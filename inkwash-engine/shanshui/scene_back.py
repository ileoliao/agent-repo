"""Back half: far 米点 hills + 平远 shore, the towering main peak (高远) with its waterfall cleft,
and the layered 披麻 mid hills receding up the valley (深远). Design units, 2400 x 3200."""
from __future__ import annotations

import numpy as np

from inkwash.core import INDIGO, INK, OCHRE
from . import atmos as A
from . import brush as B
from . import trees as T
from .massif import Massif
from . import textures as X

SHORE_Y = 1945


def far(L, rng):
    """清墨: distant peaks (米点) above the clouds; low 米点 hills and flat banks on the right (平远)."""
    pig = INK * 0.85 + INDIGO * 0.15
    A.mi_hills(L, 0, 840, 1250, [(150, 430, 260), (470, 570, 300), (740, 390, 200)], rng, ink=0.1, dot_r=13,
               wash=0.05, pig=pig, density=0.8)
    A.mi_hills(L, 1950, 2400, 1300, [(2130, 390, 220), (2360, 490, 240)], rng, ink=0.07, dot_r=12, wash=0.04, pig=pig, density=0.8)
    A.mi_hills(L, 1480, 2400, SHORE_Y - 8, [(1690, 80, 190), (1990, 150, 270), (2290, 105, 210)], rng, ink=0.1,
               dot_r=10, wash=0.05, pig=pig, density=0.9)
    A.flat_shore(L, 1380, 2400, SHORE_Y, rng, ink=0.26, pig=pig)
    A.mi_hills(L, 1900, 2400, SHORE_Y - 150, [(2100, 70, 200), (2330, 95, 180)], rng, ink=0.06, dot_r=10, wash=0.03,
               pig=pig, density=0.7)
    A.flat_shore(L, 1700, 2400, SHORE_Y + 70, rng, ink=0.22, pig=pig)
    B.mark('平远', 2120, SHORE_Y)
    B.mark('清墨', 470, 760)


def peak(L, rng):
    """重墨: the main peak massif painted front -> back so nearer lobes occlude farther ones.
    Faces: dry 侧锋 side-brush + 飞白; feet: wet pale soft strokes; cliffs: 斧劈; foothills: long 披麻."""
    M = Massif(L)
    dry = ('bundle', 'wet')
    cut = ('fupi', 'cefeng')
    soft = ('pima2', 'wet')
    # foothills sinking into the cloud band
    M.lobe(690, 1590, 460, 250, rng, style=soft, ink=0.34, dens=0.1, line=3, skew=-0.2, sharp=2.2, n_tex=14)
    M.lobe(1170, 1610, 520, 240, rng, style=soft, ink=0.34, dens=0.1, line=3.5, skew=0.15, sharp=2.0, n_tex=14,
           gaps=0.35)
    M.lobe(1790, 1590, 460, 220, rng, style=cut, ink=0.38, dens=0.1, line=4.5, steps=0.3, sharp=1.6, n_tex=20)
    # the two cliffs that frame the waterfall
    M.lobe(1432, 1480, 250, 420, rng, style=cut, ink=0.55, dens=0.15, line=6.5, sharp=1.6, steps=0.3, round_=0.7,
           skew=0.25, moss=1)
    M.lobe(1665, 1480, 250, 390, rng, style=cut, ink=0.55, dens=0.15, line=6, sharp=1.6, steps=0.3, round_=0.7,
           light=1, skew=-0.25)
    # inner folds and boulder-heads of the main mass (their crests become structure lines on the face)
    M.lobe(1010, 1480, 430, 640, rng, style=dry, ink=0.8, dens=0.2, crest_dark=0.8, line=4.5, sharp=2.0, round_=0.55, skew=-0.15,
           n_tex=22, gaps=0.3, passes=3)
    M.lobe(1330, 1470, 360, 560, rng, style=dry, ink=0.85, dens=0.21, crest_dark=0.9, line=5.5, sharp=2.0, round_=0.55, skew=0.2,
           n_tex=20, passes=3)
    M.lobe(1160, 1480, 380, 880, rng, style=dry, ink=0.75, dens=0.19, line=4, sharp=2.4, round_=0.5, skew=0.1,
           n_tex=24, gaps=0.4, crest_dark=0.8, passes=3)
    M.lobe(880, 1460, 300, 780, rng, style=soft, ink=0.38, dens=0.1, line=4.5, sharp=2.2, round_=0.5, skew=-0.3,
           n_tex=16)
    # main summit: broad, massive, steep-sided (范宽 style), then right and left peaks
    top = M.lobe(1180, 1480, 900, 1300, rng, style=dry, ink=1.05, dens=0.34, crest_dark=1.3, line=7.5, passes=4, sharp=2.4, round_=0.42,
                 skew=-0.08, bump=0.12, n_tex=75, moss=3)
    rtop = M.lobe(1810, 1430, 640, 880, rng, style=('bundle', 'fupi', 'wet'), ink=0.95, dens=0.27, crest_dark=1.0, passes=3, line=6.5,
                  sharp=1.9, round_=0.55, skew=0.2, bump=0.12, moss=2, light=1, n_tex=40)
    M.lobe(700, 1450, 560, 600, rng, style=soft, ink=0.4, dens=0.11, line=3.5, skew=-0.25, bump=0.1, n_tex=34,
           gaps=0.3)
    i = int(np.argmin(top[:, 1]))
    B.mark('高远', top[i, 0], top[i, 1] + 30)
    B.mark('重墨', 1820, 900)
    B.mark('积墨', 1150, 700)
    B.mark('勾勒', float(top[12, 0]), float(top[12, 1]))
    B.mark('侧锋', 1330, 520)
    # summit forest: a few clumps of tiny trees, not a fringe
    for crest, k in ((top, 4), (rtop, 2)):
        for _ in range(k):
            j = int(rng.integers(4, len(crest) - 4))
            for _ in range(int(rng.integers(3, 9))):
                jj = int(np.clip(j + rng.integers(-2, 3), 1, len(crest) - 2))
                x, y = crest[jj] + [rng.normal(0, 6), 0]
                if y > 1150:
                    continue
                hgt = rng.uniform(10, 32)
                L.stroke(B.P([(x, y + 3), (x + rng.normal(0, 2), y - hgt)]), rng.uniform(1.4, 2.8) * B.S, ink=1.1,
                         dry=0.3, taper=(0.1, 0.7), start_w=1.0)
                X.moss_cluster(L, x, y - hgt * 0.6, rng, n=int(rng.integers(2, 5)), spread=4, size=2.4, ink=1.0)
    B.mark('点苔', top[i + 3, 0], top[i + 3, 1] + 6)
    return top


