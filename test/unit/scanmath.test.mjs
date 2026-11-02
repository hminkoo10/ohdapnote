import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T, toInk, components, lineBands, findFigures, circledMarkers, splitLine, textSymbols, planScan, cropFormula, trimLatex, assembleBlocks, judgeScan } from '../../src/renderer/js/scanmath.js';

const H20 = 20; // 시험에서 쓰는 본문 한글 높이

/** 흰 종이 RGBA 에 검은 네모·고리를 칠함 */
function paper(W, H) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const fill = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  };
  // 두께 2px 테두리 (동그라미 번호 대신)
  const ring = (x0, y0, x1, y1) => {
    fill(x0, y0, x1, y0 + 2);
    fill(x0, y1 - 2, x1, y1);
    fill(x0, y0, x0 + 2, y1);
    fill(x1 - 2, y0, x1, y1);
  };
  return { img: { data, width: W, height: H }, fill, ring };
}

/** OCR 단어 (글자마다 상자) */
const word = (str, x0, y0, x1, y1, conf = 96, symbols = null) => ({
  str,
  x0,
  y0,
  x1,
  y1,
  conf,
  symbols: symbols || [...str].map((ch, i, a) => ({ str: ch, x0: x0 + Math.round(((x1 - x0) * i) / a.length), x1: x0 + Math.round(((x1 - x0) * (i + 1)) / a.length), y0, y1, conf })),
});

/** 덩어리 (components 결과 모양) */
let nextId = 0;
const comp = (x0, y0, x1, y1, n = null) => ({ id: nextId++, x0, y0, x1, y1, n: n ?? (x1 - x0) * (y1 - y0), chroma: 0 });

// ---------------------------------------------------------------------------
test('lineBands: 분수의 분자·가로선·분모는 한 줄, 영역 경계(cuts)는 넘지 않음, 떨어진 첨자는 가까운 줄로', () => {
  const boxes = [
    { y0: 10, y1: 30 }, // 1줄
    { y0: 50, y1: 60 }, // 분자
    { y0: 63, y1: 65 }, // 가로선
    { y0: 68, y1: 78 }, // 분모
    { y0: 110, y1: 130 }, // 3줄
    { y0: 133, y1: 140 }, // 3줄 아래 따로 떨어진 아래첨자 (얇은 띠)
  ];
  assert.deepEqual(lineBands(boxes, 200, H20), [
    { y0: 10, y1: 30 },
    { y0: 50, y1: 78 },
    { y0: 110, y1: 140 },
  ]);
  // 3줄과 첨자 사이가 영역 경계면 따로
  const cut = lineBands(boxes, 200, H20, [131]);
  assert.equal(cut.length, 4);
  assert.deepEqual(cut[3], { y0: 133, y1: 140 });
});

test('components + findFigures: 큰 그래프는 그림, 붙은 이름표는 흡수, 떨어진 글·긴 줄 하나는 그림이 아님', () => {
  const { img, fill } = paper(400, 200);
  fill(100, 50, 300, 52); // x 축
  fill(200, 20, 202, 150); // y 축 (x 축과 이어져 덩어리 하나)
  fill(304, 40, 310, 50); // 축 끝 이름표 (x 축 바로 옆)
  fill(20, 160, 38, 180); // 멀리 떨어진 글자
  fill(10, 10, 13, 190); // 세로줄 하나 (폭이 좁음)
  const { ink, chroma } = toInk(img);
  const { comps } = components(ink, 400, 200, chroma);
  assert.equal(comps.length, 4);
  const figs = findFigures(comps, H20);
  assert.equal(figs.length, 1);
  assert.deepEqual(figs[0].box, { x0: 100, y0: 20, x1: 310, y1: 150 });
  assert.equal(figs[0].comps.size, 2);
  // 글로 읽은 덩어리는 그림 옆에 있어도 흡수하지 않음
  const label = comps.find((c) => c.x0 === 304);
  const figs2 = findFigures(comps, H20, { isText: (c) => c === label });
  assert.equal(figs2[0].comps.size, 1);
});

test('circledMarkers: 숫자를 품은 고리만 (속이 찬 네모·빈 고리는 아님)', () => {
  const ring = comp(10, 10, 30, 30, 144);
  const digit = comp(17, 15, 23, 25);
  const solid = comp(50, 10, 70, 30);
  const emptyRing = comp(90, 10, 110, 30, 144);
  const inner = new Map();
  const marks = circledMarkers([ring, digit, solid, emptyRing], H20, inner);
  assert.deepEqual([...marks], [ring.id]);
  assert.deepEqual(inner.get(ring.id), [digit.id]);
});

