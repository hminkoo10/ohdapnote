// PDF 글자 정보로 문항을 글자·수식 블록으로 옮기기 (AI 없이, 내 컴퓨터에서)
//  - EBS 수능특강처럼 Mac 조판 프로그램의 수식 글꼴(EHsang, EHboNB, EHSusic …)로 만든 디지털 PDF 는
//    수식이 그림이 아니라 글자로 들어 있습니다. 다만 글꼴마다 자판 자리에 기호를 따로 넣어 두어서
//    PDF 에서 읽으면 "xÛ"(x²), ";2#;"(3/2) 처럼 암호 같은 글자가 나옵니다.
//  - 글꼴별 기호표로 글자를 풀고, 글자 위치(첨자 높이, 분수선 위·아래, 루트 윗선)로 구조를 되살려 LaTeX 로 만듭니다.
//    결과 모양은 AI 가 옮긴 것과 같습니다: {type:'para'|'math'|'choices'|'figure', text?, latex?, items?, box?}[]
//  - 모르는 기호나 풀지 못한 배치가 하나라도 있으면 그 문항은 null(→ AI 나 그림으로). 틀린 수식을 내지 않는 것이 먼저입니다.

// ---------------------------------------------------------------------------
// 1) 쪽 읽기: pdf.js 의 그리기 명령을 따라가며 글자 하나하나의 위치·글꼴과 선·도형을 모읍니다.
//    (getTextContent 는 글자를 덩어리로 합치고 글꼴 이름도 주지 않아서 직접 셈)

const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const ID = [1, 0, 0, 1, 0, 0];

/** 글꼴 이름에서 조각 표시(ABCDEF+)를 떼고 [이름, 종류] (예: "SBTLEN+EHsang-Italic" → ['EHsang', 'Italic']) */
export function fontFamily(name) {
  const base = String(name || '').replace(/^[A-Z]{6}\+/, '');
  const k = base.indexOf('-');
  return k > 0 ? [base.slice(0, k), base.slice(k + 1)] : [base, ''];
}

/**
 * 쪽 하나의 글자·선·도형. 좌표는 쪽 왼쪽 위가 0 인 pt(세로는 아래로 커짐).
 * @param page  pdf.js PDFPageProxy (문서를 fontExtraProperties: true 로 열어야 글꼴 이름이 옴)
 * @param pdfjsLib  OPS 를 쓰려고 받음
 * @returns {Promise<{w:number, h:number, glyphs:object[], lines:object[], shapes:object[]}>}
 *   glyphs: {c, fam, style, x0, x1, base, top, bottom, size, xem, rot, seq}  (seq: 그린 순서)
 *   lines:  가로선 {x0, x1, y, lw}            (분수선·루트 윗선 후보)
 *   shapes: 그 밖의 그림 {x0, y0, x1, y1, curve, segs, image, rect, closed}
 */
export async function readPageLayer(page, pdfjsLib) {
  const OPS = pdfjsLib.OPS;
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  // 글꼴 정보는 그리기 명령보다 늦게 올 수 있어 기다림 (오래 걸리면 이름 없이)
  const ids = new Set(ops.fnArray.flatMap((fn, k) => (fn === OPS.setFont ? [ops.argsArray[k][0]] : [])));
  let timer;
  await Promise.race([Promise.all([...ids].map((id) => new Promise((res) => page.commonObjs.get(id, res)))), new Promise((res) => (timer = setTimeout(res, 3000)))]);
  clearTimeout(timer);
  const glyphs = [];
  const lines = [];
  const shapes = [];
  const fonts = new Map();
  const fontOf = (id) => {
    if (!fonts.has(id)) {
      let f = null;
      try {
        f = page.commonObjs.get(id);
      } catch {
        /* 불러오지 못한 글꼴 */
      }
      const [fam, style] = fontFamily(f?.name);
      fonts.set(id, { fam, style, ascent: f?.ascent || 0.8, descent: f?.descent || -0.2, matrix: f?.fontMatrix || [0.001], vertical: !!f?.vertical });
    }
    return fonts.get(id);
  };

  // 그래픽 상태(쌓기)와 글자 상태
  // clip: 잘라 보이는 영역(쪽 좌표 상자). 그 밖의 도형은 화면에 안 보이므로 버림
  let g = { ctm: ID, lw: 1, font: null, size: 1, cs: 0, ws: 0, hs: 1, lead: 0, rise: 0, fill: 0, stroke: 0, ca: 1, CA: 1, clip: null };
  const stack = [];
  let tm = ID;
  let tlm = ID;
  let pendingClip = false;
  const toPage = (m, x, y) => apply(vp.transform, ...apply(m, x, y));
  // 색 진하기(0 검정 ~ 1 흰색). 흐린 배경 무늬("EBS" 물결 글자 등)를 그림으로 보지 않으려고
  const lightness = (hex) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(hex));
    return m ? (0.3 * parseInt(m[1], 16) + 0.5 * parseInt(m[2], 16) + 0.2 * parseInt(m[3], 16)) / 255 : 0;
  };
  const faint = (paintOp) => {
    const f = 1 - g.ca * (1 - g.fill);
    const s = 1 - g.CA * (1 - g.stroke);
    return (STROKE.has(paintOp) ? (paintOp === OPS.stroke || paintOp === OPS.closeStroke ? s : Math.min(f, s)) : f) > 0.8;
  };

  const show = (list) => {
    const font = g.font;
    if (!font || font.vertical) return;
    const scale = g.size * (font.matrix[0] || 0.001);
    let x = 0;
    const m = mul(g.ctm, tm);
    for (const gl of list) {
      if (typeof gl === 'number') {
        x -= (gl * g.size) / 1000;
        continue;
      }
      const adv = (gl.width || 0) * scale + g.cs + (gl.isSpace ? g.ws : 0);
      const c = gl.unicode || '';
      if (c) {
        const [ax, ay] = toPage(m, x * g.hs, g.rise);
        const [bx] = toPage(m, (x + (gl.width || 0) * scale) * g.hs, g.rise);
        const [, ty] = toPage(m, x * g.hs, g.rise + font.ascent * g.size);
        const [, by] = toPage(m, x * g.hs, g.rise + font.descent * g.size);
        const size = Math.abs(by - ty) / Math.max(0.5, font.ascent - font.descent);
        // xem: 가로 1em 의 길이(폭이 0 인 윗선 글자는 가로로 늘려 길이를 맞춤), rot: 돌린 글자
        const [ex, ey] = toPage(m, (x + g.size) * g.hs, g.rise);
        const rot = Math.abs(ey - ay) > 0.05 * Math.abs(ex - ax) || ex < ax;
        glyphs.push({ c, fam: font.fam, style: font.style, x0: Math.min(ax, bx), x1: Math.max(ax, bx), base: ay, top: Math.min(ty, by), bottom: Math.max(ty, by), size, xem: Math.abs(ex - ax), rot, seq: glyphs.length });
      }
      x += adv;
    }
    tm = mul(tm, [1, 0, 0, 1, x * g.hs, 0]);
  };
  const moveText = (tx, ty) => {
    tlm = mul(tlm, [1, 0, 0, 1, tx, ty]);
    tm = tlm;
  };

  const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };
  const PAINT = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const STROKE = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const path = (paintOp, data) => {
    const clipping = pendingClip;
    pendingClip = false;
    if ((!PAINT.has(paintOp) && !clipping) || !data) return;
    const d = data[0] && typeof data[0] !== 'number' ? data[0] : data; // pdf.js 판에 따라 [Float32Array] 또는 그대로
    const pts = [];
    let curve = false;
    let closed = false;
    let segs = 0;
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    const lw = g.lw * Math.hypot(g.ctm[2], g.ctm[3]) || 0.5;
    for (let i = 0; i < d.length; ) {
      const op = d[i++];
      if (op === DRAW.moveTo) {
        cx = sx = d[i++];
        cy = sy = d[i++];
        pts.push(toPage(g.ctm, cx, cy));
      } else if (op === DRAW.lineTo) {
        segs++;
        cx = d[i++];
        cy = d[i++];
        pts.push(toPage(g.ctm, cx, cy));
      } else if (op === DRAW.curveTo) {
        curve = true;
        for (let k = 0; k < 3; k++) pts.push(toPage(g.ctm, d[i + 2 * k], d[i + 2 * k + 1]));
        cx = d[i + 4];
        cy = d[i + 5];
        i += 6;
      } else if (op === DRAW.quadraticCurveTo) {
        curve = true;
        for (let k = 0; k < 2; k++) pts.push(toPage(g.ctm, d[i + 2 * k], d[i + 2 * k + 1]));
        cx = d[i + 2];
        cy = d[i + 3];
        i += 4;
      } else if (op === DRAW.closePath) {
        if (cx !== sx || cy !== sy) segs++;
        closed = true;
        cx = sx;
        cy = sy;
      } else break; // 모르는 명령
    }
    if (!pts.length) return;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    let box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    if (clipping) {
      const c = g.clip;
      g.clip = c ? { x0: Math.max(c.x0, box.x0), y0: Math.max(c.y0, box.y0), x1: Math.min(c.x1, box.x1), y1: Math.min(c.y1, box.y1) } : box;
      if (!PAINT.has(paintOp)) return;
    }
    if (g.clip) {
      const c = g.clip;
      if (box.x1 < c.x0 - 0.5 || box.x0 > c.x1 + 0.5 || box.y1 < c.y0 - 0.5 || box.y0 > c.y1 + 0.5) return;
      box = { x0: Math.max(c.x0, box.x0), y0: Math.max(c.y0, box.y0), x1: Math.min(c.x1, box.x1), y1: Math.min(c.y1, box.y1) };
    }
    const light = faint(paintOp);
    // 가로선 하나(분수선·루트 윗선 후보)
    if (!curve && segs === 1 && box.y1 - box.y0 < 0.3 && box.x1 - box.x0 > 1 && STROKE.has(paintOp)) {
      lines.push({ x0: box.x0, x1: box.x1, y: (box.y0 + box.y1) / 2, lw, light });
      return;
    }
    const rect = !curve && segs <= 4 && pts.every((p) => (Math.abs(p[0] - box.x0) < 0.3 || Math.abs(p[0] - box.x1) < 0.3) && (Math.abs(p[1] - box.y0) < 0.3 || Math.abs(p[1] - box.y1) < 0.3));
    // 가늘게 칠한 네모도 가로선으로 (분수선을 네모로 칠하는 PDF)
    if (rect && box.y1 - box.y0 < 1.2 && box.x1 - box.x0 > 2 && !STROKE.has(paintOp)) {
      lines.push({ x0: box.x0, x1: box.x1, y: (box.y0 + box.y1) / 2, lw: box.y1 - box.y0, light });
      return;
    }
    shapes.push({ ...box, curve, segs, rect, closed: closed || rect, image: false, light });
  };
  const image = () => {
    const pts = [apply(g.ctm, 0, 0), apply(g.ctm, 1, 0), apply(g.ctm, 0, 1), apply(g.ctm, 1, 1)].map(([x, y]) => apply(vp.transform, x, y));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    const c = g.clip;
    if (c && (box.x1 < c.x0 || box.x0 > c.x1 || box.y1 < c.y0 || box.y0 > c.y1)) return;
    shapes.push({ ...box, curve: false, segs: 0, rect: false, image: true });
  };

  const { fnArray, argsArray } = ops;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i];
    switch (fn) {
      case OPS.save:
      case OPS.beginGroup:
        stack.push(g);
        g = { ...g };
        break;
      case OPS.restore:
      case OPS.endGroup:
        if (stack.length) g = stack.pop();
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(g);
        g = { ...g };
        if (Array.isArray(a?.[0]) || ArrayBuffer.isView(a?.[0])) g.ctm = mul(g.ctm, Array.from(a[0]));
        break;
      case OPS.paintFormXObjectEnd:
        if (stack.length) g = stack.pop();
        break;
      case OPS.transform:
        g.ctm = mul(g.ctm, a);
        break;
      case OPS.setLineWidth:
        g.lw = a[0];
        break;
      case OPS.clip:
      case OPS.eoClip:
        pendingClip = true;
        break;
      case OPS.setFillRGBColor:
        g.fill = lightness(a[0]);
        break;
      case OPS.setStrokeRGBColor:
        g.stroke = lightness(a[0]);
        break;
      case OPS.setGState:
        for (const [k, v] of a[0] || []) {
          if (k === 'ca') g.ca = v;
          else if (k === 'CA') g.CA = v;
          else if (k === 'LW') g.lw = v;
        }
        break;
      case OPS.beginText:
        tm = tlm = ID;
        break;
      case OPS.setFont:
        g.font = fontOf(a[0]);
        g.size = a[1] < 0 ? -a[1] : a[1];
        break;
      case OPS.setTextMatrix:
        tm = tlm = Array.from(a[0]?.length === 6 ? a[0] : a);
        break;
      case OPS.moveText:
        moveText(a[0], a[1]);
        break;
      case OPS.setLeadingMoveText:
        g.lead = -a[1];
        moveText(a[0], a[1]);
        break;
      case OPS.nextLine:
        moveText(0, -g.lead);
        break;
      case OPS.setLeading:
        g.lead = a[0];
        break;
      case OPS.setCharSpacing:
        g.cs = a[0];
        break;
      case OPS.setWordSpacing:
        g.ws = a[0];
        break;
      case OPS.setHScale:
        g.hs = a[0] / 100;
        break;
      case OPS.setTextRise:
        g.rise = a[0];
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        show(a[0]);
        break;
      case OPS.nextLineShowText:
        moveText(0, -g.lead);
        show(a[0]);
        break;
      case OPS.nextLineSetSpacingShowText:
        g.ws = a[0];
        g.cs = a[1];
        moveText(0, -g.lead);
        show(a[2]);
        break;
      case OPS.constructPath:
        path(a[0], a[1]);
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintImageXObjectRepeat:
        image();
        break;
      default:
    }
  }
  return { w: vp.width, h: vp.height, glyphs, lines, shapes };
}

