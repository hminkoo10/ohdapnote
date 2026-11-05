// 정답·해설 편집기의 실제 화면·저장·권한·내보내기 시험
import { _electron as electron } from '../lib/playwright.mjs';
import { fakeCloud } from '../lib/fake-cloud.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const { PDFDocument, StandardFonts } = require('pdf-lib');
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(OUT, 'answers-temp-'));
const academy = join(tmp, 'academy');
const id = 'aaaaaaaa-1234-4000-8000-000000000012';
const dir = join(academy, 'books', id);
mkdirSync(dir, { recursive: true });
const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]);
page.drawText('Answer 12. A sample solution.', { x: 40, y: 700, size: 16, font: await pdf.embedFont(StandardFonts.Helvetica) });
writeFileSync(join(dir, 'problem.pdf'), await pdf.save());
const item = { id: 'problem-1', number: '1', num: 1, page: 0, rects: [{ page: 0, x: 0.04, y: 0.12, w: 0.9, h: 0.12 }] };
const doc = (it) => ({ files: [{ name: 'problem.pdf', originalName: 'problem.pdf', kind: 'pdf' }], items: [it], pageCount: 1, pageInfo: {}, analyzedAt: Date.now() });
const book = { id, kind: 'book', version: 2, name: '정답 편집 시험', subject: 'english', createdBy: { id: 'teacher-a', name: '김선생' }, createdAt: Date.now(), updatedAt: Date.now(), docs: { problem: doc(item), answer: doc({ ...item, id: 'answer-1' }) }, answerOverrides: {} };
writeFileSync(join(dir, 'book.json'), JSON.stringify(book));
const cloud = fakeCloud({ dir: join(tmp, 'cloud'), academyDir: academy, subjects: ['math', 'english'], members: [{ id: 'teacher-a', name: '김선생', role: 'teacher' }, { id: 'teacher-b', name: '박선생', role: 'teacher' }] });
let app;
let win;
const errors = [];
const call = (fn, ...args) => win.evaluate(([f, a]) => window.ohdap[f](...a), [fn, args]);
const openEditor = async () => {
  await win.evaluate(async (bookId) => {
    const { openAnswerEditor } = await import('./js/answer-editor.js');
    const b = await window.ohdap.getBook(bookId);
    window.answerClosed = openAnswerEditor({ book: b, item: b.docs.problem.items[0] });
  }, id);
  await win.waitForSelector('.answer-editor-modal');
};
const closeEditor = async () => {
  await win.locator('.answer-editor-modal .modal-footer button').click();
  await win.waitForSelector('.answer-editor-modal', { state: 'detached' });
};
const saved = async () => {
  await win.waitForFunction(() => document.querySelector('.answer-status')?.textContent === '저장됨');
  return (await call('getAnswers', id)).items[item.id];
};
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', ROOT], env: { ...env, OHDAP_USER_DATA: join(tmp, 'local'), OHDAP_E2E: '1', MAGOEDU_DEV: '1', MAGOEDU_ACADEMY: '테스트학원', MAGOEDU_ACADEMY_DIR: academy, MAGOEDU_DATA_DIR: join(tmp, 'data'), MAGOEDU_LOCAL_DIR: join(tmp, 'local'), MAGOEDU_USER_ID: 'teacher-a', MAGOEDU_USER_NAME: '김선생', MAGOEDU_ROLE: 'teacher', ...cloud.env } });
  win = await app.firstWindow();
  win.on('pageerror', (err) => errors.push(err.message));
  await win.waitForSelector('.topbar');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 850));
  console.log('▶ 정답·글·수식 자동 저장');
  await openEditor();
  await win.getByRole('button', { name: '③', exact: true }).click();
  const editor = win.locator('.answer-document[contenteditable="true"]');
  await editor.fill('직접 쓴 해설 검색문장. ');
  await win.getByRole('button', { name: '수식', exact: true }).click();
  await win.locator('.answer-equation-script').fill('{a} over {b}');
  await win.locator('.answer-equation-modal').getByRole('button', { name: '넣기', exact: true }).click();
  await win.waitForSelector('.answer-equation-modal', { state: 'detached' });
  let entry = await saved();
  assert.equal(entry.answer, '③');
  assert.ok(entry.blocks.some((b) => b.runs?.some((r) => r.eq === '{a} over {b}')));
  console.log('▶ 그림 붙여 넣기·되돌리기·다시 열기');
  await editor.evaluate((el) => {
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 50;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2a7195'; ctx.fillRect(0, 0, 120, 50);
    canvas.toBlob((blob) => {
      const data = new DataTransfer(); data.items.add(new File([blob], '그림.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
  });
  await win.waitForSelector('.answer-document .answer-figure');
  entry = await saved();
  assert.ok(entry.blocks.some((b) => b.type === 'figure'));
  await win.screenshot({ path: join(OUT, 'answers-editor.png') });
  await editor.focus(); await win.keyboard.press('Control+z');
  assert.equal(await editor.locator('.answer-figure').count(), 0);
  await win.keyboard.press('Control+y');
  assert.equal(await editor.locator('.answer-figure').count(), 1);
  await closeEditor(); await openEditor();
  assert.deepEqual((await saved()).blocks, entry.blocks);
  assert.equal(await win.locator('.answer-input').inputValue(), '③');
  await closeEditor();
  assert.deepEqual(errors, []);
  console.log('정답·해설 E2E 통과');
} finally {
  if (app) await app.close();
  cloud.stop();
  rmSync(tmp, { recursive: true, force: true });
}
