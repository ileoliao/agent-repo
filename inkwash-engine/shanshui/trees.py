"""Trees: 松 with 松针 fans, 介字点 / 个字点 foliage trees, bare 蟹爪 trees. Design units."""
from __future__ import annotations

import math

import numpy as np

from inkwash.core import INDIGO, INK
from . import brush as B
from . import textures as X


def _st(L, pts, w, ink, **kw):
    kw.setdefault('dry', 0.4)
    kw.setdefault('wet', 0.4)
    kw.setdefault('rough', 0.4)
    L.stroke(B.P(pts), max(0.4, w * B.S), ink=ink, **kw)


def trunk(L, x, y, h, w, rng, lean=0.0, ink=0.9, wiggle=0.06):
    """Two-sided 飞白 trunk outline + pale fill. Returns centreline points (bottom->top)."""
    n = 7
    c = [(x, y)]
    cx, cy = x, y
    for j in range(1, n):
        cx += lean * h / n + rng.normal(0, h * wiggle / n * 3)
        cy -= h / (n - 1)
        c.append((cx, cy))
    c = np.array(c)
    taper = np.linspace(1.0, 0.45, n)[:, None]
    for side in (-1, 1):
        edge = c + np.c_[side * w * 0.5 * taper[:, 0], np.zeros(n)] + rng.normal(0, w * 0.06, (n, 2))
        _st(L, edge, w * 0.16 + 1.2, ink * rng.uniform(0.85, 1.05), dry=0.75, bristle=1.8, taper=(0.05, 0.3),
            start_w=1.0, end_w=0.3, **B.bk(entry='cang'))
    _st(L, c, w * 0.75, ink * 0.28, dry=0.85, bristle=2.0, taper=(0.02, 0.2), start_w=1.0, end_w=0.5, wet=0.2)
    return c


def roots(L, x, y, w, rng, ink=0.9):
    """Roots gripping the rock: short claws spreading out and down, plus 焦墨 moss at the foot."""
    for k in range(int(rng.integers(3, 6))):
        d = rng.choice([-1, 1])
        ln = w * rng.uniform(0.8, 1.8)
        _st(L, [(x + d * w * 0.2, y - w * 0.3), (x + d * ln * 0.6, y + rng.uniform(0, 4)),
                (x + d * ln, y + rng.uniform(3, 10))], w * rng.uniform(0.15, 0.3), ink, dry=0.6,
            taper=(0.05, 0.7), start_w=1.0)
    X.moss_cluster(L, x, y + 2, rng, n=int(rng.integers(4, 9)), spread=w * 0.8, size=3.4)


def branch(L, p, ang, ln, w, rng, ink, crab=False):
    """One crooked branch (鹿角 up / 蟹爪 tips curl down); returns end point."""
    pts = [p]
    x, y = p
    a = ang
    for j in range(4):
        a += rng.normal(0, 0.28)
        if crab and j >= 2:
            a += 0.35 * (1 if math.cos(a) > 0 else -1)
        x, y = x + math.cos(a) * ln / 4, y + math.sin(a) * ln / 4
        pts.append((x, y))
    _st(L, pts, w, ink, dry=0.55, taper=(0.03, 0.6), start_w=1.0, end_w=0.08, bristle=1.4,
        **B.bk(entry='cang', exit='tip', splay=0.6))
    return pts


def pine(L, x, y, h, rng, lean=0.08, ink=0.95, scale=1.0):
    w = h * 0.07
    c = trunk(L, x, y, h, w, rng, lean=lean, ink=ink, wiggle=0.08)
    roots(L, x, y, w, rng, ink)
    for k in range(int(h / 22)):       # 鳞皴 bark scales
        t = rng.uniform(0.05, 0.85)
        px = np.interp(t, np.linspace(0, 1, len(c)), c[:, 0]) + rng.normal(0, w * 0.2)
        py = np.interp(t, np.linspace(0, 1, len(c)), c[:, 1])
        _st(L, [(px - w * 0.2, py), (px, py + w * 0.12), (px + w * 0.2, py)], 1.3, ink * 0.7, dry=0.5)
    fans = []
    nb = int(rng.integers(4, 7))
    for b in range(nb):
        t = 0.4 + 0.6 * b / nb + rng.uniform(-0.04, 0.04)
        j = min(len(c) - 1, int(t * (len(c) - 1)))
        side = 1 if (b % 2 == 0) ^ (rng.random() < 0.3) else -1
        ang = (0 if side > 0 else math.pi) + rng.uniform(-0.3, 0.12) * (1 if side > 0 else -1)
        ln = h * rng.uniform(0.18, 0.32) * (1.2 - 0.5 * t)
        pts = branch(L, tuple(c[j]), ang, ln, w * 0.35, rng, ink)
        fans += [pts[2], pts[-1]]
    fans.append(tuple(c[-1]))
    for (fx, fy) in fans:
        needle_cluster(L, fx, fy - 2, h * rng.uniform(0.06, 0.08) * scale, rng, ink)
    return fans


