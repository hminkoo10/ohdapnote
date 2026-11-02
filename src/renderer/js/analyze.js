// 문서 분석 파이프라인: 렌더링 → 레이아웃 → (텍스트 | OCR) → 번호 선택 → 영역 계산
// (Gemini 는 사용자가 고른 쪽만 따로: detectPageWithGemini)

import { analyzeLayout, inkGridFromCanvas, trimRect, inkCount, findLabelBlocks, cutAbove, snapUpToGap } from './layout.js';
import {
  extractCandidates,
  selectAnchors,
  flagPages,
  computeItems,
  assignIds,
  sortItems,
  columnOf,
  zoneOf,
  guessPageOffset,
  findCutters,
  looksLikeAnswerTable,
  fillGapsFromCandidates,
  chooseExpectedChain,
  dropStrayRuns,
  byReadingOrder,
  schemeKey,
  mergeFigureColumns,
} from './detect.js';
import { recognizeWords, recognizeLine, OCR_WORKERS } from './ocr.js';
import { geminiDetect, canvasToBase64Jpeg } from './gemini.js';
import { createCanvas } from './docsource.js';

const ANALYSIS_WIDTH = 960; // 레이아웃 분석용 렌더링 폭(px)
// OCR 방식(렌더링 폭 px): 처음엔 쪽 전체 + 번호 띠, 번호가 빠진 쪽은 해상도를 바꿔 한 번 더(놓치는 글자가 달라짐)
const OCR_PASSES = [
  { width: 1700, mode: 'page' },
  { width: 2300, mode: 'strips' },
];
const OCR_RETRY = [{ width: 2300, mode: 'page' }];
const CROP_WIDTH = 2300; // 빠진 번호 자리를 하나씩 잘라 읽을 때
// 쪽 전체·다시 읽기·숫자 자리는 숫자만 보면 되니 영어만 (한국어를 같이 읽으면 2~3배 느림).
// 말머리("유제 3")는 번호 띠에서 설정한 언어로 읽음
const DIGIT_LANG = 'eng';
const GEMINI_WIDTH = 1500;

