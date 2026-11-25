import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { supportsNumber, numberModelTrust, rescueNumberTokens, supportedNumberCandidates, mergeNumberModelAnchors } from '../../src/renderer/js/number-model.js';
import { extractCandidates, computeItems } from '../../src/renderer/js/detect.js';

const layout = { columns: [{ x0: 0.08, x1: 0.92 }], bodyTop: 0.04, bodyBottom: 0.96, spans: [] };
const token = (str, x0, y0, w = 0.03) => ({ str, x0, x1: x0 + w, y0, y1: y0 + 0.02, font: 'digits', conf: 100 });
const box = t => ({ x0: t.x0 - 0.001, y0: t.y0 - 0.001, x1: t.x1 + 0.001, y1: t.y1 + 0.001, score: 0.95 });
const tokens = () => Array.from({ length: 8 }, (_, i) => token(String(i + 1).padStart(3, '0'), 0.1, 0.08 + i * 0.1));
function page() {
  const ts = tokens(), w = 100, h = 140;
  return { index: 0, source: 'text', layout: structuredClone(layout), grid: { w, h, data: new Uint8Array(w * h).fill(1) },
    tokens: ts, candidates: extractCandidates(ts, layout).candidates, ocrPasses: [], footerNumbers: [], headings: [], ranges: [], needsOcr: false };
}

test('support: centre padding OR IoU; neighbouring glyph not supported', () => {
  const b = { x0: 0.1, x1: 0.2, y0: 0.1, y1: 0.2 };
  assert.equal(supportsNumber({ x0: 0.2, x1: 0.21, y0: 0.12, y1: 0.18 }, b), true);
  assert.equal(supportsNumber({ x0: 0.2, x1: 0.24, y0: 0.12, y1: 0.18 }, b), false);
  assert.equal(supportsNumber({ x0: 0.05, x1: 0.15, y0: 0.1, y1: 0.2 }, b), true);
  assert.equal(supportsNumber({ x0: 0.1, x1: 0.2, y0: 0.3, y1: 0.4 }, b), false);
});

test('trust: minimum evidence and two independent agreement ratios, no sequence inputs', () => {
  const p = page();
  p.numberBoxes = p.tokens.map(box);
  const anchors = new Map([[0, p.candidates]]);
  const stats = numberModelTrust([p], anchors);
  assert.equal(stats.trusted, true); assert.equal(stats.explainedRatio, 1); assert.equal(stats.supportedRatio, 1);
  // Arbitrary labels and order cannot affect visual trust.
  p.candidates.forEach((c, i) => { c.num = [4, 28, 2, 17, 90, 3, 6, 12][i]; });
  assert.equal(numberModelTrust([p], anchors).trusted, true);
  p.numberBoxes = p.numberBoxes.slice(0, 7);
  assert.equal(numberModelTrust([p], anchors).trusted, false);
  p.numberBoxes = [...p.tokens.map(box), ...Array.from({ length: 2 }, (_, i) => box(token('9', 0.7, 0.1 + i * 0.2)))];
  assert.equal(numberModelTrust([p], anchors).trusted, false);
  p.numberBoxes = p.tokens.map(box); p.numberModelFailed = true;
  assert.equal(numberModelTrust([p], anchors).trusted, false);
  delete p.numberModelFailed; p.numberBoxes = p.tokens.slice(0, 5).map(box);
  assert.equal(numberModelTrust([p], anchors, { minBoxes: 1 }).trusted, false);
});

test('rescue: existing parsing preserves prefix, style, digits, padding and column geometry', () => {
  const prefix = token('예제', 0.1, 0.2, 0.04), digit = token('03.', 0.148, 0.2, 0.03);
  const p = { layout, tokens: [prefix, digit], candidates: [] };
  const rescued = rescueNumberTokens(p, [box(digit)]);
  assert.equal(rescued.length, 1);
  const expected = extractCandidates(p.tokens, layout).candidates[0];
  for (const key of ['num', 'digits', 'prefix', 'style', 'padded', 'x0', 'x1', 'y0', 'y1', 'h', 'font', 'conf']) assert.equal(rescued[0][key], expected[key], key);
  assert.equal(rescued[0].prefix, '예제'); assert.equal(rescued[0].digits, '03');
  assert.deepEqual(rescueNumberTokens({ ...p, hiddenText: true }, [box(digit)]), []);
  assert.deepEqual(rescueNumberTokens({ ...p, tokens: [] }, [box(digit)]), []);
  const glued = token('유제12', 0.1, 0.2, 0.08);
  assert.equal(rescueNumberTokens({ layout, tokens: [glued] }, [box(glued)])[0].prefix, '유제');
});

