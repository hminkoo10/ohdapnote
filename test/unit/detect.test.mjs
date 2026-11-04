import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNumberWord,
  normalizeOcrWord,
  buildLines,
  extractCandidates,
  selectAnchors,
  byReadingOrder,
  computeItems,
  guessPageOffset,
  mergeFigureColumns,
  flagPages,
} from '../../src/renderer/js/detect.js';
import { analyzeLayout, trimRect, findLabelBlocks } from '../../src/renderer/js/layout.js';

test('parseNumberWord: 문제 번호 모양 판별', () => {
  assert.deepEqual(parseNumberWord('12'), { num: 12, digits: '12', style: 'plain' });
  assert.deepEqual(parseNumberWord('12.'), { num: 12, digits: '12', style: 'dot' });
  assert.deepEqual(parseNumberWord('0012'), { num: 12, digits: '0012', style: 'plain' });
  assert.equal(parseNumberWord('[3]').style, 'bracket');
  assert.equal(parseNumberWord('12.다음').num, 12);
  assert.equal(parseNumberWord('3x'), null);
  assert.equal(parseNumberWord('1.5'), null);
  assert.equal(parseNumberWord('0'), null);
  assert.equal(parseNumberWord('12345'), null);
  assert.equal(parseNumberWord('①'), null);
});

test('normalizeOcrWord: OCR 오인식 보정', () => {
  assert.equal(normalizeOcrWord('l2'), '12');
  assert.equal(normalizeOcrWord('1O'), '10');
  assert.equal(normalizeOcrWord('12,'), '12.');
  assert.equal(normalizeOcrWord('hello'), 'hello');
});

test('buildLines: 글자 단위로 쪼개진 숫자를 한 단어로 합침', () => {
  const lines = buildLines([
    { str: '1', x0: 0.1, x1: 0.11, y0: 0.2, y1: 0.215 },
    { str: '2', x0: 0.11, x1: 0.12, y0: 0.2, y1: 0.215 },
    { str: '다음', x0: 0.14, x1: 0.2, y0: 0.2, y1: 0.215 },
  ]);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].words.map((w) => w.str), ['12', '다음']);
});

// 합성 페이지: 2단, 각 단에 번호 + 본문 몇 줄
function fakePage(index, numbers, { trap = false } = {}) {
  const tokens = [];
  const layout = { blank: false, inkRatio: 0.1, columns: [{ x0: 0.08, x1: 0.47 }, { x0: 0.53, x1: 0.92 }], bodyTop: 0.08, bodyBottom: 0.92, hasHeader: true, hasFooter: true };
  numbers.forEach((n, k) => {
    const col = k < Math.ceil(numbers.length / 2) ? 0 : 1;
    const row = col === 0 ? k : k - Math.ceil(numbers.length / 2);
    const x = layout.columns[col].x0;
    const y = 0.1 + row * 0.2;
    tokens.push({ str: String(n), x0: x, x1: x + 0.02, y0: y, y1: y + 0.018 });
    for (let l = 0; l < 3; l++) {
      const yy = y + l * 0.025;
      tokens.push({ str: '다음', x0: x + 0.04, x1: x + 0.1, y0: yy, y1: yy + 0.014 });
      tokens.push({ str: '식의', x0: x + 0.11, x1: x + 0.16, y0: yy, y1: yy + 0.014 });
    }
    if (trap) {
      // 본문 줄이 숫자로 시작 (오인식 함정)
      const yy = y + 0.1;
      tokens.push({ str: '2', x0: x + 0.04, x1: x + 0.05, y0: yy, y1: yy + 0.014 });
      tokens.push({ str: '이상의', x0: x + 0.06, x1: x + 0.12, y0: yy, y1: yy + 0.014 });
    }
  });
  // 쪽번호(꼬리말)
  tokens.push({ str: String(index + 10), x0: 0.5, x1: 0.52, y0: 0.95, y1: 0.965 });
  return { index, layout, tokens };
}

test('selectAnchors: 단원마다 1번부터 다시 시작해도 순서대로 선택', () => {
  const pages = [fakePage(0, [1, 2, 3, 4, 5, 6], { trap: true }), fakePage(1, [7, 8, 9, 1, 2, 3], { trap: true }), fakePage(2, [4, 5, 6, 7])];
  const prepared = pages.map((p) => ({ index: p.index, candidates: extractCandidates(p.tokens, p.layout).candidates }));
  const { anchors } = selectAnchors(prepared);
  const got = pages.flatMap((p) => anchors.get(p.index).map((a) => a.num));
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4, 5, 6, 7]);
});

test('computeItems: 번호 사이를 문항 영역으로, 다음 단으로 이어짐 처리', () => {
  const w = 100;
  const h = 140;
  const data = new Uint8Array(w * h).fill(0);
  // 왼쪽 단(10~45), 오른쪽 단(55~90)에 글줄을 채움
  for (let y = 15; y < 125; y += 3) {
    for (let x = 10; x < 45; x++) data[y * w + x] = 1;
    for (let x = 55; x < 90; x++) data[y * w + x] = 1;
  }
  const grid = { w, h, data };
  const layout = analyzeLayout(grid);
  assert.equal(layout.columns.length, 2);
  const anchors = new Map([
    [
      0,
      [
        { num: 1, digits: '1', col: 0, x0: 0.1, y0: 0.11, h: 0.015, conf: 100 },
        { num: 2, digits: '2', col: 0, x0: 0.1, y0: 0.5, h: 0.015, conf: 100 },
        { num: 3, digits: '3', col: 1, x0: 0.55, y0: 0.6, h: 0.015, conf: 100 },
      ],
    ],
  ]);
  const items = computeItems([0], anchors, new Map([[0, layout]]), new Map([[0, grid]]), { flow: 'continue' });
  assert.deepEqual(items.map((i) => i.number), ['1', '2', '3']);
  // 2번은 왼쪽 단 아래 + 오른쪽 단 위(3번 전까지)로 이어짐
  assert.equal(items[1].rects.length, 2);
  assert.ok(items[1].rects[1].x > 0.5);
  assert.ok(items[1].rects[1].y + items[1].rects[1].h <= 0.6);
  const colItems = computeItems([0], anchors, new Map([[0, layout]]), new Map([[0, grid]]), { flow: 'column' });
  assert.equal(colItems[1].rects.length, 1);
});

// 공통 지문은 왼쪽 단 중간에서 시작하고, 문항은 오른쪽 단에 놓임
function passageFixture() {
  const w = 100;
  const h = 140;
  const data = new Uint8Array(w * h);
  for (let y = 15; y < 125; y += 3) {
    for (let x = 10; x < 45; x++) data[y * w + x] = 1;
    for (let x = 55; x < 90; x++) data[y * w + x] = 1;
  }
  const grid = { w, h, data };
  const layout = analyzeLayout(grid);
  const anchors = new Map([[0, [1, 2, 3].map((num) => ({
    num, digits: String(num), col: 1, x0: 0.55, x1: 0.57, y0: 0.2 + num * 0.2, h: 0.015, conf: 100,
  }))]]);
  const range = { a: 1, b: 3, col: 0, x0: 0.1, x1: 0.4, y0: 0.4, y1: 0.42 };
  return {
    anchors,
    layouts: new Map([[0, layout]]),
    grids: new Map([[0, grid]]),
    ranges: new Map([[0, [range]]]),
    cutters: new Map([[0, [{ ...range, y0: range.y0 - 0.006 }]]]),
  };
}

test('computeItems: 지문 모드에서 다음 단 지문까지 모든 문항에 같은 지문 ID로 붙임', () => {
  const f = passageFixture();
  const items = computeItems([0], f.anchors, f.layouts, f.grids, { ...f, passages: true });
  assert.equal(items.length, 3);
  for (const it of items) {
    assert.equal(it.stem.length, 2);
    assert.equal(it.stemLabel, '1~3');
    assert.equal(it.stemId, '0:1~3');
    assert.ok(it.stem[0].x < 0.5 && it.stem[1].x > 0.5);
    assert.ok(it.stem[1].y + it.stem[1].h <= items[0].rects[0].y);
    assert.deepEqual(it.stem, items[0].stem);
  }
  assert.notEqual(items[0].stem, items[1].stem);
});

