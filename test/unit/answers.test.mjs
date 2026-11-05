import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeAnswer, sanitizeAnswers, imageBytes, MAX_IMAGE_BYTES } = require('../../src/main/answers.js');
const entry = { answer: '③', blocks: [{ type: 'para', text: '답은 1/2', runs: [{ text: '답은 ' }, { eq: '{1} over {2}' }] }, { type: 'math', eq: 'x^2' }, { type: 'figure', file: 'answer-images/0123456789abcdef.png', w: 20, h: 30 }] };

test('정답·해설 검사: 블록 보존, 모르는 필드 제거', () => {
  assert.deepEqual(sanitizeAnswer({ ...entry, unknown: '<script>', by: { id: 'teacher', name: '선생님', role: 'admin' } }), { ...entry, by: { id: 'teacher', name: '선생님' } });
  assert.deepEqual(sanitizeAnswers({ version: 1, items: { orphan: entry }, unknown: 1 }), { version: 1, items: { orphan: entry } });
  assert.deepEqual(sanitizeAnswers(JSON.parse('{"version":1,"items":{"__proto__":{}}}')).items, {});
});

test('정답·해설 검사: 경로 탈출·큰 값·모양 오류 거부', () => {
  for (const file of ['../a.png', 'answer-images/../a.png', 'answer-images/0123456789abcdef.jpg', 'answer-images\\0123456789abcdef.png', '/answer-images/0123456789abcdef.png']) {
    assert.equal(sanitizeAnswer({ ...entry, blocks: [{ ...entry.blocks[2], file }] }), null);
  }
  for (const data of [{ ...entry, answer: 'x'.repeat(201) }, { ...entry, answer: '1\n2' }, { ...entry, blocks: Array(501).fill(entry.blocks[0]) }, { ...entry, blocks: [{ type: 'math', eq: 'x'.repeat(8001) }] }, { ...entry, blocks: [{ type: 'para', text: '', runs: [{ text: 'x', eq: 'x' }] }] }]) assert.equal(sanitizeAnswer(data), null);
});

test('그림 바이트 검사: 형식·8MB 제한', () => {
  assert.throws(() => imageBytes(new Uint8Array(3)), /PNG/);
  assert.throws(() => imageBytes(new Uint8Array(MAX_IMAGE_BYTES + 1)), /8MB/);
  assert.throws(() => imageBytes('data:image/png'), /그림/);
  assert.equal(imageBytes(Uint8Array.from([255, 216, 255, 1])).length, 4);
});
