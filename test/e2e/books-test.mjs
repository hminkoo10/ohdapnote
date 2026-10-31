// 시중 문제집형 테스트 책으로 인식·매칭·"쪽을 넘어가는 해설"을 자동 채점합니다.
// 먼저: node test/fixtures/make-books.mjs
// 사용: node test/e2e/books-test.mjs [ssen|suteuk|ssen-scan]
import { chromium } from '../lib/playwright.mjs';
import { startServer } from '../lib/server.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const expected = JSON.parse(readFileSync(new URL('../fixtures/generated/books-expected.json', import.meta.url)));
const CASES = {
  ssen: { prob: 'ssen-problem.pdf', ans: 'ssen-answer.pdf', key: 'ssen', cols: 3 },
  suteuk: { prob: 'suteuk-problem.pdf', ans: 'suteuk-answer.pdf', key: 'suteuk', cols: 2 },
  // 스캔본(흐림·잡티·기울기)은 OCR 특성상 90% 이상이면 통과로 봄 (놓친 쪽은 '확인 필요'로 표시됨)
  hard: { prob: 'hard-problem.pdf', ans: 'hard-answer.pdf', key: 'hard', cols: 2, stems: true },
  'ssen-scan': { prob: 'ssen-problem.pdf', ans: 'ssen-answer-scan.pdf', markers: 'ssen-answer.pdf', key: 'ssen', cols: 3, tolerance: 0.9 },
};
const only = process.argv.slice(2);
const { server, url } = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${url}/test/e2e/harness.html`);
await page.waitForFunction(() => window.harnessReady);
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });

let failures = 0;
for (const [name, c] of Object.entries(CASES)) {
  if (only.length && !only.includes(name)) continue;
  const exp = expected[c.key];
  const base = `${url}/test/fixtures/generated/`;
  const res = await page.evaluate(
    async ([probUrl, ansUrl, markerUrl]) => {
      const { openDocSource } = await import('/src/renderer/js/docsource.js');
      const { analyzeDocument, parsePageRange } = await import('/src/renderer/js/analyze.js');
      const { matchItems } = await import('/src/renderer/js/match.js');
      const { sortItems } = await import('/src/renderer/js/detect.js');
      const open = (u) => openDocSource([{ name: u, kind: 'pdf' }], (n) => n);
      const ps = await open(probUrl);
      const as = await open(ansUrl);
      const t0 = performance.now();
      const pr = await analyzeDocument(ps, { pages: parsePageRange('', ps.numPages), role: 'problem', flow: 'column' });
      const ar = await analyzeDocument(as, { pages: parsePageRange('', as.numPages), role: 'answer', flow: 'continue' });
      const ms = performance.now() - t0;
      // 해설 끝 표식 위치(디지털 원본에서)
      const ms2 = await open(markerUrl);
      const markers = {};
      for (let i = 0; i < ms2.numPages; i++) {
        for (const t of await ms2.getTextTokens(i)) {
          const m = /^ZZE(.+)$/.exec(t.str);
          if (m) markers[m[1]] = { page: i, x: (t.x0 + t.x1) / 2, y: (t.y0 + t.y1) / 2 };
        }
      }
      const P = sortItems(pr.items);
      const A = sortItems(ar.items);
      const m = matchItems(P, A);
      const strip = (it) => ({ id: it.id, page: it.page, number: it.number, prefix: it.prefix || '', rects: it.rects, stemLabel: it.stemLabel || '' });
      return { ms, P: P.map(strip), A: A.map(strip), match: Object.fromEntries(m), markers, ansFlags: ar.pageInfo, probFlags: pr.pageInfo };
    },
    [base + c.prob, base + c.ans, base + (c.markers || c.ans)],
  );

  // ---- 1) 문제 번호 인식 ----
  const gotProb = res.P.map((i) => (i.prefix ? `${i.prefix} ${i.number}` : i.number));
  const probOk = JSON.stringify(gotProb) === JSON.stringify(exp.probLabels);
  // ---- 2) 답지 항목 ↔ 해설 키 (표식이 들어 있는 항목) ----
  const inRect = (r, pt) => r.page === pt.page && pt.x >= r.x - 0.004 && pt.x <= r.x + r.w + 0.004 && pt.y >= r.y - 0.004 && pt.y <= r.y + r.h + 0.004;
  const keyOfAns = new Map();
  for (const [key, pt] of Object.entries(res.markers)) {
    const hit = res.A.filter((a) => a.rects.some((r) => inRect(r, pt)));
    if (hit.length === 1) keyOfAns.set(hit[0].id, key);
  }
  // ---- 3) 매칭 채점 ----
  let correct = 0;
  const wrong = [];
  res.P.forEach((p, i) => {
    const key = probOk ? exp.probKeys[i] : null;
    const aid = res.match[p.id];
    const akey = aid ? keyOfAns.get(aid) : null;
    const hasAnswer = exp.ansKeys.includes(key);
    if (key && (hasAnswer ? akey === key : !aid)) correct++;
    else wrong.push(`${gotProb[i]}(${key})→${aid ? `${aid}[${akey}]` : '없음'}`);
  });
  // ---- 4) 쪽·단을 넘어가는 긴 해설 ----
  const longReport = [];
  let longOk = 0;
  for (const key of exp.longKeys) {
    const pt = res.markers[key];
    const ansId = [...keyOfAns.entries()].find(([, k]) => k === key)?.[0];
    const a = res.A.find((x) => x.id === ansId);
    const startPage = a?.page;
    const spanPages = a ? [...new Set(a.rects.map((r) => r.page))] : [];
    const ok = !!a && a.rects.some((r) => inRect(r, pt)) && a.rects.every((r) => r.y > 0.055);
    if (ok) longOk++;
    longReport.push(`${key}: ${a ? `쪽 ${spanPages.map((p) => p + 1).join('→')} (영역 ${a.rects.length}개)` : '항목 없음'}${pt.page !== startPage ? ' [쪽 넘어감]' : ''}${ok ? '' : ' ✗'}`);
  }
  // 공통 지문: [a~b] 범위 안 문항에 지문이 붙었는지
  let stemReport = '';
  if (c.stems) {
    const withStem = res.P.filter((p) => p.stemLabel);
    const okStem = withStem.filter((p) => {
      const [a, b] = p.stemLabel.split('~').map(Number);
      return +p.number >= a && +p.number <= b;
    });
    stemReport = `공통 지문 붙은 문항: ${okStem.length}/${withStem.length} (기대 9)`;
    if (okStem.length !== 9 || withStem.length !== 9) failures++;
  }
  const need = c.tolerance ? Math.ceil(res.P.length * c.tolerance) : res.P.length;
  const allOk = probOk && correct >= need && longOk === exp.longKeys.length;
  if (!allOk) failures++;
  console.log(`\n${allOk ? '✅' : '❌'} ${name}  (${Math.round(res.ms)}ms)`);
  console.log(`  문제 번호: ${gotProb.length}/${exp.probLabels.length} ${probOk ? '정확' : '불일치'}`);
  if (!probOk) {
    console.log('    got:', gotProb.join(','));
    console.log('    exp:', exp.probLabels.join(','));
  }
  console.log(`  답지 항목: ${res.A.length}개 (해설과 연결된 것 ${keyOfAns.size}/${exp.ansKeys.length})`);
  console.log(`  해설 짝: ${correct}/${res.P.length} 정확 (답지에 없는 예제는 '짝 없음'이 정답)`);
  if (wrong.length) console.log('    틀림:', wrong.slice(0, 12).join('  '));
  if (stemReport) console.log('  ' + stemReport);
  console.log(`  긴 해설(단·쪽 넘어감): ${longOk}/${exp.longKeys.length}`);
  longReport.forEach((l) => console.log('    ' + l));
  const flagged = Object.entries(res.ansFlags).filter(([, v]) => v.flags.length).map(([k, v]) => `${+k + 1}쪽:${v.flags.join('/')}`);
  if (flagged.length) console.log('  답지 확인 필요:', flagged.join('  '));
  writeFileSync(new URL(`./out/books-${name}.json`, import.meta.url), JSON.stringify(res, null, 1));
}
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
