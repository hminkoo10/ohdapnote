// 문제 번호 인식 + 문항 영역 계산 (순수 함수, Node 에서 테스트 가능)
//
// 흐름
//  1) 토큰(단어 + 위치) → 줄/단어 묶기 → "줄 맨 앞의 숫자"를 번호 후보로 추출
//  2) 책 전체에서 번호 모양(위치·점 유무·0 채움·크기)의 "대표 스타일"을 학습
//  3) 페이지마다 번호가 1씩 증가하는 가장 그럴듯한 사슬을 동적계획법으로 선택
//  4) 번호 위치와 단 정보로 문항 영역(사각형들)을 계산

import { trimRect, cutAbove } from './layout.js';

/** @typedef {{str:string,x0:number,y0:number,x1:number,y1:number,conf?:number}} Token */

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const hOf = (c) => c.h ?? c.y1 - c.y0;

/** 같은 단·같은 줄에 나란히 있는지 (한 줄에 문항이 둘 이상인 편집: "0001 …   0002 …") */
export function sameRow(a, b) {
  // 위쪽 끝이 아니라 세로로 겹치는 정도로 봄 (OCR 이 옆 분수까지 묶어 상자가 커진 번호도 같은 줄로)
  const overlap = Math.min(a.y0 + hOf(a), b.y0 + hOf(b)) - Math.max(a.y0, b.y0);
  return a.col === b.col && overlap > 0.5 * Math.min(hOf(a), hOf(b));
}

/** b 가 a 와 같은 줄, 오른쪽에 충분히 떨어져 있는지 (나란히 놓인 다음 문항) */
function besideRight(a, b) {
  return sameRow(a, b) && b.x0 - (a.x1 ?? a.x0) > 2 * Math.max(hOf(a), hOf(b));
}

