import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifyExam } from '../../src/renderer/js/mockexam.js';
import { parseAnswerKey } from '../../src/renderer/js/mockexam-answers.js';
import { planExamImport } from '../../src/renderer/js/mockexam-plan.js';
const file = (folder, part, text = '') => ({ filename: `${part}-synthetic.pdf`, path: `input/2028/05/${folder}/${part}-synthetic.pdf`, text });
test('선택 폴더는 과목·선택·시행월을 모든 역할에서 공유', () => {
  const files = ['기하','미적분','확률과_통계','화법과_작문','언어와_매체'].flatMap(sel =>
    ['question','answer','explanation'].map(part => file(`고3_4월_학평(교육청)_${sel}`, part,
      part === 'question' ? `2028년 5월 고3 전국연합학력평가 ${/기하|미적분|확률/.test(sel) ? '수학' : '국어'}` : '')));
  const p = planExamImport(files, [], ['math','korean']);
  assert.equal(p.rows.length, 5);
  assert.ok(p.rows.every(r => r.files.length === 3 && r.metadata.month === 5));
  assert.equal(new Set(p.rows.map(r => r.name)).size, 5);
  assert.ok(p.rows.some(r => r.name.endsWith('수학(미적분)')));
  assert.equal(p.skipped.length, 0);
});

test('현행 평가원 선택 폴더는 공통 머리글보다 구체적, 홀짝 분리', () => {
  const files = ['기하','미적분','확률과_통계'].flatMap(sel => ['홀','짝'].flatMap(form =>
    ['question','answer'].map(part => ({ filename: `${part}-synthetic.pdf`,
      path: `input/2028학년도_대학수학능력시험_${sel}_${form}수형/${part}-synthetic.pdf`,
      text: part === 'question' ? '2028학년도 대학수학능력시험 수학 확률과 통계 미적분 기하' : '' }))));
  const p = planExamImport(files);
  assert.equal(p.rows.length, 6);
  assert.equal(p.rows.filter(r => !r.reason).length, 3);
  assert.ok(p.rows.every(r => r.metadata.selection && r.files.length === 2));
});

test('날짜/학년 디렉터리와 새 역할 코드, ZIP 내부 문제 연결', () => {
  for (const grade of [1,2,3]) {
    const files = ['kor','math','eng'].flatMap(subject => ['mun','ans','hsj'].map(role => ({
      filename: `${subject}_main_${role}_synthetic.${role === 'ans' ? 'png' : 'pdf'}`,
      path: `input/20281020/go${grade}/${subject}_main_${role}_synthetic.${role === 'ans' ? 'png' : 'pdf'}` })));
    files[6] = { filename: '영어 문제.pdf', path: `input/20281020/go${grade}/eng_mun_synthetic.zip/영어 문제.pdf` };
    const p = planExamImport(files, [], ['math','korean','english']);
    assert.equal(p.rows.length, 3);
    assert.equal(p.skipped.length, 0);
    assert.ok(p.rows.every(r => r.files.length === 3 && r.metadata.year === 2028 && r.metadata.month === 10 && r.metadata.grade === grade));
  }
  assert.equal(identifyExam({filename:'kor_main_ans_synthetic.png'}).exam, null);
});

test('선택 해설의 35번/23번 시작 정답표는 읽고 뒤 풀이 숫자는 제외', () => {
  for (const [subject,selection,start] of [['korean','언어와매체',35],['korean','화법과작문',35],['math','미적분',23]]) {
    const table=Array.from({length:subject==='korean'?11:8},(_,i)=>`${start+i} ${'①②③④⑤'[i%5]}`).join(' ');
    const p=parseAnswerKey(`${selection} 정답 ${table} 해 설 ${start} ⑤`,{subject,selection,tablesOnly:true});
    assert.equal(Object.keys(p.answers[`${subject}|${selection}`]||{}).length,subject==='korean'?11:8);
    assert.equal(p.answers[`${subject}|${selection}`][start].answer,'1');
  }
});
