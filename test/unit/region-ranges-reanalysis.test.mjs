import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// PDF/OCR 입력 경계만 합성 쪽으로 대체. 번호 선택과 두 computeItems 호출은 실제 코드.
const root = new URL('../../src/renderer/js/', import.meta.url);
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url === new URL('ocr.js', root).href) return { format: 'module', shortCircuit: true,
    source: "export const OCR_WORKERS=1; export function recognizeWords(){throw Error('OCR forbidden')} export function recognizeLine(){throw Error('OCR forbidden')}" };
  if (url === new URL('docsource.js', root).href) return { format: 'module', shortCircuit: true,
    source: "export function createCanvas(){throw Error('canvas forbidden')}" };
  if (url === new URL('analyze.js', root).href) {
    let source = readFileSync(new URL(url), 'utf8');
    source = source.replace('  const canvas = await src.renderPage(index, ANALYSIS_WIDTH);', '  return src.synthetic;\n  const canvas = await src.renderPage(index, ANALYSIS_WIDTH);');
    return { format: 'module', shortCircuit: true, source };
  }
  return nextLoad(url, context);
} });
let analyzeDocument, reanalyzeSinglePage, buildCutters;
try { ({ analyzeDocument, reanalyzeSinglePage, buildCutters } = await import('../../src/renderer/js/analyze.js')); }
finally { hooks.deregister(); }

function synthetic() {
  const w=240,h=500,data=new Uint8Array(w*h);
  const paint=(y0,y1)=>{ for(let y=Math.round(y0*h);y<Math.round(y1*h);y++) for(let x=27;x<180;x++) data[y*w+x]=1; };
  const candidates=[4,5,6,7,8].map((num,i)=>({num,digits:String(num),col:0,x0:.11,x1:.13,
    y0:i ? .39+i*.07 : .15,y1:i ? .41+i*.07 : .17,h:.02,conf:100}));
  candidates.forEach(a=>paint(a.y0,a.y1)); paint(.4,.42);
  return {index:0,bodyH:.02,grid:{w,h,data},layout:{bodyTop:.1,bodyBottom:.95,columns:[{x0:.1,x1:.9}]},
    candidates,source:'text',footerNumbers:[],headings:[],ranges:[],ocrPasses:[],needsOcr:false,
    tokens:[{str:'[',x0:.11,x1:.12,y0:.4,y1:.42},{str:'5~',x0:.13,x1:.17,y0:.4,y1:.42},
      {str:'8]',x0:.18,x1:.21,y0:.4,y1:.42},{str:'합성 조건',x0:.24,x1:.6,y0:.4,y1:.42}]};
}

test('13c: 처음 분석·한 쪽 재분석 번호 사슬/영역/지문 일치, 저장 범위 불변', async () => {
  for (const subject of ['math', 'english']) {
    const page=synthetic(), original=structuredClone(page.ranges);
    const first=await analyzeDocument({synthetic:page,numPages:1},{pages:[0],subject});
    const again=await reanalyzeSinglePage({synthetic:page}, {...first,options:{flow:'column'}},0,{deep:false,subject});
    assert.ok(first.items.length >= 4);
    assert.deepEqual(again.items,first.items);
    assert.deepEqual(again.items.map(i=>i.num),[4,5,6,7,8]);
    for (const num of [5,6,7,8]) assert.equal(again.items.find(i=>i.num===num).stemLabel,'5~8');
    assert.deepEqual(page.ranges,original);
    const anchors=new Map([[0,page.candidates]]), cuts=buildCutters([page],anchors,first.signature);
    assert.deepEqual(buildCutters([page],anchors,first.signature),cuts);
    assert.deepEqual(page.ranges,original);
  }
});

