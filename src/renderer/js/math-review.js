// 한 문항의 복원된 한컴 수식만 묶는다. 보류 그림·불명 기호·여러 줄은 개별 확인.
export function groupMathReview(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  let first, count = 0;
  const result = structuredClone(blocks);
  for (const block of result) {
    if (block.type !== 'math' || !block.low?.some((m) => m.reason === 'math')) continue;
    const eq = block.eq ?? block.latex ?? '';
    if (/matrix|cases|pile|align|array|[\n&]|\\\\/.test(eq) || block.low.some((m) => m.detail)) continue;
    const simple = /^[A-Za-z0-9\s()+\-*/=.,<>]+$/.test(eq);
    block.low = block.low.filter((m) => m.reason !== 'math');
    if (!block.low.length) delete block.low;
    if (!simple) { first ||= block; count++; }
  }
  if (first) (first.low ||= []).push({ reason: 'math', detail: `수식 ${count}개 — 원본과 한 번 비교하세요` });
  return result;
}
