'use strict';

const { sanitizeData } = require('./data-validate');

// 옛 블록과 모르는 필드는 보존하고, 확인 표시만 모양을 검사한다.
function sanitizeTranscripts(value) {
  const data = sanitizeData(value);
  for (const entry of Object.values(data?.items || {})) {
    if (!Array.isArray(entry?.blocks)) continue;
    for (const block of entry.blocks) {
      if (!block || typeof block !== 'object' || !Object.hasOwn(block, 'low')) continue;
      const low = Array.isArray(block.low) && !block.runs ? block.low.slice(0, 2000).flatMap((mark) => {
        if (!mark || typeof mark !== 'object' || Array.isArray(mark) || !['para', 'math', 'choices', 'figure'].includes(block.type)) return [];
        if (block.type === 'choices' && (!Number.isInteger(mark.item) || mark.item < 0 || mark.item >= (block.items?.length || 0))) return [];
        const text = block.type === 'choices' ? block.items[mark.item] : block.text;
        const range = mark.start !== undefined || mark.end !== undefined;
        if (range && (!Number.isInteger(mark.start) || !Number.isInteger(mark.end) || mark.start < 0 || mark.end <= mark.start || mark.end > (block.type === 'math' ? (block.latex || block.eq || '').length : typeof text === 'string' ? text.length : 0))) return [];
        if (block.type === 'para' && !range) return [];
        const out = { reason: ['ocr', 'disagree', 'math'].includes(mark.reason) ? mark.reason : 'ocr' };
        if (mark.group === 'transcription') out.group = mark.group;
        if (typeof mark.detail === 'string') out.detail = mark.detail.slice(0, 200);
        if (range) Object.assign(out, { start: mark.start, end: mark.end });
        if (block.type === 'choices') out.item = mark.item;
        if (Number.isFinite(mark.conf) && mark.conf >= 0 && mark.conf <= 1) out.conf = mark.conf;
        const b = mark.box;
        if (b && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(b[key]) && b[key] >= 0 && b[key] <= 1) && b.w > 0 && b.h > 0 && b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9) out.box = { x: b.x, y: b.y, w: b.w, h: b.h };
        return [out];
      }) : [];
      if (low.length) block.low = low;
      else delete block.low;
    }
  }
  return data;
}

module.exports = { sanitizeTranscripts };
