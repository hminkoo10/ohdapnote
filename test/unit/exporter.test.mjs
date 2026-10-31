import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBlocks, itemName } from '../../src/renderer/js/exporter.js';

const e = (n, withAns = true) => ({ problem: { number: String(n), prefix: '', page: 0, rects: [] }, answer: withAns ? { number: String(n), page: 3, rects: [] } : null });
const label = (role, it) => `p.${it.page + 1}`;

test('makeBlocks: 문제+해설 — 문제마다 바로 뒤에', () => {
  const kinds = makeBlocks('both-inline', [e(1), e(2, false)], {}, label).map((b) => b.kind);
  assert.deepEqual(kinds, ['problem', 'answer', 'problem', 'note']);
});

test('makeBlocks: 문제+해설 — 해설은 맨 뒤에', () => {
  const kinds = makeBlocks('both-end', [e(1), e(2)], {}, label).map((b) => b.kind);
  assert.deepEqual(kinds, ['problem', 'problem', 'section', 'answer', 'answer']);
});

test('itemName: 말머리 표시', () => {
  assert.equal(itemName({ number: '12' }), '12번');
  assert.equal(itemName({ number: '3', prefix: '유제' }), '유제 3');
});
