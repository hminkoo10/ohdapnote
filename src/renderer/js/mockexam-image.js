// 정규 격자 PNG의 원문자 테두리만 제거해 기존 OCR로 숫자를 읽는다.
// 배치가 다르거나 두 번 읽은 결과가 다르면 추정하지 않는다.
export function prepareAnswerGrid({ width: W, height: H, data }) {
  const dark = (x, y) => data[(y * W + x) * 4] < 180;
  const xs = [], ys = [];
  for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) if (dark(x, y)) n++; if (n > W * .6) ys.push(y); }
  for (let x = 0; x < W; x++) { let n = 0; for (let y = 0; y < H; y++) if (dark(x, y)) n++; if (n > H * .35) xs.push(x); }
  const groups = a => a.filter((n, i) => !i || n - a[i - 1] > 4);
  const cols = groups(xs);
  if (cols.length !== 11) return null; // 번호/답 다섯 쌍인 검증된 표만
  let top = 0, bottom = 0, run = 0, best = 0;
  for (let y = 0; y < H; y++) { run = dark(cols[0], y) ? run + 1 : 0; if (run > best) { best = run; top = y - run + 1; bottom = y; } }
  const rows = groups(ys).filter(y => y >= top - 5 && y <= bottom + 5);
  if (rows.length < 7 || rows.length > 13) return null;
  const gaps = rows.slice(1).map((y, i) => y - rows[i]);
  if (Math.max(...gaps) / Math.min(...gaps) > 1.15) return null;
  const pixels = new Uint8ClampedArray(data);
  const white = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const k = (y * W + x) * 4; pixels[k] = pixels[k + 1] = pixels[k + 2] = 255; };
  for (const y of ys) for (let dy = -2; dy <= 2; dy++) for (let x = 0; x < W; x++) white(x, y + dy);
  for (const x of xs) for (let dx = -2; dx <= 2; dx++) for (let y = 0; y < H; y++) white(x + dx, y);
  for (let c = 1; c + 1 < cols.length; c += 2) for (let r = 0; r + 1 < rows.length; r++) {
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (let y = rows[r] + 7; y < rows[r + 1] - 7; y++) for (let x = cols[c] + 7; x < cols[c + 1] - 7; x++) if (pixels[(y * W + x) * 4] < 180) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (x1 <= x0 || y1 <= y0 || Math.abs((x1 - x0) / (y1 - y0) - 1) > .2) continue;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0 + 1) / 2, ry = (y1 - y0 + 1) / 2;
    let ring = 0;
    for (let a = 0; a < 16; a++) {
      const x = Math.round(cx + rx * .94 * Math.cos(a * Math.PI / 8)), y = Math.round(cy + ry * .94 * Math.sin(a * Math.PI / 8));
      let ink = false;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (x + dx >= x0 && x + dx <= x1 && y + dy >= y0 && y + dy <= y1 && pixels[((y + dy) * W + x + dx) * 4] < 180) ink = true;
      if (ink) ring++;
    }
    if (ring < 14) continue; // 단답 숫자를 원문자로 오인하지 않음
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > .60) white(x, y);
  }
  return { pixels, cols, rows, top, bottom };
}

export function gridWordAnswers(words, grid, column, width, height, subject) {
  const result = {};
  for (let r = 0; r + 1 < grid.rows.length; r++) {
    const line = words.filter(w => {
      const y = grid.top + 3 + (w.y0 + w.y1) / 2 / height * (grid.bottom - grid.top - 6);
      return y > grid.rows[r] + 4 && y < grid.rows[r + 1] - 4;
    }).sort((a, b) => a.x0 - b.x0);
    if (line.length !== 2 || line.some(w => !Number.isFinite(w.conf) || w.conf < 90)) continue;
    const [number, answer] = line, expected = r * 5 + column + 1;
    if (expected > (subject === 'math' ? 30 : 60) || number.str !== String(expected) || number.x1 > width * .55 || answer.x0 < width * .4) continue;
    if (!(subject === 'math' ? /^\d{1,3}$/ : /^[1-5]$/).test(answer.str)) continue;
    result[expected] = String(+answer.str);
  }
  return result;
}

export async function recognizeAnswerGrid(canvas, recognizeWords, { subject, selection, commonOnly = false, signal } = {}) {
  if (!subject) return null;
  const ctx = canvas.getContext('2d'), image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const grid = prepareAnswerGrid(image);
  if (!grid) return null;
  const clean = document.createElement('canvas'); clean.width = canvas.width; clean.height = canvas.height;
  const output = clean.getContext('2d').createImageData(canvas.width, canvas.height); output.data.set(grid.pixels); clean.getContext('2d').putImageData(output, 0, 0);
  const entries = {};
  try {
    for (let c = 0; c + 2 < grid.cols.length; c += 2) {
      const passes = [];
      for (const width of [800, 1000]) {
        signal?.throwIfAborted();
        const crop = document.createElement('canvas'); crop.width = width; crop.height = Math.round((grid.bottom - grid.top) * width / (grid.cols[c + 2] - grid.cols[c]));
        try {
          crop.getContext('2d').drawImage(clean, grid.cols[c] + 3, grid.top + 3, grid.cols[c + 2] - grid.cols[c] - 6, grid.bottom - grid.top - 6, 0, 0, crop.width, crop.height);
          passes.push(gridWordAnswers(await recognizeWords(crop, { lang: 'kor+eng', psm: '6' }), grid, c / 2, crop.width, crop.height, subject));
        } finally { crop.width = crop.height = 1; }
      }
      for (const [n, answer] of Object.entries(passes[0])) if (passes[1][n] === answer && (!commonOnly || +n <= (subject === 'math' ? 22 : 34))) entries[n] = { answer, points: null };
    }
  } finally { clean.width = clean.height = 1; }
  return { answers: { [[subject, selection].filter(Boolean).join('|')]: entries }, warnings: [] };
}
