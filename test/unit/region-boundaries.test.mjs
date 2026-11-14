import { test } from 'node:test';
import assert from 'node:assert/strict';
import { residualBoundaries } from '../../src/renderer/js/region-boundaries.js';
import { computeItems } from '../../src/renderer/js/detect.js';
import * as boundaries from '../../src/renderer/js/region-boundaries.js';

function fixture(kind = 'heading') {
  const w = 240, h = 500, data = new Uint8Array(w * h);
  const paint = (x0, y0, x1, y1) => {
    for (let y = Math.round(y0 * h); y < Math.round(y1 * h); y++)
      for (let x = Math.round(x0 * w); x < Math.round(x1 * w); x++) data[y * w + x] = 1;
  };
  const token = (str, x0, x1, y0 = .41, y1 = .43) => ({ str, x0, x1, y0, y1 });
  const anchors = [{ col: 0, x0: .11, x1: .13, y0: .15, y1: .17, h: .02, num: 7, digits: '7' },
    { col: 0, x0: .11, x1: .13, y0: .52, y1: .54, h: .02, num: 2, digits: '2' }];
  paint(.11, .15, .5, .18); paint(.11, .52, .6, .55);
  const page = { index: 0, bodyH: .02, grid: { w, h, data },
    layout: { bodyTop: .1, bodyBottom: .9, columns: [{ x0: .1, x1: .9 }] },
    tokens: [], ocrPasses: [], ranges: [] };
  if (kind === 'range') {
    paint(.11, .4, .8, .42);
    page.ocrPasses = [[token('[', .11, .12, .4, .42), token('73-', .13, .18, .4, .42), token('6]', .19, .22, .4, .42), token('조건', .24, .6, .4, .42)]];
    anchors[1].y0 = .46; anchors[1].y1 = .48;
  } else {
    paint(.11, .4, .89, .402); paint(.11, .4, .114, .44); paint(.886, .4, .89, .44);
    paint(.15, .41, .36, .43);
    page.tokens = [token('47', .15, .19), token('새 주제', .22, .36)];
    page.ranges = [{ col: 0, y0: .46, y1: .48 }];
    paint(.11, .46, .8, .48);
  }
  return { page, anchors, paint };
}
const cuts = f => residualBoundaries(f.page, f.anchors);
test('분리된 범위 머리는 값·순서와 무관하게 앞 문항 경계', () => {
  const f = fixture('range');
  assert.equal(cuts(f)[0]?.kind, 'range-boundary');
  f.page.ocrPasses[0][1].str = '1~'; f.page.ocrPasses[0][2].str = '999]';
  f.anchors.forEach(a => { a.num = 900; a.digits = '900'; });
  assert.equal(cuts(f)[0]?.kind, 'range-boundary');
});
test('같은 공백의 내용 줄은 보존', () => {
  const f = fixture('range'); f.page.ocrPasses[0][0].str = '내용';
  assert.deepEqual(cuts(f), []);
});
test('새 지문 바로 위 얕은 전폭 제목 띠', () => {
  const f = fixture(); assert.equal(cuts(f)[0]?.kind, 'framed-heading');
});
test('같은 공백의 답 상자: 다음 지문 머리 없으면 보존', () => {
  const f = fixture(); f.page.ranges = []; assert.deepEqual(cuts(f), []);
});
test('큰 그림·수식·여러 줄 보기 상자는 보존', () => {
  for (const label of ['그림', '수식', '보기']) {
    const f = fixture(); f.paint(.11, .44, .114, .5); f.paint(.886, .44, .89, .5);
    f.paint(.2, .47, .6, .49); f.page.tokens[1].str = label;
    assert.deepEqual(cuts(f), []);
  }
});
test('긴 답 여백 뒤 본문·선택지 줄은 보존', () => {
  for (const str of ['계산을 계속한다', '① ② ③ ④ ⑤', 'x + y = z']) {
    const f = fixture('range'); f.page.ocrPasses[0] = [{ str, x0: .11, x1: .8, y0: .4, y1: .42 }];
    assert.deepEqual(cuts(f), []);
  }
});
test('문항 번호를 포함한 띠는 자르지 않음', () => {
  const f = fixture(); f.anchors.push({ ...f.anchors[0], y0: .41, y1: .43 });
  assert.deepEqual(cuts(f), []);
});
test('절단 뒤 앞 문항만 줄고 다음 문항은 그대로', () => {
  const f = fixture('range');
  const run = cutters => computeItems([0], new Map([[0, f.anchors]]), new Map([[0, f.page.layout]]), new Map([[0, f.page.grid]]), { cutters });
  const before = run(new Map()), after = run(new Map([[0, cuts(f)]]));
  assert.equal(after.length, before.length);
  assert.ok(after[0].rects[0].y + after[0].rects[0].h < .4);
  assert.deepEqual(after[1], before[1]);
});

test('13c: 숫자 값·역순·폭과 무관한 범위 복원·절단', () => {
  let expected;
  for (const [a, b] of [[5, 8], [15, 10], [3, 4], [1, 999]]) {
    const f = fixture('range');
    f.page.ocrPasses[0][1].str = `${a}~`; f.page.ocrPasses[0][2].str = `${b}]`;
    const [rg] = boundaries.recoveredRanges(f.page, f.anchors);
    assert.equal(rg.a, a); assert.equal(rg.b, b);
    const geometry = { ...rg, a: null, b: null, cuts: cuts(f) };
    if (expected) assert.deepEqual(geometry, expected);
    expected = geometry;
  }
});

