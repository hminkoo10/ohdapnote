import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { planExamImport, examBookName, examImportItems, examAnswerFiles } from '../../src/renderer/js/mockexam-plan.js';
import { identifyExam, examForm } from '../../src/renderer/js/mockexam.js';
const { readExamZip } = createRequire(import.meta.url)('../../src/main/mockexam-files.js');
const f = (name, sha256 = name) => ({ filename: name, path: name, sha256 });

test('과목 미확인 공통 정답 합본은 같은 시험에만 연결', () => {
  const files = ['2006년 3월 고1 학평 국어 문제.pdf','2006년 3월 고1 학평 수학 문제.pdf','2006년 3월 고1 학평 공통 정답.pdf','2006년 6월 고1 학평 공통 정답.pdf'].map(n=>({...f(n),metadata:identifyExam(f(n))}));
  const plan=planExamImport(files,[],['korean','math']);
  assert.equal(plan.rows.length,2);
  assert.ok(plan.rows.every(r=>r.files.some(f=>f.filename===files[2].filename)));
  assert.ok(plan.rows.every(r=>!r.files.some(f=>f.filename===files[3].filename)));
});
test('시험 이름은 학평 시행연도와 수능·모평 학년도를 구별', () => {
  for (const [file, name] of [['2024학년도 수능 수학 문제지.pdf', '2024학년도 수능 수학'], ['2024학년도 6월 모평 수학 문제지.pdf', '2024학년도 6월 모평 수학'], ['2023년 3월 고1 학평 수학 문제지.pdf', '2023년 3월 고1 학평 수학']]) assert.equal(examBookName(identifyExam({ filename: file })), name);
});
test('계약·기존 키·기존 해시·짝수형 제외와 공통 정답표 연결', () => {
  const files = ['홀수형 문제지', '짝수형 문제지', '정답', '해설'].map((part) => f(`2024학년도 수능 수학 ${part}.pdf`));
  const p = planExamImport(files);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows.find((r) => r.metadata.form === '짝').reason, '짝수형');
  assert.equal(p.rows.find((r) => r.metadata.form === '홀').files.length, 3);
  assert.equal(planExamImport(files, [], ['english']).rows[0].reason, '계약 밖');
  const m = identifyExam(files[0]);
  assert.equal(planExamImport(files, [{ subject: 'math', exam: m }]).rows[0].reason, '이미 있음');
  assert.equal(planExamImport(files, [{ subject: 'math', exam: { source: { sha256: files[0].sha256 } } }]).rows[0].reason, '이미 있음');
  assert.equal(planExamImport([f('이름 모름.pdf')]).skipped.length, 1);
});
test('ZIP 중앙 목록 CP949 이름과 저장 방식 읽기, 잘린 ZIP 거부', () => {
  const name = Buffer.concat([Buffer.from('bcf6c7d0', 'hex'), Buffer.from('.pdf')]);
  const data = Buffer.from('fake pdf');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 10); end.writeUInt32LE(local.length + name.length + data.length, 16);
  const zip = Buffer.concat([local, name, data, central, name, end]);
  const entries = readExamZip(zip);
  assert.equal(entries[0].name, '수학.pdf'); assert.deepEqual(entries[0].data, data);
  assert.throws(() => readExamZip(zip.subarray(0, zip.length - 2)));
});

test('옛 수학 계열 문제지는 한 책으로 합치지 않음', () => {
  const files = ['인문계', '자연계', '예체능'].map((v) => f(`2002년 6월 고2 학력평가 수학 문제(${v}).pdf`));
  const p = planExamImport(files);
  assert.equal(p.rows.length, 3);
  assert.deepEqual(p.rows.map((r) => r.metadata.selection), ['인문계', '자연계', '예체능']);
  assert.ok(p.rows.every((r) => r.files.length === 1));
});

test('한 PDF의 홀짝 합본도 홀수형만 등록, 짝수형 단독은 보존', () => {
  const odd = { id: 'odd', examSection: { form: '홀' } };
  const even = { id: 'even', examSection: { form: '짝' } };
  const common = { id: 'common' };
  assert.deepEqual(examImportItems([common, odd, even]), [common, odd]);
  assert.deepEqual(examImportItems([even]), [even]);
});

test('괄호로 감싼 정답표 홀짝 머리글 식별', () => {
  assert.equal(examForm('국어 영역 정답표 ( 홀수 ) 형'), '홀');
  assert.equal(examForm('수학 영역 정답표 ( 짝수 ) 형'), '짝');
});

test('해시 이름의 영문 해설도 역할 식별', () => {
  assert.equal(identifyExam({filename:'explanation-0123456789.pdf'}).part,'solution');
  assert.equal(identifyExam({filename:'explanation-0123456789.pdf',path:'2014년 3월 고2 학평/수학A/explanation-0123456789.pdf'}).selection,'A형');
});

test('과목 해설이 있으면 전 과목 합본을 답지에 중복 첨부하지 않음', () => {
  const specific={metadata:{part:'solution',subject:'math'}};
  const common={metadata:{part:'solution',subject:null}};
  assert.deepEqual(examAnswerFiles([specific,common],'math'),[specific]);
  assert.deepEqual(examAnswerFiles([common],'math'),[common]);
});
