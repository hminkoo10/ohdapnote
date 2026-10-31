// 디버그: 문서의 번호 체계와 쪽별 인식 항목 출력
import { chromium } from '../lib/playwright.mjs';
import { startServer } from '../lib/server.mjs';
const [file, role = 'answer', flow = 'continue'] = process.argv.slice(2);
const { server, url } = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${url}/test/e2e/harness.html`);
await page.waitForFunction(() => window.harnessReady);
const out = await page.evaluate(async ([u, role, flow]) => {
  const { openDocSource } = await import('/src/renderer/js/docsource.js');
  const { analyzeDocument, parsePageRange } = await import('/src/renderer/js/analyze.js');
  const src = await openDocSource([{ name: u, kind: 'pdf' }], (n) => n);
  const r = await analyzeDocument(src, { pages: parsePageRange('', src.numPages), role, flow });
  const byPage = {};
  for (const it of r.items) (byPage[it.page] ||= []).push(`${it.prefix}${it.number}[${it.rects.map((x) => `${x.page}:${x.y.toFixed(2)}+${x.h.toFixed(2)}`).join(',')}]`);
  return { sigs: r.signatures, byPage };
}, [`${url}/test/fixtures/generated/${file}`, role, flow]);
console.log(JSON.stringify(out.sigs));
for (const [p, list] of Object.entries(out.byPage)) console.log(`p${+p + 1}: ${list.join(' ')}`);
await browser.close();
server.close();
