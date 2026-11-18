import {test} from 'node:test';
import assert from 'node:assert/strict';
import {numberContextGrid,numberContextEvidence,filterNumberContexts} from '../../src/renderer/js/number-context.js';

// Invented page at the analysis raster (960 px wide). Rectangles are raster
// pixels [x0,y0,x1,y1) painted solid black. The candidate glyph is 10 px tall.
const W=960,H=1306;
function page(rects){
 const rgba=new Uint8ClampedArray(W*H*4).fill(255);
 for(const [x0,y0,x1,y1] of rects)for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const k=(y*W+x)*4;rgba[k]=rgba[k+1]=rgba[k+2]=0;}
 return {contextColumns:[{x0:.05,x1:.95}],tokens:[],ocrPasses:[],numberContext:numberContextGrid(rgba,W,H)};
}
const box=([x0,y0,x1,y1])=>({x0:x0/W,x1:x1/W,y0:y0/H,y1:y1/H});
const evidence=(rects,cand)=>numberContextEvidence(page(rects),box(cand));

// Fraction: numerator over a short stroke over a denominator.
const NUM=[384,392,394,402],BAR=[380,405,410,407],DEN=[390,410,400,420];
test('a numerator or denominator inside a fraction is rejected as formula interior',()=>{
 const top=evidence([NUM,BAR,DEN],NUM);
 assert.equal(top.reason,'fraction-interior');
 assert.equal(top.fractionEvidence.side,'below');
 const bottom=evidence([NUM,BAR,DEN],DEN);
 assert.equal(bottom.reason,'fraction-interior');
 assert.equal(bottom.fractionEvidence.side,'above');
});
test('a stroke with no ink on its far side is not a fraction',()=>{
 assert.equal(evidence([NUM,BAR],NUM).reject,false);
});
test('a genuine head under a column-wide rule with text above the rule is kept',()=>{
 // Rule across the column, the previous item's text line just above it.
 const rule=[100,380,860,382],head=[120,386,130,396];
 const text=Array.from({length:40},(_,i)=>[100+14*i,368,110+14*i,378]);
 const e=evidence([rule,head,...text],head);
 // Too wide for the ink it would separate, and centred far from that ink.
 assert.equal(e.reject,false,'stroke width cap and far-side centring keep the head');
 assert.equal(e.fractionEvidence,undefined);
});
test('a genuine head just under the top edge of a box with text above the box is kept',()=>{
 // The box outline is one component: its edges are not a thin stroke.
 const frame=[[100,380,400,382],[100,478,400,480],[100,380,102,480],[398,380,400,480]];
 const head=[110,386,120,396],text=[[100,366,110,376],[114,366,124,376],[128,366,138,376]];
 const e=evidence([...frame,head,...text],head);
 assert.equal(e.reject,false,'a box edge joined to its sides is not a fraction stroke');
 assert.notEqual(e.gate,'closed-box-preserved','reached the formula check, not the closed-box gate');
});
test('a genuine head under an underlined label, at the underline\'s left end, is kept',()=>{
 // Two-glyph label, its underline, then the first item head below the label's left end.
 const label=[[200,370,215,384],[218,370,233,384]],underline=[200,388,234,390],head=[201,394,207,406];
 const e=evidence([...label,underline,head],head);
 assert.equal(e.reject,false,'the head is not centred on the stroke');
 // The same strokes with the digit centred under the label do read as a fraction.
 assert.equal(evidence([...label,underline,[214,394,220,406]],[214,394,220,406]).reason,'fraction-interior');
});
test('a closed number box keeps its preservation gate before the formula check',()=>{
 // Separate rims above/below and a left side close the head. The lower rim is
 // a thin stroke with ink centred under it, so without the side it would read
 // as a fraction; the existing closed-box gate must win.
 const head=[400,400,410,410],above=[398,392,416,395],below=[398,413,416,415],far=[400,417,410,427];
 const side=[394,400,397,410];
 const kept=evidence([head,above,below,far,side],head);
 assert.equal(kept.reject,false);
 assert.equal(kept.gate,'closed-box-preserved');
 assert.equal(evidence([head,above,below,far],head).reason,'fraction-interior');
});

