// 가지고 있는 실제 문제집·답지 PDF(스캔본 포함)로 번호 인식을 확인합니다. (PDF 는 저장소에 넣지 않음)
// 사용: node test/e2e/scan-check.mjs <PDF 경로> [problem|answer] [쪽 범위]
//   예) node test/e2e/scan-check.mjs "C:\Users\me\Downloads\쎈 대수.pdf" problem
// 번호가 1씩 이어지는지(단원마다 1부터 다시 시작은 허용)로 채점: 빠진 번호, 순서가 어긋난 곳, 확인 필요 쪽을 보여 줍니다.
import { chromium } from '../lib/playwright.mjs';
import { startServer } from '../lib/server.mjs';
import { resolve } from 'node:path';

const [file, role = 'problem', range = ''] = process.argv.slice(2);
if (!file) {
  console.log('사용: node test/e2e/scan-check.mjs <PDF 경로> [problem|answer] [쪽 범위]');
  process.exit(2);
}
const { server, url } = await startServer(0, { '/ext/book.pdf': resolve(file) });
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${url}/test/e2e/harness.html`);
await page.waitForFunction(() => window.harnessReady);
const res = await page.evaluate(([u, o]) => window.harness.analyze(u, o), [`${url}/ext/book.pdf`, { role, range, flow: role === 'answer' ? 'continue' : 'column' }]);
await browser.close();
server.close();

const byPage = new Map();
for (const it of res.items) {
  if (!byPage.has(it.page)) byPage.set(it.page, []);
  byPage.get(it.page).push(it.number);
}
for (const [p, nums] of byPage) console.log(`${String(p + 1).padStart(4)}쪽  ${nums.join(' ')}`);

const missing = [];
const disorder = [];
for (let i = 1; i < res.items.length; i++) {
  const a = res.items[i - 1];
  const b = res.items[i];
  if (b.num === a.num + 1 || b.num === 1) continue;
  if (b.num > a.num + 1 && b.num - a.num <= 50) for (let n = a.num + 1; n < b.num; n++) missing.push(`${n}(${b.page + 1}쪽 근처)`);
  else disorder.push(`${a.page + 1}쪽 ${a.number} → ${b.page + 1}쪽 ${b.number}`);
}
const flagged = Object.entries(res.pageInfo).filter(([, v]) => v.flags.length);
console.log(`\n문항 ${res.items.length}개 · ${Math.round(res.ms / 1000)}초 (${res.numPages}쪽 문서)`);
console.log(`빠진 번호 ${missing.length}개${missing.length ? `: ${missing.join(', ')}` : ''}`);
console.log(`순서 어긋남 ${disorder.length}곳${disorder.length ? `: ${disorder.join(' / ')}` : ''}`);
if (flagged.length) console.log(`확인 필요 쪽: ${flagged.map(([k, v]) => `${+k + 1}쪽(${v.flags.join('/')})`).join('  ')}`);
process.exit(missing.length || disorder.length ? 1 : 0);
