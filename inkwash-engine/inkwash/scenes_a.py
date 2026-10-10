"""镜头 1–6：序 / 古蜀 / 开明迁都 / 秦筑城 / 都江堰 / 蜀锦。"""
from __future__ import annotations

import math

import cv2
import numpy as np

from .core import (CRIMSON, GOLD, INDIGO, INK, INK_WARM, JADE, MALACHITE, OCHRE, PINK, UMBER, VERMILION, catmull, fbm,
                   fbm1d, smoothstep, vnoise)
from .motifs import (banner, bamboo, boat, figure, foliage_tree, ground_wash, hall, hut, lerp, mist_wash,
                     mountain_range, poly_wash, reeds, river, rock, tiny_tree, wall_segment, water_lines, willow)
from .scene_base import SH, SW, SceneBase


def reveal_radial(cv, cx, cy, t0, speed, jitter=0.35):
    yy, xx = np.mgrid[0:cv.h, 0:cv.w].astype(np.float32)
    f = t0 + np.hypot(xx - cx, (yy - cy) * 1.25) / speed * (1 + jitter * cv.nz_low * 0.5)
    for L in cv.layers:
        L.T = np.maximum(L.T, f.astype(np.float32))


def reveal_x(cv, x0, t0, speed, jitter=0.3):
    xx = np.arange(cv.w, dtype=np.float32)[None, :]
    f = t0 + (xx - x0) / speed + jitter * cv.nz_low * 0.5
    for L in cv.layers:
        L.T = np.maximum(L.T, f.astype(np.float32))


def band_wash(L, y, h, pig, dens, t0, x0=0, x1=None, speed=900, cell=200, seeds=None):
    x1 = x1 if x1 is not None else L.cv.w
    w = int(x1 - x0)
    hh = int(h * 2)
    yy = np.linspace(-1, 1, hh)[:, None]
    f = np.exp(-yy ** 2 * 2.5) * (0.6 + 0.6 * vnoise(hh, w, cell, L.rng, cell * 0.3))
    L.wash(x0, y - h, f.astype(np.float32), pig, dens=dens, t0=t0, seeds=seeds or [((x0 + x1) / 2, y)], speed=speed,
           lo=0.05, hi=1.0, edge=0.15, gran=0.25, warp=0.1)


def ellipse(cx, cy, rx, ry, a0=0.0, a1=2 * np.pi, n=28):
    return [(cx + math.cos(a) * rx, cy + math.sin(a) * ry) for a in np.linspace(a0, a1, n)]


class InkFront:
    """开场墨晕：一圈湿墨前沿从中心向外扩散。"""

    def __init__(self, cx, cy, t0, speed, strength=0.35):
        self.cx, self.cy, self.t0, self.speed, self.s = cx, cy, t0, speed, strength
        self.F = None

    def __call__(self, ctx, img):
        t = ctx.t
        r = (t - self.t0) * self.speed * ctx.z
        if r < 0 or r > 2600:
            return img
        if self.F is None:
            rng = np.random.default_rng(5)
            yy, xx = np.mgrid[0:SH, 0:SW].astype(np.float32)
            self.F = np.hypot(xx - SW / 2, (yy - SH / 2) * 1.25) * (1 + 0.35 * fbm(SH, SW, 160, 4, rng) * 0.5)
        front = np.exp(-((self.F - r) / 40.0) ** 2) * self.s * (1 - smoothstep(1200, 2400, r))
        img *= np.exp(-front[..., None] * INK)
        return img


# =========================================================================== 1 序·锦城
class S01(SceneBase):
    seal = '锦城'
    seal_t = 2.6
    keys = [(0, 1248, 700, 1.0), (2.2, 1262, 712, 1.03), (7.9, 1430, 845, 1.22)]
    mist = [dict(y=705, h=55, a=0.7, speed=10), dict(y=870, h=45, a=0.55, speed=16, oy=300),
            dict(y=985, h=30, a=0.45, speed=22, oy=600)]

    def __init__(self):
        self.post = InkFront(1248, 760, 0.1, 950)

    def build(self, cv):
        W = cv.w
        sky = cv.layer('sky', parallax=0.35, fade=0.8, halo=0.6)
        far = cv.layer('far', parallax=0.55, fade=0.6)
        mid = cv.layer('mid', parallax=0.8, fade=0.35)
        pl = cv.layer('plain', 1.0, fade=0.35)
        fg = cv.layer('fg', 1.2, fade=0.3)
        band_wash(sky, 640, 120, OCHRE * 0.8 + VERMILION * 0.2, 0.10, 0.1)
        mountain_range(sky, 0, W, 700, [(260, 230, 200), (760, 300, 230), (1380, 210, 190), (1900, 280, 230), (2350, 200, 200)],
                       pig=INK * 0.45 + INDIGO * 0.55, wash=0.32, outline=0.0, cun=0.0, fall=0.35, fog=0.55, dots=0,
                       t0=0.2, t1=2.2)
        mountain_range(far, 0, W, 800, [(150, 260, 160), (560, 220, 150), (1650, 200, 160), (2150, 250, 170)],
                       pig=INK * 0.7 + INDIGO * 0.3, wash=0.36, outline=0.5, outline_w=2.2, cun=0.45, cun_ink=0.22,
                       fall=0.4, dots=0.3, t0=0.5, t1=3.2)
        mountain_range(mid, 0, 1150, 905, [(200, 440, 150), (520, 340, 150), (880, 210, 140)], wash=0.62, outline=1.0,
                       outline_w=3.6, cun=1.2, cun_ink=0.48, trees=0.8, t0=0.8, t1=4.0)
        mountain_range(mid, 1950, W, 915, [(2250, 250, 150), (2480, 190, 120)], wash=0.42, outline=0.8, cun=0.8,
                       trees=0.4, t0=1.2, t1=4.2)
        ground_wash(pl, 0, 900, W, 360, OCHRE * 0.6 + INK * 0.15, 0.13, 0.6, seeds=[(1248, 1000)], speed=900)
        ground_wash(pl, 400, 1000, 1800, 300, JADE * 0.5 + INK * 0.2, 0.09, 1.0, seeds=[(1248, 1100)], speed=900, cell=120)
        river(pl, pl, [(160, 915), (500, 960), (820, 948), (1100, 1010), (1450, 1035), (1850, 1085), (2200, 1120), (2496, 1135)],
              lambda s: 24 + 70 * s, t0=1.4, t1=4.4, dens=0.13)
        rng = pl.rng
        for k in range(26):
            y = 1060 + k * 7 + k * k * 0.3
            xa = rng.uniform(250, 1500)
            pl.stroke([(xa, y), (xa + rng.uniform(120, 420), y + rng.normal(0, 2))], 0.9, ink=0.22, t0=2.0 + 0.06 * k,
                      dur=0.5, dry=0.6, wet=0.2)
        cx, cy = 1505, 985
        wall_segment(pl, cx - 150, cx + 150, cy, 26, 2.6, 3.8, ink=0.75, crenel=True, dens=0.3)
        wall_segment(pl, cx - 110, cx + 120, cy - 42, 18, 2.8, 3.9, ink=0.45, crenel=False, dens=0.2)
        for sx in (-150, 150):
            pl.stroke([(cx + sx, cy), (cx + sx * 0.75, cy - 44)], 1.6, ink=0.6, t0=3.0, dur=0.3)
        hall(pl, cx, cy - 22, 70, 3.2, ink=0.8, tiers=2, dur=1.2)
        for k, (dx, w) in enumerate([(-90, 38), (-45, 30), (60, 34), (100, 28)]):
            hall(pl, cx + dx, cy - 40, w, 3.4 + 0.15 * k, ink=0.55, tiers=1, dur=0.8, cols=2)
        for k in range(14):
            foliage_tree(pl, rng.uniform(900, 2200), rng.uniform(1000, 1080), rng.uniform(32, 60), 3.0 + 0.1 * k, ink=0.6)
        for k in range(10):
            willow(pl, rng.uniform(600, 1900), 1060 + rng.uniform(0, 40), rng.uniform(55, 80), 3.3 + 0.1 * k, ink=0.55)
        rock(fg, 470, 1265, 520, 250, 2.6, ink=1.0, dur=1.4, wash=0.7)
        rock(fg, 780, 1275, 260, 120, 3.0, ink=0.9, dur=1.0, wash=0.55)
        rock(fg, 2050, 1270, 300, 110, 3.2, ink=0.85, dur=1.0, wash=0.5)
        foliage_tree(fg, 430, 1070, 330, 3.2, ink=1.0, kind='pine')
        foliage_tree(fg, 600, 1080, 240, 3.5, ink=0.9)
        foliage_tree(fg, 2120, 1170, 200, 3.7, ink=0.85)
        reeds(fg, 760, 1000, 1260, 30, 4.0, 5.0, h=55, ink=0.6)
        reveal_radial(cv, 1248, 760, 0.1, 950)


def dry_line(L, pts, w, t0, dur, ink=1.0, pig=INK, pieces=2, dry=0.6, jit=2.0, wob=0.2, rough=0.26, **kw):
    """干笔勾线：把一条线拆成数段，各段粗细/墨量/飞白不同，段间略有错位与断口。"""
    rng = L.rng
    P = catmull(pts, 2.0)
    n = len(P)
    if n < 4:
        return
    pieces = max(1, pieces - (rng.random() < 0.6))
    cuts = sorted(rng.uniform(0.18, 0.82, pieces - 1)) if pieces > 1 else []
    idx = [0] + [int(c * n) for c in cuts] + [n - 1]
    for k in range(pieces):
        a = max(0, idx[k] - int(rng.integers(0, 5)) + (int(rng.integers(0, 6)) if k else 0))
        b = idx[k + 1]
        if b - a < 4:
            continue
        seg = P[a:b + 1:3] + rng.normal(0, jit, 2)
        L.stroke(seg, w * rng.uniform(0.7, 1.3), ink=ink * rng.uniform(0.8, 1.1), pig=pig, t0=t0 + dur * a / n,
                 dur=dur * (b - a) / n, dry=dry * rng.uniform(0.75, 1.25), wobble=wob, rough=rough,
                 taper=kw.pop('taper', (0.06, 0.45)) if k == 0 else (0.06, 0.45), start_w=rng.uniform(0.7, 1.15),
                 end_w=rng.uniform(0.1, 0.5), **kw)


