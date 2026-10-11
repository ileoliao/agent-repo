"""程序化母题：山(披麻皴)、水、树、竹、屋、城墙、小人物……全部由笔触与墨染组成。"""
from __future__ import annotations

import math

import cv2
import numpy as np

from .core import (INK, INDIGO, OCHRE, UMBER, JADE, Layer, catmull, fbm1d, smoothstep,
                   vnoise)


def lerp(a, b, t):
    return a + (b - a) * t


# --------------------------------------------------------------------------- mountains
def mountain_range(L: Layer, x0, x1, base_y, peaks, *, wash_layer: Layer | None = None, ink=0.5,
                   pig=INK, t0=0.0, t1=3.0, outline=0.85, outline_w=3.0, cun=1.0, cun_ink=0.38,
                   wash=0.45, fall=0.45, fog=0.45, dots=1.0, scale=1.0, detail=0.10, trees=0.0,
                   speed=None, contours=2, cun_w=1.4, seed_t=None):
    """一列山：山脊轮廓线(勾) + 由脊向下渐淡的墨染(染) + 顺坡的披麻皴(皴) + 点苔(点)。"""
    rng = L.rng
    wl = wash_layer or L
    x0, x1 = int(max(0, x0)), int(min(L.cv.w, x1))
    X = np.arange(x0, x1, dtype=np.float64)
    n = len(X)
    H = np.zeros(n)
    allp = []
    for (px, ph, pw) in peaks:
        allp.append((px, ph, pw, rng.uniform(0.8, 1.6)))
        for _ in range(int(rng.integers(1, 4))):
            allp.append((px + rng.normal(0, pw * 0.7), ph * rng.uniform(0.45, 0.8), pw * rng.uniform(0.25, 0.5),
                         rng.uniform(0.9, 1.8)))
    for (px, ph, pw, sk) in allp:
        uu = (X - px) / pw
        uu = np.where(uu > 0, uu * sk, uu / sk)
        H = np.maximum(H, ph / (1 + uu * uu) ** 1.1)
    hmax = max(p[1] for p in peaks)
    rid = 1 - np.abs(fbm1d(n, 45 * scale, 4, rng))
    H = H * (1 + detail * fbm1d(n, 90 * scale, 3, rng)) + 0.05 * H * (rid - 0.5) + 0.02 * hmax * fbm1d(n, 14 * scale, 3, rng)
    H = np.maximum(H, 0)
    ridge = base_y - H
    dr = np.gradient(ridge)
    dr = np.convolve(dr, np.ones(21) / 21, mode='same')
    ymin = int(max(0, ridge.min() - 6))
    ymax = int(min(L.cv.h, base_y + 6))
    hh = ymax - ymin
    yy = np.arange(ymin, ymax, dtype=np.float32)[:, None]
    depth = yy - ridge[None, :].astype(np.float32)
    loc_h = np.maximum(H, 20)[None, :].astype(np.float32)
    fr = depth / loc_h
    body = smoothstep(-1.0, 2.5, depth)
    grad = np.exp(-fr / fall) * 0.75 + 0.25 * np.exp(-fr / (fall * 3.5))
    fogm = 1 - smoothstep(1.0 - fog, 1.02, (yy - ridge[None, :]) / np.maximum(base_y - ridge[None, :], 8))
    streak = vnoise(hh, n, 6 * scale, rng, 45 * scale)
    from .core import fbm as _fbm
    bc = float(np.clip(hmax * 0.4, 50, 260))
    blot = smoothstep(-0.9, 1.1, _fbm(hh, n, bc, 3, rng, gain=0.45) * 0.8 + 0.25 * L.cv.nz_mid[ymin:ymax, x0:x1])
    shade = 1 + 0.5 * np.tanh(dr * 2.0)[None, :]
    field = body * grad * fogm * (0.45 + 0.55 * blot + 0.18 * streak) * shade
    if speed is None:
        speed = max(250.0, (x1 - x0) / max(0.5, (t1 - t0) * 0.6))
    seeds = [(px, base_y - ph) for (px, ph, pw) in peaks]
    if wash > 0:
        wl.wash(x0, ymin, field, pig, dens=wash, t0=t0 + 0.1 * (t1 - t0), seeds=seeds, speed=speed,
                lo=0.0, hi=1.05, warp=0.08, edge=0.35, edge_blur=4, gran=0.4)

    def ridge_at(x):
        return float(np.interp(x, X, ridge))

    # 勾：山脊轮廓，断续、粗细变化
    if outline > 0:
        segs = []
        x = x0 + rng.uniform(0, 30)
        while x < x1 - 20:
            ln = rng.uniform(90, 320) * scale
            xe = min(x1 - 2, x + ln)
            segs.append((x, xe))
            x = xe + rng.uniform(-10, 25) * scale
        tt = t0
        ts = (t1 - t0) * 0.45 / max(1, len(segs))
        for (xa, xb) in segs:
            k = max(3, int((xb - xa) / (22 * scale)))
            px = np.linspace(xa, xb, k)
            pts = [(p, ridge_at(p) + rng.normal(0, 0.8)) for p in px]
            if hmax * 0 + (ridge_at((xa + xb) / 2) > base_y - 4):
                continue
            L.stroke(pts, outline_w * scale * rng.uniform(0.6, 1.25), ink=outline * rng.uniform(0.75, 1.1),
                     pig=pig, t0=tt, dur=ts * 1.6, dry=0.35, wet=0.45, taper=(0.15, 0.4), start_w=0.6,
                     end_w=0.12, rough=0.3)
            tt += ts
    # 主峰向下的结构线
    for (px, ph, pw) in peaks:
        for _ in range(contours):
            sx = px + rng.normal(0, pw * 0.25)
            if not (x0 < sx < x1):
                continue
            sy = ridge_at(sx) + rng.uniform(4, 20) * scale
            lh = (base_y - sy) * rng.uniform(0.35, 0.75)
            if lh < 15:
                continue
            side = 1 if sx > px else -1
            pts = [(sx, sy)]
            for j in range(1, 5):
                pts.append((sx + side * lh * 0.18 * j * rng.uniform(0.6, 1.3), sy + lh * j / 4))
            L.stroke(pts, 1.8 * scale * rng.uniform(0.7, 1.3), ink=outline * 0.55, pig=pig,
                     t0=t0 + (t1 - t0) * rng.uniform(0.25, 0.6), dur=0.5, dry=0.55, wet=0.3,
                     taper=(0.1, 0.5))
    # 皴：披麻皴，顺坡长线
    if cun > 0:
        nb = int(cun * (x1 - x0) / 30 * (np.mean(H) / 160 + 0.25))
        wts = np.maximum(H, 1) ** 1.3
        wts /= wts.sum()
        bx = rng.choice(np.arange(n), size=nb, p=wts) + x0
        order = np.argsort(bx + rng.normal(0, (x1 - x0) * 0.08, nb))
        for rank, i in enumerate(order):
            x = float(bx[i])
            ri = ridge_at(x)
            hloc = base_y - ri
            if hloc < 12:
                continue
            f = rng.beta(1.2, 2.8) * 0.8
            d = float(np.interp(x, X, dr))
            dx = np.clip(d * 1.2, -1.3, 1.3)
            vec = np.array([dx, 1.0])
            vec /= np.linalg.norm(vec)
            perp = np.array([vec[1], -vec[0]])
            ln0 = rng.uniform(30, 110) * scale * (0.6 + 0.6 * (1 - f))
            bend = rng.normal(0, 0.22)
            tt = t0 + (t1 - t0) * (0.25 + 0.7 * rank / max(1, nb))
            k = int(rng.integers(3, 7))
            for j in range(k):
                off = (j - k / 2) * rng.uniform(3.0, 6.0) * scale
                sx = x + perp[0] * off
                rr = ridge_at(sx)
                sy = rr + 3 + f * (base_y - rr) + rng.normal(0, 4) + perp[1] * off
                if sy < rr + 2:
                    continue
                ln = ln0 * rng.uniform(0.6, 1.15)
                pts = []
                for q in range(4):
                    tj = q / 3
                    ang = bend * (tj - 0.3)
                    ca, sa = math.cos(ang), math.sin(ang)
                    v = np.array([vec[0] * ca - vec[1] * sa, vec[0] * sa + vec[1] * ca])
                    pts.append((sx + v[0] * ln * tj, sy + v[1] * ln * tj))
                dk = cun_ink * rng.uniform(0.55, 1.2) * (1.15 - 0.6 * f)
                L.stroke(pts, cun_w * scale * rng.uniform(0.6, 1.3), ink=dk, pig=pig, t0=tt + 0.05 * j,
                         dur=rng.uniform(0.2, 0.4), dry=rng.uniform(0.45, 0.8), wet=0.3,
                         taper=(0.2, 0.55), start_w=0.5, rough=0.35)
    # 点苔
    if dots > 0:
        for (px, ph, pw) in peaks:
            k = int(dots * rng.integers(5, 14))
            for _ in range(k):
                x = px + rng.normal(0, pw * 0.45)
                if not (x0 < x < x1):
                    continue
                y = ridge_at(x) + rng.uniform(-1, 6) * scale
                L.dot(x, y, rng.uniform(1.4, 3.2) * scale, ink=0.95, pig=INK,
                      t0=t0 + (t1 - t0) * rng.uniform(0.75, 1.0), ang=rng.uniform(-0.4, 0.4) + math.pi / 2,
                      elong=rng.uniform(1.0, 1.8))
    if trees > 0:
        k = int(trees * (x1 - x0) / 40)
        for _ in range(k):
            x = rng.uniform(x0, x1)
            y = ridge_at(x)
            if base_y - y < 20:
                continue
            tiny_tree(L, x, y + rng.uniform(0, 6), rng.uniform(7, 14) * scale,
                      t0 + (t1 - t0) * rng.uniform(0.7, 1.0))
    return X, ridge


