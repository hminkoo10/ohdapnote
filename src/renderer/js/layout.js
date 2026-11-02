// 페이지 이미지의 "잉크"(어두운 픽셀) 분포로 레이아웃을 분석합니다.
//  - 머리말/꼬리말(쪽번호 등) 띠
//  - 단(column) 구분
//  - 영역 안의 실제 내용 경계(여백 잘라내기)
// 순수 함수들이라 Node 에서도 테스트할 수 있습니다.

export const GRID_W = 240;

/**
 * RGBA 픽셀 → 잉크 격자(grid). 셀 하나가 여러 픽셀을 묶습니다.
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} [gridW]
 * @returns {{w:number,h:number,data:Uint8Array}}
 */
export function inkGridFromRgba(rgba, width, height, gridW = GRID_W, darkThreshold = 175) {
  const gw = Math.min(gridW, width);
  const cell = width / gw;
  const gh = Math.max(1, Math.round(height / cell));
  const counts = new Uint16Array(gw * gh);
  const faintCounts = new Uint16Array(gw * gh);
  const faintThreshold = faintThresholdOf(rgba, darkThreshold);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / cell));
    const rowBase = gy * gw;
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      // 휘도 (투명 픽셀은 흰색으로 간주)
      const a = rgba[i + 3];
      if (a < 128) continue;
      const lum = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
      if (lum < faintThreshold) {
        const k = rowBase + Math.min(gw - 1, Math.floor(x / cell));
        faintCounts[k]++;
        if (lum < darkThreshold) counts[k]++;
      }
    }
  }
  const area = cell * cell;
  const minCount = Math.max(2, Math.round(area * 0.06));
  const data = new Uint8Array(gw * gh);
  const faint = new Uint8Array(gw * gh);
  for (let k = 0; k < data.length; k++) {
    data[k] = counts[k] >= minCount ? 1 : 0;
    faint[k] = faintCounts[k] >= minCount ? 1 : 0;
  }
  return { w: gw, h: gh, data, lines: thinLines(faint, gw, gh) };
}

/**
 * 연한 선(옅은 회색 상자 테두리 등)을 볼 휘도 기준. 종이 밝기(가장 흔한 밝은 휘도)보다 확실히 어두운 것만.
 * 스캔본은 종이가 회색일 수 있어서 종이 밝기에 맞춰 낮춤. 종이가 너무 어두우면 연한 선은 보지 않음
 */
function faintThresholdOf(rgba, darkThreshold) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < rgba.length; i += 4 * 7) {
    if (rgba[i + 3] < 128) hist[255]++;
    else hist[Math.round((rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000)]++;
  }
  let paper = 255;
  let best = -1;
  for (let v = 200; v < 256; v++) {
    if (hist[v] > best) {
      best = hist[v];
      paper = v;
    }
  }
  return Math.max(darkThreshold, Math.min(236, paper - 16));
}

/**
 * 연한 칸 중 가늘고 긴 가로·세로 선만 (상자 테두리, 구분선). 넓게 칠한 바탕·글자는 빼려고
 * 선 두 칸 위·아래(세로선은 좌·우)가 대부분 비어 있어야 함. 값: 1 가로선, 2 세로선 (겹치면 3)
 */
function thinLines(faint, w, h) {
  const out = new Uint8Array(w * h);
  const minH = Math.max(6, Math.round(w * 0.04));
  const minV = Math.max(6, Math.round(h * 0.03));
  const at = (x, y) => (x >= 0 && x < w && y >= 0 && y < h ? faint[y * w + x] : 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; ) {
      if (!faint[y * w + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < w && faint[y * w + e]) e++;
      if (e - x >= minH) {
        let up = 0;
        let down = 0;
        for (let k = x; k < e; k++) {
          up += at(k, y - 2);
          down += at(k, y + 2);
        }
        if (up < 0.4 * (e - x) && down < 0.4 * (e - x)) for (let k = x; k < e; k++) out[y * w + k] = 1;
      }
      x = e;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; ) {
      if (!faint[y * w + x]) {
        y++;
        continue;
      }
      let e = y;
      while (e < h && faint[e * w + x]) e++;
      if (e - y >= minV) {
        let left = 0;
        let right = 0;
        for (let k = y; k < e; k++) {
          left += at(x - 2, k);
          right += at(x + 2, k);
        }
        if (left < 0.4 * (e - y) && right < 0.4 * (e - y)) for (let k = y; k < e; k++) out[k * w + x] |= 2;
      }
      y = e;
    }
  }
  return out;
}

