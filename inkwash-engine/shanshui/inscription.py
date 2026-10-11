"""题款: vertical right-to-left columns written in ink through the absorbance model.

Glyph shapes come from AR PL UKai (楷书). Each character gets its own brush load (fresh ink after a
re-dip, drying along the column), ragged edges from the paper noise, dry-brush streaks on late
characters, fibre absorption and a faint wet bleed, so it reads as ink rather than vector text."""
from __future__ import annotations

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from inkwash.core import INK, smoothstep
from . import brush as B

FONT = '/usr/share/fonts/truetype/arphic/ukai.ttc'
COLUMNS = [  # (text, x_center, y_top, char size) in design units, rightmost column first
    ('飞流直下三千尺', 2290, 150, 84),
    ('疑是银河落九天', 2185, 150, 84),
    ('丙午秋日 写', 2088, 250, 56),
]
SEAL = (2088, 640, 50)          # name seal under the signature: cx, cy, size


def glyph(ch, px):
    """Anti-aliased glyph mask (px x px), centred."""
    f = ImageFont.truetype(FONT, int(px * 0.92), index=0)
    im = Image.new('L', (px, px), 0)
    d = ImageDraw.Draw(im)
    l, t, r, b = d.textbbox((0, 0), ch, font=f)
    d.text(((px - (r - l)) / 2 - l, (px - (b - t)) / 2 - t), ch, font=f, fill=255)
    return np.asarray(im, np.float32) / 255


def render(cv, rng):
    """Returns (A, boxes): absorbance HxWx3 for the whole inscription, and design-unit boxes per column."""
    S = B.S
    A = np.zeros((cv.h, cv.w, 3), np.float32)
    boxes = []
    for ci, (text, xc, y0, size) in enumerate(COLUMNS):
        load = rng.uniform(1.15, 1.3)                       # fresh dip at each column
        step = size * 1.07
        y = y0
        for k, ch in enumerate(text):
            if ch == ' ':
                y += step * 0.6
                continue
            px = int(size * S)
            m = glyph(ch, px)
            gx, gy = int((xc + rng.normal(0, 1.5)) * S - px / 2), int(y * S)
            ys, xs = slice(gy, gy + px), slice(gx, gx + px)
            if gy + px > cv.h or gx + px > cv.w:
                break
            e = cv.nz_edge[ys, xs]
            fib = cv.fiber[ys, xs]
            shape = smoothstep(0.35, 0.65, m + 0.18 * e)       # ragged, brush-like edge
            dry = max(0.0, 1.0 - load) * 2.2                   # brush running dry along the column
            if dry > 0:
                streak = cv2.resize(rng.random((max(2, px // 3), max(2, px // 10))).astype(np.float32), (px, px))
                shape *= 1 - dry * smoothstep(0.55, 0.9, streak) * (m < 0.95)
            dens = load * (0.85 + 0.3 * fib) * (1 + 0.15 * cv.nz_mid[ys, xs] * 0.5)
            bleed = cv2.GaussianBlur(shape, (0, 0), 1.6 * S + 0.6) * 0.18 * load
            a = (shape * dens + bleed)[..., None] * INK * rng.uniform(0.95, 1.08)
            A[ys, xs] += a
            load -= rng.uniform(0.05, 0.09)
            y += step * rng.uniform(0.97, 1.03)
        boxes.append((xc - size / 2, y0, xc + size / 2, y))
    B.mark('题款', COLUMNS[1][1], COLUMNS[1][2] + 3 * COLUMNS[1][3])
    return A, boxes
