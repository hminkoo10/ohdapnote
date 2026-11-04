// BBox 밖의 글자만 제거. 남는 연산은 원본 바이트를 보존합니다.
import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from '../vendor/pdf-lib.esm.min.js';

const IDENTITY = [1, 0, 0, 1, 0, 0];
const encoder = new TextEncoder();
const name = (s) => PDFName.of(s);
const fail = () => { throw new Error('PDF 내용 스트림을 안전하게 해석할 수 없음'); };
const space = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const delimiter = (c) => c === undefined || space(c) || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const ascii = (bytes) => { let s = ''; for (const c of bytes) s += String.fromCharCode(c); return s; };
const hex = (c) => c !== undefined && /[0-9a-fA-F]/.test(String.fromCharCode(c));
const tracked = new Set(['q', 'Q', 'cm', 'BT', 'ET', 'Tf', 'Tc', 'Tw', 'Tz', 'TL', 'Ts', 'Tr', 'Tm', 'Td', 'TD', 'T*', 'gs', 'Do', 'Tj', 'TJ', "'", '"', 'ID', 'EI']);
const documents = new WeakMap();
const graphicsOnly = new Set(['q', 'Q', 'cm', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs', 'CS', 'cs', 'SC', 'SCN', 'sc', 'scn', 'G', 'g', 'RG', 'rg', 'K', 'k', 'm', 'l', 'c', 'v', 'y', 'h', 're', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n', 'W', 'W*', 'sh']);
const pathOps = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const paintOps = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);

