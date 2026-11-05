// 스캔본 문항 그림 → 글자 + 수식 상자 (AI 없이)
//  - Tesseract 는 한글은 잘 읽지만 수식은 엉터리로 읽음 → 믿을 만한 한글 글자(와 거기 붙은 문장 부호)만 글로 쓰고,
//    줄 안의 나머지 잉크는 수식 상자로 묶어 수식 인식기에 보냄
//  - 한글 조사가 수식에 붙으면 OCR 이 한 단어로 읽으므로("c에" → cold) 단어가 아니라 글자 상자로 나눔
//  - 큰 잉크 덩어리(그래프·도형)는 그림으로, 동그라미 번호가 있는 줄은 보기로, 색 있는 번호·꼬리표는 뺌
//  - 여기는 계산만 (DOM·canvas 없음 → Node 에서 시험). 그림 그리기·OCR·수식 인식 부르기는 scanocr.js
//
// 좌표는 모두 문항 그림(renderStack) 픽셀, 상자는 {x0, y0, x1, y1} (x1·y1 은 끝 다음 칸)

import { LOW_CONF, textLow, mathLow, relativeBox } from './lowconf.js';

const HANGUL = /^[가-힣]$/;
const JAMO_ITEM = /^[ㄱ-ㅎ]$/; // <보기>의 ㄱ. ㄴ. ㄷ.
const PUNCT_AFTER = /^[,.?!:;)\]」』·…%]$/; // 한글 바로 뒤에 붙는 부호 (따옴표는 뺌: 위첨자·프라임을 따옴표로 읽음)
const PUNCT_BEFORE = /^[([「『]$/; // 한글 바로 앞에 붙는 부호 (따옴표는 뺌: 한글 앞 위첨자 "a²의" 의 ² 를 " 로 읽음)

// 문턱값 (h = 본문 한글 글자 높이). 쎈 대수 스캔본 4쪽(문항 55개)에 맞춤
export const T = {
  hangulConf: 85, // 한글로 믿는 OCR 글자 확신도 (kor+eng)
  hangulConfKor: 90, // 한국어만으로 읽은 것은 더 엄격하게 (수식을 한글로 읽는 일이 더 잦음)
  hangulMinH: 0.8, // 한글 글자 높이 (h 대비)
  hangulMaxH: 1.3,
  noiseArea: 0.004, // 이보다 작은 잉크(h² 대비)는 티끌
  colorChroma: 22, // 잉크 평균 채도가 이보다 크면 색 글자(번호·꼬리표·제목) → 뺌 (검은 글자는 0~6, 진한 초록 번호도 33 이상)
  figureExtent: 3, // 가로나 세로가 h 의 이만큼보다 크면 그림 후보
  bandGap: 0.25, // 줄 안에서 이만큼(h 대비) 벌어진 틈은 같은 줄 (분수의 분자·분모 등)
  smallBand: 0.5, // 이보다 낮은 줄은 가까운 줄에 붙임 (위첨자·아래첨자만 따로 떨어진 경우)
  smallBandGap: 0.7,
  splitGap: 3, // 수식 조각 사이가 이만큼 벌어지면 다른 수식
  spaceGap: 0.22, // 이보다 넓은 틈은 띄어쓰기
  pad: 0.12, // 수식 그림 둘레 흰 여백 (h 대비)
  // 믿을 만한지 (judgeScan) — GT 수식 126개로 맞춤
  confMean: LOW_CONF.confMean,
  confMin: LOW_CONF.confMin,
  textConf: 80, // 한글 크기 OCR 글자 평균 확신도
};

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cx = (b) => (b.x0 + b.x1) / 2;
const cy = (b) => (b.y0 + b.y1) / 2;
const bw = (b) => b.x1 - b.x0;
const bh = (b) => b.y1 - b.y0;
const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const grow = (b, m) => ({ x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m });
const meets = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const overlapArea = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

// ---------------------------------------------------------------------------
// 잉크·덩어리
// ---------------------------------------------------------------------------
/** Otsu 문턱값 (회색 막대그래프) */
export function otsu(hist) {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i];
    sum += i * hist[i];
  }
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const d = sumB / wB - (sum - sumB) / wF;
    const v = wB * wF * d * d;
    if (v > best) {
      best = v;
      t = i;
    }
  }
  return t;
}

/** RGBA → 회색·채도·잉크(0/1). 문턱값은 Otsu (너무 밝거나 어둡게 잡히지 않게 110~190) */
export function toInk(img) {
  const { data, width: W, height: H } = img;
  const n = W * H;
  const gray = new Uint8Array(n);
  const chroma = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const v = ((r * 3 + g * 5 + b * 2 + 5) / 10) | 0;
    gray[j] = v;
    hist[v]++;
    chroma[j] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  const threshold = clamp(otsu(hist), 110, 190);
  const ink = new Uint8Array(n);
  for (let j = 0; j < n; j++) ink[j] = gray[j] <= threshold ? 1 : 0;
  return { gray, chroma, ink, threshold };
}

/**
 * 이어진 잉크 덩어리 (8방향). labels[픽셀] = 덩어리 번호+1 (0 = 바탕)
 * @returns {{labels: Int32Array, comps: {id, x0, y0, x1, y1, n, chroma}[]}}
 */
export function components(ink, W, H, chroma = null) {
  const labels = new Int32Array(W * H);
  const parent = [0];
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const join = (a, b) => {
    a = find(a);
    b = find(b);
    if (a === b) return a;
    if (a < b) {
      parent[b] = a;
      return a;
    }
    parent[a] = b;
    return b;
  };
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      if (!ink[i]) continue;
      let l = 0;
      if (x > 0 && labels[i - 1]) l = labels[i - 1];
      if (y > 0) {
        const up = i - W;
        if (x > 0 && labels[up - 1]) l = l ? join(l, labels[up - 1]) : labels[up - 1];
        if (labels[up]) l = l ? join(l, labels[up]) : labels[up];
        if (x < W - 1 && labels[up + 1]) l = l ? join(l, labels[up + 1]) : labels[up + 1];
      }
      if (!l) {
        l = parent.length;
        parent.push(l);
      }
      labels[i] = l;
    }
  }
  const remap = new Int32Array(parent.length);
  const comps = [];
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    const root = find(l);
    let id = remap[root];
    if (!id) {
      comps.push({ id: comps.length, x0: Infinity, y0: Infinity, x1: -1, y1: -1, n: 0, chroma: 0 });
      id = remap[root] = comps.length;
    }
    labels[i] = id;
    const c = comps[id - 1];
    const x = i % W;
    const y = (i - x) / W;
    if (x < c.x0) c.x0 = x;
    if (x >= c.x1) c.x1 = x + 1;
    if (y < c.y0) c.y0 = y;
    if (y >= c.y1) c.y1 = y + 1;
    c.n++;
    if (chroma) c.chroma += chroma[i];
  }
  for (const c of comps) c.chroma = c.n ? c.chroma / c.n : 0;
  return { labels, comps };
}

