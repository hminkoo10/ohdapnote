import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { eqToMathML, parseEq, eqToText } from '../../src/renderer/js/hwpeqview.js';
import { latexToHwpEq } from '../../src/renderer/js/hwpeq.js';

// 외부 DOM 없이 태그의 부모·자식·인자 수를 검사합니다. 실제 XML 파싱은 시각 샘플에서도 검사합니다.
function mathTree(script, options) {
  const xml = eqToMathML(script, options);
  const root = { name: 'root', children: [] };
  const stack = [root];
  const allowed = new Set('math mrow mfrac msqrt mroot msub msup msubsup munder mover munderover mtable mtr mtd mo mi mn mtext mspace mstyle mmultiscripts mprescripts'.split(' '));
  const arity = { mfrac: 2, mroot: 2, msub: 2, msup: 2, msubsup: 3, munder: 2, mover: 2, munderover: 3 };
  for (const match of xml.matchAll(/<([^>]+)>/g)) {
    const body = match[1];
    if (body.startsWith('/')) {
      assert.equal(stack.pop().name, body.slice(1), xml);
    } else {
      const name = /^[a-z]+/.exec(body)?.[0];
      assert.ok(allowed.has(name), xml);
      const node = { name, attrs: body.slice(name.length), children: [] };
      stack.at(-1).children.push(node);
      if (!body.endsWith('/')) stack.push(node);
    }
  }
  assert.equal(stack.length, 1, xml);
  const visit = node => {
    if (arity[node.name]) assert.equal(node.children.length, arity[node.name], xml);
    node.children.forEach(visit);
  };
  visit(root);
  return root.children[0];
}

function all(node, type) {
  const result = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.type === type || value.name === type) result.push(value);
    for (const [key, child] of Object.entries(value)) {
      if (key === 'errors') continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(node);
  return result;
}

const structures = [
  ['{a+b} over {c}', 'mfrac'],
  ['a atop b', 'mfrac'],
  ['n choose r', 'mfrac'],
  ['binom {n} {r}', 'mfrac'],
  ['sqrt {x}', 'msqrt'],
  ['root {3} of {x^2}', 'mroot'],
  ['x_1', 'msub'],
  ['x^2', 'msup'],
  ['x_1^2', 'msubsup'],
  ['x sup 2 sub 1', 'msubsup'],
  ['sum from {k=1} to {n} k', 'munderover'],
  ['prod ^n _1 x', 'munderover'],
  ['lim _{x -> 0} {sin x} over x', 'munder'],
  ['int _0 ^1 x', 'msubsup'],
  ['oint from C to D x', 'msubsup'],
  ['x lsub a lsup b', 'mmultiscripts'],
  ['A rel <-> {+2} {-5} B', 'munderover'],
  ['A buildrel -> {f} B', 'mover'],
  ['cases {x^2 & x>=0 # -x & x<0}', 'mtable'],
];
for (const [script, name] of structures) {
  test(`hwpeqview: 구조 ${script}`, () => {
    assert.equal(parseEq(script).error, false);
    assert.ok(all(mathTree(script), name).length, name);
  });
}

test('hwpeqview: 빈 입력·인라인·블록', () => {
  assert.match(eqToMathML(''), /<math [^>]*display="inline"><mrow><\/mrow><\/math>/);
  assert.match(eqToMathML(null, { display: true }), /display="block"/);
  assert.equal(eqToText(undefined), '');
  assert.equal(parseEq('').error, false);
});

test('hwpeqview: 분수의 양쪽 식·중첩·선 없는 분수·조합', () => {
  const tree = parseEq('a+b over c+d');
  const frac = tree.children[0];
  assert.equal(frac.type, 'fraction');
  assert.equal(frac.numerator.children.length, 3);
  assert.equal(frac.denominator.children.length, 3);
  assert.equal(all(mathTree('{{1} over {2}} over {3}'), 'mfrac').length, 2);
  assert.match(eqToMathML('a atop b'), /<mfrac linethickness="0">/);
  assert.equal(all(mathTree('n choose r'), 'mo').length, 2);
  const bigg = mathTree('{a+b} over {a-b} bigg / {x+y} over {x-y}');
  assert.equal(all(bigg, 'mfrac').length, 2);
  assert.equal(all(bigg, 'mfrac').every(n => all(n, 'mfrac').length === 1), true);
  assert.match(eqToMathML('x bigg / y'), /minsize="2em"/);
});

