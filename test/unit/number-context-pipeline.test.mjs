import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
const root=new URL('../../src/renderer/js/',import.meta.url);
const hooks=registerHooks({load(url,ctx,next){
 if(url===new URL('ocr.js',root).href)return {format:'module',shortCircuit:true,source:"export const OCR_WORKERS=1; export function recognizeWords(){throw Error('unexpected OCR')} export function recognizeLine(){throw Error('unexpected OCR')}"};
 if(url===new URL('docsource.js',root).href)return {format:'module',shortCircuit:true,source:"export function createCanvas(){throw Error('unexpected canvas')}"};
 if(url===new URL('analyze.js',root).href)return {format:'module',shortCircuit:true,source:readFileSync(new URL(url),'utf8').replace('  const canvas = await src.renderPage(index, ANALYSIS_WIDTH);','  return structuredClone(src.synthetic);\n  const canvas = await src.renderPage(index, ANALYSIS_WIDTH);')};
 return next(url,ctx);
}});
let analyzeDocument,reanalyzeSinglePage;
try{({analyzeDocument,reanalyzeSinglePage}=await import('../../src/renderer/js/analyze.js'));}finally{hooks.deregister();}
function page(){
 const w=200,h=400,data=new Uint8Array(w*h).fill(1),dark=new Uint8Array(w*h).fill(30);
 for(let y=80;y<88;y++)for(let x=34;x<62;x++)dark[y*w+x]=180;
 const candidates=[[91,.08],[92,.14],[93,.45],[94,.6],[95,.8],[1,.2],[2,.35],[3,.65],[4,.9]].map(([num,y0])=>({num,digits:num>90?'00'+num:String(num),style:'plain',prefix:'',padded:num>90,col:0,x0:.1,x1:.15,y0,y1:y0+.02,h:.02,hRatio:1.5,relX:0,conf:99}));
 return {index:0,role:'problem',source:'text',layout:{bodyTop:.05,bodyBottom:.95,columns:[{x0:.09,x1:.8}]},grid:{w,h,data},numberContext:{w,h,dark,pale:new Uint8Array(w*h).fill(210),fill:new Uint8Array(w*h)},
 candidates,ocrPasses:[],footerNumbers:[],headings:[],ranges:[],needsOcr:false,
 tokens:[{str:'가상 제목',x0:.17,x1:.31,y0:.2,y1:.22},...Array.from({length:5},(_,i)=>({str:'지어낸 설명',x0:.17,x1:.4,y0:.26+i*.027,y1:.28+i*.027}))]};
}
test('final visual veto leaves learning intact; all routes and deep reanalysis block the title glyph',async()=>{
 const src={synthetic:page(),numPages:1};
 const first=await analyzeDocument(src,{pages:[0],subject:'math'});
 assert.deepEqual(first.items.filter(i=>i.num>90).map(i=>i.num),[91,92,93,94,95]);
 assert.equal(first.items.some(i=>i.num===1),false);
 const previous=first.items.find(i=>i.num===92).rects[0];assert.ok(previous.y+previous.h<=.2);
 assert.ok(first.items.find(i=>i.num===93).rects[0].y>.4);
 const again=await reanalyzeSinglePage(src,{...first,options:{flow:'column'}},0,{deep:true,subject:'math'});
 assert.deepEqual(again.items.filter(i=>i.num>90).map(i=>i.num),[91,92,93,94,95]);
 assert.equal(again.items.some(i=>i.num===1),false);
});
test('a title selected by the primary chain receives the same final veto',async()=>{
 const p=page(),primary=p.candidates.find(c=>c.num===91),aux=p.candidates.find(c=>c.num===1);
 [primary.y0,aux.y0]=[aux.y0,primary.y0];primary.y1=primary.y0+.02;aux.y1=aux.y0+.02;
 const src={synthetic:p,numPages:1};
 const first=await analyzeDocument(src,{pages:[0],subject:'math'});
 assert.equal(first.items.some(i=>i.num===91),false);
 assert.ok(first.items.some(i=>i.num===92));
 const again=await reanalyzeSinglePage(src,{...first,options:{flow:'column'}},0,{deep:true,subject:'math'});
 assert.equal(again.items.some(i=>i.num===91),false);
});
test('final primary interior glyph is removed after recovery, without becoming a cutter',async()=>{
 const p=page(),c=p.candidates.find(c=>c.num===93);
 p.numberContext.pale.fill(0);
 p.contextColumns=[{x0:.09,x1:.8}];c.x0=.3;c.x1=.35;
 p.tokens.push({str:'invented prose',x0:.24,x1:.29,y0:.45,y1:.47});
 for(let y=180;y<188;y++)for(let x=48;x<58;x++)p.numberContext.dark[y*200+x]=(x%3===0||y%4===0)?220:0;
 const src={synthetic:p,numPages:1};
 const first=await analyzeDocument(src,{pages:[0],subject:'math'});
 assert.equal(first.items.some(i=>i.num===93),false);
 assert.ok(first.items.some(i=>i.num===92));
 const again=await reanalyzeSinglePage(src,{...first,options:{flow:'column'}},0,{deep:true,subject:'math'});
 assert.equal(again.items.some(i=>i.num===93),false);
 assert.equal(again.page.contextHeadings.some(h=>h.y0===.45),false);
});
