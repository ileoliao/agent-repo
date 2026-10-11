"""平远横卷：潮平两岸。不要复用 shanshui/ 那张立轴的构图。

  python jiangfan/paint.py [--scale 0.5] [--out DIR]

远山先染，干了再点。近坡分遍积墨，坡脚趁湿。树和帆等岸干了再写。
题款用王湾《次北固山下》颈联，落款丙午秋（2026）。
"""
from __future__ import annotations

import argparse
import math
import os
import sys
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from inkwash.core import INDIGO, INK, OCHRE, Canvas, smoothstep  # noqa: E402
from shanshui import atmos as A  # noqa: E402
from shanshui import brush as B  # noqa: E402
from shanshui import figures as F  # noqa: E402
from shanshui import trees as T  # noqa: E402
from shanshui.massif import Massif  # noqa: E402

W0, H0 = 3400, 1500
SEED = 2026
FONT = '/usr/share/fonts/truetype/arphic/ukai.ttc'
# 王湾《次北固山下》颈联，右起竖行
COLUMNS = [
    ('潮平两岸阔', 3120, 90, 64),
    ('风正一帆悬', 3036, 90, 64),
    ('丙午秋日写', 2960, 160, 42),
]


def willow(L, x, y, h, rng, ink=0.9, lean=1.0):
    """柳。根在坡上。丝从树冠垂下，lean>0 偏向右（江面），好挂出坡影。"""
    w = h * 0.048
    c = T.trunk(L, x, y, h * 0.55, w, rng, lean=0.02 * lean, ink=ink, wiggle=0.03)
    T.roots(L, x, y, w, rng, ink)
    if B.PHYSICS:
        B.pause(2.0)
    n = len(c)
    for _ in range(int(rng.integers(20, 30))):
        origin = c[int(rng.uniform(0.62, 1.0) * (n - 1))]
        spread = abs(lean) * rng.uniform(0.15, 0.95)
        a = math.pi / 2 - math.copysign(spread, lean)
        ln = h * rng.uniform(0.85, 1.65)
        px, py = float(origin[0]) + rng.normal(0, w * 0.3), float(origin[1])
        pts = [(px, py)]
        steps = 9
        for _t in range(steps):
            a = 0.94 * a + 0.06 * (math.pi / 2) + rng.normal(0, 0.03)
            px += math.cos(a) * ln / steps
            py += math.sin(a) * ln / steps
            pts.append((px, py))
        L.stroke(B.P(pts), rng.uniform(0.45, 0.95) * B.S, ink=ink * rng.uniform(0.45, 0.95),
                 model='bristle', dry=0.45, wet=0.15, taper=(0.25, 0.9), start_w=0.4, end_w=0.03,
                 entry='lu', exit='tip', interact=False)
    return c


def reeds_on(L, crest, i0, i1, rng, n=14):
    """芦草扎在坡缘上，往上长，疏密成丛，不沿坡排成梳子。"""
    i0, i1 = int(i0), int(i1)
    if i1 - i0 < 3:
        return
    picks = rng.integers(i0, i1, n)
    # 两丛：把一部分点收到两个中心附近
    for k, p in enumerate(picks):
        if rng.random() < 0.55:
            center = i0 + (i1 - i0) * (0.25 if k % 2 == 0 else 0.72)
            p = int(np.clip(center + rng.normal(0, (i1 - i0) * 0.06), i0, i1 - 1))
        x, y = float(crest[p, 0]), float(crest[p, 1])
        h = rng.uniform(26, 78) * rng.choice([0.6, 0.85, 1.15], p=[0.3, 0.45, 0.25])
        lean = rng.normal(0, 0.28)
        L.stroke(B.P([(x, y + rng.uniform(-2, 4)),
                      (x + math.sin(lean) * h * 0.4, y - h * 0.5),
                      (x + math.sin(lean) * h, y - h)]),
                 rng.uniform(0.55, 1.15) * B.S, ink=rng.uniform(0.4, 0.9), model='bristle',
                 dry=0.5, wet=0.12, taper=(0.15, 0.85), start_w=0.45, end_w=0.04, interact=False)