test('computeItems: 지문 모드가 아니면 공통 지문은 기존처럼 첫 단 한 조각만 붙임', () => {
  const f = passageFixture();
  const items = computeItems([0], f.anchors, f.layouts, f.grids, f);
  for (const it of items) {
    assert.equal(it.stem.length, 1);
    assert.equal(it.stemLabel, '1~3');
  }
});

test('computeItems: 지문 모드의 문제집 문항도 다음 단으로 이어짐', () => {
  const f = passageFixture();
  f.anchors.get(0)[0] = { ...f.anchors.get(0)[0], col: 0, x0: 0.1, x1: 0.12, y0: 0.7 };
  const opts = { flow: 'column' };
  const items = computeItems([0], f.anchors, f.layouts, f.grids, { ...opts, passages: true });
  assert.equal(items[0].rects.length, 2);
  assert.ok(items[0].rects[1].x > 0.5);
  const math = computeItems([0], f.anchors, f.layouts, f.grids, opts);
  assert.equal(math[0].rects.length, 1);
});

test('computeItems: 열린 지문이 다음 쪽 첫 번호 앞까지 이어짐', () => {
  const f = passageFixture();
  const range = f.ranges.get(0)[0];
  Object.assign(range, { col: 1, x0: 0.55, x1: 0.9 });
  f.cutters.set(0, [{ ...range, y0: range.y0 - 0.006 }]);
  f.layouts.set(1, f.layouts.get(0));
  f.grids.set(1, f.grids.get(0));
  f.anchors.set(1, f.anchors.get(0).map((a) => ({ ...a, col: 0, x0: 0.1, x1: 0.12 })));
  f.anchors.set(0, []);
  const items = computeItems([0, 1], f.anchors, f.layouts, f.grids, { ...f, passages: true });
  for (const it of items) {
    assert.deepEqual(it.stem.map((r) => r.page), [0, 1]);
    assert.equal(it.stemId, '0:1~3');
  }
});

test('byReadingOrder: 띠 위 오른쪽 단을 띠 아래 왼쪽 단보다 먼저 읽음', () => {
  const candidates = [
    { num: 7, zone: 1, col: 0, x0: 0.1, y0: 0.6, h: 0.015 },
    { num: 6, zone: 0, col: 1, x0: 0.55, y0: 0.3, h: 0.015 },
    { num: 5, zone: 0, col: 1, x0: 0.55, y0: 0.15, h: 0.015 },
  ];
  assert.deepEqual(candidates.sort(byReadingOrder).map((a) => a.num), [5, 6, 7]);
});

test('byReadingOrder: 구역이 없으면 기존 단·줄·가로 순서 유지', () => {
  const candidates = [
    { num: 3, col: 1, x0: 0.55, y0: 0.15, h: 0.015 },
    { num: 2, col: 0, x0: 0.3, y0: 0.6, h: 0.015 },
    { num: 1, col: 0, x0: 0.1, y0: 0.6, h: 0.015 },
  ];
  assert.deepEqual(candidates.sort(byReadingOrder).map((a) => a.num), [1, 2, 3]);
});

test('trimRect: 여백 잘라내기', () => {
  const w = 50;
  const h = 50;
  const data = new Uint8Array(w * h);
  for (let y = 20; y < 30; y++) for (let x = 10; x < 20; x++) data[y * w + x] = 1;
  const r = trimRect({ w, h, data }, { x: 0, y: 0, w: 1, h: 1 }, 0);
  assert.deepEqual(
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, +v.toFixed(3)])),
    { x: 0.2, y: 0.4, w: 0.2, h: 0.2 },
  );
  assert.equal(trimRect({ w, h, data }, { x: 0.8, y: 0.8, w: 0.1, h: 0.1 }), null);
});

test('findLabelBlocks: 단 왼쪽 끝의 꽉 찬 이름표("유형 15")만 찾고, 위로 튀어나온 배지 위에서 끊음', () => {
  const w = 240;
  const h = 330;
  const data = new Uint8Array(w * h);
  const fill = (x0, x1, y0, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * w + x] = 1;
  };
  for (let y = 40; y < 80; y += 5) for (let x = 20; x < 110; x += 4) fill(x, x + 3, y, y + 3); // 본문 글줄
  fill(20, 33, 100, 106); // 이름표 (높이 6칸 ≈ 0.018)
  for (let x = 37; x < 100; x += 4) fill(x, x + 3, 101, 105); // 이름표 옆 제목 글자
  fill(100, 106, 95, 101); // 제목 줄 오른쪽 끝 배지 (이름표보다 위로 튀어나옴)
  fill(20, 23, 140, 144); // 글줄 첫 글자 (작음)
  const layout = { bodyTop: 0, bodyBottom: 1, columns: [{ x0: 20 / w, x1: 110 / w }] };
  const found = findLabelBlocks({ w, h, data }, layout, 0.011);
  assert.equal(found.length, 1);
  assert.ok(Math.abs(found[0].y0 - 100 / h) < 1e-9);
  assert.ok(Math.abs(found[0].cutY - 95 / h) < 1e-9, `cutY ${found[0].cutY * h}`);
});

test('guessPageOffset: 쪽번호로 책 쪽 보정값 추정', () => {
  const footers = [0, 1, 2, 3, 4].map((i) => ({ index: i, numbers: [i + 11] }));
  assert.equal(guessPageOffset(footers), 10);
  assert.equal(guessPageOffset([{ index: 0, numbers: [] }]), null);
});

test('looksLikeAnswerTable: 빠른 정답표(같은 높이에 번호가 나란히 / 일정 간격으로 건너뜀)', async () => {
  const { looksLikeAnswerTable } = await import('../../src/renderer/js/detect.js');
  const grid = [];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) grid.push({ num: r * 6 + c + 1, col: 0, x0: 0.1 + c * 0.13, y0: 0.1 + r * 0.03, h: 0.012, prefix: '' });
  assert.equal(looksLikeAnswerTable(grid), true);
  const stepped = [0, 1, 2, 3, 4].map((r) => ({ num: 1 + r * 6, col: 0, x0: 0.1, y0: 0.1 + r * 0.03, h: 0.012, prefix: '' }));
  assert.equal(looksLikeAnswerTable(stepped), true);
  const normal = [1, 2, 3, 4, 5].map((n, r) => ({ num: n, col: 0, x0: 0.1, y0: 0.1 + r * 0.15, h: 0.012, prefix: '' }));
  assert.equal(looksLikeAnswerTable(normal), false);
});

test('looksLikeAnswerTable: 해설 쪽 분수·지수 속 작은 숫자(1, 1, 1 …)는 정답표로 보지 않음', async () => {
  const { looksLikeAnswerTable } = await import('../../src/renderer/js/detect.js');
  const nums = [61, 62, 64, 65, 66, 67, 70].map((n, r) => ({ num: n, col: r < 5 ? 0 : 1, x0: 0.09, y0: 0.07 + r * 0.12, h: 0.0105, prefix: '' }));
  const fracs = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) fracs.push({ num: 1, col: 0, x0: 0.15 + c * 0.04, y0: 0.51 + r * 0.021, h: 0.004, prefix: '' });
  assert.equal(looksLikeAnswerTable([...nums, ...fracs]), false);
});

