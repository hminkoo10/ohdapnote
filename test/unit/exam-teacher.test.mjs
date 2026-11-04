import { test } from 'node:test';
import assert from 'node:assert/strict';
import { examTeacher } from '../../src/renderer/js/exam-teacher.js';

const student = { id: 'student-1', teacher: { id: 'teacher-1', name: '담당 선생님' } };
const context = {
  roster: 'cloud', students: [student], user: { name: '내 이름' }, settings: { teacher: '설정 이름' },
};
const note = { studentId: student.id };

test('시험지 선생님: 학원 명단 학생의 담당이 기본값', () => {
  assert.equal(examTeacher(note, context), '담당 선생님');
});

test('시험지 선생님: 담당 없음·이름 없음·학생 미지정이면 설정의 기본 이름', () => {
  for (const students of [[], [{ id: student.id }], [{ id: student.id, teacher: { name: '' } }]]) {
    assert.equal(examTeacher(note, { ...context, students }), '설정 이름');
  }
  assert.equal(examTeacher({}, context), '설정 이름');
});

test('시험지 선생님: 개인·없는 학원 명단의 담당은 쓰지 않음', () => {
  for (const roster of ['local', 'missing', undefined]) {
    assert.equal(examTeacher(note, { ...context, roster }), '설정 이름');
  }
});

test('시험지 선생님: 설정이 비면 로그인 이름, 그것도 없으면 빈칸', () => {
  assert.equal(examTeacher({}, { ...context, settings: { teacher: '' } }), '내 이름');
  assert.equal(examTeacher({}, { user: context.user }), '내 이름');
  assert.equal(examTeacher({}, {}), '');
});

test('시험지 선생님: 저장된 이름은 담당·나·설정보다 우선', () => {
  assert.equal(examTeacher({ ...note, teacher: '직접 쓴 이름' }, context), '직접 쓴 이름');
  assert.equal(examTeacher({ ...note, teacher: '  예전 이름  ' }, context), '  예전 이름  ');
});

test('시험지 선생님: 저장된 빈칸은 유지, null은 기본값', () => {
  assert.equal(examTeacher({ ...note, teacher: '' }, context), '');
  assert.equal(examTeacher({ ...note, teacher: null }, context), '담당 선생님');
});

test('시험지 선생님: 명단에서 떠난 담당도 학생에 남은 이름 사용', () => {
  assert.equal(examTeacher(note, { ...context, members: [] }), '담당 선생님');
});

test('시험지 선생님: 조회만으로 노트·설정을 바꾸지 않음', () => {
  const frozenNote = Object.freeze({ ...note });
  const frozenContext = Object.freeze({ ...context, settings: Object.freeze({ ...context.settings }) });
  assert.equal(examTeacher(frozenNote, frozenContext), '담당 선생님');
  assert.equal(Object.hasOwn(frozenNote, 'teacher'), false);
});
