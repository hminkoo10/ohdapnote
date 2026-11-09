import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { planExamImport, examBookName } from '../../src/renderer/js/mockexam-plan.js';
import { identifyExam } from '../../src/renderer/js/mockexam.js';
const { readExamZip } = createRequire(import.meta.url)('../../src/main/mockexam-files.js');
const f = (name, sha256 = name) => ({ filename: name, path: name, sha256 });
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
