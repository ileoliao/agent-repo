"""逐帧合成与并行编码。

    python -m inkwash.render build            # 预计算 12 个场景图层(缓存到 $INK_CACHE)
    python -m inkwash.render still 12.5 40    # 输出指定时刻的静帧到 out/stills/
    python -m inkwash.render video            # 渲染完整视频 out/chengdu_ink.mp4
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np

from .core import INK, NEVER, Canvas, fbm, save_canvas, smoothstep
from .scene_base import SH, SW
from .text import Caption, Subtitles, load_timeline, seal_absorb, subtitle_events

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'assets')
OUT = os.path.join(ROOT, 'out')
CACHE = os.environ.get('INK_CACHE', '/tmp/inkcache')
FPS = 30
TOTAL = 130.1
NFRAMES = int(round(TOTAL * FPS))
TRANS = 0.6  # 转场半宽(秒)


def get_scenes():
    from .scenes_a import SCENES_A
    from .scenes_b import SCENES_B
    meta, _ = load_timeline(ASSETS)
    scs = [c() for c in SCENES_A + SCENES_B]
    for i, (s, m) in enumerate(zip(scs, meta)):
        s.idx = i
        s.title, s.year = m['title'], m['year']
        s.start, s.end = m['start'], m['end']
        s.dur = m['end'] - m['start']
    return scs


# --------------------------------------------------------------------------- build
def build_one(i, force=False):
    scs = get_scenes()
    sc = scs[i]
    folder = os.path.join(CACHE, f's{i:02d}')
    if os.path.exists(os.path.join(folder, 'meta.json')) and not force:
        return i, 0.0
    t = time.time()
    cv = Canvas(sc.W, sc.H, seed=1000 + 37 * i + sc.seed)
    sc.build(cv)
    save_canvas(cv, folder)
    return i, time.time() - t


def build_all(idxs=None, force=False, workers=3):
    idxs = list(range(12)) if idxs is None else idxs
    order = sorted(idxs, key=lambda i: -get_scenes()[i].W * get_scenes()[i].H)
    with ProcessPoolExecutor(workers) as ex:
        for i, dt in ex.map(build_one, order, [force] * len(order)):
            print(f'scene {i + 1:02d} built in {dt:.1f}s', flush=True)


# --------------------------------------------------------------------------- runtime
class DynCtx:
    """动态元素绘制上下文：画布→屏幕变换 + 屏幕空间吸光度缓冲。"""

    def __init__(self, t, M, z, A):
        self.t, self.M, self.z, self.A = t, M, z, A

    def pts(self, P):
        P = np.asarray(P, np.float64).reshape(-1, 2)
        return P @ self.M[:, :2].T + self.M[:, 2]

    def canvas(self):
        return np.zeros((SH, SW), np.uint8)

    def add(self, buf, pig, dens, blur=0.7):
        f = buf.astype(np.float32) * (dens / 255.0)
        if blur > 0:
            f = cv2.GaussianBlur(f, (0, 0), blur)
        self.A += f[..., None] * pig


class Runtime:
    def __init__(self, sc):
        self.sc = sc
        folder = os.path.join(CACHE, f's{sc.idx:02d}')
        self.meta = json.load(open(os.path.join(folder, 'meta.json')))
        self.layers = []
        for i, lm in enumerate(self.meta['layers']):
            lv = [np.load(os.path.join(folder, f'layer{i}_L{k}.npy'), mmap_mode='r') for k in range(3)]
            self.layers.append((lm, lv))
        self.paper = [np.load(os.path.join(folder, f'paper_L{k}.npy'), mmap_mode='r') for k in range(3)]
        self.seal = seal_absorb(sc.seal, sc.seal_size, seed=sc.idx + 7, style=sc.seal_style, shape=sc.seal_shape,
                                rot=np.random.default_rng(sc.idx).uniform(-2.5, 2.5))
        self.caption = Caption(sc.idx, sc.title, sc.year)
        rng = np.random.default_rng(500 + sc.idx)
        self.mist_tex = np.clip(0.5 + 0.2 * fbm(900, 1800, 150, 4, rng), 0, 1).astype(np.float32)

    @staticmethod
    def level(z):
        k = 0
        while z * (2 ** k) < 0.72 and k < 2:
            k += 1
        return k

    def matrix(self, cx, cy, z, p):
        sc = self.sc
        zp = z ** p
        vx = sc.W / 2 + (cx - sc.W / 2) * p
        vy = sc.H / 2 + (cy - sc.H / 2) * p
        return np.array([[zp, 0, SW / 2 - zp * vx], [0, zp, SH / 2 - zp * vy]], np.float64), zp

    def render(self, t):
        sc = self.sc
        cx, cy, z = sc.camera(t)
        A = np.zeros((SH, SW, 3), np.float32)
        M1, _ = self.matrix(cx, cy, z, 1.0)
        for i, (lm, lv) in enumerate(self.layers):
            M, zp = self.matrix(cx, cy, z, lm['parallax'])
            E = sc.layer_affine(i, lm['name'], t)
            if E is not None:
                M = (np.vstack([M, [0, 0, 1]]) @ np.vstack([E, [0, 0, 1]]))[:2]
                zp = zp * math.sqrt(abs(np.linalg.det(E[:, :2])))
            k = self.level(zp)
            Mk = M.copy()
            Mk[:, :2] *= 2 ** k
            arr = cv2.warpAffine(lv[k], Mk, (SW, SH), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
                                 borderValue=(0, 0, 0, NEVER))
            v = np.clip((t - arr[..., 3]) * (1.0 / lm['fade']), 0, 1)
            v = v * v * (3 - 2 * v)
            A += arr[..., :3] * v[..., None]
        k = self.level(z)
        Mk = M1.copy()
        Mk[:, :2] *= 2 ** k
        paper = cv2.warpAffine(self.paper[k], Mk, (SW, SH), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        paper = paper.astype(np.float32) * (1.0 / 65535)
        ctx = DynCtx(t, M1, z, A)
        ctx.paper = paper
        ctx.runtime = self
        sc.dynamic(ctx)
        img = paper * np.exp(-A)
        for m in sc.mist:
            self.apply_mist(img, paper, m, t, M1, z)
        post = getattr(sc, 'post', None)
        if post is not None:
            img = post(ctx, img)
        self.apply_seal(img, t)
        self.caption.apply(img, t, sc.dur)
        return img

    def apply_mist(self, img, paper, m, t, M1, z):
        yc = M1[1, 1] * m['y'] + M1[1, 2]
        hs = m['h'] * z
        y0 = int(max(0, yc - 2.6 * hs))
        y1 = int(min(SH, yc + 2.6 * hs))
        if y1 <= y0:
            return
        ys = np.arange(y0, y1, dtype=np.float32)[:, None]
        band = np.exp(-((ys - yc) / hs) ** 2)
        s = m.get('scale', 1.0) * z * 1.4
        ox = m.get('speed', 12) * t + m.get('ox', 0) + M1[0, 2] * 0.0
        Mt = np.array([[1 / s, 0, ox + (-M1[0, 2]) * 0.25 / s], [0, 1 / s, y0 / s + m.get('oy', 100)]], np.float64)
        nz = cv2.warpAffine(self.mist_tex, Mt, (SW, y1 - y0), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                            borderMode=cv2.BORDER_REFLECT)
        amp = m['a']
        if 'fade' in m:
            amp *= 1 - smoothstep(m['fade'][0], m['fade'][1], t)
        if amp <= 0.002:
            return
        a = (amp * band * smoothstep(m.get('lo', 0.3), m.get('hi', 0.75), nz))[..., None]
        reg = img[y0:y1]
        reg[:] = reg * (1 - a) + paper[y0:y1] * a

    def apply_seal(self, img, t):
        sc = self.sc
        t0 = sc.seal_t
        if t < t0:
            return
        q = smoothstep(t0, t0 + 0.18, t)
        fade_out = getattr(sc, 'seal_fade', None)
        if fade_out is not None:
            q *= 1 - smoothstep(fade_out[0], fade_out[1], t)
        sp = self.seal
        sc_ = 1.0 + 0.12 * (1 - smoothstep(t0, t0 + 0.22, t))
        if sc_ > 1.001:
            sp = cv2.resize(sp, None, fx=sc_, fy=sc_, interpolation=cv2.INTER_LINEAR)
        h, w = sp.shape[:2]
        x = int(sc.seal_pos[0] - w / 2)
        y = int(sc.seal_pos[1] - h / 2)
        reg = img[y:y + h, x:x + w]
        reg *= np.exp(-sp[:reg.shape[0], :reg.shape[1]] * q)


# --------------------------------------------------------------------------- transitions / finishing
def transition_field(b):
    rng = np.random.default_rng(900 + b)
    yy, xx = np.mgrid[0:SH, 0:SW].astype(np.float32)
    d = None
    for _ in range(int(rng.integers(2, 4))):
        cx, cy = rng.uniform(0.15, 0.85) * SW, rng.uniform(0.2, 0.8) * SH
        r = rng.uniform(0.8, 1.2)
        dd = np.hypot(xx - cx, (yy - cy) * 1.2) * r
        d = dd if d is None else np.minimum(d, dd)
    d = d / d.max()
    F = d + 0.16 * fbm(SH, SW, 110, 4, rng) * 0.5 + 0.035 * fbm(SH, SW, 9, 2, rng) * 0.5
    lo, hi = np.percentile(F, 0.2), np.percentile(F, 99.8)
    return ((F - lo) / (hi - lo)).astype(np.float32)


def aging_map():
    rng = np.random.default_rng(3)
    yy, xx = np.mgrid[0:SH, 0:SW].astype(np.float32)
    r = np.hypot((xx - SW / 2) / (SW / 2), (yy - SH / 2) / (SH / 2))
    v = smoothstep(0.55, 1.45, r + 0.08 * fbm(SH, SW, 200, 3, rng) * 0.5)
    m = np.ones((SH, SW, 3), np.float32)
    tint = np.array([0.10, 0.14, 0.22], np.float32)
    m *= 1 - v[..., None] * tint
    for _ in range(9):
        cx, cy = rng.uniform(0, SW), rng.uniform(0, SH)
        rr = rng.uniform(6, 30)
        spot = np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (rr * rr)))
        m *= 1 - spot[..., None] * np.array([0.02, 0.04, 0.07], np.float32) * rng.uniform(0.5, 1.2)
    return m


class Composer:
    def __init__(self):
        self.scs = get_scenes()
        self.rts = {}
        self.tf = {}
        meta, words = load_timeline(ASSETS)
        self.subs = Subtitles(subtitle_events(meta, words))
        self.age = aging_map()

    def rt(self, i):
        if i not in self.rts:
            for k in list(self.rts):
                if abs(k - i) > 1:
                    del self.rts[k]
            self.rts[i] = Runtime(self.scs[i])
        return self.rts[i]

    def frame(self, t, subs=True):
        scs = self.scs
        i = 0
        while i + 1 < len(scs) and t >= scs[i + 1].start:
            i += 1
        img = None
        if i + 1 < len(scs) and t > scs[i + 1].start - TRANS:
            b = i + 1
            img = self.mix(b, t)
        elif i > 0 and t < scs[i].start + TRANS:
            img = self.mix(i, t)
        if img is None:
            img = self.rt(i).render(t - scs[i].start)
        img *= self.age
        if subs:
            self.subs.apply(img, t)
        return img

    def mix(self, b, t):
        scs = self.scs
        B = scs[b].start
        p = (t - (B - TRANS)) / (2 * TRANS)
        old = self.rt(b - 1).render(t - scs[b - 1].start)
        new = self.rt(b).render(t - scs[b].start)
        if b not in self.tf:
            self.tf = {b: transition_field(b)}
        F = self.tf[b]
        e = p * p * (3 - 2 * p)
        th = -0.06 + 1.14 * e
        inside = smoothstep(th + 0.012, th - 0.012, F)[..., None]
        front = np.exp(-((F - th) / 0.018) ** 2)
        ahead = smoothstep(th + 0.09, th, F) * (1 - inside[..., 0])
        img = old * (1 - inside) + new * inside
        img *= np.exp(-(front * 0.5 + ahead * 0.22)[..., None] * INK)
        return img


def to_u8(img):
    return (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)


# --------------------------------------------------------------------------- CLI
def stills(times, folder=None, subs=True):
    folder = folder or os.path.join(OUT, 'stills')
    os.makedirs(folder, exist_ok=True)
    comp = Composer()
    paths = []
    for t in times:
        img = comp.frame(float(t), subs=subs)
        p = os.path.join(folder, f't{float(t):07.2f}.png')
        cv2.imwrite(p, cv2.cvtColor(to_u8(img), cv2.COLOR_RGB2BGR))
        paths.append(p)
        print(p, flush=True)
    return paths


def render_segment(args):
    f0, f1, path = args
    comp = Composer()
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{SW}x{SH}', '-r', str(FPS),
           '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-threads', '2',
           '-x264-params', 'keyint=60:min-keyint=30', path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    t0 = time.time()
    for f in range(f0, f1):
        img = comp.frame(f / FPS)
        p.stdin.write(to_u8(img).tobytes())
    p.stdin.close()
    p.wait()
    return f0, f1, time.time() - t0


def video(workers=4, chunk=150, out_name='chengdu_ink.mp4'):
    build_all()
    os.makedirs(os.path.join(OUT, 'seg'), exist_ok=True)
    jobs = []
    for f0 in range(0, NFRAMES, chunk):
        f1 = min(NFRAMES, f0 + chunk)
        jobs.append((f0, f1, os.path.join(OUT, 'seg', f'seg_{f0:05d}.mp4')))
    t = time.time()
    with ProcessPoolExecutor(workers) as ex:
        for f0, f1, dt in ex.map(render_segment, jobs):
            print(f'frames {f0}-{f1} done in {dt:.0f}s  (elapsed {time.time() - t:.0f}s)', flush=True)
    lst = os.path.join(OUT, 'seg', 'list.txt')
    with open(lst, 'w') as f:
        for j in jobs:
            f.write(f"file '{j[2]}'\n")
    silent = os.path.join(OUT, 'video_silent.mp4')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', silent],
                   check=True)
    from .audio import mix
    wav = mix(os.path.join(OUT, 'mix.wav'))
    final = os.path.join(OUT, out_name)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', silent, '-i', wav, '-map', '0:v', '-map', '1:a',
                    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', f'{NFRAMES / FPS:.3f}',
                    '-movflags', '+faststart', final], check=True)
    print('wrote', final, f'total {time.time() - t:.0f}s')
    return final


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'build':
        idx = [int(x) - 1 for x in sys.argv[2:]] or None
        build_all(idx, force=bool(idx))
    elif cmd == 'still':
        stills(sys.argv[2:])
    elif cmd == 'video':
        video(workers=int(os.environ.get('WORKERS', 4)))
