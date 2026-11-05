// 표시 기준만 모음. 인식·보정 방법은 바꾸지 않는다.
export const LOW_CONF = Object.freeze({
  text: 70, // 0~100 글자·단어 점수: 낮은 점수만 확인 대상으로 삼음
  confMean: 0.93, // 기존 수식 판정과 같음: 수식 126개로 정한 기하평균 기준
  confMin: 0.3, // 기존 최솟값 기준: 0.4에서는 멀쩡한 수식의 표시가 늘어남
});

export function textLow(unit) {
  const reason = unit.check ? 'disagree' : Number.isFinite(unit.conf) && unit.conf < LOW_CONF.text ? 'ocr' : null;
  if (!reason) return [];
  return [{ start: 0, end: unit.str.length, reason,
    ...(Number.isFinite(unit.conf) ? { conf: Math.max(0, Math.min(1, unit.conf / 100)) } : {}),
    box: { x0: unit.x0, y0: unit.y0, x1: unit.x1, y1: unit.y1 } }];
}

export function mathLow(conf) {
  if (!conf || !(conf.mean < LOW_CONF.confMean || conf.min < LOW_CONF.confMin)) return null;
  return { reason: 'math', conf: Math.max(0, Math.min(1, Math.min(conf.mean, conf.min))) };
}

export function relativeBox(box, width, height) {
  if (!box || ![box.x0, box.y0, box.x1, box.y1, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  const x = Math.max(0, Math.min(width, box.x0));
  const y = Math.max(0, Math.min(height, box.y0));
  const right = Math.max(x, Math.min(width, box.x1));
  const bottom = Math.max(y, Math.min(height, box.y1));
  return right > x && bottom > y ? { x: x / width, y: y / height, w: (right - x) / width, h: (bottom - y) / height } : undefined;
}

export function listLow(blocks = []) {
  return blocks.flatMap((block, blockIndex) => (block.low || []).map((mark, index) => ({ block: blockIndex, index, mark })));
}

export function countLow(blocks) {
  return (Array.isArray(blocks) ? blocks : [blocks]).reduce((n, block) => n + (block?.low?.length || 0), 0);
}

/** 마지막 다음은 처음으로, 처음 이전은 마지막으로 돌아감. */
export function nextLow(blocks, current = null, direction = 1) {
  const list = listLow(blocks);
  if (!list.length) return null;
  const at = current ? list.findIndex((p) => p.block === current.block && p.index === current.index) : -1;
  return list[at < 0 ? direction < 0 ? list.length - 1 : 0 : (at + direction + list.length) % list.length];
}

export const clearLow = (low = [], index) => low.filter((_, i) => i !== index);

/** UTF-16 위치. 바뀐 구간과 겹친 표시만 지우고, 뒤쪽은 길이 차이만큼 옮김. */
export function moveLow(low = [], before, after, item) {
  if (before === after) return low.map((mark) => ({ ...mark }));
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length;
  let newEnd = after.length;
  while (end > start && newEnd > start && before[end - 1] === after[newEnd - 1]) { end--; newEnd--; }
  const delta = after.length - before.length;
  return low.flatMap((mark) => {
    if (item !== undefined && mark.item !== item) return [{ ...mark }];
    if (mark.start === undefined) return [];
    if (mark.end <= start) return [{ ...mark }];
    if (mark.start >= end) return [{ ...mark, start: mark.start + delta, end: mark.end + delta }];
    return [];
  });
}

export function setLow(block, low) {
  if (low.length) block.low = low;
  else delete block.low;
}
