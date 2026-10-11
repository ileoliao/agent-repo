"""v2 皴法 vocabulary: every stroke draws length / direction / curvature / pressure / wetness from wide,
region-specific ranges so no two passages look stamped.

All functions paint into `s` (a clipped scratch layer) over one lobe described by its crest `top`
(design units), foot y `by` and height `h`."""
from __future__ import annotations

import math

import numpy as np

from inkwash.core import INK
from . import brush as B


def _crest(top, x):
    return float(np.interp(x, top[:, 0], top[:, 1]))


def _slope(top, x):
    return (_crest(top, x + 8) - _crest(top, x - 8)) / 16


def _curve(x, y, ang, ln, bend, n=6):
    return [(x + sum(math.cos(ang + bend * u) for u in np.linspace(0, t, 4)) / 4 * ln * t,
             y + sum(math.sin(ang + bend * u) for u in np.linspace(0, t, 4)) / 4 * ln * t)
            for t in np.linspace(0, 1, n)]


def cefeng(s, top, by, h, n, ink, rng, pig=INK, light=-1):
    """侧锋 dry brush for the main-peak faces, laid in *passes*: each pass is a group of 3-7 broad, broken,
    飞白-streaked side strokes sharing one facet direction, hugging the crest / shadow flank and thinning
    downward into mist. Lengths, widths, pressure and dryness vary per stroke and per pass."""
    x0, x1 = top[0, 0], top[-1, 0]
    cx = (x0 + x1) / 2
    done = 0
    while done < n:
        x = rng.uniform(x0 + 0.04 * (x1 - x0), x1 - 0.04 * (x1 - x0))
        shadow = (x > cx) == (light < 0)
        if not shadow and rng.random() < 0.45:
            continue
        yt = _crest(top, x)
        if by - yt < 30:
            continue
        y = yt + (by - yt) * rng.beta(0.9, 3.2) * 0.9          # hug the crest
        fall = math.atan(_slope(top, x))
        ang = math.pi / 2 + fall * rng.uniform(0.3, 0.8) + rng.normal(0, 0.18)
        kind = rng.random()
        long_pass = kind < 0.45
        thin = kind > 0.8                                     # thin dry wrinkles between the broad passes
        k = int(rng.integers(2, 7))
        side = 1 if rng.random() < 0.5 else -1
        p_ink = ink * rng.uniform(0.55, 1.05) * (1.0 if shadow else 0.65)
        for j in range(k):
            o = j * rng.uniform(6, 15)
            px, py = x + side * o, y + rng.uniform(-15, 45)       # staggered, never a neat comb
            if thin:
                ln, w, dry = rng.uniform(70, 200), rng.uniform(1.8, 3.5), rng.uniform(0.4, 0.75)
            elif long_pass:
                ln, w, dry = rng.uniform(60, 170), rng.uniform(5, 12), rng.uniform(0.7, 0.95)
            else:
                ln, w, dry = rng.uniform(20, 55), rng.uniform(7, 16), rng.uniform(0.45, 0.8)
            q = _curve(px, py, ang + rng.normal(0, 0.08), ln, rng.normal(0, 0.3))
            s.stroke(B.P(q), w * B.S, ink=p_ink * rng.uniform(0.7, 1.1), pig=pig, dry=dry, wet=0.15,
                     taper=(rng.uniform(0.02, 0.15), rng.uniform(0.3, 0.7)), start_w=rng.uniform(0.7, 1.0),
                     end_w=rng.uniform(0.05, 0.4), rough=rng.uniform(0.25, 0.45), bristle=rng.uniform(1.5, 2.3),
                     wobble=rng.uniform(0.1, 0.3), pool=0.2, **B.bk(tip='zhong' if thin else 'ce', entry='lu', load=1.15))
        done += k


def wetfoot(s, top, by, h, n, ink, rng, pig=INK):
    """Slope feet: wet pale ink pooled softly near the foot (no stroke shapes, edges melt into paper)."""
    x0, x1 = top[0, 0], top[-1, 0]
    for _ in range(n):
        x = rng.uniform(x0, x1)
        yt = _crest(top, x)
        y = yt + (by - yt) * rng.uniform(0.55, 0.9)
        w, hh = rng.uniform(60, 160), rng.uniform(25, 60)
        W, H = int(w * B.S), int(hh * B.S)
        if W < 6 or H < 6:
            continue
        f = B.blob_field(W, H, rng, cell=w * 0.4, soft=1.2)
        s.wash(int((x - w / 2) * B.S), int((y - hh / 2) * B.S), f, pig, dens=ink * rng.uniform(0.1, 0.22), lo=0.1,
               hi=0.95, edge=0.15, edge_blur=4 * B.S + 1, gran=0.5, warp=0.35, wet=1.6)