test('looksLikeAnswerTable: 단원 첫머리 작은 정답 상자 한 줄 + 해설 속 표 숫자는 정답표가 아님, 문제집 끝 정답표는 정답표', async () => {
  const { looksLikeAnswerTable } = await import('../../src/renderer/js/detect.js');
  const c = (num, x, y, h = 0.0118, col = 0) => ({ num, col, x0: x, y0: y, h, prefix: '' });
  // 수능특강 해설 첫 쪽: "1 48 2 ① 3 32 …" 상자 한 줄, 해설 번호 1~4, 증감표 속 숫자들
  const unitStart = [
    ...[1, 2, 3, 4, 5, 6].map((n, i) => c(n, 0.13 + i * 0.061, 0.178, 0.0152)),
    c(7, 0.13, 0.201, 0.0152),
    c(1, 0.107, 0.247, 0.0221), c(1, 0.34, 0.429), c(2, 0.459, 0.429), c(48, 0.218, 0.475), c(12, 0.337, 0.475), c(16, 0.456, 0.475),
    c(2, 0.107, 0.58, 0.0221), c(1, 0.374, 0.82), c(2, 0.463, 0.82), c(2, 0.289, 0.866), c(2, 0.463, 0.866),
    c(3, 0.541, 0.168, 0.0221, 1), c(32, 0.712, 0.339, 0.0118, 1), c(32, 0.875, 0.405, 0.0111, 1), c(4, 0.541, 0.602, 0.0221, 1), c(1, 0.88, 0.776, 0.0111, 1),
  ];
  assert.equal(looksLikeAnswerTable(unitStart), false);
  // 문제집 끝 "한눈에 보는 정답": 한 줄에 1 ② 2 ② 3 ① 4 24 … (답 숫자가 끼어 있음), 칸이 촘촘함
  const quick = [];
  for (let r = 0; r < 6; r++) {
    [1, 2, 3, 4, 24, 5, 6, 7].forEach((n, i) => quick.push(c(n, 0.08 + i * 0.045, 0.15 + r * 0.06)));
  }
  assert.equal(looksLikeAnswerTable(quick, { strict: true }), true);
  // 한 줄에 문항이 둘씩 나란한 문제집 쪽(0001 …  0002 …)은 정답표가 아님
  const pairs = [];
  for (let r = 0; r < 8; r++) pairs.push(c(2 * r + 1, 0.08, 0.1 + r * 0.1), c(2 * r + 2, 0.27, 0.1 + r * 0.1));
  assert.equal(looksLikeAnswerTable(pairs, { strict: true }), false);
});

test('한 줄에 나란히 놓인 문항(0001 …  0002 …): 둘 다 고르고 영역을 가로로 나눔', async () => {
  const { sameRow, byReadingOrder } = await import('../../src/renderer/js/detect.js');
  const mk = (num, x, y) => ({ num, digits: String(num).padStart(4, '0'), style: 'plain', prefix: '', col: 0, x0: x, x1: x + 0.04, y0: y, y1: y + 0.011, h: 0.011, relX: x - 0.08, hRatio: 1, conf: 95, padded: true, font: '', ocr: true });
  // 오른쪽 번호는 OCR 상자 높이가 살짝 달라 y0 가 왼쪽보다 조금 위
  const cands = [mk(1, 0.08, 0.15), mk(2, 0.27, 0.1495), mk(3, 0.08, 0.2), mk(4, 0.27, 0.2002), mk(5, 0.08, 0.3)].sort(byReadingOrder);
  assert.deepEqual(cands.map((c) => c.num), [1, 2, 3, 4, 5]);
  assert.equal(sameRow(cands[0], cands[1]), true);
  const { anchors } = selectAnchors([{ index: 0, candidates: cands }]);
  assert.deepEqual(anchors.get(0).map((a) => a.num), [1, 2, 3, 4, 5]);

  const w = 100;
  const h = 140;
  const data = new Uint8Array(w * h);
  for (let y = 20; y < 125; y += 3) for (let x = 8; x < 46; x++) data[y * w + x] = 1;
  const grid = { w, h, data };
  const layout = { columns: [{ x0: 0.08, x1: 0.46 }], bodyTop: 0.1, bodyBottom: 0.9, spans: [] };
  const items = computeItems([0], anchors, new Map([[0, layout]]), new Map([[0, grid]]), { flow: 'column' });
  assert.deepEqual(items.map((i) => i.number), ['0001', '0002', '0003', '0004', '0005']);
  const [r1, r2, r3] = items.map((i) => i.rects[0]);
  // 0001 은 0002 앞에서 끝나고, 둘 다 다음 줄(0003) 전까지
  assert.ok(r1.x + r1.w <= 0.27 && r2.x >= 0.26);
  assert.ok(r1.y + r1.h <= 0.2 && r2.y + r2.h <= 0.2);
  assert.ok(r3.y >= 0.19);
});

test('selectAnchors: 0001 체계에서 0999 다음 1000 이상도 같은 번호 체계로 이어서 고름', async () => {
  const { schemeKey, flagPages } = await import('../../src/renderer/js/detect.js');
  const mk = (num, y) => {
    const digits = String(num).padStart(4, '0');
    return { num, digits, style: 'plain', prefix: '', col: 0, x0: 0.08, x1: 0.12, y0: y, y1: y + 0.011, h: 0.011, relX: 0.001, hRatio: 1, conf: 95, padded: digits[0] === '0', font: '', ocr: true };
  };
  const pages = [
    { index: 0, candidates: [mk(995, 0.1), mk(996, 0.3), mk(997, 0.5)] },
    { index: 1, candidates: [mk(998, 0.1), mk(999, 0.3), mk(1000, 0.5), mk(1001, 0.7)] },
    { index: 2, candidates: [mk(1002, 0.1), mk(1003, 0.3), mk(1004, 0.5)] },
  ];
  const { anchors } = selectAnchors(pages);
  const got = [0, 1, 2].flatMap((i) => anchors.get(i).map((a) => a.num));
  assert.deepEqual(got, [995, 996, 997, 998, 999, 1000, 1001, 1002, 1003, 1004]);
  assert.equal(new Set(got.map((n) => schemeKey(anchors.get(n < 998 ? 0 : n < 1002 ? 1 : 2).find((a) => a.num === n)))).size, 1);
  const layouts = new Map([0, 1, 2].map((i) => [i, { blank: false, inkRatio: 0.1 }]));
  assert.equal(flagPages([0, 1, 2], anchors, layouts).size, 0);
});

test('dropStrayRuns: 소개 쪽 견본 번호·만화 쪽·부록 표의 동떨어진 숫자만 빼고, 단원마다 1부터 다시 시작은 둠', async () => {
  const { dropStrayRuns } = await import('../../src/renderer/js/detect.js');
  const mk = (num) => ({ num, digits: String(num).padStart(4, '0'), padded: String(num).padStart(4, '0')[0] === '0', prefix: '' });
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => mk(a + i));
  const anchors = new Map([
    [1, [mk(2), mk(4), mk(5), mk(6), mk(8)]], // 구성과 특징 쪽 견본
    [2, [mk(108)]],
    [6, [mk(3939)]], // 목차
    [8, range(1, 37)],
    [9, range(38, 60)],
    [10, [mk(3939)]], // 만화 쪽
    [11, range(61, 64), ],
    [12, [mk(66), mk(67)]], // 65 를 놓쳤어도 앞뒤와 이어지는 짧은 덩어리는 둠
    [13, range(68, 90)],
    [14, [mk(3959), mk(3960), mk(3962)]], // 부록 로그표
    [15, [mk(7435)]],
  ]);
  const order = [...anchors.keys()];
  // 1000 이상 번호는 fixedWidth 로 같은 체계
  for (const chain of anchors.values()) for (const c of chain) if (!c.padded) c.fixedWidth = true;
  assert.equal(dropStrayRuns(order, anchors, '|4'), 12);
  const left = order.flatMap((i) => anchors.get(i).map((c) => c.num));
  assert.deepEqual(left, Array.from({ length: 90 }, (_, i) => i + 1).filter((n) => n !== 65));
  // 단원마다 1부터 다시 시작하는 짧은 단원은 그대로
  const units = new Map([[0, range(1, 9)], [1, range(1, 3)], [2, range(1, 8)]]);
  assert.equal(dropStrayRuns([0, 1, 2], units, '|4'), 0);
  // 번호가 큰 책(수능특강)에서 책 소개 쪽 견본 그림 속 번호, 개념 쪽 소제목 "1, 2" 는 뺌 (Level 3 의 1~3 은 둠)
  const plain = (num, h) => ({ num, digits: String(num), padded: false, prefix: '', h, ocr: false });
  const book = new Map([
    [0, [plain(1, 0.0053), plain(2, 0.0053)]],
    [1, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => plain(n, 0.0249))],
    [2, [1, 2, 3].map((n) => plain(n, 0.0249))],
    [3, [plain(1, 0.0138), plain(2, 0.0138)]],
    [4, [1, 2, 3, 4, 5, 6].map((n) => plain(n, 0.018))],
  ]);
  assert.equal(dropStrayRuns([0, 1, 2, 3, 4], book, '|0'), 4);
  assert.deepEqual([...book.values()].map((ch) => ch.length), [0, 8, 3, 0, 6]);
  // 스캔본(OCR)도: 소개 쪽 견본 그림 속 작은 "0001 0003 0004 0005" 는 1부터라도 뺌
  const scan = (num, h) => ({ ...mk(num), h, ocr: true });
  const scanned = new Map([
    [1, [1, 3, 4, 5].map((n) => scan(n, 0.0042))],
    [8, Array.from({ length: 37 }, (_, i) => scan(i + 1, 0.011))],
  ]);
  assert.equal(dropStrayRuns([1, 8], scanned, '|4'), 4);
  assert.deepEqual([...scanned.values()].map((ch) => ch.length), [0, 37]);
});