// PDF 행벡터의 Tm × CTM을 열벡터 표기로 계산.
function multiply(a, b) {
  if (!a || !b) return null;
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
const translate = (m, x, y) => multiply(m, [1, 0, 0, 1, x, y]);

class Reader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }

  skip() {
    const b = this.bytes;
    while (this.pos < b.length) {
      if (space(b[this.pos])) this.pos++;
      else if (b[this.pos] === 37) {
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  read(depth = 0) {
    if (depth > 64) fail();
    this.skip();
    const b = this.bytes;
    const start = this.pos;
    if (start === b.length) return null;
    const c = b[this.pos++];
    let kind, value;
    if (c === 40) {
      kind = 'string';
      const out = [];
      let nesting = 1;
      while (nesting) {
        if (this.pos >= b.length) fail();
        let ch = b[this.pos++];
        if (ch === 92) {
          if (this.pos >= b.length) fail();
          ch = b[this.pos++];
          if (ch === 10 || ch === 13) {
            if (ch === 13 && b[this.pos] === 10) this.pos++;
            continue;
          }
          if (ch >= 48 && ch <= 55) {
            let n = ch - 48;
            for (let i = 0; i < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; i++) n = n * 8 + b[this.pos++] - 48;
            out.push(n & 255);
          } else out.push(({ 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 })[ch] ?? ch);
        } else if (ch === 41) {
          if (--nesting) out.push(ch);
        } else {
          if (ch === 40) nesting++;
          if (ch === 13) { if (b[this.pos] === 10) this.pos++; ch = 10; }
          out.push(ch);
        }
      }
      value = Uint8Array.from(out);
    } else if (c === 60 && b[this.pos] !== 60) {
      kind = 'string';
      let digits = '';
      while (this.pos < b.length && b[this.pos] !== 62) {
        const ch = b[this.pos++];
        if (space(ch)) continue;
        if (!hex(ch)) fail();
        digits += String.fromCharCode(ch);
      }
      if (b[this.pos++] !== 62) fail();
      if (digits.length % 2) digits += '0';
      value = Uint8Array.from(digits.match(/../g) || [], (s) => parseInt(s, 16));
    } else if (c === 91 || (c === 60 && b[this.pos] === 60)) {
      kind = c === 91 ? 'array' : 'dict';
      if (kind === 'dict') this.pos++;
      value = [];
      while (true) {
        this.skip();
        if (b[this.pos] === (kind === 'array' ? 93 : 62)) {
          this.pos++;
          if (kind === 'dict' && b[this.pos++] !== 62) fail();
          break;
        }
        const token = this.read(depth + 1);
        if (!token) fail();
        value.push(token);
      }
    } else if (c === 47) {
      kind = 'name';
      value = '';
      while (!delimiter(b[this.pos])) {
        const ch = b[this.pos++];
        if (ch === 35) {
          if (!hex(b[this.pos]) || !hex(b[this.pos + 1])) fail();
          value += String.fromCharCode(parseInt(ascii(b.subarray(this.pos, this.pos + 2)), 16));
          this.pos += 2;
        } else value += String.fromCharCode(ch);
      }
    } else {
      if (delimiter(c)) fail();
      value = String.fromCharCode(c);
      while (!delimiter(b[this.pos])) value += String.fromCharCode(b[this.pos++]);
      kind = /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value) ? 'number' : 'word';
      if (kind === 'number') { value = Number(value); if (!Number.isFinite(value)) fail(); }
    }
    return { kind, value, start, end: this.pos };
  }

  inlineImage() {
    const params = new Map();
    while (true) {
      const key = this.read();
      if (key?.kind === 'word' && key.value === 'ID') break;
      if (key?.kind !== 'name') fail();
      const value = this.read();
      if (!value) fail();
      params.set(key.value, value);
    }
    const b = this.bytes;
    if (!space(b[this.pos])) fail();
    if (b[this.pos++] === 13 && b[this.pos] === 10) this.pos++;
    const start = this.pos;
    const get = (short, long) => params.get(short) || params.get(long);
    let filter = get('F', 'Filter');
    if (filter?.kind === 'array') filter = filter.value[0];
    if (!filter) {
      const w = get('W', 'Width')?.value, h = get('H', 'Height')?.value;
      const mask = get('IM', 'ImageMask')?.value === 'true';
      const bits = mask ? 1 : get('BPC', 'BitsPerComponent')?.value;
      let cs = get('CS', 'ColorSpace');
      if (cs?.kind === 'array') cs = cs.value[0];
      const components = mask ? 1 : ({ G: 1, DeviceGray: 1, RGB: 3, DeviceRGB: 3, CMYK: 4, DeviceCMYK: 4, I: 1, Indexed: 1 })[cs?.value];
      if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || ![1, 2, 4, 8, 16].includes(bits) || !components) fail();
      this.pos += Math.ceil(w * components * bits / 8) * h;
    } else if (['AHx', 'ASCIIHexDecode', 'A85', 'ASCII85Decode'].includes(filter.value)) {
      const end = filter.value === 'AHx' || filter.value === 'ASCIIHexDecode' ? '>' : '~>';
      while (this.pos < b.length && ascii(b.subarray(this.pos, this.pos + end.length)) !== end) this.pos++;
      this.pos += end.length;
    } else if (filter.value === 'RL' || filter.value === 'RunLengthDecode') {
      while (this.pos < b.length) {
        const n = b[this.pos++];
        if (n === 128) break;
        this.pos += n < 128 ? n + 1 : 1;
      }
    } else if (filter.value === 'Fl' || filter.value === 'FlateDecode') {
      // EI를 검색하지 않고 압축 스트림의 끝을 사용.
      const dict = PDFContext.create().obj({ Filter: 'FlateDecode' });
      const decoded = decodePDFRawStream({ dict, contents: b.subarray(start) });
      decoded.decode();
      this.pos = start + decoded.stream.pos - Math.floor(decoded.codeSize / 8) + 4; // zlib 체크섬
    } else if (filter.value === 'DCT' || filter.value === 'DCTDecode') {
      if (b[this.pos++] !== 255 || b[this.pos++] !== 216) fail();
      while (this.pos < b.length) {
        if (b[this.pos++] !== 255) continue;
        while (b[this.pos] === 255) this.pos++;
        const marker = b[this.pos++];
        if (marker === 217) break;
        if (marker === 0 || marker === 1 || (marker >= 208 && marker <= 216)) continue;
        const length = b[this.pos] * 256 + b[this.pos + 1];
        if (!(length >= 2)) fail();
        this.pos += length;
      }
    } else fail(); // 끝을 확정할 수 없는 필터는 원본 유지.
    if (!space(b[this.pos])) fail();
    while (space(b[this.pos])) this.pos++;
    if (b[this.pos++] !== 69 || b[this.pos++] !== 73 || !delimiter(b[this.pos])) fail();
  }
}