test('trust: a blind prefix is retained without rejecting the covered main group', () => {
  const p = page();
  p.numberBoxes = p.tokens.map(box);
  const prefix = extractCandidates([token('예제', 0.4, 0.1, 0.04), token('1', 0.45, 0.1)], layout).candidates[0];
  const extras = Array.from({ length: 20 }, (_, i) => ({ ...prefix, y0: 0.1 + i * 0.02, y1: 0.12 + i * 0.02 }));
  const main = tokens().slice(0, 4).map(t => ({ ...t, x0: 0.25, x1: 0.28 }));
  p.tokens.push(...main); p.candidates.push(...extractCandidates(main, layout).candidates); p.numberBoxes.push(...main.map(box));
  const anchors = new Map([[0, [...p.candidates, ...extras]]]);
  const trust = numberModelTrust([p], anchors);
  assert.ok(trust.supportedRatio < 0.7);
  assert.equal(trust.trusted, true);
  assert.deepEqual(trust.blindPrefixes, ['예제']);
  assert.equal(trust.coveredAnchors, 12);
  assert.equal(trust.coveredSupportedRatio, 1);
  assert.equal(trust.groups.find(g => g.prefix === '예제').supported, 0);
});

test('trust: small prefix groups remain covered below the support ratio threshold', () => {
  const p = page(); p.numberBoxes = p.tokens.map(box);
  const small = p.candidates.slice(0, 3).map(c => ({ ...c, prefix: '유제', x0: 0.5, x1: 0.55 }));
  const trust = numberModelTrust([p], new Map([[0, [...p.candidates, ...small]]]));
  assert.equal(trust.trusted, true);
  assert.deepEqual(trust.blindPrefixes, []);
  assert.equal(trust.groups.find(g => g.prefix === '유제').ratio, 0);
  assert.equal(trust.groups.find(g => g.prefix === '유제').covered, true);
});

test('supported candidates: digit box, not prefix centre; rescue, deduplication and reading order', () => {
  const prefix = token('예제', 0.1, 0.2, 0.04), digit = token('3', 0.15, 0.2, 0.012);
  const later = token('042', 0.1, 0.4);
  const p = { layout, tokens: [prefix, digit, later], candidates: extractCandidates([prefix, digit], layout).candidates,
    numberBoxes: [box(later), box(digit), box(digit)] };
  const selected = supportedNumberCandidates(p);
  assert.deepEqual(selected.map(c => [c.prefix, c.num]), [['예제', 3], ['', 42]]);
});

const root = new URL('../../src/renderer/js/', import.meta.url);
const hooks = registerHooks({ load(url, ctx, next) {
  if (url === new URL('ocr.js', root).href) return { format: 'module', shortCircuit: true, source: "export const OCR_WORKERS=1; export function recognizeWords(){throw Error('unexpected OCR')} export function recognizeLine(){throw Error('unexpected OCR')}" };
  if (url === new URL('docsource.js', root).href) return { format: 'module', shortCircuit: true, source: "export function createCanvas(){throw Error('unexpected canvas')}" };
  if (url === new URL('analyze.js', root).href) return { format: 'module', shortCircuit: true, source: readFileSync(new URL(url), 'utf8').replace('  const canvas = await src.renderPage(index, ANALYSIS_WIDTH);', '  return structuredClone(src.syntheticPages?.[index] || src.synthetic);\n  const canvas = await src.renderPage(index, ANALYSIS_WIDTH);') };
  return next(url, ctx);
} });
let analyzeDocument, reanalyzeSinglePage, applyNumberModel, buildCutters;
try { ({ analyzeDocument, reanalyzeSinglePage, applyNumberModel, buildCutters } = await import('../../src/renderer/js/analyze.js')); } finally { hooks.deregister(); }
function source(p) {
  return { synthetic: p, numPages: 1, pages: [{ w: 724, h: 1024 }], async renderPage() {
    return { width: 724, height: 1024, getContext: () => ({ getImageData: () => ({ width: 724, height: 1024, data: new Uint8Array(724 * 1024 * 4) }) }) };
  } };
}
test('pipeline: no model and untrusted/failed model yield identical anchors, items and metadata', async () => {
  const src = source(page()), opts = { pages: [0] };
  const plain = await analyzeDocument(src, opts);
  assert.deepEqual(plain.items.map(i => i.num), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const detect of [async () => [], async () => [box(token('9', 0.7, 0.1))], async () => { throw Error('offline'); }]) {
    const actual = await analyzeDocument(src, { ...opts, numberModel: { detect } });
    assert.deepEqual(actual, plain);
    const doc = { ...plain, options: { flow: 'column' } };
    const single = await reanalyzeSinglePage(src, doc, 0, { deep: false });
    const again = await reanalyzeSinglePage(src, doc, 0, { deep: false, numberModel: { detect } });
    assert.deepEqual(again, single);
  }
});

