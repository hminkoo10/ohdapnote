import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { identifyExam, groupExamFiles } from '../../src/renderer/js/mockexam.js';
import { parseAnswerKey, answerKeyToAnswers } from '../../src/renderer/js/mockexam-answers.js';
import { normalizeHancomText, HANCOM_PUA } from '../../src/renderer/js/hancom.js';
const { sanitizeAnswers } = createRequire(import.meta.url)('../../src/main/answers.js');

for (const [title, expected] of [
  ['2025학년도 대학수학능력시험 9월 모의평가 수학 문제지', { exam: 'kice', year: 2024, schoolYear: 2025, month: 9, grade: 3, subject: 'math' }],
  ['2024년 3월 고3 전국연합학력평가 국어 정답표', { exam: 'edu', year: 2024, month: 3, grade: 3, part: 'answerKey' }],
  ['2003학년도 대학수학능력시험 언어 영역 홀수형 문제지', { exam: 'csat', year: 2002, subject: 'korean', form: '홀' }],
  ['2005학년도 대학수학능력시험 수리 가형', { subject: 'math', selection: '가형' }],
  ['2014학년도 대학수학능력시험 국어 A형', { selection: 'A형', year: 2013 }],
  ['2014학년도 대학수학능력시험 외국어(영어) 영역', { subject: 'english', listening: { start: 1, end: 22 } }],
  ['2015학년도 대학수학능력시험 영어', { listening: { start: 1, end: 17 } }],
  ['2022학년도 대학수학능력시험 국어 화법과 작문 언어와 매체', { selection: null }],
  ['2026년 9월 고2 전국연합학력평가 국어 수학 영어 정답 및 해설', { subject: null, part: 'solution', grade: 2 }],
  ['2021학년도 대학수학능력시험 수리 나형 짝수형', { selection: '나형', form: '짝', year: 2020 }],
]) test(`가짜 시험 제목: ${title}`, () => {
  const actual = identifyExam({ text: title });
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(actual[k], v, k);
});

test('연기 회차 제목 우선·모르는 메타는 낮은 확신', () => {
  const m = identifyExam({ filename: '2020년 4월 고3 전국연합학력평가.pdf', text: '2020년 5월 고3 전국연합학력평가 영어 문제지' });
  assert.equal(m.month, 5); assert.ok(m.reasons.some((r) => r.includes('불일치')));
  assert.ok(identifyExam({ filename: 'unknown.pdf' }).confidence < 0.5);
  assert.equal(identifyExam({ filename: '2024 영어 듣기.mp3' }).part, 'audio');
});
test('파일 묶기: 세트 결합, 홀짝·선택·불명 분리', () => {
  const files = ['문제지', '정답표', '해설', '듣기 대본'].map((p) => ({ filename: `2025학년도 대학수학능력시험 영어 ${p}.pdf` }));
  assert.equal(groupExamFiles(files).length, 1);
  assert.equal(groupExamFiles([{ filename: '모름.pdf' }, { filename: '모름2.pdf' }]).length, 2);
  assert.equal(groupExamFiles(['홀수형', '짝수형'].map((p) => ({ filename: `2025학년도 수능 국어 ${p}.pdf` }))).length, 2);
});
test('PUA 숫자와 미확인 코드 보존', () => {
  assert.equal(normalizeHancomText('\ue034\ue03d\ue039'), '106');
  assert.equal(normalizeHancomText('\ue034', 'OtherFont'), '\ue034');
  assert.equal(normalizeHancomText('\uf888'), '\uf888');
  assert.ok(Object.keys(HANCOM_PUA).length > 100);
});
test('선택 약칭 정규화, 옛 듣기는 불명으로 보존', () => {
  for (const [name, selection] of [['화작', '화법과작문'], ['언매', '언어와매체'], ['확통', '확률과통계'], ['미적', '미적분']]) {
    assert.equal(identifyExam({ filename: `2025학년도 수능 ${name}.pdf` }).selection, selection);
  }
  assert.equal(identifyExam({ text: '2003학년도 수능 언어' }).listening, null);
});
test('합본·공통/선택·PUA 단답·타 과목 제외', () => {
  const r = parseAnswerKey('국어영역\n1 ②\n34 ⑤\n[화법과작문]\n35 ①\n[언어와매체]\n35 ③\n수학영역\n1 ④\n22 \ue035\ue03d\ue035\n[확률과통계]\n29 \ue036\ue037\ue03830 \ue03c\n영어영역\n1 ⑤\n한국사영역\n1 ①');
  assert.equal(r.answers.korean[1].answer, '2');
  assert.equal(r.answers['korean|언어와매체'][35].answer, '3');
  assert.equal(r.answers.math[22].answer, '202');
  assert.equal(r.answers['math|확률과통계'][29].answer, '345');
  assert.equal(r.answers['math|확률과통계'][30].answer, '9');
  assert.deepEqual(Object.keys(r.answers.english), ['1']);
  const out = answerKeyToAnswers(r, 'math|확률과통계', { 1: 'fake-1', 22: 'fake-22', 29: 'fake-29', 30: 'fake-30' });
  assert.deepEqual(sanitizeAnswers(out), out);
  assert.equal(out.items['fake-29'].answer, '345');
});
test('배점 열, 중복 답 충돌, 미확인 PUA', () => {
  const r = parseAnswerKey('수학 영역\n번호 정답 배점\n1 ③ 2\n2 ④ 3\n2 ⑤ 3\n\uf888');
  assert.deepEqual(r.answers.math[1], { answer: '3', points: 2 });
  assert.equal(r.answers.math[2], undefined);
  assert.equal(r.warnings.length, 2);
});

for (let year = 2002; year <= 2026; year++) test(`시행연도/학년도 분리 ${year}`, () => {
  const exam = identifyExam({ filename: `${year + 1}학년도 수능 영어 문제지.pdf` });
  assert.equal(exam.year, year);
  assert.equal(exam.schoolYear, year + 1);
  assert.equal(exam.subject, 'english');
});