def tiny_tree(L: Layer, x, y, h, t0, ink=0.85):
    rng = L.rng
    L.stroke([(x, y), (x + rng.normal(0, 1), y - h)], max(0.8, h * 0.07), ink=ink, t0=t0, dur=0.12,
             dry=0.2, taper=(0.05, 0.6))
    for j in range(int(rng.integers(3, 6))):
        yy = y - h * (0.35 + 0.65 * j / 5)
        L.dot(x + rng.normal(0, h * 0.18), yy, h * rng.uniform(0.12, 0.22), ink=ink * 0.9, t0=t0 + 0.05 * j,
              ang=rng.uniform(-0.3, 0.3), elong=2.2)


# --------------------------------------------------------------------------- water
def river(wash_l: Layer, line_l: Layer, pts, width, *, t0=0.0, t1=3.0, pig=INDIGO * 0.6 + INK * 0.4, dens=0.16,
          bank_ink=0.55, ripples=1.0, bank_w=1.6, step=4.0, ripple_ink=0.3, speed=None):
    """河：两岸断续勾线 + 淡花青染 + 水纹。width 可为标量或 (s∈0..1)->宽度 的函数。"""
    rng = line_l.rng
    P = catmull(pts, step)
    tan = np.gradient(P, axis=0)
    tan /= np.linalg.norm(tan, axis=1, keepdims=True) + 1e-9
    nrm = np.c_[-tan[:, 1], tan[:, 0]]
    M = len(P)
    u = np.linspace(0, 1, M)
    wv = np.array([width(x) for x in u]) if callable(width) else np.full(M, float(width))
    wv = wv * (1 + 0.12 * fbm1d(M, 30, 3, rng))
    left = P + nrm * wv[:, None] * 0.5
    right = P - nrm * wv[:, None] * 0.5
    poly = np.vstack([left, right[::-1]])
    x0, y0 = np.floor(poly.min(0) - 30).astype(int)
    x1, y1 = np.ceil(poly.max(0) + 30).astype(int)
    m = np.zeros((y1 - y0, x1 - x0), np.uint8)
    cv2.fillPoly(m, [((poly - [x0, y0]) * 4).astype(np.int32)], 255, cv2.LINE_AA, shift=2)
    f = cv2.GaussianBlur(m.astype(np.float32) / 255, (0, 0), 6)
    # 时间：沿河道从上游流向下游
    yy, xx = np.mgrid[y0:y1, x0:x1]
    cl = P[::3]
    from scipy.spatial import cKDTree
    _, idx = cKDTree(cl).query(np.c_[xx.ravel(), yy.ravel()])
    tf = (t0 + (t1 - t0) * 0.7 * (idx / max(1, len(cl) - 1))).reshape(xx.shape)
    # 中间淡、近岸略深
    wash_l.wash(x0, y0, f, pig, dens=dens, tfield=tf, lo=0.15, hi=0.85, edge=0.9, edge_blur=12, gran=0.3,
                body=0.14, warp=0.3)
    for side in (left, right):
        i = 0
        while i < M - 3:
            ln = int(rng.integers(12, 60))
            j = min(M - 1, i + ln)
            seg = side[i:j + 1:2] + rng.normal(0, 0.6, (len(side[i:j + 1:2]), 2))
            if len(seg) >= 2:
                line_l.stroke(seg, bank_w * rng.uniform(0.7, 1.3), ink=bank_ink * rng.uniform(0.6, 1.1),
                              t0=t0 + (t1 - t0) * 0.7 * i / M, dur=0.35, dry=0.45, wet=0.4,
                              taper=(0.15, 0.4))
            i = j + int(rng.integers(1, 6))
    if ripples > 0:
        k = int(ripples * M * step / 30)
        for _ in range(k):
            i = int(rng.integers(2, M - 6))
            off = rng.uniform(-0.38, 0.38) * wv[i]
            ln = int(rng.integers(3, 9))
            j = min(M - 1, i + ln)
            seg = P[i:j + 1] + nrm[i:j + 1] * off
            seg = seg + nrm[i:j + 1] * (np.sin(np.linspace(0, np.pi, len(seg))) * rng.uniform(-2, 2))[:, None]
            line_l.stroke(seg, rng.uniform(0.7, 1.3), ink=ripple_ink * rng.uniform(0.5, 1.2), pig=INDIGO * 0.5 + INK * 0.5,
                          t0=t0 + (t1 - t0) * (0.4 + 0.6 * i / M), dur=0.3, dry=0.5, wet=0.2, taper=(0.3, 0.5))
    return P, wv, nrm


