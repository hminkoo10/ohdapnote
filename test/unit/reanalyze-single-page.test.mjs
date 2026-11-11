import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// 브라우저 전용 PDF·OCR 경계만 대체하고 실제 analyze.js 경로를 실행합니다.
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === new URL('../../src/renderer/js/ocr.js', import.meta.url).href) {
      return { format: 'module', shortCircuit: true, source: `
        export const OCR_WORKERS = 1;
        export function recognizeWords() { throw Error('unexpected OCR'); }
        export function recognizeLine() { throw Error('unexpected OCR'); }
      ` };
    }
    if (url === new URL('../../src/renderer/js/docsource.js', import.meta.url).href) {
      return { format: 'module', shortCircuit: true,
        source: "export function createCanvas() { throw Error('unexpected canvas'); }" };
    }
    return nextLoad(url, context);
  },
});
let reanalyzeSinglePage;
try {
  ({ reanalyzeSinglePage } = await import('../../src/renderer/js/analyze.js'));
} finally {
  hooks.deregister();
}

test('reanalyzeSinglePage: 되돌린 쪽은 분석하고 뺀 쪽은 분석하지 않음', async () => {
  const sentinel = new Error('synthetic source reached');
  const reads = [];
  const src = { renderPage: async (index) => { reads.push(index); throw sentinel; } };
  const item = { page: 1, number: '5', num: 5, rects: [] };
  const doc = { items: [item], pageInfo: { 1: {
    exclusion: { role: 'answer_table', restored: false, items: [item] },
  } } };
  const excluded = await reanalyzeSinglePage(src, doc, 1);
  assert.deepEqual(reads, []);
  assert.deepEqual(excluded.items, [item]);

  doc.pageInfo[1].exclusion.restored = true;
  await assert.rejects(reanalyzeSinglePage(src, doc, 1), (error) => error === sentinel);
  assert.deepEqual(reads, [1]);
});
