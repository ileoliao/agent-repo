"""笔墨核心：噪声、宣纸、毛笔笔触、墨染(wash)、图层(墨量 + 落笔时间图)。

每个图层保存两类数据：
  A[y, x, 3]  颜料吸光度 (Beer–Lambert, 画面 = 纸色 * exp(-ΣA))
  T[y, x]     该像素被"画到"的时刻（场景本地秒）；逐帧按 t - T 显影。
"""
from __future__ import annotations

import math
import os
import zlib

import cv2
import numpy as np
from scipy.ndimage import map_coordinates
from scipy.spatial import cKDTree

NEVER = 1.0e6

# 颜料吸光度 (R, G, B)：越大越吸收该通道
INK = np.array([1.00, 0.97, 0.90], np.float32)        # 松烟墨，淡处偏冷灰
INK_WARM = np.array([0.92, 0.97, 1.02], np.float32)   # 油烟墨，略暖
INDIGO = np.array([0.95, 0.52, 0.26], np.float32)     # 花青
OCHRE = np.array([0.22, 0.45, 0.92], np.float32)      # 赭石
UMBER = np.array([0.45, 0.62, 0.90], np.float32)      # 土黄褐
CRIMSON = np.array([0.12, 0.95, 0.62], np.float32)    # 胭脂
VERMILION = np.array([0.06, 0.92, 1.00], np.float32)  # 朱砂
GOLD = np.array([0.10, 0.30, 1.05], np.float32)       # 泥金/藤黄
MALACHITE = np.array([0.85, 0.22, 0.55], np.float32)  # 石绿
JADE = np.array([0.70, 0.25, 0.42], np.float32)       # 青绿
PINK = np.array([0.04, 0.42, 0.26], np.float32)       # 桃红(淡)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0 + 1e-9), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


# --------------------------------------------------------------------------- noise
def vnoise(h, w, cell, rng, cell_y=None):
    """平滑值噪声 (0..1)，cell 为特征尺度(像素)，可各向异性。"""
    cx = max(1.0, float(cell))
    cy = max(1.0, float(cell_y if cell_y is not None else cell))
    gh = int(math.ceil(h / cy)) + 4
    gw = int(math.ceil(w / cx)) + 4
    g = rng.random((gh, gw), dtype=np.float32)
    big = cv2.resize(g, (int(gw * cx), int(gh * cy)), interpolation=cv2.INTER_CUBIC)
    oy = int(rng.integers(int(cy), int(2 * cy) + 1))
    ox = int(rng.integers(int(cx), int(2 * cx) + 1))
    out = big[oy:oy + h, ox:ox + w]
    if out.shape != (h, w):
        out = cv2.resize(out, (w, h))
    return out


def fbm(h, w, cell, octaves, rng, gain=0.5, cell_y=None):
    """分形噪声，返回近似零均值单位方差的场。"""
    acc = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    c, cy = float(cell), float(cell_y if cell_y is not None else cell)
    for _ in range(octaves):
        acc += amp * (vnoise(h, w, c, rng, cy) - 0.5)
        tot += amp * amp
        amp *= gain
        c = max(1.0, c / 2.0)
        cy = max(1.0, cy / 2.0)
    acc /= (math.sqrt(tot) * 0.2887)
    return acc


def noise1d(n, cell, rng):
    k = int(math.ceil(n / cell)) + 4
    g = rng.random(k).astype(np.float32)
    x = np.arange(n) / cell + 1.0
    i = np.floor(x).astype(int)
    f = x - i
    f = f * f * (3 - 2 * f)
    return g[i] * (1 - f) + g[i + 1] * f


def fbm1d(n, cell, octaves, rng):
    acc = np.zeros(n, np.float32)
    amp = 1.0
    tot = 0.0
    for _ in range(octaves):
        acc += amp * (noise1d(n, cell, rng) - 0.5)
        tot += amp
        amp *= 0.5
        cell = max(1.0, cell / 2)
    return acc / tot * 2.0