# =========================================================================== 2 古蜀文明
class S02(SceneBase):
    W = 3200
    seal = '古蜀'
    seal_t = 3.0
    keys = [(0, 1150, 720, 1.0), (3.8, 1150, 615, 1.34), (5.0, 1320, 640, 1.2), (8.8, 2150, 690, 1.0), (10.2, 2200, 695, 0.98)]
    mist = [dict(y=1150, h=70, a=0.5, speed=14), dict(y=330, h=80, a=0.35, speed=9, oy=400),
            dict(y=985, h=55, a=0.55, speed=11, oy=250, lo=0.25, hi=0.7),
            dict(y=820, h=50, a=0.3, speed=-9, oy=650, lo=0.4, hi=0.8)]
    disc_c = (2150, 690)

    def layer_affine(self, i, name, t):
        if name != 'disc':
            return None
        return cv2.getRotationMatrix2D(self.disc_c, 3.2 * t, 1.0)

    def build(self, cv):
        bg = cv.layer('bg', parallax=0.7, fade=0.8)
        mk = cv.layer('mask', 1.0, fade=0.6, halo=1.1)
        self.ink_l = cv.layer('mask_ink', 1.0, fade=0.3, halo=0.8)
        dl = cv.layer('disc', 1.0, fade=0.35)
        band_wash(bg, 330, 230, INK * 0.7 + INDIGO * 0.3, 0.16, 0.2, speed=700, cell=260)
        band_wash(bg, 1180, 200, INK * 0.6 + UMBER * 0.4, 0.14, 0.4, speed=700, cell=260)
        # 面具身后一团幽暗的烟墨
        X, Y = 1150, 685
        h, w = 1000, 1500
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        r = np.hypot((xx - w / 2) / 640, (yy - h / 2) / 400)
        f = np.exp(-r ** 2 * 1.6) * (0.55 + 0.6 * vnoise(h, w, 180, bg.rng))
        bg.wash(X - w / 2, Y - h / 2, f.astype(np.float32), INK * 0.75 + INDIGO * 0.25, dens=0.17, t0=0.0,
                seeds=[(X, Y)], speed=600, lo=0.1, hi=1.0, edge=0.25, gran=0.3, warp=0.3)
        # 青铜神树(淡)
        tx, ty = 470, 1260
        bg.stroke([(tx, ty), (tx + 8, ty - 400), (tx - 4, ty - 800)], 9, ink=0.32, t0=0.6, dur=1.2, dry=0.5,
                  taper=(0.02, 0.4), start_w=1.2)
        for lvl in range(3):
            by = ty - 260 - lvl * 220
            for side in (-1, 1):
                ln = 220 - lvl * 50
                pts = [(tx, by), (tx + side * ln * 0.5, by - 60), (tx + side * ln, by + 10), (tx + side * ln * 1.05, by + 60)]
                bg.stroke(pts, 4, ink=0.28, t0=1.0 + 0.3 * lvl, dur=0.8, dry=0.5, taper=(0.05, 0.4))
                bg.dot(tx + side * ln * 1.05, by + 70, 9, ink=0.3, t0=1.8 + 0.3 * lvl, pig=MALACHITE * 0.5 + INK * 0.5)
                bx, bym = tx + side * ln * 0.55, by - 70
                bg.stroke([(bx - 14 * side, bym + 6), (bx, bym), (bx + 12 * side, bym - 8)], 5, ink=0.3, t0=1.9 + 0.3 * lvl, dur=0.2)
        self._mask(mk, X, Y)
        self._disc(dl, *self.disc_c, 300)

    # ------------------------------------------------------------------ 纵目面具
    def _mask(self, L, X, Y):
        """三星堆青铜纵目面具：宽平的面、刀形长眉、杏眼中伸出的柱状瞳、薄而阔的口、翼状展开的大耳。
        以墨色浓淡写块面，少勾线；锈蚀为细密的颗粒与垂流，边缘散入纸与雾中。"""
        rng = L.rng
        K = self.ink_l

        def warp(x, y):
            return (X + x * (1.03 if x > 0 else 1.0) + 6 * math.sin(y / 90 + 1.3),
                    Y + y - 0.012 * max(x, 0) + 4 * math.sin(x / 120 + 0.4))

        def P(pts):
            return [warp(x, y) for x, y in pts]

        ink_d = INK * 0.9 + UMBER * 0.1
        bronze = INK * 0.72 + MALACHITE * 0.13 + UMBER * 0.15
        verd = MALACHITE * 0.45 + JADE * 0.3 + INK * 0.25
        rust = OCHRE * 0.5 + UMBER * 0.5
        face = [(-238, -200), (-120, -210), (0, -214), (120, -210), (238, -200), (246, -40), (236, 110), (200, 200),
                (110, 245), (0, 255), (-110, 245), (-200, 200), (-236, 110), (-246, -40)]
        ears = {s: [(s * 228, -150), (s * 320, -190), (s * 430, -238), (s * 548, -284), (s * 522, -214), (s * 470, -128),
                    (s * 400, -40), (s * 320, 38), (s * 230, 70)] for s in (-1, 1)}
        bx0, by0, bw, bh = int(X - 600), int(Y - 380), 1200, 720

        def fill(poly, blur):
            m = np.zeros((bh, bw), np.uint8)
            q = np.array(P(poly), np.float32) - [bx0, by0]
            cv2.fillPoly(m, [(q * 4).astype(np.int32)], 255, cv2.LINE_AA, shift=2)
            return cv2.GaussianBlur(m.astype(np.float32) / 255, (0, 0), blur)

        def gauss(cx, cy, sx, sy):
            return np.exp(-(((lx * 240 - cx) / sx) ** 2 + ((ly * 240 - cy) / sy) ** 2))

        yy, xx = np.mgrid[0:bh, 0:bw].astype(np.float32)
        lx = (xx + bx0 - X) / 240
        ly = (yy + by0 - Y) / 240
        fm = fill(face, 12)
        em = np.maximum(fill(ears[-1], 9), fill(ears[1], 9))
        edge_n = fbm(bh, bw, 25, 2, rng)
        fm = smoothstep(0.15, 0.85, fm + 0.18 * edge_n)
        em = smoothstep(0.15, 0.85, em + 0.18 * edge_n)
        # 散入纸中：右下颌、耳梢、下巴大片消隐
        n_lo = fbm(bh, bw, 120, 3, rng)
        dis = smoothstep(1.2, 0.5, ly + 0.3 * n_lo + 0.18 * np.maximum(lx, 0))
        dis *= smoothstep(2.4, 1.9, np.abs(lx) + 0.2 * n_lo)
        dis *= smoothstep(-0.35, 0.45, 0.55 + 0.4 * fbm(bh, bw, 75, 3, rng))
        shape = np.maximum(fm, em * 0.9) * dis
        # 纵目柱的位置(先算出，用于在铜面上留出柱身的亮面)
        pillars = []
        pil = np.zeros((bh, bw), np.float32)
        for s_ in (-1, 1):
            ex, ey = warp(s_ * 118, -108)
            ax, ay = s_ * 62, 6                    # 柱轴投影短而朝外：向前伸出、透视缩短
            al = math.hypot(ax, ay)
            ux, uy = ax / al, ay / al
            nx_, ny_ = -uy * s_, ux * s_            # 垂直于轴、指向下方(暗侧)
            gx_, gy_ = xx + bx0 - ex, yy + by0 - ey
            along = gx_ * ux + gy_ * uy
            acr = gx_ * nx_ + gy_ * ny_
            rad = 36
            body = smoothstep(rad + 2, rad - 3, np.abs(acr)) * smoothstep(-4, 4, along) * smoothstep(al + 4, al - 4, along)
            ea = 17.0                                 # 端面椭圆：沿轴方向压扁
            capm = smoothstep(1.06, 0.92, np.hypot((gx_ - ax) * ux + (gy_ - ay) * uy, 0) / ea * 0 +
                              np.hypot(((gx_ - ax) * ux + (gy_ - ay) * uy) / ea, ((gx_ - ax) * nx_ + (gy_ - ay) * ny_) / rad))
            pm = np.maximum(body, capm)
            pil = np.maximum(pil, pm)
            pillars.append((s_, ex, ey, ax, ay, al, nx_, ny_, rad, acr, body, capm))
        carve = 1 - 0.6 * cv2.GaussianBlur(pil, (0, 0), 1.5)
        # 块面：平面淡，两侧/下颌/凹处深
        val = 0.5 + 0.5 * smoothstep(0.62, 1.02, np.abs(lx)) * fm + 0.3 * smoothstep(0.7, 1.05, ly)
        eyes_m = np.zeros_like(val)
        for s in (-1, 1):
            # 眉下的阴影、眼窝、鼻侧
            val += 0.55 * np.exp(-(((lx * 240 - s * 125) / 100) ** 2 + ((ly * 240 + 128 + 0.2 * s * lx * 240 * s) / 16) ** 2))
            eye = [(s * 40, -92), (s * 110, -122), (s * 212, -130), (s * 170, -100), (s * 100, -84)]
            eyes_m = np.maximum(eyes_m, fill(eye, 4))
            val += 0.3 * gauss(s * 38, -30, 14, 70)
        val += 0.75 * eyes_m
        val += 0.6 * gauss(0, 50, 60, 14) + 0.55 * gauss(0, 112, 190, 12)     # 鼻下、口下
        val -= 0.14 * (gauss(0, -170, 150, 30) + gauss(-120, 15, 60, 50) + gauss(120, 15, 60, 50) + gauss(0, -40, 16, 70))
        ear_v = 0.5 + 0.7 * smoothstep(1.7, 0.95, np.abs(lx)) + 0.35 * np.exp(-((ly * 240 + 150 + (np.abs(lx) - 1) * 120) / 22) ** 2)
        val = val * fm + ear_v * (1 - fm)
        val = np.clip(val, 0.25, 1.4)
        # 锈蚀肌理：细颗粒 + 竖向垂流
        fine = vnoise(bh, bw, 5, rng)
        streak = vnoise(bh, bw, 6, rng, 70)
        tex = (0.9 + 0.15 * fine) * (0.92 + 0.14 * streak) * (0.85 + 0.3 * vnoise(bh, bw, 22, rng))
        tf = (0.3 + np.hypot(lx, ly * 1.2) * 0.8 + 0.25 * n_lo * 0.5).astype(np.float32)
        L.wash(bx0, by0, (shape * val * tex * carve).astype(np.float32), bronze, dens=1.0, tfield=tf, lo=0.02, hi=0.9, edge=0.25,
               gran=0.4, warp=0.12, edge_blur=6)
        # 积墨：凹处再压一层深墨
        deep = shape * np.clip(val - 0.75, 0, 1) * (0.7 + 0.5 * fine) * carve
        L.wash(bx0, by0, deep.astype(np.float32), ink_d, dens=0.7, tfield=tf + 0.5, lo=0.04, hi=0.6, edge=0.7, gran=0.6,
               warp=0.1, edge_blur=3)
        # 铜绿结壳：成片而细碎
        crust = shape * carve * smoothstep(0.3, 1.1, fbm(bh, bw, 45, 3, rng)) * (0.6 + 0.4 * smoothstep(0.2, 0.8, vnoise(bh, bw, 9, rng)))
        L.wash(bx0, by0, crust.astype(np.float32), verd, dens=0.2, tfield=tf + 0.7, lo=0.12, hi=0.7, edge=0.6, gran=0.6,
               warp=0.05, edge_blur=2)
        # 土锈垂痕
        rr_ = shape * smoothstep(0.8, 1.4, fbm(bh, bw, 50, 3, rng)) * (0.7 + 0.3 * streak)
        L.wash(bx0, by0, rr_.astype(np.float32), rust, dens=0.18, tfield=tf + 0.9, lo=0.12, hi=0.7, edge=0.5, gran=0.8,
               warp=0.05)
        # 蚀坑：细小深点
        pits = shape * smoothstep(0.9, 0.95, vnoise(bh, bw, 3, rng)) * smoothstep(0.6, 1.2, fbm(bh, bw, 90, 2, rng))
        L.wash(bx0, by0, pits.astype(np.float32), ink_d, dens=0.6, tfield=tf + 1.0, lo=0.1, hi=0.5, edge=0.0, gran=0.3,
               warp=0.0)

        # ---- 少量干笔：只勾部分边缘，其余由墨块自现
        def C(pts, w, t0, dur, pieces=2, ink=1.3, dry=0.6, **kw):
            dry_line(K, P(pts), w, t0, dur, ink=ink * 1.5, pig=ink_d, pieces=pieces, dry=dry, **kw)

        for s, tt in ((-1, 0.8), (1, 1.0)):
            # 耳：自耳根一笔扫向耳梢，飞白收笔；下缘只一短笔
            C([(s * 232, -150), (s * 320, -190), (s * 420, -236)], 16 if s < 0 else 12, tt, 0.45, pieces=1,
              dry=0.6 if s < 0 else 0.85, ink=1.1 if s < 0 else 0.85, taper=(0.04, 0.7))
            C([(s * 236, 66), (s * 300, 44), (s * 360, 4)], 6, tt + 0.5, 0.35, pieces=1, ink=0.8, dry=0.75)
            # 长眉：一笔干皴——内端重按，向外渐提，眉梢飞白
            ib, ob = (s * 40, -150), (s * 228, -173)
            brow = P([(ib[0], ib[1] - 7), (ob[0], ob[1] - 3), (ob[0], ob[1] + 3), (ib[0], ib[1] + 7)])
            poly_wash(K, brow, ink_d, 0.22, 1.2 + 0.15 * (s > 0), blur=3, speed=500, edge=0.3, lo=0.2, hi=0.7)
            K.stroke(P([ib, ((ib[0] * 2 + ob[0]) / 3, (ib[1] * 2 + ob[1]) / 3 - 2), ((ib[0] + ob[0] * 2) / 3, (ib[1] + ob[1] * 2) / 3 - 2),
                        ob]), 15, ink=1.45, pig=ink_d, t0=1.2 + 0.15 * (s > 0), dur=0.4, dry=0.75, wet=0.4, bristle=1.0,
                     taper=(0.06, 0.65), start_w=1.0, end_w=0.08, rough=0.3, wobble=0.25)
            # 杏眼：上睑一笔重、下睑一笔轻
            C([(s * 44, -96), (s * 96, -118), (s * 150, -128)], 5, 1.8 + 0.1 * (s > 0), 0.3, pieces=1, ink=0.85, dry=0.6,
              taper=(0.1, 0.6))
            C([(s * 168, -128), (s * 212, -131)], 4, 1.95, 0.15, pieces=1, ink=0.7, dry=0.7)
            C([(s * 70, -84), (s * 150, -94), (s * 208, -124)], 3, 1.9, 0.3, pieces=1, ink=0.7, dry=0.7)
        # 纵目：短而粗的圆柱自眼中向前、向外伸出——柱身下侧暗、上侧留亮；端面椭圆内淡染，一笔重弧写其外缘；投影落在下方面颊
        for s_, ex, ey, ax, ay, al, nx_, ny_, rad, acr, body, capm in pillars:
            te = 1.3 + 0.2 * (s_ > 0)
            tx, ty = ex + ax, ey + ay
            ux, uy = ax / al, ay / al
            shd = [(ex - s_ * 6, ey + rad * 0.8), (tx + s_ * 22, ty + rad * 0.9), (tx + s_ * 40, ty + rad + 34),
                   (ex + s_ * 4, ey + rad + 30)]
            poly_wash(L, shd, INK * 0.85 + UMBER * 0.15, 0.8, 1.0, blur=10, speed=200, edge=0.2, lo=0.12, hi=0.8)
            shade_ = smoothstep(-rad * 0.6, rad, acr) * 0.9 + 0.12
            K.wash(bx0, by0, (body * (1 - capm) * shade_).astype(np.float32), bronze, dens=1.6, t0=te, seeds=[(ex, ey)],
                   speed=140, lo=0.04, hi=0.7, edge=0.5, gran=0.5, warp=0.05)
            K.wash(bx0, by0, (capm * 0.45).astype(np.float32), bronze * 0.5 + verd * 0.5, dens=0.3, t0=te + 0.3,
                   seeds=[(tx, ty)], speed=100, lo=0.1, hi=0.6, edge=0.9, gran=0.6, warp=0.04)
            # 端面外缘：一笔重弧(外侧与下侧)，上内侧留空
            ea = 17.0
            rim = [(tx + ux * ea * math.cos(q) + nx_ * rad * math.sin(q), ty + uy * ea * math.cos(q) + ny_ * rad * math.sin(q))
                   for q in np.linspace(-0.9, 2.3, 14)]
            dry_line(K, rim, 10, te + 0.35, 0.35, ink=1.8, pig=ink_d, pieces=1, dry=0.45, taper=(0.1, 0.6))
            # 柱身下沿一笔淡干皴
            dry_line(K, [(ex + nx_ * rad, ey + ny_ * rad), (tx + nx_ * rad, ty + ny_ * rad)], 6, te + 0.2, 0.2, ink=1.3,
                     pig=ink_d, pieces=1, dry=0.7, taper=(0.2, 0.3))
        # 鼻：一侧鼻梁淡皴，鼻底一短横，两端略重
        C([(14, -104), (22, -40), (34, 30)], 5, 2.0, 0.4, pieces=1, ink=0.6, dry=0.85)
        C([(-52, 50), (-10, 54), (30, 52)], 5, 2.1, 0.3, pieces=1, ink=0.6, dry=0.75, taper=(0.15, 0.4))
        # 阔口：一道薄而长的闭口线，口角微翘
        C([(-212, 92), (-110, 100), (0, 102), (110, 99), (214, 88)], 5, 2.2, 0.6, pieces=2, ink=1.15, dry=0.55)

    # ------------------------------------------------------------------ 太阳神鸟
    def _disc(self, L, X, Y, R):
        rng = L.rng
        gold = GOLD * 0.78 + OCHRE * 0.3 + VERMILION * 0.04
        line = GOLD * 0.3 + OCHRE * 0.35 + INK * 0.42
        S = int(R * 1.6)
        yy, xx = np.mgrid[-S:S, -S:S].astype(np.float32)
        rr = np.hypot(xx, yy) / R
        nz = fbm(2 * S, 2 * S, 60, 3, rng)
        glow = np.exp(-(rr / 1.2) ** 2) * (0.7 + 0.3 * vnoise(2 * S, 2 * S, 90, rng))
        L.wash(X - S, Y - S, glow.astype(np.float32), GOLD * 0.8 + OCHRE * 0.2, dens=0.07, t0=4.3, seeds=[(X, Y)], speed=500,
               lo=0.0, hi=1.0, edge=0.0, gran=0.2, warp=0.0)
        # 四鸟：金环上留白(镂空)的剪影
        rmid = R * 0.83
        birds = np.zeros((2 * S, 2 * S), np.uint8)
        outlines = []
        shape = [(1.00, 0.00), (0.93, 0.03), (0.88, 0.06), (0.83, 0.05), (0.76, 0.02), (0.64, 0.045), (0.54, 0.09),
                 (0.47, 0.17), (0.39, 0.235), (0.40, 0.15), (0.34, 0.10), (0.22, 0.075), (0.10, 0.075), (-0.02, 0.12),
                 (-0.09, 0.13), (0.02, 0.05), (-0.09, -0.02), (-0.03, -0.045), (0.12, -0.02), (0.32, -0.07),
                 (0.56, -0.055), (0.74, -0.012), (0.84, 0.012), (0.92, 0.012)]
        legs = [[(0.40, -0.068), (0.425, -0.115)], [(0.425, -0.115), (0.40, -0.132)], [(0.425, -0.115), (0.45, -0.13)]]
        span = 1.05        # 每只鸟所占弧度
        def bird_pt(a0, s, hgt):
            a = a0 + s * span
            r = rmid + (hgt - 0.08) * 240
            return (math.cos(a) * r, math.sin(a) * r)
        for b in range(4):
            a0 = b * np.pi / 2 + 0.15
            poly = np.array([bird_pt(a0, s, hg) for s, hg in shape], np.float32)
            cv2.fillPoly(birds, [((poly + S) * 4).astype(np.int32)], 255, cv2.LINE_AA, shift=2)
            outlines.append((b, poly, [[bird_pt(a0, s, hg) for s, hg in lg] for lg in legs], bird_pt(a0, 0.875, 0.035)))
        bm = cv2.GaussianBlur(birds.astype(np.float32) / 255, (0, 0), 1.2)
        ring = smoothstep(0.645, 0.665, rr) * smoothstep(1.0, 0.985, rr) * (1 - bm)
        tf = (4.5 + (np.arctan2(yy, xx) % (2 * np.pi)) / (2 * np.pi) * 1.2 + 0.2 * nz * 0.5).astype(np.float32)
        ring = ring * (0.75 + 0.25 * nz + 0.3 * smoothstep(0.8, 1.0, rr))
        L.wash(X - S, Y - S, ring.astype(np.float32), gold, dens=0.2, tfield=tf, lo=0.1, hi=0.6,
               edge=0.6, gran=0.65, warp=0.05, edge_blur=3)
        for rad, wv, tt in ((R * 1.0, 1.2, 4.5), (R * 0.655, 1.2, 4.8)):
            pts = [(X + math.cos(a) * rad, Y + math.sin(a) * rad) for a in np.linspace(0, 2 * np.pi, 72)]
            L.stroke(pts, wv, ink=0.7, pig=line, t0=tt, dur=1.0, dry=0.35, taper=(0.02, 0.05), rough=0.3)
        for b, poly, lgs, eye in outlines:
            tt = 6.5 + 0.3 * b
            pts = [(X + px, Y + py) for px, py in poly]
            L.stroke(pts + pts[:2], 1.5, ink=0.85, pig=line, t0=tt, dur=0.6, dry=0.2, taper=(0.02, 0.1), rough=0.15)
            for lg in lgs:
                L.stroke([(X + px, Y + py) for px, py in lg], 1.6, ink=0.8, pig=line, t0=tt + 0.5, dur=0.15,
                         taper=(0.05, 0.5))
            L.dot(X + eye[0], Y + eye[1], 2.2, ink=0.9, pig=line, t0=tt + 0.55, elong=1.0)
        # 十二道旋转的光芒：细长的弯钩，金染 + 细线
        r0, r1 = R * 0.21, R * 0.6
        for i in range(12):
            th = i * np.pi / 6
            lead, trail = [], []
            for q in np.linspace(0, 1, 14):
                rad = lerp(r0, r1, q)
                a = th + 1.15 * q ** 1.2
                half = 0.13 * (1 - q) ** 1.3 + 0.004
                lead.append((X + math.cos(a + half) * rad, Y + math.sin(a + half) * rad))
                trail.append((X + math.cos(a - half * 0.5) * rad, Y + math.sin(a - half * 0.5) * rad))
            tt = 5.2 + 0.1 * i
            poly_wash(L, lead + trail[::-1], gold, 0.42, tt, blur=1.2, speed=260, edge=0.8, lo=0.25, hi=0.6)
            L.stroke(lead, 1.3, ink=0.8, pig=line, t0=tt, dur=0.35, dry=0.2, taper=(0.02, 0.6), rough=0.1)
        cen = ellipse(X, Y, r0 * 0.97, r0 * 0.97, n=40)
        L.stroke(cen, 1.6, ink=0.8, pig=line, t0=5.0, dur=0.5, dry=0.3, taper=(0.02, 0.05))
        cg = np.exp(-(rr / 0.16) ** 2) * 0.6
        L.wash(X - S, Y - S, cg.astype(np.float32), GOLD * 0.7 + VERMILION * 0.3, dens=0.12, t0=5.0, seeds=[(X, Y)], speed=200,
               lo=0.0, hi=1.0, edge=0.0, gran=0.3)