def water_lines(L: Layer, x0, x1, y0, y1, n, t0, t1, ink=0.25, pig=INDIGO, w=1.0):
    rng = L.rng
    for k in range(n):
        y = rng.uniform(y0, y1)
        xa = rng.uniform(x0, x1)
        ln = rng.uniform(30, 160)
        pts = [(xa + ln * j / 4, y + math.sin(j * 1.3 + k) * 2.5) for j in range(5)]
        L.stroke(pts, w * rng.uniform(0.6, 1.4), ink=ink * rng.uniform(0.5, 1.2), pig=pig,
                 t0=rng.uniform(t0, t1), dur=0.4, dry=0.5, wet=0.2, taper=(0.3, 0.5))


def mist_wash(L: Layer, x0, y0, w, h, pig, dens, t0, speed=400, cell=120, seeds=None, lo=0.35, hi=0.9):
    rng = L.rng
    f = vnoise(h, w, cell, rng) * 0.7 + vnoise(h, w, cell / 3, rng) * 0.3
    yy = np.linspace(0, 1, h)[:, None]
    xx = np.linspace(0, 1, w)[None, :]
    env = np.sin(np.pi * yy) ** 0.8 * np.sin(np.pi * np.clip(xx, 0, 1)) ** 0.5
    L.wash(x0, y0, (f * env).astype(np.float32), pig, dens=dens, t0=t0, seeds=seeds, speed=speed,
           lo=lo * 0.6, hi=hi * 0.7, edge=0.3, gran=0.3)


def ground_wash(L: Layer, x0, y0, w, h, pig, dens, t0, speed=600, seeds=None, cell=150):
    rng = L.rng
    f = vnoise(h, w, cell, rng, cell * 0.25)
    yy = np.linspace(0, 1, h)[:, None]
    env = smoothstep(0.0, 0.35, yy) * (1 - smoothstep(0.7, 1.0, yy))
    xx = np.linspace(0, 1, w)[None, :]
    env = env * smoothstep(0, 0.12, xx) * (1 - smoothstep(0.88, 1, xx))
    L.wash(x0, y0, (f * env).astype(np.float32), pig, dens=dens, t0=t0, seeds=seeds, speed=speed,
           lo=0.12, hi=0.7, edge=0.4, gran=0.35)


# --------------------------------------------------------------------------- vegetation
def willow(L: Layer, x, y, h, t0, ink=0.75, lean=0.0):
    rng = L.rng
    top = (x + lean * h * 0.3, y - h)
    L.stroke([(x, y), (x + lean * h * 0.15 + rng.normal(0, 2), y - h * 0.5), top], h * 0.05, ink=ink,
             t0=t0, dur=0.4, dry=0.45, taper=(0.05, 0.3), start_w=1.0, end_w=0.4, rough=0.4)
    for k in range(int(rng.integers(14, 22))):
        side = rng.choice([-1, 1])
        sx = top[0] + rng.normal(0, h * 0.08)
        sy = top[1] + rng.uniform(-h * 0.05, h * 0.12)
        reach = rng.uniform(0.12, 0.4) * h * side
        lift = rng.uniform(0.05, 0.15) * h
        drop = rng.uniform(0.4, 0.85) * h
        pts = [(sx, sy), (sx + reach * 0.6, sy - lift), (sx + reach, sy - lift * 0.3),
               (sx + reach * 1.12 + lean * 4, sy + drop * 0.5), (sx + reach * 1.15 + lean * 8, sy + drop)]
        L.stroke(pts, rng.uniform(0.6, 1.1), ink=ink * rng.uniform(0.35, 0.7), t0=t0 + 0.3 + 0.04 * k,
                 dur=0.45, dry=0.3, wet=0.3, taper=(0.1, 0.6))
        for j in range(int(rng.integers(4, 9))):
            q = rng.uniform(0.35, 1.0)
            px = sx + reach * (1.12 + 0.03 * q) + lean * 8 * q
            py = sy + drop * (q - 0.25) / 0.75
            L.dot(px + rng.normal(0, 1.5), py, rng.uniform(1.0, 2.0),
                  ink=ink * rng.uniform(0.25, 0.5), pig=INK * 0.6 + JADE * 0.4, t0=t0 + 0.5 + 0.04 * k,
                  ang=math.pi / 2 + rng.normal(0, 0.35), elong=3.0)


def foliage_tree(L: Layer, x, y, h, t0, ink=0.8, kind='round', pig=INK, dens=1.0):
    """杂树：干 + 枝 + 点叶团。"""
    rng = L.rng
    tw = h * 0.06
    pts = [(x, y)]
    cx, cy = x, y
    for j in range(1, 5):
        cx += rng.normal(0, h * 0.04)
        cy -= h * 0.17
        pts.append((cx, cy))
    L.stroke(pts, tw, ink=ink, t0=t0, dur=0.35, dry=0.5, taper=(0.05, 0.3), start_w=1.1, end_w=0.35, rough=0.45)
    crown = (cx, cy - h * 0.05)
    for b in range(int(rng.integers(3, 6))):
        a = -math.pi / 2 + rng.normal(0, 0.8)
        ln = h * rng.uniform(0.15, 0.35)
        sy = y - h * rng.uniform(0.45, 0.8)
        sx = float(np.interp(-sy, [-p[1] for p in pts], [p[0] for p in pts]))
        L.stroke([(sx, sy), (sx + math.cos(a) * ln * 0.6, sy + math.sin(a) * ln * 0.6 - 3),
                  (sx + math.cos(a) * ln, sy + math.sin(a) * ln)], tw * 0.45, ink=ink * 0.9,
                 t0=t0 + 0.25 + 0.05 * b, dur=0.25, dry=0.4, taper=(0.05, 0.6))
    n = int(dens * rng.integers(28, 46))
    for k in range(n):
        r = h * 0.32 * math.sqrt(rng.random())
        a = rng.uniform(0, 2 * math.pi)
        px = crown[0] + math.cos(a) * r * 1.2
        py = crown[1] + math.sin(a) * r * 0.75
        if kind == 'pine':
            L.stroke([(px - h * 0.07, py), (px + h * 0.07, py + rng.normal(0, 1))], h * 0.025, ink=ink * rng.uniform(0.6, 1.0),
                     pig=pig, t0=t0 + 0.4 + 0.02 * k, dur=0.1, dry=0.2, taper=(0.2, 0.5))
        else:
            L.dot(px, py, h * rng.uniform(0.03, 0.055), ink=ink * rng.uniform(0.5, 1.0), pig=pig,
                  t0=t0 + 0.4 + 0.02 * k, elong=rng.uniform(1.3, 2.2))