function operations(bytes) {
  const reader = new Reader(bytes);
  const result = [], stack = [], graphics = [];
  let args = [], token;
  let ctm = IDENTITY, path = false, inText = false;
  while ((token = reader.read())) {
    if (token.kind !== 'word' || ['true', 'false', 'null'].includes(token.value)) { args.push(token); continue; }
    if (token.value === 'BI') {
      if (args.length) fail();
      reader.inlineImage();
      token.end = reader.pos;
    }
    const op = token.value, start = args[0]?.start ?? token.start;
    // 열린 경로·글자·하위 폼 없는 q/Q 구간만 독립 그림으로 공유 가능.
    if (op === 'q') stack.push({ start, ctm, safe: !path && !inText, first: graphics.length });
    else if (op === 'Q') {
      const block = stack.pop();
      if (!block) fail();
      if (block.safe && !path && token.end - block.start >= 1024) {
        graphics.length = block.first;
        graphics.push({ start: block.start, end: token.end, ctm: block.ctm });
      }
      if (stack.length && !block.safe) stack[stack.length - 1].safe = false;
      ctm = block.ctm;
    } else if (op === 'cm') ctm = args.length === 6 && args.every((a) => a.kind === 'number') ? multiply(ctm, args.map((a) => a.value)) : null;
    if (op === 'BT') inText = true;
    if (op === 'ET') inText = false;
    if (pathOps.has(op)) path = true;
    if (paintOps.has(op)) path = false;
    if (stack.length && !graphicsOnly.has(op)) stack[stack.length - 1].safe = false;
    if (tracked.has(op)) result.push({ op, args, start, end: token.end });
    args = [];
  }
  if (args.length) fail();
  result.graphics = graphics;
  return result;
}

const get = (dict, key) => dict instanceof PDFDict ? dict.lookup(name(key)) : undefined;
const pdfName = (v) => v instanceof PDFName ? v.decodeText() : undefined;
function number(v, fallback) {
  if (v === undefined && fallback !== undefined) return fallback;
  if (!(v instanceof PDFNumber) || !Number.isFinite(v.asNumber())) fail();
  return v.asNumber();
}
function numbers(array, length) {
  if (!(array instanceof PDFArray) || array.size() !== length) fail();
  return Array.from({ length }, (_, i) => number(array.lookup(i)));
}

/** PDF 글꼴 사전 → 코드 폭. 지원하지 않는 글꼴은 null. */
export function fontMetrics(font) {
  const subtype = pdfName(get(font, 'Subtype'));
  if (['Type1', 'TrueType', 'MMType1'].includes(subtype)) {
    const widths = get(font, 'Widths');
    if (!(widths instanceof PDFArray)) return null;
    const first = number(get(font, 'FirstChar'));
    const missing = number(get(get(font, 'FontDescriptor'), 'MissingWidth'), 0);
    const values = Array.from({ length: widths.size() }, (_, i) => number(widths.lookup(i)));
    return { codeBytes: 1, width: (c) => values[c - first] ?? missing };
  }
  if (subtype !== 'Type0' || pdfName(get(font, 'Encoding')) !== 'Identity-H') return null;
  const descendants = get(font, 'DescendantFonts');
  if (!(descendants instanceof PDFArray) || !descendants.size()) return null;
  const cid = descendants.lookup(0);
  const dw = number(get(cid, 'DW'), 1000);
  const w = get(cid, 'W');
  if (w !== undefined && !(w instanceof PDFArray)) fail();
  const ranges = [];
  for (let i = 0; w && i < w.size();) {
    const first = number(w.lookup(i++));
    const next = w.lookup(i++);
    if (next instanceof PDFArray) {
      const values = Array.from({ length: next.size() }, (_, j) => number(next.lookup(j)));
      ranges.push({ first, last: first + values.length - 1, values });
    } else {
      const last = number(next), width = number(w.lookup(i++));
      if (last < first) fail();
      ranges.push({ first, last, width });
    }
  }
  ranges.sort((a, b) => a.first - b.first);
  for (let i = 1; i < ranges.length; i++) if (ranges[i - 1].last >= ranges[i].first) fail();
  return { codeBytes: 2, width: (c) => {
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1, range = ranges[mid];
      if (c < range.first) hi = mid - 1;
      else if (c > range.last) lo = mid + 1;
      else return range.values ? range.values[c - range.first] : range.width;
    }
    return dw;
  } };
}

