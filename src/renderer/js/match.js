// 문제 ↔ 답지(해설) 짝 맞추기
// 두 문서의 번호 순서열을 "최장 공통 부분수열(LCS)"로 정렬합니다.
//  - 책 전체 연번(0001, 0002 …)이면 번호가 그대로 맞춰지고
//  - 단원마다 1번부터 다시 시작해도 "등장 순서"가 맞춰지며
//  - 한쪽에서 빠지거나 더 있는 번호가 있어도 나머지는 올바르게 맞춰집니다.
// 짝의 개수가 같으면(동점) 모양이 같은 짝을 고릅니다:
//  말머리(예제/유제)가 같고, 0 채움(01 / 1)이 같고, 해설 영역이 큰 것(빠른 정답표 칸보다 실제 해설)

const keyOf = (item) => item.num ?? parseInt(item.number, 10);
const paddedOf = (item) => {
  const d = String(item.number ?? '');
  return d.length >= 2 && d[0] === '0' ? d.length : 0;
};
const areaOf = (item) => (item.rects || []).reduce((s, r) => s + (r.w || 0) * (r.h || 0), 0);

/** 짝 하나의 "모양 일치" 점수 (정수, 0 ~ 19) */
function pairBonus(p, a, areaRank) {
  let b = 0;
  if ((p.prefix || '') === (a.prefix || '')) b += 10;
  if (paddedOf(p) === paddedOf(a)) b += 5;
  b += Math.round(4 * areaRank); // 0~4
  return b;
}

/**
 * @param {{id:string,num:number,number?:string,prefix?:string,rects?:object[]}[]} problems  읽는 순서
 * @param {{id:string,num:number,number?:string,prefix?:string,rects?:object[]}[]} answers   읽는 순서
 * @returns {Map<string,string>} 문제 id → 답지 id
 */
export function matchItems(problems, answers) {
  const result = new Map();
  const n = problems.length;
  const m = answers.length;
  if (!n || !m) return result;

  if (n * m > 12_000_000) return matchByOccurrence(problems, answers);

  const a = problems.map(keyOf);
  const b = answers.map(keyOf);
  // 답지 항목 크기 순위(0~1)
  const areas = answers.map(areaOf);
  const sorted = [...areas].sort((x, y) => x - y);
  const rank = areas.map((v) => (m > 1 ? sorted.indexOf(v) / (m - 1) : 1));

  // L[i][j], B[i][j] = a[i..], b[j..] 에서 (짝 개수, 모양 점수) 최댓값
  const W = m + 1;
  const L = new Uint16Array((n + 1) * W);
  const B = new Uint32Array((n + 1) * W);
  const better = (l1, b1, l2, b2) => l1 > l2 || (l1 === l2 && b1 > b2);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * W;
    const below = (i + 1) * W;
    for (let j = m - 1; j >= 0; j--) {
      // i 건너뛰기
      let l = L[below + j];
      let s = B[below + j];
      // j 건너뛰기
      if (better(L[row + j + 1], B[row + j + 1], l, s)) {
        l = L[row + j + 1];
        s = B[row + j + 1];
      }
      // 짝짓기
      if (a[i] === b[j]) {
        const lm = L[below + j + 1] + 1;
        const sm = B[below + j + 1] + pairBonus(problems[i], answers[j], rank[j]);
        if (!better(l, s, lm, sm)) {
          l = lm;
          s = sm;
        }
      }
      L[row + j] = l;
      B[row + j] = s;
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const cur = i * W + j;
    if (a[i] === b[j]) {
      const lm = L[(i + 1) * W + j + 1] + 1;
      const sm = B[(i + 1) * W + j + 1] + pairBonus(problems[i], answers[j], rank[j]);
      if (lm === L[cur] && sm === B[cur]) {
        result.set(problems[i].id, answers[j].id);
        i++;
        j++;
        continue;
      }
    }
    const down = (i + 1) * W + j;
    if (L[down] === L[cur] && B[down] === B[cur]) i++;
    else j++;
  }
  return result;
}

/** 아주 큰 문서용: k번째로 나온 (말머리, 번호) ↔ 답지에서 k번째로 나온 (말머리, 번호) */
export function matchByOccurrence(problems, answers) {
  const result = new Map();
  const pool = new Map();
  const k = (it) => `${it.prefix || ''}|${keyOf(it)}`;
  for (const ans of answers) {
    if (!pool.has(k(ans))) pool.set(k(ans), []);
    pool.get(k(ans)).push(ans.id);
  }
  const used = new Map();
  for (const p of problems) {
    const list = pool.get(k(p));
    if (!list) continue;
    const u = used.get(k(p)) || 0;
    if (u < list.length) {
      result.set(p.id, list[u]);
      used.set(k(p), u + 1);
    }
  }
  return result;
}