def bamboo(L: Layer, x, y, h, t0, ink=0.8, lean=0.0, w=None, leaves=1.0, leaf_ink=None, dur=1.2,
           pig=INK, leaf_scale=1.0):
    """竹：一节一节写竿，节处留白加节点，顶部及枝上写"个""介"字叶。"""
    rng = L.rng
    w = w or max(2.0, h * 0.018)
    nseg = int(rng.integers(6, 10))
    seg_h = h / nseg
    tt = t0
    pts_all = []
    for s in range(nseg):
        ya = y - s * seg_h
        yb = y - (s + 1) * seg_h + seg_h * 0.06
        xa = x + lean * (y - ya) * 0.15
        xb = x + lean * (y - yb) * 0.15
        L.stroke([(xa, ya - 1), ((xa + xb) / 2 + rng.normal(0, 0.4), (ya + yb) / 2), (xb, yb)], w * (1 - 0.25 * s / nseg),
                 ink=ink * rng.uniform(0.75, 1.0), pig=pig, t0=tt, dur=dur / nseg, dry=0.25, wet=0.5,
                 taper=(0.12, 0.12), start_w=1.25, end_w=1.15, wobble=0.03, rough=0.12, pool=0.6)
        L.stroke([(xb - w * 1.1, yb + 1), (xb + w * 1.1, yb + 0.5)], w * 0.32, ink=ink, pig=pig, t0=tt + dur / nseg,
                 dur=0.06, dry=0.1, taper=(0.3, 0.3), start_w=0.8)
        pts_all.append((xb, yb))
        tt += dur / nseg
    li = leaf_ink if leaf_ink is not None else ink
    for k, (bx, by) in enumerate(pts_all[1:]):
        last = k == len(pts_all) - 2
        if rng.random() > 0.75 * leaves and not last:
            continue
        side = rng.choice([-1, 1])
        ln = seg_h * rng.uniform(0.8, 1.6)
        ex, ey = bx + side * ln * 0.75, by - ln * 0.55
        L.stroke([(bx, by), (bx + side * ln * 0.35, by - ln * 0.35), (ex, ey)], w * 0.28, ink=ink * 0.85, pig=pig,
                 t0=tt + 0.05 * k, dur=0.2, dry=0.3, taper=(0.05, 0.4))
        for c in range(int(rng.integers(1, 3)) + (1 if last else 0)):
            cx = lerp(bx, ex, rng.uniform(0.5, 1.0))
            cy = lerp(by, ey, rng.uniform(0.5, 1.0))
            leaf_cluster(L, cx, cy, h * 0.16 * leaf_scale * rng.uniform(0.75, 1.15), tt + 0.15 + 0.05 * k, ink=li,
                         pig=pig, base_ang=(0.55 if side > 0 else math.pi - 0.55), n=int(rng.integers(3, 6)))
    return pts_all


def leaf_cluster(L: Layer, x, y, size, t0, ink=0.8, pig=INK, base_ang=0.6, n=4, spread=1.6):
    """竹叶一组："个""介"字形，叶自枝端向下垂、两头尖中间肥。"""
    rng = L.rng
    for k in range(n):
        a = base_ang + (k - (n - 1) / 2) * spread / max(1, n - 1) + rng.normal(0, 0.18)
        ln = size * rng.uniform(0.7, 1.25)
        bend = rng.normal(0, 0.18)
        p0 = (x, y)
        p1 = (x + math.cos(a) * ln * 0.45, y + math.sin(a) * ln * 0.45)
        p2 = (x + math.cos(a + bend) * ln, y + math.sin(a + bend) * ln)
        L.stroke([p0, p1, p2], size * rng.uniform(0.085, 0.12), ink=ink * rng.uniform(0.65, 1.05), pig=pig,
                 t0=t0 + 0.06 * k, dur=0.18, dry=0.12, wet=0.75, taper=(0.3, 0.6), start_w=0.15, end_w=0.02,
                 rough=0.12, pool=0.4, wobble=0.04)


def reeds(L: Layer, x0, x1, y, n, t0, t1, h=40, ink=0.5):
    rng = L.rng
    for _ in range(n):
        x = rng.uniform(x0, x1)
        hh = h * rng.uniform(0.5, 1.2)
        lean = rng.normal(0, 0.25)
        L.stroke([(x, y), (x + lean * hh * 0.4, y - hh * 0.5), (x + lean * hh, y - hh)], rng.uniform(0.7, 1.4),
                 ink=ink * rng.uniform(0.5, 1.1), t0=rng.uniform(t0, t1), dur=0.2, dry=0.3, taper=(0.05, 0.7))


# --------------------------------------------------------------------------- architecture
def hut(L: Layer, x, y, w, t0, ink=0.8, wash_l: Layer | None = None, dur=0.9, roof_pig=OCHRE):
    """茅屋：斜坡草顶(多笔短线) + 立柱 + 墙面淡赭。"""
    rng = L.rng
    rh = w * 0.42
    wh = w * 0.38
    apex = (x + rng.normal(0, 2), y - wh - rh)
    lft, rgt = (x - w * 0.62, y - wh), (x + w * 0.62, y - wh)
    st = dur / 6
    L.stroke([lft, ((lft[0] + apex[0]) / 2, (lft[1] + apex[1]) / 2 - 2), apex], w * 0.035, ink=ink, t0=t0, dur=st,
             dry=0.4, taper=(0.1, 0.2))
    L.stroke([apex, ((rgt[0] + apex[0]) / 2, (rgt[1] + apex[1]) / 2 - 2), rgt], w * 0.035, ink=ink, t0=t0 + st, dur=st,
             dry=0.4, taper=(0.1, 0.3))
    for k in range(int(w / 6)):
        q = rng.uniform(0.08, 0.92)
        px = lerp(lft[0], rgt[0], q)
        top = apex[1] + abs(px - apex[0]) / (w * 0.62) * rh
        L.stroke([(px, top + 2), (px + (px - apex[0]) * 0.08, y - wh - 1)], 0.9, ink=ink * 0.45,
                 t0=t0 + 2 * st + 0.02 * k, dur=0.12, dry=0.6, taper=(0.1, 0.5))
    for sx in (x - w * 0.45, x + w * 0.45):
        L.stroke([(sx, y - wh), (sx, y)], w * 0.028, ink=ink, t0=t0 + 3 * st, dur=st, dry=0.35)
    L.stroke([(x - w * 0.5, y), (x + w * 0.5, y)], w * 0.02, ink=ink * 0.7, t0=t0 + 4 * st, dur=st, dry=0.5)
    L.stroke([(x - w * 0.08, y - wh * 0.7), (x - w * 0.08, y)], w * 0.08, ink=ink * 0.6, t0=t0 + 5 * st, dur=st * 0.8,
             dry=0.1, taper=(0.1, 0.1), start_w=1, end_w=1)
    wl = wash_l or L
    poly = np.array([lft, apex, rgt], np.float32)
    _poly_wash(wl, poly, roof_pig, 0.35, t0 + 3 * st)
    _poly_wash(wl, np.array([(x - w * 0.45, y - wh), (x + w * 0.45, y - wh), (x + w * 0.45, y), (x - w * 0.45, y)], np.float32),
               OCHRE, 0.12, t0 + 4 * st)


