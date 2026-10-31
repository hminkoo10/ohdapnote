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
