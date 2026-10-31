// Electron 앱 E2E: 새 오답노트 → 파일 올리기 → 분석 → 선택 → PDF 3종 내보내기 → 검토 편집 → 재실행 후 유지 확인
// 실행: xvfb-run -a node test/e2e/app-e2e.mjs
import { _electron as electron } from '../lib/playwright.mjs';
import { mkdtempSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
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

const launch = () =>
  electron.launch({
    executablePath: electronPath,
    args: ['--no-sandbox', ROOT],
    env: { ...process.env, OHDAP_E2E: '1', OHDAP_USER_DATA: userData },
  });

const step = (name) => console.log(`▶ ${name}`);
const errors = [];
let app = await launch();
let win = await app.firstWindow();
win.on('console', (m) => {
  if (m.type() === 'error') {
    errors.push(m.text());
    console.log('[renderer error]', m.text());
  }
});
win.on('pageerror', (e) => {
  errors.push(e.message);
  console.log('[pageerror]', e.message);
});
await win.setViewportSize?.({ width: 1440, height: 920 }).catch(() => {});

try {
  step('홈 화면');
  await win.waitForSelector('.project-card.new', { timeout: 20000 });
  await win.screenshot({ path: join(OUT, 'app-1-home.png') });

  step('새 오답노트');
  await win.click('.project-card.new');
  await win.fill('.modal input', '테스트 수학Ⅰ');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.doc-card[data-role="problem"] .drop-zone');

  step('문제집/답지 올리기 (파일 대화상자 대체)');
  const stubOpen = (paths) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p }); }, paths);
  await stubOpen([join(FIX, 'book-unit.pdf')]);
  await win.click('.doc-card[data-role="problem"] .drop-zone');
  await win.waitForSelector('.doc-card[data-role="problem"] .doc-file');
  await stubOpen([join(FIX, 'answer-unit.pdf')]);
  await win.click('.doc-card[data-role="answer"] .drop-zone');
  await win.waitForSelector('.doc-card[data-role="answer"] .doc-file');
  await win.screenshot({ path: join(OUT, 'app-2-uploaded.png') });

  step('분석');
  await win.click('.analyze-panel .btn-primary');
  await win.waitForFunction(() => document.querySelectorAll('.docs-sum-item .ok-text').length === 2, null, { timeout: 120000 });
  const counts = await win.$$eval('.docs-sum-item .ok-text', (els) => els.map((e) => e.textContent.trim()));
  console.log('   ', counts);
  const chips = await win.$$eval('.qtable .chip', (els) => els.map((e) => e.textContent));
  console.log('    chips:', chips.join(','));
  if (chips.length !== 24) throw new Error(`문항 수가 다릅니다: ${chips.length}`);

  step('선택 + 미리보기');
  const chip = (k) => win.locator('.qtable .chip').nth(k);
  await chip(0).click();
  await chip(5).click();
  await chip(16).hover();
  await win.waitForTimeout(600);
  await win.fill('.select-toolbar .input', '3쪽: 2, 4');
  await win.press('.select-toolbar .input', 'Enter');
  await win.waitForTimeout(300);
  const selCount = await win.$$eval('.qtable .chip.on', (els) => els.length);
  console.log('    selected:', selCount);
  if (selCount !== 4) throw new Error(`선택 수가 다릅니다: ${selCount}`);
  await win.waitForSelector('.preview-img[src^="data:"]', { timeout: 15000 });
  await win.screenshot({ path: join(OUT, 'app-3-select.png') });

  step('PDF 내보내기 3종');
  for (const [idx, name] of [[0, 'problems'], [1, 'answers'], [2, 'both']]) {
    const out = join(OUT, `app-export-${name}.pdf`);
    rmSync(out, { force: true });
    await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, out);
    await win.click(`.export-buttons .btn >> nth=${idx}`);
    await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('저장했습니다')), null, { timeout: 60000 });
    await win.$$eval('.toast', (els) => els.forEach((e) => e.remove()));
    if (!existsSync(out) || statSync(out).size < 1000) throw new Error(`${name} PDF 생성 실패`);
    console.log(`    ${name}: ${statSync(out).size} bytes`);
  }

  step('페이지 검토: 상자 선택 → 번호 고치기 → 새 상자 그리기');
  await win.click('.tabs .tab >> nth=1');
  await win.waitForSelector('.page-overlay .box', { timeout: 20000 });
  await win.waitForTimeout(500);
  await win.screenshot({ path: join(OUT, 'app-4-review.png') });
  await win.locator('.page-overlay .box').first().click();
  await win.fill('.input-num', '99');
  await win.press('.input-num', 'Enter');
  await win.waitForTimeout(200);
  const labels = await win.$$eval('.page-overlay .box-label', (els) => els.map((e) => e.textContent));
  if (!labels.includes('99')) throw new Error('번호 수정이 반영되지 않았습니다: ' + labels.join(','));
  await win.click('.editor-toolbar .tb-group:nth-child(2) .btn >> nth=0'); // 문항 추가
  const ov = await (await win.$('.page-overlay')).boundingBox();
  await win.mouse.move(ov.x + ov.width * 0.1, ov.y + ov.height * 0.92);
  await win.mouse.down();
  await win.mouse.move(ov.x + ov.width * 0.4, ov.y + ov.height * 0.97, { steps: 5 });
  await win.mouse.up();
  await win.waitForTimeout(300);
  const nBoxes = await win.$$eval('.page-overlay .box', (els) => els.length);
  console.log('    boxes after draw:', nBoxes);
  await win.screenshot({ path: join(OUT, 'app-5-edited.png') });

  step('설정 창');
  await win.click('.topbar-right .btn-ghost');
  await win.waitForSelector('.modal .settings');
  await win.screenshot({ path: join(OUT, 'app-6-settings.png') });
  await win.click('.modal-footer .btn >> nth=0');

  step('사진(JPG 3장) 문제집 → OCR 인식');
  await win.click('.topbar-project .btn-ghost');
  await win.waitForSelector('.project-card.new');
  await win.click('.project-card.new');
  await win.fill('.modal input', '사진 문제집');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.doc-card[data-role="problem"] .drop-zone');
  await stubOpen([3, 1, 2].map((i) => join(FIX, 'photos', `photo-${i}.jpg`)));
  await win.click('.doc-card[data-role="problem"] .drop-zone');
  await win.waitForSelector('.doc-card[data-role="problem"] .doc-file');
  await win.click('.analyze-panel .btn-primary');
  await win.waitForSelector('.docs-sum-item .ok-text', { timeout: 180000 });
  const ocrChips = await win.$$eval('.qtable .chip', (els) => els.map((e) => e.textContent));
  console.log('    OCR chips:', ocrChips.join(','));
  if (ocrChips.length < 22) throw new Error(`OCR 인식 수가 너무 적습니다: ${ocrChips.length}`);
  await win.screenshot({ path: join(OUT, 'app-7-photos.png') });
  const outImg = join(OUT, 'app-export-photos.pdf');
  await win.locator('.qtable .chip').nth(2).click();
  await win.locator('.qtable .chip').nth(12).click();
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, outImg);
  await win.click('.export-buttons .btn >> nth=0');
  await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('저장했습니다')), null, { timeout: 60000 });
  console.log(`    photos export: ${statSync(outImg).size} bytes`);

  step('재실행 후 저장 내용 확인');
  await win.click('.topbar-project .btn-ghost');
  await win.waitForSelector('.project-card:not(.new)');
  await app.close();
  app = await launch();
  win = await app.firstWindow();
  await win.waitForSelector('.project-card:not(.new)', { timeout: 20000 });
  const stats = await win.$$eval('.project-card:not(.new) .pc-stats', (els) => els.map((e) => e.textContent));
  console.log('   ', stats);
  if (!stats.some((t) => t.includes('선택 4개'))) throw new Error('선택 내용이 저장되지 않았습니다: ' + stats);
  await win.locator('.project-card:not(.new)', { hasText: '테스트 수학' }).click();
  await win.waitForSelector('.qtable .chip.on', { timeout: 30000 });
  console.log('✅ E2E 통과');
} catch (err) {
  console.error('❌ E2E 실패:', err);
  await win.screenshot({ path: join(OUT, 'app-fail.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}
if (errors.length) console.log('renderer errors:', errors.length);