def _poly_wash(L: Layer, poly, pig, dens, t0, blur=2.0, speed=300, edge=0.5, lo=0.3, hi=0.7):
    poly = np.asarray(poly, np.float32)
    x0, y0 = np.floor(poly.min(0) - 12).astype(int)
    x1, y1 = np.ceil(poly.max(0) + 12).astype(int)
    if x1 <= x0 or y1 <= y0:
        return
    m = np.zeros((y1 - y0, x1 - x0), np.uint8)
    cv2.fillPoly(m, [((poly - [x0, y0]) * 4).astype(np.int32)], 255, cv2.LINE_AA, shift=2)
    f = cv2.GaussianBlur(m.astype(np.float32) / 255, (0, 0), blur)
    c = poly.mean(0)
    L.wash(x0, y0, f, pig, dens=dens, t0=t0, seeds=[tuple(c)], speed=speed, lo=lo, hi=hi, edge=edge,
           edge_blur=4, warp=0.15)


poly_wash = _poly_wash


def hall(L: Layer, x, y, w, t0, ink=0.85, wash_l: Layer | None = None, tiers=1, dur=1.4, roof_pig=INK,
         wall_pig=None, cols=4, roof_dens=0.62):
    """木构殿堂：台基 + 柱 + 飞檐屋顶(上翘) + 浓淡墨染屋面 + 瓦垄。

    tiers>1 时，每一层上层屋顶下补短柱与淡墙洗，避免上层檐悬空。
    """
    rng = L.rng
    wl = wash_l or L
    st = dur / 7
    bh = w * 0.06
    jit = lambda v: v * rng.uniform(0.85, 1.15)
    L.stroke([(x - w * 0.56, y), (x, y + rng.normal(0, 1)), (x + w * 0.56, y)], jit(max(1.4, w * 0.014)), ink=ink,
             t0=t0, dur=st, dry=0.45, taper=(0.1, 0.25))
    L.stroke([(x - w * 0.52, y - bh), (x + w * 0.52, y - bh)], jit(max(1.0, w * 0.01)), ink=ink * 0.75, t0=t0 + st * 0.5,
             dur=st, dry=0.5)
    poly_wash(wl, [(x - w * 0.55, y), (x + w * 0.55, y), (x + w * 0.52, y - bh), (x - w * 0.52, y - bh)],
              UMBER * 0.5 + INK * 0.3, 0.3, t0 + st)
    yb = y - bh
    ch = w * 0.3
    for i in range(cols):
        cx = x - w * 0.4 + w * 0.8 * i / max(1, cols - 1)
        L.stroke([(cx, yb), (cx + rng.normal(0, 0.5), yb - ch)], jit(max(1.0, w * 0.013)), ink=ink * 0.85,
                 t0=t0 + st * (1 + 0.3 * i), dur=st, dry=0.45, taper=(0.05, 0.15))
    if wall_pig is not None:
        _poly_wash(wl, [(x - w * 0.4, yb), (x + w * 0.4, yb), (x + w * 0.4, yb - ch), (x - w * 0.4, yb - ch)],
                   wall_pig * 0.85 + INK * 0.08, 0.6, t0 + st * 2, edge=0.7)
    _poly_wash(wl, [(x - w * 0.44, yb - ch), (x + w * 0.44, yb - ch), (x + w * 0.44, yb - ch + w * 0.05),
                    (x - w * 0.44, yb - ch + w * 0.05)], INK, 0.35, t0 + st * 2.5)
    story_top = yb - ch  # beam line under the roof about to be drawn
    for tier in range(tiers):
        ww = w * (1 - 0.3 * tier)
        if tier > 0:
            # Short colonnade between lower roof and this upper roof (fixes floating eaves).
            sch = max(28.0, w * 0.18)
            # Sit on the previous ridge ledge; rise to clearly meet the upper eaves.
            base_y = story_top + w * 0.05
            col_top = base_y - sch
            ucols = max(3, cols - tier + 1)
            tt_col = t0 + st * (2.6 + tier * 1.2)
            # soft wall wash even without wall_pig, so the story reads as a solid body
            wp = wall_pig if wall_pig is not None else (UMBER * 0.35 + INK * 0.25)
            _poly_wash(wl,
                       [(x - ww * 0.38, base_y), (x + ww * 0.38, base_y),
                        (x + ww * 0.38, col_top), (x - ww * 0.38, col_top)],
                       wp * 0.75 + INK * 0.1, 0.48 if wall_pig is not None else 0.32,
                       tt_col, edge=0.6)
            for i in range(ucols):
                cx = x - ww * 0.38 + ww * 0.76 * i / max(1, ucols - 1)
                L.stroke([(cx, base_y + 1), (cx + rng.normal(0, 0.4), col_top - 1)],
                         jit(max(1.1, w * 0.015)), ink=ink * 0.95,
                         t0=tt_col + 0.03 * i, dur=st * 0.75, dry=0.4, taper=(0.05, 0.12),
                         start_w=1.05, end_w=0.85)
            # beam under the upper roof
            L.stroke([(x - ww * 0.42, col_top), (x + ww * 0.42, col_top)],
                     jit(max(1.1, w * 0.012)), ink=ink * 0.85, t0=tt_col + st * 0.5, dur=st * 0.5, dry=0.45)
            _poly_wash(wl,
                       [(x - ww * 0.42, col_top), (x + ww * 0.42, col_top),
                        (x + ww * 0.42, col_top + w * 0.04), (x - ww * 0.42, col_top + w * 0.04)],
                       INK, 0.35, tt_col + st * 0.55)
            story_top = col_top
        ry = story_top
        rh = w * 0.17
        eave_l = (x - ww * 0.64, ry - rh * 0.22)
        eave_r = (x + ww * 0.64, ry - rh * 0.22)
        ridge_l = (x - ww * 0.3, ry - rh)
        ridge_r = (x + ww * 0.3, ry - rh)
        tt = t0 + st * (3 + tier * 1.5)
        poly = [ridge_l, ridge_r, (lerp(ridge_r[0], eave_r[0], 0.6), ry - rh * 0.3), eave_r, (x, ry + 2), eave_l,
                (lerp(ridge_l[0], eave_l[0], 0.6), ry - rh * 0.3)]
        _poly_wash(wl, poly, roof_pig, roof_dens, tt + st, edge=0.8, lo=0.25, hi=0.75)
        _poly_wash(wl, [(eave_l[0] + ww * 0.08, ry - rh * 0.1), (eave_r[0] - ww * 0.08, ry - rh * 0.1), (x + ww * 0.5, ry + 2),
                        (x - ww * 0.5, ry + 2)], INK, roof_dens * 0.7, tt + st * 1.4)
        L.stroke([ridge_l, (x, ridge_l[1] + 1), ridge_r], jit(max(1.5, w * 0.022)), ink=ink * 1.1, t0=tt, dur=st, dry=0.3,
                 taper=(0.1, 0.1), start_w=1.2, end_w=1.2)
        for rp, sgn in ((ridge_l, -1), (ridge_r, 1)):
            L.stroke([(rp[0] + sgn * w * 0.012, rp[1] - w * 0.03), rp], max(1.2, w * 0.016), ink=ink, t0=tt, dur=0.1)
        L.stroke([ridge_l, (lerp(ridge_l[0], eave_l[0], 0.6), ry - rh * 0.3), eave_l, (eave_l[0] - ww * 0.05, eave_l[1] - rh * 0.3)],
                 jit(max(1.4, w * 0.018)), ink=ink, t0=tt + st, dur=st, dry=0.3, taper=(0.05, 0.55), start_w=0.8)
        L.stroke([ridge_r, (lerp(ridge_r[0], eave_r[0], 0.6), ry - rh * 0.3), eave_r, (eave_r[0] + ww * 0.05, eave_r[1] - rh * 0.3)],
                 jit(max(1.4, w * 0.018)), ink=ink, t0=tt + st, dur=st, dry=0.3, taper=(0.05, 0.55), start_w=0.8)
        L.stroke([(eave_l[0] + 4, eave_l[1] + 2), (x, ry + 2), (eave_r[0] - 4, eave_r[1] + 2)], jit(max(1.2, w * 0.014)),
                 ink=ink * 0.95, t0=tt + st * 1.5, dur=st, dry=0.35)
        nt = max(3, int(ww / 9))
        for k in range(nt):
            q = (k + 0.5) / nt
            px = lerp(eave_l[0] + ww * 0.06, eave_r[0] - ww * 0.06, q)
            dxr = abs(px - x)
            ty = ry - rh + 3 if dxr < ww * 0.3 else lerp(ry - rh, ry - rh * 0.3, (dxr - ww * 0.3) / (ww * 0.34))
            L.stroke([(px, ty + 1), (px + (px - x) * 0.02, ry)], max(0.7, w * 0.006), ink=ink * 0.6,
                     t0=tt + st * 2 + 0.01 * k, dur=0.1, dry=0.55)
        # ledge above this ridge for the next story's short columns
        story_top = ry - rh - w * 0.03
    return story_top


