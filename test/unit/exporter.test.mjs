import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBlocks, itemName } from '../../src/renderer/js/exporter.js';

const e = (n, withAns = true) => ({ problem: { number: String(n), prefix: '', page: 0, rects: [] }, answer: withAns ? { number: String(n), page: 3, rects: [] } : null });
const label = (role, it) => `p.${it.page + 1}`;

test('사람 해설 우선: 답지 유무와 무관, 정답만 있으면 한 줄, 빈 기록은 원래 답지', () => {
  const written = { answer: '③', blocks: [{ type: 'math', eq: '{a} over {b}' }] };
  for (const withAns of [true, false]) {
    const entry = { ...e(1, withAns), bookId: 'book-1', writtenAnswer: written };
    const [block] = makeBlocks('answers', [entry], {}, label);
    assert.deepEqual(block.answerBlocks, [{ type: 'para', text: '정답 ③' }, ...written.blocks]);
    assert.equal(block.bookId, entry.bookId);
    assert.equal(block.item, entry.problem);
    assert.equal(block.src, undefined);
    entry.writtenAnswer = { answer: '③', blocks: [] };
    assert.deepEqual(makeBlocks('answers', [entry], {}, label)[0].answerBlocks, [{ type: 'para', text: '정답 ③' }]);
    entry.writtenAnswer = { answer: '', blocks: [{ type: 'para', text: '' }] };
    assert.equal(makeBlocks('answers', [entry], {}, label)[0].kind, withAns ? 'answer' : 'note');
  }
});

test('사람 해설의 정답 줄: 해설 앞에 한 번, 불러온 해설이 같은 정답으로 시작하면 다시 쓰지 않음', () => {
  const entry = (written) => ({ ...e(1), bookId: 'book-1', writtenAnswer: written });
  const first = (written) => makeBlocks('answers', [entry(written)], {}, label)[0].answerBlocks.map((b) => b.text);
  assert.deepEqual(first({ answer: '⑤', blocks: [{ type: 'para', text: '정답 ⑤ 옮긴 풀이' }] }), ['정답 ⑤ 옮긴 풀이']);
  assert.deepEqual(first({ answer: '③', blocks: [{ type: 'para', text: '정답 ⑤ 옮긴 풀이' }] }), ['정답 ③', '정답 ⑤ 옮긴 풀이']);
  assert.deepEqual(first({ answer: '', blocks: [{ type: 'para', text: '풀이만' }] }), ['풀이만']);
});

test('makeBlocks: 문제+해설 — 문제마다 바로 뒤에', () => {
  const kinds = makeBlocks('both-inline', [e(1), e(2, false)], {}, label).map((b) => b.kind);
  assert.deepEqual(kinds, ['problem', 'answer', 'problem', 'note']);
});

test('makeBlocks: 문제+해설 — 해설은 맨 뒤에', () => {
  const kinds = makeBlocks('both-end', [e(1), e(2)], {}, label).map((b) => b.kind);
  assert.deepEqual(kinds, ['problem', 'problem', 'section', 'answer', 'answer']);
});

test('makeBlocks: 공통 지문은 그 지문을 쓰는 문항마다 (이어져도, 해설과 번갈아도)', () => {
  const stem = [{ page: 0, x: 0.1, y: 0.02, w: 0.4, h: 0.04 }];
  const other = [{ page: 0, x: 0.1, y: 0.5, w: 0.4, h: 0.04 }];
  const s = (n, st) => ({ problem: { number: String(n), prefix: '', page: 0, rects: [], ...(st ? { stem: st } : {}) }, answer: null });
  const list = [s(30, stem), s(32, stem), s(33, stem), s(40), s(41, other), s(42, other)];
  const probs = (mode) => makeBlocks(mode, list, {}, label).filter((b) => b.kind === 'problem');
  for (const mode of ['problems', 'both-inline', 'both-end']) {
    assert.deepEqual(
      probs(mode).map((b) => b.stem),
      [stem, stem, stem, null, other, other],
      mode,
    );
  }
  // 해설에는 지문을 붙이지 않음
  assert.ok(makeBlocks('answers', list, {}, label).every((b) => !b.stem));
});

test('itemName: 말머리 표시', () => {
  assert.equal(itemName({ number: '12' }), '12번');
  assert.equal(itemName({ number: '3', prefix: '유제' }), '유제 3');
});