test('hwpeqview: 근호 안과 밖의 첨자·근 지수 순서', () => {
  const tree = mathTree('root {3} of {x^2}');
  const root = all(tree, 'mroot')[0];
  assert.equal(all(root.children[0], 'msup').length, 1);
  assert.equal(all(root.children[1], 'mn').length, 1);
  assert.match(eqToMathML('sqrt {x}^2'), /<msup><msqrt>/);
  assert.equal(all(mathTree('sqrt {sqrt {x}}'), 'msqrt').length, 2);
});

test('hwpeqview: 첨자 순서·중첩·빈 밑', () => {
  assert.equal(eqToMathML('x_1^2'), eqToMathML('x^2_1'));
  assert.equal(eqToMathML('x sub 1 sup 2'), eqToMathML('x_1^2'));
  assert.equal(all(mathTree('x^{a^b}'), 'msup').length, 2);
  assert.equal(all(mathTree('x^a^b^c'), 'msup').length, 3);
  assert.equal(all(mathTree('{}_{n} "C"_{r}'), 'msub').length, 2);
  assert.equal(all(mathTree('_n C_r'), 'msub').length, 2);
  assert.equal(eqToText('x^-2'), 'x^(-2)');
});

test('hwpeqview: 큰 연산자·작은 집합·한계', () => {
  for (const [name, glyph] of Object.entries({ sum: '∑', prod: '∏', coprod: '∐', union: '⋃', inter: '⋂', int: '∫', oint: '∮', dint: '∬', tint: '∭', odint: '∯', otint: '∰' })) {
    assert.ok(eqToMathML(`${name} _a ^b`).includes(glyph));
    assert.equal(eqToMathML(`${name} _a ^b`), eqToMathML(`${name} from a to b`));
    mathTree(`${name} _a ^b`);
  }
  assert.doesNotMatch(eqToMathML('smallunion smallinter smallprod smallsum'), /largeop/);
  assert.equal(eqToText('smallunion smallinter'), '∪∩');
  assert.match(eqToMathML('Lim _{x -> 0}'), /<munder><mi mathvariant="normal">Lim/);
});

test('hwpeqview: 늘어나는 괄호·보이지 않는 한쪽·겹침', () => {
  for (const pair of ['( )', '[ ]', '{ }', 'lbrace rbrace', 'langle rangle', '| |', 'VERT VERT', 'lfloor rfloor', 'lceil rceil']) {
    const [left, right] = pair.split(' ');
    assert.equal(parseEq(`LEFT ${left} {1} over {2} RIGHT ${right}`).error, false, pair);
    assert.match(eqToMathML(`LEFT ${left} x RIGHT ${right}`), /stretchy="true"/);
  }
  assert.equal(all(mathTree('LEFT . x RIGHT |'), 'mo').length, 1);
  assert.equal(all(mathTree('LEFT ( LEFT [ x RIGHT ] RIGHT )'), 'mo').length, 4);
  assert.match(eqToMathML('(x)'), /stretchy="false"/);
});

test('hwpeqview: 행렬·쌓기·정렬·빈 칸·중첩 행렬', () => {
  for (const name of ['matrix', 'pmatrix', 'bmatrix', 'dmatrix', 'pile', 'lpile', 'rpile', 'cases', 'eqalign']) {
    const tree = mathTree(`${name} {a & b # c & d}`);
    assert.equal(all(tree, 'mtr').length, 2);
    assert.equal(all(tree, 'mtd').length, 4);
  }
  assert.match(eqToMathML('lpile {x # y}'), /text-align:left/);
  assert.match(eqToMathML('rpile {x # y}'), /text-align:right/);
  assert.match(eqToMathML('eqalign {x &= 1 # y &= 2}'), /text-align:right[\s\S]*text-align:left/);
  assert.equal(all(mathTree('matrix {& # &}'), 'mtd').length, 4);
  assert.equal(all(mathTree('matrix {matrix {1&2#3&4} & x}'), 'mtable').length, 2);
  assert.equal(all(mathTree('a &= b # c &= d'), 'mtr').length, 2);
  const columns = 'matrix {lcol {a#b} rcol {c#d}}';
  assert.equal(eqToText(columns), 'a\tc\nb\td');
  assert.match(eqToMathML(columns), /text-align:left[\s\S]*text-align:right/);
});