// ---------------------------------------------------------------------------
// 2) 기호표: 글꼴마다 자판 자리 → 뜻.
//    Mac 자판으로 넣은 기호라 Option·Option+Shift 숫자 자리가 PDF 에서는 라틴-1 글자(Á, Û …)로 읽힙니다.

const OPT_DIGIT = { Á: '1', ª: '2', '£': '3', '¢': '4', '°': '5', '¤': '6', '¦': '7', '¥': '8', '»': '9', '¼': '0' }; // Option+숫자
const OPT_SHIFT_DIGIT = { Ú: '1', Û: '2', Ü: '3', Ý: '4', Þ: '5', ß: '6', à: '7', '¡': '8', á: '9', â: '0' }; // Option+Shift+숫자
const SHIFT_DIGIT = { ')': '0', '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9' }; // Shift+숫자
const SPACES = new Set([' ', '`', ' ', ' ', ' ', ' ', ' ', '\t', '\b', '\u0007', '\u0003']);
const MATH_ASCII = /^[A-Za-z0-9+\-=<>()|,.:!/[\]]$/;

// 약물 글꼴(EHyak): 그리스 글자·관계 기호
const YAK = { a: '\\alpha', b: '\\beta', c: '\\gamma', p: '\\pi', D: '\\Delta', y: '\\cdots', '¦': '\\infty', '¾': '\\ge', É: '\\le', Ñ: '\\pm', ç: '\\circ', "'": '\\cup', ',': '\\subset', '<': '\\in', '+': '\\ne' };
const YAK_TEXT = { Ú: '(i)', Û: '(ii)', Ü: '(iii)', Ý: '(iv)', Þ: '(v)' };
// 적분 글꼴(EHSusic): ":" 가 ∫, 보통 자리 = 위끝, Shift 자리 = 아래끝 (∫ 나 큰 괄호 뒤에 붙는 첨자)
const SUSIC_UP = { '/': 'x', '-': '-', Ñ: '+', Õ: '\\beta' };
const SUSIC_LO = { '?': 'x', _: '-' };
// 분수 글꼴(EHboNB, EHboNA): ";" 가 분수선, Shift·Option 자리 = 분자, 보통 자리 = 분모
const FR_NUM = { A: 'a', B: 'b', K: 'k', P: 'p', Q: 'q', T: 't', '{': 'x' };
const FR_DEN = { a: 'a', b: 'b', k: 'k', p: 'p', q: 'q', t: 't', '[': 'x' };
// EHboNA 의 큰 기호(루트·괄호 등). 아래 값은 글꼴의 실제 윤곽에서 잰 것(em)
// 루트 기호: [윗선까지 포함한 길이, 아래끝, 위끝]
const NA_RADICAL = { "'": [1.155, -0.214, 0.848], '"': [1.155, -0.214, 0.947], '¿': [1.162, -0.214, 1.046], '®': [1.928, -0.812, 1.38], '¾': [1.926, -0.812, 1.467] };
// 루트 윗선 늘임 글자(폭 0, 가로로 늘려 그음): 길이
const NA_OVERLINE = { Ã: 2.176, Ä: 2.176, É: 2.176, '¨': 2.176, '¹': 2.176, a: 2.176, '\u008c': 0.492, '\u008d': 1.186 };
// 큰 괄호: lo·hi 는 아래끝·위끝 (같은 줄에 닫는 } 가 없는 큰 { 는 연립 괄호)
const NA_SYM = {
  '{': { k: 'open', v: '(', lo: -0.676, hi: 1.254 },
  '}': { k: 'close', v: ')', lo: -0.676, hi: 1.254 },
  '[': { k: 'open', v: '\\{', lo: -0.661, hi: 1.259 },
  ']': { k: 'close', v: '\\}', lo: -0.661, hi: 1.259 },
  '|': { k: 'm', v: '|' },
  _: { k: 'm', v: '\\times' },
  '=': { k: 'm', v: '=' },
};
// 연립 괄호 조각(EHSunm): 실제 윤곽의 [아래끝, 위끝](em). 글꼴 높이보다 훨씬 커서 그대로 쓰면 둘러싼 줄을 못 찾음
const SUNM_BRACE = { '(': [-0.574, 0.534], '{': [-0.798, 1.398], 9: [0.063, 1.171], M: [-0.572, 1.172], '[': [-0.572, 1.172], g: [-0.704, 1.286], '|': [-0.965, 1.566] };
// 똑바른 글씨로 쓴 함수 이름
const FUNCS = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'max', 'min', 'exp']);
// 본문 글꼴의 그림 글자
const TEXT_FIX = { '': '답' };
// 문항 번호·꾸밈 글꼴: 옮기지 않음 (번호는 따로 찍힘)
const SKIP_FONTS = /^(UniversLTStd|DINPro|AvenirLTStd|GmarketSans|Aleo)/;

