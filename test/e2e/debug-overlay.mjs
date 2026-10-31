// 인식된 문항 영역을 페이지 위에 그려 PNG 로 저장 (눈으로 확인용)
import { chromium } from '../lib/playwright.mjs';
import { startServer } from '../lib/server.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const [file = 'book-unit.pdf', role = 'problem', flow = 'column', pagesArg = '0'] = process.argv.slice(2);
const pages = pagesArg.split(',').map(Number);
const { server, url } = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${url}/test/e2e/harness.html`);
await page.waitForFunction(() => window.harnessReady);
const imgs = await page.evaluate(async ([u, role, flow, pages]) => {
  const { openDocSource } = await import('/src/renderer/js/docsource.js');
  const { analyzeDocument, parsePageRange } = await import('/src/renderer/js/analyze.js');
  const src = await openDocSource([{ name: u, kind: 'pdf' }], (n) => n);
  const res = await analyzeDocument(src, { pages: parsePageRange('', src.numPages), role, flow });
  const out = [];
  for (const p of pages) {
    const c = await src.renderPage(p, 800);
    const ctx = c.getContext('2d');
    const colors = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa'];
    res.items.forEach((it, k) => {
      it.rects.filter((r) => r.page === p).forEach((r, j) => {
        ctx.strokeStyle = colors[k % colors.length];
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x * c.width, r.y * c.height, r.w * c.width, r.h * c.height);
        ctx.fillStyle = colors[k % colors.length];
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText(`${it.number}${j ? '+' : ''}`, r.x * c.width + r.w * c.width - 30, r.y * c.height + 14);
      });
    });
    out.push(c.toDataURL('image/png'));
  }
  return out;
}, [`${url}/test/fixtures/generated/${file}`, role, flow, pages]);
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
imgs.forEach((d, i) => {
  const f = new URL(`./out/overlay-${file.replace('.pdf', '')}-p${pages[i]}.png`, import.meta.url);
  writeFileSync(f, Buffer.from(d.split(',')[1], 'base64'));
  console.log(f.pathname);
});
await browser.close(); server.close();