test('pipeline: visual support restores group-rejected candidates and token rescue, removes fakes', async () => {
  const p = page(), extra = token('73', 0.1, 0.89), fake = token('9', 0.1, 0.93), rare = token('[42]', 0.3, 0.52, 0.04);
  p.tokens.push(extra, fake, rare); p.candidates.push(...extractCandidates([fake, rare], layout).candidates);
  const boxes = [...p.tokens.slice(0, 8), extra, rare].map(box);
  let stats;
  const result = await analyzeDocument(source(p), { pages: [0], numberModel: { detect: async () => boxes, onResult: s => { stats = s; } } });
  assert.equal(stats.trusted, true);
  assert.deepEqual(result.items.map(i => i.num), [1, 2, 3, 4, 5, 42, 6, 7, 8, 73]);
  const again = await reanalyzeSinglePage(source(p), { ...result, numberModel: { trusted: true, blindPrefixes: [] } }, 0, { deep: false, numberModel: { detect: async () => boxes } });
  assert.deepEqual(again.items.map(i => i.num), result.items.map(i => i.num));
  const doc = { ...result, numberModelTrusted: false };
  const legacy = await reanalyzeSinglePage(source(p), doc, 0, { deep: false });
  const untrusted = await reanalyzeSinglePage(source(p), doc, 0, { deep: false, numberModel: { detect: async () => boxes } });
  assert.deepEqual(untrusted, legacy);
});

test('blind groups: mixed anchors deduplicate and preserve original objects and context boundaries', () => {
  const p = page();
  const c = { ...p.candidates[0], prefix: '예제', x0: 0.4, x1: 0.45, y0: 0.08, y1: 0.1 };
  const blind = Array.from({ length: 4 }, (_, i) => ({ ...c, num: i + 1, y0: 0.08 + i * 0.1, y1: 0.1 + i * 0.1 }));
  p.candidates.push(...blind);
  p.numberBoxes = p.tokens.map(box);
  const heading = { x0: 0.08, x1: 0.92, y0: 0.12, y1: 0.14 };
  p.contextHeadings = [heading];
  const today = [...p.candidates];
  const merged = mergeNumberModelAnchors(p, [...today, blind[0]], ['예제']);
  assert.equal(merged.filter(a => a === blind[0]).length, 1);
  const layouts = new Map([[0, p.layout]]), grids = new Map([[0, p.grid]]);
  const items = anchors => computeItems([0], anchors, layouts, grids, { cutters: buildCutters([p], anchors, null) });
  const anchors = new Map([[0, today]]);
  const before = items(anchors).filter(i => i.prefix === '예제');
  let stats;
  assert.equal(applyNumberModel([p], anchors, { onResult(s) { stats = s; } }), true);
  assert.deepEqual(stats.blindPrefixes, ['예제']);
  assert.strictEqual(p.contextHeadings[0], heading);
  assert.ok(blind.every(c => anchors.get(0).includes(c)));
  assert.deepEqual(items(anchors).filter(i => i.prefix === '예제'), before);
  p.contextHeadings = [];
  assert.notDeepEqual(items(anchors).filter(i => i.prefix === '예제'), before);
});

test('context boundaries: remove only those overlapping covered anchors when no blind group exists', () => {
  const p = page(); p.numberBoxes = p.tokens.map(box);
  const own = { ...p.tokens[0] }, unrelated = { x0: 0.3, x1: 0.8, y0: 0.9, y1: 0.92 };
  p.contextHeadings = [own, unrelated];
  applyNumberModel([p], new Map([[0, p.candidates]]), {});
  assert.deepEqual(p.contextHeadings, [unrelated]);
});

test('single page: saved blind prefixes are reused even when locally supported', async () => {
  const p = page();
  p.candidates.forEach(c => { c.prefix = '예제'; });
  const plain = await reanalyzeSinglePage(source(p), {}, 0, { deep: false });
  const extra = token('73', 0.1, 0.89);
  p.tokens.push(extra);
  let stats;
  const result = await reanalyzeSinglePage(source(p), { numberModelTrusted: true,
    numberModel: { trusted: true, blindPrefixes: ['예제'] } }, 0, { deep: false,
    numberModel: { detect: async () => [...p.tokens.slice(0, 8), extra].map(box), onResult(s) { stats = s; } } });
  assert.deepEqual(stats.blindPrefixes, ['예제']);
  // No covered final anchors on this page: its rules-only output is unchanged.
  assert.equal(stats.trusted, false);
  assert.deepEqual(result.items, plain.items);
});