function fracPiece(c) {
  if (c === ';') return { k: 'fr', part: 'bar' };
  if (SHIFT_DIGIT[c]) return { k: 'fr', part: 'num', v: SHIFT_DIGIT[c] };
  if (OPT_DIGIT[c]) return { k: 'fr', part: 'num', v: OPT_DIGIT[c] };
  if (/^[0-9]$/.test(c)) return { k: 'fr', part: 'den', v: c };
  if (FR_NUM[c]) return { k: 'fr', part: 'num', v: FR_NUM[c] };
  if (FR_DEN[c]) return { k: 'fr', part: 'den', v: FR_DEN[c] };
  return null;
}

/**
 * 글자 하나 → 뜻. 모르는 기호면 null
 * k: 'sp' 띄어쓰기, 'text' 본문 글자, 'm' 수식 글자(v: LaTeX), 'sup'/'sub' 붙은 첨자, 'up'/'lo' ∫·큰 괄호의 위끝/아래끝,
 *    'ovl' 앞 글자 n 개 윗줄, 'fr' 분수 글꼴 조각, 'int' ∫, 'rad'/'radx' 루트 기호/늘인 조각, 'brace' 연립 괄호 조각,
 *    'open'/'close' 큰 괄호, 'skip' 버림
 */
export function decodeGlyph(c, fam, style = '') {
  if (SPACES.has(c)) return { k: 'sp' };
  if (!fam.startsWith('EH')) return { k: 'text', v: TEXT_FIX[c] ?? c };
  switch (fam) {
    case 'EHsang':
      if (OPT_SHIFT_DIGIT[c]) return { k: 'sup', v: OPT_SHIFT_DIGIT[c] };
      if (OPT_DIGIT[c]) return { k: 'sub', v: OPT_DIGIT[c] };
      if (c === '_') return { k: 'm', v: '\\times' };
      if (c === 'È') return { k: 'm', v: '|' };
      if (c === 'À') return { k: 'skip' };
      if (c === 'Õ') return { k: 'ovl', n: 1 };
      if (c === 'Ó') return { k: 'ovl', n: 2 };
      if (c === "'") return { k: 'm', v: "'" };
      if (c === '{') return { k: 'm', v: '\\{' };
      if (c === '}') return { k: 'm', v: '\\}' };
      if (MATH_ASCII.test(c)) return { k: 'm', v: c, letter: /[A-Za-z]/.test(c), upright: !/Italic/.test(style) };
      return null;
    case 'EHSunm':
      if (c === 'Ú') return { k: 'm', v: '\\to' };
      if (SUNM_BRACE[c]) return { k: 'brace', lo: SUNM_BRACE[c][0], hi: SUNM_BRACE[c][1] };
      if (c === 'H') return { k: 'm', v: '\\iff' };
      if (c === 'j' || c === 'K') return { k: 'skip' };
      return null;
    case 'EHyak':
      if (YAK[c]) return { k: 'm', v: YAK[c] };
      if (YAK_TEXT[c]) return { k: 'text', v: YAK_TEXT[c] };
      return null;
    case 'EHSusic':
      if (c === ':') return { k: 'int' };
      if (c === '[') return { k: 'open', v: '[', lo: -0.654, hi: 1.241 };
      if (c === ']') return { k: 'close', v: ']', lo: -0.654, hi: 1.241 };
      if (c === 'à') return { k: 'brace', lo: -0.839, hi: 1.437 };
      if (/^[0-9a-z]$/.test(c)) return { k: 'up', v: c };
      if (SUSIC_UP[c]) return { k: 'up', v: SUSIC_UP[c] };
      if (SHIFT_DIGIT[c]) return { k: 'lo', v: SHIFT_DIGIT[c] };
      if (/^[A-Z]$/.test(c)) return { k: 'lo', v: c.toLowerCase() };
      if (SUSIC_LO[c]) return { k: 'lo', v: SUSIC_LO[c] };
      return null;
    case 'EHboNB':
      if (c === "'") return { k: 'skip' };
      return fracPiece(c);
    case 'EHboNA':
      if (NA_RADICAL[c]) return { k: 'rad', len: NA_RADICAL[c][0], lo: NA_RADICAL[c][1], hi: NA_RADICAL[c][2] };
      if (NA_OVERLINE[c]) return { k: 'radx', len: NA_OVERLINE[c] };
      if (NA_SYM[c]) return { ...NA_SYM[c] };
      return fracPiece(c);
    case 'EHhabu':
      return c === '[' || c === ']' ? { k: 'm', v: c } : null;
    case 'EHRoot':
      return c === '1' ? { k: 'rad', len: 1.155, lo: -0.214, hi: 0.848 } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 3) 영역 하나 → 블록
//    상자(box): {x0, x1, top, bottom, base, size, tok, comp?}  좌표는 쪽 pt. comp 는 여러 글자를 묶어 만든 수식 덩어리

class Fail extends Error {}
const fail = (why) => {
  throw new Fail(why);
};
const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : 0;
};
const midX = (b) => (b.x0 + b.x1) / 2;
const midY = (b) => (b.top + b.bottom) / 2;
// 글자 오른쪽 끝. 폭 없이 찍힌 첨자 글자(Û 등)는 작은 글자 폭만큼 ("(x-3)²이므로" 를 띄어 쓰지 않게)
const endX = (b) => (b.x1 - b.x0 < 0.05 && (b.tok.k === 'sup' || b.tok.k === 'sub') ? b.x0 + 0.35 * b.size : b.x1);
// 폭 없는 글자(윗줄·첨자)는 앞 글자에 붙으므로 같은 자리의 다음 글자보다 앞에 둠 ("QH" 윗줄 뒤 "는")
const xKey = (b) => b.x0 - (b.x1 - b.x0 < 0.05 ? 0.3 : 0);
const byX = (a, b) => xKey(a) - xKey(b) || (a.seq ?? 0) - (b.seq ?? 0);
const real = (b) => b.tok.k !== 'sp';
const join = (a, b) => (/\\[A-Za-z]+$/.test(a) && /^[A-Za-z0-9]/.test(b) ? `${a} ${b}` : a + b);
const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
const MARKS = '①②③④⑤';

/** 여러 상자를 감싸는 상자 */
function around(list, extra) {
  return {
    x0: Math.min(...list.map((b) => b.x0)),
    x1: Math.max(...list.map((b) => b.x1)),
    top: Math.min(...list.map((b) => b.top)),
    bottom: Math.max(...list.map((b) => b.bottom)),
    ...extra,
  };
}

/** 글자 크기가 큰 쪽의 기준선 (첨자·아래끝을 빼고) */
function mainLine(list) {
  const r = list.filter(real);
  const ref = Math.max(...r.map((b) => b.size));
  const big = r.filter((b) => b.comp || b.size >= 0.8 * ref);
  return { base: median(big.map((b) => b.base)), size: ref };
}

/** 수식 상자들(왼쪽→오른쪽) → LaTeX */
function mathLatex(list) {
  const items = list.filter(real).sort(byX);
  if (!items.length) return '';
  const { base: refBase, size: ref } = mainLine(items);
  const atoms = [];
  const need = (what) => atoms[atoms.length - 1] || fail(`${what} 앞에 붙을 글자가 없음`);
  // gap: 앞 글자와 띄어 있음 (수식 안 한글 "x≤p 또는 x≥q" 의 띄어쓰기용)
  // spc: 앞에 본문 글꼴 빈칸이 있음 ("(a) a=−2k+1", "+d (a, b는 상수)")
  let gap = false;
  let spc = false;
  let prev = null;
  const atom = (t, extra) => atoms.push({ t, sup: '', sub: '', up: '', lo: '', gap, spc, ...extra });
  for (const b of items) {
    const t = b.tok;
    spc = !!prev && !!b.spc;
    gap = spc || (!!prev && b.x0 - endX(prev) > 0.2 * b.size);
    prev = b;
    // 작게 올라가거나 내려간 글자 = 첨자
    if (!b.comp && t.k !== 'text' && b.size < 0.8 * ref && atoms.length && ['m', 'sup', 'sub'].includes(t.k)) {
      const lift = refBase - b.base;
      const v = t.v;
      if (lift > 0.25 * ref) {
        const a = need('위 첨자');
        a.sup = join(a.sup, v);
        continue;
      }
      if (lift < -0.12 * ref) {
        const a = need('아래 첨자');
        a.sub = join(a.sub, v);
        continue;
      }
    }
    switch (t.k) {
      case 'm':
        atom(t.v, { upright: t.upright && t.letter });
        break;
      case 'text':
        atom(null, { text: t.v });
        break;
      case 'sup':
        need('위 첨자').sup += t.v;
        break;
      case 'sub':
        need('아래 첨자').sub += t.v;
        break;
      case 'up':
        need('위끝').up += t.v;
        break;
      case 'lo':
        need('아래끝').lo += t.v;
        break;
      case 'ovl':
        if (atoms.length < t.n) fail('윗줄을 그을 글자가 모자람');
        for (let k = 1; k <= t.n; k++) atoms[atoms.length - k].ov = true;
        break;
      case 'int':
        atom('\\int');
        break;
      case 'open':
        atom(t.v, { open: t.v });
        break;
      case 'close':
        atom(t.v, { close: t.v });
        break;
      default:
        fail(`풀지 못한 조각(${t.k})`);
    }
  }
  return renderAtoms(atoms);
}

/** atoms[i] 가 조건을 담은 괄호("(a는 상수)", "(x≥0)")의 여는 괄호인지 */
function condParen(atoms, i) {
  if (atoms[i].t !== '(' && atoms[i].open !== '(') return false;
  for (let j = i + 1, depth = 1; j < atoms.length && depth; j++) {
    const t = atoms[j].t;
    if (t === '(' || atoms[j].open) depth++;
    else if (t === ')' || atoms[j].close) depth--;
    else if (atoms[j].text != null || ['\\le', '\\ge', '<', '>', '=', '\\ne'].includes(t)) return true;
  }
  return false;
}

