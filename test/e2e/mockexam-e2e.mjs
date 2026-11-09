import { _electron as electron, chromium } from '../lib/playwright.mjs';
import { fakeCloud } from '../lib/fake-cloud.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setPriority, constants } from 'node:os';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const tmp = mkdtempSync('C:/temp/gcc-tmp/ohdap-mockexam-');
const userData = join(tmp, 'user'), academy = join(tmp, 'academy');
mkdirSync(userData); const input = join(tmp, 'input'); mkdirSync(input);
const shots = process.env.MOCKEXAM_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const cloud = fakeCloud({ dir: join(tmp, 'cloud'), academyDir: academy, subjects: ['math', 'english', 'korean'], members: [{ id: 'teacher-a', name: '선생님', role: 'teacher' }] });
let app, win;
const launch = async () => {
  app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--renderer-process-limit=2', ROOT], env: { ...process.env, OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', OHDAP_E2E: '1', OHDAP_USER_DATA: userData, MAGOEDU_DEV: '1', MAGOEDU_ACADEMY: '테스트학원', MAGOEDU_ACADEMY_DIR: academy, MAGOEDU_DATA_DIR: join(tmp, 'data'), MAGOEDU_LOCAL_DIR: userData, MAGOEDU_USER_ID: 'teacher-a', MAGOEDU_USER_NAME: '선생님', MAGOEDU_ROLE: 'teacher', ...cloud.env } });
  win = await app.firstWindow();
  await win.waitForSelector('.seg-tab[data-tab="bank"]', { timeout: 30000 });
  await win.evaluate(() => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 }));
  await win.click('.seg-tab[data-tab="bank"]');
};
try {
  if (process.env.MOCKEXAM_MEASURE) {
    await launch();
    win.on('console', (m) => { if (m.text().startsWith('MEASURE ')) console.log(m.text()); });
    const archive = process.env.MOCKEXAM_ARCHIVE;
    const entries = readFileSync(join(archive, 'files.jsonl'), 'utf8').trim().split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const sets = new Map();
    for (const e of entries) {
      if (!/question-/i.test(e.file) || !existsSync(join(archive, e.file))) continue;
      const key = `${e.page}:${e.subject}`;
      if (!sets.has(key)) sets.set(key, e);
    }
    const picked = [];
    for (const year of [2002,2003,2004,2005,2006]) for (const subject of ['??','??','??']) {
      const candidates = [...sets.values()].filter((e) => e.year === year && e.subject === subject);
      const wanted = candidates.find((e) => e.file.includes(`?${1 + (year + ['??','??','??'].indexOf(subject)) % 3}`)) || candidates[0];
      if (wanted) picked.push(wanted);
    }
    const paths = [...new Set(picked.flatMap((e) => entries.filter((a) => a.page === e.page && a.subject === e.subject && existsSync(join(archive, a.file))).map((a) => join(archive, a.file))))];
    paths.push(...readdirSync(process.env.MOCKEXAM_HDREAM).filter((n) => /\.pdf$/i.test(n)).map((n) => join(process.env.MOCKEXAM_HDREAM,n)));
    const result = await win.evaluate(async (paths) => {
      const m = await import('./js/mockexam-import.js');
      const plan = await m.inspectExamFolder(paths);
      console.log('MEASURE plan ' + plan.rows.length + ' skipped ' + plan.skipped.length);
      const q = await m.importExamFolder(paths, { plan, onProgress: (p) => { if (p.phase === 'exam') console.log('MEASURE ' + p.name); } });
      return q.rows.map((r) => ({ name: r.name, reason: r.reason, result: r.result, error: r.error }));
    }, paths);
    const out = join(process.env.MOCKEXAM_SHOTS, 'measurement.json');
    writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } else {
  const browser = await chromium.launch({ headless: true });
  try {
    const p = await browser.newPage();
    const pdf = async (name, body) => {
      await p.setContent(`<style>@page{size:A4;margin:15mm}body{font:14px 'Malgun Gothic'}header{height:100px}section{height:150px}h1{font-size:16px}</style>${body}`);
      await p.pdf({ path: join(input, name), printBackground: true });
    };
    await pdf('2024학년도 수능 수학 홀수형 문제지.pdf', `<header>2024학년도 대학수학능력시험 수학 영역 홀수형</header>${[1,2,3].map((n) => `<section>${n}. 가짜 문항입니다. 두 수의 합을 구하세요. [3점]<p>① 1　② 2　③ 3　④ 4　⑤ 5</p></section>`).join('')}<div style="break-before:page"><header>2024학년도 대학수학능력시험 수학 영역 (미적분) 홀수형</header>${[23,24].map((n) => `<section>${n}. 가짜 선택 문항입니다. 식의 값을 구하세요. [3점]<p>① 1　② 2　③ 3　④ 4　⑤ 5</p></section>`).join('')}</div>`);
    await pdf('2024학년도 수능 수학 정답.pdf', '<h1>수학 영역 정답</h1><p>번호 정답 배점</p><p>1 2 3</p><p>2 3 3</p><p>3 4 3</p><h1>미적분</h1><p>번호 정답 배점</p><p>23 1 3</p><p>24 2 3</p>');
    await pdf('2024학년도 수능 수학 해설.pdf', '<header>가짜 해설입니다.</header><section>1. 두 수를 더하면 돼요. 설명을 읽고 확인하세요.</section>');
    writeFileSync(join(input, '건너뛸 파일.txt'), 'fake');
  } finally { await browser.close(); }
  await launch();
  await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, input);
  await win.getByRole('button', { name: '모의고사 넣기', exact: true }).click();
  await win.getByRole('button', { name: '폴더 고르기', exact: true }).click();
  await win.waitForSelector('.mockexam-table tbody tr');
  assert.match(await win.textContent('.mockexam-table'), /2024학년도 수능 수학/);
  assert.equal(await win.locator('.mockexam-table td:has-text("✓")').count(), 3);
  if (shots) await win.screenshot({ path: join(shots, 'import.png') });
  await win.getByRole('button', { name: '넣기 시작', exact: true }).click();
  if (shots) await win.screenshot({ path: join(shots, 'progress.png') });
  await win.waitForFunction(() => JSON.parse(localStorage.getItem('ohdap.examImport'))?.rows.some((r) => r.bookId), { timeout: 60000 });
  // 파일·책 ID 저장 직후 강제 종료: 미완료 시험부터 재개해야 한다.
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); app = null;
  await launch();
  await win.getByRole('button', { name: '모의고사 넣기', exact: true }).click();
  await win.getByRole('button', { name: '이어서 넣기', exact: true }).click();
  await win.waitForFunction(() => JSON.parse(localStorage.getItem('ohdap.examImport'))?.rows.every((r) => r.done || r.reason || r.error), { timeout: 180000 });
  const q = await win.evaluate(() => JSON.parse(localStorage.getItem('ohdap.examImport')));
  console.log(JSON.stringify(q.rows.map((r) => ({ name: r.name, result: r.result, error: r.error }))));
  assert.equal(q.rows[0].error, undefined);
  assert.equal(q.rows[0].result.items, 5);
  assert.equal(q.rows[0].result.answers, 5);
  assert.equal((await win.evaluate(() => window.ohdap.listBooks())).length, 1);
  await win.locator('.modal-footer .btn-primary').click();
  await win.locator('[data-bank-focus="exam"]').selectOption('csat');
  await win.waitForSelector('.bank-row');
  assert.equal(await win.locator('.bank-row').count(), 5);
  if (shots) await win.screenshot({ path: join(shots, 'bank-filter.png') });
  const answers = await win.evaluate((id) => window.ohdap.getAnswers(id), q.rows[0].bookId);
  assert.equal(Object.keys(answers.items).length, 5);
  console.log('mockexam-e2e PASS');
  }
} finally {
  await app?.close(); cloud.stop();
  assert.ok(resolve(tmp).startsWith('C:\\temp\\gcc-tmp\\ohdap-mockexam-'));
  rmSync(tmp, { recursive: true, force: true });
}
