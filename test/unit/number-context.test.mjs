import {test} from 'node:test';
import assert from 'node:assert/strict';
import {numberContextGrid,numberContextEvidence,filterNumberContexts} from '../../src/renderer/js/number-context.js';
const box={x0:.1,x1:.15,y0:.2,y1:.22};
function fixture({bold=true,panel=true,badge=false,role='problem'}={}) {
 const g={w:200,h:400,dark:new Uint8Array(80000).fill(30),pale:new Uint8Array(80000).fill(panel?210:0),fill:new Uint8Array(80000).fill(badge?210:0)};
 const title={str:'가상 제목',x0:.17,x1:.31,y0:.2,y1:.22};
 for(let y=80;y<88;y++)for(let x=34;x<62;x++)g.dark[y*200+x]=bold?180:30;
 const body=Array.from({length:5},(_,i)=>({str:'지어낸 설명',x0:.17,x1:.4,y0:.26+i*.027,y1:.28+i*.027}));
 return {index:0,role,numberContext:g,tokens:[title,...body],ocrPasses:[]};
}
test('every final title candidate is judged, regardless of primary/auxiliary membership',()=>{
 for(const group of ['main','aux','crop','fill','retry']){
  const p=fixture(),c={...box,group};p.candidates=[c];
  assert.equal(numberContextEvidence(p,box).reject,true);
  assert.deepEqual(filterNumberContexts(p,[c]),[]);
  assert.deepEqual(p.candidates,[c]);assert.equal(p.contextHeadings.length,1);
 }
});
test('real bold colored question heads and nearby fractions survive',()=>{
 for(const prompt of ['다음 조건을 설명하시오','대표문제','Find the invented value']){
  const p=fixture({badge:true});p.tokens[0].str=prompt;
  p.grid={w:200,h:400,data:new Uint8Array(80000).fill(1)};
  p.tokens.push({str:'×',x0:.16,x1:.18,y0:.23,y1:.25});
  assert.equal(numberContextEvidence(p,box).reject,false);
  assert.deepEqual(filterNumberContexts(p,[box]),[box]);
 }
});
test('fraction-like raster and adjacent fraction word do not veto a problem number',()=>{
 const p=fixture({panel:false});
 p.tokens[0].str='분자';
 for(let x=25;x<150;x++)p.numberContext.dark[92*200+x]=220;
 assert.equal(numberContextEvidence(p,box).reject,false);
 assert.deepEqual(filterNumberContexts(p,[box]),[box]);
});
test('answer roles receive the identical final visual predicate',()=>{
 const p=fixture({role:'answer',badge:true});
 assert.equal(numberContextEvidence(p,box).reject,true);
 assert.deepEqual(filterNumberContexts(p,[box]),[]);
});
test('isolated color, badge or bold text is insufficient; missing data preserves candidate',()=>{
 for(const options of [{bold:false},{panel:false},{bold:false,badge:true}])assert.equal(numberContextEvidence(fixture(options),box).reject,false);
 assert.equal(numberContextEvidence({...fixture(),tokens:[]},box).reject,false);
});
test('number fields, signature and alignment inaccessible; recovery is value invariant',()=>{
 const p=fixture();
 for(const num of [8,57,602,90001]){
  const c=new Proxy({...box,num,digits:String(num)},{get(t,k){if(['num','digits','padded','style','prefix','relX','hRatio','font','col','group','signature'].includes(k))throw Error('forbidden '+k);return t[k];}});
  assert.deepEqual(filterNumberContexts(p,[c]),[]);
 }
 assert.equal(p.contextHeadings.length,1);
 assert.deepEqual(filterNumberContexts(p,[{contextBox:box,x0:.8,x1:.99,y0:.7,y1:.8}]),[]);
});
test('repeated final evaluation clears stale cutters, without remembered group vetoes',()=>{
 const p=fixture();filterNumberContexts(p,[box]);assert.equal(p.contextHeadings.length,1);
 p.tokens[0].str='다음 문제';assert.deepEqual(filterNumberContexts(p,[box]),[box]);assert.deepEqual(p.contextHeadings,[]);
});
test('raster cues use chroma rather than one named hue',()=>{
 for(const rgb of [[100,180,110],[100,120,180],[180,100,140]]){
  const rgba=new Uint8ClampedArray(40*60*4);for(let i=0;i<rgba.length;i+=4)rgba.set([...rgb,255],i);
  const g=numberContextGrid(rgba,40,60);assert.equal(g.fill[0],255);assert.equal(g.pale[0],0);
 }
});
