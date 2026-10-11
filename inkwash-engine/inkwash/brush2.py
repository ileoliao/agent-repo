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

import cv2
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
    'dun': (0.55, 0.24, 0.7, 1.2, 1.38),  # 顿笔：短促按下成结，末端略提
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
            hump = np.sin(0.5 * np.pi * np.clip(x / 0.8, 0, 1)) ** 1.5
            lift = np.clip((x - 0.8) / 0.2, 0, 1) ** 1.5
            prof = prof * np.where(u > 1 - r, (1 + (swell - 1) * hump) * (1 - 0.12 * lift), 1.0)
        elif swell > 1:
            prof = prof * np.where(u > 1 - r, 1 + (swell - 1) * np.sin(np.pi * 0.5 * (1 - t)) ** 1.5, 1.0)
        else:
            # 出锋：笔肚先保持、最后才收尖 (圆肩)，不是一条直楔形
            prof = prof * np.where(u > 1 - r, ew + (1 - ew) * t ** (0.5 if exit == 'tip' else 0.75), 1.0)
    p = _resolve(pressure, u)
    # 提按：压力对半宽更敏感，竖画的粗细才读得出来；压力曲线先平滑，变成"鼓"而不是台阶
    p = smooth1d(p, max(1.0, 1.5 * w / step))
    prof = prof * np.maximum(p, 0.05) ** 1.1
    if wobble > 0:
        # 提按的缓慢起伏 (几倍笔宽以上的尺度)，不是逐段抖动
        # 细笔 (皴线) 的提按更明显、更频：粗细变化是皴线的生气
        thin = float(np.clip((4.0 - w) / 2.0, 0, 1))
        cellw = (1 - thin) * max(6 * w, 0.3 * L) + thin * max(12.0, 0.12 * L)
        prof = prof * (1 + (0.45 + 0.9 * thin) * wobble * (noise1d(len(u), max(8, cellw / step), rng) - 0.5) * 2)
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
    """笔毛参数表。中锋：对称、笔肚(芯)饱墨；侧锋：o=-1 为笔尖(锐、浓)，o=+1 为笔根(墨少、先枯)。"""
    x = np.linspace(-1, 1, nb) + rng.normal(0, 0.25 / nb, nb)
    var = 0.06 + 0.06 * bristle
    if tip == 'ce':
        o = np.clip(x, -1, 1)
        h = (o + 1) / 2                                      # 0 笔尖 .. 1 笔根
        load0 = load * (1.12 - 0.55 * h ** 1.3)
        rate = (0.75 + 2.6 * h ** 1.8)                        # 笔根一侧先枯：侧锋的毛糙破边
        jit = 0.02 + 0.45 * rough * h ** 3                     # 笔根一侧的边随簇游移起伏，笔尖一侧齐
    else:
        o = np.sign(x) * np.abs(x) ** 1.08
        load0 = load * (1.12 - 0.32 * o * o)
        rate = 0.8 + 0.9 * o ** 4
        jit = 0.015 + 0.06 * rough * np.abs(o) ** 4
    # 笔毛成簇 (clumps): 相邻笔毛共用墨量与耗墨率 -> 飞白成顺笔向的长丝，而不是点
    sizes = rng.integers(2, max(3, nb // 10) + 1, nb)
    cid = np.repeat(np.arange(nb), sizes)[:nb]
    nc = int(cid.max()) + 1
    load0 = load0 * rng.uniform(1 - var, 1 + var, nc)[cid] * rng.uniform(0.97, 1.03, nb)
    # 簇内每根毛的耗墨也不同 -> 墨尽时一根根先后离纸，飞白是细丝而不是整簇断开
    rate = rate * rng.uniform(0.75, 1.3, nc)[cid] * rng.uniform(0.72, 1.3, nb)
    thr = 0.7 * rng.uniform(0.10, 0.24, nc)[cid] + 0.3 * rng.uniform(0.10, 0.24, nb)
    return dict(o=o, load0=load0, rate=rate, jit=jit, thr=thr, cid=cid, nc=nc)


def _gesture(P, s, nrm, W, L, w, entry, exit, wobble, tip, rng):
    """藏锋/回锋的侧向回转、顿笔笔肚偏压，以及一条很缓的手势弧 (不是逐段抖动)。"""
    d = np.zeros_like(P)
    side = 1.0 if rng.random() < 0.5 else -1.0
    if entry == 'cang':
        sig = max(0.9 * w, 4.0)
        bell = np.exp(-0.5 * ((s + 0.40 * w) / sig) ** 2)
        d += nrm * (side * 0.35 * float(W[0]) * bell)[:, None]
    if exit == 'hui':
        # 回锋：只把笔肚略向一侧压满，不拐成钩
        sig = max(1.6 * w, 6.0)
        bell = np.exp(-0.5 * ((s - L) / sig) ** 2)
        d += nrm * (-side * 0.15 * float(W[-1]) * bell)[:, None]
    if exit == 'dun':
        sig = max(0.55 * w, 3.5)
        bell = np.exp(-0.5 * ((s - (L - 0.02 * w)) / sig) ** 2)
        d += nrm * (side * 0.12 * w * bell)[:, None]
    if wobble > 0 and len(s) > 4:
        cell = max(40.0, 0.5 * max(L, 1.0))
        trem = (noise1d(len(s), cell / 0.5, rng) - 0.5) * 2.0
        amp = wobble * max(w, 1.0) * (0.35 if tip == 'zhong' else 0.2)
        d += nrm * (amp * trem)[:, None]
        thin = float(np.clip((4.0 - w) / 2.0, 0, 1))
        if thin > 0 and L > 60:     # 细长皴线：随长度的轻微波动 (约 L 的 1–2%)
            wave = (noise1d(len(s), max(30.0, L / 3.0) / 0.5, rng) - 0.5) * 2.0
            d += nrm * (thin * wobble * 0.06 * L * wave)[:, None]
    return P + d


def _dot_profile(u, w, peak=0.68):
    """点：一次按—提。笔尖落纸 (尖)、按下成肚 (peak 处最宽)、提笔时略收 -> 瓜子/水滴形。"""
    rise = np.sin(0.5 * np.pi * np.clip(u / peak, 0, 1)) ** 1.1
    fall = 1.0 - 0.18 * smoothstep(peak, 1.0, u)
    return np.maximum(w * (0.06 + 0.94 * rise) * fall, 0.3)


def bristle_stroke(layer, pts, w, ink=0.85, pig=None, t0=0.0, dur=0.6, tip='zhong', load=1.0, dry=0.15, wet=0.5,
                   pressure=None, entry=None, exit=None, pauses=(), splay=0.35, skew=None, nb=None, bleed=None,
                   taper=(0.12, 0.35), start_w=0.45, end_w=0.05, rough=0.22, wobble=0.10, step=None, bristle=1.0,
                   pool=0.35, ease=0.3, seed=None, interact=None, **_):
    """笔毛笔触。参数与经典 stroke 兼容(taper/start_w/end_w/rough/wobble/bristle/pool/ease)，另加：
    tip 'zhong' 中锋 | 'ce' 侧锋；load 初始墨量；pressure 压力(标量/数组/callable(u))；
    entry 'cang' 藏锋 | 'lu' 露锋 | None；exit 'hui' 回锋 | 'tip' 出锋 | 'dun' 顿笔 | None；
    pauses 停顿处的 u 列表(积墨)；splay 转折散锋强度；skew 侧锋笔肚斜切(默认 ce 0.22)；
    nb 笔毛数；bleed 湿图扩散步数(默认按 wet)；
    interact 破墨/积墨：与纸上已有的湿墨/干墨作用 (None = 跟随 layer.interact，默认关)。"""
    from . import brush2_ink as K
    from .core import INK
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
    dotish = L < max(2.8 * w, 16.0)
    if dotish:
        # 点：拉成约 2:1 的瓜子形 (长 ≈ 2.3w，最宽半宽 ≈ 0.68w)，方向沿给定两点
        # 每个点都不一样：长短 (1.7–2.7 倍半宽)、肚子位置、方向 ±0.25 rad、弧度、干湿
        c, t = P[len(P) // 2], tan[len(P) // 2]
        da = rng.normal(0, 0.12)
        t = np.array([t[0] * math.cos(da) - t[1] * math.sin(da), t[0] * math.sin(da) + t[1] * math.cos(da)])
        Ld = max(0.5 * L, w * rng.uniform(0.85, 1.35))
        fr = path_frame([c - t * Ld, c + t * Ld], st)
        P, s, tan, nrm, kap = fr
        L = float(s[-1])
        u = s / L
        W = _dot_profile(u, 0.68 * w * rng.uniform(0.85, 1.12) * _resolve(pressure, np.array([0.6]))[0] ** 0.3,
                         peak=rng.uniform(0.58, 0.76))
        # 按笔时手腕带一点弧
        P = P + nrm * ((0.22 * w * (rng.random() - 0.5) * 2) * np.sin(np.pi * u))[:, None]
        wet = float(wet) * float(rng.choice([rng.uniform(0.45, 0.8), rng.uniform(1.0, 1.5)], p=[0.5, 0.5]))
        pl = 0.6 * np.exp(-0.5 * ((u - 0.6) / 0.25) ** 2)
        p = np.ones_like(u)
        entry, exit, wobble = None, None, 0.0
        ce0, ce1 = 0.0, 0.9 * W[-1]
    else:
        W, pl, p = width_profile(u, s, w, rng, entry, exit, taper, start_w, end_w, wobble, pressure, pauses, L, st,
                                 tip)
        ce0 = (0.6 if (tip == 'ce' and entry == 'lu') else ENTRY[entry][2]) * W[0]
        ce1 = EXIT[exit][2] * W[-1]
    kap = smooth1d(kap, max(1.0, w * 0.8 / st))
    # ---- cap extensions (round 藏锋/回锋 heads, blunt default ends)
    n0, n1 = int(ce0 / st) + 1, int(ce1 / st) + 1
    e0 = np.arange(n0, 0, -1) * st
    e1 = np.arange(1, n1 + 1) * st
    P = np.vstack([P[0] - tan[0] * e0[:, None], P, P[-1] + tan[-1] * e1[:, None]])
    tan = np.vstack([np.repeat(tan[:1], n0, 0), tan, np.repeat(tan[-1:], n1, 0)])
    nrm = np.vstack([np.repeat(nrm[:1], n0, 0), nrm, np.repeat(nrm[-1:], n1, 0)])
    ext = lambda a: np.r_[np.full(n0, a[0]), a, np.full(n1, a[-1])]  # noqa: E731
    capd = np.r_[e0, np.zeros(len(s)), e1]                     # distance beyond the path end
    s, u, W, pl, p, kap = np.r_[-e0, s, L + e1], ext(u), ext(W), ext(pl), ext(p), ext(kap)
    P = _gesture(P, s, nrm, W, L, w, entry, exit, wobble, tip, rng)
    M = len(s)
    # ---- bristles
    if nb is None:
        nb = int(np.clip(2.3 * max(w, float(W.max())), 5, 120))     # 笔毛间距 < 1 px，鼓起处也不出缝
    if w < 4:      # 一束细笔里每笔蘸墨不同：有几根明显淡一些
        load = load * float(rng.choice([rng.uniform(0.55, 0.8), rng.uniform(0.85, 1.15)], p=[0.3, 0.7]))
    B = make_bristles(nb, tip, rng, load, rough, bristle)
    o = B['o'][:, None]
    cid, nc = B['cid'], B['nc']
    if skew is None:
        skew = 0.22 if tip == 'ce' else 0.0
    # splay: at turns the outer side fans out (by clump); pressure > 1 spreads the belly
    spl = splay * np.clip(np.abs(kap) * W * 1.3, 0, 1)
    outer = (o * np.sign(kap)[None, :]) < 0
    # 湿笔毛彼此粘连，散锋只是整体张开；干笔才按簇分叉
    sep = min(1.0, 0.2 + dry) * (1.0 - 0.7 * min(wet, 1.0))
    frnd = 1 + sep * (rng.uniform(0.3, 1.7, nc)[cid][:, None] - 1)
    fan = 1 + spl[None, :] * np.where(outer, 0.5 * np.abs(o) * frnd, 0.08) \
        + 0.12 * splay * np.clip(p - 1, 0, 1)[None, :]
    # 笔毛的缓慢游移 (簇共享, 几十 px 尺度) -> 轮廓平滑而不规则
    wander = (0.75 * K.noise_rows(nc, s, rng.uniform(40, 120, nc), rng)[cid]
              + 0.25 * K.noise_rows(nb, s, rng.uniform(25, 60, nb), rng) - 0.5) * 2
    # 不再给每根毛独立的径向到达：相邻毛错开 >1 px 会在边内留一条浅缝
    off = W[None, :] * (o * fan + B['jit'][:, None] * wander)
    al = o * W[None, :] * skew
    X = P[None, :, 0] + nrm[None, :, 0] * off + tan[None, :, 0] * al
    Y = P[None, :, 1] + nrm[None, :, 1] * off + tan[None, :, 1] * al
    # ---- ink load: each bristle depletes with deposited length (pressure, pauses consume more)
    dc = p * (1 + 1.2 * pl) * st
    cum = np.cumsum(dc) / max(np.sum(dc[n0:M - n1]), 1e-6)
    # 长细笔不该因为长度/宽度比大就断成虚线：长度项封顶
    Kd = 1.0 * dry + 0.6 * dry ** 4 + 0.30 * min(L / (40.0 * max(w, 1.0)), 1.5) / max(load, 0.05)
    r = B['load0'][:, None] * np.clip(1 - B['rate'][:, None] * Kd * np.clip(cum, 0, None)[None, :], 0, None) ** 0.8
    r = r - spl[None, :] * np.where(outer, 0.25, 0.0) * (0.3 + dry)    # outer side of a turn runs dry first
    # 断墨：簇级的低频起伏，丝要长 (60-200 px 尺度)
    skip = (K.noise_rows(nc, s, rng.uniform(60, 200, nc), rng)[cid] - 0.5) * 0.22 * min(1.0, 0.2 + dry)
    act = smoothstep(B['thr'][:, None] - 0.03, B['thr'][:, None] + 0.03, r + skip)
    # 笔毛足迹 (含墨尽/离纸的毛)：擦痕间的淡灰用；越往后越轻
    foot = np.broadcast_to(np.clip(1.15 - u, 0, 1)[None, :] * (1 - 0.5 * o * o), act.shape)
    # 纸面接触：沿每根笔毛自己的路径取纸面高度 (纤维+颗粒)，顺笔向平滑 -> 断墨成顺笔向的擦痕，不成点
    cv = layer.cv
    gx = np.clip(np.rint(X).astype(np.int64), 0, cv.w - 1)
    gy = np.clip(np.rint(Y).astype(np.int64), 0, cv.h - 1)
    hp = 0.55 * np.clip((cv.fiber[gy, gx] - 0.31) / 0.4, 0, 1) + 0.45 * np.clip(0.5 + 0.35 * cv.nz_gran[gy, gx], 0, 1)
    # 一簇毛一起离纸/落纸：簇内平均，再顺笔向平滑约 8 px
    cnt = np.bincount(cid, minlength=nc)[:, None]
    hc = np.zeros((nc, M))
    np.add.at(hc, cid, hp)
    hc = (hc / cnt).astype(np.float32)
    k = max(1, int(round(8.0 / st)))
    hc = cv2.blur(hc, (2 * k + 1, 1), borderType=cv2.BORDER_REFLECT)
    hc = (hc - hc.mean()) / (hc.std() + 1e-6)                       # 标准化：~N(0,1)
    # 细一级：每 2 根毛为一缕 (≈1–2 px 的丝)，顺笔向 15–45 px 的起伏 + 单毛的纸面高度
    sid = np.arange(nb) // 2
    ns = int(sid[-1]) + 1
    sn = (0.55 * K.noise_rows(ns, s, rng.uniform(15, 45, ns), rng)[sid]
          + 0.45 * K.noise_rows(nb, s, rng.uniform(10, 30, nb), rng) - 0.5) * 3.8
    hb = cv2.blur(hp.astype(np.float32), (2 * max(1, int(3 / st)) + 1, 1))
    hb = (hb - hb.mean()) / (hb.std() + 1e-6)
    starve = np.clip(1.0 - r / 0.55, 0, 1) * (0.4 + 0.6 * min(dry, 1.0))   # 墨少的毛才挑纸
    # 笔肚(芯)的毛压得实，墨未尽前不离纸；外缘毛先挑纸
    # 单毛的长丝：每根毛自己的 25–80 px 起伏 + 自己的断点偏移 -> 1–1.5 px 的丝，彼此在不同长度断掉
    hn = (K.noise_rows(nb, s, rng.uniform(25, 80, nb), rng) - 0.5) * 3.4 + rng.normal(0, 0.5, (nb, 1))
    # 受保护的芯：中锋是笔肚 (o≈0)，侧锋是笔尖一侧 (o≈−1)，笔根一侧最先裂开
    core = np.clip((1 - o) / 2, 0, 1) ** 1.5 if tip == 'ce' else 1 - o * o
    score = 0.3 * hc[cid] + 0.45 * sn + hn + 0.45 * hb + 1.2 * core * (1 - starve)
    # 收笔前笔毛开叉：少数几簇在末段提前离纸 -> 笔内的细裂缝 (只在干一些的笔)
    split = (rng.random(nc) < 0.22)[cid][:, None] * smoothstep(0.62, 0.95, u)[None, :] * min(1.0, 2.0 * max(dry - 0.2, 0))
    score = score - 5.0 * split * (1 - 0.5 * core)
    contact = smoothstep(-0.35, 0.35, score + 3.2 - 6.5 * starve)
    # 细笔 (皴、勾线) 只有几根毛：整根离纸会断成虚线，所以细笔的干只表现为变淡、变细
    thin = float(np.clip((4.0 - w) / 2.0, 0, 1))
    act = act * ((1 - thin) * contact + thin * (0.12 + 0.88 * contact))
    if thin > 0 and dry > 0.2:
        # 细干笔整笔挑纸：纸面高低 (沿路径) + 墨尽 -> 几处 3–10 px 的断，越往后越多
        hm = cv2.blur(hp.mean(axis=0).astype(np.float32)[None, :], (2 * max(1, int(2 / st)) + 1, 1))[0]
        g = 0.6 * (hm - hm.mean()) / (hm.std() + 1e-6) + (K.noise_rows(1, s, 22.0, rng)[0] - 0.5) * 3.4
        brk = smoothstep(-0.9, 0.5, g + 3.3 - 2.4 * dry - 1.4 * starve.mean(axis=0))
        # 外缘毛先断、芯后断 -> 断口是逐渐变细的，不是方头
        lvl = (1 - brk)[None, :] * (1.25 - 0.5 * (1 - o * o))
        act = act * (1 - thin * np.clip(lvl, 0, 1))
    # ---- ends: per-bristle cap length -> round/blunt heads; staggered ends for 出锋 / 露锋
    ecap = np.sqrt(np.clip(1 - o * o, 0, 1)) * rng.uniform(0.92, 1.05, (nb, 1))
    if entry == 'cang':
        # 藏锋头：逆入后回转，毛长短不齐，按簇参差 -> 头部有毛的纹理而不是光滑圆帽
        ecap = np.sqrt(np.clip(1 - 0.75 * o * o, 0, 1)) * rng.uniform(0.8, 1.06, nc)[cid][:, None] \
            * rng.uniform(0.93, 1.03, (nb, 1))
    if exit == 'hui':
        ecap = np.sqrt(np.clip(1 - 0.7 * o * o, 0, 1)) * rng.uniform(0.92, 1.04, (nb, 1))
    lim0, lim1 = ecap * ce0, ecap * ce1
    act = act * (np.where(capd[None, :] > 0, (np.arange(M) < n0)[None, :] * (capd[None, :] <= lim0)
                          + (np.arange(M) >= M - n1)[None, :] * (capd[None, :] <= lim1), 1.0))
    if exit == 'tip':
        cut = L * (1 - 0.15 * EXIT['tip'][1] * np.abs(o) * rng.uniform(0.5, 1.0, (nb, 1)))
        act = act * smoothstep(0.0, 2.0, cut - s[None, :])
    if entry == 'lu':
        act = act * smoothstep(0.0, 2.0, s[None, :] - (o + 1) * 0.5 * 0.3 * ENTRY['lu'][1] * L)
    a = act * (2 * W[None, :] / nb) * st * fan          # 张开处毛距变大：按张开量补足密度，不出浅缝
    foot = foot * (np.arange(M) >= n0)[None, :] * (np.arange(M) < M - n1)[None, :] * (2 * W[None, :] / nb) * st
    # ---- per-sample tone: 起笔饱和、压力重处浓
    sat = 1.0 + 0.22 * np.exp(-np.clip(s, 0, None) / max(3.0 * w, 8.0))
    # 笔向丝理：每簇/每根毛带的墨略多略少，沿笔向几十到几百 px 才变 -> 5–15% 的顺笔条纹，不是噪点
    amp = (0.05 + 0.09 * min(dry, 1.0)) * min(bristle, 2.0) * (1 - 0.6 * min(wet, 1.0))
    stk = 1 + amp * (2 * K.noise_rows(nc, s, rng.uniform(60, 200, nc), rng)[cid] - 1) \
        + 0.5 * amp * (2 * K.noise_rows(nb, s, rng.uniform(30, 90, nb), rng) - 1)
    # 笔肚：按下去的芯更湿更浓、毛稀的两侧略淡 (中锋对称；侧锋浓在笔尖一侧，已由 load0 给出)
    belly = (1 + 0.16 * (1 - o * o) * np.clip(p, 0.6, 1.5)[None, :] ** 0.8 - 0.06) if tip != 'ce' else 1.0
    if entry == 'cang':      # 头部回转处毛压得乱：条纹更明显
        head = np.exp(-0.5 * (np.clip(s, 0, None) / max(1.2 * w, 4.0)) ** 2)[None, :]
        stk = stk * (1 + 0.12 * head * (2 * K.noise_rows(nb, s, rng.uniform(4, 10, nb), rng) - 1))
    tone = (sat * np.clip(p, 0.6, 1.4) ** 0.6)[None, :] * stk * belly
    if exit == 'tip':        # 出锋：笔尖的毛带墨少，尖端淡下去 (松针、撇的尖不是硬刺)
        win = min(0.55 * L, max(4.0 * w, 20.0))
        fade = 0.6 if w < 2 else 0.35
        tone = tone * (1 - fade * smoothstep(L - win, L, s))[None, :]
    return _deposit(layer, X, Y, a, r, B['load0'][:, None], tone, u, pl, ink, pig, wet, dry, pool, bleed, t0,
                    dur, ease, w, dotish, foot, interact)


_K5 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))


def _deposit(layer, X, Y, a, r, load0, tone, u, pl, ink, pig, wet, dry, pool, bleed, t0, dur, ease, w, dotish,
             foot=None, interact=None):
    """splat 笔毛 -> 覆盖 C / 墨量 Q / 水 Wt -> 纸面高点门限 (飞白) -> 墨图/湿图 -> 顺纤维扩散 + 水线
    -> 写入 layer.A / Wet / T。"""
    import cv2
    from . import brush2_ink as K
    cv = layer.cv
    if foot is None or dry <= 0.2:
        foot = a
    keep = (a > 1e-5) | (foot > 1e-5)
    if not keep.any():
        return
    wet = float(wet)
    sig = 0.55 + 0.004 * w + 0.2 * float(np.clip(1.6 - w, 0, 1))     # 极细笔略柔，不是硬线
    it = int(round(bleed if bleed is not None else 1 + 10.0 * min(wet, 1.3) ** 1.4 * min(1.0, 0.5 + 0.05 * w)))
    ia = bool(getattr(layer, 'interact', False) if interact is None else interact)
    if ia:
        from . import pomo
    pad = int(3 * sig + it + 4) + (pomo.pad_extra(layer, ia) if ia else 0)
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
    wl = np.broadcast_to(np.clip(r / np.maximum(load0, 1e-3), 0, 1) ** 0.4, a.shape)[keep]   # 水比墨耗得慢
    uu = np.broadcast_to(u[None, :], a.shape)[keep]
    pp = np.broadcast_to(pl[None, :], a.shape)[keep]
    tt = tone[keep]
    C, Q, Wt, U, PL, TS, F = K.splat(H, Wd, xs - x0 - 0.5, ys - y0 - 0.5,
                                     [av, av * rr, av * wl, av * uu, av * pp, av * tt, foot[keep]])
    C, Q, Wt, PL, TS = [cv2.GaussianBlur(f, (0, 0), sig) for f in (C, Q, Wt, PL, TS)]
    U = cv2.GaussianBlur(U, (0, 0), sig)
    fib = cv.fiber[y0:y1, x0:x1]
    gr = np.clip(0.5 + 0.35 * cv.nz_gran[y0:y1, x0:x1], 0, 1)
    inv = 1.0 / (C + 1e-6)
    rm, wm, pm, tm = Q * inv, Wt * inv, PL * inv, TS * inv
    tm = np.where(C > 0.05, tm, 1.0)
    # 覆盖：平滑的抗锯齿边，不用噪声啃边
    # 纸面吸墨不匀：纤维/颗粒让轮廓在 1 px 尺度上进出 (不是噪声啃边，幅度只有覆盖阈值的一小部分)
    h = np.clip(0.55 * (fib - 0.31) / 0.4 + 0.45 * gr, 0, 1)
    cov = K.smoothstep(0.12, 0.42, C + 0.12 * (h - 0.5))
    # 飞白：只有笔毛墨少的地方 + 纸面低处才断；墨足时纸纹不起作用
    gate = K.smoothstep(0.02, 0.14, rm + 0.12 * (h - 0.5))
    paint = cov * gate
    # 擦痕之间纸面低处也沾一点淡墨
    if dry > 0.2:
        # 只在真有擦痕的地方 (附近有墨丝) 才蹭出淡灰，不在笔外留一块影子
        near = K.smoothstep(0.08, 0.35, cv2.GaussianBlur(paint, (0, 0), 2.0))
        hull = K.smoothstep(0.1, 0.5, cv2.GaussianBlur(F, (0, 0), 1.0)) * near
        paint = paint + (1 - paint) * hull * (0.08 + 0.40 * h ** 2) * min(dry, 1.0)   # 枯毛只蹭到纸面高点
    # 墨图：墨量越多越浓 (含起笔饱和 tone)，积墨处更浓
    base = 0.52 + 0.22 * min(dry, 1.0)            # 枯笔剩下的毛仍是浓墨 (焦墨丝)，不淡成灰
    Pm = 1.15 * ink * paint * (base + (1 - base) * np.clip(rm, 0, 1.25)) * tm * (1 + 0.45 * np.clip(pm, 0, 1.5))
    # 低频浓淡 (几十 px 的云状)，没有高频颗粒
    # 纸的吸墨不匀：低频斑驳 (几十–几百 px 的云状，约 ±9%)，不是盐粒噪声
    Pm *= 1.0 + 0.07 * np.clip(cv.nz_mid[y0:y1, x0:x1], -1.5, 1.5) + 0.05 * np.clip(cv.nz_low[y0:y1, x0:x1], -1.5, 1.5)
    Pm *= 1.0 + 0.03 * min(wet, 1.0) * (gr - 0.5) * 2
    # "吃进纸里"：中间调里透出纸纤维 (浓墨处几乎看不出)
    fn = np.clip((fib - 0.31) / 0.4, 0, 1)
    Pm *= 1.0 + 0.16 * (fn - 0.35) * (1.0 - K.smoothstep(0.45, 1.1, Pm))
    # 湿图
    Wm = paint * np.clip(wm, 0, 1.2) * wet * (1 + 0.6 * np.clip(pm, 0, 1.5))
    # 湿笔里水把颜料抹匀：笔内的簇间浓淡差随 wet 被拉平 (干笔保留丝理)
    lev = min(wet, 1.2) * (1.0 - 0.6 * min(dry, 1.0))
    if lev > 0.05:
        sg = 0.5 + 0.45 * w * lev
        Pb = cv2.GaussianBlur(Pm, (0, 0), sg)
        pb = cv2.GaussianBlur(paint, (0, 0), sg)
        f = 0.9 * min(lev, 1.0)
        Pm = (1 - f) * Pm + f * paint * Pb / (pb + 1e-4)
    dens = Pm
    mob = 0.22 + 0.18 * min(wet, 1.0)
    if ia:
        # 破墨：读纸面此刻的湿度与旧墨；旧水让新墨走得更远 (笔上的墨碰到纸上的水就混进去)
        sl = (slice(y0, y1), slice(x0, x1))
        tnow = pomo.now(layer, t0)
        ctx, cond_ia, it, mob_add = pomo.prepare(layer, sl, tnow, K.conductance(fib, gr), it, wet, paint)
        Wm = Wm + paint * ctx['Wold']
        mob = mob + mob_add
        Wf = Wm
    if it > 0 and (wet > 0.04 or (ia and float(ctx['wo'].max()) > 0.05)):
        cond = cond_ia if ia else K.conductance(fib, gr)
        Wf, Pf, Wmax = K.diffuse(Wm, Pm, cond, it, mob=mob,
                                  keep=0.80 + 0.12 * min(wet, 1.0))
        # 渗出只向外加：芯内保持原墨，纸面上多出的那部分是淡的羽状晕
        halo = np.clip(Pf - Pm, 0, None) * (1.0 - paint)
        if ia:      # 湿破湿：旧湿区里的交界是软的渐变 (5–15 px)，只有碰到干纸处才保留破碎毛边
            Pm, halo = pomo.soften(ctx, Pm, halo, w)
        # 水线：湿区边缘干时积墨 (Curtis edge darkening)，作用在芯与晕的外沿
        wmask = K.smoothstep(0.04, 0.25, Wm)
        ed = K.edge_darkening(wmask, 1.2 + 0.05 * w + 0.6 * min(wet, 1.0))
        kd = (0.25 + 0.6 * pool) * min(wet, 1.2) * (0.6 if dotish else 1.0)
        if ia:      # 积墨：干的旧墨上，新层的边积得更重
            kd = kd * pomo.edge_boost(ctx)
        dens = (Pm + halo) * (1.0 + kd * ed)
    if ia:
        dens = dens + pomo.layer_edge(ctx, paint, Pm, w)
    # 纤维毛边：轮廓外 2 px 内，只在纤维脊上吸进一点墨 (2 倍放大才看得出)，干笔几乎没有
    ring = np.clip(cv2.dilate(paint, _K5) - paint, 0, None)
    fz = ring * K.smoothstep(0.5, 0.75, fib) * (0.35 + 0.65 * min(1.0, 2 * wet)) * (1 - 0.7 * min(dry, 1.0))
    dens = dens + 0.45 * fz * cv2.dilate(Pm, _K5)
    dens = np.clip(dens, 0, None).astype(np.float32)
    um = U * inv
    if it > 0:
        Cb = cv2.GaussianBlur(C, (0, 0), 1.0 + it * 0.6)
        ub = cv2.GaussianBlur(U, (0, 0), 1.0 + it * 0.6) / (Cb + 1e-6)
        um = np.where(C > 0.02, um, ub + 0.06)
    um = np.clip(um, 0, 1.2)
    ue = (1 - ease) * um + ease * (0.5 - 0.5 * np.cos(np.pi * np.clip(um, 0, 1)))
    Tp = (t0 + dur * ue).astype(np.float32)
    layer.A[y0:y1, x0:x1] += dens[..., None] * pig
    layer.Wet[y0:y1, x0:x1] += dens * (wet * 0.35)
    T = layer.T[y0:y1, x0:x1]
    np.copyto(T, np.where(dens > 0.004, np.minimum(T, Tp), T).astype(np.float32))
    if ia:
        dOld = pomo.apply(layer, ctx, Wf, Pm, dens, cond_ia, w)
        pomo.recolor(layer, sl, dOld)
        # 被推开的墨在这一笔之后才出现
        np.copyto(T, np.where(dOld > 0.004, np.minimum(T, np.float32(t0 + dur)), T).astype(np.float32))