/** 고리 모양: 네 변 가운데쯤에 모두 잉크가 있음 (동그라미 번호. √ 는 오른쪽·아래 가운데가 비어 있음) */
function ringTest(labels, W) {
  return (c) => {
    const w = bw(c);
    const hh = bh(c);
    const any = (xa, xb, ya, yb) => {
      for (let y = Math.floor(ya); y < Math.ceil(yb); y++) for (let x = Math.floor(xa); x < Math.ceil(xb); x++) if (labels[y * W + x] === c.id + 1) return true;
      return false;
    };
    const midX = [c.x0 + 0.3 * w, c.x0 + 0.7 * w];
    const midY = [c.y0 + 0.3 * hh, c.y0 + 0.7 * hh];
    return any(c.x0, c.x0 + 0.2 * w, ...midY) && any(c.x1 - 0.2 * w, c.x1, ...midY) && any(...midX, c.y0, c.y0 + 0.2 * hh) && any(...midX, c.y1 - 0.2 * hh, c.y1);
  };
}

/** 덩어리 잉크 중 테두리 가까이(d 픽셀 안)에 있는 비율 — 글을 둘러싼 네모 틀이면 1 에 가까움 */
function borderFraction(c, labels, W, d) {
  let near = 0;
  for (let y = c.y0; y < c.y1; y++) {
    for (let x = c.x0; x < c.x1; x++) {
      if (labels[y * W + x] !== c.id + 1) continue;
      if (x - c.x0 < d || c.x1 - 1 - x < d || y - c.y0 < d || c.y1 - 1 - y < d) near++;
    }
  }
  return near / Math.max(1, c.n);
}

// ---------------------------------------------------------------------------
// OCR 글자 → 한글 글자 상자
// ---------------------------------------------------------------------------
/**
 * 단어 안 글자 상자 다듬기: Tesseract 는 첫 글자 상자를 단어 전체로 주는 일이 잦아서,
 * 뒤 글자가 시작하는 곳에서 앞 글자를 자름
 */
function cleanSymbols(word) {
  const syms = (word.symbols || []).map((s) => ({ ...s }));
  for (let i = 0; i + 1 < syms.length; i++) {
    const a = syms[i];
    const b = syms[i + 1];
    if (b.x0 > a.x0 && a.x1 > b.x0) a.x1 = b.x0;
  }
  return syms;
}

/** OCR 결과(여러 번 읽은 것)에서 본문 한글 글자 높이 h */
export function textHeight(passes, fallback = 0) {
  const hs = [];
  for (const { words } of passes) for (const w of words || []) for (const s of w.symbols || []) if (HANGUL.test(s.str) && s.conf >= 90) hs.push(s.y1 - s.y0);
  return hs.length >= 3 ? median(hs) : fallback;
}

/**
 * 믿을 만한 한글 + 거기 붙은 부호 (글로 쓸 것)
 *  - 한글로만 된 단어(부호 포함)는 단어 하나로, 수식과 섞인 단어는 한글 글자만
 *  - 수식을 한글로 잘못 읽은 것은 확신도가 낮거나 키가 맞지 않음 (분수를 "금"으로 읽으면 h 의 두 배)
 *    단 Σ·분수가 있는 높은 줄에서는 진짜 한글 상자도 높게 나와서, 그런 것은 check 를 달아 잉크로 다시 봄(planScan)
 *  - 한 번만 읽힌 한국어만(kor) 결과도 check (수식 "g₂" 를 "요" 로 읽기도 함)
 *  - 글자 수보다 넓은 상자는 줄임: 뒤에 다른 한글이 있으면 앞쪽을, 아니면(수식 뒤 조사) 뒤쪽을 남김
 *  - 두 번 읽은 것(kor+eng, kor)은 겹치면 긴 것·확신도 높은 것 하나만
 * @param passes [{words, kor?}] — kor: 한국어만으로 읽은 결과 (확신도 문턱을 높임)
 * @param comps  잉크 덩어리 (있으면 넓은 상자를 잉크에 맞춤)
 * @returns {{str, x0, y0, x1, y1, conf, kind:'hangul'|'punct'|'jamo', n?, check?}[]} x 순서
 */
