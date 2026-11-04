// 옮긴 글의 열쇠·우선순위·개수 정리 (화면·저장 API 없이 시험)
import { transcriptFiles } from './store.js';

/** 같은 문항·영역·원본이면 오답노트와 문제은행이 같은 열쇠를 씀 */
export function transcriptKey(block) {
  const raw = JSON.stringify({ files: transcriptFiles(block.src?.files), rects: block.item.rects, stem: block.stem || null });
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) hash = Math.imul(hash ^ raw.charCodeAt(i), 0x01000193);
  return `${block.role}|${block.item.id}|${(hash >>> 0).toString(36)}`;
}

export function pickTranscript(items, key) {
  for (const [suffix, path] of [['|edit', 'edit'], ['', 'ai'], ['|local', 'ocr'], ['|pdf', 'pdf']]) {
    const entry = items?.[key + suffix];
    if (entry?.blocks?.length) return { entry, path };
  }
  return null;
}

/** 오래된 자동 결과부터 정리. 사람이 고친 글은 마지막까지 남김 */
export function trimTranscripts(items, max = 3000) {
  const keys = Object.keys(items);
  keys.sort((a, b) => Number(a.endsWith('|edit')) - Number(b.endsWith('|edit')) || (items[a].at || 0) - (items[b].at || 0));
  const drop = new Set(keys.slice(0, Math.max(0, keys.length - max)));
  return Object.fromEntries(Object.entries(items).filter(([key]) => !drop.has(key)));
}
