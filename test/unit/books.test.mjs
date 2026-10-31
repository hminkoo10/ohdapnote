import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDoc, missingNumbers, flaggedPages, selectedItems, noteSelection, setNoteSelection, noteSelectedCount } from '../../src/renderer/js/store.js';
import { makeBlocks } from '../../src/renderer/js/exporter.js';

const item = (page, num, y = 0.1, extra = {}) => ({ id: `${page}:${num}`, page, number: String(num), num, col: 0, rects: [{ page, x: 0.1, y, w: 0.3, h: 0.1 }], ...extra });

test('normalizeDoc: 바뀐 문제 ID 를 돌려주고 짝 정보도 옮김', () => {
  const a = item(0, 1);
  const b = item(0, 2, 0.3);
  b.number = '5';
  b.num = 5;
  const book = { docs: { problem: { items: [a, b] } }, answerOverrides: { '0:2': '3:2' } };
  const { renames } = normalizeDoc(book, 'problem');
  assert.deepEqual(renames, { '0:2': '0:5' });
  assert.deepEqual(book.answerOverrides, { '0:5': '3:2' });
});

test('missingNumbers: 건너뛴 번호를 그 쪽에 표시 (다시 시작·큰 점프는 무시)', () => {
  const doc = { items: [item(0, 1), item(0, 2, 0.3), item(1, 4), item(1, 5, 0.3), item(2, 1), item(2, 90, 0.3)], pageInfo: {} };
  const m = missingNumbers(doc);
  assert.deepEqual([...m.keys()], [1]);
  assert.equal(m.get(1)[0].num, 3);
  assert.equal(m.get(1)[0].beforeId, '1:4');
  // 사용자가 "문제없음"으로 넘긴 쪽은 빼기
  doc.pageInfo[1] = { ok: true };
  assert.equal(missingNumbers(doc).size, 0);
});

test('missingNumbers: 머리말(유제)이 다른 번호는 따로 셈', () => {
  const doc = { items: [item(0, 1), item(0, 1, 0.2, { prefix: '유제', id: '0:유제1' }), item(0, 2, 0.4), item(0, 2, 0.6, { prefix: '유제', id: '0:유제2' })], pageInfo: {} };
  assert.equal(missingNumbers(doc).size, 0);
});

test('flaggedPages: 확인 표시가 있고 문제없음이 아닌 쪽만', () => {
  const doc = { pageInfo: { 0: { flags: ['a'] }, 1: { flags: [] }, 2: { flags: ['b'], ok: true }, 3: { flags: ['c'] } } };
  assert.deepEqual(flaggedPages(doc), [0, 3]);
});

test('오답노트 선택: 책별로 저장하고 사라진 문항은 빠짐', () => {
  const note = { selected: {} };
  setNoteSelection(note, 'b1', ['0:1', '0:1', '1:3']);
  assert.deepEqual(noteSelection(note, 'b1'), ['0:1', '1:3']);
  assert.deepEqual(noteSelection(note, 'b2'), []);
  assert.equal(noteSelectedCount(note), 2);
  const book = { docs: { problem: { items: [item(1, 3), item(0, 1)] } } };
  assert.deepEqual(selectedItems(book, ['1:3', '0:1', '9:9']).map((it) => it.id), ['0:1', '1:3']);
});

test('makeBlocks: 같은 공통 지문은 처음 문항에만, 책이 여럿이면 출처에 책 이름', () => {
  const stem = [{ page: 0, x: 0.1, y: 0.05, w: 0.3, h: 0.05 }];
  const e = (n, book = '') => ({ book, problem: item(0, n, 0.1 * n, { stem, stemLabel: '1~3' }), answer: null });
  const blocks = makeBlocks('problems', [e(1, '쎈'), e(2, '쎈'), e(3, '쎈')], { labels: true, renumber: true }, (r, it) => `p.${it.page + 1}`);
  assert.equal(blocks[0].stem, stem);
  assert.equal(blocks[1].stem, null);
  assert.equal(blocks[0].num, '1.');
  assert.equal(blocks[0].source, '쎈 p.1 1번');
});

test('missingNumbers: 번호 하나만 잘못 읽은 경우(1, 9, 3, 4 …)는 9 앞을 모두 빠졌다고 하지 않음', () => {
  const doc = { items: [item(0, 1, 0.1), item(0, 9, 0.2), item(0, 3, 0.3), item(0, 4, 0.4), item(0, 5, 0.5), item(0, 6, 0.6), item(0, 7, 0.7), item(0, 8, 0.8), item(0, 10, 0.9)], pageInfo: {} };
  const m = missingNumbers(doc);
  assert.deepEqual([...m.values()].flat().map((x) => x.num), [2]);
});

test('missingNumbers: 다음 단원(멀리 떨어진 쪽)의 같은 번호 때문에 빠진 번호를 놓치지 않음', () => {
  const doc = { items: [item(0, 1, 0.1), item(0, 9, 0.2), ...[3, 4, 5, 6, 7, 8].map((n) => item(0, n, n / 10)), item(1, 9), item(1, 10, 0.3), item(4, 1, 0.1), item(4, 2, 0.2), item(4, 3, 0.3)], pageInfo: {} };
  assert.deepEqual([...missingNumbers(doc).values()].flat().map((x) => x.num), [2]);
  // 진짜로 여러 개가 빠졌으면 한 번씩만 알림
  const doc2 = { items: [item(0, 1, 0.1), item(0, 2, 0.2), item(0, 6, 0.3), item(1, 3), item(1, 7, 0.3)], pageInfo: {} };
  const nums = [...missingNumbers(doc2).values()].flat().map((x) => x.num);
  assert.equal(new Set(nums).size, nums.length);
});
