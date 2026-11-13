import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { parseExamBatch, makeSummary } = createRequire(import.meta.url)('../../src/main/exam-batch.js');
const args = ['--exam-batch', tmpdir(), '--exam-out', join(tmpdir(), '..', 'batch-output')];
test('소스 실행과 입력 폴더 검사', () => {
  assert.equal(parseExamBatch(args, true), null);
  assert.equal(parseExamBatch([]), null);
  assert.equal(parseExamBatch(args).threads, 2);
  assert.throws(() => parseExamBatch(['--exam-batch', join(tmpdir(), 'missing-batch-input')]));
  assert.throws(() => parseExamBatch(['--exam-batch', tmpdir()]));
  assert.throws(() => parseExamBatch([...args, '--exam-batch', tmpdir()]));
});
test('스레드 범위 검사', () => {
  for (const n of ['0','9','1.5','NaN','-1','']) assert.throws(() => parseExamBatch([...args, '--exam-threads', n]));
  for (const n of ['1','2','8']) assert.equal(parseExamBatch([...args, '--exam-threads', n]).threads, +n);
});
test('요약에서 원문 제외', () => {
  const s = makeSummary({ rows: [{ name: '시험', done: true, bookId: 'id', result: { items: 3, answers: 2, low: 1, seconds: 4 }, files: [{ text: 'PRIVATE_PDF_TEXT' }] }, { name: '시험', reason: '짝수형' }, { name: '시험', error: '저장 실패' }], skipped: ['지원 외'] }, { version: '1', commit: 'abc', startedAt: 'now' });
  assert.equal(s.exams[0].items, 3); assert.equal(s.skipped.length, 2);
  assert.equal(s.errors.length, 1); assert.ok(!JSON.stringify(s).includes('PRIVATE_PDF_TEXT'));
});

test('완료 시험 체크포인트는 다음 시험 실패 뒤에도 책과 요약 유지', async () => {
  const fs = await import('node:fs/promises');
  const { createExamWriter } = createRequire(import.meta.url)('../../src/main/exam-batch.js');
  const tmp = await fs.mkdtemp(join(tmpdir(), 'exam-checkpoint-'));
  try {
    const source = join(tmp, 'source'); await fs.mkdir(source);
    await fs.writeFile(join(source, 'book.json'), '{"synthetic":true}');
    const output = join(tmp, 'output');
    const writer = createExamWriter(output, { version: 'test' }, () => source);
    const good = { name: '합성 시험', bookId: 'synthetic', done: true, result: { items: 3, answers: 3, low: 0 } };
    await writer({ rows: [good] }, true);
    assert.equal(JSON.parse(await fs.readFile(join(output, 'summary.json'))).partial, true);
    await writer({ rows: [good, { name: '실패 시험', error: '합성 실패' }] }, false);
    assert.equal(JSON.parse(await fs.readFile(join(output, 'books', 'synthetic', 'book.json'))).synthetic, true);
    const summary = JSON.parse(await fs.readFile(join(output, 'summary.json')));
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.partial, false);
    assert.equal(summary.exams[0].answers, 3);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
