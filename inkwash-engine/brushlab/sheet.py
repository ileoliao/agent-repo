"""Stroke test sheet: OLD (classic) vs NEW (bristle) per row.

  python3 brushlab/sheet.py [out.png]      -> brushlab/sheet.png + per-stroke timings
"""
from __future__ import annotations

import os
import sys
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from inkwash import core  # noqa: E402
from inkwash.core import Canvas  # noqa: E402
from tests import CH, CW, TESTS  # noqa: E402

LBL, TOP = 230, 90
FONT = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc'

_orig = core.Layer.stroke
TIMES = []          # (test, model, ms, w, length)


def _timed(self, pts, w, *a, **kw):
    t = time.perf_counter()
    r = _orig(self, pts, w, *a, **kw)
    p = np.asarray(core.catmull(pts, 1.0))
    ln = float(np.sum(np.hypot(*np.diff(p, axis=0).T))) if len(p) > 1 else 0.0
    model = kw.get('model', 'classic') + ('+ia' if kw.get('interact') else '')
    TIMES.append((_timed.test, model, (time.perf_counter() - t) * 1e3, w, ln))
    return r


core.Layer.stroke = _timed


def main(out):
    W, H = LBL + 2 * CW, TOP + len(TESTS) * CH
    cv = Canvas(W, H, 21)
    L = cv.layer('sheet', halo=0.9)
    # warm-up (imports / first-call overhead) on a throwaway layer
    tmp = cv.layer('warm')
    _timed.test = 'warm'
    tmp.stroke([(10, 10), (200, 30)], 8, model='bristle')
    cv.layers.remove(tmp)
    for i, (name, fn) in enumerate(TESTS):
        y = TOP + i * CH
        _timed.test = name
        fn(L, LBL, y, False)
        fn(L, LBL + CW, y, True)
    L.finalize()
    img = np.clip(cv.paper * np.exp(-L.A), 0, 1)
    im = Image.fromarray((img * 255 + 0.5).astype(np.uint8))
    d = ImageDraw.Draw(im)
    f1, f2 = ImageFont.truetype(FONT, 30), ImageFont.truetype(FONT, 22)
    d.text((LBL + 20, 25), '旧 · classic stroke', fill=(120, 40, 30), font=f1)
    d.text((LBL + CW + 20, 25), '新 · bristle 毛笔模型', fill=(120, 40, 30), font=f1)
    pomo_at = None
    for i, (name, _) in enumerate(TESTS):
        y = TOP + i * CH
        d.line([(0, y), (W, y)], fill=(200, 190, 170), width=1)
        d.text((16, y + CH // 2 - 16), name, fill=(60, 50, 40), font=f2)
        if pomo_at is None and (name.startswith(('破墨', '积墨', '湿破湿', '对照'))):
            pomo_at = y
    if pomo_at is not None:
        # 破墨/积墨这几行两列都是毛笔，差别只在 interact
        d.rectangle([LBL, pomo_at, W, pomo_at + 36], fill=(232, 222, 202))
        d.text((LBL + 16, pomo_at + 4), '关 · interact=off', fill=(120, 40, 30), font=f2)
        d.text((LBL + CW + 16, pomo_at + 4), '开 · interact=on', fill=(120, 40, 30), font=f2)
    d.line([(LBL + CW, TOP), (LBL + CW, H)], fill=(200, 190, 170), width=1)
    im.save(out)
    print('saved', out, im.size)
    print(f'{"test":<16}{"n":>4}{"left ms/stroke":>20}{"right ms/stroke":>20}{"max right ms":>16}')
    for name, _ in TESTS:
        c = [t for t in TIMES if t[0] == name and t[1] == 'classic']
        b = [t for t in TIMES if t[0] == name and t[1] == 'bristle']
        if not c:   # 破墨/积墨 rows: left = bristle (interact off), right = bristle + interact
            c, b = b, [t for t in TIMES if t[0] == name and t[1] == 'bristle+ia']
        name = name.split(chr(10))[0]
        print(f'{name:<16}{len(b):>4}{np.mean([t[2] for t in c]):>20.2f}{np.mean([t[2] for t in b]):>20.2f}'
              f'{max(t[2] for t in b):>16.2f}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'sheet.png'))
