"""镜头 7–12：武侯祠 / 杜甫草堂 / 交子 / 湖广填四川 / 今日成都 / 尾声长卷。"""
from __future__ import annotations

import math

import cv2
import numpy as np

from .core import (CRIMSON, GOLD, INDIGO, INK, INK_WARM, JADE, MALACHITE, OCHRE, PINK, UMBER, VERMILION, catmull, fbm,
                   smoothstep, vnoise)
from .motifs import (bamboo, banner, boat, cypress, figure, foliage_tree, ground_wash, hall, hut, leaf_cluster, lerp,
                     mountain_range, poly_wash, reeds, river, rock, tiny_tree, wall_segment, willow)
from .scene_base import SH, SW, SceneBase
from .scenes_a import band_wash, reveal_x


def ellipse_pts(cx, cy, rx, ry, a0=0, a1=2 * np.pi, n=40, rot=0.0):
    out = []
    for a in np.linspace(a0, a1, n):
        x, y = math.cos(a) * rx, math.sin(a) * ry
        out.append((cx + x * math.cos(rot) - y * math.sin(rot), cy + x * math.sin(rot) + y * math.cos(rot)))
    return out


def blob(L, cx, cy, rx, ry, t0, ink=1.0, pig=INK, rot=0.0, hole=None, speed=None, edge=0.6):
    """湿墨团：椭圆软形 + 噪声边，墨从中心晕开。hole=(dx,dy,r) 留白。"""
    pad = 14
    w, h = int(rx * 2 + pad * 2), int(ry * 2 + pad * 2)
    big = int(max(w, h) * 1.3)
    yy, xx = np.mgrid[0:big, 0:big].astype(np.float32)
    xx -= big / 2
    yy -= big / 2
    c, s = math.cos(-rot), math.sin(-rot)
    u = xx * c - yy * s
    v = xx * s + yy * c
    d = (u / rx) ** 2 + (v / ry) ** 2
    f = np.clip(1.25 - d, 0, 1.25) / 1.25
    if hole is not None:
        hx, hy, hr = hole
        f *= smoothstep(hr * 0.8, hr * 1.3, np.hypot(xx - hx, yy - hy))
    L.wash(cx - big / 2, cy - big / 2, f.astype(np.float32), pig, dens=ink, t0=t0, seeds=[(cx, cy)],
           speed=speed or max(rx, ry) * 3, lo=0.12, hi=0.4, edge=edge, gran=0.4, warp=0.25)


def tower(L, wl, x, base, w, h, t0, ink=0.6, pig=INDIGO * 0.5 + INK * 0.5, kind=0, dens=0.22, speed=260):
    """现代高楼：竖向笔线自下而上"长"出来，淡墨染体块，顶部各异。"""
    rng = L.rng
    top = base - h
    dur = h / speed
    for sx in (x - w / 2, x + w / 2):
        L.stroke([(sx, base), (sx + rng.normal(0, 0.6), base - h * 0.5), (sx, top)], max(1.4, w * 0.025), ink=ink,
                 t0=t0, dur=dur, dry=0.45, taper=(0.02, 0.05), ease=0.0)
    if kind == 0:
        cap = [(x - w / 2, top), (x + w / 2, top)]
    elif kind == 1:
        cap = [(x - w / 2, top), (x, top - w * 0.6), (x + w / 2, top)]
    elif kind == 2:
        cap = [(x - w / 2, top), (x + w * 0.5, top - w * 0.45)]
    else:
        cap = [(x - w / 2, top), (x - w * 0.1, top - w * 0.15), (x + w * 0.1, top - w * 0.15), (x + w / 2, top)]
        L.stroke([(x, top - w * 0.15), (x, top - w * 0.9)], 1.2, ink=ink, t0=t0 + dur, dur=0.3)
    L.stroke(cap, max(1.4, w * 0.02), ink=ink, t0=t0 + dur, dur=0.25, dry=0.35)
    poly = [(x - w / 2, base)] + cap + [(x + w / 2, base)]
    hh = int(h + w)
    ww = int(w + 20)
    f = np.zeros((hh, ww), np.uint8)
    pp = np.array([(px - (x - w / 2 - 10), py - (top - w)) for px, py in poly], np.float32)
    cv2.fillPoly(f, [(pp * 4).astype(np.int32)], 255, cv2.LINE_AA, shift=2)
    ff = cv2.GaussianBlur(f.astype(np.float32) / 255, (0, 0), 1.5)
    yy = np.linspace(0, 1, hh)[:, None]
    xx = np.linspace(0, 1, ww)[None, :]
    ff *= (0.35 + 0.65 * smoothstep(0.3, 0.9, xx)) * (1 - smoothstep(0.55, 1.0, yy) * 0.85)
    tf = (t0 + (1 - yy) * dur + 0 * xx).astype(np.float32)
    wl.wash(x - w / 2 - 10, top - w, ff, pig, dens=dens, tfield=np.broadcast_to(tf, (hh, ww)).copy(), lo=0.05, hi=0.8,
            edge=0.4, gran=0.3)
    nfl = int(h / 26)
    for k in range(1, nfl):
        if rng.random() < 0.55:
            continue
        y = base - h * k / nfl
        L.stroke([(x - w / 2 + 3, y), (x + w / 2 - 3, y)], 0.7, ink=ink * 0.45, t0=t0 + dur * k / nfl, dur=0.15, dry=0.6)


