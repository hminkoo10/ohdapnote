import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trailingNonQuestionPages, applyPageExclusions, restorePageItems, isExcludedPage } from '../../src/renderer/js/page-exclusions.js';
import { classifyAnswerTableShape } from '../../src/renderer/js/pagerole.js';
import { densePages } from '../fixtures/dense-pages.mjs';

test('약한 끝 묶음은 기존 모양을 통과한 쪽이 있을 때만 연결', () => {
  const rows = [{index:0,hasQuestions:true},{index:1,shape:true},
    {index:2,weakShape:true},{index:3,weakShape:true}];
  assert.deepEqual([...trailingNonQuestionPages(rows,4).keys()],[3,2,1]);
  assert.equal(trailingNonQuestionPages(rows.map(r=>({...r,shape:false})),4).size,0);
  assert.equal(trailingNonQuestionPages(rows.map(r=>({...r,weakShape:r.index===3})),4).size,0);
  assert.deepEqual([...trailingNonQuestionPages(rows.map(r=>({...r,restored:r.index===2})),4).keys()],[]);
});

test('확실한 쪽 없는 경우 비문항 끝 묶음도 이전 결과 유지', () => {
  const rows = [{index:0,hasQuestions:true},{index:1,weakShape:true},
    {index:2,nonQuestion:true,role:'toc'}];
  assert.deepEqual([...trailingNonQuestionPages(rows,3)],[[2,'toc']]);
  for (let mask=0;mask<625;mask++) {
    let state=mask;
    const sample=[{index:0,hasQuestions:true}];
    for(let index=1;index<5;index++) {
      const kind=state%5;state=Math.floor(state/5);
      sample.push({index,weakShape:kind===1||kind===3,nonQuestion:kind===2||kind===3,
        restored:kind===4,role:'toc',hasQuestions:true});
    }
    const legacy=new Map();
    for(let index=4;index>=0;index--) {
      const row=sample[index];
      if(row.restored||!row.nonQuestion)break;
      legacy.set(index,row.role);
    }
    assert.deepEqual([...trailingNonQuestionPages(sample,5)],[...legacy]);
  }
});

test('약한 모양은 적은 문장·짧은 글 격자만 허용하고 40상자 이하는 거부', () => {
  const make = n => Array.from({length:n},(_,i)=>({page:0,text:i<2?'값이다.':'①',
    rects:[{page:0,x:.1+(i%3)*.25,y:.05+Math.floor(i/3)*.035,w:.15,h:i%6===0?.06:.02}]}));
  const weak=classifyAnswerTableShape(make(48));
  assert.equal(weak.matchesShape,false);
  assert.equal(weak.supportsAnswerTable,true);
  assert.equal(classifyAnswerTableShape(make(40)).supportsAnswerTable,false);
  assert.equal(classifyAnswerTableShape(make(48).map(x=>({...x,text:'값이다.'}))).supportsAnswerTable,false);
  assert.equal(classifyAnswerTableShape(make(48).map(x=>({...x,rects:[{...x.rects[0],w:-1}]}))).supportsAnswerTable,false);
  assert.equal(classifyAnswerTableShape(make(48).map((x,i)=>({...x,number:999-i}))).supportsAnswerTable,true);
});

test('책 끝 연속 묶음만 제외: 중간 모양·쪽 누락·되돌린 쪽에서 멈춤', () => {
  const rows = [0,1,2,3,4].map(index => ({ index, shape: index !== 2, hasQuestions: index === 2, role: 'answer_table' }));
  assert.deepEqual([...trailingNonQuestionPages(rows, 5).keys()], [4,3]);
  assert.equal(trailingNonQuestionPages(rows.slice(0,4), 5).size, 0);
  assert.deepEqual([...trailingNonQuestionPages(rows.map(r => ({ ...r, restored: r.index === 3 })), 5).keys()], [4]);
  assert.equal(trailingNonQuestionPages(rows, 7).size, 0);
});

test('끝의 비문항 쪽을 연결하되 문항 쪽 너머로 확장하지 않음', () => {
  const rows = [{ index: 0, hasQuestions: true }, { index: 1, shape: true }, { index: 2, nonQuestion: true, role: 'toc' }];
  assert.deepEqual([...trailingNonQuestionPages(rows, 3)], [[2,'toc'],[1,'answer_table']]);
});

test('한 쪽·전부 빽빽한 문서는 통째로 빼지 않음', () => {
  for (const count of [1, 3, 12]) {
    const rows = Array.from({ length: count }, (_, index) => ({ index, shape: true, hasQuestions: true }));
    assert.equal(trailingNonQuestionPages(rows, count).size, 0);
  }
});

test('사진 몇 장: 앞에 문항이 남는 보통 쪽이 있어야 제외', () => {
  const rows = [{ index: 0, nonQuestion: true }, { index: 1 }, { index: 2, shape: true }];
  assert.equal(trailingNonQuestionPages(rows, 3).size, 0);
  rows[1].hasQuestions = true;
  assert.deepEqual([...trailingNonQuestionPages(rows, 3).keys()], [2]);
  assert.equal(trailingNonQuestionPages(rows.slice(2), 3).size, 0);
});

test('제외 원본 보관, 저장 왕복, 한 번 복구, 다시 분석 뒤에도 전부 보존', () => {
  const items = densePages[2].items;
  const index = items[0].page;
  const fresh = { [index]: { analyzed: true, flags: ['번호를 찾지 못함'] } };
  const roles = new Map([[index,'answer_table']]);
  let doc = applyPageExclusions(items, fresh, roles);
  assert.equal(doc.items.length, 0);
  assert.equal(doc.pageInfo[index].exclusion.items.length, items.length);
  assert.deepEqual(doc.pageInfo[index].flags, []);
  doc = JSON.parse(JSON.stringify(doc));
  doc = applyPageExclusions([], fresh, new Map(), doc);
  assert.equal(isExcludedPage(doc.pageInfo[index]), true);
  assert.equal(restorePageItems(doc,index), true);
  assert.deepEqual(doc.items, items);
  assert.equal(restorePageItems(doc,index), false);
  doc.items[0].number = '사용자 수정';
  const next = applyPageExclusions([], fresh, roles, doc);
  assert.deepEqual(next.items, doc.items);
  assert.equal(isExcludedPage(next.pageInfo[index]), false);
  assert.equal(next.pageInfo[index].exclusion.restored, true);
  assert.deepEqual(applyPageExclusions([], {}, new Map(), next).items, next.items);
});

test('옛 저장본·표지·목차도 원본을 버리지 않음', () => {
  const item = { page: 0, id: 'old', rects: [] };
  const old = JSON.parse(JSON.stringify({ items: [item], pageInfo: { 0: { analyzed: true } } }));
  assert.deepEqual(applyPageExclusions(old.items, old.pageInfo, new Map(), old), old);
  assert.equal(restorePageItems(old,0), false);
  for (const role of ['toc','unit_cover']) {
    const doc = applyPageExclusions([item], old.pageInfo, new Map([[0,role]]));
    assert.equal(doc.items.length,0);
    restorePageItems(doc,0);
    assert.deepEqual(doc.items,[item]);
  }
});

test('상자 안 문장은 제외 거부, 식만 있거나 글 누락인 밀집 쪽은 복구 가능', () => {
  for (const row of densePages) {
    const shape = classifyAnswerTableShape(row.items).matchesShape;
    if (row.items[0].text?.includes('하시오') || row.items[0].text?.includes('이다')) assert.equal(shape,false);
    else assert.equal(shape,true);
  }
});
