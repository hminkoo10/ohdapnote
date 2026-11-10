// 공식 단축키 22줄·실제 Electron 메뉴·수식 저장 및 내보내기 시험
import { _electron as electron } from '../lib/playwright.mjs';
import { fakeCloud } from '../lib/fake-cloud.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require('pdf-lib');
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(OUT, 'eqeditor-temp-'));
const academy = join(tmp, 'academy');
const id = 'aaaaaaaa-1234-4000-8000-000000000012';
const dir = join(academy, 'books', id);
mkdirSync(dir, { recursive: true });
const pdf = await PDFDocument.create();
pdf.addPage([595, 842]).drawText('1. Write a formula.', { x: 40, y: 700, size: 16, font: await pdf.embedFont(StandardFonts.Helvetica) });
writeFileSync(join(dir, 'problem.pdf'), await pdf.save());
const item = { id: 'problem-1', number: '1', num: 1, page: 0, rects: [{ page: 0, x: 0.04, y: 0.12, w: 0.9, h: 0.12 }] };
const doc = { files: [{ name: 'problem.pdf', originalName: 'problem.pdf', kind: 'pdf' }], items: [item], pageCount: 1, pageInfo: {}, range: '', options: { flow: 'column', numberStyle: 'auto' }, pageOffset: 0, pageOffsetAuto: true, analyzedAt: Date.now() };
const book = { id, kind: 'book', version: 2, name: '수식 편집 시험', subject: 'math', createdBy: { id: 'teacher-a', name: '김선생' }, createdAt: Date.now(), updatedAt: Date.now(), docs: { problem: doc, answer: null }, answerOverrides: {} };
writeFileSync(join(dir, 'book.json'), JSON.stringify(book));
const cloud = fakeCloud({ dir: join(tmp, 'cloud'), academyDir: academy, subjects: ['math'], members: [{ id: 'teacher-a', name: '김선생', role: 'teacher' }] });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let win;
const errors = [];
const passed = new Set();
const mark = (id) => { passed.add(id); console.log(`A1 ${id} 통과`); };
const script = () => win.locator('.answer-equation-script');
const preview = () => win.locator('.answer-equation-preview');
const eqModal = () => win.locator('.answer-equation-modal');
const picker = () => win.locator('.eq-picker');
const call = (fn, ...args) => win.evaluate(([f, a]) => window.ohdap[f](...a), [fn, args]);
const select = async (start, end = start) => script().evaluate((el, [a, b]) => { el.focus(); el.setSelectionRange(a, b); }, [start, end]);
const range = () => script().evaluate((el) => [el.selectionStart, el.selectionEnd]);
const shot = async (name) => {
  await win.evaluate(async () => Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect.getComputedTiming().endTime)).map((a) => a.finished.catch(() => {}))));
  await win.screenshot({ path: join(OUT, `eqeditor-${name}.png`) });
};
const fill = async (text) => { await script().fill(text); await select(text.length); };
const waitForFile = async (file) => {
  const until = Date.now() + 5000;
  while (!existsSync(file) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(file), '수식 파일 저장');
};
const nativeKey = (key, modifiers = []) => app.evaluate(({ BrowserWindow }, { key, modifiers }) => {
  const window = BrowserWindow.getAllWindows()[0];
  window.focus();
  const contents = window.webContents;
  contents.focus();
  contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
  contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
}, { key, modifiers });
const saved = async () => {
  await win.waitForFunction(() => document.querySelector('.answer-status')?.textContent === '저장됨');
  return (await call('getAnswers', id)).items[item.id];
};
const open = async () => {
  await win.locator('.answer-editor-modal').getByRole('button', { name: '수식', exact: true }).click();
  await win.waitForSelector('.answer-equation-modal');
};
function sectionXml(bytes) {
  const buf = Buffer.from(bytes);
  const end = buf.lastIndexOf(Buffer.from([80, 75, 5, 6]));
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const length = buf.readUInt16LE(at + 28);
    const name = buf.toString('utf8', at + 46, at + 46 + length);
    const local = buf.readUInt32LE(at + 42);
    if (name === 'Contents/section0.xml') {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + buf.readUInt32LE(at + 20));
      return (buf.readUInt16LE(at + 10) === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    at += 46 + length + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  throw new Error('HWPX 본문 없음');
}

try {
  app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', ROOT], env: { ...env, OHDAP_E2E: '1', OHDAP_USER_DATA: join(tmp, 'local'), MAGOEDU_DEV: '1', MAGOEDU_ACADEMY: '테스트학원', MAGOEDU_ACADEMY_DIR: academy, MAGOEDU_DATA_DIR: join(tmp, 'data'), MAGOEDU_LOCAL_DIR: join(tmp, 'local'), MAGOEDU_USER_ID: 'teacher-a', MAGOEDU_USER_NAME: '김선생', MAGOEDU_ROLE: 'teacher', ...cloud.env } });
  win = await app.firstWindow();
  win.on('pageerror', (error) => errors.push(error.message));
  win.setDefaultTimeout(15000);
  await win.waitForSelector('.topbar');
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    BrowserWindow.getAllWindows()[0].setSize(1040, 850);
    globalThis.eqMenuHits = [];
    globalThis.eqNativeInputs = [];
    contents.on('before-input-event', (_event, input) => { if (input.type === 'keyDown') globalThis.eqNativeInputs.push(input.key); });
    contents.print = () => globalThis.eqMenuHits.push('print');
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '시험 메뉴', submenu: [
      { label: '새로고침', accelerator: 'Ctrl+R', role: 'reload' },
      ...['N', 'D', 'O', 'S', 'I', 'L', 'E', '9', '0', 'P', 'M'].map((key) => ({ label: key, accelerator: `Ctrl+${key}`, click: () => { globalThis.eqMenuHits.push(key); if (key === 'P') contents.print(); } })),
    ] }]));
  });
  await win.evaluate(async (id) => {
    window.eqSessionMarker = '편집 중';
    const { openAnswerEditor } = await import('./js/answer-editor.js');
    const book = await window.ohdap.getBook(id);
    window.answerClosed = openAnswerEditor({ book, item: book.docs.problem.items[0] });
  }, id);
  await win.waitForSelector('.answer-editor-modal');
  await win.locator('.answer-document').focus();
  await nativeKey('N', ['control']);
  await win.keyboard.press('m');
  await win.waitForSelector('.answer-equation-modal');
  assert.equal(await script().inputValue(), '');
  mark(1);
  assert.ok(await eqModal().evaluate((el) => el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth && el.scrollWidth <= el.clientWidth), '1040px 가로 넘침 없음');

  for (const [id, key, text, tag] of [[2, 'Shift+6', 'x^2', 'msup'], [3, 'Shift+-', 'x_2', 'msub']]) {
    await fill('x'); await win.keyboard.press(key); await win.keyboard.type('2');
    assert.equal(await script().inputValue(), text);
    assert.equal(await preview().locator(tag).count(), 1); mark(id);
  }
  const templates = [
    [4, 'D', 'hat {}', 'mover'], [5, 'O', '{} over {}', 'mfrac'], [6, 'R', 'sqrt {}', 'msqrt'],
    [7, 'S', 'sum _{}^{}', 'munderover'], [8, 'I', 'int _{}^{}', 'msubsup'], [9, 'L', 'lim _{}', 'munder'],
    [10, 'E', 'rel -> {} {}', 'munderover'], [11, '9', 'LEFT ( {} RIGHT )', 'mo[stretchy="true"]'],
    [12, '0', 'cases {{} & {} # {} & {}}', 'mtable'], [13, 'P', 'pile {{} # {}}', 'mtable'], [14, 'M', 'matrix {{} & {} # {} & {}}', 'mtable'],
  ];
  for (const [id, key, text, tag] of templates) {
    await fill(''); await nativeKey(key, ['control']);
    await win.waitForFunction((expected) => document.querySelector('.answer-equation-script')?.value === expected, text);
    assert.ok(await preview().locator(tag).count(), text);
    assert.ok(await picker().isVisible());
    assert.equal(await eqModal().count(), 1);
    assert.equal(await win.evaluate(() => window.eqSessionMarker), '편집 중', '새로고침 없음');
    assert.deepEqual(await app.evaluate(() => globalThis.eqMenuHits), [], 'Electron 메뉴 가로채기 없음');
    await win.keyboard.press('Escape');
    assert.ok(await picker().isHidden()); mark(id);
  }
  await nativeKey('N', ['control']);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.ok((await app.evaluate(() => globalThis.eqNativeInputs)).includes('r'), '실제 before-input-event 경로를 거침');

  await fill('a'); await win.keyboard.press('Enter'); await win.keyboard.type('b');
  assert.equal(await script().inputValue(), 'a#b');
  assert.equal(await preview().locator('mtr').count(), 2); mark(15);
  await win.keyboard.press('F1');
  await win.waitForSelector('.eq-help-modal');
  assert.equal(await win.locator('.eq-help-table').first().locator('tbody tr').count(), 22);
  await shot('shortcuts');
  await win.locator('.eq-help-modal .modal-footer').getByRole('button', { name: '닫기', exact: true }).click();
  await win.waitForSelector('.eq-help-modal', { state: 'detached' }); mark(16);

  await fill(''); await win.keyboard.press('Control+o');
  await win.keyboard.type('a+b'); await win.keyboard.press('Tab');
  assert.deepEqual(await range(), [12, 12]); mark(18);
  await win.keyboard.type('c'); await win.keyboard.press('Shift+Tab');
  assert.deepEqual(await range(), [1, 4]); mark(19);
  await win.keyboard.press('Tab');
  assert.deepEqual(await range(), [12, 13]);
  await eqModal().getByLabel('가운데 수식으로 넣기').check();
  await shot('fraction');
  await win.keyboard.press('Shift+Escape');
  await win.waitForSelector('.answer-equation-modal', { state: 'detached' });
  assert.equal(await win.locator('.answer-document .answer-display').getAttribute('data-eq'), '{a+b} over {c}');
  const entry = await saved();
  assert.ok(entry.blocks.some((b) => b.type === 'math' && b.eq === '{a+b} over {c}')); mark(17);

  await win.locator('.answer-document [data-eq]').focus(); await win.keyboard.press('p');
  await win.waitForSelector('.answer-equation-modal');
  assert.equal(await script().inputValue(), '{a+b} over {c}');
  assert.ok(await eqModal().getByLabel('가운데 수식으로 넣기').isChecked()); mark(22);
  await preview().locator('mi').filter({ hasText: /^b$/ }).click();
  assert.deepEqual(await range(), [3, 4], '위 수식을 누르면 그 원문 범위 선택');
  await fill('바뀐 수식');
  assert.equal(await win.locator('.answer-document [data-eq]').getAttribute('data-eq'), '{a+b} over {c}', '확정 전 본문 불변');
  await eqModal().getByRole('button', { name: '취소', exact: true }).click();
  await win.getByText('고친 수식을 버릴까요? 원래 수식은 그대로 남아요.').waitFor();
  await shot('cancel');
  await win.locator('.modal-overlay:not(.closing)').last().getByRole('button', { name: '취소', exact: true }).click();
  assert.equal(await script().inputValue(), '바뀐 수식');
  await win.keyboard.press('Escape');
  await win.locator('.modal-overlay:not(.closing)').last().getByRole('button', { name: '버리기', exact: true }).click();
  await win.waitForSelector('.answer-equation-modal', { state: 'detached' });
  assert.equal(await win.locator('.answer-document [data-eq]').getAttribute('data-eq'), '{a+b} over {c}');
  assert.deepEqual((await saved()).blocks, entry.blocks); mark(21);

  await open();
  await fill(''); await win.keyboard.press('Backslash'); await win.keyboard.type('x');
  assert.equal(await script().inputValue(), '\\x');
  assert.equal(await preview().locator('mi[mathvariant="normal"]').count(), 1); mark(20);
  await preview().focus(); await win.keyboard.press('Backslash');
  await eqModal().getByLabel('넣을 명령').fill('alpha'); await win.keyboard.press('Enter');
  assert.ok((await script().inputValue()).includes('alpha'));
  assert.ok(await picker().isHidden());

  console.log('▶ 고르기 대체·감싸기·행렬 크기·기호 표·오류·조합 중 입력');
  await fill('x+1'); await select(0, 3); await win.keyboard.press('Control+r');
  assert.equal(await script().inputValue(), 'sqrt {x+1}');
  await picker().getByRole('button', { name: 'n제곱근', exact: true }).click();
  assert.equal(await script().inputValue(), 'root {x+1} of {}', '기본 틀을 다른 종류로 대체');
  await fill(''); await win.keyboard.press('Control+m');
  await eqModal().getByLabel('행렬 줄 수').fill('3'); await eqModal().getByLabel('행렬 칸 수').fill('4');
  await picker().getByRole('button', { name: '대괄호 행렬', exact: true }).click();
  assert.equal(await preview().locator('mtr').count(), 3);
  assert.equal(await preview().locator('mtd').count(), 12);
  await shot('matrix');
  await eqModal().getByRole('button', { name: '기호·문자표', exact: true }).click();
  await picker().getByRole('button', { name: '화살표', exact: true }).click();
  await picker().getByRole('button', { name: 'LRARROW', exact: true }).click();
  assert.ok((await script().inputValue()).includes('LRARROW'));
  assert.ok((await preview().textContent()).includes('⇔'));

  await fill('{x} over {sqrt {} + {y}}'); await select(1, 2);
  await win.keyboard.press('Tab');
  assert.deepEqual(await range(), [16, 16]);
  await win.keyboard.press('Shift+Tab');
  assert.deepEqual(await range(), [1, 2]);
  await fill('x^a'); await win.keyboard.press('Tab'); await win.keyboard.type('y');
  assert.equal(await script().inputValue(), 'x^a y');
  assert.equal(await preview().locator('msup mi').count(), 2, 'Tab 뒤 글자는 첨자 밖');
  await fill('bold {x}'); await select(6, 7); await win.keyboard.press('Tab'); await win.keyboard.type('y');
  assert.equal(await script().inputValue(), 'bold {x} rm y');
  assert.equal(await preview().locator('mi').last().evaluate((el) => getComputedStyle(el).fontWeight), '400', 'Tab 뒤 글자는 굵게 해제');
  await eqModal().getByLabel('수식 보기 확대').selectOption('1.5');
  assert.equal(await preview().evaluate((el) => getComputedStyle(el).fontSize), '48px');
  await eqModal().getByLabel('수식 보기 확대').selectOption('1');

  console.log('▶ 자주 쓰는 수식·JSON·MathML·글자 색');
  await fill('sqrt {x}');
  await eqModal().getByRole('button', { name: '자주 쓰는 수식', exact: true }).click();
  await picker().getByLabel('자주 쓰는 수식 이름').fill('근호 견본');
  await picker().getByRole('button', { name: '현재 수식 등록', exact: true }).click();
  const macroFile = join(tmp, 'macros.json');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, macroFile);
  await picker().getByRole('button', { name: 'JSON 저장', exact: true }).click();
  await waitForFile(macroFile);
  await picker().getByRole('button', { name: '목록 닫기', exact: true }).click();
  await fill('');
  await eqModal().getByRole('button', { name: '자주 쓰는 수식', exact: true }).click();
  await picker().getByRole('button', { name: '근호 견본', exact: true }).click();
  assert.equal(await script().inputValue(), 'sqrt {x}');
  assert.deepEqual(JSON.parse(readFileSync(macroFile, 'utf8')), [{ name: '근호 견본', script: 'sqrt {x}' }]);
  await eqModal().getByRole('button', { name: '글자·파일', exact: true }).click();
  const mathFile = join(tmp, 'equation.mml');
  await shot('format');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, mathFile);
  await picker().getByRole('button', { name: 'MathML 저장', exact: true }).click();
  await waitForFile(mathFile);
  await picker().getByRole('button', { name: '목록 닫기', exact: true }).click();
  await fill('');
  await eqModal().getByRole('button', { name: '글자·파일', exact: true }).click();
  const chooser = win.waitForEvent('filechooser');
  await picker().getByRole('button', { name: 'MathML 불러오기', exact: true }).click();
  await (await chooser).setFiles(mathFile);
  await win.waitForFunction(() => document.querySelector('.answer-equation-script').value === 'sqrt {x}');
  assert.equal(await preview().locator('msqrt').count(), 1);
  await fill('x'); await select(0, 1);
  await eqModal().getByRole('button', { name: '글자·파일', exact: true }).click();
  await picker().getByLabel('수식 글자 색').fill('#123456');
  await picker().getByRole('button', { name: '글자 색 넣기', exact: true }).click();
  assert.equal(await script().inputValue(), 'COLOR {18,52,86}{x}');
  assert.equal(await preview().locator('mi').evaluate((el) => getComputedStyle(el).color), 'rgb(18, 52, 86)');

  await fill('bar {AB} = vec {AB} + hat {x} + bar {x} + {{a} over {b}} + bar {AB}');
  assert.equal(await eqModal().locator('.eq-notice').innerText(), '');
  const border = await preview().evaluate(el => getComputedStyle(el).borderColor);
  await fill('sqr {x}');
  assert.equal(await eqModal().locator('.eq-notice').innerText(), '\u0060sqr\u0060 을(를) 확인하세요. 지금 모양으로도 들어가요.');
  assert.equal(await preview().evaluate(el => getComputedStyle(el).borderColor), border);
  assert.deepEqual(await eqModal().locator('.eq-notice').evaluate(el => ({ color: getComputedStyle(el).color, weight: getComputedStyle(el).fontWeight })), { color: 'rgb(107, 118, 132)', weight: '400' });
  await fill('"<script>" + sqrt { unknownword');
  assert.match(await eqModal().locator('.eq-notice').innerText(), /확인/);
  assert.equal(await preview().locator('script').count(), 0);
  const before = await script().inputValue();
  const composing = await script().evaluate((el) => {
    const keys = [{ key: 'r', code: 'KeyR', ctrlKey: true }, { key: 'Tab', code: 'Tab' }, { key: 'Escape', code: 'Escape' }, { key: 'Enter', code: 'Enter' }];
    return keys.map((key) => !el.dispatchEvent(new KeyboardEvent('keydown', { ...key, isComposing: true, bubbles: true, cancelable: true })));
  });
  assert.deepEqual(composing, [false, false, false, false]);
  assert.equal(await script().inputValue(), before);
  assert.equal(await eqModal().count(), 1);
  await shot('warning');
  await win.keyboard.press('Shift+Escape');
  await win.waitForSelector('.answer-equation-modal', { state: 'detached' });
  assert.ok((await saved()).blocks.some((b) => b.eq === before || b.runs?.some((r) => r.eq === before)), '오류도 넣기를 막지 않음');

  console.log('▶ 자동 저장 → 다시 열기 → HWPX 원문·빈칸 보존');
  await open(); await fill('{} over {x}'); await win.keyboard.press('Shift+Escape');
  await win.waitForSelector('.answer-equation-modal', { state: 'detached' }); await saved();
  const bytes = await win.evaluate(async (id) => {
    const { makeBlocks } = await import('./js/exporter.js');
    const { buildHwpx } = await import('./js/hwpx.js');
    const { attachAnswers } = await import('./js/answers.js');
    const book = await window.ohdap.getBook(id);
    const entries = [{ bookId: id, problem: book.docs.problem.items[0], answer: null }];
    await attachAnswers(entries);
    return [...await buildHwpx({ blocks: makeBlocks('answers', entries, {}, () => 'p.1'), title: '수식 시험' })];
  }, id);
  const xml = sectionXml(bytes);
  assert.match(xml, /<hp:equation\b/);
  assert.match(xml, /<hp:script>\{a\+b\} over \{c\}<\/hp:script>/);
  assert.match(xml, /<hp:script>\{\} over \{x\}<\/hp:script>/);
  assert.doesNotMatch(xml, /□|data-eq-/);
  await win.locator('.answer-editor-modal .modal-footer').getByRole('button', { name: '닫기', exact: true }).click();
  await win.waitForSelector('.answer-editor-modal', { state: 'detached' });
  const stored = JSON.parse(readFileSync(join(dir, 'answers.json'), 'utf8')).items[item.id];
  assert.ok(stored.blocks.some((b) => b.type === 'math' && b.eq === '{a+b} over {c}'));

  console.log('▶ 편집기 밖 메뉴 동작 복구');
  await win.locator('body').click({ position: { x: 10, y: 10 } });
  await nativeKey('P', ['control']);
  await app.evaluate(async () => {
    const until = Date.now() + 3000;
    while (!globalThis.eqMenuHits.length && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.deepEqual(await app.evaluate(() => globalThis.eqMenuHits), ['P', 'print']);
  await nativeKey('R', ['control']);
  await win.waitForFunction(() => window.eqSessionMarker === undefined);
  await win.waitForSelector('.topbar');
  assert.deepEqual([...passed].sort((a, b) => a - b), Array.from({ length: 22 }, (_, i) => i + 1));
  assert.deepEqual(errors, []);
  console.log('수식 편집기 E2E 통과 · A1 22/22');
} catch (error) {
  console.error('화면 오류:', errors);
  if (win && !win.isClosed()) { await shot('failure').catch(() => {}); console.log(await win.locator('body').innerText().catch(() => '')); }
  throw error;
} finally {
  if (app) await app.close();
  cloud.stop();
  rmSync(tmp, { recursive: true, force: true });
}