test('extractCandidates: 해설 단원 첫머리 작은 정답 상자(1 ② 2 ② 3 ① 4 24 … / 7 ① 8 ③)의 번호는 후보에서 뺌', () => {
  const t = (str, x, y, h = 0.0152) => ({ str, x0: x, x1: x + 0.012, y0: y, y1: y + h });
  const tokens = [];
  // 상자 첫 줄: 번호와 답이 번갈아 (답은 ①② 같은 기호)
  ['1', '2', '3', '4', '5', '6'].forEach((n, i) => tokens.push(t(n, 0.13 + i * 0.061, 0.178), t('②', 0.15 + i * 0.061, 0.178)));
  tokens.push(t('7', 0.13, 0.201), t('①', 0.15, 0.201), t('8', 0.191, 0.201), t('③', 0.211, 0.201));
  // 해설 1, 2 (큰 번호, 뒤에 본문)
  tokens.push(t('1', 0.107, 0.247, 0.0221), t('함수의', 0.14, 0.25, 0.012), t('2', 0.107, 0.58, 0.0221), t('따라서', 0.14, 0.583, 0.012));
  const layout = { columns: [{ x0: 0.1, x1: 0.5 }], bodyTop: 0.05, bodyBottom: 0.95 };
  const { candidates } = extractCandidates(tokens, layout);
  assert.deepEqual(candidates.map((c) => c.num), [1, 2]);
  assert.ok(candidates.every((c) => c.x0 < 0.11));
});

test('sameRow: OCR 이 옆 분수까지 묶어 키가 커진 번호 상자도 오른쪽 번호와 같은 줄', async () => {
  const { sameRow } = await import('../../src/renderer/js/detect.js');
  const tall = { col: 0, x0: 0.075, y0: 0.659, h: 0.0212 };
  const right = { col: 0, x0: 0.271, y0: 0.665, h: 0.011 };
  const below = { col: 0, x0: 0.078, y0: 0.721, h: 0.0114 };
  assert.equal(sameRow(tall, right), true);
  assert.equal(sameRow(tall, below), false);
});

test('analyzeLayout: 단 안쪽의 빈 세로 띠보다 세로 구분선이 있는 진짜 단 경계를 고름', () => {
  const w = 120;
  const h = 160;
  const data = new Uint8Array(w * h);
  for (let y = 10; y < 150; y++) {
    if (y % 3 === 0) {
      // 왼쪽 단: 짧은 수식 줄(10~44) + 줄 끝의 답 표시(52~57) → 45~51 이 비어 보임
      for (let x = 10; x < 44; x++) data[y * w + x] = 1;
      if (y % 9 === 0) for (let x = 52; x < 57; x++) data[y * w + x] = 1;
      for (let x = 64; x < 110; x++) data[y * w + x] = 1;
    }
    data[y * w + 60] = 1; // 단 사이 세로선
  }
  const L = analyzeLayout({ w, h, data });
  assert.equal(L.columns.length, 2);
  assert.ok(L.columns[1].x0 > 0.5, `오른쪽 단 시작 ${L.columns[1].x0}`);
});

test('selectAnchors: 두 번호 체계(유제 1,2… / Level 01,02…)를 함께 인식', () => {
  const mk = (num, digits, col, y, font) => ({ num, digits, style: 'plain', prefix: '', col, x0: 0.07 + col * 0.45, x1: 0.09, y0: y, y1: y + 0.015, h: 0.015, relX: 0.001, hRatio: 1.2, conf: 100, padded: digits[0] === '0', font, ocr: false });
  const pages = [
    { index: 0, candidates: [mk(1, '1', 0, 0.2, 'B'), mk(2, '2', 0, 0.5, 'B'), mk(3, '3', 1, 0.2, 'B'), mk(4, '4', 1, 0.5, 'B')] },
    { index: 1, candidates: [mk(1, '01', 0, 0.2, 'B'), mk(2, '02', 0, 0.4, 'B'), mk(3, '03', 0, 0.6, 'B'), mk(4, '04', 1, 0.2, 'B'), mk(1, '01', 1, 0.5, 'B'), mk(2, '02', 1, 0.7, 'B')] },
    { index: 2, candidates: [mk(5, '5', 0, 0.2, 'B'), mk(6, '6', 0, 0.5, 'B'), mk(1, '01', 1, 0.2, 'B'), mk(2, '02', 1, 0.4, 'B'), mk(3, '03', 1, 0.6, 'B')] },
  ];
  const { anchors, signatures } = selectAnchors(pages);
  assert.equal(signatures.length, 2);
  const got = [0, 1, 2].flatMap((i) => anchors.get(i).map((a) => a.digits));
  assert.deepEqual(got, ['1', '2', '3', '4', '01', '02', '03', '04', '01', '02', '5', '6', '01', '02', '03']);
});

test('extractCandidates: 줄 맨 앞 수식("1 + 2 = 3", "8 = 2³")·앞 줄에서 넘어온 문장 끝("8 이므로")은 번호가 아님, 번호 없는 "유제" 이름표는 따로 모음', () => {
  const t = (str, x, y, h = 0.012) => ({ str, x0: x, x1: x + 0.012 * Math.max(1, [...str].length), y0: y, y1: y + h });
  const tokens = [
    t('1', 0.1, 0.1), t('정답', 0.116, 0.1),
    t('1', 0.1, 0.13), t('+', 0.116, 0.13), t('2', 0.132, 0.13), t('=', 0.148, 0.13), t('3', 0.164, 0.13),
    t('8', 0.1, 0.16), t('이므로', 0.116, 0.16), t('a', 0.16, 0.16),
    t('8', 0.1, 0.19), t('=', 0.116, 0.19), t('2³', 0.132, 0.19),
    t('2', 0.1, 0.22), t('정답', 0.116, 0.22),
    t('유제', 0.1, 0.3, 0.016), t('정답과', 0.6, 0.3), t('풀이', 0.65, 0.3),
    t('유제', 0.1, 0.35), t('3', 0.128, 0.35), t('함수', 0.17, 0.35),
  ];
  const layout = { columns: [{ x0: 0.1, x1: 0.9 }], bodyTop: 0.05, bodyBottom: 0.95 };
  const { candidates, sectionLabels } = extractCandidates(tokens, layout);
  assert.deepEqual(candidates.map((c) => `${c.prefix}${c.num}`), ['1', '2', '유제3']);
  assert.equal(sectionLabels.length, 1);
  assert.ok(Math.abs(sectionLabels[0].y0 - 0.3) < 1e-9);
});