def pima_long(s, top, by, h, n, ink, rng, pig=INK):
    """披麻 for earthy hills: long, gently curving hemp strokes that start under the crest and bend to follow
    the dome's flank; sparse bundles, each with its own length, pressure and wetness."""
    x0, x1 = top[0, 0], top[-1, 0]
    cx = (x0 + x1) / 2
    for _ in range(n):
        x = rng.uniform(x0 + 0.05 * (x1 - x0), x1 - 0.05 * (x1 - x0))
        yt = _crest(top, x)
        if by - yt < 25:
            continue
        y = yt + rng.uniform(3, 0.3 * (by - yt))
        sl = math.atan(_slope(top, x))
        ang = math.pi / 2 - sl * rng.uniform(0.4, 0.8)
        bend = (0.25 if x > cx else -0.25) * rng.uniform(0.3, 1.4)  # curve outward with the dome
        l0 = (by - y) * rng.uniform(0.35, 0.9)
        wet = rng.uniform(0.2, 1.0)
        for j in range(int(rng.integers(2, 6))):            # bundle of hemp fibres
            off = (j - 2) * rng.uniform(4, 8)
            q = _curve(x + off, y + abs(off) * 0.4, ang, l0 * rng.uniform(0.7, 1.05), bend)
            s.stroke(B.P(q), rng.uniform(1.0, 2.6) * B.S, ink=ink * rng.uniform(0.35, 0.95), pig=pig,
                     dry=0.75 - 0.5 * wet, wet=wet, taper=(rng.uniform(0.1, 0.35), rng.uniform(0.3, 0.6)),
                     start_w=0.3, end_w=0.1, rough=0.3, wobble=rng.uniform(0.15, 0.4), **B.bk(entry='lu', exit='tip'))


def moss_cluster(L, x, y, rng, n=None, spread=14, size=3.6, ink=1.4):
    """点苔 as an irregular clump: a few big wet dots, several small dry flicks, varied shapes."""
    n = n or int(rng.integers(4, 11))
    for _ in range(n):
        r = size * rng.choice([0.45, 0.7, 1.0, 1.5], p=[0.35, 0.3, 0.25, 0.1])
        dx, dy = rng.normal(0, spread), rng.normal(0, spread * 0.35)
        if rng.random() < 0.3:                                # flick: short slanted stroke
            a = math.pi / 2 + rng.normal(0, 0.6)
            L.stroke(B.P([(x + dx, y + dy), (x + dx + math.cos(a) * r * 2.2, y + dy + math.sin(a) * r * 2.2)]),
                     r * 0.8 * B.S, ink=ink * rng.uniform(0.6, 1.0), dry=0.4, wet=0.4, taper=(0.1, 0.7), start_w=1.0)
        else:
            L.dot((x + dx) * B.S, (y + dy) * B.S, r * B.S, ink=ink * rng.uniform(0.55, 1.1),
                  ang=math.pi / 2 + rng.normal(0, 0.5), elong=rng.uniform(0.9, 1.9), wet=rng.uniform(0.3, 1.2))


def bundles(s, top, by, h, n, ink, rng, pig=INK, light=-1):
    """v3 侧锋 for the main peak: coherent directional bundles. Each bundle = 4-9 long side-brush strokes laid
    side by side down the fall line of the face (shared direction + gentle shared curve), broad at the start,
    dragging dry (飞白) at the end. Dense under the crest and on the shadow side; few isolated fragments."""
    x0, x1 = top[0, 0], top[-1, 0]
    cx = (x0 + x1) / 2
    for _ in range(n):
        x = rng.uniform(x0 + 0.05 * (x1 - x0), x1 - 0.05 * (x1 - x0))
        shadow = (x > cx) == (light < 0)
        if not shadow and rng.random() < 0.35:
            continue
        yt = _crest(top, x)
        if by - yt < 60:
            continue
        y = yt + (by - yt) * rng.beta(1.0, 2.6) * 0.8
        fall = math.atan(_slope(top, x))
        ang = math.pi / 2 + fall * rng.uniform(0.35, 0.7) + rng.normal(0, 0.08)
        bend = rng.normal(0, 0.18)
        ln0 = rng.uniform(110, 300) * (0.6 + 0.4 * (by - y) / max(h, 1))
        w0 = rng.uniform(5, 11)
        k = int(rng.integers(4, 10))
        b_ink = ink * rng.uniform(0.7, 1.1) * (1.0 if shadow else 0.7)
        perp = (math.cos(ang + math.pi / 2), math.sin(ang + math.pi / 2))
        for j in range(k):
            o = (j - k / 2) * w0 * rng.uniform(0.9, 1.4)
            q = _curve(x + perp[0] * o, y + perp[1] * o + rng.uniform(-10, 10), ang, ln0 * rng.uniform(0.6, 1.05),
                       bend + rng.normal(0, 0.05))
            s.stroke(B.P(q), w0 * rng.uniform(0.7, 1.2) * B.S, ink=b_ink * rng.uniform(0.75, 1.1), pig=pig,
                     dry=rng.uniform(0.45, 0.85), wet=0.25, taper=(0.04, rng.uniform(0.35, 0.6)), start_w=0.9,
                     end_w=0.08, rough=0.35, bristle=1.9, wobble=0.15, pool=0.3, **B.bk(tip='ce', entry='cang', load=1.15))
