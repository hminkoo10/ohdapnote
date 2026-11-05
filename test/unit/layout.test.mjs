import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inkGridFromRgba, analyzeLayout, trimRect, cutAbove, snapUpToGap, trimPassageMargins } from '../../src/renderer/js/layout.js';

/** 흰 종이 RGBA 에 회색 사각형들을 칠함 (lum: 0 검정 ~ 255 흰색) */
function paper(w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  const fill = (x0, y0, x1, y1, lum) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = lum;
      }
    }
  };
  // 테두리만 (두께 2px)
  const box = (x0, y0, x1, y1, lum) => {
    fill(x0, y0, x1, y0 + 2, lum);
    fill(x0, y1 - 2, x1, y1, lum);
    fill(x0, y0, x0 + 2, y1, lum);
    fill(x1 - 2, y0, x1, y1, lum);
  };
  return { rgba, fill, box };
}

test('inkGridFromRgba + trimRect: 연한 회색 상자 테두리는 잘라내지 않고, rect 밖으로 뻗는 쪽 테두리는 넣지 않음', () => {
  const W = 480;
  const H = 600;
  const { rgba, fill, box } = paper(W, H);
  fill(60, 100, 240, 116, 0); // 문항 첫 줄 (검정)
  fill(80, 200, 220, 214, 0); // 상자 안 조건 (가)(나)
  box(60, 180, 400, 240, 210); // 옅은 회색 상자 — 글자보다 오른쪽·아래로 더 큼
  box(20, 20, 460, 580, 210); // 쪽 전체를 두른 옅은 테두리
  const grid = inkGridFromRgba(rgba, W, H);
  assert.equal(grid.w, 240);
  // 어두운 잉크 격자에는 연한 테두리가 없음
  assert.equal(grid.data[Math.floor(239 / 2) * grid.w + Math.floor(398 / 2)], 0);
  const r = trimRect(grid, { x: 0.1, y: 0.15, w: 0.8, h: 0.3 }, 0);
  // 상자 오른쪽 끝(400px ≈ 0.833)·아래 끝(240px = 0.4)까지 들어감
  assert.ok(r.x + r.w >= 0.83, `오른쪽 ${r.x + r.w}`);
  assert.ok(r.y + r.h >= 0.399, `아래 ${r.y + r.h}`);
  // 쪽 테두리(20px, 460px)는 들어가지 않음
  assert.ok(r.x >= 0.12 && r.x + r.w <= 0.85, `가로 ${r.x}~${r.x + r.w}`);
});

test('trimRect: 글자 아래쪽에 따로 떨어진 옅은 가로선(다음 제목 띠의 윗변)이나 옆의 세로선 토막은 넣지 않음', () => {
  const W = 480;
  const H = 600;
  const { rgba, fill } = paper(W, H);
  fill(60, 100, 300, 116, 0); // 문항 글줄
  fill(60, 130, 260, 146, 0);
  fill(60, 300, 420, 302, 210); // 아래쪽 제목 띠의 옅은 윗변
  fill(440, 90, 442, 200, 210); // 오른쪽의 옅은 세로선 토막
  const grid = inkGridFromRgba(rgba, W, H);
  const r = trimRect(grid, { x: 0.1, y: 0.14, w: 0.85, h: 0.4 }, 0);
  assert.ok(r.y + r.h <= 147 / 600 + 0.01, `아래 ${(r.y + r.h) * 600}`);
  assert.ok(r.x + r.w <= 301 / 480 + 0.01, `오른쪽 ${(r.x + r.w) * 480}`);
});

test('analyzeLayout: 쪽 아래쪽 상자의 옅은 밑변까지 본문으로 봄 (꼬리말은 뺌)', () => {
  const W = 480;
  const H = 600;
  const { rgba, fill, box } = paper(W, H);
  for (let y = 60; y < 480; y += 20) fill(40, y, 440, y + 8, 0); // 본문 글줄
  box(40, 470, 440, 520, 210); // 마지막 상자의 옅은 테두리 (글줄보다 아래로 내려옴)
  fill(220, 570, 260, 580, 0); // 쪽번호
  const L = analyzeLayout(inkGridFromRgba(rgba, W, H));
  assert.ok(L.hasFooter);
  assert.ok(L.bodyBottom >= 518 / 600, `본문 아래 ${L.bodyBottom * 600}`);
  assert.ok(L.bodyBottom < 570 / 600);
});

