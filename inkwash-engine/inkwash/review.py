"""自检工具：渲染若干时刻的帧并拼成网格图。

    python -m inkwash.review out/review.png 3.0 10.0 ...
"""
from __future__ import annotations

import sys

import cv2
import numpy as np

from .render import Composer, to_u8


def sheet(path, times, cols=2, w=960, label=True):
    comp = Composer()
    tiles = []
    for t in times:
        img = cv2.cvtColor(to_u8(comp.frame(float(t))), cv2.COLOR_RGB2BGR)
        im = cv2.resize(img, (w, w * 9 // 16), interpolation=cv2.INTER_AREA)
        if label:
            cv2.putText(im, f'{float(t):.2f}s', (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (40, 40, 160), 2, cv2.LINE_AA)
        tiles.append(im)
    while len(tiles) % cols:
        tiles.append(np.full_like(tiles[0], 255))
    rows = [np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]
    cv2.imwrite(path, np.vstack(rows))
    print(path)


if __name__ == '__main__':
    sheet(sys.argv[1], sys.argv[2:])