test('hwpeqview: 장식 전체·부정·관계', () => {
  for (const name of ['hat', 'check', 'tilde', 'acute', 'grave', 'dot', 'ddot', 'vec', 'dyad', 'arch']) {
    assert.match(eqToMathML(`${name} {AB}`), /<mover accent="true">/);
    mathTree(`${name} {AB}`);
  }
  assert.match(eqToMathML('under {AB}'), /border-bottom:0\.065em solid currentColor;padding-bottom:0\.17em/);
  assert.match(eqToMathML('not ='), /<mo>≠<\/mo>/);
  assert.match(eqToMathML('not {in}'), /<mo>∉<\/mo>/);
  assert.match(eqToMathML('not x'), /x̸/);
  assert.doesNotThrow(() => eqToMathML('not constructor'));
});

test('hwpeqview: 윗줄·밑줄은 본체 폭과 글자 크기를 따르고 중첩 구조를 보존', () => {
  for (const [kind, edge] of [['bar', 'top'], ['under', 'bottom']]) {
    for (const body of ['A', '{AB}', 'x', '{z_1}', '{vec {AB}}']) {
      const xml = eqToMathML(`${kind} ${body}`, { sourceMap: true });
      assert.ok(xml.includes(`style="border-${edge}:0.065em solid currentColor;padding-${edge}:0.17em"`));
      assert.doesNotMatch(xml, /[¯‾_]/);
      assert.match(xml, /data-eq-start=/);
      mathTree(`${kind} ${body}`);
    }
  }
  for (const script of ['{bar {AB}} over {2}', 'bar {x}^2', 'x^{bar {AB}}', 'sqrt {bar {AB}}', 'bar {bar x}']) {
    mathTree(script);
    assert.doesNotMatch(eqToMathML(script), /<mo stretchy="true">¯/);
  }
  assert.equal(all(mathTree('bar {z_1}'), 'msub').length, 1);
  assert.equal(all(mathTree('bar {AB} = vec {AB}'), 'mover').length, 1);
});

test('hwpeqview: 그리스 문자 전체·대소문자와 화살표 예외', () => {
  const names = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(' ');
  const chars = [...'αβγδεζηθικλμνξοπρστυφχψω'];
  names.forEach((name, i) => {
    assert.equal(eqToText(name), chars[i]);
    assert.equal(eqToText(name.toUpperCase()), chars[i].toUpperCase());
    assert.equal(eqToText(name[0].toUpperCase() + name.slice(1)), chars[i].toUpperCase());
  });
  assert.equal(eqToText('larrow LARROW rarrow RARROW lrarrow LRARROW vert VERT'), '←⇐→⇒↔⇔|‖');
  assert.equal(eqToText('vartheta varpi varsigma varphi varepsilon'), 'ϑϖςϕϵ');
  assert.equal(eqToMathML('SQRT {x}'), eqToMathML('sqrt {x}'));
  assert.notEqual(eqToMathML('sin x'), eqToMathML('SIN x'));
  assert.equal(eqToText('DEG deg'), '°deg');
});

test('hwpeqview: 관계·집합·논리·연산 기호', () => {
  const script = 'times div cdot +- -+ <= >= != == in notin owns subset supset subseteq supseteq cup cap emptyset forall exist lnot therefore because inf partial nabla prime DEG';
  assert.equal(eqToText(script), '×÷⋅±∓≤≥≠≡∈∉∋⊂⊃⊆⊇∪∩∅∀∃¬∴∵∞∂∇′°');
  assert.equal(eqToText('-> <- <-> => <=>'), '→←↔⇒⇔');
  assert.equal(eqToText('aleph hbar liter wp imag angstrom mho'), 'ℵℏℓ℘ℑÅ℧');
  assert.equal(eqToText('sqsubset sqsupset sqsubseteq sqsupseteq'), '⊏⊐⊑⊒');
});

