import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
const { makeSummary } = createRequire(import.meta.url)('../../src/main/exam-batch.js');
const source = readFileSync(new URL('../../src/renderer/js/mockexam-import.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export async function importExamFolder')).replace('export ', '');
test('문자열 예외도 시험 오류로 기록하고 다음 시험 계속', async () => {
  const queue = { rows: ['실패 시험', '정상 시험'].map(name => ({ name, metadata: { subject: 'math' }, files: [{ filename: 'synthetic.pdf', metadata: { part: 'question' } }] })) };
  const events = [];
  const run = runInNewContext(`${body}; importExamFolder`, {
    running: false, restartGuard: { track: (_name, f) => f() }, save() {}, state: { appInfo: {} }, subjectOpen: () => true,
    api: { createBook: async name => { if (name === '실패 시험') throw '합성 문자열 오류'; return { id: 'synthetic', docs: { problem: { analyzedAt: 1, items: [{ id: 'q1', number: 1 }] } } }; }, saveBook: async () => {} },
    attach: async () => {}, examAnswerFiles: () => [], getSources: async () => ({}), dropSources() {},
    readAnswers: async () => ({ connected: 1, low: 0 }), transcribeExam: async () => 0,
  });
  await run(['synthetic'], { plan: queue, onProgress: e => events.push(e.phase) });
  assert.equal(queue.rows[0].error, '합성 문자열 오류');
  assert.equal(queue.rows[1].done, true);
  assert.equal(queue.rows[1].result.answers, 1);
  assert.equal(makeSummary(queue, {}).errors.length, 1);
  assert.equal(events.at(-1), 'finished');
});