def wall_segment(L: Layer, x0, x1, y, h, t0, t1, ink=0.8, wash_l: Layer | None = None, crenel=True, pig=UMBER,
                 dens=0.35, bands=True, rise=False):
    """夯土城墙：横向夯层线 + 赭褐墨染 + 女墙垛口。rise=True 时自下而上"长"出来。"""
    rng = L.rng
    wl = wash_l or L
    w = int(x1 - x0)
    hh = int(h)
    f = np.ones((hh + 8, w), np.float32)
    f[:4] = 0
    f[-4:] = 0
    f = cv2.GaussianBlur(f, (0, 0), 1.5)
    tex = vnoise(hh + 8, w, 40, rng, 6)
    f = f * (0.7 + 0.5 * tex)
    if rise:
        yy = np.arange(hh + 8)[:, None] * np.ones((1, w))
        tf = t0 + (t1 - t0) * (1 - yy / (hh + 8)) + 0.15 * vnoise(hh + 8, w, 30, rng)
    else:
        xx = np.ones((hh + 8, 1)) * np.arange(w)[None, :]
        tf = t0 + (t1 - t0) * 0.6 * xx / w
    wl.wash(x0, y - hh - 4, f, pig, dens=dens, tfield=tf.astype(np.float32), lo=0.2, hi=0.8, edge=0.5, gran=0.5)
    L.stroke([(x0, y), (x1, y)], 2.2, ink=ink, t0=t0, dur=(t1 - t0) * 0.4, dry=0.4)
    if bands:
        nb = max(2, int(h / 14))
        for b in range(1, nb):
            by = y - h * b / nb
            tb = t0 + (t1 - t0) * (b / nb if rise else 0.5)
            xa = x0 + rng.uniform(0, 20)
            while xa < x1 - 20:
                xb = min(x1, xa + rng.uniform(60, 240))
                L.stroke([(xa, by + rng.normal(0, 0.5)), (xb, by + rng.normal(0, 0.8))], rng.uniform(0.7, 1.3),
                         ink=ink * rng.uniform(0.3, 0.55), t0=tb, dur=0.4, dry=0.6, wet=0.2)
                xa = xb + rng.uniform(4, 30)
    L.stroke([(x0, y - h), (x1, y - h)], 2.0, ink=ink, t0=t1 - (t1 - t0) * 0.15, dur=(t1 - t0) * 0.3, dry=0.35)
    if crenel:
        cw = max(10, h * 0.12)
        k = int((x1 - x0) / (cw * 2))
        for i in range(k):
            cx = x0 + (i + 0.5) * (x1 - x0) / k
            tt = t1 + 0.1 * i / max(1, k) * (t1 - t0)
            _poly_wash(L, [(cx - cw / 2, y - h), (cx + cw / 2, y - h), (cx + cw / 2, y - h - cw * 0.7), (cx - cw / 2, y - h - cw * 0.7)],
                       INK, 0.55 * ink, tt, blur=1.0, speed=200)


