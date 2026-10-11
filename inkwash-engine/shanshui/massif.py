"""Mountains as overlapping lobes painted front-to-back with an occlusion mask.

Each lobe: rounded/angular top contour (勾), 积墨 washes darkening into the recess at its foot,
皴 texture following the contour (披麻 / 斧劈 / vertical), 点苔 on the crown."""
from __future__ import annotations

import math

import cv2
import numpy as np

from inkwash.core import INK, fbm, fbm1d, smoothstep
from . import brush as B
from . import rocks as R
from . import textures as TX


def lobe_contour(cx, by, w, h, rng, skew=0.0, sharp=1.8, bump=0.05, steps=0.0, n=48, round_=0.6):
    u = np.linspace(-1, 1, n)
    v = np.clip((u - skew) / np.where(u > skew, 1 - skew, 1 + skew), -1, 1)
    prof = np.clip(1 - np.abs(v) ** sharp, 0, 1) ** round_
    prof = prof * (1 + bump * fbm1d(n, 7, 3, rng))
    if steps > 0:                                    # angular facets for 斧劈 rocks: piecewise-linear crest
        k = int(rng.integers(4, 7))
        ku = np.sort(np.r_[-1, rng.uniform(-0.9, 0.9, k), 1])
        kp = np.interp(ku, u, prof) * (1 + steps * rng.uniform(-0.5, 0.5, len(ku)))
        kp[0] = kp[-1] = 0
        prof = np.interp(u, ku, kp) * (1 + 0.02 * fbm1d(n, 5, 2, rng))
    return np.c_[cx + u * w / 2, by - h * np.clip(prof, 0, None)]


