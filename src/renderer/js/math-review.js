// 문항의 원본 비교를 묶어 센다. 위치는 유지하고 불명 기호·여러 줄은 별도 확인.
export function groupMathReview(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  let first, firstMark, count = 0;
  const result = structuredClone(blocks);
  for (const block of result) {
    for (const mark of block.low || []) {
      // 원본과 비교할 위치를 모두 보존. 모호한 구조·불일치는 별도 확인.
      if ((block.type === 'figure' || mark.reason === 'ocr' || /^수식 \d+개 —/.test(mark.detail || '')) && (!mark.detail || /^수식 \d+개 —/.test(mark.detail))) mark.group = 'transcription';
      if (block.type === 'para' && mark.start === undefined && block.text?.length) Object.assign(mark, { start: 0, end: block.text.length });
    }
    if (!['math','para','choices'].includes(block.type) || !block.low?.some((m) => m.reason === 'math')) continue;
    block.low = block.low.filter((mark) => {
      if (mark.reason !== 'math' || mark.detail) return true;
      const text = block.type === 'math' ? block.eq ?? block.latex ?? '' : block.type === 'choices' ? block.items[mark.item] : block.text;
      const equations = block.type === 'math' ? [text] : [...(text || '').matchAll(/\$([^$]+)\$/g)].map(m=>m[1]);
      if (!equations.length || equations.some(eq=>/matrix|cases|pile|align|array|[\n&\uE000-\uF8FF]|\\\\/.test(eq))) return true;
      const complex = equations.filter(eq => !/^[A-Za-z0-9\s()+\-*/=.,<>]+$/.test(eq) || /\b(?:over|sqrt|root|sum|int|bar|vec|lim)\b/.test(eq));
      if (complex.length) { first ||= block; firstMark ||= mark; count += complex.length; }
      return false;
    });
    if (!block.low.length) delete block.low;
  }
  if (first) (first.low ||= []).push({ ...firstMark, reason: 'math', group: 'transcription', detail: `수식 ${count}개 — 원본과 한 번 비교하세요` });
  return result;
}
