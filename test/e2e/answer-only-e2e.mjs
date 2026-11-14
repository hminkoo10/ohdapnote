// 시험용 책으로 새 두 모드의 실제 저장·HWPX 글자·PDF 그림·화면 확인.
import { _electron as electron } from '../lib/playwright.mjs';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = process.env.ANSWER_ONLY_SHOTS || join(ROOT, 'test/e2e/out/answer-only');
const EXPORTS = join(ROOT, 'test/e2e/out/answer-only');
const FIX = join(ROOT, 'test/fixtures/generated');
mkdirSync(OUT, { recursive: true });
mkdirSync(EXPORTS, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'ohdap-answer-only-'));
const env = { ...process.env, OHDAP_USER_DATA: join(tmp, 'local'), OHDAP_E2E: '1' };
for (const key of Object.keys(env)) if (key.startsWith('MAGOEDU_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
let app, win;
const errors = [];
const started = Date.now();
const bookId = 'aaaaaaaa-1234-4000-8000-000000000071';
const dir = join(tmp, 'local/data/shared/books', bookId);

function sectionXml(bytes) {
  const buf = Buffer.from(bytes), end = buf.lastIndexOf(Buffer.from([80, 75, 5, 6]));
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const len = buf.readUInt16LE(p + 28), name = buf.toString('utf8', p + 46, p + 46 + len), at = buf.readUInt32LE(p + 42);
    if (name === 'Contents/section0.xml') {
      const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28), data = buf.subarray(start, start + buf.readUInt32LE(p + 20));
      return (buf.readUInt16LE(p + 10) === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + len + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  assert.fail('HWPX 본문 없음');
}

try {
  assert.ok(existsSync(join(FIX, 'book-unit.pdf')), '먼저 시험용 자료 생성');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(FIX, 'book-unit.pdf'), join(dir, 'problem.pdf'));
  copyFileSync(join(FIX, 'answer-unit.pdf'), join(dir, 'answer.pdf'));
  app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', ROOT], env });
  win = await app.firstWindow();
  win.on('pageerror', error => errors.push(error.message));
  await win.waitForSelector('.topbar');
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setSize(1040, 1000);
    globalThis.answerPrintCalls = 0;
    const handler = ipcMain._invokeHandlers.get('answers:renderPdf');
    ipcMain.removeHandler('answers:renderPdf');
    ipcMain.handle('answers:renderPdf', (...args) => { globalThis.answerPrintCalls++; return handler(...args); });
  });
  const call = (fn, ...args) => win.evaluate(([fn, args]) => window.ohdap[fn](...args), [fn, args]);
  // 분석도 앱에서 쓰는 경로 그대로. 원본은 기존 합성 자료만 사용한다.
  const docs = await win.evaluate(async bookId => {
    const { openDocSource, bookFileUrl } = await import('./js/docsource.js');
    const { analyzeDocument } = await import('./js/analyze.js');
    const docs = {};
    for (const role of ['problem', 'answer']) {
      const files = [{ name: `${role}.pdf`, kind: 'pdf', originalName: `${role}.pdf` }];
      const src = await openDocSource(files, name => bookFileUrl(bookId, name));
      try {
        const result = await analyzeDocument(src, { pages: src.pages.map((_, i) => i), role, flow: role === 'problem' ? 'column' : 'continue' });
        docs[role] = { files, items: result.items, pageInfo: result.pageInfo, pageCount: src.numPages, pageOffset: result.pageOffset, range: '', options: { flow: role === 'problem' ? 'column' : 'continue' }, analyzedAt: Date.now() };
      } finally { await src.destroy(); }
    }
    return docs;
  }, bookId);
  assert.ok(docs.problem.items.length >= 3);
  const book = { id: bookId, kind: 'book', version: 2, subject: 'math', name: '답 내보내기 연습', createdAt: Date.now(), updatedAt: Date.now(), docs, answerOverrides: {} };
  // 책 생성 API가 요구하는 새 UUID 폴더를 이미 시험 폴더 안에 만들어 둠.
  writeFileSync(join(dir, 'book.json'), JSON.stringify(book));
  const picks = docs.problem.items.slice(0, 3);
  // 마지막 문항은 답 출처를 모두 없애 안내 줄과 알림도 확인한다.
  book.answerOverrides[picks[2].id] = null;
  await call('saveBook', book);
  const regionCount = await win.evaluate(async bookId => {
    const { getSources } = await import('./js/shared.js');
    const { computeMatches, findItem } = await import('./js/store.js');
    const { resolveExportAnswers } = await import('./js/export-answers.js');
    const book = await window.ohdap.getBook(bookId), src = await getSources(book), matches = computeMatches(book);
    const entries = book.docs.problem.items.slice(0, 2).map(problem => ({ problem, answer: findItem(book.docs.answer, matches.get(problem.id)), src, bookObj: book }));
    return (await resolveExportAnswers(entries)).entries.filter(e => e.exportAnswer).length;
  }, bookId);
  assert.ok(regionCount > 0, '기존 합성 답지의 실제 글자층에서 답 읽기');
  console.log(`짝 영역 글자층 답 읽기: ${regionCount}개`);
  await call('saveAnswer', bookId, picks[0].id, { answer: '③', blocks: [{ type: 'para', text: '풀이 확인 문장' }] });
  await call('saveAnswer', bookId, picks[1].id, { answer: '12', blocks: [] });
  const answersBefore = JSON.stringify(await call('getAnswers', bookId));
  const note = await call('createNote', { title: '답 내보내기 연습', bookIds: [bookId] });
  note.selected = { [bookId]: picks.map(p => p.id) };
  note.exportOptions = { columns: 1, space: 'none', labels: false, renumber: true, format: 'pdf' };
  await call('saveNote', note);
  await win.evaluate(async id => (await import('./js/shared.js')).nav.note(id), note.id);
  await win.waitForSelector('.export-btn[data-mode="answer-inline"]');
  assert.equal(await win.locator('.export-btn').count(), 6);
  for (const mode of ['answer-inline', 'answer-end']) assert.equal(await win.locator(`.export-btn[data-mode="${mode}"]`).isEnabled(), true);
  await win.locator('.export-buttons').screenshot({ path: join(OUT, 'export-buttons.png') });
  const renderPdf = async (bytes, mode) => win.evaluate(async ([bytes, mode]) => {
    const { openDocSource } = await import('./js/docsource.js');
    const blob = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }));
    const src = await openDocSource([{ name: blob, kind: 'pdf' }], n => n);
    try {
      const { OPS } = await import('./vendor/pdfjs/pdf.min.mjs');
      let text = '';
      const pages = [];
      const images = [];
      let first = null, last = null;
      for (let i = 0; i < src.numPages; i++) {
        const page = await src.getPdfPage(i);
        const current = (await page.getTextContent()).items.map(t => t.str).join(' ');
        pages.push(current); text += current + '\n';
        const ops = await page.getOperatorList();
        images.push(ops.fnArray.filter(fn => fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject).length);
        // 쪽 캐시를 정리하기 전에 그 쪽 그림을 바로 받아 둔다.
        if (i === 0) first = (await src.renderPage(i, 1000)).toDataURL().split(',')[1];
        if (mode === 'answer-end' && i === src.numPages - 1) last = (await src.renderPage(i, 1000)).toDataURL().split(',')[1];
      }
      return { text, pages, images, first, last };
    } finally { await src.destroy(); URL.revokeObjectURL(blob); }
  }, [bytes, mode]);
  for (const format of ['pdf', 'hwpx']) {
    await win.locator(`.seg label:has(input[name="format"][value="${format}"])`).click();
    for (const mode of ['answer-inline', 'answer-end']) {
      const begin = Date.now(), dest = join(tmp, `${mode}.${format}`);
      await win.locator('.toast').evaluateAll(nodes => nodes.forEach(node => node.remove()));
      await app.evaluate(({ dialog }, dest) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest }); }, dest);
      const before = await app.evaluate(() => globalThis.answerPrintCalls);
      await win.locator(`.export-btn[data-mode="${mode}"]`).click();
      await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some(el => el.textContent.includes('저장했어요')), null, { timeout: 120000 });
      assert.ok(existsSync(dest));
      assert.ok(await win.getByText('답을 찾지 못한 문항 1개', { exact: true }).count());
      assert.equal(await app.evaluate(() => globalThis.answerPrintCalls), before, '답마다 숨은 인쇄 창 없음');
      const bytes = readFileSync(dest);
      writeFileSync(join(EXPORTS, `${mode}.${format}`), bytes);
      if (format === 'hwpx') {
        const text = sectionXml(bytes);
        assert.ok(text.includes('③'), '객관식 답 글자');
        assert.ok(text.includes('12'), '단답 글자');
        assert.ok(text.replace(/\s/g, '').includes('(답을찾지못했어요)'), '없는 답 안내 글자');
        if (mode === 'answer-end') assert.ok(text.includes('정답'));
      } else {
        const rendered = await renderPdf([...bytes], mode);
        assert.equal(rendered.pages.length, mode === 'answer-end' ? 2 : 1, 'PDF 쪽 수');
        assert.ok(rendered.images.every(n => n > 0), '쪽마다 머리·라벨·답 그림 존재');
        assert.ok(rendered.images.at(-1) >= (mode === 'answer-end' ? 3 : 6), '답 그림 배치');
        assert.ok(rendered.pages[0].replace(/\s/g, '').includes('f(x)'), '첫 쪽에 첫 문제도 남아 있음');
        writeFileSync(join(OUT, `${mode}-first.png`), Buffer.from(rendered.first, 'base64'));
        if (rendered.last) writeFileSync(join(OUT, `${mode}-answers.png`), Buffer.from(rendered.last, 'base64'));
        assert.ok(rendered.first && (mode !== 'answer-end' || rendered.last), '첫 쪽·정답 모음 쪽 캡처');
      }
      assert.equal(JSON.stringify(await call('getAnswers', bookId)), answersBefore, '찾은 답을 저장하지 않음');
      console.log(`${mode} ${format}: 통과 (${((Date.now() - begin) / 1000).toFixed(2)}초, ${bytes.length} bytes)`);
    }
  }
  // 기존 해설은 답 줄로 바뀌지 않고 그대로 인쇄한다.
  await win.locator('.seg label:has(input[name="format"][value="pdf"])').click();
  const dest = join(tmp, 'both-inline.pdf');
  await win.locator('.toast').evaluateAll(nodes => nodes.forEach(node => node.remove()));
  await app.evaluate(({ dialog }, dest) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest }); }, dest);
  await win.locator('.export-btn[data-mode="both-inline"]').click();
  await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some(el => el.textContent.includes('저장했어요')), null, { timeout: 120000 });
  const legacy = await renderPdf([...readFileSync(dest)], 'both-inline');
  assert.ok(legacy.text.replace(/\s/g, '').includes('풀이확인문장'));
  assert.deepEqual(errors, []);
  console.log(`답 전용 E2E 통과: ${((Date.now() - started) / 1000).toFixed(2)}초`);
} catch (error) {
  await win?.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  assert.ok(tmp.startsWith(join(tmpdir(), 'ohdap-answer-only-')));
  rmSync(tmp, { recursive: true, force: true });
}
