import {test} from 'node:test';
import assert from 'node:assert/strict';
import {anchorVisualEvidence, dropStrayRuns} from '../../src/renderer/js/detect.js';
const c=(num,y=.2)=>({num,digits:String(num),prefix:'',padded:false,col:0,x0:.11,x1:.13,y0:y,y1:y+.03,h:.03,hRatio:1.5,relX:.01});
const w=(str,x,y)=>({str,x0:x,x1:x+.09,y0:y,y1:y+.02});
const page=(a)=>({index:9,layout:{columns:[{x0:.1,x1:.9}],bodyTop:.1,bodyBottom:.9},candidates:[a],ocrPasses:[[w('가상의 조건',.18,.21),w('조건을 사용',.18,.245)]]});
test('visual protection accepts separated text block, invariant to number value/order',()=>{
 const a=c(4),p=page(a);const before=anchorVisualEvidence(p,a);
 assert.equal(before.protect,true);
 for(const num of [1,82,17,61,999])assert.deepEqual(anchorVisualEvidence(p,{...a,num,digits:String(num)}),before);
});
test('formula, contents, choice, figure, footer and missing evidence stay unprotected',()=>{
 const a=c(4);
 for(const tokens of [[],[w('+',.18,.21),w('x',.18,.245)],[w('목차 ··· 38',.18,.21),w('조건을 사용',.18,.245)],[w('① 조건',.18,.21),w('② 조건',.18,.245)]])assert.equal(anchorVisualEvidence({...page(a),ocrPasses:[tokens]},a).protect,false);
 for(const b of [{...a,hRatio:.5},{...a,relX:.2},{...a,y0:.96,y1:.99}])assert.equal(anchorVisualEvidence(page(b),b).protect,false);
});
test('stray deletion still removes unprotected candidates',()=>{
 const a=c(55),p=page(a),order=[0,1,2,3,4,5,6,9],anchors=new Map(order.map((i)=>[i,[i===9?a:c(10+i)]]));
 assert.equal(dropStrayRuns(order,anchors,'|0',[p]),0);assert.deepEqual(anchors.get(9),[a]);
 const m=new Map(order.map((i)=>[i,[i===9?a:c(10+i)]]));assert.equal(dropStrayRuns(order,m,'|0'),1);
});
