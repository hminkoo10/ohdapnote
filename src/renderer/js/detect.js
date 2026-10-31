// 문제 번호 인식 + 문항 영역 계산 (순수 함수, Node 에서 테스트 가능)
//
// 흐름
//  1) 토큰(단어 + 위치) → 줄/단어 묶기 → "줄 맨 앞의 숫자"를 번호 후보로 추출
//  2) 책 전체에서 번호 모양(위치·점 유무·0 채움·크기)의 "대표 스타일"을 학습
//  3) 페이지마다 번호가 1씩 증가하는 가장 그럴듯한 사슬을 동적계획법으로 선택
//  4) 번호 위치와 단 정보로 문항 영역(사각형들)을 계산

import { trimRect } from './layout.js';

/** @typedef {{str:string,x0:number,y0:number,x1:number,y1:number,conf?:number}} Token */

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const mode = (arr) => {
  const counts = new Map();
  let best = null;
  let bestN = 0;
  for (const v of arr) {
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return { value: best, count: bestN };
};

/**
 * OCR 에서 자주 헷갈리는 글자를 숫자로 보정(숫자가 하나 이상 섞인 짧은 단어만)
 */
export function normalizeOcrWord(str) {
  if (!/\d/.test(str) || str.length > 7) return str;
  return str
    .replace(/[lI|!]/g, '1')
    .replace(/[oOQD]/g, '0')
    .replace(/,$/, '.')
    .replace(/[。·]$/, '.');
}

/**
 * 토큰들을 줄 단위로 묶고, 한 줄 안에서 가까운 토큰은 하나의 단어로 합칩니다.
 * @param {Token[]} tokens
 */
export function buildLines(tokens) {
  const toks = tokens
    .filter((t) => t.str && t.x1 > t.x0 && t.y1 > t.y0)
    .map((t) => ({ ...t, h: t.y1 - t.y0, cy: (t.y0 + t.y1) / 2 }))
    .sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
  const lines = [];
  // 최근 줄들만 비교(위→아래로 정렬되어 있으므로)
  for (const t of toks) {
    let target = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 40; i--) {
      const L = lines[i];
      const ratio = t.h / L.h;
      if (ratio < 0.6 || ratio > 1.65) continue;
      if (Math.abs(t.cy - L.cy) <= 0.3 * Math.max(t.h, L.h)) {
        target = L;
        break;
      }
    }
    if (!target) {
      target = { tokens: [], cy: t.cy, h: t.h, y0: t.y0, y1: t.y1 };
      lines.push(target);
    }
    target.tokens.push(t);
    target.y0 = Math.min(target.y0, t.y0);
    target.y1 = Math.max(target.y1, t.y1);
  }
  for (const L of lines) {
    L.tokens.sort((a, b) => a.x0 - b.x0);
    L.h = median(L.tokens.map((t) => t.h));
    // 단어 합치기 (글자 단위로 쪼개진 PDF 대응)
    const words = [];
    for (const t of L.tokens) {
      const last = words[words.length - 1];
      if (last && t.x0 - last.x1 < 0.12 * L.h && t.x0 >= last.x0) {
        last.str += t.str;
        last.x1 = Math.max(last.x1, t.x1);
        last.y0 = Math.min(last.y0, t.y0);
        last.y1 = Math.max(last.y1, t.y1);
        last.conf = Math.min(last.conf ?? 100, t.conf ?? 100);
      } else {
        words.push({ str: t.str, x0: t.x0, x1: t.x1, y0: t.y0, y1: t.y1, conf: t.conf ?? 100 });
      }
    }
    L.words = words;
  }
  return lines;
}

const NUM_RE = /^([[(（【〔]?)(\d{1,4})([.)\]）】〕]?)(.*)$/;

/**
 * 단어가 문제 번호처럼 생겼는지 확인합니다.
 * @returns {{num:number,digits:string,style:string}|null}
 */
export function parseNumberWord(str) {
  const m = NUM_RE.exec(str);
  if (!m) return null;
  const [, open, digits, close, rest] = m;
  if (open && !close) return null;
  let style = 'plain';
  if (open) style = open === '[' || open === '【' || open === '〔' ? 'bracket' : 'paren';
  else if (close === '.') style = 'dot';
  else if (close === ')' || close === '）') style = 'rparen';
  else if (close) return null;
  if (rest) {
    // "12.다음" 처럼 구두점 뒤에 바로 글자가 붙은 경우만 허용 (3x, 1.5 등은 제외)
    if (!close) return null;
    if (/^[\d.,]/.test(rest)) return null;
  }
  const num = parseInt(digits, 10);
  if (!(num >= 1) && digits !== '0') return null;
  if (num === 0) return null;
  return { num, digits, style };
}

