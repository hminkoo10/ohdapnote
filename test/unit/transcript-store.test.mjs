import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTranscript, trimTranscripts, transcriptKey } from '../../src/renderer/js/transcript-store.js';

const entry = (at) => ({ blocks: [{ type: 'para', text: String(at) }], at });

test('옮긴 글 우선순위: 고침 > AI > OCR > PDF, 빈 결과 건너뜀', () => {
  const items = { 'k|edit': entry(1), k: entry(2), 'k|local': entry(3), 'k|pdf': entry(4) };
  for (const [key, path] of [['k|edit', 'edit'], ['k', 'ai'], ['k|local', 'ocr'], ['k|pdf', 'pdf']]) {
    assert.deepEqual(pickTranscript(items, 'k'), { entry: items[key], path });
    items[key] = { blocks: [] };
  }
  assert.equal(pickTranscript(items, 'k'), null);
  assert.equal(pickTranscript(null, '없음'), null);
});

test('개수 정리: 오래된 자동 결과부터, 고친 글은 맨 마지막', () => {
  const items = { 'a|edit': entry(1), a: entry(2), 'a|local': entry(3), 'b|edit': entry(4), 'a|pdf': entry(5) };
  assert.deepEqual(Object.keys(trimTranscripts(items, 3)), ['a|edit', 'b|edit', 'a|pdf']);
  assert.deepEqual(Object.keys(trimTranscripts(items, 1)), ['b|edit']);
  assert.equal(Object.keys(items).length, 5, '원본 저장소를 바꾸지 않음');
  assert.deepEqual(trimTranscripts(items, 10), items);
});

test('문제은행·오답노트 열쇠 호환: 같은 원본·영역, 추가 파일 제외, 지문은 별도', () => {
  const block = { role: 'problem', item: { id: '문항1', rects: [{ page: 0, x: 0.1, y: 0.2, w: 0.8, h: 0.2 }] }, src: { files: [{ name: '원본.pdf' }] } };
  assert.equal(transcriptKey(block), transcriptKey({ ...block, stem: null }));
  assert.equal(transcriptKey(block), transcriptKey({ ...block, src: { files: [...block.src.files, { name: '추가.pdf', added: true }] } }));
  assert.notEqual(transcriptKey(block), transcriptKey({ ...block, stem: block.item.rects }));
  assert.notEqual(transcriptKey(block), transcriptKey({ ...block, role: 'answer' }));
  assert.notEqual(transcriptKey(block), transcriptKey({ ...block, src: { files: [{ name: '새원본.pdf' }] } }));
});
