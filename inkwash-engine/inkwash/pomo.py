"""破墨 / 积墨：纸面状态 (每个图层一份)，让新笔与纸上已有的墨水发生作用。opt-in：
`cv.layer(..., interact=True)` 或 `stroke(..., model='bristle', interact=True)`；默认不建状态，输出不变。

PaperState 持有整幅大小、按需分配的三张图：
  W   含水量 (笔触写入的湿图，0..~1.5)
  Tw  W 最后一次写入的时刻
  P   本图层已落下的墨量 (标量密度，= 写入 layer.A 前的 dens 之和)
干燥是惰性的：只在新笔的包围盒里按 W·exp(−(t − Tw)/tau) 求"此刻还有多湿"，所以每笔只碰自己的 bbox。
时钟：笔触时刻 t = max(t0, clock)；`layer.set_time(t)` / `layer.dry(dt)` 推进时钟。

与新笔的作用 (见 brush2._deposit 调用的 prepare / apply)：
  浓破淡 / 湿破湿：旧水使纸的传导率升高、渗化步数增加 -> 新墨顺着旧湿区羽状渗开。
  淡破浓 (backrun / 水花)：新水把旧湿区里尚未固着的墨用宽高斯推向四周 -> 中间淡、深色往外走成软的羽边；
                           前沿按纤维传导率起伏，不是一条硬边的浅坑。局部守恒。
  积墨：旧墨已干处纸被墨"上过胶"，新墨渗得少、边缘积墨更重 -> 每层的边都读得出来。
"""
from __future__ import annotations

import cv2
import numpy as np

from .brush2_ink import smoothstep


class PaperState:
    def __init__(self, h, w, tau=1.2):
        self.h, self.w = h, w
        self.tau = float(tau)          # 干燥时间常数 (与 t0/dur 同单位，秒)
        self.clock = 0.0
        self.W = None
        self.Tw = None
        self.P = None

    def _alloc(self):
        if self.W is None:
            self.W = np.zeros((self.h, self.w), np.float32)
            self.Tw = np.zeros((self.h, self.w), np.float32)
            self.P = np.zeros((self.h, self.w), np.float32)

    def wet_now(self, sl, t):
        """包围盒 sl 内此刻的含水量 (惰性干燥)。"""
        self._alloc()
        dt = np.clip(np.float32(t) - self.Tw[sl], 0, None)
        return self.W[sl] * np.exp(-dt / np.float32(self.tau))

    def commit(self, sl, W_now, dW, dP, t):
        """写回：W = 此刻余水 + 新水 (封顶)，Tw = t；P += dP。"""
        self.W[sl] = np.minimum(W_now + dW, 1.6)
        self.Tw[sl] = np.float32(t)
        self.P[sl] = np.maximum(self.P[sl] + dP, 0)


def state(layer):
    st = getattr(layer, 'paper_state', None)
    if st is None:
        st = PaperState(layer.cv.h, layer.cv.w, getattr(layer, 'dry_tau', 1.2))
        layer.paper_state = st
    return st


def prepare(layer, sl, t, cond, it, wet, paint):
    """新笔落墨前：读旧湿度/旧墨，返回 (ctx, cond', it', mob_add)。"""
    st = state(layer)
    Wold = st.wet_now(sl, t)
    Pold = st.P[sl]
    wo = smoothstep(0.03, 0.35, Wold).astype(np.float32)            # 旧湿区 0..1
    dryink = (smoothstep(0.04, 0.35, Pold) * (1.0 - wo)).astype(np.float32)   # 已干的旧墨
    # 湿纸上水走得快，但仍顺纤维、受纸面细纹调制；干墨上过胶的纸几乎不再渗
    fine = np.clip(0.5 + 0.5 * layer.cv.nz_edge[sl], 0, 1)
    cond2 = np.clip(cond * (1.0 + 2.6 * wo) * (0.50 + 1.05 * wo * fine), 0, 0.97) * (1.0 - 0.78 * dryink)
    wmax = float(wo.max()) if wo.size else 0.0
    it2 = int(it + round(8 * wmax * min(1.0, 0.45 + wet)))
    mob_add = 0.55 * wo
    ctx = dict(st=st, sl=sl, t=t, Wold=Wold, Pold=Pold, wo=wo, dryink=dryink, paint=paint)
    return ctx, cond2.astype(np.float32), it2, mob_add


