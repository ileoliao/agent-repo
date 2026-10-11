"""叠泉 waterfall: a dark water mouth (notch) at the source, two stages broken by a rock step, a thin
side strand, and a plunge pool with spray (水汽). Water / pool / spray are 留白 masks applied at composite."""
from __future__ import annotations

import math

import cv2
import numpy as np

from inkwash.core import INDIGO, INK, fbm, smoothstep
from . import brush as B
from . import rocks as R

MOUTH = (1546, 988)
STAGES = [  # (path, (width_top, width_bottom))
    ([(1546, 992), (1543, 1080), (1547, 1168)], (12, 24)),
    ([(1531, 1214), (1527, 1310), (1533, 1428)], (20, 34)),
    ([(1566, 1212), (1569, 1300), (1566, 1380)], (5, 9)),       # thin side strand
]
STEP = [(1508, 1196), (1522, 1172), (1560, 1168), (1584, 1186), (1578, 1212), (1515, 1214)]
POOL = (1545, 1455, 95, 16)                                  # cx, cy, rx, ry
SPRAY = (1545, 1400, 175, 95)


def _ribbon(m, path, width):
    pts = np.asarray(path, np.float64)
    k = len(pts)
    for i in range(k - 1):
        a, b = pts[i] * B.S, pts[i + 1] * B.S
        wd = np.interp(i + 0.5, [0, k - 1], width) * B.S
        cv2.line(m, tuple(np.int32(a)), tuple(np.int32(b)), 1.0, max(1, int(wd)), cv2.LINE_AA)


def masks(h, w, rng):
    """Returns (water, spray): water = hard-ish 留白 (falls + pool), spray = soft mist to lift ink."""
    m = np.zeros((h, w), np.float32)
    for path, wd in STAGES:
        _ribbon(m, path, wd)
    cx, cy, rx, ry = POOL
    cv2.ellipse(m, (int(cx * B.S), int(cy * B.S)), (int(rx * B.S), int(ry * B.S)), 0, 0, 360, 1.0, -1, cv2.LINE_AA)
    rag = fbm(h, w, 9 * B.S + 1, 3, rng, cell_y=50 * B.S + 1)
    water = smoothstep(0.25, 0.75, cv2.GaussianBlur(m, (0, 0), 3.0 * B.S + 0.5) + 0.18 * rag)
    sx, sy, srx, sry = SPRAY
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = ((xx / B.S - sx) / srx) ** 2 + ((yy / B.S - sy) / sry) ** 2
    puff = fbm(h, w, 40 * B.S + 1, 3, rng)
    spray = np.clip(np.exp(-d * 1.6) * (0.85 + 0.3 * puff), 0, 1)
    # splash plume where stage 1 hits the rock step
    d2 = ((xx / B.S - 1546) / 55) ** 2 + ((yy / B.S - 1170) / 20) ** 2
    spray = np.maximum(spray, 0.7 * np.exp(-d2 * 2.0))
    return water, spray