/** 읽는 순서: 단 → 위에서 아래 (같은 줄이면 왼쪽에서 오른쪽) */
export function byReadingOrder(a, b) {
  return a.col - b.col || (sameRow(a, b) ? a.x0 - b.x0 : a.y0 - b.y0);
}

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
/** 수식 줄의 시작(숫자 뒤 연산·비교 기호). 빼기(−)는 문제 첫머리의 음수일 수 있어서 넣지 않음 */
const OPERATOR_START = /^[=+×÷<>≤≥≠±∓·]/;
/** 숫자 뒤에 띄어 쓴 조사·어미 — 문제 첫머리로는 오지 않음 (앞 줄에서 넘어온 수식·문장의 끝) */
const PARTICLES = new Set(['이므로', '이고', '이다', '이며', '이면', '이라', '이라고', '이라면', '에서', '에서의', '일', '을', '를', '은', '는', '의', '와', '과', '로', '으로', '에', '이상', '이하', '미만', '초과', '만큼', '보다', '이므', '임을', '인', '이지만', '이어야', '이어서']);

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
        // "예제 1  함수의 극한" 처럼 말머리로 시작하는 줄은 (글씨가 커도) 제목이 아니라 문항 머리
        const first = seg.words[0].str;
        if (PREFIXES.some((p) => first === p || (first.startsWith(p) && /^\d/.test(first.slice(p.length))))) continue;
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
          // 공통 지문 머리는 괄호로 싸여 있거나 단 왼쪽 끝에서 시작함
          // (선택지 "④ ∛−27" 을 OCR 이 "3−27" 로 읽은 것 같은 줄 가운데 수식은 아님)
          const bracketed = /^[[(【〔]/.test(m[0]) || /[\])】〕]$/.test(m[0]);
          const atLineStart = w.x0 - cols[colOf((w.x0 + w.x1) / 2)].x0 < 0.06;
          if ((bracketed || atLineStart) && !hasLeftNeighbor(w)) {
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
  const make = (parsed, prefix, w, numWord) => {
    const col = colOf((w.x0 + w.x1) / 2);
    return {
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
    };
  };
  const inBody = (w) => {
    const cy = (w.y0 + w.y1) / 2;
    return !(layout?.hasHeader && cy < bodyTop) && !(layout?.hasFooter && cy > bodyBottom);
  };
  // "유형 01" 머리 (만렙 PM 등). 답지에서는 해설 머리("유형 02 답 65/4")라 문항이고,
  // 문제집에서는 제목("유형 01 구분구적법")이라 그 뒤 "대표 문제" 가 이 번호의 문항.
  // (쎈처럼 유형 제목 아래 문제마다 번호가 붙은 책은 "대표 문제" 가 없어서 해당 없음)
  // 한 줄에 여럿 있는 것("유형01 ④ 유형02 65/4 …" 빠른 정답표)은 뺌
  const str0 = (w) => (opts.ocr ? normalizeOcrWord(w.str) : w.str);
  // 바로 오른쪽 글자 (작은 "유형" 옆의 큰 "01" 처럼 기준선이 달라 다른 줄로 묶인 것까지)
  const rightOf = (w) => nextWord(w) || words.filter((u) => u.x0 >= w.x1 - 0.002 && u.x0 - w.x1 < 2 * (w.y1 - w.y0) && u.y0 < w.y1 && u.y1 > w.y0).sort((a, b) => a.x0 - b.x0)[0];
  const typeHeads = [];
  for (const w of words) {
    let digits = /^유형(\d{1,2})$/.exec(str0(w))?.[1];
    let numWord = w;
    if (!digits && str0(w) === '유형') {
      numWord = rightOf(w);
      digits = numWord && /^\d{1,2}$/.test(str0(numWord)) ? str0(numWord) : null;
    }
    if (!digits || !inBody(w)) continue;
    const after = rightOf(numWord);
    // titled: 제목("유형 01 구분구적법"), answered: 해설 머리("유형 01 답 ④"). 둘 다 아니면 해설 속 참고 표시("유형03")
    const next = after ? str0(after) : '';
    typeHeads.push({ w, numWord, digits, col: colOf((w.x0 + w.x1) / 2), titled: /^[가-힣]/.test(next) && next !== '답', answered: next === '답' });
  }
  // "유형 10" 은 "유형 01" 과 같은 두 자리 체계
  const typeCand = (digits, w, numWord) => ({ ...make(parseNumberWord(digits), '유형', w, numWord), fixedWidth: digits.length === 2 });
  const oneLine = (a, b) => a !== b && a.col === b.col && Math.abs(a.w.y0 - b.w.y0) < 0.5 * (a.w.y1 - a.w.y0);
  // 정답표 줄(한 줄에 여럿) 바로 아래·위의 줄은 혼자 있어도 정답표 ("유형15 ⑤" 만 남은 마지막 줄)
  const tableRows = typeHeads.filter((t) => typeHeads.some((u) => oneLine(t, u)));
  const inTable = (t) => tableRows.some((u) => u.col === t.col && Math.abs(u.w.y0 - t.w.y0) < 2.5 * (t.w.y1 - t.w.y0));
  for (const t of typeHeads) {
    if (!t.answered || hasLeftNeighbor(t.w) || inTable(t)) continue;
    candidates.push(typeCand(t.digits, t.w, t.numWord));
  }
  for (const w of words) {
    const s = str0(w);
    const label = s === '대표문제' || s === '대표 문제' ? w : s === '대표' && nextWord(w) && str0(nextWord(w)) === '문제' ? nextWord(w) : null;
    if (!label || !inBody(w) || hasLeftNeighbor(w)) continue;
    if (nextWord(label) && /^[[(]?\d/.test(str0(nextWord(label)))) continue; // "대표문제 12" 는 아래에서 말머리 번호로
    // 바로 위(또는 옆 단의 같은 높이)에 있는 가장 가까운 유형 제목의 번호 (왼쪽 단 "유형 01 …" 설명 옆 오른쪽 단 "대표 문제")
    const col = colOf((w.x0 + w.x1) / 2);
    // (제목이 수식으로 시작하는 "유형 03 lim aₙ=α 의 이용" 도 제목)
    const above = typeHeads.filter((t) => !t.answered && !inTable(t) && t.col <= col && t.w.y0 <= w.y1);
    if (!above.length) continue;
    const head = above.reduce((a, b) => (b.w.y0 > a.w.y0 ? b : a));
    // 번호 크기는 유형 번호 글자로 (이름표 글자는 작아서 번호 크기 비교에서 밀려남)
    const h = head.numWord.y1 - head.numWord.y0;
    candidates.push({ ...typeCand(head.digits, w, label), h, hRatio: h / bodyH, font: head.numWord.font || '' });
  }
  // 번호 없이 말머리만 있는 줄 맨 앞 이름표("유제" 띠 등): 그 아래부터 새 묶음이라 앞 문항 영역을 여기서 끊음
  const sectionLabels = [];
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
      if (!nw || !/^[[(]?\d/.test(normalizeOcrWord(nw.str))) {
        const cy = (w.y0 + w.y1) / 2;
        const inBody = !(layout?.hasHeader && cy < bodyTop) && !(layout?.hasFooter && cy > bodyBottom);
        if (inBody && !hasLeftNeighbor(w)) sectionLabels.push({ x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1, col: colOf((w.x0 + w.x1) / 2) });
      }
      if (!nw) continue;
      prefix = str;
      numWord = nw;
      str = opts.ocr ? normalizeOcrWord(nw.str) : nw.str;
    }
    const parsed = parseNumberWord(str);
    if (!parsed) continue;
    // 바로 뒤에 =, +, × 같은 연산 기호가 오면 줄 맨 앞의 수식("1 + 2 + 3 = 6", "8 = 2³")이고,
    // 조사·어미("8 이므로", "16 이다")가 오면 앞 줄에서 넘어온 문장 끝이라 번호가 아님
    if (!prefix && parsed.style === 'plain') {
      const after = (nextWord(numWord)?.str || '').replace(/[.,)]+$/, '');
      if (OPERATOR_START.test(after) || PARTICLES.has(after)) continue;
    }
    const cy = (w.y0 + w.y1) / 2;
    // 머리말/꼬리말(쪽번호) 제외
    if (layout?.hasHeader && cy < bodyTop) continue;
    if (layout?.hasFooter && cy > bodyBottom) continue;
    if (hasLeftNeighbor(w)) continue;
    candidates.push(make(parsed, prefix, w, numWord));
  }
  candidates.sort(byReadingOrder);
  const { kept, boxes } = dropAnswerRows(candidates);
  return { candidates: kept, bodyH, lineCount: lines.length, headings, ranges, answerBoxes: boxes, sectionLabels };
}

/**
 * 1단 쪽에서 문제 오른쪽에 놓인 그래프·⑤ 선택지 때문에 생긴 빈 세로 띠를 단 구분으로 잘못 본 경우 1단으로 되돌립니다.
 * (그대로 두면 문항 영역이 그 띠에서 잘려 오른쪽의 그림·선택지·문장 끝이 빠짐)
 * 두 단의 폭이 크게 다르고(좁은 쪽이 넓은 쪽의 60% 미만), 단 사이 세로선이 없고,
 * 넓은 단에만 줄 맨 앞 번호가 있고 좁은 단의 왼쪽 끝에는 그와 닮은 번호가 없을 때.
 * @param {{layout:object, candidates:object[]}} page  layout 을 고침
 * @returns {boolean} 단을 바꿨는지 (바꿨으면 후보를 다시 뽑아야 함)
 */
export function mergeFigureColumns(page) {
  const L = page.layout;
  if (L.columns?.length !== 2 || L.inferred != null || L.gutters?.some((g) => g.rule)) return false;
  const [a, b] = L.columns;
  const wa = a.x1 - a.x0;
  const wb = b.x1 - b.x0;
  if (Math.min(wa, wb) >= 0.6 * Math.max(wa, wb)) return false;
  const narrow = wa < wb ? 0 : 1;
  const starts = page.candidates.filter((c) => c.col === 1 - narrow && c.relX < 0.06);
  if (!starts.length) return false;
  // 좁은 단 왼쪽 끝에 넓은 단 번호와 닮은(같은 글꼴, 비슷한 크기) 번호가 있으면 진짜 단
  const alike = (c) => starts.some((s) => (!s.font || !c.font || s.font === c.font) && hOf(c) > 0.8 * hOf(s) && hOf(c) < 1.25 * hOf(s));
  if (page.candidates.some((c) => c.col === narrow && c.relX < 0.03 && alike(c))) return false;
  L.columns = [{ x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1) }];
  L.gutters = [];
  L.merged = true;
  return true;
}

