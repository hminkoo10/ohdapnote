import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../../src/renderer/js/pagerole.js', import.meta.url), 'utf8');
const { classifyAnswerTableShape: guarded } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const classify = items => guarded(items);
// 모든 자료는 가상 격자입니다. 실제 교재 글·좌표를 사용하지 않습니다.
const grid = (n=60) => Array.from({length:n},(_,i)=>({page:1,number:String(i%9),
  rects:[{page:1,x:.1+(i%5)*.16,y:.1+Math.floor(i/5)*.05,w:.06,h:.02}]}));
test('머리글·본문 글 없이 작은 격자 검출',()=>{
  const items=grid(), copy=JSON.stringify(items), r=classify(items);
  assert.equal(r.isAnswerTable,true);assert.equal(r.features.gridRatio,1);
  assert.equal(r.features.shortTextRatio,null);assert.equal(JSON.stringify(items),copy);
  assert.deepEqual(classify(items.reverse().map(i=>({...i,number:'9876'}))),r);
});
test('상자 수 경계와 기하 문턱',()=>{
  assert.equal(classify(grid(40)).isAnswerTable,false);
  assert.equal(classify(grid(41)).isAnswerTable,true);
  assert.equal(classify(grid().map(i=>({...i,rects:[{...i.rects[0],h:.049}]}))).isAnswerTable,false);
  assert.equal(classify(grid().map(i=>({...i,rects:[{...i.rects[0],x:.1}]}))).isAnswerTable,false);
});
test('빈 입력·비정규 좌표·여러 쪽·여러 조각은 보존',()=>{
  for(const items of [null,[],[{}],grid().map(i=>({...i,page:2})),
    grid().map(i=>({...i,rects:[{...i.rects[0],w:NaN}]})),
    grid().map(i=>({...i,rects:[...i.rects,...i.rects]}))]) assert.equal(classify(items).isAnswerTable,false);
});
test('짧은 글 비율은 실제 text만 사용, 번호와 무관',()=>{
  const items=grid().map((i,k)=>({...i,text:k%2 ? '긴 가상 문항 설명' : '12 ③'}));
  assert.equal(classify(items).features.shortTextRatio,.5);
  assert.equal(classify(items).features.textCoverage,1);
});
