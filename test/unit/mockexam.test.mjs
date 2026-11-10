import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { identifyExam, groupExamFiles } from '../../src/renderer/js/mockexam.js';
import { parseAnswerKey, answerKeyToAnswers } from '../../src/renderer/js/mockexam-answers.js';
import { normalizeHancomText, HANCOM_PUA, resolvePdfFontName } from '../../src/renderer/js/hancom.js';
const { sanitizeAnswers } = createRequire(import.meta.url)('../../src/main/answers.js');

test('본문은 시험 제목이 아니며 모평 약칭도 식별', () => {
  const m = identifyExam({ filename: '2024학년도_6월모평_영어_문제지.pdf', text: '고2 학생은 수학 풀이를 읽었다. 가형 평가원' });
  assert.deepEqual([m.exam, m.subject, m.grade, m.part, m.selection], ['kice', 'english', 3, 'question', null]);
  assert.equal(identifyExam({ filename: '2024학년도 수능 국어 문제지.pdf', text: '본문 풀이 가형' }).selection, null);
});

test('내부 글꼴 키 무시와 실제 글꼴명 조회, 한컴 구조 기호', () => {
  assert.equal(normalizeHancomText('\ue06d\ue06e\ue078\ue079\ue07a\ue07b\ue101', 'g_d0_f3'), '―→⎧⎨⎩⎪|');
  assert.equal(resolvePdfFontName({ commonObjs: { get: () => ({ name: 'HancomEQN' }) } }, 'g_d0_f3'), 'HancomEQN');
  assert.equal(resolvePdfFontName({ commonObjs: { get: () => { throw Error(); } } }, 'missing'), undefined);
});

// 실제 글·답 대신 번호에 따른 가짜 답. 행 우선 내용 순서와 다단 배치만 재현.
for (const [subject, label, columns, size] of [
  ['korean', '국어', [null, null, '화법과작문', '언어와매체'], [17, 17, 11, 11]],
  ['math', '수학', [null, null, '확률과통계', '미적분', '기하'], [11, 11, 8, 8, 8]],
  ['english', '영어', [null, null, null, null], [12, 12, 12, 9]],
]) test(`가짜 다단 정답표 ${subject}: 공통·선택·배점`, () => {
  const items = [];
  const add = (str, x, y) => items.push({ str, transform: [1, 0, 0, 1, x, y], hasEOL: false });
  add(`2024학년도 대학수학능력시험 6월 모의평가 ${label} 영역 정답표`, 0, 800);
  columns.forEach((sel, c) => {
    if (sel) add(sel, 10 + c * 100, 740);
    add('문항', c * 100, 700); add('번호', c * 100, 690);
    add('정 답', c * 100 + 30, 695); add('배 점', c * 100 + 60, 695);
  });
  for (let r = 0; r < Math.max(...size); r++) columns.forEach((sel, c) => {
    if (r >= size[c]) return;
    const start = sel ? subject === 'korean' ? 35 : 23 : c * size[0] + 1;
    add(String(start + r), c * 100 + 5, 660 - r * 20);
    add('①②③④⑤'[(r + c) % 5], c * 100 + 35, 660 - r * 20);
    add(String(2 + r % 2), c * 100 + 65, 660 - r * 20);
  });
  const result = parseAnswerKey(items);
  assert.deepEqual(result.warnings, []);
  assert.equal(Object.keys(result.answers[subject]).length, subject === 'korean' ? 34 : subject === 'math' ? 22 : 45);
  columns.forEach((sel, c) => {
    if (sel) assert.equal(Object.keys(result.answers[`${subject}|${sel}`]).length, size[c]);
    const number = sel ? subject === 'korean' ? 35 : 23 : c * size[0] + 1;
    for (let r = 0; r < size[c]; r++) {
      assert.deepEqual(result.answers[sel ? `${subject}|${sel}` : subject][number + r], {
        answer: String((r + c) % 5 + 1), points: 2 + r % 2,
      });
    }
    // PDF 내용 순서가 뒤집혀도 좌표 있는 표의 값은 같다.
  });
  assert.deepEqual(parseAnswerKey([...items].reverse()), result);
});

test('좌표 없는 교육청 통합 items는 내용 순서 경로 유지', () => {
  const text = '국어 영역 번호 정 답 배 점\n1 ⑤ 3\n수학 영역 번호 정답 배점\n22 123 4\n영어 영역 번호 정답 배점\n45 ② 2';
  const expected = parseAnswerKey(text);
  assert.deepEqual(parseAnswerKey(text.split('\n').map((str) => ({ str, hasEOL: true }))), expected);
  assert.deepEqual(expected.answers.math[22], { answer: '123', points: 4 });
  assert.deepEqual(expected.warnings, []);
});

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

test('옛 점 번호와 계열별 정답, 해설 본문의 숫자는 제외', () => {
  const r=parseAnswerKey('수리 영역 [인문계 정답] 1. ③ 2. ② 3. ① 해설 1. ④ 2. ⑤ [자연계 정답] 1. ⑤ 2. ④');
  assert.equal(r.answers['math|인문계'][1].answer,'3');
  assert.equal(r.answers['math|자연계'][1].answer,'5');
});

test('해설 본문 숫자는 정답 아님, 예·체능계 정답 제목은 인식', () => {
  assert.deepEqual(parseAnswerKey('가짜 풀이 3 5 4 2',{subject:'math',selection:'예체능',tablesOnly:true}).answers,{});
  const r=parseAnswerKey('수리 영역 [예·체능계 정답] 1. ① 2. ② 3. ③ 해설 3 5',{subject:'math',tablesOnly:true});
  assert.equal(Object.keys(r.answers['math|예체능']).length,3);
});

test('가형 표 안의 옛 세부 과목 머리글은 같은 형의 정답으로 유지', () => {
  const r=parseAnswerKey('수리 영역 가형 정답 1 ① 2 ② 3 ③ 미적분과 통계 26 ④ 27 ⑤',{subject:'math',selection:'가형',tablesOnly:true});
  assert.equal(r.answers['math|가형'][26].answer,'4');
  assert.equal(r.answers['math|미적분'],undefined);
});