test('hwpeqview: 함수·글꼴 전환과 묶음 범위·굵은 숫자', () => {
  for (const name of 'sin cos tan cot sec csc cosec arcsin arccos arctan arc sinh cosh tanh coth log ln lg exp Exp max min det gcd mod if for and hom ker deg arg dim Pr or'.split(' ')) {
    assert.match(eqToMathML(name), new RegExp(`<mi mathvariant="normal">${name}</mi>`));
  }
  assert.match(eqToMathML('rm AB'), /font-style:normal/);
  assert.match(eqToMathML('rm x it y'), /font-style:normal[\s\S]*font-style:italic/);
  assert.match(eqToMathML('bold x'), /font-style:italic;font-weight:bold/);
  assert.match(eqToMathML('rmbold x'), /font-style:normal;font-weight:bold/);
  assert.match(eqToMathML('bold 12'), /<mn style="font-weight:bold">12/);
  assert.match(eqToMathML('{rm x} y'), /<\/mrow><mi>y<\/mi>/);
  assert.equal(eqToMathML('\\ x'), eqToMathML('rm x'));
});

test('hwpeqview: 공백·따옴표·한글·색·크기', () => {
  assert.match(eqToMathML('x~y`z'), /width="0.5em"[\s\S]*width="0.125em"/);
  assert.match(eqToMathML('"단, x > 0"'), /<mtext style="white-space:pre">단, x &gt; 0<\/mtext>/);
  assert.match(eqToMathML('"a   b"'), /white-space:pre">a   b/);
  assert.match(eqToMathML('넓이'), /<mtext>넓이<\/mtext>/);
  assert.match(eqToMathML('COLOR {255,0,12}{x}'), /style="color:rgb\(255,0,12\)"/);
  assert.match(eqToMathML('size 12 {x}'), /font-size:12pt/);
  assert.match(eqToMathML('scale 150 {x}'), /font-size:150%/);
  assert.equal(eqToText('color {1,2,3}{x}'), 'x');
});

test('hwpeqview: XML·속성·제어 문자·프로토타입 이름은 실행 내용으로 새지 않음', () => {
  const scripts = ['"<script>alert(1)</script>"', '<script>', '"</mtext><img src=x onerror=alert(1)>"', '"& < > \'"', 'color {1,2,999}{x}', 'size "12; background:url(x)" {x}', 'constructor', 'toString', '__proto__', 'not constructor', '"\u0000\ud800\uffff"'];
  for (const script of scripts) {
    const xml = eqToMathML(script);
    assert.doesNotMatch(xml, /<(?:script|img|iframe|svg)\b|\u0000|\ud800|\uffff/);
    assert.doesNotMatch(xml, /style="[^"]*(?:url\(|background|999)/);
    mathTree(script);
  }
  assert.match(eqToMathML('"& < > \'"'), /&amp; &lt; &gt; &apos;/);
  assert.match(eqToMathML('"<script>"'), /&lt;script&gt;/);
});

test('hwpeqview: 불완전 입력 복구와 진단·모르는 명령 보존', () => {
  for (const script of ['{x', '(x]', 'x}', 'LEFT ( x', 'RIGHT )', 'sqrt', 'root 3 x', 'x^', 'matrix {1#2', 'matrix', '"끝나지 않은 글', 'color {999,0,0} x', 'size -1 x', 'longdiv x']) {
    assert.doesNotThrow(() => mathTree(script), script);
    const tree = parseEq(script);
    assert.equal(tree.error, true, script);
    assert.ok(tree.errors.some(error => error.severity === 'error'), script);
  }
  for (const script of ['{x', '(x]', 'x}', 'LEFT ( x', '"끝나지 않은 글']) assert.equal(eqToText(script), script);
  const unknown = parseEq('mystery {x}');
  assert.equal(unknown.children[0].unknown, true);
  assert.equal(unknown.error, false);
  assert.deepEqual(unknown.errors, []);
  assert.equal(eqToText('mystery {x}'), 'mysteryx');
});

function checkPositions(script) {
  const tree = parseEq(script);
  assert.equal(tree.start, 0);
  assert.equal(tree.end, script.length);
  const visit = (node, parent) => {
    if (!node || typeof node !== 'object' || !node.type) return;
    assert.ok(Number.isInteger(node.start) && Number.isInteger(node.end), JSON.stringify(node));
    assert.ok(node.start >= parent.start && node.end <= parent.end && node.start <= node.end, `${script}: ${JSON.stringify(node)}`);
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) visit(child, node);
    }
  };
  visit(tree, tree);
  return tree;
}

