import { _electron as electron, chromium } from '../lib/playwright.mjs';
import { fakeCloud } from '../lib/fake-cloud.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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
    win.on('console', (m) => { if (m.text().startsWith('MEASURE ') || m.type() === 'warning') console.log(m.text()); });
    const archive = process.env.MOCKEXAM_ARCHIVE;
    const entries = readFileSync(join(archive, 'files.jsonl'), 'utf8').trim().split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const sets = new Map();
    for (const e of entries) {
      if (!/question-/i.test(e.file) || !existsSync(join(archive, e.file))) continue;
      const key = `${e.page}:${e.subject}`;
      if (!sets.has(key)) sets.set(key, e);
    }
    const picked = [];
    for (const year of [2002,2004,2006,2008,2011]) for (const subject of ['국어','수학','영어']) {
      const candidates = [...sets.values()].filter((e) => e.year === year && e.subject === subject);
      const wanted = candidates.find((e) => e.file.includes(`고${1 + ([2002,2004,2006,2008,2011].indexOf(year) + ['국어','수학','영어'].indexOf(subject)) % 3}`)) || candidates[0];
      if (wanted) picked.push(wanted);
    }
    const paths = [...new Set((process.env.MOCKEXAM_MEASURE_CSAT ? picked.filter((e) => e.year === 2002 && e.subject === '영어') : picked).flatMap((e) => entries.filter((a) => a.page === e.page && a.subject === e.subject && (!/question-/i.test(a.file) || a.file === e.file) && existsSync(join(archive, a.file))).map((a) => join(archive, a.file))))];
    paths.push(...readdirSync(process.env.MOCKEXAM_HDREAM).filter((n) => /\.pdf$/i.test(n) && (!process.env.MOCKEXAM_MEASURE_CSAT || n.includes('수능') || n.includes('6월') && n.includes('국어'))).map((n) => join(process.env.MOCKEXAM_HDREAM,n)));
    if (process.env.MOCKEXAM_ONLY_FAILED) {
      const previous = JSON.parse(readFileSync(join(shots, 'measurement-csat.json'), 'utf8'));
      await win.evaluate((names) => { globalThis.retryExamNames = names; }, previous.filter((r) => r.error).map((r) => r.name));
    }
    const result = await win.evaluate(async (paths) => {
      const m = await import('./js/mockexam-import.js');
      const plan = await m.inspectExamFolder(paths);
      if (globalThis.retryExamNames) plan.rows = plan.rows.filter((r) => globalThis.retryExamNames.includes(r.name));
      console.log('MEASURE plan ' + plan.rows.length + ' skipped ' + plan.skipped.length);
      const q = await m.importExamFolder(paths, { plan, onProgress: (p) => { if (p.phase === 'exam') console.log('MEASURE ' + p.name); } });
      return q.rows.map((r) => ({ name: r.name, reason: r.reason, result: r.result, error: r.error }));
    }, paths);
    const out = join(process.env.MOCKEXAM_SHOTS, process.env.MOCKEXAM_ONLY_FAILED ? 'measurement-retry.json' : process.env.MOCKEXAM_MEASURE_CSAT ? 'measurement-csat.json' : 'measurement.json');
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
    await pdf('2024학년도 수능 수학 정답.pdf', '<h1>수학 영역 정답 (홀수) 형</h1><p>번호 정답 배점</p><p>1 2 3</p><p>2 3 3</p><p>3 4 3</p><h1>미적분</h1><p>번호 정답 배점</p><p>23 1 3</p><p>24 2 3</p><div style="break-before:page"><h1>수학 영역 정답 (짝수) 형</h1><p>번호 정답 배점</p><p>1 5 3</p><p>2 5 3</p><p>3 5 3</p><h1>미적분</h1><p>번호 정답 배점</p><p>23 5 3</p><p>24 5 3</p></div>');
    await pdf('2024학년도 수능 수학 해설.pdf', '<header>가짜 해설입니다.</header><section>1. 두 수를 더하면 돼요. 설명을 읽고 확인하세요.</section>');
    await pdf('2023년 3월 고1 학평 수학 문제지.pdf', `<header>2023년 3월 고1 전국연합학력평가 수학</header>${[1,2,3].map((n) => `<section>${n}. 두 수의 합을 구하세요. [3점]<p>① 1　② 2　③ 3　④ 4　⑤ 5</p></section>`).join('')}`);
    await p.setContent('<style>body{font:48px monospace;line-height:2;background:white;padding:30px}</style><pre>1       2<br>2       3<br>3       4</pre>');
    await p.screenshot({ path: join(input, '2023년 3월 고1 학평 수학 정답.png') });
    writeFileSync(join(input, '건너뛸 파일.txt'), 'fake');
  } finally { await browser.close(); }
  await launch();
  await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, input);
  await win.getByRole('button', { name: '모의고사 넣기', exact: true }).click();
  await win.getByRole('button', { name: '폴더 고르기', exact: true }).click();
  await win.waitForSelector('.mockexam-table tbody tr');
  assert.match(await win.textContent('.mockexam-table'), /2024학년도 수능 수학/);
  assert.equal(await win.locator('.mockexam-table td:has-text("✓")').count(), 5);
  await win.evaluate(() => { const tb = document.querySelector('.mockexam-table tbody'); for(let i=0;i<200;i++) tb.append(tb.firstElementChild.cloneNode(true)); });
  assert.ok(await win.locator('.mockexam-table').evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'));
  await win.evaluate(() => { const tb = document.querySelector('.mockexam-table tbody'); while(tb.children.length > 2) tb.lastElementChild.remove(); });
  if (shots) await win.screenshot({ path: join(shots, 'import.png') });
  await win.getByRole('button', { name: '넣기 시작', exact: true }).click();
  if (shots) await win.screenshot({ path: join(shots, 'progress.png') });
  await win.waitForFunction(() => JSON.parse(localStorage.getItem('ohdap.examImport'))?.rows.some((r) => r.bookId), { timeout: 60000 });
  // 파일·책 ID 저장 직후 강제 종료: 미완료 시험부터 재개해야 한다.
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); app = null;
  await launch();
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('books:saveTranscripts');
    let failed = false;
    ipcMain.removeHandler('books:saveTranscripts');
    ipcMain.handle('books:saveTranscripts', (...args) => {
      if (!failed) { failed = true; globalThis.examSaveFailureInjected = true; throw Error('EPERM: 시험용 일시적 파일 잠금'); }
      return original(...args);
    });
  });
  await win.getByRole('button', { name: '모의고사 넣기', exact: true }).click();
  await win.getByRole('button', { name: '이어서 넣기', exact: true }).click();
  await win.waitForFunction(() => JSON.parse(localStorage.getItem('ohdap.examImport'))?.rows.every((r) => r.done || r.reason || r.error), { timeout: 180000 });
  const q = await win.evaluate(() => JSON.parse(localStorage.getItem('ohdap.examImport')));
  console.log(JSON.stringify(q.rows.map((r) => ({ name: r.name, result: r.result, error: r.error }))));
  assert.equal(q.rows[0].error, undefined);
  assert.equal(q.rows.find((r) => r.metadata.exam === 'csat').result.items, 5);
  assert.equal(q.rows.find((r) => r.metadata.exam === 'csat').result.answers, 5);
  const scanRow = q.rows.find((r) => r.metadata.exam === 'edu');
  assert.equal(scanRow.result.answers, 3);
  const scanAnswers = await win.evaluate((id) => window.ohdap.getAnswers(id), scanRow.bookId);
  assert.ok(Object.values(scanAnswers.items).every((a) => a.blocks[0].low?.length));
  assert.equal((await win.evaluate(() => window.ohdap.listBooks())).length, 2);
  await win.locator('.modal-footer .btn-primary').click();
  await win.locator('[data-bank-focus="exam"]').selectOption('csat');
  await win.waitForSelector('.bank-row');
  assert.equal(await win.locator('.bank-row').count(), 5);
  assert.match(await win.locator('.bank-list').innerText(), /2024학년도 수능 수학 미적분.*23번/);
  if (shots) {
    await win.screenshot({ path: join(shots, 'bank-filter.png') });
    await win.locator('.bank-row').first().scrollIntoViewIfNeeded();
    await win.screenshot({ path: join(shots, 'bank-items.png') });
  }
  const answers = await win.evaluate((id) => window.ohdap.getAnswers(id), q.rows.find((r) => r.metadata.exam === 'csat').bookId);
  assert.equal(Object.keys(answers.items).length, 5);
  assert.ok(Object.values(answers.items).every((a) => a.answer !== '5'));
  assert.equal(await app.evaluate(() => globalThis.examSaveFailureInjected), true);
  console.log('mockexam-e2e PASS');
  }
} finally {
  await app?.close(); cloud.stop();
  assert.ok(resolve(tmp).startsWith('C:\\temp\\gcc-tmp\\ohdap-mockexam-'));
  const { execFileSync } = await import('node:child_process');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:MOCKEXAM_CLEANUP, 'OnlyErrorDialogs', 'SendToRecycleBin')"], { env: { ...process.env, MOCKEXAM_CLEANUP: tmp } });
}