test('extractCandidates: 해설 머리 "유형 01 답 ④" 와 문제집 "유형 02 …" 옆 "대표 문제" 는 유형 번호 문항 (빠른 정답표 줄·해설 속 "유형03" 표시는 아님)', () => {
  const t = (str, x, y, h = 0.012) => ({ str, x0: x, x1: x + 0.012 * Math.max(1, [...str].length), y0: y, y1: y + h });
  const one = { columns: [{ x0: 0.1, x1: 0.9 }], bodyTop: 0.05, bodyBottom: 0.95 };
  const answer = [
    t('유형', 0.1, 0.1), t('01', 0.126, 0.1), t('답', 0.152, 0.1), t('④', 0.166, 0.1), // 해설 머리
    t('유형', 0.1, 0.3), t('02', 0.126, 0.3), t('④', 0.152, 0.3), t('유형', 0.3, 0.3), t('03', 0.326, 0.3), t('5', 0.352, 0.3), // 빠른 정답표 줄
    t('유형', 0.1, 0.32), t('04', 0.126, 0.32), t('①', 0.152, 0.32), // 정답표 마지막 줄 (하나뿐)
    t('유형', 0.1, 0.6), t('03', 0.126, 0.6), t('에서', 0.152, 0.6, 0.012), // 해설 속 참고 표시 아님: 뒤가 "답" 이 아니면 제목으로 봄
  ];
  assert.deepEqual(extractCandidates(answer, one).candidates.map((c) => `${c.prefix}${c.digits}`), ['유형01']);
  // 문제집: 왼쪽 단 유형 제목(작은 "유형" 옆 큰 번호, 제목이 수식으로 시작하기도), 오른쪽 단 같은 높이의 "대표 문제"
  const two = { columns: [{ x0: 0.1, x1: 0.48 }, { x0: 0.52, x1: 0.9 }], bodyTop: 0.05, bodyBottom: 0.95 };
  const problem = [
    t('유형', 0.1, 0.1, 0.009), t('01', 0.126, 0.1, 0.016), t('구분구적법', 0.16, 0.1),
    t('대표', 0.55, 0.11), t('문제', 0.58, 0.11),
    t('유형', 0.1, 0.5, 0.009), t('02', 0.126, 0.5, 0.016), t('lim', 0.16, 0.5),
    t('대표', 0.55, 0.51), t('문제', 0.58, 0.51),
  ];
  const got = extractCandidates(problem, two).candidates;
  assert.deepEqual(got.map((c) => `${c.prefix}${c.digits}:${c.col}`), ['유형01:1', '유형02:1']);
  assert.ok(Math.abs(got[0].h - 0.016) < 1e-9, '번호 크기는 유형 번호 글자');
});

test('extractCandidates: 같은 단 한 줄에 번호가 셋 이상 커지며 나란하면(몇 개는 답에 붙어 후보에서 빠져도) 정답표', () => {
  const t = (str, x, y) => ({ str, x0: x, x1: x + 0.012 * [...str].length, y0: y, y1: y + 0.012 });
  const one = { columns: [{ x0: 0.1, x1: 0.5 }], bodyTop: 0.05, bodyBottom: 0.95 };
  const tokens = [
    t('1', 0.1, 0.5), t('①', 0.116, 0.5), t('2', 0.2, 0.5), t('③', 0.216, 0.5), t('3①', 0.26, 0.5), t('4', 0.34, 0.5), t('①', 0.356, 0.5), // 3 은 답에 붙어 후보가 아님
    t('6', 0.1, 0.522), t('④', 0.116, 0.522),
    t('7', 0.1, 0.8), t('함수', 0.13, 0.8),
  ];
  const { candidates, answerBoxes } = extractCandidates(tokens, one);
  assert.deepEqual(candidates.map((c) => c.num), [7]);
  assert.equal(answerBoxes.length, 1);
  // 동그라미 답이 붙지 않은 줄(문제 속 표 "n 1 2 4")은 그대로
  const table = [t('1', 0.1, 0.5), t('n', 0.13, 0.5), t('2', 0.2, 0.5), t('ㄱ', 0.216, 0.5), t('4', 0.34, 0.5), t('ㄴ', 0.356, 0.5)];
  assert.deepEqual(extractCandidates(table, one).candidates.map((c) => c.num), [1, 2, 4]);
});

test('extractCandidates: 공통 지문 머리는 괄호가 있거나 단 왼쪽 끝일 때만 (줄 가운데 "3−27" 같은 수식은 아님)', () => {
  const t = (str, x, y) => ({ str, x0: x, x1: x + 0.01 * str.length, y0: y, y1: y + 0.012 });
  const layout = { columns: [{ x0: 0.07, x1: 0.47 }, { x0: 0.42, x1: 0.93 }], bodyTop: 0.05, bodyBottom: 0.95 };
  const tokens = [t('[0030~0037]', 0.07, 0.1), t('다음', 0.2, 0.1), t('3-27', 0.3, 0.3), t('[0040~0041]', 0.51, 0.5), t('12~15', 0.07, 0.7)];
  const { ranges } = extractCandidates(tokens, layout);
  assert.deepEqual(ranges.map((r) => [r.a, r.b, r.col]), [[30, 37, 0], [40, 41, 1], [12, 15, 0]]);
});

test('mergeFigureColumns: 1단 쪽 오른쪽의 그래프·⑤ 때문에 생긴 빈 띠는 단 구분이 아님 (진짜 2단·세로선 있는 쪽은 그대로)', () => {
  const num = (n, col, relX, h = 0.025, font = 'N') => ({ num: n, col, relX, h, font, x0: 0, y0: 0.1 * n });
  const page = (columns, candidates, gutters = []) => ({ layout: { columns, gutters }, candidates });
  // 넓은 단(문제)과 좁은 단(그래프 눈금 숫자만)
  const fig = page([{ x0: 0.075, x1: 0.667 }, { x0: 0.683, x1: 0.896 }], [num(1, 0, 0.032), num(2, 0, 0.032), num(1, 1, 0.124, 0.011, 'S'), num(2, 1, 0.124, 0.011, 'S')]);
  assert.equal(mergeFigureColumns(fig), true);
  assert.deepEqual(fig.layout.columns, [{ x0: 0.075, x1: 0.896 }]);
  assert.equal(fig.layout.merged, true);
  // 폭이 비슷한 진짜 2단
  const two = page([{ x0: 0.07, x1: 0.47 }, { x0: 0.53, x1: 0.93 }], [num(1, 0, 0.01), num(2, 1, 0.01)]);
  assert.equal(mergeFigureColumns(two), false);
  // 단 사이 세로선이 있으면 그대로
  const ruled = page([{ x0: 0.075, x1: 0.667 }, { x0: 0.683, x1: 0.896 }], [num(1, 0, 0.032)], [{ x0: 0.667, x1: 0.683, rule: true }]);
  assert.equal(mergeFigureColumns(ruled), false);
  // 좁은 단 왼쪽 끝에도 같은 모양 번호가 있으면 진짜 단
  const narrowNums = page([{ x0: 0.075, x1: 0.667 }, { x0: 0.683, x1: 0.896 }], [num(1, 0, 0.032), num(2, 1, 0)]);
  assert.equal(mergeFigureColumns(narrowNums), false);
});

test('flagPages: 번호가 없는 쪽이라도 앞뒤 번호가 체계마다 그대로 이어지면 확인할 쪽이 아님 (개념 설명 쪽)', () => {
  const c = (num, prefix = '') => ({ num, digits: String(num), prefix, conf: 100 });
  const layouts = new Map([0, 1, 2, 3, 4].map((i) => [i, { blank: false, inkRatio: 0.1 }]));
  const anchors = new Map([
    [0, [c(1, '예제'), c(1), c(2)]],
    [1, []], // 개념 쪽
    [2, [c(2, '예제'), c(3), c(4)]],
    [3, []], // 번호를 놓친 쪽
    [4, [c(8), c(9)]],
  ]);
  const flags = flagPages([0, 1, 2, 3, 4], anchors, layouts);
  assert.equal(flags.has(1), false);
  assert.deepEqual(flags.get(3), ['번호를 찾지 못함']);
});

