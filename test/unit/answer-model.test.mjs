import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksToModel, modelToBlocks, createAnswerHistory, importAnswerBlocks, recognizedAnswer } from '../../src/renderer/js/answer-model.js';

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
