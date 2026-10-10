"""毛笔模型 (bristle brush)：opt-in 的"笔毛"笔触，`Layer.stroke(..., model='bristle')` 调用。

思路 (Strassmann 1986 hairy brush + 简化的 MoXi 纤维渗化)：
  笔 = nb 根笔毛，每根有横向偏移 o∈[-1,1]、自己的墨量 r_b、耗墨速率与断墨阈值；
  每根笔毛沿自己的路径 P(s) + n·o·W(s)(+散锋/抖动) 以亚像素双线性 splat 落墨；
  墨量随落墨距离指数递减，低于阈值即断 → 沿笔向的飞白丝；
  splat 结果经饱和(覆盖) → 纸纹门限(枯笔只沾纸面高点) → 湿笔边缘积墨 → 顺纤维渗化。
w 与经典笔触相同：半宽(像素)。
"""
from __future__ import annotations

import math

import numpy as np

from .core import catmull, noise1d, smoothstep


def _resolve(v, u, default=1.0):
    """pressure 等参数：None / 标量 / 数组(按 u 插值) / callable(u)。"""
    if v is None:
        return np.full_like(u, default)
    if callable(v):
        return np.asarray(v(u), np.float64) * np.ones_like(u)
    a = np.asarray(v, np.float64)
    if a.ndim == 0:
        return np.full_like(u, float(a))
    return np.interp(u, np.linspace(0, 1, len(a)), a)


def path_frame(pts, step):
    """稠密路径 + 弧长 + 切/法向 + 平滑曲率。"""
    P = catmull(pts, step)
    if len(P) < 2:
        return None
    s = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
    tan = np.gradient(P, axis=0)
    tan /= (np.linalg.norm(tan, axis=1, keepdims=True) + 1e-9)
    nrm = np.c_[-tan[:, 1], tan[:, 0]]
    th = np.unwrap(np.arctan2(tan[:, 1], tan[:, 0]))
    kap = np.gradient(th) / max(step, 1e-3)
    return P, s, tan, nrm, kap


def smooth1d(x, sig):
    if sig < 0.5 or len(x) < 3:
        return x
    r = int(3 * sig)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sig) ** 2)
    k /= k.sum()
    return np.convolve(np.pad(x, r, mode='edge'), k, mode='valid')


ENTRY = {  # (start_w, ramp, cap, pool)   cap: 0 尖 / 1 圆头
    'cang': (0.94, 0.11, 0.62, 0.75),   # 藏锋：逆入，钝跟而不是正圆头，起笔积墨
    'lu': (0.08, 0.16, 0.0, 0.0),       # 露锋：尖入，斜切
    None: (None, None, 0.35, 0.15),
}
EXIT = {   # (end_w, ramp, cap, pool, swell)
    'hui': (0.80, 0.13, 0.78, 0.62, 1.10),  # 回锋：收笔回转，略鼓、不收尖
    'tip': (0.03, 0.38, 0.0, 0.0, 1.0),     # 出锋：笔毛收拢成尖
    'dun': (0.55, 0.11, 0.42, 1.45, 2.05),  # 顿笔：短促按下成结，末端略提
    None: (None, None, 0.25, 0.1, 1.0),
}


