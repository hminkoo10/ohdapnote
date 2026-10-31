// 문서 분석 파이프라인: 렌더링 → 레이아웃 → (텍스트 | OCR) → 번호 선택 → 영역 계산 → (Gemini 보조)

import { analyzeLayout, inkGridFromCanvas, trimRect } from './layout.js';
import {
  extractCandidates,
  selectAnchors,
  flagPages,
  computeItems,
  assignIds,
  sortItems,
  columnOf,
  guessPageOffset,
  findCutters,
} from './detect.js';
import { recognizeWords, recognizeLine } from './ocr.js';
import { geminiDetect, canvasToBase64Jpeg } from './gemini.js';
import { createCanvas } from './docsource.js';

const ANALYSIS_WIDTH = 960; // 레이아웃 분석용 렌더링 폭(px)
const OCR_WIDTH = 2300; // OCR 용 렌더링 폭(px)
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
 * 한 페이지 분석(번호 후보까지)
 * @returns {Promise<{index:number, layout:object, grid:object, candidates:object[], source:string, footerNumbers:number[]}>}
 */
export async function analyzePage(src, index, { ocrLang = 'kor+eng', forceOcr = false, ocrFallback = true } = {}) {
  const canvas = await src.renderPage(index, ANALYSIS_WIDTH);
  const grid = inkGridFromCanvas(canvas);
  const layout = analyzeLayout(grid);
  const page = { index, layout, grid, candidates: [], source: 'text', footerNumbers: [] };
  if (layout.blank) return page;

  const tokens = forceOcr ? [] : await src.getTextTokens(index);
  const textChars = tokens.reduce((n, t) => n + t.str.length, 0);
  if (textChars >= 30) {
    page.candidates = extractCandidates(tokens, layout).candidates;
    for (const t of tokens) {
      const cy = (t.y0 + t.y1) / 2;
      const inMargin = (layout.hasHeader && cy < layout.bodyTop) || (layout.hasFooter && cy > layout.bodyBottom);
      if (inMargin && /^\d{1,4}$/.test(t.str)) page.footerNumbers.push(parseInt(t.str, 10));
    }
    if (page.candidates.length > 0) return page;
    // 글자는 있는데 번호가 없는 쪽(개념 설명 쪽 등). 번호가 그림/도형으로 그려진 책일 수도 있음
    page.textWithoutNumbers = true;
    if (!ocrFallback) return page;
  }

  // 텍스트 레이어가 없거나 번호가 글자로 들어있지 않으면 OCR
  page.source = 'ocr';
  const hi = await src.renderPage(index, OCR_WIDTH);
  const tokensOcr = [];
  const W = hi.width;
  const H = hi.height;
  const y0 = Math.max(0, layout.bodyTop - 0.006);
  const y1 = Math.min(1, layout.bodyBottom + 0.006);
  for (const col of layout.columns) {
    // 단의 왼쪽 띠만 OCR (번호는 줄 맨 앞에 있으므로) → 훨씬 빠름
    const sx0 = Math.max(0, col.x0 - 0.012);
    const sx1 = Math.min(col.x1, col.x0 + 0.17);
    const sw = Math.round((sx1 - sx0) * W);
    const sh = Math.round((y1 - y0) * H);
    if (sw < 10 || sh < 10) continue;
    const strip = createCanvas(sw, sh);
    const ctx = strip.getContext('2d');
    ctx.drawImage(hi, Math.round(sx0 * W), Math.round(y0 * H), sw, sh, 0, 0, sw, sh);
    const words = await recognizeWords(strip, { lang: ocrLang, psm: '4' });
    for (const w of words) {
      tokensOcr.push({
        str: w.str,
        conf: w.conf,
        x0: sx0 + w.x0 / W,
        x1: sx0 + w.x1 / W,
        y0: y0 + w.y0 / H,
        y1: y0 + w.y1 / H,
      });
    }
  }
  const ex = extractCandidates(tokensOcr, layout, { ocr: true });
  page.candidates = ex.candidates;
  page.bodyH = ex.bodyH;
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
  let hi = null;
  const found = [];
  for (const reg of regions) {
    const col = layout.columns[reg.col];
    if (!col || reg.y1 - reg.y0 < hNum) continue;
    const bx0 = col.x0 + sig.relX - 0.01;
    const bx1 = col.x0 + sig.relX + 0.03;
    for (const band of inkBands(grid, bx0, bx1, reg.y0, reg.y1)) {
      const bh = band.y1 - band.y0;
      if (bh < hNum * 0.5 || bh > hNum * 2.6) continue;
      if (!hi) hi = await src.renderPage(page.index, OCR_WIDTH);
      // 번호 덩어리만 잘라냄(뒤에 붙은 본문 글자가 섞이면 숫자 인식이 흐트러짐)
      const span = inkSpan(grid, bx0, Math.min(col.x1, bx0 + 0.08), band.y0, band.y1);
      if (!span) continue;
      const cx0 = Math.max(0, span.x0 - 0.008);
      const cx1 = Math.min(1, span.x1 + 0.008);
      const cy0 = Math.max(0, band.y0 - 0.005);
      const cy1 = Math.min(1, band.y1 + 0.005);
      const W = hi.width;
      const H = hi.height;
      const crop = createCanvas((cx1 - cx0) * W + 20, (cy1 - cy0) * H + 20);
      const ctx = crop.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, crop.width, crop.height);
      ctx.drawImage(hi, cx0 * W, cy0 * H, (cx1 - cx0) * W, (cy1 - cy0) * H, 10, 10, (cx1 - cx0) * W, (cy1 - cy0) * H);
      const { text, conf } = await recognizeLine(crop, { lang: ocrLang, whitelist: '0123456789.)' });
      const m = /^(\d{1,4})/.exec(text.replace(/\s+/g, ' ').split(' ')[0] || '');
      if (!m) continue;
      const num = parseInt(m[1], 10);
      if (!reg.missing.has(num)) continue;
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
  const { pages, role = 'problem', flow = 'column', numberStyle = 'auto', ocrLang, gemini, onProgress, signal } = opts;
  const results = [];
  const layouts = new Map();
  const grids = new Map();
  const sourceMap = new Map();
  let ocrPages = 0;

  for (let k = 0; k < pages.length; k++) {
    abortIfNeeded(signal);
    const idx = pages[k];
    onProgress?.({ phase: 'scan', done: k, total: pages.length, message: `${idx + 1}쪽 분석 중` });
    const page = await analyzePage(src, idx, { ocrLang, ocrFallback: false });
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
      const page = await analyzePage(src, r.index, { ocrLang, forceOcr: true });
      Object.assign(r, page);
      sourceMap.set(r.index, page.source);
      ocrPages++;
    }
  }
  onProgress?.({ phase: 'scan', done: pages.length, total: pages.length, message: '번호 정리 중' });

  const { anchors, signature } = selectAnchors(results, { numberStyle });
  if (ocrPages) await fillOcrGaps(src, results, anchors, signature, { ocrLang, numberStyle, signal, onProgress });
  const flags = flagPages(pages, anchors, layouts);
  const cutters = findCutters(results, anchors, signature);
  let items = computeItems(pages, anchors, layouts, grids, { flow, source: sourceMap, cutters });

  // ---- Gemini 보조 ----
  const geminiPages = new Set();
  const geminiErrors = [];
  if (gemini && gemini.mode && gemini.mode !== 'off') {
    const targets = pages.filter((idx) => {
      const L = layouts.get(idx);
      if (!L || L.blank) return false;
      return gemini.mode === 'all' || flags.has(idx);
    });
    for (let k = 0; k < targets.length; k++) {
      abortIfNeeded(signal);
      const idx = targets[k];
      onProgress?.({ phase: 'gemini', done: k, total: targets.length, message: `Gemini 인식: ${idx + 1}쪽` });
      try {
        const found = await detectPageWithGemini(src, idx, { role, gemini, grid: grids.get(idx), layout: layouts.get(idx), signal });
        if (found.length) {
          items = replacePageItems(items, idx, found);
          geminiPages.add(idx);
          flags.delete(idx);
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        geminiErrors.push(`${idx + 1}쪽: ${err.message}`);
        if (/한도|quota|429/i.test(err.message)) break; // 한도 초과면 중단
      }
    }
    onProgress?.({ phase: 'gemini', done: targets.length, total: targets.length, message: 'Gemini 완료' });
  }

  items = assignIds(sortItems(items));
  const pageInfo = {};
  for (const idx of pages) {
    pageInfo[idx] = {
      analyzed: true,
      source: geminiPages.has(idx) ? 'gemini' : sourceMap.get(idx),
      blank: !!layouts.get(idx)?.blank,
      columns: layouts.get(idx)?.columns?.length || 1,
      flags: flags.get(idx) || [],
    };
  }
  const pageOffset = guessPageOffset(results.map((r) => ({ index: r.index, numbers: r.footerNumbers })));
  return { items, pageInfo, signature, pageOffset, ocrPages, geminiErrors, layouts, grids };
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
 * 편집기에서 "이 쪽 다시 인식(로컬)"
 */
export async function reanalyzeSinglePage(src, doc, idx, { ocrLang, forceOcr = false } = {}) {
  const page = await analyzePage(src, idx, { ocrLang, forceOcr });
  const sig = doc.signature;
  // 앞 쪽의 마지막 번호
  const prevItems = (doc.items || []).filter((it) => it.page < idx);
  const prevLast = prevItems.length ? sortItems(prevItems).pop().num : null;
  const { anchors: sel } = selectAnchors([page], { numberStyle: doc.options?.numberStyle, signature: sig || null, prevLast });
  const chain = sel.get(idx) || [];
  const anchors = new Map([[idx, chain]]);
  const newItems = computeItems([idx], anchors, new Map([[idx, page.layout]]), new Map([[idx, page.grid]]), {
    flow: 'column',
    source: new Map([[idx, page.source]]),
  });
  return { items: newItems, page };
}
