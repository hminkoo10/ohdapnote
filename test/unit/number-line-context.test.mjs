import {test} from 'node:test';
import assert from 'node:assert/strict';
import {numberContextEvidence,filterNumberContexts} from '../../src/renderer/js/number-context.js';

// Invented geometry only. No textbook coordinates/content or number sequences.
const box={x0:.4,x1:.43,y0:.3,y1:.33};
function paint(g,channel,b,value=255){
 for(let y=Math.floor(b.y0*g.h);y<Math.ceil(b.y1*g.h);y++)
  for(let x=Math.floor(b.x0*g.w);x<Math.ceil(b.x1*g.w);x++)
   if(x>=0&&x<g.w&&y>=0&&y<g.h)g[channel][y*g.w+x]=value;
}
function fixture(str='invented',left={x0:.31,x1:.385,y0:.3,y1:.33}){
 const g={w:400,h:600,dark:new Uint8Array(240000),pale:new Uint8Array(240000),fill:new Uint8Array(240000)};
 // Broken vertical/horizontal strokes, unlike a solid geometric bullet.
 for(let x=Math.floor(left.x0*g.w);x<Math.ceil(left.x1*g.w);x++)for(let y=180;y<198;y++)
  if(x%5===0 || y%7===0)g.dark[y*g.w+x]=220;
 return {numberContext:g,contextColumns:[{x0:.1,x1:.9}],layout:{columns:[{x0:.39,x1:.9}],inferred:.39},tokens:[{str,...left}],ocrPasses:[]};
}
test('same-line prose and math interiors are rejected; distant fraction and line heads survive',()=>{
 for(const text of ['invented','가상의 글줄','x + y','α × β','=','+','246'])assert.equal(numberContextEvidence(fixture(text),box).reason,'same-line-interior');
 for(const left of [{x0:.1,x1:.2,y0:.3,y1:.33},{x0:.31,x1:.385,y0:.24,y1:.27}])
  assert.equal(numberContextEvidence(fixture('invented',left),box).reject,false);
 const p=fixture();p.tokens=[];assert.equal(numberContextEvidence(p,box).reject,false);
});
test('only ink-derived columns may bound context, never candidate-inferred columns',()=>{
 const p=fixture();assert.equal(numberContextEvidence(p,box).reject,true);
 p.contextColumns=[{x0:.1,x1:.39},{x0:.395,x1:.9}];
 assert.equal(numberContextEvidence(p,box).reject,false);
 delete p.contextColumns;assert.equal(numberContextEvidence(p,box).reject,false);
});
test('OCR hallucinated left text on white paper cannot reject',()=>{
 const p=fixture();p.numberContext.dark.fill(0);assert.equal(numberContextEvidence(p,box).reject,false);
});
test('boxed, monochrome badge, colored badge and tinted band heads survive left OCR noise',()=>{
 for(const type of ['box','mono','badge','band']){
  const p=fixture(),g=p.numberContext;
  if(type==='box'){
   paint(g,'dark',{x0:.38,x1:.45,y0:.293,y1:.296});
   paint(g,'dark',{x0:.38,x1:.45,y0:.336,y1:.34});
   paint(g,'dark',{x0:.381,x1:.386,y0:.293,y1:.34});
  }else paint(g,type==='mono'?'dark':type==='badge'?'fill':'pale',{x0:.38,x1:.45,y0:.29,y1:.34});
  assert.equal(numberContextEvidence(p,box).reject,false,type);
 }
});
test('square/circle/line decorations do not become same-line text, including OCR O on a solid bullet',()=>{
 for(const str of ['■','●','—','|','O']){
  const p=fixture(str);p.numberContext.dark.fill(0);
  paint(p.numberContext,'dark',{x0:.31,x1:.385,y0:.3,y1:.33});
  assert.equal(numberContextEvidence(p,box).reject,false,str);
 }
});
test('local line predicate is value/group/role invariant across recovery sources',()=>{
 for(const role of ['problem','answer'])for(const source of ['text','ocr','crop','fill','retry'])for(const value of [4,81,760,90002]){
  const p=fixture();p.role=role;
  if(source==='ocr'){p.ocrPasses=[p.tokens];p.tokens=[];}
  const c=new Proxy({...box,num:value,digits:String(value),source},{get(t,k){
   if(['num','digits','padded','style','prefix','col','group','signature','relX','hRatio'].includes(k))throw Error('forbidden '+k);
   return t[k];
  }});
  assert.deepEqual(filterNumberContexts(p,[c]),[]);
  assert.deepEqual(p.contextHeadings,[]); // Interior glyphs must NOT cut a real problem.
  assert.deepEqual(filterNumberContexts(p,[{contextBox:box,x0:.8,x1:.9,y0:.8,y1:.9}]),[]);
 }
});
test('short raster detail, question-prefix labels and superscript neighbors preserve heads',()=>{
 const p=fixture('Question');assert.equal(numberContextEvidence(p,box).reject,false);
 p.tokens[0].str='invented';p.tokens[0].y1=.307;assert.equal(numberContextEvidence(p,box).reject,false);
 const tiny={...box,y1:.302};assert.equal(numberContextEvidence(fixture(),tiny).reject,false);
});