def sailboat(L, x, y, w, rng, ink=0.9):
    """一帆。船底坐在水线 y，帆等船舷干了再染，倒影断成几截。"""
    hl = w * 0.62
    hull = [(x - hl, y - w * 0.06), (x - hl * 0.15, y + w * 0.02),
            (x + hl * 0.7, y + w * 0.01), (x + hl * 1.05, y - w * 0.08)]
    L.stroke(B.P(hull), 2.4 * B.S, ink=ink, model='bristle', dry=0.22, wet=0.18, interact=False)
    L.stroke(B.P([(x - hl * 0.55, y - w * 0.1), (x + hl * 0.35, y - w * 0.12)]),
             1.2 * B.S, ink=ink * 0.7, model='bristle', dry=0.3, interact=False)
    mx = x + hl * 0.05
    top = y - w * 1.15
    L.stroke(B.P([(mx, y - 1), (mx + rng.normal(0, 0.8), top)]), 1.4 * B.S, ink=ink,
             model='bristle', dry=0.28, interact=False)
    if B.PHYSICS:
        B.pause(3.0)
    # 风正：帆鼓向右，是一块软边的淡墨，不是三角形硬片
    sail = [(mx + 3, top + w * 0.06),
            (mx + w * 0.62, top + w * 0.22),
            (mx + w * 0.7, y - w * 0.28),
            (mx + 2, y - w * 0.1)]
    x0, y0, f = B.poly_field(sail, blur=1.4, pad=8)
    L.wash(x0, y0, f, INK * 0.7 + OCHRE * 0.3, dens=0.34, lo=0.2, hi=0.8, edge=0.25, edge_blur=2.5, wet=0.7)
    L.stroke(B.P(sail + [sail[0]]), 1.0 * B.S, ink=ink * 0.65, model='bristle',
             dry=0.45, wet=0.12, interact=False)
    for k in range(6):
        yy = y + 8 + k * w * 0.055
        span = hl * (0.9 - 0.1 * k) * rng.uniform(0.85, 1.05)
        cx = x + rng.normal(0, 2)
        L.stroke(B.P([(cx - span, yy), (cx + span * 0.55, yy + rng.normal(0, 0.6))]),
                 rng.uniform(0.7, 1.4) * B.S, ink=max(0.06, 0.2 - 0.025 * k),
                 pig=INK * 0.55 + INDIGO * 0.45, model='bristle', dry=0.55, wet=0.08, interact=False)
    return (x, y - w * 0.5)


def write_inscription(cv, rng):
    S = B.S
    acc = np.zeros((cv.h, cv.w, 3), np.float32)
    font_path = FONT
    for text, xc, y0, size in COLUMNS:
        load = rng.uniform(1.1, 1.25)
        step = size * 1.08
        y = y0
        face = ImageFont.truetype(font_path, int(size * S * 0.92), index=0)
        for ch in text:
            if ch == ' ':
                y += step * 0.55
                continue
            px = int(size * S)
            im = Image.new('L', (px, px), 0)
            d = ImageDraw.Draw(im)
            l, t, r, b = d.textbbox((0, 0), ch, font=face)
            d.text(((px - (r - l)) / 2 - l, (px - (b - t)) / 2 - t), ch, font=face, fill=255)
            m = np.asarray(im, np.float32) / 255
            gx = int((xc + rng.normal(0, 1.2)) * S - px / 2)
            gy = int(y * S)
            if gy + px > cv.h or gx + px > cv.w or gx < 0 or gy < 0:
                break
            ys, xs = slice(gy, gy + px), slice(gx, gx + px)
            shape = smoothstep(0.35, 0.65, m + 0.16 * cv.nz_edge[ys, xs])
            dens = load * (0.85 + 0.25 * cv.fiber[ys, xs])
            bleed = cv2.GaussianBlur(shape, (0, 0), 1.4 * S + 0.5) * 0.16 * load
            acc[ys, xs] += (shape * dens + bleed)[..., None] * INK
            load -= rng.uniform(0.04, 0.08)
            y += step * rng.uniform(0.98, 1.03)
    return acc