/** 한 줄(왼쪽→오른쪽) 안에서 1씩 늘어나며 이어지는 가장 긴 번호들 (정답표 한 줄: 1 ② 2 ② 3 ① 4 24 …) */
function longestRun(row, maxGap) {
  let best = [];
  for (let i = 0; i < row.length; i++) {
    const run = [row[i]];
    for (let j = i + 1; j < row.length; j++) {
      const cur = run[run.length - 1];
      if (row[j].num === cur.num + 1 && row[j].x0 - cur.x0 <= maxGap) run.push(row[j]);
    }
    if (run.length > best.length) best = run;
  }
  return best;
}

/** 같은 단·같은 줄끼리 묶기 (읽는 순서) */
function rowsOf(cands) {
  const rows = [];
  for (const c of [...cands].sort(byReadingOrder)) {
    const row = rows[rows.length - 1];
    if (row && sameRow(row[0], c)) row.push(c);
    else rows.push([c]);
  }
  return rows;
}

/**
 * 해설 단원 첫머리의 작은 정답 상자("1 ② 2 ② 3 ① 4 24 …") 번호를 뺍니다:
 * 한 줄에 1씩 늘어나는 번호가 촘촘히 4개 이상(답이 셋뿐인 "Level 3" 상자는 더 촘촘히 3개) 나란한 줄
 * + 바로 아래에서 그 번호를 이어 가는 줄. (한 줄에 문항이 둘·셋 나란한 문제 쪽은 번호 사이가 넓어서 해당 없음)
 */
