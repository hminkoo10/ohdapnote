import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveExamTranscripts, examScanEntry } from '../../src/renderer/js/mockexam-save.js';
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

test('빈 OCR·실패는 문항 전체 원본과 확인 하나, 성공 글자는 보존', () => {
  for (const r of [undefined,{blocks:[],reasons:['가짜 실패']}]) {
    const e=examScanEntry(r);
    assert.equal(e.blocks[0].type,'figure');
    assert.deepEqual(e.blocks[0].box,{x:0,y:0,w:1,h:1});
    assert.equal(e.blocks[0].low.length,1);
    assert.equal(e.reliable,false);
  }
  const blocks=[{type:'para',text:'가짜 스캔 문항'}];
  assert.equal(examScanEntry({blocks}).blocks,blocks);
});