def peak_color(L, rng):
    """浅绛: a whisper of ochre on the lit (left) side, indigo on the shaded right."""
    for (cx, cy, w, h, pig) in ((1000, 900, 700, 900, OCHRE), (1700, 1050, 600, 700, INDIGO)):
        W, H = int(w * B.S), int(h * B.S)
        f = B.blob_field(W, H, rng, cell=w * 0.3)
        L.wash(int((cx - w / 2) * B.S), int((cy - h / 2) * B.S), f, pig, dens=0.07, lo=0.05, hi=0.9, edge=0.1,
               edge_blur=5, gran=0.5)


def mid(L, rng):
    """淡墨: rounded earthy hills with long 披麻皴, rows stepping back up the valley (深远)."""
    M = Massif(L, pig=INK * 0.85 + OCHRE * 0.15)
    P2 = ('pima2', 'wet')
    crests = []
    # dominant earthy mass: one big sloping body + shoulders merged behind it (no visible seams)
    c = dom = M.lobe(380, 2190, 900, 430, rng, style=P2, ink=0.5, dens=0.13, line=6.5, sharp=1.7, round_=0.6, skew=0.32,
               bump=0.22, n_tex=130, moss=1)
    crests.append(c)
    M.lobe(820, 2130, 460, 330, rng, style=P2, ink=0.44, dens=0.12, line=2.5, sharp=2.0, round_=0.6, skew=-0.2,
           n_tex=50, gaps=0.55)
    M.lobe(80, 2050, 380, 360, rng, style=P2, ink=0.42, dens=0.12, line=3, sharp=2.2, skew=0.1, n_tex=16, gaps=0.45)
    # a long low spur sloping toward the stream, thin broken outline
    c = M.lobe(1020, 2030, 420, 150, rng, style=P2, ink=0.36, dens=0.1, line=2.2, sharp=1.2, round_=0.9, skew=-0.6,
               n_tex=12, gaps=0.4)
    crests.append(c)
    # back rows: angular / sloping / small, each a different weight, fading up the valley (深远)
    M.lobe(330, 1840, 640, 300, rng, style=P2, ink=0.34, dens=0.1, line=4.5, sharp=1.4, steps=0.15, round_=0.75,
           skew=-0.4, bump=0.18, n_tex=60)
    M.lobe(860, 1790, 460, 380, rng, style=P2, ink=0.3, dens=0.1, line=2.4, sharp=1.3, round_=0.8, skew=0.45, steps=0.35,
           n_tex=16, gaps=0.5)
    M.lobe(600, 1680, 600, 150, rng, style='wet', ink=0.26, dens=0.08, line=3.0, sharp=1.1, round_=0.9, skew=0.65, steps=0.25,
           n_tex=30, gaps=0.3)
    M.lobe(1060, 1700, 300, 230, rng, style='pima2', ink=0.22, dens=0.07, line=1.6, sharp=1.2, skew=-0.3, steps=0.4, n_tex=6,
           gaps=0.5)
    py = float(np.interp(200, dom[:, 0], dom[:, 1])) + 85
    B.pomo(L, 200, py, 300, 150, rng, base=0.24, dark=0.9)
    B.mark('破墨', 200, py)
    B.mark('披麻皴', 540, 1150)
    B.mark('深远', 760, 1600)
    B.mark('淡墨', 1060, 1880)
    B.MARKING = False
    for c in crests:
        for _ in range(3):
            j = rng.integers(8, len(c) - 8)
            x, y = c[j]
            T.leaf_tree(L, x, y + 5, rng.uniform(50, 80), rng, kind='jie' if rng.random() < 0.5 else 'ge',
                        ink=0.55, leaf_ink=0.45, n_clusters=2)
    B.MARKING = True