test('analyzeLayout: 쪽 아래까지 내려오는 옅은 세로선(단 구분 점선)이 있어도 꼬리말(쪽번호)은 본문이 아님', () => {
  const W = 480;
  const H = 600;
  const { rgba, fill } = paper(W, H);
  for (let y = 60; y < 480; y += 20) {
    fill(40, y, 220, y + 8, 0);
    fill(260, y, 440, y + 8, 0);
  }
  fill(239, 40, 241, 580, 210); // 옅은 세로선
  fill(60, 570, 100, 580, 0); // 쪽번호
  const L = analyzeLayout(inkGridFromRgba(rgba, W, H));
  assert.ok(L.hasFooter);
  assert.ok(L.bodyBottom < 560 / 600, `본문 아래 ${L.bodyBottom * 600}`);
});

/** 칸 격자 직접 만들기 */
function cells(w, h) {
  const data = new Uint8Array(w * h);
  const fill = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * w + x] = 1;
  };
  return { grid: { w, h, data }, fill };
}

test('analyzeLayout: 좁은 거터의 기울어진 세로선은 줄 합집합으로 단을 나눔', () => {
  const { grid, fill } = cells(240, 340);
  grid.lines = new Uint8Array(grid.data.length);
  for (let y = 35; y < 310; y += 7) {
    fill(20, y, 117, y + 3);
    fill(124, y, 220, y + 3);
  }
  for (let y = 35; y < 310; y++) {
    const x = 119 + Math.floor((y - 35) / 95);
    grid.lines[y * grid.w + x] = 2;
    grid.data[y * grid.w + x] = 1;
  }
  // 선 양옆 번짐 때문에 빈칸 규칙만으로는 못 나눔
  for (let y = 35; y < 310; y += 20) fill(117, y, 124, y + 1);
  const L = analyzeLayout(grid);
  assert.equal(L.columns.length, 2);
  assert.ok(L.gutters[0].rule);
  assert.ok(L.columns[0].x1 <= 0.5 && L.columns[1].x0 >= 0.5);
  // 같은 줄의 짧은 선 여러 개를 더해서 긴 선으로 보지는 않음
  grid.lines.fill(0);
  for (let y = 0; y < grid.h; y++) for (let x = 117; x < 124; x++) grid.data[y * grid.w + x] = 0;
  fill(117, 35, 124, 65);
  for (let y = 35; y < 65; y++) for (let x = 119; x < 122; x++) grid.lines[y * grid.w + x] = 2;
  assert.equal(analyzeLayout(grid).columns.length, 1);
});

test('trimPassageMargins: 기울어진 머리선·쪽번호와 그 아래 꼬리말만 제외', () => {
  const { grid, fill } = cells(240, 340);
  grid.lines = new Uint8Array(grid.data.length);
  fill(20, 20, 220, 27);
  for (let x = 20; x < 220; x++) grid.lines[(30 + Math.floor((x - 20) / 70)) * 240 + x] = 1;
  for (let y = 38; y < 315; y += 6) {
    fill(20, y, 110, y + 2);
    fill(130, y, 220, y + 2);
  }
  fill(113, 320, 130, 328);
  fill(150, 330, 220, 334);
  const columns = [{ x0: 20 / 240, x1: 110 / 240 }, { x0: 130 / 240, x1: 220 / 240 }];
  const L = { blank: false, columns, bodyTop: 20 / 340, bodyBottom: 334 / 340, content: {}, spans: [{ y0: 30 / 340, y1: 33 / 340 }, { y0: 0.5, y1: 0.52 }] };
  trimPassageMargins(grid, L);
  assert.equal(L.bodyTop, 33 / 340);
  assert.equal(L.bodyBottom, 320 / 340);
  assert.ok(L.hasHeader && L.hasFooter);
  assert.deepEqual(L.spans, [{ y0: 0.5, y1: 0.52 }]);
  // 본문 아래에 따로 놓인 왼쪽 글줄은 쪽번호가 아님
  for (let y = 320; y < 328; y++) for (let x = 113; x < 130; x++) grid.data[y * 240 + x] = 0;
  fill(20, 320, 80, 328);
  const other = { bodyTop: 0.1, bodyBottom: 1, content: {} };
  trimPassageMargins(grid, other);
  assert.equal(other.bodyBottom, 1);
  assert.equal(other.bodyTop, 0.1); // 1단 교재 상자 윗변은 머리선이 아님
  for (let y = 30; y < 33; y++) for (let x = 111; x < 130; x++) grid.lines[y * 240 + x] = 0;
  const boxes = { columns, bodyTop: 0.05, bodyBottom: 1, content: {} };
  trimPassageMargins(grid, boxes);
  assert.equal(boxes.bodyTop, 0.05); // 같은 높이 양쪽 상자도 제외
});