/** 선 격자의 이어진 덩어리(8방향)와 덩어리마다의 경계 상자 (격자 칸 단위). 격자마다 한 번만 계산 */
function lineComponents(grid) {
  if (grid._lineComps) return grid._lineComps;
  const { w, h, lines } = grid;
  const label = new Int32Array(w * h);
  const boxes = [null];
  const stack = [];
  for (let k = 0; k < w * h; k++) {
    if (!lines[k] || label[k]) continue;
    const id = boxes.length;
    const b = { x0: w, y0: h, x1: -1, y1: -1 };
    label[k] = id;
    stack.push(k);
    while (stack.length) {
      const q = stack.pop();
      const x = q % w;
      const y = (q - x) / w;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const n = ny * w + nx;
          if (lines[n] && !label[n]) {
            label[n] = id;
            stack.push(n);
          }
        }
      }
    }
    boxes.push(b);
  }
  grid._lineComps = { label, boxes };
  return grid._lineComps;
}

export function inkGridFromCanvas(canvas, gridW = GRID_W) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return inkGridFromRgba(img.data, canvas.width, canvas.height, gridW);
}

function bandsOf(rowInk, minGap = 1) {
  const bands = [];
  let start = -1;
  let lastInk = -10;
  for (let y = 0; y < rowInk.length; y++) {
    if (rowInk[y] > 0) {
      if (start < 0) start = y;
      else if (y - lastInk - 1 > minGap) {
        bands.push({ y0: start, y1: lastInk + 1 });
        start = y;
      }
      lastInk = y;
    }
  }
  if (start >= 0) bands.push({ y0: start, y1: lastInk + 1 });
  return bands;
}

/**
 * 페이지 레이아웃 분석.
 * 결과의 좌표는 모두 비율(0~1).
 */