function dropAnswerRows(cands) {
  const rows = rowsOf(cands);
  const drop = new Set();
  const boxes = [];
  rows.forEach((row, i) => {
    const continued = row.some((c) => drop.has(c)); // 앞 줄에서 이어진 줄 (상자는 이미 기록함)
    let run = longestRun(row, 0.09);
    if (run.length < 4) run = longestRun(row, 0.075);
    // 같은 단 한 줄에 번호가 셋 이상 커지며 나란하면(답이 앞 번호에 붙어 몇 개는 후보에서 빠진 "1 ① 2 … 4 …") 정답표
    const rising = row.length >= 3 && row.every((c, k) => !k || (c.col === row[0].col && c.num > row[k - 1].num && c.x0 - row[k - 1].x0 <= 0.16));
    if (run.length < 3 && !rising) return;
    if (run.length < 3) run = row;
    const group = [...row];
    row.forEach((c) => drop.add(c));
    let last = run[run.length - 1];
    let prev = row;
    for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j];
      if (next[0].col !== row[0].col || next[0].y0 - prev[0].y0 > 3 * hOf(prev[0])) break;
      // 바로 다음 번호(빠진 번호가 있으면 몇 개 건너뛴 번호)로 이어지는 줄
      const step = (c) => c.num > last.num && c.num <= last.num + (rising ? 6 : 1);
      if (!next.some(step)) break;
      next.forEach((c) => drop.add(c));
      group.push(...next);
      for (const c of next) if (step(c) && c.num > last.num) last = c;
      prev = next;
    }
    // 정답 상자 자리 (문항 영역을 여기서 끊으려고)
    if (!continued) boxes.push({
      col: row[0].col,
      x0: Math.min(...group.map((c) => c.x0)),
      x1: Math.max(...group.map((c) => c.x1 ?? c.x0)),
      y0: Math.min(...group.map((c) => c.y0)),
      y1: Math.max(...group.map((c) => c.y0 + hOf(c))),
      h: median(group.map(hOf)),
      relX: Math.min(...group.map((c) => c.relX ?? 0)),
    });
  });
  return { kept: drop.size ? cands.filter((c) => !drop.has(c)) : cands, boxes };
}

/**
 * 빠른 정답표 같은 쪽인지
 *  - 한 줄에 1씩 늘어나는 번호가 여럿 나란한 줄이 두 줄 이상, 또는
 *  - 줄 맨 앞 번호가 촘촘한 줄 간격으로 일정하게 건너뛰거나(1, 7, 13 …) 줄마다 다시 1부터(1, 1, 1 …)
 *    (답 ①② 가 붙은 번호는 후보가 아니라서 줄 맨 앞 번호만 남는 경우가 많음)
 * @param {{strict?:boolean}} [opts] strict: 문제집용 — 칸이 촘촘한 표만 (한 줄에 문항이 둘·셋 나란한 쪽과 구분)
 */