function renderAtoms(atoms) {
  // 똑바른 글자 묶음 중 함수 이름(sin, log …)
  for (let i = 0; i < atoms.length; i++) {
    if (!atoms[i].upright) continue;
    let j = i;
    while (j < atoms.length && atoms[j].upright && !atoms[j].sup && !atoms[j].sub) j++;
    for (let n = Math.min(j, atoms.length - 1) - i + 1; n >= 2; n--) {
      const word = atoms.slice(i, i + n).map((a) => a.t).join('');
      if (FUNCS.has(word) && atoms.slice(i, i + n - 1).every((a) => !a.sup && !a.sub)) {
        const last = atoms[i + n - 1];
        atoms.splice(i, n, { ...last, t: `\\${word}`, upright: false });
        break;
      }
    }
  }
  // 짝이 맞는 큰 괄호만 \left \right
  const stack = [];
  for (const a of atoms) {
    if (a.open) stack.push(a);
    else if (a.close && stack.length) {
      stack.pop().pair = true;
      a.pair = true;
    }
  }
  // 똑바른 글자(점 이름 P, Q, 단위 …)는 \mathrm 으로 묶음
  const plain = (a) => a.upright && /^[A-Za-z]$/.test(a.t);
  const letters = (grp) => grp.map((g, k) => (plain(g) ? `${k && plain(grp[k - 1]) ? '' : '\\mathrm{'}${g.t}${plain(grp[k + 1] || {}) ? '' : '}'}` : g.t)).join('');
  let out = '';
  for (let i = 0; i < atoms.length; i++) {
    let a = atoms[i];
    let t;
    // 본문 빈칸은 조건 괄호 앞만 띄움 ("+d (a, b는 상수)"). 앞 \text{… } 가 이미 띄웠으면 그대로
    if (a.spc && out && condParen(atoms, i) && !/(\\ | \})$/.test(out)) out += '\\ ';
    if (plain(a) && !a.ov) {
      const grp = [a];
      while (!a.sup && !a.sub && !a.up && !a.lo && plain(atoms[i + 1] || {}) && !atoms[i + 1].ov) grp.push((a = atoms[++i]));
      t = letters(grp);
      if (a.sub || a.lo) t += `_{${a.sub + a.lo}}`;
      if (a.sup || a.up) t += `^{${a.sup + a.up}}`;
      out = join(out, t);
      continue;
    }
    if (a.text != null) {
      // 앞뒤·사이 띄어쓰기는 실제 틈대로 ("x\le p\text{ 또는 }x\ge q")
      let s = a.gap && out ? ' ' : '';
      const start = i;
      for (; i < atoms.length && atoms[i].text != null; i++) s += (i > start && atoms[i].gap ? ' ' : '') + atoms[i].text;
      if (atoms[i]?.gap) s += ' ';
      i--;
      out = join(out, `\\text{${s.replace(/[{}\\$]/g, '')}}`);
      continue;
    }
    if (a.ov) {
      const grp = [];
      while (i < atoms.length && atoms[i].ov) grp.push(atoms[i++]);
      i--;
      a = grp[grp.length - 1];
      t = `\\overline{${letters(grp)}}`;
    } else if (a.open) t = a.pair ? `\\left${a.open}` : a.open;
    else if (a.close) t = a.pair ? `\\right${a.close}` : a.close;
    else t = a.t;
    if (t === '\\cdots' && out.endsWith('\\cdots')) continue;
    const lo = a.sub + a.lo;
    const up = a.sup + a.up;
    if (lo) t += `_{${lo}}`;
    if (up) t += `^{${up}}`;
    out = join(out, t);
  }
  return out;
}

/** 분수 글꼴 조각(";2#;" = 3/2) → 분수 덩어리. 분자나 분모 한쪽만 있으면 그 자리에 분수선을 그어 둠 */
function glyphFractions(boxes, lines) {
  // 그린 순서대로 (폭이 0 인 분자 글자는 x 로 줄 세우면 닫는 ";" 뒤로 갈 수 있음)
  const fr = boxes.filter((b) => b.tok.k === 'fr').sort((a, b) => a.seq - b.seq);
  if (!fr.length) return boxes;
  const seqs = [];
  for (const b of fr) {
    const seq = seqs[seqs.length - 1];
    const prev = seq?.[seq.length - 1];
    // 사이에 다른 글자가 하나둘 끼어 그려져도 바로 붙어 있으면 같은 분수
    const next = prev && (b.seq === prev.seq + 1 || (b.seq - prev.seq <= 3 && Math.abs(b.x0 - prev.x1) < 0.5));
    if (next && Math.abs(prev.base - b.base) < 0.3 && b.fam === prev.fam) seq.push(b);
    else seqs.push([b]);
  }
  const made = [];
  for (const seq of seqs) {
    let i = 0;
    while (i < seq.length) {
      const start = i;
      let open = 0;
      while (i < seq.length && seq[i].tok.part === 'bar') {
        open++;
        i++;
      }
      const parts = [];
      while (i < seq.length && seq[i].tok.part !== 'bar') parts.push(seq[i++]);
      let close = 0;
      while (i < seq.length && seq[i].tok.part === 'bar' && close < open) {
        close++;
        i++;
      }
      if (!open || close !== open || !parts.length) fail('분수 글꼴의 분수선 짝이 맞지 않음');
      const all = seq.slice(start, i);
      const num = parts.filter((p) => p.tok.part === 'num').map((p) => p.tok.v).join('');
      const den = parts.filter((p) => p.tok.part === 'den').map((p) => p.tok.v).join('');
      const { base, size } = all[0];
      const box = around(all, { base, size });
      if (num && den) {
        made.push({ ...box, tok: { k: 'm', v: `\\frac{${num}}{${den}}` }, comp: true });
        continue;
      }
      // 한쪽은 보통 글자로 위(아래)에 따로 찍힘 → 분수선만 그어 두고 나머지는 분수선 규칙으로
      const y = base - 0.3 * size;
      lines.push({ x0: box.x0, x1: box.x1, y, lw: 0.3 });
      if (num) made.push({ x0: box.x0, x1: box.x1, top: y - 0.8 * size, bottom: y - 0.1 * size, base: y - 0.25 * size, size, tok: { k: 'm', v: num }, comp: true });
      if (den) made.push({ x0: box.x0, x1: box.x1, top: y + 0.1 * size, bottom: y + 0.85 * size, base: y + 0.65 * size, size, tok: { k: 'm', v: den }, comp: true });
    }
  }
  return [...boxes.filter((b) => b.tok.k !== 'fr'), ...made];
}

/** 똑바른 lim + 그 아래 작은 글자(x→a) → \lim_{x \to a} */
function limits(boxes) {
  const up = boxes.filter((b) => b.tok.k === 'm' && b.tok.upright && b.tok.letter).sort(byX);
  const lims = [];
  for (const l of up) {
    if (l.tok.v !== 'l') continue;
    const near = (a, c) => up.find((b) => b.tok.v === c && Math.abs(b.base - a.base) < 0.3 && b.x0 - a.x1 < 0.3 * a.size && b.x0 >= a.x1 - 0.5);
    const i = near(l, 'i');
    const m = i && near(i, 'm');
    if (m) lims.push([l, i, m]);
  }
  for (const word of lims) {
    const lim = around(word, { base: word[0].base, size: word[0].size });
    let rest = boxes.filter((b) => !word.includes(b));
    const small = rest.filter((b) => real(b) && b.tok.k !== 'text' && b.size < 0.8 * lim.size && b.top >= lim.base - 0.3 * lim.size && b.top <= lim.base + 0.7 * lim.size);
    const grp = small.filter((b) => b.x1 > lim.x0 - 0.3 * lim.size && b.x0 < lim.x1 + 0.3 * lim.size);
    if (grp.length) {
      const gb = median(grp.map((b) => b.base));
      for (let changed = true; changed; ) {
        changed = false;
        const lo = Math.min(...grp.map((b) => b.x0));
        const hi = Math.max(...grp.map((b) => b.x1));
        for (const b of small) {
          if (grp.includes(b) || Math.abs(b.base - gb) > 0.6 * b.size) continue;
          if (b.x0 - hi < 0.5 * lim.size && lo - b.x1 < 0.5 * lim.size) {
            grp.push(b);
            changed = true;
          }
        }
      }
      // 아래끝 사이의 띄어쓰기도 같이 치움
      const lo = Math.min(...grp.map((b) => b.x0));
      const hi = Math.max(...grp.map((b) => b.x1));
      const gaps = rest.filter((b) => !real(b) && b.size < 0.8 * lim.size && midX(b) > lo && midX(b) < hi && Math.abs(b.base - gb) < 0.6 * b.size);
      rest = rest.filter((b) => !grp.includes(b) && !gaps.includes(b));
    }
    const v = grp.length ? `\\lim_{${mathLatex(grp)}}` : '\\lim';
    boxes = [...rest, { ...(grp.length ? around([lim, ...grp]) : lim), base: lim.base, size: lim.size, tok: { k: 'm', v }, comp: true }];
  }
  return boxes;
}

/**
 * 루트가 덮는 범위. 루트 기호 글자에 짧은 윗선이 붙어 있고, 더 긴 윗선은 폭이 0 인 늘임 글자(가로로 늘려 길이를 맞춤)가 이어 그음
 * @returns {{rad, x1, top, bottom, w}[]}
 */