export function textSymbols(passes, h, comps = null) {
  const units = [];
  const others = [];
  const isPunct = (str) => PUNCT_AFTER.test(str) || PUNCT_BEFORE.test(str);
  const normalH = (sh) => sh >= T.hangulMinH * h && sh <= T.hangulMaxH * h;
  passes.forEach(({ words, kor }, pass) => {
    for (const w of words || []) {
      const syms = cleanSymbols(w);
      const sylls = syms.filter((s) => HANGUL.test(s.str));
      const pure = sylls.length > 0 && syms.every((s) => HANGUL.test(s.str) || isPunct(s.str));
      const wh = w.y1 - w.y0;
      /** 0: 아님, 1: 한글, 2: 한글인데 잉크로 다시 볼 것 */
      const grade = (s) => {
        const sh = s.y1 - s.y0;
        if (s.conf >= (kor ? T.hangulConfKor : T.hangulConf) && normalH(sh)) return 1;
        if (s.conf >= 95 && w.conf >= 80 && sh >= 0.5 * h && sh <= 2.3 * h) return normalH(sh) ? 1 : 2; // 그·오처럼 납작한 글자, 높은 줄의 글자
        if (pure && sylls.length >= 2 && w.conf >= 88 && s.conf >= 80 && wh >= T.hangulMinH * h && wh <= 1.6 * h) return 1;
        return 0;
      };
      const grades = sylls.map(grade);
      if (pure && grades.every(Boolean)) {
        units.push({
          str: w.str.replace(/\s+/g, ''),
          x0: w.x0,
          y0: w.y0,
          x1: w.x1,
          y1: w.y1,
          conf: Math.min(...sylls.map((s) => s.conf)),
          wordConf: w.conf, // 표시용으로만 전달. 글자 선택에 쓰는 conf는 그대로 둠.
          kind: 'hangul',
          n: sylls.length,
          punct: syms.length - sylls.length,
          pass,
          kor,
          check: grades.includes(2),
        });
        continue;
      }
      syms.forEach((s, k) => {
        const sh = s.y1 - s.y0;
        if (HANGUL.test(s.str)) {
          const g = grade(s);
          if (g) units.push({ ...s, kind: 'hangul', n: 1, punct: 0, pass, kor, check: g === 2 });
        } else if (s.conf >= 60 && isPunct(s.str)) {
          // 부호 상자는 단어 끝까지 늘어나 있곤 함 → 좁게
          const box = { ...s, kind: 'punct' };
          if (bw(box) > 0.45 * h) box.x1 = box.x0 + 0.45 * h;
          others.push(box);
        } else if (JAMO_ITEM.test(s.str) && s.conf >= 70 && sh >= 0.6 * h && sh <= 1.3 * h && /^[.)]$/.test(syms[k + 1]?.str || '')) {
          // <보기>의 "ㄱ." — 점이 바로 붙은 것만 (수식 "tan" 을 "ㅁ" 으로 읽기도 함)
          units.push({ ...s, str: `${s.str}${syms[k + 1].str}`, x1: syms[k + 1].x1, kind: 'jamo', n: 1, punct: 1, pass, kor });
        }
      });
    }
  });
  // 글자 수보다 넓은 상자 줄이기 (단어 상자가 읽지 못한 옆 글자·수식까지 덮는 일이 있음)
  //  1) 다른 번 읽기에서 같은 글자를 더 좁게 읽었으면 그 상자
  //  2) 상자 안 뒤쪽(앞쪽)에 다른 한글이 있으면 앞쪽(뒤쪽)만
  //  3) 잉크가 있으면 한글처럼 생긴 덩어리(키가 h 쯤이고 폭도 넓은 것)가 있는 곳만 ("수 a," → "수", "x_n은" → "은", "값을" → 그대로)
  //  4) 그래도 모르면 뒤쪽 (수식 뒤에 붙은 조사가 흔함)
  const sameLine = (a, b) => Math.abs(cy(a) - cy(b)) < 0.6 * h;
  for (const u of units) {
    const cap = (u.n * 1.15 + u.punct * 0.45) * h;
    if (bw(u) <= cap) continue;
    const twin = units.find((v) => v !== u && v.pass !== u.pass && v.str === u.str && sameLine(u, v) && v.x0 >= u.x0 - 0.1 * h && v.x1 <= u.x1 + 0.1 * h && bw(v) < bw(u));
    if (twin) {
      u.x0 = twin.x0;
      u.x1 = twin.x1;
      if (bw(u) <= 1.3 * cap) continue; // 조금 넓은 것은 그대로 (잉크로 줄이면 다음 글자와 틈이 넓어 보여 띄어 씀)
    }
    const inside = units.filter((v) => v !== u && v !== twin && v.str !== u.str && sameLine(u, v) && cx(v) > u.x0 && cx(v) < u.x1);
    if (inside.some((v) => cx(v) > u.x0 + cap)) {
      u.x1 = u.x0 + cap;
      continue;
    }
    if (inside.some((v) => cx(v) < u.x1 - cap)) {
      u.x0 = u.x1 - cap;
      continue;
    }
    const looks = hangulLike(comps, u, h);
    if (looks) {
      u.x0 = looks.x0;
      u.x1 = looks.x1;
    } else u.x0 = u.x1 - cap;
  }
  // 다른 번 읽기에서도 한글로 읽힌 것은 다시 볼 필요 없음
  for (const u of units) {
    if (!u.check && !(u.kor && u.n === 1)) continue;
    const confirmed = units.some((v) => v.pass !== u.pass && !v.check && sameLine(u, v) && Math.min(v.x1, u.x1) - Math.max(v.x0, u.x0) > 0.3 * Math.min(bw(u), bw(v)));
    u.check = !confirmed;
  }
  // 겹치는 것은 하나만: 글자 수가 많은 것 → 폭이 그럴듯한 것(한 글자 0.6h 이상) → 다시 볼 필요 없는 것 → 확신도 높은 것 먼저
  const keep = [];
  const thin = (u) => (bw(u) < 0.6 * h * u.n ? 1 : 0);
  for (const u of units.sort((a, b) => b.n - a.n || thin(a) - thin(b) || a.check - b.check || b.conf - a.conf)) {
    const covered = keep.some((k) => sameLine(k, u) && Math.min(k.x1, u.x1) - Math.max(k.x0, u.x0) > 0.5 * Math.min(bw(u), bw(k)));
    if (covered) continue;
    // 다른 번 읽기의 단어 첫(끝) 글자와 같은 글자가 그 단어 앞(뒤)에 조금 겹쳐 있으면 같은 글자 ("함" + "함수" → "함수")
    const word = keep.find((k) => sameLine(k, u) && k.n > u.n && Math.min(k.x1, u.x1) > Math.max(k.x0, u.x0) && ((u.x0 < k.x0 && k.str.startsWith(u.str)) || (u.x1 > k.x1 && k.str.endsWith(u.str))));
    if (word) {
      word.x0 = Math.min(word.x0, u.x0);
      word.x1 = Math.max(word.x1, u.x1);
      continue;
    }
    keep.push(u);
  }
  // 부호는 한글 바로 옆에 붙은 것만 ("(단," "은?" "때,")
  const near = (p) =>
    keep.some((k) => Math.abs(cy(k) - cy(p)) < 0.7 * h && (PUNCT_BEFORE.test(p.str) ? k.x0 >= p.x1 - 0.2 * h && k.x0 - p.x1 < (/^단/.test(k.str) ? 0.8 : 0.4) * h : p.x0 >= k.x1 - 0.2 * h && p.x0 - k.x1 < 0.4 * h));
  for (const p of others.sort((a, b) => b.conf - a.conf)) {
    if (keep.some((k) => Math.min(k.x1, p.x1) - Math.max(k.x0, p.x0) > 0.5 * bw(p) && Math.abs(cy(k) - cy(p)) < 0.7 * h)) continue;
    if (near(p)) keep.push(p);
  }
  return keep.sort((a, b) => a.x0 - b.x0);
}

/**
 * 상자 안에서 한글처럼 생긴 잉크 묶음(가로로 겹치는 덩어리끼리 묶어 키 0.8~1.25h, 폭 0.6h 이상)이 차지한 가로 범위 (없으면 null)
 * 영문·숫자는 한글보다 낮고(소문자 0.55h, 숫자 0.8h 안팎) 좁음
 */
function hangulLike(comps, u, h) {
  if (!comps) return null;
  const cs = comps.filter((c) => !c.kind && cx(c) >= u.x0 && cx(c) <= u.x1 && cy(c) >= u.y0 - 0.2 * h && cy(c) <= u.y1 + 0.2 * h).sort((a, b) => a.x0 - b.x0);
  // 가로로 겹치거나 아주 가까운 덩어리끼리 (가 = ㄱ+ㅏ 처럼 옆으로 놓인 글자도) — 단 한 글자 폭(1.15h)을 넘지 않게
  const groups = [];
  for (const c of cs) {
    const g = groups[groups.length - 1];
    if (g && (c.x0 < g.x1 || (c.x0 - g.x1 <= 0.12 * h && Math.max(g.x1, c.x1) - g.x0 <= 1.15 * h))) Object.assign(g, union(g, c));
    else groups.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 });
  }
  // 글자 수만큼, 뒤쪽 것부터 (수식 뒤 조사가 흔하고, 첨자 붙은 "a₂" 가 한글처럼 보이기도 함)
  const ok = groups.filter((g) => bh(g) >= 0.8 * h && bh(g) <= 1.25 * h && bw(g) >= 0.6 * h).slice(-(u.n || 1));
  return ok.length ? { x0: Math.min(...ok.map((g) => g.x0)), x1: Math.max(...ok.map((g) => g.x1)) } : null;
}

/**
 * check 가 달린 한글을 잉크로 다시 봄: 그 자리 잉크의 위·아래 끝이 같은 줄의 다른 한글과 맞아야 함
 * (첨자가 붙은 "g₂"·분수·Σ 는 위나 아래로 삐져나옴)
 */
