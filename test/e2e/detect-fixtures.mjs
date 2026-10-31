// 합성 문제집/답지로 인식 정확도 확인
// 사용: node test/e2e/detect-fixtures.mjs [파일...]
import { chromium } from '../lib/playwright.mjs';
import { startServer } from '../lib/server.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const expected = JSON.parse(readFileSync(new URL('../fixtures/generated/expected.json', import.meta.url)));
const cases = [
  { file: 'book-unit.pdf', role: 'problem', flow: 'column', expect: expected['book-unit.pdf'] },
  { file: 'answer-unit.pdf', role: 'answer', flow: 'continue', expect: expected['answer-unit.pdf'] },
  { file: 'book-serial.pdf', role: 'problem', flow: 'column', expect: expected['book-serial.pdf'] },
  { file: 'answer-serial.pdf', role: 'answer', flow: 'continue', expect: expected['answer-serial.pdf'] },
  { file: 'book-unit-scan.pdf', role: 'problem', flow: 'column', expect: expected['book-unit.pdf'] },
  { file: 'photos', files: ['photos/photo-1.jpg', 'photos/photo-2.jpg', 'photos/photo-3.jpg'], role: 'problem', flow: 'column', expect: expected['book-unit.pdf'] },
];
const only = process.argv.slice(2);
const { server, url } = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.text().startsWith('GAP')) console.log('[console]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${url}/test/e2e/harness.html`);
await page.waitForFunction(() => window.harnessReady);
let failed = 0;
const results = {};
for (const c of cases) {
  if (only.length && !only.includes(c.file)) continue;
  const target = c.files ? c.files.map((f) => `${url}/test/fixtures/generated/${f}`) : `${url}/test/fixtures/generated/${c.file}`;
  const res = await page.evaluate(([u, o]) => window.harness.analyze(u, o), [target, c]);
  results[c.file] = res;
  const got = res.items.map((i) => i.number);
  const ok = JSON.stringify(got) === JSON.stringify(c.expect);
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${c.file}: ${got.length}/${c.expect.length}개, ${Math.round(res.ms)}ms, offset=${res.pageOffset}, sig=${JSON.stringify(res.signature)}`);
  if (!ok) {
    console.log('   got:', got.join(','));
    console.log('   exp:', c.expect.join(','));
  }
  const flagged = Object.entries(res.pageInfo).filter(([, v]) => v.flags.length);
  if (flagged.length) console.log('   flags:', JSON.stringify(flagged));
}
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
writeFileSync(new URL('./out/detect-results.json', import.meta.url), JSON.stringify(results, null, 1));
if (results['book-unit.pdf'] && results['answer-unit.pdf']) {
  const m = await page.evaluate(([p, a]) => window.harness.match(p, a), [results['book-unit.pdf'].items, results['answer-unit.pdf'].items]);
  const pairs = Object.entries(m);
  const wrong = pairs.filter(([pid, aid]) => {
    const p = results['book-unit.pdf'].items.find((i) => i.id === pid);
    const a = results['answer-unit.pdf'].items.find((i) => i.id === aid);
    return p.number !== a.number;
  });
  console.log(`match: ${pairs.length} pairs, wrong=${wrong.length}`);
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
