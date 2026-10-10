"""Atmosphere & water: 米点 far hills, 平远 shoreline, mist (留白) masks, ripples, waterfall."""
from __future__ import annotations

import math

import cv2
import numpy as np

from inkwash.core import INDIGO, INK, fbm, fbm1d, smoothstep
from . import brush as B

MIST_PIG = INDIGO * 0.55 + INK * 0.45


def dome_ridge(x0, x1, base, peaks, rng):
    """Rounded hill silhouette: list of (x, y) design units."""
    X = np.linspace(x0, x1, 80)
    Hh = np.zeros_like(X)
    for (px, ph, pw) in peaks:
        Hh = np.maximum(Hh, ph * np.clip(1 - ((X - px) / pw) ** 2, 0, None) ** 0.6)
    Hh *= 1 + 0.06 * fbm1d(len(X), 12, 3, rng)
    return np.c_[X, base - Hh]


def mi_hills(L, x0, x1, base, peaks, rng, ink=0.22, rows=7, dot_r=11, wash=0.10, pig=INK, density=1.0):
    """米点山: pale wash body, then clusters of horizontal wet dots accumulated pale->dark (积点),
    densest along the crowns and thinning into the mist below."""
    rid = dome_ridge(x0, x1, base, peaks, rng)
    poly = np.vstack([rid, [[x1, base + 40], [x0, base + 40]]])
    x0r, y0r, f = B.poly_field(poly, blur=8)
    h, w = f.shape
    yy = np.arange(h)[:, None] / h
    B.field_wash(L, x0r, y0r, f * (1.0 - 0.8 * yy), pig=pig, dens=wash, edge=0.25, lo=0.02, hi=0.9, warp=0.3)
    hmax = max(p[1] for p in peaks)
    area = (x1 - x0) * hmax
    for pas, (rk, ik, nk) in enumerate(((1.5, 0.45, 0.6), (1.1, 0.8, 1.0), (0.8, 1.3, 0.7))):
        n = int(density * nk * area / (dot_r * dot_r * 6))
        for _ in range(n):
            x = rng.uniform(x0 + 5, x1 - 5)
            top = np.interp(x, rid[:, 0], rid[:, 1])
            hloc = base - top
            if hloc < 10:
                continue
            fr = rng.beta(1.0, 2.6 + pas)              # later (darker) passes hug the crowns
            y = top + 3 + fr * hloc
            B.midot(L, x, y, dot_r * rk * rng.uniform(0.7, 1.2), ink * ik * (1 - 0.7 * fr) * rng.uniform(0.7, 1.2),
                    rng, pig=pig, wet=0.9)
    i = int(np.argmin(rid[:, 1]))
    B.mark('米点皴', rid[i, 0], rid[i, 1] + 25)
    return rid


def flat_shore(L, x0, x1, y, rng, ink=0.3, pig=INK):
    """平远: long low banks drawn with a few horizontal strokes, tiny distant trees."""
    x = x0
    while x < x1:
        ln = rng.uniform(120, 320)
        xe = min(x1, x + ln)
        yy = y + rng.normal(0, 5)
        bump = rng.uniform(4, 12)
        pts = [(x, yy), (x + ln * 0.3, yy - bump), (x + ln * 0.7, yy - bump * 0.6), (xe, yy)]
        L.stroke(B.P(pts), rng.uniform(2, 3.5) * B.S, ink=ink * rng.uniform(0.7, 1.1), pig=pig, dry=0.3, wet=0.6,
                 taper=(0.2, 0.4), start_w=0.4, end_w=0.1)
        if rng.random() < 0.5 and xe - x > 80:          # a little clump of distant trees
            tx = rng.uniform(x + 30, xe - 30)
            for _ in range(int(rng.integers(3, 7))):
                ux = tx + rng.normal(0, 9)
                L.dot(ux * B.S, (yy - bump * 0.5 - rng.uniform(4, 9)) * B.S, rng.uniform(1.5, 2.6) * B.S,
                      ink=ink * 1.1, pig=pig, ang=math.pi / 2, elong=rng.uniform(1.4, 2.2))
        x = xe + rng.uniform(30, 160)
        y += rng.uniform(-6, 10)


