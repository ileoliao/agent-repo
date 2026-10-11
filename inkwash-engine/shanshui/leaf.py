"""册页试笔：毛笔 + 破墨/积墨。  python shanshui/leaf.py [--out DIR]

石头分三次下，每次隔几秒等干，是积墨。竹叶先淡后浓、趁湿相交，是浓破淡；
另有一笔淡墨压在未干的浓叶上，是淡破浓。左上两枝湿墨交叉，是湿破湿。
"""
from __future__ import annotations

import argparse
import math
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from inkwash.core import INK, Canvas  # noqa: E402
from shanshui import brush as B  # noqa: E402
from shanshui import textures as X  # noqa: E402
from shanshui import trees as T  # noqa: E402

W, H = 1400, 1860


def build():
    B.set_scale(1.0)
    B.set_brush('bristle')
    B.MARKING = False
    cv = Canvas(W, H, 42)
    L = cv.layer('leaf', halo=0.85, interact=True)
    rng = np.random.default_rng(7)

    # 远坡：淡湿，不参与后来的积墨时钟
    f = B.blob_field(980, 280, rng, cell=80, soft=1.1)
    L.wash(80, 1500, f, INK, dens=0.16, lo=0.05, hi=0.7, edge=0.2, edge_blur=8, gran=0.4, wet=1.2)
    L.dry(6.0)

    top = np.array([[80, 1040], [280, 900], [520, 860], [760, 930], [980, 840], [1180, 980]], np.float64)
    # 积墨：三遍侧锋，每遍等干
    X.bundles(L, top, by=1620, h=760, n=7, ink=0.42, rng=rng, light=-1)
    L.dry(5.0)
    X.bundles(L, top + np.array([14.0, 18.0]), by=1600, h=740, n=5, ink=0.55, rng=rng, light=-1)
    L.dry(5.0)
    X.pima_long(L, top, by=1580, h=720, n=12, ink=0.85, rng=rng)
    L.dry(4.0)
    for mx, my in ((420, 1280), (640, 1180), (860, 1340), (300, 1420)):
        X.moss_cluster(L, mx, my, rng, n=6, spread=22, size=3.2, ink=1.1)
    L.dry(4.0)

    # 竹竿，干后再发叶
    culms = []
    for k, x in enumerate((1020, 1125, 1230, 1310)):
        yb, yt = 1680, 260 + 70 * (k % 2)
        lean = (-0.03, 0.02, -0.01, 0.04)[k]
        pts = [(x + lean * 1400 * t + 18 * math.sin(t * 5 + k), yb + (yt - yb) * t)
               for t in np.linspace(0, 1, 9)]
        L.stroke(pts, 6.5 + (k % 3), ink=0.72, model='bristle', dry=0.4, wet=0.35,
                 tip='zhong', entry='cang', exit='hui', taper=(0.2, 0.4), bristle=1.15)
        culms.append(pts)
        for t in (0.22, 0.42, 0.62, 0.8):
            i = min(len(pts) - 1, int(t * (len(pts) - 1)))
            nx, ny = pts[i]
            L.stroke([(nx - 16, ny), (nx + 16, ny + 2)], 2.0, ink=0.95, model='bristle',
                     dry=0.15, wet=0.25, taper=(0.2, 0.3))
    L.dry(5.0)

    def leaf(x, y, ang, ln, w, ink, wet):
        L.stroke([(x, y),
                  (x + math.cos(ang) * ln * 0.55, y + math.sin(ang) * ln * 0.55),
                  (x + math.cos(ang) * ln, y + math.sin(ang) * ln)],
                 w, ink=ink, model='bristle', dry=0.02, wet=wet, tip='zhong',
                 entry='lu', exit='tip', taper=(0.25, 0.8), start_w=0.35, end_w=0.05)

    # 浓破淡：先铺湿的淡叶，立刻用浓叶破开
    for cx, cy, n_pale, n_dark in ((1040, 520, 6, 3), (1160, 390, 5, 3), (1240, 640, 5, 2),
                                   (940, 700, 4, 2), (1100, 820, 4, 2)):
        for _ in range(n_pale):
            leaf(cx, cy, -math.pi / 2 + rng.uniform(-1.15, 1.15), rng.uniform(80, 150),
                 rng.uniform(5.5, 9.0), 0.20, 1.15)
        for _ in range(n_dark):
            leaf(cx + rng.uniform(-10, 10), cy + rng.uniform(-8, 8),
                 -math.pi / 2 + rng.uniform(-0.7, 0.7), rng.uniform(55, 120),
                 rng.uniform(2.0, 3.2), 0.95, 0.65)
        # 淡破浓：一笔更淡的湿叶压在刚落下的浓叶上
        leaf(cx - 16, cy + 12, rng.uniform(-2.4, -0.3), 100, 7.5, 0.10, 1.25)
    L.dry(6.0)

    # 湿破湿：两枝差不多浓的湿墨交叉
    stroke = lambda pts, w, ink: L.stroke(
        pts, w, ink=ink, model='bristle', dry=0.0, wet=1.15, tip='zhong',
        entry='cang', exit='hui', taper=(0.15, 0.45))
    stroke([(160, 280), (340, 200), (520, 250)], 9, 0.48)
    stroke([(180, 160), (340, 230), (500, 150)], 8, 0.34)

    # 松：干后画在石上，针叶自己是枯笔
    T.pine(L, 250, 1560, 460, rng, lean=-0.06, ink=0.92, scale=0.85)
    L.finalize()
    img = np.clip(cv.paper * np.exp(-L.A), 0, 1)
    return (img * 255 + 0.5).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='/tmp/leaf')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    t = time.time()
    rgb = build()
    print(f'painted in {time.time() - t:.1f}s', rgb.shape, flush=True)
    bgr = rgb[..., ::-1]
    cv2.imwrite(os.path.join(a.out, 'leaf.png'), bgr)
    # 预览按长边 1600
    h, w = bgr.shape[:2]
    sc = 1600 / max(h, w)
    pv = cv2.resize(bgr, (int(w * sc), int(h * sc)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(os.path.join(a.out, 'leaf_preview.jpg'), pv, [cv2.IMWRITE_JPEG_QUALITY, 90])
    print('saved', a.out)


if __name__ == '__main__':
    main()
