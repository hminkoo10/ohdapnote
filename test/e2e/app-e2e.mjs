// Electron 앱 E2E
//  예전 데이터 옮기기 → 책 등록 → 문제집/답지 따로 분석 → 인식 결과·검토 편집
//  → 학생 오답노트 만들기 → 문항 고르기 → 시험지 PDF 4종 → 사진 책(OCR) → 재실행 후 유지 확인
// 실행: xvfb-run -a node test/e2e/app-e2e.mjs
import { _electron as electron } from '../lib/playwright.mjs';
import { mkdtempSync, existsSync, statSync, mkdirSync, rmSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIX = join(ROOT, 'test/fixtures/generated');
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'ohdap-e2e-'));
const electronPath = require('electron');

// 예전 버전(책+선택이 한 파일) 데이터 하나 만들어 두기 → 처음 켤 때 책 + 오답노트로 옮겨져야 함
const oldId = '11111111-2222-3333-4444-555555555555';
const oldDir = join(userData, 'data', 'projects', oldId);
mkdirSync(oldDir, { recursive: true });
copyFileSync(join(FIX, 'book-serial.pdf'), join(oldDir, 'problem-old-000.pdf'));
writeFileSync(
  join(oldDir, 'project.json'),
  JSON.stringify({
    id: oldId,
    name: '예전 오답노트',
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
    docs: { problem: { files: [{ name: 'problem-old-000.pdf', originalName: 'book-serial.pdf', kind: 'pdf' }], originalName: 'book-serial.pdf', pageCount: 0, range: '', options: { flow: 'column', numberStyle: 'auto' }, pageOffset: 0, pageOffsetAuto: true, items: [], pageInfo: {}, analyzedAt: null }, answer: null },
    selected: [],
    answerOverrides: {},
  }),
);

const packagedExe = process.env.OHDAP_EXE;
const launch = () =>
  electron.launch({
    executablePath: packagedExe || electronPath,
    args: packagedExe ? ['--no-sandbox'] : ['--no-sandbox', ROOT],
    env: { ...process.env, OHDAP_E2E: '1', OHDAP_USER_DATA: userData },
  });

const step = (name) => console.log(`▶ ${name}`);
const errors = [];
let app = await launch();
let win = await app.firstWindow();
const watch = (w) => {
  w.on('console', (m) => {
    if (m.type() === 'error' && !/diacritics/.test(m.text())) {
      errors.push(m.text());
      console.log('[renderer error]', m.text());
    }
  });
  w.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('[pageerror]', e.message);
  });
};
watch(win);
const shot = (name) => win.screenshot({ path: join(OUT, `app-${name}.png`) });
const stubOpen = (paths) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p }); }, paths);
const stubSave = (p) => app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, p);
const waitToast = (text, timeout = 60000) => win.waitForFunction((t) => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(t)), text, { timeout });
const clearToasts = () => win.$$eval('.toast', (els) => els.forEach((e) => e.remove()));