# =========================================================================== 3 开明迁都
class S03(SceneBase):
    W = 3800
    seal = '成都'
    seal_t = 7.4
    keys = [(0, 1000, 720, 1.04), (4.4, 1320, 730, 1.04), (6.4, 2020, 725, 1.03), (9.0, 2900, 720, 1.0),
            (11.6, 2450, 760, 0.8)]
    mist = [dict(y=640, h=60, a=0.6, speed=10), dict(y=1240, h=50, a=0.35, speed=18, oy=500)]

    def build(self, cv):
        far = cv.layer('far', 0.55, fade=0.7)
        wl = cv.layer('wash', 1.0, fade=0.6)
        mid = cv.layer('mid', 1.0, fade=0.35)
        fg = cv.layer('fg', 1.2, fade=0.35)
        rng = mid.rng
        mountain_range(far, 0, cv.w, 660, [(400, 250, 260), (1200, 300, 300), (2100, 260, 260), (2900, 320, 300), (3500, 250, 240)],
                       pig=INK * 0.55 + INDIGO * 0.45, wash=0.36, outline=0.45, outline_w=2.4, cun=0.45, cun_ink=0.22,
                       fall=0.35, dots=0.2, t0=0.0, t1=6.0)
        river(wl, mid, [(0, 1170), (600, 1205), (1300, 1175), (2000, 1230), (2800, 1200), (3800, 1240)], 120, t0=0.2, t1=9.0,
              dens=0.14)
        ground_wash(wl, 0, 820, cv.w, 340, OCHRE * 0.55 + JADE * 0.25, 0.16, 0.3, seeds=[(300, 950)], speed=420)
        # 聚：河边几间茅屋
        for k, (x, y, w) in enumerate([(640, 1085, 170), (850, 1110, 140), (1060, 1080, 160)]):
            hut(mid, x, y, w, 0.6 + 0.9 * k, ink=0.95, wash_l=wl, roof_pig=OCHRE * 0.45 + INK * 0.35)
        willow(mid, 470, 1120, 260, 1.0, ink=0.8)
        willow(mid, 1250, 1110, 220, 2.6, ink=0.75)
        foliage_tree(mid, 960, 1060, 200, 2.0, ink=0.85)
        for k in range(8):
            mid.stroke([(560 + k * 26, 1135), (562 + k * 26, 1100)], 2.2, ink=0.75, t0=3.0 + 0.05 * k, dur=0.1)
        mid.stroke([(555, 1112), (770, 1110)], 1.6, ink=0.6, t0=3.4, dur=0.3)
        figure(mid, 960, 1140, 44, 3.3, load='basket')
        figure(mid, 760, 1145, 42, 3.6, load='pole', facing=-1)
        boat(mid, 900, 1200, 110, 3.2, ink=0.85)
        # 邑：村落与田畴
        xs = [1500, 1640, 1790, 1930, 2080, 1570, 1720, 1870, 2020]
        ys = [1045, 1060, 1040, 1065, 1050, 1000, 990, 1005, 995]
        for k, (x, y) in enumerate(zip(xs, ys)):
            tt = 3.9 + 0.22 * k
            if k % 3 == 1:
                hall(mid, x, y, 130, tt, ink=0.9, tiers=1, dur=0.9, cols=3, wash_l=wl)
            else:
                hut(mid, x, y, 125, tt, ink=0.9, wash_l=wl, dur=0.8, roof_pig=OCHRE * 0.45 + INK * 0.35)
        for k in range(5):
            x0 = 1440 + k * 150
            for j in range(2):
                y0 = 1092 + j * 30
                poly_wash(wl, [(x0, y0), (x0 + 138, y0 + 2), (x0 + 143, y0 + 25), (x0 + 3, y0 + 23)], JADE * 0.8 + INK * 0.15,
                          0.3, 4.4 + 0.12 * k + 0.1 * j, blur=2)
                mid.stroke([(x0, y0 + 25), (x0 + 143, y0 + 27)], 1.2, ink=0.5, t0=4.5 + 0.12 * k, dur=0.3, dry=0.5)
        for k in range(7):
            foliage_tree(mid, 1450 + k * 110 + rng.uniform(-30, 30), 975 + rng.uniform(0, 20), rng.uniform(90, 140), 4.5 + 0.2 * k,
                         ink=0.8)
        for k in range(6):
            figure(mid, 1480 + rng.uniform(0, 700), 1160 + rng.uniform(-6, 6), 40, 5.0 + 0.2 * k,
                   load=rng.choice(['pole', 'basket', None]), facing=rng.choice([-1, 1]))
        # 都：夯土城墙、宫室
        wall_segment(mid, 2420, 3500, 1110, 85, 6.2, 8.0, ink=0.95, wash_l=wl, dens=0.42)
        wall_segment(mid, 2520, 3400, 960, 45, 6.6, 8.3, ink=0.65, wash_l=wl, dens=0.25, crenel=True)
        mid.stroke([(2420, 1110), (2520, 960)], 2.4, ink=0.7, t0=7.0, dur=0.4)
        mid.stroke([(3500, 1110), (3400, 960)], 2.4, ink=0.7, t0=7.0, dur=0.4)
        hall(mid, 2960, 1025, 150, 7.1, ink=1.0, tiers=2, dur=1.0, wash_l=wl, wall_pig=VERMILION * 0.45)
        hall(mid, 2960, 950, 380, 7.5, ink=1.0, tiers=2, dur=1.4, wash_l=wl, wall_pig=VERMILION * 0.4, cols=6)
        for k, (dx, dy, w) in enumerate([(-320, 965, 190), (320, 970, 200), (-200, 990, 140), (210, 995, 140)]):
            hall(mid, 2960 + dx, dy, w, 7.8 + 0.15 * k, ink=0.9, tiers=1, dur=0.8, wash_l=wl, cols=3)
        for k in range(10):
            figure(mid, 2500 + rng.uniform(0, 950), 1170 + rng.uniform(-5, 5), 40, 8.4 + 0.1 * k,
                   load=rng.choice(['pole', 'basket', None]), facing=rng.choice([-1, 1]))
        for k in range(5):
            willow(mid, 2350 + k * 290 + rng.uniform(-40, 40), 1200, rng.uniform(160, 210), 8.6 + 0.12 * k, ink=0.7)
        # 近景：墨石、杂树、芦苇
        for (x, w, h, t) in ((260, 380, 160, 1.2), (1350, 300, 130, 4.0), (2350, 340, 140, 6.2), (3600, 360, 150, 8.6)):
            rock(fg, x, 1440, w, h, t, ink=1.0, dur=1.0, wash=0.65)
            foliage_tree(fg, x - w * 0.15, 1330, 300, t + 0.4, ink=0.95, kind='pine' if x % 2 else 'round')
            reeds(fg, x + w * 0.2, x + w * 0.7, 1400, 18, t + 0.6, t + 1.4, h=70, ink=0.65)
        reveal_x(cv, 300, 0.0, 420)