def width_profile(u, s, w, rng, entry, exit, taper, start_w, end_w, wobble, pressure, pauses, L, step, tip='zhong'):
    """半宽 W(s)、积墨权重 pool(s)、压力 p(s)。"""
    e_sw, e_r, _, e_pool = ENTRY[entry]
    if tip == 'ce' and entry == 'lu':
        e_sw = 0.5                       # 侧锋露锋：斜切入纸，不是尖刺
    x_ew, x_r, _, x_pool, swell = EXIT[exit]
    a = taper[0] if e_r is None else e_r
    r = taper[1] if x_r is None else x_r
    sw = start_w if e_sw is None else e_sw
    ew = end_w if x_ew is None else x_ew
    prof = np.ones_like(u)
    if entry == 'cang':
        prof += 0.14 * np.exp(-0.5 * (s / max(1.5 * w, 2)) ** 2)
    if exit == 'hui':
        prof += 0.10 * np.exp(-0.5 * ((L - s) / max(1.5 * w, 2)) ** 2)
    if a > 0:
        prof = np.where(u < a, sw + (1 - sw) * np.sin(0.5 * np.pi * np.clip(u / a, 0, 1)), prof)
    if r > 0:
        t = np.clip((1 - u) / r, 0, 1)
        if exit == 'dun':
            # 顿笔：收笔前按下成结，末端略提，避免收成圆棒
            x = 1.0 - t
            hump = np.sin(np.pi * np.clip(x / 0.74, 0, 1)) ** 0.85
            lift = np.clip((x - 0.58) / 0.42, 0, 1) ** 1.15
            prof = prof * np.where(u > 1 - r, (1 + (swell - 1) * hump) * (1 - 0.42 * lift), 1.0)
        elif swell > 1:
            prof = prof * np.where(u > 1 - r, 1 + (swell - 1) * np.sin(np.pi * 0.5 * (1 - t)) ** 1.5, 1.0)
        else:
            prof = prof * np.where(u > 1 - r, ew + (1 - ew) * t ** 0.75, 1.0)
    p = _resolve(pressure, u)
    # 提按：压力对半宽更敏感，竖画的粗细才读得出来（p=0.85→约 0.82，p=1.25→约 1.31）
    prof = prof * np.maximum(p, 0.05) ** 1.28
    if wobble > 0:
        prof = prof * (1 + wobble * (noise1d(len(u), max(8, 40 / step), rng) - 0.5) * 2)
    pool = np.zeros_like(u)
    if e_pool:
        pool += e_pool * np.exp(-0.5 * (s / max(1.2 * w, 2)) ** 2)
    if x_pool:
        pool += x_pool * np.exp(-0.5 * ((L - s) / max(1.2 * w, 2)) ** 2)
    for pu in pauses or ():
        d = (s - pu * L) / max(1.6 * w, 3)
        g = np.exp(-0.5 * d * d)
        pool += 0.9 * g
        prof = prof * (1 + 0.16 * g)
    return np.maximum(w * prof, 0.3), pool, p


