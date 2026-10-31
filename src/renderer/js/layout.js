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
  for (let y = 0; y < height; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / cell));
    const rowBase = gy * gw;
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      // 휘도 (투명 픽셀은 흰색으로 간주)
      const a = rgba[i + 3];
      if (a < 128) continue;
      const lum = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
      if (lum < darkThreshold) counts[rowBase + Math.min(gw - 1, Math.floor(x / cell))]++;
    }
  }
  const area = cell * cell;
  const minCount = Math.max(2, Math.round(area * 0.06));
  const data = new Uint8Array(gw * gh);
  for (let k = 0; k < data.length; k++) data[k] = counts[k] >= minCount ? 1 : 0;
  return { w: gw, h: gh, data };
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
  // 스캔본의 가장자리 검은 테두리 등을 무시하기 위해 가장자리 2% 제외
  const ex = Math.max(1, Math.round(w * 0.02));
  const ey = Math.max(1, Math.round(h * 0.015));
  const at = (x, y) => (x < ex || x >= w - ex || y < ey || y >= h - ey ? 0 : data[y * w + x]);

  const rowInk = new Uint16Array(h);
  let total = 0;
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < w; x++) c += at(x, y);
    rowInk[y] = c;
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

  const bands = bandsOf(rowInk, 1);
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
  const colInk = new Uint16Array(w);
  const colInkAll = new Uint16Array(w);
  let bodyRows = 0;
  for (let y = bodyTopRow; y < bodyBottomRow; y++) {
    if (rowInk[y] === 0) continue;
    for (let x = 0; x < w; x++) if (at(x, y)) colInkAll[x]++;
    if (spanning[y]) continue;
    bodyRows++;
    for (let x = 0; x < w; x++) if (at(x, y)) colInk[x]++;
  }
  let cx0 = 0;
  while (cx0 < w && colInkAll[cx0] === 0) cx0++;
  let cx1 = w - 1;
  while (cx1 > cx0 && colInkAll[cx1] === 0) cx1--;
  cx1 += 1;

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
        rule[k] = 1;
      }
    }
    x = e;
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
      if (leftRows / bodyRows >= 0.1 && rightRows / bodyRows >= 0.2) {
        // 거터 후보 안에는 잉크가 드문 번호 열이 섞여 있을 수 있음.
        // 실제로 잉크가 없는 구간들 중 본문 가운데에 가장 가까운 것을 거터로 봄
        const isGap = (k) => colInk[k] < 2 || rule[k];
        const center = (cx0 + cx1) / 2;
        let best = null;
        for (let k = x; k < e; ) {
          if (!isGap(k)) {
            k++;
            continue;
          }
          let q = k;
          while (q < e && isGap(q)) q++;
          const d = Math.abs((k + q) / 2 - center);
          if (!best || d < best.d) best = { g0: k, g1: q, d };
          k = q;
        }
        splits.push(best ? { g0: best.g0, g1: best.g1 } : { g0: x, g1: e });
      }
    }
    x = e;
  }

  const columns = [];
  let start = cx0;
  for (const s of splits) {
    if (s.g0 - start >= minColW && cx1 - s.g1 >= minColW) {
      columns.push({ x0: start, x1: s.g0 });
      start = s.g1;
    }
  }
  columns.push({ x0: start, x1: cx1 });
  // 각 단의 실제 잉크 범위로 좁히기
  if (columns.length === 1) return result;
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
  const gx0 = Math.max(0, Math.floor(rect.x * w));
  const gx1 = Math.min(w, Math.ceil((rect.x + rect.w) * w));
  const gy0 = Math.max(0, Math.floor(rect.y * h));
  const gy1 = Math.min(h, Math.ceil((rect.y + rect.h) * h));
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
  if (maxX < 0) return null;
  const padY = (pad * w) / h;
  const x0 = Math.max(rect.x, minX / w - pad);
  const x1 = Math.min(rect.x + rect.w, (maxX + 1) / w + pad);
  const y0 = Math.max(rect.y, minY / h - padY);
  const y1 = Math.min(rect.y + rect.h, (maxY + 1) / h + padY);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
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
