// 시중 교재형 테스트 책으로 앱 화면 캡처 (쎈형 문제집+답지, 쪽을 넘어가는 해설 미리보기)
// 실행: xvfb-run -a node test/e2e/app-books-shot.mjs
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
const userData = mkdtempSync(join(tmpdir(), 'ohdap-books-'));
const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', ROOT], env: { ...process.env, OHDAP_E2E: '1', OHDAP_USER_DATA: userData } });
const win = await app.firstWindow();
const [book = 'ssen', pick = '0024'] = process.argv.slice(2);
try {
  await win.waitForSelector('.project-card.new');
  await win.click('.project-card.new');
  await win.fill('.modal input', book === 'ssen' ? '쎈형 수학Ⅰ' : '수능특강형 수학Ⅰ');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.doc-card[data-role="problem"] .drop-zone');
  const stub = (p) => app.evaluate(({ dialog }, q) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: q }); }, p);
  await stub([join(FIX, `${book}-problem.pdf`)]);
  await win.click('.doc-card[data-role="problem"] .drop-zone');
  await win.waitForSelector('.doc-card[data-role="problem"] .doc-file');
  await stub([join(FIX, `${book}-answer.pdf`)]);
  await win.click('.doc-card[data-role="answer"] .drop-zone');
  await win.waitForSelector('.doc-card[data-role="answer"] .doc-file');
  await win.click('.analyze-panel .btn-primary');
  await win.waitForFunction(() => document.querySelectorAll('.docs-sum-item .ok-text').length === 2, null, { timeout: 120000 });
  await win.$$eval('.toast', (els) => els.forEach((e) => e.remove()));
  const chip = win.locator('.qtable .chip', { hasText: new RegExp(`^${pick}$`) }).first();
  await chip.click();
  await chip.hover();
  await win.waitForSelector('.preview-img.loaded', { timeout: 20000 });
  await win.waitForTimeout(900);
  await win.$$eval('.toast', (els) => els.forEach((e) => e.remove()));
  await win.screenshot({ path: join(OUT, `books-${book}-app.png`) });
  console.log('saved', join(OUT, `books-${book}-app.png`));
} finally {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}
