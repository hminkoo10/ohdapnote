// 내보내기 확인: 문제집/답지 분석 → 몇 문항 선택 → 세 가지 PDF 생성
import { chromium } from '../lib/playwright.mjs';
import { startServer } from '../lib/server.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const book = process.argv[2] || 'book-unit.pdf';
const answer = process.argv[3] || 'answer-unit.pdf';
const { server, url } = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('[console]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${url}/test/e2e/harness.html`);
await page.waitForFunction(() => window.harnessReady);
const out = await page.evaluate(async ([bu, au]) => {
  const { openDocSource } = await import('/src/renderer/js/docsource.js');
  const { analyzeDocument, parsePageRange } = await import('/src/renderer/js/analyze.js');
  const { matchItems } = await import('/src/renderer/js/match.js');
  const { buildPdf, makeBlocks } = await import('/src/renderer/js/exporter.js');
  const pSrc = await openDocSource([{ name: bu, kind: 'pdf' }], (n) => n);
  const aSrc = await openDocSource([{ name: au, kind: 'pdf' }], (n) => n);
  const pRes = await analyzeDocument(pSrc, { pages: parsePageRange('', pSrc.numPages), role: 'problem', flow: 'column' });
  const aRes = await analyzeDocument(aSrc, { pages: parsePageRange('', aSrc.numPages), role: 'answer', flow: 'continue' });
  const m = matchItems(pRes.items, aRes.items);
  const byId = new Map(aRes.items.map((i) => [i.id, i]));
  const picks = [0, 3, 8, 13, 14, 23].map((k) => pRes.items[k]).filter(Boolean);
  const entries = picks.map((p) => ({ problem: p, answer: byId.get(m.get(p.id)) || null }));
  const label = (role, it) => `p.${it.page + 1}`;
  const res = {};
  for (const [mode, options] of [['problems', { columns: 1, space: 'small' }], ['answers', { columns: 2 }], ['both', { columns: 2, bothOrder: 'interleave', space: 'none' }], ['both-append', { columns: 1, bothOrder: 'append', space: 'page' }]]) {
    const blocks = makeBlocks(mode.startsWith('both') ? 'both' : mode, entries, options, label);
    const bytes = await buildPdf({ blocks, sources: { problem: pSrc, answer: aSrc }, options, title: `테스트 오답노트 · ${mode}` });
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    res[mode] = btoa(bin);
  }
  return res;
}, [`${url}/test/fixtures/generated/${book}`, `${url}/test/fixtures/generated/${answer}`]);
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
for (const [mode, b64] of Object.entries(out)) {
  const f = new URL(`./out/export-${mode}.pdf`, import.meta.url);
  writeFileSync(f, Buffer.from(b64, 'base64'));
  console.log(f.pathname, Buffer.from(b64, 'base64').length, 'bytes');
}
await browser.close(); server.close();
