import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareAnswerGrid, gridWordAnswers, recognizeAnswerGrid, preferGridAnswerKey, answerGridScope } from '../../src/renderer/js/mockexam-image.js';
function synthetic(dataRows = 9) {
  const width = 460, height = 400, data = new Uint8ClampedArray(width * height * 4).fill(255);
  const ink = (x, y) => { const k = (y * width + x) * 4; data[k] = data[k + 1] = data[k + 2] = 0; };
  for (let x = 20; x <= 420; x += 40) for (let y = 80; y <= 80 + dataRows * 30; y++) ink(x, y);
  for (let y = 80; y <= 80 + dataRows * 30; y += 30) for (let x = 20; x <= 420; x++) ink(x, y);
  for (let y = 88; y <= 102; y++) for (let x = 73; x <= 87; x++) if (Math.abs(Math.hypot(x - 80, y - 95) - 7) < 1) ink(x, y);
  for (let y = 91; y <= 99; y++) ink(80, y);
  return { width, height, data };
}
test('합성 정규 격자 선/원 제거, 가운데 숫자와 원본 보존', () => {
  const image = synthetic();
  for (let channel = 0; channel < 3; channel++) image.data[(87 * image.width + 80) * 4 + channel] = 210;
  const original = image.data.slice();
  const g = prepareAnswerGrid(image);
  assert.equal(g.cols.length, 11); assert.equal(g.rows.length, 10);
  assert.equal(g.pixels[(95 * image.width + 80) * 4], 0);
  assert.equal(g.pixels[(88 * image.width + 80) * 4], 255);
  assert.equal(g.pixels[(87 * image.width + 80) * 4], 255);
  assert.deepEqual(image.data, original);
  assert.equal(prepareAnswerGrid({ width: 10, height: 10, data: new Uint8ClampedArray(400).fill(255) }), null);
});
test('행별 번호·좌우 위치·확신도 검증, 읽지 못한 답 추정 금지', () => {
  const grid = { rows: [80, 110, 140], top: 80, bottom: 140 };
  const word = (str, x0, conf = 99) => ({ str, x0, x1: x0 + 30, y0: 5, y1: 20, conf });
  assert.deepEqual(gridWordAnswers([word('1', 100), word('4', 500)], grid, 0, 800, 60, 'korean'), { 1: '4' });
  for (const words of [[word('6', 100), word('4', 500)], [word('1', 100), word('4', 500, 89)], [word('1', 100), {...word('4', 500), conf: undefined}], [word('1', 100), word('9', 500)], [word('1', 100)]]) assert.deepEqual(gridWordAnswers(words, grid, 0, 800, 60, 'korean'), {});
});

test('두 확대 결과가 일치할 때만 답 연결', async () => {
  const previous = globalThis.document;
  const image = synthetic();
  const makeCanvas = () => {
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => ({ getImageData: () => image, createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, drawImage() {} });
    return canvas;
  };
  globalThis.document = { createElement: makeCanvas };
  try {
    const canvas = makeCanvas(); canvas.width = image.width; canvas.height = image.height;
    for (const disagree of [false, true]) {
      const parsed = await recognizeAnswerGrid(canvas, async crop => {
        const cy = crop.height * (95 - 83) / 264;
        return [{ str: '1', x0: crop.width * .1, x1: crop.width * .2, y0: cy - 8, y1: cy + 8, conf: 99 }, { str: disagree && crop.width === 1000 ? '5' : '4', x0: crop.width * .6, x1: crop.width * .7, y0: cy - 8, y1: cy + 8, conf: 99 }];
      }, { subject: 'korean' });
      assert.deepEqual(parsed.answers.korean, disagree ? {} : { 1: { answer: '4', points: null } });
    }
    for (const commonOnly of [false, true]) {
      const parsed = await recognizeAnswerGrid(canvas, async crop => {
        const cy = crop.height * (335 - 83) / 264;
        return [{ str: '41', x0: crop.width * .1, x1: crop.width * .2, y0: cy - 8, y1: cy + 8, conf: 99 }, { str: '4', x0: crop.width * .6, x1: crop.width * .7, y0: cy - 8, y1: cy + 8, conf: 99 }];
      }, { subject: 'korean', commonOnly });
      assert.deepEqual(parsed.answers.korean, commonOnly ? {} : { 41: { answer: '4', points: null } });
    }
  } finally { globalThis.document = previous; }
});

