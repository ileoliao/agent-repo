"""Rock helpers: masked painting (Clip) and broken 勾勒 contour strokes."""
from __future__ import annotations

import cv2
import numpy as np

from inkwash.core import Layer
from . import brush as B


class Clip:
    """Paint strokes into a scratch layer, then add them to `L` only inside a mask."""
    _scratch = None

    def __init__(self, L, x0, y0, mask, feather=2.0):
        self.L, self.x0, self.y0 = L, x0, y0
        m = cv2.GaussianBlur(mask, (0, 0), feather * B.S + 0.3) if feather > 0 else mask
        self.m = m
        if Clip._scratch is None or Clip._scratch.cv is not L.cv:
            Clip._scratch = Layer(L.cv, 'scratch', 1, 0, 0, interact=False)
        self.s = Clip._scratch
        self.s.rng = L.rng

    def __enter__(self):
        # 每一块山石是一张新的局部纸：清掉上一块残留的水和墨，时钟对齐到整幅画
        self.s.interact = bool(self.L.interact)
        self.s.paper_state = None
        if self.s.interact:
            B.track(self.s)
            self.s.set_time(B.CLOCK)
        return self.s

    def __exit__(self, *a):
        h, w = self.m.shape
        H, W = self.L.cv.h, self.L.cv.w
        xa, ya = max(0, self.x0), max(0, self.y0)
        xb, yb = min(W, self.x0 + w), min(H, self.y0 + h)
        m = self.m[ya - self.y0:yb - self.y0, xa - self.x0:xb - self.x0]
        self.L.A[ya:yb, xa:xb] += self.s.A[ya:yb, xa:xb] * m[..., None]
        self.L.Wet[ya:yb, xa:xb] += self.s.Wet[ya:yb, xa:xb] * m
        self._merge_paper(ya, yb, xa, xb, m)
        self.s.A[:] = 0
        self.s.Wet[:] = 0
        self.s.paper_state = None

    def _merge_paper(self, ya, yb, xa, xb, m):
        """把这块石上的水墨交回主图层，后面的树和下一笔才知道纸干了没有。"""
        sp = self.s.paper_state
        if not self.L.interact or sp is None or sp.P is None:
            return
        from inkwash import pomo
        st = pomo.state(self.L)
        st._alloc()
        sl = (slice(ya, yb), slice(xa, xb))
        mm = m.astype(np.float32)
        st.P[sl] += sp.P[sl] * mm
        wet = sp.W[sl] * mm
        st.W[sl] = np.minimum(st.W[sl] + wet, 1.6)
        upd = wet > 0.01
        st.Tw[sl] = np.where(upd, np.maximum(st.Tw[sl], sp.Tw[sl]), st.Tw[sl])


def outline(L, poly, rng, w=5.0, ink=0.85, dry=0.5, gaps=0.15, closed=False, seg=(4, 9)):
    """勾勒: broken contour strokes with pressure changes along a design-unit polyline."""
    pts = np.asarray(poly, np.float64)
    if closed:
        pts = np.vstack([pts, pts[:1]])
    i = 0
    while i < len(pts) - 1:
        k = int(rng.integers(*seg))
        sub = pts[i:i + k + 1]
        if len(sub) >= 2 and rng.random() > gaps:
            sub = sub + rng.normal(0, 1.2, sub.shape)
            L.stroke(B.P(sub), w * rng.uniform(0.6, 1.3) * B.S, ink=ink * rng.uniform(0.8, 1.1), dry=dry,
                     wet=0.4, taper=(0.12, 0.35), start_w=0.9, end_w=0.15, rough=0.4, bristle=1.3, wobble=0.25)
        i += k
