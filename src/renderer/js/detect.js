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
      // 글자 단위로 쪼개진 숫자는 합치되, 번호(굵은 글꼴 등) 바로 뒤에 다른 글꼴 글자가 붙어 있으면 따로 둠
      const numberThenOtherFont = last && /^[\[(]?\d{1,4}[.)\]]?$/.test(last.str) && t.font && last.font && t.font !== last.font && !/^[\d.)\]]/.test(t.str);
      if (last && !numberThenOtherFont && t.x0 - last.x1 < 0.12 * L.h && t.x0 >= last.x0) {
        last.str += t.str;
        last.x1 = Math.max(last.x1, t.x1);
        last.y0 = Math.min(last.y0, t.y0);
        last.y1 = Math.max(last.y1, t.y1);
        last.conf = Math.min(last.conf ?? 100, t.conf ?? 100);
      } else {
        words.push({ str: t.str, x0: t.x0, x1: t.x1, y0: t.y0, y1: t.y1, conf: t.conf ?? 100, font: t.font || '', h: t.y1 - t.y0 });
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

/** 번호 앞에 붙는 말머리 (같은 줄, 바로 뒤에 번호) */
export const PREFIXES = ['예제', '유제', '필수예제', '대표예제', '기본예제', '발전예제', '확인문제', '확인체크', '개념확인', '필수유형', '대표문제'];
const HANGUL = /[가-힣]/g;

/**
 * 한 페이지의 번호 후보 추출
 * @param {Token[]} tokens
 * @param {object} layout analyzeLayout 결과
 * @param {{ocr?:boolean}} [opts]
 * @returns {{candidates:object[], bodyH:number, lineCount:number, headings:{x0:number,x1:number,y0:number,y1:number}[]}}
 */
export function extractCandidates(tokens, layout, opts = {}) {
  const lines = buildLines(tokens);
  const bodyH = median(lines.map((l) => l.h)) || 0.012;
  const words = [];
  for (const L of lines) {
    for (const w of L.words) {
      w.lineH = L.h;
      words.push(w);
    }
  }

  // ---- 제목 줄 찾기: 글자(번호 제외)가 본문보다 확실히 큰 줄 조각 ----
  // (텍스트 PDF 에서만. 제목 안의 "01" 같은 숫자는 문제 번호 후보에서 뺌)
  const headings = [];
  const headingWords = new Set();
  if (!opts.ocr) {
    for (const L of lines) {
      // 줄을 큰 빈칸 기준으로 조각내기 (단이 여러 개면 같은 높이의 다른 단 글자와 분리)
      const segs = [];
      for (const w of L.words) {
        const last = segs[segs.length - 1];
        if (last && w.x0 - last.x1 < 2.5 * L.h) {
          last.words.push(w);
          last.x1 = Math.max(last.x1, w.x1);
        } else segs.push({ words: [w], x0: w.x0, x1: w.x1 });
      }
      for (const seg of segs) {
        const textWords = seg.words.filter((w) => !/^[\d.()[\]]+$/.test(w.str));
        const hangul = textWords.reduce((n, w) => n + (w.str.match(HANGUL)?.length || 0), 0);
        if (hangul < 2) continue;
        const hText = median(textWords.map((w) => w.h ?? w.y1 - w.y0));
        if (hText >= 1.2 * bodyH) {
          const y0 = Math.min(...seg.words.map((w) => w.y0));
          const y1 = Math.max(...seg.words.map((w) => w.y1));
          headings.push({ x0: seg.x0, x1: seg.x1, y0, y1 });
          seg.words.forEach((w) => headingWords.add(w));
        }
      }
    }
  }

  // 세로로 겹치는 단어를 빨리 찾기 위한 버킷
  const BUCKET = 0.01;
  const buckets = new Map();
  for (const w of words) {
    for (let b = Math.floor(w.y0 / BUCKET); b <= Math.floor(w.y1 / BUCKET); b++) {
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(w);
    }
  }
  const neighbours = (w) => {
    const out = [];
    const seen = new Set();
    for (let b = Math.floor(w.y0 / BUCKET); b <= Math.floor(w.y1 / BUCKET); b++) {
      for (const u of buckets.get(b) || []) {
        if (u === w || seen.has(u)) continue;
        seen.add(u);
        const ov = Math.min(u.y1, w.y1) - Math.max(u.y0, w.y0);
        if (ov > 0.35 * Math.min(w.y1 - w.y0, u.y1 - u.y0)) out.push(u);
      }
    }
    return out;
  };
  // 번호 왼쪽의 체크 칸(□), 별(★), 화살표 같은 기호는 "앞 글자"로 치지 않음
  // (수식 기호 =, +, − 등은 빼야 함 — 그 뒤 숫자는 줄 맨 앞이 아님)
  const SYMBOL_ONLY = /^[\u25A0-\u25FF\u2605\u2606\u2610-\u2612\u2713-\u2718\u27A4\u25B6\u25B7\u2022\u203B\u2766-\u2793]+$/u;
  // 같은 단 안의 왼쪽 글자만 봄 (단 사이가 아주 좁으면 옆 단 글자가 가까이 있을 수 있음)
  const sameCol = (u, w) => cols.length < 2 || colOf((u.x0 + u.x1) / 2) === colOf((w.x0 + w.x1) / 2);
  const hasLeftNeighbor = (w) => {
    const gap = Math.max(1.6 * (w.y1 - w.y0), 0.012);
    return neighbours(w).some((u) => u.x0 < w.x0 && u.x1 >= w.x0 - gap && !SYMBOL_ONLY.test(u.str) && sameCol(u, w));
  };
  // 번호 바로 앞의 체크 칸·별 같은 기호가 있으면 그 기호 위치를 줄 시작으로 봄
  const lineStartX = (w) => {
    let x = w.x0;
    const gap = Math.max(1.6 * (w.y1 - w.y0), 0.012);
    for (const u of neighbours(w)) if (u.x0 < x && u.x1 >= w.x0 - gap && SYMBOL_ONLY.test(u.str) && sameCol(u, w)) x = u.x0;
    return x;
  };
  // 같은 줄 오른쪽 바로 다음 단어
  const nextWord = (w) => {
    let best = null;
    for (const u of neighbours(w)) {
      if (u.x0 <= w.x0) continue;
      if (u.x0 - w.x1 > 1.2 * (w.y1 - w.y0)) continue;
      if (!best || u.x0 < best.x0) best = u;
    }
    return best;
  };

  const cols = layout?.columns?.length ? layout.columns : [{ x0: 0, x1: 1 }];
  const bodyTop = layout?.bodyTop ?? 0;
  const bodyBottom = layout?.bodyBottom ?? 1;
  const colOf = (cx) => {
    let col = 0;
    let bestD = Infinity;
    cols.forEach((c, i) => {
      const d = cx < c.x0 ? c.x0 - cx : cx > c.x1 ? cx - c.x1 : 0;
      if (d < bestD) {
        bestD = d;
        col = i;
      }
    });
    return col;
  };

  // ---- 공통 지문 머리 "[0100~0120]", "[100~102] 다음 글을 읽고…" ----
  const ranges = [];
  const RANGE_RE = /^[[(【〔]?\s*(\d{1,4})\s*[~∼～〜\-–—]\s*(\d{1,4})\s*[\])】〕]?/;
  for (const L of lines) {
    for (let k = 0; k < L.words.length; k++) {
      const w = L.words[k];
      if (!/^[[(【〔]?\d/.test(w.str)) continue;
      // 첫 몇 단어를 이어 붙여 검사 ("[0100", "~", "0120]" 처럼 쪼개진 경우)
      let text = '';
      let last = w;
      for (let j = k; j < Math.min(L.words.length, k + 4); j++) {
        if (j > k && L.words[j].x0 - last.x1 > 1.2 * L.h) break;
        text += L.words[j].str;
        last = L.words[j];
        const m = RANGE_RE.exec(text);
        if (m && +m[2] > +m[1] && +m[2] - +m[1] <= 40) {
          if (!hasLeftNeighbor(w)) {
            const cy = (w.y0 + w.y1) / 2;
            if (!(layout?.hasHeader && cy < bodyTop) && !(layout?.hasFooter && cy > bodyBottom)) {
              ranges.push({ a: +m[1], b: +m[2], x0: w.x0, x1: last.x1, y0: Math.min(w.y0, last.y0), y1: Math.max(w.y1, last.y1), col: colOf((w.x0 + w.x1) / 2) });
            }
          }
          break;
        }
      }
    }
  }
  const inRangeHeader = (w) => ranges.some((r) => w.y0 < r.y1 && w.y1 > r.y0 && w.x0 >= r.x0 - 0.001 && w.x1 <= r.x1 + 0.001);

  const candidates = [];
  for (const w of words) {
    if (headingWords.has(w) || inRangeHeader(w)) continue;
    let str = opts.ocr ? normalizeOcrWord(w.str) : w.str;
    let prefix = '';
    let numWord = w;
    // "유제 3", "예제3" 처럼 말머리가 붙은 번호
    const glued = /^([가-힣]{2,4})(\d{1,3})([.)]?)$/.exec(str);
    if (glued && PREFIXES.includes(glued[1])) {
      prefix = glued[1];
      str = glued[2] + glued[3];
    } else if (PREFIXES.includes(str)) {
      const nw = nextWord(w);
      if (!nw) continue;
      prefix = str;
      numWord = nw;
      str = opts.ocr ? normalizeOcrWord(nw.str) : nw.str;
    }
    const parsed = parseNumberWord(str);
    if (!parsed) continue;
    const cy = (w.y0 + w.y1) / 2;
    // 머리말/꼬리말(쪽번호) 제외
    if (layout?.hasHeader && cy < bodyTop) continue;
    if (layout?.hasFooter && cy > bodyBottom) continue;
    if (hasLeftNeighbor(w)) continue;
    const col = colOf((w.x0 + w.x1) / 2);
    candidates.push({
      ...parsed,
      prefix,
      x0: w.x0,
      x1: Math.max(w.x1, numWord.x1),
      y0: Math.min(w.y0, numWord.y0),
      y1: Math.max(w.y1, numWord.y1),
      h: numWord.y1 - numWord.y0,
      col,
      relX: lineStartX(w) - cols[col].x0,
      hRatio: (numWord.y1 - numWord.y0) / bodyH,
      conf: Math.min(w.conf ?? 100, numWord.conf ?? 100),
      padded: parsed.digits.length >= 2 && parsed.digits[0] === '0',
      font: numWord.font || '',
      ocr: !!opts.ocr,
    });
  }
  candidates.sort((a, b) => a.col - b.col || a.y0 - b.y0);
  return { candidates, bodyH, lineCount: lines.length, headings, ranges };
}

/**
 * 빠른 정답표 같은 쪽인지: 한 단 안에서 같은 높이에 번호가 여러 개 나란히 있는 경우가 많음
 */
export function looksLikeAnswerTable(candidates) {
  if (candidates.length >= 20) {
    let sideBySide = 0;
    for (const c of candidates) {
      if (candidates.some((d) => d !== c && d.col === c.col && Math.abs(d.y0 - c.y0) < 0.4 * c.h && Math.abs(d.x0 - c.x0) > 3 * c.h)) sideBySide++;
    }
    if (sideBySide >= candidates.length * 0.4) return true;
  }
  // 표를 단 단위로 읽으면 번호가 일정한 간격(예: +6)으로 건너뜀 (스캔본처럼 칸 일부만 읽힌 경우)
  const diffs = [];
  const byCol = new Map();
  for (const c of candidates) {
    if (c.prefix) continue;
    if (!byCol.has(c.col)) byCol.set(c.col, []);
    byCol.get(c.col).push(c);
  }
  for (const list of byCol.values()) {
    list.sort((a, b) => a.y0 - b.y0);
    for (let i = 1; i < list.length; i++) diffs.push(list[i].num - list[i - 1].num);
  }
  if (diffs.length < 4) return false;
  const { value, count } = mode(diffs);
  return value >= 3 && count >= diffs.length * 0.7;
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
  if (b.num === 1) return a.num >= 3 ? -0.4 : a.num === 2 ? -1.5 : -6;
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
  // 0 채움(0001, 01)은 아주 뚜렷한 특징이라 다르면 크게 감점
  s += c.padded === sig.padded ? 0.4 : -3.5;
  if (sig.padded && sig.digitsLen && c.digits.length !== sig.digitsLen) s -= 2.5;
  if ((c.prefix || '') !== (sig.prefix || '')) s -= 3;
  if (sig.hRatio > 0) {
    const r = c.hRatio / sig.hRatio;
    if (c.ocr) {
      if (r > 0.85 && r < 1.2) s += 0.3;
      else if (r < 0.65 || r > 1.6) s -= 0.8;
    } else if (Math.abs(r - 1) <= 0.06) s += 0.6;
    else if (Math.abs(r - 1) > 0.12) s -= 1.2;
  }
  // 글꼴(굵은 번호 전용 글꼴 등)이 같으면 가점, 다르면 감점
  if (sig.font && c.font) s += c.font === sig.font ? 0.8 : -2;
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

function learnSignature(chosen) {
  if (chosen.length < 3) return null;
  const fonts = chosen.map((c) => c.font).filter(Boolean);
  const fm = mode(fonts);
  return {
    relX: median(chosen.map((c) => c.relX)),
    style: mode(chosen.map((c) => c.style)).value,
    padded: mode(chosen.map((c) => c.padded)).value,
    hRatio: median(chosen.map((c) => c.hRatio)),
    digitsLen: mode(chosen.filter((c) => c.padded).map((c) => c.digits.length)).value || 0,
    prefix: mode(chosen.map((c) => c.prefix || '')).value || '',
    font: fonts.length >= chosen.length * 0.6 && fm.count >= fonts.length * 0.6 ? fm.value : '',
  };
}

/** 번호 모양 묶음 열쇠 (말머리 / 점·괄호 / 0 채움 자릿수 / 글꼴) */
function groupKey(c) {
  if (c.style === 'paren' && !c.prefix) return null; // (1), (2) 는 소문항 표시일 때가 많음
  const st = c.ocr && (c.style === 'dot' || c.style === 'plain') ? 'pd' : c.style;
  return `${c.prefix ? `pre:${c.prefix}` : st}|${c.padded ? c.digits.length : 0}|${c.font || ''}`;
}
const sigKey = (sig) => sig.key;

function runSelection(pages, opts, signatureIn) {
  // 1단계: 페이지별(스타일 정보 없이) 선택 → 대표 스타일 추정
  let signature = signatureIn || null;
  if (!signature) {
    const firstPass = [];
    let prev = opts.prevLast ?? null;
    for (const p of pages) {
      const chain = chooseChain(p.candidates, prev, (i) => priorLocal(p.candidates, i));
      if (chain.length) prev = chain[chain.length - 1].num;
      firstPass.push(...chain);
    }
    signature = learnSignature(firstPass);
  }
  // 2단계: 대표 스타일과의 유사도를 반영해 다시 선택
  const anchors = new Map();
  let prev = opts.prevLast ?? null;
  for (const p of pages) {
    const priorFn = signature ? (i) => priorWithStyle(p.candidates, i, signature) : (i) => priorLocal(p.candidates, i);
    const chain = chooseChain(p.candidates, prev, priorFn);
    if (chain.length) prev = chain[chain.length - 1].num;
    anchors.set(p.index, chain);
  }
  return { anchors, signature };
}

/** 번호 사슬이 얼마나 "1씩 늘어나는 번호"다운지 */
function sequenceScore(seq) {
  let good = 0;
  let bad = 0;
  let resets = 0;
  for (let i = 1; i < seq.length; i++) {
    const d = seq[i].num - seq[i - 1].num;
    if (d === 1) good++;
    else if (seq[i].num === 1) resets++;
    else bad++;
  }
  const maxNum = seq.length ? Math.max(...seq.map((c) => c.num)) : 0;
  return { good, bad, resets, maxNum, score: good - 1.5 * bad - 0.8 * resets + 0.05 * seq.length };
}

/** 두 번째 번호 체계(예: 유제 1,2… 와 Level 01,02…)가 믿을 만한지 */
function groupQuality(q, count, sig, mainSig, prefixed) {
  if (count < (prefixed ? 2 : 4)) return false;
  if (q.maxNum < 3 && !prefixed) return false;
  if (q.good < (prefixed ? 1 : 2) || q.bad > 0.3 * (q.good + q.bad)) return false;
  if (q.resets > q.good) return false;
  if (!prefixed && mainSig && Math.abs(sig.relX - mainSig.relX) > 0.02) return false;
  return true;
}

function mergeAnchors(anchors, extraByPage) {
  for (const [idx, extra] of extraByPage) {
    if (!extra.length) continue;
    const merged = [...(anchors.get(idx) || [])];
    for (const c of extra) {
      // 이미 고른 번호와 거의 같은 자리면 건너뜀
      if (merged.some((a) => a.col === c.col && Math.abs(a.y0 - c.y0) < 0.6 * Math.max(a.h, c.h))) continue;
      merged.push(c);
    }
    merged.sort((a, b) => a.col - b.col || a.y0 - b.y0);
    anchors.set(idx, merged);
  }
}

/**
 * 문서 전체 번호 선택.
 *  - 번호 후보를 모양(말머리·자릿수·글꼴)별로 묶고, 묶음마다 연속 번호 사슬을 고른 뒤
 *  - 가장 "1씩 늘어나는" 묶음을 대표 번호 체계로, 믿을 만한 다른 묶음(유제/Level 등)도 함께 씀
 * @param {{index:number, candidates:object[]}[]} pages  분석한 페이지(쪽 순서)
 * @param {{numberStyle?:string, signature?:object, signatures?:object[], prevLast?:number}} [opts]
 *   numberStyle: auto|dot|plain|pad|bracket, signatures: 이전에 학습한 번호 체계들(다시 인식할 때)
 * @returns {{anchors: Map<number, object[]>, signature: object|null, signatures: object[]}}
 */
export function selectAnchors(pages, opts = {}) {
  const forced = opts.numberStyle && opts.numberStyle !== 'auto' ? opts.numberStyle : null;
  if (forced) {
    const styleOk = (c) => {
      if (forced === 'dot') return c.style === 'dot';
      if (forced === 'plain') return c.style === 'plain' && !c.padded;
      if (forced === 'pad') return c.padded;
      if (forced === 'bracket') return c.style === 'bracket' || c.style === 'paren';
      return true;
    };
    const filtered = pages.map((p) => ({ ...p, candidates: p.candidates.filter(styleOk) }));
    const res = runSelection(filtered, opts, opts.signatures?.[0] || opts.signature || null);
    return { anchors: res.anchors, signature: res.signature, signatures: res.signature ? [res.signature] : [] };
  }

  // 후보를 모양별로 묶기
  const groups = new Map();
  for (const p of pages) {
    for (const c of p.candidates) {
      const k = groupKey(c);
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, new Map());
      const g = groups.get(k);
      if (!g.has(p.index)) g.set(p.index, []);
      g.get(p.index).push(c);
    }
  }
  const pagesOf = (byPage) => pages.map((p) => ({ index: p.index, candidates: byPage.get(p.index) || [] }));

  // 이미 학습한 번호 체계가 있으면(한 쪽 다시 인식) 그대로 사용
  const known = opts.signatures || (opts.signature ? [opts.signature] : null);
  if (known?.length && known.every((sg) => sg.key)) {
    const anchors = new Map(pages.map((p) => [p.index, []]));
    known.forEach((sg, i) => {
      const byPage = groups.get(sg.key);
      if (!byPage) return;
      const res = runSelection(pagesOf(byPage), { prevLast: i === 0 ? opts.prevLast : null }, sg);
      mergeAnchors(anchors, res.anchors);
    });
    return { anchors, signature: known[0], signatures: known };
  }

  // 묶음마다 사슬 고르기 + 점수
  const results = [];
  for (const [key, byPage] of groups) {
    const gp = pagesOf(byPage);
    const total = gp.reduce((n, p) => n + p.candidates.length, 0);
    if (total < 2) continue;
    const res = runSelection(gp, { prevLast: null }, null);
    if (!res.signature) continue;
    res.signature.key = key;
    const seq = gp.flatMap((p) => res.anchors.get(p.index) || []);
    results.push({ key, res, seq, q: sequenceScore(seq), prefixed: key.startsWith('pre:') });
  }
  if (!results.length) {
    // 묶음이 너무 작으면 예전 방식(전체 후보 한꺼번에)
    const res = runSelection(pages, opts, null);
    if (res.signature) res.signature.key = '';
    return { anchors: res.anchors, signature: res.signature, signatures: res.signature ? [res.signature] : [] };
  }
  results.sort((a, b) => b.q.score - a.q.score);
  const main = results[0];
  // 대표 체계는 이어지는 앞 쪽 번호(prevLast)를 반영해 다시 선택
  const mainRes = opts.prevLast != null ? runSelection(pagesOf(groups.get(main.key)), opts, main.res.signature) : main.res;
  const anchors = new Map(pages.map((p) => [p.index, [...(mainRes.anchors.get(p.index) || [])]]));
  const signatures = [main.res.signature];
  for (const r of results.slice(1)) {
    if (!groupQuality(r.q, r.seq.length, r.res.signature, main.res.signature, r.prefixed)) continue;
    signatures.push(r.res.signature);
    mergeAnchors(anchors, r.res.anchors);
  }
  return { anchors, signature: main.res.signature, signatures };
}

const schemeKey = (c) => `${c.prefix || ''}|${c.padded ? c.digits.length : 0}`;

/**
 * 번호가 건너뛴 곳(예: 5 → 7)을 "버려진 후보"에서 찾아 채웁니다.
 * 글꼴·크기가 조금 달라 대표 모양에서 떨어진 진짜 번호를 되살리는 단계.
 * 채운 번호에는 filled=true 를 붙여 "확인 필요"로 알려 줍니다.
 * @returns {number} 채운 개수
 */
export function fillGapsFromCandidates(pages, anchors, signatures = []) {
  const sigByScheme = new Map();
  for (const sg of signatures) {
    const k = `${sg.prefix || ''}|${sg.padded ? sg.digitsLen : 0}`;
    if (!sigByScheme.has(k)) sigByScheme.set(k, sg);
  }
  const order = (c) => c.col * 10 + c.y0;
  const lastByKey = new Map();
  let filled = 0;
  for (let pi = 0; pi < pages.length; pi++) {
    const p = pages[pi];
    const chain = anchors.get(p.index) || [];
    const chosen = new Set(chain);
    const pool = p.candidates.filter((c) => !chosen.has(c));
    const add = [];
    const byKey = new Map();
    for (const c of chain) {
      if (!byKey.has(schemeKey(c))) byKey.set(schemeKey(c), []);
      byKey.get(schemeKey(c)).push(c);
    }
    // 이 쪽에 번호가 하나도 없으면, 앞 쪽 마지막 번호 다음부터 이어지는 후보를 찾아 봄
    if (!chain.length && sigByScheme.size) {
      const mainKey = [...sigByScheme.keys()][0];
      const last = lastByKey.get(mainKey);
      if (last != null) byKey.set(mainKey, []);
    }
    for (const [key, seq] of byKey) {
      const sig = sigByScheme.get(key) || signatures[0];
      const okShape = (c) =>
        schemeKey(c) === key && (!sig || Math.abs(c.relX - sig.relX) <= 0.045) && (!sig?.hRatio || (c.hRatio / sig.hRatio > 0.6 && c.hRatio / sig.hRatio < 1.7));
      const points = [{ num: lastByKey.get(key) ?? null, pos: -Infinity }, ...seq.map((c) => ({ num: c.num, pos: order(c) })), { num: null, pos: Infinity }];
      for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        if (a.num == null) continue;
        const hi = b.num != null ? b.num : a.num + 12;
        if (hi - a.num < 2 && b.num != null) continue;
        let want = a.num + 1;
        const between = pool
          .filter((c) => okShape(c) && order(c) > a.pos && order(c) < b.pos && c.num > a.num && c.num < (b.num ?? hi + 1))
          .sort((x, y) => order(x) - order(y));
        for (const c of between) {
          if (c.num === want || (c.num > want && c.num - want <= 1)) {
            c.filled = true;
            add.push(c);
            want = c.num + 1;
          }
        }
      }
      const all = [...seq, ...add.filter((c) => schemeKey(c) === key)];
      if (all.length) lastByKey.set(key, Math.max(...all.map((c) => c.num)));
    }
    if (add.length) {
      filled += add.length;
      anchors.set(p.index, [...chain, ...add].sort((x, y) => x.col - y.col || x.y0 - y.y0));
    }
  }
  return filled;
}

/**
 * "꼼꼼히 다시 찾기": 모양은 따지지 않고, 앞·뒤 쪽 번호 사이(prevLast < n < nextFirst)에 들어가는
 * 번호를 읽는 순서대로 가장 길게 이어지게 고릅니다.
 */
export function chooseExpectedChain(cands, prevLast, nextFirst) {
  const lo = prevLast ?? 0;
  const hi = nextFirst ?? lo + 40;
  const list = cands.filter((c) => c.num > lo && c.num < hi).sort((a, b) => a.col - b.col || a.y0 - b.y0);
  // 최장 증가 부분수열 (번호가 1씩 늘어날수록, 줄 맨 앞에 가까울수록 가점)
  const n = list.length;
  const best = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let j = 0; j < n; j++) {
    best[j] = 1 + (list[j].num === lo + 1 ? 0.5 : 0) - Math.min(0.5, list[j].relX * 5);
    for (let i = 0; i < j; i++) {
      if (list[i].num >= list[j].num) continue;
      if (list[i].col === list[j].col && list[j].y0 - list[i].y0 < 0.6 * Math.max(list[i].h, list[j].h)) continue;
      const v = best[i] + 1 + (list[j].num - list[i].num === 1 ? 0.6 : 0) - Math.min(0.5, list[j].relX * 5);
      if (v > best[j]) {
        best[j] = v;
        back[j] = i;
      }
    }
  }
  let end = -1;
  for (let j = 0; j < n; j++) if (end < 0 || best[j] > best[end]) end = j;
  const chain = [];
  for (let k = end; k >= 0; k = back[k]) chain.push(list[k]);
  return chain.reverse();
}

