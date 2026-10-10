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


def _smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0 + 1e-9), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def capillary(wm, fiber, gran, iters, reach=1.0):
    """毛细渗化：湿墨只沿偏亮的纸纤维往外爬成丝，而不是铺一圈均匀光晕。

    纤维图的底约 0.3、纤维脊更高。传导率在脊上才打开，所以膨胀的壳只会留在纤维上，
    前沿收成羽状毛边。返回渗出场 (>= wm)。"""
    if iters <= 0:
        return wm
    ridge = _smoothstep(0.39, 0.52, fiber)
    grain_ok = np.clip(0.55 + 0.9 * (gran - 0.42), 0.2, 1.25)
    cond = np.clip(reach * (0.04 + 0.96 * ridge) * grain_ok, 0.0, 0.93).astype(np.float32)
    m = np.asarray(wm, np.float32).copy()
    keep = np.float32(0.92)
    for _ in range(int(iters)):
        shell = np.maximum(cv2.dilate(m, _K) - m, 0.0)
        m += shell * cond * keep
        keep = np.float32(max(0.55, float(keep) * 0.94))
    return m