/**
 * 한 페이지의 번호 후보 추출
 * @param {Token[]} tokens
 * @param {object} layout analyzeLayout 결과
 * @param {{ocr?:boolean}} [opts]
 */
export function extractCandidates(tokens, layout, opts = {}) {
  const lines = buildLines(tokens);
  const bodyH = median(lines.map((l) => l.h)) || 0.012;
  const words = [];
  for (const L of lines) for (const w of L.words) words.push({ ...w, lineH: L.h });

  // 세로로 겹치는 단어를 빨리 찾기 위한 버킷
  const BUCKET = 0.01;
  const buckets = new Map();
  for (const w of words) {
    for (let b = Math.floor(w.y0 / BUCKET); b <= Math.floor(w.y1 / BUCKET); b++) {
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(w);
    }
  }
  const hasLeftNeighbor = (w) => {
    const h = w.y1 - w.y0;
    const gap = Math.max(1.6 * h, 0.012);
    const seen = new Set();
    for (let b = Math.floor(w.y0 / BUCKET); b <= Math.floor(w.y1 / BUCKET); b++) {
      for (const u of buckets.get(b) || []) {
        if (u === w || seen.has(u)) continue;
        seen.add(u);
        if (u.x0 >= w.x0) continue;
        if (u.x1 < w.x0 - gap) continue;
        const ov = Math.min(u.y1, w.y1) - Math.max(u.y0, w.y0);
        if (ov > 0.35 * Math.min(h, u.y1 - u.y0)) return true;
      }
    }
    return false;
  };

  const cols = layout?.columns?.length ? layout.columns : [{ x0: 0, x1: 1 }];
  const bodyTop = layout?.bodyTop ?? 0;
  const bodyBottom = layout?.bodyBottom ?? 1;

  const candidates = [];
  for (const w of words) {
    const str = opts.ocr ? normalizeOcrWord(w.str) : w.str;
    const parsed = parseNumberWord(str);
    if (!parsed) continue;
    const cy = (w.y0 + w.y1) / 2;
    // 머리말/꼬리말(쪽번호) 제외
    if (layout?.hasHeader && cy < bodyTop) continue;
    if (layout?.hasFooter && cy > bodyBottom) continue;
    if (hasLeftNeighbor(w)) continue;
    const cx = (w.x0 + w.x1) / 2;
    let col = 0;
    let bestD = Infinity;
    cols.forEach((c, i) => {
      const d = cx < c.x0 ? c.x0 - cx : cx > c.x1 ? cx - c.x1 : 0;
      if (d < bestD) {
        bestD = d;
        col = i;
      }
    });
    candidates.push({
      ...parsed,
      x0: w.x0,
      x1: w.x1,
      y0: w.y0,
      y1: w.y1,
      h: w.y1 - w.y0,
      col,
      relX: w.x0 - cols[col].x0,
      hRatio: (w.y1 - w.y0) / bodyH,
      conf: w.conf ?? 100,
      padded: parsed.digits.length >= 2 && parsed.digits[0] === '0',
      ocr: !!opts.ocr,
    });
  }
  candidates.sort((a, b) => a.col - b.col || a.y0 - b.y0);
  return { candidates, bodyH, lineCount: lines.length };
}

// ---------------------------------------------------------------------------
// 번호 사슬 선택
// ---------------------------------------------------------------------------

function transitionScore(a, b) {
  const d = b.num - a.num;
  if (d === 1) return 2.5;
  if (d === 2) return 0.4;
  if (d === 3) return -0.2;
  if (d >= 4 && d <= 8) return -3;
  // 단원이 바뀌며 1번부터 다시 시작 (단원 제목의 "01" 같은 것과 구분하기 위해 앞 번호가 3 이상일 때만)
  if (b.num === 1) return a.num >= 3 ? -0.4 : -6;
  return -6;
}

function startScore(prevLast, c) {
  if (prevLast == null) return c.num === 1 ? 0.8 : 0.4;
  if (c.num === prevLast + 1) return 2.5;
  if (c.num === 1) return 0.8;
  const d = c.num - prevLast;
  if (d > 1 && d <= 4) return 0.3;
  return -0.6;
}