def build(scale):
    B.set_scale(scale)
    B.set_brush('bristle')
    B.reset_clock()
    B.set_physics(True)
    B.MARKING = False
    w, h = int(W0 * scale), int(H0 * scale)
    cv = Canvas(w, h, SEED)
    rng = np.random.default_rng(SEED)
    L = cv.layer('sheet', halo=0.75, interact=True)
    B.track(L)

    # 远山清墨。左边三丘高矮不一，江口正中更远更淡，右边只两丘，不跟左边重复。
    # 题款占右上，远山停在 x≈2780。
    pig = INK * 0.75 + INDIGO * 0.25
    A.mi_hills(L, 40, 1180, 500, [(240, 100, 220), (560, 190, 300), (940, 130, 240)],
               rng, ink=0.1, dot_r=8, wash=0.05, pig=pig, density=0.55)
    B.pause(5.0)
    A.mi_hills(L, 1280, 1960, 440, [(1580, 70, 260)],
               rng, ink=0.05, dot_r=7, wash=0.03, pig=pig, density=0.4)
    B.pause(4.0)
    A.mi_hills(L, 1980, 2760, 540, [(2260, 160, 280), (2620, 90, 200)],
               rng, ink=0.08, dot_r=8, wash=0.04, pig=pig, density=0.5)
    B.pause(6.0)

    # 对岸是一条平远长岸，用横笔，不跟近坡的披麻同一个形
    A.flat_shore(L, 1500, 2500, 790, rng, ink=0.2, pig=pig)
    B.pause(4.0)

    # 近景两坡夹出江面。左坡高、披麻；右坡矮、长披麻。脚留在纸内，染两遍就停，纸要透出来。
    N = Massif(L)
    # 染得淡，披麻才露得出来。坡脚仍用湿笔，但是淡的。
    shore = N.lobe(500, 1460, 1080, 420, rng, style=('pima2', 'wet'), ink=0.58, dens=0.055,
                   line=3.2, sharp=1.6, round_=0.62, skew=0.18, bump=0.1, n_tex=26, moss=2,
                   fade=0.32, passes=2, gaps=0.2)
    B.pause(5.0)
    right = N.lobe(2920, 1500, 980, 300, rng, style=('pima2',), ink=0.4, dens=0.045,
                   line=2.6, sharp=1.3, round_=0.75, skew=-0.28, bump=0.06, n_tex=12, moss=1,
                   fade=0.35, passes=2, gaps=0.28)
    B.pause(4.0)
    # 水口一块小石，单独用斧劈，离开左坡的影
    N.lobe(1360, 1160, 240, 150, rng, style=('fupi',), ink=0.7, dens=0.08, line=2.4,
           sharp=1.5, steps=0.45, round_=0.32, skew=0.05, n_tex=7, moss=0, passes=2, gaps=0.25)
    B.pause(5.0)

    def ground_at(crest, x):
        return float(np.interp(x, crest[:, 0], crest[:, 1]))

    ipeak = int(np.argmin(shore[:, 1]))
    px = float(shore[ipeak, 0])
    willow(L, px - 30, ground_at(shore, px - 30) + 3, 300, rng, lean=0.35)
    B.pause(3.0)
    # 第二株柳靠水边，丝挂进空白的江面
    iedge = ipeak + int(0.42 * (len(shore) - 1 - ipeak))
    ex, ey = float(shore[iedge, 0]), float(shore[iedge, 1])
    willow(L, ex, ey + 3, 240, rng, ink=0.82, lean=1.0)
    B.pause(3.0)
    reeds_on(L, shore, iedge + 2, len(shore) - 2, rng, n=10)
    rpeak = int(np.argmin(right[:, 1]))
    reeds_on(L, right, max(1, rpeak - 8), min(len(right) - 1, rpeak + 3), rng, n=7)
    rx = float(right[rpeak, 0]) - 30
    T.bare_tree(L, rx, ground_at(right, rx) + 4, 210, rng, lean=0.08, ink=0.72)
    B.pause(4.0)

    # 水是留白。波纹只在船的水线附近断续几笔。
    A.ripples(L, 1480, 2200, 980, 1140, 7, rng, ink=0.14)
    B.pause(2.0)
    # 一帆，是这张画的主体。船在两坡之间，船底低于对岸横线、高于右坡坡顶。
    sailboat(L, 1760, 1130, 240, rng, ink=0.95)
    A.ripples(L, 1580, 2060, 1100, 1200, 4, rng, ink=0.16)
    B.pause(4.0)

    L.finalize()
    acc = L.A.copy()
    # 雾只压在远山脚下，不罩到帆和近岸
    mist = A.mist_mask(h, w, [(600, 80, 0, 2700, 0.7)], rng)
    acc *= (1 - 0.42 * mist)[..., None]

    ins = write_inscription(cv, np.random.default_rng(SEED + 3))
    acc += ins
    y0, x0, patch = F.seal(h, w, 2960, 500, 46, np.random.default_rng(11))
    ph, pw = patch.shape[:2]
    y1, x1 = min(h, y0 + ph), min(w, x0 + pw)
    if y0 >= 0 and x0 >= 0:
        acc[y0:y1, x0:x1] += patch[:y1 - y0, :x1 - x0]
    img = cv.paper * np.exp(-np.clip(acc, 0, None))
    return np.clip(img, 0, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--out', default=os.path.join(HERE, 'out'))
    ap.add_argument('--name', default='jiangfan')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    t = time.time()
    img = build(a.scale)
    print(f'painted in {time.time() - t:.1f}s', flush=True)
    rgb = (img * 255 + 0.5).astype(np.uint8)
    bgr = rgb[..., ::-1]
    cv2.imwrite(os.path.join(a.out, f'{a.name}.png'), bgr)
    h, w = bgr.shape[:2]
    sc = 1400 / max(h, w)
    pv = cv2.resize(bgr, (max(1, int(w * sc)), max(1, int(h * sc))), interpolation=cv2.INTER_AREA)
    cv2.imwrite(os.path.join(a.out, f'{a.name}_preview.jpg'), pv, [cv2.IMWRITE_JPEG_QUALITY, 90])
    print('saved', a.out, bgr.shape)


if __name__ == '__main__':
    main()