test('trimPassageMargins: 쪽번호와 높이가 겹친 옆 단 끝줄은 보존', () => {
  const { grid, fill } = cells(240, 340);
  grid.lines = new Uint8Array(grid.data.length);
  fill(20, 318, 75, 320); // 왼쪽 단 끝줄
  fill(125, 319, 130, 320); // 기울어진 쪽번호 윗변
  fill(113, 320, 132, 328);
  for (let x = 113; x < 132; x++) grid.lines[327 * 240 + x] = 1;
  const L = { bodyTop: 0.1, bodyBottom: 1, content: {} };
  trimPassageMargins(grid, L);
  assert.equal(L.bodyBottom, 328 / 340);
  assert.equal(grid.data[319 * 240 + 20], 1);
  assert.equal(grid.data[319 * 240 + 125], 0);
  assert.equal(grid.lines[327 * 240 + 120], 0);
  const r = trimRect(grid, { x: 0, y: 0.9, w: 1, h: 0.1 }, 0);
  assert.equal(r.y + r.h, 320 / 340);
});

test('cutAbove: 번호 바로 위에 붙은 좁은 문항 코드 줄은 그 문항으로, 앞 문항 마지막 줄은 앞 문항으로', () => {
  const W = 120;
  const H = 300;
  const a = { y0: 56 / H, h: 9 / H, x0: 10 / W, x1: 18 / W };
  // 1) [26009-0012] 같은 코드 줄이 번호 위에 붙어 있음 (본문 들여쓰기에서 시작)
  {
    const { grid, fill } = cells(W, H);
    fill(10, 20, 110, 24); // 앞 문항 마지막 줄
    fill(30, 50, 50, 53); // 문항 코드 (좁음)
    fill(10, 56, 18, 65); // 번호
    fill(30, 57, 100, 63); // 번호 줄 본문
    const y = cutAbove(grid, a, 8 / W, 112 / W, 0, { minX: a.x1 });
    assert.ok(y <= 50 / H && y >= 24 / H, `끊는 자리 ${y * H}`);
  }
  // 2) 같은 자리에 단 왼쪽 끝부터 시작하는 긴 줄 → 앞 문항의 마지막 줄: 그 줄 아래에서 끊음
  {
    const { grid, fill } = cells(W, H);
    fill(10, 20, 110, 24);
    fill(10, 50, 110, 53);
    fill(10, 56, 18, 65);
    const y = cutAbove(grid, a, 8 / W, 112 / W, 0, { minX: a.x1 });
    assert.ok(y >= 53 / H && y <= 56 / H, `끊는 자리 ${y * H}`);
  }
  // 3) 기본 자리가 빈 줄이면 그대로
  {
    const { grid, fill } = cells(W, H);
    fill(10, 20, 110, 24);
    fill(10, 56, 18, 65);
    const y = cutAbove(grid, a, 8 / W, 112 / W, 0, { minX: a.x1 });
    assert.ok(Math.abs(y - (a.y0 - (0.45 * a.h + 0.004))) < 1e-9);
  }
});

