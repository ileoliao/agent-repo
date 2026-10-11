"""毛笔模型的栅格部分：亚像素 splat、逐笔毛平滑噪声、湿图/墨图的顺纤维扩散与水线积墨。

物理上的简化 (Curtis et al. 1997 watercolor; Chu & Tai 2005 MoXi)：
  笔毛把 水(W) 与 墨(P) 分别落到局部 bbox 的两张图上；
  随后若干步扩散：水按纸的传导率 (纤维脊上高 -> 顺纤维成丝) 向干处流，墨随水走但被纸纤维滤掉一部分 (mob<1)；
  每步蒸发一点；水退时颜料被带向湿区边缘 -> 边线(水线)比芯深。
"""
from __future__ import annotations

import cv2
import numpy as np


def noise_rows(n, s, cell, rng):
    """n 行彼此独立的 1D 平滑值噪声 (0..1)，在弧长 s (M,) 处取值 -> (n, M)。cell 可为 (n,) 数组。"""
    cell = np.broadcast_to(np.asarray(cell, np.float64), (n,))[:, None]
    x = (s[None, :] - s[0]) / cell + 1.0
    K = int(np.ceil(x.max())) + 3
    g = rng.random((n, K))
    i = np.floor(x).astype(np.int64)
    f = x - i
    f = f * f * (3 - 2 * f)
    rows = np.arange(n)[:, None]
    return g[rows, i] * (1 - f) + g[rows, i + 1] * f


def splat(h, w, xs, ys, weights):
    """双线性亚像素落墨：xs, ys (N,) 为缓冲区像素坐标(像素中心在整数处)；weights 为若干 (N,) 权重。"""
    x0 = np.floor(xs).astype(np.int64)
    y0 = np.floor(ys).astype(np.int64)
    fx = xs - x0
    fy = ys - y0
    idx, cw = [], []
    for dy, dx, k in ((0, 0, (1 - fx) * (1 - fy)), (0, 1, fx * (1 - fy)), (1, 0, (1 - fx) * fy), (1, 1, fx * fy)):
        xx, yy = x0 + dx, y0 + dy
        ok = (xx >= 0) & (xx < w) & (yy >= 0) & (yy < h)
        idx.append((yy * w + xx)[ok])
        cw.append((k, ok))
    I = np.concatenate(idx)
    out = []
    for wt in weights:
        ww = np.concatenate([(k * wt)[ok] for k, ok in cw])
        out.append(np.bincount(I, ww, minlength=h * w).reshape(h, w).astype(np.float32))
    return out


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0 + 1e-9), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def conductance(fib, gran):
    """纸的传导率：纤维脊 (fiber 亮脊) 上水走得快，纸面平处慢 -> 渗化顺纤维成羽丝，而不是一圈均匀光晕。"""
    ridge = smoothstep(0.36, 0.58, fib)
    return np.clip((0.22 + 0.78 * ridge) * (0.85 + 0.3 * (gran - 0.5)), 0.08, 1.0).astype(np.float32)


_K3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))


def diffuse(Wm, Pm, cond, iters, mob=0.4, keep=0.9):
    """毛细渗化：湿区前沿每步向外推 1 px，推进量 = 邻域最大含水量 × 传导率 × keep (逐步衰减)。
    传导率在纤维脊上高 -> 前沿顺纤维伸出羽丝。墨随水外流，浓度为芯内浓度 × mob (纸纤维滤掉一部分颜料)。

    返回 (W, P, Wmax)：渗化后的含水量、墨量 (芯内不变，只在外圈增加)、湿区 (=W，单调)。"""
    W = Wm.astype(np.float32).copy()
    if iters <= 0:
        return W, Pm.astype(np.float32), W
    k = np.float32(keep)
    for _ in range(int(iters)):
        shell = np.maximum(cv2.dilate(W, _K3) - W, 0.0)
        W += shell * cond * k
        k = np.float32(max(0.5, float(k) * 0.95))
    # 芯内墨浓度向外延伸 (取邻域最大)，作为渗出水携带的浓度
    conc = np.where(Wm > 0.05, Pm / (Wm + 1e-3), 0.0).astype(np.float32)
    r = int(iters) + 1
    conc = cv2.dilate(conc, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    P = Pm + np.float32(mob) * np.clip(W - Wm, 0, None) * conc
    return W, P.astype(np.float32), W


def edge_darkening(wet_mask, sig):
    """Curtis 式边缘积墨：湿区内靠近边界的一圈 (mask·(1-blur(mask))) -> 0..~0.5。"""
    return wet_mask * (1.0 - cv2.GaussianBlur(wet_mask, (0, 0), sig))
