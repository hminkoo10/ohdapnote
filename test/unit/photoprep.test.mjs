import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homography, project, planPhoto, photoPoint, estimateSkew, preparePhoto } from '../../src/renderer/js/photoprep.js';

function raster(w, h, pixel) {
  const data = new Uint8ClampedArray(w*h*4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const color = pixel(x, y), k = (y*w+x)*4;
    data.set(Array.isArray(color) ? [...color, 255] : [color, color, color, 255], k);
  }
  return { width: w, height: h, data };
}

function spread({ spine = 300, curl = 0, shadow = 0.18, line = true } = {}) {
  return raster(600, 450, (x, y) => {
    const bend = curl*Math.max(0, 1-Math.abs(x-spine)/230)**4;
    if (y < 60+bend || y > 390-bend || x < 60+(390-y)*0.1 || x > 540-(390-y)*0.1) return [105, 80, 55];
    if (line && Math.abs(x-spine) <= 1) return 50;
    if (y > 100 && y < 345 && y%30 < 2 && x%108 > 12 && x%108 < 88) return 35;
    return Math.round(250*(1-shadow*Math.exp(-(((x-spine)/42)**2))));
  });
}

test('원근 변환: 사각형 네 모서리와 중앙', () => {
  const q = [[20, 10], [180, 30], [200, 300], [0, 300]], m = homography(q);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const p = project(m, u, v);
    assert.ok(Math.hypot(p[0]-q[i][0], p[1]-q[i][1]) < 1e-8);
  });
  assert.deepEqual(project(homography([[0, 0], [200, 0], [200, 300], [0, 300]]), 0.5, 0.5), [100, 150]);
  assert.equal(homography([[0, 0], [1, 0], [2, 0], [3, 0]]), null);
});

test('펼친 두 쪽: 접힌 선에서 좌우 분리, 보정 크기·좌우 순서', () => {
  const plan = planPhoto(spread());
  assert.equal(plan.reason, 'spread');
  assert.equal(plan.pages.length, 2);
  assert.ok(Math.abs(plan.split.mid-0.5) < 0.012);
  for (const p of plan.pages) {
    assert.ok(p.width > 215 && p.width < 235, `width=${p.width}`);
    assert.ok(p.height > 325 && p.height < 338, `height=${p.height}`);
  }
  assert.ok(photoPoint(plan.pages[0], 1, 0.5)[0] < 300);
  assert.ok(photoPoint(plan.pages[1], 0, 0.5)[0] > 298);
});

test('가운데가 아닌 접힌 선도 찾는다', () => {
  const plan = planPhoto(spread({ spine: 278 }));
  assert.equal(plan.pages.length, 2);
  assert.ok(plan.split.mid > 0.43 && plan.split.mid < 0.47);
});

test('휜 상하 종이 경계를 따라 접힌 곳의 글줄 높이 보정', () => {
  const plan = planPhoto(spread({ curl: 22, shadow: 0.25 }));
  assert.equal(plan.pages.length, 2);
  assert.ok(plan.pages.every((p) => p.curves));
  const left = plan.pages[0];
  const outside = photoPoint(left, 0.05, 0.05), inside = photoPoint(left, 0.97, 0.05);
  assert.ok(inside[1]-outside[1] > 14);
  assert.ok(inside[1]-outside[1] < 26);
});

test('반듯한 2단 스캔은 중앙 인쇄선이 있어도 원본 유지', () => {
  const scan = raster(420, 600, (x, y) => {
    if (x === 210 && y > 40 && y < 560) return 100;
    return y > 60 && y < 530 && y%35 < 2 && x%210 > 25 && x%210 < 180 ? 30 : 255;
  });
  const plan = planPhoto(scan);
  assert.equal(plan.changed, false);
  assert.equal(plan.reason, 'flat-scan');
});

test('인쇄 구분선·접힘 없는 가로 종이를 두 쪽으로 나누지 않는다', () => {
  for (const line of [false, true]) {
    const plan = planPhoto(spread({ shadow: 0, line }));
    assert.equal(plan.changed, false);
    assert.equal(plan.reason, 'uncertain-spine');
  }
});

test('배경·잘린 종이·작은 이미지는 손대지 않는다', async () => {
  assert.equal(planPhoto(raster(300, 400, () => [65, 90, 125])).changed, false);
  const clipped = raster(400, 550, (x, y) => x > 75 && y < 500 ? 240 : 45);
  assert.equal(planPhoto(clipped).changed, false);
  const source = { width: 120, height: 90 };
  assert.strictEqual((await preparePhoto(source)).pages[0], source);
});

test('한 쪽의 원근 보정 크기', () => {
  const im = raster(420, 560, (x, y) => y >= 55 && y <= 505 && x >= 50+(505-y)*0.07 && x <= 370-(505-y)*0.04 ? 245 : [100, 70, 50]);
  const plan = planPhoto(im);
  assert.equal(plan.changed, true);
  assert.equal(plan.pages.length, 1);
  assert.ok(Math.abs(plan.pages[0].width-295) < 5);
  assert.ok(Math.abs(plan.pages[0].height-450) < 5);
});

test('종이·책상 경계의 대비가 낮으면 원본 유지', () => {
  const im = raster(420, 560, (x, y) => y >= 55 && y <= 505 && x >= 65 && x <= 355 ? 195 : 185);
  assert.equal(planPhoto(im).changed, false);
});

test('투영 프로파일: 양·음 기울기와 작은 기울기 무변경', () => {
  for (const degrees of [-5, 0, 0.3, 4, 8]) {
    const im = raster(440, 600, (x, y) => {
      const lineY = y-Math.tan(degrees*Math.PI/180)*(x-220);
      return x > 40 && x < 400 && lineY > 80 && lineY < 520 && ((lineY%30)+30)%30 < 2 ? 30 : 255;
    });
    const gray = Uint8Array.from({ length: 440*600 }, (_, i) => im.data[i*4]);
    const got = estimateSkew({ w: 440, h: 600, gray })*180/Math.PI;
    if (Math.abs(degrees) < 0.7) assert.equal(got, 0);
    else assert.ok(Math.abs(got-degrees) < 0.4, `${degrees} → ${got}`);
  }
});
