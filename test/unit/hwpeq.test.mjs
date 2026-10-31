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