export function analyzeLayout(grid) {
  const { w, h, data } = grid;
  const lines = grid.lines || new Uint8Array(w * h);
  // 스캔본의 가장자리 검은 테두리 등을 무시하기 위해 가장자리 2% 제외
  const ex = Math.max(1, Math.round(w * 0.02));
  const ey = Math.max(1, Math.round(h * 0.015));
  const inside = (x, y) => !(x < ex || x >= w - ex || y < ey || y >= h - ey);
  const at = (x, y) => (inside(x, y) ? data[y * w + x] : 0);
  // 본문 범위(위아래·좌우 끝)는 연한 상자 테두리까지 봄 (쪽 아래쪽 상자의 밑변이 잘리지 않게)
  const atAny = (x, y) => (inside(x, y) && (data[y * w + x] || lines[y * w + x]) ? 1 : 0);
  // 위아래 범위(머리말·꼬리말 구분)는 가로선만: 쪽 아래까지 내려오는 연한 세로선(단 구분 점선 등)이 꼬리말 위 빈 줄을 메우지 않게
  const atRow = (x, y) => (inside(x, y) && (data[y * w + x] || lines[y * w + x] & 1) ? 1 : 0);

  const rowInk = new Uint16Array(h);
  const rowAny = new Uint16Array(h);
  let total = 0;
  for (let y = 0; y < h; y++) {
    let c = 0;
    let any = 0;
    for (let x = 0; x < w; x++) {
      c += at(x, y);
      any += atRow(x, y);
    }
    rowInk[y] = c;
    rowAny[y] = any;
    total += c;
  }
  const blank = total < w * 0.5;
  const result = {
    blank,
    inkRatio: total / (w * h),
    content: { x0: 0, y0: 0, x1: 1, y1: 1 },
    bodyTop: 0,
    bodyBottom: 1,
    hasHeader: false,
    hasFooter: false,
    columns: [{ x0: 0, x1: 1 }],
    spans: [],
  };
  if (blank) return result;

  const bands = bandsOf(rowAny, 1);
  const gapMin = Math.max(2, Math.round(h * 0.011));

  // 머리말: 위쪽 9% 안에서 끝나고, 아래로 충분한 여백이 있는 띠
  let bodyTopRow = bands[0].y0;
  for (let i = 0; i < bands.length - 1; i++) {
    const b = bands[i];
    if (b.y1 > h * 0.09) break;
    if (bands[i + 1].y0 - b.y1 >= gapMin) {
      bodyTopRow = bands[i + 1].y0;
      result.hasHeader = true;
    }
  }
  // 꼬리말: 아래쪽 9% 안에서 시작하고, 위로 충분한 여백이 있는 띠(쪽번호 등)
  let bodyBottomRow = bands[bands.length - 1].y1;
  for (let i = bands.length - 1; i > 0; i--) {
    const b = bands[i];
    if (b.y0 < h * 0.91) break;
    if (b.y0 - bands[i - 1].y1 >= gapMin) {
      bodyBottomRow = bands[i - 1].y1;
      result.hasFooter = true;
    }
  }
  if (bodyBottomRow <= bodyTopRow) {
    bodyTopRow = bands[0].y0;
    bodyBottomRow = bands[bands.length - 1].y1;
  }

  // 본문 영역의 가로 범위
  // 페이지 폭 절반 이상을 끊김 없이 덮는 줄(단원 제목 띠, 가로선, 넓은 그림)은
  // 단 구분 판단에서 제외합니다(spanning row).
  const spanning = new Uint8Array(h);
  for (let y = bodyTopRow; y < bodyBottomRow; y++) {
    if (rowInk[y] === 0) continue;
    let run = 0;
    let best = 0;
    for (let x = 0; x < w; x++) {
      if (at(x, y)) {
        run++;
        if (run > best) best = run;
      } else run = 0;
    }
    if (best >= 0.55 * w) spanning[y] = 1;
  }
  // 본문 안의 가로 띠(단원 제목 막대 등) — 여러 단 쪽에서 문항 영역을 끊는 데 씀
  result.spans = [];
  for (let y = bodyTopRow; y < bodyBottomRow; ) {
    if (!spanning[y]) {
      y++;
      continue;
    }
    let e = y;
    while (e < bodyBottomRow && spanning[e]) e++;
    result.spans.push({ y0: y / h, y1: e / h }); // 한 줄짜리 가로선도 구분선
    y = e;
  }
  // 쪽 맨 위의 얇은 가로선(머리말 밑줄) 위쪽은 머리말: 머리말 글자("www.ebsi.co.kr")와 선 사이가 좁아 위에서 못 가른 경우
  // (그대로 두면 머리말 조각이 앞 쪽에서 이어지는 해설 영역으로 붙고, 이어지는 해설이 거기서 끊김)
  const firstSpan = result.spans[0];
  if (firstSpan && firstSpan.y0 < 0.08 && firstSpan.y1 - firstSpan.y0 <= 0.012 && firstSpan.y0 - bodyTopRow / h <= 0.03) {
    let next = Math.ceil(firstSpan.y1 * h);
    while (next < bodyBottomRow && rowAny[next] === 0) next++;
    if (bodyBottomRow - next > 0.5 * h) {
      bodyTopRow = next;
      result.hasHeader = true;
      result.spans.shift();
    }
  }
  const colInk = new Uint16Array(w);
  const colInkAll = new Uint16Array(w);
  let bodyRows = 0;
  for (let y = bodyTopRow; y < bodyBottomRow; y++) {
    if (rowAny[y] === 0) continue;
    for (let x = 0; x < w; x++) if (atAny(x, y)) colInkAll[x]++;
    if (rowInk[y] === 0 || spanning[y]) continue;
    bodyRows++;
    for (let x = 0; x < w; x++) if (at(x, y)) colInk[x]++;
  }
  let cx0 = 0;
  while (cx0 < w && colInkAll[cx0] === 0) cx0++;
  let cx1 = w - 1;
  while (cx1 > cx0 && colInkAll[cx1] === 0) cx1--;
  cx1 += 1;
  // 쪽 가장자리의 단원 탭("01 지수" 같은 세로 띠)은 본문이 아님: 바깥 끝의 좁고 세로로 짧은 덩어리가
  // 빈 세로 띠로 본문과 떨어져 있으면 본문 가로 범위에서 뺌 (그대로 두면 옆 문항 영역에 딸려 들어감)
  const bodyH = bodyBottomRow - bodyTopRow;
  const stripRows = (a, b) => {
    let y0 = -1;
    let y1 = -1;
    for (let y = bodyTopRow; y < bodyBottomRow; y++) {
      for (let x = a; x < b; x++) {
        if (atAny(x, y)) {
          if (y0 < 0) y0 = y;
          y1 = y;
          break;
        }
      }
    }
    return y0 < 0 ? 0 : y1 - y0 + 1;
  };
  const isTab = (a, b, gap) => b - a <= Math.round(0.05 * w) && gap >= Math.max(3, Math.round(0.012 * w)) && stripRows(a, b) <= 0.35 * bodyH;
  if (cx1 >= 0.92 * w) {
    let a = cx1 - 1;
    while (a > cx0 && colInkAll[a] > 0) a--;
    let g = a;
    while (g > cx0 && colInkAll[g] === 0) g--;
    if (g + 1 - cx0 >= 0.5 * w && isTab(a + 1, cx1, a - g)) cx1 = g + 1;
  }
  if (cx0 <= 0.08 * w) {
    let b = cx0;
    while (b < cx1 && colInkAll[b] > 0) b++;
    let g = b;
    while (g < cx1 && colInkAll[g] === 0) g++;
    if (cx1 - g >= 0.5 * w && isTab(cx0, b, g - b)) cx0 = g;
  }

  result.content = { x0: cx0 / w, y0: bodyTopRow / h, x1: cx1 / w, y1: bodyBottomRow / h };
  result.bodyTop = bodyTopRow / h;
  result.bodyBottom = bodyBottomRow / h;
  result.columns = [{ x0: cx0 / w, x1: cx1 / w }];
  if (bodyRows < 8) return result;

  // ---- 단 구분(거터) 찾기 ----
  const frac = new Float32Array(w);
  for (let x = 0; x < w; x++) frac[x] = colInk[x] / bodyRows;
  const empty = new Uint8Array(w);
  for (let x = 0; x < w; x++) empty[x] = frac[x] <= 0.03 ? 1 : 0;
  const rule = new Uint8Array(w);
  // 단 사이의 세로 구분선(얇은 선)은 빈 칸으로 취급
  for (let x = cx0; x < cx1; ) {
    if (empty[x]) {
      x++;
      continue;
    }
    let e = x;
    while (e < cx1 && !empty[e]) e++;
    const runW = e - x;
    const leftEmpty = x >= 2 && empty[x - 1] && empty[x - 2];
    const rightEmpty = e + 1 < w && empty[e] && empty[e + 1];
    let maxFrac = 0;
    for (let k = x; k < e; k++) maxFrac = Math.max(maxFrac, frac[k]);
    // 스캔본은 살짝 기울어 선이 몇 칸에 걸칠 수 있음. 선은 거의 모든 줄에 걸쳐 있음(maxFrac 큼)
    const isRule = runW <= 2 || (runW <= Math.max(3, Math.round(w * 0.02)) && maxFrac >= 0.35);
    if (isRule && leftEmpty && rightEmpty) {
      for (let k = x; k < e; k++) {
        empty[k] = 1;
        rule[k] = maxFrac >= 0.35 ? 2 : 1; // 2: 본문 줄 대부분에 걸친 진짜 세로선 (1: 가는 잉크가 조금 — 괄호, 그림 선 등)
      }
    }
    x = e;
  }
  // 쪽 가운데에서 본문 줄 대부분에 걸친 긴 세로선은 양옆에 글자가 바싹 붙어 있어도(빈 칸이 없어도) 단 구분선 (만렙 PM 등)
  // (가운데가 아닌 긴 선은 예전처럼 빈 띠로만 판단 — 목차 쪽의 번호·제목 사이 선 같은 것)
  const vcov = new Uint16Array(w);
  for (let x = 0; x < w; x++) for (let y = bodyTopRow; y < bodyBottomRow; y++) if (lines[y * w + x] & 2) vcov[x]++;
  const longRule = (x) => vcov[x] >= 0.6 * bodyRows && Math.abs(x - w / 2) <= 0.06 * w;
  for (let x = cx0; x < cx1; x++) {
    if (!longRule(x)) continue;
    rule[x] = 2;
    empty[x] = 1;
  }

  const minColW = 0.2 * w;
  const innerLo = cx0 + Math.round(0.12 * w);
  const innerHi = cx1 - Math.round(0.12 * w);
  const minGutter = Math.max(2, Math.round(w * 0.011));
  const probe = Math.max(3, Math.round(w * 0.08));
  const splits = [];
  for (let x = innerLo; x < innerHi; ) {
    if (!empty[x]) {
      x++;
      continue;
    }
    let e = x;
    while (e < innerHi && empty[e]) e++;
    if (e - x >= minGutter) {
      // 진짜 단 구분이면 양쪽 모두 거터에 붙은 글줄이 많다
      const leftRows = rowsWithInk(at, Math.max(cx0, x - probe), x, bodyTopRow, bodyBottomRow, rowInk, spanning);
      const rightRows = rowsWithInk(at, e, Math.min(cx1, e + probe), bodyTopRow, bodyBottomRow, rowInk, spanning);
      // 본문 줄 대부분에 걸친 세로선이 있으면 왼쪽 단 글줄이 짧아(기본 문제 쪽의 짧은 식) 거터 옆이 비어 있어도 단 구분
      let strongRule = false;
      for (let k = x; k < e; k++) if (rule[k] === 2) strongRule = true;
      const ok = strongRule ? leftRows / bodyRows >= 0.02 && rightRows / bodyRows >= 0.1 : leftRows / bodyRows >= 0.1 && rightRows / bodyRows >= 0.2;
      if (ok) {
        // 거터 후보 안에는 잉크가 드문 번호 열이 섞여 있을 수 있음.
        // 실제로 잉크가 없는 구간들 중 본문 가운데에 가장 가까운 것을 거터로 봄
        // (세로선 바로 옆의 번진 잉크 몇 점은 선의 일부로 봄 — 거터가 선 양쪽으로 쪼개지지 않게)
        const isGap = (k) => colInk[k] < 2 || rule[k] || (empty[k] && (rule[k - 1] || rule[k + 1]));
        // 긴 세로선이 든 구간이 있으면 그것 (빈 띠가 넓어 가운데에 더 가까운 다른 틈이 있어도)
        const center = (cx0 + cx1) / 2;
        let best = null;
        for (let k = x; k < e; ) {
          if (!isGap(k)) {
            k++;
            continue;
          }
          let q = k;
          let long = false;
          for (; q < e && isGap(q); q++) if (rule[q] === 2) long = true;
          const d = Math.abs((k + q) / 2 - center) - (long ? w : 0);
          if (!best || d < best.d) best = { g0: k, g1: q, d };
          k = q;
        }
        let hasRule = false;
        let strong = false;
        for (let k = x; k < e; k++) {
          if (rule[k]) hasRule = true;
          if (rule[k] === 2) strong = true;
        }
        splits.push({ ...(best ? { g0: best.g0, g1: best.g1 } : { g0: x, g1: e }), rule: hasRule, strong, width: e - x });
      }
    }
    x = e;
  }
  // 빈 띠가 거터 폭에 못 미쳐도 긴 세로선 자리는 단 구분 후보
  for (let x = innerLo; x < innerHi; ) {
    if (!longRule(x)) {
      x++;
      continue;
    }
    let e = x;
    while (e < innerHi && longRule(e)) e++;
    if (!splits.some((s) => s.g0 <= x && s.g1 >= e)) {
      const leftRows = rowsWithInk(at, Math.max(cx0, x - probe), x, bodyTopRow, bodyBottomRow, rowInk, spanning);
      const rightRows = rowsWithInk(at, e, Math.min(cx1, e + probe), bodyTopRow, bodyBottomRow, rowInk, spanning);
      if (leftRows / bodyRows >= 0.02 && rightRows / bodyRows >= 0.1) splits.push({ g0: x, g1: e, rule: true, strong: true, width: e - x });
    }
    x = e;
  }

  // 단 최소 폭보다 가까운 후보끼리는 하나만: 본문 줄 대부분에 걸친 세로선 > 가는 잉크라도 세로선 > 더 넓은 빈칸
  // (수식이 짧아 단 안쪽에 빈 세로 띠가 생긴 쪽, 해설 옆 "→①" 표시 열 때문에 넓은 빈칸이 생긴 쪽에서 진짜 단 구분을 놓치지 않게)
  const chosen = [];
  for (const s of [...splits].sort((a, b) => b.strong - a.strong || b.rule - a.rule || b.width - a.width)) {
    if (s.g0 - cx0 < minColW || cx1 - s.g1 < minColW) continue;
    if (chosen.some((c) => s.g0 - c.g1 < minColW && c.g0 - s.g1 < minColW)) continue;
    chosen.push(s);
  }
  chosen.sort((a, b) => a.g0 - b.g0);
  const columns = [];
  let start = cx0;
  for (const s of chosen) {
    columns.push({ x0: start, x1: s.g0 });
    start = s.g1;
  }
  columns.push({ x0: start, x1: cx1 });
  // 각 단의 실제 잉크 범위로 좁히기
  if (columns.length === 1) return result;
  // 단 사이 세로 구분선이 있었는지 (그림 옆 빈칸을 단 구분으로 잘못 본 것인지 나중에 따질 때 씀)
  result.gutters = chosen.map((s) => ({ x0: s.g0 / w, x1: s.g1 / w, rule: s.strong }));
  result.columns = columns.map((c) => {
    let a = c.x0;
    while (a < c.x1 && colInk[a] === 0) a++;
    let b = c.x1 - 1;
    while (b > a && colInk[b] === 0) b--;
    return { x0: a / w, x1: (b + 1) / w };
  });
  return result;
}

