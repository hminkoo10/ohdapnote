// 한 문항의 복원된 한컴 수식만 묶는다. 보류 그림·불명 기호·여러 줄은 개별 확인.
export function groupMathReview(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  let first, firstMark, count = 0;
  const result = structuredClone(blocks);
  for (const block of result) {
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
  if (first) (first.low ||= []).push({ ...firstMark, reason: 'math', detail: `수식 ${count}개 — 원본과 한 번 비교하세요` });
  return result;
}
