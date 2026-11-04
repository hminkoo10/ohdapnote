import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SUBJECTS, subjectOf, subjectName, contractedSubjects, subjectOpen } from '../../src/renderer/js/subjects.js';

const require = createRequire(import.meta.url);
const main = require('../../src/main/subjects.js');

test('학원 계약 과목: 약속 1 순서로, 모르는 값·중복은 빼고, 없으면 수학만', () => {
  assert.deepEqual(main.contractSubjects(undefined), ['math']);
  assert.deepEqual(main.contractSubjects(null), ['math']);
  assert.deepEqual(main.contractSubjects('math'), ['math']);
  assert.deepEqual(main.contractSubjects([]), []); // 계약한 과목이 없을 수도 있음
  assert.deepEqual(main.contractSubjects(['korean', 'math', 'korean', 'science']), ['math', 'korean']);
  assert.deepEqual(main.contractSubjects(['english']), ['english']);
});

test('교재 과목: 없거나 모르는 값이면 수학', () => {
  assert.equal(main.bookSubject({}), 'math');
  assert.equal(main.bookSubject(null), 'math');
  assert.equal(main.bookSubject({ subject: 'english' }), 'english');
  assert.equal(main.bookSubject({ subject: 'Science' }), 'math');
  assert.equal(subjectOf({ subject: 'korean' }), 'korean');
  assert.equal(subjectOf({ subject: 'x' }), 'math');
});

test('화면: 과목 이름과 계약 여부', () => {
  assert.deepEqual(SUBJECTS.map((s) => s.name), ['수학', '영어', '국어']);
  assert.equal(subjectName('english'), '영어');
  assert.deepEqual(contractedSubjects({}), ['math']);
  assert.deepEqual(contractedSubjects({ subjects: ['korean', 'english'] }), ['english', 'korean']);
  assert.equal(subjectOpen({ subject: 'english' }, { subjects: ['math'] }), false);
  assert.equal(subjectOpen({}, { subjects: ['math', 'english'] }), true); // 기존 교재 = 수학
  assert.equal(subjectOpen({}, { subjects: ['english'] }), false);
});
