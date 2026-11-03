// 오답노트 3-way 병합 (src/main/notemerge.js): 학생 오답노트를 두 사람이 같이 고칠 때
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeNote, mergeList } = require('../../src/main/notemerge.js');

const B1 = 'book-0000-0001';
const B2 = 'book-0000-0002';
const B3 = 'book-0000-0003';
const base = {
  id: 'note-0000-0001',
  kind: 'note',
  version: 2,
  title: '1학기 오답',
  student: '김하늘',
  studentId: 'stu-0000-0001',
  bookIds: [B1, B2],
  selected: { [B1]: ['a', 'b'], [B2]: ['x'] },
  renamesSeen: { [B1]: 2, [B2]: 0 },
  exportOptions: { space: 'normal', answers: true },
  createdAt: 1,
  updatedAt: 10,
};
const copy = () => structuredClone(base);

test('목록: 지금 파일 순서 + 내가 더한 것, 내가 뺀 것은 빠짐', () => {
  assert.deepEqual(mergeList(['a', 'b'], ['a', 'c'], ['b', 'a', 'd']), ['a', 'd', 'c']);
  assert.deepEqual(mergeList(undefined, ['a'], undefined), ['a']);
  assert.deepEqual(mergeList(['a'], [], ['a', 'b']), ['b']);
});

test('고른 문항은 책마다 서로 더하고 뺀 것이 모두 남음', () => {
  const mine = copy();
  mine.selected[B1] = ['a', 'c']; // b 빼고 c 더함
  mine.updatedAt = 20;
  const cur = copy();
  cur.selected[B1] = ['a', 'b', 'd']; // d 더함
  cur.selected[B2] = []; // x 뺌
  cur.updatedAt = 15;
  const out = mergeNote(base, mine, cur);
  assert.deepEqual(out.selected[B1], ['a', 'd', 'c']);
  assert.deepEqual(out.selected[B2], []);
  assert.equal(out.updatedAt, 20);
});

test('제목 같은 칸은 한쪽만 바뀐 쪽을, 둘 다 바뀌면 내 것을', () => {
  const mine = copy();
  mine.student = '김하늘(고2)';
  const cur = copy();
  cur.title = '중간고사 대비';
  let out = mergeNote(base, mine, cur);
  assert.equal(out.title, '중간고사 대비');
  assert.equal(out.student, '김하늘(고2)');
  cur.student = '다른 이름';
  out = mergeNote(base, mine, cur);
  assert.equal(out.student, '김하늘(고2)');
});

test('내보내기 설정은 칸마다 합침', () => {
  const mine = copy();
  mine.exportOptions.space = 'wide';
  const cur = copy();
  cur.exportOptions.answers = false;
  cur.exportOptions.cover = true;
  assert.deepEqual(mergeNote(base, mine, cur).exportOptions, { space: 'wide', answers: false, cover: true });
});

test('책 더하기·빼기: 뺀 책의 선택은 사라지고 더한 책은 양쪽 것이 모두', () => {
  const mine = copy();
  mine.bookIds = [B1, B3]; // B2 빼고 B3 더함
  delete mine.selected[B2];
  mine.selected[B3] = ['m1'];
  mine.renamesSeen[B3] = 4;
  const cur = copy();
  cur.bookIds = [B1, B2, B3]; // 다른 사람도 B3 더함
  cur.selected[B3] = ['c1'];
  cur.renamesSeen[B1] = 5;
  const out = mergeNote(base, mine, cur);
  assert.deepEqual(out.bookIds, [B1, B3]);
  assert.deepEqual(Object.keys(out.selected), [B1, B3]);
  assert.deepEqual(out.selected[B3], ['c1', 'm1']);
  assert.deepEqual(out.renamesSeen, { [B1]: 5, [B3]: 4 });
});

test('다른 사람이 학생을 바꿨고 나는 안 바꿨으면 바뀐 학생 (파일을 옮기지 않게)', () => {
  const mine = copy();
  mine.selected[B1] = ['a', 'b', 'c'];
  const cur = copy();
  cur.studentId = 'stu-0000-0002';
  cur.student = '이바다';
  const out = mergeNote(base, mine, cur);
  assert.equal(out.studentId, 'stu-0000-0002');
  assert.equal(out.student, '이바다');
  assert.deepEqual(out.selected[B1], ['a', 'b', 'c']);
});

test('base 가 없으면 지금 파일과 내 것의 합 (내 것이 이김)', () => {
  const mine = copy();
  mine.title = '내 제목';
  const cur = copy();
  cur.selected[B1] = ['z'];
  const out = mergeNote(null, mine, cur);
  assert.equal(out.title, '내 제목');
  assert.deepEqual(out.selected[B1], ['z', 'a', 'b']);
});