def rocks(L, rng):
    """Dark mouth notch, rock lips along each stage, the interrupting step, pool rims."""
    mx, my = MOUTH
    for d in (-1, 1):                                 # V-shaped notch cut into the cliff above the source
        L.stroke(B.P([(mx + d * 30, my - 34), (mx + d * 16, my - 14), (mx + d * 9, my + 2)]), 8 * B.S, ink=1.2,
                 dry=0.55, wet=0.4, taper=(0.3, 0.2), start_w=0.3, end_w=0.9, rough=0.55, bristle=1.6)
    L.stroke(B.P([(mx - 16, my - 1), (mx, my - 6), (mx + 16, my - 1)]), 4 * B.S, ink=1.2, dry=0.3, taper=(0.2, 0.2))
    x0, y0, f = B.poly_field([(mx - 30, my - 50), (mx + 34, my - 46), (mx + 10, my + 4), (mx - 10, my + 4)], blur=9)
    L.wash(x0, y0, f, INK, dens=0.55, lo=0.15, hi=0.95, edge=0.3, edge_blur=4, gran=0.6, warp=0.4)
    for path, (w0, w1) in STAGES:
        pts = np.asarray(path, np.float64)
        for d in (-1, 1):
            for k in range(2):
                q = [(x + d * (np.interp(y, pts[[0, -1], 1], [w0, w1]) * 0.55 + 4 + 9 * k) + rng.normal(0, 2.5), y)
                     for (x, y) in pts]
                L.stroke(B.P(q), (7 - 3 * k) * B.S, ink=1.25 - 0.5 * k, dry=0.4 + 0.2 * k, wet=0.5,
                         taper=(0.05, 0.25), start_w=0.7, end_w=0.4, rough=0.45)
    # the rock step that breaks the fall into two stages
    x0, y0, f = B.poly_field(STEP, blur=1.5)
    L.wash(x0, y0, f, INK, dens=0.75, lo=0.1, hi=0.85, edge=0.6, edge_blur=2, gran=0.6)
    R.outline(L, STEP[:4], rng, w=5, ink=1.3, dry=0.5, seg=(2, 3), gaps=0.0)
    # pool rims: low dark rocks left / right and a broken front lip
    cx, cy, rx, ry = POOL
    for sx, sw in ((-1, 70), (1, 60)):
        bx = cx + sx * (rx + sw * 0.35)
        poly = [(bx - sw / 2, cy + 18), (bx - sw * 0.3, cy - 14), (bx + sw * 0.2, cy - 22), (bx + sw / 2, cy + 18)]
        x0, y0, f = B.poly_field(poly, blur=2)
        L.wash(x0, y0, f, INK, dens=0.55, lo=0.1, hi=0.85, edge=0.5, edge_blur=2, gran=0.5)
        R.outline(L, poly[:4], rng, w=4, ink=1.1, dry=0.5, seg=(2, 3), gaps=0.0)
    for _ in range(9):                                # front lip: scattered pebbles, not a drawn line
        u = rng.uniform(-1.0, 1.0)
        B.midot(L, cx + rx * u, cy + ry + rng.uniform(4, 12), rng.uniform(3, 6), rng.uniform(0.5, 0.9), rng)
    B.mark('叠泉', 1540, 1195)
    B.mark('留白', 1531, 1330)


def after(L, rng):
    """Drawn after the reservation: faint threads in the falls, ripple arcs in the pool, pale spray wash."""
    pig = INDIGO * 0.5 + INK * 0.5
    for path, (w0, w1) in STAGES[:2]:
        pts = np.asarray(path, np.float64)
        for _ in range(6):
            u = rng.uniform(-0.3, 0.3)
            q = [(x + u * np.interp(y, pts[[0, -1], 1], [w0, w1]), y) for (x, y) in pts]
            L.stroke(B.P(q), 1.0 * B.S, ink=0.14, pig=pig, dry=0.6, wet=0.1, taper=(0.3, 0.3), start_w=0.2,
                     end_w=0.2)
    cx, cy, rx, ry = POOL
    for k in range(3):
        r = 0.35 + 0.25 * k
        q = [(cx + rx * r * math.cos(a), cy + 4 + ry * r * 0.6 * math.sin(a)) for a in np.linspace(0.3, 2.8, 6)]
        L.stroke(B.P(q), 1.2 * B.S, ink=0.2, pig=pig, dry=0.4, taper=(0.3, 0.3), start_w=0.2, end_w=0.2)
    sx, sy, srx, sry = SPRAY
    W, H = int(srx * 2.4 * B.S), int(sry * 2.2 * B.S)
    f = B.blob_field(W, H, rng, cell=60)
    ring = f - B.blob_field(W, H, rng, cell=60, thresh=-0.35)            # pale halo around the white core
    L.wash(int((sx - srx * 1.2) * B.S), int((sy - sry * 1.1) * B.S), ring, pig, dens=0.1,
           lo=0.12, hi=0.9, edge=0.2, edge_blur=6, gran=0.4, warp=0.3)
    B.mark('水汽', sx + 60, sy - 20)
