"""디지털 PDF → '스캔본처럼 보이는' 이미지 PDF (텍스트 레이어 없음)
사용: python3 make-scan.py input.pdf output.pdf [jpg폴더]
(pdftoppm 이 없으면 PyMuPDF 로 쪽 그림을 만듦)
"""
import glob
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageFilter

src, dst = sys.argv[1], sys.argv[2]
jpg_dir = sys.argv[3] if len(sys.argv) > 3 else None


def render(pdf, out_dir):
    if shutil.which('pdftoppm'):
        subprocess.run(['pdftoppm', '-r', '200', '-png', pdf, os.path.join(out_dir, 'p')], check=True)
        return
    import pymupdf
    with pymupdf.open(pdf) as doc:
        for i, pg in enumerate(doc):
            pg.get_pixmap(dpi=200).save(os.path.join(out_dir, f'p-{i + 1:03d}.png'))


with tempfile.TemporaryDirectory() as tmp:
    render(src, tmp)
    pages = []
    rng = np.random.default_rng(3)
    for i, f in enumerate(sorted(glob.glob(os.path.join(tmp, 'p*.png')))):
        im = Image.open(f).convert('L')
        im = im.rotate(0.35 if i % 2 == 0 else -0.25, resample=Image.BICUBIC, fillcolor=255)
        im = im.filter(ImageFilter.GaussianBlur(0.6))
        a = np.asarray(im).astype(np.int16)
        a = a + rng.normal(0, 7, a.shape).astype(np.int16)
        # 종이 질감 + 군데군데 점
        speck = rng.random(a.shape) < 0.0004
        a[speck] = 60
        a = np.clip(a * 0.97 + 6, 0, 255).astype(np.uint8)
        pages.append(Image.fromarray(a).convert('RGB'))
    pages[0].save(dst, save_all=True, append_images=pages[1:], resolution=200.0, quality=82)
    if jpg_dir:
        os.makedirs(jpg_dir, exist_ok=True)
        for i, pg in enumerate(pages):
            pg.save(os.path.join(jpg_dir, f'photo-{i + 1}.jpg'), quality=85)
print('scan →', dst)
