import {test} from 'node:test';
import assert from 'node:assert/strict';
import {numberContextGrid,numberContextEvidence as packedEvidence,lineInteriorEvidence as packedLineEvidence,filterNumberContexts} from '../../src/renderer/js/number-context.js';

// Every existing real-size case also runs against the independently generated
// pre-compression byte raster. Compare the complete result, including reason/gate.
function equivalent(fn,page,box){
 const actual=fn(page,box);
 if(page.numberContext?.line && page.byteLine){
  const reference={...page,numberContext:{...page.numberContext,line:page.byteLine}};
  assert.deepEqual(actual,fn(reference,box));
 }
 return actual;
}
const numberContextEvidence=(page,box)=>equivalent(packedEvidence,page,box);
const lineInteriorEvidence=(page,box)=>equivalent(packedLineEvidence,page,box);

// Actual app analysis width; printed candidate is only ~11 px high (2.7 cells
// on the former 240-wide grid). Invented strokes, not commercial page pixels.
function fixture(){
 const w=960,h=1306,rgba=new Uint8ClampedArray(w*h*4).fill(255);
 const box={x0:.4,x1:.41,y0:.3,y1:.308};
 const left={str:'invented',x0:.365,x1:.395,y0:.3,y1:.308};
 for(let y=Math.floor(.3*h);y<Math.ceil(.308*h);y++)for(let x=Math.floor(.365*w);x<Math.ceil(.395*w);x++)
  if(x%7===0||y%6===0){let k=(y*w+x)*4;rgba[k]=rgba[k+1]=rgba[k+2]=0;}
 // Candidate glyph itself, not a blank box: invented angular strokes.
 const top=Math.floor(box.y0*h),bottom=Math.ceil(box.y1*h),right=Math.ceil(box.x1*w)-1;
 for(let y=top;y<bottom;y++)for(let x=Math.floor(box.x0*w);x<=right;x++)
  if(y===top||x===right){let k=(y*w+x)*4;rgba[k]=rgba[k+1]=rgba[k+2]=0;}
 const byteDark=new Uint8Array(w*h);
 for(let i=0,k=0;i<rgba.length;i+=4,k++)
  byteDark[k]=rgba[i+3]>=128 && Math.max(rgba[i],rgba[i+1],rgba[i+2])<170 ? 255 : 0;
 return {box,page:{contextColumns:[{x0:.1,x1:.9}],tokens:[left],ocrPasses:[],byteLine:{w,h,dark:byteDark},numberContext:numberContextGrid(rgba,w,h)}};
}
test('real-size tiny inline glyph reproduces old 3-cell early exit, then rejects on native grid',()=>{
 const {box,page}=fixture();assert.ok((box.y1-box.y0)*page.numberContext.h<3);
 const fine=page.numberContext.line;delete page.numberContext.line;
 assert.equal(numberContextEvidence(page,box).reject,false);
 assert.equal(lineInteriorEvidence(page,box).gate,'raster-height-below-3');
 page.numberContext.line=fine;
 assert.equal(numberContextEvidence(page,box).reason,'same-line-interior');
 assert.equal(fine.bits.byteLength,Math.ceil(960*1306/8));
 assert.equal(fine.dark,undefined); // No redundant full-size byte raster retained.
});
test('packed and byte rasters give identical final candidates, cutters and boundary decisions at real size',()=>{
 const {box,page}=fixture();
 const reference={...page,numberContext:{...page.numberContext,line:page.byteLine}};
 // Fractional/edge rectangles exercise floor/ceil, crossed byte boundaries and
 // denominators in density decisions without changing any decision thresholds.
 let checked=0;
 for(const x of [-.01,0,.34,.365,.39,.4,.41,.99])for(const y of [-.01,0,.296,.3,.304,.308,.99]){
  const b={x0:x,x1:x+.01,y0:y,y1:y+.008};
  assert.deepEqual(packedEvidence(page,b),packedEvidence(reference,b));checked++;
 }
 assert.equal(checked,56);
 assert.deepEqual(filterNumberContexts(page,[box]),filterNumberContexts(reference,[box]));
 assert.deepEqual(page.contextHeadings,reference.contextHeadings);
});
test('bit storage matches old threshold at every pixel, including alpha/cutoff and partial last bytes',()=>{
 for(const [w,h] of [[13,11],[17,9]]){
  const rgba=new Uint8ClampedArray(w*h*4);
  for(let k=0;k<w*h;k++)rgba.set([k%3===0?169:170,k%5===0?169:0,0,k%7===0?127:128],k*4);
  const g=numberContextGrid(rgba,w,h).line;
  assert.equal(g.bits.byteLength,Math.ceil(w*h/8));
  for(let k=0;k<w*h;k++){
   const i=k*4,old=rgba[i+3]>=128 && Math.max(rgba[i],rgba[i+1],rgba[i+2])<170 ? 255 : 0;
   assert.equal(((g.bits[k>>3]>>(k&7))&1)*255,old);
  }
  if(w*h%8)assert.equal(g.bits.at(-1)>>(w*h%8),0);
 }
});
test('preservation diagnostics distinguish absent OCR context from absent local-left context',()=>{
 const {box,page}=fixture();page.tokens=[];
 assert.equal(lineInteriorEvidence(page,box).gate,'no-tokens');
 page.tokens=[{str:'invented',x0:.6,x1:.7,y0:.3,y1:.308}];
 assert.equal(lineInteriorEvidence(page,box).gate,'no-local-left-token');
 delete page.contextColumns;assert.equal(lineInteriorEvidence(page,box).gate,'missing-grid-or-ink-columns');
});
test('body or formula starting a line is not removed merely because it is below a genuine head',()=>{
 const {box,page}=fixture();
 page.tokens[0].x0=box.x0;page.tokens[0].x1=.46;
 assert.equal(numberContextEvidence(page,box).reject,false);
 // A broad OCR candidate covering the whole beginning of a formula has no
 // external left neighbor. Locating a numeral inside that token is NOT inferred.
 assert.equal(numberContextEvidence(page,{...box,x1:.46}).reject,false);
});
test('real-size line head, bullet/badge and nearby fraction remain preserved',()=>{
 const {box,page}=fixture();page.tokens[0].str='●';assert.equal(numberContextEvidence(page,box).reject,false);
 page.tokens[0].str='invented';page.tokens[0].x1=.35;assert.equal(numberContextEvidence(page,box).reject,false);
 page.tokens[0].x1=.395;page.tokens[0].y0=.32;page.tokens[0].y1=.328;assert.equal(numberContextEvidence(page,box).reject,false);
 page.tokens[0].y0=.3;page.tokens[0].y1=.308;page.numberContext.fill.fill(200);
 assert.equal(numberContextEvidence(page,box).reject,false);
});