test('rowMajorOrder + flagPages: 두 단에 짝지어 줄마다 왼쪽→오른쪽으로 번호 매긴 쪽(105 | 106, 107 | 108 …)은 빠진 번호가 아님, 진짜 빠진 쪽은 그대로 표시', async () => {
  const { rowMajorOrder } = await import('../../src/renderer/js/detect.js');
  // 자이스토리 "잘 틀리는 유형 훈련" 쪽 (실제 위치): 오른쪽 번호가 왼쪽보다 조금 내려앉아 있음
  const mk = (num, col, y) => ({ num, digits: String(num), style: 'plain', prefix: '', col, x0: col ? 0.523 : 0.093, x1: col ? 0.553 : 0.123, y0: y, y1: y + 0.0194, h: 0.0194, relX: col ? -0.002 : 0.001, hRatio: 1.52, conf: 100, padded: false, font: 'sans-serif|100|-21|', ocr: false });
  const L = [0.141, 0.398, 0.668];
  const R = [0.175, 0.432, 0.702];
  const paired = (first, rows, skip = []) => [0, 1, 2].slice(0, rows).flatMap((r) => [mk(first + 2 * r, 0, L[r]), mk(first + 2 * r + 1, 1, R[r])]).filter((c) => !skip.includes(c.num));
  const colMajor = (first, n) => Array.from({ length: n }, (_, i) => mk(first + i, i < n / 2 ? 0 : 1, 0.12 + (i % (n / 2)) * 0.2));
  const sorted = (cands) => cands.sort((a, b) => a.col - b.col || a.y0 - b.y0); // 단 → 위→아래
  const pages = [
    { index: 0, candidates: sorted(colMajor(97, 8)) }, // 보통 쪽 (왼쪽 97~100, 오른쪽 101~104)
    { index: 1, candidates: sorted(paired(105, 3)) },
    { index: 2, candidates: sorted(paired(111, 2)) }, // 두 줄뿐인 쪽 (자이 26쪽: 129 | 130, 131 | 132)
    { index: 3, candidates: sorted(paired(115, 2, [116])) }, // 오른쪽 116 을 정말 놓친 쪽
    { index: 4, candidates: sorted(paired(119, 3, [124])) }, // 마지막 줄은 왼쪽 123 만
    { index: 5, candidates: sorted(colMajor(124, 6)) },
  ];
  const { anchors } = selectAnchors(pages);
  assert.deepEqual(anchors.get(1).map((a) => a.num), [105, 107, 109, 106, 108, 110]); // 세 줄이면 단 순서로도 모두 고름
  assert.deepEqual(anchors.get(2).map((a) => a.num), [111, 112, 113, 114]); // 단 순서로는 112 를 버렸던 쪽
  for (const [idx, chain] of anchors) anchors.set(idx, rowMajorOrder(chain));
  assert.deepEqual(anchors.get(0).map((a) => a.num), [97, 98, 99, 100, 101, 102, 103, 104]);
  assert.deepEqual(anchors.get(1).map((a) => a.num), [105, 106, 107, 108, 109, 110]);
  assert.deepEqual(anchors.get(3).map((a) => a.num), [115, 117, 118]); // 빠진 번호가 있으면 그대로
  assert.deepEqual(anchors.get(4).map((a) => a.num), [119, 120, 121, 122, 123]); // 마지막 번호가 123 이라 다음 쪽 124 와 이어짐
  assert.deepEqual(anchors.get(5).map((a) => a.num), [124, 125, 126, 127, 128, 129]);
  const layouts = new Map([0, 1, 2, 3, 4, 5].map((i) => [i, { blank: false, inkRatio: 0.1 }]));
  const flags = flagPages([0, 1, 2, 3, 4, 5], anchors, layouts);
  assert.deepEqual([...flags.keys()], [3]);
  assert.deepEqual(flags.get(3), ['중간에 빠진 번호가 있음']);
  // 오른쪽 단 번호가 왼쪽 위로 올라가 있으면(단 순서로 읽는 쪽의 번호가 잘못 섞인 것) 짝 쪽으로 보지 않음
  const odd = [mk(5, 0, 0.4), mk(7, 0, 0.7), mk(6, 1, 0.1)];
  assert.deepEqual(rowMajorOrder(odd).map((c) => c.num), [5, 7, 6]);
});

test('sortItems: 줄마다 두 단을 건너 번호 매긴 쪽은 번호 순서로, 보통 쪽(단 → 위→아래)과 한 단 안에 나란한 문항은 그대로', async () => {
  const { sortItems, assignIds } = await import('../../src/renderer/js/detect.js');
  const it = (page, col, num, x, y, w = 0.389) => ({ page, zone: 0, col, number: String(num), num, prefix: '', rects: [{ page, x, y, w, h: 0.05 }], source: 'text', conf: 100 });
  // 자이스토리 22쪽 (실제 영역 위치)
  const p22 = [it(21, 0, 105, 0.086, 0.136), it(21, 0, 107, 0.086, 0.395), it(21, 0, 109, 0.086, 0.655), it(21, 1, 106, 0.519, 0.169), it(21, 1, 108, 0.519, 0.425), it(21, 1, 110, 0.519, 0.696)];
  // 보통 2단 쪽, 한 단 안에 0001 | 0002 가 나란한 쪽
  const p21 = [it(20, 1, 101, 0.519, 0.14), it(20, 0, 97, 0.086, 0.14), it(20, 0, 98, 0.086, 0.5), it(20, 1, 102, 0.519, 0.5)];
  const row = [it(5, 0, 2, 0.27, 0.15, 0.18), it(5, 0, 1, 0.08, 0.15, 0.18), it(5, 0, 3, 0.08, 0.3, 0.18)];
  // 오른쪽 번호(130)를 정말 놓친 쪽은 단 순서 그대로
  const p26 = [it(25, 1, 132, 0.519, 0.57), it(25, 0, 129, 0.086, 0.136), it(25, 0, 131, 0.086, 0.533)];
  const out = assignIds(sortItems([...p26, ...p22.reverse(), ...row, ...p21]));
  assert.deepEqual(out.map((i) => i.num), [1, 2, 3, 97, 98, 101, 102, 105, 106, 107, 108, 109, 110, 129, 131, 132]);
  assert.deepEqual(out.filter((i) => i.page === 21).map((i) => i.id), ['21:105', '21:106', '21:107', '21:108', '21:109', '21:110']);
});

test('computeItems: 해설이 단원 제목 띠 위쪽 오른쪽 단으로 이어질 때, 띠(구역 아래 끝)에서 닫지 않음', () => {
  const w = 120;
  const h = 160;
  const data = new Uint8Array(w * h);
  for (let y = 10; y < 150; y += 3) {
    if (y >= 68 && y < 82) continue;
    for (let x = 8; x < 52; x++) data[y * w + x] = 1;
    for (let x = 68; x < 112; x++) data[y * w + x] = 1;
  }
  for (let y = 72; y < 78; y++) for (let x = 8; x < 112; x++) data[y * w + x] = 1; // 단원 제목 띠
  const grid = { w, h, data };
  const layout = analyzeLayout(grid);
  assert.equal(layout.columns.length, 2);
  assert.ok(layout.spans?.length >= 1);
  const band = layout.spans[0];
  const cutters = new Map([[0, [{ x0: 0, x1: 1, y0: band.y0 - 0.002, kind: 'span' }]]]);
  const anchors = new Map([[0, [
    { num: 1, digits: '1', col: 0, x0: 0.07, x1: 0.08, y0: 0.118, h: 0.015, conf: 100 },
    { num: 2, digits: '2', col: 0, x0: 0.07, x1: 0.08, y0: 0.6, h: 0.015, conf: 100 },
  ]]]);
  const items = computeItems([0], anchors, new Map([[0, layout]]), new Map([[0, grid]]), { flow: 'continue', cutters });
  assert.equal(items.length, 2);
  // 1번: 왼쪽 단 띠 위 + 오른쪽 단 띠 위
  assert.equal(items[0].rects.length, 2);
  const r = items[0].rects[1];
  assert.ok(r.x > 0.5 && r.y + r.h <= band.y0 + 0.01, JSON.stringify(r));
  // 띠 아래(새 단원)는 2번부터: 오른쪽 단 띠 아래로 이어지는 것은 2번
  assert.ok(items[1].rects.every((q) => q.y >= band.y1 - 0.01));
});

