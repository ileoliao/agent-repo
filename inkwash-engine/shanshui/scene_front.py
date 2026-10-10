"""Front half: 斧劈 boulders (浓墨) with trees rooted on their crests, 泼墨 / 破墨 masses, the pavilion
on a flat ledge, the stream entering the lake, the fishing boat. Design units."""
from __future__ import annotations

import numpy as np

from inkwash.core import INDIGO, INK, OCHRE
from . import atmos as A
from . import brush as B
from . import figures as F
from . import trees as T
from .massif import Massif
from . import textures as X

BOAT = (1800, 2760)
C = {}          # crest contours of the foreground rocks, filled by rocks()


def at(crest, x):
    return float(np.interp(x, crest[:, 0], crest[:, 1]))


def rocks(L, rng):
    """浓墨 foreground: angular boulders painted front -> back; 泼墨 on the front mass, 破墨 on the left."""
    M = Massif(L)
    kw = dict(style=('fupi', 'cefeng', 'wet'), dens=0.28, line=8, sharp=2.4, steps=0.3, round_=0.55, moss=0, fade=0.0,
              bump=0.1, extend=420)
    C['front'] = M.lobe(720, 3340, 720, 400, rng, ink=0.95, **{**kw, 'skew': 0.2, 'extend': 0, 'line': 9.5})
    M.lobe(1020, 3310, 560, 330, rng, ink=0.9, **{**kw, 'skew': -0.2, 'extend': 0, 'style': 'fupi', 'line': 6})
    C['water'] = M.lobe(1340, 3015, 330, 115, rng, ink=0.8, **{**kw, 'line': 5, 'fade': 1.0, 'extend': 0})
    C['ledge'] = M.lobe(990, 2940, 580, 480, rng, ink=0.85, **{**kw, 'sharp': 6, 'round_': 0.3, 'steps': 0.0,
                                                                  'skew': 0.1, 'bump': 0.04, 'extend': 70,
                                                                  'fade': 0.5})
    C['pine'] = M.lobe(620, 2900, 520, 470, rng, ink=0.9, **{**kw, 'skew': 0.3, 'sharp': 3.0, 'round_': 0.45,
                                                            'moss': 1, 'line': 6.5, 'gaps': 0.25})
    C['left'] = M.lobe(200, 2880, 700, 560, rng, ink=0.9, **{**kw, 'skew': 0.2, 'sharp': 3.0, 'round_': 0.45})
    C['shore'] = M.lobe(2180, 3300, 660, 210, rng, ink=0.75, skew=-0.2, **{**kw, 'line': 6})
    B.mark('斧劈皴', 1150, 2640)
    B.mark('浓墨', 820, 3080)
    B.pomo_splash(L, [(0, 3010), (60, 2935), (150, 2920), (215, 2875), (300, 2905), (350, 2960), (430, 2985),
                      (470, 3060), (455, 3130), (500, 3200), (0, 3200)], rng, dens=2.0)
    B.mark('泼墨', 230, 3080)
    for (x, y) in ((880, 2600), (1120, 2760)):          # a couple of moss clumps in rock seams only
        X.moss_cluster(L, x, y, rng, spread=10)
    for (cx, cy, w, h, pig) in ((960, 2700, 460, 300, OCHRE), (250, 2650, 420, 400, INDIGO)):
        W, H = int(w * B.S), int(h * B.S)
        f = B.blob_field(W, H, rng, cell=w * 0.3)
        L.wash(int((cx - w / 2) * B.S), int((cy - h / 2) * B.S), f, pig, dens=0.08, lo=0.05, hi=0.9, edge=0.1,
               edge_blur=5, gran=0.5)


def stream_and_lake(L, rng):
    """The stream leaves the mist and zig-zags (之) into the lake; water itself stays paper."""
    for (x, y, ln) in ((1130, 1760, 280), (1120, 1915, 330), (1360, 2000, 280)):
        q = [(x, y), (x + ln * 0.3, y - 7), (x + ln * 0.75, y - 3), (x + ln, y + 4)]
        L.stroke(B.P(q), 2.6 * B.S, ink=0.36, dry=0.4, wet=0.5, taper=(0.2, 0.5), start_w=0.4)
        poly = [(x + 10, y), (x + ln * 0.3, y - 6), (x + ln * 0.8, y - 2), (x + ln, y + 4), (x + ln * 0.5, y + 22)]
        x0, y0, f = B.poly_field(poly, blur=6)
        B.field_wash(L, x0, y0, f, pig=INK * 0.8 + OCHRE * 0.2, dens=0.1, edge=0.3)
    A.ripples(L, 1350, 2350, 2120, 3050, 30, rng, ink=0.16)
    B.mark('留白', 1700, 2380)


def trees(L, rng):
    """Trees rooted on the crests (root claws + moss at each foot)."""
    T.bare_tree(L, 95, at(C['left'], 95) + 8, 430, rng, lean=-0.05)
    T.leaf_tree(L, 290, at(C['left'], 290) + 8, 420, rng, kind='jie', lean=0.03, n_clusters=6, leaf_ink=0.95)
    T.pine(L, 470, at(C['left'], 470) + 10, 580, rng, lean=-0.07, ink=0.85)
    T.pine(L, 630, at(C['pine'], 630) + 8, 780, rng, lean=0.09)
    B.mark('焦墨', 630, at(C['pine'], 630) + 4)
    T.leaf_tree(L, 800, at(C['ledge'], 800) + 6, 330, rng, kind='ge', lean=0.05, n_clusters=5, leaf_ink=0.9)
    T.bare_tree(L, 1190, at(C['ledge'], 1190) + 6, 300, rng, lean=0.14, ink=0.85)
    B.mark('飞白', 95, at(C['left'], 95) - 120)


def figures(L, rng):
    x = 990
    y = at(C['ledge'], x)
    a = F.pavilion(L, x, y + 3, 130, rng)
    B.mark('茅亭', *a)
    b = F.boat(L, BOAT[0], BOAT[1], 190, rng)
    B.mark('渔舟', *b)
    F.scholar(L, 895, at(C['ledge'], 895) + 2, 40, rng, seated=False, facing=1)
