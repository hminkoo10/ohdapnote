import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {numberContextGrid,lineInteriorEvidence,filterNumberContexts} from '../../src/renderer/js/number-context.js';
function fixture({rule=true,inside=false,short=false,split=false}={}){
 const w=960,h=1200,rgba=new Uint8ClampedArray(w*h*4).fill(255),box={x0:.53,x1:.55,y0:.45,y1:.465};
 const paint=(x0,x1,y0,y1,solid=false)=>{for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)if(solid||x%5===0||y%7===0){const k=(y*w+x)*4;rgba[k]=rgba[k+1]=rgba[k+2]=0;}};
 paint(509,527,540,558);
 if(rule)paint(489,491,short?536:180,short?562:1020,true);
 const left=inside?{x0:.513,x1:.526,y0:.45,y1:.465}:{x0:.49,x1:.508,y0:.45,y1:.465};
 paint(Math.floor(left.x0*w),Math.ceil(left.x1*w),540,558);
 return {box,page:{numberContext:numberContextGrid(rgba,w,h),contextColumns:split?[{x0:.1,x1:.51},{x0:.515,x1:.9}]:[{x0:.1,x1:.9}],tokens:[{str:'invented prose',...left}],ocrPasses:[]}};
}
test('two columns and a long thin separator preserve right-column head despite same-height left-column prose',()=>{
 for(const split of [false,true]){const {page,box}=fixture({split});assert.equal(lineInteriorEvidence(page,box).reject,false);}
});
test('regression fixture reproduces cross-column rejection when local rule clipping is absent',async()=>{
 const source=fs.readFileSync(new URL('../../src/renderer/js/number-context.js',import.meta.url),'utf8').replace('const boundary=localColumnBoundary(g,box,baseCol,hp);','const boundary=null;');
 const old=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const {page,box}=fixture();assert.equal(old.lineInteriorEvidence(page,box).reason,'same-line-interior');
});
test('same-column interior remains rejected on the right side of the separator',()=>{
 const {page,box}=fixture({inside:true});assert.equal(lineInteriorEvidence(page,box).reason,'same-line-interior');
});
test('a short vertical glyph is not a column separator',()=>{
 const {page,box}=fixture({short:true});assert.equal(lineInteriorEvidence(page,box).reason,'same-line-interior');
});
test('column clipping is independent of number value, scheme, source and group',()=>{
 const {page,box}=fixture();
 for(const source of ['text','ocr','crop','fill'])for(const value of [5,82,703,90004]){
  const c=new Proxy({...box,source,num:value,digits:String(value)},{get(t,k){if(['num','digits','style','prefix','padded','signature','group','col','relX'].includes(k))throw Error('forbidden field');return t[k];}});
  assert.equal(filterNumberContexts(page,[c]).length,1);
 }
});