test('analyzeLayout: 쪽 바깥 끝의 단원 탭(좁고 세로로 짧은 덩어리)은 본문 가로 범위에서 뺌', () => {
  const W = 240;
  const H = 300;
  const page = (tabY1) => {
    const { grid, fill } = cells(W, H);
    for (let y = 20; y < 280; y += 6) {
      fill(18, y, 110, y + 3);
      fill(124, y, 216, y + 3);
    }
    fill(226, 30, 231, tabY1); // 오른쪽 가장자리 탭
    return analyzeLayout(grid);
  };
  const L = page(70);
  assert.equal(L.columns.length, 2);
  assert.ok(L.columns[1].x1 <= 217 / W, `오른쪽 단 끝 ${L.columns[1].x1 * W}`);
  // 쪽 높이 대부분에 걸친 세로 덩어리는 탭이 아님 (그대로 둠)
  const tall = page(270);
  assert.ok(tall.columns[tall.columns.length - 1].x1 >= 231 / W);
});

test('analyzeLayout: 단 사이 세로선 옆에 번진 잉크 몇 점이 있어도 거터는 선 양쪽 빈칸 전체 (오른쪽 단이 선에서 시작하지 않음)', () => {
  const W = 240;
  const H = 300;
  const { grid, fill } = cells(W, H);
  for (let y = 20; y < 280; y += 6) {
    fill(18, y, 111, y + 3);
    fill(122, y, 216, y + 3);
  }
  for (let y = 20; y < 280; y += 3) fill(116, y, 117, y + 1); // 점선처럼 끊긴 세로선 (잉크 비율 낮음)
  for (const y of [40, 120, 200]) fill(117, y, 118, y + 1); // 선 옆 번진 점
  const L = analyzeLayout(grid);
  assert.equal(L.columns.length, 2);
  assert.ok(L.columns[1].x0 >= 121 / W, `오른쪽 단 시작 ${L.columns[1].x0 * W}`);
  assert.ok(L.columns[0].x1 <= 112 / W, `왼쪽 단 끝 ${L.columns[0].x1 * W}`);
});

test('snapUpToGap: 제목 장식(동그라미)에 걸린 자리를 그 위 빈 줄로 올림', () => {
  const { grid, fill } = cells(100, 200);
  fill(10, 40, 30, 56); // 동그라미 이름표 (제목 글자보다 위로 튀어나옴)
  fill(32, 46, 80, 54); // 제목 글자
  assert.equal(snapUpToGap(grid, 0.05, 0.85, 43 / 200), 40 / 200);
  // 빈 줄이면 그대로, 너무 높이(maxUp 넘게) 이어지는 덩어리면 손대지 않음
  assert.equal(snapUpToGap(grid, 0.05, 0.85, 30 / 200), 30 / 200);
  assert.equal(snapUpToGap(grid, 0.05, 0.85, 55 / 200, 0.02), 55 / 200);
});

test('analyzeLayout: 단 사이 긴 세로선 양옆에 글자가 바싹 붙어 있어도 그 선에서 단을 나눔 (오른쪽 단 번호와 본문 사이 틈이 아님)', () => {
  const W = 480;
  const H = 600;
  const { rgba, fill } = paper(W, H);
  fill(239, 40, 241, 560, 0); // 단 구분 세로선
  for (let y = 60; y < 540; y += 24) {
    fill(40, y, 236, y + 10, 0); // 왼쪽 단 글줄 (선 바로 앞까지)
    fill(244, y, 252, y + 10, 0); // 오른쪽 단 번호 열
    fill(272, y, 440, y + 10, 0); // 오른쪽 단 본문 (번호와 사이에 빈 띠)
  }
  const L = analyzeLayout(inkGridFromRgba(rgba, W, H));
  assert.equal(L.columns.length, 2);
  assert.ok(L.columns[0].x1 <= 240 / W && L.columns[1].x0 >= 240 / W && L.columns[1].x0 < 252 / W, JSON.stringify(L.columns));
});