function verifyByInk(texts, comps, bands, h) {
  const inkOf = (u, b) => {
    const cs = comps.filter((c) => !c.kind && cx(c) >= u.x0 && cx(c) <= u.x1 && cy(c) >= b.y0 && cy(c) < b.y1);
    return cs.length ? cs.reduce((a, c) => union(a, c), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }) : null;
  };
  return texts.filter((u) => {
    if (u.kind !== 'hangul' || !u.check) return true;
    const b = bands.find((x) => cy(u) >= x.y0 && cy(u) < x.y1);
    if (!b) return false;
    const refs = texts.filter((v) => v.kind === 'hangul' && !v.check && cy(v) >= b.y0 && cy(v) < b.y1).map((v) => inkOf(v, b)).filter(Boolean);
    const ink = inkOf(u, b);
    if (!ink) return false;
    if (bh(ink) < 0.55 * h || bh(ink) > 1.3 * h) return false;
    if (!refs.length) return true;
    const top = median(refs.map((r) => r.y0));
    const bot = median(refs.map((r) => r.y1));
    return Math.abs(ink.y0 - top) <= 0.2 * h && Math.abs(ink.y1 - bot) <= 0.2 * h;
  });
}

// ---------------------------------------------------------------------------
// 그림 (그래프·도형)
// ---------------------------------------------------------------------------
/**
 * 큰 잉크 덩어리(가로나 세로 > 3h)를 겹치는 것끼리 묶고, 그 안팎에 붙은 작은 글자(눈금·이름표)를 흡수
 * 글을 둘러싼 네모 틀(<보기> 상자)이나 긴 가로·세로 줄 하나는 그림이 아님
 * @returns {{box, comps:Set<number>}[]}
 */
export function findFigures(comps, h, { isFrame = () => false, isText = () => false } = {}) {
  const big = comps.filter((c) => {
    if (c.kind) return false;
    const w = bw(c);
    const hh = bh(c);
    if (Math.max(w, hh) <= T.figureExtent * h) return false;
    if (hh < 0.3 * h || w < 0.3 * h) return false; // 긴 줄 하나
    return !isFrame(c);
  });
  // 겹치는 큰 덩어리 묶기
  let groups = big.map((c) => ({ box: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }, comps: new Set([c.id]) }));
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < groups.length && !changed; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (meets(grow(groups[i].box, 0.5 * h), groups[j].box)) {
          groups[i].box = union(groups[i].box, groups[j].box);
          for (const id of groups[j].comps) groups[i].comps.add(id);
          groups.splice(j, 1);
          changed = true;
          break;
        }
      }
    }
  }
  groups = groups.filter((g) => bw(g.box) >= 2 * h && bh(g.box) >= 2 * h);
  // 안에 든 것과 바로 옆에 붙은 작은 것(눈금 숫자·점선·이름표) 흡수
  const taken = new Set(groups.flatMap((g) => [...g.comps]));
  for (const g of groups) {
    const core = { ...g.box };
    for (let round = 0; round < 4; round++) {
      let added = 0;
      const zone = grow(g.box, 0.35 * h);
      for (const c of comps) {
        if (taken.has(c.id) || c.kind === 'noise' || c.kind === 'frame') continue;
        const inside = overlapArea(c, core) >= 0.6 * Math.max(1, bw(c) * bh(c));
        const small = bh(c) < 2 * h && bw(c) < 4 * h;
        if (inside || (small && meets(c, zone) && !isText(c))) {
          g.comps.add(c.id);
          taken.add(c.id);
          g.box = union(g.box, c);
          added++;
        }
      }
      if (!added) break;
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// 줄
// ---------------------------------------------------------------------------
/**
 * 줄 띠 찾기: 덩어리들이 차지하는 행을 모아, 좁은 틈(분수의 분자·분모, 첨자)은 잇고
 * 너무 얇은 띠(따로 떨어진 첨자 등)는 가까운 줄에 붙임. cuts(영역 경계 y)는 넘지 않음
 * @returns {{y0, y1}[]}
 */
export function lineBands(boxes, H, h, cuts = []) {
  const cover = new Uint8Array(H + 1);
  for (const b of boxes) for (let y = Math.max(0, b.y0); y < Math.min(H, b.y1); y++) cover[y] = 1;
  let bands = [];
  for (let y = 0; y < H; ) {
    if (!cover[y]) {
      y++;
      continue;
    }
    let e = y;
    while (e < H && cover[e]) e++;
    bands.push({ y0: y, y1: e });
    y = e;
  }
  const cutBetween = (a, b) => cuts.some((c) => c >= a.y1 && c <= b.y0);
  const merged = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b.y0 - last.y1 < T.bandGap * h && !cutBetween(last, b)) last.y1 = b.y1;
    else merged.push({ ...b });
  }
  bands = merged;
  // 얇은 띠는 가까운 이웃 줄로
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (bh(b) >= T.smallBand * h) continue;
      const prev = bands[i - 1];
      const next = bands[i + 1];
      const gp = prev && !cutBetween(prev, b) ? b.y0 - prev.y1 : Infinity;
      const gn = next && !cutBetween(b, next) ? next.y0 - b.y1 : Infinity;
      if (Math.min(gp, gn) > T.smallBandGap * h) continue;
      if (gp <= gn) {
        prev.y1 = b.y1;
        bands.splice(i, 1);
      } else {
        next.y0 = b.y0;
        bands.splice(i, 1);
      }
      changed = true;
      break;
    }
  }
  return bands;
}

// ---------------------------------------------------------------------------
// 보기 번호 ①~⑤
// ---------------------------------------------------------------------------
/**
 * 동그라미 번호: 거의 정사각형인 고리 안에 숫자 덩어리가 들어 있음
 * @returns {Set<number>} 동그라미(고리) 덩어리 id. 안의 숫자는 inner 에 모음
 */
