import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {densePages} from '../fixtures/dense-pages.mjs';
const source=await readFile(new URL('../../src/renderer/js/pagerole.js',import.meta.url),'utf8');
const {classifyAnswerTableShape:classify}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('밀집 가상 문항 3권 12쪽은 모두 보존',()=>{
  for(const row of densePages) assert.equal(classify(row.items,row).isAnswerTable,false,row.id);
});
test('위치 불명·마지막 문항과 같은 쪽·잘못된 경계는 보존',()=>{
  const {items,pageIndex}=densePages[2];
  for(const context of [{},{pageIndex,lastQuestionPage:pageIndex},{pageIndex,lastQuestionPage:NaN},
    {pageIndex:-1,lastQuestionPage:-2},{pageIndex:pageIndex+1,lastQuestionPage:0},
    {pageIndex,lastQuestionPage:1.5}]) assert.equal(classify(items,context).isAnswerTable,false);
});
test('뒤쪽의 격자라도 지시문·서술어 있으면 보존',()=>{
  for(const text of ['구하시오','계산 하시오','쓰시오','고르시오','빈칸을 채우시오','옳으면 O를 표시하라','값은 무엇인가?','이 명제는 참이다.']) {
    const items=densePages[0].items.map(i=>({...i,text}));
    assert.equal(classify(items,{pageIndex:1,lastQuestionPage:0}).isAnswerTable,false,text);
  }
});
test('뒤쪽 정답 격자 허용, 중간 정답표는 의도적으로 보존',()=>{
  const {items,pageIndex}=densePages[2];
  assert.equal(classify(items,{pageIndex,lastQuestionPage:0}).isAnswerTable,true);
  assert.equal(classify(items,{pageIndex,lastQuestionPage:8}).isAnswerTable,false);
});
