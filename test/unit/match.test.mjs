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

test('matchItems: 말머리(예제/유제)·0 채움·해설 크기가 같은 짝을 우선', () => {
  const it = (id, num, number, prefix = '', h = 0.1) => ({ id, num, number, prefix, rects: [{ w: 0.3, h }] });
  // 문제: 예제1, 1, 2 / 답지: 1, 2 → 예제1 은 짝 없음
  const m1 = matchItems([it('e1', 1, '1', '예제'), it('p1', 1, '1'), it('p2', 2, '2')], [it('a1', 1, '1'), it('a2', 2, '2')]);
  assert.equal(m1.get('e1'), undefined);
  assert.equal(m1.get('p1'), 'a1');
  // 빠른 정답표(작은 칸) 뒤에 실제 해설(큰 영역)이 있으면 실제 해설과 짝
  const quick = [it('q1', 1, '0001', '', 0.01), it('q2', 2, '0002', '', 0.01)];
  const real = [it('r1', 1, '0001', '', 0.2), it('r2', 2, '0002', '', 0.3)];
  const m2 = matchItems([it('p1', 1, '0001'), it('p2', 2, '0002')], [...quick, ...real]);
  assert.equal(m2.get('p1'), 'r1');
  assert.equal(m2.get('p2'), 'r2');
});
