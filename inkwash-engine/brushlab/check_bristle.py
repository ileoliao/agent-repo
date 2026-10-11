"""Bristle regression (interaction off): `save` writes A/T of all bristle test strokes, `cmp` compares (np.array_equal).

Run `save` on the commit BEFORE changes, `cmp` after. Only the bristle (right) column of brushlab/tests.py is rendered."""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
from inkwash.core import Canvas  # noqa: E402
from tests import CH, CW, TESTS  # noqa: E402

REF = '/tmp/bristle_ref.npz'


NEW_ROWS = ('破墨', '积墨', '湿破湿', '对照')


def render():
    base = [(n, f) for n, f in TESTS if not n.startswith(NEW_ROWS)]   # interaction rows are new; not in the reference
    cv = Canvas(CW + 40, len(base) * CH, 21)
    L = cv.layer('t', halo=0.9)
    for i, (name, fn) in enumerate(base):
        fn(L, 0, i * CH, True)
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