function radicalSpans(boxes) {
  const exts = boxes.filter((b) => b.tok.k === 'radx');
  const used = new Set();
  const spans = [];
  for (const r of boxes.filter((b) => b.tok.k === 'rad').sort(byX)) {
    const top = r.base - r.tok.hi * r.size;
    const bottom = r.base - r.tok.lo * r.size;
    let end = r.x0 + r.tok.len * r.xem;
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of exts) {
        if (used.has(e) || e.x0 < r.x0 || e.x0 > end + 0.5 || e.base < top || e.base > bottom + 0.5 * r.size) continue;
        used.add(e);
        end = Math.max(end, e.x0 + e.tok.len * e.xem);
        grew = true;
      }
    }
    spans.push({ rad: r, x1: end, top, bottom, w: end - r.x0 });
  }
  if (used.size !== exts.length) fail('루트 윗선 조각이 남음');
  return spans;
}

/** 루트·분수선 → 루트·분수 덩어리. 안쪽(짧은 것)부터 */
function structures(boxes, lines, s) {
  const items = radicalSpans(boxes);
  boxes = boxes.filter((b) => b.tok.k !== 'radx');
  for (const l of lines) if (l.x1 - l.x0 >= 2.5) items.push({ line: l, w: l.x1 - l.x0 });
  items.sort((a, b) => a.w - b.w);
  for (const it of items) boxes = it.rad ? makeSqrt(boxes, it, s) : makeFrac(boxes, it.line, s);
  return boxes;
}

function makeFrac(boxes, l, s) {
  const span = (b) => real(b) && midX(b) >= l.x0 - 0.5 && midX(b) <= l.x1 + 0.5;
  const pick = (seed, side) => {
    const grp = boxes.filter((b) => span(b) && seed(b));
    if (!grp.length) return grp;
    let lo = Math.min(...grp.map((b) => b.top));
    let hi = Math.max(...grp.map((b) => b.bottom));
    for (let changed = true; changed; ) {
      changed = false;
      for (const b of boxes) {
        if (grp.includes(b) || !span(b) || !side(b) || b.bottom <= lo || b.top >= hi) continue;
        grp.push(b);
        lo = Math.min(lo, b.top);
        hi = Math.max(hi, b.bottom);
        changed = true;
      }
    }
    return grp;
  };
  const num = pick((b) => b.bottom <= l.y + 0.25 * s && b.bottom >= l.y - 0.6 * s, (b) => b.bottom <= l.y + 0.25 * s);
  const den = pick((b) => b.top >= l.y - 0.25 * s && b.top <= l.y + 0.6 * s, (b) => b.top >= l.y - 0.25 * s);
  if (!num.length || !den.length) return boxes; // 분수선이 아님(밑줄·꾸밈)
  const all = [...num, ...den];
  const size = Math.max(...all.map((b) => b.size));
  const box = around([...all, { x0: l.x0, x1: l.x1, top: l.y, bottom: l.y }]);
  const v = `\\frac{${mathLatex(num)}}{${mathLatex(den)}}`;
  const inside = (b) => !real(b) && midX(b) > box.x0 && midX(b) < box.x1 && midY(b) > box.top && midY(b) < box.bottom;
  return [...boxes.filter((b) => !all.includes(b) && !inside(b)), { ...box, base: l.y + 0.3 * Math.min(size, s), size: Math.min(size, s), tok: { k: 'm', v }, comp: true }];
}

function makeSqrt(boxes, { rad, x1, top, bottom }, s) {
  const pad = 0.2 * rad.size;
  const mem = boxes.filter((b) => b !== rad && real(b) && midX(b) > rad.x1 - 0.5 && midX(b) < x1 && midY(b) > top - pad && midY(b) < bottom + pad);
  if (!mem.length) fail('루트 안이 비어 있음');
  const { base, size } = mainLine(mem);
  const box = around([rad, ...mem, { x0: rad.x0, x1, top, bottom }]);
  const inside = (b) => !real(b) && midX(b) > box.x0 && midX(b) < box.x1 && midY(b) > box.top && midY(b) < box.bottom;
  return [...boxes.filter((b) => b !== rad && !mem.includes(b) && !inside(b)), { ...box, base, size, tok: { k: 'm', v: `\\sqrt{${mathLatex(mem)}}` }, comp: true }];
}

/** 세로로 이어진 큰 중괄호 조각 + 오른쪽 여러 줄 → cases */
function makeCases(boxes, s) {
  // 뒤(같은 줄 오른쪽이나 아래 줄)에 닫는 } 가 없는 큰 { 도 연립 괄호
  for (const o of boxes) {
    if (o.tok.k !== 'open' || o.tok.v !== '\\{') continue;
    const later = (c) => c.base > o.base + 0.5 * s || (Math.abs(c.base - o.base) <= 0.5 * s && c.x0 > o.x1);
    if (!boxes.some((c) => c.tok.k === 'close' && c.tok.v === '\\}' && later(c))) o.tok = { ...o.tok, k: 'brace', open: o.tok };
  }
  const pieces = boxes.filter((b) => b.tok.k === 'brace').sort((a, b) => a.top - b.top);
  const braces = [];
  for (const p of pieces) {
    const br = braces.find((b) => Math.abs(b.x0 - p.x0) < 2 && p.top - b.bottom < 0.5 * s);
    if (br) {
      Object.assign(br, around([br, p]));
      br.parts.push(p);
    } else braces.push({ ...around([p]), parts: [p] });
  }
  const all = [...braces];
  braces.sort((a, b) => a.bottom - a.top - (b.bottom - b.top));
  for (const br of braces) {
    const rest = boxes.filter((b) => !br.parts.includes(b));
    // 같은 높이에 나란한 다음 괄호 앞까지 ("f(x)={…, g(x)={…")
    const mid = midY(br);
    const limit = Math.min(...all.filter((o) => o !== br && o.x0 > br.x1 && Math.abs(midY(o) - mid) < 0.5 * s).map((o) => o.x0));
    let content = rest.filter((b) => b.x0 >= br.x1 - 0.5 && b.x1 <= limit + 0.5 && midY(b) >= br.top - 0.1 * s && midY(b) <= br.bottom + 0.1 * s);
    // 괄호 가운데 높이에서 줄들보다 오른쪽에 오는 글(", g(x)=")은 괄호 밖
    const onMid = (b) => Math.abs(midY(b) - mid) < 0.4 * s;
    const off = content.filter((b) => real(b) && !onMid(b));
    if (off.length) {
      // 가운데 줄이 다른 줄 끝에서 시작하면 괄호 밖. 아니면 진짜 가운데 줄이고, 다른 줄 끝 뒤의 큰 틈부터 밖
      const end = Math.max(...off.map((b) => b.x1));
      const midRow = content.filter((b) => real(b) && onMid(b)).sort(byX);
      let cut = midRow.length && midRow[0].x0 >= end - 0.3 * s ? midRow[0].x0 : Infinity;
      for (let i = 1; i < midRow.length && cut === Infinity; i++) {
        if (midRow[i].x0 >= end - 0.3 * s && midRow[i].x0 - midRow[i - 1].x1 > 0.6 * s) cut = midRow[i].x0;
      }
      content = content.filter((b) => !onMid(b) || b.x0 < cut - 0.1);
    }
    const rows = clusterRows(content, s);
    if (rows.length < 2 && br.parts.length === 1 && br.parts[0].tok.open) {
      // 줄이 하나면 연립이 아니라 그냥 여는 괄호
      br.parts[0].tok = br.parts[0].tok.open;
      continue;
    }
    if (rows.length < 2) fail('연립 괄호 안 줄이 하나뿐');
    const out = [];
    // 조건 칸(x<2 …): 가장 넓은 틈 뒤 글자의 왼쪽에 줄마다 맞춰 있음
    const rr = rows.map((row) => row.filter(real));
    let col = 0;
    let gmax = 0;
    for (const r of rr) {
      for (let i = 1; i < r.length; i++) {
        if (r[i].x0 - r[i - 1].x1 > gmax) {
          gmax = r[i].x0 - r[i - 1].x1;
          col = r[i].x0;
        }
      }
    }
    if (gmax <= 0.6 * s) {
      // 틈이 좁아도 모든 줄에서 같은 자리에 틈을 두고 "(" 로 시작하면 조건 칸 ("x+3 (x≤1)")
      const gapAt = (r, i) => i > 0 && r[i].x0 - r[i - 1].x1 > 0.2 * s;
      const cand = rr[0].filter((b, i) => b.tok.v === '(' && gapAt(rr[0], i)).map((b) => b.x0);
      const ok = cand.filter((x) => rr.every((r) => r.some((b, i) => Math.abs(b.x0 - x) < 1 && b.tok.v === '(' && gapAt(r, i))));
      if (ok.length) {
        col = ok[ok.length - 1];
        gmax = Infinity;
      }
    }
    for (const r of rr) {
      const k = gmax > 0.6 * s ? r.findIndex((b, i) => i > 0 && b.x0 >= col - 1) : -1;
      out.push(k > 0 ? `${mathLatex(r.slice(0, k))} & ${mathLatex(r.slice(k))}` : mathLatex(r));
    }
    const box = around([br, ...content]);
    boxes = [...rest.filter((b) => !content.includes(b)), { ...box, base: (br.top + br.bottom) / 2 + 0.3 * s, size: s, tok: { k: 'm', v: `\\begin{cases} ${out.join(' \\\\ ')} \\end{cases}` }, comp: true }];
  }
  return boxes;
}