def mist_mask(h, w, bands, rng):
    """Soft 留白 mist (render px). bands: (y_center, thickness, x_from, x_to, strength) in design units.
    Wavy, wispy, uneven along x — never a hard stripe."""
    S = B.S
    yy = np.arange(h, dtype=np.float32)[:, None]
    M = np.zeros((h, w), np.float32)
    wisp = fbm(h, w, 140 * S, 4, rng, gain=0.55, cell_y=45 * S)
    for (yc, th, xa, xb, st) in bands:
        off = fbm1d(w, 300 * S, 3, rng) * 70 * S
        thk = th * S * (0.7 + 0.6 * smoothstep(-1.5, 1.5, fbm1d(w, 260 * S, 2, rng)))
        X = np.arange(w)
        env = smoothstep(xa * S - 250 * S, xa * S + 150 * S, X) * smoothstep(xb * S + 250 * S, xb * S - 150 * S, X)
        d = (yy - (yc * S + off)[None, :]) / thk[None, :]
        band = np.exp(-d * d * 1.3) * (0.75 + 0.35 * wisp)
        M = np.maximum(M, np.clip(band, 0, 1) * env[None, :] * st)
    return smoothstep(0.05, 0.95, M)


def ripples(L, x0, x1, y0, y1, n, rng, ink=0.18, pig=INDIGO * 0.5 + INK * 0.5):
    """Very sparse faint horizontal water lines (the water itself is 留白)."""
    for _ in range(n):
        y = rng.uniform(y0, y1)
        x = rng.uniform(x0, x1)
        ln = rng.uniform(40, 160) * (0.5 + (y - y0) / (y1 - y0 + 1))
        pts = [(x, y), (x + ln * 0.33, y - 2), (x + ln * 0.66, y + 1.5), (x + ln, y)]
        L.stroke(B.P(pts), rng.uniform(1.0, 1.8) * B.S, ink=ink * rng.uniform(0.6, 1.2), pig=pig, dry=0.4, wet=0.3,
                 taper=(0.3, 0.4), start_w=0.2, end_w=0.1)


def waterfall_mask(h, w, path, width, rng):
    """Mask (render px) of the falling water: a ribbon along `path` (design units) with soft edges."""
    m = np.zeros((h, w), np.float32)
    pts = np.asarray(path, np.float64)
    k = len(pts)
    for i in range(k - 1):
        a, b = pts[i] * B.S, pts[i + 1] * B.S
        wd = np.interp(i, [0, k - 1], [width[0], width[1]]) * B.S
        cv2.line(m, tuple(np.int32(a)), tuple(np.int32(b)), 1.0, max(1, int(wd)), cv2.LINE_AA)
    rag = fbm(h, w, 9 * B.S + 1, 3, rng, cell_y=60 * B.S + 1)
    m = cv2.GaussianBlur(m, (0, 0), 3.5 * B.S + 0.5)
    return smoothstep(0.25, 0.75, m + 0.18 * rag)


def fall_lines(L, path, width, rng, n=14, ink=0.16):
    """Few faint long vertical threads inside the fall so it reads as moving water, not a hole."""
    pts = np.asarray(path, np.float64)
    for _ in range(n):
        u = rng.uniform(-0.35, 0.35)
        t0, t1 = sorted(rng.uniform(0, 1, 2))
        if t1 - t0 < 0.2:
            continue
        ts = np.linspace(t0, t1, 6)
        q = []
        for t in ts:
            p = pts[0] + (pts[-1] - pts[0]) * t
            j = min(len(pts) - 2, int(t * (len(pts) - 1)))
            p = pts[j] + (pts[j + 1] - pts[j]) * (t * (len(pts) - 1) - j)
            wd = width[0] + (width[1] - width[0]) * t
            q.append((p[0] + u * wd, p[1]))
        L.stroke(B.P(q), 1.0 * B.S, ink=ink, pig=INDIGO * 0.5 + INK * 0.5, dry=0.6, wet=0.1,
                 taper=(0.3, 0.3), start_w=0.2, end_w=0.2)