test('hwpeqview: 모든 노드의 UTF-16 위치·빈 칸·첨자 범위', () => {
  for (const script of ['  {한글😀} over {x_2}  ', 'matrix {a & # & z}', 'x^a^b^c^d', 'matrix {lcol {a#b} rcol {c#d}}', 'root {3} of {x}', 'COLOR {1,2,3}{x}', 'a + (x]']) checkPositions(script);
  const script = '  sqrt {x+1} ';
  const root = all(checkPositions(script), 'root')[0];
  assert.equal(script.slice(root.start, root.end), 'sqrt {x+1}');
  assert.equal(script.slice(root.body.start, root.body.end), '{x+1}');
});

test('hwpeqview: 평문은 분수·근호·첨자·행렬 의미를 남김', () => {
  const cases = [
    ['{1} over {2}', '1/2'], ['sqrt {x}', '√x'], ['sqrt {a+b}', '√(a+b)'],
    ['a+b over c+d', '(a+b)/(c+d)'], ['x_1^2', 'x_1^2'], ['sin x', 'sin x'],
    ['bar {AB}', 'bar(AB)'], ['a atop b', '(a atop b)'], ['n choose r', '(n choose r)'],
    ['pmatrix {1&2#3&4}', '(1\t2\n3\t4)'], ['"넓이"~x', '넓이 x'],
  ];
  for (const [script, expected] of cases) assert.equal(eqToText(script), expected, script);
});

test('hwpeqview: 깊은 입력·깨진 입력을 반복해도 중단하지 않음', () => {
  for (const script of ['{'.repeat(2000) + 'x' + '}'.repeat(2000), 'sqrt '.repeat(1000) + 'x', 'x' + '^x'.repeat(1000), 'a over '.repeat(1000) + 'b', 'sqrt ' + 'rm '.repeat(1000) + 'x']) {
    assert.doesNotThrow(() => eqToMathML(script));
    assert.doesNotThrow(() => eqToText(script));
    assert.ok(parseEq(script).errors.some(error => error.code === 'depth-limit'));
  }
  let seed = 27;
  const words = ['{', '}', '[', '(', ')', ']', '#', '&', 'root', 'of', 'sqrt', 'over', 'matrix', 'left', 'right', '.', 'x', '_', '^', '"', 'color', 'rm'];
  for (let i = 0; i < 250; i++) {
    const script = Array.from({ length: 20 }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return words[seed % words.length];
    }).join(' ');
    assert.doesNotThrow(() => mathTree(script), script);
    checkPositions(script);
  }
});

test('hwpeqview: 기존 변환기의 모든 LaTeX·실측 예시를 다시 그릴 수 있음', () => {
  // 기존 시험 파일은 바꾸지 않고 두 데이터 배열만 읽습니다. 테스트 본문은 실행하지 않습니다.
  const source = readFileSync(new URL('./hwpeq.test.mjs', import.meta.url), 'utf8');
  let count = 0;
  for (const name of ['cases', 'MEASURED']) {
    const match = new RegExp(`const ${name} = (\\[[\\s\\S]*?\\n\\]);`).exec(source);
    assert.ok(match, name);
    const fixtures = runInNewContext(`(${match[1]})`, Object.create(null), { timeout: 1000 });
    for (const [latex] of fixtures) {
      const script = latexToHwpEq(latex);
      assert.equal(parseEq(script).error, false, `${latex} → ${script}`);
      mathTree(script);
      checkPositions(script);
      assert.equal(typeof eqToText(script), 'string');
      count++;
    }
  }
  assert.ok(count >= 120, `예시 ${count}개`);
});

test('hwpeqview: 변수 묶음은 보존하고 가까운 명령 오타만 경고', () => {
  for (const script of ['dx', 'dy', 'ab', 'xy', 'abc', 'pq', 'Ab', 'nPr', 'AB', 'ABC', "A'B", 'overline {PQ}', 'bar {x}',
    'int _{0} ^{1} f(x) dx', 'dy over dx', '2ab + xy', 'pq + qr',
    'bar {AB}', 'vec {AB}', "AB'C", 'hat {x}', '{{a} over {b}}', 'fraq', 'unknownword']) {
    assert.deepEqual(parseEq(script).errors, [], script);
  }
  for (const script of ['sqr {x}', 'ovr', 'sqtr', 'ovre', 'matirx', 'lmi', 'SQR {x}', 'sqqrt', 'sqat', 'alhpa']) {
    assert.ok(parseEq(script).errors.some(e => e.code === 'unknown-word' && e.severity === 'warning'), script);
  }
});