export function circledMarkers(comps, h, inner = new Map(), isRing = () => true) {
  const out = new Set();
  for (const c of comps) {
    const w = bw(c);
    const hh = bh(c);
    if (hh < 0.6 * h || hh > 1.4 * h || w / hh < 0.75 || w / hh > 1.33) continue;
    if (c.n > 0.5 * w * hh) continue; // 속이 찬 것은 고리가 아님
    if (!isRing(c)) continue; // √ 도 숫자를 품지만 오른쪽·아래가 비어 있음
    const kids = comps.filter((k) => k !== c && k.x0 >= c.x0 && k.x1 <= c.x1 && k.y0 >= c.y0 && k.y1 <= c.y1 && bh(k) >= 0.25 * hh && bh(k) <= 0.8 * hh);
    if (!kids.length) continue;
    out.add(c.id);
    inner.set(c.id, kids.map((k) => k.id));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 줄 안: 글 / 수식
// ---------------------------------------------------------------------------
/**
 * 한 줄(또는 보기 하나)의 덩어리를 글 덩어리와 수식 덩어리로 나누고, 글 사이의 수식 덩어리를 수식 상자로 묶음
 * @param comps 이 범위의 덩어리 (뺄 것은 뺀 뒤)
 * @param texts 이 범위의 글 글자 (textSymbols)
 * @returns {{tokens: ({t:'text', s, x0, x1}|{t:'math', box, comps:number[]})[]}} x 순서
 */
export function splitLine(comps, texts, h) {
  const unitOf = new Map(); // 덩어리 → 그것을 덮는 글 글자
  for (const c of comps) {
    if (bh(c) > 1.4 * h) continue;
    const s = texts.find((t) => cx(c) >= t.x0 - 0.05 * h && cx(c) <= t.x1 + 0.05 * h && cy(c) >= t.y0 - 0.3 * h && cy(c) <= t.y1 + 0.3 * h);
    if (s) unitOf.set(c, s);
  }
  // 수식 바로 뒤 한글 상자가 수식의 위·아래 첨자(x⁵의, a₂ₖ의)까지 덮는 일이 잦음:
  // 한글 상자 왼쪽 끝의 작은 덩어리가 위나 아래에 붙어 있고, 같은 글자의 다른 획과 겹치지 않고, 왼쪽이 수식이면 수식으로
  for (const s of new Set(unitOf.values())) {
    if (s.kind !== 'hangul') continue;
    const own = comps.filter((c) => unitOf.get(c) === s).sort((a, b) => a.x0 - b.x0);
    const tall = own.filter((c) => bh(c) >= 0.5 * h);
    if (!tall.length) continue;
    const top = Math.min(...tall.map((c) => c.y0));
    const bot = Math.max(...tall.map((c) => c.y1));
    for (const c of own) {
      if (tall.includes(c) || bh(c) >= 0.55 * h) break;
      const script = c.y1 < top + 0.55 * (bot - top) || c.y0 > top + 0.5 * (bot - top);
      const overlaps = own.some((o) => o !== c && Math.min(o.x1, c.x1) - Math.max(o.x0, c.x0) > 0.3 * bw(c));
      const left = comps.filter((o) => o.x1 <= c.x0 + 0.1 * h && c.x0 - o.x1 < 0.6 * h).sort((a, b) => b.x1 - a.x1)[0];
      if (!script || overlaps || !left || unitOf.has(left)) break;
      unitOf.delete(c);
    }
  }
  const math = comps.filter((c) => !unitOf.has(c)).sort((a, b) => a.x0 - b.x0);
  const runs = [];
  for (const c of math) {
    const run = runs[runs.length - 1];
    const textBetween = run && texts.some((s) => cx(s) > run.box.x1 - 0.1 * h && cx(s) < c.x0 + 0.1 * h && s.x0 >= run.box.x1 - 0.2 * h);
    if (run && (c.x0 < run.box.x1 || (!textBetween && c.x0 - run.box.x1 < T.splitGap * h))) {
      run.box = union(run.box, c);
      run.comps.push(c);
    } else runs.push({ box: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }, comps: [c] });
  }
  const tokens = [];
  const extraText = [];
  const textComps = comps.filter((c) => unitOf.has(c));
  for (const r of runs) {
    // OCR 글자 상자가 어긋나 한글 한 글자의 일부(식의 ㅣ, 가의 ㅏ, 상의 ㅅ)만 남은 것: 한글 잉크에 바짝 붙은 좁은 조각
    if (bw(r.box) < 0.6 * h && r.comps.length <= 2) {
      const before = textComps.filter((c) => c.x1 <= r.box.x0 + 0.05 * h && r.box.x0 - c.x1 < 0.15 * h && Math.abs(cy(c) - cy(r.box)) < 0.5 * h);
      const after = textComps.filter((c) => c.x0 >= r.box.x1 - 0.05 * h && c.x0 - r.box.x1 < 0.12 * h && Math.abs(cy(c) - cy(r.box)) < 0.5 * h);
      const ref = [...before, ...after];
      const within = ref.length && r.box.y0 >= Math.min(...ref.map((c) => c.y0)) - 0.1 * h && r.box.y1 <= Math.max(...ref.map((c) => c.y1)) + 0.1 * h;
      // 뒤에 붙은 조각은 그냥 글, 앞에 붙은 조각은 키가 한글만 할 때만 (수식 뒤 조사 "c에" 의 c 는 낮음)
      if (within && (before.length || bh(r.box) >= 0.92 * h)) continue;
    }
    const tiny = r.comps.every((c) => Math.max(bw(c), bh(c)) < 0.3 * h);
    if (tiny) {
      // 한글 바로 뒤의 점·쉼표 (OCR 이 놓친 것)
      const prev = texts.filter((s) => s.x1 <= r.box.x0 + 0.1 * h).pop();
      if (prev && r.box.x0 - prev.x1 < 0.5 * h && r.box.y1 > prev.y1 - 0.4 * h) extraText.push({ str: bh(r.box) > 1.3 * bw(r.box) ? ',' : '.', x0: r.box.x0, x1: r.box.x1, y0: r.box.y0, y1: r.box.y1 });
      continue;
    }
    // 긴 가로줄 하나 (밑줄·구분선)
    if (r.comps.length === 1 && bh(r.box) < 0.25 * h && bw(r.box) > 2 * h) continue;
    // "(단," 의 "(" 를 OCR 이 놓친 경우 (괄호 하나가 "단" 바로 앞에)
    if (r.comps.length === 1 && bh(r.box) >= 0.85 * h && bh(r.box) <= 1.5 * h && bw(r.box) <= 0.4 * h) {
      const right = texts.find((s) => s.x0 >= r.box.x1 - 0.1 * h && s.x0 - r.box.x1 < 0.8 * h);
      if (right && /^단/.test(right.str)) {
        extraText.push({ str: '(', kind: 'punct', ...r.box });
        continue;
      }
    }
    tokens.push({ t: 'math', box: r.box, comps: r.comps.map((c) => c.id) });
  }
  // 글 글자는 사이에 수식이 없으면 이어 붙임 (틈이 넓으면 띄어쓰기)
  const pieces = [...tokens, ...[...texts, ...extraText].map((s) => ({ t: 'sym', s }))].sort((a, b) => (a.t === 'math' ? a.box.x0 : a.s.x0) - (b.t === 'math' ? b.box.x0 : b.s.x0));
  // 띄어쓰기는 잉크 사이 틈으로 (OCR 글자 상자는 옆 글자 쪽으로 밀려 있곤 함: "차" 의 ㅊ, "은" 의 ㅡ)
  const inkX = new Map();
  for (const [c, s] of unitOf) {
    const e = inkX.get(s);
    inkX.set(s, e ? { x0: Math.min(e.x0, c.x0), x1: Math.max(e.x1, c.x1) } : { x0: c.x0, x1: c.x1 });
  }
  const out = [];
  let prev = null;
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (p.t === 'math') out.push(p);
    else if (last?.t === 'text') {
      const gap = (inkX.get(p.s) || p.s).x0 - (inkX.get(prev) || prev).x1;
      const sep = gap > T.spaceGap * h && !PUNCT_AFTER.test(p.s.str) && !PUNCT_BEFORE.test(last.s.slice(-1)) ? ' ' : '';
      const offset = last.s.length + sep.length;
      const low = textLow(p.s).map((mark) => ({ ...mark, start: mark.start + offset, end: mark.end + offset }));
      if (low.length) last.low = [...(last.low || []), ...low];
      last.s += sep + p.s.str;
      last.x1 = Math.max(last.x1, p.s.x1);
    } else {
      const low = textLow(p.s);
      out.push({ t: 'text', s: p.s.str, x0: p.s.x0, x1: p.s.x1, ...(low.length ? { low } : {}) });
    }
    if (p.t !== 'math') prev = p.s;
  }
  return { tokens: out };
}