const smallMath = (b, s) => b.tok.k !== 'text' && !b.comp && b.size < 0.8 * s;

/** 상자들 → 줄(기준선이 가까운 것끼리). 각 줄은 왼쪽→오른쪽 */
function clusterRows(list, s) {
  const rows = [];
  for (const b of list.filter((b) => real(b) && !smallMath(b, s)).sort((a, b) => a.base - b.base)) {
    const r = rows.find((r) => Math.abs(r.base - b.base) < 0.45 * s);
    if (r) r.items.push(b);
    else rows.push({ base: b.base, items: [b] });
  }
  for (const b of list.filter((b) => !real(b) || smallMath(b, s))) {
    let best = null;
    for (const r of rows) {
      const top = Math.min(...r.items.map((i) => i.top));
      const bot = Math.max(...r.items.map((i) => i.bottom));
      const y = midY(b);
      const d = y < top ? top - y : y > bot ? y - bot : 0;
      if (!best || d < best.d) best = { r, d };
    }
    if (best && best.d < 0.6 * s) best.r.items.push(b);
    else if (real(b)) rows.push({ base: b.base, items: [b] });
  }
  const out = rows.sort((a, b) => a.base - b.base).map((r) => r.items.sort(byX));
  // 본문 글꼴 빈칸 뒤의 글자 표시 (빈칸 글자가 좁아 틈으로는 안 보이는 띄어쓰기: "ㄱ. g(−1)", "(a) a=…")
  for (const items of out) {
    let sp = false;
    for (const b of items) {
      if (!real(b)) sp ||= !!b.textSp;
      else {
        b.spc = sp;
        sp = false;
      }
    }
  }
  return out;
}

