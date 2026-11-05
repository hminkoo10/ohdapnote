import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksToModel, modelToBlocks, createAnswerHistory, importAnswerBlocks, recognizedAnswer } from '../../src/renderer/js/answer-model.js';
import { attachAnswers } from '../../src/renderer/js/answers.js';

test('편집 모델과 블록 왕복: 원문·글 안 수식·그림·빈 문단 보존', () => {
  const blocks = [{ type: 'para', text: '함수 x²', runs: [{ text: '함' }, { text: '수 ' }, { eq: 'x^{2}' }] }, { type: 'para', text: '' }, { type: 'math', eq: ' {a} over {b} ' }, { type: 'figure', file: 'answer-images/0123456789abcdef.png', w: 300, h: 200 }];
  assert.deepEqual(modelToBlocks(blocksToModel(blocks)), blocks);
  const model = blocksToModel(blocks);
  model[0].runs[0].text = '다른 함';
  assert.match(modelToBlocks(model)[0].text, /^다른 함수/);
});

test('되돌리기: 연속 글 입력만 묶고 수식·그림은 별도, 되돌린 뒤 새 입력은 가지 자름', () => {
  const history = createAnswerHistory({ text: '' });
  history.push({ text: '하' }, 'text', 1000);
  history.push({ text: '하나' }, 'text', 1200);
  history.push({ text: '하나', eq: 'x' }, '', 1300);
  history.push({ text: '하나', eq: 'x', figure: '그림' }, '', 1400);
  assert.deepEqual(history.undo(), { text: '하나', eq: 'x' });
  assert.deepEqual(history.undo(), { text: '하나' });
  assert.deepEqual(history.undo(), { text: '' });
  assert.deepEqual(history.redo(), { text: '하나' });
  history.push({ text: '둘' }, 'text', 1500);
  assert.equal(history.canRedo, false);
});

test('답지 불러오기: LaTeX·글 안 수식 변환과 정답 찾기', () => {
  const blocks = importAnswerBlocks([{ type: 'para', text: '정답 ③ 함수 $x^2$' }, { type: 'math', latex: '\\frac{1}{2}' }]);
  assert.equal(recognizedAnswer(blocks), '③');
  assert.ok(blocks[0].runs.some((r) => r.eq));
  assert.match(blocks[1].eq, /over/);
  assert.equal(recognizedAnswer([{ text: '답 12' }]), '12');
  assert.equal(recognizedAnswer([{ text: '알 수 없음' }]), '');
});

test('내보낼 때 책마다 한 번 새로 읽고, 현재 문항 id로만 찾음', async () => {
  const entries = [{ bookId: 'book', problem: { id: 'new' } }, { bookId: 'book', item: { id: 'second' } }];
  let reads = 0;
  await attachAnswers(entries, { getAnswers: async () => { reads++; return { items: { old: { answer: '①' }, second: { answer: '②' } } }; } });
  assert.equal(reads, 1);
  assert.equal(entries[0].writtenAnswer, undefined);
  assert.equal(entries[1].writtenAnswer.answer, '②');
});

test('되돌리기: 시간 경계·그룹 경계·기록 상한·외부 값 변경 방지', () => {
  const history = createAnswerHistory({ text: '' }, { limit: 3 });
  history.push({ text: '1' }, 'text', 1000);
  history.push({ text: '2' }, 'text', 2000);
  history.boundary(); history.push({ text: '3' }, 'text', 2100);
  assert.deepEqual(history.undo(), { text: '2' });
  assert.deepEqual(history.undo(), { text: '1' });
  assert.equal(history.canUndo, false);
  const state = history.current(); state.text = '외부';
  assert.equal(history.current().text, '1');
});
