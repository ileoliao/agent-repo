"""Pavilion (茅亭), scholar, fishing boat with reflection, text-free seals. Design units."""
from __future__ import annotations

import math

import cv2
import numpy as np

from inkwash.core import INDIGO, INK, OCHRE, VERMILION, fbm
from . import brush as B


def _st(L, pts, w, ink, **kw):
    kw.setdefault('dry', 0.25)
    kw.setdefault('wet', 0.4)
    kw.setdefault('rough', 0.3)
    L.stroke(B.P(pts), max(0.5, w * B.S), ink=ink, **kw)


def scholar(L, x, y, h, rng, seated=False, facing=1, ink=0.9):
    """Tiny 高士 in a robe: head dot, robe as two strokes, (seated: wide base)."""
    hd = h * 0.12
    L.dot(x * B.S, (y - h + hd) * B.S, hd * B.S, ink=ink, ang=math.pi / 2, elong=1.1)
    if seated:
        robe = [(x - facing * h * 0.05, y - h + hd * 2.2), (x - facing * h * 0.12, y - h * 0.4), (x - h * 0.25, y)]
        robe2 = [(x + facing * h * 0.02, y - h + hd * 2.2), (x + facing * h * 0.15, y - h * 0.35), (x + h * 0.28, y)]
        _st(L, [(x - h * 0.27, y), (x + h * 0.3, y)], h * 0.05, ink)
    else:
        robe = [(x, y - h + hd * 2.2), (x - h * 0.1, y - h * 0.4), (x - h * 0.16, y)]
        robe2 = [(x + h * 0.02, y - h + hd * 2.2), (x + h * 0.12, y - h * 0.4), (x + h * 0.14, y)]
        _st(L, [(x - h * 0.16, y), (x + h * 0.15, y)], h * 0.05, ink)
        _st(L, [(x + facing * h * 0.1, y - h * 0.75), (x + facing * h * 0.32, y + h * 0.02)], h * 0.025, ink * 0.8)  # staff
    _st(L, robe, h * 0.06, ink, taper=(0.1, 0.2))
    _st(L, robe2, h * 0.06, ink, taper=(0.1, 0.2))
    poly = np.array(robe + robe2[::-1])
    x0, y0, f = B.poly_field(poly, blur=0.8, pad=4)
    L.wash(x0, y0, f, INDIGO * 0.4 + INK * 0.2, dens=0.25, lo=0.1, hi=0.8, edge=0.2, edge_blur=2)


def pavilion(L, x, y, w, rng, ink=0.9):
    """茅亭 standing on a rock ledge at ground line y: stone plinth, 4 posts, thatched hip roof, a seated
    scholar inside. Returns label anchor."""
    ph = w * 0.62          # post height
    pl = w * 0.12          # plinth height
    # plinth (stone base) — trapezoid outline + wash, wider at the bottom so it beds into the rock
    base = [(x - w * 0.62, y), (x - w * 0.55, y - pl), (x + w * 0.55, y - pl), (x + w * 0.62, y)]
    _st(L, base[:2] + [base[2]], 2.4, ink, dry=0.45)
    _st(L, base[2:], 2.2, ink, dry=0.45)
    _st(L, [(x - w * 0.5, y - pl * 0.45), (x + w * 0.5, y - pl * 0.4)], 1.2, ink * 0.5, dry=0.6)
    x0, y0, f = B.poly_field(base, blur=1.0, pad=6)
    L.wash(x0, y0, f, INK, dens=0.22, lo=0.1, hi=0.8, edge=0.4, edge_blur=2)
    top = y - pl
    # seated scholar first so posts overlap him
    scholar(L, x + w * 0.08, top - 1, w * 0.36, rng, seated=True, facing=-1)
    # posts: two front (darker, wider apart), two back (paler, inset)
    for px, k in ((-0.42, 1.0), (0.42, 1.0), (-0.22, 0.55), (0.24, 0.55)):
        _st(L, [(x + px * w, top + 1), (x + px * w + rng.normal(0, 0.6), top - ph)], 2.2 if k > 0.8 else 1.6,
            ink * k, dry=0.3, taper=(0.05, 0.1), start_w=1.0, end_w=0.9)
    # low railing between front posts
    _st(L, [(x - w * 0.42, top - ph * 0.28), (x - w * 0.12, top - ph * 0.28)], 1.3, ink * 0.8)
    _st(L, [(x + w * 0.42, top - ph * 0.28), (x + w * 0.3, top - ph * 0.28)], 1.3, ink * 0.8)
    # beam
    _st(L, [(x - w * 0.47, top - ph), (x + w * 0.47, top - ph)], 2.0, ink)
    # thatched roof: steep pyramid with drooping eaves overhanging the posts
    ey = top - ph + 2
    apex = (x + rng.normal(0, 1), ey - w * 0.55)
    left = (x - w * 0.78, ey + w * 0.06)
    right = (x + w * 0.78, ey + w * 0.06)
    _st(L, [left, (x - w * 0.4, ey - w * 0.18), apex], 2.6, ink, dry=0.5, taper=(0.2, 0.1))
    _st(L, [apex, (x + w * 0.4, ey - w * 0.18), right], 2.6, ink, dry=0.5, taper=(0.1, 0.2))
    _st(L, [left, (x, ey + w * 0.02), right], 2.4, ink, dry=0.55, bristle=1.6)
    roof = [left, apex, right, (x, ey + w * 0.02)]
    x0, y0, f = B.poly_field(roof, blur=1.0, pad=6)
    L.wash(x0, y0, f, OCHRE * 0.6 + INK * 0.4, dens=0.35, lo=0.1, hi=0.8, edge=0.5, edge_blur=2)
    for _ in range(int(w * 0.5)):      # thatch strands
        t = rng.uniform(0.08, 0.92)
        bx = left[0] + (right[0] - left[0]) * t
        by = ey + w * 0.04 - abs(t - 0.5) * w * 0.04
        tx = apex[0] + (bx - apex[0]) * rng.uniform(0.15, 0.45)
        ty = apex[1] + (by - apex[1]) * rng.uniform(0.15, 0.45)
        _st(L, [(tx, ty), (bx, by)], 0.9, ink * rng.uniform(0.35, 0.7), dry=0.6)
    return (x, ey - w * 0.2)


