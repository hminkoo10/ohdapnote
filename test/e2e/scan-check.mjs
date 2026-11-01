// 가지고 있는 실제 문제집·답지 PDF(스캔본 포함)로 번호 인식을 확인합니다. (PDF 는 저장소에 넣지 않음)
// 사용: node test/e2e/scan-check.mjs <PDF 경로> [problem|answer] [쪽 범위]
//   예) node test/e2e/scan-check.mjs "C:\Users\me\Downloads\쎈 대수.pdf" problem
//   또는 test/e2e/local-books.json(내 컴퓨터에만, git 에 안 올라감)에 책 목록을 적고 인자 없이: npm run test:scan
//   (형식은 local-books.example.json 참고)
// 번호가 1씩 이어지는지(단원마다 1부터 다시 시작은 허용, 예제·유제 같은 말머리는 따로)로 채점:
// 빠진 번호, 순서가 어긋난 곳, 확인 필요 쪽을 보여 줍니다.
import { chromium } from '../lib/playwright.mjs';
import { startServer } from '../lib/server.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LIST = new URL('./local-books.json', import.meta.url);
const [file, role = 'problem', range = ''] = process.argv.slice(2);
let books;
if (file) books = [{ file, role, range }];
else if (existsSync(LIST)) books = JSON.parse(readFileSync(LIST, 'utf8'));
else {
  console.log('사용: node test/e2e/scan-check.mjs <PDF 경로> [problem|answer] [쪽 범위]');
  console.log('   또는 test/e2e/local-books.json 에 책 목록을 적고 인자 없이 실행 (local-books.example.json 참고)');
  process.exit(2);
}

const { server, url } = await startServer(0, Object.fromEntries(books.map((b, i) => [`/ext/book${i}.pdf`, resolve(b.file)])));
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${url}/test/e2e/harness.html`);
await page.waitForFunction(() => window.harnessReady);

let failed = 0;
const summary = [];
for (const [i, b] of books.entries()) {
  const r = b.role || 'problem';
  console.log(`\n=== ${b.name || b.file} (${r === 'answer' ? '답지' : '문제집'})`);
  const res = await page.evaluate(([u, o]) => window.harness.analyze(u, o), [`${url}/ext/book${i}.pdf`, { role: r, range: b.range || '', flow: r === 'answer' ? 'continue' : 'column' }]);
  const byPage = new Map();
  for (const it of res.items) {
    if (!byPage.has(it.page)) byPage.set(it.page, []);
    byPage.get(it.page).push(it.prefix ? `${it.prefix} ${it.number}` : it.number);
  }
  for (const [p, nums] of byPage) console.log(`${String(p + 1).padStart(4)}쪽  ${nums.join(' ')}`);

  const missing = [];
  const disorder = [];
  const byPrefix = new Map();
  for (const it of res.items) {
    if (!byPrefix.has(it.prefix || '')) byPrefix.set(it.prefix || '', []);
    byPrefix.get(it.prefix || '').push(it);
  }
  for (const [prefix, list] of byPrefix) {
    for (let k = 1; k < list.length; k++) {
      const a = list[k - 1];
      const z = list[k];
      if (z.num === a.num + 1 || z.num === 1) continue;
      const label = (it) => `${prefix ? `${prefix} ` : ''}${it.number}`;
      if (z.num > a.num + 1 && z.num - a.num <= 50) for (let n = a.num + 1; n < z.num; n++) missing.push(`${prefix ? `${prefix} ` : ''}${n}(${z.page + 1}쪽 근처)`);
      else disorder.push(`${a.page + 1}쪽 ${label(a)} → ${z.page + 1}쪽 ${label(z)}`);
    }
  }
  const flagged = Object.entries(res.pageInfo).filter(([, v]) => v.flags.length);
  console.log(`\n문항 ${res.items.length}개 · ${Math.round(res.ms / 1000)}초 (${res.numPages}쪽 문서)`);
  console.log(`빠진 번호 ${missing.length}개${missing.length ? `: ${missing.join(', ')}` : ''}`);
  console.log(`순서 어긋남 ${disorder.length}곳${disorder.length ? `: ${disorder.join(' / ')}` : ''}`);
  if (flagged.length) console.log(`확인 필요 쪽: ${flagged.map(([k, v]) => `${+k + 1}쪽(${v.flags.join('/')})`).join('  ')}`);
  const ok = !missing.length && !disorder.length;
  if (!ok) failed++;
  summary.push(`${ok ? '✅' : '❌'} ${b.name || b.file}: 문항 ${res.items.length}개, 빠진 번호 ${missing.length}, 순서 어긋남 ${disorder.length}`);
}
await browser.close();
server.close();
if (books.length > 1) console.log(`\n${summary.join('\n')}`);
process.exit(failed ? 1 : 0);
