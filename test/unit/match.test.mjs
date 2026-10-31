import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchItems, matchByOccurrence } from '../../src/renderer/js/match.js';

const mk = (prefix, nums) => nums.map((n, i) => ({ id: `${prefix}${i}`, num: n }));

test('matchItems: 단원마다 번호가 다시 시작하는 경우 순서대로 짝', () => {
  const p = mk('p', [1, 2, 3, 1, 2, 3]);
  const a = mk('a', [1, 2, 3, 1, 2, 3]);
  const m = matchItems(p, a);
  assert.equal(m.get('p3'), 'a3');
  assert.equal(m.get('p5'), 'a5');
});

test('matchItems: 답지에서 하나가 빠져도 나머지는 올바르게', () => {
  const p = mk('p', [1, 2, 3, 4, 1, 2, 3, 4]);
  const a = mk('a', [1, 2, 4, 1, 2, 3, 4]); // 첫 단원 3번 누락
  const m = matchItems(p, a);
  assert.equal(m.get('p2'), undefined); // 첫 단원 3번 → 짝 없음
  assert.equal(m.get('p3'), 'a2'); // 첫 단원 4번
  assert.equal(m.get('p6'), 'a5'); // 둘째 단원 3번
});

test('matchItems: 책 전체 연번', () => {
  const p = mk('p', [1, 2, 3, 4, 5]);
  const a = mk('a', [0, 1, 2, 3, 4, 5, 6]);
  const m = matchItems(p, a);
  assert.equal(m.get('p0'), 'a1');
  assert.equal(m.get('p4'), 'a5');
});

test('matchByOccurrence', () => {
  const m = matchByOccurrence(mk('p', [1, 2, 1]), mk('a', [1, 1, 2]));
  assert.equal(m.get('p0'), 'a0');
  assert.equal(m.get('p1'), 'a2');
  assert.equal(m.get('p2'), 'a1');
});