class Massif:
    def __init__(self, L, pig=INK):
        self.L = L
        self.pig = pig
        cv = L.cv
        self.cov = np.zeros((cv.h, cv.w), np.float32)

    def lobe(self, cx, by, w, h, rng, style='pima', ink=0.5, dens=0.2, line=4.0, skew=0.0, sharp=1.8,
             n_tex=None, moss=0, steps=0.0, fade=0.75, light=-1, round_=0.6, bump=0.07, extend=0.0, gaps=0.12, crest_dark=0.0, passes=2):
        """Paint one lobe behind everything already painted in this massif. Returns the top contour."""
        if B.PHYSICS:
            B.pause(2.0)                                 # 下一块石头时，上一块已经干了
        top = lobe_contour(cx, by, w, h, rng, skew, sharp, bump=bump, steps=steps, round_=round_)
        if extend > 0:                                   # flared, ragged body continuing below the frame
            ey = np.linspace(by, by + extend, 6)
            fl = (ey - by) * 0.35 + rng.normal(0, 12, 6)
            right = np.c_[cx + w / 2 + fl, ey]
            left = np.c_[cx - w / 2 - fl, ey][::-1]
            poly = np.vstack([top, right, left])
            sides = [np.vstack([top[-3:], right]), np.vstack([left, top[:3]])]
        else:
            poly = np.vstack([top, [[cx + w / 2, by + 6], [cx - w / 2, by + 6]]])
            sides = []
        x0, y0, f = B.poly_field(poly, blur=1.2, pad=24)
        hh, ww = f.shape
        L, S = self.L, B.S
        cv = L.cv
        xa, ya, xb, yb = max(0, x0), max(0, y0), min(cv.w, x0 + ww), min(cv.h, y0 + hh)
        if xb <= xa or yb <= ya:
            return top
        f = f[ya - y0:yb - y0, xa - x0:xb - x0]
        x0, y0 = xa, ya
        hh, ww = f.shape
        free = 1 - self.cov[ya:yb, xa:xb]
        clipm = cv2.dilate(f, np.ones((int(8 * S) | 1, int(8 * S) | 1), np.uint8)) * free
        # depth below the top contour (0 at crest, 1 at foot)
        X = np.arange(ww) + x0
        ty = np.interp(X / S, top[:, 0], top[:, 1]) * S
        yy = np.arange(hh)[:, None] + y0
        d = np.clip((yy - ty[None, :]) / max(1.0, h * S), 0, 1.6)
        side = np.clip((X / S - cx) / (w / 2), -1, 1)[None, :] * (-light)
        with R.Clip(L, x0, y0, clipm, feather=0.8) as s:
            styles = style if isinstance(style, tuple) else (style,)
            for k in range(passes):                  # 积墨: 每一遍染完等干，下一遍才压上去
                if k and B.PHYSICS:
                    B.pause(4.5)
                n = fbm(hh, ww, max(6, 0.35 * w * S), 3, rng, gain=0.55)
                g = f * (0.3 + 0.5 * smoothstep(0.05 + 0.15 * k, 0.85, d) + 0.35 * smoothstep(1.0, 1.4, d) + 0.22 * side + 0.28 * n
                         + crest_dark * (1 - smoothstep(0.0, 0.45, d)) * (0.6 + 0.4 * side))
                if fade > 0:
                    g *= 1 - fade * smoothstep(0.55, 1.0, d)
                s.wash(x0, y0, np.clip(g, 0, 1.3), self.pig, dens=dens * (1 + 0.3 * k), lo=0.05 + 0.1 * k, hi=0.95,
                       edge=0.3, edge_blur=3 * S + 1, gran=0.45, warp=0.15, seeds=[(cx * S, (by - h) * S)], speed=800)
            nt = n_tex if n_tex is not None else int(w * h / 2500)
            if B.PHYSICS:
                # 坡脚趁最后一遍染还湿的时候化开；皴等纸干了再上，边才留得住
                B.pause(0.4)
                for st in styles:
                    if st == 'wet':
                        self._one_style(s, st, top, by, h, nt, ink, rng, light, extend, style)
                B.pause(4.5)
                for st in styles:
                    if st != 'wet':
                        self._one_style(s, st, top, by, h, nt, ink, rng, light, extend, style)
                B.pause(3.0)
            else:
                for st in styles:
                    self._one_style(s, st, top, by, h, nt, ink, rng, light, extend, style)
            R.outline(s, top, rng, w=line, ink=min(1.4, ink + 0.35), dry=0.5, seg=(5, 10), gaps=gaps)
            for sd in sides:                         # 勾 the cliff sides of the body too, drier and broken
                R.outline(s, sd, rng, w=line * 0.8, ink=min(1.3, ink + 0.25), dry=0.65, seg=(2, 4), gaps=0.2)
            for _ in range(moss):                     # 点苔 only as a few clumps at accent spots
                i = int(np.clip(np.argmin(top[:, 1]) + rng.integers(-8, 9), 3, len(top) - 4))
                TX.moss_cluster(s, top[i, 0], top[i, 1] + rng.uniform(2, 8), rng, spread=rng.uniform(8, 22))
        vis = smoothstep(0.3, 0.7, f) * (1 - fade * smoothstep(0.55, 1.0, d))   # faded foot doesn't occlude
        vis = cv2.GaussianBlur(vis, (0, 0), 2 * S + 0.5)
        self.cov[ya:yb, xa:xb] = np.maximum(self.cov[ya:yb, xa:xb], vis)
        return top

    def _one_style(self, s, st, top, by, h, nt, ink, rng, light, extend, style):
        if st == 'pima':
            self._pima(s, top, by, h, nt, ink, rng)
        elif st == 'fupi':
            self._fupi(s, top, by + extend * 0.6, h, max(3, nt // 2) if isinstance(style, tuple) else nt, ink,
                       rng, light)
        elif st == 'vert':
            self._vert(s, top, by, h, int(nt * 1.6), ink, rng)
        elif st == 'cefeng':
            TX.cefeng(s, top, by, h, nt, ink, rng, self.pig, light)
        elif st == 'wet':
            TX.wetfoot(s, top, by, h, max(3, nt // 6), ink, rng, self.pig)
        elif st == 'bundle':
            TX.bundles(s, top, by, h, nt, ink, rng, self.pig, light)
        elif st == 'pima2':
            TX.pima_long(s, top, by, h, nt, ink, rng, self.pig)

    # -------------------------------------------------------------- textures
    def _pima(self, s, top, by, h, n, ink, rng):
        """披麻: bundles of long soft strokes spread over the face, following the flank downhill."""
        cx = top[:, 0].mean()
        hw = (top[-1, 0] - top[0, 0]) / 2
        for _ in range(n):
            x = cx + hw * rng.uniform(-0.85, 0.85)
            yt = float(np.interp(x, top[:, 0], top[:, 1]))
            y = yt + rng.uniform(6, max(8, (by - yt) * 0.6))
            sl = (np.interp(x + 6, top[:, 0], top[:, 1]) - np.interp(x - 6, top[:, 0], top[:, 1])) / 12
            ang = math.pi / 2 - math.atan(sl) * 0.6
            l0 = (by - y) * rng.uniform(0.3, 0.7) + 20
            bend = rng.normal(0, 0.15)
            for j in range(int(rng.integers(2, 5))):
                off = (j - 1.5) * rng.uniform(5, 8)
                l = l0 * rng.uniform(0.6, 1.05)
                y1 = y + rng.normal(0, 4)
                q = [(x + off + math.cos(ang + bend * t) * l * t, y1 + math.sin(ang + bend * t) * l * t)
                     for t in np.linspace(0, 1, 5)]
                s.stroke(B.P(q), rng.uniform(1.2, 2.3) * B.S, ink=ink * rng.uniform(0.4, 0.9), pig=self.pig,
                         dry=rng.uniform(0.35, 0.65), wet=0.5, taper=(0.25, 0.5), start_w=0.3, end_w=0.1,
                         rough=0.3, wobble=0.25)

    def _fupi(self, s, top, by, h, n, ink, rng, light):
        """斧劈: sparse groups of broad side-brush cuts dragged down from the crest; paper shows between
        cuts (飞白), denser and darker on the shadow flank."""
        for _ in range(max(4, n // 2)):
            i = rng.integers(3, len(top) - 3)
            x, y = top[i]
            right = i > len(top) // 2
            shadow = right == (light < 0)
            if not shadow and rng.random() < 0.4:
                continue
            base = math.radians(rng.uniform(64, 82) if right else rng.uniform(98, 116))
            y += rng.uniform(2, (by - y) * 0.5)
            ln = rng.uniform(0.25, 0.45) * h
            wd = min(26.0, rng.uniform(0.04, 0.06) * h)
            px, py = -math.sin(base), math.cos(base)          # across-stroke direction
            for j in range(int(rng.integers(2, 5))):
                o = j * wd * rng.uniform(0.9, 1.25)
                B.fupi(s, x + px * o, y + py * o + j * wd * 0.5, ln * rng.uniform(0.6, 1.0), wd * rng.uniform(0.7, 1.1),
                       base, ink * rng.uniform(0.5, 0.95) * (1.0 if shadow else 0.7), rng,
                       dry=rng.uniform(0.55, 0.9), pig=self.pig)

    def _vert(self, s, top, by, h, n, ink, rng):
        """Vertical dry strokes for the sheer peak face (lines like rain-streaked cliff)."""
        for _ in range(n):
            i = rng.integers(2, len(top) - 2)
            x = top[i, 0] + rng.normal(0, 8)
            y = top[i, 1] + rng.uniform(5, (by - top[i, 1]) * 0.9)
            l = rng.uniform(25, 70)
            q = [(x, y), (x + rng.normal(0, 3), y + l * 0.5), (x + rng.normal(0, 5), y + l)]
            s.stroke(B.P(q), rng.uniform(1.1, 2.2) * B.S, ink=ink * rng.uniform(0.35, 0.8), pig=self.pig,
                     dry=rng.uniform(0.5, 0.8), wet=0.3, taper=(0.3, 0.5), start_w=0.4, end_w=0.15, rough=0.3)
