import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {densePages} from '../fixtures/dense-pages.mjs';
import {trailingNonQuestionPages} from '../../src/renderer/js/page-exclusions.js';
const source=await readFile(new URL('../../src/renderer/js/pagerole.js',import.meta.url),'utf8');
const {classifyAnswerTableShape:classify}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('중간 밀집 문항은 책 끝 연속 묶음이 아니므로 보존',()=>{
  for(const row of densePages) assert.equal(trailingNonQuestionPages([{index:row.pageIndex,shape:classify(row.items).matchesShape}],10).size,0,row.id);
});
test('책 끝 쪽 누락·쪽 수 불명은 보존',()=>{
  const {items,pageIndex}=densePages[2];
  for(const count of [undefined,NaN,Infinity,-1,1.5,pageIndex+2]) assert.equal(trailingNonQuestionPages([{index:pageIndex,shape:classify(items).matchesShape}],count).size,0);
});
test('뒤쪽의 격자라도 지시문·서술어 있으면 보존',()=>{
  for(const text of ['구하시오','계산 하시오','쓰시오','고르시오','빈칸을 채우시오','옳으면 O를 표시하라','값은 무엇인가?','이 명제는 참이다.']) {
    const items=densePages[0].items.map(i=>({...i,text}));
    assert.equal(classify(items,{pageIndex:1,lastQuestionPage:0}).isAnswerTable,false,text);
  }
});
test('뒤쪽 정답 격자 허용, 중간 정답표는 의도적으로 보존',()=>{
  const {items,pageIndex}=densePages[2];
  const rows=[{index:0,hasQuestions:true},{index:pageIndex,shape:classify(items).matchesShape}];
  assert.equal(trailingNonQuestionPages(rows,pageIndex+1).size,1);
  assert.equal(trailingNonQuestionPages(rows,pageIndex+2).size,0);
});
