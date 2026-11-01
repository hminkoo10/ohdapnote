// 뒤에서 도는 작업 E2E
//  스캔본 분석 → [백그라운드에서 계속] → 다른 책·오답노트로 가도 그 화면엔 쓰지 않음 → 위쪽 막대로 다시 열기
//  → 그 사이 책 이름 고치기 → 끝나면 토스트 [책 열기] + 윈도우 알림(흉내) + 그 책에만 저장
//  → Gemini 창 숨기기·다시 열기·같은 작업은 하나만 → 끄기 전에 물어보기
// Gemini 는 실제로 부르지 않고 메인 프로세스의 IPC 처리기를 바꿔 끼워서 흉내냅니다.
// 실행: xvfb-run -a node test/e2e/app-background.mjs
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
const userData = mkdtempSync(join(tmpdir(), 'ohdap-bg-'));
const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', ROOT], env: { ...process.env, OHDAP_E2E: '1', OHDAP_USER_DATA: userData } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => m.type() === 'error' && !/diacritics/.test(m.text()) && errors.push(m.text()));
const step = (s) => console.log(`▶ ${s}`);
const shot = (n) => win.screenshot({ path: join(OUT, `bg-${n}.png`) });
const stub = (p) => app.evaluate(({ dialog }, q) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: q }); }, p);
const books = () => win.evaluate(() => window.ohdap.listBooks());
const getBook = (id) => win.evaluate((i) => window.ohdap.getBook(i), id);
const busyHere = () => win.$('.doc-card[data-role="problem"] .doc-foot.busy');
const fakeGemini = (ms) =>
  app.evaluate(({ ipcMain }, wait) => {
    globalThis.__gem = 0;
    ipcMain.removeHandler('gemini:generate');
    ipcMain.handle('gemini:generate', async () => {
      globalThis.__gem++;
      await new Promise((r) => setTimeout(r, wait));
      const boxes = [
        { number: '1', box_2d: [70, 66, 420, 470] },
        { number: '2', box_2d: [430, 66, 900, 470] },
        { number: '3', box_2d: [70, 520, 420, 930] },
      ];
      return { ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify(boxes) }] } }] } };
    });
  }, ms);
const closeWindow = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
let exited = false;