/** 페이지 안에서의 정렬 근거(같은 단에서 x 가 거의 같은 후보 수) */
function alignmentSupport(cands, i, tol = 0.008) {
  let n = 0;
  for (let j = 0; j < cands.length; j++) {
    if (j !== i && cands[j].col === cands[i].col && Math.abs(cands[j].relX - cands[i].relX) <= tol) n++;
  }
  return n;
}

function priorLocal(cands, i) {
  const c = cands[i];
  let s = 0.5 * Math.min(alignmentSupport(cands, i), 3);
  if (c.relX > 0.06) s -= 1.5;
  else if (c.relX < 0.02) s += 0.3;
  if (c.hRatio >= 1.1) s += 0.3;
  if (c.hRatio < 0.75) s -= 0.8;
  if (c.style === 'dot' || c.style === 'bracket') s += 0.2;
  if (c.conf < 60) s -= 0.6;
  return s;
}

function priorWithStyle(cands, i, sig) {
  const c = cands[i];
  let s = 0.15 * Math.min(alignmentSupport(cands, i), 3);
  const dx = Math.abs(c.relX - sig.relX);
  if (dx <= 0.012) s += 1.6;
  else if (dx <= 0.03) s += 0.2;
  else s -= 2;
  if (c.style === sig.style) s += 0.9;
  else if (c.ocr && (c.style === 'dot' || c.style === 'plain') && (sig.style === 'dot' || sig.style === 'plain')) s -= 0.2; // OCR 은 점을 놓치거나 더 읽기도 함
  else s -= 1.6;
  s += c.padded === sig.padded ? 0.4 : -1.2;
  if (sig.padded && sig.digitsLen && c.digits.length !== sig.digitsLen) s -= 1.5;
  if (sig.hRatio > 0) {
    const r = c.hRatio / sig.hRatio;
    if (r > 0.92 && r < 1.2) s += 0.4;
    else if (r < 0.65 || r > 1.6) s -= 0.8;
  }
  if (c.conf < 60) s -= 0.6;
  return s;
}

/**
 * 한 페이지에서 가장 그럴듯한 번호 사슬을 고릅니다.
 * @returns {object[]} 선택된 후보들(읽는 순서)
 */
export function chooseChain(cands, prevLast, priorFn) {
  const n = cands.length;
  if (!n) return [];
  const prior = cands.map((_, i) => priorFn(i));
  const dp = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let j = 0; j < n; j++) {
    let best = startScore(prevLast, cands[j]);
    let arg = -1;
    for (let i = 0; i < j; i++) {
      const a = cands[i];
      const b = cands[j];
      // 같은 단에서 거의 같은 높이면 같이 선택할 수 없음
      if (a.col === b.col && b.y0 - a.y0 < 0.6 * Math.max(a.h, b.h)) continue;
      const v = dp[i] + transitionScore(a, b);
      if (v > best) {
        best = v;
        arg = i;
      }
    }
    dp[j] = best + prior[j] + 1;
    back[j] = arg;
  }
  let end = 0;
  for (let j = 1; j < n; j++) if (dp[j] > dp[end]) end = j;
  if (dp[end] < 1.5) return [];
  const chain = [];
  for (let k = end; k >= 0; k = back[k]) chain.push(cands[k]);
  chain.reverse();
  // 점수에 거의 기여하지 못하는 동떨어진 후보 제거
  return chain.filter((c) => prior[cands.indexOf(c)] > -2.5);
}

/**
 * 문서 전체 번호 선택(2단계).
 * @param {{index:number, candidates:object[]}[]} pages  분석한 페이지(쪽 순서)
 * @param {{numberStyle?:string, signature?:object, prevLast?:number}} [opts]
 *   numberStyle: auto|dot|plain|pad|bracket, signature: 이전에 학습한 대표 스타일
 * @returns {{anchors: Map<number, object[]>, signature: object|null}}
 */
