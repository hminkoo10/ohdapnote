// OCR 토큰(쪽 비율 좌표)과 앱 잉크 격자만 사용하는 독립 쪽 분류기.
// 번호 순서·정답 내용·책 식별자를 사용하지 않습니다. 불확실하면 문항으로 유지합니다.
export function classifyPageRole({ tokens = [], grid } = {}) {
  const ts = tokens.filter(t => typeof t.str === 'string' &&
    [t.x0, t.x1, t.y0, t.y1].every(Number.isFinite) && t.x1 > t.x0 && t.y1 > t.y0);
  const result = (role, reason) => ({ role, effectiveRole: role === 'unknown' ? 'problem' : role,
    extractQuestions: role === 'problem' || role === 'unknown', retain: true, reason });
  const text = ts.map(t => t.str).join(' ');
  // 본문 질문이 있으면 머리글보다 우선합니다. 개념 설명도 기본적으로 유지합니다.
  if (/(구하|고르|옳은|물음|답하|풀어|which|calculate|find\b)/i.test(text)) return result('problem', '문항 본문');
  if (hasIsolatedDisplayInk(grid)) return result('unit_cover', '큰 제목 잉크와 넓은 빈 영역');
  if (!ts.length) return result('unknown', '읽을 수 있는 토큰 없음');
  const head = ts.filter(t => t.y0 < 0.25).sort((a,b) => a.y0-b.y0 || a.x0-b.x0)
    .map(t => t.str).join('').replace(/\s/g, '');
  const small = ts.filter(t => /^\d{1,4}$|^[①-⑳]$/.test(t.str.trim()) && t.y1-t.y0 < 0.035);
  // 값이나 차이는 읽지 않고 작은 숫자 상자의 공간 분포만 셉니다.
  const cols = new Set(small.map(t => Math.round(t.x0 / 0.06))).size;
  const rows = new Set(small.map(t => Math.round(t.y0 / 0.035))).size;
  const gridLike = small.length >= 20 && small.length / ts.length >= 0.65 && cols >= 3 && rows >= 4;
  if (/빠른정답|정답표|정답과해설|ANSWERS?/i.test(head) && gridLike)
    return result('answer_table', '정답 머리글과 작은 숫자 격자');
  if (/차례|목차|CONTENTS/i.test(head) && small.length >= 4)
    return result('toc', '목차 머리글과 쪽수 모양 토큰');
  // 큰 제목 아래에 글과 잉크가 거의 없는 경우만 표지로 봅니다.
  const title = ts.filter(t => t.y1-t.y0 >= 0.045 && t.y0 < 0.65);
  if (title.length && ts.length <= 12 && grid?.w > 0 && grid?.h > 0 && grid.data?.length === grid.w*grid.h) {
    const end = Math.max(...title.map(t => t.y1)) + 0.04;
    const bodyText = ts.some(t => t.y0 > end && t.y0 < 0.9 && !/^\d+$/.test(t.str));
    let ink = 0, cells = 0;
    for (let y = Math.ceil(end*grid.h); y < Math.floor(0.9*grid.h); y++)
      for (let x = 0; x < grid.w; x++) { ink += grid.data[y*grid.w+x] ? 1 : 0; cells++; }
    if (!bodyText && cells > 0 && ink/cells < 0.01) return result('unit_cover', '큰 제목 아래 본문 없음');
  }
  return result('unknown', '단서 부족: 문항으로 유지');
}

// 글자 이름 대신 연결된 잉크 덩어리의 크기와 빈 영역만 봅니다.
// 작은 본문이 많거나 아래쪽까지 잉크가 이어지면 판단하지 않습니다.
function hasIsolatedDisplayInk(grid) {
  if (!grid || !Number.isInteger(grid.w) || !Number.isInteger(grid.h) ||
      grid.w < 20 || grid.h < 20 || grid.w * grid.h > 1000000 ||
      grid.data?.length !== grid.w * grid.h) return false;
  const {w, h, data} = grid, seen = new Uint8Array(data.length);
  let total = 0, largeInk = 0, largeCount = 0, count = 0, bottom = 0;
  for (let k = 0; k < data.length; k++) {
    if (!data[k]) continue;
    total++;
    if (k >= Math.floor(h * .8) * w) bottom++;
    if (seen[k]) continue;
    const stack = [k];seen[k] = 1;
    let area = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = Math.floor(p / w);
      area++;x0 = Math.min(x0, x);x1 = Math.max(x1, x);y0 = Math.min(y0, y);y1 = Math.max(y1, y);
      for (const q of [x > 0 ? p-1 : -1, x+1 < w ? p+1 : -1, y > 0 ? p-w : -1, y+1 < h ? p+w : -1]) {
        if (q >= 0 && data[q] && !seen[q]) { seen[q] = 1;stack.push(q); }
      }
    }
    // 단일 잡점은 배치 판단에서 제외합니다.
    if (area < 3) continue;
    count++;
    if ((x1-x0+1)/w >= .04 && (y1-y0+1)/h >= .045 && y0/h >= .08 && y1/h < .65) {
      largeCount++;largeInk += area;
    }
  }
  return total > 0 && total/(w*h) < .08 && count <= 40 &&
    largeCount >= 5 && largeInk/total >= .7 && bottom/total < .005;
}

// 정답표 등도 원본 기록은 버리지 않고 별도 경로에 보관합니다.
export function routePageItems(items, classification) {
  return { questions: classification.extractQuestions ? [...items] : [],
    retainedNonQuestions: classification.extractQuestions ? [] : [...items], classification };
}