def needle_cluster(L, x, y, r, rng, ink=0.9):
    """松针: a flat plate of small half-wheel fans of needles, with a pale indigo under-wash."""
    nh = int(rng.integers(5, 9))
    for k in range(nh):
        hx = x + rng.uniform(-1.4, 1.4) * r
        hy = y + rng.uniform(-0.3, 0.3) * r
        n = int(rng.integers(9, 14))
        span = rng.uniform(math.pi * 0.8, math.pi * 1.0)
        a0 = -math.pi / 2 - span / 2 + rng.normal(0, 0.15)
        ii = rng.uniform(0.7, 1.05)
        l0 = r * rng.uniform(0.45, 0.6)
        for i in range(n):
            a = a0 + span * i / (n - 1)
            l = l0 * rng.uniform(0.8, 1.0)
            _st(L, [(hx, hy), (hx + math.cos(a) * l, hy + math.sin(a) * l)], 1.0, ink * ii,
                dry=0.15, taper=(0.05, 0.6), start_w=1.0, end_w=0.1, wet=0.2, **B.bk(exit='tip'))
    B.mark('松针', x, y - r * 0.3)
    W, H = int(r * 3.6 * B.S), int(r * 1.3 * B.S)
    if W > 4 and H > 4:
        f = B.blob_field(W, H, rng, cell=r)
        L.wash(int(x * B.S - W / 2), int((y - r * 0.25) * B.S - H / 2), f, INDIGO * 0.5 + INK * 0.5, dens=0.2,
               lo=0.1, hi=0.9, edge=0.4, edge_blur=3, gran=0.4)


def jiezi(L, x, y, s, ink, rng):
    """介字点: two strokes splaying down from an apex (^), sometimes with a short pair under it."""
    a = rng.normal(0, 0.25)
    for d in (-1, 1):
        ang = math.pi / 2 + d * 0.62 + a
        _st(L, [(x, y), (x + math.cos(ang) * s, y + math.sin(ang) * s)], s * 0.22, ink, dry=0.1, wet=0.7,
            taper=(0.15, 0.6), start_w=0.4, end_w=0.15)


def gezi(L, x, y, s, ink, rng):
    """个字点: three pointed leaves fanning down from one point (like bamboo leaves)."""
    a = rng.normal(0, 0.3)
    for d, k in ((-1, 1.0), (1, 1.0), (0, 0.7)):
        ang = math.pi / 2 + d * 0.75 + a
        l = s * k
        _st(L, [(x, y), (x + math.cos(ang) * l * 0.5, y + math.sin(ang) * l * 0.5),
                (x + math.cos(ang) * l, y + math.sin(ang) * l)], s * 0.3, ink, dry=0.05, wet=0.8,
            taper=(0.2, 0.75), start_w=0.5, end_w=0.04)


def leaf_tree(L, x, y, h, rng, kind='jie', lean=0.0, ink=0.9, leaf_ink=0.8, n_clusters=5):
    """Deciduous tree with foliage clusters of 介字点 or 个字点 at branch tips."""
    w = h * 0.05
    c = trunk(L, x, y, h * 0.75, w, rng, lean=lean, ink=ink)
    roots(L, x, y, w, rng, ink)
    tips = []
    for b in range(int(rng.integers(3, 5))):
        j = int(rng.integers(3, len(c)))
        ang = -math.pi / 2 + rng.uniform(-1.1, 1.1)
        pts = branch(L, tuple(c[j]), ang, h * rng.uniform(0.2, 0.35), w * 0.4, rng, ink)
        tips.append(pts[-1])
    tips.append(tuple(c[-1]))
    f = jiezi if kind == 'jie' else gezi
    s = h * (0.055 if kind == 'jie' else 0.07)
    for k in range(n_clusters):
        tx, ty = tips[k % len(tips)]
        tx += rng.normal(0, h * 0.06)
        ty += rng.normal(0, h * 0.04)
        li = leaf_ink * rng.uniform(0.6, 1.1)
        for _ in range(int(rng.integers(8, 15))):
            f(L, tx + rng.normal(0, h * 0.09), ty + rng.normal(0, h * 0.055), s * rng.uniform(0.8, 1.2), li, rng)
    B.mark('介字点' if kind == 'jie' else '个字点', tips[0][0], tips[0][1])


def bare_tree(L, x, y, h, rng, lean=0.0, ink=0.9):
    """寒林 bare tree: trunk + forking crab-claw branches."""
    w = h * 0.045
    c = trunk(L, x, y, h * 0.6, w, rng, lean=lean, ink=ink)
    roots(L, x, y, w, rng, ink)

    def grow(p, ang, ln, bw, d):
        pts = branch(L, p, ang, ln, max(0.9, bw), rng, ink * (0.8 + 0.07 * d), crab=(d == 0))
        if d > 0:
            for _ in range(int(rng.integers(2, 4))):
                a = ang + rng.normal(0, 0.5)
                a = -math.pi / 2 + (a + math.pi / 2) * 0.85        # keep twigs reaching upward/outward
                grow(pts[int(rng.integers(2, 5))], a, ln * rng.uniform(0.5, 0.7), bw * 0.55, d - 1)

    for j in (3, 4, 5, 6):
        side = -1 if j % 2 else 1
        grow(tuple(c[min(j, len(c) - 1)]), -math.pi / 2 + side * rng.uniform(0.3, 1.0), h * 0.26, w * 0.38, 3)
    B.mark('飞白', c[1][0], c[1][1])
