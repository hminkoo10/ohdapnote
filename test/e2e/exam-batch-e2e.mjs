import { _electron as electron } from '../lib/playwright.mjs';
import { fileURLToPath } from 'node:url';
import { makeMockExamFixtures } from '../lib/mockexam-fixtures.mjs';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, setPriority, constants } from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'ohdap-exam-batch-'));
const input = join(tmp, 'input'), output = join(tmp, 'output'), user = join(tmp, 'user');
mkdirSync(input);
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
async function run(args, expected = 0, extra = {}) {
  const env = { ...process.env, OHDAP_E2E: '', OHDAP_USER_DATA: user, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), ['.', ...args], { cwd: root, windowsHide: true,
    env });
  child.once('spawn', () => setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL));
  let stdout = '', stderr = '';
  child.stdout.on('data', (b) => { stdout += b; }); child.stderr.on('data', (b) => { stderr += b; });
  const timer = setTimeout(() => child.kill(), 240000);
  const code = await new Promise((ok, fail) => { child.once('error', fail); child.once('exit', ok); });
  clearTimeout(timer);
  const events = stdout.split(/\r?\n/).filter((s) => s.startsWith('{')).map((s) => JSON.parse(s));
  assert.equal(code, expected, JSON.stringify({ code, events, stderr: stderr.slice(-1500) }));
  return events;
}
try {
  const bad = await run(['--exam-batch', join(tmp, 'missing'), '--exam-out', output], 2);
  assert.equal(bad.at(-1).event, 'fatal');
  await makeMockExamFixtures(input);
  const args = ['--exam-batch', input, '--exam-out', output, '--exam-threads', '2'];
  const first = await run(args);
  assert.equal(first.filter((e) => e.event === 'exam-start').length, 2);
  const summary = JSON.parse(readFileSync(join(output, 'summary.json')));
  assert.equal(summary.errors.length, 0); assert.equal(summary.exams.length, 2);
  assert.ok(summary.exams.every((r) => r.done));
  assert.equal(summary.exams.find((r) => r.name.includes('수능')).items, 5);
  assert.equal(summary.exams.find((r) => r.name.includes('수능')).answers, 5);
  const before = summary.exams.map((r) => readFileSync(join(output, 'books', r.bookId, 'book.json'), 'utf8'));
  for (const row of summary.exams) {
    const dir = join(output, 'books', row.bookId);
    assert.ok(existsSync(join(dir, 'transcripts.json'))); assert.ok(existsSync(join(dir, 'answers.json')));
    assert.ok(readdirSync(dir).length > 3);
  }
  const second = await run(args);
  assert.equal(second.filter((e) => e.event === 'exam-start').length, 0);
  const again = JSON.parse(readFileSync(join(output, 'summary.json')));
  assert.deepEqual(again.exams, summary.exams);
  assert.deepEqual(again.exams.map((r) => readFileSync(join(output, 'books', r.bookId, 'book.json'), 'utf8')), before);
  const invalid = join(tmp, 'invalid'); mkdirSync(invalid);
  writeFileSync(join(invalid, '2022학년도 수능 수학 문제.pdf'), 'not a PDF');
  const failed = await run(['--exam-batch', invalid, '--exam-out', output], 1);
  assert.equal(failed.at(-1).code, 1);
  assert.equal(JSON.parse(readFileSync(join(output, 'summary.json'))).errors.length, 1);
  const crashEnv = { ...process.env, OHDAP_USER_DATA: join(tmp, 'crash-user'), OHDAP_E2E: '' };
  delete crashEnv.ELECTRON_RUN_AS_NODE;
  const crashApp = await electron.launch({ executablePath: require('electron'), args: ['.', ...args], cwd: root, env: crashEnv });
  const crashCode = new Promise((ok) => crashApp.process().once('exit', ok));
  await crashApp.firstWindow();
  await crashApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()).catch(() => {});
  assert.equal(await crashCode, 2);
  console.log('exam-batch-e2e PASS (codes 0/1/2, renderer crash, 2 exams, resume unchanged)');
} finally {
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { console.log('남은 임시 폴더:', tmp); }
}