/** 한 줄 → 글(수식은 $…$) */
function rowString(items, s) {
  // 띄어쓰기는 본문 글꼴 빈칸이나 글자 사이 실제 틈으로 (수식 글꼴의 가는 빈칸은 모양만 맞추는 것이라 "f(x)에" 처럼 붙여 씀)
  const list = items.filter(real);
  let out = '';
  let prev = null;
  for (let i = 0; i < list.length; ) {
    const b = list[i];
    if (b.tok.k === 'text') {
      if (prev && (b.spc || b.x0 - endX(prev) > 0.2 * b.size)) out += ' ';
      out += b.tok.v;
      prev = b;
      i++;
      continue;
    }
    const run = [];
    let depth = 0;
    while (i < list.length) {
      const c = list[i];
      if (c.tok.k === 'text') {
        if (depth <= 0) break;
        // 괄호 안 쉼표("P(t², t)", "{-3, 0, 3}")는 본문 글꼴이어도 수식 안으로
        if (c.tok.v === ',' && list[i + 1] && list[i + 1].tok.k !== 'text') {
          run.push({ ...c, tok: { k: 'm', v: ',\\ ' } });
          i++;
          continue;
        }
        // 닫는 괄호 바로 앞의 짧은 글("{a | …, a는 실수}")도 수식 안 \text 로
        let j = i;
        while (j < list.length && list[j].tok.k === 'text') j++;
        if (j - i > 12 || !list[j] || ![')', ']', '\\}'].includes(list[j].tok.v)) break;
        run.push(...list.slice(i, j));
        i = j;
        continue;
      }
      if (['(', '[', '\\{'].includes(c.tok.v)) depth++;
      if ([')', ']', '\\}'].includes(c.tok.v)) depth = Math.max(0, depth - 1);
      run.push(c);
      i++;
    }
    const latex = mathLatex(run);
    if (prev && (run[0].spc || run[0].x0 - endX(prev) > 0.2 * s)) out += ' ';
    out += /^[()[\],.:]+$/.test(latex) ? latex : `$${latex}$`;
    prev = run[run.length - 1];
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** 한글이 없는 줄(쉼표 정도만 본문 글꼴) → 수식 한 줄 */
function rowLatex(items) {
  const list = items.map((b) => (b.tok.k === 'text' && /^[,.:;]$/.test(b.tok.v) ? { ...b, tok: { k: 'm', v: b.tok.v === ',' ? ',\\ ' : b.tok.v } } : b));
  return mathLatex(list);
}

/** 그림(그래프·도형·표): 이어진 도형 묶음 + 그 안의 이름표 글자 */
function findFigures(shapes, lines, boxes, R, s) {
  // 이름표가 될 수 있는 글자: 수식 글자, 본문 글꼴의 괄호·쉼표·숫자·영문. 본문 글자 크기(한글)와 견줌
  const labelish = (b) => real(b) && (b.tok.k !== 'text' || /^[(),.'\-0-9A-Za-z]$/.test(b.tok.v));
  const hs = median(boxes.filter((b) => b.tok.k === 'text' && HANGUL.test(b.tok.v)).map((b) => b.size)) || s;
  const W = R.x1 - R.x0;
  const area = W * (R.y1 - R.y0);
  const groups = [];
  const seps = []; // 긴 세로 구분선(풀이 옆 안내선 등). 그림에 닿을 때만 그림을 늘림
  for (const sh of shapes) {
    const w = sh.x1 - sh.x0;
    const h = sh.y1 - sh.y0;
    if (w < 0.8 && h < 0.8) continue; // 점
    if (w * h > 0.6 * area) continue; // 바탕
    if (sh.closed && !sh.image && sh.segs <= 12 && w > 0.25 * W && h > 1.2 * s) continue; // 글을 둘러싼 상자(<보기>, 조건 상자)
    const g = { x0: sh.x0, y0: sh.y0, x1: sh.x1, y1: sh.y1, curve: sh.curve || sh.image, segs: sh.segs, n: 1 };
    const crossed = lines.some((l) => l.x0 < sh.x0 - 0.5 && l.x1 > sh.x1 + 0.5 && l.y > sh.y0 + 0.5 && l.y < sh.y1 - 0.5);
    if (w < 0.8 && !g.curve && sh.segs <= 2 && h > 8 * s && !crossed) seps.push(g);
    else groups.push(g);
  }
  // 가로선은 홀로는 분수선일 수 있어 그림 조각으로 보지 않음. 다만 그림을 잇는 조각인 경우:
  //  - 도형(세로축·직선)을 가로질러 지나가는 선 (x축, y=1 같은 직선)
  //  - 세로 칸막이와 맞물린 격자 (표: 가로·세로 칸막이가 3개 이상씩)
  const lineBox = (l) => ({ x0: l.x0, y0: l.y - 0.2, x1: l.x1, y1: l.y + 0.2, curve: false, segs: 1, n: 1 });
  const shapeGroups = [...groups];
  const cross = (l, g) => l.x0 < g.x0 - 0.5 && l.x1 > g.x1 + 0.5 && l.y > g.y0 + 0.5 && l.y < g.y1 - 0.5;
  const grid = new Set();
  const vert = shapeGroups.filter((g) => g.x1 - g.x0 < 0.8 && !g.curve);
  const touch = (l, v) => v.x0 >= l.x0 - 1 && v.x0 <= l.x1 + 1 && l.y >= v.y0 - 1 && l.y <= v.y1 + 1;
  const seen = new Set();
  for (const start of lines) {
    if (seen.has(start)) continue;
    const ls = [];
    const vs = [];
    const queue = [{ line: start }];
    seen.add(start);
    while (queue.length) {
      const { line, v } = queue.pop();
      if (line) {
        ls.push(line);
        for (const o of vert) if (!seen.has(o) && touch(line, o)) {
          seen.add(o);
          queue.push({ v: o });
        }
      } else {
        vs.push(v);
        for (const o of lines) if (!seen.has(o) && touch(o, v)) {
          seen.add(o);
          queue.push({ line: o });
        }
      }
    }
    if (ls.length >= 3 && vs.length >= 3) ls.forEach((l) => grid.add(l));
  }
  for (const l of lines) if (grid.has(l) || shapeGroups.some((g) => cross(l, g))) groups.push(lineBox(l));
  const near = (a, b, d) => a.x0 - d < b.x1 && b.x0 - d < a.x1 && a.y0 - d < b.y1 && b.y0 - d < a.y1;
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < groups.length && !merged; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i];
        const b = groups[j];
        if (!near(a, b, 0.6 * s)) continue;
        groups[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), curve: a.curve || b.curve, segs: a.segs + b.segs, n: a.n + b.n };
        groups.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  const figs = [];
  for (const f of groups.filter((g) => (g.curve || g.segs >= 3 || g.n >= 3) && g.x1 - g.x0 >= 2.5 * s && g.y1 - g.y0 >= 2.5 * s)) {
    // 영역 맨 위의 얇고 넓은 띠("예제 ① 함수의 연속" 머리 장식): 그 안 글자와 함께 버림
    if (f.x1 - f.x0 > 0.7 * W && f.y1 - f.y0 < 5 * s && f.y0 < R.y0 + 2 * s) {
      figs.push({ ...f, deco: true });
      continue;
    }
    // 이름표가 한글뿐인 "그림"은 장식(유제·길잡이 탭) → 그림으로 보지 않고 글자로 옮김 (구분선으로 늘리기 전에 판단)
    const onlyHangul = (list) => list.length && list.every((b) => b.tok.k === 'text') && list.some((b) => HANGUL.test(b.tok.v));
    const pad0 = 0.4 * s;
    if (onlyHangul(boxes.filter((b) => real(b) && midX(b) > f.x0 - pad0 && midX(b) < f.x1 + pad0 && midY(b) > f.y0 - pad0 && midY(b) < f.y1 + pad0))) continue;
    for (const sp of seps) if (near(f, sp, 0.6 * s)) Object.assign(f, { x0: Math.min(f.x0, sp.x0), y0: Math.min(f.y0, sp.y0), x1: Math.max(f.x1, sp.x1), y1: Math.max(f.y1, sp.y1) });
    // 축 같은 가로선
    const used = [];
    for (const l of lines) {
      if (l.x1 >= f.x0 - 2 && l.x0 <= f.x1 + 2 && l.y >= f.y0 - 2 && l.y <= f.y1 + 2) {
        used.push(l);
        f.x0 = Math.min(f.x0, l.x0);
        f.x1 = Math.max(f.x1, l.x1);
      }
    }
    // 그림 안·바로 옆 이름표 글자. 걸친 이름표("2b-6/3" 분수, "y=t₂")는 붙은 글자까지 통째로. 더 늘지 않을 때까지
    const labels = new Set();
    const inside = (b, pad) => midX(b) > f.x0 - pad && midX(b) < f.x1 + pad && midY(b) > f.y0 - pad && midY(b) < f.y1 + pad;
    const grow = () => {
      for (let grew = true; grew; ) {
        grew = false;
        for (const b of boxes) {
          if (labels.has(b) || !labelish(b)) continue;
          // 같은 줄로 붙은 글자("y=x²" 뒤 "(x−3)²", "(1, f(1))" 의 쉼표), 또는 바로 옆 첨자("t₂" 의 ₂)
          const script = (l) => Math.min(b.size, l.size) < 0.9 * Math.max(b.size, l.size);
          if ([...labels].some((l) => Math.abs(b.base - l.base) < (script(l) ? 0.6 : 0.3) * s && b.x0 - endX(l) < 0.35 * s && l.x0 - b.x1 < 0.35 * s)) {
            labels.add(b);
            grew = true;
          }
        }
      }
      for (const b of labels) Object.assign(f, { x0: Math.min(f.x0, b.x0), x1: Math.max(f.x1, b.x1), y0: Math.min(f.y0, b.top), y1: Math.max(f.y1, b.bottom) });
    };
    for (let round = 0, size = -1; round < 10 && labels.size !== size; round++) {
      size = labels.size;
      // 처음 뒤로는 이름표 바로 곁의 수식 글자만 (그림 옆 본문 줄까지 번져 먹지 않게)
      const close = (b) => [...labels].some((l) => b.x0 - l.x1 < 0.5 * s && l.x0 - b.x1 < 0.5 * s && b.top - l.bottom < 0.5 * s && l.top - b.bottom < 0.5 * s);
      for (const b of boxes) if ((!round || (b.tok.k !== 'text' && close(b))) && inside(b, round ? 0 : 0.4 * s)) labels.add(b);
      // 그림 가장자리에 닿은 수식 이름표 (점선 끝 바로 아래 "x=1"). 본문보다 작은 글자는 조금 떨어져 있어도 (그래프 위 "y=f(x)")
      if (!round) for (const b of boxes) if (labelish(b) && near(f, { x0: b.x0, y0: b.top, x1: b.x1, y1: b.bottom }, b.size < 0.95 * hs ? 0.8 * hs : 0.3 * s)) labels.add(b);
      grow();
    }
    // 늘어난 상자 안 글자는 어차피 그림으로 빠지므로, 그 곁에 붙은 첨자까지 한 번 더 함께 ("y=t₂" 의 ₂ 만 남지 않게)
    for (const b of boxes) if (inside(b, 0)) labels.add(b);
    grow();
    if (onlyHangul([...labels].filter(real))) continue;
    for (const l of used) l.used = true;
    for (const l of lines) if (l.x0 >= f.x0 - 1 && l.x1 <= f.x1 + 1 && l.y >= f.y0 - 1 && l.y <= f.y1 + 1) l.used = true;
    figs.push(f);
  }
  return figs;
}

const wordCache = new WeakMap();
/** 쪽 안의 한글 낱말들(한 줄 안에서 붙어 있는 글자들). 줄 끝에서 끊긴 낱말을 이을 때 씀 */
function pageWords(layer) {
  if (!wordCache.has(layer)) {
    const gl = layer.glyphs.filter((g) => /[가-힣]/.test(g.c)).sort((a, b) => a.base - b.base || a.x0 - b.x0);
    let words = '';
    let prev = null;
    for (const g of gl) {
      const joined = prev && Math.abs(g.base - prev.base) < 0.3 && Math.abs(g.x0 - prev.x1) < 0.15 * g.size;
      words += (joined ? '' : '\n') + g.c;
      prev = g;
    }
    wordCache.set(layer, words);
  }
  return wordCache.get(layer);
}

/**
 * 줄바꿈으로 나뉜 두 줄을 이음. spaced: 앞 줄 끝에 빈칸 글자가 있었는지 (모르면 null)
 * 모를 때는 짐작: 수식 뒤 한글("$48$"+"이다"), 조사 한 글자("x축"+"의"), 쪽 안에 이어진 꼴이 있는 낱말("그래"+"프는")은 붙여 씀
 */
// 수식 바로 뒤에 붙지 않는 낱말 (수식으로 끝난 줄 다음 줄이 이 낱말로 시작하면 띄어 씀)
const CONJ = /^(또는|그리고|및|즉|따라서|이때|그러므로|또|한편|그런데|이상에서)$/;

function joinLines(a, b, spaced, words) {
  if (spaced != null) return spaced ? `${a} ${b}` : a + b;
  const tail = a.match(/[가-힣]+$/)?.[0];
  const head = b.match(/^[가-힣]+/)?.[0];
  if (head && a.endsWith('$') && !CONJ.test(head)) return a + b;
  if (tail && head && (/^[의는은을를이가에와과도로만]$/.test(head) || words.includes(tail + head[0]))) return a + b;
  return `${a} ${b}`;
}

/** 문항 코드 "[26009-0010]" 는 옮기지 않음 (책 정리용 번호) */
function dropItemCodes(boxes) {
  const text = boxes.filter((b) => b.tok.k === 'text').sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const drop = new Set();
  for (let i = 0; i < text.length; i++) {
    if (text[i].tok.v !== '[') continue;
    let str = '';
    const run = [];
    for (let j = i; j < text.length && j < i + 13 && Math.abs(text[j].base - text[i].base) < 0.5; j++) {
      str += text[j].tok.v;
      run.push(text[j]);
      if (/^\[\d{5}-\d{4}\]$/.test(str)) run.forEach((b) => drop.add(b));
    }
  }
  return drop.size ? boxes.filter((b) => !drop.has(b)) : boxes;
}

function regionBlocks(layer, rect, place) {
  const R = { x0: rect.x * layer.w, y0: rect.y * layer.h, x1: (rect.x + rect.w) * layer.w, y1: (rect.y + rect.h) * layer.h };
  const inR = (b) => midX(b) >= R.x0 - 1 && midX(b) <= R.x1 + 1 && midY(b) >= R.y0 - 1 && midY(b) <= R.y1 + 1;
  let boxes = [];
  for (const gl of layer.glyphs) {
    if (!inR(gl) || SKIP_FONTS.test(gl.fam)) continue;
    if (gl.rot) fail(`돌려 놓은 글자 ${gl.fam} "${gl.c}"`);
    const tok = decodeGlyph(gl.c, gl.fam, gl.style);
    if (!tok) fail(`모르는 기호 ${gl.fam}-${gl.style} "${gl.c}" (U+${gl.c.codePointAt(0).toString(16).toUpperCase()})`);
    if (tok.k === 'skip') continue;
    const ink = tok.hi != null ? { top: gl.base - tok.hi * gl.size, bottom: gl.base - tok.lo * gl.size } : { top: gl.top, bottom: gl.bottom };
    // 빈칸 중 본문 글꼴 것(낱말 사이), 가는 것(첨자 뒤 "`" 등 모양 맞춤)
    const sp = tok.k === 'sp' ? { textSp: !gl.fam.startsWith('EH'), thin: /[`\b\u0007\u0003]/.test(gl.c) } : null;
    boxes.push({ x0: gl.x0, x1: gl.x1, ...ink, base: gl.base, size: gl.size, xem: gl.xem, seq: gl.seq, fam: gl.fam, tok, ...sp });
  }
  boxes = dropItemCodes(boxes);
  if (!boxes.some(real)) return [];
  const s = median(boxes.filter((b) => real(b) && b.size >= 6).map((b) => b.size)) || 10;

  // 그림부터 떼어 냄 (그래프 축을 분수선으로 읽지 않게)
  const lines = layer.lines.filter((l) => !l.light && l.x1 > R.x0 && l.x0 < R.x1 && l.y > R.y0 - 1 && l.y < R.y1 + 1).map((l) => ({ ...l }));
  const shapes = layer.shapes.filter((sh) => !sh.light && sh.x1 > R.x0 && sh.x0 < R.x1 && sh.y1 > R.y0 && sh.y0 < R.y1);
  const figs = findFigures(shapes, lines, boxes, R, s);
  boxes = boxes.filter((b) => !figs.some((f) => midX(b) >= f.x0 && midX(b) <= f.x1 && midY(b) >= f.y0 && midY(b) <= f.y1));
  const free = lines.filter((l) => !l.used);

  boxes = glyphFractions(boxes, free);
  boxes = limits(boxes);
  boxes = structures(boxes, free, s);
  boxes = makeCases(boxes, s);
  const left = boxes.find((b) => ['fr', 'rad', 'radx', 'brace'].includes(b.tok.k));
  if (left) fail(`풀지 못한 조각(${left.tok.k})`);

  // 줄 → 블록 (그림은 제자리에)
  // endSp: 줄 끝에 빈칸 글자가 있음. 이 교재는 낱말 사이에서 줄을 바꾸면 줄 끝에 빈칸을 남기고, 낱말 중간("그래|프는")에서 바꾸면 남기지 않음
  const rows = clusterRows(boxes, s)
    .map((items) => {
      const r = items.filter(real);
      if (!r.length) return null;
      const last = items[items.length - 1];
      return {
        items,
        x0: Math.min(...r.map((b) => b.x0)),
        x1: Math.max(...r.map((b) => b.x1)),
        top: Math.min(...r.map((b) => b.top)),
        bottom: Math.max(...r.map((b) => b.bottom)),
        base: mainLine(r).base,
        endSp: !real(last) && !last.thin,
        endText: !real(last) && last.textSp,
        // 줄 끝 글자: 'math' 수식, 'hangul' 한글, 'other' 문장부호 등
        endWord: r[r.length - 1].tok.k !== 'text' ? 'math' : /[가-힣]$/.test(r[r.length - 1].tok.v) ? 'hangul' : 'other',
      };
    })
    .filter(Boolean);
  // 줄 끝 빈칸을 남기는 PDF 인지 (아니면 낱말 짐작으로 이음)
  const marked = rows.some((r) => r.endText);
  const right = rows.length ? Math.max(...rows.map((r) => r.x1)) : R.x1;
  const shown = figs.filter((f) => !f.deco);
  // 그림 옆 줄은 그림 앞에서 줄을 바꿈
  const rightOf = (r) => Math.min(right, ...shown.filter((f) => f.x0 >= r.x1 - 1 && f.y0 < r.bottom && f.y1 > r.top).map((f) => f.x0 - 0.5 * s));
  const flow = rows.map((r) => ({ row: r, y: r.base }));
  for (const f of shown) {
    // 옆에 글이 있는 그림은 그 글 뒤에
    const beside = rows.filter((r) => r.x1 <= f.x0 + 1 && r.bottom > f.y0 && r.top < f.y1);
    flow.push({ fig: f, beside: beside.length > 0, y: beside.length ? Math.max(...beside.map((r) => r.base)) + 0.01 : f.y0 });
  }
  // 나란히 놓인 그림들은 왼쪽부터
  const figFlow = flow.filter((e) => e.fig).sort((a, b) => a.fig.y0 - b.fig.y0);
  const sideBySide = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0);
  for (let i = 0; i < figFlow.length; ) {
    let j = i + 1;
    while (j < figFlow.length && sideBySide(figFlow[i].fig, figFlow[j].fig)) j++;
    const grp = figFlow.slice(i, j).sort((a, b) => a.fig.x0 - b.fig.x0);
    const y = Math.min(...grp.map((e) => e.y));
    grp.forEach((e, k) => (e.y = y + k * 1e-4));
    i = j;
  }
  flow.sort((a, b) => a.y - b.y);

  const blocks = [];
  let para = null;
  const toPlace = (f) => {
    const pad = 2;
    const x0 = Math.max(R.x0, f.x0 - pad);
    const x1 = Math.min(R.x1, f.x1 + pad);
    const y0 = Math.max(R.y0, f.y0 - pad);
    const y1 = Math.min(R.y1, f.y1 + pad);
    return { x: place.x + ((x0 - R.x0) / (R.x1 - R.x0)) * place.w, y: place.y + ((y0 - R.y0) / (R.y1 - R.y0)) * place.h, w: ((x1 - x0) / (R.x1 - R.x0)) * place.w, h: ((y1 - y0) / (R.y1 - R.y0)) * place.h };
  };
  // 옆에 글이 있는 그림은 그 글의 문단이 끝난 뒤에 (문단 가운데 끼지 않게)
  const later = [];
  const flush = () => {
    for (const f of later.splice(0)) blocks.push({ type: 'figure', box: toPlace(f) });
  };
  for (const { row, fig, beside } of flow) {
    if (fig) {
      if (beside) later.push(fig);
      else {
        flush();
        blocks.push({ type: 'figure', box: toPlace(fig) });
        para = null;
      }
      continue;
    }
    const items = row.items;
    const text = rowString(items, s);
    // 문항 코드, 유제 띠의 "정답과 풀이 10쪽" 안내는 옮기지 않음
    if (!text || /^\[\d{5}-\d{4}\]$/.test(text) || /^(유제\s*)?정답과 풀이 \d+쪽$/.test(text)) continue;
    // 보기 ①~⑤
    // "답 ③" 의 번호는 보기가 아님
    const reals = items.filter(real);
    const marks = reals.filter((b, i) => b.tok.k === 'text' && MARKS.includes(b.tok.v) && reals[i - 1]?.tok.v !== '답');
    const first = items.find(real);
    // 오른쪽 끝에 번호 하나만 있는 줄은 답 표시(글자가 아닌 "답" 그림 옆)
    if (marks.length === 1 && reals.length === 1 && row.x0 > R.x0 + 0.5 * (R.x1 - R.x0)) {
      flush();
      blocks.push({ type: 'para', text: `답 ${marks[0].tok.v}` });
      para = null;
      continue;
    }
    const prev = blocks[blocks.length - 1];
    const prevChoices = prev?.type === 'choices';
    // 번호가 ①부터(이어지는 줄은 앞 줄 다음 번호부터) 차례로일 때만 보기. 정답표 "1 ③ 2 ① …" 는 글
    const from = prevChoices ? prev.items.length : 0;
    const inOrder = marks.length > 0 && marks.every((m, k) => m.tok.v === MARKS[from + k]);
    if (inOrder && (marks.length >= 2 || (first === marks[0] && prevChoices))) {
      if (first !== marks[0]) fail('보기 번호 앞에 글이 있음');
      const list = prevChoices ? prev.items : [];
      for (let k = 0; k < marks.length; k++) {
        const a = items.indexOf(marks[k]);
        const z = k + 1 < marks.length ? items.indexOf(marks[k + 1]) : items.length;
        list.push(rowString(items.slice(a + 1, z), s));
      }
      if (!prevChoices) {
        flush();
        blocks.push({ type: 'choices', items: list });
      }
      para = null;
      continue;
    }
    const hangul = items.some((b) => b.tok.k === 'text' && (HANGUL.test(b.tok.v) || /[A-Za-z]/.test(b.tok.v) || MARKS.includes(b.tok.v)));
    const fresh = /^(ㄱ|ㄴ|ㄷ|ㄹ|ㅁ)\.|^\((가|나|다|라|마)\)|^<보기>|^답\b|^\((i|ii|iii|iv|v)\)/.test(text);
    // 앞 줄이 오른쪽 끝까지 찼으면 이어지는 줄.
    // 줄 끝 빈칸을 남기는 PDF 에서 빈칸이 없으면 낱말 중간에서 바꾼 줄만 이어짐: 한글|한글("그래|프는"), 수식|조사("F(x)|의")
    // 그 밖("…이다." / "풀이", "…하면" / "f(x)=…", "a=−2/3" / "또 함수")은 오른쪽 끝에 닿았어도 새 문단
    const head = text.match(/^[가-힣]+/)?.[0];
    const midWord = !!head && (para?.endWord === 'hangul' || (para?.endWord === 'math' && !CONJ.test(head)));
    const cont = para && !fresh && para.x1 >= para.right - 2.5 * s && Math.abs(row.x0 - para.x0) < 1.2 * s && (!marked || para.endSp || midWord);
    if (cont) {
      para.block.text = joinLines(para.block.text, text, marked ? para.endSp : null, pageWords(layer));
      Object.assign(para, { x1: row.x1, right: rightOf(row), endSp: row.endSp, endWord: row.endWord });
      continue;
    }
    flush();
    if (!hangul) {
      blocks.push({ type: 'math', latex: rowLatex(items) });
      para = null;
      continue;
    }
    const block = { type: 'para', text };
    blocks.push(block);
    para = { block, x0: row.x0, x1: row.x1, right: rightOf(row), endSp: row.endSp, endWord: row.endWord };
  }
  flush();
  return blocks;
}

/**
 * 문항 영역들(쪽 여러 곳에 걸칠 수 있음) → 블록. 옮길 수 없으면 null
 * @param {{layer:object, rect:{x,y,w,h}, place:{x,y,w,h}}[]} parts
 *   layer: readPageLayer 결과, rect: 쪽에 대한 비율 좌표, place: 쌓은 그림(문항 하나를 세로로 이어 붙인 그림) 안의 그 영역 자리(비율)
 *   그림 블록의 box 는 쌓은 그림에 대한 비율이라 AI 가 옮긴 결과와 같은 방법으로 잘라 쓸 수 있습니다.
 * @param {{explain?:boolean}} opts explain 이면 실패할 때 null 대신 {fail: 이유}
 */
export function transcribeParts(parts, { explain = false } = {}) {
  try {
    // 수식 글꼴(EH…)로 만든 PDF 만 (다른 출판사 PDF 의 수식 글꼴은 아직 모름)
    if (!parts.length || !parts.every((p) => p.layer.glyphs.some((g) => g.fam.startsWith('EH')))) fail('수식 글꼴(EH…)로 만든 PDF 가 아님');
    const blocks = [];
    for (const p of parts) blocks.push(...regionBlocks(p.layer, p.rect, p.place));
    if (!blocks.some((b) => b.type !== 'figure')) fail('읽은 글자가 없음');
    return blocks;
  } catch (err) {
    if (!(err instanceof Fail)) throw err;
    return explain ? { fail: err.message } : null;
  }
}