# =========================================================================== 7 武侯祠
class S07(SceneBase):
    seal = '武侯'
    seal_t = 2.0
    keys = [(0, 1248, 760, 1.0), (10.99, 1248, 820, 1.3)]
    mist = [dict(y=760, h=170, a=0.75, speed=14, fade=(1.0, 7.5), lo=0.2, hi=0.7),
            dict(y=420, h=120, a=0.45, speed=8, oy=400)]

    def build(self, cv):
        sky = cv.layer('sky', 0.5, fade=0.9)
        mid = cv.layer('mid', 1.0, fade=0.35)
        wl = cv.layer('wash', 1.0, fade=0.6)
        cyp = cv.layer('cypress', 1.25, fade=0.4)
        rng = mid.rng
        self._fan(sky, 1930, 560, 1.0)
        mountain_range(sky, 0, cv.w, 560, [(300, 180, 200), (900, 140, 200), (1700, 160, 200), (2200, 190, 200)],
                       pig=INK * 0.5 + INDIGO * 0.5, wash=0.18, outline=0.2, cun=0.1, dots=0, t0=0.3, t1=3.0)
        for k, bxp in enumerate([520, 760, 1760, 1990]):
            banner(sky, bxp, 560, 150, 2.2 + 0.2 * k, ink=0.3)
        # 祠堂
        hx, hy = 1248, 1010
        poly_wash(wl, [(hx - 420, hy), (hx + 420, hy), (hx + 450, hy + 70), (hx - 450, hy + 70)], UMBER * 0.6 + INK * 0.2, 0.3, 0.8)
        for k in range(5):
            mid.stroke([(hx - 300 + k * 6, hy + 14 * k), (hx + 300 - k * 6, hy + 14 * k)], 1.6, ink=0.55, t0=0.8 + 0.08 * k, dur=0.5)
        hall(mid, hx, hy, 640, 1.2, ink=0.95, tiers=2, dur=2.6, wash_l=wl, wall_pig=VERMILION * 0.55 + UMBER * 0.2, cols=6)
        for side in (-1, 1):
            x0, x1 = (hx - 1250, hx - 340) if side < 0 else (hx + 340, hx + 1250)
            poly_wash(wl, [(x0, hy - 160), (x1, hy - 160), (x1, hy + 10), (x0, hy + 10)], VERMILION * 0.5 + UMBER * 0.25, 0.4,
                      2.0, blur=7, speed=500, edge=0.8, lo=0.15, hi=0.8)
            mid.stroke([(x0, hy - 165), (x1, hy - 165)], 6, ink=0.9, t0=2.0, dur=0.8, dry=0.3)
            mid.stroke([(x0, hy - 178), (x1, hy - 178)], 3, ink=0.7, t0=2.2, dur=0.8, dry=0.4)
            mid.stroke([(x0, hy + 10), (x1, hy + 10)], 2, ink=0.6, t0=2.3, dur=0.8, dry=0.5)
        for k, (cx_, h_) in enumerate([(820, 520), (1680, 560), (1000, 420), (1500, 450)]):
            cypress(mid, cx_, hy - 150, h_, 1.6 + 0.3 * k, ink=0.7, dur=2.0)
        # 香炉
        px, py = hx, hy + 120
        poly_wash(mid, ellipse_pts(px, py - 40, 60, 42, 0, np.pi, 16) + [(px - 60, py - 40)], INK * 0.8 + UMBER * 0.2, 0.7, 3.0)
        mid.stroke(ellipse_pts(px, py - 40, 60, 42, 0, np.pi, 16), 4, ink=1.0, t0=3.0, dur=0.5)
        mid.stroke([(px - 66, py - 42), (px + 66, py - 42)], 5, ink=1.0, t0=3.4, dur=0.3)
        for dx in (-40, 0, 40):
            mid.stroke([(px + dx, py), (px + dx * 1.2, py + 30)], 5, ink=1.0, t0=3.5, dur=0.15)
        for dx in (-30, 30):
            mid.stroke([(px + dx, py - 44), (px + dx, py - 70), (px + dx * 0.6, py - 74)], 3, ink=0.9, t0=3.6, dur=0.2)
        self.burner = (px, py - 50)
        # 前景古柏
        cypress(cyp, 420, 1420, 1150, 0.3, ink=0.95, dur=2.5, w=60)
        cypress(cyp, 2080, 1420, 1100, 0.6, ink=0.95, dur=2.5, w=55, lean=-0.2)
        cypress(cyp, 150, 1420, 900, 0.9, ink=0.8, dur=2.0, w=45)
        cypress(cyp, 2350, 1420, 950, 1.1, ink=0.8, dur=2.0, w=48)

    @staticmethod
    def _fan(L, bx, by, s, t0=1.0, rot=0.42):
        """羽扇：自扇柄处放射的宽软羽笔，淡墨叠染成水滴形扇面，加中脊与扇柄。"""
        rng = L.rng
        c, sn = math.cos(rot), math.sin(rot)

        def P(u, v):
            return (bx + (u * c - v * sn) * s, by + (u * sn + v * c) * s)

        ln, hw = 330, 150

        def edge(q):
            v = -ln * (0.12 + 0.88 * q)
            return hw * math.sin(np.pi * q ** 0.75) ** 0.85, v

        outline = [P(-edge(q)[0], edge(q)[1]) for q in np.linspace(0, 1, 20)] + \
                  [P(edge(q)[0], edge(q)[1]) for q in np.linspace(1, 0, 20)]
        poly_wash(L, outline, INK * 0.75 + UMBER * 0.25, 0.12, t0, blur=14, speed=260, edge=0.7, lo=0.15, hi=0.85)
        n = 26
        for k in range(n):
            q = 0.18 + 0.82 * (k / (n - 1)) ** 0.9
            side = -1 if k % 2 else 1
            ex, ey = edge(q)
            ex *= side * rng.uniform(0.75, 1.0)
            mid_ = P(ex * 0.45 + rng.normal(0, 6), ey * 0.6)
            L.stroke([P(0, -20), mid_, P(ex, ey)], rng.uniform(14, 22) * s, ink=rng.uniform(0.14, 0.24),
                     pig=INK * 0.8 + UMBER * 0.2, t0=t0 + 0.25 + 0.05 * k, dur=0.45, dry=0.55, taper=(0.35, 0.75),
                     start_w=0.3, end_w=0.4, bristle=1.0, rough=0.4)
        L.stroke([P(0, -10), P(rng.normal(0, 3), -ln * 0.5), P(0, -ln * 0.97)], 3.2 * s, ink=0.55, t0=t0 + 0.1, dur=0.8,
                 dry=0.3, taper=(0.05, 0.6))
        L.stroke([P(0, -24), P(0, 150)], 9 * s, ink=0.7, pig=INK_WARM, t0=t0, dur=0.4, dry=0.25, taper=(0.05, 0.1),
                 start_w=1.0, end_w=0.9)
        for k in range(3):
            L.stroke([P(0, 150), P(-8 + 8 * k, 205 + 6 * k)], 2.0 * s, ink=0.5, pig=VERMILION * 0.8 + INK * 0.2,
                     t0=t0 + 0.4, dur=0.2, dry=0.4)

    def dynamic(self, ctx):
        t = ctx.t
        if t < 3.2:
            return
        buf = ctx.canvas()
        bx, by = 1248, 1080
        a = smoothstep(3.2, 4.5, t)
        for k in range(5):
            pts = []
            for j in range(40):
                q = j / 39
                y = by - q * 420
                x = bx + (k - 2) * 10 + math.sin(q * 5 + t * 1.2 + k * 1.7) * 28 * q + math.sin(q * 11 - t * 0.7 + k) * 7 * q
                pts.append((x, y))
            q = ctx.pts(pts)
            for j in range(len(q) - 1):
                v = int(150 * a * (1 - j / len(q)) ** 1.2)
                if v < 4:
                    continue
                cv2.line(buf, tuple((q[j] * 4).astype(int)), tuple((q[j + 1] * 4).astype(int)), v, max(1, int(2 * ctx.z)),
                         cv2.LINE_AA, shift=2)
        ctx.add(buf, INK * 0.7 + INDIGO * 0.3, 0.32, blur=1.8)


# =========================================================================== 8 杜甫草堂
def camel(L, x, y, h, t0, ink=0.85):
    L.stroke([(x - h * 0.5, y - h * 0.62), (x - h * 0.2, y - h * 0.85), (x + h * 0.05, y - h * 0.68),
              (x + h * 0.25, y - h * 0.82), (x + h * 0.5, y - h * 0.6)], h * 0.2, ink=ink * 0.8, t0=t0, dur=0.3, dry=0.1,
             wet=0.8, taper=(0.3, 0.3), start_w=0.6, end_w=0.6)
    L.stroke([(x + h * 0.5, y - h * 0.6), (x + h * 0.72, y - h * 0.75), (x + h * 0.78, y - h * 1.0)], h * 0.07, ink=ink,
             t0=t0 + 0.2, dur=0.2)
    L.dot(x + h * 0.84, y - h * 1.0, h * 0.07, ink=ink, t0=t0 + 0.35, ang=0.0)
    for k, lx in enumerate((-0.38, -0.3, 0.3, 0.4)):
        L.stroke([(x + h * lx, y - h * 0.5), (x + h * lx * 1.05, y)], h * 0.035, ink=ink, t0=t0 + 0.3 + 0.03 * k, dur=0.1)


def lantern(L, x, y, r, t0):
    blob(L, x, y, r, r * 1.2, t0, ink=0.8, pig=VERMILION, edge=0.4, speed=60)
    L.stroke([(x, y - r * 1.2), (x, y - r * 2.2)], 0.9, ink=0.8, t0=t0, dur=0.1)
    L.stroke([(x - r * 0.6, y - r * 1.15), (x + r * 0.6, y - r * 1.15)], 1.2, ink=0.9, t0=t0 + 0.1, dur=0.1)


