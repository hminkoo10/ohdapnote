import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latexToHwpEq, convertLatex } from '../../src/renderer/js/hwpeq.js';

const cases = [
  // 분수 (다른 것과 이어지면 분수 전체를 묶음)
  ['\\frac{a}{b}', '{a} over {b}'],
  ['\\dfrac{a+b}{c}', '{a+b} over {c}'],
  ['\\frac12', '{1} over {2}'],
  ['\\frac{\\frac{1}{2}}{3}', '{{1} over {2}} over {3}'],
  ['x+\\frac{1}{2}', 'x+{{1} over {2}}'],
  ['\\frac{1}{1+\\frac{1}{x}}', '{1} over {1+{{1} over {x}}}'],
  // 루트
  ['\\sqrt{x}', 'sqrt {x}'],
  ['\\sqrt[3]{x^{2}}', 'root {3} of {x^{2}}'],
  ['\\sqrt{\\frac{1}{2}}', 'sqrt {{1} over {2}}'],
  ['\\pm\\sqrt{2}', '+- sqrt {2}'],
  // 첨자
  ['x^{2}-2x+1=0', 'x^{2}-2x+1=0'],
  ['x^2', 'x^{2}'],
  ['a_{n+1}=2a_n', 'a_{n+1}=2a_{n}'],
  ['x_1^2', 'x_{1}^{2}'],
  ['2^{10}', '2^{10}'],
  ['{}_{n}\\mathrm{C}_{r}', '{}_{n} "C"_{r}'],
  // 로그·극한·합·적분
  ['\\log_{2} 8', 'log _{2} 8'],
  ['\\log_a b', 'log _{a} b'],
  ['\\lim_{x \\to 0} \\frac{\\sin x}{x}', 'lim _{x -> 0} {{sin x} over {x}}'],
  ['\\lim_{n\\to\\infty}a_n', 'lim _{n -> inf} a_{n}'],
  ['\\sum_{k=1}^{n} a_k', 'sum _{k=1} ^{n} a_{k}'],
  ['\\int_a^b f(x)\\,dx', 'int _{a} ^{b} f(x)`dx'],
  ['\\sin^2 x+\\cos^2 x=1', 'sin ^{2} x+ cos ^{2} x=1'],
  // 괄호
  ['\\left( \\frac{1}{2} \\right)^{2}', '{LEFT ( {1} over {2} RIGHT )}^{2}'],
  ['\\left| x-1 \\right|', 'LEFT | x-1 RIGHT |'],
  ['\\left[ F(x) \\right]_{a}^{b}', '{LEFT [ F(x) RIGHT ]}_{a}^{b}'],
  ['\\{1, 2, 3\\}', 'lbrace 1,2,3 rbrace'],
  ['\\left\\{ x \\mid x > 0 \\right\\}', 'lbrace x|x>0 rbrace'],
  ['\\binom{n}{r}', 'LEFT ( {n} atop {r} RIGHT )'],
  // 기호
  ['3 \\times 4 \\div 2', '3 times 4 div 2'],
  ['a \\cdot b', 'a cdot b'],
  ['1+2+\\cdots+n', '1+2+ cdots +n'],
  ['x \\le 3', 'x<=3'],
  ['x \\leq -1', 'x<= -1'],
  ['x \\geq 0', 'x>=0'],
  ['a \\neq b', 'a!=b'],
  ['a \\ne b', 'a!=b'],
  ['n!=120', 'n! =120'],
  ['\\alpha+\\beta=\\pi', 'alpha + beta = pi'],
  ['\\theta', 'theta'],
  ['\\Delta', 'DELTA'],
  ['\\infty', 'inf'],
  ['x \\to 1', 'x -> 1'],
  ['\\overline{AB}', 'bar {AB}'],
  ['\\vec{a}\\cdot\\vec{b}', 'vec {a} cdot vec {b}'],
  ['\\angle ABC = 90^\\circ', 'angle ABC= 90 DEG'],
  ['\\triangle ABC', 'triangle ABC'],
  ['\\therefore x=1', 'therefore x=1'],
  ['\\because a>0', 'because a>0'],
  ['x \\in A \\cup B', 'x in A cup B'],
  ['A \\cap B = \\emptyset', 'A cap B= emptyset'],
  ['A \\subset B', 'A subset B'],
  ["f'(x)", 'f prime (x)'],
  // 띄어쓰기: 한글 수식에서 빈칸은 안 보이므로 ~ `
  ['x\\,y\\quad z', 'x`y~~z'],
  ['a\\ b', 'a~b'],
  // 글자
  ['\\text{(단, }x>0\\text{)}', '"(단, " x>0 ")"'],
  ['넓이', '"넓이"'],
  ['\\text{cm}^2', '"cm"^{2}'],
  // 환경
  ['\\begin{cases} x+1 & (x \\ge 0) \\\\ -x & (x<0) \\end{cases}', 'cases{x+1 & (x>=0) # -x & (x<0)}'],
  ['\\left\\{ \\begin{array}{l} x=1 \\\\ y=2 \\end{array} \\right.', 'cases{x=1 # y=2}'],
  ['\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}', 'pmatrix{1 & 2 # 3 & 4}'],
  ['\\begin{matrix} a & b \\end{matrix}', 'matrix{a & b}'],
  ['\\begin{aligned} a &= b \\\\ &= c \\end{aligned}', 'lpile{a =b # =c}'],
  // 한글 명령과 겹치는 글자 묶음은 띄움 (점 P, I → Π 가 되지 않게)
  ['\\overline{PI}', 'bar {P I}'],
  ['x_{in}', 'x_{i n}'],
  // 모르는 명령·짝이 틀린 괄호: 멈추지 않음
  ['\\foo{x}', 'foo {x}'],
  ['\\frac{1}', '{1} over {}'],
  ['x^', 'x^{}'],
  ['}', ''],
  ['\\mathbb{R}', '{R}'],
];

