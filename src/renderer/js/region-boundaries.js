// 영역 전용 보완. 자르기·되찾기에는 번호의 값·순서나 제목 내용을 쓰지 않습니다.
// 지문 붙이기로 넘기는 범위만 기존 범위 읽기(detect.js)와 같은 조건(두 수를 읽었고 b > a, b - a <= 40)을 따릅니다.
export function residualBoundaries(page, anchors) {
  return residualRegions(page, anchors).boundaries;
}

// 번호 검출이 끝난 뒤에만 사용. 저장된 page.ranges에는 쓰지 않습니다.
export function recoveredRanges(page, anchors) {
  return residualRegions(page, anchors).recovered;
}

// 기존 범위 읽기와 같은 조건. 못 읽었거나 거꾸로·넓게 읽힌 머리는 자르기에만 쓰고 지문 붙이기에는 넘기지 않음.
export function attachableRange(r) {
  return Number.isFinite(r.a) && Number.isFinite(r.b) && r.b > r.a && r.b - r.a <= 40;
}

export function rangesForItems(results, anchors) {
  return new Map(results.map(page => [page.index,
    [...(page.ranges || []), ...recoveredRanges(page, anchors.get(page.index) || []).filter(attachableRange)]]));
}

function residualRegions(page, anchors) {
  const { grid, layout } = page;
  const h = page.bodyH;
  if (!grid || !layout || !(h > 0)) return { boundaries: [], recovered: [] };
  const tokens = [...(page.tokens || []), ...(page.ocrPasses || []).flat()];
  const out = [];
  const recovered = [];
  for (const [colIndex, col] of (layout.columns || []).entries()) {
    const chain = anchors.filter(a => a.col === colIndex);
    if (!chain.length) continue;
    const left = Math.ceil(col.x0 * grid.w), right = Math.floor(col.x1 * grid.w);
    const bands = [];
    let band = null, previousEnd = layout.bodyTop;
    for (let y = Math.ceil(layout.bodyTop * grid.h); y < layout.bodyBottom * grid.h; y++) {
      let ink = 0, first = right, last = left;
      for (let x = left; x < right; x++) if (grid.data[y * grid.w + x]) { ink++; first = Math.min(first, x); last = x; }
      if (ink) {
        if (!band) band = { y0: y / grid.h, gap: y / grid.h - previousEnd, firstInk: ink, rows: 0, sides: 0 };
        band.y1 = (y + 1) / grid.h;
        band.rows++;
        if (first - left <= 2 && right - 1 - last <= 2) band.sides++;
      } else if (band) {
        bands.push(band); previousEnd = band.y1; band = null;
      }
    }
    if (band) bands.push(band);
    const local = tokens.filter(t => (t.x0 + t.x1) / 2 >= col.x0 && (t.x0 + t.x1) / 2 <= col.x1);
    const ranges = [...(page.ranges || []).filter(r => r.col === colIndex)];
    // 분리 OCR 토큰의 괄호·범위 구분자 모양만 복원. 숫자는 읽거나 비교하지 않음.
    for (const b of bands) {
      if (b.gap < 3 * h || b.y1 - b.y0 > 3 * h) continue;
      if (!chain.some(a => a.y1 < b.y0)) continue;
      const next = chain.filter(a => a.y0 > b.y1).sort((a, c) => a.y0 - c.y0)[0];
      if (!next || next.y0 - b.y1 > 3 * h) continue;
      for (const pass of [page.tokens || [], ...(page.ocrPasses || [])]) {
        const line = pass.filter(t => t.x0 >= col.x0 - h && t.x0 < col.x0 + 0.4 * (col.x1 - col.x0) &&
          (t.y0 + t.y1) / 2 >= b.y0 && (t.y0 + t.y1) / 2 <= b.y1).sort((a, c) => a.x0 - c.x0);
        if (!line.length || line[0].x0 - col.x0 > 2 * h) continue;
        const shape = line.map(t => t.str).join('').replace(/\d/g, '#');
        if (!/^\[#+[~～\-–−]#+\]/.test(shape)) continue;
        if (!ranges.some(r => r.y0 < b.y1 && r.y1 > b.y0)) {
          ranges.push({ col: colIndex, y0: b.y0, y1: b.y1 });
          // 수락·절단은 위 기하/모양으로 확정. 값·순서는 기존 attachStems에만 전달.
          const prefix = line.map(t => t.str).join('').match(/^\[(\d+)[~～\-–−](\d+)\]/);
          const numbers = prefix && [+prefix[1], +prefix[2]];
          const last = line.find(t => t.str.includes(']')) || line[line.length - 1];
          recovered.push({ col: colIndex, x0: line[0].x0, x1: last.x1, y0: b.y0, y1: b.y1,
            ...(numbers?.every(Number.isFinite) ? { a: numbers[0], b: numbers[1] } : {}) });
          out.push({ x0: col.x0, x1: col.x1, y0: b.y0 - 1 / grid.h, kind: 'range-boundary' });
        }
        break;
      }
    }
    // 큰 공백 뒤의 얕은 전폭 테두리+한 줄, 바로 아래 새 지문 머리가 있을 때만 제목.
    for (const b of bands) {
      if (b.gap < 3 * h || b.y1 - b.y0 > 3 * h || b.firstInk < 0.8 * (right - left) || b.sides < 0.5 * b.rows) continue;
      if (!chain.some(a => a.y1 < b.y0) || chain.some(a => a.y0 < b.y1 && a.y1 > b.y0)) continue;
      if (!ranges.some(r => r.y0 >= b.y1 && r.y0 - b.y1 <= 3 * h)) continue;
      const text = local.filter(t => (t.y0 + t.y1) / 2 > b.y0 && (t.y0 + t.y1) / 2 < b.y1 &&
        t.x0 > col.x0 + h && t.x1 < col.x1 - h && t.y1 - t.y0 >= 0.5 * h);
      if (!text.length || Math.max(...text.map(t => t.x1)) > col.x0 + 0.65 * (col.x1 - col.x0)) continue;
      out.push({ x0: col.x0, x1: col.x1, y0: b.y0 - 1 / grid.h, kind: 'framed-heading' });
    }
  }
  return { boundaries: out, recovered };
}