test('기존 OCR와 충돌하는 새 답은 제외, 기존 연결 수가 더 많으면 유지', () => {
  const p={answers:{korean:{1:{answer:'4',points:null}}}};
  const g={answers:{korean:{1:{answer:'2',points:null},2:{answer:'3',points:null},3:{answer:'5',points:null}}}};
  assert.deepEqual(preferGridAnswerKey(p,g).answers.korean,{2:{answer:'3',points:null},3:{answer:'5',points:null}});
  assert.equal(preferGridAnswerKey(g,p),g);
});

test('새 그림 후보가 읽지 못한 기존 답은 남기고 충돌 번호만 버림', () => {
  const p={answers:{korean:{1:{answer:'4',points:null},9:{answer:'2',points:null}}}};
  const g={answers:{korean:{1:{answer:'2',points:null},2:{answer:'3',points:null},3:{answer:'5',points:null}}}};
  assert.deepEqual(preferGridAnswerKey(p,g).answers.korean,{2:{answer:'3',points:null},3:{answer:'5',points:null},9:{answer:'2',points:null}});
});

test('두 배율이 같은 오인 숫자를 반환해도 분리 문자와 다르면 연결하지 않음', async () => {
  const previous = globalThis.document, image = synthetic();
  const makeCanvas = () => {
    const canvas = { width: image.width, height: image.height };
    canvas.getContext = () => ({ getImageData: () => image, createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, drawImage() {}, fillRect() {} });
    return canvas;
  };
  globalThis.document = { createElement: makeCanvas };
  try {
    for (const [isolated, conf, accept] of [['4', 95, false], ['', 95, false], ['1', 79, false], ['1', NaN, false], ['1', 95, true]]) {
      const parsed = await recognizeAnswerGrid(makeCanvas(), async (crop, options) => {
        if (options.psm === '10') return isolated ? [{ str: isolated, conf }] : [];
        const cy = crop.height * (95 - 83) / 264;
        return [{ str: '1', x0: crop.width * .1, x1: crop.width * .2, y0: cy - 8, y1: cy + 8, conf: 99 }, { str: '1', x0: crop.width * .6, x1: crop.width * .7, y0: cy - 8, y1: cy + 8, conf: 94 }];
      }, { subject: 'english' });
      assert.deepEqual(parsed.answers.english, accept ? { 1: { answer: '1', points: null } } : {});
    }
  } finally { globalThis.document = previous; }
});

test('배점이 있는 네 단 표는 머리글 제외 후 열 우선 번호 검증', () => {
  const width=560,height=500,data=new Uint8ClampedArray(width*height*4).fill(255);
  const ink=(x,y)=>{for(let c=0;c<3;c++)data[(y*width+x)*4+c]=0;};
  for(let x=20;x<=500;x+=40)for(let y=60;y<=460;y++)ink(x,y);
  for(const y of [60,...Array.from({length:13},(_,i)=>100+i*30)])for(let x=20;x<=500;x++)ink(x,y);
  const grid=prepareAnswerGrid({width,height,data});
  assert.ok(grid);assert.equal(grid.stride,3);assert.equal(grid.rows.length,13);assert.equal(grid.top,100);
  const words=[{str:'13',x0:100,x1:130,y0:5,y1:20,conf:99},{str:'4',x0:500,x1:530,y0:5,y1:20,conf:99}];
  assert.deepEqual(gridWordAnswers(words,grid,1,800,360,'korean'),{13:'4'});
});

test('현대 수학 공통 22문항처럼 다섯 행인 표도 번호 검증 대상으로 인식', () => {
  const grid=prepareAnswerGrid(synthetic(5));
  assert.ok(grid);assert.equal(grid.rows.length,6);
});

test('형·선택 미확인 합권은 그림 답을 공통 답으로 연결하지 않음', () => {
  const book={subject:'english',docs:{problem:{items:Array.from({length:90},()=>({}))}}};
  assert.equal(answerGridScope(book,{}, {subject:'english'}),null);
  book.docs.problem.items=[{examSection:{selection:'A형'}}];
  assert.equal(answerGridScope(book,{}, {subject:'english'}),null);
  assert.equal(answerGridScope(book,{selection:'A형'},{subject:'english'}),null);
  assert.ok(answerGridScope(book,{selection:'A형'},{subject:'english',selection:'A형'}));
  book.subject='math';book.docs.problem.items=[{examSection:{selection:'미적분',form:'홀'}}];
  assert.equal(answerGridScope(book,{selection:'미적분',form:'홀'},{subject:'math'}),null);
  assert.deepEqual(answerGridScope(book,{selection:'미적분',form:'홀'},{subject:'math'},'홀'),{subject:'math',selection:null,commonOnly:true});
});