def edge_boost(ctx):
    """积墨：旧墨已干处，新笔的边缘积墨加重 (每层的边读得出来)；
    落在湿处的笔不在自己的边上结水线 (水线留到湿区前沿)。"""
    return (1.0 + 3.4 * ctx['dryink']) * (1.0 - 0.92 * ctx['wo'])


def soften(ctx, Pm, halo, w):
    """旧湿区里把新笔的边晕开。淡墨压浓墨时晕得更开，避免挖出一个硬边的浅坑。"""
    wo = ctx['wo']
    if float(wo.max()) < 0.05:
        return Pm, halo
    pale = smoothstep(0.12, 0.65, 1.0 - Pm / (ctx['Pold'] + 0.08)).astype(np.float32)
    sig_a = 2.6 + 0.08 * w
    sig_b = 5.2 + 0.32 * w
    Pm_a = cv2.GaussianBlur(Pm, (0, 0), sig_a)
    Pm_b = cv2.GaussianBlur(Pm, (0, 0), sig_b)
    Pm_s = (1.0 - pale) * Pm_a + pale * Pm_b
    Pm2 = (1.0 - wo) * Pm + wo * Pm_s
    halo2 = (1.0 - wo) * halo + wo * cv2.GaussianBlur(halo, (0, 0), 3.6 + 0.12 * w)
    return Pm2, halo2


def layer_edge(ctx, paint, Pm, w):
    """积墨：新层落在已干的旧墨上时，纸已被墨上胶，水停在笔边。
    边是一条几像素宽、明显更深的水线，1 倍下也能和 interact=off 分开。"""
    di = ctx['dryink']
    if float(di.max()) < 0.05:
        return 0.0
    m = smoothstep(0.06, 0.42, paint).astype(np.float32)
    inner = cv2.GaussianBlur(m, (0, 0), 0.9)
    outer = cv2.GaussianBlur(m, (0, 0), 3.2 + 0.05 * w)
    band = np.clip(inner - outer, 0, None)
    peak = float(np.percentile(band, 99)) + 1e-6
    band = np.clip(band / peak, 0, 1)
    # 窄的内沿线 + 稍宽的积墨带，强度跟这一层自己的墨走
    line = m * (1.0 - cv2.GaussianBlur(m, (0, 0), 1.15))
    return (0.85 * band + 0.45 * np.clip(line * 3.2, 0, 1)) * di * (0.70 + 1.05 * np.clip(Pm, 0, 1.3))