function initialState() {
  return { ctm: IDENTITY, tm: IDENTITY, tlm: IDENTITY, font: null, size: 0, tc: 0, tw: 0, th: 1, leading: 0, rise: 0, render: 0, inText: false };
}

function advance(parts, state) {
  const { font, size, tc, tw, th } = state;
  if (!font) return null;
  let tx = 0, min = 0, max = 0, glyphs = 0;
  for (const part of parts) {
    if (part.kind === 'number') tx -= part.value / 1000 * size * th;
    else {
      const b = part.value;
      if (b.length % font.codeBytes) return null;
      for (let i = 0; i < b.length; i += font.codeBytes) {
        const code = font.codeBytes === 2 ? b[i] * 256 + b[i + 1] : b[i];
        const width = font.width(code);
        if (!Number.isFinite(width)) return null;
        const end = tx + width / 1000 * size * th;
        min = Math.min(min, tx, end); max = Math.max(max, tx, end);
        tx = end + (tc + (font.codeBytes === 1 && code === 32 ? tw : 0)) * th;
        glyphs++;
      }
    }
    min = Math.min(min, tx); max = Math.max(max, tx);
  }
  return [tx, min, max, glyphs].every(Number.isFinite) ? { tx, min, max, glyphs } : null;
}

function bounds(state, run) {
  const m = multiply(state.ctm, state.tm);
  if (!m || !m.every(Number.isFinite)) return null;
  const xs = [], ys = [];
  for (const x of [run.min, run.max]) for (const y of [state.rise - 0.25 * state.size, state.rise + state.size]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const outside = (rect, box) => rect[2] < box[0] - 1 || rect[0] > box[2] + 1 || rect[3] < box[1] - 1 || rect[1] > box[3] + 1;

// PDF 숫자는 지수 표기를 허용하지 않음.
function decimal(n) {
  if (!Number.isFinite(n)) fail();
  const s = String(n);
  if (!/[eE]/.test(s)) return s;
  const [coefficient, exponent] = s.split('e');
  const sign = coefficient.startsWith('-') ? '-' : '';
  const [whole, fraction = ''] = coefficient.replace('-', '').split('.');
  const digits = whole + fraction, point = whole.length + Number(exponent);
  return sign + (point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point));
}

function scan(ops, fonts, initial = initialState(), onForm, onGraphics) {
  let state = { ...initial };
  const stack = [], edits = [];
  const nextLine = (x, y) => { state.tlm = translate(state.tlm, x, y); state.tm = state.tlm; };
  for (const { op, args, start, end } of ops) {
    const expect = (...kinds) => {
      if (args.length !== kinds.length || args.some((a, i) => a.kind !== kinds[i])) fail();
      return args.map((a) => a.value);
    };
    switch (op) {
      case 'q': expect(); stack.push({ ...state }); break;
      case 'Q': expect(); if (!stack.length) fail(); state = stack.pop(); break;
      case 'cm': state.ctm = multiply(state.ctm, expect('number', 'number', 'number', 'number', 'number', 'number')); break;
      case 'BT': expect(); if (state.inText) fail(); state.inText = true; state.tm = state.tlm = IDENTITY; break;
      case 'ET': expect(); if (!state.inText) fail(); state.inText = false; break;
      case 'Tf': { const [f, size] = expect('name', 'number'); state.font = fonts(f); state.size = size; break; }
      case 'Tc': [state.tc] = expect('number'); break;
      case 'Tw': [state.tw] = expect('number'); break;
      case 'Tz': state.th = expect('number')[0] / 100; break;
      case 'TL': [state.leading] = expect('number'); break;
      case 'Ts': [state.rise] = expect('number'); break;
      case 'Tr': [state.render] = expect('number'); break;
      case 'Tm': state.tm = state.tlm = expect('number', 'number', 'number', 'number', 'number', 'number'); break;
      case 'Td': case 'TD': {
        const [x, y] = expect('number', 'number');
        if (op === 'TD') state.leading = -y;
        nextLine(x, y); break;
      }
      case 'T*': expect(); nextLine(0, -state.leading); break;
      case 'gs': { const [key] = expect('name'); if (onGraphics) onGraphics(key, state); else state.font = null; break; }
      case 'Do': { const [key] = expect('name'); onForm?.(key, { ...state }); break; }
      case 'Tj': case 'TJ': case "'": case '"': {
        if (!state.inText) fail();
        let parts;
        if (op === 'TJ') {
          [parts] = expect('array');
          if (parts.some((p) => p.kind !== 'number' && p.kind !== 'string')) fail();
        } else {
          if (op === '"') [state.tw, state.tc] = expect('number', 'number', 'string');
          else expect('string');
          parts = [args[args.length - 1]];
        }
        if (op === "'" || op === '"') nextLine(0, -state.leading);
        const run = advance(parts, state);
        // 윤곽선·글자 클리핑은 뒤의 그림에도 영향을 줄 수 있음.
        if (run?.glyphs && state.size !== 0 && state.th !== 0 && [0, 3].includes(state.render)) {
          const n = -run.tx * 1000 / (state.size * state.th);
          const rect = bounds(state, run);
          if (rect && Number.isFinite(n)) {
            const prefix = op === '"' ? `${decimal(state.tw)} Tw ${decimal(state.tc)} Tc T* ` : op === "'" ? 'T* ' : '';
            edits.push({ start, end, rect, text: ` ${prefix}[${decimal(n)}] TJ ` });
          }
        }
        state.tm = run ? translate(state.tm, run.tx, 0) : null;
        break;
      }
      case 'BI': break;
      case 'ID': case 'EI': fail(); break;
    }
  }
  if (stack.length || state.inText !== initial.inText) fail();
  return edits;
}

function splice(bytes, edits) {
  if (!edits.length) return bytes;
  const chunks = [];
  let pos = 0;
  for (const edit of edits) {
    chunks.push(bytes.subarray(pos, edit.start), encoder.encode(edit.text));
    pos = edit.end;
  }
  chunks.push(bytes.subarray(pos));
  const out = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0));
  pos = 0;
  for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
  return out;
}

