"""기존 2단 PDF → 펼친 책 사진·번호 위치 정답. 생성물은 generated/ 안에만 저장.
사용: python test/fixtures/make-photo-spreads.py [기존 generated 폴더]
시험 환경: Pillow, numpy, PyMuPDF (앱 의존성 아님).
"""
import json
import sys
from pathlib import Path

import numpy as np
import pymupdf
from PIL import Image

ROOT = Path(__file__).resolve().parent / 'generated'
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT
OUT = ROOT / 'photo-spreads'
OUT.mkdir(parents=True, exist_ok=True)
W, H = 4000, 3000
PW, PH = 1500, 2123


def project(matrix, x, y):
    z = matrix[2, 0] * x + matrix[2, 1] * y + matrix[2, 2]
    return ((matrix[0, 0] * x + matrix[0, 1] * y + matrix[0, 2]) / z,
            (matrix[1, 0] * x + matrix[1, 1] * y + matrix[1, 2]) / z)


def homography(src, dst):
    a, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        a.extend([[x, y, 1, 0, 0, 0, -u*x, -u*y],
                  [0, 0, 0, x, y, 1, -v*x, -v*y]])
        b.extend([u, v])
    return np.append(np.linalg.solve(a, b), 1).reshape(3, 3)


doc = pymupdf.open(SOURCE / 'book-serial.pdf')
pages, labels = [], []
for pi in [0, 2]:
    pg = doc[pi]
    pix = pg.get_pixmap(matrix=pymupdf.Matrix(PW / pg.rect.width, PH / pg.rect.height), alpha=False)
    pages.append(np.asarray(Image.frombytes('RGB', (pix.width, pix.height), pix.samples).resize((PW, PH))))
    labels.append([{'number': w[4], 'rect': [w[0]/pg.rect.width, w[1]/pg.rect.height,
                                           w[2]/pg.rect.width, w[3]/pg.rect.height]}
                   for w in pg.get_text('words') if len(w[4]) == 4 and w[4].isdigit()])
for pi, pixels in enumerate(pages):
    Image.fromarray(pixels).save(OUT / f'flat-{pi + 1}.png')
flat = np.concatenate(pages, axis=1)
cases = [
    ('spread-3deg', 3, 0.025, 0.022, 0.14),
    ('spread-minus5deg', -5, 0.065, 0.038, 0.24),
    ('spread-8deg', 8, 0.09, 0.055, 0.30),
]
manifest = {'source': 'book-serial.pdf', 'sourcePages': [0, 2], 'cases': []}
for name, angle, perspective, curl, shadow in cases:
    corners = np.array([[450 + W*perspective, 390], [3500 - W*perspective, 430],
                        [3500, 2570], [450, 2550]], dtype=float)
    radians = np.deg2rad(angle)
    rotation = np.array([[np.cos(radians), -np.sin(radians)], [np.sin(radians), np.cos(radians)]])
    corners = (corners - [2000, 1500]) @ rotation.T + [2000, 1500]
    matrix = homography([[0, 0], [2*PW-1, 0], [2*PW-1, PH-1], [0, PH-1]], corners)
    inverse = np.linalg.inv(matrix)
    result = np.empty((H, W, 3), dtype=np.uint8)
    rng = np.random.default_rng(1600)
    for start in range(0, H, 120):
        yy, xx = np.mgrid[start:min(H, start+120), :W]
        px, py = project(inverse, xx, yy)
        fold = np.maximum(0, 1 - np.abs(px-PW)/PW) ** 4
        bend = curl * PH * fold
        sy = (py - bend) / (1 - 2*bend/(PH-1))
        inside = (px >= 0) & (px < 2*PW-1) & (sy >= 0) & (sy < PH-1)
        sx = np.clip(px, 0, 2*PW-1.001)
        sy = np.clip(sy, 0, PH-1.001)
        ix, iy = sx.astype(int), sy.astype(int)
        fx, fy = (sx-ix)[..., None], (sy-iy)[..., None]
        value = ((flat[iy, ix]*(1-fx) + flat[iy, ix+1]*fx)*(1-fy)
                 + (flat[iy+1, ix]*(1-fx) + flat[iy+1, ix+1]*fx)*fy)
        light = 1 - shadow*np.exp(-((px-PW)/(PW*0.20))**2) - 0.10*(1-px/(2*PW))
        value *= light[..., None]
        value[np.abs(px-PW) < 4] *= 0.24
        desk = np.stack([108 + 5*np.sin(yy/41), 83 + 3*np.sin(yy/41), 61 + 2*np.sin(yy/41)], axis=2)
        desk[(yy < 210) & (xx > 650) & (xx < 3400)] = [32, 34, 38]
        value = np.where(inside[..., None], value, desk)
        value += rng.normal(0, 0.8, value.shape)
        result[start:start+len(yy)] = np.clip(value, 0, 255).astype(np.uint8)
    Image.fromarray(result).save(OUT / f'{name}.jpg', quality=93)
    truth = []
    for pi, entries in enumerate(labels):
        for item in entries:
            x0, y0, x1, y1 = item['rect']
            polygon = []
            for x, y in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]:
                px = (pi+x)*PW
                bend = curl*PH*max(0, 1-abs(px-PW)/PW)**4
                py = bend + y*(PH-1-2*bend)
                xx, yy = project(matrix, px, py)
                polygon.append([round(float(xx), 3), round(float(yy), 3)])
            truth.append({'page': pi, **item, 'photoPolygon': polygon})
    manifest['cases'].append({'file': f'{name}.jpg', 'width': W, 'height': H,
                              'rotation': angle, 'curl': curl, 'shadow': shadow,
                              'corners': corners.tolist(), 'questions': truth})
    print(name, len(truth), 'questions', flush=True)
(OUT / 'expected.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
