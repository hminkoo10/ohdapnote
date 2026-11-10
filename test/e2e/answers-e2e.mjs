// 정답·해설 편집기의 실제 화면·저장·권한·내보내기 시험
import { _electron as electron } from '../lib/playwright.mjs';
import { fakeCloud } from '../lib/fake-cloud.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, cpSync, renameSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

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
const doc = (it) => ({ files: [{ name: 'problem.pdf', originalName: 'problem.pdf', kind: 'pdf' }], items: [it], pageCount: 1, pageInfo: {}, range: '', options: { flow: 'column', numberStyle: 'auto' }, pageOffset: 0, pageOffsetAuto: true, analyzedAt: Date.now() });
const book = { id, kind: 'book', version: 2, name: '정답 편집 시험', subject: 'english', createdBy: { id: 'teacher-a', name: '김선생' }, createdAt: Date.now(), updatedAt: Date.now(), docs: { problem: doc(item), answer: doc({ ...item, id: 'answer-1' }) }, answerOverrides: {} };
writeFileSync(join(dir, 'book.json'), JSON.stringify(book));
const cloud = fakeCloud({ dir: join(tmp, 'cloud'), academyDir: academy, subjects: ['math', 'english'], members: [{ id: 'teacher-a', name: '김선생', role: 'teacher' }, { id: 'teacher-b', name: '박선생', role: 'teacher' }] });
const clouds = [cloud];
let app;
let win;
const errors = [];
function sectionXml(bytes) {
  const buf = Buffer.from(bytes);
  const end = buf.lastIndexOf(Buffer.from([80, 75, 5, 6]));
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const len = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + len);
    const at = buf.readUInt32LE(p + 42);
    if (name === 'Contents/section0.xml') {
      const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
      const data = buf.subarray(start, start + buf.readUInt32LE(p + 20));
      return (buf.readUInt16LE(p + 10) === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + len + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  throw new Error('HWPX 본문 없음');
}
const call = (fn, ...args) => win.evaluate(([f, a]) => window.ohdap[f](...a), [fn, args]);
const shot = async (name) => {
  await win.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect.getComputedTiming().endTime)).map((a) => a.finished.catch(() => {})));
  });
  await win.screenshot({ path: join(OUT, `answers-${name}.png`) });
};
async function eventually(check) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('실시간 변경을 기다리는 시간이 지났어요.');
}
async function launch(user = 'teacher-a', academyDir = academy, link = cloud) {
  app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', ROOT], env: { ...env, OHDAP_USER_DATA: join(tmp, user, 'local'), OHDAP_E2E: '1', MAGOEDU_DEV: '1', MAGOEDU_ACADEMY: '테스트학원', MAGOEDU_ACADEMY_DIR: academyDir, MAGOEDU_DATA_DIR: join(tmp, user, 'data'), MAGOEDU_LOCAL_DIR: join(tmp, user, 'local'), MAGOEDU_USER_ID: user, MAGOEDU_USER_NAME: user === 'teacher-a' ? '김선생' : '박선생', MAGOEDU_ROLE: 'teacher', ...link.env } });
  win = await app.firstWindow();
  win.on('pageerror', (err) => errors.push(err.message));
  await win.waitForSelector('.topbar');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 850));
}
async function exportFromUi(where, format) {
  const dest = join(tmp, `${where}.${format}`);
  await win.locator('.toast').evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, dest);
  const name = where === 'bank' ? 'bank-format' : 'format';
  await win.locator(`.seg label:has(input[name="${name}"][value="${format}"])`).click();
  await win.locator('.export-btn[data-mode="answers"]').click();
  await win.waitForFunction((message) => [...document.querySelectorAll('.toast')].some((el) => el.textContent.includes(message)), where === 'bank' ? '저장 완료' : '저장했어요', { timeout: 60000 });
  assert.ok(existsSync(dest));
  const bytes = readFileSync(dest);
  if (format === 'hwpx') assert.match(sectionXml(bytes), /<hp:script>\{a\} over \{b\}<\/hp:script>/);
  else {
    const text = await win.evaluate(async (bytes) => {
      const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
      const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
      const pdf = await task.promise;
      const text = (await (await pdf.getPage(1)).getTextContent()).items.map((x) => x.str).join('');
      await task.destroy(); return text;
    }, [...bytes]);
    assert.match(text.replace(/\s/g, ''), /직접쓴해설검색문장/);
  }
}
const openEditor = async () => {
  await win.evaluate(async (bookId) => {
    const { openAnswerEditor } = await import('./js/answer-editor.js');
    const b = await window.ohdap.getBook(bookId);
    window.answerClosed = openAnswerEditor({ book: b, item: b.docs.problem.items[0] });
  }, id);
  await win.waitForSelector('.answer-editor-modal');
  assert.ok(await win.locator('.answer-editor-modal').evaluate((el) => el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth && el.scrollWidth <= el.clientWidth), '1040px에서 편집기 가로 넘침 없음');
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
  await launch();
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
  await shot('editor');
  await editor.focus(); await win.keyboard.press('Control+z');
  assert.equal(await editor.locator('.answer-figure').count(), 0);
  await win.keyboard.press('Control+y');
  assert.equal(await editor.locator('.answer-figure').count(), 1);
  await closeEditor(); await openEditor();
  assert.deepEqual((await saved()).blocks, entry.blocks);
  assert.equal(await win.locator('.answer-input').inputValue(), '③');
  await closeEditor();
  console.log('▶ 해설 PDF 글자 검색·HWPX 수식 원문');
  const exported = await win.evaluate(async (bookId) => {
    const { makeBlocks, buildPdf } = await import('./js/exporter.js');
    const { buildHwpx } = await import('./js/hwpx.js');
    const { attachAnswers } = await import('./js/answers.js');
    const book = await window.ohdap.getBook(bookId);
    const entries = [{ bookId, problem: book.docs.problem.items[0], answer: null }];
    await attachAnswers(entries);
    const blocks = makeBlocks('answers', entries, {}, () => 'p.1');
    const pdf = await buildPdf({ blocks, options: { space: 'none' }, title: '해설 시험' });
    const hwpx = await buildHwpx({ blocks, title: '해설 시험' });
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    const task = pdfjs.getDocument({ data: pdf.slice() });
    const doc = await task.promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((x) => x.str).join('');
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const screenshot = canvas.toDataURL('image/png').split(',')[1];
    await task.destroy();
    return { pdf: [...pdf], hwpx: [...hwpx], text, screenshot };
  }, id);
  assert.match(exported.text.replace(/\s/g, ''), /직접쓴해설검색문장/);
  const section = sectionXml(exported.hwpx);
  assert.match(section, /<hp:script>\{a\} over \{b\}<\/hp:script>/);
  assert.match(section, /<hp:pic /);
  writeFileSync(join(OUT, 'answers-pdf.png'), Buffer.from(exported.screenshot, 'base64'));
  console.log('▶ 문서 왕복·한글 수식 단축키·불완전 수식 안내');
  await win.evaluate(async () => {
    const { renderAnswerDocument, readAnswerDocument } = await import('./js/answer-editor.js');
    const blocks = [{ type: 'para', text: '검색용 원문', runs: [{ text: '함' }, { text: '수 ' }, { eq: 'x^2' }, { text: ' 뒤' }] }, { type: 'math', eq: ' {x} over {y} ' }, { type: 'para', text: '' }];
    const root = document.createElement('div'); renderAnswerDocument(root, blocks);
    if (JSON.stringify(readAnswerDocument(root)) !== JSON.stringify(blocks)) throw new Error(`문서 왕복 손실: ${JSON.stringify(readAnswerDocument(root))}`);
  });
  await openEditor(); await editor.focus();
  await win.keyboard.press('Control+n'); await win.keyboard.press('Control+m');
  await win.waitForSelector('.answer-equation-modal');
  await win.locator('.answer-equation-script').fill('sqrt {');
  assert.match(await win.locator('.answer-equation-modal .warn-text').innerText(), /확인/);
  await shot('equation');
  await win.keyboard.press('Escape');
  await win.getByRole('button', { name: '버리기', exact: true }).click();
  await win.waitForSelector('.answer-equation-modal', { state: 'detached' });
  assert.equal(await win.locator('.answer-editor-modal').count(), 1, '수식 창 취소가 본문 창을 닫지 않음');
  console.log('▶ 답지 짝 지정·인식 글 불러오기·덮어쓰기 확인·그림 변환');
  await closeEditor();
  const changedBook = await call('getBook', id);
  changedBook.docs.answer.items.push({ ...item, id: 'answer-2' });
  changedBook.answerOverrides[item.id] = 'answer-2';
  await call('saveBook', changedBook);
  await win.evaluate(async (bookId) => {
    const { getSources } = await import('./js/shared.js');
    const { setEditedTranscript } = await import('./js/transcribe.js');
    const book = await window.ohdap.getBook(bookId);
    const src = await getSources(book);
    await setEditedTranscript(bookId, { kind: 'answer', role: 'answer', item: book.docs.answer.items[1], src: src.answer }, [{ type: 'para', text: '정답 ⑤ 옮긴 풀이 $x^2$' }, { type: 'math', latex: '\\frac{3}{4}' }, { type: 'figure', box: { x: 0, y: 0, w: 0.5, h: 0.8 } }]);
  }, id);
  await openEditor();
  await win.getByRole('button', { name: '답지 인식 결과 불러오기', exact: true }).click();
  await win.getByRole('button', { name: '취소', exact: true }).click();
  assert.equal(await win.locator('.answer-input').inputValue(), '③');
  await win.getByRole('button', { name: '답지 인식 결과 불러오기', exact: true }).click();
  await win.getByRole('button', { name: '바꾸기', exact: true }).click();
  await win.waitForFunction(() => document.querySelector('.answer-input').value === '⑤');
  const imported = await saved();
  assert.ok(imported.blocks.some((b) => b.type === 'math' && b.eq.includes('over')));
  assert.ok(imported.blocks.some((b) => b.type === 'figure' && b.file.startsWith('answer-images/')));
  await shot('imported');
  await closeEditor();
  console.log('▶ 인식 결과 없는 디지털 답지 바로 읽기');
  await call('saveTranscripts', id, { version: 1, items: {} });
  await openEditor();
  await win.getByRole('button', { name: '답지 인식 결과 불러오기', exact: true }).click();
  await win.getByRole('button', { name: '바꾸기', exact: true }).click();
  await win.waitForFunction(() => document.querySelector('.answer-document').textContent.includes('sample solution'));
  assert.equal(await win.locator('.answer-input').inputValue(), '', '정답을 찾지 못하면 비움');
  await closeEditor();
  console.log('▶ 답지 없는 교재·창 닫기·앱 종료 직전 저장');
  changedBook.docs.answer = null;
  await call('saveBook', changedBook);
  await call('saveAnswer', id, item.id, entry);
  await openEditor();
  assert.match(await win.locator('.answer-reference').innerText(), /답지 없음 · 직접 작성 가능/);
  await win.locator('.answer-input').fill('12');
  await closeEditor();
  assert.equal((await call('getAnswers', id)).items[item.id].answer, '12');
  await openEditor();
  await win.locator('.answer-input').fill('③');
  await win.reload();
  await win.waitForSelector('.topbar');
  assert.equal((await call('getAnswers', id)).items[item.id].answer, '③');
  console.log('▶ 문제은행 실제 해설지 PDF·HWPX 버튼');
  await win.click('.seg-tab[data-tab="bank"]');
  await win.waitForSelector('.bank-row');
  await win.locator('.bank-row input').first().check();
  await win.locator('.bank-row').first().click();
  await win.locator('.bank-preview .answer-open').click();
  await win.waitForSelector('.answer-editor-modal'); await closeEditor();
  await exportFromUi('bank', 'pdf'); await exportFromUi('bank', 'hwpx');
  console.log('▶ 오답노트 실제 해설지 PDF·HWPX 버튼');
  const note = await call('createNote', { title: '해설 시험 노트', bookIds: [id] });
  note.selected = { [id]: [item.id] }; note.exportOptions = { format: 'pdf', columns: 1, space: 'none' };
  await call('saveNote', note);
  await win.evaluate(async (noteId) => (await import('./js/shared.js')).nav.note(noteId), note.id);
  await win.waitForSelector('.export-btn[data-mode="answers"]');
  await exportFromUi('note', 'pdf'); await exportFromUi('note', 'hwpx');
  assert.equal((await call('getNote', note.id)).answersForStudent, false);
  console.log('▶ 오답노트·책 미리보기에서 편집기 열기');
  await win.locator('.qtable .chip').first().hover();
  await win.locator('.select-side .answer-open').click();
  await win.waitForSelector('.answer-editor-modal'); await closeEditor();
  await win.evaluate(async (bookId) => (await import('./js/shared.js')).nav.book(bookId), id);
  await win.locator('.qtable .chip').first().hover();
  await win.locator('.answer-open').click();
  await win.waitForSelector('.answer-editor-modal'); await closeEditor();
  await win.evaluate(async (noteId) => (await import('./js/shared.js')).nav.note(noteId), note.id);
  console.log('▶ 고아 정답 보존·계약 과목 제한');
  const moved = await call('getBook', id);
  moved.docs.problem.items[0].id = 'problem-new';
  await call('saveBook', moved);
  await assert.rejects(win.evaluate(async ({ bookId, item }) => {
    const { openAnswerEditor } = await import('./js/answer-editor.js');
    await openAnswerEditor({ book: await window.ohdap.getBook(bookId), item });
  }, { bookId: id, item }), /문항이 바뀌/);
  await openEditor();
  assert.equal(await win.locator('.answer-input').inputValue(), '');
  await closeEditor();
  assert.equal((await call('getAnswers', id)).items[item.id].answer, '③');
  moved.docs.problem.items[0].id = item.id;
  await call('saveBook', moved);
  cloud.setSubjects(['math']);
  await eventually(async () => (await call('getBook', id)).$subjectOpen === false);
  await assert.rejects(call('saveAnswer', id, item.id, entry), /계약/);
  cloud.setSubjects(['math', 'english']);
  await eventually(async () => (await call('getBook', id)).$subjectOpen !== false);
  await openEditor();
  await win.locator('.answer-input').fill('②');
  await app.close(); app = null;
  assert.equal(JSON.parse(readFileSync(join(dir, 'answers.json'), 'utf8')).items[item.id].answer, '②', '앱을 끌 때 마지막 입력 저장');
  console.log('▶ 다른 PC·다른 선생님: 공유 파일 받기·보기만·실시간 갱신');
  const academy2 = join(tmp, 'pc2', 'academy');
  const dir2 = join(academy2, 'books', id);
  cpSync(dir, dir2, { recursive: true });
  const cloud2 = fakeCloud({ dir: join(tmp, 'cloud2'), academyDir: academy2, subjects: ['math', 'english'], members: [{ id: 'teacher-b', name: '박선생', role: 'teacher' }, { id: 'teacher-a', name: '김선생', role: 'teacher' }] });
  clouds.push(cloud2);
  await launch('teacher-b', academy2, cloud2); await openEditor();
  assert.equal(await win.locator('.answer-input').isEditable(), false);
  assert.equal(await win.locator('.answer-document').getAttribute('contenteditable'), 'false');
  await assert.rejects(call('saveAnswer', id, item.id, entry), /만든 사람/);
  await assert.rejects(call('putAnswerImage', id, [137, 80, 78, 71]), /만든 사람/);
  const picture = entry.blocks.find((b) => b.type === 'figure');
  assert.match(await call('getAnswerImage', id, picture.file), /^data:image\/png/);
  await assert.rejects(call('getAnswerImage', id, '../book.json'), /경로/);
  const remote = JSON.parse(readFileSync(join(dir, 'answers.json'), 'utf8'));
  remote.items[item.id] = { answer: '④', blocks: [...entry.blocks, { type: 'para', text: '다른 PC에서 바꾼 해설' }], updatedAt: Date.now(), by: { id: 'teacher-a', name: '김선생' } };
  // 통합 클라우드가 내려받은 파일을 원자적으로 바꾸는 것과 같은 경로.
  writeFileSync(join(dir2, 'answers.json.tmp'), JSON.stringify(remote)); renameSync(join(dir2, 'answers.json.tmp'), join(dir2, 'answers.json'));
  await win.waitForFunction(() => document.querySelector('.answer-input').value === '④');
  assert.match(await win.locator('.answer-document').innerText(), /다른 PC에서/);
  await shot('readonly-sync');
  await closeEditor();
  assert.deepEqual(errors, []);
  console.log('정답·해설 E2E 통과');
} catch (err) {
  console.error('화면 오류:', errors);
  if (win && !win.isClosed()) console.log(await win.locator('body').innerText().catch(() => ''));
  throw err;
} finally {
  if (app) await app.close();
  clouds.forEach((cloud) => cloud.stop());
  if (process.platform === 'win32') {
    const { execFileSync } = await import('node:child_process');
    execFileSync('powershell.exe', ['-NoProfile', '-Command', "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:OHDAP_TEST_CLEANUP, 'OnlyErrorDialogs', 'SendToRecycleBin')"], { env: { ...process.env, OHDAP_TEST_CLEANUP: tmp } });
  } else rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
