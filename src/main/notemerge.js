'use strict';

// 오답노트 3-way 병합: 학생 오답노트는 학원 사람 누구나 고치므로, 저장할 때 그사이 파일이 바뀌었으면
// 열 때 받은 것(base) · 내 것(mine) · 지금 파일(cur)을 합친다
//   bookIds · 고른 문항(selected[책]): 내가 더하고 뺀 것만 지금 파일에 반영 (다른 사람이 더하고 뺀 것도 남음)
//   renamesSeen: 책마다 큰 쪽 · updatedAt: 늦은 쪽
//   나머지 칸(제목·학생·내보내기 설정 …): 한쪽만 바뀌었으면 그쪽, 둘 다 바뀌었으면 내 것 (객체는 칸마다)

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

/** 목록: 지금 파일 순서 그대로 + 내가 더한 것, 내가 뺀 것은 빼고 */
function mergeList(base, mine, cur) {
  const b = new Set(list(base));
  const m = new Set(list(mine));
  const removed = new Set(list(base).filter((x) => !m.has(x)));
  return [...new Set([...list(cur), ...list(mine).filter((x) => !b.has(x))])].filter((x) => !removed.has(x));
}

function mergeValue(base, mine, cur) {
  if (same(mine, base)) return cur;
  if (same(cur, base)) return mine;
  if (isObj(base) && isObj(mine) && isObj(cur)) {
    const out = {};
    for (const k of new Set([...Object.keys(cur), ...Object.keys(mine)])) {
      const v = mergeValue(base[k], mine[k], cur[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return mine;
}

const SPECIAL = new Set(['id', 'bookIds', 'selected', 'renamesSeen', 'updatedAt', 'answersForStudent']);

/** base · mine · cur 는 저장되는 모양 (화면용 $ 값 없이) → 합친 오답노트 */
function mergeNote(base, mine, cur) {
  base = isObj(base) ? base : {};
  const out = {};
  for (const k of new Set([...Object.keys(cur), ...Object.keys(mine)])) {
    if (SPECIAL.has(k)) continue;
    const v = mergeValue(base[k], mine[k], cur[k]);
    if (v !== undefined) out[k] = v;
  }
  out.id = mine.id;
  // 예전 노트의 빈 값도 false: 기본값을 채운 것만으로 다른 사람이 켠 설정을 덮지 않게
  out.answersForStudent = mergeValue(base.answersForStudent === true, mine.answersForStudent === true, cur.answersForStudent === true);
  out.bookIds = mergeList(base.bookIds, mine.bookIds, cur.bookIds);
  const sel = (n, b) => n?.selected?.[b];
  out.selected = Object.fromEntries(out.bookIds.map((b) => [b, mergeList(sel(base, b), sel(mine, b), sel(cur, b))]));
  const seen = (n, b) => Number(n?.renamesSeen?.[b]) || 0;
  out.renamesSeen = Object.fromEntries(
    out.bookIds.filter((b) => mine.renamesSeen?.[b] !== undefined || cur.renamesSeen?.[b] !== undefined).map((b) => [b, Math.max(seen(mine, b), seen(cur, b))]),
  );
  out.updatedAt = Math.max(Number(mine.updatedAt) || 0, Number(cur.updatedAt) || 0);
  return out;
}

module.exports = { mergeNote, mergeList };