export function looksLikeAnswerTable(all, { strict = false } = {}) {
  // 분수·지수 속 작은 숫자는 빼고 봄 (번호보다 확실히 작음. 해설 쪽의 1/2, 1/3 … 이 표처럼 보이지 않게)
  const hs = all.map((c) => c.h).sort((a, b) => a - b);
  const big = hs.length ? hs[Math.floor(hs.length * 0.75)] : 0;
  const candidates = all.filter((c) => c.h >= 0.6 * big);
  // 해설 속 증감표나 단원 첫머리의 작은 정답 상자 한 줄과 구분하려고, 그런 줄이 두 줄 이상이어야 함
  const tableRows = rowsOf(candidates).filter((row) => longestRun(row, strict ? 0.09 : Infinity).length >= 4);
  const members = tableRows.reduce((n, row) => n + row.length, 0);
  if (tableRows.length >= 2 && members >= candidates.length * (strict ? 0.5 : 0.4)) return true;
  // 단마다 줄 맨 앞(왼쪽 끝) 번호만 위→아래로
  const diffs = [];
  const gaps = [];
  const byCol = new Map();
  for (const c of candidates) {
    if (c.prefix) continue;
    if (!byCol.has(c.col)) byCol.set(c.col, []);
    byCol.get(c.col).push(c);
  }
  for (const list of byCol.values()) {
    const minRel = Math.min(...list.map((c) => c.relX ?? c.x0));
    const left = list.filter((c) => (c.relX ?? c.x0) <= minRel + 0.012).sort((a, b) => a.y0 - b.y0);
    for (let i = 1; i < left.length; i++) {
      diffs.push(left[i].num - left[i - 1].num);
      gaps.push(left[i].y0 - left[i - 1].y0);
    }
  }
  if (diffs.length < 4) return false;
  const { value, count } = mode(diffs);
  if (!(value === 0 || value >= 3) || count < diffs.length * 0.7) return false;
  // 정답표는 한 줄에 한 칸씩이라 줄 간격이 촘촘함 (한 줄에 문항이 셋 나란한 문제 쪽은 줄 사이가 넓음)
  return median(gaps) <= 4 * median(candidates.map((c) => c.h));
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
  // 앞 쪽보다 작은 번호로 시작(1번 제외)은 거의 늘 잘못 읽은 것 (부록 표의 숫자 등)
  return d <= 0 ? -2.5 : -0.6;
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
  // 0 채움(0001, 01)은 아주 뚜렷한 특징이라 다르면 크게 감점 (단, 0001 체계의 1000 처럼 자릿수가 꽉 찬 번호는 같은 모양)
  s += c.padded === sig.padded || (sig.padded && fullWidth(c) && c.digits.length === sig.digitsLen) ? 0.4 : -3.5;
  if (sig.padded && sig.digitsLen && c.digits.length !== sig.digitsLen) s -= 2.5;
  if ((c.prefix || '') !== (sig.prefix || '')) s -= 3;
  if (!c.ocr && sig.sizes?.length) {
    // 글자 레이어의 글꼴 크기는 정확함: 이 체계 번호들의 어느 크기와도 8% 넘게 다르면 다른 요소(줄 맨 앞 수식, 소제목 등).
    // 15% 넘게 다르면(개념 쪽 소제목 "3" 등) 번호가 1 이어지더라도 고르지 않음
    const d = Math.min(...sig.sizes.map((v) => Math.abs(c.h / v - 1)));
    if (d <= 0.04) s += 0.6;
    else if (d > 0.15) s -= 7;
    else if (d > 0.08) s -= 2.5;
  } else if (sig.hRatio > 0) {
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
      // 같은 단에서 거의 같은 높이면 같이 선택할 수 없음 (한 줄에 나란히 놓인 문항은 예외)
      if (a.col === b.col && b.y0 - a.y0 < 0.6 * Math.max(a.h, b.h) && !besideRight(a, b)) continue;
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
 * 글자 레이어 번호들의 글꼴 크기 무리 (한 체계 안에 크기가 다른 번호가 섞일 수 있음: 수능특강 유제 / Level).
 * 4% 안쪽으로 붙은 값끼리 묶고, 전체의 15% 이상인 무리의 가운데 값만
 */
function sizeClusters(chosen) {
  const hs = chosen.filter((c) => !c.ocr && c.h > 0).map((c) => c.h).sort((a, b) => a - b);
  const groups = [];
  for (const v of hs) {
    const g = groups[groups.length - 1];
    if (g && v <= g[g.length - 1] * 1.04) g.push(v);
    else groups.push([v]);
  }
  return groups.filter((g) => g.length >= Math.max(2, 0.15 * hs.length)).map(median);
}

function learnSignature(chosen) {
  if (chosen.length < 3) return null;
  const fonts = chosen.map((c) => c.font).filter(Boolean);
  const fm = mode(fonts);
  return {
    sizes: sizeClusters(chosen),
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
      const hh = (a) => Math.max(a.h, c.h);
      if (merged.some((a) => a.col === c.col && Math.abs(a.y0 - c.y0) < 0.6 * hh(a) && Math.abs(a.x0 - c.x0) < 3 * hh(a))) continue;
      merged.push(c);
    }
    merged.sort(byReadingOrder);
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
      if (forced === 'pad') return c.padded || c.digits.length >= 3;
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
  // 0001 체계에서 1000 이상 번호는 앞에 0 이 없으므로, 같은 자릿수의 0 채움 묶음에도 넣음
  for (const p of pages) {
    for (const c of p.candidates) {
      if (!fullWidth(c)) continue;
      const g = groups.get(groupKey({ ...c, padded: true }));
      if (!g) continue;
      if (!g.has(p.index)) g.set(p.index, []);
      g.get(p.index).push(c);
      g.get(p.index).sort(byReadingOrder);
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
      markFixedWidth(res.anchors, sg);
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
  markFixedWidth(mainRes.anchors, main.res.signature);
  const anchors = new Map(pages.map((p) => [p.index, [...(mainRes.anchors.get(p.index) || [])]]));
  const signatures = [main.res.signature];
  for (const r of results.slice(1)) {
    if (!groupQuality(r.q, r.seq.length, r.res.signature, main.res.signature, r.prefixed)) continue;
    signatures.push(r.res.signature);
    markFixedWidth(r.res.anchors, r.res.signature);
    mergeAnchors(anchors, r.res.anchors);
  }
  return { anchors, signature: main.res.signature, signatures };
}

/**
 * 0 채움 없이 자릿수가 꽉 찬 번호(0001 체계의 1000 …)일 수 있는지.
 * 2자리(01 체계)는 본문의 10 이상 숫자가 너무 흔해서 빼고 3자리 이상만
 */
const fullWidth = (c) => !c.padded && c.digits.length >= 3 && c.digits[0] !== '0';

/** 0 채움 체계로 고른 꽉 찬 번호에 표시 (체계 열쇠가 같아지게) */
function markFixedWidth(anchors, sig) {
  if (!sig?.padded) return;
  for (const chain of anchors.values()) for (const c of chain) if (fullWidth(c) && c.digits.length === sig.digitsLen) c.fixedWidth = true;
}

/** 번호 체계 열쇠: 말머리 | 0 채움 자릿수 (0001 체계의 1000 이상도 같은 체계) */
export const schemeKey = (c) => `${c.prefix || ''}|${c.padded || c.fixedWidth ? c.digits.length : 0}`;

/** 버려진 후보가 그 체계에 들어갈 수 있는지 (꽉 찬 번호는 0 채움 체계에도) */
const fitsScheme = (c, key) => schemeKey(c) === key || (fullWidth(c) && key === `${c.prefix || ''}|${c.digits.length}`);

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
  const lastByKey = new Map();
  const nextFirstOf = (pi, key) => {
    for (let j = pi + 1; j < pages.length; j++) {
      const c = (anchors.get(pages[j].index) || []).find((x) => schemeKey(x) === key);
      if (c) return c.num;
    }
    return null;
  };
  let filled = 0;
  for (let pi = 0; pi < pages.length; pi++) {
    const p = pages[pi];
    const chain = anchors.get(p.index) || [];
    // 읽는 순서상의 자리 (같은 줄에 나란한 번호는 왼쪽이 먼저)
    const rank = new Map([...new Set([...p.candidates, ...chain])].sort(byReadingOrder).map((c, i) => [c, i]));
    const order = (c) => rank.get(c);
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
        fitsScheme(c, key) && (!sig || Math.abs(c.relX - sig.relX) <= 0.045) && (!sig?.hRatio || (c.hRatio / sig.hRatio > 0.6 && c.hRatio / sig.hRatio < 1.7));
      const points = [{ num: lastByKey.get(key) ?? null, pos: -Infinity }, ...seq.map((c) => ({ num: c.num, pos: order(c) })), { num: null, pos: Infinity }];
      for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        if (a.num == null) continue;
        // 쪽 끝 구간은 다음 쪽 첫 번호가 실제로 건너뛰었을 때만 그 사이를 채움 (다음 단원이 1번부터면 빠진 게 없음)
        const hi = b.num != null ? b.num : nextFirstOf(pi, key);
        if (hi == null || hi - a.num < 2) continue;
        let want = a.num + 1;
        const between = pool
          .filter((c) => okShape(c) && order(c) > a.pos && order(c) < b.pos && c.num > a.num && c.num < hi)
          .sort((x, y) => order(x) - order(y));
        for (const c of between) {
          if (c.num === want || (c.num > want && c.num - want <= 1)) {
            c.filled = true;
            if (schemeKey(c) !== key) c.fixedWidth = true;
            add.push(c);
            want = c.num + 1;
          }
        }
      }
      const all = [...seq, ...add.filter((c) => fitsScheme(c, key))];
      if (all.length) lastByKey.set(key, Math.max(...all.map((c) => c.num)));
    }
    if (add.length) {
      filled += add.length;
      anchors.set(p.index, [...chain, ...add].sort(byReadingOrder));
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
  const list = cands.filter((c) => c.num > lo && c.num < hi).sort(byReadingOrder);
  // 최장 증가 부분수열 (번호가 1씩 늘어날수록, 줄 맨 앞에 가까울수록 가점)
  const n = list.length;
  const best = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let j = 0; j < n; j++) {
    best[j] = 1 + (list[j].num === lo + 1 ? 0.5 : 0) - Math.min(0.5, list[j].relX * 5);
    for (let i = 0; i < j; i++) {
      if (list[i].num >= list[j].num) continue;
      if (list[i].col === list[j].col && list[j].y0 - list[i].y0 < 0.6 * Math.max(list[i].h, list[j].h) && !besideRight(list[i], list[j])) continue;
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
 * 대표 번호 체계에서 앞뒤 흐름과 동떨어진 짧은 덩어리를 뺍니다.
 * (책 앞 소개 쪽의 견본 번호, 목차·만화 쪽이나 부록 로그표에서 잘못 읽은 "3939" 같은 숫자)
 * 덩어리 = 번호가 1~4씩 늘며 이어지는 구간. 6개 이하이고, 가까운 앞·뒤의 긴 덩어리 어느 쪽과도 이어지지 않으면 버림.
 * 1부터 시작하는 덩어리(단원마다 다시 시작)는 그대로 두되, 높이가 이 책 번호들보다 확실히 작은
 * 숫자로만 된 6개 이하 덩어리(개념 쪽 소제목 "1 함수의 수렴과 발산", 책 소개 쪽 견본 그림 속 "0001 0003 …")는 버림.
 * @returns {number} 뺀 개수
 */
export function dropStrayRuns(order, anchors, key) {
  const runs = [];
  for (const idx of order) {
    for (const c of anchors.get(idx) || []) {
      if (schemeKey(c) !== key) continue;
      const run = runs[runs.length - 1];
      const d = run ? c.num - run[run.length - 1].c.num : 0;
      if (run && d >= 1 && d <= 4) run.push({ idx, c });
      else runs.push([{ idx, c }]);
    }
  }
  const isLong = (r) => r.length > 6;
  if (!runs.some(isLong)) return 0;
  const follows = (a, b) => !!a && !!b && b[0].c.num - a[a.length - 1].c.num >= 1 && b[0].c.num - a[a.length - 1].c.num <= 10;
  const stray = new Set();
  const typicalH = median(runs.flat().map(({ c }) => c.h));
  const small = ({ c }) => c.h < 0.6 * typicalH;
  runs.forEach((r, i) => {
    if (r.length <= 6 && r.every(small)) {
      for (const { c } of r) stray.add(c);
      return;
    }
    if (isLong(r) || r[0].c.num === 1) return;
    const prev = runs.slice(0, i).reverse().find(isLong);
    const next = runs.slice(i + 1).find(isLong);
    if (!follows(prev, r) && !follows(r, next)) for (const { c } of r) stray.add(c);
  });
  if (!stray.size) return 0;
  for (const idx of order) {
    const chain = anchors.get(idx);
    if (chain?.some((c) => stray.has(c))) anchors.set(idx, chain.filter((c) => !stray.has(c)));
  }
  return stray.size;
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
      const next = k + 1 < order.length ? anchors.get(order[k + 1]) || [] : [];
      // 다음 쪽 번호가 체계마다 앞 쪽에서 1씩 그대로 이어지면 빠진 번호가 없음 (개념 설명 쪽 등)
      const firstByKey = new Map();
      for (const c of next) if (!firstByKey.has(schemeKey(c))) firstByKey.set(schemeKey(c), c.num);
      const continues = firstByKey.size > 0 && [...firstByKey].every(([key, n]) => lastByKey.get(key) === n - 1);
      if (L && !L.blank && L.inkRatio > 0.02 && prevHas && next.length && !continues) reasons.push('번호를 찾지 못함');
    } else {
      // 번호 체계별로 연속성 확인 (유제 1,2 와 Level 01,02 처럼 섞여 있을 수 있음)
      const byKey = new Map();
      for (const c of chain) {
        const key = schemeKey(c);
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
  let prevCols = null;
  for (const pageIdx of order) {
    const L = layouts.get(pageIdx);
    const grid = grids.get(pageIdx);
    const chain = anchors.get(pageIdx) || [];
    if (!L || !grid || opts.stopPages?.has(pageIdx)) {
      open = null;
      prevCols = null;
      continue;
    }
    const cols = L.columns?.length ? L.columns : [{ x0: 0, x1: 1 }];
    // 번호가 하나도 없고 단 폭도 앞 쪽과 다른 쪽(책 끝 메모·광고 쪽 등)으로는 앞 해설이 이어지지 않음
    // (마지막 쪽에 왼쪽 단만 차 있는 해설 끝은 단 폭이 같아서 이어짐)
    const widthOf = (c) => c.x1 - c.x0;
    if (!chain.length && prevCols && !cols.every((c) => prevCols.some((p) => Math.abs(widthOf(c) - widthOf(p)) <= 0.25 * widthOf(p)))) open = null;
    prevCols = cols;
    const zones = zonesOf(L);
    zones.forEach((zone, z) => {
      if (zone.afterBand) open = null; // 단원 제목 띠 다음은 새 단원
      const top = zone.y0;
      const bottom = zone.y1;
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        // 단 사이 거터로는 넓히지 않음 (단 구분 세로선이 영역에 들어가면 위아래 여백을 못 잘라 다음 문항 앞까지 늘어남)
        const gut = L.gutters || [];
        const x0 = Math.max(0, col.x0 - 0.006, ...gut.filter((g) => g.x1 <= col.x0 + 0.002).map((g) => g.x1));
        const x1 = Math.min(1, col.x1 + 0.006, ...gut.filter((g) => g.x0 >= col.x1 - 0.002).map((g) => g.x0));
        const inCol = chain.filter((a) => a.col === c && a.y0 >= top - 0.01 && (a.y0 < bottom || z === zones.length - 1)).sort(byReadingOrder);
        // 한 줄에 나란히 놓인 번호들은 한 줄로 묶음 (세로는 다음 줄 번호까지, 가로는 오른쪽 번호 앞까지)
        const rows = [];
        for (const a of inCol) {
          const row = rows[rows.length - 1];
          if (row && sameRow(row[0], a)) row.push(a);
          else rows.push([a]);
        }
        // 공통 지문 머리 ([0100~0120]) — 그 아래 첫 문항 전까지가 공통 지문
        const rangesHere = (opts.ranges?.get(pageIdx) || []).filter((r) => r.col === c && r.y0 >= top - 0.01 && r.y0 < bottom);
        // 단원·유형 제목 등에서 영역을 끊음 (이 단과 가로로 겹치는 것만)
        // 구역 아래 끝의 가로 띠는 구역 경계일 뿐이라, 이어지는 해설을 거기서 닫지 않음 (다음 단 위쪽으로 이어짐)
        const cuts = (opts.cutters?.get(pageIdx) || [])
          .filter((k) => k.x1 > col.x0 + 0.005 && k.x0 < col.x1 - 0.005)
          .map((k) => k.y0)
          .filter((cy) => cy > top && cy < bottom - 0.006 && !inCol.some((a) => Math.abs(cy - a.y0) < a.h * 1.2));
        const cutBetween = (ya, yb) => {
          let v = yb;
          for (const cy of cuts) if (cy > ya + 0.005 && cy < v) v = cy;
          return v;
        };
        // 번호 위에서 끊을 자리 (글줄을 가로지르지 않게, 번호 위에 붙은 문항 코드는 그 문항으로)
        const cutAt = new Map();
        const cutOf = (a) => {
          if (!cutAt.has(a)) cutAt.set(a, cutAbove(grid, a, x0, x1, top - 0.01, { minX: a.x1 ?? a.x0 }));
          return cutAt.get(a);
        };

        // 단 맨 위가 단원 제목·정답 상자 같은 새 묶음의 시작이면 앞 해설은 여기까지
        if (open && flow === 'continue') {
          const startsNew = (opts.cutters?.get(pageIdx) || []).some(
            (k) => k.kind !== 'span' && k.x1 > col.x0 + 0.005 && k.x0 < col.x1 - 0.005 && k.y0 >= top - 0.02 && k.y0 <= top + 0.006,
          );
          if (startsNew) open = null;
        }
        // 단 위쪽: 이전 문항이 이어지는 부분
        if (open && flow === 'continue') {
          const nominal = inCol.length ? cutOf(inCol[0]) : bottom;
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
          const y1 = nextA ? cutOf(nextA) : bottom;
          const r = trimRect(grid, { x: x0, y: y0, w: x1 - x0, h: Math.max(0.01, y1 - y0) });
          if (r) stems.push({ a: rg.a, b: rg.b, y: rg.y0, page: pageIdx, z, c, rect: { page: pageIdx, ...r } });
        }
        for (let ri = 0; ri < rows.length; ri++) {
          const row = rows[ri];
          const nextRow = rows[ri + 1];
          const nominal = nextRow ? Math.min(...nextRow.map(cutOf)) : bottom;
          for (let k = 0; k < row.length; k++) {
            const a = row[k];
            const right = row[k + 1];
            const y0 = Math.max(top - 0.01, cutOf(a));
            const y1 = cutBetween(y0, nominal);
            const rx0 = k === 0 ? Math.min(x0, a.x0 - 0.004) : a.x0 - 0.004;
            const rx1 = right ? right.x0 - 0.004 : x1;
            const raw = { x: rx0, y: y0, w: rx1 - rx0, h: Math.max(0.01, y1 - y0) };
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

/** 문항을 읽는 순서로 정렬(쪽 → 구역 → 단 → 위치, 같은 줄에 나란하면 왼쪽부터) */
export function sortItems(items) {
  const pos = (r, s) => (Math.abs(r.y - s.y) < 0.008 ? r.x - s.x : r.y - s.y);
  return [...items].sort(
    (a, b) => a.page - b.page || (a.zone ?? 0) - (b.zone ?? 0) || (a.col ?? 0) - (b.col ?? 0) || pos(a.rects[0], b.rects[0]),
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