/** 풀린 바이트 + [left, bottom, right, top] + Map<글꼴 이름, fontMetrics 결과>. */
export function filterContent(bytes, bbox, fonts) {
  return splice(bytes, scan(operations(bytes), (key) => fonts.get(key)).filter((e) => outside(e.rect, bbox)));
}

function decoded(stream) {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (typeof stream?.getUnencodedContents === 'function') return stream.getUnencodedContents();
  fail();
}

async function transformBytes(bytes, transform) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer());
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function graphicBox(m, box) {
  if (!m || !(box instanceof PDFArray)) return null;
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10) return null;
  const b = numbers(box, 4), xs = [], ys = [];
  for (const x of [b[0], b[2]]) for (const y of [b[1], b[3]]) {
    xs.push((m[3] * (x - m[4]) - m[2] * (y - m[5])) / det);
    ys.push((-m[1] * (x - m[4]) + m[0] * (y - m[5])) / det);
  }
  if (![...xs, ...ys].every(Number.isFinite)) return null;
  return [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1];
}

// 문서가 해제되면 원본·분석·복제본 캐시도 함께 해제.
function documentCache(context) {
  if (!documents.has(context)) documents.set(context, { streams: new WeakMap(), fonts: new WeakMap(), fontIds: new WeakMap(), nextFont: 1, done: new WeakSet(), contents: new Map() });
  return documents.get(context);
}

