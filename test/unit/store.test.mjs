import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickSelect, computeMatches, normalizeDoc } from '../../src/renderer/js/store.js';
import { parseResponse } from '../../src/renderer/js/gemini.js';

const item = (page, num, y = 0.1) => ({ id: `${page}:${num}`, page, number: String(num), num, col: 0, rects: [{ page, x: 0.1, y, w: 0.3, h: 0.1 }] });
const doc = { pageOffset: 10, items: [item(0, 1), item(0, 2, 0.3), item(1, 3), item(2, 1), item(2, 2, 0.3)] };

test('parseQuickSelect: 쪽 지정', () => {
  const r = parseQuickSelect('11쪽: 1, 2', doc);
  assert.deepEqual(r.ids, ['0:1', '0:2']);
  assert.deepEqual(parseQuickSelect('p13 1-2', doc).ids, ['2:1', '2:2']);
});

test('parseQuickSelect: 번호만 → 같은 번호 모두', () => {
  const r = parseQuickSelect('1, 3', doc);
  assert.deepEqual(r.ids.sort(), ['0:1', '1:3', '2:1']);
  assert.deepEqual(parseQuickSelect('99', doc).unknown, ['99']);
});

test('computeMatches: 사용자가 고친 짝이 우선', () => {
  const project = {
    docs: { problem: { items: [item(0, 1), item(0, 2, 0.3)] }, answer: { items: [item(5, 1), item(5, 2, 0.3)] } },
    answerOverrides: { '0:2': '' },
  };
  const m = computeMatches(project);
  assert.equal(m.get('0:1'), '5:1');
  assert.equal(m.get('0:2'), null);
});

test('normalizeDoc: ID 가 바뀌면 선택도 따라감', () => {
  const a = item(0, 1);
  const b = item(0, 2, 0.3);
  b.number = '5';
  b.num = 5;
  const project = { docs: { problem: { items: [a, b] } }, selected: ['0:2'], answerOverrides: {} };
  normalizeDoc(project, 'problem');
  assert.deepEqual(project.selected, ['0:5']);
});

test('gemini parseResponse: box_2d → 비율 좌표', () => {
  const json = { candidates: [{ content: { parts: [{ text: '[{"number":"12","box_2d":[100,50,400,480]},{"number":"x","box_2d":[0,0,1,1]}]' }] } }] };
  const r = parseResponse(json);
  assert.equal(r.length, 1);
  assert.equal(r[0].number, '12');
  assert.deepEqual(r[0].rect, { x: 0.05, y: 0.1, w: 0.43, h: 0.30000000000000004 });
});
