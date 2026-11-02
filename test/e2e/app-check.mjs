// 확인할 쪽 흐름 E2E: 빠진 번호 표시 → 문제없음 → AI(Gemini, 1순위 한도 초과 → 2순위) → AI 즉시 취소
// AI 는 실제로 부르지 않고 메인 프로세스의 IPC 처리기(ai:generate)를 바꿔 끼워서 흉내냅니다.
// 실행: xvfb-run -a node test/e2e/app-check.mjs
import { _electron as electron } from '../lib/playwright.mjs';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIX = join(ROOT, 'test/fixtures/generated');
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'ohdap-check-'));
const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', ROOT], env: { ...process.env, OHDAP_E2E: '1', OHDAP_USER_DATA: userData } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => m.type() === 'error' && !/diacritics/.test(m.text()) && errors.push(m.text()));
const step = (s) => console.log(`▶ ${s}`);
const shot = (n) => win.screenshot({ path: join(OUT, `check-${n}.png`) });
const clearToasts = () => win.$$eval('.toast', (els) => els.forEach((e) => e.remove()));
const chipTexts = () => win.$$eval('.qtable .chip:not(.missing)', (els) => els.map((e) => e.textContent.replace(/\D/g, '')));

try {
  step('어려운 교재(공통 지문·2mm 단 간격) 등록 + 분석');
  await win.waitForSelector('.seg-tab[data-tab="books"]');
  await win.click('.seg-tab[data-tab="books"]');
  await win.click('.card-new:has-text("새 책 등록")');
  await win.fill('.modal input', '어려운 교재');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.doc-card[data-role="problem"] .drop-zone');
  const stub = (p) => app.evaluate(({ dialog }, q) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: q }); }, p);
  await stub([join(FIX, 'hard-problem.pdf')]);
  await win.click('.doc-card[data-role="problem"] .drop-zone');
  await stub([join(FIX, 'hard-answer.pdf')]);
  await win.click('.doc-card[data-role="answer"] .drop-zone');
  await win.waitForSelector('.doc-card[data-role="answer"] .doc-foot .btn-primary');
  await win.click('.doc-card[data-role="problem"] .doc-foot .btn-primary');
  await win.waitForSelector('.doc-card[data-role="problem"] .sum-main', { timeout: 120000 });
  await win.click('.doc-card[data-role="answer"] .doc-foot .btn-primary');
  await win.waitForSelector('.doc-card[data-role="answer"] .sum-main', { timeout: 120000 });
  await clearToasts();
  await win.click('.mini-seg button >> nth=0');
  await win.waitForTimeout(300);
  const nums = await chipTexts();
  console.log('    문항:', nums.join(','));
  if (nums.length !== 18) throw new Error(`문항 수: ${nums.length}`);
  const stems = await win.$$eval('.qtable .chip .chip-dot', (els) => els.length);
  console.log('    공통 지문 붙은 문항:', stems);
  if (stems !== 9) throw new Error(`공통 지문 문항 수: ${stems}`);

  step('검토에서 116번 상자를 지움 → 빠진 번호로 표시되는지');
  await win.click('.tabs-row .seg-tab[data-tab="review"]');
  await win.waitForSelector('.page-overlay .box', { timeout: 20000 });
  await win.click('.page-row >> nth=1');
  await win.waitForTimeout(700);
  await win.locator('.page-overlay .box', { hasText: /^116$/ }).first().click();
  await win.keyboard.press('Delete');
  await win.waitForTimeout(300);
  await win.click('.tabs-row .seg-tab[data-tab="result"]');
  await win.waitForSelector('.check-panel .cp-row', { timeout: 5000 });
  const why = await win.$$eval('.cp-row .cp-why', (els) => els.map((e) => e.textContent));
  console.log('    확인할 쪽:', why);
  if (!why.some((t) => t.includes('116'))) throw new Error('빠진 번호 116 이 표시되지 않았습니다');
  const missChip = await win.$$eval('.qtable .chip.missing', (els) => els.map((e) => e.textContent));
  if (!missChip.some((t) => t.startsWith('116'))) throw new Error('표에 빠진 번호 칩이 없습니다: ' + missChip);
  await win.waitForTimeout(500);
  await shot('1-panel');

  step('설정: Gemini 키 + 1순위 model-a / 2순위 model-b');
  await win.click('#settings-btn');
  await win.waitForSelector('.modal .settings');
  const cards = win.locator('.settings .set-card');
  await cards.nth(1).locator('input').nth(0).fill('test-key');
  await cards.nth(1).locator('input').nth(1).fill('model-a');
  await cards.nth(1).locator('input').nth(2).fill('model-b');
  await win.click('.modal-footer .btn-primary');
  await win.waitForTimeout(300);

  step('Gemini: 1순위 한도 초과 → 2순위로 넘어가 116번 되찾기');
  await app.evaluate(({ ipcMain }) => {
    globalThis.__calls = [];
    ipcMain.removeHandler('ai:generate');
    ipcMain.handle('ai:generate', async (_e, { model }) => {
      globalThis.__calls.push(model);
      await new Promise((r) => setTimeout(r, 200));
      if (model === 'model-a') {
        return { ok: false, status: 429, error: 'Quota exceeded: GenerateRequestsPerDayPerProjectPerModel-FreeTier', json: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded: GenerateRequestsPerDayPerProjectPerModel-FreeTier' } } };
      }
      const boxes = [
        { number: '114', box_2d: [70, 66, 420, 470] },
        { number: '115', box_2d: [430, 66, 900, 470] },
        { number: '116', box_2d: [70, 520, 420, 930] },
        { number: '117', box_2d: [430, 520, 900, 930] },
      ];
      return { ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify(boxes) }] } }] } };
    });
  });
  const row = win.locator('.cp-row', { hasText: '116' });
  await row.locator('.cp-actions .btn').nth(2).click(); // AI
  await win.waitForSelector('.gem-row[data-state="ok"]', { timeout: 15000 });
  const gemMsg = await win.$eval('.gem-row[data-state="ok"] .gem-msg', (e) => e.textContent);
  const calls = await app.evaluate(() => globalThis.__calls);
  console.log('    결과:', gemMsg, '| 부른 모델:', calls.join(' → '));
  if (!gemMsg.includes('model-b') || calls[0] !== 'model-a') throw new Error('2순위 모델로 넘어가지 않았습니다');
  await win.waitForTimeout(400);
  await shot('2-gemini');
  await win.click('.gem-modal .modal-footer .btn');
  await win.waitForTimeout(500);
  const after = await chipTexts();
  if (!after.includes('116')) throw new Error('Gemini 결과가 반영되지 않았습니다: ' + after);
  const left = await win.$$eval('.cp-row', (els) => els.length);
  console.log('    남은 확인할 쪽:', left);

  step('Gemini 취소: 기다리는 중에 취소하면 바로 멈춤');
  await app.evaluate(({ ipcMain }) => {
    globalThis.__aborted = 0;
    globalThis.__started = 0;
    const pending = new Map();
    ipcMain.removeHandler('ai:generate');
    ipcMain.removeHandler('ai:abort');
    ipcMain.handle('ai:generate', (_e, { requestId }) => new Promise((resolve) => {
      globalThis.__started++;
      const t = setTimeout(() => resolve({ ok: true, status: 200, json: { candidates: [] } }), 20000);
      pending.set(requestId, () => { clearTimeout(t); resolve({ ok: false, status: 0, aborted: true, error: '취소됨' }); });
    }));
    ipcMain.handle('ai:abort', (_e, id) => { globalThis.__aborted++; pending.get(id)?.(); return true; });
  });
  await win.click('.tabs-row .seg-tab[data-tab="review"]');
  await win.waitForSelector('.editor-toolbar');
  await win.waitForTimeout(500);
  await win.click('.editor-toolbar .btn:has-text("AI")');
  await win.waitForSelector('.gem-row[data-state="run"]', { timeout: 10000 });
  // 분당 요청 수 제한 때문에 잠깐 기다렸다가 실제 요청이 나간 뒤에 취소
  for (let i = 0; i < 100 && !(await app.evaluate(() => globalThis.__started)); i++) await win.waitForTimeout(200);
  await win.waitForTimeout(300);
  const t0 = Date.now();
  await win.click('.gem-modal .modal-footer .btn');
  await win.waitForSelector('.gem-modal', { state: 'detached', timeout: 3000 });
  await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('멈췄어요')), null, { timeout: 3000 });
  const ms = Date.now() - t0;
  const aborted = await app.evaluate(() => globalThis.__aborted);
  console.log(`    취소까지 ${ms}ms, 메인에서 요청 끊음: ${aborted}회`);
  if (ms > 1500 || aborted < 1) throw new Error('취소가 바로 되지 않았습니다');

  step('문제없음: 다른 쪽 번호를 지운 뒤 "문제없음"으로 넘기기');
  await win.click('.page-row >> nth=0');
  await win.waitForTimeout(600);
  await win.locator('.page-overlay .box', { hasText: /^101$/ }).first().click();
  await win.keyboard.press('Delete');
  await win.waitForTimeout(300);
  await win.click('.tabs-row .seg-tab[data-tab="result"]');
  await win.waitForSelector('.cp-row', { timeout: 5000 });
  const rowsBefore = await win.$$eval('.cp-row', (els) => els.length);
  await win.locator('.cp-row', { hasText: '101' }).locator('.btn-ok').click();
  await win.waitForTimeout(800);
  const rowsAfter = await win.$$eval('.cp-row', (els) => els.length);
  console.log(`    확인할 쪽 ${rowsBefore} → ${rowsAfter}`);
  if (rowsAfter !== rowsBefore - 1) throw new Error('문제없음이 반영되지 않았습니다');
  await shot('3-dismissed');
  if (errors.length) throw new Error('화면 오류: ' + errors.join(' | '));
  console.log('✅ 확인할 쪽 흐름 통과');
} catch (err) {
  console.error('❌ 실패:', err);
  await shot('fail').catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}
