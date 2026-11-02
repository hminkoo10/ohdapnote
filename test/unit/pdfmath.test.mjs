import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeParts, decodeGlyph, fontFamily } from '../../src/renderer/js/pdfmath.js';

// 실제 교재 대신 글자 위치를 직접 만든 가짜 쪽으로 시험 (글꼴 이름·코드는 EBS 교재 PDF 의 수식 글꼴 규칙)
// 글자 조각: [글자, 글꼴, 모양, 폭(em)]
const T = (s) => [...s].map((c) => [c, 'YDVYMjOStd', '', c === ' ' ? 0.3 : c === ',' ? 0.35 : 1]); // 본문 글꼴
const M = (s) => [...s].map((c) => [c, 'EHsang', /[A-Za-z]/.test(c) ? 'Italic' : '', /[=+<>-]/.test(c) ? 1 : 0.5]); // 수식(기울임)
const U = (s) => [...s].map((c) => [c, 'EHsang', '', 0.6]); // 똑바른 글자(점 이름)
const SP = (em = 0.3) => [[' ', 'EHsang', '', em]];
const G = (c, fam, w, style = '') => [[c, fam, style, w]];

/** 한 줄: 조각들을 왼쪽부터 이어 놓음 */
function row(base, x, pieces, size = 10) {
  const out = [];
  for (const [c, fam, style, w] of pieces.flat()) {
    out.push({ c, fam, style, x0: x, x1: x + w * size, base, top: base - 0.8 * size, bottom: base + 0.2 * size, size, xem: size, rot: false });
    x += w * size;
  }
  return out;
}

function layer(rows, { lines = [], shapes = [] } = {}) {
  return { w: 600, h: 800, glyphs: rows.flat().map((g, seq) => ({ ...g, seq })), lines, shapes };
}

const whole = (L) => [{ layer: L, rect: { x: 0, y: 0, w: 1, h: 1 }, place: { x: 0, y: 0, w: 1, h: 1 } }];
const run = (L) => transcribeParts(whole(L), { explain: true });

test('글꼴 이름 → 종류·모양', () => {
  assert.deepEqual(fontFamily('ABCDEF+EHsang-Italic'), ['EHsang', 'Italic']);
  assert.deepEqual(fontFamily('EHboNB'), ['EHboNB', '']);
});

test('글자 해독: 첨자·분수 조각·관계 기호', () => {
  assert.deepEqual(decodeGlyph('Û', 'EHsang'), { k: 'sup', v: '2' });
  assert.deepEqual(decodeGlyph(';', 'EHboNB'), { k: 'fr', part: 'bar' });
  assert.deepEqual(decodeGlyph('#', 'EHboNB'), { k: 'fr', part: 'num', v: '3' });
  assert.deepEqual(decodeGlyph('2', 'EHboNB'), { k: 'fr', part: 'den', v: '2' });
  assert.deepEqual(decodeGlyph('É', 'EHyak'), { k: 'm', v: '\\le' });
  assert.equal(decodeGlyph('가', 'YDVYMjOStd').k, 'text');
  assert.equal(decodeGlyph('\u0001', 'EHsang'), null);
});

test('본문 + 줄 안 수식', () => {
  const r = run(layer([row(100, 50, [T('함수 '), M('f(x)'), T('는')])]));
  assert.deepEqual(r, [{ type: 'para', text: '함수 $f(x)$는' }]);
});

test('수식만 있는 줄 → 수식 블록, 붙은 위첨자', () => {
  const r = run(layer([row(100, 50, [M('x'), G('Û', 'EHsang', 0), M('+1=0')])]));
  assert.deepEqual(r, [{ type: 'math', latex: 'x^{2}+1=0' }]);
});

test('분수 글꼴 조각 → \\frac (사이에 다른 글자가 끼어 그려져도)', () => {
  const pieces = [M('x='), G(';', 'EHboNB', 0.2), G('2', 'EHboNB', 0.45), G('#', 'EHboNB', 0), G(';', 'EHboNB', 0.2)];
  const r = run(layer([row(100, 50, pieces)]));
  assert.deepEqual(r, [{ type: 'math', latex: 'x=\\frac{3}{2}' }]);
  // 분자 다음에 상관없는 글자를 하나 그린 뒤 닫는 조각을 그림
  const gl = row(100, 50, pieces);
  const [close] = gl.splice(gl.length - 1, 1);
  const L = layer([gl, row(300, 50, [T('가')]), [close]]);
  assert.equal(run(L)[0].latex, 'x=\\frac{3}{2}');
});