// ---------------------------------------------------------------------------
// 문항 하나 분석
// ---------------------------------------------------------------------------
/**
 * 문항 그림 → 줄·그림·수식 상자 계획
 * @param img {data: RGBA, width, height}
 * @param passes [{words, kor?}]  recognizeWords(.., {symbols: true}) 결과. kor: 한국어만으로 읽은 것
 * @param opts
 *   number    문항 번호 (첫 줄의 번호를 뺌 — 색으로 못 거를 때)
 *   segments  [{y, h, stem}] 그림에 쌓인 영역 (공통 지문 + 문항). 영역이 바뀌면 문단을 나눔
 * @returns plan {W, H, h, labels, comps, figures, lines, formulas, textConf}
 *   lines: {kind:'text'|'choice', y0, y1, x0, x1, seg, tokens? | items?}
 *   formulas: {box, comps}[] — tokens 의 {t:'math', f} 가 가리킴
 */
export function planScan(img, passes, { number = '', segments = [] } = {}) {
  const { width: W, height: H } = img;
  const { ink, chroma } = toInk(img);
  const { labels, comps } = components(ink, W, H, chroma);
  // 한글이 거의 없으면 덩어리 높이로 어림 (숫자·영문은 한글의 0.7 정도)
  const tall = comps.filter((c) => c.n >= 30 && bh(c) >= 12 && bh(c) <= 200).map(bh);
  const h = Math.max(12, textHeight(passes, tall.length ? median(tall) * 1.35 : 40));
  const segs = segments.length ? segments : [{ y: 0, h: H, stem: false }];
  const segOf = (y) => Math.max(0, segs.findIndex((s) => y >= s.y - 6 && y < s.y + s.h + 6));
  for (const c of comps) if (c.n < T.noiseArea * h * h) c.kind = 'noise';
  let texts = textSymbols(passes, h, comps);

  // 덩어리 종류: noise(티끌) · frame(네모 틀) · rule(세로줄) · figure · color(색 글자) · number(문항 번호)
  for (const c of comps) {
    const w = bw(c);
    const hh = bh(c);
    if (c.n < T.noiseArea * h * h) c.kind = 'noise';
    else if (w < 0.3 * h && hh > T.figureExtent * h) c.kind = 'rule';
    else if (w > T.figureExtent * h && hh > 1.5 * h && borderFraction(c, labels, W, Math.max(3, Math.round(0.08 * h))) >= 0.85) c.kind = 'frame';
  }
  const inText = (c) => texts.some((s) => s.kind === 'hangul' && cx(c) >= s.x0 && cx(c) <= s.x1 && cy(c) >= s.y0 && cy(c) <= s.y1);
  const figures = findFigures(comps, h, { isText: inText });
  for (const f of figures) for (const id of f.comps) comps[id].kind = 'figure';
  for (const c of comps) if (!c.kind && c.chroma >= T.colorChroma) c.kind = 'color';
  // 그림 안의 글자는 본문이 아님
  const inFigure = (b) => figures.some((f) => cx(b) >= f.box.x0 && cx(b) <= f.box.x1 && cy(b) >= f.box.y0 && cy(b) <= f.box.y1);
  texts = texts.filter((s) => !inFigure(s));

  const cuts = segs.slice(1).map((s) => s.y - 6);
  const live = () => comps.filter((c) => !c.kind);
  let bands = lineBands(live(), H, h, cuts);

  // 첫 줄의 문항 번호·지문 범위 표시 (흑백 스캔이라 색으로 못 거른 경우)
  const words = passes.flatMap((p) => p.words || []);
  const digits = String(number).replace(/\D/g, '');
  segs.forEach((sg, k) => {
    // 쪽 머리말이 문항 영역에 딸려 오기도 해서 앞의 세 줄까지 봄
    for (const first of bands.filter((b) => segOf(cy(b)) === k).slice(0, 3)) {
    for (const w of words) {
      if (cy(w) < first.y0 || cy(w) > first.y1) continue;
      const str = w.str.replace(/\s/g, '');
      // 한 자리 번호는 그 줄 맨 앞 단어일 때만 (본문 숫자와 헷갈리지 않게)
      const leftmost = !words.some((o) => o !== w && cy(o) >= first.y0 && cy(o) <= first.y1 && o.x1 <= w.x0 + 2);
      const isNum = !sg.stem && (digits.length >= 2 || (digits.length === 1 && leftmost)) && str.replace(/\D/g, '') === digits && /^\D?\d+\D?$/.test(str);
      const isRange = sg.stem && /^[[(（［【]?\d{2,}[~∼～\-–]\d{2,}[\])）］】]?$/.test(str);
      if (!isNum && !isRange) continue;
      if (w.x0 > W * 0.3) continue; // 줄 앞쪽만
      for (const c of comps) if (!c.kind && cx(c) >= w.x0 - 2 && cx(c) <= w.x1 + 2 && cy(c) >= first.y0 && cy(c) <= first.y1) c.kind = 'number';
    }
    }
  });
  // 작은 글씨 줄(쪽 머리말 "정답 및 풀이 84쪽" 같은 것)은 문항 내용이 아님
  for (const b of bands) {
    const hs = words.filter((w) => w.conf >= 85).flatMap((w) => w.symbols || []).filter((s) => HANGUL.test(s.str) && s.conf >= 90 && cy(s) >= b.y0 && cy(s) < b.y1).map(bh);
    if (hs.length >= 2 && median(hs) < 0.72 * h) for (const c of comps) if (!c.kind && cy(c) >= b.y0 && cy(c) < b.y1) c.kind = 'small';
  }
  texts = texts.filter((t) => !comps.some((c) => c.kind === 'small' && meets(c, t)));
  bands = lineBands(live(), H, h, cuts);
  texts = verifyByInk(texts, comps, bands, h);

  // 줄마다: 보기 줄이면 번호 사이를 보기 하나씩, 아니면 글 사이 수식을 묶음
  const formulas = [];
  const addMath = (tokens) =>
    tokens.map((t) => {
      if (t.t !== 'math') return t;
      formulas.push({ box: t.box, comps: t.comps });
      return { t: 'math', f: formulas.length - 1, box: t.box };
    });
  const lines = [];
  for (const b of bands) {
    const inBand = (o) => cy(o) >= b.y0 && cy(o) < b.y1;
    const bc = live().filter(inBand);
    if (!bc.length) continue;
    const bt = texts.filter(inBand);
    const box = bc.reduce((a, c) => union(a, c), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const inner = new Map();
    const marks = [...circledMarkers(bc, h, inner, ringTest(labels, W))].map((id) => comps[id]).sort((a, b) => a.x0 - b.x0);
    const line = { y0: b.y0, y1: b.y1, x0: box.x0, x1: box.x1, seg: segOf(cy(b)) };
    if (marks.length && marks[0].x0 <= box.x0 + 0.5 * h) {
      const skip = new Set(marks.flatMap((m) => [m.id, ...inner.get(m.id)]));
      line.kind = 'choice';
      line.items = marks.map((m, i) => {
        const end = marks[i + 1]?.x0 ?? Infinity;
        const within = (o) => cx(o) > m.x1 && cx(o) < end;
        return addMath(splitLine(bc.filter((c) => !skip.has(c.id) && within(c)), bt.filter(within), h).tokens);
      });
    } else {
      line.kind = 'text';
      line.tokens = addMath(splitLine(bc, bt, h).tokens);
      if (!line.tokens.length) continue;
    }
    lines.push(line);
  }

  // 한글 OCR 확신도 (한글 크기 글자 평균) — 낮으면 믿기 어려운 문항
  const hs = passes.flatMap((p) => (p.words || []).flatMap((w) => w.symbols || [])).filter((s) => HANGUL.test(s.str) && bh(s) >= T.hangulMinH * h && bh(s) <= T.hangulMaxH * h && !inFigure(s));
  const textConf = hs.length ? hs.reduce((a, s) => a + s.conf, 0) / hs.length : 100;
  return {
    W,
    H,
    h,
    labels,
    comps,
    figures: figures.map((f) => ({ box: grow(f.box, Math.round(0.15 * h)) })),
    lines,
    formulas,
    textConf,
    hangul: texts.filter((s) => s.kind === 'hangul').length,
  };
}

/**
 * 수식 상자 하나를 잘라 RGBA 로 (둘레 흰 여백, 상자 안의 다른 덩어리는 지움)
 * @returns {{data: Uint8ClampedArray, width, height}}
 */
export function cropFormula(img, plan, f) {
  const { W, H, labels } = plan;
  const pad = Math.max(4, Math.round(T.pad * plan.h));
  const own = new Set(f.comps.map((id) => id + 1));
  const x0 = Math.max(0, f.box.x0 - 2);
  const y0 = Math.max(0, f.box.y0 - 2);
  const x1 = Math.min(W, f.box.x1 + 2);
  const y1 = Math.min(H, f.box.y1 + 2);
  const width = x1 - x0 + 2 * pad;
  const height = y1 - y0 + 2 * pad;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      const l = labels[i];
      if (l && !own.has(l)) continue; // 다른 덩어리 → 흰색
      const o = ((y - y0 + pad) * width + (x - x0 + pad)) * 4;
      data[o] = img.data[i * 4];
      data[o + 1] = img.data[i * 4 + 1];
      data[o + 2] = img.data[i * 4 + 2];
    }
  }
  return { data, width, height };
}

