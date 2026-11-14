import {test} from 'node:test';
import assert from 'node:assert/strict';
import {numberContextGrid,numberContextEvidence,choiceShapeObservation} from '../../src/renderer/js/number-context.js';
function fixture({kind='circle',peer=true,vertical=false,radius=8}={}){
 const w=960,h=1306,rgba=new Uint8ClampedArray(w*h*4).fill(255),r=radius,cy=400,cx=220;
 const dot=(x,y)=>{x=Math.round(x);y=Math.round(y);if(x>=0&&x<w&&y>=0&&y<h){const k=(y*w+x)*4;rgba[k]=rgba[k+1]=rgba[k+2]=0;}};
 function item(x,y){
  if(kind==='filled'){for(let a=-r;a<=r;a++)for(let b=-r;b<=r;b++)if(a*a+b*b<=r*r)dot(x+a,y+b);}
  else if(kind==='box')for(let a=-r;a<=r;a++){dot(x+a,y-r);dot(x+a,y+r);dot(x-r,y+a);dot(x+r,y+a);}
  else if(kind==='prefix'){for(let a=-r;a<0;a++)for(let b=-r;b<=r;b++)if(Math.abs(b)<a+r)dot(x-8+a,y+b);}
  else for(let a=0;a<360;a+=2){
   const t=a*Math.PI/180;
   if(kind==='parentheses'&&Math.abs(Math.sin(t))>.87)continue;
   dot(x+r*Math.cos(t),y+r*(kind==='parentheses'?1.1:1)*Math.sin(t));
  }
  // Invented angular center glyph, with no encoded numeric value.
  for(let yy=-4;yy<=4;yy++){dot(x-1,y+yy);if(yy===-4)for(let xx=-1;xx<=2;xx++)dot(x+xx,y+yy);}
  for(let xx=x+15;xx<x+65;xx++)for(let yy=y-6;yy<=y+6;yy++)if(xx%6===0||yy%7===0)dot(xx,yy);
 }
 item(cx,cy);if(peer)item(vertical?cx:540,vertical?cy+65:cy);
 const box={x0:(cx-r)/w,x1:(cx+r+1)/w,y0:(cy-r)/h,y1:(cy+r+1)/h};
 return {box,page:{numberContext:numberContextGrid(rgba,w,h),contextColumns:[{x0:.1,x1:.9}],tokens:[],ocrPasses:[]}};
}
test('hollow ink shape plus same-row horizontal peer rejects independently enclosed circle choices',()=>{
 for(const kind of ['circle'])for(const radius of [6,8]){
  const {page,box}=fixture({kind,radius});
  assert.equal(choiceShapeObservation(page,box).horizontalPeer,true,JSON.stringify(choiceShapeObservation(page,box)));
  assert.equal(numberContextEvidence(page,box).reason,'choice-shape-horizontal',kind);
 }
});
test('single/vertically arranged circular or parenthesized genuine heads stay',()=>{
 for(const kind of ['circle','parentheses'])for(const options of [{peer:false},{vertical:true}]){
  const {page,box}=fixture({kind,...options});assert.equal(numberContextEvidence(page,box).reject,false);
 }
});
test('filled badges and border boxes remain even if repeated horizontally',()=>{
 for(const kind of ['filled','box','prefix'])for(const radius of [5,6,8]){
  const {page,box}=fixture({kind,radius});assert.equal(numberContextEvidence(page,box).reject,false,kind);
 }
});
test('large circular genuine problem badges stay despite a same-row circular peer',()=>{
 const {page,box}=fixture({radius:14});assert.equal(numberContextEvidence(page,box).reject,false);
});
test('shape input ignores OCR glyph strings, numeric values, groups and other columns',()=>{
 const {page,box}=fixture();
 page.tokens=new Proxy([],{get(){throw Error('tokens forbidden');}});
 page.candidates=new Proxy([],{get(){throw Error('candidates forbidden');}});
 for(const n of [7,83,406,90004]){
  const b=new Proxy({...box,num:n,digits:String(n)},{get(t,k){if(['num','digits','style','padded','col','group','signature','prefix'].includes(k))throw Error('forbidden '+k);return t[k];}});
  assert.equal(choiceShapeObservation(page,b).horizontalPeer,true);
 }
 page.contextColumns=[{x0:.1,x1:.4},{x0:.45,x1:.9}];
 assert.equal(choiceShapeObservation(page,box).horizontalPeer,false);
});

// Wide head geometry from the failure class, invented pixels only. Formula
// arcs elsewhere must not turn strokes inside the head into parentheses.
test('wide multi-glyph heads with same-row formula arcs remain',()=>{
 for(const width of [34,39,42]){
  const {page,box}=fixture({kind:'parentheses'});
  const cx=(box.x0+box.x1)/2;
  const wide={...box,x0:cx-width/1920,x1:cx+width/1920};
  assert.equal(numberContextEvidence(page,wide).reject,false);
 }
});
test('parenthesis rejection withdrawn even with a horizontal peer',()=>{
 const {page,box}=fixture({kind:'parentheses'});
 assert.equal(numberContextEvidence(page,box).reject,false);
});
test('small ring inside a wide candidate is not an enclosing circle',()=>{
 const {page,box}=fixture();
 assert.equal(numberContextEvidence(page,{...box,x0:box.x0-.012,x1:box.x1+.012}).reject,false);
});

test('open formula arcs are not independently enclosed peers',()=>{
 const {page,box}=fixture();const g=page.numberContext.line;
 for(let x=537;x<=543;x++)for(let y=390;y<=394;y++){
  const k=y*g.w+x;g.bits[k>>3]&=~(1<<(k&7));
 }
 assert.equal(choiceShapeObservation(page,box).horizontalPeer,false);
 assert.equal(numberContextEvidence(page,box).reject,false);
});