test('13c: 반복 호출·위치 중복·저장 범위 불변', () => {
  const f = fixture('range'), original = structuredClone(f.page.ranges);
  f.page.ocrPasses[0][1].str = '5~'; f.page.ocrPasses[0][2].str = '8]';
  const anchors = new Map([[0, f.anchors]]);
  const first = boundaries.rangesForItems([f.page], anchors);
  assert.equal(first.get(0).length, 1);
  assert.deepEqual(boundaries.rangesForItems([f.page], anchors), first);
  assert.deepEqual(f.page.ranges, original);
  const rg = first.get(0)[0];
  for (const existing of [{ ...rg, a: 1, b: 2, y0: .415, y1: .435 },
    { ...rg, y0: .2, y1: .22 }, { ...rg, col: 1 }]) {
    f.page.ranges = [existing];
    const merged = boundaries.rangesForItems([f.page], anchors).get(0);
    assert.equal(merged.length, existing.col === 0 && existing.y0 === .415 ? 1 : 2);
    assert.deepEqual(f.page.ranges, [existing]);
  }
});

test('13c: 복원 범위 아래 문항이 떨어진 지문을 받음', () => {
  const f = fixture('range');
  f.anchors[0].num = 4; f.anchors[0].digits = '4';
  f.anchors[1].num = 5; f.anchors[1].digits = '5';
  f.page.ocrPasses[0][1].str = '5~'; f.page.ocrPasses[0][2].str = '8]';
  const anchors = new Map([[0, f.anchors]]);
  const run = ranges => computeItems([0], anchors, new Map([[0, f.page.layout]]), new Map([[0, f.page.grid]]),
    { cutters: new Map([[0, cuts(f)]]), ranges });
  assert.equal(run(new Map())[1].stem, undefined);
  const after = run(boundaries.rangesForItems([f.page], anchors));
  assert.equal(after[0].stem, undefined);
  assert.equal(after[1].stemLabel, '5~8');
  assert.ok(after[1].stem[0].y < .42);
});

test('13c: 지문 붙이기에는 기존 범위 조건을 통과한 되찾은 머리만 넘김 (지문·비지문 모드)', () => {
  // 앞 지문 [4~8] → 4번 → 되찾은 머리 → 5·6번
  const w = 240, h = 500, data = new Uint8Array(w * h);
  const paint = (x0, y0, x1, y1) => {
    for (let y = Math.round(y0 * h); y < Math.round(y1 * h); y++)
      for (let x = Math.round(x0 * w); x < Math.round(x1 * w); x++) data[y * w + x] = 1;
  };
  const A = (num, y0) => ({ col: 0, x0: .11, x1: .13, y0, y1: y0 + .02, h: .02, num, digits: String(num), conf: 100 });
  const chain = [A(4, .20), A(5, .46), A(6, .60)];
  for (const a of chain) paint(.11, a.y0, .6, a.y1);
  paint(.11, .12, .7, .14); paint(.11, .40, .8, .42);
  const first = { col: 0, a: 4, b: 8, x0: .11, x1: .2, y0: .12, y1: .14 };
  const page = (lo, hi) => ({ index: 0, bodyH: .02, grid: { w, h, data },
    layout: { bodyTop: .1, bodyBottom: .9, columns: [{ x0: .1, x1: .9 }] }, tokens: [], ranges: [first],
    ocrPasses: [[{ str: '[', x0: .11, x1: .12, y0: .40, y1: .42 }, { str: `${lo}~`, x0: .13, x1: .17, y0: .40, y1: .42 },
      { str: `${hi}]`, x0: .18, x1: .21, y0: .40, y1: .42 }, { str: '조건', x0: .24, x1: .6, y0: .40, y1: .42 }]] });
  const anchors = new Map([[0, chain]]);
  const run = (p, ranges, passages) => computeItems([0], anchors, new Map([[0, p.layout]]), new Map([[0, p.grid]]),
    { passages, cutters: new Map([[0, residualBoundaries(p, chain)]]), ranges })
    .map(it => ({ num: it.num, stemLabel: it.stemLabel, stem: it.stem }));
  for (const passages of [true, false]) {
    for (const [lo, hi] of [['9'.repeat(400), 6], [15, 10], [1, 999]]) {
      const p = page(lo, hi);
      assert.equal(boundaries.recoveredRanges(p, chain).length, 1);
      assert.equal(residualBoundaries(p, chain).length, 1);
      assert.deepEqual(run(p, boundaries.rangesForItems([p], anchors), passages), run(p, new Map([[0, [first]]]), passages));
    }
    const p = page(5, 6);
    const after = run(p, boundaries.rangesForItems([p], anchors), passages);
    assert.deepEqual(after.map(it => `${it.num}:${it.stemLabel}`), ['4:4~8', '5:5~6', '6:5~6']);
  }
  assert.equal(boundaries.attachableRange({ a: undefined, b: undefined }), false);
  assert.equal(boundaries.attachableRange({ a: 15, b: 10 }), false);
  assert.equal(boundaries.attachableRange({ a: 1, b: 999 }), false);
  assert.equal(boundaries.attachableRange({ a: 5, b: 8 }), true);
});

test('13c: 읽을 수 없는 숫자도 기하 범위는 유지, 복수 OCR 중복 없음', () => {
  const f = fixture('range');
  f.page.ocrPasses[0][1].str = '9'.repeat(400) + '~';
  f.page.ocrPasses.push(structuredClone(f.page.ocrPasses[0]));
  const [rg] = boundaries.recoveredRanges(f.page, f.anchors);
  assert.equal(Object.hasOwn(rg, 'a'), false);
  assert.equal(Object.hasOwn(rg, 'b'), false);
  assert.equal(boundaries.recoveredRanges(f.page, f.anchors).length, 1);
  assert.equal(cuts(f).length, 1);
});