class S08(SceneBase):
    W = 3600
    seal = '草堂'
    seal_t = 6.5
    keys = [(0, 1050, 700, 1.0), (11.86, 2700, 730, 1.07)]
    mist = [dict(y=720, h=60, a=0.55, speed=14), dict(y=1240, h=40, a=0.3, speed=20, oy=500)]

    def build(self, cv):
        far = cv.layer('far', 0.6, fade=0.7)
        wl = cv.layer('wash', 1.0, fade=0.6)
        mid = cv.layer('mid', 1.0, fade=0.3)
        fg = cv.layer('fg', 1.15, fade=0.3)
        rng = mid.rng
        mountain_range(far, 0, cv.w, 760, [(500, 250, 260), (1500, 210, 260), (2500, 300, 280), (3300, 260, 260)],
                       pig=INK * 0.5 + INDIGO * 0.5, wash=0.3, outline=0.35, cun=0.35, cun_ink=0.2, t0=0.0, t1=3.5, dots=0.2)
        # 左：唐代市井
        for row, (yb, sc) in enumerate([(930, 0.8), (1040, 1.0)]):
            x = 200 + row * 60
            k = 0
            while x < 1750:
                w = rng.uniform(150, 220) * sc
                hall(mid, x, yb + rng.uniform(-6, 6), w, 0.3 + x / 1500 + 0.2 * row, ink=0.85, tiers=1, dur=0.8, wash_l=wl,
                     cols=3, wall_pig=(OCHRE * 0.5 if k % 2 else None))
                if row == 1:
                    for j in range(2):
                        lantern(mid, x - w * 0.3 + j * w * 0.6, yb - w * 0.3, 7, 1.5 + x / 1500)
                x += w + rng.uniform(15, 40)
                k += 1
        ground_wash(wl, 100, 1040, 1800, 200, OCHRE * 0.5 + INK * 0.1, 0.12, 0.6, seeds=[(700, 1100)])
        for k in range(30):
            figure(mid, rng.uniform(220, 1750), 1110 + rng.uniform(-10, 30), rng.uniform(30, 40), 1.0 + rng.uniform(0, 3.5),
                   load=rng.choice(['pole', 'basket', None, None]), facing=rng.choice([-1, 1]))
        camel(mid, 1100, 1140, 70, 2.5)
        camel(mid, 1210, 1150, 64, 2.8)
        for k in range(5):
            willow(mid, 1750 + k * 110, 1100 + rng.uniform(-10, 20), rng.uniform(140, 190), 3.0 + 0.2 * k, ink=0.6)
        # 右：浣花溪畔草堂
        river(wl, mid, [(1700, 1220), (2200, 1190), (2700, 1240), (3200, 1210), (3600, 1235)], 110, t0=3.0, t1=7.0, dens=0.14)
        for k in range(18):
            bx_ = 2280 + k * 62 + rng.uniform(-20, 20)
            if 2560 < bx_ < 3010:
                continue
            bamboo(mid, bx_, 1150, rng.uniform(380, 560), 3.6 + 0.12 * k, ink=0.55,
                   lean=rng.normal(0, 0.12), leaf_ink=0.6, leaves=0.8)
        hut(mid, 2780, 1130, 300, 5.0, ink=0.95, wash_l=wl, dur=1.4, roof_pig=OCHRE * 0.6 + INK * 0.25)
        figure(mid, 2840, 1128, 70, 6.3, ink=0.9, pose=None)
        for k in range(3):
            foliage_tree(mid, 3150 + k * 120, 1160, rng.uniform(170, 230), 5.5 + 0.3 * k, ink=0.7, pig=PINK * 0.7 + INK * 0.15)
            for j in range(40):
                a = rng.uniform(0, 2 * np.pi)
                rr = rng.uniform(0, 70)
                mid.dot(3150 + k * 120 + math.cos(a) * rr * 1.2, 1160 - 200 + math.sin(a) * rr * 0.7, rng.uniform(2.5, 4.5),
                        ink=0.6, pig=PINK, t0=6.0 + 0.3 * k + 0.01 * j, elong=1.1)
        for k, fx in enumerate((1980, 2090, 3620, 3720, 3830)):
            bamboo(fg, fx + rng.uniform(-30, 30), 1450, rng.uniform(750, 950), 4.5 + 0.15 * k, ink=0.85,
                   lean=rng.normal(0, 0.1), leaves=1.2, leaf_scale=0.8)
        reeds(mid, 1900, 3500, 1250, 60, 5.0, 8.0, h=40, ink=0.5)
        reveal_x(cv, 200, 0.0, 500)

    def dynamic(self, ctx):
        t = ctx.t
        k = smoothstep(2.0, 6.0, t)
        if k <= 0:
            return
        buf = ctx.canvas()
        rng = np.random.default_rng(88)
        N = 480
        n = int(N * k)
        x0 = rng.uniform(0, SW + 300, N)
        y0 = rng.uniform(0, SH, N)
        sp = rng.uniform(700, 1100, N)
        ln = rng.uniform(26, 56, N)
        val = rng.integers(110, 220, N)
        for i in range(n):
            y = (y0[i] + sp[i] * t) % (SH + 60) - 30
            x = (x0[i] - 0.28 * sp[i] * t) % (SW + 300) - 150
            dx, dy = -0.28 * ln[i], ln[i]
            cv2.line(buf, (int(x * 4), int(y * 4)), (int((x + dx) * 4), int((y + dy) * 4)), int(val[i]), 1, cv2.LINE_AA, shift=2)
        ctx.add(buf, INK * 0.6 + INDIGO * 0.4, 0.6, blur=0.6)
        buf2 = ctx.canvas()
        for i in range(24):
            ph = (t * 0.7 + i * 0.37) % 1.0
            cx = 1800 + (i * 211) % 1700
            cy = 1205 + (i * 37) % 50
            (sx, sy), = ctx.pts([(cx, cy)])
            r = 3 + ph * 18
            cv2.ellipse(buf2, (int(sx), int(sy)), (int(r * ctx.z), max(1, int(r * 0.3 * ctx.z))), 0, 0, 360,
                        int(160 * (1 - ph) * k), 1, cv2.LINE_AA)
        ctx.add(buf2, INDIGO * 0.6 + INK * 0.4, 0.4, blur=0.6)


# =========================================================================== 9 交子
def coin(L, x, y, r, t0, ink=0.85, tilt=0.45):
    pig = INK * 0.8 + UMBER * 0.2
    L.stroke(ellipse_pts(x, y, r, r * tilt, n=24), max(1.2, r * 0.22), ink=ink, pig=pig, t0=t0, dur=0.12, dry=0.35,
             taper=(0.02, 0.05), start_w=1.0, end_w=1.0)
    hs = r * 0.3
    L.stroke([(x - hs, y - hs * tilt), (x + hs, y - hs * tilt), (x + hs, y + hs * tilt), (x - hs, y + hs * tilt), (x - hs, y - hs * tilt)],
             max(0.8, r * 0.1), ink=ink, pig=pig, t0=t0 + 0.08, dur=0.06)


