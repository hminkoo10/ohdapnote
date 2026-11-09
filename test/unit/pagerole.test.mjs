import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../../src/renderer/js/pagerole.js', import.meta.url), 'utf8');
const { classifyPageRole: classify, routePageItems } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const t = (str, x0=.1, y0=.1, h=.02) => ({ str, x0, x1:x0+.05, y0, y1:y0+h });
const digits = Array.from({length:40}, (_,i)=>t(String((i*7)%13), .1+(i%5)*.15, .3+Math.floor(i/5)*.06));
test('불명확한 쪽은 문항으로 유지',()=>{
  for(const input of [{},{tokens:[t('개념 설명')]},{tokens:[{str:'목차'}]}]) {
    const r=classify(input);assert.equal(r.role,'unknown');assert.equal(r.extractQuestions,true);assert.equal(r.effectiveRole,'problem');
  }
});
test('정답 머리글과 격자는 별도 보관, 순서·값 변경 무관',()=>{
  for(const tokens of [[t('빠른 정답'),...digits],[t('ANSWERS'),...digits].reverse()]) {
    const r=classify({tokens});assert.equal(r.role,'answer_table');
    const items=[{number:'임의'}];const routed=routePageItems(items,r);
    assert.deepEqual(routed.questions,[]);assert.deepEqual(routed.retainedNonQuestions,items);assert.equal(items.length,1);
  }
});
test('숫자 격자만으로 문항을 버리지 않음',()=>assert.equal(classify({tokens:digits}).extractQuestions,true));
test('목차 머리글과 쪽수 단서',()=>assert.equal(classify({tokens:[t('CONTENTS'),...digits.slice(0,4)]}).role,'toc'));
test('머리글을 인용한 문항·실제 해설 본문 보존',()=>{
  for(const tokens of [[t('목차'),...digits,t('옳은 것을 고르시오')],[t('정답과 해설'),t('이 식을 전개하면 결과가 나온다')]])
    assert.equal(classify({tokens}).extractQuestions,true);
});
test('큰 제목 아래 빈 잉크만 표지로 분류',()=>{
  const grid={w:20,h:30,data:new Uint8Array(600)};
  assert.equal(classify({tokens:[t('가상 단원',.1,.2,.08)],grid}).role,'unit_cover');
  grid.data.fill(1);assert.equal(classify({tokens:[t('가상 단원',.1,.2,.08)],grid}).extractQuestions,true);
  assert.equal(classify({tokens:[t('가상 단원',.1,.2,.08),t('본문 설명',.1,.6)],grid}).extractQuestions,true);
});
test('문항 배치는 보존하고 복사 반환',()=>{
  const items=[{number:'8'},{number:'2'},{number:'8'}];const r=routePageItems(items,classify({}));
  assert.deepEqual(r.questions,items);assert.notEqual(r.questions,items);assert.equal(r.retainedNonQuestions.length,0);
});
