"""场景基类：画布尺寸、相机关键帧、雾带、印章、动态元素钩子。"""
from __future__ import annotations

import numpy as np
from scipy.interpolate import PchipInterpolator

SW, SH = 1920, 1080


class SceneBase:
    W = 2496
    H = 1404
    seed = 1
    seal = '成都'
    seal_style = 'bai'
    seal_shape = 'square'
    seal_pos = (1745, 800)       # 屏幕坐标(印章中心)
    seal_size = 96
    seal_t = 1.6
    keys = [(0, 1248, 702, 1.0)]  # (t, cx, cy, zoom)
    mist = []                     # dict(y=画布y, h=半高, a=强度, speed=px/s, scale)
    title = ''
    year = ''
    dur = 10.0

    def build(self, cv):
        raise NotImplementedError

    def camera(self, t):
        k = np.array(self.keys, np.float64)
        if len(k) == 1:
            return tuple(k[0, 1:])
        tt = np.clip(t, k[0, 0], k[-1, 0])
        out = []
        for c in range(1, 4):
            out.append(float(PchipInterpolator(k[:, 0], k[:, c])(tt)))
        # 关键帧之外继续缓慢漂移，避免转场时画面静止
        if t < k[0, 0] or t > k[-1, 0]:
            i0, i1 = (0, 1) if t < k[0, 0] else (-2, -1)
            dt = k[i1, 0] - k[i0, 0]
            v = (k[i1, 1:] - k[i0, 1:]) / max(dt, 1e-3) * 0.35
            ex = (t - k[0, 0]) if t < k[0, 0] else (t - k[-1, 0])
            out = [o + v[j] * ex for j, o in enumerate(out)]
        return tuple(out)

    def dynamic(self, ctx):
        """逐帧动态元素(雨、流水线、落钱、行人…)；向 ctx.A 叠加屏幕空间吸光度。"""
        return None

    def layer_affine(self, i, name, t):
        """可选：对某层附加画布空间仿射(如神鸟金箔缓慢旋转)。返回 2x3 或 None。"""
        return None