function rowsWithInk(at, xa, xb, y0, y1, rowInk, spanning) {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    if (rowInk[y] === 0 || spanning[y]) continue;
    for (let x = xa; x < xb; x++) {
      if (at(x, y)) {
        n++;
        break;
      }
    }
  }
  return n;
}

/**
 * rect 안의 실제 잉크 경계로 여백을 잘라냅니다. 잉크가 없으면 null.
 * @param {{w:number,h:number,data:Uint8Array}} grid
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {number} pad 잘라낸 뒤 바깥쪽으로 둘 여백(비율, 폭 기준)
 */
export function trimRect(grid, rect, pad = 0.008) {
  const { w, h, data } = grid;
  // (칸 경계에 딱 맞는 값이 계산 오차로 옆 칸까지 넘지 않게)
  const gx0 = Math.max(0, Math.floor(rect.x * w + 1e-6));
  const gx1 = Math.min(w, Math.ceil((rect.x + rect.w) * w - 1e-6));
  const gy0 = Math.max(0, Math.floor(rect.y * h + 1e-6));
  const gy1 = Math.min(h, Math.ceil((rect.y + rect.h) * h - 1e-6));
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  for (let y = gy0; y < gy1; y++) {
    const base = y * w;
    for (let x = gx0; x < gx1; x++) {
      if (data[base + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  // 연한 회색 상자 테두리((가)(나) 조건 상자, 보기 상자 등): rect 안에 통째로 들어 있고 글자 범위에 걸치는 선 덩어리만 더함
  // (쪽 전체를 두른 테두리, 단 사이 세로선처럼 rect 밖으로 뻗는 선, 글자 아래쪽에 따로 떨어진 다음 제목 띠의 윗변은 이 문항 것이 아님)
  if (grid.lines && maxX >= 0) {
    const { label, boxes } = lineComponents(grid);
    const ink = { x0: minX, x1: maxX, y0: minY, y1: maxY };
    const seen = new Set();
    for (let y = gy0; y < gy1; y++) {
      const base = y * w;
      for (let x = gx0; x < gx1; x++) {
        const id = label[base + x];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const b = boxes[id];
        if (b.x0 < gx0 - 1 || b.x1 >= gx1 + 1 || b.y0 < gy0 - 1 || b.y1 >= gy1 + 1) continue;
        if (b.x1 < ink.x0 - 1 || b.x0 > ink.x1 + 1 || b.y1 < ink.y0 - 1 || b.y0 > ink.y1 + 1) continue;
        minX = Math.min(minX, Math.max(gx0, b.x0));
        maxX = Math.max(maxX, Math.min(gx1 - 1, b.x1));
        minY = Math.min(minY, Math.max(gy0, b.y0));
        maxY = Math.max(maxY, Math.min(gy1 - 1, b.y1));
      }
    }
  }
  if (maxX < 0) return null;
  const padY = (pad * w) / h;
  const x0 = Math.max(rect.x, minX / w - pad);
  const x1 = Math.min(rect.x + rect.w, (maxX + 1) / w + pad);
  const y0 = Math.max(rect.y, minY / h - padY);
  const y1 = Math.min(rect.y + rect.h, (maxY + 1) / h + padY);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * 번호(또는 정답 상자 줄) 위쪽에서 영역을 끊을 자리 (비율). 글줄을 가로지르지 않게 정합니다.
 *  - 번호 바로 위에 붙은 짧은 덩어리(수능특강 "[26009-0012]" 문항 코드, 정답 상자 머리 "Level 1 기초 연습")는
 *    사이 빈칸이 번호 높이 이하이고 그 위 빈칸이 확실히 더 넓으면 이 번호 쪽으로 넣음
 *  - 그렇지 않은데 기본 자리(번호 위 0.45줄)가 글줄에 걸리면, 그 줄 아래 빈칸(앞 문항의 마지막 줄)으로 옮기고
 *    번호 줄까지 이어진 잉크(번호 줄의 키 큰 분수)면 그 위 빈칸으로 옮김
 * @param {{y0:number,h:number}} a  번호 위치(비율)
 * @param {number} x0  이 영역의 가로 범위(비율)
 * @param {number} x1
 * @param {number} minY  더 위로는 보지 않음(구역 위쪽 끝)
 * @param {{maxW?:number, maxH?:number, maxGap?:number, minX?:number}} [opts] 붙은 덩어리 폭(범위 폭 대비)·높이(번호 높이 대비)·
 *   사이 빈칸(번호 높이 대비) 상한, minX: 붙은 덩어리의 왼쪽 끝이 이보다 오른쪽이어야 함 (번호 옆 본문 들여쓰기에서
 *   시작하는 문항 코드만. 단 왼쪽 끝에서 시작하는 앞 문항의 마지막 줄은 붙이지 않음)
 */
export function cutAbove(grid, a, x0, x1, minY = 0, { maxW = 0.4, maxH = 1.5, maxGap = 1, minX = -1 } = {}) {
  const { w, h, data } = grid;
  const nominal = a.y0 - (0.45 * a.h + 0.004);
  const gx0 = Math.max(0, Math.floor(x0 * w));
  const gx1 = Math.min(w, Math.ceil(x1 * w));
  const lim = Math.max(0, Math.floor(minY * h));
  const nTop = Math.min(h, Math.floor(a.y0 * h));
  if (gx1 - gx0 < 2 || nTop <= lim) return nominal;
  const inkRow = (y) => {
    const b = y * w;
    for (let x = gx0; x < gx1; x++) if (data[b + x]) return true;
    return false;
  };
  const numH = Math.max(1, Math.round(a.h * h));
  // 1) 번호 바로 위에 붙은 덩어리
  let y = nTop - 1;
  // 번호 줄의 키 큰 수식이 번호 위로 조금 튀어나온 부분은 번호 줄로 보고 건너뜀
  let k = y;
  while (k >= lim && inkRow(k) && y - k < Math.round(0.6 * numH)) k--;
  if (k < y && k >= lim && !inkRow(k)) y = k;
  let r = y;
  while (r >= lim && !inkRow(r)) r--;
  const gapBelow = y - r;
  if (r >= lim) {
    const bb = r + 1;
    while (r >= lim && inkRow(r)) r--;
    const bt = r + 1;
    let q = r;
    while (q >= lim && !inkRow(q)) q--;
    const gapAbove = q < lim ? Infinity : r - q;
    let bx0 = gx1;
    let bx1 = gx0;
    for (let yy = bt; yy < bb; yy++) {
      for (let x = gx0; x < gx1; x++) {
        if (data[yy * w + x]) {
          if (x < bx0) bx0 = x;
          if (x >= bx1) bx1 = x + 1;
        }
      }
    }
    const attached =
      r >= lim - 1 &&
      gapBelow <= maxGap * numH &&
      bb - bt <= maxH * numH &&
      bx1 - bx0 <= maxW * (gx1 - gx0) &&
      bx0 / w >= minX &&
      gapAbove >= Math.max(2.5 * gapBelow, 2);
    if (attached) {
      // 붙은 덩어리 위 빈칸 (위 내용 쪽으로 너무 내려가지 않게 2칸 이내)
      const cut = Math.max(lim, bt - Math.min(2, Math.max(1, Math.floor((gapAbove === Infinity ? 4 : gapAbove) / 2)))) / h;
      if (cut < nominal) return cut;
    }
  }
  // 2) 기본 자리가 글줄에 걸리면 빈 줄로
  const n = Math.floor(nominal * h);
  if (n >= lim && n < nTop && inkRow(n)) {
    let d = n;
    while (d < nTop && inkRow(d)) d++;
    if (d < nTop) return d / h;
    let u = n;
    while (u >= lim && inkRow(u) && nTop - u <= 2 * numH) u--;
    if (u >= lim && !inkRow(u)) return (u + 1) / h;
  }
  return nominal;
}

/**
 * 끊는 자리 y 가 글자(제목 띠, 동그라미 이름표 등)에 걸리면 그 덩어리 위 빈 줄로 올림 (maxUp 이내)
 */
export function snapUpToGap(grid, x0, x1, y, maxUp = 0.02) {
  const { w, h, data } = grid;
  const gx0 = Math.max(0, Math.floor(x0 * w));
  const gx1 = Math.min(w, Math.ceil(x1 * w));
  const inkRow = (yy) => {
    const b = yy * w;
    for (let x = gx0; x < gx1; x++) if (data[b + x]) return true;
    return false;
  };
  let r = Math.floor(y * h);
  if (r < 0 || r >= h || !inkRow(r)) return y;
  const stop = Math.max(0, r - Math.ceil(maxUp * h));
  while (r > stop && inkRow(r)) r--;
  return inkRow(r) ? y : (r + 1) / h;
}

/**
 * 단 왼쪽 끝에 붙은 색칠된 이름표(알약 모양 "유형 15", "02-2" 등)를 찾습니다.
 * 스캔본은 글자 크기로 단원·유형 제목 줄을 알 수 없어서, 그 앞의 이런 이름표로 찾습니다.
 * 꽉 찬 덩어리이면서 본문 글줄보다 높아야 함. cutY 는 같은 줄 장식(위로 튀어나온 배지 등) 위의 빈 줄
 * @param {number} lineH 본문 글줄 높이(비율)
 * @returns {{x0:number,x1:number,y0:number,y1:number,cutY:number}[]}
 */
export function findLabelBlocks(grid, layout, lineH = 0) {
  // 두 번 찾음: 그대로, 그리고 이름표 속 흰 글자("유형 05")가 만든 한 칸짜리 구멍을 건너뛰고.
  // (건너뛰면 한 칸 띄고 붙은 제목 글자까지 이어져 놓치는 이름표도 있어서 둘을 합침)
  const out = labelBlocksOnce(grid, layout, lineH, false);
  for (const lb of labelBlocksOnce(grid, layout, lineH, true)) {
    if (!out.some((o) => o.x0 < lb.x1 && lb.x0 < o.x1 && o.y0 < lb.y1 && lb.y0 < o.y1)) out.push(lb);
  }
  return out;
}

function labelBlocksOnce(grid, layout, lineH, bridge) {
  const { w, h, data } = grid;
  const top = Math.max(0, Math.floor((layout.bodyTop ?? 0) * h));
  const bottom = Math.min(h, Math.ceil((layout.bodyBottom ?? 1) * h));
  const out = [];
  for (const col of layout.columns || []) {
    const cx0 = Math.max(0, Math.floor(col.x0 * w) - 1);
    const cx1 = Math.min(w, Math.ceil(col.x1 * w) + 1);
    const reach = cx0 + Math.round(0.03 * w);
    // 줄마다: 단 왼쪽 끝 근처에서 시작하는 잉크 띠
    const runs = [];
    for (let y = top; y < bottom; y++) {
      let s = cx0;
      while (s < reach && !data[y * w + s]) s++;
      let e = s;
      while (e < cx1 && (data[y * w + e] || (bridge && e > s && e + 1 < cx1 && data[y * w + e + 1]))) e++;
      runs.push(s < reach ? { s, e } : null);
    }
    const long = (r) => r && r.e - r.s >= 0.025 * w && r.e - r.s <= 0.16 * w;
    const like = (a, b) => b && Math.abs(a.s - b.s) <= 2 && Math.abs(a.e - b.e) <= 2;
    for (let i = 0; i < runs.length; i++) {
      if (!long(runs[i])) continue;
      // 시작·끝이 거의 같은 띠가 이어지는 동안이 이름표 몸통 (모서리가 둥근 위아래 줄은 덜 맞아도 됨)
      let j = i + 1;
      while (j < runs.length && like(runs[j - 1], runs[j])) j++;
      const { s, e } = runs[i];
      let a = i;
      let b = j;
      const edge = (r) => r && r.s <= s + 3 && r.e >= e - 3 && r.e - r.s >= 0.6 * (e - s);
      if (a > 0 && edge(runs[a - 1])) a--;
      if (b < runs.length && edge(runs[b])) b++;
      i = j - 1;
      const bh = (b - a) / h;
      if (bh < Math.max(0.013, 1.3 * lineH) || bh > 0.035) continue;
      let ink = 0;
      for (let y = a; y < b; y++) for (let x = s; x < e; x++) ink += data[(top + y) * w + x];
      if (ink < 0.85 * (b - a) * (e - s)) continue;
      // 위로 같은 줄 장식이 이어지면 그 위 빈 줄에서 끊음 (이름표 높이 두 배까지만: "집중 공략" 배지·두 줄 제목은 이름표보다 높음)
      const blankRow = (y) => {
        for (let x = cx0; x < cx1; x++) if (data[y * w + x]) return false;
        return true;
      };
      let cut = top + a;
      for (let y = top + a - 1; y >= Math.max(top, top + a - 2 * (b - a)); y--) {
        if (blankRow(y)) {
          cut = y + 1;
          break;
        }
      }
      out.push({ x0: s / w, x1: e / w, y0: (top + a) / h, y1: (top + b) / h, cutY: cut / h });
    }
  }
  return out;
}

/** rect 안 잉크 셀 개수 */
export function inkCount(grid, rect) {
  const { w, h, data } = grid;
  const gx0 = Math.max(0, Math.floor(rect.x * w));
  const gx1 = Math.min(w, Math.ceil((rect.x + rect.w) * w));
  const gy0 = Math.max(0, Math.floor(rect.y * h));
  const gy1 = Math.min(h, Math.ceil((rect.y + rect.h) * h));
  let n = 0;
  for (let y = gy0; y < gy1; y++) for (let x = gx0; x < gx1; x++) n += data[y * w + x];
  return n;
}