# --------------------------------------------------------------------------- paper
def make_paper(h, w, seed=7):
    """宣纸：底色 + 云絮状纤维团 + 细长纤维 + 颗粒；返回 (rgb float32, fiber 0..1)。"""
    rng = np.random.default_rng(seed)
    cloud = fbm(h, w, 260, 5, rng)
    floc = fbm(h, w, 34, 3, rng)
    fib_l = np.zeros((h, w), np.uint8)
    fib_d = np.zeros((h, w), np.uint8)
    n = int(h * w / 520)
    xs = rng.uniform(-50, w + 50, n)
    ys = rng.uniform(-50, h + 50, n)
    ang = rng.uniform(0, np.pi, n)
    lens = rng.uniform(14, 70, n) * np.where(rng.random(n) < 0.1, 3.5, 1.0)
    bend = rng.normal(0, 0.9, n)
    vals = rng.integers(40, 150, n)
    dark = rng.random(n) < 0.2
    for k in range(n):
        a = ang[k]
        pts = []
        for j in range(6):
            tt = j / 5.0 - 0.5
            aa = a + bend[k] * tt
            pts.append((xs[k] + math.cos(aa) * lens[k] * tt, ys[k] + math.sin(aa) * lens[k] * tt))
        arr = np.array(pts, np.float32).reshape(-1, 1, 2)
        arr = (arr * 4).astype(np.int32)
        cv2.polylines(fib_d if dark[k] else fib_l, [arr], False, int(vals[k]), 1, cv2.LINE_AA, shift=2)
    fl = cv2.GaussianBlur(fib_l.astype(np.float32) / 255.0, (0, 0), 0.7)
    fd = cv2.GaussianBlur(fib_d.astype(np.float32) / 255.0, (0, 0), 0.6)
    grain = cv2.GaussianBlur(rng.standard_normal((h, w)).astype(np.float32), (0, 0), 0.6)
    lum = 1.0 + 0.010 * cloud + 0.012 * floc + 0.03 * fl - 0.03 * fd + 0.009 * grain
    age = np.clip(0.5 + 0.22 * fbm(h, w, 600, 3, rng), 0, 1)[..., None]
    base = np.array([0.952, 0.928, 0.866], np.float32)
    aged = np.array([0.925, 0.880, 0.785], np.float32)
    col = base * (1 - age * 0.5) + aged * (age * 0.5)
    paper = np.clip(col * lum[..., None], 0, 1).astype(np.float32)
    fiber = np.clip(0.5 + 0.9 * fl + 0.6 * fd + 0.12 * floc, 0, 1.6).astype(np.float32) / 1.6
    return paper, fiber


# --------------------------------------------------------------------------- geometry
def catmull(pts, step=1.0):
    pts = np.asarray(pts, np.float64)
    if len(pts) < 2:
        return pts
    if len(pts) == 2:
        dense = pts
    else:
        P = np.vstack([2 * pts[0] - pts[1], pts, 2 * pts[-1] - pts[-2]])
        out = []
        for i in range(len(pts) - 1):
            p0, p1, p2, p3 = P[i], P[i + 1], P[i + 2], P[i + 3]
            seg = np.linalg.norm(p2 - p1)
            n = max(2, int(seg / max(step, 0.25) * 1.5) + 1)
            t = np.linspace(0, 1, n, endpoint=False)[:, None]
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
        out.append(pts[-1:])
        dense = np.vstack(out)
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(dense, axis=0).T))]
    L = d[-1]
    if L < 1e-6:
        return dense[:1]
    n = max(2, int(L / step) + 1)
    s = np.linspace(0, L, n)
    return np.c_[np.interp(s, d, dense[:, 0]), np.interp(s, d, dense[:, 1])]


# --------------------------------------------------------------------------- canvas / layers
class Canvas:
    """一个场景的画布（全分辨率），持有宣纸与公共噪声场。"""

    def __init__(self, w, h, seed, paper=None, fiber=None):
        self.w, self.h = w, h
        self.seed = seed
        self.rng = np.random.default_rng(seed)
        r = self.rng
        if paper is None:
            paper, fiber = make_paper(h, w, seed + 1)
        self.paper = paper
        self.fiber = fiber
        self.nz_edge = np.clip(fbm(h, w, 5, 3, r) * 0.5, -1.5, 1.5)
        self.nz_mid = fbm(h, w, 40, 4, r)
        self.nz_low = fbm(h, w, 220, 3, r)
        self.nz_gran = fbm(h, w, 3, 2, r)
        self.layers: list[Layer] = []

    def layer(self, name, parallax=1.0, fade=0.3, halo=0.9):
        L = Layer(self, name, parallax, fade, halo)
        self.layers.append(L)
        return L