# =========================================================================== 4 秦筑城
class S04(SceneBase):
    W = 3600
    seal = '秦城'
    seal_t = 3.0
    keys = [(0, 1150, 700, 1.02), (6.0, 1900, 690, 1.03), (12.7, 2780, 650, 1.12)]
    mist = [dict(y=700, h=60, a=0.55, speed=12), dict(y=1150, h=45, a=0.3, speed=25, oy=700)]
    walls = [(300, 1250, 0.4), (1250, 2150, 2.4), (2150, 2780, 4.6), (3060, 3500, 6.4)]
    base_y, wall_h = 1090, 260

    def build(self, cv):
        far = cv.layer('far', 0.55, fade=0.7)
        wl = cv.layer('wash', 1.0, fade=0.5)
        mid = cv.layer('mid', 1.0, fade=0.3)
        fg = cv.layer('fg', 1.2, fade=0.35)
        rng = mid.rng
        mountain_range(far, 0, cv.w, 740, [(400, 280, 260), (1300, 340, 300), (2300, 300, 280), (3200, 320, 300)],
                       pig=INK * 0.6 + INDIGO * 0.4, wash=0.36, outline=0.5, outline_w=2.4, cun=0.5, cun_ink=0.24, fall=0.35,
                       t0=0.0, t1=4.0, dots=0.2)
        ground_wash(wl, 0, 1020, cv.w, 380, UMBER * 0.6 + INK * 0.25, 0.22, 0.2, seeds=[(1200, 1150)], speed=900)
        by, wh = self.base_y, self.wall_h
        for (xa, xb, t0) in self.walls:
            t1 = t0 + 3.6
            w = int(xb - xa)
            hh = wh + 30
            yy = np.arange(hh, dtype=np.float32)[:, None]
            xx = np.arange(w, dtype=np.float32)[None, :]
            topj = 10 * vnoise(1, w, 60, rng)[0][None, :]
            f = smoothstep(topj + 6, topj + 14, yy) * smoothstep(hh, hh - 6, yy)
            layers_ = 0.82 + 0.18 * np.sin(yy / (wh / 9) * 2 * np.pi) ** 8
            tex = vnoise(hh, w, 50, rng, 8) * 0.5 + 0.6
            side = 0.75 + 0.25 * smoothstep(0, 0.15 * w, xx) * smoothstep(w, 0.85 * w, xx)
            f = f * layers_ * tex * side
            tf = (t0 + (t1 - t0) * (1 - yy / hh) + 0.25 * vnoise(hh, w, 40, rng)).astype(np.float32)
            tf = np.broadcast_to(tf, (hh, w)).copy()
            wl.wash(xa, by - hh, f.astype(np.float32), UMBER * 0.75 + OCHRE * 0.25, dens=0.6, tfield=tf, lo=0.05, hi=0.9,
                    edge=0.6, gran=0.7, warp=0.15)
            wl.wash(xa, by - hh, (f * smoothstep(0.2, 1.0, xx / w)).astype(np.float32), INK, dens=0.22, tfield=tf, lo=0.1,
                    hi=0.9, edge=0.3, gran=0.6)
            nb = 9
            for bnd in range(1, nb):
                yb_ = by - wh * bnd / nb
                tb = t0 + (t1 - t0) * bnd / nb
                xq = xa + rng.uniform(0, 30)
                while xq < xb - 30:
                    xe = min(xb, xq + rng.uniform(80, 260))
                    mid.stroke([(xq, yb_ + rng.normal(0, 0.6)), ((xq + xe) / 2, yb_ + rng.normal(0, 1.2)), (xe, yb_ + rng.normal(0, 0.6))],
                               rng.uniform(0.9, 1.8), ink=rng.uniform(0.35, 0.6), t0=tb, dur=0.5, dry=0.6, wet=0.2)
                    xq = xe + rng.uniform(5, 40)
            mid.stroke([(xa, by - wh), (xa + rng.normal(0, 2), by)], 2.6, ink=0.85, t0=t0, dur=t1 - t0, dry=0.45)
            mid.stroke([(xb, by - wh), (xb + rng.normal(0, 2), by)], 2.6, ink=0.85, t0=t0, dur=t1 - t0, dry=0.45)
            mid.stroke([(xa - 10, by), (xb + 10, by)], 3.0, ink=0.9, t0=t0, dur=0.6, dry=0.4)
            # 夹板与立柱(最上一层夯土)
            for k in range(int(w / 140) + 1):
                px = xa + 20 + k * (w - 40) / max(1, int(w / 140))
                mid.stroke([(px, by - wh + 20), (px + rng.normal(0, 1), by - wh - 55)], 3.2, ink=0.95, t0=t1, dur=0.3, dry=0.35,
                           pig=INK_WARM)
            for yy_ in (by - wh - 8, by - wh - 34):
                mid.stroke([(xa + 5, yy_), (xb - 5, yy_ + rng.normal(0, 1))], 4.0, ink=0.85, t0=t1 + 0.2, dur=0.6, dry=0.4,
                           pig=INK_WARM)
        # 运土坡道与挑土的人
        for (rx, t0) in ((900, 1.5), (1900, 3.5)):
            mid.stroke([(rx - 260, by + 2), (rx - 120, by - 120), (rx, by - 240)], 3, ink=0.75, t0=t0, dur=0.8, dry=0.5)
            mid.stroke([(rx - 200, by + 2), (rx - 60, by - 120), (rx + 50, by - 240)], 2, ink=0.6, t0=t0 + 0.2, dur=0.8, dry=0.5)
            poly_wash(wl, [(rx - 260, by), (rx, by - 240), (rx + 50, by - 240), (rx - 200, by)], UMBER, 0.35, t0)
        # 城门楼
        gx = 2920
        mid.stroke([(2780, by), (2780, by - wh)], 3, ink=0.9, t0=6.8, dur=0.4)
        mid.stroke([(3060, by), (3060, by - wh)], 3, ink=0.9, t0=6.8, dur=0.4)
        poly_wash(wl, [(2780, by - wh), (3060, by - wh), (3060, by), (2990, by), (2990, by - 120), (2850, by - 120), (2850, by),
                       (2780, by)], UMBER * 0.8 + INK * 0.2, 0.6, 7.0)
        arch = [(2850, by)] + [(gx + 70 * math.cos(a), by - 120 - 50 * math.sin(a)) for a in np.linspace(np.pi, 0, 9)] + [(2990, by)]
        mid.stroke(arch, 4, ink=1.0, t0=7.2, dur=0.6)
        poly_wash(wl, arch, INK, 0.85, 7.3, blur=2)
        hall(mid, gx, by - wh, 300, 8.0, ink=1.0, tiers=2, dur=1.6, wash_l=wl, wall_pig=VERMILION * 0.35, cols=5)
        for wx in (700, 1700, 3350):
            hall(mid, wx, by - wh - 40, 130, 7.0 + wx / 3000, ink=0.95, tiers=1, dur=0.8, wash_l=wl, cols=3)
        for k, bx in enumerate([520, 1100, 1450, 2050, 2500, 2840, 3010, 3300]):
            banner(mid, bx, by - wh - 40, 150, 4.0 + 0.6 * k, ink=1.0)
        # 台上监工(背影，高冠)
        ox_, oy_ = 420, 1250
        poly_wash(wl, [(ox_ - 110, oy_), (ox_ + 110, oy_), (ox_ + 95, oy_ - 50), (ox_ - 95, oy_ - 50)], UMBER * 0.8 + INK * 0.2, 0.6, 1.0)
        mid.stroke([(ox_ - 115, oy_ - 50), (ox_ + 115, oy_ - 50)], 4, ink=0.95, t0=1.0, dur=0.4)
        figure(mid, ox_, oy_ - 52, 130, 1.6, ink=1.05, pose=None)
        mid.stroke([(ox_ - 3, oy_ - 52 - 130 + 8), (ox_ + 3, oy_ - 52 - 130 - 30)], 9, ink=1.1, t0=1.9, dur=0.15, taper=(0.1, 0.1))
        for k in range(26):
            x = rng.uniform(250, 2700)
            figure(mid, x, 1200 + rng.uniform(-20, 70), rng.uniform(36, 46), rng.uniform(0.5, 9.0),
                   load=rng.choice(['pole', 'basket', None, None]), facing=rng.choice([-1, 1]), ink=0.9)
        for (x, w, h, t) in ((150, 360, 150, 0.8), (1500, 300, 120, 3.0), (2600, 340, 140, 6.0), (3450, 300, 120, 8.0)):
            rock(fg, x, 1440, w, h, t, ink=1.0, dur=1.0, wash=0.65)
            reeds(fg, x - w * 0.4, x + w * 0.4, 1400, 16, t + 0.4, t + 1.2, h=80, ink=0.7)

    def wall_top(self, x, t):
        for (xa, xb, t0) in self.walls:
            if xa <= x <= xb:
                p = np.clip((t - t0) / 3.6, 0, 1)
                return self.base_y - self.wall_h * p, p
        return None, 0

    def dynamic(self, ctx):
        t = ctx.t
        buf = ctx.canvas()
        rng = np.random.default_rng(44)
        z = ctx.z
        for k in range(46):
            x = rng.uniform(320, 3480)
            if 2780 < x < 3060:
                continue
            top, p = self.wall_top(x, t)
            if top is None or p <= 0.02 or p >= 0.995:
                continue
            ph = rng.uniform(0, 6.28)
            lift = (0.5 + 0.5 * math.sin(t * 7.0 + ph)) * 10
            h = 30
            (sx, sy), = ctx.pts([(x, top)])
            s = z
            cv2.circle(buf, (int(sx), int(sy - h * s + 3 * s)), max(1, int(3.2 * s)), 230, -1, cv2.LINE_AA)
            cv2.line(buf, (int(sx), int(sy - h * s + 6 * s)), (int(sx - 1 * s), int(sy - 4 * s)), 220, max(1, int(4 * s)), cv2.LINE_AA)
            cv2.line(buf, (int(sx - 2 * s), int(sy - 4 * s)), (int(sx - 4 * s), int(sy)), 200, max(1, int(1.6 * s)), cv2.LINE_AA)
            cv2.line(buf, (int(sx + 1 * s), int(sy - 4 * s)), (int(sx + 4 * s), int(sy)), 200, max(1, int(1.6 * s)), cv2.LINE_AA)
            rx = int(sx + 6 * s)
            cv2.line(buf, (rx, int(sy - (h + 6 + lift) * s)), (rx, int(sy - (2 + lift) * s)), 210, max(1, int(1.8 * s)), cv2.LINE_AA)
            cv2.line(buf, (rx - int(3 * s), int(sy - (2 + lift) * s)), (rx + int(3 * s), int(sy - (2 + lift) * s)), 230,
                     max(1, int(3 * s)), cv2.LINE_AA)
        ctx.add(buf, INK, 0.9, blur=0.6)
        # 尘土：贴近墙脚漂移的赭色薄雾
        dust = ctx.runtime.mist_tex
        ox = int(t * 25) % 600
        sub = cv2.resize(dust[100:400, ox:ox + 1200], (SW, 300))
        (_, y0), = ctx.pts([(0, self.base_y - 120)])
        y0 = int(np.clip(y0, 0, SH - 300))
        d = smoothstep(0.45, 0.85, sub) * 0.10 * np.sin(np.linspace(0, np.pi, 300))[:, None]
        ctx.A[y0:y0 + 300] += d[..., None] * (UMBER * 0.7 + OCHRE * 0.3)


