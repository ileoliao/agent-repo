"""Stroke tests for the sheet: each test(L, x, y, new) paints into a cell whose top-left is (x, y).
`new` False -> classic Layer.stroke, True -> model='bristle'. Returns nothing; timing is done by the caller."""
from __future__ import annotations

import math

import numpy as np

CW, CH = 660, 250          # cell size


def _s(L, new, pts, w, cls=None, nw=None, **kw):
    """One stroke: shared kw, classic-only extras `cls`, bristle-only extras `nw`."""
    if new:
        L.stroke(pts, w, model='bristle', **kw, **(nw or {}))
    else:
        L.stroke(pts, w, **kw, **(cls or {}))


def heng(L, x, y, new):
    for k, (w, yy) in enumerate(((11, 80), (6, 170))):
        _s(L, new, [(x + 60, y + yy + 4), (x + 330, y + yy - 6), (x + 600, y + yy + 2)], w, ink=0.95, dry=0.25,
           wet=0.4, nw=dict(tip='zhong', entry='cang', exit='hui'), cls=dict(taper=(0.08, 0.12), start_w=0.8,
                                                                            end_w=0.7))


def shu(L, x, y, new):
    for k, w in enumerate((4, 8, 13)):
        xx = x + 140 + k * 170
        _s(L, new, [(xx, y + 20), (xx + 6, y + 125), (xx - 2, y + 230)], w, ink=0.95, dry=0.3, wet=0.4,
           nw=dict(tip='zhong', entry='cang', exit='tip' if k == 0 else 'hui', wobble=0.2,
                   pressure=[0.85, 1.12, 0.92, 1.0, 1.15, 0.9][k:] + [1.0] * k))


def cefeng(L, x, y, new):
    _s(L, new, [(x + 50, y + 90), (x + 300, y + 120), (x + 610, y + 150)], 34, ink=0.9, dry=0.55, wet=0.3,
       nw=dict(tip='ce', entry='lu', exit=None), cls=dict(taper=(0.03, 0.5), start_w=1.0, end_w=0.3, bristle=1.6))


def feibai(L, x, y, new):
    _s(L, new, [(x + 40, y + 110), (x + 320, y + 95), (x + 620, y + 140)], 18, ink=1.0, dry=0.9, wet=0.1,
       nw=dict(tip='zhong', load=0.75, entry='cang'), cls=dict(bristle=1.8, taper=(0.05, 0.3), start_w=0.9))


def danmo(L, x, y, new):
    _s(L, new, [(x + 50, y + 130), (x + 250, y + 90), (x + 450, y + 150), (x + 610, y + 110)], 20, ink=0.32,
       dry=0.0, wet=1.0, nw=dict(entry='cang', exit='hui'), cls=dict(taper=(0.1, 0.2), start_w=0.7, end_w=0.5))


def canghui(L, x, y, new):
    _s(L, new, [(x + 50, y + 75), (x + 300, y + 70), (x + 600, y + 80)], 12, ink=0.95, dry=0.3, wet=0.4,
       nw=dict(entry='cang', exit='hui'), cls=dict(taper=(0.06, 0.08), start_w=0.9, end_w=0.8))
    _s(L, new, [(x + 50, y + 180), (x + 300, y + 170), (x + 600, y + 185)], 12, ink=0.95, dry=0.3, wet=0.4,
       nw=dict(entry='lu', exit='tip'), cls=dict(taper=(0.15, 0.4), start_w=0.1, end_w=0.03))


def dunbi(L, x, y, new):
    _s(L, new, [(x + 60, y + 110), (x + 330, y + 120), (x + 560, y + 125)], 14, ink=0.9, dry=0.35, wet=0.6,
       nw=dict(entry='cang', exit='dun', pauses=[0.45]), cls=dict(taper=(0.08, 0.1), start_w=0.8, end_w=1.0))


def zhuanzhe(L, x, y, new):
    _s(L, new, [(x + 60, y + 50), (x + 300, y + 45), (x + 360, y + 60), (x + 340, y + 225)], 14, ink=0.95,
       dry=0.45, wet=0.3, nw=dict(entry='cang', exit='tip', splay=0.9), cls=dict(taper=(0.06, 0.3), start_w=0.8))
    _s(L, new, [(x + 430, y + 210), (x + 520, y + 60), (x + 620, y + 210)], 9, ink=0.9, dry=0.5, wet=0.3,
       nw=dict(entry='lu', exit='tip', splay=0.9))


def mojin(L, x, y, new):
    pts = [(x + 30, y + 130 + 70 * math.sin(t * 2.6)) for t in np.linspace(0, math.pi, 8)]
    pts = [(x + 30 + 600 * k / 7, py) for k, (_, py) in enumerate(pts)]
    _s(L, new, pts, 11, ink=0.95, dry=0.7, wet=0.4, nw=dict(load=0.9, entry='cang', exit=None),
       cls=dict(taper=(0.05, 0.2), start_w=0.9))


def dian(L, x, y, new):
    for k, (r, a) in enumerate(((5, 1.3), (9, 1.0), (14, 1.7), (20, 1.4), (11, 0.8), (7, 2.0))):
        L.dot(x + 70 + k * 100, y + 125, r, ink=0.95, ang=a, **(dict(model='bristle', entry='cang', exit='dun',
                                                                        pressure=[0.8, 1.2, 1.0], wobble=0.3)
                                                                   if new else {}))


def pima(L, x, y, new):
    rng = np.random.default_rng(3)
    for j in range(6):
        ox = x + 120 + j * 9 + rng.normal(0, 2)
        q = [(ox + 230 * t + 60 * t * t, y + 25 + 210 * t - 30 * math.sin(t * 3)) for t in np.linspace(0, 1, 6)]
        _s(L, new, q, rng.uniform(1.4, 2.4), ink=0.8 * rng.uniform(0.6, 1.0), dry=0.5, wet=0.4, rough=0.3,
           wobble=0.25, taper=(0.25, 0.4), start_w=0.3, end_w=0.1, nw=dict(exit='tip', entry='lu'))
    for j in range(5):
        ox = x + 380 + j * 8
        q = [(ox + 120 * t, y + 30 + 200 * t + 20 * math.sin(t * 4)) for t in np.linspace(0, 1, 6)]
        _s(L, new, q, 2.2, ink=0.5, dry=0.1, wet=0.9, taper=(0.2, 0.4), start_w=0.3, end_w=0.1,
           nw=dict(exit='tip', entry='lu'))


def songzhen(L, x, y, new):
    rng = np.random.default_rng(5)
    for hx in (x + 150, x + 330, x + 500):
        hy = y + 150
        for i in range(13):
            a = -math.pi / 2 - 1.4 + 2.8 * i / 12
            l = 70 * rng.uniform(0.8, 1.0)
            _s(L, new, [(hx, hy), (hx + math.cos(a) * l, hy + math.sin(a) * l)], 1.1, ink=0.9, dry=0.15, wet=0.2,
               rough=0.4, taper=(0.05, 0.6), start_w=1.0, end_w=0.1, nw=dict(exit='tip'))


TESTS = [('中锋横画', heng), ('中锋竖画', shu), ('侧锋阔笔', cefeng), ('飞白枯笔', feibai), ('淡墨湿笔', danmo),
         ('藏锋起笔+回锋收笔', canghui), ('顿笔积墨', dunbi), ('转折散锋', zhuanzhe), ('长笔墨尽(墨量递减)', mojin),
         ('点', dian), ('披麻皴(一束)', pima), ('松针', songzhen)]