test('splitLine: 글 사이 잉크를 수식 상자로 — 글이 끼거나 많이 벌어지면 따로, 가까우면 하나로', () => {
  const texts = [
    { str: '함수', kind: 'hangul', x0: 20, x1: 58, y0: 20, y1: 40, n: 2 },
    { str: '와', kind: 'hangul', x0: 120, x1: 138, y0: 20, y1: 40, n: 1 },
  ];
  const cs = [
    comp(20, 20, 38, 40), // 함
    comp(40, 20, 58, 40), // 수
    comp(70, 24, 80, 40), // 수식 1
    comp(84, 24, 94, 40),
    comp(120, 20, 138, 40), // 와
    comp(150, 24, 160, 40), // 수식 2 (가까운 조각 둘)
    comp(190, 24, 200, 40),
    comp(280, 24, 290, 40), // 수식 3 (3h 넘게 떨어짐)
  ];
  const { tokens } = splitLine(cs, texts, H20);
  assert.deepEqual(
    tokens.map((t) => (t.t === 'text' ? t.s : [t.box.x0, t.box.x1])),
    ['함수', [70, 94], '와', [150, 200], [280, 290]],
  );
});

test('splitLine: 한글 상자가 덮은 위첨자(x²의)는 수식으로 돌려 놓음', () => {
  const texts = [{ str: '의', kind: 'hangul', x0: 111, x1: 134, y0: 20, y1: 40, n: 1 }];
  const x = comp(100, 28, 110, 40);
  const sup = comp(111, 18, 116, 27); // ² — 의 상자 왼쪽 끝 위
  const cs = [x, sup, comp(119, 22, 128, 38), comp(130, 20, 133, 40)];
  const { tokens } = splitLine(cs, texts, H20);
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].t, 'math');
  assert.deepEqual(tokens[0].comps.sort(), [x.id, sup.id].sort());
  assert.deepEqual(tokens[1], { t: 'text', s: '의', x0: 111, x1: 134 });
});

test('textSymbols: 확신도 높은 한글만 글로, 수식과 섞인 단어는 한글 글자만, 넓은 단어 상자는 다른 번 읽기에 맞춤', () => {
  const passes = [
    {
      words: [
        word('함수', 20, 20, 58, 40),
        // "f(x)의" — 수식 부분은 확신도가 낮음
        word('f(x)의', 70, 20, 128, 40, 60, [
          { str: 'f', x0: 70, x1: 80, y0: 20, y1: 40, conf: 50 },
          { str: '(', x0: 82, x1: 86, y0: 18, y1: 42, conf: 40 },
          { str: 'x', x0: 88, x1: 98, y0: 28, y1: 40, conf: 50 },
          { str: ')', x0: 100, x1: 104, y0: 18, y1: 42, conf: 40 },
          { str: '의', x0: 110, x1: 128, y0: 20, y1: 40, conf: 95 },
        ]),
        word('값', 140, 20, 260, 40), // 뒤 수식까지 덮은 넓은 상자
        word('금', 300, 10, 318, 50, 70), // 분수를 한글로 잘못 읽음 (키가 h 의 두 배, 확신도 낮음)
      ],
    },
    { words: [word('값', 140, 20, 160, 40)], kor: true },
  ];
  const out = textSymbols(passes, H20);
  assert.deepEqual(
    out.map((s) => [s.str, s.x0, s.x1]),
    [
      ['함수', 20, 58],
      ['의', 110, 128],
      ['값', 140, 160],
    ],
  );
});

