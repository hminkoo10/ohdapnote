import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidates, filterAnswerCandidates, computeItems } from '../../src/renderer/js/detect.js';

const layout = { columns: [{ x0: 0.08, x1: 0.47 }, { x0: 0.53, x1: 0.92 }], bodyTop: 0.05, bodyBottom: 0.95 };
const word = (str, x0, y0, w = 0.015, h = 0.01, conf = 95) => ({ str, x0, x1: x0 + w, y0, y1: y0 + h, conf });
const candidate = (num, x0, y0, extra = {}) => ({ num, digits: String(num), style: 'plain', prefix: '', x0, x1: x0 + 0.015, y0, y1: y0 + 0.01, h: 0.01, col: 0, relX: 0, conf: 95, ...extra });

test('해설: 아래 정답 상자의 큰 OCR 영역은 번호 앞 글자가 아님', () => {
  const tokens = [word('12', 0.083, 0.1), word('label', 0.08, 0.106, 0.03, 0.034)];
  assert.equal(extractCandidates(tokens, layout, { ocr: true }).candidates.length, 0);
  assert.deepEqual(extractCandidates(tokens, layout, { ocr: true, answer: true }).candidates.map(c => c.num), [12]);
});

test('해설: 들여쓴 본문 수치 범위는 지문 머리가 아님', () => {
  const tokens = [word('2~9', 0.125, 0.2, 0.04), word('[12~14]', 0.08, 0.4, 0.06), word('16~18', 0.08, 0.6, 0.05)];
  assert.equal(extractCandidates(tokens, layout, { ocr: true, passages: true }).ranges.length, 3);
  assert.deepEqual(extractCandidates(tokens, layout, { ocr: true, passages: true, answer: true }).ranges.map(r => r.a), [12, 16]);
});

test('해설: 붙여 쓴 문단·등수와 한글을 잘라 읽은 숫자는 제외, 제목은 유지', () => {
  const nums = [candidate(2, 0.08, 0.2), candidate(1, 0.08, 0.4), candidate(3, 0.08, 0.6), candidate(12, 0.08, 0.8)];
  const tokens = [word('문', 0.096, 0.196, 0.012, 0.018), word('등', 0.097, 0.4), word('본문', 0.078, 0.6, 0.04), word('제목', 0.108, 0.8, 0.04)];
  assert.deepEqual(filterAnswerCandidates(nums, tokens).map(c => c.num), [12]);
});

test('해설: 낮은 신뢰도 숫자 단독 오인은 제외', () => {
  const nums = [candidate(17, 0.08, 0.2, { conf: 35 }), candidate(18, 0.08, 0.4)];
  assert.deepEqual(filterAnswerCandidates(nums, []).map(c => c.num), [18]);
});

test('해설: 같은 자리의 OCR 신뢰도·마침표 근거를 합침, 다른 번호와는 분리', () => {
  const nums = [candidate(17, 0.08, 0.2, { conf: 35 }), candidate(17, 0.081, 0.201, { style: 'dot', conf: 92 }), candidate(18, 0.08, 0.4)];
  const got = filterAnswerCandidates(nums, []);
  assert.deepEqual(got.map(c => [c.num, c.style, c.conf]), [[17, 'dot', 92], [18, 'plain', 95]]);
  assert.equal(nums[0].conf, 35);
});

test('해설: 제목까지 걸친 OCR 상자는 더 확실한 숫자 좌표로 보정', () => {
  const wide = candidate(14, 0.08, 0.2, { x1: 0.115, conf: 85 });
  const narrow = candidate(14, 0.08, 0.2, { conf: 96 });
  const got = filterAnswerCandidates([wide, narrow], [word('제목', 0.1005, 0.2, 0.04)]);
  assert.equal(got.length, 1);
  assert.equal(got[0].x1, narrow.x1);
});

test('해설: 다음 쪽 번호 리셋이면 제목 띠 위로 앞 해설을 잇지 않음', () => {
  const g = { w: 100, h: 100, data: new Uint8Array(10000).fill(1) };
  const a = candidate(18, 0.08, 0.7);
  const b = candidate(1, 0.08, 0.5);
  const second = { ...layout, spans: [{ y0: 0.15, y1: 0.18 }] };
  const run = answer => computeItems([0, 1], new Map([[0, [a]], [1, [b]]]), new Map([[0, layout], [1, second]]), new Map([[0, g], [1, g]]), { passages: true, answer });
  assert.ok(run(false)[0].rects.some(r => r.page === 1));
  assert.ok(run(true)[0].rects.every(r => r.page === 0));
  assert.equal(run(true)[1].num, 1);
});

test('해설: 단 중간의 선택과목 띠 위까지는 앞 해설을 이어 붙임', () => {
  const g = { w: 200, h: 300, data: new Uint8Array(60000) };
  const fill = (x0, x1, y0, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g.data[y * g.w + x] = 1;
  };
  fill(16, 94, 210, 280);
  fill(106, 184, 18, 90);
  fill(106, 184, 120, 129); // 넓고 앞뒤가 빈 제목 띠
  fill(106, 184, 150, 280);
  const a = candidate(40, 0.08, 0.7);
  const b = candidate(30, 0.53, 0.5, { col: 1 });
  const run = () => computeItems([0], new Map([[0, [a, b]]]), new Map([[0, layout]]), new Map([[0, g]]), { passages: true, answer: true });
  const items = run();
  assert.equal(items[0].rects.length, 2);
  assert.ok(items[0].rects[1].y + items[0].rects[1].h < 0.4);
  assert.ok(items[1].rects[0].y > 0.43);
  // 좁은 본문 상자는 선택과목 띠로 보지 않음
  for (let y = 120; y < 129; y++) for (let x = 120; x < 184; x++) g.data[y * g.w + x] = 0;
  assert.equal(run()[0].rects.length, 1);
});
