'use strict';
const fs = require('node:fs');
const path = require('node:path');
function parseExamBatch(argv, packaged = false) {
  if (packaged || !argv.includes('--exam-batch')) return null;
  const values = {};
  for (const flag of ['--exam-batch', '--exam-out', '--exam-threads']) {
    const indices = argv.flatMap((arg, i) => arg === flag ? [i] : []);
    if (indices.length > 1) throw Error(`${flag}: 중복 인자`);
    if (indices.length) {
      const value = argv[indices[0] + 1];
      if (!value || value.startsWith('--')) throw Error(`${flag}: 값이 필요해요.`);
      values[flag] = value;
    }
  }
  if (!values['--exam-out']) throw Error('--exam-out: 결과 폴더가 필요해요.');
  const input = path.resolve(values['--exam-batch']);
  if (!fs.existsSync(input) || !fs.statSync(input).isDirectory()) throw Error('입력 폴더가 없어요.');
  const threads = values['--exam-threads'] === undefined ? 2 : Number(values['--exam-threads']);
  if (!Number.isInteger(threads) || threads < 1 || threads > 8) throw Error('--exam-threads: 1~8 정수만 가능해요.');
  const output = path.resolve(values['--exam-out']);
  const inside = (a, b) => { const r = path.relative(a, b); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (inside(input, output) || inside(output, input)) throw Error('입력·결과 폴더는 서로 분리하세요.');
  return { input, output, threads };
}
function makeSummary(queue, meta) {
  const exams = (queue?.rows || []).map((r) => ({ name: r.name, bookId: r.bookId || null, done: !!r.done,
    items: r.result?.items || 0, answers: r.result?.answers || 0, low: r.result?.low || 0,
    seconds: r.result?.seconds || r.seconds || 0, reason: r.reason || null, error: r.error || null }));
  const skipped = [...exams.filter((r) => r.reason).map(({ name, reason }) => ({ name, reason })),
    ...(queue?.skipped || []).map((entry) => typeof entry === 'string' ? { path: entry, reason: '지원하지 않는 파일·시험 정보 미확인·연결할 문제지 없음' } : entry)];
  return { ...meta, finishedAt: new Date().toISOString(), exams, skipped,
    errors: exams.filter((r) => r.error).map(({ name, error }) => ({ name, error })) };
}
// 완료 시험은 다음 시험을 시작하기 전에 외부 결과에 확정한다.
function createExamWriter(output, meta, bookDir) {
  const copied = new Set();
  return async (queue, partial = true) => {
    const summary = { ...makeSummary(queue, meta), partial };
    await fs.promises.mkdir(output, { recursive: true });
    for (const row of summary.exams.filter(r => r.done && !copied.has(r.bookId))) {
      try {
        await fs.promises.cp(bookDir(row.bookId), path.join(output, 'books', row.bookId), { recursive: true });
        copied.add(row.bookId);
      } catch (err) { row.error = err.message; summary.errors.push({ name: row.name, error: err.message }); }
    }
    const temp = path.join(output, 'summary.json.tmp');
    await fs.promises.writeFile(temp, JSON.stringify(summary, null, 2) + '\n');
    await fs.promises.rename(temp, path.join(output, 'summary.json'));
    return summary;
  };
}
module.exports = { parseExamBatch, makeSummary, createExamWriter };