class Layer:
    def __init__(self, cv: Canvas, name, parallax, fade, halo):
        self.cv = cv
        self.name = name
        self.parallax = parallax
        self.fade = fade
        self.halo = halo
        h, w = cv.h, cv.w
        self.A = np.zeros((h, w, 3), np.float32)
        self.Wet = np.zeros((h, w), np.float32)
        self.T = np.full((h, w), NEVER, np.float32)
        self.rng = np.random.default_rng(zlib.crc32(f'{name}/{len(cv.layers)}'.encode()) + cv.seed)
        self.extra = {}

    # ------------------------------------------------------------------ brush stroke
    def stroke(self, pts, w, ink=0.85, pig=INK, t0=0.0, dur=0.6, dry=0.15, wet=0.5,
               taper=(0.12, 0.35), start_w=0.45, end_w=0.05, rough=0.22, wobble=0.10,
               step=None, bristle=1.0, pool=0.35, ease=0.3, model='classic', **kw):
        """一笔：沿样条路径，带起笔/收笔、笔毛飞白、湿边与纸纤维吸墨。
        model='bristle' 改用 inkwash.brush2 的笔毛模型(额外参数经 **kw 传入)；默认 'classic' 行为不变。"""
        if model == 'bristle':
            from .brush2 import bristle_stroke
            return bristle_stroke(self, pts, w, ink=ink, pig=pig, t0=t0, dur=dur, dry=dry, wet=wet, taper=taper,
                                  start_w=start_w, end_w=end_w, rough=rough, wobble=wobble, step=step,
                                  bristle=bristle, pool=pool, ease=ease, **kw)
        if kw:
            raise TypeError(f'unexpected stroke kwargs for classic model: {sorted(kw)}')
        cv = self.cv
        rng = self.rng
        if step is None:
            step = 0.6 if w < 3 else 1.0
        P = catmull(pts, step)
        M = len(P)
        if M < 2:
            return
        s = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
        Ltot = s[-1]
        if Ltot < 0.8:
            return
        tan = np.gradient(P, axis=0)
        tan /= (np.linalg.norm(tan, axis=1, keepdims=True) + 1e-9)
        nrm = np.c_[-tan[:, 1], tan[:, 0]]
        u = s / Ltot
        prof = np.ones(M)
        a, r = taper
        if a > 0:
            prof = np.where(u < a, start_w + (1 - start_w) * np.sin(0.5 * np.pi * np.clip(u / a, 0, 1)), prof)
        if r > 0:
            tail = np.clip((1 - u) / r, 0, 1)
            prof = prof * np.where(u > 1 - r, end_w + (1 - end_w) * tail ** 0.75, 1.0)
        if wobble > 0:
            prof = prof * (1 + wobble * (noise1d(M, max(8, 40 / step), rng) - 0.5) * 2)
        W = np.maximum(w * prof, 0.35)
        Wmax = float(W.max())
        pad = Wmax * 1.35 + 3
        x0 = int(max(0, math.floor(P[:, 0].min() - pad)))
        y0 = int(max(0, math.floor(P[:, 1].min() - pad)))
        x1 = int(min(cv.w, math.ceil(P[:, 0].max() + pad)))
        y1 = int(min(cv.h, math.ceil(P[:, 1].max() + pad)))
        if x1 <= x0 or y1 <= y0:
            return
        mask = np.zeros((y1 - y0, x1 - x0), np.uint8)
        q = ((P - [x0, y0]) * 4).astype(np.int32).reshape(-1, 1, 2)
        cv2.polylines(mask, [q], False, 255, int(2 * pad), cv2.LINE_8, shift=2)
        ys, xs = np.nonzero(mask)
        if len(xs) == 0:
            return
        gx = xs + x0
        gy = ys + y0
        pix = np.c_[gx + 0.5, gy + 0.5]
        dist, idx = cKDTree(P).query(pix, distance_upper_bound=pad)
        ok = idx < M
        if not ok.any():
            return
        pix, idx, dist, gx, gy = pix[ok], idx[ok], dist[ok], gx[ok], gy[ok]
        dv = pix - P[idx]
        along = np.einsum('ij,ij->i', dv, tan[idx])
        across = np.einsum('ij,ij->i', dv, nrm[idx])
        cap = ((idx == 0) & (along < 0)) | ((idx == M - 1) & (along > 0))
        rad = np.where(cap, dist, np.abs(across))
        Wi = W[idx]
        edge = 1.0 + rough * cv.nz_edge[gy, gx]
        cover = np.clip(Wi * edge - rad + 0.6, 0, 1)
        keepm = cover > 0
        if not keepm.any():
            return
        pix, idx, gx, gy, cover, across, Wi = pix[keepm], idx[keepm], gx[keepm], gy[keepm], cover[keepm], across[keepm], Wi[keepm]
        nn = np.clip(across / np.maximum(Wi, 0.5), -1, 1)
        ui = u[idx]
        # 笔毛：横向高频、纵向低频的条纹纹理
        nb = int(np.clip(w * 1.1, 6, 60))
        gs = int(Ltot / 18) + 3
        grid = rng.random((gs, nb + 2)).astype(np.float32)
        grid = grid ** 0.8
        B = map_coordinates(grid, [s[idx] / 18.0, (nn + 1) * 0.5 * nb + 0.5], order=1, mode='nearest')
        load = ink * (1 - dry * 0.55 * ui ** 1.3)
        dness = dry * (0.15 + 1.05 * ui ** 1.6) + dry * 0.45 * nn ** 2
        keep = smoothstep(dness - 0.12, dness + 0.12, B + 0.1)
        tex = (1 - 0.3 * bristle) + 0.3 * bristle * B
        fib = 0.86 + 0.28 * cv.fiber[gy, gx]
        pl = 1 + pool * wet * smoothstep(0.55, 1.0, np.abs(nn))
        dens = (cover * load * keep * tex * fib * pl).astype(np.float32)
        ue = (1 - ease) * ui + ease * (0.5 - 0.5 * np.cos(np.pi * ui))
        Tp = (t0 + dur * ue).astype(np.float32)
        self.A[gy, gx] += dens[:, None] * pig
        self.Wet[gy, gx] += dens * wet
        cur = self.T[gy, gx]
        self.T[gy, gx] = np.where(dens > 0.004, np.minimum(cur, Tp), cur)

    def dot(self, x, y, r, ink=0.9, pig=INK, t0=0.0, dur=0.12, ang=None, elong=1.6, **kw):
        """点（点苔、叶点、墨点）：短促的一笔。"""
        if ang is None:
            ang = self.rng.uniform(0, np.pi)
        L = r * elong
        dx, dy = math.cos(ang) * L * 0.5, math.sin(ang) * L * 0.5
        kw.setdefault('taper', (0.35, 0.5))
        kw.setdefault('start_w', 0.6)
        kw.setdefault('end_w', 0.25)
        kw.setdefault('dry', 0.0)
        kw.setdefault('wet', 0.8)
        self.stroke([(x - dx, y - dy), (x + dx, y + dy)], r, ink=ink, pig=pig, t0=t0, dur=dur, **kw)

    # ------------------------------------------------------------------ wash
    def wash(self, x0, y0, field, pig, dens=0.4, t0=0.0, seeds=None, speed=500.0, jitter=0.5,
             edge=0.5, gran=0.35, wet=0.9, lo=0.25, hi=0.6, warp=0.22, edge_blur=7, tfield=None, body=None):
        """渲染：软形状场 → 有机边缘 + 水渍边(边缘积墨) + 颗粒；从种子点向外晕开。"""
        cv = self.cv
        h, w = field.shape
        x0, y0 = int(x0), int(y0)
        xa, ya = max(0, x0), max(0, y0)
        xb, yb = min(cv.w, x0 + w), min(cv.h, y0 + h)
        if xb <= xa or yb <= ya:
            return
        f = field[ya - y0:yb - y0, xa - x0:xb - x0].astype(np.float32)
        nm = cv.nz_mid[ya:yb, xa:xb]
        m = smoothstep(lo, hi, f + warp * nm * 0.5)
        if edge > 0:
            e = np.clip(m - cv2.GaussianBlur(m, (0, 0), edge_blur), 0, 1)
            m2 = m * ((1 - 0.35 * edge) if body is None else body) + edge * 2.2 * e
        else:
            m2 = m
        tex = (1 - 0.5 * gran) + gran * np.clip(0.5 + 0.35 * cv.nz_gran[ya:yb, xa:xb], 0, 1)
        tex *= 0.86 + 0.28 * cv.fiber[ya:yb, xa:xb]
        tex *= 1 + 0.12 * cv.nz_mid[ya:yb, xa:xb] * 0.5
        D = (dens * m2 * tex).astype(np.float32)
        if tfield is not None:
            Tp = tfield[ya - y0:yb - y0, xa - x0:xb - x0].astype(np.float32)
        else:
            yy, xx = np.mgrid[ya:yb, xa:xb].astype(np.float32)
            if seeds is None:
                seeds = [((xa + xb) / 2, (ya + yb) / 2)]
            d = None
            for sx, sy in seeds:
                dd = np.hypot(xx - sx, yy - sy)
                d = dd if d is None else np.minimum(d, dd)
            Tp = t0 + d / speed * (1 + jitter * cv.nz_low[ya:yb, xa:xb] * 0.5)
        self.A[ya:yb, xa:xb] += D[..., None] * pig
        self.Wet[ya:yb, xa:xb] += D * wet
        T = self.T[ya:yb, xa:xb]
        np.copyto(T, np.where(D > 0.004, np.minimum(T, Tp), T).astype(np.float32))

    # ------------------------------------------------------------------ finalize
    def finalize(self):
        """墨晕：湿墨沿纸纤维向外渗开(halo)，并让渗出部分比笔触稍晚出现。"""
        A = self.A
        lum = A.mean(axis=2)
        if self.halo > 0:
            wet = self.Wet
            b1 = cv2.GaussianBlur(wet, (0, 0), 2.5)
            b2 = cv2.GaussianBlur(wet, (0, 0), 9.0)
            bw = 0.6 * b1 + 0.4 * b2
            spread = np.clip(bw - wet, 0, None)
            fibr = 0.35 + 1.1 * self.cv.fiber
            hal = spread * fibr * self.halo
            colr = cv2.GaussianBlur(A, (0, 0), 3.0)
            cl = colr.mean(axis=2, keepdims=True) + 1e-5
            A += (hal[..., None] * colr / cl).astype(np.float32)
            Te = cv2.erode(self.T, np.ones((17, 17), np.uint8)) + 0.28
            self.T = np.where(lum > 0.012, self.T, np.minimum(Te, NEVER)).astype(np.float32)
        del self.Wet
        self.Wet = None

    def packed(self):
        out = np.empty((self.cv.h, self.cv.w, 4), np.float32)
        out[..., :3] = self.A
        out[..., 3] = self.T
        return out


