import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNumberWord,
  normalizeOcrWord,
  buildLines,
  extractCandidates,
  selectAnchors,
  computeItems,
  guessPageOffset,
} from '../../src/renderer/js/detect.js';
import { analyzeLayout, trimRect } from '../../src/renderer/js/layout.js';

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
