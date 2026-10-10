"""v1 | v2 comparison sheets:  python shanshui/compare.py
compare_v1_v2.jpg  — whole paintings side by side;  detail_compare.jpg — 4 detail crop pairs."""
from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = '/usr/share/fonts/opentype/noto/NotoSerifCJK-SemiBold.ttc'
PAPER = (244, 238, 224)
INKC = (40, 30, 25)
# (title, (x0, y0, x1, y1)) in full-resolution pixels of the 2400x3200 sheet
DETAILS = [('主峰 · 皴法与墨色', (700, 60, 1900, 1500)), ('苔点', (850, 80, 1750, 700)),
           ('瀑布 · 叠泉与水汽', (1330, 880, 1770, 1600)), ('中景山', (0, 1450, 1250, 2300))]


def header(im, text, size):
    f = ImageFont.truetype(FONT, size, index=2)
    out = Image.new('RGB', (im.width, im.height + int(size * 1.8)), PAPER)
    out.paste(im, (0, int(size * 1.8)))
    ImageDraw.Draw(out).text((12, int(size * 0.3)), text, font=f, fill=INKC)
    return out


def side_by_side(a, b, gap=24):
    out = Image.new('RGB', (a.width + b.width + gap, max(a.height, b.height)), PAPER)
    out.paste(a, (0, 0))
    out.paste(b, (a.width + gap, 0))
    return out


def fit(im, w):
    return im.resize((w, int(im.height * w / im.width)), Image.LANCZOS)


def main():
    v1 = Image.open(os.path.join(HERE, 'shanshui_v1.png')).convert('RGB')
    v2 = Image.open(os.path.join(HERE, 'shanshui.png')).convert('RGB')
    full = side_by_side(header(fit(v1, 1100), 'v1', 34), header(fit(v2, 1100), 'v2', 34))
    full.save(os.path.join(HERE, 'compare_v1_v2.jpg'), quality=88)
    rows = []
    for title, box in DETAILS:
        a, b = fit(v1.crop(box), 760), fit(v2.crop(box), 760)
        rows.append(header(side_by_side(header(a, 'v1', 26), header(b, 'v2', 26)), title, 32))
    W = max(r.width for r in rows)
    sheet = Image.new('RGB', (W * 2 + 40, 10), PAPER)
    # two pairs per row of the sheet to keep it compact
    grid = [rows[i:i + 2] for i in range(0, len(rows), 2)]
    hs = [max(r.height for r in g) for g in grid]
    sheet = Image.new('RGB', (W * 2 + 40, sum(hs) + 30 * len(hs)), PAPER)
    y = 0
    for g, h in zip(grid, hs):
        for k, r in enumerate(g):
            sheet.paste(r, (k * (W + 40), y))
        y += h + 30
    sheet = fit(sheet, 2400) if sheet.width > 2400 else sheet
    sheet.save(os.path.join(HERE, 'detail_compare.jpg'), quality=85)
    for n in ('compare_v1_v2.jpg', 'detail_compare.jpg'):
        print(n, os.path.getsize(os.path.join(HERE, n)) // 1024, 'KB')


if __name__ == '__main__':
    main()