# --------------------------------------------------------------------------- figures
def figure(L: Layer, x, y, h, t0, ink=0.85, pose='walk', load=None, facing=1, pig=INK):
    """小人物：头点 + 袍身一笔 + 腿/担子。h 为身高(像素)。"""
    rng = L.rng
    hd = h * 0.11
    L.dot(x, y - h + hd, hd, ink=ink, pig=pig, t0=t0, ang=math.pi / 2, elong=1.15)
    L.stroke([(x, y - h + hd * 2.1), (x + facing * h * 0.04, y - h * 0.5), (x - facing * h * 0.02, y - h * 0.12)],
             h * 0.13, ink=ink * 0.9, pig=pig, t0=t0 + 0.08, dur=0.18, dry=0.15, wet=0.6, taper=(0.3, 0.2),
             start_w=0.45, end_w=0.9)
    if pose == 'walk':
        L.stroke([(x - h * 0.03, y - h * 0.15), (x - facing * h * 0.1, y)], h * 0.045, ink=ink, pig=pig, t0=t0 + 0.2, dur=0.08)
        L.stroke([(x + h * 0.02, y - h * 0.15), (x + facing * h * 0.11, y)], h * 0.045, ink=ink, pig=pig, t0=t0 + 0.24, dur=0.08)
    if load == 'pole':
        L.stroke([(x - h * 0.45, y - h * 0.78), (x + h * 0.45, y - h * 0.8)], h * 0.03, ink=ink, pig=pig, t0=t0 + 0.3, dur=0.12)
        for sx in (-0.42, 0.42):
            L.stroke([(x + sx * h, y - h * 0.78), (x + sx * h, y - h * 0.48)], h * 0.015, ink=ink * 0.7, pig=pig, t0=t0 + 0.35, dur=0.05)
            L.dot(x + sx * h, y - h * 0.4, h * 0.11, ink=ink * 0.8, pig=pig, t0=t0 + 0.4, ang=0, elong=1.4)
    elif load == 'basket':
        L.dot(x - facing * h * 0.12, y - h * 0.62, h * 0.12, ink=ink * 0.75, pig=pig, t0=t0 + 0.3, ang=0.3, elong=1.3)
    elif load == 'ram':
        L.stroke([(x + facing * h * 0.15, y - h * 0.95), (x + facing * h * 0.2, y - h * 0.05)], h * 0.04, ink=ink, pig=pig,
                 t0=t0 + 0.3, dur=0.1)


def rock(L: Layer, x, y, w, h, t0, ink=0.85, dur=1.2, wash=0.4, cun=1.0, pig=INK):
    """石：两三笔勾出外轮廓，斧劈皴横扫 + 墨染 + 点苔。(x,y) 为底边中点。"""
    rng = L.rng
    n = 9
    ang = np.linspace(np.pi, 0, n)
    rad = 1 + 0.18 * rng.normal(0, 1, n)
    pts = [(x + math.cos(a) * w * 0.5 * r, y - math.sin(a) * h * r * (0.75 + 0.25 * math.sin(a))) for a, r in zip(ang, rad)]
    pts[0] = (x - w * 0.5, y)
    pts[-1] = (x + w * 0.5, y)
    half = n // 2 + 1
    L.stroke(pts[:half + 1], max(2.0, w * 0.018), ink=ink, pig=pig, t0=t0, dur=dur * 0.3, dry=0.45, wet=0.5,
             taper=(0.1, 0.3), start_w=0.9, rough=0.4)
    L.stroke(pts[half - 1:], max(2.0, w * 0.016), ink=ink, pig=pig, t0=t0 + dur * 0.3, dur=dur * 0.3, dry=0.5, wet=0.5,
             taper=(0.1, 0.4), start_w=0.9, rough=0.4)
    poly = np.array(pts + [(x, y + 4)], np.float32)
    if wash > 0:
        x0, y0 = np.floor(poly.min(0) - 10).astype(int)
        x1, y1 = np.ceil(poly.max(0) + 10).astype(int)
        m = np.zeros((y1 - y0, x1 - x0), np.uint8)
        cv2.fillPoly(m, [((poly - [x0, y0]) * 4).astype(np.int32)], 255, cv2.LINE_AA, shift=2)
        f = cv2.GaussianBlur(m.astype(np.float32) / 255, (0, 0), 3)
        yy = np.linspace(0, 1, y1 - y0)[:, None]
        xx = np.linspace(0, 1, x1 - x0)[None, :]
        f = f * (0.35 + 0.65 * smoothstep(0.1, 0.9, xx)) * (0.6 + 0.4 * yy)
        L.wash(x0, y0, f, pig, dens=wash, t0=t0 + dur * 0.4, seeds=[(x + w * 0.3, y - h * 0.5)], speed=w * 1.2,
               lo=0.05, hi=0.8, edge=0.5, gran=0.5)
    for k in range(int(cun * w / 12)):
        px = x + rng.uniform(-0.4, 0.45) * w
        top = y - h * 0.9 * (1 - (2 * (px - x) / w) ** 2) ** 0.5
        py = rng.uniform(top + 6, y - 4)
        ln = rng.uniform(0.1, 0.25) * w
        L.stroke([(px, py), (px + ln * 0.6, py + ln * 0.35), (px + ln, py + ln * 0.8)], rng.uniform(1.5, 4.0) * w / 200,
                 ink=ink * rng.uniform(0.4, 0.9), pig=pig, t0=t0 + dur * (0.5 + 0.5 * k / max(1, w / 12)), dur=0.15,
                 dry=0.7, wet=0.2, taper=(0.1, 0.6), start_w=1.0, rough=0.5)
    for k in range(int(rng.integers(4, 9))):
        a = rng.uniform(0.2, np.pi - 0.2)
        L.dot(x + math.cos(a) * w * 0.45, y - math.sin(a) * h * 0.95, rng.uniform(2, 3.5) * max(1, w / 220), ink=0.95,
              t0=t0 + dur, ang=math.pi / 2)


def banner(L: Layer, x, y, h, t0, ink=0.9, flag=0.5, wave=0.0, pig=INK):
    """无字黑旗：旗杆 + 飘动的旗面墨染。"""
    rng = L.rng
    L.stroke([(x, y), (x + rng.normal(0, 1), y - h)], max(1.2, h * 0.015), ink=ink, pig=pig, t0=t0, dur=0.3, dry=0.2,
             taper=(0.02, 0.1))
    fw, fh = h * flag, h * 0.32
    ph = rng.uniform(0, 6) + wave
    top = [(x + fw * q, y - h + math.sin(q * 4 + ph) * fh * 0.08) for q in np.linspace(0, 1, 6)]
    bot = [(x + fw * q * 0.9, y - h + fh * (1 - 0.25 * q) + math.sin(q * 4 + ph + 0.6) * fh * 0.1) for q in np.linspace(1, 0, 6)]
    poly_wash(L, top + bot, pig, 0.95 * ink, t0 + 0.25, blur=1.5, speed=h * 3, edge=0.6)
    L.stroke(top, max(1.0, h * 0.01), ink=ink, pig=pig, t0=t0 + 0.25, dur=0.25, dry=0.3)


