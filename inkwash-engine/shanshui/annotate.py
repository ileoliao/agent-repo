"""Annotated copy of the preview: small Chinese technique labels with thin leader lines.

python shanshui/annotate.py   (reads shanshui_preview.jpg + labels.json written by paint.py)
Anchor points come from labels.json, i.e. from where paint.py actually drew each technique."""
from __future__ import annotations

import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = '/usr/share/fonts/opentype/noto/NotoSerifCJK-SemiBold.ttc'

# label text shown for each technique key (key = name used in paint code)
TEXT = {
    '高远': '高远 · 主峰', '深远': '深远 · 层峦', '平远': '平远 · 远汀', '披麻皴': '披麻皴', '斧劈皴': '斧劈皴',
    '米点皴': '米点皴', '积墨': '积墨', '破墨': '破墨', '泼墨': '泼墨', '飞白': '飞白', '留白': '留白 · 瀑布',
    '云雾': '留白 · 云雾', '点苔': '点苔', '勾勒': '勾勒 + 渲染', '松针': '松针', '介字点': '介字点', '个字点': '个字点',
    '焦墨': '焦墨', '浓墨': '浓墨', '重墨': '重墨', '淡墨': '淡墨', '清墨': '清墨', '茅亭': '茅亭', '渔舟': '渔舟 · 倒影',
    '印章': '印章', '题款': '题款', '叠泉': '叠泉', '水汽': '水汽', '侧锋': '侧锋 · 干笔',
}
# for techniques recorded several times, which occurrence to point at
PICK = {'留白': 0, '勾勒': 0, '飞白': -1}
# regions labels must never cover (design units): the inscription + name seal
KEEP_CLEAR = [(2030, 120, 2350, 720)]


def candidates(r):
    for k in range(16):
        a = k * math.pi / 8 + 0.2
        yield r * math.cos(a), r * math.sin(a)


def main(src=None, labels=None, out=None):
    src = src or os.path.join(HERE, 'shanshui_preview.jpg')
    labels = labels or os.path.join(HERE, 'labels.json')
    out = out or os.path.join(HERE, 'techniques_annotated.jpg')
    im = Image.open(src).convert('RGB')
    W, H = im.size
    meta = json.load(open(labels, encoding='utf-8'))
    sx = W / meta['sheet'][0]
    lum = np.asarray(im.convert('L'), np.float32) / 255
    font = ImageFont.truetype(FONT, max(14, int(W * 0.0155)), index=2)
    dr = ImageDraw.Draw(im)
    boxes = [tuple(v * sx for v in k) for k in KEEP_CLEAR]
    pts = []
    for key, txt in TEXT.items():
        if key not in meta['labels']:
            continue
        p = meta['labels'][key][PICK.get(key, 0)]
        pts.append((key, txt, p[0] * sx, p[1] * sx))
    anchors = [(x, y) for _, _, x, y in pts]
    for key, txt, x, y in pts:
        l, t, r, b = dr.textbbox((0, 0), txt, font=font)
        tw, th = r - l + 10, b - t + 8
        best, bs = None, -1e9
        for rad in (70, 110, 150, 200):
            for dx, dy in candidates(rad):
                bx, by = x + dx - tw / 2, y + dy - th / 2
                if bx < 4 or by < 4 or bx + tw > W - 4 or by + th > H - 4:
                    continue
                box = (bx, by, bx + tw, by + th)
                ov = sum(max(0, min(box[2], o[2]) - max(box[0], o[0])) * max(0, min(box[3], o[3]) - max(box[1], o[1]))
                         for o in boxes)
                cover = sum(1 for (ax, ay) in anchors if box[0] - 8 < ax < box[2] + 8 and box[1] - 8 < ay < box[3] + 8)
                bright = float(lum[int(by):int(by + th), int(bx):int(bx + tw)].mean())
                score = bright * 40 - ov * 0.5 - cover * 30 - rad * 0.04
                if score > bs:
                    bs, best = score, box
        bx0, by0, bx1, by1 = best
        boxes.append(best)
        assert best is not None
        cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
        ex = min(max(x, bx0), bx1) if not (bx0 <= x <= bx1) else cx
        ey = by1 if y > by1 else (by0 if y < by0 else cy)
        dr.line([(x, y), (ex, ey)], fill=(150, 30, 25), width=1)
        dr.ellipse([x - 3, y - 3, x + 3, y + 3], outline=(150, 30, 25), width=1)
        dr.rounded_rectangle(best, radius=4, fill=(246, 240, 226), outline=(150, 30, 25), width=1)
        dr.text((bx0 + 5 - l, by0 + 4 - t), txt, font=font, fill=(40, 30, 25))
    im.save(out, quality=90)
    print('annotated', out, len(boxes) - len(KEEP_CLEAR), 'labels')


if __name__ == '__main__':
    import sys
    d = sys.argv[1] if len(sys.argv) > 1 else HERE
    main(os.path.join(d, 'shanshui_preview.jpg'), os.path.join(d, 'labels.json'),
         os.path.join(d, 'techniques_annotated.jpg'))
