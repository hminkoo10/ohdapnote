// Pix2Text LaTeX 정규화(src/renderer/js/latexnorm.js) → hwpeq.js 가 잘 읽는 LaTeX
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLatex } from '../../src/renderer/js/latexnorm.js';
import { latexToHwpEq } from '../../src/renderer/js/hwpeq.js';

const r = String.raw;

const cases = [
  // 띄어 쓴 함수 이름·숫자
  [r`\operatorname{l o g}_{2} 3 2 \!=\! 5`, r`\log_{2}32=5`],
  [r`\operatorname{s i n} ( b x-c )`, r`\sin(bx-c)`],
  [r`\mathrm{l o g}_{3} \frac{4} {3}`, r`\log_{3}\frac{4}{3}`],
  [r`\operatorname{s g n} x`, r`\operatorname{sgn}x`],
  [r`\mathrm{c m}`, r`\mathrm{cm}`],
  [r`\operatorname{l o g} 1 0 0 0`, r`\log 1000`],
  [r`\log0 . 0 2 5 4`, r`\log 0.0254`],
  [r`\frac{1 6} {3}`, r`\frac{16}{3}`],
  // 아래위 한계
  [r`\underset{k=1} {\overset{1 0} {\sum}} a_{k}`, r`\sum_{k=1}^{10}a_{k}`],
  [r`\overset{1 0} {\underset{k=1} {\sum}} a_{k} {}^{2}`, r`\sum_{k=1}^{10}a_{k}^{2}`],
  [r`\underset{x \to 0} {\lim} f ( x )`, r`\lim_{x\to 0}f(x)`],
  // 거듭제곱근
  [r`\log{\frac{1} {\root5 \of{1 0 0 0}}}`, r`\log\frac{1}{\sqrt[5]{1000}}`],
  [r`\root{n}\of x`, r`\sqrt[n]x`],
  // 띄움·묶음
  [r`y {=} a \sin\left( b x {-} c \right)`, r`y=a\sin(bx-c)`],
  [r`a , \, b , \, c`, r`a,b,c`],
  [r`\scriptstyle y=f ( x ) , \ y=g ( x )`, r`y=f(x),y=g(x)`],
  [r`{\sum_{i=1}^{n}} {x_{i}}^{2} {=} 2 3`, r`\sum_{i=1}^{n}x_{i}^{2}=23`],
  [r`\scriptstyle y=\tan{( a x-b )}`, r`y=\tan(ax-b)`],
  [r`a_{n} {=} \cos{\frac{n \pi} {4}}`, r`a_{n}=\cos\frac{n\pi}{4}`],
  [r`\mathrm{~ \sum_{k=1}^{1 0 0} ~} a_{2 k}`, r`\sum_{k=1}^{100}a_{2k}`],
  [r`\log_x 81=3`, r`\log_{x}81=3`],
  [r`{a+b}^{2}`, r`{a+b}^{2}`], // 여러 글자 묶음은 그대로
  [r`{x^{2}}^{3}`, r`{x^{2}}^{3}`], // 위첨자가 겹치면 그대로
  [r`{}_{n}\mathrm{C}_{r}`, r`{}_{n}\mathrm{C}_{r}`], // 조합 기호의 빈 묶음은 둠
  // 괄호: 큰 것이 있을 때만 \left \right
  [r`f \Big( {\frac{1} {2}} \Big)`, r`f\left(\frac{1}{2}\right)`],
  [r`y \!=\! a \cos\pi\! \left( x \!+\! {\frac{1} {2}} \right) \!+\! b`, r`y=a\cos\pi\left(x+\frac{1}{2}\right)+b`],
  [r`\operatorname{l o g}_{2} \left\{\operatorname{l o g}_{3} \left( \operatorname{l o g}_{4} n \right) \right\} \!=\! 0`, r`\log_{2}\{\log_{3}(\log_{4}n)\}=0`],
  [r`\left. \frac{d}{dx} \right|_{x=1}`, r`\left.\frac{d}{dx}\right|_{x=1}`],
  [r`\left( x`, r`(x`],
  // 한 칸짜리 array
  [r`\begin{array} {c} {a+b} \\ \end{array}`, r`a+b`],
  [r`\left\{ \begin{array} { l } x+y=1 \\ x-y=3 \end{array} \right.`, r`\left\{\begin{aligned}x+y=1\\x-y=3\end{aligned}\right.`],
  [r`\begin{cases} x & y \\ z \end{cases}`, r`\begin{cases}x&y\\z\end{cases}`],
  // 크롭 가장자리 찌꺼기
  [r`a \! > \! 0 , \, b \! > \! 0 , \, 0 \! < \! c \! < \! 1 \circ\! 1`, r`a>0,b>0,0<c<1`],
  [r`g ( x ) \!=\! a f ( x \!-\! b ) \circ\! ]`, r`g(x)=af(x-b)`],
  [r`a , \, b \circ\|`, r`a,b`],
  [r`\scriptstyle x={\frac{1+{\sqrt{3}} \, i} {2}} \, \circ\parallel`, r`x=\frac{1+\sqrt{3}i}{2}`],
  [r`k \textcircled{2}`, r`k`],
  [r`\log2 . 5 4 {=} 0 . 4 0 4 8 {\bmod{}}`, r`\log 2.54=0.4048`],
  [r`a \! > \! 0 , \; 0 \! < \! b \! < \! \pi)`, r`a>0,0<b<\pi`],
  [r`\sum_{n=1}^{2 4} {a_{n}}^{2} .`, r`\sum_{n=1}^{24}a_{n}^{2}`],
  [r`0 1 2 5 \textrm{\} 4^{2} {=} 1 6`, r`4^{2}=16`],
  [r`0 6 9 6 \cdots\textcircled{2}`, ''],
  [r`1 0 7 2 \cdot\textcircled{<}`, ''],
  [r`\circ`, ''],
  // 찌꺼기가 아닌 것은 둠
  [r`x^\circ`, r`x^{\circ}`],
  [r`\angle A=3 0^{\circ}`, r`\angle A=30^{\circ}`],
  [r`1 0 0 0 {=} 1 0^{3}`, r`1000=10^{3}`],
  [r`0 . 5 x`, r`0.5x`],
  [r`\textcircled{3} x`, '③x'],
  [r`\left\{ x \right\}`, r`\{x\}`],
  ['$x^2$', r`x^{2}`],
  ['', ''],
];

