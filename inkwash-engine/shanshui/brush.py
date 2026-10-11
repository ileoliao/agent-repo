"""Shared brush helpers for the shanshui painting (built on inkwash.core).

All coordinates passed in are in *design units* of a 2400x3200 sheet; `S` converts them
to the current render scale so the whole painting can be previewed small and rendered full.
"""
from __future__ import annotations

import math
import os

import cv2
import numpy as np

from inkwash.core import INK, fbm, smoothstep

S = 1.0          # render scale (set by paint.py)
BRUSH = os.environ.get('BRUSH', 'classic')   # 'bristle' -> inkwash.brush2 毛笔模型 for 皴/飞白/松针
# 笔毛山水才走纸面物理：水会干，湿时相破，干后积墨。经典笔触不设这个开关，输出不变。
PHYSICS = False
CLOCK = 0.0          # 秒，和 PaperState.tau 同一把尺
_LAYERS = []


def set_brush(name):
    global BRUSH
    BRUSH = name


def set_physics(on):
    """打开后，pause() 会把已登记图层的纸面时钟向前拨。"""
    global PHYSICS
    PHYSICS = bool(on)


def reset_clock():
    """一幅画开始：时钟归零，忘掉上一张的图层。"""
    global CLOCK
    CLOCK = 0.0
    _LAYERS.clear()


def track(layer):
    if layer is not None and layer not in _LAYERS:
        _LAYERS.append(layer)


def pause(dt):
    """让纸晾 dt 秒。没开物理时什么都不做。"""
    global CLOCK
    if not PHYSICS or dt <= 0:
        return
    CLOCK += float(dt)
    for layer in _LAYERS:
        if getattr(layer, 'interact', False):
            layer.set_time(CLOCK)


def bk(**extra):
    """Extra Layer.stroke kwargs: {} for the classic brush (unchanged output), model='bristle' + extra otherwise."""
    return dict(model='bristle', **extra) if BRUSH == 'bristle' else {}
LABELS = {}      # technique -> list of (x, y) design coords where it was actually drawn


def set_scale(s):
    global S
    S = s


MARKING = True


def mark(tech, x, y):
    if MARKING:
        LABELS.setdefault(tech, []).append((float(x), float(y)))


def P(pts):
    return [(x * S, y * S) for x, y in pts]


def poly_field(poly, blur=3.0, pad=16):
    """Rasterise a design-unit polygon at render scale -> (x0, y0, soft mask)."""
    p = np.asarray(poly, np.float32) * S
    x0, y0 = np.floor(p.min(0) - pad).astype(int)
    x1, y1 = np.ceil(p.max(0) + pad).astype(int)
    m = np.zeros((y1 - y0, x1 - x0), np.uint8)
    cv2.fillPoly(m, [((p - [x0, y0]) * 4).astype(np.int32)], 255, cv2.LINE_AA, shift=2)
    f = m.astype(np.float32) / 255
    if blur > 0:
        f = cv2.GaussianBlur(f, (0, 0), blur * S + 0.5)
    return int(x0), int(y0), f


def field_wash(L, x0, y0, f, pig=INK, dens=0.3, edge=0.4, lo=0.05, hi=0.7, gran=0.4, warp=0.12, wet=0.9):
    h, w = f.shape
    L.wash(x0, y0, f, pig, dens=dens, seeds=[(x0 + w / 2, y0 + h / 2)], speed=600, lo=lo, hi=hi,
           edge=edge, edge_blur=max(2, 4 * S), gran=gran, warp=warp, wet=wet)