class S09(SceneBase):
    seal = '交子'
    seal_t = 6.0
    seal_pos = (1780, 560)
    keys = [(0, 1248, 640, 1.4), (4.5, 1248, 660, 1.3), (10.0, 1248, 720, 1.0), (13.08, 1248, 730, 0.97)]
    mist = []
    note = (1048, 320, 1448, 960)
    piles = [(600, 1045, 270), (1900, 1048, 270), (330, 1050, 150), (2170, 1052, 150)]

    def build(self, cv):
        cl = cv.layer('cloud', 1.0, fade=0.9, halo=0.5)
        nt = cv.layer('note', 1.0, fade=0.3)
        rm = cv.layer('room', 1.0, fade=0.3)
        rng = nt.rng
        x0, y0, x1, y1 = self.note
        # 墨云：从中心晕开，交子以留白显形
        yy, xx = np.mgrid[0:cv.h, 0:cv.w].astype(np.float32)
        dx = np.maximum(np.maximum(x0 - xx, xx - x1), 0)
        dy = np.maximum(np.maximum(y0 - yy, yy - y1), 0)
        d = np.hypot(dx, dy)
        lowf = cv2.GaussianBlur(cv.nz_low, (0, 0), 40)
        lowf = lowf / (lowf.std() + 1e-6)
        f = smoothstep(4, 50, d) * np.exp(-d / 230) * (0.62 + 0.38 * smoothstep(-1.6, 1.6, lowf))
        f = f * (1 - smoothstep(880, 1040, yy))
        tf = (0.2 + np.hypot(xx - 1248, (yy - 640) * 1.2) / 520 * (1 + 0.15 * lowf)).astype(np.float32)
        cl.wash(0, 0, f.astype(np.float32), INK * 0.85 + INDIGO * 0.15, dens=0.95, tfield=tf, lo=0.03, hi=0.9, edge=0.35,
                gran=0.12, warp=0.1, edge_blur=16)
        # 纸面
        poly_wash(nt, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], OCHRE * 0.7 + INK * 0.1, 0.16, 1.4, blur=2, speed=400, edge=0.3)
        def rect(L, a, b, c, d_, w, ink, t, dur):
            L.stroke([(a, b), (c, b), (c, d_), (a, d_), (a, b + 2)], w, ink=ink, t0=t, dur=dur, dry=0.25, taper=(0.02, 0.02),
                     start_w=1.0, end_w=1.0, wobble=0.03, rough=0.2)
        rect(nt, x0 + 14, y0 + 14, x1 - 14, y1 - 14, 5, 1.0, 2.0, 1.4)
        rect(nt, x0 + 40, y0 + 40, x1 - 40, y1 - 40, 2, 0.9, 2.6, 1.2)
        # 回纹边框
        unit = [(0, 0), (0, -1), (1, -1), (1, 0.4), (0.4, 0.4), (0.4, -0.4)]
        s = 11
        tt = 3.0
        for side in range(4):
            if side in (0, 2):
                yb = y0 + 27 if side == 0 else y1 - 27
                xs = np.arange(x0 + 34, x1 - 34, s * 1.6)
                for k, xq in enumerate(xs):
                    pts = [(xq + u * s, yb + v * s * 0.55) for u, v in unit]
                    nt.stroke(pts, 1.4, ink=0.85, t0=tt + 0.02 * k, dur=0.12, dry=0.2, taper=(0.02, 0.02))
            else:
                xb = x0 + 27 if side == 3 else x1 - 27
                ys = np.arange(y0 + 34, y1 - 34, s * 1.6)
                for k, yq in enumerate(ys):
                    pts = [(xb + v * s * 0.55, yq + u * s) for u, v in unit]
                    nt.stroke(pts, 1.4, ink=0.85, t0=tt + 0.02 * k, dur=0.12, dry=0.2, taper=(0.02, 0.02))
        # 上栏：三枚钱纹 + 云纹
        for k in range(3):
            cx = x0 + 110 + k * 90
            nt.stroke(ellipse_pts(cx, y0 + 95, 26, 26, n=30), 3, ink=0.9, t0=4.0 + 0.2 * k, dur=0.4)
            nt.stroke([(cx - 8, y0 + 87), (cx + 8, y0 + 87), (cx + 8, y0 + 103), (cx - 8, y0 + 103), (cx - 8, y0 + 87)], 2, ink=0.9,
                      t0=4.3 + 0.2 * k, dur=0.2)
        nt.stroke([(x0 + 50, y0 + 145), (x1 - 50, y0 + 145)], 2, ink=0.8, t0=4.2, dur=0.6)
        # 中栏：屋舍、树、人物(抽象图案，非文字)
        gy = y0 + 330
        for k in range(3):
            hall(nt, x0 + 105 + k * 95, gy, 80, 4.4 + 0.25 * k, ink=0.9, tiers=1, dur=0.6, cols=2)
        for k in range(2):
            foliage_tree(nt, x0 + 80 + k * 240, gy + 110, 90, 4.8 + 0.2 * k, ink=0.8)
        for k in range(3):
            figure(nt, x0 + 150 + k * 50, gy + 120, 50, 5.0 + 0.15 * k, ink=0.9, load=['pole', 'basket', 'pole'][k])
        nt.stroke([(x0 + 50, gy + 150), (x1 - 50, gy + 150)], 2, ink=0.8, t0=5.0, dur=0.6)
        # 下栏：抽象纹样(点线格，非文字)
        for r_ in range(4):
            for c_ in range(10):
                px = x0 + 72 + c_ * 28
                py = gy + 195 + r_ * 34
                if (r_ + c_) % 3 == 0:
                    nt.stroke([(px - 7, py), (px + 7, py)], 2.2, ink=0.75, t0=5.4 + 0.02 * (r_ * 10 + c_), dur=0.08)
                else:
                    nt.dot(px, py, 2.8, ink=0.7, t0=5.4 + 0.02 * (r_ * 10 + c_))
        # 朱印两方
        for (sx, sy, sz) in ((x1 - 120, y0 + 75, 62), (x0 + 70, y1 - 140, 54)):
            poly_wash(nt, [(sx, sy), (sx + sz, sy), (sx + sz, sy + sz), (sx, sy + sz)], VERMILION, 1.0, 5.8, blur=1.2, speed=200,
                      edge=0.3)
        # 室内：长案、钱串堆、竹篮、纸叠、印板
        ty = 1062
        poly_wash(rm, [(140, ty), (2360, ty), (2360, ty + 22), (140, ty + 22)], UMBER * 0.6 + INK * 0.3, 0.35, 3.4, blur=3,
                  speed=900)
        rm.stroke([(140, ty), (1248, ty - 8), (2360, ty)], 5, ink=0.9, t0=3.5, dur=1.0, dry=0.35)
        rm.stroke([(140, ty + 22), (2360, ty + 24)], 2.4, ink=0.65, t0=3.7, dur=1.0, dry=0.5)
        for lx in (200, 900, 1600, 2300):
            rm.stroke([(lx, ty + 22), (lx + rng.normal(0, 3), ty + 230)], 7, ink=0.85, t0=4.0, dur=0.3, dry=0.3)
        for (px, py, w) in self.piles:
            n = int(w * 0.32)
            order = []
            for k in range(n):
                u = rng.uniform(-1, 1)
                hgt = (1 - u * u) * w * 0.5 * rng.uniform(0.2, 1.0)
                order.append((hgt, px + u * w * 0.6, py - hgt))
            order.sort()
            for k, (hgt, cx, cy) in enumerate(order):
                coin(rm, cx, cy, rng.uniform(17, 23), 4.2 + 6.0 * k / n, ink=0.55)
            ground_wash(rm, int(px - w * 0.7), int(py - w * 0.45), int(w * 1.4), int(w * 0.5), GOLD * 0.5 + OCHRE * 0.4, 0.14, 4.5,
                        seeds=[(px, py)], cell=60)
        for k, fx in enumerate((120, 2400)):
            figure(rm, fx, ty + 200, 230, 5.0 + 0.3 * k, ink=0.9, pose=None, facing=1 if k == 0 else -1)

    def dynamic(self, ctx):
        t = ctx.t
        if t < 4.0:
            return
        buf = ctx.canvas()
        rng = np.random.default_rng(99)
        n = 70
        ts = np.sort(rng.uniform(4.0, 12.8, n))
        pile = rng.integers(0, 4, n)
        offs = rng.uniform(-0.5, 0.5, n)
        spin = rng.uniform(5, 11, n)
        for i in range(n):
            dt = t - ts[i]
            if dt < 0:
                continue
            px, py, w = self.piles[pile[i]]
            ty = py - w * 0.3
            y = -60 + 0.5 * 1500 * dt * dt
            if y > ty:
                continue
            x = px + offs[i] * w
            (sx, sy), = ctx.pts([(x, y)])
            r = 20 * ctx.z
            c = abs(math.cos(spin[i] * dt))
            ax = (max(1, int(r * c)), max(1, int(r)))
            cv2.ellipse(buf, (int(sx), int(sy)), ax, 20, 0, 360, 230, max(1, int(3.2 * ctx.z)), cv2.LINE_AA)
            hs = max(1, int(r * 0.3))
            cv2.rectangle(buf, (int(sx - hs * c), int(sy - hs)), (int(sx + hs * c), int(sy + hs)), 210, 1, cv2.LINE_AA)
        ctx.add(buf, INK * 0.8 + UMBER * 0.2, 0.9, blur=0.6)