const abortIfNeeded = (signal) => {
  if (signal?.aborted) throw new DOMException('분석을 취소했습니다.', 'AbortError');
};

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** "1-10, 15, 20-" 같은 쪽 범위 문자열 → 0부터 시작하는 쪽 번호 배열 */
export function parsePageRange(text, numPages) {
  const s = String(text || '').trim();
  if (!s) return Array.from({ length: numPages }, (_, i) => i);
  const set = new Set();
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d*)\s*[-~]\s*(\d*)$/.exec(part);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : numPages;
      for (let p = Math.max(1, a); p <= Math.min(numPages, b); p++) set.add(p - 1);
    } else if (/^\d+$/.test(part)) {
      const p = parseInt(part, 10);
      if (p >= 1 && p <= numPages) set.add(p - 1);
    } else {
      throw new Error(`쪽 범위를 이해하지 못했습니다: "${part}"`);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 단 구분을 잉크로 못 찾았을 때(1단으로 보일 때), 번호 후보가 쪽 가운데쯤에 줄지어 있으면 2단으로 봅니다.
 * @returns {boolean} 단을 바꿨는지
 */
function splitAt(page, mx) {
  const L = page.layout;
  const col = L.columns[0];
  // 바로 왼쪽은 대체로 비어 있어야 함 (단 사이 빈칸)
  const area = { x: mx - 0.011, y: L.bodyTop, w: 0.008, h: L.bodyBottom - L.bodyTop };
  const cells = Math.max(1, Math.ceil(area.w * page.grid.w) * Math.round(area.h * page.grid.h));
  if (inkCount(page.grid, area) / cells > 0.15) return false;
  L.columns = [
    { x0: col.x0, x1: mx - 0.015 },
    { x0: mx - 0.004, x1: col.x1 },
  ];
  L.inferred = mx;
  return true;
}

function inferColumnsFromCandidates(page, splitHint = null) {
  const L = page.layout;
  if (L.columns.length !== 1 || L.merged) return false;
  const col = L.columns[0];
  const width = col.x1 - col.x0;
  if (width < 0.55) return false;
  // 같은 책 앞 쪽에서 찾은 단 위치가 있으면 그대로 써 봄
  if (splitHint != null && splitHint > col.x0 + 0.2 && splitHint < col.x1 - 0.2 && splitAt(page, splitHint)) return true;
  if (page.candidates.length < 3) return false;
  const mid = page.candidates.filter((c) => c.x0 > col.x0 + width * 0.38 && c.x0 < col.x0 + width * 0.66);
  const left = page.candidates.filter((c) => c.x0 < col.x0 + 0.06);
  if (mid.length < 2 || !left.length) return false;
  // 가운데쯤에서 x 가 거의 같은 번호가 2개 이상인 가장 왼쪽 위치 (= 둘째 단 시작)
  const xs = mid.map((c) => c.x0).sort((a, b) => a - b);
  let mx = null;
  for (const x of xs) {
    if (xs.filter((v) => v >= x - 0.002 && v <= x + 0.03).length >= 2) {
      mx = x;
      break;
    }
  }
  if (mx == null) return false;
  return splitAt(page, mx);
}

/**
 * 한 쪽의 레이아웃과 글자 레이어(있으면)까지 읽습니다. OCR 이 필요하면 needsOcr = true.
 *  - 스캔본 위에 보이지 않게 깔린 OCR 글자(휴대폰 스캔 앱 등)는 한글이 엉터리인 경우가 많아 쓰지 않습니다.
 */
async function readPage(src, index, { forceOcr = false, ocrFallback = true, deep = false, splitHint = null } = {}) {
  const canvas = await src.renderPage(index, ANALYSIS_WIDTH);
  const grid = inkGridFromCanvas(canvas);
  const layout = analyzeLayout(grid);
  const page = { index, layout, grid, candidates: [], source: 'text', footerNumbers: [], headings: [], ranges: [], ocrPasses: [], needsOcr: false };
  if (layout.blank) return page;

  let tokens = forceOcr ? [] : await src.getTextTokens(index);
  if (tokens.length && (await src.hasOnlyHiddenText(index))) {
    tokens = [];
    page.hiddenText = true;
  }
  const textChars = tokens.reduce((n, t) => n + t.str.length, 0);
  const runText = () => {
    const ex = extractCandidates(tokens, layout);
    page.candidates = ex.candidates;
    page.headings = ex.headings;
    page.ranges = ex.ranges;
    page.answerBoxes = ex.answerBoxes;
    page.sectionLabels = ex.sectionLabels;
  };
  if (textChars >= 30) {
    runText();
    if (inferColumnsFromCandidates(page, splitHint) || mergeFigureColumns(page)) runText();
    promoteFullWidthHeadings(page);
    for (const t of tokens) {
      const cy = (t.y0 + t.y1) / 2;
      const inMargin = (layout.hasHeader && cy < layout.bodyTop) || (layout.hasFooter && cy > layout.bodyBottom);
      if (inMargin && /^\d{1,4}$/.test(t.str)) page.footerNumbers.push(parseInt(t.str, 10));
    }
    if (page.candidates.length > 0 && !deep) return page;
    // 글자는 있는데 번호가 없는 쪽(개념 설명 쪽 등). 번호가 그림/도형으로 그려진 책일 수도 있음
    page.textWithoutNumbers = page.candidates.length === 0;
    if (!ocrFallback && !deep) return page;
  }
  page.needsOcr = true;
  return page;
}

/**
 * OCR → 단어 토큰(비율 좌표). 두 가지 방식을 함께 씀 (서로 놓치는 번호가 다름)
 *  - page  : 쪽 전체를 흩어진 글자 모드로 — 한 줄에 나란한 문항, 색 상자 속 번호
 *  - strips: 단마다 번호가 있는 왼쪽 띠만 — 홀로 떨어진 한 자리 번호("1", "3")
 */
async function ocrTokens(src, page, { width, mode }, ocrLang) {
  const hi = await src.renderPage(page.index, width);
  const W = hi.width;
  const H = hi.height;
  const toTokens = (words, sx0 = 0, sy0 = 0) => words.map((w) => ({ str: w.str, conf: w.conf, x0: sx0 + w.x0 / W, x1: sx0 + w.x1 / W, y0: sy0 + w.y0 / H, y1: sy0 + w.y1 / H }));
  if (mode === 'page') return toTokens(await recognizeWords(hi, { lang: DIGIT_LANG, psm: '11' }));
  const L = page.layout;
  const y0 = Math.max(0, L.bodyTop - 0.006);
  const y1 = Math.min(1, L.bodyBottom + 0.006);
  const strips = L.columns.map((col) => [Math.max(0, col.x0 - 0.012), Math.min(col.x1, col.x0 + 0.17)]);
  // 1단으로 보이면 가운데쯤(둘째 단 시작일 수 있는 곳)도 읽어 봄
  if (L.columns.length === 1 && L.columns[0].x1 - L.columns[0].x0 > 0.55) {
    const c = L.columns[0];
    strips.push([c.x0 + (c.x1 - c.x0) * 0.4, c.x0 + (c.x1 - c.x0) * 0.66]);
  }
  const parts = await Promise.all(
    strips.map(async ([sx0, sx1]) => {
      const sw = Math.round((sx1 - sx0) * W);
      const sh = Math.round((y1 - y0) * H);
      if (sw < 10 || sh < 10) return [];
      const strip = createCanvas(sw, sh);
      strip.getContext('2d').drawImage(hi, Math.round(sx0 * W), Math.round(y0 * H), sw, sh, 0, 0, sw, sh);
      return toTokens(await recognizeWords(strip, { lang: ocrLang, psm: '4' }), sx0, y0);
    }),
  );
  return parts.flat();
}

const samePlace = (a, b) => a.num === b.num && Math.abs(a.y0 - b.y0) < 0.01 && Math.abs(a.x0 - b.x0) < 0.02;

/** 여러 번 읽은 OCR 결과에서 번호 후보를 모음 (같은 자리 중복 제거, 글자 레이어 후보가 있으면 그쪽 우선) */
function extractOcr(page) {
  const cands = [];
  const ranges = [];
  page.bodyH = 0;
  // 영어로만 읽은 쪽 전체에서는 한글을 숫자로 읽기도 함("일" → "2").
  // 번호 띠를 한국어로 읽었을 때 그 자리가 또렷한 한글이었으면 번호가 아님 ("3다음"처럼 번호에 붙어 읽힌 건 빼고)
  const hangul = page.ocrPasses.flat().filter((t) => t.conf >= 60 && /[가-힣]/.test(t.str));
  const onHangul = (c) => {
    const cx = (c.x0 + c.x1) / 2;
    const cy = (c.y0 + c.y1) / 2;
    return !c.prefix && hangul.some((t) => cx > t.x0 && cx < t.x1 && cy > t.y0 && cy < t.y1 && !t.str.startsWith(c.digits));
  };
  const boxes = [];
  const labels = [];
  const near = (p, q) => Math.abs(p.y0 - q.y0) < 0.01 && Math.abs(p.x0 - q.x0) < 0.03;
  for (const toks of page.ocrPasses) {
    const ex = extractCandidates(toks, page.layout, { ocr: true });
    page.bodyH ||= ex.bodyH;
    for (const c of ex.candidates) if (!onHangul(c) && !cands.some((d) => samePlace(c, d))) cands.push(c);
    for (const r of ex.ranges) if (!ranges.some((q) => q.a === r.a && q.b === r.b && Math.abs(q.y0 - r.y0) < 0.01)) ranges.push(r);
    for (const b of ex.answerBoxes) if (!boxes.some((q) => near(q, b))) boxes.push(b);
    for (const l of ex.sectionLabels) if (!labels.some((q) => near(q, l))) labels.push(l);
  }
  const text = page.textCands || [];
  page.source = text.length ? 'text' : 'ocr';
  page.candidates = [...text, ...cands.filter((o) => !text.some((t) => samePlace(t, o)))].sort(byReadingOrder);
  if (!text.length) {
    page.ranges = ranges;
    page.answerBoxes = boxes;
    page.sectionLabels = labels;
  }
}

/** OCR 결과를 쪽에 반영 (단 구분을 번호 위치로 보정) */
function applyOcr(page, splitHint = null) {
  extractOcr(page);
  if (inferColumnsFromCandidates(page, splitHint) || mergeFigureColumns(page)) extractOcr(page);
  const L = page.layout;
  if (page.source === 'ocr' && !page.footerNumbers.length) {
    for (const t of page.ocrPasses[0] || []) {
      const cy = (t.y0 + t.y1) / 2;
      const inMargin = (L.hasHeader && cy < L.bodyTop) || (L.hasFooter && cy > L.bodyBottom);
      if (inMargin && /^\d{1,4}$/.test(t.str) && t.conf >= 60) page.footerNumbers.push(parseInt(t.str, 10));
    }
  }
}

/** 읽은 OCR 결과를 쪽에 반영하고 정답표 같은지 봄 */
function finishOcr(page, splitHint, role) {
  page.needsOcr = false;
  applyOcr(page, splitHint);
  if (looksLikeAnswerTable(page.candidates, { strict: role !== 'answer' })) page.isTable = true;
  // 스캔한 문제집: 유형·단원 제목 앞의 색칠된 이름표 (해설에는 "다른 풀이" 같은 이름표가 문항 안에 있어서 문제집만)
  if (role === 'problem' && page.source === 'ocr') page.labels = findLabelBlocks(page.grid, page.layout, page.bodyH);
}

/** 한 쪽 OCR (passes 마다 한 번씩 읽어 후보를 합침) */
async function ocrPage(src, page, { ocrLang = 'kor+eng', passes = OCR_PASSES, splitHint = null, role = 'problem' } = {}) {
  page.textCands ??= page.candidates; // 꼼꼼히 모드: 글자 레이어 후보도 함께 씀
  page.ocrPasses.push(...(await Promise.all(passes.map((p) => ocrTokens(src, page, p, ocrLang)))));
  finishOcr(page, splitHint, role);
}

/**
 * 여러 쪽을 OCR 워커 수만큼 동시에.
 * 방식(pass)마다 모든 쪽을 다 읽고 다음 방식으로 넘어감 (방식마다 언어가 달라서, 섞어 읽으면 워커를 자꾸 바꿔 띄움)
 */
async function ocrPages(src, list, { passes, ocrLang, role, splitHint, signal, onProgress, label, count = { done: 0, total: list.length * passes.length }, finish = true }) {
  for (const r of list) r.textCands ??= r.candidates;
  for (const pass of passes) {
    let next = 0;
    const run = async () => {
      while (next < list.length) {
        abortIfNeeded(signal);
        const r = list[next++];
        r.ocrPasses.push(await ocrTokens(src, r, pass, ocrLang));
        count.done++;
        onProgress?.({ phase: 'scan', done: count.done, total: count.total, message: `${r.index + 1}쪽 ${label}` });
      }
    };
    await Promise.all(Array.from({ length: Math.min(OCR_WORKERS, list.length) }, run));
  }
  if (finish) for (const r of list) finishOcr(r, splitHint, role);
}

/**
 * 1단계에서 쪽을 읽는 동안, 글자가 없는 쪽(스캔본)부터 첫째 OCR 방식(쪽 전체)을 미리 시작 — 쪽 그리기와 OCR 이 겹치게.
 * push(쪽) 로 넣고, close() 는 넣은 쪽을 다 읽을 때까지 기다림 (그 뒤로는 진행 상황도 알림)
 */
function earlyPageOcr(src, { ocrLang, signal, onProgress, count }) {
  const queue = [];
  const waiting = [];
  let next = 0;
  let closed = false;
  let error = null;
  const wakeAll = () => waiting.splice(0).forEach((wake) => wake());
  const run = async () => {
    while (!signal?.aborted && !error) {
      if (next < queue.length) {
        const r = queue[next++];
        r.ocrPasses.push(await ocrTokens(src, r, OCR_PASSES[0], ocrLang));
        count.done++;
        if (closed) onProgress?.({ phase: 'scan', done: count.done, total: count.total, message: `${r.index + 1}쪽 OCR 중` });
      } else if (closed) return;
      else await new Promise((wake) => waiting.push(wake));
    }
  };
  const runs = Array.from({ length: OCR_WORKERS }, () => run().catch((err) => (error ||= err)));
  return {
    push(r) {
      r.textCands ??= r.candidates;
      queue.push(r);
      wakeAll();
    },
    async close() {
      closed = true;
      wakeAll();
      await Promise.all(runs);
      abortIfNeeded(signal);
      if (error) throw error;
    },
  };
}

/**
 * 한 페이지 분석(번호 후보까지)
 * @param {object} opts
 *   deep: 꼼꼼히 — 글자가 있어도 OCR 을 함께, 두 가지 해상도로 읽음
 * @returns {Promise<{index:number, layout:object, grid:object, candidates:object[], source:string, footerNumbers:number[]}>}
 */
export async function analyzePage(src, index, { ocrLang = 'kor+eng', forceOcr = false, ocrFallback = true, deep = false, role = 'problem', splitHint = null } = {}) {
  const page = await readPage(src, index, { forceOcr, ocrFallback, deep, splitHint });
  if (page.needsOcr) await ocrPage(src, page, { ocrLang, passes: deep ? [...OCR_PASSES, ...OCR_RETRY] : OCR_PASSES, splitHint, role });
  return page;
}

/** 번호가 건너뛴(2~40) 곳에 걸친 쪽들 — 번호 체계(말머리·자릿수)마다 따로 봄 */
function pagesWithGaps(results, anchors) {
  const hit = new Set();
  const last = new Map();
  results.forEach((r, k) => {
    for (const c of anchors.get(r.index) || []) {
      const key = schemeKey(c);
      const prev = last.get(key);
      if (prev && c.num !== 1 && c.num - prev.num >= 2 && c.num - prev.num <= 40) for (let j = prev.k; j <= k; j++) hit.add(results[j]);
      if (!prev && c.num >= 2 && c.num <= 6) hit.add(r); // 첫 번호(1번)부터 놓친 경우
      last.set(key, { num: c.num, k });
    }
  });
  return results.filter((r) => hit.has(r));
}

/**
 * 빠진 번호(예: 52 → 54)가 들어갈 수 있는 영역들.
 * 같은 단이면 두 번호 사이, 다른 단이면 앞 번호 아래 + 뒤 번호 위, 그리고 앞 번호와 같은 줄 오른쪽(나란히 놓인 문항).
 * @param chain  이 쪽의 대표 번호 체계 번호들(읽는 순서)
 */
function gapRegions(page, chain, prevLast, nextFirst, maxGap = 6) {
  const L = page.layout;
  const regions = [];
  const range = (lo, hi) => new Set(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
  const flow = (a, b, missing) => {
    const lastCol = b ? b.col : L.columns.length - 1;
    if (a) {
      regions.push({ col: a.col, y0: a.y0 - 0.003, y1: a.y1 + 0.003, xFrom: a.x1 + 0.006, missing });
      regions.push({ col: a.col, y0: a.y1, y1: a.col === b?.col ? b.y0 : L.bodyBottom, missing });
    }
    for (let c = a ? a.col + 1 : 0; c < lastCol; c++) regions.push({ col: c, y0: L.bodyTop, y1: L.bodyBottom, missing });
    if (b && (!a || a.col !== b.col)) regions.push({ col: b.col, y0: L.bodyTop, y1: b.y0, missing });
    if (!b && (!a || a.col !== lastCol)) regions.push({ col: lastCol, y0: L.bodyTop, y1: L.bodyBottom, missing });
  };
  if (!chain.length) {
    if (prevLast != null && nextFirst != null && nextFirst - prevLast >= 2 && nextFirst - prevLast <= 2 * maxGap) flow(null, null, range(prevLast + 1, nextFirst - 1));
    return regions;
  }
  const d0 = prevLast != null ? chain[0].num - prevLast : 0;
  if (d0 >= 2 && d0 <= maxGap) flow(null, chain[0], range(prevLast + 1, chain[0].num - 1));
  for (let i = 0; i + 1 < chain.length; i++) {
    const d = chain[i + 1].num - chain[i].num;
    if (d >= 2 && d <= maxGap) flow(chain[i], chain[i + 1], range(chain[i].num + 1, chain[i + 1].num - 1));
  }
  const last = chain[chain.length - 1];
  const d1 = nextFirst != null ? nextFirst - last.num : 0;
  if (d1 >= 2 && d1 <= maxGap) flow(last, null, range(last.num + 1, nextFirst - 1));
  return regions;
}

/**
 * OCR 로도 빠진 번호는, 그 사이 영역에서 "번호처럼 생긴 잉크 덩어리"를 하나씩 잘라 숫자 전용으로 다시 읽어 채웁니다.
 * (색 상자 속 흰 숫자 "대표 문제", 한 줄에 나란한 번호 포함)
 */
async function fillOcrGaps(src, results, anchors, signature, { signal, onProgress }) {
  if (!signature) return 0;
  const sigKey = `${signature.prefix || ''}|${signature.padded ? signature.digitsLen : 0}`;
  const main = (r) => (anchors.get(r.index) || []).filter((c) => schemeKey(c) === sigKey);
  const ref = results.flatMap(main).slice(0, 400);
  let added = 0;
  for (let k = 0; k < results.length; k++) {
    const r = results[k];
    if (r.source !== 'ocr' || !r.ocrPasses.length) continue;
    abortIfNeeded(signal);
    let prevLast = null;
    for (let j = k - 1; j >= 0 && prevLast == null; j--) {
      const ch = main(results[j]);
      if (ch.length) prevLast = ch[ch.length - 1].num;
    }
    let nextFirst = null;
    for (let j = k + 1; j < results.length && nextFirst == null; j++) {
      const ch = main(results[j]);
      if (ch.length) nextFirst = ch[0].num;
    }
    // 앞에 번호가 하나도 없는데 첫 번호가 2~6 이면 1번부터 놓친 것으로 봄
    if (prevLast == null && main(r).length && main(r)[0].num <= 6) prevLast = 0;
    const regions = gapRegions(r, main(r), prevLast, nextFirst);
    if (!regions.length) continue;
    onProgress?.({ phase: 'scan', done: k, total: results.length, message: `${r.index + 1}쪽 빠진 번호 찾는 중` });
    const found = await findNumbersInRegions(src, r, regions, ref, signature);
    if (found.length) {
      r.candidates.push(...found);
      r.candidates.sort(byReadingOrder);
      anchors.set(r.index, [...(anchors.get(r.index) || []), ...found].sort(byReadingOrder));
      added += found.length;
    }
  }
  return added;
}

/**
 * 잘라낸 번호 조각을 흑백으로 (글자는 검게).
 * @param {boolean} inverted  진한 색 상자 속 흰 글자(대표 문제 등)로 보고 뒤집을지
 * @returns {boolean} 색 상자처럼 보이는지 (잉크가 많은 가로줄들이 감싸는 사각형 안이 대부분 잉크)
 */
function binarizeDigits(canvas, inverted = false) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const ink = new Uint8Array(w * h);
  const rowInk = new Uint32Array(h);
  for (let y = 0, k = 0; y < h; y++) {
    for (let x = 0; x < w; x++, k++) {
      const i = k * 4;
      const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      const sat = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
      // 검은 글자 또는 진한 색(주황·초록 번호, 색 상자)
      if (lum < 150 || (sat > 60 && lum < 215)) {
        ink[k] = 1;
        rowInk[y]++;
      }
    }
  }
  let ry0 = -1;
  let ry1 = -1;
  for (let y = 0; y < h; y++) {
    if (rowInk[y] > 0.4 * w) {
      if (ry0 < 0) ry0 = y;
      ry1 = y;
    }
  }
  let boxLike = false;
  if (ry0 >= 0 && ry1 - ry0 + 1 >= 0.3 * h) {
    let rx0 = w;
    let rx1 = -1;
    let inRect = 0;
    for (let y = ry0; y <= ry1; y++) {
      for (let x = 0; x < w; x++) {
        if (ink[y * w + x]) {
          if (x < rx0) rx0 = x;
          if (x > rx1) rx1 = x;
        }
      }
    }
    for (let y = ry0; y <= ry1; y++) for (let x = rx0; x <= rx1; x++) inRect += ink[y * w + x];
    boxLike = rx1 > rx0 && inRect > 0.6 * (ry1 - ry0 + 1) * (rx1 - rx0 + 1);
  }
  // 상자 속 흰 글자 = 상자에 둘러싸인(조각 테두리에서 잉크를 건너지 않고는 닿을 수 없는) 흰 픽셀
  const outside = new Uint8Array(w * h);
  if (inverted) {
    const stack = [];
    const push = (k) => {
      if (!ink[k] && !outside[k]) {
        outside[k] = 1;
        stack.push(k);
      }
    };
    for (let x = 0; x < w; x++) push(x), push((h - 1) * w + x);
    for (let y = 0; y < h; y++) push(y * w), push(y * w + w - 1);
    while (stack.length) {
      const k = stack.pop();
      const x = k % w;
      if (x > 0) push(k - 1);
      if (x < w - 1) push(k + 1);
      if (k >= w) push(k - w);
      if (k < (h - 1) * w) push(k + w);
    }
  }
  for (let y = 0, k = 0; y < h; y++) {
    for (let x = 0; x < w; x++, k++) {
      const black = inverted ? !ink[k] && !outside[k] : ink[k] === 1;
      const v = black ? 0 : 255;
      d[k * 4] = d[k * 4 + 1] = d[k * 4 + 2] = v;
      d[k * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return boxLike;
}

/** 페이지 이미지의 한 조각을 키워 흑백으로 만든 뒤 숫자만 읽음 */
async function readDigitsAt(hi, box, scale, inverted) {
  const W = hi.width;
  const H = hi.height;
  const cw = (box.x1 - box.x0) * W;
  const ch = (box.y1 - box.y0) * H;
  const piece = createCanvas(cw * scale, ch * scale);
  const pctx = piece.getContext('2d', { willReadFrequently: true });
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(hi, box.x0 * W, box.y0 * H, cw, ch, 0, 0, piece.width, piece.height);
  const boxLike = binarizeDigits(piece, inverted);
  const crop = createCanvas(piece.width + 40, piece.height + 40);
  const ctx = crop.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, crop.width, crop.height);
  ctx.drawImage(piece, 20, 20);
  const { text, conf } = await recognizeLine(crop, { lang: DIGIT_LANG, whitelist: '0123456789.)' });
  // 앞에 붙은 점·잡티는 버리고 첫 숫자 덩어리만 (예: ".0006" → 0006)
  const m = /(\d{1,4})/.exec(text.replace(/\s+/g, ' '));
  return { digits: m ? m[1] : '', conf, boxLike };
}

const hamming = (a, b) => (a.length === b.length ? [...a].filter((ch, i) => ch !== b[i]).length : Infinity);

async function findNumbersInRegions(src, page, regions, ref, sig) {
  const { grid, layout } = page;
  const hNum = median(ref.map((c) => c.h)) || 0.012;
  // 숫자 한 글자 폭(이미 찾은 번호들에서)
  const perDigit = median(ref.map((c) => (c.x1 - c.x0) / Math.max(1, c.digits.length))) || hNum * 0.6;
  // 한 줄에 나란한 번호가 있던 가로 위치(단 시작 기준)
  const sideRel = [...new Set(ref.filter((c) => c.relX - sig.relX > 0.03).map((c) => Math.round(c.relX * 100) / 100))];
  const hW = (hNum * grid.h) / grid.w; // 번호 높이를 가로 비율로
  const blobs = [];
  for (const reg of regions) {
    const col = layout.columns[reg.col];
    if (!col || reg.y1 - reg.y0 < hNum * 0.6) continue;
    const xFrom = reg.xFrom ?? Math.max(0, col.x0 - 0.012);
    for (const band of inkBands(grid, xFrom, col.x1, reg.y0, reg.y1)) {
      let prevEnd = null;
      for (const seg of inkSegments(grid, xFrom, col.x1, band.y0, band.y1)) {
        const leftGap = prevEnd == null ? Infinity : seg.x0 - prevEnd;
        prevEnd = seg.x1;
        // 줄(또는 영역) 맨 앞이거나, 앞 글자와 충분히 떨어진 덩어리만
        if (leftGap < 0.9 * hW) continue;
        for (const sub of inkBands(grid, seg.x0, seg.x1, band.y0, band.y1)) {
          const bh = sub.y1 - sub.y0;
          if (bh < hNum * 0.6 || bh > hNum * 2.2) continue;
          const rel = seg.x0 - col.x0;
          const pri = Math.abs(rel - sig.relX) <= 0.015 ? 0 : sideRel.some((s) => Math.abs(rel - s) <= 0.015) ? 1 : reg.xFrom != null ? 1 : 2;
          blobs.push({ reg, col: reg.col, x0: seg.x0, x1: seg.x1, y0: sub.y0, y1: sub.y1, pri });
        }
      }
    }
  }
  blobs.sort((a, b) => a.pri - b.pri);
  let hi = null;
  const found = [];
  let budget = 40; // 쪽마다 잘라 읽는 횟수 상한
  for (const b of blobs) {
    const reg = b.reg;
    if (!reg.missing.size) continue;
    if (budget-- <= 0) break;
    if (found.some((f) => Math.abs(f.y0 - b.y0) < hNum && Math.abs(f.x0 - b.x0) < 0.02)) continue;
    const digits = Math.max(...[...reg.missing].map((n) => (sig.padded && sig.digitsLen ? sig.digitsLen : String(n).length)));
    const numW = perDigit * digits;
    if (b.pri === 2 && (b.x1 - b.x0 < 0.6 * numW || b.x1 - b.x0 > 1.8 * numW)) continue; // 엉뚱한 자리는 번호 폭인 것만
    if (!hi) hi = await src.renderPage(page.index, CROP_WIDTH);
    const box = { x0: Math.max(0, b.x0 - 0.006), x1: Math.min(1, Math.min(b.x1, b.x0 + numW * 1.2) + 0.006), y0: Math.max(0, b.y0 - 0.004), y1: Math.min(1, b.y1 + 0.004) };
    const bh = b.y1 - b.y0;
    // 숫자 높이가 40px 안팎이 되게 키움(작은 글씨 대응)
    const S = Math.min(2.5, Math.max(1, 40 / Math.max(1, Math.min(bh, hNum * 1.2) * hi.height)));
    const want = reg.missing.size === 1 ? [...reg.missing][0] : null;
    const wantStr = want == null ? '' : sig.padded && sig.digitsLen ? String(want).padStart(sig.digitsLen, '0') : String(want);
    const heightOk = bh > hNum * 0.75 && bh < hNum * 1.5;
    let m = null;
    let conf = 0;
    let near = null; // 한 자리만 다르게 읽힌 것
    // 그대로 → (색 상자 같으면) 뒤집어서 → 크게 키워서, 빠진 번호가 읽힐 때까지
    const tries = [{ scale: S, inverted: false }];
    for (let t = 0; t < tries.length && !m; t++) {
      const r = await readDigitsAt(hi, box, tries[t].scale, tries[t].inverted);
      if (t === 0) {
        if (r.boxLike) tries.push({ scale: S, inverted: true });
        tries.push({ scale: Math.min(4, S * 1.6), inverted: false });
        if (r.boxLike) tries.push({ scale: Math.min(4, S * 1.6), inverted: true });
      }
      // 번호와 거리가 먼 덩어리(색 상자도 아니고 숫자도 거의 안 읽힘)는 더 읽지 않음
      if (t === 0 && !r.boxLike && r.digits.length < 2) break;
      if (!r.digits) continue;
      if (reg.missing.has(parseInt(r.digits, 10))) {
        m = [r.digits, r.digits];
        conf = r.conf;
      } else if (want != null && b.pri === 0 && heightOk && r.digits.length >= 2 && (wantStr.startsWith(r.digits) || hamming(r.digits, wantStr) === 1)) near = r;
    }
    // 빠진 번호가 하나뿐이고, 번호 자리·크기가 맞는 덩어리에서 그 번호의 앞부분이나 한 자리만 다르게 읽혔다면 그 번호로 봄
    if (!m && near) {
      m = [wantStr, wantStr];
      conf = near.conf;
    }
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (!reg.missing.has(num)) continue;
    if (sig.padded && sig.digitsLen && m[1].length !== sig.digitsLen) continue; // 0001 같은 번호면 자릿수도 맞아야 함
    reg.missing.delete(num);
    const col = layout.columns[b.col];
    found.push({
      num,
      digits: m[1],
      style: sig.style,
      prefix: '',
      x0: b.x0,
      x1: b.x0 + numW,
      y0: b.y0,
      y1: b.y1,
      h: bh,
      col: b.col,
      relX: b.x0 - col.x0,
      hRatio: page.bodyH ? bh / page.bodyH : sig.hRatio,
      conf: Math.max(60, conf),
      padded: m[1].length >= 2 && m[1][0] === '0',
      fixedWidth: !!sig.padded && m[1][0] !== '0',
      ocr: true,
    });
  }
  return found;
}

/** 띠(y0~y1) 안에서 x0 부터 오른쪽으로 잉크 덩어리들의 가로 범위 (빈 칸 2개 이상이면 끊음) */
function inkSegments(grid, x0, x1, y0, y1) {
  const { w, h, data } = grid;
  const gx0 = Math.max(0, Math.floor(x0 * w));
  const gx1 = Math.min(w, Math.ceil(x1 * w));
  const gy0 = Math.max(0, Math.floor(y0 * h));
  const gy1 = Math.min(h, Math.ceil(y1 * h));
  const colHasInk = (x) => {
    for (let y = gy0; y < gy1; y++) if (data[y * w + x]) return true;
    return false;
  };
  const segs = [];
  let start = -1;
  let end = -1;
  let empty = 0;
  for (let x = gx0; x <= gx1; x++) {
    if (x < gx1 && colHasInk(x)) {
      if (start < 0) start = x;
      end = x + 1;
      empty = 0;
    } else if (start >= 0 && (++empty >= 2 || x === gx1)) {
      segs.push({ x0: start / w, x1: end / w });
      start = -1;
    }
  }
  return segs;
}

/** 격자에서 x 범위 [x0,x1] 안의 잉크 줄 묶음 */
function inkBands(grid, x0, x1, y0, y1) {
  const { w, h, data } = grid;
  const gx0 = Math.max(0, Math.floor(x0 * w));
  const gx1 = Math.min(w, Math.ceil(x1 * w));
  const gy0 = Math.max(0, Math.floor(y0 * h));
  const gy1 = Math.min(h, Math.ceil(y1 * h));
  const bands = [];
  let start = -1;
  for (let y = gy0; y <= gy1; y++) {
    let ink = false;
    if (y < gy1) for (let x = gx0; x < gx1 && !ink; x++) ink = data[y * w + x] === 1;
    if (ink && start < 0) start = y;
    if (!ink && start >= 0) {
      bands.push({ y0: start / h, y1: y / h });
      start = -1;
    }
  }
  return bands;
}

/** 단 위치를 동시에 읽느라 앞 쪽에서 찾은 단 위치(splitHint)를 못 받은 OCR 쪽에 다시 적용 */
function shareSplitHints(results) {
  let hint = null;
  for (const r of results) {
    if (r.layout.inferred) hint = r.layout.inferred;
    else if (hint != null && r.ocrPasses.length && inferColumnsFromCandidates(r, hint)) extractOcr(r);
  }
}

/**
 * 문서 전체 분석
 * @param {import('./docsource.js').DocSource} src
 * @param {object} opts
 *   pages: number[]               분석할 쪽(0부터)
 *   role: 'problem'|'answer'
 *   flow: 'column'|'continue'
 *   numberStyle: 'auto'|...
 *   ocrLang
 *   onProgress({phase, done, total, message})
 *   signal
 */
export async function analyzeDocument(src, opts) {
  const { role = 'problem', flow = 'column', numberStyle = 'auto', ocrLang, onProgress, signal } = opts;
  let { pages } = opts;
  let results = [];
  let splitHint = null; // 번호 위치로 추정한 단 위치(같은 책 다음 쪽에도 적용)

  // 1) 쪽마다 레이아웃·글자 레이어 (빠름). 스캔한 쪽은 읽는 대로 쪽 전체 OCR 을 시작
  const count = { done: 0, total: 0 }; // OCR 진행 (쪽 × 방식)
  const early = earlyPageOcr(src, { ocrLang, signal, onProgress, count });
  for (let k = 0; k < pages.length; k++) {
    abortIfNeeded(signal);
    const idx = pages[k];
    onProgress?.({ phase: 'scan', done: k, total: pages.length, message: `${idx + 1}쪽 분석 중` });
    const page = await readPage(src, idx, { ocrFallback: false, splitHint });
    if (page.layout.inferred) splitHint = page.layout.inferred;
    results.push(page);
    if (page.needsOcr) early.push(page);
  }

  // 문제집 뒤에 붙은 정답과 풀이는 문제가 아님 (글자 레이어로 알 수 있으면 OCR 전에 뺌)
  let answersFrom = -1;
  const cutAnswers = () => {
    const k = role === 'problem' ? answerSectionStart(results) : -1;
    if (k < 0) return;
    answersFrom = results[k].index;
    results = results.slice(0, k + 1);
    pages = pages.slice(0, pages.indexOf(answersFrom) + 1);
  };
  cutAnswers();

  // 텍스트 레이어는 있지만 번호를 거의 못 찾은 문서 → 번호가 그림으로 되어 있는 것으로 보고 OCR
  const textPages = results.filter((r) => r.source === 'text' && !r.layout.blank && !r.needsOcr);
  const withNums = textPages.filter((r) => r.candidates.length > 0).length;
  if (textPages.length && withNums / textPages.length < 0.3) for (const r of results) if (r.textWithoutNumbers) r.needsOcr = true;

  // 2) OCR (워커 여러 개가 여러 쪽을 동시에): 쪽 전체를 마저 다 읽고 → 번호 띠
  const ocrList = results.filter((r) => r.needsOcr);
  count.total = ocrList.length * OCR_PASSES.length;
  await early.close();
  const ocrOpts = { ocrLang, role, splitHint, signal, onProgress, label: 'OCR 중', count };
  await ocrPages(src, ocrList.filter((r) => !r.ocrPasses.length), { ...ocrOpts, passes: OCR_PASSES.slice(0, 1), finish: false });
  await ocrPages(src, ocrList, { ...ocrOpts, passes: OCR_PASSES.slice(1) });
  shareSplitHints(results);
  if (answersFrom < 0) cutAnswers(); // 스캔본은 OCR 로 정답표를 알아본 뒤에
  onProgress?.({ phase: 'scan', done: pages.length, total: pages.length, message: '번호 정리 중' });

  // 빠른 정답표 쪽은 번호 인식에서 뺌 (문제집 끝에 붙은 "한눈에 보는 정답"도: 문제집은 칸이 촘촘한 표만)
  const tablePages = new Set();
  const markTables = () => {
    for (const r of results) {
      if (r.isTable || looksLikeAnswerTable(r.candidates, { strict: role !== 'answer' })) {
        tablePages.add(r.index);
        r.candidates = [];
        r.ranges = [];
      }
    }
  };
  markTables();
  let { anchors, signature, signatures } = selectAnchors(results, { numberStyle });

  // 3) 번호가 건너뛴 OCR 쪽은 해상도를 바꿔 한 번 더 읽어 후보를 보탬
  const reread = pagesWithGaps(results, anchors).filter((r) => r.ocrPasses.length && !tablePages.has(r.index));
  if (reread.length) {
    await ocrPages(src, reread, { passes: OCR_RETRY, ocrLang, role, signal, onProgress, label: '빠진 번호 다시 읽는 중' });
    markTables();
    ({ anchors, signature, signatures } = selectAnchors(results, { numberStyle }));
  }
  // 4) 그래도 빠진 번호는 번호 자리를 하나씩 잘라 숫자만 읽음
  if (ocrList.length) await fillOcrGaps(src, results, anchors, signature, { signal, onProgress });
  // 번호가 건너뛴 곳은 버려진 후보에서 다시 찾아 채움
  fillGapsFromCandidates(results, anchors, signatures);
  // 앞뒤 번호 흐름과 동떨어진 짧은 덩어리(목차·만화 쪽, 부록 표에서 잘못 읽은 숫자)는 뺌
  if (signature) dropStrayRuns(pages, anchors, `${signature.prefix || ''}|${signature.padded ? signature.digitsLen : 0}`);

  const layouts = new Map(results.map((r) => [r.index, r.layout]));
  const grids = new Map(results.map((r) => [r.index, r.grid]));
  const sourceMap = new Map(results.map((r) => [r.index, r.source]));
  const flags = flagPages(pages, anchors, layouts);
  for (const idx of tablePages) flags.set(idx, ['빠른 정답표 같아서 건너뜀']);
  if (answersFrom >= 0) flags.set(answersFrom, ['여기부터는 정답과 풀이 같아서 뺌 (문제 쪽까지만 범위를 정하면 사라짐)']);
  const cutters = buildCutters(results, anchors, signature);
  const ranges = new Map(results.filter((r) => r.ranges?.length).map((r) => [r.index, r.ranges]));
  let items = computeItems(pages, anchors, layouts, grids, { flow, source: sourceMap, cutters, stopPages: tablePages, ranges });
  // 앞 쪽 해설이 통째로 이어지는 쪽(긴 해설의 가운데 쪽)은 번호가 없는 게 맞음
  if (flow === 'continue') {
    const continued = new Set(items.flatMap((it) => it.rects.filter((r) => r.page !== it.page).map((r) => r.page)));
    for (const idx of continued) {
      const f = flags.get(idx);
      if (f?.length === 1 && f[0] === '번호를 찾지 못함') flags.delete(idx);
    }
  }

  items = assignIds(sortItems(items));
  const pageInfo = {};
  for (const r of results) {
    pageInfo[r.index] = {
      analyzed: true,
      source: sourceMap.get(r.index),
      blank: !!r.layout?.blank,
      columns: r.layout?.columns?.length || 1,
      ...pageMeta(r, anchors.get(r.index) || []),
      flags: flags.get(r.index) || [],
    };
  }
  const pageOffset = guessPageOffset(results.map((r) => ({ index: r.index, numbers: r.footerNumbers })));
  const ocrPageCount = results.filter((r) => r.ocrPasses.length).length;
  return { items, pageInfo, signature, signatures, pageOffset, ocrPages: ocrPageCount, layouts, grids };
}

/**
 * 문제집 PDF 뒤에 정답과 풀이가 붙어 있으면 그 첫머리의 빠른 정답표 쪽 (results 안 위치). 없으면 -1
 * 앞에 문제가 있고, 문서 뒤쪽 절반에서 나온 정답표만 봄 (단원 중간의 정답표로 문제를 잘라 내지 않게)
 */
function answerSectionStart(results) {
  return results.findIndex(
    (r, k) => k >= results.length / 2 && (r.isTable || looksLikeAnswerTable(r.candidates, { strict: true })) && results.slice(0, k).some((q) => q.candidates.length),
  );
}

const round4 = (v) => Math.round(v * 10000) / 10000;

/** 편집기용 쪽 정보: 단 위치, 본문 범위, 고르지 않은 번호 후보(점선 상자로 보여 주고 눌러서 추가) */
export function pageMeta(r, chain) {
  const chosen = new Set(chain);
  const L = r.layout || {};
  return {
    cols: (L.columns || []).map((c) => ({ x0: round4(c.x0), x1: round4(c.x1) })),
    body: [round4(L.bodyTop ?? 0), round4(L.bodyBottom ?? 1)],
    cands: (r.candidates || [])
      .filter((c) => !chosen.has(c))
      .slice(0, 60)
      .map((c) => ({ num: c.num, digits: c.digits, prefix: c.prefix || '', col: c.col, x0: round4(c.x0), y0: round4(c.y0), x1: round4(c.x1), y1: round4(c.y1) })),
  };
}

/**
 * 여러 단 쪽에서, 옆 단들이 비어 있는 제목 줄은 "전체 폭 제목"(단원 제목)으로 보고 구역을 나눕니다.
 * (예: 2단 해설 중간에 "02 지수함수와 로그함수" 제목이 끼어 있는 쪽)
 */
function promoteFullWidthHeadings(page) {
  const L = page.layout;
  const cols = L.columns || [];
  if (cols.length < 2 || !page.headings?.length) return;
  for (const hd of page.headings) {
    const others = cols.filter((c) => !(hd.x1 > c.x0 + 0.005 && hd.x0 < c.x1 - 0.005));
    if (!others.length) continue;
    const y0 = hd.y0 - 0.004;
    const hgt = hd.y1 - hd.y0 + 0.008;
    const empty = others.every((c) => inkCount(page.grid, { x: c.x0, y: y0, w: c.x1 - c.x0, h: hgt }) === 0);
    if (empty) L.spans = [...(L.spans || []), { y0, y1: y0 + hgt }];
  }
  L.spans.sort((a, b) => a.y0 - b.y0);
}

/**
 * 문항 영역을 끊는 위치들: 큰 글씨 제목, 여러 단 쪽의 가로 띠(단원 제목 막대), 제목처럼 큰 번호, 스캔본 제목 이름표
 * @returns {Map<number, {x0:number,x1:number,y0:number}[]>}
 */
export function buildCutters(results, anchors, signature) {
  const map = new Map();
  const add = (idx, c) => {
    if (!map.has(idx)) map.set(idx, []);
    map.get(idx).push(c);
  };
  for (const [idx, list] of findCutters(results, anchors, signature)) {
    for (const c of list) add(idx, { x0: c.x0, x1: c.x1, y0: c.y0 - (0.45 * c.h + 0.004) });
  }
  for (const r of results) {
    // 제목 위 장식(동그라미 번호, 띠)에 걸리지 않게 그 위 빈 줄로
    const snap = (x0, x1, y) => (r.grid ? snapUpToGap(r.grid, x0, x1, y) : y);
    for (const hd of r.headings || []) add(r.index, { x0: hd.x0, x1: hd.x1, y0: snap(hd.x0 - 0.01, hd.x1 + 0.01, hd.y0 - 0.004) });
    for (const rg of r.ranges || []) add(r.index, { x0: rg.x0, x1: rg.x1, y0: rg.y0 - 0.006 });
    // 번호 없는 말머리 이름표("유제" 띠): 다음 묶음의 시작
    for (const lb of r.sectionLabels || []) add(r.index, { x0: lb.x0, x1: lb.x1, y0: snap(lb.x0 - 0.01, lb.x1 + 0.01, lb.y0 - 0.004) });
    // 해설 중간의 작은 정답 상자("Level 1 기초 연습 / 1 ③ 2 ③ …"): 앞 해설에 딸려 오지 않게 상자 머리 위에서 끊음
    // (단 왼쪽 끝에서 시작하는 줄만 — 그래프 눈금 "1 2 3" 같은 건 아님)
    for (const bx of r.answerBoxes || []) {
      if (bx.relX > 0.08) continue;
      const col = r.layout?.columns?.[bx.col] || { x0: bx.x0, x1: bx.x1 };
      const y = r.grid ? cutAbove(r.grid, { y0: bx.y0, h: bx.h }, col.x0 - 0.006, col.x1 + 0.006, r.layout?.bodyTop ?? 0, { maxW: 1, maxH: 3, maxGap: 2 }) : bx.y0 - 0.006;
      add(r.index, { x0: bx.x0, x1: bx.x1, y0: y });
    }
    // 이름표 중 문항 번호가 들어 있지 않은 것 ("0094 대표 문제" 는 문항 머리, "유형 15" 는 제목)
    const chain = anchors.get(r.index) || [];
    for (const lb of r.labels || []) {
      const own = chain.some((a) => (a.x0 + a.x1) / 2 > lb.x0 - 0.01 && (a.x0 + a.x1) / 2 < lb.x1 + 0.01 && (a.y0 + a.y1) / 2 > lb.y0 - 0.01 && (a.y0 + a.y1) / 2 < lb.y1 + 0.01);
      if (!own) add(r.index, { x0: lb.x0, x1: lb.x1, y0: lb.cutY - 0.002 });
    }
    if ((r.layout?.columns?.length || 1) >= 2) {
      for (const b of r.layout.spans || []) add(r.index, { x0: 0, x1: 1, y0: b.y0 - 0.002, kind: 'span' });
    }
  }
  return map;
}

/** Gemini 로 한 페이지 인식 → 문항 배열 */
export async function detectPageWithGemini(src, idx, { role, gemini, grid, layout, signal, onStatus }) {
  const canvas = await src.renderPage(idx, GEMINI_WIDTH);
  if (!grid || !layout) {
    const small = await src.renderPage(idx, ANALYSIS_WIDTH);
    grid = inkGridFromCanvas(small);
    layout = analyzeLayout(grid);
  }
  const found = await geminiDetect(canvasToBase64Jpeg(canvas), { role, provider: gemini.provider, models: gemini.models, model: gemini.model, rpm: gemini.rpm, signal, onStatus });
  const items = found.map((f) => {
    const pad = 0.006;
    const expanded = {
      x: Math.max(0, f.rect.x - pad),
      y: Math.max(0, f.rect.y - pad),
      w: Math.min(1, f.rect.x + f.rect.w + pad) - Math.max(0, f.rect.x - pad),
      h: Math.min(1, f.rect.y + f.rect.h + pad) - Math.max(0, f.rect.y - pad),
    };
    const r = trimRect(grid, expanded) || expanded;
    return {
      page: idx,
      zone: zoneOf(layout, r.y),
      col: columnOf(layout, r),
      number: f.number,
      num: f.num,
      rects: [{ page: idx, ...r }],
      source: 'gemini',
      conf: 100,
    };
  });
  items.model = found.model;
  return items;
}

/**
 * 한 페이지에서 시작하는 문항들을 새 문항으로 바꿉니다.
 * 기존 마지막 문항이 다음 쪽으로 이어지던 영역은 새 마지막 문항에 넘겨줍니다.
 */
export function replacePageItems(items, pageIdx, newItems) {
  const old = items.filter((it) => it.page === pageIdx);
  const keep = items.filter((it) => it.page !== pageIdx);
  const sortedNew = sortItems(newItems);
  const oldSorted = sortItems(old);
  const lastOld = oldSorted[oldSorted.length - 1];
  const carried = lastOld ? lastOld.rects.filter((r) => r.page !== pageIdx) : [];
  if (carried.length && sortedNew.length) {
    const last = sortedNew[sortedNew.length - 1];
    last.rects = [...last.rects, ...carried];
  }
  return [...keep, ...sortedNew];
}

/**
 * 편집기에서 "이 쪽 꼼꼼히 다시 찾기"
 *  - 글자가 있어도 OCR 을 함께, 더 높은 해상도·넓은 띠·두 가지 방식으로 읽고
 *  - 앞 쪽 마지막 번호 ~ 뒤 쪽 첫 번호 사이에 들어갈 번호를 모양과 상관없이 가장 길게 이어지게 고름
 */
export async function reanalyzeSinglePage(src, doc, idx, { ocrLang, deep = true, role = 'problem' } = {}) {
  const page = await analyzePage(src, idx, { ocrLang, deep, role });
  const sorted = sortItems((doc.items || []).filter((it) => !it.prefix));
  const prev = sorted.filter((it) => it.page < idx);
  const next = sorted.filter((it) => it.page > idx);
  const prevLast = prev.length ? prev[prev.length - 1].num : null;
  const nextFirst = next.length ? next[0].num : null;
  if (looksLikeAnswerTable(page.candidates, { strict: role !== 'answer' })) page.candidates = [];
  const signatures = doc.signatures || (doc.signature ? [doc.signature] : null);
  const { anchors: sel } = selectAnchors([page], { numberStyle: doc.options?.numberStyle, signatures, prevLast });
  let chain = sel.get(idx) || [];
  if (deep) {
    const plain = chain.filter((c) => !c.prefix);
    const expected = chooseExpectedChain(page.candidates.filter((c) => !c.prefix), prevLast, nextFirst);
    if (expected.length > plain.length) chain = [...expected, ...chain.filter((c) => c.prefix)].sort(byReadingOrder);
    // 그래도 빠진 번호는 번호 자리를 하나씩 잘라 숫자만 읽음
    const sig = signatures?.[0];
    const sigKey = sig ? `${sig.prefix || ''}|${sig.padded ? sig.digitsLen : 0}` : null;
    const mainChain = chain.filter((c) => schemeKey(c) === sigKey);
    const regions = mainChain.length ? gapRegions(page, mainChain, prevLast, nextFirst) : [];
    if (regions.length) {
      const found = await findNumbersInRegions(src, page, regions, mainChain, sig);
      chain = [...chain, ...found].sort(byReadingOrder);
    }
  }
  const anchors = new Map([[idx, chain]]);
  const newItems = computeItems([idx], anchors, new Map([[idx, page.layout]]), new Map([[idx, page.grid]]), {
    flow: doc.options?.flow || 'column',
    source: new Map([[idx, page.source]]),
    cutters: buildCutters([page], anchors, doc.signature),
    ranges: new Map([[idx, page.ranges || []]]),
  });
  return { items: newItems, page, meta: pageMeta(page, chain) };
}
