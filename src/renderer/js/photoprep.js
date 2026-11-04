// 사진 전용. 축소본에서 찾고 원본을 한 번만 재표본화한다.
// 표준 기법·한계: docs/photo-prep.md
import { otsu } from './scanmath.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a, b, c) => (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
const median = (a) => [...a].sort((x, y) => x-y)[a.length >> 1];
const area = (p) => Math.abs(p.reduce((s, a, i) => {
  const b = p[(i+1)%p.length];
  return s + a[0]*b[1] - a[1]*b[0];
}, 0))/2;

/** 단위 사각형 → 네 꼭짓점 (좌상·우상·우하·좌하). */
export function homography(q) {
  const [a, b, c, d] = q;
  const dx = a[0]-b[0]+c[0]-d[0], dy = a[1]-b[1]+c[1]-d[1];
  const bx = b[0]-c[0], by = b[1]-c[1], cx = d[0]-c[0], cy = d[1]-c[1];
  const det = bx*cy-cx*by;
  if (Math.abs(det) < 1e-10) return null;
  const g = (dx*cy-cx*dy)/det, h = (bx*dy-dx*by)/det;
  return [b[0]-a[0]+g*b[0], d[0]-a[0]+h*d[0], a[0],
    b[1]-a[1]+g*b[1], d[1]-a[1]+h*d[1], a[1], g, h];
}

export function project(m, u, v) {
  const z = m[6]*u+m[7]*v+1;
  return [(m[0]*u+m[1]*v+m[2])/z, (m[3]*u+m[4]*v+m[5])/z];
}

function grayImage(image) {
  const { width: w, height: h, data } = image;
  const gray = new Uint8Array(w*h), hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (data[i*4]*3+data[i*4+1]*5+data[i*4+2]*2)/10;
    hist[gray[i]]++;
  }
  const threshold = clamp(otsu(hist), 125, 200);
  const paper = new Uint8Array(w*h);
  for (let i = 0; i < gray.length; i++) {
    const k = i*4;
    paper[i] = gray[i] > threshold && Math.max(data[k], data[k+1], data[k+2])-Math.min(data[k], data[k+1], data[k+2]) < 65;
  }
  return { w, h, gray, paper, threshold };
}

function sample(im, x, y, mask = false) {
  x = Math.round(x); y = Math.round(y);
  return x < 0 || y < 0 || x >= im.w || y >= im.h ? (mask ? 0 : 255) : (mask ? im.paper : im.gray)[y*im.w+x];
}

function hull(points) {
  points.sort((a, b) => a[0]-b[0] || a[1]-b[1]);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length > 1 && cross(out.at(-2), out.at(-1), p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(points), ...half([...points].reverse())];
}

function paperQuad(im) {
  const { w, h, paper } = im;
  const seen = new Uint8Array(w*h), queue = new Int32Array(w*h), components = [];
  for (let i = 0; i < paper.length; i++) {
    if (!paper[i] || seen[i]) continue;
    let head = 0, tail = 1;
    queue[0] = i; seen[i] = 1;
    const edge = [];
    while (head < tail) {
      const p = queue[head++], x = p%w, y = (p/w)|0;
      let border = false;
      for (const n of [x ? p-1 : -1, x < w-1 ? p+1 : -1, y ? p-w : -1, y < h-1 ? p+w : -1]) {
        if (n < 0 || !paper[n]) { border = true; continue; }
        if (!seen[n]) { seen[n] = 1; queue[tail++] = n; }
      }
      if (border) edge.push([x, y]);
    }
    if (tail > w*h*0.08) components.push({ count: tail, edge });
  }
  components.sort((a, b) => b.count-a.count);
  if (!components.length) return null;
  const chosen = components.slice(0, 2).filter((c) => c.count >= components[0].count*0.45);
  const outline = hull(chosen.flatMap((c) => c.edge));
  const hullArea = area(outline), q = [...outline];
  // Visvalingam–Whyatt 다각형 단순화.
  while (q.length > 4) {
    let at = 0, least = Infinity;
    for (let i = 0; i < q.length; i++) {
      const v = Math.abs(cross(q[(i+q.length-1)%q.length], q[i], q[(i+1)%q.length]));
      if (v < least) { least = v; at = i; }
    }
    q.splice(at, 1);
  }
  if (q.length !== 4 || area(q) < w*h*0.28 || area(q)/hullArea < 0.9 || chosen.reduce((s, c) => s+c.count, 0)/hullArea < 0.68) return null;
  if (q.some(([x, y]) => x <= 1 || y <= 1 || x >= w-2 || y >= h-2)) return null;
  const start = q.reduce((best, p, i) => p[0]+p[1] < q[best][0]+q[best][1] ? i : best, 0);
  const ordered = [...q.slice(start), ...q.slice(0, start)], m = homography(ordered);
  if (!m) return null;
  const contrasts = [];
  for (const v of [0.2, 0.4, 0.6, 0.8]) for (const u of [0, 1]) {
    const step = u ? -0.025 : 0.025;
    contrasts.push(sample(im, ...project(m, u+step, v))-sample(im, ...project(m, u-step, v)));
  }
  return median(contrasts) >= 22 ? ordered : null;
}

