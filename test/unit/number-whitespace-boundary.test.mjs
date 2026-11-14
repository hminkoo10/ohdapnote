import {test} from 'node:test';
import assert from 'node:assert/strict';
import {numberContextGrid,lineInteriorEvidence,filterNumberContexts} from '../../src/renderer/js/number-context.js';
function fixture({mode='gutter',inside=false,tall=false}={}){
 const w=960,h=1200,rgba=new Uint8ClampedArray(w*h*4).fill(255),box={x0:490/w,x1:530/w,y0:540/h,y1:560/h};
 const paint=(x0,x1,y0,y1,solid=false)=>{for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)if(solid||x%4===0||y%7===0){const k=(y*w+x)*4;rgba[k]=rgba[k+1]=rgba[k+2]=0;}};
 const rows=mode==='word'||mode==='choices'?[360,410,460,510,540,590,640,690]:Array.from({length:23},(_,i)=>80+i*46);
 for(const y of rows){
  if(mode==='table'){paint(464,476,y,y+13);paint(490,503,y,y+13);}
  else {paint(410,480,y,y+14);paint(490,620,y,y+14);}
 }
 paint(410,480,540,560);paint(490,530,540,560);
 if(mode==='ruled')for(let y=50;y<1170;y+=50)paint(405,625,y,y+1,true);
 let left={x0:452/w,x1:477/w,y0:540/h,y1:560/h};
 if(inside){left={x0:535/w,x1:565/w,y0:540/h,y1:560/h};paint(535,565,540,560);box.x0=577/w;box.x1=612/w;paint(577,612,540,560);}
 if(tall)left={...left,y0:500/h,y1:610/h};
 return {box,page:{numberContext:numberContextGrid(rgba,w,h),contextColumns:[{x0:.05,x1:.95}],tokens:[{str:'invented prose',...left}],ocrPasses:[]}};
}
test('narrow unruled two-column gutter preserves a head even when ink layout has one column',()=>{
 for(const tall of [false,true]){
  const {page,box}=fixture({tall});const e=lineInteriorEvidence(page,box);
  assert.equal(e.reject,false);assert.equal(e.lineProbe.columnBoundary.basis,'vertical-whitespace');
 }
});
test('same-column interiors still reject beyond a genuine gutter',()=>{
 const {page,box}=fixture({inside:true});assert.equal(lineInteriorEvidence(page,box).reason,'same-line-interior');
});
test('word spaces accidentally aligned over many lines do not become column boundaries',()=>{
 const {page,box}=fixture({mode:'word'});assert.equal(lineInteriorEvidence(page,box).reason,'same-line-interior');
});
test('choice gaps, narrow borderless cells and ruled tables are not paragraph gutters',()=>{
 for(const mode of ['choices','table','ruled']){
  const {page,box}=fixture({mode});assert.equal(lineInteriorEvidence(page,box).reason,'same-line-interior',mode);
 }
});
test('gutter preservation does not read number, group, signature or inferred alignment fields',()=>{
 const {page,box}=fixture();
 for(const value of [8,61,903,50004])for(const source of ['text','ocr','crop','fill']){
  const c=new Proxy({...box,num:value,digits:String(value),source},{get(t,k){if(['num','digits','padded','style','prefix','col','group','signature','relX'].includes(k))throw Error('forbidden field');return t[k];}});
  assert.equal(filterNumberContexts(page,[c]).length,1);
 }
});