test('computeItems: 마지막 해설은 번호 없는 같은 꼴(단 폭이 같은) 쪽으로는 이어지지만, 단 폭이 다른 쪽(책 끝 메모 쪽)으로는 이어지지 않음', () => {
  const page = (kind) => {
    const w = 120;
    const h = 160;
    const data = new Uint8Array(w * h);
    for (let y = 10; y < 150; y += 3) {
      if (kind === 'full') {
        for (let x = 8; x < 112; x++) data[y * w + x] = 1;
        continue;
      }
      for (let x = 8; x < 52; x++) data[y * w + x] = 1;
      if (kind === 'two') for (let x = 68; x < 112; x++) data[y * w + x] = 1;
    }
    const grid = { w, h, data };
    return { grid, layout: analyzeLayout(grid) };
  };
  const p0 = page('two');
  const anchors = new Map([[0, [{ num: 1, digits: '1', col: 0, x0: 0.07, x1: 0.08, y0: 0.118, h: 0.015, conf: 100 }]]]);
  // 'left': 마지막 쪽에 왼쪽 단만 차 있는 해설 끝(단 수는 1 이지만 폭은 같음)
  for (const [kind, expectPages] of [['two', [0, 0, 1, 1]], ['left', [0, 0, 1]], ['full', [0, 0]]]) {
    const p1 = page(kind);
    const items = computeItems([0, 1], anchors, new Map([[0, p0.layout], [1, p1.layout]]), new Map([[0, p0.grid], [1, p1.grid]]), { flow: 'continue' });
    assert.deepEqual(items[0].rects.map((r) => r.page), expectPages, kind);
  }
});