function gridFor(im, matrix, w, h) {
  const gray = new Uint8Array(w*h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    gray[y*w+x] = sample(im, ...project(matrix, x/(w-1), y/(h-1)));
  }
  return { w, h, gray };
}

/** 어두운 접힌 선의 Hough 탐색. 인쇄된 단 구분선은 넓은 그림자가 없어 제외. */
export function findSpine(im) {
  let best = null;
  const side = Math.max(5, Math.round(im.w*0.06));
  const near = Math.max(3, Math.round(im.w*0.012));
  for (let slope = -0.06; slope <= 0.0601; slope += 0.01) {
    for (let mid = 0.35; mid <= 0.6501; mid += 1/im.w) {
      let score = 0, support = 0, broad = 0, rows = 0;
      for (let y = Math.round(im.h*0.15); y < im.h*0.85; y += 3) {
        const x = Math.round((mid+slope*(y/im.h-0.5))*im.w);
        const at = (dx) => im.gray[y*im.w+clamp(x+dx, 0, im.w-1)];
        const center = (at(-1)+2*at(0)+at(1))/4;
        const flank = (at(-side)+at(side))/2;
        const difference = flank-center;
        score += Math.max(0, difference);
        support += difference > 25;
        broad += Math.min(at(-side)-at(-near), at(side)-at(near)) > 5;
        rows++;
      }
      if (support/rows < 0.8 || broad/rows < 0.6) continue;
      if (!best || score/rows > best.score) best = { mid, slope, score: score/rows };
    }
  }
  return best;
}

function boundaries(im, matrix) {
  const top = [], bottom = [];
  for (let i = 0; i <= 32; i++) {
    const u = clamp(i/32, 0.015, 0.985);
    const edge = (from, step) => {
      let run = 0;
      for (let j = 0; j < 90; j++) {
        const v = from+j*step;
        run = sample(im, ...project(matrix, u, v), true) ? run+1 : 0;
        if (run === 3) return v-2*step;
      }
      return null;
    };
    top.push(edge(-0.025, 0.002));
    bottom.push(edge(1.025, -0.002));
  }
  if ([...top, ...bottom].some((v) => v == null)) return null;
  const smooth = (a) => a.map((_, i) => median(a.slice(Math.max(0, i-1), Math.min(a.length, i+2))));
  const t = smooth(top), b = smooth(bottom);
  if (t.some((v, i) => v > 0.13 || v < -0.02 || b[i]-v < 0.73) || b.some((v) => v < 0.87 || v > 1.02)) return null;
  if ([t, b].some((a) => a.some((v, i) => i && Math.abs(v-a[i-1]) > 0.025))) return null;
  // 평평한 윤곽은 손대지 않는다.
  if (Math.max(...t)-Math.min(...t) < 0.008 && Math.max(...b)-Math.min(...b) < 0.008) return null;
  const fitTop = cubicCurve(t), fitBottom = cubicCurve(b);
  return fitTop && fitBottom ? { top: fitTop, bottom: fitBottom } : null;
}