try {
  step('책 두 권 등록: 스캔본 문제집 + 보통 문제집');
  await win.waitForSelector('.seg-tab[data-tab="books"]');
  await win.click('.seg-tab[data-tab="books"]');
  const newBook = async (name, files) => {
    await win.click('.card-new:has-text("새 책 등록")');
    await win.fill('.modal input', name);
    await win.click('.modal .btn-primary');
    await win.waitForSelector('.doc-card[data-role="problem"] .drop-zone');
    await stub(files.map((f) => join(FIX, f)));
    await win.click('.doc-card[data-role="problem"] .drop-zone');
    if (files.length > 1) await win.click('.modal .btn-primary'); // PDF 여러 개 이어 붙이기
    await win.waitForSelector('.doc-card[data-role="problem"] .doc-foot .btn-primary');
  };
  await newBook('다른 책', ['book-unit.pdf']);
  await win.click('#back-btn');
  await win.waitForSelector('.book-card');
  // 스캔본 하나는 몇 초면 끝나서, 여러 번 이어 붙여 화면을 오가는 동안 계속 돌게 함
  await newBook('스캔 문제집', Array(4).fill('book-unit-scan.pdf'));
  const list = await books();
  const scanId = list.find((b) => b.name === '스캔 문제집').id;
  const otherId = list.find((b) => b.name === '다른 책').id;

  step('분석 시작 → [백그라운드에서 계속] → 책장, 위쪽 막대에 진행 상황');
  const t0 = Date.now();
  await win.click('.doc-card[data-role="problem"] .doc-foot .btn-primary');
  await win.waitForSelector('.doc-card[data-role="problem"] .doc-foot.busy');
  await win.click('.doc-foot.busy .bg-btn');
  await win.waitForSelector('.book-card');
  await win.waitForSelector('.job-chip', { timeout: 3000 });
  const chipText = await win.$eval('.job-chip', (e) => e.textContent);
  console.log('    위쪽 막대:', chipText);
  if (!chipText.includes('스캔 문제집')) throw new Error('위쪽 막대에 분석이 보이지 않습니다');
  await shot('1-home-chip');

  step('다른 책을 열어도 그 화면에는 진행 상황·결과를 쓰지 않음');
  await win.locator('.book-card', { hasText: '다른 책' }).click();
  await win.waitForSelector('.doc-card[data-role="problem"] .doc-foot .btn-primary');
  await win.waitForTimeout(1500);
  if (await busyHere()) throw new Error('다른 책 화면에 진행 상황이 그려졌습니다');
  if (!(await win.$('.job-chip'))) throw new Error('다른 책 화면에서 위쪽 막대가 사라졌습니다');
  await shot('2-other-book');

  step('위쪽 막대를 누르면 그 책으로 → 진행 중 카드, 그 사이 책 이름 고치기');
  await win.click('.job-chip');
  await win.waitForFunction(() => document.querySelector('.title-input')?.value === '스캔 문제집');
  await win.waitForSelector('.doc-card[data-role="problem"] .doc-foot.busy', { timeout: 3000 });
  await win.waitForTimeout(300);
  if (await win.$('.job-chip')) throw new Error('그 책 화면에서도 위쪽 막대에 보입니다');
  await win.fill('.title-input', '스캔 문제집 2');
  await win.press('.title-input', 'Enter');
  await win.locator('.title-input').blur();
  await shot('3-running-book');

  step('창이 앞에 없을 때 윈도우 알림 (흉내) → 오답노트 탭에 가 있는 동안 끝남');
  await win.evaluate(() => {
    window.__notes = [];
    window.Notification = function (title, o) {
      window.__notes.push({ title, body: o?.body });
    };
    document.hasFocus = () => false;
  });
  await win.click('#back-btn');
  await win.waitForSelector('.seg-tab[data-tab="notes"]');
  await win.click('.seg-tab[data-tab="notes"]');
  if (!(await win.$('.job-chip'))) throw new Error('분석이 너무 빨리 끝나서 뒤에서 도는 것을 확인하지 못했습니다');
  const doneToast = win.locator('.toast', { hasText: '개 인식' }).filter({ has: win.locator('.toast-actions .btn', { hasText: '책 열기' }) });
  await doneToast.waitFor({ timeout: 180000 });
  console.log(`    분석 ${Math.round((Date.now() - t0) / 1000)}초:`, await doneToast.locator('.toast-msg').textContent());
  const saved = await getBook(scanId);
  const n = saved.docs.problem.items.length;
  console.log(`    저장된 책: ${saved.name}, 문항 ${n}개`);
  if (n < 20 || !saved.docs.problem.analyzedAt) throw new Error('뒤에서 끝난 분석이 저장되지 않았습니다');
  if (saved.name !== '스캔 문제집 2') throw new Error('분석하는 동안 고친 책 이름이 사라졌습니다: ' + saved.name);
  const other = await getBook(otherId);
  if (other.docs.problem.analyzedAt || other.docs.problem.items.length) throw new Error('다른 책에 결과가 들어갔습니다');
  const notes = await win.evaluate(() => window.__notes);
  console.log('    윈도우 알림:', notes);
  if (notes.length !== 1 || !notes[0].body.includes('개 인식')) throw new Error('윈도우 알림이 뜨지 않았습니다');
  if (!(await win.$('.seg-tab.active[data-tab="notes"]'))) throw new Error('보고 있던 오답노트 탭이 바뀌었습니다');
  await shot('4-done-toast');

  step('토스트 [책 열기] → 결과가 그대로');
  await doneToast.locator('.toast-actions .btn', { hasText: '책 열기' }).click();
  await win.waitForSelector('.doc-card[data-role="problem"] .sum-main', { timeout: 10000 });
  const chips = await win.$$eval('.qtable .chip:not(.missing)', (els) => els.length);
  if (chips !== n) throw new Error(`책 화면 문항 수가 다릅니다: ${chips} / ${n}`);

  step('Gemini: 창을 숨겨도 계속 → 같은 작업은 하나만 → 위쪽 막대에서 다시 열기 → 책장에 있는 동안 끝남');
  await win.click('#settings-btn');
  await win.waitForSelector('.modal .settings');
  await win.fill('.settings input[type="password"]', 'test-key');
  await win.fill('.settings input[type="number"]', '60');
  await win.click('.modal-footer .btn-primary');
  await win.waitForSelector('.modal', { state: 'detached' });
  await fakeGemini(6000);
  await win.click('.tabs-row .seg-tab[data-tab="review"]');
  await win.waitForSelector('.editor-toolbar');
  await win.waitForTimeout(500);
  const bgBtn = '.gem-modal .modal-footer .btn:has-text("백그라운드에서 계속")';
  await win.click('.editor-toolbar .btn >> text=Gemini');
  await win.waitForSelector(bgBtn);
  await win.click(bgBtn);
  await win.waitForSelector('.gem-modal', { state: 'detached' });
  await win.waitForSelector('.job-chip:has-text("Gemini")', { timeout: 3000 });
  await win.click('.editor-toolbar .btn >> text=Gemini');
  await win.waitForSelector(bgBtn);
  const dialogs = await win.$$eval('.gem-modal', (els) => els.length);
  if (dialogs !== 1) throw new Error(`Gemini 창이 ${dialogs}개 떴습니다`);
  await win.click(bgBtn);
  await win.waitForSelector('.gem-modal', { state: 'detached' });
  await win.click('.job-chip:has-text("Gemini")');
  await win.waitForSelector(bgBtn);
  await shot('5-gemini-reopened');
  await win.click(bgBtn);
  await win.click('#back-btn');
  await win.waitForSelector('.book-card');
  const gemToast = win.locator('.toast', { hasText: 'Gemini 인식 끝' });
  await gemToast.waitFor({ timeout: 30000 });
  console.log('    ', await gemToast.locator('.toast-msg').textContent());
  const calls = await app.evaluate(() => globalThis.__gem);
  if (calls !== 1) throw new Error(`Gemini 를 ${calls}번 불렀습니다`);
  const afterGem = await getBook(scanId);
  const gemPages = Object.entries(afterGem.docs.problem.pageInfo).filter(([, pi]) => pi.source === 'gemini').map(([p]) => Number(p));
  const onPage = afterGem.docs.problem.items.filter((it) => it.page === gemPages[0]).length;
  console.log(`    Gemini 로 바뀐 쪽: ${gemPages.join(',')} (문항 ${onPage}개)`);
  if (gemPages.length !== 1 || onPage !== 3) throw new Error('뒤에서 끝난 Gemini 결과가 저장되지 않았습니다');

  step('작업이 남아 있으면 끄기 전에 물어봄 → [취소]면 그대로, [끄기]면 꺼짐');
  await fakeGemini(20000);
  await win.locator('.book-card', { hasText: '스캔 문제집 2' }).click();
  await win.click('.tabs-row .seg-tab[data-tab="review"]');
  await win.waitForSelector('.editor-toolbar');
  await win.waitForTimeout(500);
  await win.click('.editor-toolbar .btn >> text=Gemini');
  await win.click(bgBtn);
  await win.waitForSelector('.gem-modal', { state: 'detached' });
  await closeWindow();
  const ask = '.modal:has-text("아직 끝나지 않은 작업")';
  await win.waitForSelector(ask, { timeout: 5000 });
  await shot('6-close-confirm');
  await win.click(`${ask} .modal-footer .btn:has-text("취소")`);
  await win.waitForSelector(ask, { state: 'detached' });
  await win.waitForTimeout(500);
  if (!(await win.$('.job-chip:has-text("Gemini")'))) throw new Error('끄기를 취소했는데 작업이 사라졌습니다');
  await closeWindow();
  await win.waitForSelector(ask, { timeout: 5000 });
  const gone = new Promise((r) => app.process().once('exit', r));
  await win.click(`${ask} .modal-footer .btn-danger`);
  const ok = await Promise.race([gone.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
  if (!ok) throw new Error('[끄기]를 눌렀는데 꺼지지 않았습니다');
  exited = true;
  if (errors.length) throw new Error('화면 오류: ' + errors.join(' | '));
  console.log('✅ 뒤에서 도는 작업 흐름 통과');
} catch (err) {
  console.error('❌ 실패:', err);
  if (!exited) await shot('fail').catch(() => {});
  process.exitCode = 1;
} finally {
  if (!exited) {
    // 남은 작업이 창 닫기를 막지 않게
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.on('will-prevent-unload', (e) => e.preventDefault()))).catch(() => {});
    await app.close().catch(() => {});
  }
  rmSync(userData, { recursive: true, force: true });
}