export function selectAnchors(pages, opts = {}) {
  const forced = opts.numberStyle && opts.numberStyle !== 'auto' ? opts.numberStyle : null;
  const styleOk = (c) => {
    if (!forced) return true;
    if (forced === 'dot') return c.style === 'dot';
    if (forced === 'plain') return c.style === 'plain' && !c.padded;
    if (forced === 'pad') return c.padded;
    if (forced === 'bracket') return c.style === 'bracket' || c.style === 'paren';
    return true;
  };
  const filtered = pages.map((p) => ({ ...p, candidates: p.candidates.filter(styleOk) }));

  // 1단계: 페이지별(스타일 정보 없이) 선택 → 대표 스타일 추정
  const firstPass = [];
  let prev = opts.prevLast ?? null;
  for (const p of filtered) {
    const chain = chooseChain(p.candidates, prev, (i) => priorLocal(p.candidates, i));
    if (chain.length) prev = chain[chain.length - 1].num;
    firstPass.push(...chain);
  }

  let signature = opts.signature || null;
  if (!signature && firstPass.length >= 4) {
    signature = {
      relX: median(firstPass.map((c) => c.relX)),
      style: mode(firstPass.map((c) => c.style)).value,
      padded: mode(firstPass.map((c) => c.padded)).value,
      hRatio: median(firstPass.map((c) => c.hRatio)),
      digitsLen: mode(firstPass.filter((c) => c.padded).map((c) => c.digits.length)).value || 0,
    };
  }

  // 2단계: 대표 스타일과의 유사도를 반영해 다시 선택
  const anchors = new Map();
  prev = opts.prevLast ?? null;
  for (const p of filtered) {
    const priorFn = signature ? (i) => priorWithStyle(p.candidates, i, signature) : (i) => priorLocal(p.candidates, i);
    const chain = chooseChain(p.candidates, prev, priorFn);
    if (chain.length) prev = chain[chain.length - 1].num;
    anchors.set(p.index, chain);
  }
  return { anchors, signature };
}

/**
 * 페이지별 "확인 필요" 표시
 * @param {number[]} order 분석한 페이지 번호(순서대로)
 * @param {Map<number, object[]>} anchors
 * @param {Map<number, object>} layouts
 */
export function flagPages(order, anchors, layouts) {
  const flags = new Map();
  let prevLast = null;
  for (let k = 0; k < order.length; k++) {
    const idx = order[k];
    const chain = anchors.get(idx) || [];
    const reasons = [];
    if (!chain.length) {
      const L = layouts.get(idx);
      const prevHas = k > 0 && (anchors.get(order[k - 1]) || []).length > 0;
      const nextHas = k + 1 < order.length && (anchors.get(order[k + 1]) || []).length > 0;
      if (L && !L.blank && L.inkRatio > 0.02 && prevHas && nextHas) reasons.push('번호를 찾지 못함');
    } else {
      if (prevLast != null && chain[0].num !== prevLast + 1 && chain[0].num !== 1) reasons.push('앞 쪽과 번호가 이어지지 않음');
      for (let i = 1; i < chain.length; i++) {
        const d = chain[i].num - chain[i - 1].num;
        if (d !== 1 && chain[i].num !== 1) {
          reasons.push('중간에 빠진 번호가 있음');
          break;
        }
      }
      if (chain.some((c) => c.conf < 65)) reasons.push('인식 신뢰도 낮음');
      prevLast = chain[chain.length - 1].num;
    }
    if (reasons.length) flags.set(idx, reasons);
  }
  return flags;
}

/**
 * 선택되지 않은 후보 중 "단원 제목" 처럼 보이는 것(크기/0채움이 대표 스타일과 다름)
 * @returns {Map<number, object[]>}
 */
