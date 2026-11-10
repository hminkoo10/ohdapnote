// 문제은행 E2E: 실제 PDF 분석·옮기기·검색·지문 담기·PDF/HWPX 저장·고친 글 공유
// 실행: NODE_PATH에 Playwright 경로를 지정한 뒤 node test/e2e/bank-e2e.mjs
import { _electron as electron } from '../lib/playwright.mjs';
import { fakeCloud } from '../lib/fake-cloud.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require('pdf-lib');
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });
const tempRoot = process.env.OHDAP_USER_DATA || OUT;
mkdirSync(tempRoot, { recursive: true });
const tmp = mkdtempSync(join(tempRoot, 'bank-temp-'));
const academy = join(tmp, 'academy');
const userData = join(tmp, 'local');
const dataDir = join(tmp, 'data');
mkdirSync(userData, { recursive: true });
const ids = { math: 'aaaaaaaa-0000-4000-8000-000000000001', english: 'bbbbbbbb-0000-4000-8000-000000000001', korean: 'cccccccc-0000-4000-8000-000000000001', scan: 'dddddddd-0000-4000-8000-000000000001' };
const doc = (file, items = []) => ({ files: [{ name: file, originalName: file, kind: 'pdf' }], originalName: file, pageCount: 1, range: '', options: { flow: 'column', numberStyle: 'auto' }, pageOffset: 0, pageOffsetAuto: true, items, pageInfo: {}, analyzedAt: items.length ? Date.now() : null });
const seed = (subject, name, creator = 'teacher-a', id = ids[subject]) => {
  const dir = join(academy, 'books', id);
  mkdirSync(dir, { recursive: true });
  const book = { id, kind: 'book', version: 2, name, subject, createdAt: Date.now(), updatedAt: Date.now(), createdBy: { id: creator, name: creator === 'teacher-a' ? '김선생' : '박선생' }, docs: { problem: null, answer: null }, answerOverrides: {} };
  return { dir, book, save: () => writeFileSync(join(dir, 'book.json'), JSON.stringify(book)) };
};
const math = seed('math', '수학 연습 교재');
for (const [role, file] of [['problem', 'book-unit.pdf'], ['answer', 'answer-unit.pdf']]) {
  copyFileSync(join(ROOT, 'test/fixtures/generated', file), join(math.dir, `${role}.pdf`));
  math.book.docs[role] = doc(`${role}.pdf`);
}
math.save();
const english = seed('english', '영어 지문 교재', 'teacher-b');
const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]);
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (const [text, y] of [['Read the passage. A quiet garden has many flowers.', 700], ['1. What can you find in the garden?', 600], ['2. Choose the best title for this passage.', 450]]) page.drawText(text, { x: 45, y, font, size: 14 });
const englishBytes = await pdf.save();
writeFileSync(join(english.dir, 'problem.pdf'), englishBytes);
const stem = [{ page: 0, x: 0.06, y: 0.14, w: 0.88, h: 0.05 }];
english.book.docs.problem = doc('problem.pdf', [0, 1].map((i) => ({ id: `english-${i + 1}`, page: 0, number: String(i + 1), num: i + 1, rects: [{ page: 0, x: 0.06, y: i ? 0.44 : 0.26, w: 0.88, h: 0.06 }], stem, stemLabel: '1~2' })));
english.save();
const korean = seed('korean', '국어 보기 전용 교재');
writeFileSync(join(korean.dir, 'problem.pdf'), englishBytes);
korean.book.docs.problem = doc('problem.pdf', [{ ...english.book.docs.problem.items[0], id: 'korean-1', stem: null }]);
korean.save();
const scan = seed('math', '스캔본 교재', 'teacher-a', ids.scan);
copyFileSync(join(ROOT, 'test/fixtures/generated/book-unit-scan.pdf'), join(scan.dir, 'problem.pdf'));
scan.book.docs.problem = doc('problem.pdf', [{ id: 'scan-1', page: 0, number: '1', num: 1, rects: [{ page: 0, x: 0, y: 0, w: 1, h: 1 }] }]);
scan.save();
const cloud = fakeCloud({ dir: join(tmp, 'cloud'), academyDir: academy, subjects: ['math', 'english'], members: [{ id: 'teacher-a', name: '김선생', role: 'teacher' }, { id: 'teacher-b', name: '박선생', role: 'teacher' }] });
let app;
let win;
const errors = [];
const step = (text) => console.log(`▶ ${text}`);
const call = (fn, ...args) => win.evaluate(([f, a]) => window.ohdap[f](...a), [fn, args]);
const stubSave = (file) => app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, file);
const closeFinished = async () => {
  await Promise.race([
    win.waitForSelector('.modal:not(.closing) .btn-primary:has-text("닫기")', { timeout: 120000 }),
    win.waitForSelector('.modal h3:has-text("수식 인식 모델이 필요해요")', { timeout: 120000 }).then(() => { throw new Error('디지털 PDF가 OCR 모델을 요구합니다.'); }),
  ]);
  await win.click('.modal .btn-primary:has-text("닫기")');
  await win.waitForSelector('.modal-overlay', { state: 'detached' });
};
const clearToasts = () => win.$$eval('.toast', (els) => els.forEach((el) => el.remove()));
const hwpxSection = (bytes) => {
  const buf = Buffer.from(bytes);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(end + 16);
  for (let k = 0; k < buf.readUInt16LE(end + 10); k++) {
    const len = buf.readUInt16LE(p + 28);
    const at = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + len) === 'Contents/section0.xml') {
      const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
      const data = buf.subarray(start, start + buf.readUInt32LE(p + 20));
      return (buf.readUInt16LE(p + 10) === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + len + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  throw new Error('HWPX 본문 없음');
};
const expectMissingModel = async (id) => {
  assert.equal((await call('mathocrStatus')).installed, false, '모델 없는 환경');
  await win.click(`.bank-book[data-book="${id}"] button`);
  await win.waitForSelector('.modal .bank-ai');
  assert.equal(await win.isChecked('.bank-ai input'), false);
  await win.click('.modal .btn-primary:has-text("넣기 시작")');
  const warning = win.locator('.modal', { has: win.locator('h3', { hasText: '수식 인식 모델이 필요해요' }) });
  await warning.waitFor({ timeout: 30000 });
  assert.match(await warning.innerText(), /설정에서 수식 인식 파일을 받아요/);
  await warning.getByRole('button', { name: '설정 열기', exact: true }).click();
  await win.waitForSelector('.settings-modal');
  await win.waitForFunction(async (bookId) => !(await import('./js/shared.js')).findJob(`bank:${bookId}`), id);
  const saved = await call('getTranscripts', id);
  assert.equal(Object.keys(saved?.items || {}).length, 0, '변환·저장하지 않고 멈춤');
  await win.locator('.settings-modal').getByRole('button', { name: '취소', exact: true }).click();
  await win.waitForSelector('.settings-modal', { state: 'detached' });
  await closeFinished();
  assert.equal(await win.locator(`.bank-book[data-book="${id}"] .bank-complete`).count(), 0);
  await clearToasts();
};
const put = async (id) => {
  await win.click(`.bank-book[data-book="${id}"] button`);
  await win.waitForSelector('.modal .bank-ai');
  assert.equal(await win.isChecked('.bank-ai input'), false, 'AI는 기본 꺼짐');
  await win.click('.modal .btn-primary:has-text("넣기 시작")');
  await closeFinished();
  await win.waitForSelector(`.bank-book[data-book="${id}"] .bank-complete`, { timeout: 10000 });
};

try {
  app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', ROOT], env: {
    ...process.env, OHDAP_E2E: '1', OHDAP_USER_DATA: userData,
    MAGOEDU_DEV: '1', MAGOEDU_ACADEMY: '테스트학원', MAGOEDU_ACADEMY_DIR: academy, MAGOEDU_DATA_DIR: dataDir, MAGOEDU_LOCAL_DIR: userData,
    MAGOEDU_USER_ID: 'teacher-a', MAGOEDU_USER_NAME: '김선생', MAGOEDU_ROLE: 'teacher', ...cloud.env,
  } });
  win = await app.firstWindow();
  win.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.stack || e.message); });
  win.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('[renderer error]', m.text()); } });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 900));
  await win.waitForSelector('.seg-tab[data-tab="bank"]', { timeout: 30000 });

  step('분석 안 된 교재 안내 → 책 열기 → 실제 문제집·답지 분석');
  await win.click('.seg-tab[data-tab="bank"]');
  await win.waitForSelector('.bank-book');
  assert.match(await win.textContent(`.bank-book[data-book="${ids.math}"]`), /책 분석이 필요해요/);
  await win.click(`.bank-book[data-book="${ids.math}"] button`);
  for (const role of ['problem', 'answer']) {
    await win.click(`.doc-card[data-role="${role}"] .doc-foot .btn`);
    await win.waitForSelector(`.doc-card[data-role="${role}"] .sum-main`, { timeout: 120000 });
  }
  await win.click('#back-btn');
  await win.waitForSelector('.seg-tab[data-tab="bank"]');
  await win.click('.seg-tab[data-tab="bank"]');
  await win.waitForSelector('.bank-row', { timeout: 30000 });
  await clearToasts();

  step('계약 과목·보기 전용 과목, 도움말, 1040px 화면');
  const locked = `.bank-book[data-book="${ids.korean}"]`;
  assert.ok(await win.$(`${locked}.bank-locked`));
  assert.equal(await win.locator(`${locked} button`).count(), 0, '계약 밖 교재는 넣기 버튼 없음');
  assert.ok(await win.isDisabled(`.bank-row[data-book="${ids.korean}"] input`));
  assert.ok(await win.$(`.bank-book[data-book="${ids.english}"] button`));
  assert.ok(await win.$('.bank-intro'));
  assert.equal(await win.locator('.bank-steps p:empty').count(), 0);
  await win.locator('.bank-intro').getByRole('button', { name: '닫기', exact: true }).click();
  assert.equal(await win.locator('.bank-intro').count(), 0);
  await win.getByRole('button', { name: '사용 순서', exact: true }).click();
  assert.ok(await win.$('.bank-intro'));
  assert.equal(await win.locator('.bank-steps p:empty').count(), 0);

  step('일반 글꼴 수학 PDF는 OCR 모델 필요 → 설정 열기 → 넣기 멈춤');
  await expectMissingModel(ids.math);
  step('스캔본 교재 넣기: 모델 안내 → 설정 열기 → 저장 없이 멈춤');
  await expectMissingModel(ids.scan);
  step('영어 교재를 PDF 글자로 넣기 (모델·AI 없이) → 다 넣었어요');
  await put(ids.english);
  assert.equal(existsSync(join(english.dir, 'transcripts.json')), false, '남의 책은 공유 폴더에 저장하지 않음');
  const ownTranscripts = join(academy, 'members', 'teacher-a', 'transcripts', `${ids.english}.json`);
  assert.equal(Object.keys(JSON.parse(readFileSync(ownTranscripts, 'utf8')).items).length, 3, '영어 지문 하나·문항 둘');
  assert.ok(Object.keys(JSON.parse(readFileSync(ownTranscripts, 'utf8')).items).every((k) => k.endsWith('|pdf')), 'PDF 경로만 사용');

  step('지문 글로 검색 → 세트 전체 담기, 번호 범위로 검색');
  await win.fill('[data-bank-focus="text"]', 'QUIETGARDEN');
  await win.waitForFunction(() => document.querySelectorAll('.bank-row').length === 2);
  await win.getByRole('button', { name: '세트 모두 담기', exact: true }).click();
  assert.equal(await win.locator('.bank-basket .sel-chip').count(), 2);
  assert.match(await win.textContent('.bank-basket'), /지문도 함께 들어가요/);
  await win.fill('[data-bank-focus="number"]', '2');
  await win.waitForFunction(() => document.querySelectorAll('.bank-row').length === 1);
  await win.getByRole('button', { name: '지우기', exact: true }).click();
  await win.selectOption('[data-bank-focus="bookId"]', ids.math);
  await win.fill('[data-bank-focus="number"]', '3-4');
  await win.waitForFunction(() => document.querySelectorAll('.bank-row').length === 4);
  await win.locator('.bank-row input').first().check();
  await win.locator('.bank-row').first().click();
  await win.waitForSelector('.bank-preview .bank-image');
  await win.waitForSelector('.bank-transcript button:has-text("글 고치기")');
  assert.ok(await win.$('.bank-preview img[alt="짝 해설 그림"]'));

  step('PDF 저장·쪽 수 확인 → 한글(HWPX) 저장');
  const pdfOut = join(tmp, '시험지.pdf');
  await stubSave(pdfOut);
  await win.click('.bank-basket .export-btn[data-mode="problems"]');
  await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes('저장 완료')), null, { timeout: 120000 });
  assert.ok((await PDFDocument.load(readFileSync(pdfOut))).getPageCount() > 0);
  await clearToasts();
  const hwpxOut = join(tmp, '시험지.hwpx');
  await stubSave(hwpxOut);
  await win.click('.bank-basket .seg label:has(input[name="bank-format"][value="hwpx"])');
  assert.ok(await win.isChecked('input[name="bank-convert"][value="ocr"]'), '한글 기본 옮기기는 OCR');
  await win.click('.bank-basket .export-btn[data-mode="both-end"]');
  await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes('저장 완료')), null, { timeout: 120000 });
  assert.equal(readFileSync(hwpxOut).subarray(0, 2).toString(), 'PK');
  assert.ok(readFileSync(hwpxOut).length > 1000);
  await clearToasts();

  step('글 고치기 저장 → 검색·목록·transcripts.json의 고친 글');
  const focused = await win.locator('.bank-row.active').getAttribute('data-item');
  await win.click('.bank-transcript[data-passage="false"] button:has-text("글 고치기")');
  await win.locator('.bank-edit-block textarea').first().fill('고쳐 쓴 이차함수 확인 문항');
  await win.click('.modal .btn-primary:has-text("저장")');
  await win.waitForSelector('.modal-overlay', { state: 'detached' });
  await win.fill('[data-bank-focus="text"]', '고쳐쓴이차함수');
  await win.waitForFunction(() => document.querySelectorAll('.bank-row').length === 1);
  assert.match(await win.textContent('.bank-row'), /고쳐 쓴 이차함수.*고침/s);
  const edited = JSON.parse(readFileSync(join(math.dir, 'transcripts.json'), 'utf8')).items;
  const edit = Object.entries(edited).find(([k]) => k.includes(`|${focused}|`) && k.endsWith('|edit'));
  assert.ok(edit);
  assert.deepEqual(edit[1].by, { id: 'teacher-a', name: '김선생' });

  step('공용 모듈: 오답노트 한글 내보내기도 고친 글 우선 (PDF·OCR·AI 다시 읽지 않음)');
  const sharedResult = await win.evaluate(async ([id, itemId]) => {
    const { getSources } = await import('./js/shared.js');
    const { exportHwpx, transcriptKey } = await import('./js/transcribe.js');
    const { makeBlocks } = await import('./js/exporter.js');
    const b = await window.ohdap.getBook(id);
    const src = await getSources(b);
    const e = { bookId: id, bookObj: b, problem: b.docs.problem.items.find((it) => it.id === itemId), src };
    const blocks = makeBlocks('problems', [e], {}, () => 'p.1');
    const original = src.problem.getMathLayer;
    let calls = 0;
    src.problem.getMathLayer = async () => { calls++; throw new Error('고친 문항은 PDF를 다시 읽으면 안 됨'); };
    try {
      const bytes = await exportHwpx(blocks, [e], { convert: 'ocr' }, { title: '공용 결과' }, { key: 'hwpx:regression', sig: '수정' });
      return { calls, text: bytes.stats.text, key: transcriptKey(blocks[0]) };
    } finally { src.problem.getMathLayer = original; }
  }, [ids.math, focused]);
  assert.equal(sharedResult.calls, 0);
  assert.equal(sharedResult.text, 1);
  assert.equal(edit[0], `${sharedResult.key}|edit`);

  step('일반 글꼴 PDF 내보내기: 은행의 비수학만 글자, 수학·오답노트는 원래대로');
  const pdfModes = await win.evaluate(async (id) => {
    const { getSources } = await import('./js/shared.js');
    const { exportHwpx, loadTranscripts, saveTranscripts } = await import('./js/transcribe.js');
    const b = await window.ohdap.getBook(id);
    const src = await getSources(b);
    const store = await loadTranscripts(id);
    const before = { ...store.items };
    const out = [];
    // 앞의 영어 변환으로 |pdf가 있어도 수학·오답노트에서 우회 사용하지 않음.
    try {
      for (const subject of ['english', 'korean', 'math', undefined]) {
        for (const plainPdf of [true, false]) {
          const e = { bookId: id, bookObj: { ...b, subject }, src: { problem: src.problem, answer: src.problem } };
          const blocks = ['problem', 'answer'].map((kind) => ({ kind, role: kind, item: b.docs.problem.items[0], src: src.problem, stem: null }));
          const bytes = await exportHwpx(blocks, [e], { convert: 'ocr', plainPdf }, { title: '과목별 PDF' }, { key: 'hwpx:pdf-mode', sig: `${subject}:${plainPdf}` });
          out.push(bytes.stats.text);
        }
      }
      return out;
    } finally {
      store.items = before;
      store.dirty = true;
      await saveTranscripts();
    }
  }, ids.english);
  assert.deepEqual(pdfModes, [2, 0, 2, 0, 0, 0, 0, 0]);

  step('오답노트 캐시: AI 켜기·키·OCR 모델·옮기기 방식의 원래 조건 유지');
  const cases = [
    { convert: 'ai', enabled: false, key: true, ocr: true, expected: null },
    { convert: 'ai', enabled: true, key: false, ocr: true, expected: null },
    { convert: 'ocr', enabled: true, key: true, ocr: false, expected: null },
    { convert: 'mix', enabled: false, key: true, ocr: false, expected: null },
    { convert: 'ocr', enabled: true, key: true, ocr: true, expected: 'OCR' },
    { convert: 'ai', enabled: true, key: true, ocr: true, expected: 'AI' },
    { convert: 'mix', enabled: true, key: true, ocr: true, expected: 'AI' },
    { convert: 'mix', enabled: false, key: true, ocr: true, expected: 'OCR' },
  ];
  await app.evaluate(({ ipcMain }) => {
    globalThis.bankOcrStatus = ipcMain._invokeHandlers.get('mathocr:status');
    ipcMain.removeHandler('mathocr:status');
    ipcMain.handle('mathocr:status', () => ({ installed: globalThis.bankOcrInstalled }));
  });
  try {
    for (const c of cases) {
      await app.evaluate((_, installed) => { globalThis.bankOcrInstalled = installed; }, c.ocr);
      const bytes = await win.evaluate(async ([id, c]) => {
        const { getSources, state } = await import('./js/shared.js');
        const { exportHwpx, loadTranscripts, transcriptKey } = await import('./js/transcribe.js');
        const { makeBlocks } = await import('./js/exporter.js');
        const b = await window.ohdap.getBook(id);
        const src = await getSources(b);
        const e = { bookId: id, bookObj: b, problem: b.docs.problem.items[0], src };
        const blocks = makeBlocks('problems', [e], {}, () => 'p.1');
        const store = await loadTranscripts(id);
        const key = transcriptKey(blocks[0]);
        const before = { items: { ...store.items }, settings: state.settings, getMathLayer: src.problem.getMathLayer };
        src.problem.getMathLayer = async () => null;
        state.settings = { ...state.settings, aiSource: 'personal', aiProvider: 'gemini', aiEnabled: c.enabled, geminiApiKey: c.key ? 'test-key' : '' };
        delete store.items[`${key}|edit`];
        for (const [suffix, name] of [['', 'AI'], ['|local', 'OCR'], ['|pdf', 'PDF']]) {
          store.items[key + suffix] = { blocks: [{ type: 'para', text: `${name}-CACHED-CONTENT` }], reliable: true, at: Date.now() };
        }
        try {
          return Array.from(await exportHwpx(blocks, [e], { convert: c.convert }, { title: '캐시 조건' }, { key: 'hwpx:cache-mode', sig: JSON.stringify(c) }));
        } finally {
          src.problem.getMathLayer = before.getMathLayer;
          state.settings = before.settings;
          store.items = before.items;
        }
      }, [ids.math, c]);
      const xml = hwpxSection(bytes);
      for (const name of ['AI', 'OCR', 'PDF']) assert.equal(xml.includes(`${name}-CACHED-CONTENT`), c.expected === name, JSON.stringify(c));
      if (!c.expected) assert.match(xml, /<hp:pic /, '쓸 결과가 없으면 그림');
    }
  } finally {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('mathocr:status');
      ipcMain.handle('mathocr:status', globalThis.bankOcrStatus);
    });
  }

  step('저장된 PDF·OCR·AI도 쓸 수 없으면 그림으로, 고친 글 우선 시험은 별도로 유지');
  const reused = await win.evaluate(async (id) => {
    const { getSources } = await import('./js/shared.js');
    const { exportHwpx, loadTranscripts, transcriptKey } = await import('./js/transcribe.js');
    const { makeBlocks } = await import('./js/exporter.js');
    const b = await window.ohdap.getBook(id);
    const src = await getSources(b);
    const e = { bookId: id, bookObj: b, problem: b.docs.problem.items[0], src };
    const blocks = makeBlocks('problems', [e], {}, () => 'p.1');
    const store = await loadTranscripts(id);
    const key = transcriptKey(blocks[0]);
    const original = src.problem.getMathLayer;
    const before = { ...store.items };
    src.problem.getMathLayer = async () => null;
    const out = [];
    try {
      for (const suffix of ['|pdf', '|local', '']) {
        delete store.items[key];
        delete store.items[`${key}|local`];
        delete store.items[`${key}|pdf`];
        store.items[key + suffix] = { blocks: [{ type: 'para', text: '저장해 둔 글' }], at: Date.now() };
        const bytes = await exportHwpx(blocks, [e], { convert: 'ocr' }, { title: '재사용' }, { key: 'hwpx:reuse', sig: suffix });
        out.push(bytes.stats.text);
      }
      return out;
    } finally { src.problem.getMathLayer = original; store.items = before; }
  }, ids.math);
  assert.deepEqual(reused, [0, 0, 0]);

  step('실시간 다시 그려도 찾는 말·입력 위치·미리보기·바구니 유지');
  await win.focus('[data-bank-focus="text"]');
  await win.evaluate(async () => { const { showHome } = await import('./js/home.js'); await showHome(); });
  await win.waitForSelector('.bank-row');
  await win.waitForFunction(() => document.activeElement?.dataset.bankFocus === 'text');
  assert.equal(await win.inputValue('[data-bank-focus="text"]'), '고쳐쓴이차함수');
  assert.equal(await win.locator('.bank-row.active').getAttribute('data-item'), focused);
  assert.equal(await win.locator('.bank-basket .sel-chip').count(), 3);
  assert.ok(await win.isChecked('input[name="bank-format"][value="hwpx"]'));

  step('지문 따로 고치기·원래대로, 계약 밖 교재 미리보기에는 고치기 없음');
  await win.getByRole('button', { name: '지우기', exact: true }).click();
  await win.selectOption('[data-bank-focus="bookId"]', ids.english);
  await win.waitForFunction(() => document.querySelectorAll('.bank-row').length === 2);
  await win.locator('.bank-row').first().click();
  await win.waitForSelector('.bank-transcript[data-passage="true"] button');
  await win.click('.bank-transcript[data-passage="true"] button');
  await win.locator('.bank-edit-block textarea').first().fill('지문을 따로 고쳤어요');
  await win.click('.modal .btn-primary:has-text("저장")');
  await win.waitForSelector('.modal-overlay', { state: 'detached' });
  await win.waitForSelector('.bank-transcript[data-passage="true"] button');
  assert.match(await win.textContent('.bank-set > .bank-snippet'), /지문을 따로 고쳤어요/);
  await win.click('.bank-transcript[data-passage="true"] button');
  await win.getByRole('button', { name: '원래대로', exact: true }).click();
  await win.waitForSelector('.modal-overlay', { state: 'detached' });
  assert.ok(Object.keys(JSON.parse(readFileSync(ownTranscripts, 'utf8')).items).every((k) => !k.endsWith('|edit')));

  step('백그라운드 진행·멈추기·중간 결과 저장 → 이어서 넣기');
  await win.evaluate(async (id) => {
    const { getSources, findJob } = await import('./js/shared.js');
    window.bankJob = () => findJob(`bank:${id}`);
    const { loadTranscripts, saveTranscripts, transcriptKey } = await import('./js/transcribe.js');
    const { bankTargets } = await import('./js/bank.js');
    const b = await window.ohdap.getBook(id);
    const src = await getSources(b);
    const store = await loadTranscripts(id);
    for (const target of bankTargets(b).filter((t) => !t.passage)) delete store.items[`${transcriptKey({ ...target, src: src.problem })}|pdf`];
    store.dirty = true;
    await saveTranscripts();
    const original = src.problem.getMathLayer.bind(src.problem);
    window.restoreBankSource = () => { window.releaseBankSource?.(); src.problem.getMathLayer = original; };
    src.problem.getMathLayer = async (p) => {
      // 마지막 문항은 취소를 누를 때까지 대기해 화면 응답 속도에 영향을 받지 않게 한다.
      if (window.bankJob()?.done === 2) {
        window.bankSourceBlocked = true;
        await new Promise((resolve) => { window.releaseBankSource = resolve; });
      }
      return original(p);
    };
    const { showHome } = await import('./js/home.js');
    await showHome();
  }, ids.english);
  await win.waitForSelector(`.bank-book[data-book="${ids.english}"] button:has-text("이어서 넣기")`);
  await win.click(`.bank-book[data-book="${ids.english}"] button`);
  await win.click('.modal .btn-primary:has-text("넣기 시작")');
  await win.click('.modal .btn-primary:has-text("다른 일 하면서 기다리기")');
  await win.waitForFunction(() => window.bankJob()?.done === 2 && window.bankSourceBlocked);
  await win.click(`.bank-book[data-book="${ids.english}"] button:has-text("진행 보기")`);
  await win.locator('.modal-footer').getByRole('button', { name: '작업 취소', exact: true }).click();
  await win.waitForFunction(() => window.bankJob()?.cancelled);
  await win.evaluate(() => window.releaseBankSource());
  await win.waitForFunction(() => !window.bankJob());
  assert.equal(Object.keys(JSON.parse(readFileSync(ownTranscripts, 'utf8')).items).length, 2, '지문·첫 문항을 중간 저장');
  await win.evaluate(() => window.restoreBankSource());
  await win.waitForSelector(`.bank-book[data-book="${ids.english}"] button:has-text("이어서 넣기")`);
  await put(ids.english);
  assert.equal(Object.keys(JSON.parse(readFileSync(ownTranscripts, 'utf8')).items).length, 3);

  await win.selectOption('[data-bank-focus="bookId"]', ids.korean);
  await win.waitForFunction(() => document.querySelectorAll('.bank-row').length === 1);
  await win.locator('.bank-row').click();
  await win.waitForSelector('.bank-preview .readonly-banner');
  assert.equal(await win.locator('.bank-preview button:not(.answer-open)').count(), 0);
  assert.equal(await win.locator('.bank-preview .answer-open').innerText(), '정답·해설 보기');
  assert.doesNotMatch(await win.textContent('.bank-transcript'), /null|undefined|문제은행에 넣기/);
  await clearToasts();
  await win.screenshot({ path: join(OUT, 'bank-1040.png') });
  assert.ok(await win.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.bank-columns > *')].every((e) => e.getBoundingClientRect().right <= window.innerWidth)), '1040px에서 가로 넘침 없음');
  assert.deepEqual(errors, []);
  console.log('✅ 문제은행 E2E 통과: PDF·HWPX·글 고치기·지문·과목 잠금·공용 저장소·실시간 유지');
} catch (err) {
  console.error('❌ 문제은행 E2E 실패:', err);
  if (win) {
    console.log(await win.evaluate(async () => {
      const out = [];
      for (const name of ['ui', 'subjects', 'bank', 'transcript-store', 'shared', 'transcribe', 'bank-transcribe', 'bankview', 'home']) {
        try { await import(`./js/${name}.js`); } catch (err) { out.push(`${name}: ${err.stack}`); }
      }
      return out;
    }).catch(() => []));
    console.log((await win.locator('body').innerText().catch(() => '')).slice(-7000));
    await win.screenshot({ path: join(OUT, 'bank-fail.png') }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (win) await win.evaluate(async () => {
    window.restoreBankSource?.();
    document.querySelectorAll('.modal').forEach((m) => m.close?.('cancel'));
    const { stopJobs } = await import('./js/shared.js');
    await stopJobs();
  }).catch(() => {});
  if (app) await app.close().catch(() => {});
  cloud.stop();
  // 임시 폴더가 이 worktree 안인지 확인하고 정리
  assert.ok(resolve(tmp).startsWith(resolve(tempRoot) + sep));
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (errors.length) process.exitCode = 1;
