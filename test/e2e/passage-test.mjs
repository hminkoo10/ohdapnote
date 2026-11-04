// 국어·영어 지문 세트 묶기 채점 — 지문([1~3] 다음 글을 읽고 …)과 거기 딸린 문항을 정확히 묶는지
// 먼저: node test/fixtures/make-passages.mjs
// 사용: node test/e2e/passage-test.mjs [korean-exam|english-exam|korean-book|english-book|korean-exam-scan|...]
//
// 문항마다 이 넷이 모두 맞아야 '정확':
//  1) 번호   — 그 번호 문항을 찾음
//  2) 세트   — 붙은 지문 이름(stemLabel)이 정답 세트와 같음 (단독 문항은 지문 없음)
//  3) 지문   — 붙은 지문 영역이 그 세트 지문 표식을 모두 담고, 문항·다른 세트 표식은 담지 않음
//  4) 문항   — 문항 영역이 자기 표식을 모두 담고, 지문·다른 문항 표식은 담지 않음
// 표식(흰색 1px 글자 ZZP…/ZZQ…)은 디지털 원본에서 읽음 (스캔본도 같은 배치)
import { chromium } from '../lib/playwright.mjs';
import { startServer } from '../lib/server.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const expected = JSON.parse(readFileSync(new URL('../fixtures/generated/passages-expected.json', import.meta.url)));
// target: 정확한 문항 비율 목표 (스캔본은 OCR 이라 조금 낮게)
const CASES = {
  'korean-exam': { file: 'korean-exam.pdf', subject: 'korean', target: 1 },
  'english-exam': { file: 'english-exam.pdf', subject: 'english', target: 1 },
  'korean-book': { file: 'korean-book.pdf', subject: 'korean', target: 1 },
  'english-book': { file: 'english-book.pdf', subject: 'english', target: 1 },
  'korean-exam-scan': { file: 'korean-exam-scan.pdf', markers: 'korean-exam.pdf', key: 'korean-exam', subject: 'korean', target: 0.9, tol: 0.007 },
  'english-exam-scan': { file: 'english-exam-scan.pdf', markers: 'english-exam.pdf', key: 'english-exam', subject: 'english', target: 0.9, tol: 0.007 },
  'korean-book-scan': { file: 'korean-book-scan.pdf', markers: 'korean-book.pdf', key: 'korean-book', subject: 'korean', target: 0.9, tol: 0.007 },
};
const args = process.argv.slice(2);
const subjectOverride = args.find((a) => a.startsWith('--subject='))?.slice(10);
const only = args.filter((a) => !a.startsWith('--'));
const { server, url } = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${url}/test/e2e/harness.html`);
await page.waitForFunction(() => window.harnessReady);
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
const summary = [];
let failures = 0;
for (const [name, c] of Object.entries(CASES)) {
  if (only.length && !only.includes(name)) continue;
  const exp = expected[c.key || name];
  const base = `${url}/test/fixtures/generated/`;
  const subject = subjectOverride ?? c.subject;
  const res = await page.evaluate(
    async ([docUrl, markerUrl, subject]) => {
      const { openDocSource } = await import('/src/renderer/js/docsource.js');
      const { analyzeDocument, parsePageRange } = await import('/src/renderer/js/analyze.js');
      const open = (u) => openDocSource([{ name: u, kind: 'pdf' }], (n) => n);
      const src = await open(docUrl);
      const t0 = performance.now();
      const r = await analyzeDocument(src, { pages: parsePageRange('', src.numPages), role: 'problem', flow: 'column', subject: subject || undefined });
      const ms = performance.now() - t0;
      const ms2 = await open(markerUrl);
      const markers = {};
      for (let i = 0; i < ms2.numPages; i++) {
        for (const t of await ms2.getTextTokens(i)) {
          const m = /^ZZ([PQ]\d+k\d+)$/.exec(t.str);
          if (m) markers[m[1]] = { page: i, x: (t.x0 + t.x1) / 2, y: (t.y0 + t.y1) / 2 };
        }
      }
      const items = r.items.map((it) => ({ id: it.id, page: it.page, number: it.number, num: it.num, prefix: it.prefix || '', rects: it.rects, stem: it.stem || null, stemLabel: it.stemLabel || '', stemId: it.stemId || '' }));
      return { ms, items, markers, flags: Object.entries(r.pageInfo).filter(([, v]) => v.flags.length).map(([k, v]) => `${+k + 1}쪽:${v.flags.join('/')}`) };
    },
    [base + c.file, base + (c.markers || c.file), subject],
  );

  const tol = c.tol ?? 0.004;
  const inRect = (r, pt) => r.page === pt.page && pt.x >= r.x - tol && pt.x <= r.x + r.w + tol && pt.y >= r.y - tol && pt.y <= r.y + r.h + tol;
  const inAny = (rects, key) => !!res.markers[key] && (rects || []).some((r) => inRect(r, res.markers[key]));
  const missingMarkers = [...exp.sets.flatMap((s) => s.keys), ...exp.questions.flatMap((q) => q.keys)].filter((k) => !res.markers[k]);
  const setKeys = new Map(exp.sets.map((s) => [s.label, s.keys]));
  const allPassageKeys = exp.sets.flatMap((s) => s.keys);
  const allQuestionKeys = exp.questions.map((q) => q.keys);
  const norm = (label) => (label ? label.split('~').map((v) => +v).join('~') : '');

  // 정답 문항 ↔ 찾은 문항 (번호 순서대로 짝짓기; 같은 번호가 다시 나와도 앞에서부터)
  const pool = res.items.filter((it) => !it.prefix);
  let cursor = 0;
  const rows = [];
  for (const [qi, q] of exp.questions.entries()) {
    let found = null;
    for (let j = cursor; j < pool.length; j++) {
      if (pool[j].num === q.n) {
        found = pool[j];
        cursor = j + 1;
        break;
      }
    }
    const row = { n: q.n, set: q.set, found: !!found, setOk: false, stemOk: false, itemOk: false, why: [] };
    if (!found) {
      row.why.push('번호 못 찾음');
      rows.push(row);
      continue;
    }
    row.setOk = norm(found.stemLabel) === norm(q.set);
    if (!row.setOk) row.why.push(`세트 ${found.stemLabel || '없음'} (정답 ${q.set || '없음'})`);
    if (q.set) {
      const own = setKeys.get(q.set) || [];
      const lost = own.filter((k) => !inAny(found.stem, k));
      const foreign = [...allPassageKeys.filter((k) => !own.includes(k)), ...allQuestionKeys.flat()].filter((k) => inAny(found.stem, k));
      row.stemOk = row.setOk && !lost.length && !foreign.length;
      if (lost.length) row.why.push(`지문 빠짐 ${lost.length}/${own.length}`);
      if (foreign.length) row.why.push(`지문에 다른 글 ${foreign.slice(0, 3).join(',')}`);
    } else {
      row.stemOk = !found.stem?.length;
      if (!row.stemOk) row.why.push('단독 문항에 지문이 붙음');
    }
    const ownQ = allQuestionKeys[qi];
    const lostQ = ownQ.filter((k) => !inAny(found.rects, k));
    const foreignQ = [...allPassageKeys, ...allQuestionKeys.filter((_, j) => j !== qi).flat()].filter((k) => inAny(found.rects, k));
    row.itemOk = !lostQ.length && !foreignQ.length;
    if (lostQ.length) row.why.push(`문항 글 빠짐 ${lostQ.length}/${ownQ.length}`);
    if (foreignQ.length) row.why.push(`문항에 다른 글 ${foreignQ.slice(0, 3).join(',')}`);
    rows.push(row);
  }
  const N = rows.length;
  const count = (f) => rows.filter(f).length;
  const ok = (r) => r.found && r.setOk && r.stemOk && r.itemOk;
  const okN = count(ok);
  const setRows = rows.filter((r) => r.set);
  const sets = exp.sets.map((s) => rows.filter((r) => r.set === s.label));
  const setsOk = sets.filter((list) => list.length && list.every(ok)).length;
  const extra = pool.length - count((r) => r.found);
  const acc = okN / N;
  const pass = acc >= c.target && !missingMarkers.length;
  if (!pass) failures++;
  console.log(`\n${pass ? '✅' : '❌'} ${name}  (${Math.round(res.ms)}ms, 문항 ${N}개 · 세트 ${exp.sets.length}개)`);
  console.log(`  지문-문항 묶기 정확: ${okN}/${N} = ${pct(okN, N)} (목표 ${pct(c.target, 1)})`);
  console.log(`   ├ 번호 찾음 ${count((r) => r.found)}/${N} · 세트 맞음 ${count((r) => r.found && r.setOk)}/${N} (세트 문항 ${setRows.filter((r) => r.found && r.setOk).length}/${setRows.length})`);
  console.log(`   ├ 지문 영역 맞음 ${count((r) => r.found && r.stemOk)}/${N} · 문항 영역 맞음 ${count((r) => r.found && r.itemOk)}/${N}`);
  console.log(`   └ 세트 통째로 맞음 ${setsOk}/${exp.sets.length}${extra > 0 ? ` · 정답에 없는 문항 ${extra}개` : ''}`);
  if (missingMarkers.length) console.log(`  (표식을 못 읽음: ${missingMarkers.slice(0, 5).join(',')})`);
  for (const r of rows.filter((x) => !ok(x))) console.log(`    ✗ ${r.n}번${r.set ? ` [${r.set}]` : ''}: ${r.why.join(' / ')}`);
  if (res.flags.length) console.log(`  확인 필요 쪽: ${res.flags.join('  ')}`);
  summary.push(`${pass ? '✅' : '❌'} ${name.padEnd(18)} ${pct(okN, N).padStart(6)}  (${okN}/${N}, 세트 ${setsOk}/${exp.sets.length}, 목표 ${pct(c.target, 1)})`);
  writeFileSync(new URL(`./out/passages-${name}.json`, import.meta.url), JSON.stringify({ ...res, rows }, null, 1));
}
await browser.close();
server.close();
console.log(`\n${summary.join('\n')}`);
process.exit(failures ? 1 : 0);