// 최소제곱 3차 곡선. 경계 표본의 계단 현상을 줄인다.
function cubicCurve(values) {
  const a = Array.from({ length: 4 }, () => Array(5).fill(0));
  values.forEach((v, i) => {
    const u = i/(values.length-1);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) a[r][c] += u**(r+c);
      a[r][4] += v*u**r;
    }
  });
  for (let i = 0; i < 4; i++) {
    const divisor = a[i][i];
    for (let j = i; j <= 4; j++) a[i][j] /= divisor;
    for (let r = 0; r < 4; r++) if (r !== i) {
      const factor = a[r][i];
      for (let j = i; j <= 4; j++) a[r][j] -= factor*a[i][j];
    }
  }
  const fit = values.map((_, i) => a.reduce((sum, row, k) => sum+row[4]*(i/(values.length-1))**k, 0));
  return fit.every((v, i) => Math.abs(v-values[i]) < 0.008) ? fit : null;
}

const interpolate = (a, u) => {
  const x = clamp(u, 0, 1)*(a.length-1), i = Math.min(a.length-2, Math.floor(x));
  return a[i]+(a[i+1]-a[i])*(x-i);
};

/** 최종 쪽의 비율 좌표 → 원본 사진 픽셀 좌표. */
export function photoPoint(page, u, v) {
  if (page.angle) {
    const x = (u-0.5)*page.width, y = (v-0.5)*page.height;
    const co = Math.cos(page.angle), si = Math.sin(page.angle);
    u = (x*co-y*si)/page.baseWidth+0.5;
    v = (x*si+y*co)/page.baseHeight+0.5;
    if (u < 0 || v < 0 || u > 1 || v > 1) return [-1e6, -1e6];
  }
  if (page.curves) {
    const top = interpolate(page.curves.top, u), bottom = interpolate(page.curves.bottom, u);
    v = top+(bottom-top)*v;
  }
  return project(page.matrix, u, v);
}

/** 투영 프로파일 분산 최대화. 작은 스캔 기울기는 그대로 둔다. */
export function estimateSkew(im) {
  const pts = [], { w, h, gray } = im;
  for (let y = Math.round(h*0.08); y < h*0.92; y += 2) for (let x = Math.round(w*0.07); x < w*0.93; x += 2) {
    if (gray[y*w+x] < 145) pts.push([x-w/2, y]);
  }
  if (pts.length < 150 || pts.length > w*h*0.09) return 0;
  const score = (degrees) => {
    const bins = new Uint32Array(h+w), slope = Math.tan(degrees*Math.PI/180);
    for (const [x, y] of pts) bins[Math.round(y-slope*x+w/2)]++;
    return bins.reduce((sum, n) => sum+n*n, 0);
  };
  let best = 0, value = score(0);
  const initial = value;
  for (let d = -9; d <= 9; d += 0.5) {
    const s = score(d);
    if (s > value) { value = s; best = d; }
  }
  const center = best;
  for (let d = center-0.4; d <= center+0.4; d += 0.1) {
    const s = score(d);
    if (s > value) { value = s; best = d; }
  }
  return Math.abs(best) >= 0.7 && Math.abs(best) < 8.8 && value > initial*1.12 ? best*Math.PI/180 : 0;
}