def make_bristles(nb, tip, rng, load, rough, bristle):
    """笔毛参数表。中锋：对称、芯部饱墨；侧锋：o=-1 为笔尖(锐、浓)，o=+1 为笔肚/笔根(散、枯)。"""
    x = np.linspace(-1, 1, nb) + rng.normal(0, 0.35 / nb, nb)
    var = 0.12 + 0.1 * bristle
    if tip == 'ce':
        o = np.clip(x, -1, 1)
        h = (o + 1) / 2                                      # 0 笔尖 .. 1 笔根
        load0 = load * (1.12 - 0.42 * h ** 1.3) * rng.uniform(1 - var, 1 + var, nb)
        rate = rng.uniform(0.65, 1.4, nb) * (0.7 + 1.6 * h ** 1.5)
        jit = (0.08 + 1.4 * rough * h ** 2) * rng.uniform(0.5, 1.5, nb)
    else:
        o = np.sign(x) * np.abs(x) ** 1.12
        load0 = load * (1.1 - 0.3 * o * o) * rng.uniform(1 - var, 1 + var, nb)
        rate = rng.uniform(0.65, 1.4, nb) * (0.75 + 1.0 * o ** 4)
        jit = (0.06 + 0.9 * rough * np.abs(o) ** 4) * rng.uniform(0.5, 1.5, nb)
    thr = rng.uniform(0.08, 0.24, nb)
    # 笔毛成簇 (clumps): 相邻笔毛共用墨量起伏/游移/断墨 -> 笔向的条纹与成片飞白
    sizes = rng.integers(2, max(3, nb // 6) + 1, nb)
    cid = np.repeat(np.arange(nb), sizes)[:nb]
    nc = int(cid.max()) + 1
    cl_load = rng.uniform(1 - 0.12 * bristle, 1 + 0.12 * bristle, nc)
    load0 = load0 * cl_load[cid]
    rate = rate * (0.35 + 0.65 * rng.uniform(0.55, 1.6, nc)[cid])
    thr = 0.3 * thr + 0.7 * rng.uniform(0.08, 0.26, nc)[cid]
    return dict(o=o, load0=load0, rate=rate, jit=jit, thr=thr, cid=cid, nc=nc)


def _gesture(P, s, nrm, W, L, w, entry, exit, wobble, tip, rng):
    """藏锋/回锋的侧向回转、顿笔笔肚偏压，以及沿法向的轻微手抖。位移相对笔宽很小。"""
    d = np.zeros_like(P)
    side = 1.0 if rng.random() < 0.5 else -1.0
    if entry == 'cang':
        sig = max(0.95 * w, 5.0)
        bell = np.exp(-0.5 * ((s + 0.40 * w) / sig) ** 2)
        d += nrm * (side * 1.25 * float(W[0]) * bell)[:, None]
    if exit == 'hui':
        sig = max(0.90 * w, 5.0)
        bell = np.exp(-0.5 * ((s - (L + 0.15 * w)) / sig) ** 2)
        d += nrm * (-side * 1.20 * float(W[-1]) * bell)[:, None]
    if exit == 'dun':
        sig = max(0.55 * w, 3.5)
        bell = np.exp(-0.5 * ((s - (L - 0.02 * w)) / sig) ** 2)
        d += nrm * (side * 0.38 * w * bell)[:, None]
    if wobble > 0 and len(s) > 4:
        cell = max(18.0, 0.22 * max(L, 1.0))
        trem = (noise1d(len(s), cell, rng) - 0.5) * 2.0
        trem2 = (noise1d(len(s), max(8.0, cell * 0.38), rng) - 0.5) * 2.0
        amp = wobble * max(w, 1.0) * (1.15 if tip == 'zhong' else 0.42)
        d += nrm * ((amp * trem + 0.35 * amp * trem2))[:, None]
    return P + d


def bristle_stroke(layer, pts, w, ink=0.85, pig=None, t0=0.0, dur=0.6, tip='zhong', load=1.0, dry=0.15, wet=0.5,
                   pressure=None, entry=None, exit=None, pauses=(), splay=0.35, skew=None, nb=None, bleed=None,
                   taper=(0.12, 0.35), start_w=0.45, end_w=0.05, rough=0.22, wobble=0.10, step=None, bristle=1.0,
                   pool=0.35, ease=0.3, seed=None, **_):
    """笔毛笔触。参数与经典 stroke 兼容(taper/start_w/end_w/rough/wobble/bristle/pool/ease)，另加：
    tip 'zhong' 中锋 | 'ce' 侧锋；load 初始墨量；pressure 压力(标量/数组/callable(u))；
    entry 'cang' 藏锋 | 'lu' 露锋 | None；exit 'hui' 回锋 | 'tip' 出锋 | 'dun' 顿笔 | None；
    pauses 停顿处的 u 列表(积墨)；splay 转折散锋强度；skew 侧锋笔肚斜切(默认 ce 0.4)；
    nb 笔毛数；bleed 渗化步数(默认按 wet)。"""
    from . import brush2_ink as K
    from .core import INK
    cv = layer.cv
    pig = INK if pig is None else pig
    rng = layer.rng if seed is None else np.random.default_rng(seed)
    st = 0.5
    fr = path_frame(pts, st)
    if fr is None:
        return
    P, s, tan, nrm, kap = fr
    L = float(s[-1])
    if L < 0.8:
        return
    u = s / L
    W, pl, p = width_profile(u, s, w, rng, entry, exit, taper, start_w, end_w, wobble, pressure, pauses, L, st, tip)
    kap = smooth1d(kap, max(1.0, w * 0.8 / st))
    # ---- cap extensions (round 藏锋/回锋 heads, blunt default ends)
    ce0 = (0.6 if (tip == 'ce' and entry == 'lu') else ENTRY[entry][2]) * W[0]
    ce1 = EXIT[exit][2] * W[-1]
    n0, n1 = int(ce0 / st) + 1, int(ce1 / st) + 1
    e0 = np.arange(n0, 0, -1) * st
    e1 = np.arange(1, n1 + 1) * st
    P = np.vstack([P[0] - tan[0] * e0[:, None], P, P[-1] + tan[-1] * e1[:, None]])
    tan = np.vstack([np.repeat(tan[:1], n0, 0), tan, np.repeat(tan[-1:], n1, 0)])
    nrm = np.vstack([np.repeat(nrm[:1], n0, 0), nrm, np.repeat(nrm[-1:], n1, 0)])
    ext = lambda a: np.r_[np.full(n0, a[0]), a, np.full(n1, a[-1])]  # noqa: E731
    capd = np.r_[e0, np.zeros(len(s)), e1]                     # distance beyond the path end
    s, u, W, pl, p, kap = np.r_[-e0, s, L + e1], ext(u), ext(W), ext(pl), ext(p), ext(kap)
    # 回转加在含笔头的整条路径上，藏锋/回锋的帽才跟着偏，而不是在直线帽之后才拐
    P = _gesture(P, s, nrm, W, L, w, entry, exit, wobble, tip, rng)
    M = len(s)
    # ---- bristles
    if nb is None:
        nb = int(np.clip(2.3 * w, 5, 90))
    B = make_bristles(nb, tip, rng, load, rough, bristle)
    o = B['o'][:, None]
    cid, nc = B['cid'], B['nc']
    if skew is None:
        skew = 0.22 if tip == 'ce' else 0.0
    # splay: at turns the outer side fans out; pressure > 1 spreads the belly
    spl = splay * np.clip(np.abs(kap) * W * 1.3, 0, 1)
    outer = (o * np.sign(kap)[None, :]) < 0
    fan = 1 + spl[None, :] * np.where(outer, 0.7 * rng.uniform(0.2, 1.8, nc)[cid][:, None], 0.12) + 0.15 * splay * np.clip(p - 1, 0, 1)[None, :]
    gap = rng.normal(0, 1, (nb, 1)) * spl[None, :] * 0.4 * outer
    wander = (0.7 * K.noise_rows(nc, s, rng.uniform(25, 70, nc), rng)[cid]
              + 0.3 * K.noise_rows(nb, s, rng.uniform(15, 40, nb), rng) - 0.5) * 2
    # 每根毛的径向到达不同：外缘毛有的探出、有的够不着，轮廓不是一条矢量线
    reach = rng.uniform(0.76, 1.24, (nb, 1))
    abs_o = np.abs(B['o'])
    jscale = (0.20 + 0.22 * min(dry, 1.15)) * (1.0 - 0.32 * min(wet, 1.0))
    wj = np.clip(1 + jscale * (0.30 + 0.70 * abs_o)[:, None]
                 * (2 * K.noise_rows(nc, s, rng.uniform(10, 32, nc), rng)[cid] - 1), 0.64, 1.42)
    # 纤维尺度的边缘毛刺。侧锋只让笔肚一侧毛，笔尖侧保持较齐
    chatter = (K.noise_rows(nb, s, rng.uniform(2.6, 6.0, nb), rng) - 0.5) * 2
    if tip == 'ce':
        fringe = np.clip((B['o'] + 0.05) / 1.05, 0, 1)
    else:
        fringe = np.clip((abs_o - 0.12) / 0.88, 0, 1)
    poke_amp = (0.40 + 0.32 * min(dry, 1.15)) * (1.0 - 0.40 * min(wet, 1.0))
    poke = np.clip(np.sign(B['o'])[:, None] * fringe[:, None] * poke_amp * chatter, -0.46, 0.46)
    off = W[None, :] * (o * reach * fan * wj + gap + B['jit'][:, None] * 0.4 * wander + poke)
    al = o * W[None, :] * skew
    X = P[None, :, 0] + nrm[None, :, 0] * off + tan[None, :, 0] * al
    Y = P[None, :, 1] + nrm[None, :, 1] * off + tan[None, :, 1] * al
    # ---- ink load: each bristle depletes with deposited length; pauses consume more
    dc = p * (1 + 1.5 * pl) * st
    cum = np.cumsum(dc) / max(np.sum(dc[n0:M - n1]), 1e-6)
    # near-linear drain (a hair holds ink until it suddenly runs out), heterogeneous per hair
    Kd = 1.6 * dry + 1.2 * dry ** 4 + L / (2 * w) / (110 * max(load, 0.05))
    r = B['load0'][:, None] * np.clip(1 - B['rate'][:, None] * Kd * np.clip(cum, 0, None)[None, :], 0, None) ** 0.8
    r = r - spl[None, :] * np.where(outer, 0.3, 0.0) * (0.3 + dry)    # outer side of a turn runs dry first
    skip = (K.noise_rows(nc, s, rng.uniform(20, 60, nc), rng)[cid] - 0.5) * 0.36 \
        + (K.noise_rows(nb, s, rng.uniform(16, 40, nb), rng) - 0.5) * 0.12
    act = smoothstep(B['thr'][:, None] - 0.04, B['thr'][:, None] + 0.04, r + skip * min(1.0, 0.3 + dry))
    # ---- ends: cap shape (round heads) + staggered bristle ends for 出锋 / 露锋
    ecap = np.sqrt(np.clip(1 - o * o, 0, 1)) * (0.55 + 0.7 * rng.random((nb, 1))) * rng.uniform(0.7, 1.35, nc)[cid][:, None]
    if entry == 'cang':
        ecap = (0.78 + 0.28 * rng.random((nb, 1))) * (1.0 - 0.22 * o * o)   # 钝跟，少出飞丝
    if exit == 'hui':
        ecap = (0.70 + 0.40 * rng.random((nb, 1))) * (1.0 - 0.18 * o * o)
    if exit == 'dun':
        ecap = (0.55 + 0.55 * rng.random((nb, 1))) * (1.0 - 0.12 * np.abs(o))
    lim0, lim1 = ecap * ce0, ecap * ce1
    act = act * (np.where(capd[None, :] > 0, (np.arange(M) < n0)[None, :] * (capd[None, :] <= lim0)
                          + (np.arange(M) >= M - n1)[None, :] * (capd[None, :] <= lim1), 1.0))
    if exit == 'tip':
        cut = L * (1 - 0.22 * EXIT['tip'][1] * np.abs(o) * rng.random((nb, 1)))
        act = act * (s[None, :] <= cut)
    if entry == 'lu':
        act = act * (s[None, :] >= (o + 1) * 0.5 * 0.35 * ENTRY['lu'][1] * L)
    # 外缘毛更细、粗细差更大；湿笔少收一点，好让渗化把它们连成羽边
    thick = rng.uniform(0.38, 1.55, (nb, 1)) * (1.18 - 0.62 * np.abs(o) * (0.30 + 0.70 * min(dry, 1.15)))
    a = act * (2 * W[None, :] / nb) * st * thick
    dotish = L < max(2.8 * w, 16.0)
    fray = 1.0
    if dotish:
        # 点：半径差很大，外缘毛有的缺、有的甩出去，不再是椭圆
        rad = rng.uniform(0.40, 1.58, (nb, 1))
        rad = np.where(rng.random((nb, 1)) < 0.16, rad * 1.45, rad)
        off = off * rad + rng.normal(0, 0.20 * max(w, 1.0), (nb, 1))
        al = al * rng.uniform(0.45, 1.45, (nb, 1)) + rng.normal(0, 0.26 * max(w, 1.0), (nb, 1))
        r = r * rng.uniform(0.62, 1.28, (nb, 1))
        rim = np.abs(o) > 0.50
        a = a * np.where(rim, rng.uniform(0.12, 1.05, (nb, 1)), 1.0)
        X = P[None, :, 0] + nrm[None, :, 0] * off + tan[None, :, 0] * al
        Y = P[None, :, 1] + nrm[None, :, 1] * off + tan[None, :, 1] * al
        fray = 1.7
        if bleed is None:
            bleed = int(min(14, 6 + 0.45 * w))
    # streak tone: each clump carries a little more / less ink along long stretches -> 笔向丝理
    amp = (0.10 + 0.22 * dry) * min(bristle, 2.0) * (1 - 0.55 * min(wet, 1.0))
    stk = 1 + amp * (2 * K.noise_rows(nc, s, rng.uniform(40, 140, nc), rng)[cid] - 1) \
        + 0.5 * amp * (2 * K.noise_rows(nb, s, rng.uniform(20, 60, nb), rng) - 1)
    return _deposit(layer, X, Y, a, r, u, pl, ink, pig, wet, dry, pool, bleed, t0, dur, ease, w, rng, stk, rough, tip, fray)


def _edge_warp(C, Q, U, PL, SK, fib, ne, gr, wet, dry, rough, tip, fray=1.0):
    """把墨芯轮廓沿法线挪开：干笔咬进纸谷，湿笔顺纤维探出，再叠加高频齿。

    只动外轮廓（邻域平均墨量低的地方），飞白丝留在芯里不被抹掉。
    d>0 表示向纸面外长（采样点朝墨芯）。"""
    import cv2
    gx = cv2.Sobel(C, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(C, cv2.CV_32F, 0, 1, ksize=3)
    gmag = np.sqrt(gx * gx + gy * gy)
    scale = float(np.percentile(gmag, 90)) + 1e-6
    edgew = np.clip(gmag / scale, 0, 1)
    inx = gx / (gmag + 1e-6)
    iny = gy / (gmag + 1e-6)
    local = cv2.GaussianBlur(C, (0, 0), 2.2)
    shell = np.clip(1.15 - local / (float(np.percentile(local, 88)) + 1e-6), 0, 1)
    k = (0.50 if tip == 'ce' else 1.0) * fray
    ridge = np.clip(fib - 0.37, 0, 0.22)
    valley = np.clip(0.40 - fib, 0, 0.22)
    d = k * (
        (6.8 + 3.2 * min(dry, 1.1)) * ne * (0.65 + 0.8 * rough)
        + (1.6 + 9.0 * min(wet, 1.2)) * ridge * 14.0
        - (2.2 + 9.5 * min(dry, 1.1)) * (1.0 - 0.50 * min(wet, 1.0)) * valley * 12.0
        + (0.8 + 2.2 * min(wet, 1.0)) * (gr - 0.5) * 3.0
    )
    d = np.clip(d, -6.0 - 5.0 * min(dry, 1.0), 3.5 + 9.0 * min(wet, 1.2))
    d = d * edgew * (0.20 + 0.80 * shell)
    h, wd = C.shape
    yy, xx = np.mgrid[0:h, 0:wd].astype(np.float32)
    mapx = np.clip(xx + inx * d, 0, wd - 1).astype(np.float32)
    mapy = np.clip(yy + iny * d, 0, h - 1).astype(np.float32)
    def warp(img):
        return cv2.remap(img, mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    return [warp(f) for f in (C, Q, U, PL, SK)]


def _deposit(layer, X, Y, a, r, u, pl, ink, pig, wet, dry, pool, bleed, t0, dur, ease, w, rng, stk, rough, tip='zhong', fray=1.0):
    """splat 笔毛 -> 覆盖/墨色/纸纹门限/湿边/渗化 -> 写入 layer.A / Wet / T。"""
    import cv2
    from . import brush2_ink as K
    from .core import NEVER  # noqa: F401
    cv = layer.cv
    keep = a > 1e-5
    if not keep.any():
        return
    # 少模糊：边缘的毛刺要留下来。湿笔的羽化交给 capillary，不靠大 sigma 涂匀
    sig = 0.30 + 0.008 * w + 0.05 * min(float(wet), 1.0)
    it = int(round(bleed if bleed is not None else min(8.0 * wet ** 1.05 + 1.2 * wet, 2.0 + 0.55 * w)))
    pad = int(3 * sig + it + 3)
    xs, ys = X[keep], Y[keep]
    x0 = int(max(0, math.floor(xs.min()) - pad))
    y0 = int(max(0, math.floor(ys.min()) - pad))
    x1 = int(min(cv.w, math.ceil(xs.max()) + pad + 1))
    y1 = int(min(cv.h, math.ceil(ys.max()) + pad + 1))
    if x1 <= x0 or y1 <= y0:
        return
    H, Wd = y1 - y0, x1 - x0
    av = a[keep]
    rr = np.clip(r, 0, None)[keep]
    uu = np.broadcast_to(u[None, :], a.shape)[keep]
    pp = np.broadcast_to(pl[None, :], a.shape)[keep]
    sk = stk[keep]
    C, Q, U, PL, SK = K.splat(H, Wd, xs - x0 - 0.5, ys - y0 - 0.5, [av, av * rr, av * uu, av * pp, av * sk])
    C, Q, U, PL, SK = [cv2.GaussianBlur(f, (0, 0), sig) for f in (C, Q, U, PL, SK)]
    fib = cv.fiber[y0:y1, x0:x1]
    gr = np.clip(0.5 + 0.35 * cv.nz_gran[y0:y1, x0:x1], 0, 1)
    ne = cv.nz_edge[y0:y1, x0:x1]
    if float(C.max()) > 1e-4:
        C, Q, U, PL, SK = _edge_warp(C, Q, U, PL, SK, fib, ne, gr, wet, dry, rough, tip, fray)
    cov0 = 1 - np.exp(-2.35 * C)
    # 轮廓本身已经按纸纹挪开，这里收成较利的墨芯，好让齿留在深色边上
    lo = 0.10 + 0.10 * min(dry, 1.0) - 0.04 * min(wet, 1.0)
    hi = lo + 0.16 + 0.06 * min(dry, 1.0)
    cov = smoothstep(lo, max(hi, lo + 0.12), cov0)
    # 干笔：纸谷再啃掉一圈，边沿成擦痕
    if dry > 0.12:
        contact = smoothstep(0.30, 0.70, 0.55 * fib + 0.45 * gr)
        edge_band = smoothstep(0.04, 0.22, cov) * (1.0 - smoothstep(0.55, 0.92, cov))
        kill = min(dry, 1.2) * (1.0 - 0.65 * min(wet, 1.0)) * edge_band * (1.0 - contact)
        cov = cov * (1.0 - 0.85 * kill)
    rm = Q / (C + 1e-6)
    pm = PL / (C + 1e-6)
    # dry bristles only touch the high points of the paper (fibres + grain) -> broken, grain-aligned 飞白
    g = 0.55 * fib + 0.45 * gr
    gate = smoothstep(0.0, 0.28, rm * 1.15 - 0.22 * (1 - g) * (0.25 + dry))
    tone = ink * (0.50 + 0.50 * np.clip(rm, 0, 1.4)) * (1 + 0.95 * np.clip(pm, 0, 1.5)) * (SK / (C + 1e-6))
    # 颗粒：淡墨、湿墨里色素结块；焦墨只留一点齿。用未裁剪的颗粒场，结块约 2px
    pale = float(np.clip(1.20 - 0.42 * min(float(ink), 1.35), 0.45, 1.35))
    gamp = (0.08 + 0.50 * min(wet, 1.15)) * pale
    raw = cv2.GaussianBlur(cv.nz_gran[y0:y1, x0:x1], (0, 0), 0.8)
    speck = np.clip(0.42 + 0.62 * raw, 0.08, 1.85)
    dens = cov * gate * tone * (0.74 + 0.52 * fib) * ((1.0 - gamp) + gamp * speck)
    if wet > 0.18:
        mid = np.clip(cv.nz_mid[y0:y1, x0:x1], -1.3, 1.3)
        dens = dens * (1.0 + (0.045 + 0.11 * min(wet, 1.0)) * mid)
    if pool * wet > 0:      # 湿墨干后把颜料推到轮廓上，边线比芯深
        e = np.clip(cov - cv2.GaussianBlur(cov, (0, 0), 1.05 + 0.05 * w), 0, None)
        dens = dens + ink * pool * (0.55 + 1.25 * min(wet, 1.2)) * e * gate * (0.60 + 0.75 * fib)
    wm = cov * gate * np.clip(rm, 0, 1.5) * wet * (1 + 0.65 * pm)
    halo = None
    if it > 0 and wet > 0.04:
        reach = max(0.28, 0.58 + 0.55 * min(wet, 1.25) - 0.22 * min(dry, 1.0))
        sp = K.capillary(wm, fib, gr, it, reach=reach)
        halo = np.clip(sp - wm, 0, None)
        dens = dens + halo * ink * (1.55 + 1.15 * min(wet, 1.0)) * np.clip(fib - 0.30, 0.05, 1.0)
        tide = np.clip(halo - cv2.GaussianBlur(halo, (0, 0), 0.95), 0, None)
        dens = dens + ink * max(pool, 0.25) * min(wet, 1.2) * 2.6 * tide * (0.45 + fib)
    dens = dens.astype(np.float32)
    um = U / (C + 1e-6)
    if halo is not None:
        Cb = cv2.GaussianBlur(C, (0, 0), 1.0 + it * 0.6)
        ub = cv2.GaussianBlur(U, (0, 0), 1.0 + it * 0.6) / (Cb + 1e-6)
        um = np.where(C > 0.02, um, ub + 0.06)
    um = np.clip(um, 0, 1.2)
    ue = (1 - ease) * um + ease * (0.5 - 0.5 * np.cos(np.pi * np.clip(um, 0, 1)))
    Tp = (t0 + dur * ue).astype(np.float32)
    layer.A[y0:y1, x0:x1] += dens[..., None] * pig
    layer.Wet[y0:y1, x0:x1] += dens * (wet * 0.6)
    T = layer.T[y0:y1, x0:x1]
    np.copyto(T, np.where(dens > 0.004, np.minimum(T, Tp), T).astype(np.float32))
