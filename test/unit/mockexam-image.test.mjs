import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareAnswerGrid, gridWordAnswers, recognizeAnswerGrid, preferGridAnswerKey } from '../../src/renderer/js/mockexam-image.js';
function synthetic() {
  const width = 460, height = 400, data = new Uint8ClampedArray(width * height * 4).fill(255);
  const ink = (x, y) => { const k = (y * width + x) * 4; data[k] = data[k + 1] = data[k + 2] = 0; };
  for (let x = 20; x <= 420; x += 40) for (let y = 80; y <= 350; y++) ink(x, y);
  for (let y = 80; y <= 350; y += 30) for (let x = 20; x <= 420; x++) ink(x, y);
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