def save_canvas(cv: Canvas, folder, meta_extra=None):
    """把每层存为 (H,W,4) float32 .npy + 金字塔(1/2, 1/4)，供渲染时内存映射。"""
    import json
    os.makedirs(folder, exist_ok=True)
    meta = {'w': cv.w, 'h': cv.h, 'layers': []}
    for i, L in enumerate(cv.layers):
        if L.Wet is not None:
            L.finalize()
        pk = L.packed()
        L.A = None
        L.T = None
        levels = [pk]
        for _ in range(2):
            prev = levels[-1]
            a = cv2.resize(prev[..., :3], (prev.shape[1] // 2, prev.shape[0] // 2), interpolation=cv2.INTER_AREA)
            t = cv2.erode(prev[..., 3], np.ones((2, 2), np.uint8))
            t = t[0:(prev.shape[0] // 2) * 2:2, 0:(prev.shape[1] // 2) * 2:2]
            nxt = np.empty((a.shape[0], a.shape[1], 4), np.float32)
            nxt[..., :3] = a
            nxt[..., 3] = t
            levels.append(nxt)
        for k, arr in enumerate(levels):
            np.save(os.path.join(folder, f'layer{i}_L{k}.npy'), arr)
        meta['layers'].append({'name': L.name, 'parallax': L.parallax, 'fade': L.fade, **L.extra})
        del levels, pk
    pap = (np.clip(cv.paper, 0, 1) * 65535).astype(np.uint16)
    plev = [pap]
    for _ in range(2):
        p = plev[-1]
        plev.append(cv2.resize(p, (p.shape[1] // 2, p.shape[0] // 2), interpolation=cv2.INTER_AREA))
    for k, arr in enumerate(plev):
        np.save(os.path.join(folder, f'paper_L{k}.npy'), arr)
    if meta_extra:
        meta.update(meta_extra)
    with open(os.path.join(folder, 'meta.json'), 'w') as f:
        json.dump(meta, f)