// Bracket pair: tall narrow strokes on both sides crossing the candidate's middle.
const CAND=[400,400,410,410],LB=[385,380,388,430],RB=[422,380,425,430];
test('a number between a pair of tall brackets is rejected as formula interior',()=>{
 const e=evidence([CAND,LB,RB],CAND);
 assert.equal(e.reason,'bracket-pair-interior');
 assert.equal(e.bracketEvidence.leftHeightH,5);
});
test('one bracket alone does not reject',()=>{
 assert.equal(evidence([CAND,LB],CAND).reject,false);
 assert.equal(evidence([CAND,RB],CAND).reject,false);
});
test('a number in a table cell is kept: cell borders joined to rules are not brackets',()=>{
 const cell=[[300,380,600,382],[300,428,600,430],[385,380,387,430],[425,380,427,430]];
 const e=evidence([CAND,...cell],CAND);
 assert.equal(e.reject,false);
 assert.notEqual(e.gate,'closed-box-preserved');
});
test('decorated genuine heads are kept: a marker and a tall side bar on one side only',()=>{
 const head=[400,400,410,410];
 const star=[388,401,395,409],checkbox=[[372,400,382,401],[372,409,382,410],[372,400,373,410],[381,400,382,410]];
 const sideBar=[355,385,359,425],text=[[418,400,428,410],[432,400,442,410]];
 for(const rects of [[head,star,...text],[head,...checkbox,...text],[head,sideBar,star,...text]])
  assert.equal(evidence(rects,head).reject,false);
});

// Contract: only page ink and this candidate's box. No number values, order,
// digit counts, tokens or other candidates.
// The bracket set moved clear of the fraction so both fit on one page.
const sh=([x0,y0,x1,y1])=>[x0+200,y0+100,x1+200,y1+100];
const CAND2=sh(CAND),LB2=sh(LB),RB2=sh(RB);
test('formula evidence ignores number fields, tokens and the other candidates',()=>{
 const p=page([NUM,BAR,DEN,CAND2,LB2,RB2]);
 const refFrac=numberContextEvidence(p,box(NUM)),refBr=numberContextEvidence(p,box(CAND2));
 assert.equal(refFrac.reason,'fraction-interior');
 assert.equal(refBr.reason,'bracket-pair-interior');
 for(const value of [3,48,512,90001]){
  for(const [b,ref] of [[box(NUM),refFrac],[box(CAND2),refBr]]){
   const guarded=new Proxy({...b,num:value,digits:String(value)},{get(t,k){
    if(['num','number','id','str','digits','padded','style','prefix','col','group','signature','relX','hRatio'].includes(k))throw Error('forbidden '+String(k));
    return t[k];
   }});
   assert.deepEqual(numberContextEvidence(p,guarded),ref);
  }
 }
 const far={str:'1',x0:.9,x1:.92,y0:.9,y1:.91};
 assert.deepEqual(numberContextEvidence({...p,tokens:[far],ocrPasses:[[{...far,str:'x'}]]},box(NUM)),refFrac);
 const a={...box(NUM),num:1},b={...box(CAND2),num:2},c={...box([700,700,710,710]),num:3};
 assert.deepEqual(filterNumberContexts(p,[a]),[]);
 assert.deepEqual(filterNumberContexts(p,[c,a,b]),[c]);
 assert.deepEqual(filterNumberContexts(p,[b,c]),[c]);
});
test('packed and byte ink rasters give the same formula evidence',()=>{
 const p=page([NUM,BAR,DEN,CAND2,LB2,RB2]),g=p.numberContext.line,bytes=new Uint8Array(g.w*g.h);
 for(let k=0;k<bytes.length;k++)bytes[k]=(g.bits[k>>3]>>(k&7))&1?255:0;
 const q={...p,numberContext:{...p.numberContext,line:{w:g.w,h:g.h,dark:bytes}}};
 for(const cand of [NUM,DEN,CAND2])assert.deepEqual(numberContextEvidence(q,box(cand)),numberContextEvidence(p,box(cand)));
});