def boat(L: Layer, x, y, w, t0, ink=0.85, sail=False, pig=INK):
    rng = L.rng
    L.stroke([(x - w * 0.5, y - w * 0.08), (x - w * 0.3, y + w * 0.04), (x + w * 0.3, y + w * 0.04), (x + w * 0.52, y - w * 0.1)],
             max(1.5, w * 0.045), ink=ink, pig=pig, t0=t0, dur=0.3, dry=0.25, taper=(0.15, 0.3))
    L.stroke([(x - w * 0.22, y - w * 0.02), (x - w * 0.15, y - w * 0.16), (x + w * 0.15, y - w * 0.16), (x + w * 0.2, y - w * 0.02)],
             max(1.0, w * 0.025), ink=ink * 0.8, pig=pig, t0=t0 + 0.3, dur=0.25, dry=0.4)
    if sail:
        L.stroke([(x, y - w * 0.05), (x, y - w * 0.75)], max(1, w * 0.018), ink=ink, pig=pig, t0=t0 + 0.4, dur=0.2)
        poly_wash(L, [(x + 2, y - w * 0.72), (x + w * 0.28, y - w * 0.6), (x + w * 0.25, y - w * 0.2), (x + 2, y - w * 0.18)],
                  OCHRE * 0.4 + INK * 0.3, 0.5, t0 + 0.5, blur=1.2)
    L.stroke([(x + w * 0.45, y - w * 0.05), (x + w * 0.75, y + w * 0.25)], max(0.8, w * 0.012), ink=ink * 0.7, pig=pig,
             t0=t0 + 0.6, dur=0.15)
    for k in range(3):
        L.stroke([(x - w * 0.6 + k * 6, y + w * 0.1 + k * 3), (x - w * (0.9 + 0.15 * k), y + w * 0.12 + k * 3)],
                 0.8, ink=0.25, pig=INDIGO, t0=t0 + 0.7, dur=0.2, dry=0.5)


def ox(L: Layer, x, y, h, t0, ink=0.85, facing=1, pig=INK):
    """牛：墨块躯干 + 四腿 + 弯角。"""
    rng = L.rng
    bl = h * 1.5
    L.stroke([(x - facing * bl * 0.5, y - h * 0.62), (x, y - h * 0.7), (x + facing * bl * 0.45, y - h * 0.6)], h * 0.32,
             ink=ink * 0.8, pig=pig, t0=t0, dur=0.25, dry=0.1, wet=0.8, taper=(0.3, 0.3), start_w=0.7, end_w=0.6)
    hx = x + facing * bl * 0.62
    L.dot(hx, y - h * 0.62, h * 0.17, ink=ink, pig=pig, t0=t0 + 0.2, ang=0.4 * facing, elong=1.6)
    L.stroke([(hx - facing * h * 0.05, y - h * 0.8), (hx + facing * h * 0.1, y - h * 0.98), (hx + facing * h * 0.22, y - h * 0.92)],
             h * 0.04, ink=ink, pig=pig, t0=t0 + 0.3, dur=0.1)
    for k, lx in enumerate((-0.42, -0.28, 0.25, 0.38)):
        px = x + facing * bl * lx
        L.stroke([(px, y - h * 0.5), (px + rng.normal(0, h * 0.03), y)], h * 0.06, ink=ink, pig=pig, t0=t0 + 0.3 + 0.03 * k,
                 dur=0.08, taper=(0.05, 0.4))
    L.stroke([(x - facing * bl * 0.52, y - h * 0.65), (x - facing * bl * 0.62, y - h * 0.3)], h * 0.025, ink=ink, pig=pig,
             t0=t0 + 0.45, dur=0.1)


def cypress(L: Layer, x, y, h, t0, ink=0.9, dur=2.0, w=None, pig=INK, lean=0.0):
    """古柏：扭曲粗干(干笔皴擦) + 层层墨团的柏叶。"""
    rng = L.rng
    w = w or h * 0.06
    pts = []
    cx, cy = x, y
    for j in range(7):
        pts.append((cx, cy))
        cx += rng.normal(0, w * 0.25) + lean * h * 0.02
        cy -= h * 0.12
    for side in (-1, 1):
        sp = [(px + side * w * 0.5 * (1 - 0.5 * j / 7), py) for j, (px, py) in enumerate(pts)]
        L.stroke(sp, max(1.5, w * 0.12), ink=ink, pig=pig, t0=t0 + (0 if side < 0 else 0.15), dur=dur * 0.3, dry=0.55,
                 wet=0.3, taper=(0.02, 0.3), start_w=1.0, rough=0.5)
    for k in range(int(h / 10)):
        q = rng.uniform(0, 0.85)
        i = int(q * 6)
        px, py = pts[i]
        L.stroke([(px - w * 0.4, py - rng.uniform(0, h * 0.1)), (px + w * rng.uniform(-0.1, 0.3), py - h * rng.uniform(0.05, 0.18))],
                 max(1.0, w * 0.08), ink=ink * 0.6, pig=pig, t0=t0 + dur * 0.2, dur=0.2, dry=0.75, wet=0.1, rough=0.5)
    poly_wash(L, [(p[0] - w * 0.45, p[1]) for p in pts] + [(p[0] + w * 0.45, p[1]) for p in pts[::-1]], pig, 0.25, t0 + dur * 0.2,
              blur=2, speed=h)
    top = pts[-1]
    nclump = int(rng.integers(6, 10))
    for c in range(nclump):
        q = c / max(1, nclump - 1)
        cyc = lerp(y - h * 0.4, top[1] - h * 0.05, q)
        cxc = float(np.interp(-cyc, [-p[1] for p in pts], [p[0] for p in pts])) + rng.normal(0, h * 0.05)
        rr = h * rng.uniform(0.09, 0.16) * (1.1 - 0.4 * q)
        sx = cxc + rng.choice([-1, 1]) * rr * 0.6
        tt = t0 + dur * (0.35 + 0.55 * q)
        f_w, f_h = int(rr * 3.2), int(rr * 1.9)
        f = vnoise(f_h, f_w, max(3, rr * 0.25), rng)
        yy = np.linspace(-1, 1, f_h)[:, None]
        xx = np.linspace(-1, 1, f_w)[None, :]
        env = np.clip(1 - (xx ** 2 + (yy * 1.2) ** 2), 0, 1) ** 0.6
        L.wash(sx - f_w / 2, cyc - f_h / 2, (f * env).astype(np.float32), pig, dens=0.85 * ink, t0=tt, seeds=[(sx, cyc)],
               speed=rr * 4, lo=0.25, hi=0.55, edge=0.7, gran=0.5, warp=0.3)
        for d in range(int(rr / 2)):
            a = rng.uniform(0, 2 * np.pi)
            r = rr * math.sqrt(rng.random())
            L.dot(sx + math.cos(a) * r * 1.4, cyc + math.sin(a) * r * 0.75, rng.uniform(1.5, 3.2) * h / 500,
                  ink=ink * rng.uniform(0.7, 1.1), pig=pig, t0=tt + 0.2, elong=1.5)