// ---------------------------------------------------------------------------
// 블록 만들기 (인식한 LaTeX 를 넣어서)
// ---------------------------------------------------------------------------
const WORD_END = new Set([...'은는을를의에와과로며면때']); // 줄 끝 글자가 이것이면 다음 줄과 띄어 씀
const PARTICLE = new Set([...'의에은는이가을를와과도로으만']); // 수식 바로 뒤에 붙는 조사

/** 짝이 안 맞는 괄호·끝 쉼표를 수식 밖 글로 (수식 상자에 "(단, a>0)" 의 ")" 가 딸려 오는 경우) */
export function trimLatex(latex) {
  let s = String(latex || '').trim();
  let before = '';
  let after = '';
  const count = (str, ch) => str.replace(/\\(?:left|right)\s*[()]/g, '').split(ch).length - 1;
  for (let k = 0; k < 4; k++) {
    const m = /^(.*?)(?:\\[,;!: ]|\s)*([,.)])$/.exec(s);
    if (m && (m[2] !== ')' || count(s, ')') > count(s, '('))) {
      after = m[2] + after;
      s = m[1].trim();
      continue;
    }
    if (s.startsWith('(') && count(s, '(') > count(s, ')')) {
      before += '(';
      s = s.slice(1).trim();
      continue;
    }
    break;
  }
  return { before, latex: s, after };
}

/**
 * 계획 + 수식 LaTeX → transcribe 블록 [{type:'para', text} | {type:'choices', items} | {type:'figure', box}]
 * @param latexOf(i) → LaTeX 문자열 (못 읽었으면 '' / null — 그 수식은 빠짐)
 */