try {
  step('홈 화면 + 예전 데이터 옮기기');
  await win.waitForSelector('.seg-tabs .seg-tab', { timeout: 20000 });
  await win.waitForTimeout(900);
  await shot('1-home-notes');
  const migratedNotes = await win.$$eval('.note-card .nc-title', (els) => els.map((e) => e.textContent));
  if (!migratedNotes.includes('예전 오답노트')) throw new Error('예전 오답노트가 옮겨지지 않았습니다: ' + migratedNotes);
  if (existsSync(join(userData, 'data', 'projects', oldId))) throw new Error('예전 폴더가 남아 있습니다');
  if (!existsSync(join(userData, 'data', 'books', oldId, 'problem-old-000.pdf'))) throw new Error('예전 파일이 책 폴더로 옮겨지지 않았습니다');

  step('책장 → 새 책 등록');
  await win.click('.seg-tab[data-tab="books"]');
  await win.waitForSelector('.book-card', { timeout: 5000 });
  await win.waitForTimeout(500);
  await shot('2-home-books');
  await win.click('.card-new:has-text("새 책 등록")');
  await win.fill('.modal input', '테스트 수학Ⅰ');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.doc-card[data-role="problem"] .drop-zone');

  step('문제집/답지 올리기');
  await stubOpen([join(FIX, 'book-unit.pdf')]);
  await win.click('.doc-card[data-role="problem"] .drop-zone');
  await win.waitForSelector('.doc-card[data-role="problem"] .doc-foot');
  await stubOpen([join(FIX, 'answer-unit.pdf')]);
  await win.click('.doc-card[data-role="answer"] .drop-zone');
  await win.waitForSelector('.doc-card[data-role="answer"] .doc-foot');
  await win.waitForTimeout(500);
  await shot('3-book-uploaded');

  step('문제집만 분석 → 답지만 분석 (따로따로)');
  await win.click('.doc-card[data-role="problem"] .doc-foot .btn');
  await win.waitForSelector('.doc-card[data-role="problem"] .sum-main', { timeout: 120000 });
  const ansAnalyzedEarly = await win.$('.doc-card[data-role="answer"] .sum-main');
  if (ansAnalyzedEarly) throw new Error('답지까지 같이 분석되었습니다');
  await win.click('.doc-card[data-role="answer"] .doc-foot .btn');
  await win.waitForSelector('.doc-card[data-role="answer"] .sum-main', { timeout: 120000 });
  await clearToasts();
  await win.click('.mini-seg button >> nth=0');
  await win.waitForTimeout(400);
  const chips = await win.$$eval('.qtable .chip:not(.missing)', (els) => els.map((e) => e.textContent));
  console.log('    chips:', chips.join(','));
  if (chips.length !== 24) throw new Error(`문항 수가 다릅니다: ${chips.length}`);
  await win.locator('.qtable .chip').nth(5).hover();
  await win.waitForSelector('.result-side .preview-img[src^="data:"]', { timeout: 15000 });
  await win.waitForTimeout(600);
  await shot('4-book-result');

  step('페이지 검토: 번호 고치기 → 빠진 번호 표시 → 문제없음 → 새 상자');
  await win.click('.tabs-row .seg-tab[data-tab="review"]');
  await win.waitForSelector('.page-overlay .box', { timeout: 20000 });
  await win.waitForTimeout(900);
  // 첫 쪽 두 번째 문항 번호를 바꿔서 번호가 끊기게 함
  await win.locator('.page-overlay .box').nth(1).click();
  await win.fill('.input-num', '9');
  await win.press('.input-num', 'Enter');
  await win.waitForTimeout(300);
  const labels = await win.$$eval('.page-overlay .box-label', (els) => els.map((e) => e.textContent));
  if (!labels.includes('9')) throw new Error('번호 수정이 반영되지 않았습니다: ' + labels.join(','));
  const missRows = await win.$$eval('.page-row .pr-miss', (els) => els.length);
  console.log('    빠진 번호 표시된 쪽:', missRows);
  if (!missRows) throw new Error('빠진 번호 표시가 없습니다');
  await shot('5-review-missing');
  await win.click('.editor-hint .btn-ok');
  await win.waitForTimeout(300);
  await win.click('.editor-toolbar .tb-group:nth-child(2) .btn >> nth=0'); // 문항 추가
  const ov = await (await win.$('.page-overlay')).boundingBox();
  const before = await win.$$eval('.page-overlay .box', (els) => els.length);
  await win.mouse.move(ov.x + ov.width * 0.12, ov.y + ov.height * 0.30);
  await win.mouse.down();
  await win.mouse.move(ov.x + ov.width * 0.4, ov.y + ov.height * 0.36, { steps: 5 });
  await win.mouse.up();
  await win.waitForTimeout(300);
  const nBoxes = await win.$$eval('.page-overlay .box', (els) => els.length);
  console.log('    boxes after draw:', before, '→', nBoxes);
  if (nBoxes !== before + 1) throw new Error('새 상자가 그려지지 않았습니다');
  await win.click('.editor-toolbar .btn >> text=삭제');
  await win.waitForTimeout(200);
  // 원래 번호로 되돌림
  await win.locator('.page-overlay .box', { hasText: /^9$/ }).first().click();
  await win.fill('.input-num', '2');
  await win.press('.input-num', 'Enter');
  await win.waitForTimeout(300);
  await shot('6-review-edited');

  step('홈 → 새 학생 오답노트 (책 고르기)');
  await win.click('#back-btn');
  await win.waitForSelector('.seg-tab[data-tab="notes"]');
  await win.click('.seg-tab[data-tab="notes"]');
  await win.click('.card-new:has-text("새 오답노트")');
  await win.waitForSelector('.modal .book-opt');
  await win.fill('.modal .field-v >> nth=0 >> input', '김하늘');
  await win.fill('.modal .field-v >> nth=1 >> input', '중간고사 대비 오답');
  await win.locator('.modal .book-opt', { hasText: '테스트 수학' }).click();
  await win.waitForTimeout(250);
  await shot('7-new-note');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.qtable .chip', { timeout: 30000 });

  step('문항 고르기 + 미리보기');
  const chip = (k) => win.locator('.qtable .chip:not(.missing)').nth(k);
  await chip(0).click();
  await chip(5).click();
  await chip(16).hover();
  await win.waitForTimeout(500);
  await win.fill('.select-toolbar .input', '3쪽: 2, 4');
  await win.press('.select-toolbar .input', 'Enter');
  await win.waitForTimeout(300);
  const selCount = await win.$$eval('.qtable .chip.on', (els) => els.length);
  console.log('    selected:', selCount);
  if (selCount !== 4) throw new Error(`선택 수가 다릅니다: ${selCount}`);
  await win.waitForSelector('.select-side .preview-img[src^="data:"]', { timeout: 15000 });
  await win.fill('.exam-field [data-key="academy"]', '한빛수학학원');
  await win.fill('.exam-field [data-key="teacher"]', '박선생');
  await win.waitForTimeout(600);
  await shot('8-note-select');

  step('시험지 PDF 4종');
  for (const mode of ['problems', 'answers', 'both-inline', 'both-end']) {
    const out = join(OUT, `app-export-${mode}.pdf`);
    rmSync(out, { force: true });
    await stubSave(out);
    await win.click(`.export-btn[data-mode="${mode}"]`);
    await waitToast('저장했어요');
    await clearToasts();
    if (!existsSync(out) || statSync(out).size < 1000) throw new Error(`${mode} PDF 생성 실패`);
    console.log(`    ${mode}: ${statSync(out).size} bytes`);
  }

  step('설정 창 (학원·선생님 기본값, Gemini 1·2순위)');
  await win.click('#settings-btn');
  await win.waitForSelector('.modal .settings');
  await win.waitForTimeout(500);
  await shot('9-settings');
  await win.fill('.settings .set-card >> nth=0 >> input >> nth=0', '기본학원');
  await win.click('.modal-footer .btn-primary');
  await win.waitForTimeout(400);
  const saved = await win.evaluate(() => window.ohdap.getSettings());
  if (saved.academy !== '기본학원' || !('geminiModel2' in saved)) throw new Error('설정 저장 실패: ' + JSON.stringify(saved));

  step('사진(JPG 3장) 책 → OCR 인식');
  await win.click('#back-btn');
  await win.waitForSelector('.seg-tab[data-tab="books"]');
  await win.click('.seg-tab[data-tab="books"]');
  await win.click('.card-new:has-text("새 책 등록")');
  await win.fill('.modal input', '사진 문제집');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.doc-card[data-role="problem"] .drop-zone');
  await stubOpen([3, 1, 2].map((i) => join(FIX, 'photos', `photo-${i}.jpg`)));
  await win.click('.doc-card[data-role="problem"] .drop-zone');
  await win.waitForSelector('.doc-card[data-role="problem"] .doc-foot .btn-primary');
  await win.click('.doc-card[data-role="problem"] .doc-foot .btn-primary');
  await win.waitForSelector('.doc-card[data-role="problem"] .sum-main', { timeout: 180000 });
  const ocrChips = await win.$$eval('.qtable .chip:not(.missing)', (els) => els.map((e) => e.textContent));
  console.log('    OCR chips:', ocrChips.join(','));
  if (ocrChips.length < 22) throw new Error(`OCR 인식 수가 너무 적습니다: ${ocrChips.length}`);
  await win.waitForTimeout(400);
  await shot('10-photos');

  step('재실행 후 저장 내용 확인');
  await win.click('#back-btn');
  await win.waitForSelector('.seg-tabs');
  await app.close();
  app = await launch();
  win = await app.firstWindow();
  watch(win);
  await win.waitForSelector('.note-card', { timeout: 20000 });
  await win.waitForTimeout(1200);
  const stats = await win.$$eval('.note-card', (els) => els.map((e) => e.textContent));
  console.log('   ', stats);
  if (!stats.some((t) => t.includes('중간고사') && t.includes('4문항'))) throw new Error('선택 내용이 저장되지 않았습니다: ' + stats);
  await shot('11-home-after-restart');
  await win.locator('.note-card', { hasText: '중간고사' }).click();
  await win.waitForSelector('.qtable .chip.on', { timeout: 30000 });
  const onAfter = await win.$$eval('.qtable .chip.on', (els) => els.length);
  if (onAfter !== 4) throw new Error(`다시 열었을 때 선택 수가 다릅니다: ${onAfter}`);
  const academy = await win.$eval('.exam-field [data-key="academy"]', (e) => e.value);
  if (academy !== '한빛수학학원') throw new Error('노트별 학원 이름이 저장되지 않았습니다: ' + academy);

  step('예전 데이터 책 분석');
  await win.click('#back-btn');
  await win.waitForSelector('.seg-tab[data-tab="books"]');
  await win.click('.seg-tab[data-tab="books"]');
  await win.locator('.book-card', { hasText: '예전 오답노트' }).click();
  await win.waitForSelector('.doc-card[data-role="problem"] .doc-foot .btn-primary', { timeout: 20000 });
  await win.click('.doc-card[data-role="problem"] .doc-foot .btn-primary');
  await win.waitForSelector('.doc-card[data-role="problem"] .sum-main', { timeout: 120000 });
  const oldChips = await win.$$eval('.qtable .chip:not(.missing)', (els) => els.length);
  console.log('    예전 책 문항:', oldChips);
  if (oldChips !== 17) throw new Error(`예전 책 문항 수: ${oldChips}`);
  console.log('✅ E2E 통과');
} catch (err) {
  console.error('❌ E2E 실패:', err);
  await win.screenshot({ path: join(OUT, 'app-fail.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}
if (errors.length) {
  console.log('renderer errors:', errors.length);
  process.exitCode = 1;
}