export function findCutters(pages, anchors, signature) {
  const map = new Map();
  if (!signature) return map;
  for (const p of pages) {
    const chosen = new Set(anchors.get(p.index) || []);
    const list = p.candidates.filter(
      (c) =>
        !chosen.has(c) &&
        Math.abs(c.relX - signature.relX) < 0.03 &&
        (c.padded !== signature.padded || c.hRatio > signature.hRatio * 1.15),
    );
    if (list.length) map.set(p.index, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 영역 계산
// ---------------------------------------------------------------------------

/**
 * 번호 위치로 문항 영역을 계산합니다.
 * @param {number[]} order  분석한 페이지(순서대로)
 * @param {Map<number, object[]>} anchors
 * @param {Map<number, object>} layouts  페이지별 analyzeLayout 결과
 * @param {Map<number, object>} grids    페이지별 잉크 격자
 * @param {{flow?:'column'|'continue', source?:Map<number,string>}} opts
 *    flow = 'continue' 이면 문항(해설)이 다음 단/페이지로 이어질 수 있음
 */
export function computeItems(order, anchors, layouts, grids, opts = {}) {
  const flow = opts.flow || 'column';
  const items = [];
  let open = null;
  for (const pageIdx of order) {
    const L = layouts.get(pageIdx);
    const grid = grids.get(pageIdx);
    const chain = anchors.get(pageIdx) || [];
    if (!L || !grid) {
      open = null;
      continue;
    }
    const cols = L.columns?.length ? L.columns : [{ x0: 0, x1: 1 }];
    const top = L.bodyTop ?? 0;
    const bottom = L.bodyBottom ?? 1;
    for (let c = 0; c < cols.length; c++) {
      const col = cols[c];
      const x0 = Math.max(0, col.x0 - 0.006);
      const x1 = Math.min(1, col.x1 + 0.006);
      const inCol = chain.filter((a) => a.col === c).sort((a, b) => a.y0 - b.y0);
      const padOf = (a) => 0.45 * a.h + 0.004;
      // 단원 제목 등(번호처럼 생겼지만 문제 번호가 아닌 줄)에서 영역을 끊음
      const cuts = (opts.cutters?.get(pageIdx) || []).filter((k) => k.col === c).map((k) => k.y0 - padOf(k));
      const cutBetween = (ya, yb) => {
        let v = yb;
        for (const cy of cuts) if (cy > ya + 0.005 && cy < v) v = cy;
        return v;
      };

      // 단 위쪽: 이전 문항이 이어지는 부분
      if (open && flow === 'continue') {
        const segBottom = cutBetween(top, inCol.length ? inCol[0].y0 - padOf(inCol[0]) : bottom);
        if (segBottom - top > 0.01) {
          const r = trimRect(grid, { x: x0, y: top, w: x1 - x0, h: segBottom - top });
          if (r && r.h > 0.008) open.rects.push({ page: pageIdx, ...r });
        }
      }
      for (let k = 0; k < inCol.length; k++) {
        const a = inCol[k];
        const next = inCol[k + 1];
        const y0 = Math.max(0, a.y0 - padOf(a));
        const y1 = cutBetween(y0, next ? next.y0 - padOf(next) : bottom);
        const raw = { x: Math.min(x0, a.x0 - 0.004), y: y0, w: 0, h: Math.max(0.01, y1 - y0) };
        raw.w = x1 - raw.x;
        const r = trimRect(grid, raw) || raw;
        const item = {
          page: pageIdx,
          col: c,
          number: a.digits,
          num: a.num,
          rects: [{ page: pageIdx, ...r }],
          source: opts.source?.get(pageIdx) || 'text',
          conf: Math.round(a.conf ?? 100),
        };
        items.push(item);
        open = item;
        if (y1 < (next ? next.y0 - padOf(next) : bottom) - 1e-6) open = null; // 제목에서 끊겼으면 더 잇지 않음
      }
      if (!inCol.length && cuts.length) open = null;
      if (flow !== 'continue') open = null;
    }
  }
  return assignIds(items);
}

/** 같은 쪽·같은 번호가 여러 개면 #2, #3 을 붙여 고유 ID 생성 */
export function assignIds(items) {
  const seen = new Map();
  for (const it of items) {
    const base = `${it.page}:${it.number}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    it.id = n === 1 ? base : `${base}#${n}`;
  }
  return items;
}

/** 문항을 읽는 순서로 정렬(쪽 → 단 → 위치) */
export function sortItems(items) {
  return [...items].sort((a, b) => a.page - b.page || (a.col ?? 0) - (b.col ?? 0) || a.rects[0].y - b.rects[0].y);
}

/** rect 의 중심이 속한 단 번호 */
export function columnOf(layout, rect) {
  const cols = layout?.columns?.length ? layout.columns : [{ x0: 0, x1: 1 }];
  const cx = rect.x + Math.min(rect.w, 0.1) / 2;
  let best = 0;
  let bestD = Infinity;
  cols.forEach((c, i) => {
    const d = cx < c.x0 ? c.x0 - cx : cx > c.x1 ? cx - c.x1 : 0;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * 머리말/꼬리말의 쪽번호로 "PDF 쪽 ↔ 책 쪽" 차이를 추정합니다.
 * @param {{index:number, numbers:number[]}[]} footers
 * @returns {number|null} 책쪽 - (PDF쪽)  (PDF쪽은 1부터)
 */
export function guessPageOffset(footers) {
  const offsets = [];
  for (const f of footers) for (const n of f.numbers) offsets.push(n - (f.index + 1));
  if (offsets.length < 3) return null;
  const { value, count } = mode(offsets);
  const pagesWithNumbers = footers.filter((f) => f.numbers.length).length;
  if (count >= 3 && count >= pagesWithNumbers * 0.3) return value;
  return null;
}