# =========================================================================== 5 都江堰
class S05(SceneBase):
    W, H = 2600, 1500
    seal = '天府'
    seal_t = 5.5
    keys = [(0, 900, 540, 1.3), (4.6, 960, 860, 1.22), (11.93, 1300, 770, 0.86)]
    mist = [dict(y=300, h=70, a=0.55, speed=12), dict(y=420, h=55, a=0.5, speed=-9, oy=200),
            dict(y=560, h=50, a=0.4, speed=18, oy=300), dict(y=1000, h=45, a=0.45, speed=15, oy=500, lo=0.35, hi=0.8)]
    MAIN = [(60, 150), (260, 230), (430, 260), (600, 360), (760, 430), (900, 520), (985, 600)]
    OUTER = [(985, 600), (1120, 640), (1320, 690), (1560, 720), (1820, 790), (2080, 860), (2350, 920), (2650, 990)]
    INNER = [(985, 600), (955, 680), (930, 770), (925, 850), (935, 915)]
    ORIGIN = (935, 935)

    CANAL_V = 360.0  # 渠水推进速度(px/s)
    # (来源, 点列)：来源为 ('origin', t) 宝瓶口 / ('outer', t) 外江南岸开口 / 整数 = 父渠序号。分叉点错落
    CANALS = [
        (('origin', 4.6), [(935, 935), (922, 1004), (880, 1080), (822, 1170), (770, 1262), (702, 1368), (652, 1476), (612, 1570)]),
        (0, [(880, 1080), (760, 1102), (600, 1134), (452, 1182), (300, 1240), (120, 1292), (-60, 1332)]),
        (0, [(770, 1262), (862, 1322), (958, 1402), (1010, 1490), (1046, 1570)]),
        (1, [(452, 1182), (422, 1290), (362, 1400), (330, 1570)]),
        (('outer', 5.0), [(1330, 776), (1352, 880), (1330, 990), (1300, 1100), (1252, 1220), (1222, 1340), (1196, 1460),
                          (1172, 1570)]),
        (4, [(1300, 1100), (1450, 1132), (1600, 1190), (1702, 1262), (1764, 1334), (1800, 1420)]),
        (4, [(1222, 1340), (1300, 1420), (1340, 1570)]),
        (('outer', 5.6), [(1822, 858), (1834, 952), (1802, 1052), (1842, 1162), (1902, 1282), (1952, 1400), (1990, 1570)]),
        (7, [(1802, 1052), (1952, 1082), (2152, 1102), (2352, 1152), (2650, 1182)]),
        (('outer', 6.2), [(2352, 988), (2372, 1082), (2332, 1202), (2382, 1322), (2422, 1452), (2452, 1570)]),
        (7, [(1902, 1282), (2050, 1330), (2200, 1400), (2260, 1500)]),
    ]

    def _geom(self):
        """返回 [(点列, 起流时刻, 层级)]，起流时刻 = 水到达分叉点的时刻。"""
        rng = np.random.default_rng(515)
        out = []
        for src, pts in self.CANALS:
            pts = [(x + rng.normal(0, 6), y + rng.normal(0, 4)) if 0 < i else (x, y) for i, (x, y) in enumerate(pts)]
            if isinstance(src, tuple):
                ts, dep = src[1], 0
            else:
                pp, pts0, pdep = out[src]
                P = np.array(pp)
                d = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
                i = int(np.argmin(np.hypot(P[:, 0] - pts[0][0], P[:, 1] - pts[0][1])))
                pts[0] = tuple(P[i])
                ts, dep = pts0 + d[i] / self.CANAL_V, 1
            out.append((pts, ts, dep))
        return out

    def _ytop(self, x):
        """田畴的上沿(远端)：左侧山后、中部小山脚、右侧外江南岸。"""
        ox_ = [p[0] for p in self.OUTER]
        oy_ = [p[1] for p in self.OUTER]
        riv = np.interp(x, ox_, oy_) + 105
        base = np.interp(x, [0, 430, 600, 1150, 1400], [590, 640, 985, 1010, 1000])
        return np.where(x > 1200, np.maximum(riv, np.interp(x, [1200, 1400], [1010, 860])), base)

    def build(self, cv):
        far = cv.layer('far', 0.6, fade=0.8, halo=0.6)
        mid = cv.layer('midmt', 0.8, fade=0.6)
        mt = cv.layer('mount', 1.0, fade=0.4)
        pd = cv.layer('paddy', 1.0, fade=0.9, halo=0.5)
        wl = cv.layer('wash', 1.0, fade=0.6)
        ln = cv.layer('lines', 1.0, fade=0.3)
        rng = ln.rng
        # 三重山：远山只染不勾、淡青灰，半没雾中；中山淡勾；近山皴染俱全
        mountain_range(far, 0, 2600, 390, [(150, 230, 170), (620, 270, 200), (1100, 210, 180), (1600, 280, 220), (2150, 240, 190),
                                           (2550, 200, 160)], pig=INK * 0.35 + INDIGO * 0.65, wash=0.26, outline=0.0, cun=0.0,
                       fall=0.5, fog=0.8, dots=0, t0=-0.6, t1=1.6)
        mountain_range(mid, 0, 2600, 480, [(330, 200, 150), (850, 230, 160), (1250, 170, 140), (1950, 210, 170), (2400, 180, 150)],
                       pig=INK * 0.55 + INDIGO * 0.45, wash=0.32, outline=0.35, outline_w=2.2, cun=0.35, cun_ink=0.2, fog=0.7,
                       dots=0.2, t0=-0.3, t1=2.4)
        mountain_range(mt, 0, 900, 520, [(110, 300, 120), (400, 220, 120), (700, 160, 110)], wash=0.58, outline=1.0,
                       outline_w=3.4, cun=1.1, cun_ink=0.45, t0=-0.5, t1=2.2, trees=0.6, fog=0.55)
        mountain_range(mt, 1150, 2600, 560, [(1400, 200, 120), (1750, 230, 130), (2150, 190, 130), (2480, 210, 120)],
                       wash=0.5, outline=0.9, cun=0.9, t0=0.4, t1=3.2, trees=0.5, fog=0.55)
        mountain_range(mt, 560, 900, 960, [(700, 230, 90), (820, 150, 70)], wash=0.6, outline=1.0, cun=1.0, t0=3.0, t1=4.5,
                       trees=0.6)
        self._brush_river(wl, ln, self.MAIN, lambda s_: 110 + 45 * s_, -0.4, 2.0, 1)
        self._brush_river(wl, ln, self.OUTER, lambda s_: 150 - 25 * s_, 2.4, 6.0, 2)
        self._brush_river(wl, ln, self.INNER, lambda s_: 85 - 30 * s_, 2.6, 4.6, 3)
        self._fish_mouth(mt, wl, ln)
        # 离堆：鱼嘴下游一座孤立的小山
        mountain_range(mt, 1060, 1330, 1010, [(1170, 170, 70), (1250, 110, 50)], wash=0.6, outline=1.0, cun=1.0, dots=0.4,
                       t0=3.4, t1=4.6, trees=0.4)
        canals = self._geom()
        self._paddies(cv, pd, canals)
        # 渠：一道流动的墨线 + 淡花青，远细近粗
        for k, (c, t0, dep) in enumerate(canals):
            P = catmull(c, 3.0)
            yv = P[:, 1]
            wv = (3 + 18 * smoothstep(900, 1500, yv)) * (1.0, 0.7)[dep]
            n = len(P)
            tan = np.gradient(P, axis=0)
            tan /= np.linalg.norm(tan, axis=1, keepdims=True) + 1e-9
            nrm = np.c_[-tan[:, 1], tan[:, 0]]
            poly = np.vstack([P + nrm * wv[:, None] * 0.5, (P - nrm * wv[:, None] * 0.5)[::-1]])
            seg_len = float(np.sum(np.hypot(*np.diff(P, axis=0).T)))
            tdur = seg_len / self.CANAL_V
            bx0, by0 = np.floor(poly.min(0) - 20).astype(int)
            bx1, by1 = np.ceil(poly.max(0) + 20).astype(int)
            m = np.zeros((by1 - by0, bx1 - bx0), np.uint8)
            cv2.fillPoly(m, [((poly - [bx0, by0]) * 4).astype(np.int32)], 255, cv2.LINE_AA, shift=2)
            f = cv2.GaussianBlur(m.astype(np.float32) / 255, (0, 0), 2.5)
            from scipy.spatial import cKDTree
            yy, xx = np.mgrid[by0:by1, bx0:bx1]
            _, idx = cKDTree(P[::3]).query(np.c_[xx.ravel(), yy.ravel()])
            tf = (t0 + tdur * idx / max(1, len(P[::3]) - 1)).reshape(xx.shape).astype(np.float32)
            wl.wash(bx0, by0, f, INDIGO * 0.6 + INK * 0.25 + JADE * 0.15, dens=0.26, tfield=tf, lo=0.15, hi=0.8, edge=0.9,
                    edge_blur=3, gran=0.3, warp=0.12)
            i = 0
            side = 1 if k % 2 else -1
            while i < n - 4:
                j = min(n - 1, i + int(rng.integers(25, 70)))
                seg = P[i:j + 1:2] + nrm[i:j + 1:2] * (side * wv[i:j + 1:2, None] * 0.45)
                ww = float(np.mean(wv[i:j + 1])) * 0.12 + 0.8
                ln.stroke(seg, ww * rng.uniform(0.8, 1.4), ink=rng.uniform(0.45, 0.75), pig=INK * 0.8 + INDIGO * 0.2,
                          t0=t0 + tdur * i / n, dur=tdur * (j - i) / n + 0.1, dry=0.4, wet=0.5, taper=(0.2, 0.4))
                i = j + int(rng.integers(4, 20))
        # 川西林盘：竹丛、杂树、远处只余一团墨晕——大小疏密各不相同，远小近大
        clusters = [(380, 760, 'wash'), (250, 1180, 'bamboo'), (640, 1330, 'trees'), (1500, 1120, 'mixed'), (1900, 1000, 'wash'),
                    (2250, 1240, 'bamboo'), (2420, 1080, 'trees'), (1180, 1420, 'mixed'), (1720, 1380, 'bamboo'),
                    (2100, 900, 'wash'), (60, 960, 'trees'), (1400, 1260, 'trees'), (880, 1430, 'bamboo')]
        for k, (cx, cy, kind) in enumerate(clusters):
            sc = (0.45 + 0.75 * smoothstep(600, 1500, cy)) * rng.uniform(0.75, 1.3)
            tt = 6.0 + 0.22 * k
            spread = rng.uniform(35, 80) * sc
            n_items = int(rng.integers(3, 10) * (0.6 + sc * 0.5))
            if kind in ('trees', 'mixed'):
                for j in range(n_items):
                    foliage_tree(ln, cx + rng.normal(0, spread), cy + rng.normal(0, 12 * sc), rng.uniform(34, 72) * sc,
                                 tt + 0.05 * j, ink=rng.uniform(0.45, 0.85) * (0.6 + 0.4 * sc),
                                 kind='round' if rng.random() < 0.6 else 'pine')
            if kind in ('bamboo', 'mixed'):
                for j in range(n_items + 2):
                    bamboo(ln, cx + rng.normal(0, spread * 0.7), cy + rng.normal(0, 8 * sc), rng.uniform(60, 110) * sc,
                           tt + 0.04 * j, ink=rng.uniform(0.4, 0.7), lean=rng.normal(0, 0.15), leaves=0.6, dur=0.6,
                           pig=INK * 0.8 + JADE * 0.2, leaf_scale=0.5 + 0.4 * sc)
            if kind != 'wash' or rng.random() < 0.5:
                for j in range(int(rng.integers(0, 3))):
                    hut(ln, cx + rng.normal(0, 35 * sc), cy + 10 * sc, 46 * sc, tt + 0.3 + 0.2 * j, ink=0.45 + 0.35 * sc,
                        wash_l=wl, roof_pig=OCHRE * 0.4 + INK * 0.3)
            fm = np.clip(fbm(int(170 * sc) + 2, int(340 * sc) + 2, 22 * sc + 4, 3, rng) * 0.5 + 0.5, 0, 1)
            hh_, ww_ = fm.shape
            yy_ = np.linspace(-1, 1, hh_)[:, None]
            xx_ = np.linspace(-1, 1, ww_)[None, :]
            fm = fm * np.exp(-(xx_ ** 2 + yy_ ** 2) * (1.6 if kind == 'wash' else 2.4))
            wl.wash(cx - ww_ / 2, cy - hh_ * 0.65, fm.astype(np.float32), INK * 0.55 + JADE * 0.3 + INDIGO * 0.15,
                    dens=(0.3 if kind == 'wash' else 0.2) + 0.2 * sc, t0=tt, seeds=[(cx, cy)], speed=200, lo=0.18, hi=0.6,
                    edge=0.6, gran=0.5)

    def _brush_river(self, wl, ln, pts, width, t0, t1, k):
        """江：淡花青染(边缘化入纸、近岸深) + 顺流的长短水纹线(粗细浓淡不一)，岸线只偶见数笔。"""
        rng = np.random.default_rng(800 + k)
        P = catmull(pts, 4.0)
        M = len(P)
        tan = np.gradient(P, axis=0)
        tan /= np.linalg.norm(tan, axis=1, keepdims=True) + 1e-9
        nrm = np.c_[-tan[:, 1], tan[:, 0]]
        u = np.linspace(0, 1, M)
        wv = np.array([width(q) for q in u]) * (1 + 0.1 * fbm1d(M, 40, 3, rng))
        s_ = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
        x0, y0 = np.floor(P.min(0) - wv.max()).astype(int) - 20
        x1, y1 = np.ceil(P.max(0) + wv.max()).astype(int) + 20
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, self.W), min(y1, self.H)
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        from scipy.spatial import cKDTree
        d, idx = cKDTree(P).query(np.c_[xx.ravel(), yy.ravel()])
        d = d.reshape(xx.shape).astype(np.float32)
        idx = idx.reshape(xx.shape)
        sgn = np.sign(np.einsum('ijk,ijk->ij', np.dstack([xx - P[idx, 0], yy - P[idx, 1]]), nrm[idx]))
        half = (wv[idx] * 0.5).astype(np.float32)
        q = d * sgn / half                                               # -1..1 跨江
        n1 = fbm(y1 - y0, x1 - x0, 60, 3, rng)
        body = smoothstep(1.15, 0.7, np.abs(q) + 0.12 * n1)
        depth = 0.45 + 0.55 * smoothstep(-0.2, 0.9, q * (1 if k % 2 else -1)) + 0.15 * n1 * 0.5
        tf = (t0 + (t1 - t0) * 0.7 * idx / max(1, M - 1)).astype(np.float32)
        wl.wash(x0, y0, (body * depth).astype(np.float32), INDIGO * 0.6 + INK * 0.3 + JADE * 0.1, dens=0.24, tfield=tf, lo=0.05,
                hi=0.9, edge=0.25, edge_blur=10, gran=0.35, warp=0.25)
        # 顺流水纹
        L_ = s_[-1]
        nlines = int(L_ * float(np.mean(wv)) / 2600)
        for j in range(nlines):
            off = rng.uniform(-0.42, 0.42)
            sa = rng.uniform(-100, L_)
            ln_ = rng.uniform(120, 420)
            ia, ib = np.searchsorted(s_, [max(sa, 0), min(sa + ln_, L_)])
            if ib - ia < 6:
                continue
            ii = np.arange(ia, ib, 3)
            ph = rng.uniform(0, 6.3)
            wav = 4 * np.sin(s_[ii] / rng.uniform(60, 110) + ph)
            seg = P[ii] + nrm[ii] * (off * wv[ii] * 0.5 + wav)[:, None]
            cen = 1 - abs(off) / 0.42
            ln.stroke(seg, rng.uniform(0.9, 2.6) * (0.6 + 0.6 * cen), ink=rng.uniform(0.18, 0.5) * (0.7 + 0.5 * cen),
                      pig=INDIGO * 0.55 + INK * 0.45, t0=t0 + (t1 - t0) * 0.7 * ia / M, dur=0.6, dry=0.45, wet=0.3,
                      taper=(0.25, 0.45), rough=0.25)
        # 岸：只偶见几段干笔
        for side in (-1, 1):
            i = int(rng.integers(0, 20))
            while i < M - 10:
                j = min(M - 1, i + int(rng.integers(15, 45)))
                if rng.random() < 0.4:
                    seg = P[i:j:2] + nrm[i:j:2] * (side * wv[i:j:2, None] * 0.52)
                    ln.stroke(seg, rng.uniform(1.0, 2.2), ink=rng.uniform(0.3, 0.6), pig=INK * 0.8 + UMBER * 0.2,
                              t0=t0 + (t1 - t0) * 0.7 * i / M, dur=0.4, dry=0.6, wet=0.3, taper=(0.2, 0.5), rough=0.35)
                i = j + int(rng.integers(10, 50))

    def _fish_mouth(self, mt, wl, ln):
        """鱼嘴：尖嘴迎着上游，两道流畅的长笔向下游张开，劈江为内外二江；堤身卵石竹笼淡赭染。"""
        rng = np.random.default_rng(909)
        tip = (987, 598)
        right = [tip, (1002, 616), (1024, 660), (1046, 730), (1060, 810), (1066, 880), (1060, 930)]
        left = [tip, (985, 640), (983, 720), (982, 810), (988, 900), (1000, 940)]
        poly = np.array(right + left[::-1][:-1], np.float32)
        x0, y0 = np.floor(poly.min(0) - 20).astype(int)
        x1, y1 = np.ceil(poly.max(0) + 20).astype(int)
        m = np.zeros((y1 - y0, x1 - x0), np.uint8)
        cv2.fillPoly(m, [((poly - [x0, y0]) * 4).astype(np.int32)], 255, cv2.LINE_AA, shift=2)
        f = cv2.GaussianBlur(m.astype(np.float32) / 255, (0, 0), 4)
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        dt = np.hypot(xx - tip[0], yy - tip[1])
        f = f * (0.95 - 0.55 * smoothstep(120, 340, dt)) * (0.7 + 0.4 * vnoise(y1 - y0, x1 - x0, 10, rng))
        wl.wash(x0, y0, f.astype(np.float32), OCHRE * 0.4 + INK * 0.4 + UMBER * 0.2, dens=0.45, t0=2.0, seeds=[tip], speed=170,
                lo=0.08, hi=0.8, edge=0.6, gran=0.8, warp=0.25)
        dry_line(ln, right, 3.6, 2.0, 0.7, ink=1.15, pieces=1, dry=0.45, rough=0.25, taper=(0.02, 0.6))
        dry_line(ln, left, 3.2, 2.05, 0.7, ink=1.05, pieces=1, dry=0.5, rough=0.25, taper=(0.02, 0.6))
        # 竹笼卵石：堤身上一层层弧形短皴与石点
        for k in range(26):
            qq = rng.uniform(0.05, 0.9)
            ia = qq * (len(left) - 1)
            lx_ = np.interp(ia, range(len(left)), [p_[0] for p_ in left])
            ly_ = np.interp(ia, range(len(left)), [p_[1] for p_ in left])
            rx_ = np.interp(qq * (len(right) - 1), range(len(right)), [p_[0] for p_ in right])
            ry_ = np.interp(qq * (len(right) - 1), range(len(right)), [p_[1] for p_ in right])
            t_ = rng.uniform(0.1, 0.6)
            px, py = lx_ + (rx_ - lx_) * t_, ly_ + (ry_ - ly_) * t_
            ln.stroke([(px - 9, py - 3), (px, py + 2), (px + 10, py - 1)], rng.uniform(1.2, 2.2), ink=rng.uniform(0.3, 0.6),
                      t0=2.5 + 0.03 * k, dur=0.12, dry=0.7, taper=(0.1, 0.6))
            if rng.random() < 0.5:
                ln.dot(px + rng.normal(0, 6), py + rng.normal(0, 5), rng.uniform(1.5, 2.6), ink=0.7, t0=2.7 + 0.03 * k, elong=1.2)
        # 江水撞上鱼嘴，分成两股：几道弯曲的水纹自嘴尖向两侧分开
        for k in range(7):
            side = -1 if k % 2 else 1
            o = rng.uniform(8, 40)
            sx, sy = tip[0] - 90 + rng.normal(0, 10), tip[1] - 60 + rng.normal(0, 8)
            if side > 0:
                pts = [(sx, sy - o * 0.3), (tip[0] - 20, tip[1] - 22 - o * 0.4), (tip[0] + 40, tip[1] - 10 - o * 0.6),
                       (tip[0] + 140 + o, tip[1] + 30 + o * 0.4)]
            else:
                pts = [(sx - o * 0.3, sy), (tip[0] - 30 - o * 0.5, tip[1] - 12), (tip[0] - 26 - o * 0.4, tip[1] + 50),
                       (tip[0] - 40 - o * 0.3, tip[1] + 140)]
            ln.stroke(pts, rng.uniform(1.2, 2.4), ink=rng.uniform(0.35, 0.6), pig=INDIGO * 0.55 + INK * 0.45,
                      t0=2.3 + 0.08 * k, dur=0.6, dry=0.4, wet=0.3, taper=(0.2, 0.5))

    def _paddies(self, cv, pd, canals):
        """顺等高线的弧形梯田：远处(上)小而淡、扁，近处大而润；田埂留白，少量干笔埂线。"""
        rng = np.random.default_rng(5050)
        X0, X1, Y0, Y1 = 0, 2600, 560, 1500
        h, w = Y1 - Y0, X1 - X0
        yy, xx = np.mgrid[Y0:Y1, X0:X1].astype(np.float32)
        ytop = self._ytop(np.arange(X0, X1, dtype=np.float32))[None, :].astype(np.float32)
        z0 = np.clip((yy - 560) / 940, 0, 1)
        # 等高线起伏(随远近放大)
        bend = fbm(h, w, 420, 3, rng, cell_y=260) * (14 + 70 * z0) + fbm(h, w, 130, 2, rng) * (4 + 18 * z0) \
            + fbm(h, w, 45, 2, rng) * (1 + 6 * z0)
        yw = yy + bend
        z = np.clip((yw - 560) / 940, 0, 1)
        NR = 24
        r = NR * z ** 0.62 + 0.45 * fbm(h, w, 260, 2, rng, cell_y=120)
        row = np.floor(r).astype(np.int32)
        fr = r - row
        rowh = 940 / NR / 0.62 * np.maximum(z, 0.02) ** 0.38          # 行高(像素)
        pw = 70 + 300 * z ** 1.2                                        # 田块宽
        rof = rng.uniform(0, 1, NR + 2).astype(np.float32)
        slant = rng.normal(0, 0.6, NR + 2).astype(np.float32)
        c = (xx + slant[row] * (fr - 0.5) * rowh * 1.5 + fbm(h, w, 60, 2, rng) * 10) / pw + rof[row] * 3
        col = np.floor(c).astype(np.int32)
        fc = c - col
        NC = int(col.max()) + 2
        # 随机合并相邻田块：无切口则沿用前一块的编号
        cut = rng.random((NR + 2, NC + 2)) < 0.62
        gid = np.zeros((NR + 2, NC + 2), np.int32)
        g = 0
        for i in range(NR + 2):
            for j in range(NC + 2):
                if j == 0 or cut[i, j]:
                    g += 1
                gid[i, j] = g
        cid = gid[np.clip(row, 0, NR + 1), np.clip(col, 0, NC + 1)]
        ng = g + 1
        # 田埂(留白)：行间必有，块间仅在有切口处
        bund_r = np.minimum(fr, 1 - fr) * rowh
        has_cut = cut[np.clip(row, 0, NR + 1), np.clip(col, 0, NC + 1)]
        bund_c = np.where(has_cut, fc, 1.0) * pw
        bund_c = np.minimum(bund_c, np.where(cut[np.clip(row, 0, NR + 1), np.clip(col + 1, 0, NC + 1)], 1 - fc, 1.0) * pw)
        bw = 1.0 + 3.0 * z
        inside = smoothstep(bw * 0.4, bw * 1.8, np.minimum(bund_r, bund_c) * (0.7 + 0.6 * vnoise(h, w, 50, rng)))
        inside = 0.22 + 0.78 * inside
        # 田块边缘被水洇得不齐：逐块随机侵蚀
        inside *= smoothstep(0.05, 0.35, vnoise(h, w, 22, rng) * 0.5 + 0.5 * smoothstep(0, bw * 6, np.minimum(bund_r, bund_c)))
        # 区域：上沿以下，避开河道、鱼嘴、岩石
        region = smoothstep(ytop, ytop + 50, yy) * smoothstep(Y1 + 10, Y1 - 60, yy)
        ex = np.zeros((h, w), np.uint8)
        for pts, wd in ((self.OUTER, 190), (self.INNER, 130), (self.MAIN, 190)):
            q = catmull(pts, 4.0) - [X0, Y0]
            cv2.polylines(ex, [(q * 4).astype(np.int32).reshape(-1, 1, 2)], False, 255, wd, cv2.LINE_AA, shift=2)
        cv2.ellipse(ex, (1130 - X0, 920 - Y0), (190, 110), 0, 0, 360, 255, -1)
        cv2.ellipse(ex, (730 - X0, 880 - Y0), (190, 110), 0, 0, 360, 255, -1)
        region *= 1 - cv2.GaussianBlur(ex.astype(np.float32) / 255, (0, 0), 25)
        # 空出一些地块(林盘、未耕地)
        holes = smoothstep(0.75, 1.25, fbm(h, w, 160, 2, rng))
        region *= 1 - 0.85 * holes
        # 雾：横向成带、远处更浓，田畴在雾中时隐时现
        mist_f = smoothstep(0.55, 1.35, fbm(h, w, 380, 3, rng, cell_y=70)) * (1.0 - 0.6 * z0)
        region *= 1 - 0.85 * mist_f
        # 每块：颜色类别、浓淡、湿度
        pigs = [JADE * 0.65 + GOLD * 0.25 + INK * 0.1,
                MALACHITE * 0.45 + INDIGO * 0.2 + GOLD * 0.2 + INK * 0.15,
                GOLD * 0.45 + JADE * 0.45 + INK * 0.1,
                OCHRE * 0.6 + GOLD * 0.25 + INK * 0.15,
                INDIGO * 0.45 + JADE * 0.3 + INK * 0.25]
        cls = rng.choice(5, ng, p=[0.32, 0.22, 0.2, 0.12, 0.14])
        dens_g = rng.uniform(0.55, 1.0, ng).astype(np.float32)
        ox, oy = self.ORIGIN
        gx = np.zeros(ng)
        gy = np.zeros(ng)
        cnt = np.bincount(cid.ravel(), minlength=ng) + 1e-6
        gx = np.bincount(cid.ravel(), weights=xx.ravel(), minlength=ng) / cnt
        gy = np.bincount(cid.ravel(), weights=yy.ravel(), minlength=ng) / cnt
        ct = (5.0 + np.hypot((gx - ox) / 1.4, (gy - oy) / 0.55) / 330 + rng.uniform(0, 0.5, ng)).astype(np.float32)
        tf = ct[cid]
        # 大气透视：远处淡、偏冷灰；近处润
        aer = (0.18 + 0.82 * z ** 1.3) * (1 - 0.25 * smoothstep(1800, 2600, xx) * (1 - z))
        wetv = 0.75 + 0.35 * fbm(h, w, 90, 3, rng) * 0.5
        base = (region * inside * aer * wetv).astype(np.float32)
        for k, pig in enumerate(pigs):
            fld = base * (cls[cid] == k) * dens_g[cid]
            pd.wash(X0, Y0, fld.astype(np.float32), pig, dens=0.42, tfield=tf, lo=0.06, hi=0.75, edge=0.9, gran=0.5,
                    warp=0.06, edge_blur=3 + 0 * k)
        # 远处罩一层冷灰淡墨，溶入雾中
        far = (region * (1 - smoothstep(0.0, 0.45, z)) * (0.6 + 0.4 * vnoise(h, w, 200, rng))).astype(np.float32)
        pd.wash(X0, Y0, far, INK * 0.5 + INDIGO * 0.5, dens=0.08, tfield=tf, lo=0.05, hi=0.9, edge=0.0, gran=0.3)
        # 少量干笔田埂线(只在近处、断续)
        L = pd
        for i in range(4, NR):
            if rng.random() < 0.45:
                continue
            zr = (i / NR) ** (1 / 0.62)
            yb = 560 + zr * 940
            xs = rng.uniform(0, 2400)
            ln_ = rng.uniform(200, 600) * (0.5 + zr)
            pts = []
            for xq in np.linspace(xs, xs + ln_, 8):
                xi = int(np.clip(xq, 0, w - 1))
                col_y = np.argmin(np.abs(r[:, xi] - i)) + Y0
                pts.append((xq, col_y))
            ys = [p[1] for p in pts]
            if max(ys) - min(ys) > 90 or min(ys) < float(self._ytop(np.array([xs]))[0]) + 40:
                continue
            L.stroke(pts, 0.8 + 1.6 * zr, ink=0.18 + 0.25 * zr, pig=INK * 0.7 + UMBER * 0.3, t0=6.0 + zr * 2, dur=0.8,
                     dry=0.75, wet=0.3, taper=(0.2, 0.4), rough=0.35)

    def dynamic(self, ctx):
        if getattr(self, '_dense', None) is None:
            def mk(p):
                P = catmull(p, 3.0)
                s_ = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
                tan = np.gradient(P, axis=0)
                tan /= np.linalg.norm(tan, axis=1, keepdims=True) + 1e-9
                return P, s_, np.c_[-tan[:, 1], tan[:, 0]]
            self._dense = [('main', mk(self.MAIN), 0.3, 5, 110), ('outer', mk(self.OUTER), 2.6, 6, 130),
                           ('inner', mk(self.INNER), 2.8, 3, 70)]
            for c, ts, dep in self._geom():
                self._dense.append(('canal', mk(c), ts, 1, 0))
        t = ctx.t
        buf = ctx.canvas()
        for ci, (key, (P, s_, nrm), tstart, nlines, wid) in enumerate(self._dense):
            L = s_[-1]
            if key == 'canal':
                reach = min(L, (t - tstart) * self.CANAL_V)
            else:
                reach = np.clip((t - tstart) / 2.5, 0, 1) * L
            if reach <= 5:
                continue
            period = 64.0 if key != 'canal' else 48.0
            for li in range(nlines):
                off = (li / max(1, nlines - 1) - 0.5) * wid * 0.6 if nlines > 1 else 0.0
                ph = (t * (95 if key != 'canal' else 60) + li * 23 + ci * 17) % period
                for k in range(int(L / period) + 1):
                    sa = k * period + ph - period
                    sb = sa + (24 if key != 'canal' else 16) + 6 * math.sin(li + k)
                    sa = max(sa, 0)
                    if sb > reach:
                        break
                    ia, ib = np.searchsorted(s_, [sa, sb])
                    if ib - ia < 2:
                        continue
                    wig = np.sin(np.linspace(0, np.pi, ib - ia))[:, None] * 2.0
                    seg = P[ia:ib] + nrm[ia:ib] * (off + wig)
                    q = ctx.pts(seg)
                    cv2.polylines(buf, [(q * 4).astype(np.int32).reshape(-1, 1, 2)], False, 210, max(1, int(1.3 * ctx.z)),
                                  cv2.LINE_AA, shift=2)
        ctx.add(buf, INDIGO * 0.6 + INK * 0.4, 0.4, blur=0.8)