export function assembleBlocks(plan, latexOf, results = []) {
  const { h, W, H } = plan;
  const mathText = (t) => {
    const raw = latexOf(t.f);
    if (!raw) return null;
    const { before, latex, after } = trimLatex(raw);
    return latex ? `${before}$${latex}$${after}` : `${before}${after}`;
  };
  /** 토큰들 → 한 줄 글 (수식은 $…$) */
  const lineText = (tokens) => {
    let s = '';
    let low = [];
    let prev = null;
    for (const t of tokens) {
      const piece = t.t === 'math' ? mathText(t) : t.s;
      if (piece == null || piece === '') continue;
      const x0 = t.t === 'math' ? t.box.x0 : t.x0;
      if (prev) {
        const gap = x0 - prev.x1;
        const glue = t.t === 'text' && (PUNCT_AFTER.test(piece[0]) || (prev.t === 'math' && PARTICLE.has(piece[0]) && gap < 0.45 * h));
        // 쉼표 뒤 수식은 붙어 보여도 띄움 ("(단, a>0)")
        if (!glue && (gap > T.spaceGap * h || (t.t === 'math' && /,$/.test(s)))) s += ' ';
      }
      const offset = s.length;
      if (t.t === 'math') {
        const mark = mathLow(results[t.f]?.conf);
        if (mark && piece.includes('$')) low.push({ ...mark, start: offset + piece.indexOf('$'), end: offset + piece.lastIndexOf('$') + 1, box: relativeBox(t.box, W, H) });
      } else {
        low.push(...(t.low || []).map((mark) => ({ ...mark, start: offset + mark.start, end: offset + mark.end, box: relativeBox(mark.box, W, H) })));
      }
      s += piece;
      prev = { t: t.t, x1: t.t === 'math' ? t.box.x1 : t.x1 };
    }
    const trim = s.length - s.trimStart().length;
    const text = s.trim();
    low = low.map((mark) => ({ ...mark, start: Math.max(0, mark.start - trim), end: Math.min(text.length, mark.end - trim) })).filter((mark) => mark.end > mark.start);
    return { text, low };
  };

  // 줄 오른쪽 끝: 오른쪽에 그림이 있으면 그림 앞까지, 아니면 영역의 가장 긴 줄
  const maxRight = new Map();
  for (const l of plan.lines) maxRight.set(l.seg, Math.max(maxRight.get(l.seg) || 0, l.x1));
  const availRight = (l) => {
    const fig = plan.figures.find((f) => f.box.y0 < l.y1 && f.box.y1 > l.y0 && f.box.x0 >= l.x1 - h);
    return fig ? fig.box.x0 : maxRight.get(l.seg);
  };

  // 줄·그림을 위에서부터: 그림은 그 그림 아래끝보다 위에 있는 줄들 뒤에
  const elems = [...plan.lines.map((l) => ({ kind: l.kind, y: cy(l), l })), ...plan.figures.map((f) => ({ kind: 'figure', y: f.box.y1 - 0.5 * h, f }))].sort((a, b) => a.y - b.y);
  const blocks = [];
  let para = null; // {text, line, cond}
  let choices = null;
  let choiceLow = [];
  let figs = []; // 문단 도중에 끝나는 그림 (옆에 놓인 그림): 문장을 끊지 않게 그 문단 뒤에
  const flush = () => {
    if (para?.text) blocks.push({ type: 'para', text: para.text, ...(para.low.length ? { low: para.low } : {}) });
    para = null;
    blocks.push(...figs);
    figs = [];
  };
  const flushChoices = () => {
    if (choices?.length) blocks.push({ type: 'choices', items: choices, ...(choiceLow.length ? { low: choiceLow } : {}) });
    choices = null;
    choiceLow = [];
  };
  for (const e of elems) {
    if (e.kind === 'figure') {
      flushChoices();
      const b = e.f.box;
      const x0 = clamp(b.x0, 0, W);
      const y0 = clamp(b.y0, 0, H);
      figs.push({ type: 'figure', box: { x: x0 / W, y: y0 / H, w: (clamp(b.x1, 0, W) - x0) / W, h: (clamp(b.y1, 0, H) - y0) / H } });
      if (!para) flush();
      continue;
    }
    const l = e.l;
    if (e.kind === 'choice') {
      flush();
      choices ||= [];
      for (const it of l.items) {
        const line = lineText(it);
        choiceLow.push(...line.low.map((mark) => ({ ...mark, item: choices.length })));
        choices.push(line.text);
      }
      continue;
    }
    flushChoices();
    const { text, low } = lineText(l.tokens);
    if (!text) continue;
    const first = l.tokens[0];
    const cond = first.t === 'text' && /^\(\s*단\s*[,.]?/.test(first.s);
    const jamo = first.t === 'text' && /^[ㄱ-ㅎ]\s*[.)]/.test(first.s);
    const prev = para?.line;
    const newPara = !para || prev.seg !== l.seg || cond || jamo || para.cond || prev.x1 < availRight(prev) - 1.5 * h;
    if (newPara) {
      flush();
      para = { text, low, line: l, cond };
      continue;
    }
    // 줄바꿈 잇기: 끝·첫 글자에 따라 띄어쓰기
    const endsHangul = /[가-힣]$/.test(para.text);
    const startsHangul = /^[가-힣]/.test(text);
    const lastTok = prev.tokens[prev.tokens.length - 1];
    let sep = ' ';
    if (endsHangul && startsHangul) sep = WORD_END.has(para.text.slice(-1)) ? ' ' : '';
    else if (lastTok?.t === 'math' && startsHangul && PARTICLE.has(text[0])) sep = '';
    const offset = para.text.length + sep.length;
    para.low.push(...low.map((mark) => ({ ...mark, start: mark.start + offset, end: mark.end + offset })));
    para.text += sep + text;
    para.line = l;
  }
  flush();
  flushChoices();
  return blocks;
}

// ---------------------------------------------------------------------------
// 믿을 만한지 ('섞어서'에서 AI 에게 다시 맡길 문항 고르기)
// ---------------------------------------------------------------------------
/** { } 짝이 맞는지 (\{ \} 는 글자) */
function bracesBalanced(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

/** 수식이라기보다 한글 조각을 읽은 것 같은 결과: 글자·숫자 없는 기호 하나(\sharp, *, \Uparrow), 글꼴 바꾼 글자 하나(\mathbb{A}) */
const GREEK_OK = /^\\(?:pi|theta|alpha|beta|gamma|omega|infty|cdots|ldots)$/;
function strayGlyph(s) {
  const t = s.replace(/\s+/g, '');
  if (/^\\math(?:bb|sf|cal|frak|scr|bf|rm|tt)\{+\\?[A-Za-z]?\}+$/.test(t)) return true;
  if (GREEK_OK.test(t)) return false;
  return t.length > 0 && t.length <= 12 && !/[A-Za-z0-9]/.test(t.replace(/\\[A-Za-z]+/g, ''));
}
/** 밑·지수 뒤에 아무것도 없는 log·sin (작은 첨자를 놓친 것: "\log_{5}-", "\log,5", 끝이 "\log_{5}") */
const NO_ARG = /\\(?:log|ln|sin|cos|tan)(?:_\{[^{}]*\}|_[A-Za-z0-9])?(?:\^\{[^{}]*\})?\s*(?:[-+=,)\]]|\\cdot|$)/;

/**
 * 문항 하나의 결과가 미덥지 않은 까닭들 (없으면 빈 배열)
 *  - 수식 확신도가 낮음 (토큰 확률 기하평균·최솟값) · 인식 오류
 *  - 찌꺼기 같은 결과: 상자 크기에 비해 너무 김, \begin{matrix} 범벅, 정리한 뒤에도 { } 짝이 안 맞음, 비어 버림,
 *    글자·숫자 없는 기호 하나나 글꼴 바꾼 글자 하나 (한글 조각을 수식으로 읽은 것: ㄴ → \mathsf{L}, ㅊ → \dagger)
 *  - 한글 OCR 확신도가 낮음
 * @param results 수식 인식 결과 [{latex, conf:{mean,min,n}}] (plan.formulas 순서)
 * @param latex   normalizeLatex 한 LaTeX (같은 순서)
 */
export function judgeScan(plan, results, latex) {
  const reasons = [];
  plan.formulas.forEach((f, i) => {
    const r = results[i];
    const s = latex[i] || '';
    const name = `수식 ${i + 1}`;
    if (!r || r.error) {
      reasons.push(`${name}: 인식 오류`);
      return;
    }
    if (r.conf && (r.conf.mean < T.confMean || r.conf.min < T.confMin)) reasons.push(`${name}: 확신도 낮음`);
    if (!s.trim()) reasons.push(`${name}: 읽은 것이 없음`);
    else if (s.length > 30 + 10 * (bw(f.box) / plan.h)) reasons.push(`${name}: 너무 긺`);
    else if (/\\begin\{(?:matrix|array|aligned|cases)\}/.test(s) && bh(f.box) < 2.2 * plan.h) reasons.push(`${name}: 행렬 찌꺼기`);
    else if (!bracesBalanced(s)) reasons.push(`${name}: 괄호 짝이 안 맞음`);
    else if (strayGlyph(s)) reasons.push(`${name}: 이상한 기호`);
    else if (/(.{8,})\1/.test(s)) reasons.push(`${name}: 같은 것 되풀이`);
    else if (NO_ARG.test(s)) reasons.push(`${name}: 함수 뒤가 비어 있음`);
  });
  if (plan.textConf < T.textConf) reasons.push('한글 OCR 확신도 낮음');
  return reasons;
}