def boat(L, x, y, w, rng, ink=0.9):
    """Fishing skiff whose hull bottom sits on waterline y; mat awning; fisher with rod; reflection."""
    hl = w * 0.5
    hull_top = [(x - hl, y - w * 0.13), (x - hl * 0.4, y - w * 0.05), (x + hl * 0.5, y - w * 0.05), (x + hl * 1.05, y - w * 0.16)]
    hull_bot = [(x - hl * 0.92, y - w * 0.1), (x - hl * 0.4, y), (x + hl * 0.5, y), (x + hl * 0.98, y - w * 0.12)]
    _st(L, hull_top, 2.4, ink, dry=0.3)
    _st(L, hull_bot, 3.2, ink, dry=0.2, taper=(0.1, 0.3))
    x0, y0, f = B.poly_field(hull_top + hull_bot[::-1], blur=0.8, pad=4)
    L.wash(x0, y0, f, INK, dens=0.35, lo=0.1, hi=0.8, edge=0.3, edge_blur=2)
    # awning (篷)
    aw = [(x - hl * 0.35, y - w * 0.05), (x - hl * 0.3, y - w * 0.24), (x + hl * 0.05, y - w * 0.27), (x + hl * 0.2, y - w * 0.05)]
    _st(L, aw, 2.0, ink * 0.9)
    x0, y0, f = B.poly_field(aw, blur=0.8, pad=4)
    L.wash(x0, y0, f, OCHRE * 0.5 + INK * 0.5, dens=0.4, lo=0.1, hi=0.8, edge=0.4, edge_blur=2)
    # fisherman at the bow, with rod and line
    scholar(L, x + hl * 0.55, y - w * 0.05, w * 0.22, rng, seated=True, facing=1)
    rx, ry = x + hl * 0.6, y - w * 0.16
    _st(L, [(rx, ry), (rx + w * 0.3, ry - w * 0.18), (rx + w * 0.55, ry - w * 0.3)], 1.0, ink * 0.8, taper=(0.05, 0.8))
    _st(L, [(rx + w * 0.55, ry - w * 0.3), (rx + w * 0.58, y + w * 0.06)], 0.5, ink * 0.35)
    # reflection: broken pale horizontal strokes mirrored under the hull
    for k in range(6):
        yy = y + 3 + k * w * 0.035
        span = hl * (1.0 - 0.13 * k) * rng.uniform(0.8, 1.05)
        cx = x + rng.normal(0, 3)
        _st(L, [(cx - span, yy), (cx - span * 0.3, yy + 1), (cx + span * 0.4, yy - 1), (cx + span, yy)],
            rng.uniform(1.2, 2.2), ink * (0.32 - 0.04 * k), pig=INK * 0.7 + INDIGO * 0.3, dry=0.6, wet=0.2,
            taper=(0.3, 0.3), start_w=0.2, end_w=0.2)
    for d in (-1, 1):                  # ripple rings
        _st(L, [(x + d * hl * 1.1, y + 4), (x + d * hl * 1.5, y + 6), (x + d * hl * 1.9, y + 4)], 1.2, ink * 0.25,
            pig=INK * 0.6 + INDIGO * 0.4, taper=(0.3, 0.3), start_w=0.2, end_w=0.2)
    return (x, y - w * 0.15)


def seal(h, w, cx, cy, size, rng, oval=False, dens=1.25):
    """Text-free red seal: carved stone impression with an abstract meander pattern (no characters).
    Returns (y0, x0, absorbance patch HxWx3) in render px."""
    S = B.S
    n = int(size * S)
    m = np.zeros((n, n), np.float32)
    if oval:
        cv2.ellipse(m, (n // 2, n // 2), (int(n * 0.36), int(n * 0.48)), 0, 0, 360, 1.0, -1)
    else:
        m[:] = 1.0
    carve = np.zeros_like(m)
    bw = max(2, int(n * 0.055))
    g = 5
    step = n / (g + 1)
    # abstract carved meander: a few fixed lattice paths (a pattern, deliberately not a character)
    paths = ([(1, 1), (1, 4), (3, 4), (3, 2), (5, 2), (5, 5)], [(2, 1), (5, 1)], [(1, 5), (4, 5)],
             [(2, 2), (2, 3)], [(4, 3), (4, 4)])
    for path in paths:
        for a, b in zip(path[:-1], path[1:]):
            cv2.line(carve, tuple(np.int32(np.array(a) * step)), tuple(np.int32(np.array(b) * step)), 1.0, bw)
    if not oval:
        cv2.rectangle(carve, (bw * 2, bw * 2), (n - bw * 2, n - bw * 2), 1.0, max(1, bw // 2))
    rough = fbm(n, n, max(2, n / 14), 3, rng)
    body = np.clip(m * (1 - carve) * (0.85 + 0.15 * rough), 0, 1)
    body *= (rough > -1.6) * (rng.random((n, n)) > 0.03)
    body = cv2.GaussianBlur(body.astype(np.float32), (0, 0), 0.7)
    return int(cy * S - n / 2), int(cx * S - n / 2), body[..., None] * VERMILION * dens