test('cancellation: abort does not wait for a slow detection or schedule another one', async () => {
  const ctrl = new AbortController();
  let finish, started, calls = 0, notifications = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const slow = new Promise(resolve => { finish = resolve; });
  const src = source(page());
  src.numPages = 2; src.pages.push(src.pages[0]);
  const analysis = analyzeDocument(src, { pages: [0, 1], signal: ctrl.signal,
    numberModel: { detect() { calls++; started(); return slow; }, onResult() { notifications++; } } });
  const outcome = analysis.then(() => 'resolved', err => err.name);
  await ready; ctrl.abort();
  let timer;
  const result = await Promise.race([outcome, new Promise(resolve => { timer = setTimeout(() => resolve('blocked'), 100); })]);
  clearTimeout(timer);
  finish([]);
  await outcome;
  await new Promise(setImmediate);
  assert.equal(result, 'AbortError');
  assert.equal(calls, 1);
  assert.equal(notifications, 0);
});

test('cancellation: late model rejection is consumed after abort', async () => {
  const ctrl = new AbortController();
  let fail, started;
  const ready = new Promise(resolve => { started = resolve; });
  const analysis = analyzeDocument(source(page()), { pages: [0], signal: ctrl.signal, numberModel: {
    detect() { started(); return new Promise((resolve, reject) => { fail = reject; }); },
  } });
  const rejected = assert.rejects(analysis, { name: 'AbortError' });
  await ready; ctrl.abort(); await rejected;
  fail(new Error('late inference failure'));
  await new Promise(setImmediate);
});

const manyPages = (n, extra = {}) => {
  const src = source(page());
  src.syntheticPages = Array.from({ length: n }, (_, index) => ({ ...page(), index, ...extra }));
  src.pages = src.syntheticPages.map(() => ({ w: 724, h: 1024 })); src.numPages = src.pages.length;
  return src;
};

test('probe: 빈 쪽이 아닌 앞 24쪽에서 번호가 20개 미만이면 멈추고 규칙 결과는 그대로', async () => {
  const src = manyPages(30);
  src.syntheticPages[0].candidates = []; // 표지처럼 후보가 없는 쪽도 셈
  src.syntheticPages[1].layout.blank = true; // 빈 쪽은 모델도 안 돌리고 세지도 않음
  const pages = src.pages.map((_, i) => i);
  const before = await analyzeDocument(src, { pages });
  let calls = 0, stats;
  // 쪽마다 상자 0개, 단 첫 쪽만 19개 → 24쪽까지 19개
  const after = await analyzeDocument(src, { pages, numberModel: { async detect() { return calls++ ? [] : Array.from({ length: 19 }, () => box(tokens()[0])); }, onResult(s) { stats = s; } } });
  assert.equal(calls, 24);
  assert.equal(stats.pagesRun, 24); assert.equal(stats.evidencePages, 24); assert.equal(stats.probeBoxes, 19);
  assert.equal(stats.earlyStopped, true); assert.equal(stats.trusted, false); assert.equal(stats.failed, false);
  assert.deepEqual(after, before);
});

test('probe: 앞 24쪽에 번호가 20개 이상이면 끝까지 돌림', async () => {
  const src = manyPages(26);
  let calls = 0, stats;
  await analyzeDocument(src, { pages: src.pages.map((_, i) => i), numberModel: {
    async detect() { calls++; return tokens().map(box); }, onResult(s) { stats = s; } } });
  assert.equal(calls, 26); assert.equal(stats.pagesRun, 26); assert.equal(stats.evidencePages, 24); assert.equal(stats.earlyStopped, false);
});

test('probe: 번호를 OCR 로 읽는 책(모델이 끝날 때 후보가 아직 없음)도 24쪽에서 멈춤', async () => {
  const src = manyPages(30, { source: 'ocr', candidates: [], ocrPasses: [] });
  const pages = src.pages.map((_, i) => i);
  const before = await analyzeDocument(src, { pages });
  let calls = 0, stats;
  const after = await analyzeDocument(src, { pages, numberModel: { async detect() { calls++; return []; }, onResult(s) { stats = s; } } });
  assert.equal(calls, 24); assert.equal(stats.earlyStopped, true);
  assert.deepEqual(after, before);
});
