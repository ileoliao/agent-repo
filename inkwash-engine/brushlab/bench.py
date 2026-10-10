"""Timing: bristle vs classic for a typical stroke (w=20, L≈400) and a 松针 needle (w=1.1, L≈70)."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from inkwash.core import Canvas  # noqa: E402

cv = Canvas(1000, 800, 1)
L = cv.layer('b')
cases = {'w20 L400 (zhong)': ([(100, 300), (300, 330), (500, 300)], 20, {}),
         'w20 L400 (ce, dry 0.8)': ([(100, 500), (300, 530), (500, 500)], 20, dict(tip='ce', dry=0.8)),
         'w20 L400 (wet 1.0)': ([(100, 650), (300, 680), (500, 650)], 20, dict(wet=1.0)),
         'w3 L200 (皴)': ([(600, 100), (700, 200), (720, 300)], 3, {}),
         'w1.1 L70 (松针)': ([(800, 400), (850, 450)], 1.1, dict(exit='tip'))}
L.stroke([(0, 0), (50, 50)], 5, model='bristle')
for name, (pts, w, kw) in cases.items():
    res = []
    for model in ('classic', 'bristle'):
        n = 20
        t = time.perf_counter()
        for _ in range(n):
            if model == 'classic':
                L.stroke(pts, w, **{k: v for k, v in kw.items() if k in ('dry', 'wet')})
            else:
                L.stroke(pts, w, model='bristle', **kw)
        res.append((time.perf_counter() - t) / n * 1e3)
    print(f'{name:<26} classic {res[0]:6.2f} ms   bristle {res[1]:6.2f} ms')
