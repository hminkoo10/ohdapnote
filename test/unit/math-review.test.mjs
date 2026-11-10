import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupMathReview } from '../../src/renderer/js/math-review.js';
import { countLow, nextLow, clearLow, moveLow } from '../../src/renderer/js/lowconf.js';
import { sanitizeTranscripts } from '../../src/main/transcript-review.js';
const math = (eq) => ({ type: 'math', eq, low: [{ reason: 'math' }] });
test('단순 수식 무표시, 복원 수식 문항당 하나, 모호한 구조·그림 개별 유지', () => {
  const input = [math('x'), math('123'), math('f(x)'), math('x ^ {2}'), math('{a} over {b}'), math('cases {x & y}'), {type:'figure', box:{x:0,y:0,w:1,h:1},low:[{reason:'math',detail:'불명 기호'}]}];
  const out = groupMathReview(input);
  assert.equal(countLow(out), 3);
  assert.ok(out.slice(0,3).every(b => !b.low));
  assert.match(out[3].low[0].detail, /수식 2개/);
  assert.equal(nextLow(out).block,3);
  out[3].low = clearLow(out[3].low,0);
  assert.equal(nextLow(out).block,5);
  assert.equal(countLow(input),7);
  const clean = sanitizeTranscripts({items:{q:{blocks:groupMathReview(input)}}});
  assert.equal(countLow(clean.items.q.blocks),3);
  assert.match(clean.items.q.blocks[3].low[0].detail,/수식 2개/);
});

test('문단·보기 안의 한 줄 식도 단순 식 제외 후 같은 문항 묶음', () => {
  const out=groupMathReview([
    {type:'para',text:'값 $f(x)$',low:[{start:0,end:8,reason:'math'}]},
    {type:'choices',items:['$x^{2}$','$1$'],low:[{item:0,start:0,end:7,reason:'math'},{item:1,start:0,end:3,reason:'math'}]},
    math('sqrt x'),
  ]);
  assert.equal(countLow(out),1);
  assert.match(out[1].low[0].detail,/수식 2개/);
  assert.equal(out[1].low[0].item,0);
});

test('한 식 편집으로 문항 전체 수식 묶음이 확인 처리되지 않음', () => {
  const blocks=groupMathReview([math('x ^ {2}'),math('y ^ {3}')]);
  assert.equal(moveLow(blocks[0].low,'x ^ {2}','x ^ {4}').length,1);
});

test('원본 그림 묶음 하나로 세되 모든 조각 다음 확인·저장 유지', () => {
  const f=()=>({type:'figure',box:{x:0,y:0,w:1,h:1},low:[{reason:'ocr'}]});
  const out=groupMathReview([f(),f(),{...f(),low:[{reason:'math',detail:'분수선 미확인'}]}]);
  assert.equal(countLow(out),2);
  let p=nextLow(out); assert.equal(p.block,0);
  p=nextLow(out,p); assert.equal(p.block,1);
  p=nextLow(out,p); assert.equal(p.block,2);
  assert.equal(countLow(sanitizeTranscripts({items:{q:{blocks:out}}}).items.q.blocks),2);
});

test('본문 OCR·복원 수식·원본은 같은 비교 묶음, 불일치·모호한 구조 별도', () => {
  const out=groupMathReview([
    {type:'para',text:'가짜 본문',low:[{reason:'ocr'}]},math('sqrt x'),
    {type:'figure',box:{x:0,y:0,w:1,h:1},low:[{reason:'math'}]},
    math('cases {x & y}'),
    {type:'para',text:'가짜 불일치',low:[{start:0,end:2,reason:'disagree'}]},
  ]);
  assert.equal(countLow(out),3);
  let p=null;const seen=[];
  for(let i=0;i<5;i++){p=nextLow(out,p);seen.push(p.block);}
  assert.deepEqual(seen,[0,1,2,3,4]);
  assert.equal(countLow(sanitizeTranscripts({items:{q:{blocks:out}}}).items.q.blocks),3);
});
