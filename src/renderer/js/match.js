// 문제 ↔ 답지(해설) 짝 맞추기
// 두 문서의 번호 순서열을 최장 공통 부분수열(LCS)로 정렬합니다.
//  - 책 전체 연번(0001, 0002 …)이면 번호가 그대로 맞춰지고
//  - 단원마다 1번부터 다시 시작해도 "등장 순서"가 맞춰지며
//  - 한쪽에서 빠지거나 더 있는 번호가 있어도 나머지는 올바르게 맞춰집니다.

const keyOf = (item) => item.num ?? parseInt(item.number, 10);

/**
 * @param {{id:string,num:number}[]} problems  읽는 순서
 * @param {{id:string,num:number}[]} answers   읽는 순서
 * @returns {Map<string,string>} 문제 id → 답지 id
 */
export function matchItems(problems, answers) {
  const result = new Map();
  const n = problems.length;
  const m = answers.length;
  if (!n || !m) return result;

  const a = problems.map(keyOf);
  const b = answers.map(keyOf);

  if (n * m > 20_000_000) return matchByOccurrence(problems, answers);

  // dp[i][j] = a[i..], b[j..] 의 LCS 길이 (뒤에서부터 계산 → 앞에서부터 복원)
  const W = m + 1;
  const dp = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * W;
    const below = (i + 1) * W;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = a[i] === b[j] ? dp[below + j + 1] + 1 : Math.max(dp[below + j], dp[row + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.set(problems[i].id, answers[j].id);
      i++;
      j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return result;
}

/** 아주 큰 문서용: k번째로 나온 번호 N ↔ 답지에서 k번째로 나온 번호 N */
export function matchByOccurrence(problems, answers) {
  const result = new Map();
  const pool = new Map();
  for (const ans of answers) {
    const k = keyOf(ans);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(ans.id);
  }
  const used = new Map();
  for (const p of problems) {
    const k = keyOf(p);
    const list = pool.get(k);
    if (!list) continue;
    const u = used.get(k) || 0;
    if (u < list.length) {
      result.set(p.id, list[u]);
      used.set(k, u + 1);
    }
  }
  return result;
}
