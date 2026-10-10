"""毛笔模型的栅格部分：亚像素 splat、逐笔毛噪声、顺纸纤维的毛细渗化。"""
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


_K = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))


def capillary(wm, fiber, gran, iters, reach=1.0):
    """毛细渗化：湿墨沿纸纤维向外爬。每步 3x3 膨胀，再乘以由纤维图决定的传导率(纤维亮处导得远)。
    返回渗出场 (>=wm)。"""
    if iters <= 0:
        return wm
    cond = np.clip(reach * (0.78 + 1.1 * (fiber - 0.45) + 0.25 * (gran - 0.5)), 0.0, 0.95).astype(np.float32)
    m = wm.copy()
    for _ in range(int(iters)):
        np.maximum(m, cv2.dilate(m, _K) * cond, out=m)
    return m
