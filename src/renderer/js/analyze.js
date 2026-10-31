// 문서 분석 파이프라인: 렌더링 → 레이아웃 → (텍스트 | OCR) → 번호 선택 → 영역 계산 → (Gemini 보조)

import { analyzeLayout, inkGridFromCanvas, trimRect, inkCount } from './layout.js';
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
} from './detect.js';
import { recognizeWords, recognizeLine } from './ocr.js';
import { geminiDetect, canvasToBase64Jpeg } from './gemini.js';
import { createCanvas } from './docsource.js';

const ANALYSIS_WIDTH = 960; // 레이아웃 분석용 렌더링 폭(px)
const OCR_WIDTH = 2300; // OCR 용 렌더링 폭(px)
const DEEP_OCR_WIDTH = 3000; // 꼼꼼히 다시 찾기용
const GEMINI_WIDTH = 1500;

const abortIfNeeded = (signal) => {
  if (signal?.aborted) throw new DOMException('분석을 취소했습니다.', 'AbortError');
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
  if (L.columns.length !== 1) return false;
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
 * 한 페이지 분석(번호 후보까지)
 * @param {object} opts
 *   deep: 꼼꼼히 — 글자가 있어도 OCR 을 함께, 더 높은 해상도·더 넓은 띠·두 가지 방식으로 읽음
 * @returns {Promise<{index:number, layout:object, grid:object, candidates:object[], source:string, footerNumbers:number[]}>}
 */
export async function analyzePage(src, index, { ocrLang = 'kor+eng', forceOcr = false, ocrFallback = true, deep = false, role = 'problem', splitHint = null } = {}) {
  const canvas = await src.renderPage(index, ANALYSIS_WIDTH);
  const grid = inkGridFromCanvas(canvas);
  const layout = analyzeLayout(grid);
  const page = { index, layout, grid, candidates: [], source: 'text', footerNumbers: [], headings: [], ranges: [] };
  if (layout.blank) return page;

  const tokens = forceOcr ? [] : await src.getTextTokens(index);
  const textChars = tokens.reduce((n, t) => n + t.str.length, 0);
  const runText = () => {
    const ex = extractCandidates(tokens, layout);
    page.candidates = ex.candidates;
    page.headings = ex.headings;
    page.ranges = ex.ranges;
  };
  if (textChars >= 30) {
    runText();
    if (inferColumnsFromCandidates(page, splitHint)) runText();
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

  // 텍스트 레이어가 없거나 번호가 글자로 들어있지 않으면 OCR (꼼꼼히 모드는 글자가 있어도 함께)
  const textCands = page.candidates;
  page.source = textCands.length ? 'text' : 'ocr';
  const hi = await src.renderPage(index, deep ? DEEP_OCR_WIDTH : OCR_WIDTH);
  const W = hi.width;
  const H = hi.height;
  const y0 = Math.max(0, layout.bodyTop - 0.006);
  const y1 = Math.min(1, layout.bodyBottom + 0.006);
  const strips = layout.columns.map((col) => [Math.max(0, col.x0 - (deep ? 0.03 : 0.012)), Math.min(col.x1, col.x0 + (deep ? 0.26 : 0.17))]);
  // 1단으로 보이면 가운데쯤(둘째 단 시작일 수 있는 곳)도 읽어 봄
  if (layout.columns.length === 1 && layout.columns[0].x1 - layout.columns[0].x0 > 0.55) {
    const c = layout.columns[0];
    strips.push([c.x0 + (c.x1 - c.x0) * 0.4, c.x0 + (c.x1 - c.x0) * 0.66]);
  }
  const ocrWords = async (psm) => {
    const out = [];
    for (const [sx0, sx1] of strips) {
      const sw = Math.round((sx1 - sx0) * W);
      const sh = Math.round((y1 - y0) * H);
      if (sw < 10 || sh < 10) continue;
      const strip = createCanvas(sw, sh);
      strip.getContext('2d').drawImage(hi, Math.round(sx0 * W), Math.round(y0 * H), sw, sh, 0, 0, sw, sh);
      for (const w of await recognizeWords(strip, { lang: ocrLang, psm })) {
        out.push({ str: w.str, conf: w.conf, x0: sx0 + w.x0 / W, x1: sx0 + w.x1 / W, y0: y0 + w.y0 / H, y1: y0 + w.y1 / H });
      }
    }
    return out;
  };
  let tokensOcr = await ocrWords('4');
  if (deep) {
    // 두 번째 방식(흩어진 글자 찾기)으로도 읽어서, 겹치지 않는 단어만 더함
    const extra = await ocrWords('11');
    const overlaps = (a, b) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
    tokensOcr = tokensOcr.concat(extra.filter((e) => !tokensOcr.some((t) => overlaps(t, e))));
  }
  let ex = extractCandidates(tokensOcr, layout, { ocr: true });
  page.candidates = ex.candidates;
  if (inferColumnsFromCandidates(page, splitHint)) {
    ex = extractCandidates(tokensOcr, layout, { ocr: true });
    page.candidates = ex.candidates;
  }
  page.bodyH = ex.bodyH;
  if (textCands.length) {
    // 꼼꼼히 모드: 글자 후보 + OCR 후보 (같은 자리 중복 제거, 글자 후보 우선)
    const near = (a, b) => a.num === b.num && Math.abs(a.y0 - b.y0) < 0.01 && Math.abs(a.x0 - b.x0) < 0.02;
    page.candidates = [...textCands, ...page.candidates.filter((o) => !textCands.some((t) => near(t, o)))].sort((a, b) => a.col - b.col || a.y0 - b.y0);
  }
  if (role === 'answer' && looksLikeAnswerTable(page.candidates)) page.isTable = true;
  return page;
}

/**
 * 스캔본에서 번호 사슬 중간이 빠진 경우(예: 10 → 12), 번호 열의 잉크 덩어리를 숫자 전용 OCR로 다시 읽어 채웁니다.
 */
async function fillOcrGaps(src, results, anchors, signature, { ocrLang, numberStyle, signal, onProgress }) {
  if (!signature) return 0;
  let prevLast = null;
  let added = 0;
  for (let k = 0; k < results.length; k++) {
    const r = results[k];
    const chain = anchors.get(r.index) || [];
    if (r.source === 'ocr' && chain.length) {
      abortIfNeeded(signal);
      const L = r.layout;
      const cols = L.columns;
      const regions = []; // {col, y0, y1, missing:Set}
      const addFlow = (a, b, missing) => {
        // a → b 사이(같은 단이면 그 사이, 다른 단이면 a 아래 + b 위)
        if (!a) {
          regions.push({ col: b.col, y0: L.bodyTop, y1: b.y0, missing });
          for (let c = 0; c < b.col; c++) regions.push({ col: c, y0: L.bodyTop, y1: L.bodyBottom, missing });
          return;
        }
        if (a.col === b.col) regions.push({ col: a.col, y0: a.y1, y1: b.y0, missing });
        else {
          regions.push({ col: a.col, y0: a.y1, y1: L.bodyBottom, missing });
          for (let c = a.col + 1; c < b.col; c++) regions.push({ col: c, y0: L.bodyTop, y1: L.bodyBottom, missing });
          regions.push({ col: b.col, y0: L.bodyTop, y1: b.y0, missing });
        }
      };
      const range = (lo, hi) => new Set(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
      if (prevLast != null && chain[0].num - prevLast >= 2 && chain[0].num - prevLast <= 4) addFlow(null, chain[0], range(prevLast + 1, chain[0].num - 1));
      for (let i = 0; i + 1 < chain.length; i++) {
        const d = chain[i + 1].num - chain[i].num;
        if (d >= 2 && d <= 4) addFlow(chain[i], chain[i + 1], range(chain[i].num + 1, chain[i + 1].num - 1));
      }
      if (regions.length) {
        onProgress?.({ phase: 'scan', done: k, total: results.length, message: `${r.index + 1}쪽 빠진 번호 찾는 중` });
        const found = await findNumbersInRegions(src, r, regions, chain, signature, ocrLang);
        if (found.length) {
          r.candidates.push(...found);
          r.candidates.sort((a, b) => a.col - b.col || a.y0 - b.y0);
          const { anchors: again } = selectAnchors([r], { numberStyle, signature, prevLast });
          // (빠진 번호 재탐색은 대표 번호 체계 기준)
          const next = again.get(r.index) || [];
          if (next.length > chain.length) {
            anchors.set(r.index, next);
            added += next.length - chain.length;
          }
        }
      }
    }
    const ch = anchors.get(r.index) || [];
    if (ch.length) prevLast = ch[ch.length - 1].num;
  }
  return added;
}

async function findNumbersInRegions(src, page, regions, chain, sig, ocrLang) {
  const { grid, layout } = page;
  const hNum = chain.map((c) => c.h).sort((a, b) => a - b)[chain.length >> 1] || 0.015;
  // 숫자 한 글자 폭(이미 찾은 번호들에서)
  const perDigit = chain.map((c) => (c.x1 - c.x0) / Math.max(1, c.digits.length)).sort((a, b) => a - b)[chain.length >> 1] || hNum * 0.6;
  let hi = null;
  const found = [];
  for (const reg of regions) {
    const col = layout.columns[reg.col];
    if (!col || reg.y1 - reg.y0 < hNum) continue;
    const bx0 = col.x0 + sig.relX - 0.01;
    const bx1 = col.x0 + sig.relX + 0.03;
    for (const band of inkBands(grid, bx0, bx1, reg.y0, reg.y1)) {
      if (!reg.missing.size) break;
      const bh = band.y1 - band.y0;
      if (bh < hNum * 0.5 || bh > hNum * 2.6) continue;
      if (!hi) hi = await src.renderPage(page.index, OCR_WIDTH);
      // 번호 덩어리만 잘라냄(뒤에 붙은 본문 글자가 섞이면 숫자 인식이 흐트러짐)
      const span = inkSpan(grid, bx0, Math.min(col.x1, bx0 + 0.08), band.y0, band.y1);
      if (!span) continue;
      const digits = Math.max(...[...reg.missing].map((n) => (sig.padded && sig.digitsLen ? sig.digitsLen : String(n).length)));
      const cx0 = Math.max(0, span.x0 - 0.008);
      const cx1 = Math.min(1, Math.min(span.x1, span.x0 + perDigit * digits * 1.25) + 0.006);
      const cy0 = Math.max(0, band.y0 - 0.005);
      const cy1 = Math.min(1, band.y1 + 0.005);
      const W = hi.width;
      const H = hi.height;
      // 숫자 높이가 40px 안팎이 되게 키우고(작은 글씨 대응) 여백을 둠
      const S = Math.min(2.5, Math.max(1, 40 / Math.max(1, bh * H)));
      const cw = (cx1 - cx0) * W;
      const ch = (cy1 - cy0) * H;
      const crop = createCanvas(cw * S + 40, ch * S + 40);
      const ctx = crop.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, crop.width, crop.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(hi, cx0 * W, cy0 * H, cw, ch, 20, 20, cw * S, ch * S);
      const { text, conf } = await recognizeLine(crop, { lang: ocrLang, whitelist: '0123456789.)' });
      // 앞에 붙은 점·잡티는 버리고 첫 숫자 덩어리만 (예: ".0006" → 0006)
      let m = /(\d{1,4})/.exec(text.replace(/\s+/g, ' '));
      if (!m) continue;
      let num = parseInt(m[1], 10);
      if (!reg.missing.has(num) && reg.missing.size === 1) {
        // 빠진 번호가 하나뿐이고, 번호 자리·크기가 맞는 덩어리에서 그 번호의 앞부분이 읽혔다면 그 번호로 봄
        const want = [...reg.missing][0];
        const wantStr = sig.padded && sig.digitsLen ? String(want).padStart(sig.digitsLen, '0') : String(want);
        const widthOk = Math.abs(span.x1 - span.x0 - perDigit * wantStr.length) <= perDigit * wantStr.length * 0.35;
        const heightOk = bh > hNum * 0.75 && bh < hNum * 1.5;
        if (widthOk && heightOk && m[1].length >= 2 && wantStr.startsWith(m[1])) {
          num = want;
          m = [wantStr, wantStr];
        }
      }
      if (!reg.missing.has(num)) continue;
      if (sig.padded && sig.digitsLen && m[1].length !== sig.digitsLen) continue; // 0001 같은 번호면 자릿수도 맞아야 함
      reg.missing.delete(num);
      found.push({
        num,
        digits: m[1],
        style: sig.style,
        x0: col.x0 + sig.relX,
        x1: col.x0 + sig.relX + 0.02,
        y0: band.y0,
        y1: band.y1,
        h: bh,
        col: reg.col,
        relX: sig.relX,
        hRatio: page.bodyH ? bh / page.bodyH : sig.hRatio,
        conf: Math.max(60, conf),
        padded: m[1].length >= 2 && m[1][0] === '0',
        ocr: true,
      });
    }
  }
  return found;
}

/** 띠(y0~y1) 안에서 x0 부터 오른쪽으로 첫 잉크 덩어리의 가로 범위 (빈 칸 2개 이상이면 끝) */
function inkSpan(grid, x0, x1, y0, y1) {
  const { w, h, data } = grid;
  const gx0 = Math.max(0, Math.floor(x0 * w));
  const gx1 = Math.min(w, Math.ceil(x1 * w));
  const gy0 = Math.max(0, Math.floor(y0 * h));
  const gy1 = Math.min(h, Math.ceil(y1 * h));
  const colHasInk = (x) => {
    for (let y = gy0; y < gy1; y++) if (data[y * w + x]) return true;
    return false;
  };
  let start = -1;
  let end = -1;
  let empty = 0;
  for (let x = gx0; x < gx1; x++) {
    if (colHasInk(x)) {
      if (start < 0) start = x;
      end = x + 1;
      empty = 0;
    } else if (start >= 0 && ++empty >= 2) break;
  }
  return start < 0 ? null : { x0: start / w, x1: end / w };
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

/**
 * 문서 전체 분석
 * @param {import('./docsource.js').DocSource} src
 * @param {object} opts
 *   pages: number[]               분석할 쪽(0부터)
 *   role: 'problem'|'answer'
 *   flow: 'column'|'continue'
 *   numberStyle: 'auto'|...
 *   ocrLang
 *   gemini: {mode:'off'|'auto'|'all', model, rpm}
 *   onProgress({phase, done, total, message})
 *   signal
 */
export async function analyzeDocument(src, opts) {
  const { pages, role = 'problem', flow = 'column', numberStyle = 'auto', ocrLang, onProgress, signal } = opts;
  const results = [];
  const layouts = new Map();
  const grids = new Map();
  const sourceMap = new Map();
  let ocrPages = 0;
  let splitHint = null; // 번호 위치로 추정한 단 위치(같은 책 다음 쪽에도 적용)

  for (let k = 0; k < pages.length; k++) {
    abortIfNeeded(signal);
    const idx = pages[k];
    onProgress?.({ phase: 'scan', done: k, total: pages.length, message: `${idx + 1}쪽 분석 중` });
    const page = await analyzePage(src, idx, { ocrLang, ocrFallback: false, role, splitHint });
    if (page.layout.inferred) splitHint = page.layout.inferred;
    if (page.source === 'ocr') ocrPages++;
    results.push(page);
    layouts.set(idx, page.layout);
    grids.set(idx, page.grid);
    sourceMap.set(idx, page.source);
  }

  // 텍스트 레이어는 있지만 번호를 거의 못 찾은 문서 → 번호가 그림으로 되어 있는 것으로 보고 OCR
  const textPages = results.filter((r) => r.source === 'text' && !r.layout.blank);
  const withNums = textPages.filter((r) => r.candidates.length > 0).length;
  if (textPages.length && withNums / textPages.length < 0.3) {
    const retry = results.filter((r) => r.textWithoutNumbers);
    for (let k = 0; k < retry.length; k++) {
      abortIfNeeded(signal);
      const r = retry[k];
      onProgress?.({ phase: 'scan', done: k, total: retry.length, message: `${r.index + 1}쪽 OCR 중` });
      const page = await analyzePage(src, r.index, { ocrLang, forceOcr: true, role });
      Object.assign(r, page);
      sourceMap.set(r.index, page.source);
      ocrPages++;
    }
  }
  onProgress?.({ phase: 'scan', done: pages.length, total: pages.length, message: '번호 정리 중' });

  // 빠른 정답표 쪽은 번호 인식에서 뺌 (답지에서만)
  const tablePages = new Set();
  if (role === 'answer') {
    for (const r of results) {
      if (r.isTable || looksLikeAnswerTable(r.candidates)) {
        tablePages.add(r.index);
        r.candidates = [];
        r.ranges = [];
      }
    }
  }
  const { anchors, signature, signatures } = selectAnchors(results, { numberStyle });
  if (ocrPages) await fillOcrGaps(src, results, anchors, signature, { ocrLang, numberStyle, signal, onProgress });
  // 번호가 건너뛴 곳은 버려진 후보에서 다시 찾아 채움
  fillGapsFromCandidates(results, anchors, signatures);
  const flags = flagPages(pages, anchors, layouts);
  for (const idx of tablePages) flags.set(idx, ['빠른 정답표 같아서 건너뜀']);
  const cutters = buildCutters(results, anchors, signature);
  const ranges = new Map(results.filter((r) => r.ranges?.length).map((r) => [r.index, r.ranges]));
  let items = computeItems(pages, anchors, layouts, grids, { flow, source: sourceMap, cutters, stopPages: tablePages, ranges });

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
  return { items, pageInfo, signature, signatures, pageOffset, ocrPages, layouts, grids };
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
 * 문항 영역을 끊는 위치들: 큰 글씨 제목, 여러 단 쪽의 가로 띠(단원 제목 막대), 제목처럼 큰 번호
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
    for (const hd of r.headings || []) add(r.index, { x0: hd.x0, x1: hd.x1, y0: hd.y0 - 0.004 });
    for (const rg of r.ranges || []) add(r.index, { x0: rg.x0, x1: rg.x1, y0: rg.y0 - 0.006 });
    if ((r.layout?.columns?.length || 1) >= 2) {
      for (const b of r.layout.spans || []) add(r.index, { x0: 0, x1: 1, y0: b.y0 - 0.002 });
    }
  }
  return map;
}

/** Gemini 로 한 페이지 인식 → 문항 배열 */
export async function detectPageWithGemini(src, idx, { role, gemini, grid, layout, signal }) {
  const canvas = await src.renderPage(idx, GEMINI_WIDTH);
  if (!grid || !layout) {
    const small = await src.renderPage(idx, ANALYSIS_WIDTH);
    grid = inkGridFromCanvas(small);
    layout = analyzeLayout(grid);
  }
  const found = await geminiDetect(canvasToBase64Jpeg(canvas), { role, model: gemini.model, rpm: gemini.rpm, signal });
  return found.map((f) => {
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
  if (role === 'answer' && looksLikeAnswerTable(page.candidates)) page.candidates = [];
  const signatures = doc.signatures || (doc.signature ? [doc.signature] : null);
  const { anchors: sel } = selectAnchors([page], { numberStyle: doc.options?.numberStyle, signatures, prevLast });
  let chain = sel.get(idx) || [];
  if (deep) {
    const plain = chain.filter((c) => !c.prefix);
    const expected = chooseExpectedChain(page.candidates.filter((c) => !c.prefix), prevLast, nextFirst);
    if (expected.length > plain.length) chain = [...expected, ...chain.filter((c) => c.prefix)].sort((a, b) => a.col - b.col || a.y0 - b.y0);
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
