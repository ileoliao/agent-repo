"""字幕(词级时间轴对齐)、镜头标题(标题+年代+小红印)、程序化印章。"""
from __future__ import annotations

import difflib
import json
import math

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .core import fbm, smoothstep

FONT_DIR = '/usr/share/fonts/opentype/noto/'
SC = 2  # Noto Serif CJK .ttc 中简体中文(SC)的索引
PUNCT = set('，。、；：！？,.;:!?')
QUOTES = set('“”‘’"「」')


def font(size, weight='SemiBold'):
    return ImageFont.truetype(FONT_DIR + f'NotoSerifCJK-{weight}.ttc', size, index=SC)


# --------------------------------------------------------------------------- subtitle timing
def char_times(words, offset):
    out = []
    for st, du, tx in words:
        tx = ''.join(c for c in tx if c not in PUNCT and c not in QUOTES)
        n = max(1, len(tx))
        for k, c in enumerate(tx):
            out.append((c, offset + st + du * k / n, offset + st + du * (k + 1) / n))
    return out


def align(narr, words, offset):
    """把显示文本(含阿拉伯数字)逐字对齐到 TTS 词时间(数字被读作汉字)。"""
    ct = char_times(words, offset)
    tts = ''.join(c for c, _, _ in ct)
    disp = [c for c in narr if c not in PUNCT and c not in QUOTES]
    sm = difflib.SequenceMatcher(a=''.join(disp), b=tts, autojunk=False)
    times = [None] * len(disp)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            for k in range(i2 - i1):
                times[i1 + k] = (ct[j1 + k][1], ct[j1 + k][2])
        elif tag in ('replace',) and i2 > i1 and j2 > j1:
            a, b = ct[j1][1], ct[j2 - 1][2]
            n = i2 - i1
            for k in range(n):
                times[i1 + k] = (a + (b - a) * k / n, a + (b - a) * (k + 1) / n)
    for k in range(len(times)):
        if times[k] is None:
            prev = times[k - 1] if k > 0 and times[k - 1] else (offset, offset)
            times[k] = (prev[1], prev[1] + 0.1)
    return disp, times


def subtitle_events(scenes, words_all, maxlen=16, merge_len=12):
    events = []
    for i, (sc, words) in enumerate(zip(scenes, words_all)):
        off = sc['start'] + (1.0 if i == 0 else 0.0)
        narr = sc['narr']
        disp, times = align(narr, words, off)
        # 按标点切句，保留引号
        clauses, cur, idx, cur_idx = [], '', 0, []
        for c in narr:
            if c in PUNCT:
                if cur:
                    clauses.append((cur, cur_idx))
                cur, cur_idx = '', []
                continue
            cur += c
            if c not in QUOTES:
                cur_idx.append(idx)
                idx += 1
        if cur:
            clauses.append((cur, cur_idx))
        # 短句合并
        merged = []
        for txt, ids in clauses:
            open_q = merged and merged[-1][0].count('“') > merged[-1][0].count('”')
            if merged and ((len(merged[-1][0]) + 1 + len(txt) <= merge_len and len(merged[-1][0]) <= 4)
                           or (open_q and len(merged[-1][0]) + 1 + len(txt) <= maxlen)):
                merged[-1] = (merged[-1][0] + ' ' + txt, merged[-1][1] + ids)
            else:
                merged.append((txt, ids))
        # 超长切分(≤16字/行)
        final = []
        for txt, ids in merged:
            if len(txt) <= maxlen:
                final.append((txt, ids))
                continue
            parts = math.ceil(len(txt) / maxlen)
            per = math.ceil(len(txt) / parts)
            pos = 0
            idp = 0
            while pos < len(txt):
                piece = txt[pos:pos + per]
                nid = sum(1 for c in piece if c not in QUOTES and c != ' ')
                final.append((piece, ids[idp:idp + nid]))
                pos += per
                idp += nid
        for txt, ids in final:
            if not ids:
                continue
            events.append({'text': txt.strip(), 'start': times[ids[0]][0] - 0.06, 'end': times[ids[-1]][1] + 0.25,
                           'scene': i})
    for a, b in zip(events, events[1:]):
        if b['start'] - a['end'] < 0.45:
            a['end'] = b['start'] - 0.03
        a['end'] = min(a['end'], b['start'] - 0.03)
    return events