test('분수선(선) 위아래 글자 → \\frac', () => {
  const rows = [row(100, 50, [M('y=')]), row(94, 65.5, [M('1')]), row(107, 65.5, [M('x')])];
  const r = run(layer(rows, { lines: [{ x0: 64, x1: 72, y: 97, lw: 0.4 }] }));
  assert.deepEqual(r, [{ type: 'math', latex: 'y=\\frac{1}{x}' }]);
});

test('보기 ①~⑤ → choices', () => {
  const pieces = [];
  for (let i = 0; i < 5; i++) pieces.push(T('①②③④⑤'[i]), SP(0.3), M(String(i + 1)), SP(6));
  const r = run(layer([row(100, 50, pieces)]));
  assert.deepEqual(r, [{ type: 'choices', items: ['$1$', '$2$', '$3$', '$4$', '$5$'] }]);
});

test('연립 괄호 + 조건 칸, 같은 줄의 두 함수', () => {
  // f(x)={ x (x>0) / -x (x≤0) , g(x)={ 1 (x>0) / 0 (x≤0)
  const brace = (x) => row(100, x, [G('à', 'EHSusic', 0.5)]);
  const rows = [
    row(100, 50, [M('f(x)=')]),
    brace(76),
    row(93, 82, [M('x'), SP(1.5), M('(x>0)')]),
    row(107, 82, [M('-x'), SP(0.5), M('(x'), G('É', 'EHyak', 1), M('0)')]),
    row(100, 150, [T(', '), M('g(x)=')]),
    brace(184),
    row(93, 190, [M('1'), SP(2), M('(x>0)')]),
    row(107, 190, [M('0'), SP(2), M('(x'), G('É', 'EHyak', 1), M('0)')]),
  ];
  const r = run(layer(rows));
  assert.equal(r.length, 1);
  assert.equal(r[0].latex, 'f(x)=\\begin{cases} x & (x>0) \\\\ -x & (x\\le 0) \\end{cases},\\ g(x)=\\begin{cases} 1 & (x>0) \\\\ 0 & (x\\le 0) \\end{cases}');
});

test('윗줄(폭 없는 글자)이 뒤 글자와 같은 자리여도 앞 글자에 붙음, 점 이름은 \\mathrm', () => {
  // 실제 PDF 처럼 윗줄을 먼저 그렸고, 뒤 글자 "는" 이 아주 조금 왼쪽에서 시작
  const rows = row(100, 50, [T('거리 '), U('QH'), G('Ó', 'EHsang', 0), T('는')]);
  rows[rows.length - 1].x0 -= 0.02;
  assert.deepEqual(run(layer([rows])), [{ type: 'para', text: '거리 $\\overline{\\mathrm{QH}}$는' }]);
  const pi = [row(100, 50, [U('P'), G('Õ', 'EHsang', 0), U('I'), G('Õ', 'EHsang', 0), M('=t')])];
  assert.deepEqual(run(layer(pi)), [{ type: 'math', latex: '\\overline{\\mathrm{PI}}=t' }]);
});

test('괄호 안 본문 글꼴 쉼표는 수식 안으로', () => {
  const r = run(layer([row(100, 50, [T('점 '), U('P'), M('(1'), T(', '), M('2)'), T('에서')])]));
  assert.deepEqual(r, [{ type: 'para', text: '점 $\\mathrm{P}(1,\\ 2)$에서' }]);
});

test('줄 끝에서 끊긴 낱말은 붙여 이음 (쪽 안 낱말·조사·수식 뒤)', () => {
  // 첫 줄이 오른쪽 끝까지 차서 다음 줄로 이어지는 문단. 셋째 줄(새 문단)에 "그래프를" 이 있음
  const word = layer([row(100, 50, [T('가나다라마바사 그래')]), row(120, 50, [T('프는 '), M('x'), T('축')]), row(150, 80, [T('그래프를 본다')])]);
  assert.deepEqual(run(word), [
    { type: 'para', text: '가나다라마바사 그래프는 $x$축' },
    { type: 'para', text: '그래프를 본다' },
  ]);
  // 같은 말이 쪽에 없으면 띄어 씀
  const apart = layer([row(100, 50, [T('가나다라마바사 대하')]), row(120, 50, [T('여 보면 '), M('x')])]);
  assert.equal(run(apart)[0].text, '가나다라마바사 대하 여 보면 $x$');
  const particle = layer([row(100, 50, [T('가나다라마바사 '), M('x'), T('축')]), row(120, 50, [T('의 방향')])]);
  assert.equal(run(particle)[0].text, '가나다라마바사 $x$축의 방향');
  const afterMath = layer([row(100, 50, [T('가나다라마바사 값은 '), M('48')]), row(120, 50, [T('이다.')])]);
  assert.equal(run(afterMath)[0].text, '가나다라마바사 값은 $48$이다.');
});

