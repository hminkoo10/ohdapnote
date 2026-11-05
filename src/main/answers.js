'use strict';

const { isObj, key } = require('./data-validate');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const imageFile = (v) => typeof v === 'string' && /^answer-images\/[a-f0-9]{16}\.png$/.test(v);
const text = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(v);

function sanitizeAnswer(v) {
  if (!isObj(v) || !text(v.answer, 200) || /[\r\n]/.test(v.answer) || !Array.isArray(v.blocks) || v.blocks.length > 500) return null;
  const blocks = [];
  let size = v.answer.length;
  for (const b of v.blocks) {
    if (!isObj(b)) return null;
    if (b.type === 'para') {
      if (!text(b.text, 20000)) return null;
      const out = { type: 'para', text: b.text };
      size += b.text.length;
      if (b.runs !== undefined) {
        if (!Array.isArray(b.runs) || b.runs.length > 1000) return null;
        out.runs = [];
        for (const run of b.runs) {
          if (!isObj(run)) return null;
          if (text(run.eq, 8000) && run.text === undefined) out.runs.push({ eq: run.eq });
          else if (text(run.text, 20000) && run.eq === undefined) out.runs.push({ text: run.text });
          else return null;
          size += (run.eq || run.text || '').length;
        }
      }
      blocks.push(out);
    } else if (b.type === 'math' && text(b.eq, 8000)) {
      blocks.push({ type: 'math', eq: b.eq });
      size += b.eq.length;
    } else if (b.type === 'figure' && imageFile(b.file) && [b.w, b.h].every((n) => Number.isFinite(n) && n > 0 && n <= 20000)) {
      blocks.push({ type: 'figure', file: b.file, w: b.w, h: b.h });
    } else return null;
    if (size > 250000) return null;
  }
  const out = { answer: v.answer, blocks };
  if (Number.isSafeInteger(v.updatedAt) && v.updatedAt >= 0) out.updatedAt = v.updatedAt;
  if (isObj(v.by) && key(v.by.id, 64) && text(v.by.name, 200)) out.by = { id: v.by.id, name: v.by.name };
  return out;
}

function sanitizeAnswers(v) {
  const out = { version: 1, items: {} };
  if (!isObj(v) || v.version !== 1 || !isObj(v.items)) return out;
  for (const [id, value] of Object.entries(v.items).slice(0, 20000)) {
    if (!key(id, 200)) continue;
    const entry = sanitizeAnswer(value);
    if (entry) out.items[id] = entry;
  }
  return out;
}

function imageBytes(value) {
  if (!(value instanceof Uint8Array) && !Array.isArray(value) && !(value instanceof ArrayBuffer)) throw new Error('그림 파일을 확인해 주세요.');
  if ((value.byteLength ?? value.length) > MAX_IMAGE_BYTES) throw new Error('그림은 8MB 이하로 넣어 주세요.');
  const bytes = Buffer.from(value);
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new Error('PNG 또는 JPEG 그림만 넣을 수 있어요.');
  // 압축을 풀기 전에 큰 해상도를 거른다. 손상 여부는 실제 그림 읽기에서도 확인한다.
  let width = 0;
  let height = 0;
  if (png && bytes.length >= 24) { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  if (jpeg) {
    let at = 2;
    while (at + 4 <= bytes.length && bytes[at] === 255) {
      const marker = bytes[at + 1];
      if (marker === 255) { at++; continue; }
      if (marker === 218 || marker === 217) break;
      const length = bytes.readUInt16BE(at + 2);
      if (length < 2 || at + length + 2 > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(at + 5); width = bytes.readUInt16BE(at + 7); break;
      }
      at += length + 2;
    }
  }
  if (width > 20000 || height > 20000 || width * height > 32000000) throw new Error('그림 해상도가 너무 커요. 크기를 줄여 주세요.');
  return bytes;
}

module.exports = { sanitizeAnswer, sanitizeAnswers, imageFile, imageBytes, MAX_IMAGE_BYTES };
