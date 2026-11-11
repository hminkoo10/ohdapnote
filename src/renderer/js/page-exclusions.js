// 문항 배열에는 활성 문항만 둡니다. 뺀 검출은 쪽 정보에 함께 저장합니다.
// 예전 저장본에는 exclusion이 없으므로 별도 마이그레이션이 필요 없습니다.
export const isExcludedPage = (info) => !!info?.exclusion && !info.exclusion.restored;

export function trailingNonQuestionPages(rows, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount <= 0) return new Map();
  const byPage = new Map(rows.map(r => [r.index, r]));
  const excluded = new Map();
  for (let index = pageCount - 1; index >= 0; index--) {
    const row = byPage.get(index);
    if (!row || row.restored || (!row.shape && !row.nonQuestion)) break;
    excluded.set(index, row.shape ? 'answer_table' : row.role);
  }
  // 묶음 앞에 실제 문항이 남는 보통 쪽이 없으면 문서 전체를 보호합니다.
  const first = Math.min(...excluded.keys());
  if (!rows.some(r => r.index < first && r.hasQuestions && !r.shape && !r.nonQuestion)) return new Map();
  return excluded;
}

export function applyPageExclusions(items, pageInfo, roles, previous = {}) {
  let active = [...items];
  const info = { ...pageInfo };
  for (const [key, oldInfo] of Object.entries(previous.pageInfo || {})) {
    if (oldInfo.exclusion && !info[key]) info[key] = oldInfo;
  }
  for (const [key, fresh] of Object.entries(info)) {
    const index = Number(key);
    const old = previous.pageInfo?.[key]?.exclusion;
    let exclusion = old;
    if (!exclusion && roles.has(index)) {
      exclusion = { role: roles.get(index), restored: false,
        items: active.filter(it => it.page === index) };
    }
    if (!exclusion) continue;
    // 이미 뺀 쪽의 원본과 사용자가 되돌린 문항(직접 수정 포함)은 덮어쓰지 않습니다.
    const kept = exclusion.restored
      ? (previous.items || []).filter(it => it.page === index)
      : [];
    active = active.filter(it => it.page !== index);
    if (exclusion.restored) active.push(...kept);
    info[key] = { ...fresh, exclusion, flags: [] };
  }
  return { items: active, pageInfo: info };
}

export function restorePageItems(doc, index) {
  const info = doc.pageInfo?.[index];
  if (!isExcludedPage(info)) return false;
  doc.items = [...(doc.items || []).filter(it => it.page !== index), ...info.exclusion.items];
  info.exclusion = { ...info.exclusion, restored: true };
  info.flags = [];
  doc.edited = true;
  return true;
}