def apply(layer, ctx, Wf, Pm, dens, cond, w):
    """新笔落墨后：淡破浓 backrun (改写 layer.A 里的旧墨)，并写回纸面状态。返回旧墨改动量 dOld (标量)。"""
    st, sl = ctx['st'], ctx['sl']
    Wold, Pold, wo = ctx['Wold'], ctx['Pold'], ctx['wo']
    dOld = np.zeros_like(Pold)
    if float(wo.max()) > 0.05 and float(Wf.max()) > 0.02:
        paint = ctx['paint']
        newwater = smoothstep(0.03, 0.58, Wf).astype(np.float32)
        core = np.where(paint > 0.22, Pm / (paint + 1e-4), 0.0).astype(np.float32)
        dnew = cv2.GaussianBlur(core, (0, 0), max(2.0, 0.16 * w))
        water = smoothstep(0.05, 0.50, newwater)
        ratio = dnew / (Pold + 1e-3)
        # 浅心只在新墨远淡于旧墨时出现 (淡破浓 ratio≈0.05)。0.3 左右仍是湿破湿
        hole = (1.0 - smoothstep(0.12, 0.42, ratio)) * smoothstep(0.05, 0.28, Pold)
        hole = (hole * water).astype(np.float32)
        sim = (smoothstep(0.16, 0.40, ratio) * (1.0 - smoothstep(1.5, 3.0, ratio))).astype(np.float32)
        mobile = Pold * wo * (0.50 + 0.45 * wo)
        feather = np.clip((cond - 0.18) / 0.42, 0, 1).astype(np.float32)
        nz = layer.cv.nz_edge[sl]
        lobes = np.clip(0.40 + 0.70 * (0.5 + 0.5 * nz), 0.25, 1.15).astype(np.float32)
        lobes = cv2.GaussianBlur(lobes, (0, 0), 2.6)
        # 淡破浓：种子可以紧，边只由宽高斯决定。色阶接近的那部分另外晕，不从这里掏芯
        seed = mobile * water * hole * 0.80
        if float(seed.max()) > 1e-4:
            sig_b = max(8.0, 0.50 * w)
            bowl = cv2.GaussianBlur(seed.astype(np.float32), (0, 0), sig_b)
            center = smoothstep(0.45, 0.85, newwater) * hole
            if float(center.max()) > 0.2:
                sel = center > (0.55 * float(center.max()))
                target = float(np.mean((mobile * (0.64 * hole))[sel])) + 1e-6
                have = float(np.mean(bowl[sel])) + 1e-6
                scale = float(np.clip(target / have, 0.8, 4.0))
            else:
                scale = 1.0
            removed = np.minimum(bowl * scale, mobile * 0.88)
            soft_core = cv2.GaussianBlur((newwater * hole).astype(np.float32), (0, 0), sig_b)
            soft_core = soft_core / (float(soft_core.max()) + 1e-6)
            prefer = (0.12 + 0.88 * (1.0 - soft_core)) * (0.50 + 0.50 * feather) * lobes
            dep = cv2.GaussianBlur(removed, (0, 0), max(11.0, 0.72 * w)) * prefer
            dep = cv2.GaussianBlur(dep.astype(np.float32), (0, 0), 2.0)
            tot = float(removed.sum()) + 1e-8
            dep *= tot / (float(dep.sum()) + 1e-8)
            dOld = dep - removed
        # 湿破湿：色阶接近时把旧墨从窄芯摊到很宽的羽边上。浓压淡 sim≈0，这里不动
        stir = mobile * np.clip(water * sim * (1.0 - hole) * 1.35, 0, 0.62)
        if float(stir.max()) > 0.03:
            take_s = cv2.GaussianBlur(stir.astype(np.float32), (0, 0), max(2.2, 0.12 * w))
            take_s = np.minimum(take_s, np.maximum(mobile * 0.72 - np.maximum(-dOld, 0), 0))
            outer = 1.0 - cv2.GaussianBlur(np.clip(water, 0, 1), (0, 0), max(5.0, 0.32 * w))
            outer = np.clip(outer, 0, 1)
            weight = (0.22 + 0.78 * outer) * (0.35 + 0.65 * feather) * lobes
            fringe = cv2.GaussianBlur(take_s, (0, 0), max(8.0, 0.62 * w)) * weight
            fringe = cv2.GaussianBlur(fringe.astype(np.float32), (0, 0), 2.0)
            tot_s = float(take_s.sum()) + 1e-8
            fringe *= tot_s / (float(fringe.sum()) + 1e-8)
            dOld = dOld + (fringe - take_s)
    # 写回状态：新笔的水 + 此刻余水；墨量加上新墨与旧墨的搬运
    st.commit(sl, Wold, Wf, dens + dOld, ctx['t'])
    return dOld


def recolor(layer, sl, dOld):
    """把旧墨的标量改动量按旧墨颜色写回 layer.A。"""
    if not np.any(dOld):
        return
    A = layer.A[sl]
    st = layer.paper_state
    Pc = st.P[sl] - dOld                                   # 改动前的旧墨 (commit 已加过 dOld)
    col = A / (Pc[..., None] + 1e-4)
    # 新落墨处 (环) 原本可能没有旧墨：取邻域平均颜色
    colb = cv2.GaussianBlur(A, (0, 0), 4.0) / (cv2.GaussianBlur(Pc, (0, 0), 4.0)[..., None] + 1e-4)
    use = (Pc > 0.02)[..., None]
    col = np.where(use, col, colb)
    col = np.clip(col, 0, 2.0)
    np.maximum(A + dOld[..., None] * col, 0, out=A)


def pad_extra(layer, interact):
    return 14 if interact else 0


def now(layer, t0):
    st = state(layer)
    return max(float(t0), st.clock)

