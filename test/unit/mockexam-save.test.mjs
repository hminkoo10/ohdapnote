import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveExamTranscripts } from '../../src/renderer/js/mockexam-save.js';
test('일시적 글 저장 실패 뒤 재시도하고 성공하면 바로 끝냄', async () => {
  let calls = 0; const waits = [];
  assert.equal(await saveExamTranscripts(async () => ++calls === 3, async (ms) => waits.push(ms)), true);
  assert.equal(calls, 3); assert.deepEqual(waits, [250, 500]);
});
test('계속 저장하지 못하면 횟수를 제한하고 실패 유지', async () => {
  let calls = 0;
  assert.equal(await saveExamTranscripts(async () => { calls++; return false; }, async () => {}), false);
  assert.equal(calls, 6);
});
test('처음 저장 성공에는 대기·추가 호출 없음', async () => {
  let calls = 0;
  assert.equal(await saveExamTranscripts(async () => { calls++; return true; }, async () => assert.fail('대기하지 않음')), true);
  assert.equal(calls, 1);
});