# =========================================================================== 6 蜀锦
class S06(SceneBase):
    W, H = 3600, 2000
    seal = '蜀锦'
    seal_t = 2.2
    keys = [(0, 1500, 820, 1.55), (3.0, 1620, 900, 1.05), (8.3, 1950, 1000, 0.66)]
    mist = [dict(y=1560, h=60, a=0.35, speed=15), dict(y=430, h=70, a=0.4, speed=10, oy=350)]
    # 各布层的摆动：(悬挂高度, 幅度, 角频率, 相位)
    SWAY = {'cloth_a': (700.0, 0.016, 1.25, 0.0), 'cloth_b': (700.0, 0.021, 1.05, 1.9),
            'cloth_c': (805.0, 0.018, 1.4, 3.6)}
    # 晾锦竿：(x0, y0, x1, y1, 下垂, 抖动相位)
    RACKS = [(300, 690, 1890, 708, 22, 0.7), (1900, 800, 3480, 812, 18, 2.9)]

    def layer_affine(self, i, name, t):
        if name not in self.SWAY:
            return None
        y0, amp, w, ph = self.SWAY[name]
        a = amp * (math.sin(t * w + ph) + 0.35 * math.sin(t * w * 2.3 + ph * 1.7))
        return np.array([[1, a, -a * y0], [0, 1, 0]], np.float64)

    def _pole_y(self, r, x):
        x0, y0, x1, y1, sag, ph = self.RACKS[r]
        q = (x - x0) / (x1 - x0)
        return y0 + (y1 - y0) * q + sag * 4 * q * (1 - q) + 5 * math.sin(x / 230 + ph) + 2 * math.sin(x / 71 + 2 * ph)

    def build(self, cv):
        bg = cv.layer('bg', 0.7, fade=0.7)
        mid = cv.layer('mid', 1.0, fade=0.6)
        ca = cv.layer('cloth_a', 1.0, fade=0.45, halo=0.7)
        cb = cv.layer('cloth_b', 1.0, fade=0.45, halo=0.7)
        cc = cv.layer('cloth_c', 1.0, fade=0.45, halo=0.7)
        ln = cv.layer('lines', 1.0, fade=0.3)
        fg = cv.layer('fg', 1.12, fade=0.4)
        rng = np.random.default_rng(606)
        # ---- 远景：淡山、雾
        mountain_range(bg, 0, cv.w, 540, [(500, 220, 280), (1500, 260, 320), (2600, 230, 300), (3350, 180, 220)],
                       pig=INK * 0.4 + INDIGO * 0.6, wash=0.22, outline=0.18, cun=0.15, cun_ink=0.12, dots=0, t0=-0.4,
                       t1=2.0, fog=0.7)
        band_wash(bg, 560, 90, INK * 0.5 + INDIGO * 0.5, 0.06, -0.3, speed=1200, cell=300)
        band_wash(bg, 1480, 140, OCHRE * 0.6 + JADE * 0.2 + INK * 0.2, 0.08, 0.3, speed=1200, cell=260)
        # ---- 中景：远处一排晾锦(小、淡) + 柳，之后罩雾
        C_RED = CRIMSON * 0.42 + OCHRE * 0.3 + INK * 0.1
        C_IND = INDIGO * 0.5 + INK * 0.12 + OCHRE * 0.06
        C_GOLD = OCHRE * 0.45 + GOLD * 0.28 + INK * 0.05
        C_JADE = JADE * 0.42 + INDIGO * 0.1 + OCHRE * 0.12 + INK * 0.06
        C_ROSE = PINK * 1.1 + OCHRE * 0.18 + INK * 0.05
        C_VERM = VERMILION * 0.35 + OCHRE * 0.3 + INK * 0.06
        pals = [(C_RED, C_GOLD, C_IND), (C_IND, C_RED * 0.9, C_GOLD), (C_GOLD, C_IND, C_RED), (C_JADE, C_GOLD, C_RED),
                (C_ROSE, C_IND * 0.8, C_GOLD), (C_VERM, C_IND, C_JADE)]
        dry_line(mid, [(150, 600), (900, 606), (1800, 610), (2700, 603), (3450, 596)], 2.6, -0.4, 1.4, ink=0.4, pieces=3,
                 dry=0.5, rough=0.3)
        for px in (180, 1000, 1850, 2700, 3420):
            mid.stroke([(px, 593), (px + rng.normal(0, 5), 760), (px + rng.normal(0, 6), 900)], 2.4, ink=0.35, t0=-0.3,
                       dur=0.8, dry=0.5)
        x = 230.0
        k = 0
        while x < 3350:
            bw = rng.uniform(55, 115)
            self._bolt(mid, x, 603 + rng.uniform(-3, 5), bw, rng.uniform(140, 280), rng.choice(self.DESIGNS), pals[k % 6],
                       -0.2 + 0.06 * k, k + 20, dens_mul=rng.uniform(0.22, 0.4), far=True,
                       mode='gather' if rng.random() < 0.25 else 'hang')
            x += bw + rng.uniform(-10, 90)
            k += 1
        for k, (wx, wh, lean) in enumerate([(420, 360, 0.1), (1180, 420, -0.15), (2050, 330, 0.2), (2560, 460, -0.1),
                                            (3200, 380, 0.15), (820, 260, 0.0), (2900, 280, -0.2)]):
            willow(mid, wx, 1000 + rng.uniform(-20, 20), wh * 0.85, 0.2 + 0.12 * k, ink=0.42, lean=lean)
        # 远近之间的雾：成带、飘忽，远竿远柳时隐时现
        yy_, xx_ = np.mgrid[0:cv.h, 0:cv.w].astype(np.float32)
        mf = smoothstep(-0.2, 0.9, fbm(cv.h, cv.w, 420, 3, rng, cell_y=60)) * np.exp(-((yy_ - 820) / 260) ** 2)
        mid.A *= (1 - 0.85 * mf)[..., None]
        bg.A *= (1 - 0.6 * mf)[..., None]
        del yy_, xx_, mf
        # ---- 近景两架竹竿：弯曲、略抖，节处一顿；立柱歪斜
        for r, (x0, y0, x1, y1, sag, ph) in enumerate(self.RACKS):
            xs = np.linspace(x0 - 50, x1 + 50, 16)
            dry_line(mid, [(xq, self._pole_y(r, xq)) for xq in xs], 7.5, -0.6 + 0.2 * r, 1.0, ink=0.95,
                     pig=INK * 0.75 + UMBER * 0.25, pieces=3, dry=0.4, rough=0.3, wob=0.15)
            for xq in np.linspace(x0 + 80, x1 - 80, 7):
                yq = self._pole_y(r, xq)
                mid.stroke([(xq, yq - 6), (xq + 1, yq + 6)], 2.2, ink=0.8, t0=-0.2 + 0.2 * r, dur=0.1)
            for j, px in enumerate((x0 + 10, (x0 + x1) / 2 + rng.uniform(-60, 60), x1 - 10)):
                top = self._pole_y(r, px)
                lean_ = rng.normal(0, 14)
                dry_line(mid, [(px, top - 26), (px + lean_ * 0.3 + rng.normal(0, 3), top + 380),
                               (px + lean_ * 0.7, top + 640), (px + lean_, 1480)], 5.5, -0.5 + 0.1 * j, 0.9, ink=0.6,
                         pig=INK * 0.8 + UMBER * 0.2, pieces=2, dry=0.5, rough=0.3)
                mid.stroke([(px - 18, top - 6), (px + 2, top + 2), (px + 18, top + 4)], 3, ink=0.7, t0=0.0, dur=0.2)
        # ---- 近景晾锦：(x, 宽, 长, 纹样, 配色, 方式)  方式: hang 直垂 / fold 搭竿对折 / gather 收束成团 / slant 风吹
        layout = [(0, 360, 290, 760, 'cloud', 0, 'hang'), (0, 680, 210, 600, 'stripe', 1, 'fold'),
                  (0, 950, 150, 520, 'scatter', 4, 'gather'), (0, 1120, 300, 700, 'wave', 3, 'slant'),
                  (0, 1450, 230, 640, 'lozenge', 2, 'fold'), (0, 1700, 160, 560, 'band', 5, 'gather'),
                  (1, 1960, 260, 600, 'lozenge', 1, 'hang'), (1, 2260, 300, 560, 'cloud', 2, 'fold'),
                  (1, 2620, 180, 520, 'stripe', 0, 'gather'), (1, 2840, 280, 590, 'wave', 4, 'slant'),
                  (1, 3170, 220, 520, 'scatter', 3, 'fold')]
        for k, (r, bx, bw, bl, des, pi, mode) in enumerate(layout):
            L = cc if r == 1 else (ca if k % 2 == 0 else cb)
            top = self._pole_y(r, bx + bw / 2)
            # 开场镜头(1.55 倍)对准 x≈880–2120：这里的锦提前落笔，避免空竿
            t0 = (-0.75 if 850 < bx + bw / 2 < 2150 else 0.1) + 0.12 * abs(k - 4) + rng.uniform(0, 0.25)
            if mode == 'fold':
                front = bl * rng.uniform(0.48, 0.62)
                off = bw * rng.uniform(0.14, 0.22) * rng.choice([-1, 1])
                self._bolt(L, bx + off, top, bw * 0.96, bl, des, pals[pi], t0 + 0.15, k + 100, shade=0.3, v_off=bl * 0.7,
                           dens_mul=0.9)
                self._bolt(L, bx, top, bw, front, des, pals[pi], t0, k, swag=1.6)
            elif mode == 'gather':
                self._bolt(L, bx, top, bw, bl, des, pals[pi], t0, k, mode='gather')
            else:
                self._bolt(L, bx, top, bw, bl, des, pals[pi], t0, k,
                           slant=rng.uniform(0.35, 0.55) * rng.choice([-1, 1]) if mode == 'slant' else 0.0)
        # 不透明：前排遮后排(竿2 的锦在前，cloth_b 在 cloth_a 之前)，近处的锦遮住竹竿、远锦与柳
        def cover(Ls):
            c = sum(Lc.A.mean(axis=2) for Lc in Ls)
            c = cv2.dilate(np.clip(c * 6, 0, 1), np.ones((5, 5), np.uint8))
            return cv2.GaussianBlur(c, (0, 0), 3)
        c_c = cover([cc])
        for Lb in (ca, cb):
            Lb.A *= (1 - 0.92 * c_c)[..., None]
        cb_c = cover([cb])
        ca.A *= (1 - 0.92 * cb_c)[..., None]
        c_all = np.maximum(np.maximum(c_c, cb_c), cover([ca]))
        for Lb in (mid, bg):
            Lb.A *= (1 - 0.92 * c_all)[..., None]
        del c_c, cb_c, c_all
        # ---- 河中漂洗的锦带
        river(bg, ln, [(0, 1650), (900, 1610), (1800, 1668), (2700, 1628), (3600, 1655)], 230, t0=2.0, t1=6.0, dens=0.14)
        for j, (rx, ry, rl, pal) in enumerate([(700, 1612, 1100, pals[0]), (1700, 1660, 900, pals[1]), (2500, 1630, 760, pals[3])]):
            self._ribbon(ln, rx, ry, rl, 52 + 10 * (j % 2), pal, 3.4 + 0.4 * j, j)
        for k, (fx, fy, fh, load) in enumerate([(560, 1500, 74, None), (1080, 1528, 82, 'basket'), (1410, 1490, 66, None),
                                                (2140, 1520, 78, 'basket'), (2480, 1540, 84, None), (3060, 1498, 70, None)]):
            figure(ln, fx + rng.uniform(-20, 20), fy, fh, 3.0 + 0.25 * k, ink=0.8, load=load, facing=1 if k % 2 else -1)
        reeds(ln, 200, 3400, 1560, 70, 3.0, 5.5, h=36, ink=0.38)
        # ---- 前景：左上垂柳、右侧柳枝，拉开纵深
        self._fg_willow(fg, 980, 260, 1.0, 0.6)
        self._fg_willow(fg, 3300, 380, 1.3, -0.5)

    DESIGNS = ['lozenge', 'cloud', 'stripe', 'wave', 'scatter', 'band']

    def _pattern(self, design, w, h, rng, k, sc=1.0):
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        v = yy
        p1 = np.ones((h, w), np.float32)
        p2 = np.zeros((h, w), np.float32)
        p3 = np.zeros((h, w), np.float32)
        if design == 'lozenge':
            c = 52.0 * sc
            a = np.abs(((xx + 0.5 * c) % c) - c / 2) + np.abs(((v + 0.5 * c) % c) - c / 2)
            p2 = smoothstep(17 * sc, 14 * sc, a) * smoothstep(5 * sc, 8 * sc, a)
            p3 = smoothstep(4 * sc, 2 * sc, a)
            per = 230 * sc
            p1 = 1 - 0.25 * (np.floor(v / per) % 2)
            p3 = np.maximum(p3, smoothstep(10 * sc, 4 * sc, np.abs((v % per) - per / 2)) * (np.sin(xx * 0.4 / sc) > 0))
        elif design == 'cloud':
            c = 96.0 * sc
            gx = (xx % c) - c / 2
            gy = ((v + (np.floor(xx / c) % 2) * c / 2) % c) - c / 2
            r = np.hypot(gx, gy)
            th = np.arctan2(gy, gx)
            petal = (np.abs(np.cos(th * 2)) * 18 + 8) * sc
            p2 = smoothstep(petal + 2, petal - 2, r) * smoothstep(4 * sc, 7 * sc, r)
            p3 = smoothstep(4, 1.5, np.abs(r - 33 * sc)) + smoothstep(4 * sc, 2 * sc, r)
        elif design == 'stripe':
            sw = (12 + 6 * (k % 3)) * sc
            bands = np.sin(xx / w * np.pi * 2 * 4) * 0.5 + 0.5
            p1 = 0.6 + 0.4 * bands
            p2 = smoothstep(0.75, 0.9, np.sin(xx * 2 * np.pi / sw) * 0.5 + 0.5)
            p3 = smoothstep(0.85, 0.95, np.sin(xx * 0.9 / sc) * 0.5 + 0.5) * (np.sin(v / (60 * sc)) > 0.3)
        elif design == 'wave':
            # 水波纹：错位的半圆弧
            c = 70.0 * sc
            gy = (v % (c * 0.5))
            gx = (xx + (np.floor(v / (c * 0.5)) % 2) * c / 2) % c - c / 2
            r = np.hypot(gx, gy)
            p2 = sum(smoothstep(3.0 * sc, 1.2 * sc, np.abs(r - rr * sc)) for rr in (12, 22, 32)) * (gy < c * 0.5)
            p1 = 0.85 + 0.15 * np.sin(v / (300 * sc))
            p3 = smoothstep(5 * sc, 2 * sc, np.abs((v % (300 * sc)) - 150 * sc))
        elif design == 'scatter':
            # 散花：随机小团花
            p1 = np.ones((h, w), np.float32) * 0.8
            n = int(w * h / (4200 * sc * sc)) + 3
            m2 = np.zeros((h, w), np.float32)
            m3 = np.zeros((h, w), np.float32)
            for _ in range(n):
                cx_, cy_ = rng.uniform(0, w), rng.uniform(0, h)
                rr = rng.uniform(8, 13) * sc
                for a in range(5):
                    an = a * 2 * np.pi / 5 + cx_
                    cv2.circle(m2, (int(cx_ + math.cos(an) * rr * 0.8), int(cy_ + math.sin(an) * rr * 0.8)), int(rr * 0.55),
                               1.0, -1, cv2.LINE_AA)
                cv2.circle(m3, (int(cx_), int(cy_)), max(1, int(rr * 0.3)), 1.0, -1, cv2.LINE_AA)
            p2, p3 = m2, m3
        else:  # band：素地 + 上下宽饰带
            per = 260 * sc
            vv = v % per
            band = smoothstep(0, 4, vv - 20 * sc) * smoothstep(0, 4, 70 * sc - vv)
            p1 = 0.75 + 0.25 * band
            p2 = band * (np.sin(xx * 2 * np.pi / (24 * sc)) > 0.2)
            p3 = smoothstep(3, 1, np.abs(vv - 18 * sc)) + smoothstep(3, 1, np.abs(vv - 72 * sc))
        sel = smoothstep(0, 14 * sc, xx) * smoothstep(0, 14 * sc, w - 1 - xx)
        edge = smoothstep(0, 6, xx) * smoothstep(0, 6, w - 1 - xx)
        border = (1 - sel) * edge
        weave = 0.92 + 0.08 * ((np.sin(xx * 2.1) * np.sin(v * 2.1)) > 0)
        return (p1 * weave).astype(np.float32), (p2 * sel * weave).astype(np.float32), \
            (np.clip(p3 * sel + border * 0.8, 0, 1) * weave).astype(np.float32)

    def _bolt(self, L, x, top, bw, length, design, pal, t0, k, mode='hang', slant=0.0, dens_mul=1.0, far=False, shade=0.0,
              v_off=0.0, swag=1.0):
        """一匹锦：搭过竿顶垂下(顶端一道卷折)，竖褶明暗、下摆成弧、随风偏摆；手织纹样有抖动、
        每个循环略有不同；染色不匀、边缘略褪；以一道道竖向笔触自上而下“染”出。不透明：先压暗其下已有的墨色。"""
        rng = np.random.default_rng(9000 + k)
        w, h = int(bw), int(length)
        sc = float(np.clip(bw / 300, 0.35, 1.1))
        R = 12                                         # 竿上卷折的高度
        p1, p2, p3 = self._pattern(design, w, h + R + 40, rng, k, sc)
        pad = int(60 + 60 * abs(slant))
        Wc, Hc = w + 2 * pad, h + R + 60
        yy, xx = np.mgrid[0:Hc, 0:Wc].astype(np.float32)
        v = yy - R                                      # v=0 在竿上
        q = np.clip(v / h, 0, 1.2)
        ph = rng.uniform(0, 6.3)
        amp = rng.uniform(14, 30) * (0.4 if far else 1.0)
        sway = amp * q ** 1.6 * np.sin(ph + v / 210) + 0.3 * amp * q * np.sin(v / 63 + ph * 2) + slant * q ** 1.3 * h * 0.25
        if mode == 'gather':
            taper = 0.38 + 0.62 * smoothstep(-0.05, 0.6, q) - 0.06 * q
        else:
            taper = 1 - 0.06 * q + 0.035 * np.sin(v / 150 + ph) * q
        u = (xx - pad - sway - w * (1 - taper) / 2) / taper
        nf = rng.uniform(1.6, 3.0) * (2.0 if mode == 'gather' else 1.0)
        fph = rng.uniform(0, 6.3)
        fold = np.sin(u / w * np.pi * 2 * nf + fph + 0.6 * q)
        if mode == 'gather':
            fold = fold * (0.6 + 0.6 * (1 - q))
        # 手织的抖动：纹样坐标加低频扰动
        jx = fbm(Hc, Wc, 40 * sc + 8, 2, rng) * 2.5 * sc + (vnoise(Hc, Wc, 55 * sc + 6, rng) - 0.5) * 9 * sc
        jy = fbm(Hc, Wc, 40 * sc + 8, 2, rng) * 2.5 * sc + (vnoise(Hc, Wc, 55 * sc + 6, rng) - 0.5) * 9 * sc
        ud = u + 5 * fold * q + jx
        vd = v + v_off + 3 * np.sin(u / 37 + ph) * q + jy + R
        hem = h - (6 + 8 * np.sin(u / w * np.pi * 2 * rng.uniform(0.7, 1.4) + ph)) \
            - swag * 16 * (1 - (2 * u / w - 1) ** 2) * rng.choice([1.0, -0.6]) - slant * (u - w / 2) * 0.5
        topc = -R + 4 * (2 * u / w - 1) ** 2               # 卷折处的圆顶
        inside = smoothstep(-0.8, 1.2, u) * smoothstep(-0.8, 1.2, w - u) * smoothstep(-1.0, 2.0, hem - v) \
            * smoothstep(-1.0, 1.0, v - topc)
        ps = [cv2.remap(p, ud.astype(np.float32), vd.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
              for p in (p1, p2, p3)]
        var = 0.6 + 0.55 * vnoise(Hc, Wc, 70 * sc + 10, rng)        # 循环之间的差异
        ps[1] *= var
        ps[2] *= 0.75 + 0.4 * vnoise(Hc, Wc, 55 * sc + 10, rng)
        dye = 0.8 + 0.3 * fbm(Hc, Wc, 150, 3, rng) * 0.5
        selv = 0.8 + 0.2 * smoothstep(0, 0.22 * w, np.minimum(u, w - u))
        light = (0.8 + 0.26 * fold) * dye * selv
        roll = np.exp(-((v + R * 0.5) / 5) ** 2)                      # 卷折高光：少上色
        light = light * (1 - 0.45 * roll)
        # 笔触式显影：竖向条纹噪声 + 自上而下
        streak = vnoise(Hc, Wc, 7 * sc + 4, rng, 120)
        tf = (t0 + 0.1 + np.clip(v, 0, None) / max(h, 1) * (1.3 if far else 1.7) + 0.45 * streak
              + 0.15 * np.clip(u / w, 0, 1)).astype(np.float32)
        x0 = int(x - pad)
        y0 = int(top - R)
        # 不透明：压暗下面已有的墨(同层)
        if not far:
            cov = cv2.GaussianBlur(inside.astype(np.float32), (0, 0), 1.2)
            xa, ya = max(0, x0), max(0, y0)
            xb, yb = min(self.W, x0 + Wc), min(self.H, y0 + Hc)
            L.A[ya:yb, xa:xb] *= (1 - 0.93 * cov[ya - y0:yb - y0, xa - x0:xb - x0])[..., None]
        for p, pig, dd in zip(ps, pal, (0.42, 0.52, 0.5)):
            pp = cv2.GaussianBlur(p, (0, 0), 0.9 if not far else 1.6)
            L.wash(x0, y0, (pp * light * inside).astype(np.float32), pig, dens=dd * dens_mul, tfield=tf, lo=0.02, hi=0.75,
                   edge=0.45, gran=0.6, warp=0.05, edge_blur=3)
        # 褶暗 + 竿下阴影 + (后片)整体压暗
        under = np.exp(-np.clip(v - 2, 0, None) / 16) * smoothstep(-2, 3, v)
        dk = (np.clip(-fold, 0, 1) ** 1.5 * (0.9 if mode == 'gather' else 0.65) + 0.9 * under + shade * 3) * inside
        L.wash(x0, y0, dk.astype(np.float32), INK * 0.8 + UMBER * 0.2, dens=0.15 * (0.6 if far else 1.0), tfield=tf, lo=0.04,
               hi=0.9, edge=0.0, gran=0.3, warp=0.05)
        if far:
            return
        # 两侧干笔边线(断续)，与布同层，随风同摆
        vs = np.linspace(0, h - 14, 10)
        for side in (0, 1):
            pts = []
            for v_ in vs:
                qv = min(v_ / h, 1.2)
                sw_ = amp * qv ** 1.6 * math.sin(ph + v_ / 210) + 0.3 * amp * qv * math.sin(v_ / 63 + ph * 2) \
                    + slant * qv ** 1.3 * h * 0.25
                if mode == 'gather':
                    tp = 0.38 + 0.62 * float(smoothstep(-0.05, 0.6, qv)) - 0.06 * qv
                else:
                    tp = 1 - 0.06 * qv + 0.035 * math.sin(v_ / 150 + ph) * qv
                pts.append((x + sw_ + w * (1 - tp) / 2 + side * w * tp, top + v_))
            dry_line(L, pts, rng.uniform(1.3, 2.0), t0 + 0.25, 1.8, ink=rng.uniform(0.35, 0.55), pig=INK * 0.85 + UMBER * 0.15,
                     pieces=2, dry=0.6, rough=0.25, wob=0.2)
        # 褶线：几道淡墨顺褶而下
        for j in range(int(rng.integers(2, 5)) if mode == 'gather' else int(rng.integers(1, 3))):
            fu = rng.uniform(0.2, 0.8) * w
            ln_ = rng.uniform(0.3, 0.8) * h
            pts = []
            for v_ in np.linspace(6, ln_, 6):
                qv = v_ / h
                sw_ = amp * qv ** 1.6 * math.sin(ph + v_ / 210) + 0.3 * amp * qv * math.sin(v_ / 63 + ph * 2) \
                    + slant * qv ** 1.3 * h * 0.25
                if mode == 'gather':
                    tp = 0.38 + 0.62 * float(smoothstep(-0.05, 0.6, qv))
                    pts.append((x + sw_ + w * (1 - tp) / 2 + fu * tp, top + v_))
                else:
                    pts.append((x + sw_ + fu * (1 - 0.06 * qv) + w * 0.03 * qv, top + v_))
            L.stroke(pts, 1.0, ink=0.22, pig=INK * 0.8 + UMBER * 0.2, t0=t0 + 0.6, dur=1.4, dry=0.6, wet=0.2,
                     taper=(0.1, 0.6))

    def _ribbon(self, L, x, y, length, wd, pal, t0, k):
        """河中漂洗的锦带：随水流弯曲、渐没入水，半透明。"""
        rng = np.random.default_rng(700 + k)
        hh, ww = int(wd), int(length)
        p1, p2, p3 = self._pattern(['lozenge', 'stripe', 'cloud'][k % 3], hh, ww, rng, k, 0.45)
        p1, p2, p3 = (np.ascontiguousarray(p.T) for p in (p1, p2, p3))
        pad = 50
        Hc, Wc = hh + 2 * pad, ww
        yy, xx = np.mgrid[0:Hc, 0:Wc].astype(np.float32)
        wav = 22 * np.sin(xx / 170 + k) + 8 * np.sin(xx / 53 + 2 * k)
        twist = 0.55 + 0.45 * np.abs(np.cos(xx / 140 + k))      # 翻转处变窄
        vloc = (yy - pad - wav) / twist + hh / 2 - hh / 2 / 1.0
        inside = smoothstep(-0.5, 1.0, vloc) * smoothstep(-0.5, 1.0, hh - vloc)
        fade = 0.25 + 0.75 * smoothstep(ww, ww * 0.25, xx)
        tf = (t0 + xx / ww * 2.2).astype(np.float32)
        for p, pig, dd in zip((p1, p2, p3), pal, (0.3, 0.36, 0.38)):
            q = cv2.remap(p, xx, np.clip(vloc, 0, hh - 1).astype(np.float32), cv2.INTER_LINEAR)
            L.wash(x - ww * 0.25, y - Hc / 2, (q * inside * fade * twist).astype(np.float32), pig, dens=dd, tfield=tf, lo=0.02,
                   hi=0.7, edge=0.35, gran=0.3, warp=0.05)
        for j in range(int(length / 90)):
            px = x - ww * 0.25 + rng.uniform(0.05, 0.95) * ww
            py = y + 22 * math.sin((px - x + ww * 0.25) / 170 + k) + rng.normal(0, 10)
            L.stroke([(px - 30, py), (px, py - 2), (px + 34, py + 1)], 1.0, ink=0.3, pig=INDIGO * 0.7 + INK * 0.3,
                     t0=t0 + 1.0 + 0.05 * j, dur=0.4, dry=0.5, taper=(0.2, 0.5))

    def _fg_willow(self, L, x, y, s, lean):
        """前景垂柳：一段粗枝 + 长长垂下的柳丝，近而淡化。"""
        rng = np.random.default_rng(int(x))
        L.stroke([(x - 260 * s * np.sign(lean or 1), y - 220 * s), (x - 90 * s * np.sign(lean or 1), y - 60 * s), (x, y)],
                 16 * s, ink=0.8, pig=INK * 0.9 + UMBER * 0.1, t0=1.0, dur=0.8, dry=0.55, taper=(0.02, 0.5), start_w=1.0,
                 end_w=0.3, rough=0.4)
        for k in range(26):
            sx = x + rng.uniform(-200, 120) * s
            sy = y + rng.uniform(-120, 30) * s
            drop = rng.uniform(260, 620) * s
            sw = rng.uniform(-30, 30) * s + lean * 40 * s
            pts = [(sx, sy), (sx + sw * 0.3, sy + drop * 0.35), (sx + sw * 0.8, sy + drop * 0.7), (sx + sw, sy + drop)]
            L.stroke(pts, rng.uniform(1.0, 1.8) * s, ink=rng.uniform(0.3, 0.55), pig=INK * 0.7 + JADE * 0.3, t0=1.3 + 0.04 * k,
                     dur=0.7, dry=0.35, wet=0.3, taper=(0.1, 0.6))
            for j in range(int(rng.integers(5, 11))):
                qq = rng.uniform(0.2, 1.0)
                L.dot(sx + sw * qq + rng.normal(0, 2), sy + drop * qq, rng.uniform(1.6, 3.2) * s, ink=rng.uniform(0.25, 0.45),
                      pig=INK * 0.45 + JADE * 0.55, t0=1.6 + 0.04 * k, ang=math.pi / 2 + rng.normal(0, 0.4), elong=3.0)


SCENES_A = [S01, S02, S03, S04, S05, S06]