test('줄 끝 빈칸 글자를 남기는 PDF: 빈칸이 있으면 띄우고, 없으면 낱말 중간이라 붙이고, 마침표 뒤는 새 문단', () => {
  const L = layer([
    row(100, 50, [T('가나다라마바사아자 대한 ')]),
    row(120, 50, [T('칭이고 아자차카타파 그')]),
    row(140, 50, [T('래프는 아자차카타파하다.')]),
    row(160, 50, [T('풀이 '), M('x')]),
  ]);
  assert.deepEqual(run(L), [
    { type: 'para', text: '가나다라마바사아자 대한 칭이고 아자차카타파 그래프는 아자차카타파하다.' },
    { type: 'para', text: '풀이 $x$' },
  ]);
});

test('번호가 ①부터 차례로가 아닌 줄(정답표)은 보기가 아니라 글', () => {
  assert.deepEqual(run(layer([row(100, 50, [T('1 ③ 2 ① 값 '), M('x')])])), [{ type: 'para', text: '1 ③ 2 ① 값 $x$' }]);
});

test('오른쪽 끝에 번호 하나만 있는 줄은 답 표시, "답 ③" 은 보기가 아님', () => {
  const r = run(layer([row(100, 50, [T('따라서 값은 '), M('2')]), row(120, 500, [T('②')])]));
  assert.deepEqual(r[1], { type: 'para', text: '답 ②' });
  const two = run(layer([row(100, 50, [T('값은 '), M('1')]), row(120, 50, [T('답 ①')]), row(120, 400, [T('답 ③')])]));
  assert.deepEqual(two[1], { type: 'para', text: '답 ① 답 ③' });
});

test('문항 코드 [12345-6789] 는 빼고 옮김', () => {
  const rows = [row(100, 50, [T('[12345-6789]')]), row(120, 50, [T('값은 '), M('x')])];
  assert.deepEqual(run(layer(rows)), [{ type: 'para', text: '값은 $x$' }]);
});

test('곧은 선과 축만 있는 그래프도 그림으로 (이름표 포함)', () => {
  const rows = [row(100, 50, [T('그래프는 '), M('y')]), row(200, 150, [M('O')]), row(300, 50, [T('이다.')])];
  const shapes = [
    { x0: 160, y0: 130, x1: 160, y1: 240, segs: 1, curve: false, closed: true, image: false, light: false }, // y축
    { x0: 170, y0: 135, x1: 220, y1: 235, segs: 1, curve: false, closed: true, image: false, light: false }, // 직선
  ];
  const lines = [{ x0: 140, x1: 260, y: 200, lw: 0.4 }]; // x축
  const r = run(layer(rows, { lines, shapes }));
  assert.equal(r.length, 3);
  assert.equal(r[0].type, 'para');
  assert.equal(r[1].type, 'figure');
  const b = r[1].box;
  assert.ok(b.x > 0.2 && b.x + b.w < 0.5 && b.y > 0.15 && b.y + b.h < 0.32, JSON.stringify(b));
  assert.deepEqual(r[2], { type: 'para', text: '이다.' });
});

test('수식 글꼴이 없는 PDF 는 옮기지 않음', () => {
  const L = layer([row(100, 50, [T('가나다')])]);
  assert.equal(transcribeParts(whole(L)), null);
  assert.match(run(L).fail, /수식 글꼴/);
});

test('모르는 수식 기호가 있으면 옮기지 않음 (그림으로)', () => {
  const L = layer([row(100, 50, [M('x'), G('\u0001', 'EHsang', 0.5)])]);
  assert.equal(transcribeParts(whole(L)), null);
});