for (const [latex, want] of cases) {
  test(`hwpeq: ${latex}`, () => {
    assert.equal(latexToHwpEq(latex), want);
  });
}

test('hwpeq: 중괄호 짝이 항상 맞음', () => {
  for (const [latex] of cases) {
    const s = latexToHwpEq(latex);
    let depth = 0;
    for (const ch of s.replace(/"[^"]*"/g, '')) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      assert.ok(depth >= 0, `${latex} → ${s}`);
    }
    assert.equal(depth, 0, `${latex} → ${s}`);
  }
});

test('hwpeq: 크기 — 분수는 한 줄보다 높고, 긴 식은 더 넓음', () => {
  const one = convertLatex('x');
  const frac = convertLatex('\\frac{1}{2}');
  const long = convertLatex('x^{2}+2x+1=0');
  assert.ok(frac.height > one.height * 1.5);
  assert.ok(long.width > one.width * 4);
  for (const r of [one, frac, long]) {
    assert.ok(r.baseLine > 40 && r.baseLine < 100);
    assert.ok(Number.isInteger(r.width) && Number.isInteger(r.height));
  }
  assert.equal(convertLatex('x', { baseUnit: 2000 }).height, one.height * 2);
});

// 한글 2024 에서 수식을 만들어 잰 크기 [LaTeX, 폭, 높이, 기준선 %] (10pt, HWPUNIT)
// 한글은 파일을 열 때 수식 크기를 다시 재지 않으므로, 적어 넣은 폭이 이보다 좁으면 뒤 글자와 겹칩니다.
const MEASURED = [
  ['a > b > 0', 4140, 975, 86],
  ['a, b', 1345, 975, 86],
  ['a^{\\frac{2}{3}} + b^{\\frac{2}{3}} = 2', 5430, 2042, 94],
  ['(x+y)^{\\frac{2}{3}} + (x-y)^{\\frac{2}{3}}', 8695, 2042, 94],
  ['a > 0, b > 0', 5035, 975, 86],
  ['x = a + 3a^{\\frac{1}{3}}b^{\\frac{2}{3}}, \\quad y = b + 3a^{\\frac{2}{3}}b^{\\frac{1}{3}}', 14030, 2054, 93],
  ['\\left(2^{\\frac{9}{4}}\\right)^{2} \\times 2^{\\frac{1}{2}}', 4770, 2209, 94],
  ['\\sqrt{3\\sqrt[3]{3}}', 2740, 1269, 90],
  ['\\sqrt[3]{5\\sqrt{5}}', 2740, 1269, 90],
  ['a < \\sqrt[6]{n} < b', 4850, 1125, 88],
  ['15^{\\frac{1}{6}}', 1765, 2042, 94],
  ['a^{\\frac{1}{6}}b^{\\frac{1}{3}}', 2405, 2042, 94],
  ['V_{2} = V_{1} \\times \\left(\\frac{H_{2}}{H_{1}}\\right)^{\\frac{2}{2-k}}', 9236, 3261, 71],
  ['H_{1} < H_{2}', 3810, 1177, 72],
  ['\\frac{b}{a}', 1025, 2250, 66],
  ['x = \\log_{a} N', 4470, 1177, 72],
  ['\\log 1000', 3525, 975, 86],
  ['4^{2} = 16', 3285, 1163, 89],
  ['\\text{(단, } a > 0 \\text{)}', 4735, 1000, 86],
  ['10 \\text{ cm}', 2450, 1000, 86],
  ['\\text{넓이}', 2100, 975, 86],
  ['x', 600, 975, 86],
  ['t', 375, 975, 86],
  ['A', 825, 975, 86],
  ['-1', 1490, 975, 86],
  ['f(x)', 2090, 975, 86],
  ['2^{n}', 975, 1163, 89],
  ['a_{n}', 975, 1177, 72],
  ['A^{C}', 1425, 1163, 89],
  ['{}_{n}\\mathrm{P}_{r}', 1500, 1177, 72],
  ['\\log_{2} 3 \\times \\log_{3} 4', 5530, 1177, 72],
  ['3^{2x} - 4 \\cdot 3^{x} + 3 = 0', 8525, 1163, 89],
  ['\\left(\\frac{8}{27}\\right)^{-\\frac{1}{3}}', 3713, 2857, 73],
  ['\\sin^{2} \\theta + \\cos^{2} \\theta = 1', 7525, 1163, 89],
  ['2\\sin x - 1 = 0', 5875, 975, 86],
  ['\\sum_{k=1}^{n} (2k-1) = n^{2}', 7350, 2700, 63],
  ['\\lim_{x \\to 2} \\frac{x^{2}-4}{x-2}', 4965, 2588, 65],
  ["f'(x) = 3x^{2} - 2x", 7425, 1163, 89],
  ['\\int_{0}^{2} (3x^{2}+1) \\, dx', 6820, 2586, 62],
  ['P(A|B) = \\frac{1}{3}', 5635, 2250, 66],
  ['\\overline{AB} = 3', 3240, 1170, 89],
  ['\\angle A = 60^{\\circ}', 4995, 975, 86],
  ['A = \\{1, 2, 3\\}', 5655, 975, 86],
  ['|x - 1| + |x + 2| \\le 5', 8460, 975, 86],
  ['-1 < x < 3', 5255, 975, 86],
  ['f(x) = \\begin{cases} x^{2} & (x \\ge 0) \\\\ -x & (x < 0) \\end{cases}', 9040, 2288, 66],
  ['x = \\frac{-b \\pm \\sqrt{b^{2}-4ac}}{2a}', 9200, 2588, 71],
  ['\\sqrt{a\\sqrt{a\\sqrt{a}}}', 4110, 1425, 91],
  ['a_{n} = 2 \\cdot 3^{n-1}', 6031, 1365, 76],
  ['a_{1}, a_{2}, a_{3}, \\cdots', 4860, 1177, 72],
  ['B\\left(100, \\frac{1}{5}\\right)', 4470, 2250, 66],
  ['V(X) = E(X^{2}) - \\{E(X)\\}^{2}', 11425, 1163, 89],
  ['\\vec{a} \\cdot \\vec{b} = 3', 3795, 1170, 89],
  ['\\text{(단, } k \\text{는 상수)}', 6165, 1000, 86],
  ['\\sin A : \\sin B : \\sin C', 7740, 975, 86],
  ['y = \\tan \\left(x - \\frac{\\pi}{4}\\right)', 6825, 2250, 66],
  ['\\log_{\\sqrt{2}} 8', 2966, 1264, 67],
];

test('hwpeq: 크기 — 한글이 잰 폭보다 좁지 않고(겹치지 않게) 지나치게 넓지도 않음', () => {
  for (const [latex, w] of MEASURED) {
    const r = convertLatex(latex);
    assert.ok(r.width >= w, `${latex}: 폭 ${r.width} < 한글 ${w}`);
    assert.ok(r.width <= w * 1.2 + 100, `${latex}: 폭 ${r.width} — 한글 ${w} 보다 너무 넓음`);
  }
});

test('hwpeq: 크기 — 기준선 위는 한글과 거의 같고, 아래는 모자라지 않음(줄이 겹치지 않게)', () => {
  for (const [latex, , h, base] of MEASURED) {
    const r = convertLatex(latex);
    const ascent = (r.height * r.baseLine) / 100;
    const real = (h * base) / 100;
    assert.ok(Math.abs(ascent - real) <= 40, `${latex}: 위 ${ascent} / 한글 ${real}`);
    assert.ok(r.height - ascent >= h - real - 10, `${latex}: 아래 ${r.height - ascent} / 한글 ${h - real}`);
  }
});