# --------------------------------------------------------------------------- rendered sprites
INK_RGB = (28, 24, 22)
PAPER_RGB = (244, 238, 224)


def text_sprite(txt, size, weight='SemiBold', color=INK_RGB, glow=PAPER_RGB, glow_r=7, glow_a=0.88):
    f = font(size, weight)
    l, t, r, b = f.getbbox(txt)
    pad = glow_r * 3 + 6
    W, H = r - l + 2 * pad, b - t + 2 * pad
    g = Image.new('L', (W, H), 0)
    ImageDraw.Draw(g).text((pad - l, pad - t), txt, font=f, fill=255, stroke_width=glow_r // 2 + 2, stroke_fill=255)
    ga = cv2.GaussianBlur(np.asarray(g, np.float32) / 255, (0, 0), glow_r * 0.7) * glow_a
    ga = np.clip(ga * 1.6, 0, glow_a)
    m = Image.new('L', (W, H), 0)
    ImageDraw.Draw(m).text((pad - l, pad - t), txt, font=f, fill=255)
    ta = np.asarray(m, np.float32) / 255
    rgb = np.empty((H, W, 3), np.float32)
    a = ta + ga * (1 - ta)
    for c in range(3):
        rgb[..., c] = (color[c] / 255 * ta + glow[c] / 255 * ga * (1 - ta)) / np.maximum(a, 1e-4)
    return rgb, a.astype(np.float32)


def seal_absorb(chars, size, seed=1, style='bai', shape='square', rot=0.0):
    """程序化印章：朱砂底 + 白文/朱文字，边缘残破、印泥不均。返回吸光度(H,W,3)。"""
    from .core import VERMILION
    rng = np.random.default_rng(seed)
    S = int(size)
    pad = int(S * 0.12)
    N = S + 2 * pad
    sc = 4
    big = Image.new('L', (N * sc, N * sc), 0)
    d = ImageDraw.Draw(big)
    if shape == 'square':
        d.rounded_rectangle([pad * sc, pad * sc, (pad + S) * sc, (pad + S) * sc], radius=int(S * 0.06 * sc), fill=255)
    elif shape == 'oval':
        d.ellipse([pad * sc, int((pad + S * 0.1) * sc), (pad + S) * sc, int((pad + S * 0.9) * sc)], fill=255)
    else:
        d.ellipse([pad * sc, pad * sc, (pad + S) * sc, (pad + S) * sc], fill=255)
    txt = Image.new('L', (N * sc, N * sc), 0)
    td = ImageDraw.Draw(txt)
    n = len(chars)
    if n == 1:
        cells = [(0.5, 0.5, 0.78)]
    elif n == 2:
        cells = [(0.5, 0.29, 0.44), (0.5, 0.71, 0.44)]
    else:
        cells = [(0.71, 0.29, 0.42), (0.71, 0.71, 0.42), (0.29, 0.29, 0.42), (0.29, 0.71, 0.42)]
    for ch, (cx, cy, fs) in zip(chars, cells):
        f = font(int(S * fs * sc), 'Black')
        l, t, r, b = f.getbbox(ch)
        x = (pad + cx * S) * sc - (l + r) / 2
        y = (pad + cy * S) * sc - (t + b) / 2
        td.text((x, y), ch, font=f, fill=255)
    if style == 'zhu':
        border = Image.new('L', (N * sc, N * sc), 0)
        bd = ImageDraw.Draw(border)
        bw = int(S * 0.07 * sc)
        bd.rounded_rectangle([pad * sc, pad * sc, (pad + S) * sc, (pad + S) * sc], radius=int(S * 0.06 * sc),
                             outline=255, width=bw)
        m = np.maximum(np.asarray(border), np.asarray(txt)).astype(np.float32) / 255
    else:
        m = np.asarray(big, np.float32) / 255 * (1 - np.asarray(txt, np.float32) / 255)
    m = cv2.resize(m, (N, N), interpolation=cv2.INTER_AREA)
    nz = fbm(N, N, max(3, S / 18), 3, rng)
    nz2 = fbm(N, N, max(2, S / 60), 2, rng)
    edge = np.clip(m - cv2.GaussianBlur(m, (0, 0), 2.0), 0, 1)
    m = np.clip(m - edge * smoothstep(0.3, 1.2, nz) * 1.2, 0, 1)
    chip = smoothstep(1.1, 1.6, nz2)
    m = m * (1 - chip * 0.85)
    ink = 0.82 + 0.18 * smoothstep(-1.2, 1.2, fbm(N, N, max(3, S / 8), 3, rng))
    m = smoothstep(0.25, 0.75, m) * ink
    if rot:
        M = cv2.getRotationMatrix2D((N / 2, N / 2), rot, 1.0)
        m = cv2.warpAffine(m, M, (N, N))
    return (m[..., None] * VERMILION * 1.55).astype(np.float32)


CN_NUM = '壹贰叁肆伍陆柒捌玖拾'


class Caption:
    """左上角：小红印(镜头序号) + 标题 + 年代。"""

    def __init__(self, idx, title, year):
        self.seal = seal_absorb(CN_NUM[idx] if idx < 10 else '拾' + '壹贰'[idx - 10], 58, seed=100 + idx)
        self.title = text_sprite(title, 50, 'SemiBold', glow_r=7, glow_a=0.8)
        self.year = text_sprite(year, 28, 'Medium', color=(112, 52, 40), glow_r=6, glow_a=0.78)
        rng = np.random.default_rng(idx)
        self.wnz = rng.random(64).astype(np.float32)

    def apply(self, img, t, dur):
        a = smoothstep(0.35, 1.1, t) * (1 - smoothstep(dur - 0.15, dur + 0.35, t))
        if a <= 0.001:
            return
        x0, y0 = 64, 54
        sh, sw = self.seal.shape[:2]
        sa = smoothstep(0.25, 0.45, t) * (1 - smoothstep(dur - 0.15, dur + 0.35, t))
        reg = img[y0:y0 + sh, x0:x0 + sw]
        reg *= np.exp(-self.seal * sa)
        wipe = smoothstep(0.45, 1.5, t)
        self._blit(img, self.title, x0 + sw - 2, y0 - 16, a, wipe)
        self._blit(img, self.year, x0 + sw + 2, y0 + 50, a * smoothstep(0.8, 1.5, t), smoothstep(0.8, 1.8, t))

    def _blit(self, img, spr, x, y, a, wipe):
        rgb, al = spr
        h, w = al.shape
        xs = np.linspace(0, 1, w)[None, :]
        edge = wipe * 1.25 - 0.1
        wm = smoothstep(edge + 0.08, edge - 0.08, xs + 0.04 * np.sin(np.arange(h)[:, None] * 0.21))
        aa = (al * wm * a)[..., None]
        reg = img[y:y + h, x:x + w]
        reg[:] = reg * (1 - aa) + rgb * aa


class Subtitles:
    def __init__(self, events, size=46, y_base=1080 - 70):
        self.events = events
        self.size = size
        self.y_base = y_base
        self.cache = {}

    def apply(self, img, t):
        for k, e in enumerate(self.events):
            if e['start'] - 0.15 <= t <= e['end'] + 0.15:
                a = smoothstep(e['start'] - 0.12, e['start'] + 0.08, t) * (1 - smoothstep(e['end'] - 0.05, e['end'] + 0.15, t))
                if a <= 0.001:
                    continue
                if k not in self.cache:
                    self.cache[k] = text_sprite(e['text'], self.size, 'SemiBold', glow_r=8, glow_a=0.82)
                rgb, al = self.cache[k]
                h, w = al.shape
                x = (img.shape[1] - w) // 2
                y = self.y_base - h + 16
                aa = (al * a)[..., None]
                reg = img[y:y + h, x:x + w]
                reg[:] = reg * (1 - aa) + rgb * aa


def load_timeline(asset_dir):
    scenes = json.load(open(f'{asset_dir}/scenes.json', encoding='utf-8'))
    words = json.load(open(f'{asset_dir}/word_boundaries.json', encoding='utf-8'))
    return scenes, words