# =========================================================================== 10 湖广填四川
class S10(SceneBase):
    W = 4000
    seal = '湖广'
    seal_t = 2.5
    keys = [(0, 1150, 760, 1.02), (8.0, 2500, 820, 1.0), (11.4, 2900, 800, 0.88)]
    mist = [dict(y=620, h=70, a=0.6, speed=10), dict(y=1000, h=50, a=0.4, speed=18, oy=400)]
    PATH = [(150, 600), (450, 640), (800, 690), (1250, 690), (1600, 700), (1820, 780), (1650, 860), (1900, 930),
            (2250, 960), (2500, 1060), (2800, 1120), (3200, 1150), (3600, 1160), (4000, 1170)]

    def build(self, cv):
        far = cv.layer('far', 0.55, fade=0.7)
        mt = cv.layer('mount', 1.0, fade=0.4)
        wl = cv.layer('wash', 1.0, fade=0.6)
        ln = cv.layer('lines', 1.0, fade=0.3)
        rng = ln.rng
        mountain_range(far, 0, cv.w, 640, [(300, 300, 240), (1100, 360, 260), (2000, 300, 260), (3000, 220, 280), (3700, 180, 240)],
                       pig=INK * 0.5 + INDIGO * 0.5, wash=0.3, outline=0.3, cun=0.25, cun_ink=0.18, t0=0.0, t1=4.0, dots=0)
        mountain_range(mt, 0, 2300, 1300, [(250, 820, 200), (700, 700, 220), (1200, 760, 200), (1700, 560, 220), (2100, 380, 200)],
                       wash=0.5, outline=0.9, cun=1.1, trees=0.7, t0=0.2, t1=5.0, fall=0.55, fog=0.3)
        ground_wash(wl, 2000, 1050, 2000, 280, OCHRE * 0.6 + JADE * 0.3, 0.16, 2.0, seeds=[(3000, 1150)], speed=700)
        P = catmull(self.PATH, 4.0)
        for off, ink in ((-7, 0.55), (7, 0.4)):
            tan = np.gradient(P, axis=0)
            tan /= np.linalg.norm(tan, axis=1, keepdims=True)
            nrm = np.c_[-tan[:, 1], tan[:, 0]]
            Q = P + nrm * off
            i = 0
            while i < len(Q) - 4:
                j = min(len(Q) - 1, i + int(rng.integers(15, 50)))
                ln.stroke(Q[i:j + 1:2], 1.4, ink=ink, t0=0.5 + 5.0 * i / len(Q), dur=0.4, dry=0.5, taper=(0.1, 0.4))
                i = j + int(rng.integers(1, 4))
        poly_wash(wl, [tuple(p) for p in (P[::6] + [0, -8])] + [tuple(p) for p in (P[::-6] + [0, 8])], OCHRE * 0.6 + INK * 0.2, 0.15, 1.0)
        # 栈道：峭壁上的木栈与支柱
        for x in np.arange(860, 1560, 34):
            y = 690 + 3 * math.sin(x / 50)
            ln.stroke([(x, y + 6), (x + rng.normal(0, 2), y + 60)], 2.2, ink=0.8, t0=1.2 + (x - 860) / 700, dur=0.15)
            ln.stroke([(x, y + 34), (x + 30, y + 36)], 1.0, ink=0.5, t0=1.3 + (x - 860) / 700, dur=0.1)
        ln.stroke([(850, 698), (1250, 698), (1570, 706)], 3.2, ink=0.95, t0=1.0, dur=1.2, dry=0.3)
        rock(mt, 1200, 1000, 520, 260, 1.5, ink=0.9, dur=1.6, wash=0.5)
        river(wl, ln, [(0, 1300), (800, 1270), (1600, 1310), (2400, 1260), (3200, 1290), (4000, 1270)], 120, t0=1.0, t1=6.0, dens=0.14)
        for k in range(20):
            foliage_tree(ln, rng.uniform(2300, 3900), 1110 + rng.uniform(-20, 40), rng.uniform(50, 90), 3.0 + 0.15 * k, ink=0.65)
        for k in range(8):
            hut(ln, 2900 + k * 130 + rng.uniform(-30, 30), 1135 + rng.uniform(-10, 10), 70, 4.5 + 0.2 * k, ink=0.8, wash_l=wl,
                roof_pig=OCHRE * 0.5 + INK * 0.2)
        for k in range(30):
            q = rng.uniform(0, 1)
            x = 2400 + q * 1500
            ln.stroke([(x, 1180 + rng.uniform(0, 60)), (x + rng.uniform(60, 160), 1182 + rng.uniform(0, 60))], 1.0, ink=0.3,
                      t0=3.5 + q, dur=0.4, dry=0.6)
        self._P = None

    def dynamic(self, ctx):
        t = ctx.t
        if getattr(self, '_P', None) is None:
            P = catmull(self.PATH, 2.0)
            self._P = P
            self._s = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
        P, s = self._P, self._s
        L = s[-1]
        buf = ctx.canvas()
        rng = np.random.default_rng(1010)
        n = 70
        gaps = rng.uniform(42, 70, n) + np.where(rng.random(n) < 0.15, 120, 0)
        pos0 = np.cumsum(gaps)
        kind = rng.integers(0, 10, n)
        z = ctx.z
        vis = smoothstep(0.0, 1.5, t)
        for i in range(n):
            si = pos0[i] + 40 * t - 300
            if si < 0 or si > L - 5:
                continue
            k = np.searchsorted(s, si)
            x, y = P[min(k, len(P) - 1)]
            nx = P[min(k + 3, len(P) - 1)]
            facing = 1 if nx[0] >= x else -1
            (sx, sy), = ctx.pts([(x, y)])
            sc = 1.6 * z
            bob = abs(math.sin(t * 6 + i)) * 1.5 * sc
            h = 30 * sc if kind[i] != 3 else 19 * sc
            col = int(245 * vis)
            if kind[i] == 7:
                cv2.ellipse(buf, (int(sx), int(sy - 13 * sc)), (int(16 * sc), int(8 * sc)), 0, 0, 360, col, -1, cv2.LINE_AA)
                cv2.circle(buf, (int(sx + facing * 18 * sc), int(sy - 15 * sc)), max(1, int(5 * sc)), col, -1, cv2.LINE_AA)
                for lx in (-10, -5, 6, 11):
                    cv2.line(buf, (int(sx + lx * sc), int(sy - 8 * sc)), (int(sx + lx * sc), int(sy)), col, max(1, int(2 * sc)), cv2.LINE_AA)
                continue
            cy = sy - bob
            cv2.circle(buf, (int(sx), int(cy - h + 3 * sc)), max(1, int(3.3 * sc)), col, -1, cv2.LINE_AA)
            body = np.array([[sx - 2 * sc, cy - h + 7 * sc], [sx + 2.5 * sc, cy - h + 7 * sc], [sx + 5 * sc, cy - 6 * sc],
                             [sx - 5 * sc, cy - 6 * sc]], np.int32)
            cv2.fillConvexPoly(buf, body, col, cv2.LINE_AA)
            sw = math.sin(t * 6 + i) * 4 * sc
            cv2.line(buf, (int(sx - 2 * sc), int(cy - 6 * sc)), (int(sx - 2 * sc + sw), int(sy)), col, max(1, int(1.8 * sc)), cv2.LINE_AA)
            cv2.line(buf, (int(sx + 2 * sc), int(cy - 6 * sc)), (int(sx + 2 * sc - sw), int(sy)), col, max(1, int(1.8 * sc)), cv2.LINE_AA)
            if kind[i] in (0, 1, 5):
                py = int(cy - h * 0.8)
                cv2.line(buf, (int(sx - 14 * sc), py), (int(sx + 14 * sc), py - 1), col, max(1, int(1.6 * sc)), cv2.LINE_AA)
                for e in (-13, 13):
                    cv2.line(buf, (int(sx + e * sc), py), (int(sx + e * sc), int(py + 8 * sc)), col // 2, 1, cv2.LINE_AA)
                    cv2.ellipse(buf, (int(sx + e * sc), int(py + 11 * sc)), (int(4.5 * sc), int(3.5 * sc)), 0, 0, 360, col, -1, cv2.LINE_AA)
            elif kind[i] == 2:
                cv2.ellipse(buf, (int(sx - facing * 5 * sc), int(cy - h * 0.62)), (int(4 * sc), int(5 * sc)), 0, 0, 360, col, -1, cv2.LINE_AA)
        ctx.add(buf, INK, 1.1, blur=0.8)
        # 逆流而上的木船
        b2 = ctx.canvas()
        for k in range(3):
            bx = 3400 - k * 900 - 22 * t
            by = 1290 - 10 * k
            q = ctx.pts([(bx - 50, by - 6), (bx - 30, by + 6), (bx + 30, by + 6), (bx + 55, by - 8)])
            cv2.polylines(b2, [(q * 4).astype(np.int32).reshape(-1, 1, 2)], False, 230, max(1, int(4 * z)), cv2.LINE_AA, shift=2)
            m = ctx.pts([(bx, by), (bx, by - 70), (bx + 30, by - 58), (bx + 28, by - 18)])
            cv2.line(b2, tuple((m[0] * 4).astype(int)), tuple((m[1] * 4).astype(int)), 220, max(1, int(2 * z)), cv2.LINE_AA, shift=2)
            cv2.fillConvexPoly(b2, (m[1:] * 4).astype(np.int32).reshape(-1, 1, 2), 110, cv2.LINE_AA, shift=2)
        ctx.add(b2, INK * 0.8 + UMBER * 0.2, 0.8, blur=0.7)


# =========================================================================== 11 今日成都
def panda(L, wl, x, y, s, t0):
    """熊猫：淡墨勾出白色的身与头，浓墨团写耳、眼圈、鼻、前臂、肩带与后腿；怀抱一竿竹。(x,y)=坐地底部中心。"""
    hx, hy = x, y - 228 * s
    sp = 140
    # 身：梨形，左右两笔断续勾成，下部淡墨衬底
    left = [(x - 34 * s, y - 172 * s), (x - 92 * s, y - 132 * s), (x - 118 * s, y - 62 * s), (x - 96 * s, y - 6 * s)]
    right = [(x + 34 * s, y - 172 * s), (x + 94 * s, y - 130 * s), (x + 120 * s, y - 60 * s), (x + 100 * s, y - 6 * s)]
    L.stroke(left, 3.6 * s, ink=0.8, t0=t0, dur=0.6, dry=0.35, taper=(0.05, 0.3))
    L.stroke(right, 3.6 * s, ink=0.8, t0=t0 + 0.15, dur=0.6, dry=0.35, taper=(0.05, 0.3))
    L.stroke([(x - 96 * s, y - 4 * s), (x, y + 4 * s), (x + 100 * s, y - 4 * s)], 2.8 * s, ink=0.6, t0=t0 + 0.4, dur=0.4,
             dry=0.45)
    sh = ellipse_pts(x, y - 30 * s, 120 * s, 34 * s, 0, 2 * np.pi, 30)
    poly_wash(wl, sh, INK * 0.7 + JADE * 0.3, 0.12, t0 + 0.3, blur=10, speed=sp)
    # 头
    L.stroke(ellipse_pts(hx, hy, 74 * s, 64 * s, np.pi * 0.62, np.pi * 2.42, 34), 3.6 * s, ink=0.85, t0=t0 + 0.3, dur=0.7,
             dry=0.3, taper=(0.05, 0.25))
    for ex in (-1, 1):
        blob(L, hx + ex * 56 * s, hy - 54 * s, 24 * s, 21 * s, t0 + 0.9, ink=0.95, rot=0.35 * ex, speed=sp, edge=0.4)
        blob(L, hx + ex * 27 * s, hy + 2 * s, 14 * s, 21 * s, t0 + 1.1, ink=1.0, rot=-0.55 * ex,
             hole=(ex * 2 * s, -5 * s, 5.5 * s), speed=sp, edge=0.4)
    blob(L, hx, hy + 26 * s, 10 * s, 7 * s, t0 + 1.3, ink=1.0, speed=sp, edge=0.3)
    L.stroke([(hx - 10 * s, hy + 40 * s), (hx, hy + 45 * s), (hx + 10 * s, hy + 40 * s)], 2.0 * s, ink=0.8, t0=t0 + 1.4,
             dur=0.2)
    # 肩带 + 前臂(墨团一笔写成)
    L.stroke([(x - 90 * s, y - 128 * s), (x - 30 * s, y - 166 * s), (x + 30 * s, y - 166 * s), (x + 92 * s, y - 126 * s)],
             26 * s, ink=0.95, t0=t0 + 1.5, dur=0.4, dry=0.15, wet=0.7, taper=(0.25, 0.25), start_w=0.6, end_w=0.6, rough=0.3)
    L.stroke([(x - 92 * s, y - 128 * s), (x - 84 * s, y - 92 * s), (x - 48 * s, y - 84 * s), (x - 4 * s, y - 102 * s)],
             30 * s, ink=1.0, t0=t0 + 1.8, dur=0.35, dry=0.12, wet=0.7, taper=(0.15, 0.35), start_w=0.9, end_w=0.5)
    L.stroke([(x + 94 * s, y - 126 * s), (x + 84 * s, y - 100 * s), (x + 52 * s, y - 108 * s), (x + 18 * s, y - 132 * s)],
             28 * s, ink=1.0, t0=t0 + 2.0, dur=0.35, dry=0.12, wet=0.7, taper=(0.15, 0.35), start_w=0.9, end_w=0.5)
    # 后腿：脚掌朝前
    for side, t_ in ((-1, 2.3), (1, 2.45)):
        blob(L, x + side * 72 * s, y - 26 * s, 46 * s, 28 * s, t0 + t_, ink=1.0, rot=0.22 * side, speed=sp, edge=0.4,
             hole=(side * 14 * s, 2 * s, 9 * s))
    # 竹竿与叶
    st = [(x + 6 * s, y - 60 * s), (x + 22 * s, y - 180 * s), (x + 50 * s, y - 330 * s)]
    L.stroke(st, 7 * s, ink=0.75, pig=JADE * 0.55 + INK * 0.45, t0=t0 + 2.6, dur=0.4, dry=0.3, taper=(0.05, 0.4))
    for k in range(4):
        leaf_cluster(L, x + 48 * s + k * 4 * s, y - 325 * s + k * 10 * s, 64 * s, t0 + 2.9 + 0.1 * k, ink=0.85,
                     pig=JADE * 0.45 + INK * 0.55, base_ang=-0.3 + 0.6 * k, n=2)


def gaiwan(L, wl, x, y, s, t0):
    """盖碗：托、碗、盖，淡青釉 + 青花纹。(x,y)=托盘中心。"""
    sau = ellipse_pts(x, y, 150 * s, 30 * s, 0, 2 * np.pi, 40)
    poly_wash(wl, sau, JADE * 0.4 + INK * 0.1, 0.2, t0, blur=3)
    L.stroke(sau, 3 * s, ink=0.85, t0=t0, dur=0.6, dry=0.3)
    bowl = [(x - 105 * s, y - 95 * s), (x - 92 * s, y - 40 * s), (x - 55 * s, y - 10 * s), (x + 55 * s, y - 10 * s),
            (x + 92 * s, y - 40 * s), (x + 105 * s, y - 95 * s)]
    poly_wash(wl, bowl, JADE * 0.45 + INK * 0.1, 0.25, t0 + 0.4, blur=3)
    L.stroke(bowl, 3.2 * s, ink=0.95, t0=t0 + 0.4, dur=0.6, dry=0.25)
    lid = [(x - 112 * s, y - 95 * s)] + ellipse_pts(x, y - 95 * s, 112 * s, 75 * s, np.pi, 2 * np.pi, 20)[1:]
    poly_wash(wl, lid, JADE * 0.45 + INK * 0.1, 0.25, t0 + 0.8, blur=3)
    L.stroke(lid, 3.2 * s, ink=0.95, t0=t0 + 0.8, dur=0.6, dry=0.25)
    L.stroke(ellipse_pts(x, y - 95 * s, 112 * s, 14 * s, 0, np.pi, 14), 2.2 * s, ink=0.8, t0=t0 + 1.0, dur=0.4)
    knob = ellipse_pts(x, y - 172 * s, 22 * s, 9 * s, 0, 2 * np.pi, 16)
    L.stroke(knob, 2.6 * s, ink=0.9, t0=t0 + 1.2, dur=0.3)
    poly_wash(wl, knob, INDIGO, 0.5, t0 + 1.2, blur=1.5)
    for k in range(5):
        cx = x - 70 * s + k * 35 * s
        L.stroke(ellipse_pts(cx, y - 55 * s, 9 * s, 7 * s, 0, 1.8 * np.pi, 10), 1.6 * s, ink=0.7, pig=INDIGO, t0=t0 + 1.3 + 0.1 * k,
                 dur=0.2)
        L.stroke(ellipse_pts(cx, y - 125 * s, 10 * s, 6 * s, 0, 1.8 * np.pi, 10), 1.6 * s, ink=0.7, pig=INDIGO, t0=t0 + 1.4 + 0.1 * k,
                 dur=0.2)


class S11(SceneBase):
    seal = '蓉城'
    seal_t = 4.0
    seal_pos = (1790, 330)
    keys = [(0, 830, 900, 1.38), (3.6, 980, 880, 1.24), (7.0, 1380, 840, 1.1), (10.9, 1248, 720, 0.97)]
    mist = [dict(y=830, h=70, a=0.75, speed=12, lo=0.2, hi=0.7), dict(y=1240, h=40, a=0.25, speed=20, oy=500)]
    cup = (1830, 1140)

    def build(self, cv):
        sky = cv.layer('sky', 0.6, fade=0.5)
        wl = cv.layer('wash', 1.0, fade=0.5)
        mid = cv.layer('mid', 1.0, fade=0.3)
        rng = mid.rng
        towers = [(520, 300, 60, 0), (620, 420, 70, 2), (740, 260, 55, 0), (880, 520, 75, 3), (1000, 360, 60, 1),
                  (1120, 470, 80, 0), (1260, 600, 58, 3), (1380, 400, 72, 2), (1500, 500, 65, 0), (1640, 340, 60, 1),
                  (1760, 440, 70, 0), (1900, 300, 60, 2), (2020, 380, 55, 0)]
        for k, (tx, th, tw, kind) in enumerate(towers):
            tower(sky, sky, tx, 860, tw, th, 5.2 + 0.18 * k, ink=0.55, kind=kind, speed=300)
        band_wash(sky, 860, 70, INDIGO * 0.5 + INK * 0.3, 0.12, 5.0, speed=800)
        # 茶馆：银杏、桌、竹椅、盖碗
        foliage_tree(mid, 2150, 1150, 330, 3.0, ink=0.7)
        for j in range(70):
            a = rng.uniform(0, 2 * np.pi)
            rr = rng.uniform(0, 120)
            mid.dot(2150 + math.cos(a) * rr * 1.3, 1150 - 330 + math.sin(a) * rr * 0.7, rng.uniform(3, 6), ink=0.7,
                    pig=GOLD * 0.8 + OCHRE * 0.2, t0=3.5 + 0.01 * j, elong=1.2)
        mid.stroke([(1450, 1185), (1850, 1180), (2300, 1188)], 5, ink=0.9, t0=2.8, dur=0.8, dry=0.35)
        mid.stroke([(1500, 1200), (1500, 1380)], 5, ink=0.85, t0=3.0, dur=0.3)
        mid.stroke([(2250, 1200), (2250, 1380)], 5, ink=0.85, t0=3.0, dur=0.3)
        for k in range(5):
            mid.stroke([(2330 + k * 12, 1100), (2340 + k * 12, 1350)], 3, ink=0.6, pig=OCHRE * 0.6 + INK * 0.4, t0=3.2 + 0.05 * k, dur=0.3)
        mid.stroke([(2320, 1230), (2420, 1225)], 3, ink=0.6, t0=3.4, dur=0.2)
        gaiwan(mid, wl, *self.cup, 0.9, 3.4)
        # 竹林与熊猫
        for k in range(16):
            x = 120 + k * 75 + rng.uniform(-25, 25)
            if 560 < x < 1060:
                continue
            bamboo(mid, x, 1404, rng.uniform(800, 1250), 0.1 + 0.08 * k, ink=rng.uniform(0.55, 0.9), lean=rng.normal(0, 0.08),
                   leaves=1.3, leaf_scale=0.6, pig=INK * 0.85 + JADE * 0.15)
        pl = cv.layer('panda', 1.0, fade=0.3, halo=0.45)
        panda(pl, wl, 810, 1250, 1.15, 0.6)
        for k in range(30):
            lx = rng.uniform(100, 1400)
            if 640 < lx < 980:
                lx += 380 if lx > 810 else -380
            leaf_cluster(mid, lx, rng.uniform(1290, 1400), rng.uniform(50, 80), 1.0 + 0.05 * k, ink=0.8,
                         pig=INK * 0.7 + JADE * 0.3, base_ang=rng.uniform(-0.5, 3.5), n=3)
        ground_wash(wl, 0, 1150, 1500, 254, JADE * 0.5 + INK * 0.2, 0.14, 0.3, seeds=[(800, 1250)])

    def dynamic(self, ctx):
        t = ctx.t
        if t < 4.4:
            return
        buf = ctx.canvas()
        a = smoothstep(4.4, 5.5, t)
        x0, y0 = self.cup[0], self.cup[1] - 190
        for k in range(3):
            pts = []
            for j in range(30):
                q = j / 29
                pts.append((x0 + (k - 1) * 22 + math.sin(q * 4 + t * 1.4 + k * 2) * 22 * q, y0 - q * 230))
            q = ctx.pts(pts)
            for j in range(len(q) - 1):
                v = int(150 * a * math.sin(np.pi * j / len(q)) ** 0.8)
                if v < 4:
                    continue
                cv2.line(buf, tuple((q[j] * 4).astype(int)), tuple((q[j + 1] * 4).astype(int)), v, max(1, int(2.5 * ctx.z)),
                         cv2.LINE_AA, shift=2)
        ctx.add(buf, INK * 0.6 + INDIGO * 0.4, 0.28, blur=2.5)


# =========================================================================== 12 尾声长卷
class S12(SceneBase):
    W = 5200
    seal = '成都'
    seal_size = 190
    seal_pos = (960, 520)
    seal_t = 8.3
    keys = [(0, 1248, 690, 1.0), (6.0, 3950, 700, 1.0), (7.7, 2600, 702, 0.47), (9.76, 2600, 702, 0.46)]
    mist = [dict(y=820, h=70, a=0.55, speed=14), dict(y=1080, h=40, a=0.3, speed=20, oy=500)]

    def build(self, cv):
        far = cv.layer('far', 1.0, fade=0.7)
        wl = cv.layer('wash', 1.0, fade=0.6)
        mid = cv.layer('mid', 1.0, fade=0.3)
        rng = mid.rng
        # 远山一抹，贯通全卷
        mountain_range(far, 0, cv.w, 860, [(500, 420, 300), (1350, 470, 330), (2250, 330, 300), (3100, 300, 300),
                                           (3900, 260, 300), (4700, 240, 320)],
                       pig=INK * 0.45 + INDIGO * 0.55, wash=0.34, outline=0.4, cun=0.35, cun_ink=0.22, dots=0.1, t0=-1.2,
                       t1=3.5)
        # 卷首：近山浓墨
        mountain_range(mid, 0, 2000, 1100, [(260, 640, 230), (720, 560, 240), (1250, 420, 220), (1700, 260, 200)],
                       wash_layer=wl, wash=0.55, outline=0.95, cun=1.1, trees=0.8, t0=-1.5, t1=1.2, fall=0.5, fog=0.35)
        for k in range(5):
            foliage_tree(mid, 1450 + k * 90 + rng.uniform(-20, 20), 1110, rng.uniform(110, 160), -0.6 + 0.12 * k, ink=0.8,
                         kind='pine' if k % 2 else 'round')
        river(wl, mid, [(0, 1150), (900, 1185), (1800, 1215), (2700, 1235), (3600, 1250), (4500, 1235), (5200, 1255)], 170,
              t0=-0.8, t1=5.5, dens=0.15)
        # 古城：城墙、殿阁、塔
        wall_segment(mid, 1950, 3150, 1110, 120, 0.4, 2.0, ink=0.9, wash_l=wl, dens=0.4)
        hall(mid, 2550, 1000, 420, 0.6, ink=1.0, tiers=2, dur=1.4, wash_l=wl, wall_pig=VERMILION * 0.5 + UMBER * 0.2, cols=6)
        for k in range(5):
            hall(mid, 3020, 1000 - k * 78, 150 - k * 22, 0.9 + 0.2 * k, ink=0.95, tiers=1, dur=0.5, wash_l=wl, cols=2)
        for k, hx_ in enumerate((2070, 2230, 2810)):
            hall(mid, hx_, 1000, 150, 0.8 + 0.15 * k, ink=0.85, tiers=1, dur=0.6, wash_l=wl, cols=3)
        for k in range(9):
            cypress(mid, 2000 + k * 130 + rng.uniform(-30, 30), 990, rng.uniform(170, 240), 0.6 + 0.1 * k, ink=0.7, dur=1.0)
        # 河畔街市与廊桥
        for k in range(12):
            x = 3300 + k * 95
            hall(mid, x, 1150, 92, 2.0 + 0.08 * k, ink=0.9, tiers=1, dur=0.5, wash_l=wl, cols=2)
            lantern(mid, x, 1098, 8, 2.6 + 0.05 * k)
        bx = 4000
        arch = [(bx - 280, 1235)] + ellipse_pts(bx - 140, 1235, 140, 80, np.pi, 2 * np.pi, 14)[1:] + \
            ellipse_pts(bx + 140, 1235, 140, 80, np.pi, 2 * np.pi, 14)[1:]
        mid.stroke(arch, 6, ink=1.0, t0=2.6, dur=0.8)
        mid.stroke([(bx - 300, 1158), (bx + 300, 1158)], 6, ink=1.0, t0=2.8, dur=0.6)
        poly_wash(wl, [(bx - 300, 1158), (bx + 300, 1158), (bx + 280, 1235), (bx - 280, 1235)], UMBER * 0.5 + INK * 0.3, 0.3, 2.8)
        hall(mid, bx, 1158, 460, 2.9, ink=1.0, tiers=2, dur=1.0, wash_l=wl, wall_pig=VERMILION * 0.45 + UMBER * 0.2, cols=7)
        for k in range(10):
            lantern(mid, bx - 225 + k * 50, 1110, 7, 3.4 + 0.04 * k)
        for k in range(5):
            willow(mid, 3250 + k * 300, 1215, rng.uniform(150, 200), 2.4 + 0.1 * k, ink=0.6)
        # 卷尾：现代楼群隐于云
        for k in range(12):
            tower(mid, wl, 4420 + k * 62 + rng.uniform(-12, 12), 1130, rng.uniform(50, 80), rng.uniform(300, 620),
                  3.6 + 0.12 * k, ink=0.55, kind=int(rng.integers(0, 4)), dens=0.2, speed=420)
        band_wash(wl, 1060, 80, INDIGO * 0.4 + INK * 0.3, 0.1, 4.5, x0=4300, x1=5200, speed=800)
        for k in range(10):
            boat(mid, 300 + k * 480 + rng.uniform(-80, 80), 1240 + rng.uniform(-10, 25), rng.uniform(70, 100), 0.5 + 0.4 * k,
                 ink=0.85, sail=bool(rng.random() < 0.4))
        reveal_x(cv, 2400, 0.0, 560)

    def post(self, ctx, img):
        t = ctx.t
        M = ctx.M
        x0 = M[0, 2]
        x1 = M[0, 0] * self.W + M[0, 2]
        y0 = M[1, 2]
        y1 = M[1, 1] * self.H + M[1, 2]
        if x0 > -2 or y0 > -2 or x1 < SW + 2:
            xs = np.arange(SW, dtype=np.float32)[None, :]
            ys = np.arange(SH, dtype=np.float32)[:, None]
            inside = smoothstep(x0 - 1, x0 + 1, xs) * smoothstep(x1 + 1, x1 - 1, xs) * smoothstep(y0 - 1, y0 + 1, ys) * \
                smoothstep(y1 + 1, y1 - 1, ys)
            silk = ctx.paper * np.array([0.86, 0.90, 0.88], np.float32)
            shadow = np.exp(-np.maximum(0, np.maximum(ys - y1, y0 - ys)) / 10.0) * (1 - inside)
            silk = silk * (1 - 0.12 * shadow[..., None])
            out = img * inside[..., None] + silk * (1 - inside[..., None])
            for xr in (x0, x1):
                ra, rb = int(xr - 20 * ctx.z / 0.3), int(xr + 20 * ctx.z / 0.3)
                ya, yb = int(y0 - 40 * ctx.z / 0.3), int(y1 + 40 * ctx.z / 0.3)
                ra, rb = max(0, ra), min(SW, rb)
                ya, yb = max(0, ya), min(SH, yb)
                if rb > ra and yb > ya:
                    g = np.linspace(-1, 1, rb - ra)[None, :]
                    shade = (0.28 + 0.22 * (1 - g ** 2))[..., None] * np.array([1.0, 0.78, 0.6], np.float32)
                    out[ya:yb, ra:rb] = shade
            img = out
        f = smoothstep(8.0, 9.5, t)
        if f > 0:
            img = img * (1 - f) + ctx.paper * f
        return img


SCENES_B = [S07, S08, S09, S10, S11, S12]
