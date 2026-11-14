// 문항 영역 삭제를 키보드로 확정하고, book.json 이 잠깐 열려 있어도 저장되는지 확인. 합성 PDF와 새 임시 사용자 폴더만 사용.
import assert from 'node:assert/strict';
import { _electron as electron } from '../lib/playwright.mjs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tmp = fs.mkdtempSync(join(tmpdir(), 'delete-save-e2e-'));
const id = 'aaaaaaaa-1234-4000-8000-000000000060';
const dir = join(tmp, 'data/shared/books', id);
const file = join(dir, 'book.json');
const started = Date.now();
let app;
let checks = 0;
const errors = [];
try {
  fs.mkdirSync(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Synthetic workbook', { x: 45, y: 775, font, size: 18 });
  for (let i = 0; i < 5; i++) page.drawText(`${i + 1}. Find x: x + ${i + 1} = 10`, { x: 45, y: 680 - i * 110, font, size: 14 });
  fs.writeFileSync(join(dir, 'problem.pdf'), await pdf.save());
  fs.writeFileSync(file, JSON.stringify({ id, kind: 'book', version: 2, subject: 'math', name: '합성 연습 교재',
    createdAt: 1, updatedAt: 1, answerOverrides: {}, docs: { answer: null, problem: {
      files: [{ name: 'problem.pdf', originalName: 'synthetic.pdf', kind: 'pdf' }], originalName: 'synthetic.pdf',
      pageCount: 1, range: '', options: { flow: 'column', numberStyle: 'auto' }, pageOffset: 0, pageOffsetAuto: true,
      analyzedAt: 1, pageInfo: { 0: { analyzed: true, source: 'text', flags: [] } },
      items: Array.from({ length: 5 }, (_, i) => ({ id: `problem-${i + 1}`, page: 0, number: String(i + 1), num: i + 1,
        rects: [{ page: 0, x: .06, y: .16 + i * .131, w: .88, h: .10 }] })),
    } } }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MAGOEDU_') || key === 'OHDAP_EXE') delete env[key];
  app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--renderer-process-limit=2', ROOT],
    env: { ...env, OHDAP_E2E: '1', OHDAP_USER_DATA: tmp } });
  const win = await app.firstWindow();
  win.setDefaultTimeout(20000);
  win.on('pageerror', (err) => errors.push(err.message));
  await win.waitForSelector('.seg-tab');
  await win.evaluate(async (id) => (await import('./js/shared.js')).nav.book(id, { tab: 'review' }), id);
  await win.waitForSelector('.page-overlay .box');
  await win.waitForTimeout(1000);
  const boxes = win.locator('.page-overlay .box');
  const activeModal = win.locator('.modal-overlay:not(.closing) .modal');
  const count = async (n) => { assert.equal(await boxes.count(), n); checks++; };
  const gone = () => win.waitForFunction(() => !document.querySelector('.modal-overlay'));
  const open = async () => {
    await boxes.first().click();
    await win.keyboard.press('Delete');
    await activeModal.waitFor();
    assert.equal(await activeModal.getAttribute('aria-label'), '문항 영역 삭제');
  };
  const diskCount = () => JSON.parse(fs.readFileSync(file, 'utf8')).docs.problem.items.length;
  const saved = async (n) => {
    // 다른 저장 도우미도 상태 글자를 바꾸므로 실제 책 파일까지 기다림.
    for (let i = 0; diskCount() !== n; i++) {
      if (i === 200) assert.fail(`책 파일 저장 대기 시간 초과: ${diskCount()} != ${n}`);
      await win.waitForTimeout(20);
    }
    await win.waitForFunction(() => document.querySelector('.save-status')?.textContent === '저장됨');
    assert.equal(diskCount(), n);
    assert.equal(await win.locator('.toast').filter({ hasText: /저장하지 못했어요|EPERM/ }).count(), 0);
    checks++;
  };
  await count(5);
  await app.evaluate((_electron, file) => {
    const fs = process.getBuiltinModule('node:fs');
    globalThis.deleteSaveCounts = { readSync: 0, readAsync: 0, rename: 0 };
    const readSync = fs.readFileSync, readAsync = fs.promises.readFile, rename = fs.renameSync;
    fs.readFileSync = function (name, ...args) { if (String(name) === file) globalThis.deleteSaveCounts.readSync++; return readSync.call(this, name, ...args); };
    fs.promises.readFile = function (name, ...args) { if (String(name) === file) globalThis.deleteSaveCounts.readAsync++; return readAsync.call(this, name, ...args); };
    fs.renameSync = function (from, to) { if (String(to) === file) globalThis.deleteSaveCounts.rename++; return rename.call(this, from, to); };
  }, file);

  console.log('STEP Delete → Esc');
  await open(); await win.keyboard.press('Escape'); await gone(); await count(5);

  console.log('STEP Delete → Tab → 취소 → Enter');
  await open();
  for (let i = 0; i < 5; i++) {
    await win.keyboard.press('Tab');
    if (await win.evaluate(() => document.activeElement?.textContent === '취소')) break;
  }
  assert.equal(await win.evaluate(() => document.activeElement?.textContent), '취소');
  await win.keyboard.press('Enter'); await gone(); await count(5);

  console.log('STEP IME·반복 Enter·Delete·Backspace 차단');
  await open();
  for (const event of [{ key: 'Enter', isComposing: true }, { key: 'Enter', repeat: true },
    { key: 'Delete', repeat: true }, { key: 'Backspace' }]) {
    const result = await win.evaluate((options) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options });
      document.activeElement.dispatchEvent(event);
      return { prevented: event.defaultPrevented, modal: !!document.querySelector('.modal-overlay:not(.closing)') };
    }, event);
    assert.equal(result.modal, true);
    if (!event.isComposing) assert.equal(result.prevented, true);
    await count(5);
  }
  if (process.env.DELETE_SAVE_SHOTS) {
    fs.mkdirSync(process.env.DELETE_SAVE_SHOTS, { recursive: true });
    await win.screenshot({ path: join(process.env.DELETE_SAVE_SHOTS, 'delete-confirm.png'), animations: 'disabled' });
  }
  await win.keyboard.press('Enter');
  await gone(); await count(4); await saved(4);
  const ids = await boxes.evaluateAll((els) => els.map((el) => el.dataset.id));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).docs.problem.items.some((item) => item.id === 'problem-1'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).docs.problem.items.map((item) => item.number), ['2', '3', '4', '5']);
  await win.keyboard.press('Delete'); await win.waitForTimeout(350);
  assert.equal(await activeModal.count(), 0, '삭제 뒤 다음 문항은 자동 선택하지 않음'); await count(4);
  console.log('DELETE_COUNTS', await app.evaluate(() => globalThis.deleteSaveCounts), 'remaining', ids);
  if (process.env.DELETE_SAVE_SHOTS) await win.screenshot({ path: join(process.env.DELETE_SAVE_SHOTS, 'delete-after.png') });

  console.log('STEP 누른 채 Delete·Enter 반복과 닫히는 창');
  await boxes.first().click();
  await win.keyboard.down('Delete'); await activeModal.waitFor();
  await win.keyboard.down('Delete');
  await win.keyboard.down('Enter');
  await win.keyboard.down('Delete'); await win.keyboard.down('Enter');
  await win.keyboard.up('Enter'); await win.keyboard.up('Delete');
  await gone(); await count(3); await saved(3);
  await boxes.first().click();
  await win.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', repeat: true, bubbles: true, cancelable: true })));
  assert.equal(await activeModal.count(), 0, '창이 없을 때도 반복 Delete 무시');

  console.log('STEP 열린 대상 파일 핸들 300ms와 삭제 저장');
  await open();
  let handle = fs.openSync(file, 'r');
  const lockStarted = Date.now();
  const release = setTimeout(() => { fs.closeSync(handle); handle = null; }, 950);
  // 자동 저장은 수정 600ms 뒤 시작하므로 실제 저장과 겹치는 마지막 350ms를 잠금.
  try { await win.keyboard.press('Enter'); await gone(); await count(2); await saved(2); }
  finally { clearTimeout(release); if (handle !== null) fs.closeSync(handle); }
  console.log('LOCK_SAVE_MS', Date.now() - lockStarted);

  console.log('STEP 앱 안 비동기 읽기 핸들과 삭제 저장은 같은 줄');
  await app.evaluate(({ ipcMain }, file) => {
    const fs = process.getBuiltinModule('node:fs');
    const read = fs.promises.readFile;
    globalThis.holdNextBookRead = true;
    globalThis.bookReadHeld = false;
    globalThis.bookSaveArrived = false;
    fs.promises.readFile = async function (name, ...args) {
      if (String(name) !== file || !globalThis.holdNextBookRead) return read.call(this, name, ...args);
      globalThis.holdNextBookRead = false;
      const handle = fs.openSync(file, 'r');
      globalThis.bookReadHeld = true;
      try {
        await new Promise((r) => { globalThis.releaseBookRead = r; });
        return await read.call(this, name, ...args);
      } finally { fs.closeSync(handle); globalThis.bookReadHeld = false; }
    };
    const save = ipcMain._invokeHandlers.get('books:save');
    ipcMain.removeHandler('books:save');
    ipcMain.handle('books:save', (...args) => { globalThis.bookSaveArrived = true; return save(...args); });
  }, file);
  const ownRead = win.evaluate((id) => window.ohdap.getBook(id), id);
  await app.evaluate(async () => {
    for (let i = 0; !globalThis.bookReadHeld; i++) {
      if (i === 200) throw Error('읽기 핸들 대기 시간 초과');
      await new Promise((r) => setTimeout(r, 10));
    }
  });
  try {
    await open(); await win.keyboard.press('Enter'); await gone(); await count(1);
    await app.evaluate(async () => {
      for (let i = 0; !globalThis.bookSaveArrived; i++) {
        if (i === 300) throw Error('저장 요청 대기 시간 초과');
        await new Promise((r) => setTimeout(r, 10));
      }
      globalThis.releaseBookRead();
    });
    assert.equal((await ownRead).docs.problem.items.length, 2);
    await saved(1);
  } finally { await app.evaluate(() => globalThis.releaseBookRead?.()); await ownRead; }

  console.log('STEP 다른 위험 확인 창은 Enter 기본 무시');
  await win.evaluate(async () => {
    globalThis.defaultConfirm = undefined;
    (await import('./js/ui.js')).confirmDialog('합성 삭제 확인', { danger: true }).then((r) => { globalThis.defaultConfirm = r; });
  });
  await activeModal.waitFor(); await win.keyboard.press('Enter');
  assert.equal(await activeModal.count(), 1); checks++;
  await win.keyboard.press('Escape'); await gone();
  assert.equal(await win.evaluate(() => globalThis.defaultConfirm), false);
  assert.deepEqual(errors, []);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  console.log(`PASS delete-save E2E: ${checks} checks, ${Date.now() - started}ms`);
} finally {
  if (app) await app.close().catch(() => {});
  assert.ok(tmp.startsWith(join(tmpdir(), 'delete-save-e2e-')));
  fs.rmSync(tmp, { recursive: true, force: true });
}