test('selectAnchors: 글자 레이어 번호 크기가 두 무리(예: 유제·Level)면 작은 무리 번호도 깎지 않음 (옆으로 살짝 비켜난 같은 번호보다 우선)', () => {
  const R = 0.0127;
  const S = 0.011;
  const mk = (num, y, h, relX = 0) => ({ num, digits: String(num), style: 'plain', prefix: '', col: 0, x0: 0.07 + relX, x1: 0.08 + relX, y0: y, y1: y + h, h, relX, hRatio: h / 0.0109, conf: 100, padded: false, font: 'F', ocr: false });
  const pages = [
    { index: 0, candidates: [mk(1, 0.1, R), mk(2, 0.25, R), mk(3, 0.4, R), mk(4, 0.55, R, 0.011), mk(4, 0.65, S), mk(5, 0.8, R)] },
    { index: 1, candidates: [mk(6, 0.1, S), mk(7, 0.3, R), mk(8, 0.5, S), mk(9, 0.7, R)] },
  ];
  // 개념 쪽 소제목 "3"(같은 글꼴, 15% 넘게 작음)은 번호가 1 이어져도 고르지 않음 → 다음 쪽의 진짜 3번을 고름
  const concept = [
    { index: 0, candidates: [mk(1, 0.2, 0.018), mk(2, 0.6, 0.018)] },
    { index: 1, candidates: [mk(3, 0.1, 0.0138)] },
    { index: 2, candidates: [mk(3, 0.5, 0.018), mk(4, 0.8, 0.018)] },
    { index: 3, candidates: [mk(5, 0.3, 0.018), mk(6, 0.7, 0.018)] },
  ];
  const c = selectAnchors(concept).anchors;
  assert.deepEqual([0, 1, 2, 3].map((i) => c.get(i).map((a) => a.num)), [[1, 2], [], [3, 4], [5, 6]]);

  const { anchors } = selectAnchors(pages);
  const four = anchors.get(0).find((a) => a.num === 4);
  assert.equal(four.y0, 0.65);
  assert.deepEqual([0, 1].flatMap((i) => anchors.get(i).map((a) => a.num)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('extractCandidates: 소단원 제목 번호표("❶ 제곱근의 뜻과 표현", 제목 글씨가 번호보다 크고 본문보다도 큼)는 번호가 아님', () => {
  const t = (str, x0, x1, y, h) => ({ str, x0, x1, y0: y, y1: y + h });
  const one = { columns: [{ x0: 0.09, x1: 0.46 }], bodyTop: 0.05, bodyBottom: 0.95 };
  const tokens = [
    // 자이스토리 개념 체크 쪽 (실제 크기): 번호표 1 은 0.0116, 제목은 0.0145, 본문 0.0127, 문항 번호 001 은 0.0182
    t('1', 0.099, 0.107, 0.118, 0.0116), t('제곱근의', 0.121, 0.18, 0.118, 0.0145), t('뜻과', 0.195, 0.224, 0.118, 0.0145), t('표현', 0.239, 0.268, 0.118, 0.0145),
    t('다음', 0.181, 0.209, 0.14, 0.0121), t('수의', 0.214, 0.242, 0.14, 0.0121), t('제곱근을', 0.247, 0.304, 0.14, 0.0121),
    t('001', 0.093, 0.127, 0.169, 0.0182), t('36', 0.14, 0.157, 0.169, 0.0127),
    t('002', 0.093, 0.127, 0.209, 0.0182), t('49', 0.14, 0.157, 0.209, 0.0127),
    t('003', 0.093, 0.127, 0.248, 0.0182), t('64', 0.14, 0.157, 0.248, 0.0127),
    ...[0.33, 0.36, 0.39, 0.42].flatMap((y) => [t('본문', 0.15, 0.18, y, 0.0127), t('글자', 0.19, 0.22, y, 0.0127)]), // 본문 줄 (본문 높이 0.0127)
    // 작은 글씨 번호 뒤에 본문 크기 글: 제목이 아니라 문항
    t('4', 0.093, 0.1, 0.3, 0.01), t('다음', 0.106, 0.134, 0.3, 0.0127), t('중', 0.139, 0.15, 0.3, 0.0127),
  ];
  assert.deepEqual(extractCandidates(tokens, one).candidates.map((c) => c.digits), ['001', '002', '003', '4']);
});

// 자이스토리 글자 레이어 (실제 좌표·크기): 문항 번호 글꼴 N(0.0182~0.0194), 본문 수식 T·글 P(0.0127)
const XN = 'sans-serif|100|-21|';
const XT = 'serif|75|-25|';
const XP = 'serif|80|-25|';
const xt = (str, x0, x1, y, h = 0.0127, font = XT) => ({ str, x0, x1, y0: y, y1: y + h, font });
const XI2 = { columns: [{ x0: 0.092, x1: 0.458 }, { x0: 0.521, x1: 0.908 }], bodyTop: 0.07, bodyBottom: 0.92 };

test('extractCandidates: 한 줄에 문항이 둘이면 앞 문항 답 빈칸 "(    )" 바로 뒤 번호도 번호 (괄호 안에 글자가 있는 수식 뒤 숫자는 아님)', () => {
  const row = (a, b, y) => [
    xt(a, 0.523, 0.56, y, 0.0182, XN), xt('√2', 0.57, 0.588, y), xt('(', 0.657, 0.663, y, 0.0127, XP), xt(')', 0.699, 0.705, y, 0.0127, XP),
    xt(b, 0.715, 0.752, y, 0.0182, XN), xt('-√2.1', 0.762, 0.81, y), xt('(', 0.859, 0.865, y, 0.0127, XP), xt(')', 0.901, 0.907, y, 0.0127, XP),
  ];
  const tokens = [
    ...row('026', '027', 0.343),
    ...row('028', '029', 0.376),
    // 수식 "(−3)" 바로 뒤의 숫자: 괄호 안이 비어 있지 않음
    xt('030', 0.523, 0.56, 0.408, 0.0182, XN), xt('(', 0.57, 0.576, 0.408, 0.0127, XP), xt('-3', 0.58, 0.6, 0.408), xt(')', 0.604, 0.61, 0.408, 0.0127, XP), xt('2', 0.62, 0.628, 0.408),
  ];
  const { candidates } = extractCandidates(tokens, XI2);
  assert.deepEqual(candidates.map((c) => c.digits), ['026', '027', '028', '029', '030']);
});

test('extractCandidates: 앞 문항 수식 끝이 바로 앞까지 와도, 같은 줄 맨 앞 번호가 있고 위아래 번호들과 줄을 맞춘 같은 모양 번호는 한 줄에 나란한 둘째 문항', () => {
  const tokens = [];
  ['001', '003', '005'].forEach((n, i) => {
    const y = 0.169 + i * 0.04;
    tokens.push(xt(n, 0.093, 0.13, y, 0.0182, XN), xt('√2', 0.14, 0.16, y), xt(String(+n + 1).padStart(3, '0'), 0.285, 0.322, y, 0.0182, XN), xt('√3', 0.331, 0.35, y));
  });
  // 017 3√10÷√6÷√15  018 … (수식 끝 0.259, 018 시작 0.285)
  tokens.push(xt('017', 0.093, 0.13, 0.745, 0.0182, XN), xt('3√10', 0.14, 0.176, 0.745), xt('÷√6', 0.185, 0.214, 0.745), xt('÷√15', 0.223, 0.259, 0.745), xt('018', 0.285, 0.319, 0.745, 0.0182, XN), xt('√2', 0.33, 0.35, 0.745));
  // 같은 번호 글꼴이라도 다른 번호들과 줄이 안 맞으면, 줄이 맞아도 본문 글꼴이면 아님
  tokens.push(xt('019', 0.093, 0.13, 0.82, 0.0182, XN), xt('x+y=', 0.14, 0.29, 0.82), xt('7', 0.3, 0.31, 0.82, 0.0182, XN));
  tokens.push(xt('021', 0.093, 0.13, 0.86, 0.0182, XN), xt('a의', 0.14, 0.27, 0.86, 0.0127, XP), xt('8', 0.285, 0.294, 0.86));
  const { candidates } = extractCandidates(tokens, XI2);
  assert.deepEqual(candidates.map((c) => c.digits), ['001', '002', '003', '004', '005', '006', '017', '018', '019', '021']);
});

test('extractCandidates: 그래프 눈금 같은 작은 줄이 많은 쪽에서도 본문 크기 문항 글은 제목이 아님 (번호를 빼지 않음)', () => {
  const tokens = [
    // 진짜 제목 (본문보다 확실히 큼)
    xt('이차함수의', 0.13, 0.2, 0.11, 0.016, XP), xt('그래프', 0.21, 0.26, 0.11, 0.016, XP),
    xt('105', 0.093, 0.13, 0.443, 0.0194, XN), xt('이차함수', 0.144, 0.208, 0.446, 0.0127, XP), xt('y=2(x+1)²-3의', 0.216, 0.355, 0.446),
    xt('대하여', 0.093, 0.13, 0.468, 0.0127, XP), xt('대칭이동시킨', 0.14, 0.22, 0.468, 0.0127, XP),
    xt('106', 0.093, 0.13, 0.553, 0.0194, XN), xt('이차함수', 0.144, 0.207, 0.556, 0.0127, XP), xt('y=-3(x+1)²-2의', 0.211, 0.361, 0.556),
    xt('대하여', 0.093, 0.13, 0.578, 0.0127, XP), xt('대칭이동한', 0.14, 0.21, 0.578, 0.0127, XP),
  ];
  // 오른쪽 단 그래프의 라벨 ("y", "O", "x") — 모든 줄의 가운데 높이가 0.0091 이 됨
  for (let i = 0; i < 12; i++) tokens.push(xt(['y', 'O', 'x'][i % 3], 0.6 + (i % 4) * 0.05, 0.607 + (i % 4) * 0.05, 0.17 + i * 0.02, 0.0091));
  const { candidates, headings } = extractCandidates(tokens, XI2);
  assert.deepEqual(candidates.map((c) => c.digits), ['105', '106']);
  assert.equal(headings.length, 1);
  assert.ok(Math.abs(headings[0].y0 - 0.11) < 1e-9);
});

test('extractCandidates: 번호 뒤 꺾쇠 기호 "<x>는" 은 부등호가 아니고, 단 경계까지 뻗은 그림의 작은 라벨은 앞 글자가 아님', () => {
  const tokens = [
    xt('153', 0.523, 0.56, 0.385, 0.0194, XN), xt('<x>는', 0.574, 0.635, 0.389), xt('자연수', 0.642, 0.689, 0.389, 0.0127, XP),
    // 줄 맨 앞 수식 "3 < x" 는 그대로 번호가 아님
    xt('3', 0.523, 0.531, 0.45), xt('<', 0.545, 0.555, 0.45), xt('x', 0.565, 0.573, 0.45),
    // 131 바로 왼쪽의 그림 라벨 "y", "O" (높이 0.0091)
    xt('y', 0.502, 0.508, 0.608, 0.0091), xt('O', 0.513, 0.523, 0.629, 0.0091),
    xt('131', 0.523, 0.556, 0.616, 0.0194, XN), xt('이차함수', 0.574, 0.639, 0.62, 0.0127, XP),
    // 본문 크기 글자가 바로 앞이면 여전히 줄 가운데 숫자
    xt('값은', 0.6, 0.64, 0.7, 0.0127, XP), xt('7', 0.645, 0.656, 0.7, 0.0194, XN),
  ];
  const { candidates } = extractCandidates(tokens, XI2);
  assert.deepEqual(candidates.map((c) => c.digits), ['153', '131']);
});

test('selectAnchors·dropStrayRuns: 두 단에 걸쳐 가로로 번호가 이어지는 쪽("021 | 022 / 023 | 024")도 번호를 다 고르고 버리지 않음', async () => {
  const { dropStrayRuns, rowMajorOrder } = await import('../../src/renderer/js/detect.js');
  const mk = (num, col, y) => {
    const x0 = col ? 0.523 : 0.093;
    return { num, digits: String(num).padStart(3, '0'), style: 'plain', prefix: '', col, x0, x1: x0 + 0.037, y0: y, y1: y + 0.0194, h: 0.0194, relX: 0.001, hRatio: 1.52, conf: 100, padded: true, font: XN, ocr: false };
  };
  // 보통 쪽(단 → 위아래) 사이에 가로로 이어지는 쪽 (오른쪽 단 번호가 왼쪽보다 조금 아래)
  const colMajor = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => mk(a + i, i < (b - a + 1) / 2 ? 0 : 1, 0.12 + (i % Math.ceil((b - a + 1) / 2)) * 0.25));
  const rowMajor = (a, rows) => Array.from({ length: 2 * rows }, (_, i) => mk(a + i, i % 2, 0.141 + Math.floor(i / 2) * 0.26 + (i % 2) * 0.034));
  const sorted = (list) => list.sort((a, b) => a.col - b.col || a.y0 - b.y0); // 후보는 읽는 순서(단 → 위아래)로 들어옴
  const pages = [colMajor(1, 6), colMajor(7, 12), rowMajor(13, 2), rowMajor(17, 3), colMajor(23, 28), colMajor(29, 34)].map((list, index) => ({ index, candidates: sorted(list) }));
  const { anchors } = selectAnchors(pages);
  for (const [idx, chain] of anchors) anchors.set(idx, rowMajorOrder(chain)); // analyze.js 처럼 가로로 이어지는 쪽은 번호 순서로
  assert.equal(dropStrayRuns(pages.map((p) => p.index), anchors, '|3'), 0);
  const got = pages.flatMap((p) => anchors.get(p.index).map((a) => a.num)).sort((a, b) => a - b);
  assert.deepEqual(got, Array.from({ length: 34 }, (_, i) => i + 1));
  const plain = (num) => ({ num, digits: String(num).padStart(3, '0'), padded: true, prefix: '' });
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => plain(a + i));
  // 해설 쪽 가운데서 다음 단원이 25번부터 시작해도(앞 번호는 다른 곳) 앞 단원 끝 번호는 둠
  const answers = new Map([[0, range(130, 149)], [1, [plain(150), plain(151), ...range(25, 31)]], [2, range(32, 45)]]);
  assert.equal(dropStrayRuns([0, 1, 2], answers, '|3'), 0);
});