/** 문항별 Form을 만든 뒤, 성공한 경우에만 같은 ref로 교체. */
export async function stripHiddenText(pdfDoc, embeddedPage) {
  await embeddedPage.embed();
  const context = pdfDoc.context, cache = documentCache(context);
  const root = context.lookup(embeddedPage.ref);
  if (cache.done.has(root)) return;
  const bbox = numbers(get(root.dict, 'BBox'), 4);
  if (bbox[0] > bbox[2] || bbox[1] > bbox[3]) fail();
  let visits = 0;

  const metrics = (font) => {
    if (!(font instanceof PDFDict)) return null;
    if (!cache.fonts.has(font)) {
      const value = fontMetrics(font);
      cache.fonts.set(font, value);
      if (value) cache.fontIds.set(value, cache.nextFont++);
    }
    return cache.fonts.get(font);
  };

  async function entry(stream, source) {
    if (!cache.streams.has(source)) {
      const raw = stream instanceof PDFRawStream && pdfName(get(stream.dict, 'Filter')) === 'FlateDecode' && !get(stream.dict, 'DecodeParms');
      const compressed = raw ? stream.contents : null;
      const bucket = compressed ? (cache.contents.get(compressed.length) || []) : [];
      let data = bucket.find((item) => equalBytes(item.compressed, compressed));
      if (!data) {
        const bytes = raw && typeof DecompressionStream === 'function'
          ? await transformBytes(compressed, new DecompressionStream('deflate')) : decoded(stream);
        data = { compressed, bytes, ops: operations(bytes) };
        if (compressed) { bucket.push(data); cache.contents.set(compressed.length, bucket); }
      }
      cache.streams.set(source, { ...data, resources: new Map() });
    }
    return cache.streams.get(source);
  }

  async function plan(stream, inheritedResources, states, ancestors, source = stream) {
    if (++visits > 256 || states.length > 256) fail();
    const resources = get(stream.dict, 'Resources') || inheritedResources;
    const xobjects = get(resources, 'XObject');
    const fontDict = get(resources, 'Font');
    const data = await entry(stream, source);
    if (!data.resources.has(resources)) data.resources.set(resources, { analyses: new Map(), variants: new Map(), graphics: new Map() });
    const memo = data.resources.get(resources), calls = new Map();
    let edits;
    for (const state of states) {
      // BBox는 분석 키에서 제외. 같은 배치의 글자 경계는 한 번만 계산.
      const stateKey = JSON.stringify({ ...state, font: state.font ? cache.fontIds.get(state.font) : 0 });
      if (!memo.analyses.has(stateKey)) {
        const forms = [];
        const candidates = scan(data.ops, (key) => metrics(get(fontDict, key)), state,
          (key, childState) => forms.push([key, childState]), (key, s) => {
            const gs = get(get(resources, 'ExtGState'), key);
            if (!(gs instanceof PDFDict)) { s.font = null; return; }
            const font = get(gs, 'Font');
            if (font !== undefined) {
              if (!(font instanceof PDFArray) || font.size() !== 2) fail();
              s.font = metrics(font.lookup(0)); s.size = number(font.lookup(1));
            }
          });
        memo.analyses.set(stateKey, { candidates, forms });
      }
      const { candidates, forms } = memo.analyses.get(stateKey);
      for (const [key, childState] of forms) {
        if (!calls.has(key)) calls.set(key, []);
        calls.get(key).push(childState);
      }
      const current = candidates.filter((e) => outside(e.rect, bbox));
      // 같은 이름을 여러 CTM에서 부르면 모두 바깥인 연산만 제거.
      if (edits === undefined) edits = current;
      else {
        const byStart = new Map(current.map((e) => [e.start, e]));
        edits = edits.filter((e) => byStart.get(e.start)?.text === e.text);
      }
    }
    const children = new Map();
    for (const [key, childStates] of calls) {
      const child = get(xobjects, key);
      if (pdfName(get(child?.dict, 'Subtype')) !== 'Form' || ancestors.has(child) || ancestors.size >= 8) continue;
      const matrix = get(child.dict, 'Matrix');
      const transform = matrix === undefined ? IDENTITY : numbers(matrix, 6);
      const childPlan = await plan(child, resources, childStates.map((s) => ({ ...s, ctm: multiply(s.ctm, transform) })), new Set([...ancestors, child]));
      if (childPlan) children.set(key, childPlan);
    }
    if (!edits.length && !children.size) return null;
    return { stream, resources, xobjects, data, memo, edits, children };
  }

  async function materialize(p, rootRef) {
    const childRefs = [];
    for (const [key, child] of p.children) childRefs.push([key, await materialize(child)]);
    // BBox가 달라도 제거 연산·자식 ref가 같으면 같은 복제본을 공유.
    const variant = JSON.stringify([p.edits.map((e) => [e.start, e.end, e.text]), childRefs.map(([key, ref]) => [key, ref.toString()])]);
    if (!rootRef && p.memo.variants.has(variant)) return p.memo.variants.get(variant);
    const edits = [...p.edits], graphicRefs = [];
    // 폼 자체의 BBox가 고정된 중첩 폼에만 적용. 원본 구간은 그대로 이동.
    if (!rootRef) for (const block of p.data.ops.graphics) {
      const box = graphicBox(block.ctm, get(p.stream.dict, 'BBox'));
      if (!box) continue;
      if (!p.memo.graphics.has(block.start)) {
        let key = `PdfClipGraphics${p.memo.graphics.size}`;
        while (p.xobjects?.has(name(key))) key += '_';
        const stream = await flate(p.data.bytes.subarray(block.start, block.end));
        for (const [k, v] of context.obj({ Type: 'XObject', Subtype: 'Form', BBox: box }).entries()) stream.dict.set(k, v);
        if (p.resources) stream.dict.set(name('Resources'), p.resources);
        p.memo.graphics.set(block.start, [key, context.register(stream)]);
      }
      const [key, ref] = p.memo.graphics.get(block.start);
      graphicRefs.push([key, ref]);
      edits.push({ start: block.start, end: block.end, text: ` /${key} Do ` });
    }
    const result = await flate(splice(p.data.bytes, edits.sort((a, b) => a.start - b.start)));
    for (const [key, value] of p.stream.dict.entries()) {
      if (!['Length', 'Filter', 'DecodeParms'].includes(key.decodeText())) result.dict.set(key, value);
    }
    if (childRefs.length || graphicRefs.length) {
      const resources = p.resources ? p.resources.clone(context) : context.obj({});
      const xobjects = p.xobjects ? p.xobjects.clone(context) : context.obj({});
      for (const [key, ref] of [...childRefs, ...graphicRefs]) xobjects.set(name(key), ref);
      resources.set(name('XObject'), xobjects);
      result.dict.set(name('Resources'), resources);
    }
    if (rootRef) { context.assign(rootRef, result); cache.done.add(result); return rootRef; }
    const ref = context.register(result);
    p.memo.variants.set(variant, ref);
    return ref;
  }

  async function flate(bytes) {
    if (typeof CompressionStream !== 'function') return context.flateStream(bytes);
    return context.stream(await transformBytes(bytes, new CompressionStream('deflate')), { Filter: 'FlateDecode' });
  }

  // pdf-lib 1.17.1의 embedPages는 같은 쪽의 page 노드를 공유.
  // 접근 불가한 구현에서는 Form 객체별 캐시로 안전하게 후퇴.
  const source = embeddedPage.embedder?.page || root;
  // 루트 Matrix는 BBox와 함께 외부 배치용. 여기서는 루트 로컬 좌표.
  const result = await plan(root, undefined, [initialState()], new Set([root]), source);
  if (result) await materialize(result, embeddedPage.ref);
  else cache.done.add(root);
}
