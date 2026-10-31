import { chromium } from '../lib/playwright.mjs';
import { startServer } from '../lib/server.mjs';
const file = process.argv[2] || 'book-unit.pdf';
const { server, url } = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${url}/test/e2e/harness.html`);
await page.waitForFunction(() => window.harnessReady);
const out = await page.evaluate(async (u) => {
  const { openDocSource } = await import('/src/renderer/js/docsource.js');
  const { analyzePage } = await import('/src/renderer/js/analyze.js');
  const src = await openDocSource([{ name: u, kind: 'pdf' }], (n) => n);
  const res = [];
  for (let i = 0; i < src.numPages; i++) {
    const p = await analyzePage(src, i, {});
    res.push({ i, source: p.source, layout: { ...p.layout }, cands: p.candidates.map((c) => `${c.digits}${c.style[0]}@c${c.col} x${c.relX.toFixed(3)} y${c.y0.toFixed(3)} h${c.hRatio.toFixed(2)} cf${Math.round(c.conf)}`) });
  }
  return res;
}, `${url}/test/fixtures/generated/${file}`);
for (const p of out) {
  console.log(`page ${p.i} [${p.source}] cols=${JSON.stringify(p.layout.columns.map(c=>[+c.x0.toFixed(3),+c.x1.toFixed(3)]))} body=${p.layout.bodyTop.toFixed(3)}-${p.layout.bodyBottom.toFixed(3)} hdr=${p.layout.hasHeader} ftr=${p.layout.hasFooter}`);
  console.log('   ', p.cands.join(' | '));
}
await browser.close(); server.close();