// ---------------------------------------------------------------------------
/** 문항 하나: 글 + 수식 한 줄, 보기 한 줄, 그래프 하나 */
function sampleItem() {
  const W = 600;
  const H = 260;
  const { img, fill, ring } = paper(W, H);
  // 1줄: 함수 f(x)의 값을 구하시오.
  const glyph = (x) => fill(x, 20, x + 18, 40);
  [20, 40].forEach(glyph); // 함수
  fill(70, 20, 80, 40); // f
  fill(82, 18, 85, 42); // (
  fill(88, 28, 97, 40); // x
  fill(99, 18, 102, 42); // )
  [110, 140, 160, 190, 210, 230, 250].forEach(glyph); // 의 값을 구하시오
  fill(270, 36, 273, 39); // .
  // 2줄: ① 1   ② 2
  ring(20, 70, 40, 90);
  fill(27, 75, 33, 85);
  fill(50, 72, 56, 88);
  ring(200, 70, 220, 90);
  fill(207, 75, 213, 85);
  fill(230, 72, 238, 88);
  // 그래프 (축 두 개 + 이름표)
  fill(300, 170, 500, 172);
  fill(400, 120, 402, 220);
  fill(505, 160, 511, 170);
  const s = (str, x0, conf = 97) => ({ str, x0, x1: x0 + 18, y0: 20, y1: 40, conf });
  const passes = [
    {
      words: [
        word('함수', 20, 20, 58, 40, 96, [s('함', 20), s('수', 40)]),
        word('f(x)의', 70, 18, 128, 42, 55, [
          { str: 'f', x0: 70, x1: 80, y0: 20, y1: 40, conf: 50 },
          { str: '(', x0: 82, x1: 85, y0: 18, y1: 42, conf: 40 },
          { str: 'x', x0: 88, x1: 97, y0: 28, y1: 40, conf: 50 },
          { str: ')', x0: 99, x1: 102, y0: 18, y1: 42, conf: 40 },
          s('의', 110),
        ]),
        word('값을', 140, 20, 178, 40, 96, [s('값', 140), s('을', 160)]),
        word('구하시오.', 190, 20, 273, 40, 96, [s('구', 190), s('하', 210), s('시', 230), s('오', 250), { str: '.', x0: 270, x1: 273, y0: 36, y1: 39, conf: 95 }]),
      ],
    },
  ];
  return { img, passes, W, H };
}

test('planScan + assembleBlocks: 글·수식 상자, 동그라미 번호 보기, 그림을 블록으로', () => {
  const { img, passes, W, H } = sampleItem();
  const plan = planScan(img, passes, { number: '0123' });
  assert.equal(plan.h, 20);
  assert.equal(plan.lines.length, 2);
  const [l1, l2] = plan.lines;
  assert.equal(l1.kind, 'text');
  assert.deepEqual(
    l1.tokens.map((t) => (t.t === 'text' ? t.s : `#${t.f}`)),
    ['함수', '#0', '의 값을 구하시오.'],
  );
  assert.deepEqual(plan.formulas[0].box, { x0: 70, y0: 18, x1: 102, y1: 42 });
  assert.equal(l2.kind, 'choice');
  assert.equal(l2.items.length, 2);
  assert.equal(plan.figures.length, 1);
  const fb = plan.figures[0].box;
  assert.ok(fb.x0 <= 300 && fb.x1 >= 511 && fb.y0 <= 120 && fb.y1 >= 220, JSON.stringify(fb));

  // 수식 그림: 상자 + 여백, 다른 덩어리는 지워짐
  const crop = cropFormula(img, plan, plan.formulas[0]);
  const pad = Math.max(4, Math.round(T.pad * plan.h));
  assert.equal(crop.width, 102 - 70 + 4 + 2 * pad);
  assert.equal(crop.height, 42 - 18 + 4 + 2 * pad);

  const latex = ['f(x)', '1', '2'];
  const blocks = assembleBlocks(plan, (i) => latex[i]);
  assert.deepEqual(blocks.slice(0, 2), [
    { type: 'para', text: '함수 $f(x)$의 값을 구하시오.' },
    { type: 'choices', items: ['$1$', '$2$'] },
  ]);
  assert.equal(blocks[2].type, 'figure');
  const b = blocks[2].box;
  assert.ok(Math.abs(b.x - fb.x0 / W) < 1e-9 && Math.abs(b.h - (fb.y1 - fb.y0) / H) < 1e-9);
});

test('planScan: 첫 줄의 문항 번호는 뺌', () => {
  const { img, fill } = paper(300, 60);
  fill(5, 20, 15, 40);
  fill(17, 20, 27, 40);
  fill(29, 20, 39, 40); // "0123" (세 덩어리로)
  [60, 80].forEach((x) => fill(x, 20, x + 18, 40)); // 함수
  const passes = [{ words: [word('0123', 5, 20, 39, 40, 90), word('함수', 60, 20, 98, 40, 96)] }];
  passes[0].words[1].symbols.push({ str: '함', x0: 60, x1: 78, y0: 20, y1: 40, conf: 97 });
  const plan = planScan(img, passes, { number: '0123' });
  assert.deepEqual(plan.formulas, []);
  assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'para', text: '함수' }]);
});

