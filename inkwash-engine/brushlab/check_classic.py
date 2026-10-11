"""Classic stroke regression: `save` writes a reference from the current code, `cmp` compares (np.array_equal)."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from inkwash.core import Canvas, INDIGO  # noqa: E402

REF = '/tmp/classic_ref.npz'


def render():
    cv = Canvas(640, 480, 11)
    L = cv.layer('t')
    L.stroke([(40, 60), (300, 80), (600, 50)], 12, ink=0.9, dry=0.6, t0=0.2, dur=1.0)
    L.stroke([(80, 400), (200, 200), (320, 420)], 3, wet=0.9, pig=INDIGO)
    L.dot(500, 300, 14, ink=1.0)
    L.stroke([(400, 150), (420, 420)], 30, dry=0.9, bristle=2.0, taper=(0.03, 0.8), start_w=1.0)
    L.finalize()
    return L.A, L.T


if __name__ == '__main__':
    A, T = render()
    if sys.argv[1] == 'save':
        np.savez(REF, A=A, T=T)
        print('saved', REF)
    else:
        r = np.load(REF)
        print('A equal:', np.array_equal(r['A'], A), ' T equal:', np.array_equal(r['T'], T))
