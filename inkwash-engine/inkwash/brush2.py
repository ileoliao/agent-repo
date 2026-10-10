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
    'cang': (0.85, 0.10, 1.0, 0.55),    # 藏锋：逆入回转，圆钝饱满，起笔略重
    'lu': (0.08, 0.16, 0.0, 0.0),       # 露锋：尖入，斜切
    None: (None, None, 0.35, 0.15),
}
EXIT = {   # (end_w, ramp, cap, pool, swell)
    'hui': (0.75, 0.10, 1.0, 0.5, 1.0),   # 回锋：收笔回转，圆钝
    'tip': (0.03, 0.38, 0.0, 0.0, 1.0),   # 出锋：笔毛收拢成尖
    'dun': (1.0, 0.14, 1.35, 0.9, 1.28),   # 顿笔：收笔按下，略鼓、积墨
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
        if swell > 1:
            prof = prof * np.where(u > 1 - r, 1 + (swell - 1) * np.sin(np.pi * 0.5 * (1 - t)) ** 1.5, 1.0)
        else:
            prof = prof * np.where(u > 1 - r, ew + (1 - ew) * t ** 0.75, 1.0)
    p = _resolve(pressure, u)
    prof = prof * np.maximum(p, 0.05) ** 0.8
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
    wj = 1 + 0.07 * (2 * K.noise_rows(nc, s, rng.uniform(15, 45, nc), rng)[cid] - 1)    # per-clump width jitter
    off = W[None, :] * (o * fan * wj + gap + B['jit'][:, None] * 0.4 * wander)
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
    ecap = np.sqrt(np.clip(1 - o * o, 0, 1)) * (0.8 + 0.25 * rng.random((nb, 1))) * rng.uniform(0.7, 1.3, nc)[cid][:, None]
    lim0, lim1 = ecap * ce0, ecap * ce1
    act = act * (np.where(capd[None, :] > 0, (np.arange(M) < n0)[None, :] * (capd[None, :] <= lim0)
                          + (np.arange(M) >= M - n1)[None, :] * (capd[None, :] <= lim1), 1.0))
    if exit == 'tip':
        cut = L * (1 - 0.22 * EXIT['tip'][1] * np.abs(o) * rng.random((nb, 1)))
        act = act * (s[None, :] <= cut)
    if entry == 'lu':
        act = act * (s[None, :] >= (o + 1) * 0.5 * 0.35 * ENTRY['lu'][1] * L)
    a = act * (2 * W[None, :] / nb) * st * rng.uniform(0.7, 1.3, (nb, 1))     # hair thickness
    # streak tone: each clump carries a little more / less ink along long stretches -> 笔向丝理
    amp = (0.10 + 0.22 * dry) * min(bristle, 2.0) * (1 - 0.55 * min(wet, 1.0))
    stk = 1 + amp * (2 * K.noise_rows(nc, s, rng.uniform(40, 140, nc), rng)[cid] - 1) \
        + 0.5 * amp * (2 * K.noise_rows(nb, s, rng.uniform(20, 60, nb), rng) - 1)
    return _deposit(layer, X, Y, a, r, u, pl, ink, pig, wet, dry, pool, bleed, t0, dur, ease, w, rng, stk, rough)


def _deposit(layer, X, Y, a, r, u, pl, ink, pig, wet, dry, pool, bleed, t0, dur, ease, w, rng, stk, rough):
    """splat 笔毛 -> 覆盖/墨色/纸纹门限/湿边/渗化 -> 写入 layer.A / Wet / T。"""
    import cv2
    from . import brush2_ink as K
    from .core import NEVER  # noqa: F401
    cv = layer.cv
    keep = a > 1e-5
    if not keep.any():
        return
    sig = 0.45 + 0.018 * w + 0.25 * wet
    it = int(round(bleed if bleed is not None else min(12 * wet ** 1.1, 1 + 1.0 * w)))
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
    cov = 1 - np.exp(-2.2 * C)
    # edge meets paper: threshold soft coverage against fibre + edge noise -> crisp but fibre-ragged rim
    ne = cv.nz_edge[y0:y1, x0:x1]
    cov = cov * smoothstep(0.1, 0.45, cov + 0.32 * (fib - 0.5) + 0.2 * ne * (0.5 + rough))
    rim = np.clip(1 - cov, 0, 1) * (cov > 0.02)
    cov = cov * (1 - dry * 0.45 * rim ** 1.5 * smoothstep(0.45, 0.75, gr + 0.25 * (fib - 0.5)))   # scratchy dry rim
    rm = Q / (C + 1e-6)
    pm = PL / (C + 1e-6)
    # dry bristles only touch the high points of the paper (fibres + grain) -> broken, grain-aligned 飞白
    g = 0.55 * fib + 0.45 * gr
    gate = smoothstep(0.0, 0.3, rm * 1.25 - 0.18 * (1 - g) * (0.3 + dry))
    tone = ink * (0.5 + 0.5 * np.clip(rm, 0, 1.4)) * (1 + 0.38 * pm) * (SK / (C + 1e-6))
    gamp = 0.05 + 0.07 * min(wet, 1.0)                    # ink granulation, stronger in wet/pale ink
    dens = cov * gate * tone * (0.84 + 0.32 * fib) * (1 - gamp + 2 * gamp * gr)
    if pool * wet > 0:      # wet ink is pushed to the rim while drying -> slightly darker edge line
        e = np.clip(cov - cv2.GaussianBlur(cov, (0, 0), 1.6 + 0.12 * w), 0, None)
        dens = dens + ink * pool * wet * 2.6 * e * gate * (0.7 + 0.6 * fib)
    wm = cov * gate * np.clip(rm, 0, 1.5) * wet * (1 + pm)
    halo = None
    if it > 0:
        sp = K.capillary(wm, fib, gr, it, reach=0.92 + 0.1 * min(wet, 1.0))
        halo = np.clip(sp - wm, 0, None)
        dens = dens + halo * ink * 1.25 * min(1.0, 0.15 + w / 10) * (0.4 + 1.2 * fib)
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
