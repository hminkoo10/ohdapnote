import {test} from 'node:test';
import assert from 'node:assert/strict';
import {numberContextGrid,numberContextEvidence} from '../../src/renderer/js/number-context.js';

function fixture({left=true,tall=false,padded=false,decoration=false}={}){
 const w=960,h=1306,rgba=new Uint8ClampedArray(w*h*4).fill(255);
 const glyph={x0:.4,x1:.41,y0:.312,y1:.32};
 const box=padded?{...glyph,y0:.3,y1:.33}:{...glyph};
 const leftInk={x0:.375,x1:.395,y0:.312,y1:.32};
 function paint(b,solid=false){
  for(let y=Math.floor(b.y0*h);y<Math.ceil(b.y1*h);y++)for(let x=Math.floor(b.x0*w);x<Math.ceil(b.x1*w);x++)
   if(solid||x%6===0||y%7===0){const k=(y*w+x)*4;rgba[k]=rgba[k+1]=rgba[k+2]=0;}
 }
 paint(glyph);
 if(left)paint(leftInk,decoration);
 const token={str:decoration?'■':'invented',...leftInk,...(tall?{y0:.25,y1:.37}:{})};
 return {box,page:{contextColumns:[{x0:.1,x1:.9}],tokens:[token],ocrPasses:[],numberContext:numberContextGrid(rgba,w,h)},paint,rgba,w,h};
}
test('native same-line ink rejects an interior glyph despite a tall OCR token and padded candidate box',()=>{
 for(const options of [{tall:true},{padded:true},{tall:true,padded:true}]){
  const {page,box}=fixture(options);
  assert.equal(numberContextEvidence(page,box).reason,'same-line-interior');
 }
});
test('a tall paragraph token without actual left ink, another line or superscript does not erase a true head',()=>{
 const {page,box}=fixture({left:false,tall:true,padded:true});
 assert.equal(numberContextEvidence(page,box).reject,false);
 page.tokens[0].y0=.29;page.tokens[0].y1=.3;
 assert.equal(numberContextEvidence(page,box).reject,false);
 page.tokens[0].y0=.305;page.tokens[0].y1=.31;
 assert.equal(numberContextEvidence(page,box).reject,false);
});
test('native fallback retains decorated and tinted heads even with oversized OCR token boxes',()=>{
 const {page,box}=fixture({tall:true,padded:true,decoration:true});
 assert.equal(numberContextEvidence(page,box).reject,false);
 page.tokens[0].str='invented';page.numberContext.fill.fill(200);
 assert.equal(numberContextEvidence(page,box).reject,false);
});
test('boxed and labeled genuine heads retain oversized left OCR boxes',()=>{
 const f=fixture({tall:true});
 for(const b of [{x0:.394,x1:.416,y0:.3072,y1:.3087},{x0:.394,x1:.416,y0:.3232,y1:.3247},
  {x0:.394,x1:.396,y0:.3072,y1:.3247}])f.paint(b,true);
 f.page.numberContext=numberContextGrid(f.rgba,f.w,f.h);
 assert.equal(numberContextEvidence(f.page,f.box).reject,false);
 const g=fixture({tall:true,padded:true});g.page.tokens[0].str='Question';
 assert.equal(numberContextEvidence(g.page,g.box).reject,false);
});
test('native band measurements remain byte/bit equivalent and number/group independent',()=>{
 const f=fixture({tall:true,padded:true}),bytes=new Uint8Array(f.w*f.h);
 for(let i=0,k=0;i<f.rgba.length;i+=4,k++)bytes[k]=f.rgba[i+3]>=128&&Math.max(f.rgba[i],f.rgba[i+1],f.rgba[i+2])<170?255:0;
 const bytePage={...f.page,numberContext:{...f.page.numberContext,line:{w:f.w,h:f.h,dark:bytes}}};
 assert.deepEqual(numberContextEvidence(f.page,f.box),numberContextEvidence(bytePage,f.box));
 for(const value of [6,73,804,90003]){
  const b=new Proxy({...f.box,num:value,digits:String(value)},{get(t,k){
   if(['num','digits','padded','style','prefix','col','group','signature','relX','hRatio'].includes(k))throw Error('forbidden '+k);
   return t[k];
  }});
  assert.equal(numberContextEvidence(f.page,b).reason,'same-line-interior');
 }
});
