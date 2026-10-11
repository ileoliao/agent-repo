"""Deliverable images: compare_pr3_new.jpg (PR3 bristle column | v2 bristle column) and ref_vs_new.jpg.

  python3 brushlab/sheet.py /tmp/sheet_new.png && python3 brushlab/make_compare.py /tmp/sheet_new.png [r5_sheet.png]

With a second sheet (v2 r5, e.g. rendered from commit 4639c8d in a worktree) also writes compare_final3.jpg:
PR3 bristle | v2 r5 bristle | final bristle.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
F = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc'
R = os.path.join(HERE, 'ref')
LBL, TOP, CW, CH = 230, 90, 660, 250


def final3(old, r5, new):
    H = new.height
    out = Image.new('RGB', (LBL + 3 * CW, H), (245, 240, 228))
    out.paste(old.crop((0, 0, LBL, H)), (0, 0))
    for k, im in enumerate((old, r5, new)):
        out.paste(im.crop((LBL + CW, 0, LBL + 2 * CW, H)), (LBL + k * CW, 0))
    d = ImageDraw.Draw(out)
    f = ImageFont.truetype(F, 30)
    d.rectangle([LBL, 0, LBL + 3 * CW, 85], fill=(245, 240, 228))
    for k, t in enumerate(('PR3 · bristle', 'v2 r5 · bristle', 'final r7 · bristle')):
        d.text((LBL + k * CW + 20, 25), t, fill=(120, 40, 30), font=f)
        if k:
            d.line([(LBL + k * CW, 0), (LBL + k * CW, H)], fill=(160, 150, 130), width=2)
    out.resize((out.width * 3 // 4, out.height * 3 // 4), Image.LANCZOS).save(
        os.path.join(HERE, 'compare_final3.jpg'), quality=85)


def main(sheet, r5=None):
    new = Image.open(sheet).convert('RGB')
    old = Image.open(os.path.join(HERE, 'pr3_sheet_final.jpg')).convert('RGB')
    H = new.height
    out = Image.new('RGB', (LBL + 2 * CW, H), (245, 240, 228))
    out.paste(old.crop((0, 0, LBL, H)), (0, 0))
    out.paste(old.crop((LBL + CW, 0, LBL + 2 * CW, H)), (LBL, 0))
    out.paste(new.crop((LBL + CW, 0, LBL + 2 * CW, H)), (LBL + CW, 0))
    d = ImageDraw.Draw(out)
    f = ImageFont.truetype(F, 30)
    d.rectangle([LBL, 0, LBL + 2 * CW, 85], fill=(245, 240, 228))
    d.text((LBL + 20, 25), 'PR3 · bristle (旧)', fill=(120, 40, 30), font=f)
    d.text((LBL + CW + 20, 25), 'v2 · bristle (新)', fill=(120, 40, 30), font=f)
    d.line([(LBL + CW, 0), (LBL + CW, H)], fill=(160, 150, 130), width=2)
    out.resize((out.width * 3 // 4, out.height * 3 // 4), Image.LANCZOS).save(
        os.path.join(HERE, 'compare_pr3_new.jpg'), quality=85)
    if r5:
        final3(old, Image.open(r5).convert('RGB'), new)

    def row(i):
        return new.crop((LBL + CW, TOP + i * CH, LBL + 2 * CW, TOP + (i + 1) * CH))

    def fit(im, w, h):
        im = im.copy()
        im.thumbnail((w, h), Image.LANCZOS)
        c = Image.new('RGB', (w, h), (255, 255, 255))
        c.paste(im, ((w - im.width) // 2, (h - im.height) // 2))
        return c

    zb = Image.open(os.path.join(R, 'zhuda_bamboo.jpg')).convert('RGB')
    dots = np.hstack([np.asarray(row(9).crop((150, 60, 560, 190))),
                      np.asarray(row(1).crop((180, 0, 560, 250)).resize((410, 130)))])
    pairs = [('八大山人 竹叶 (侧锋实笔)', zb.crop((1150, 800, 1640, 1250)), '侧锋阔笔', row(2)),
             ('八大山人 淡墨竹叶 (湿笔、水线)', zb.crop((60, 900, 560, 1330)), '淡墨湿笔', row(4)),
             ('八大山人 竹竿 (后段飞白)', zb.crop((880, 0, 1240, 700)).rotate(90, expand=True), '飞白枯笔', row(3)),
             ('黄庭坚 枯笔细线', Image.open(os.path.join(R, 'huang_tingjian.jpg')).crop((330, 520, 560, 760)),
              '披麻皴(一束)', row(10)),
             ('米芾 点与中锋', Image.open(os.path.join(R, 'mifu_grass.jpg')).crop((1650, 40, 1780, 350)),
              '点 / 中锋竖画', Image.fromarray(dots))]
    W2, H2 = 600, 330
    out = Image.new('RGB', (2 * W2 + 30, len(pairs) * (H2 + 50) + 20), (250, 248, 242))
    d = ImageDraw.Draw(out)
    f = ImageFont.truetype(F, 24)
    for i, (a, ia, b, ib) in enumerate(pairs):
        y = 10 + i * (H2 + 50)
        d.text((10, y), '参考: ' + a, fill=(90, 40, 30), font=f)
        d.text((W2 + 30, y), '新模型: ' + b, fill=(90, 40, 30), font=f)
        out.paste(fit(ia, W2, H2), (10, y + 40))
        out.paste(fit(ib, W2, H2), (W2 + 20, y + 40))
    out.save(os.path.join(HERE, 'ref_vs_new.jpg'), quality=85)
    print('saved compare_pr3_new.jpg, ref_vs_new.jpg')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'sheet.png'), sys.argv[2] if len(sys.argv) > 2 else None)