test('planScan: 한 자리 번호는 줄 맨 앞일 때만 뺌 (본문의 같은 숫자는 수식으로 남김)', () => {
  const { img, fill } = paper(300, 60);
  fill(5, 20, 13, 40); // 번호 "7"
  [40, 60].forEach((x) => fill(x, 20, x + 18, 40)); // 함수
  fill(90, 22, 98, 40); // 본문의 "7"
  const passes = [{ words: [word('7', 5, 20, 13, 40, 90), word('함수', 40, 20, 78, 40, 96), word('7', 90, 22, 98, 40, 90)] }];
  const plan = planScan(img, passes, { number: '7' });
  assert.deepEqual(plan.formulas.map((f) => [f.box.x0, f.box.x1]), [[90, 98]]);
});

// ---------------------------------------------------------------------------
test('trimLatex: 짝 없는 괄호·끝 쉼표는 수식 밖 글로', () => {
  assert.deepEqual(trimLatex('a>0)'), { before: '', latex: 'a>0', after: ')' });
  assert.deepEqual(trimLatex('x=1,'), { before: '', latex: 'x=1', after: ',' });
  assert.deepEqual(trimLatex('(a+b'), { before: '(', latex: 'a+b', after: '' });
  assert.deepEqual(trimLatex('\\left(x\\right)'), { before: '', latex: '\\left(x\\right)', after: '' });
  assert.deepEqual(trimLatex('f(x)'), { before: '', latex: 'f(x)', after: '' });
});

/** 손으로 만든 계획 (줄마다 토큰) */
function handPlan(lines, figures = []) {
  return {
    W: 600,
    H: 400,
    h: H20,
    figures,
    lines: lines.map(([y, tokens, extra = {}]) => {
      const xs = tokens.map((t) => (t.t === 'math' ? t.box : t));
      return { kind: 'text', y0: y, y1: y + 20, x0: Math.min(...xs.map((b) => b.x0)), x1: Math.max(...xs.map((b) => b.x1)), seg: 0, tokens, ...extra };
    }),
  };
}
const tx = (s, x0, x1) => ({ t: 'text', s, x0, x1 });
const mt = (f, x0, x1) => ({ t: 'math', f, box: { x0, x1, y0: 0, y1: 20 } });

test('assembleBlocks: 줄바꿈 잇기와 문단 나누기 ((단, …) · ㄱ. · 짧은 줄 · 그림)', () => {
  const plan = handPlan([
    [10, [tx('다음 조건을 만족시키는 함수를 구하', 10, 590)]], // 꽉 찬 줄 → 다음 줄과 이어서 (글자 사이라 붙여서)
    [40, [tx('시오.', 10, 60)]], // 짧은 줄 → 문단 끝
    [70, [tx('수열', 10, 50), mt(0, 60, 300), tx('의 첫째항', 302, 590)]],
    [100, [tx('은', 10, 30), mt(1, 40, 80), tx('이다.', 82, 130)]],
    [130, [tx('(단, ', 10, 60), mt(2, 62, 120), tx(')', 122, 130)]],
    [160, [tx('ㄱ. 참이다.', 10, 590)]],
    [190, [tx('ㄴ. 거짓', 10, 590)]],
  ], [{ box: { x0: 100, y0: 250, x1: 300, y1: 350 } }]);
  const latex = ['\\{a_{n}\\}', '3', 'a>0'];
  assert.deepEqual(assembleBlocks(plan, (i) => latex[i]), [
    { type: 'para', text: '다음 조건을 만족시키는 함수를 구하시오.' },
    { type: 'para', text: '수열 $\\{a_{n}\\}$의 첫째항은 $3$이다.' },
    { type: 'para', text: '(단, $a>0$)' },
    { type: 'para', text: 'ㄱ. 참이다.' },
    { type: 'para', text: 'ㄴ. 거짓' },
    { type: 'figure', box: { x: 100 / 600, y: 250 / 400, w: 200 / 600, h: 100 / 400 } },
  ]);
});