test('normalizeLatex: Pix2Text 표기 → 보통 LaTeX', () => {
  for (const [src, want] of cases) assert.equal(normalizeLatex(src), want, src);
});

test('normalizeLatex: 두 번 해도 같음', () => {
  for (const [src] of cases) {
    const once = normalizeLatex(src);
    assert.equal(normalizeLatex(once), once, src);
  }
});

// 실제 Pix2Text(MFR-1.5) 출력 표본 (문제집 스캔 크롭)
const SAMPLE = [
  r`y {=} a \sin\left( b x {-} c \right)`,
  r`a \! > \! 0 , \; b \! > \! 0 , \; 0 \! < \! c \! < \! \pi)`,
  r`y \!=\! a \cos\pi\! \left( x \!+\! {\frac{1} {2}} \right) \!+\! b`,
  r`f ( x ) \!=\! 2 \sin3 x \!-\! 1`,
  r`\scriptstyle y=\tan{( a x-b )}`,
  r`f \Big( {\frac{1} {2}} \Big)`,
  r`g ( x ) \!=\! a f ( x \!-\! b ) \circ\! ]`,
  r`x {=} \operatorname{l o g}_{a} N`,
  r`0 1 2 5 \textrm{\} 4^{2} {=} 1 6`,
  r`1 0 0^{\frac{1} {2}} {=} 1 0`,
  r`\log_{\frac{1} {3}} 8 1=-4`,
  r`\operatorname{l o g}_{4} \frac{1} {8} \!=\!-\frac{3} {2}`,
  r`\log_{3} {\left(-x^{2} \!+\! 4 x \right)}`,
  r`\operatorname{l o g}_{x+4} {( x \!-\! 2 )^{2}}`,
  r`\operatorname{l o g}_{3} 5 \! \cdot\! \operatorname{l o g}_{5} 7 \! \cdot\! \operatorname{l o g}_{7} 3`,
  r`\log_{\frac{1} {1 0}} {\sqrt{1 0}}`,
  r`3^{\operatorname{l o g} , 5}`,
  r`\log{\frac{1} {\root5 \of{1 0 0 0}}}`,
  r`\operatorname{l o g} {\frac{1} {\, 5 0 \,}}+\operatorname{l o g} {\frac{1} {\, 2 0 \,}}`,
  r`\log2 . 5 4 {=} 0 . 4 0 4 8 {\bmod{}}`,
  r`\operatorname{l o g}_{2} \left\{\operatorname{l o g}_{3} \left( \operatorname{l o g}_{4} n \right) \right\} \!=\! 0`,
  r`\scriptstyle x=\log_{3} {( {\sqrt{3}}+{\sqrt{2}} \, )}`,
  r`\mathrm{l o g}_{3} \frac{4} {3} \!+\! 3 \mathrm{l o g}_{3} \frac{1} {\sqrt{1 2}} \!=\! 2`,
  r`\underset{i=1} {\overset{n} {\sum}} x_{i} {=} 1 3`,
  r`\scriptstyle x={\frac{1+{\sqrt{3}} \, i} {2}} \, \circ\parallel`,
  r`k \textcircled{2}`,
  r`\overset{1 0} {\underset{k=1} {\sum}} a_{k} \!=\! 4 , \, \overset{1 0} {\underset{k=1} {\sum}} a_{k} {}^{2} \!=\! 8`,
  r`\begin{array} {c} {\underset{k=1} {\overset{3 0} {\sum}} ( a_{k} \!+\! 1 )^{2} \!=\! 5 6 , \, \underset{k=1} {\overset{3 0} {\sum}} a_{k} ( a_{k} \!+\! 1 ) \!=\! 2 4} \\ \end{array}`,
  r`\mathrm{~ \sum_{k=1}^{1 0 0} ~} a_{2 k} \!-\! \sum_{k=1}^{1 0 0} a_{2 k+1}`,
  r`\frac{-\frac{\pi} {6}} {-\frac{6} {-}}`,
  r`\begin{matrix} {\left| \begin{matrix} \end{matrix} \right|} & {\left| \left| \begin{matrix} \end{matrix} \right|} \\ \end{matrix} \left| \begin{matrix} \end{matrix} \right|} & {| \begin{matrix} \end{matrix} \right| x} \\ \end{matrix}`,
  r`1 0 7 2 \cdot\textcircled{<}`,
  r`\circ|`,
  r`0 3-1 , 2`,
];