/**
 * 페이지별 "확인 필요" 표시
 * @param {number[]} order 분석한 페이지 번호(순서대로)
 * @param {Map<number, object[]>} anchors
 * @param {Map<number, object>} layouts
 */
export function flagPages(order, anchors, layouts) {
  const flags = new Map();
  const lastByKey = new Map(); // 번호 체계별 마지막 번호
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
      // 번호 체계별로 연속성 확인 (유제 1,2 와 Level 01,02 처럼 섞여 있을 수 있음)
      const byKey = new Map();
      for (const c of chain) {
        const key = `${c.prefix || ''}|${c.padded ? c.digits.length : 0}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(c);
      }
      for (const [key, seq] of byKey) {
        const prev = lastByKey.get(key);
        if (prev != null && seq[0].num !== prev + 1 && seq[0].num !== 1 && !reasons.length) reasons.push('앞 쪽과 번호가 이어지지 않음');
        for (let i = 1; i < seq.length; i++) {
          const d = seq[i].num - seq[i - 1].num;
          if (d !== 1 && seq[i].num !== 1) {
            if (!reasons.includes('중간에 빠진 번호가 있음')) reasons.push('중간에 빠진 번호가 있음');
            break;
          }
        }
        lastByKey.set(key, seq[seq.length - 1].num);
      }
      if (chain.some((c) => c.conf < 65)) reasons.push('인식 신뢰도 낮음');
      if (chain.some((c) => c.filled)) reasons.push('빠진 번호를 추정해서 채움');
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
        !c.ocr && // OCR 글자 크기는 믿기 어려움
        Math.abs(c.relX - signature.relX) < 0.03 &&
        c.hRatio > signature.hRatio * 1.15,
    );
    if (list.length) map.set(p.index, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 영역 계산
// ---------------------------------------------------------------------------

/**
 * 여러 단 쪽에서 전체 폭 가로 띠(단원 제목 막대 등)로 나뉜 "구역".
 * 읽는 순서는 구역 → 단 → 위→아래 입니다. (띠 위쪽 단들을 다 읽고 띠 아래로)
 */
export function zonesOf(L) {
  const top = L?.bodyTop ?? 0;
  const bottom = L?.bodyBottom ?? 1;
  const cols = L?.columns?.length ? L.columns : [{ x0: 0, x1: 1 }];
  if (cols.length < 2 || !L.spans?.length) return [{ y0: top, y1: bottom, afterBand: false }];
  const zones = [];
  let y = top;
  let afterBand = false;
  for (const b of [...L.spans].sort((a, c) => a.y0 - c.y0)) {
    if (b.y0 - y > 0.01) zones.push({ y0: y, y1: b.y0, afterBand });
    y = Math.max(y, b.y1);
    afterBand = true;
  }
  if (bottom - y > 0.01) zones.push({ y0: y, y1: bottom, afterBand });
  return zones.length ? zones : [{ y0: top, y1: bottom, afterBand: false }];
}

export function zoneOf(L, y) {
  const zones = zonesOf(L);
  for (let i = zones.length - 1; i >= 0; i--) if (y >= zones[i].y0 - 0.01) return i;
  return 0;
}

/**
 * 번호 위치로 문항 영역을 계산합니다.
 * @param {number[]} order  분석한 페이지(순서대로)
 * @param {Map<number, object[]>} anchors
 * @param {Map<number, object>} layouts  페이지별 analyzeLayout 결과
 * @param {Map<number, object>} grids    페이지별 잉크 격자
 * @param {{flow?:'column'|'continue', source?:Map<number,string>, cutters?:Map, stopPages?:Set<number>}} opts
 *    flow = 'continue' 이면 문항(해설)이 다음 단/페이지로 이어질 수 있음
 */
export function computeItems(order, anchors, layouts, grids, opts = {}) {
  const flow = opts.flow || 'column';
  const items = [];
  const stems = [];
  let open = null;
  const padOf = (a) => 0.45 * a.h + 0.004;
  for (const pageIdx of order) {
    const L = layouts.get(pageIdx);
    const grid = grids.get(pageIdx);
    const chain = anchors.get(pageIdx) || [];
    if (!L || !grid || opts.stopPages?.has(pageIdx)) {
      open = null;
      continue;
    }
    const cols = L.columns?.length ? L.columns : [{ x0: 0, x1: 1 }];
    const zones = zonesOf(L);
    zones.forEach((zone, z) => {
      if (zone.afterBand) open = null; // 단원 제목 띠 다음은 새 단원
      const top = zone.y0;
      const bottom = zone.y1;
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        const x0 = Math.max(0, col.x0 - 0.006);
        const x1 = Math.min(1, col.x1 + 0.006);
        const inCol = chain
          .filter((a) => a.col === c && a.y0 >= top - 0.01 && (a.y0 < bottom || z === zones.length - 1))
          .sort((a, b) => a.y0 - b.y0);
        // 공통 지문 머리 ([0100~0120]) — 그 아래 첫 문항 전까지가 공통 지문
        const rangesHere = (opts.ranges?.get(pageIdx) || []).filter((r) => r.col === c && r.y0 >= top - 0.01 && r.y0 < bottom);
        // 단원·유형 제목 등에서 영역을 끊음 (이 단과 가로로 겹치는 것만)
        const cuts = (opts.cutters?.get(pageIdx) || [])
          .filter((k) => k.x1 > col.x0 + 0.005 && k.x0 < col.x1 - 0.005)
          .map((k) => k.y0)
          .filter((cy) => cy > top && cy < bottom && !inCol.some((a) => Math.abs(cy - a.y0) < a.h * 1.2));
        const cutBetween = (ya, yb) => {
          let v = yb;
          for (const cy of cuts) if (cy > ya + 0.005 && cy < v) v = cy;
          return v;
        };

        // 단 위쪽: 이전 문항이 이어지는 부분
        if (open && flow === 'continue') {
          const nominal = inCol.length ? inCol[0].y0 - padOf(inCol[0]) : bottom;
          const segBottom = cutBetween(top, nominal);
          if (segBottom - top > 0.01) {
            const r = trimRect(grid, { x: x0, y: top, w: x1 - x0, h: segBottom - top });
            if (r && r.h > 0.008) open.rects.push({ page: pageIdx, ...r });
          }
          if (segBottom < nominal - 1e-6) open = null; // 제목에서 끊김
        }
        for (const rg of rangesHere) {
          const nextA = inCol.find((a) => a.y0 > rg.y1);
          const y0 = rg.y0 - 0.006;
          const y1 = nextA ? nextA.y0 - padOf(nextA) : bottom;
          const r = trimRect(grid, { x: x0, y: y0, w: x1 - x0, h: Math.max(0.01, y1 - y0) });
          if (r) stems.push({ a: rg.a, b: rg.b, y: rg.y0, page: pageIdx, z, c, rect: { page: pageIdx, ...r } });
        }
        for (let k = 0; k < inCol.length; k++) {
          const a = inCol[k];
          const next = inCol[k + 1];
          const y0 = Math.max(top - 0.01, a.y0 - padOf(a));
          const nominal = next ? next.y0 - padOf(next) : bottom;
          const y1 = cutBetween(y0, nominal);
          const raw = { x: Math.min(x0, a.x0 - 0.004), y: y0, w: 0, h: Math.max(0.01, y1 - y0) };
          raw.w = x1 - raw.x;
          const r = trimRect(grid, raw) || raw;
          const item = {
            page: pageIdx,
            zone: z,
            col: c,
            number: a.digits,
            num: a.num,
            prefix: a.prefix || '',
            rects: [{ page: pageIdx, ...r }],
            source: opts.source?.get(pageIdx) || 'text',
            conf: Math.round(a.conf ?? 100),
          };
          items.push(item);
          open = item;
          if (y1 < nominal - 1e-6) open = null; // 제목에서 끊겼으면 더 잇지 않음
        }
        if (flow !== 'continue') open = null;
      }
    });
  }
  attachStems(items, stems);
  return assignIds(items);
}

/** 공통 지문을 범위 안 번호의 문항들에 붙임 (지문 뒤에 나오는 문항부터, 다음 지문 전까지) */
function attachStems(items, stems) {
  if (!stems.length) return;
  const key = (page, z, c, y) => page * 1e6 + z * 1e4 + c * 100 + y;
  const sortedStems = stems.sort((a, b) => key(a.page, a.z, a.c, a.y) - key(b.page, b.z, b.c, b.y));
  for (const it of items) {
    if (it.prefix) continue;
    const k = key(it.page, it.zone ?? 0, it.col ?? 0, it.rects[0].y);
    let st = null;
    for (const s of sortedStems) if (key(s.page, s.z, s.c, s.y) < k && it.num >= s.a && it.num <= s.b) st = s;
    if (st) {
      it.stem = [st.rect];
      it.stemLabel = `${st.a}~${st.b}`;
    }
  }
}

/** 같은 쪽·같은 번호가 여러 개면 #2, #3 을 붙여 고유 ID 생성 */
export function assignIds(items) {
  const seen = new Map();
  for (const it of items) {
    const base = `${it.page}:${it.prefix || ''}${it.number}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    it.id = n === 1 ? base : `${base}#${n}`;
  }
  return items;
}

/** 문항을 읽는 순서로 정렬(쪽 → 구역 → 단 → 위치) */
export function sortItems(items) {
  return [...items].sort(
    (a, b) => a.page - b.page || (a.zone ?? 0) - (b.zone ?? 0) || (a.col ?? 0) - (b.col ?? 0) || a.rects[0].y - b.rects[0].y,
  );
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
