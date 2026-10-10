"""从成片中抽帧拼成联系表(contact sheet)。

    python -m inkwash.contact out/chengdu_ink.mp4 out/contact_sheet.jpg
"""
from __future__ import annotations

import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

from .render import get_scenes
from .text import font


def grab(video, t, w):
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-ss', f'{t:.3f}', '-i', video, '-frames:v', '1',
                          '-vf', f'scale={w}:-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                         check=True, capture_output=True).stdout
    h = len(raw) // (w * 3)
    return Image.fromarray(np.frombuffer(raw, np.uint8).reshape(h, w, 3))


def main(video, out, cols=4, w=640):
    extra = {5: (0.35, 0.85), 12: (0.3, 0.83, 0.97)}
    picks = []
    for n, sc in enumerate(get_scenes(), 1):
        for q in extra.get(n, (0.6,)):
            picks.append((sc.start + sc.dur * q, sc.title))
    pad, lab = 12, 34
    tiles = [(grab(video, t, w), t, title) for t, title in picks]
    th = tiles[0][0].height
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * (w + pad) + pad, rows * (th + lab + pad) + pad + 70), (236, 228, 210))
    d = ImageDraw.Draw(sheet)
    d.text((pad + 4, 18), '锦城千年 · 程序化水墨动画 · 联系表', font=font(34), fill=(40, 30, 25))
    for k, (im, t, title) in enumerate(tiles):
        x = pad + (k % cols) * (w + pad)
        y = 70 + pad + (k // cols) * (th + lab + pad)
        sheet.paste(im, (x, y))
        m, s = divmod(t, 60)
        d.text((x + 2, y + th + 4), f'{int(m)}:{s:05.2f}  {title}', font=font(22, 'Medium'), fill=(70, 50, 40))
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    sheet.save(out, quality=92)
    print(out, len(tiles), 'frames')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