def blob_field(w, h, rng, cell=60, thresh=0.0, soft=0.8):
    """Organic ellipse-ish blob (0..1) for washes, sized w x h render px."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r = np.hypot((xx - w / 2) / (w / 2), (yy - h / 2) / (h / 2))
    n = fbm(h, w, max(4, cell * S), 3, rng)
    win = smoothstep(1.0, 0.8, np.maximum(np.abs(xx - w / 2) / (w / 2), np.abs(yy - h / 2) / (h / 2)))
    # negative outside the window so wash warp noise can never lift the bbox edge into a visible rectangle
    return smoothstep(thresh + soft, thresh - soft, r * 1.6 - 1.0 + 0.35 * n) * win - 0.6 * (1 - win)


# ------------------------------------------------------------------ techniques
def fupi(L, x, y, ln, w, ang, ink, rng, dry=0.55, pig=INK):
    """斧劈皴: one broad side-brush axe cut — heavy blunt entry, sharp dragged exit."""
    ang += rng.normal(0, 0.08)
    ca, sa = math.cos(ang), math.sin(ang)
    bend = rng.normal(0, 0.12) * ln
    pts = [(x, y), (x + ca * ln * 0.45 - sa * bend * 0.4, y + sa * ln * 0.45 + ca * bend * 0.4),
           (x + ca * ln, y + sa * ln)]
    L.stroke(P(pts), w * S, ink=ink, pig=pig, dry=dry, wet=0.2, taper=(0.03, 0.85), start_w=1.0,
             end_w=0.02, rough=0.22, bristle=1.5, wobble=0.1, pool=0.25, **bk(tip='ce', entry='cang'))


def midot(L, x, y, r, ink, rng, pig=INK, wet=1.0):
    """米点: one horizontal, blunt, wet dot."""
    L.dot(x * S, y * S, r * S, ink=ink, pig=pig, ang=rng.normal(0, 0.08), elong=rng.uniform(1.8, 2.6),
          wet=wet, dry=0.0, rough=0.35, start_w=0.8, end_w=0.6, taper=(0.3, 0.35))


def moss(L, x, y, r, rng, ink=1.0, n=1, spread=6, pig=INK):
    """点苔: cluster of dark 焦墨 dots."""
    for _ in range(n):
        dx, dy = rng.normal(0, spread), rng.normal(0, spread * 0.4)
        L.dot((x + dx) * S, (y + dy) * S, r * rng.uniform(0.7, 1.3) * S, ink=ink * rng.uniform(0.85, 1.1),
              pig=pig, ang=math.pi / 2 + rng.normal(0, 0.35), elong=rng.uniform(1.0, 1.6), wet=0.6)


def pomo(L, cx, cy, w, h, rng, base=0.25, dark=0.55, pig=INK):
    """破墨: pale wet wash broken into by darker ink while wet — soft blooms + back-run edges."""
    W, H = int(w * S), int(h * S)
    f = blob_field(W, H, rng, cell=w * 0.25)
    x0, y0 = int(cx * S - W / 2), int(cy * S - H / 2)
    L.wash(x0, y0, f, pig, dens=base, seeds=[(cx * S, cy * S)], speed=500, lo=0.2, hi=0.9,
           edge=0.2, edge_blur=3, gran=0.5, warp=0.3, wet=1.5)
    for _ in range(int(rng.integers(3, 6))):
        bw, bh = W * rng.uniform(0.25, 0.5), H * rng.uniform(0.25, 0.5)
        bx = cx * S + rng.uniform(-0.3, 0.3) * W
        by = cy * S + rng.uniform(-0.3, 0.3) * H
        g = blob_field(int(bw), int(bh), rng, cell=w * 0.15, soft=1.0)
        g = cv2.GaussianBlur(g, (0, 0), 4 * S + 1) * f[np.clip(int(by - y0), 0, H - 1), np.clip(int(bx - x0), 0, W - 1)]
        L.wash(bx - bw / 2, by - bh / 2, g, pig, dens=dark * rng.uniform(0.6, 1.1), seeds=[(bx, by)],
               lo=0.2, hi=0.85, edge=0.9, edge_blur=6 * S + 1, gran=0.6, warp=0.4, wet=2.0)


def pomo_splash(L, poly, rng, dens=1.3, pig=INK):
    """泼墨 rock: ink splashed and left to spread.
    - silhouette: polygon warped by large-scale noise -> irregular lobes and a few bays
    - edge: feathered bleed halo whose reach varies along the contour, plus small breaks where the
      wet front stopped short (paper shows through)
    - inside: lighter diluted zones where water thinned the ink, darker pools at a few spots."""
    x0, y0, f = poly_field(poly, blur=22, pad=90)
    H, W = f.shape
    big = fbm(H, W, max(8, 120 * S), 3, rng, gain=0.5)
    mid = fbm(H, W, max(4, 28 * S), 3, rng, gain=0.55)
    shape = f + 0.22 * big + 0.035 * mid                       # lobes + bays + ragged rim
    body = smoothstep(0.45, 0.62, shape)
    breaks = smoothstep(0.75, 1.0, fbm(H, W, max(3, 9 * S), 2, rng)) * (1 - smoothstep(0.62, 0.8, shape))
    body *= 1 - 0.85 * breaks                                 # broken bits of the edge
    reach = 10 + 22 * smoothstep(-1, 1, big)                  # bleed reach varies along the contour
    halo = smoothstep(0.2, 0.5, shape + 0.004 * reach * mid) - body * 0.6
    tone = 0.6 + 0.4 * smoothstep(-0.9, 0.6, fbm(H, W, max(6, 150 * S), 2, rng, gain=0.45))   # diluted zones
    sd = [(x0 + W * 0.4, y0 + H * 0.5)]
    L.wash(x0, y0, cv2.GaussianBlur(halo, (0, 0), 7 * S + 1) - 0.25 * (1 - f), pig, dens=0.26, seeds=sd, lo=0.04,
           hi=0.7, edge=0.25, edge_blur=6 * S + 1, gran=0.6, warp=0.3, wet=1.2)
    L.wash(x0, y0, cv2.GaussianBlur(body * tone, (0, 0), 1.2 * S + 0.5) - 0.3 * (1 - f), pig, dens=dens * 1.05,
           seeds=sd, lo=0.08, hi=0.9, edge=0.4, edge_blur=5 * S + 1, gran=0.55, warp=0.2, wet=2.5)
    for _ in range(int(rng.integers(3, 6))):                   # pooled dark spots where the ink settled
        ys, xs = np.nonzero(body > 0.9)
        if len(xs) == 0:
            break
        i = rng.integers(len(xs))
        pw, ph = rng.uniform(40, 110) * S, rng.uniform(25, 60) * S
        g = blob_field(int(pw) + 2, int(ph) + 2, rng, cell=30)
        L.wash(x0 + xs[i] - pw / 2, y0 + ys[i] - ph / 2, g, pig, dens=dens * rng.uniform(0.5, 0.8), lo=0.1, hi=0.9,
               edge=0.5, edge_blur=3 * S + 1, gran=0.4, warp=0.2, wet=1.5)