function pagePlan(im, q) {
  const width = Math.round((distance(q[0], q[1])+distance(q[3], q[2]))/2);
  const height = Math.round((distance(q[0], q[3])+distance(q[1], q[2]))/2);
  const matrix = homography(q);
  if (!matrix || width < 60 || height < 80) return null;
  const page = { matrix, width, height, baseWidth: width, baseHeight: height, curves: boundaries(im, matrix), angle: 0 };
  const w = Math.min(420, width), h = Math.round(w*height/width), gray = new Uint8Array(w*h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y*w+x] = sample(im, ...photoPoint(page, x/(w-1), y/(h-1)));
  page.angle = estimateSkew({ w, h, gray });
  if (page.angle) {
    const co = Math.cos(page.angle), si = Math.abs(Math.sin(page.angle));
    page.width = Math.ceil(width*co+height*si);
    page.height = Math.ceil(height*co+width*si);
  }
  return page;
}

/** 축소 RGBA 분석. 불확실하면 changed=false. */
export function planPhoto(image) {
  const im = grayImage(image), { w, h } = im;
  const unchanged = (reason) => ({ changed: false, reason, pages: [] });
  let edgePaper = 0, edgeCount = 0;
  for (let x = 0; x < w; x++) { edgePaper += im.paper[x]+im.paper[(h-1)*w+x]; edgeCount += 2; }
  for (let y = 0; y < h; y++) { edgePaper += im.paper[y*w]+im.paper[y*w+w-1]; edgeCount += 2; }
  if (edgePaper/edgeCount > 0.85) {
    const angle = estimateSkew(im);
    if (!angle) return unchanged('flat-scan');
    const p = pagePlan(im, [[0, 0], [w-1, 0], [w-1, h-1], [0, h-1]]);
    if (!p?.angle) return unchanged('flat-scan');
    p.curves = null;
    return { changed: true, reason: 'skew', pages: [p] };
  }
  const quad = paperQuad(im);
  if (!quad) return unchanged('uncertain-paper');
  const matrix = homography(quad);
  if (!matrix) return unchanged('uncertain-paper');
  const width = (distance(quad[0], quad[1])+distance(quad[3], quad[2]))/2;
  const height = (distance(quad[0], quad[3])+distance(quad[1], quad[2]))/2;
  const ratio = width/height;
  let quads = [quad], split = null;
  if (ratio > 1.12) {
    if (ratio > 1.9) return unchanged('uncertain-spread');
    const rectified = gridFor(im, matrix, 600, Math.round(600/ratio));
    split = findSpine(rectified);
    if (!split) return unchanged('uncertain-spine');
    const top = split.mid-split.slope/2, bottom = split.mid+split.slope/2;
    const gap = 0.003;
    quads = [
      [quad[0], project(matrix, top-gap, 0), project(matrix, bottom-gap, 1), quad[3]],
      [project(matrix, top+gap, 0), quad[1], quad[2], project(matrix, bottom+gap, 1)],
    ];
  } else if (ratio < 0.48 || ratio > 0.95) return unchanged('uncertain-page-shape');
  const pages = quads.map((q) => pagePlan(im, q));
  if (pages.some((p) => !p || p.baseWidth/p.baseHeight < 0.45 || p.baseWidth/p.baseHeight > 0.98)) return unchanged('uncertain-page-shape');
  return { changed: true, reason: split ? 'spread' : 'perspective', split, pages };
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

// 타일 밝기의 상위 분위수로 저주파 배경을 추정한다.
function illumination(im, page) {
  const n = 17, values = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const samples = [];
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const u = clamp(x/(n-1)+dx/160, 0.01, 0.99), v = clamp(y/(n-1)+dy/160, 0.01, 0.99);
      samples.push(sample(im, ...photoPoint(page, u, v)));
    }
    samples.sort((a, b) => a-b);
    values.push(samples[Math.floor(samples.length*0.85)]);
  }
  const bright = [...values].sort((a, b) => a-b);
  if (bright[Math.floor(values.length*0.9)]-bright[Math.floor(values.length*0.1)] < 18) return null;
  // 큰 그림·검은 테두리를 조명으로 오인하지 않는다.
  return { n, values: values.map((v) => Math.max(170, v)) };
}

