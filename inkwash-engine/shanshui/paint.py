"""Render the shanshui hanging scroll:  python shanshui/paint.py [--scale 0.5] [--out DIR]

Deterministic (SEED). Writes shanshui.png (2400x3200 at scale 1), shanshui_preview.jpg and
labels.json (technique -> design-unit anchor points actually used while painting)."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from inkwash.core import Canvas, fbm  # noqa: E402
from shanshui import atmos as A  # noqa: E402
from shanshui import brush as B  # noqa: E402
from shanshui import falls as FL  # noqa: E402
from shanshui import figures as F  # noqa: E402
from shanshui import inscription as INS  # noqa: E402
from shanshui import scene_back as SB  # noqa: E402
from shanshui import scene_front as SF  # noqa: E402

SEED = 1086          # 北宋 · 溪山行旅 era
W0, H0 = 2400, 3200

# mist bands (y_center, thickness, x_from, x_to, strength), design units, per layer
MIST = {
    'far': [(1265, 120, 0, 900, 1.0), (1320, 110, 1880, 2400, 1.0), (1700, 70, 1500, 2400, 0.5)],
    'peak': [(1625, 130, 380, 2250, 1.0), (1210, 55, 420, 880, 0.7), (900, 45, 1720, 2150, 0.55),
             (1430, 55, 1760, 2150, 0.6), (1075, 38, 940, 1330, 0.6)],
    'mid': [(2215, 95, 0, 1300, 0.95), (1880, 50, 0, 1100, 0.5), (1700, 60, 350, 1300, 0.75)],
}


# breathing pale areas inside the main peak (lit faces / 留白 in folds): cx, cy, rx, ry, strength
LIGHT = [(1040, 600, 45, 150, 0.4), (1690, 800, 35, 120, 0.3)]   # only a few pale breathing gaps


def light_mask(h, w, rng):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nz = fbm(h, w, 30 * B.S + 1, 3, rng, cell_y=90 * B.S + 1)
    m = np.zeros((h, w), np.float32)
    for (cx, cy, rx, ry, st) in LIGHT:
        d = ((xx / B.S - cx) / rx) ** 2 + ((yy / B.S - cy) / ry) ** 2
        m = np.maximum(m, st * np.clip(np.exp(-d * 1.4) * (0.8 + 0.45 * nz), 0, 1))
    return m


def build(scale):
    B.set_scale(scale)
    B.LABELS.clear()
    w, h = int(W0 * scale), int(H0 * scale)
    cv = Canvas(w, h, SEED)
    rng = np.random.default_rng(SEED)
    far = cv.layer('far', halo=0.6)
    peak = cv.layer('peak', halo=0.9)
    mid = cv.layer('mid', halo=0.9)
    near = cv.layer('near', halo=1.0)
    t = time.time()
    SB.far(far, rng)
    SB.peak(peak, rng)
    FL.rocks(peak, rng)
    SB.peak_color(peak, rng)
    SB.mid(mid, rng)
    SF.rocks(near, rng)
    SF.stream_and_lake(near, rng)
    SF.trees(near, rng)
    SF.figures(near, rng)
    print(f'painted in {time.time() - t:.1f}s', flush=True)
    return cv, dict(far=far, peak=peak, mid=mid, near=near)


def compose(cv, layers, scale):
    h, w = cv.h, cv.w
    rng = np.random.default_rng(SEED + 5)
    water, spray = FL.masks(h, w, rng)
    tot = np.zeros((h, w, 3), np.float32)
    for name, L in layers.items():
        L.finalize()
        a = L.A
        if name in MIST:
            a = a * (1 - A.mist_mask(h, w, MIST[name], rng))[..., None]
        if name == 'peak':
            a = a * (1 - light_mask(h, w, rng))[..., None]
        if name in ('peak', 'far', 'mid'):
            a = a * ((1 - water) * (1 - 0.95 * spray))[..., None]
        tot += a
    B.mark('云雾', 560, 1560)
    # threads of falling water drawn after the reservation so they stay visible
    tmp = cv.layer('fall', halo=0.0)
    FL.after(tmp, rng)
    tmp.finalize()
    tot += tmp.A
    for (cx, cy, sz, oval) in ((2235, 3035, 120, False), (2245, 2885, 70, True)):
        y0, x0, patch = F.seal(h, w, cx, cy, sz, np.random.default_rng(int(sz)), oval=oval)
        ph, pw = patch.shape[:2]
        tot[y0:y0 + ph, x0:x0 + pw] += patch
    B.mark('印章', 2235, 3035)
    ins, boxes = INS.render(cv, np.random.default_rng(SEED + 9))
    tot += ins
    sx, _, sz = INS.SEAL
    sy = boxes[2][3] + sz * 0.75                       # name seal just under the signature
    y0, x0, patch = F.seal(h, w, sx, sy, sz, np.random.default_rng(77))
    ph, pw = patch.shape[:2]
    tot[y0:y0 + ph, x0:x0 + pw] += patch
    B.mark('名章', sx, sy)
    img = cv.paper * np.exp(-tot)
    return np.clip(img, 0, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--out', default=HERE)
    ap.add_argument('--name', default='shanshui')
    ap.add_argument('--brush', default=None, choices=['classic', 'bristle'],
                    help='brush model for 皴/飞白/松针 (default: env BRUSH or classic)')
    a = ap.parse_args()
    if a.brush:
        B.set_brush(a.brush)
    cv, layers = build(a.scale)
    img = compose(cv, layers, a.scale)
    bgr = (img[..., ::-1] * 255 + 0.5).astype(np.uint8)
    os.makedirs(a.out, exist_ok=True)
    cv2.imwrite(os.path.join(a.out, f'{a.name}.png'), bgr)
    pv = cv2.resize(bgr, (1200, 1600), interpolation=cv2.INTER_AREA)
    cv2.imwrite(os.path.join(a.out, f'{a.name}_preview.jpg'), pv, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if B.BRUSH != 'classic' and a.name == 'shanshui':
        print('note: non-classic brush -> pass --name to avoid overwriting shanshui.png')
    with open(os.path.join(a.out, 'labels.json'), 'w') as f:
        json.dump({'sheet': [W0, H0], 'labels': B.LABELS}, f, ensure_ascii=False, indent=1)
    print('saved', a.out, bgr.shape)


if __name__ == '__main__':
    main()