test('Pix2Text 출력 표본: 정규화 → 한글 수식이 멈추지 않고, 역슬래시나 모르는 명령이 남지 않음', () => {
  for (const src of SAMPLE) {
    const norm = normalizeLatex(src);
    const hwp = latexToHwpEq(norm);
    assert.equal(typeof hwp, 'string', src);
    assert.doesNotMatch(hwp, /\\|operatorname|underset|overset|textcircled|scriptstyle|\broot\s+\d|\bof\b(?! \{)/, `${src} → ${hwp}`);
  }
});

test('정규화하면 Pix2Text 출력과 사람이 쓴 LaTeX 가 같은 한글 수식이 됨', () => {
  const pairs = [
    [r`y {=} a \sin\left( b x {-} c \right)`, r`y=a\sin(bx-c)`],
    [r`\operatorname{l o g}_{3} 5 \! \cdot\! \operatorname{l o g}_{5} 7 \! \cdot\! \operatorname{l o g}_{7} 3`, r`\log_3 5\cdot\log_5 7\cdot\log_7 3`],
    [r`\log{\frac{1} {\root5 \of{1 0 0 0}}}`, r`\log\frac{1}{\sqrt[5]{1000}}`],
    [r`\operatorname{l o g}_{x+4} {( x \!-\! 2 )^{2}}`, r`\log_{x+4}(x-2)^2`],
    [r`f \Big( {\frac{1} {2}} \Big)`, r`f\left(\frac{1}{2}\right)`],
    [r`\overset{1 0} {\underset{k=1} {\sum}} a_{k} \!=\! 4 , \, \overset{1 0} {\underset{k=1} {\sum}} a_{k} {}^{2} \!=\! 8`, r`\sum_{k=1}^{10}a_k=4, \sum_{k=1}^{10}a_k^2=8`],
    [r`x_{1} , \; x_{2} , \; x_{3} , \; \cdots, \; x_{n}`, r`x_1, x_2, x_3, \cdots, x_n`],
    [r`\begin{array} {c} {\underset{k=1} {\overset{3 0} {\sum}} ( a_{k} \!+\! 1 )^{2} \!=\! 5 6} \\ \end{array}`, r`\sum_{k=1}^{30}(a_k+1)^2=56`],
    [r`0 1 2 5 \textrm{\} 4^{2} {=} 1 6`, r`4^2=16`],
  ];
  for (const [p2t, gt] of pairs) assert.equal(latexToHwpEq(normalizeLatex(p2t)), latexToHwpEq(normalizeLatex(gt)), p2t);
});