async function renderPhoto(data, page, field, sx, sy) {
  const out = canvas(page.width*sx, page.height*sy), ctx = out.getContext('2d');
  const pixels = ctx.createImageData(out.width, out.height), dst = pixels.data, src = data.data;
  const w = data.width, h = data.height;
  // 열별 변환 계수는 한 번 계산한다.
  const columns = Array.from({ length: out.width }, (_, x) => {
    const u = x/(out.width-1), m = page.matrix;
    const t = page.curves ? interpolate(page.curves.top, u) : 0;
    const span = (page.curves ? interpolate(page.curves.bottom, u) : 1)-t;
    const gx = u*((field?.n || 2)-1), gi = Math.min((field?.n || 2)-2, gx|0);
    return [m[0]*u+m[1]*t+m[2], m[1]*span, m[3]*u+m[4]*t+m[5], m[4]*span,
      m[6]*u+m[7]*t+1, m[7]*span, gi, gx-gi];
  });
  for (let y = 0; y < out.height; y++) {
    const v = y/(out.height-1);
    let light;
    if (field) {
      const gy = v*(field.n-1), iy = Math.min(field.n-2, gy|0), fy = gy-iy;
      light = Array.from({ length: field.n }, (_, i) => field.values[iy*field.n+i]*(1-fy)+field.values[(iy+1)*field.n+i]*fy);
    }
    for (let x = 0; x < out.width; x++) {
      const c = columns[x], z = c[4]+c[5]*v;
      let px, py;
      if (page.angle) [px, py] = photoPoint(page, x/(out.width-1), v);
      else { px = (c[0]+c[1]*v)/z; py = (c[2]+c[3]*v)/z; }
      px = (px+0.5)*sx-0.5; py = (py+0.5)*sy-0.5;
      const at = (y*out.width+x)*4;
      dst[at+3] = 255;
      if (px < 0 || py < 0 || px >= w-1 || py >= h-1) { dst[at] = dst[at+1] = dst[at+2] = 255; continue; }
      const ix = px|0, iy = py|0, fx = px-ix, fy = py-iy, a = (iy*w+ix)*4, b = a+w*4;
      const gain = light ? Math.min(1.45, 250/(light[c[6]]*(1-c[7])+light[c[6]+1]*c[7])) : 1;
      for (let k = 0; k < 3; k++) dst[at+k] = ((src[a+k]*(1-fx)+src[a+4+k]*fx)*(1-fy)+(src[b+k]*(1-fx)+src[b+4+k]*fx)*fy)*gain;
    }
    if (y%128 === 127) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  ctx.putImageData(pixels, 0, 0);
  return out;
}

/** 원본을 바꾸지 않는다. 실패·낮은 확신도는 원본 한 쪽으로 복귀. */
export async function preparePhoto(source) {
  const started = performance.now();
  const original = (reason) => ({ pages: [source], changed: false, reason, ms: performance.now()-started });
  if (source.width < 240 || source.height < 240) return original('small-image');
  let full;
  try {
    const scale = Math.min(1, 900/Math.max(source.width, source.height));
    const small = canvas(source.width*scale, source.height*scale), ctx = small.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, small.width, small.height);
    ctx.drawImage(source, 0, 0, small.width, small.height);
    const sampleImage = ctx.getImageData(0, 0, small.width, small.height);
    const plan = planPhoto(sampleImage);
    if (!plan.changed) return original(plan.reason);
    const im = grayImage(sampleImage);
    full = canvas(source.width, source.height);
    const fc = full.getContext('2d', { willReadFrequently: true });
    fc.fillStyle = '#fff'; fc.fillRect(0, 0, full.width, full.height); fc.drawImage(source, 0, 0);
    const pixels = fc.getImageData(0, 0, full.width, full.height), pages = [];
    for (const p of plan.pages) pages.push(await renderPhoto(pixels, p, illumination(im, p), source.width/small.width, source.height/small.height));
    return { ...plan, pages, ms: performance.now()-started };
  } catch (error) {
    console.warn('사진 전처리 생략:', error);
    return original('processing-failed');
  } finally {
    if (full) { full.width = 1; full.height = 1; }
  }
}