test('assembleBlocks: 옆에 놓인 그림은 문장을 끊지 않고 그 문단 뒤에', () => {
  // 그림(오른쪽)의 아래끝이 두 줄 사이 — 첫 줄은 그림 앞까지 꽉 차서 다음 줄과 이어짐
  const plan = handPlan([
    [10, [tx('오른쪽 그림과 같을 때, 상수의 값을', 10, 390)]],
    [40, [tx('구하시오.', 10, 100)]],
  ], [{ box: { x0: 400, y0: 0, x1: 590, y1: 45 } }]);
  const blocks = assembleBlocks(plan, () => '');
  assert.deepEqual(blocks.map((b) => b.type), ['para', 'figure']);
  assert.equal(blocks[0].text, '오른쪽 그림과 같을 때, 상수의 값을 구하시오.');
});

test('assembleBlocks: 못 읽은 수식은 빠지고, 짝 없는 괄호는 글로', () => {
  const plan = handPlan([[10, [tx('(단,', 10, 50), mt(0, 60, 200)]]]);
  assert.deepEqual(assembleBlocks(plan, () => 'a>0)'), [{ type: 'para', text: '(단, $a>0$)' }]);
  assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'para', text: '(단,' }]);
});

// ---------------------------------------------------------------------------
test('judgeScan: 확신도 낮음 · 찌꺼기 · 한글 OCR 확신도 → 까닭, 멀쩡하면 빈 배열', () => {
  const f = (w = 100, hh = 20) => ({ box: { x0: 0, y0: 0, x1: w, y1: hh } });
  const plan = (n, extra = {}) => ({ h: H20, formulas: Array.from({ length: n }, () => f()), textConf: 95, ...extra });
  const ok = { latex: 'x', conf: { mean: 0.99, min: 0.9, n: 3 } };
  assert.deepEqual(judgeScan(plan(1), [ok], ['x^{2}']), []);
  assert.deepEqual(judgeScan(plan(1), [{ ...ok, conf: { mean: T.confMean - 0.01, min: 0.9, n: 3 } }], ['x']), ['수식 1: 확신도 낮음']);
  assert.deepEqual(judgeScan(plan(1), [{ ...ok, conf: { mean: 0.99, min: T.confMin - 0.01, n: 3 } }], ['x']), ['수식 1: 확신도 낮음']);
  assert.deepEqual(judgeScan(plan(1), [null], ['']), ['수식 1: 인식 오류']);
  assert.deepEqual(judgeScan(plan(1), [ok], ['']), ['수식 1: 읽은 것이 없음']);
  assert.deepEqual(judgeScan(plan(1), [ok], [Array.from({ length: 20 }, (_, i) => `x_{${i}}`).join('+')]), ['수식 1: 너무 긺']);
  assert.deepEqual(judgeScan(plan(1), [ok], ['\\begin{matrix}a\\end{matrix}']), ['수식 1: 행렬 찌꺼기']);
  assert.deepEqual(judgeScan(plan(1), [ok], ['\\frac{1}{2']), ['수식 1: 괄호 짝이 안 맞음']);
  for (const junk of ['\\mathsf{L}', '\\sharp', '*', '\\Uparrow']) assert.deepEqual(judgeScan(plan(1), [ok], [junk]), ['수식 1: 이상한 기호'], junk);
  for (const fine of ['\\pi', 'x', '\\{a_{n}\\}', '\\sqrt{2}']) assert.deepEqual(judgeScan(plan(1), [ok], [fine]), [], fine);
  assert.deepEqual(judgeScan(plan(1), [ok], ['\\log_{x-1}(-x^{2}+6x-5)7(-x^{2}+6x-5)7(-x^{2}+6x-5)']), ['수식 1: 같은 것 되풀이']);
  for (const bad of ['\\log_{5}-\\log_{3}1', '3^{\\log,5}', '\\log_{3}5\\cdot\\log_{5}']) assert.deepEqual(judgeScan(plan(1), [ok], [bad]), ['수식 1: 함수 뒤가 비어 있음'], bad);
  for (const fine of ['\\log_{2}(x-1)', '\\sin^{2}x+\\cos x', '\\log 2.54']) assert.deepEqual(judgeScan(plan(1), [ok], [fine]), [], fine);
  assert.deepEqual(judgeScan(plan(0, { textConf: T.textConf - 1 }), [], []), ['한글 OCR 확신도 낮음']);
});
