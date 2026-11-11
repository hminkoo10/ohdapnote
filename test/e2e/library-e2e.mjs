import { _electron as electron } from '../lib/playwright.mjs';
import { transcriptKey } from '../../src/renderer/js/transcript-store.js';
import { fakeCloud } from '../lib/fake-cloud.mjs';
import { makeMockExamFixtures } from '../lib/mockexam-fixtures.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tmp = mkdtempSync(join(process.env.OHDAP_USER_DATA || tmpdir(), 'ohdap-library-'));
const libraryDir = join(tmp, 'library'), source = join(tmp, 'source'), academy = join(tmp, 'academy');
const shots = process.env.LIBRARY_SHOTS;
for (const p of [libraryDir, source, academy, join(tmp, 'input'), ...(shots ? [shots] : [])]) mkdirSync(p, { recursive: true });
const id = (n) => `exam-${n.toString(16).padStart(16, '0')}`;
const seed = (n, subject = 'math') => {
  const book = { id: id(n), kind: 'book', version: 2, name: `합성 ${n} 모의고사`, subject, createdAt: 1, updatedAt: 1, exam: { exam: n === 1 ? 'csat' : 'edu', year: 2023, schoolYear: n === 1 ? 2024 : 2023, month: n === 1 ? 11 : 3, grade: 3 }, docs: { problem: { files: [{ name: 'problem-1.pdf', kind: 'pdf', originalName: 'synthetic.pdf' }], items: [{ id: 'q1', page: 0, number: '1', num: 1, rects: [{ page: 0, x: .05, y: .15, w: .9, h: .35 }] }], analyzedAt: 1 }, answer: null }, answerOverrides: {} };
  const dir = join(libraryDir, 'books', book.id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'book.json'), JSON.stringify(book));
  const key = transcriptKey({ role: 'problem', item: book.docs.problem.items[0], src: { files: book.docs.problem.files } });
  writeFileSync(join(dir, 'transcripts.json'), JSON.stringify({ version: 1, items: { [key + '|pdf']: { blocks: [{ type: 'para', text: '합성 공용 문항입니다.', low: [{ start: 0, end: 2 }] }], model: 'pdf', at: 1 } } }));
  writeFileSync(join(dir, 'answers.json'), '{"version":1,"items":{"q1":{"answer":"2","blocks":[]}}}');
  return book;
};
const cloud = fakeCloud({ dir: join(tmp, 'cloud'), academyDir: academy, libraryDir, librarySourceDir: source, subjects: ['math'], members: [{ id: 'teacher-a', name: '선생님', role: 'teacher' }] });
let app, win;
const call = (fn, ...args) => win.evaluate(([f, a]) => window.ohdap[f](...a), [fn, args]);
try {
  await makeMockExamFixtures(join(tmp, 'input'));
  const book = seed(1); seed(2); seed(3, 'english');
  mkdirSync(join(source, 'books', book.id), { recursive: true });
  copyFileSync(join(tmp, 'input', '2024학년도 수능 수학 홀수형 문제지.pdf'), join(source, 'books', book.id, 'problem-1.pdf'));
  app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--renderer-process-limit=2', ROOT], env: { ...process.env, OHDAP_E2E: '1', OHDAP_USER_DATA: join(tmp, 'user'), MAGOEDU_DEV: '1', MAGOEDU_ACADEMY: '합성학원', MAGOEDU_ACADEMY_DIR: academy, MAGOEDU_DATA_DIR: join(tmp, 'data'), MAGOEDU_LOCAL_DIR: join(tmp, 'local'), MAGOEDU_USER_ID: 'teacher-a', MAGOEDU_ROLE: 'teacher', ...cloud.env } });
  win = await app.firstWindow(); await win.setViewportSize({ width: 1280, height: 800 });
  await win.waitForSelector('.seg-tab[data-tab="bank"]');
  await app.evaluate(({ ipcMain }) => {
    globalThis.libraryReads = 0; globalThis.libraryFileReads = 0;
    for (const name of ['books:get', 'answers:get', 'books:getTranscripts']) {
      const old = ipcMain._invokeHandlers.get(name); ipcMain.removeHandler(name);
      ipcMain.handle(name, (...args) => { globalThis.libraryReads++; if (String(args[1]).startsWith('exam-')) globalThis.libraryFileReads++; return old(...args); });
    }
  });
  await win.click('.seg-tab[data-tab="bank"]'); await win.waitForSelector('.bank-filters');
  assert.equal(await win.locator('.bank-row').count(), 0);
  assert.match(await win.locator('.bank-list').innerText(), /시험 종류나 연도/);
  assert.equal(await app.evaluate(() => globalThis.libraryReads), 0);
  assert.equal((await call('listBooks')).length, 2);
  assert.equal(await win.locator('.bank-book').count(), 0);
  if (shots) { await win.locator('.bank-list').scrollIntoViewIfNeeded(); await win.screenshot({ path: join(shots, 'initial.png') }); }
  await win.locator('[data-bank-focus="exam"]').selectOption('csat');
  await win.locator('[data-bank-focus="year"]').fill('2024');
  await win.waitForSelector('.bank-row'); assert.equal(await win.locator('.bank-row').count(), 1);
  assert.equal(existsSync(join(libraryDir, 'books', book.id, 'problem-1.pdf')), false);
  if (shots) await win.screenshot({ path: join(shots, 'selected.png') });
  await win.locator('.bank-row input').check();
  await win.locator('.bank-row').click(); await win.waitForSelector('.bank-image').catch(async (err) => { console.log(await win.locator('.bank-preview').innerText()); throw err; });
  assert.ok(cloud.requests.some((r) => r.library === true && r.paths.includes(`books/${book.id}/problem-1.pdf`)));
  assert.equal(await win.getByRole('button', { name: '글 고치기', exact: true }).count(), 0);
  assert.equal(await win.getByRole('button', { name: '이 문항만 옮기기', exact: true }).count(), 0);
  assert.equal(await win.locator('.answer-open').count(), 0);
  assert.match(await win.locator('.bank-preview').innerText(), /합성 공용 문항/);
  if (shots) { await win.locator('.bank-preview').scrollIntoViewIfNeeded(); await win.screenshot({ path: join(shots, 'preview.png') }); }
  const exportPath = join(tmp, 'synthetic-output.pdf');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exportPath);
  await win.getByRole('button', { name: '문제지', exact: true }).click();
  await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((e) => e.textContent.includes('저장 완료')), { timeout: 60000 });
  assert.equal(readFileSync(exportPath).subarray(0, 4).toString(), '%PDF');
  for (const [name, args] of [['books:save', [book]], ['books:delete', [book.id]], ['books:setShared', [{ id: book.id, shared: false }]], ['books:renameItems', [{ bookId: book.id, renames: {} }]], ['books:saveTranscripts', [{ bookId: book.id, data: { items: {} } }]], ['answers:save', [{ bookId: book.id, itemId: 'q1', data: { answer: '3', blocks: [] } }]], ['answers:putImage', [{ bookId: book.id }]]]) {
    const message = await app.evaluate(async ({ ipcMain }, [name, args]) => { try { await ipcMain._invokeHandlers.get(name)({}, ...args); return 'allowed'; } catch (err) { return err.message; } }, [name, args]);
    assert.match(message, /마고 공용 책장/, name);
  }
  await win.getByRole('button', { name: '내 책으로 복사', exact: true }).click();
  let copy;
  for (let attempt = 0; attempt < 50 && !copy; attempt++) {
    copy = (await call('listBooks')).find((b) => !b.library);
    if (!copy) await new Promise((r) => setTimeout(r, 100));
  }
  if (!copy) console.log(await win.locator('body').innerText());
  assert.ok(copy, '복사본이 목록에 있어야 해요.');
  assert.equal(copy.canEdit, true); assert.equal(copy.library, false);
  const copied = await call('getBook', copy.id); copied.name = '합성 복사본 수정';
  await call('saveBook', copied);
  assert.equal((await call('getBook', copy.id)).name, copied.name);
  assert.equal((await call('getAnswers', copy.id)).items.q1.answer, '2');
  assert.equal(JSON.parse(readFileSync(join(libraryDir, 'books', book.id, 'book.json'))).name, book.name);
  await win.evaluate(async () => { const { nav } = await import('./js/shared.js'); await nav.home({ tab: 'bank' }); });
  await win.waitForSelector('.bank-filters');
  // 같은 창·동일 로컬 교재에서 공용 요약 유무만 바꿔 비교. 실제 문제은행 DOM을 기다림.
  for (let i = 4; i <= 1001; i++) seed(i);
  const listStart = performance.now();
  const all = await call('listBooks');
  const listColdMs = performance.now() - listStart;
  const warmStart = performance.now(); await call('listBooks');
  const listWarmMs = performance.now() - warmStart;
  await win.getByRole('button', { name: '모두 비우기', exact: true }).click();
  await win.locator('[data-bank-focus="exam"]').selectOption('');
  await win.locator('[data-bank-focus="year"]').fill('');
  await new Promise((r) => setTimeout(r, 500));
  const readsBeforeMeasure = await app.evaluate(() => globalThis.libraryFileReads);
  const metrics = await win.evaluate(async (all) => {
    const { bankView } = await import('./js/bankview.js');
    const samples = async (summaries) => {
      const times = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        const root = bankView(summaries); document.querySelector('.home-body').replaceChildren(root);
        while (!root.querySelector('.bank-filters')) await new Promise(requestAnimationFrame);
        times.push(performance.now() - start);
      }
      return times;
    };
    return { without: await samples(all.filter((b) => !b.library)), thousand: await samples(all) };
  }, all);
  assert.equal(await app.evaluate(() => globalThis.libraryFileReads), readsBeforeMeasure);
  console.log(JSON.stringify({ performance: metrics, listColdMs, listWarmMs, libraryBooks: all.filter((b) => b.library).length }));
  // 1000권을 한꺼번에 고르면 읽지 않고 더 골라 달라고 함
  await win.locator('[data-bank-focus="exam"]').selectOption('library');
  await win.getByText(/마고 모의고사가 \d+권이라 다 보이지 않아요/).waitFor();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await app.evaluate(() => globalThis.libraryFileReads), readsBeforeMeasure);
  assert.equal(await win.locator('.bank-row[data-book^="exam-"]').count(), 0);
  console.log('library-e2e PASS');
} finally {
  await app?.close(); cloud.stop();
  execFileSync('powershell.exe', ['-NoProfile', '-Command', "try { Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:LIBRARY_CLEANUP, 'OnlyErrorDialogs', 'SendToRecycleBin') } catch { Write-Output $env:LIBRARY_CLEANUP }"], { env: { ...process.env, LIBRARY_CLEANUP: tmp } });
}
