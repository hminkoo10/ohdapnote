// 시중 문제집 편집 구조를 흉내 낸 테스트용 문제집/답지 생성
//  - ssen   : 4자리 연번(0001…) 번호 상자, 유형 제목, 2단 문제집 / 빠른 정답표 + 3단 해설(단·쪽을 넘어가는 긴 해설)
//  - suteuk : 개념 → 예제(풀이 포함) → 유제(1, 2…, 단원 내 연번) → Level 1~3(01…, 단계마다 다시 시작)
//             답지는 2단, "본문 ○쪽" 머리글, Level 제목, 쪽을 넘어가는 긴 해설
// 각 해설 끝에는 흰색 1px 표식(ZZE<키>)을 넣어, 해설이 실제로 어디서 끝나는지 PDF 글자로 확인할 수 있게 합니다.
// 사용: node test/fixtures/make-books.mjs
import { chromium } from '../lib/playwright.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'generated');
mkdirSync(outDir, { recursive: true });
const FONT = `'WenQuanYi Zen Hei', 'Noto Sans CJK KR', 'Malgun Gothic', sans-serif`;

let seed = 11;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const Q = [
  '다음 식의 값을 구하시오.',
  '실수 a에 대하여 ∛(a²) × a^(1/3) = 8 일 때, a의 값은?',
  '두 실수 x, y가 2^x = 3, 3^y = 4를 만족시킬 때, xy의 값은?',
  '함수 f(x) = log₂(x + 1) + 3 의 그래프가 점 (a, 5)를 지날 때, a의 값은?',
  '양수 a에 대하여 a^(1/2) + a^(-1/2) = 3 일 때, a + a^(-1)의 값을 구하시오.',
  '1이 아닌 두 양수 a, b에 대하여 log_a b = 2 일 때, log_b a² 의 값은?',
  '자연수 n에 대하여 n의 n제곱근 중 실수인 것의 개수를 f(n)이라 할 때, f(2) + f(3) + f(4)의 값은?',
  '그림과 같이 두 곡선 y = 2^x, y = 4^x 이 직선 y = k와 만나는 두 점을 각각 A, B라 하자.',
];
const SOL = [
  '주어진 식을 지수법칙으로 정리하면',
  '양변에 밑이 2인 로그를 취하면',
  '조건에서 x + y = 6, xy = 8 이므로',
  '로그의 성질에 의하여 정리하면',
  '따라서 a = 4 이고 b = 16 이다.',
  '이차방정식의 근과 계수의 관계에 의하여',
  '그래프에서 두 점 사이의 거리는',
  '이때 k > 0 이므로 조건을 만족시키는 값은',
];
const EQ = ['2³ × 2² = 2⁵ = 32', '3 log₂ 3 = log₂ 27', '8 = 2³ 이므로 a = 3', '12 = 2² × 3', '1 + 2 + 3 = 6', '4^(1/2) = 2'];
const CH = ['①', '②', '③', '④', '⑤'];
const fig = () =>
  '<svg width="140" height="84" style="display:block;margin:4px 0"><rect x="8" y="6" width="120" height="70" fill="none" stroke="#333"/><path d="M8 70 Q60 0 128 10" fill="none" stroke="#333"/><text x="0" y="82" font-size="9">O</text></svg>';
const choices = () => `<div class="ch">${CH.map((c, i) => `${c} ${int(1, 9) * (i + 1)}`).join('&emsp;')}</div>`;
const marker = (key) => `<span class="mk">ZZE${key}</span>`;

function explanation(lines, withEq = true) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    if (withEq && i % 3 === 1) out.push(`<div class="eq">${pick(EQ)}</div>`);
    else out.push(pick(SOL) + ' ' + pick(SOL));
  }
  return out.join(' ');
}

// ---------------------------------------------------------------------------
// 쎈 스타일
// ---------------------------------------------------------------------------
function ssenBooks() {
  const units = [
    { title: '01 지수', types: ['유형 01 거듭제곱근', '유형 02 지수의 확장', '유형 03 지수법칙의 활용'] },
    { title: '02 로그', types: ['유형 04 로그의 정의', '유형 05 로그의 성질', '유형 06 상용로그'] },
  ];
  let serial = 0;
  const probKeys = [];
  const ansKeys = [];
  const longKeys = new Set();
  let probHtml = '';
  let ansHtml = '';
  const quick = [];
  units.forEach((u, ui) => {
    probHtml += `<section class="unit"><div class="band"><span class="bn">${u.title}</span><span class="bs">A 유형 다지기</span></div><div class="cols">`;
    ansHtml += `<h2 class="sec">${u.title}</h2><div class="acols">`;
    u.types.forEach((t) => {
      probHtml += `<div class="type">${t}</div>`;
      const n = int(4, 6);
      for (let k = 0; k < n; k++) {
        serial++;
        const key = String(serial).padStart(4, '0');
        probKeys.push(key);
        const tag = rnd() < 0.3 ? '<span class="tag">중요</span>' : '';
        const src = rnd() < 0.25 ? '<span class="src">[교육청 기출]</span>' : '';
        const body = [pick(Q), rnd() < 0.4 ? `<div class="eq">${pick(EQ)}</div>` : '', rnd() < 0.3 ? pick(Q) : ''].join(' ');
        probHtml += `<div class="q"><span class="qn">${key}</span><div class="qb">${tag}${src} ${body}${rnd() < 0.3 ? fig() : ''}${rnd() < 0.8 ? choices() : ''}</div></div>`;
        // 해설
        const ans = pick(CH);
        quick.push(`<td><b>${key}</b> ${ans}</td>`);
        let lines = int(2, 6);
        if (serial % 7 === 3) {
          lines = int(26, 34); // 단·쪽을 넘어가는 긴 해설
          longKeys.add(key);
        }
        const other = rnd() < 0.3 ? `<div class="other"><b>다른 풀이</b> ${explanation(3, false)}</div>` : '';
        const subs = rnd() < 0.25 ? '<div>(1) 첫째 조건에서 값을 구한다.</div><div>(2) 둘째 조건에서 값을 구한다.</div>' : '';
        ansHtml += `<div class="a"><span class="an">${key}</span> <b class="dap">답 ${ans}</b> ${explanation(lines)}${subs}${other}따라서 정답은 ${ans}이다.${marker(key)}</div>`;
        ansKeys.push(key);
      }
    });
    probHtml += '</div></section>';
    ansHtml += '</div>';
  });
  // 빠른 정답표 (6칸씩)
  const rows = [];
  for (let i = 0; i < quick.length; i += 6) rows.push(`<tr>${quick.slice(i, i + 6).join('')}</tr>`);
  const quickHtml = `<div class="quick"><h1>빠른 정답 찾기</h1><table>${rows.join('')}</table></div>`;

  const common = `body{font-family:${FONT};color:#151515;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .eq{margin:2px 0;font-style:italic}.mk{font-size:1px;color:#fff;line-height:0}`;
  const prob = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:188mm 257mm;margin:20mm 13mm 16mm 13mm}
    ${common} body{font-size:9.5pt;line-height:1.6}
    .unit{break-before:page}.unit:first-child{break-before:auto}
    .band{display:flex;align-items:center;gap:10px;background:linear-gradient(90deg,#1f4fbf,#4b7be5);color:#fff;padding:3mm 4mm;margin-bottom:5mm;border-radius:2mm}
    .bn{font-size:15pt;font-weight:800}.bs{font-size:10pt;opacity:.9}
    .cols{column-count:2;column-gap:9mm;column-rule:.5pt solid #9db3e6}
    .type{display:inline-block;background:#e8efff;color:#1f4fbf;font-weight:700;font-size:9pt;padding:1mm 3mm;border-radius:1.5mm;margin:1mm 0 3mm}
    .q{display:flex;gap:2.5mm;margin-bottom:9mm;break-inside:avoid}
    .qn{flex:0 0 auto;align-self:flex-start;background:#1f4fbf;color:#fff;font-weight:800;font-size:9pt;padding:.3mm 1.4mm;border-radius:1mm;line-height:1.5}
    .qb{flex:1}.tag{color:#d02f2f;font-weight:700;font-size:8pt;margin-right:3px}.src{color:#777;font-size:7.5pt;margin-right:3px}
    .ch{margin-top:1.5mm;letter-spacing:.3pt}
  </style></head><body>${probHtml}</body></html>`;
  const ansDoc = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:188mm 257mm;margin:19mm 11mm 15mm 11mm}
    ${common} body{font-size:8pt;line-height:1.55}
    .quick{break-after:page}.quick h1{font-size:14pt;margin:0 0 4mm}
    .quick table{border-collapse:collapse;width:100%}.quick td{border:.4pt solid #bbb;padding:1.2mm 1.5mm;font-size:8pt;width:16.6%}
    h2.sec{font-size:12pt;color:#fff;background:#1f4fbf;padding:1.5mm 3mm;margin:3mm 0 3mm;border-radius:1mm}
    .acols{column-count:3;column-gap:5mm;column-rule:.4pt solid #ccc}
    .a{margin-bottom:3mm}.an{font-weight:800;color:#1f4fbf;font-size:9pt}.dap{color:#d02f2f}
    .other{background:#f3f6fd;border-radius:1mm;padding:1mm 1.5mm;margin-top:1mm}
  </style></head><body>${quickHtml}${ansHtml}</body></html>`;
  return { prob, ans: ansDoc, probKeys, ansKeys, longKeys: [...longKeys], header: '수학Ⅰ 쎈', ansHeader: '정답과 해설' };
}

// ---------------------------------------------------------------------------
// 수능특강 스타일
// ---------------------------------------------------------------------------
function suteukBooks() {
  const units = [
    { title: '01 지수와 로그', concepts: ['1 거듭제곱과 거듭제곱근', '2 지수의 확장', '3 로그의 뜻과 성질'] },
    { title: '02 지수함수와 로그함수', concepts: ['1 지수함수의 뜻과 그래프', '2 로그함수의 뜻과 그래프'] },
  ];
  const probKeys = [];
  const ansKeys = [];
  const longKeys = new Set();
  let probHtml = '';
  let ansHtml = '';
  let page = 6;
  units.forEach((u, ui) => {
    let yuje = 0;
    let ex = 0;
    probHtml += `<section class="unit"><div class="band">${u.title}</div><div class="cols">`;
    ansHtml += `<h2 class="sec">${u.title}</h2><div class="acols">`;
    u.concepts.forEach((c) => {
      ex++;
      probHtml += `<div class="concept"><div class="ct">${c}</div>${explanation(3, false)}</div>`;
      probKeys.push(`E${ui}-${ex}`);
      probHtml += `<div class="ex"><div class="exh"><span class="exl">예제 ${ex}</span></div>${pick(Q)} ${choices()}<div class="sol"><b>풀이</b> ${explanation(4)} <b>답 ${pick(CH)}</b></div></div>`;
      probHtml += '<div class="yu"><div class="yul">유제</div>';
      ansHtml += `<div class="pref">본문 ${page}~${page + 1}쪽</div>`;
      page += 2;
      for (let k = 0; k < 2; k++) {
        yuje++;
        const key = `Y${ui}-${yuje}`;
        probKeys.push(key);
        probHtml += `<div class="q"><span class="yn">${yuje}</span><div class="qb">${pick(Q)} ${rnd() < 0.5 ? choices() : ''}</div></div>`;
        ansKeys.push(key);
        ansHtml += `<div class="a"><span class="an">${yuje}</span> <b class="dap">정답 ${pick(CH)}</b> ${explanation(int(2, 5))} 따라서 답은 ③이다.${marker(key)}</div>`;
      }
      probHtml += '</div>';
    });
    // Level 1~3
    [['Level 1 기초 연습', 4], ['Level 2 기본 연습', 4], ['Level 3 실력 완성', 2]].forEach(([lv, cnt], li) => {
      probHtml += `<div class="lv">${lv}</div>`;
      ansHtml += `<div class="lvh">${lv}</div>`;
      for (let k = 1; k <= cnt; k++) {
        const key = `L${ui}-${li}-${k}`;
        const label = String(k).padStart(2, '0');
        probKeys.push(key);
        probHtml += `<div class="q"><span class="ln">${label}</span><div class="qb">${pick(Q)} ${rnd() < 0.3 ? fig() : ''}${rnd() < 0.7 ? choices() : ''}</div></div>`;
        ansKeys.push(key);
        let lines = int(2, 5);
        if (li === 2) {
          lines = int(24, 30); // Level 3 해설은 길어서 단·쪽을 넘어감
          longKeys.add(key);
        }
        ansHtml += `<div class="a"><span class="ln">${label}</span> <b class="dap">정답 ${pick(CH)}</b> ${explanation(lines)} 따라서 답은 ②이다.${marker(key)}</div>`;
      }
    });
    probHtml += '</div></section>';
    ansHtml += '</div>';
  });
  const common = `body{font-family:${FONT};color:#151515;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .eq{margin:2px 0;font-style:italic}.mk{font-size:1px;color:#fff;line-height:0}`;
  const prob = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:22mm 15mm 18mm 15mm}
    ${common} body{font-size:10pt;line-height:1.6}
    .unit{break-before:page}.unit:first-child{break-before:auto}
    .band{font-size:17pt;font-weight:800;color:#0b6e4f;border-bottom:2pt solid #0b6e4f;padding-bottom:2mm;margin-bottom:5mm}
    .cols{column-count:2;column-gap:10mm}
    .concept{background:#eef7f2;border-radius:2mm;padding:3mm;margin-bottom:5mm;break-inside:avoid}.ct{font-size:13pt;font-weight:800;color:#0b6e4f;margin-bottom:1mm}
    .ex{border:.8pt solid #0b6e4f;border-radius:2mm;padding:3mm;margin-bottom:5mm;break-inside:avoid}.exl{background:#0b6e4f;color:#fff;font-weight:800;padding:.5mm 2mm;border-radius:1mm}.exh{margin-bottom:2mm}
    .sol{margin-top:2mm;border-top:.5pt dashed #999;padding-top:2mm;font-size:9pt}
    .yu{margin-bottom:6mm}.yul{display:inline-block;font-weight:800;color:#0b6e4f;border-bottom:1.5pt solid #0b6e4f;margin-bottom:2mm}
    .q{display:flex;gap:3mm;margin-bottom:8mm;break-inside:avoid}
    .yn{flex:0 0 5mm;font-weight:800;font-size:12pt;color:#0b6e4f;line-height:1.3}
    .ln{flex:0 0 7mm;font-weight:800;font-size:12pt;color:#e0662a;line-height:1.3}.qb{flex:1}
    .lv{font-size:12.5pt;font-weight:800;color:#fff;background:#e0662a;padding:1.5mm 3mm;border-radius:1.5mm;margin:2mm 0 4mm;break-after:avoid}
    .ch{margin-top:1.5mm}
  </style></head><body>${probHtml}</body></html>`;
  const ansDoc = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:20mm 14mm 16mm 14mm}
    ${common} body{font-size:9pt;line-height:1.55}
    h2.sec{font-size:13pt;color:#0b6e4f;border-bottom:1.5pt solid #0b6e4f;margin:0 0 3mm;padding-bottom:1mm}
    .acols{column-count:2;column-gap:8mm;column-rule:.4pt solid #ccc}
    .pref{font-size:8.5pt;color:#fff;background:#0b6e4f;display:inline-block;padding:.3mm 2mm;border-radius:3mm;margin:2mm 0}
    .lvh{font-size:11.5pt;font-weight:800;color:#e0662a;border-bottom:1pt solid #e0662a;margin:3mm 0 2mm;break-after:avoid}
    .a{margin-bottom:3.5mm}.an{font-weight:800;color:#0b6e4f;font-size:10.5pt}.ln{font-weight:800;color:#e0662a;font-size:10.5pt}.dap{color:#c0392b}
  </style></head><body>${ansHtml}</body></html>`;
  return { prob, ans: ansDoc, probKeys, ansKeys, longKeys: [...longKeys], header: '수능특강 수학Ⅰ', ansHeader: '정답과 풀이' };
}

// ---------------------------------------------------------------------------
// 까다로운 책: [0100~0105] 공통 지문 + "100." 번호, 체크칸(□), 번호와 글자가 붙은 경우,
// 모양이 다른 번호 하나, 단 사이가 아주 좁아 잉크로는 단 구분이 안 되는 쪽
// ---------------------------------------------------------------------------
function hardBooks() {
  const probKeys = [];
  const ansKeys = [];
  let probHtml = '';
  let ansHtml = '';
  let n = 99;
  const q = (label, body, opts = {}) => {
    const box = opts.check ? '<span class="cb">□</span>' : '';
    const cls = opts.odd ? 'qn odd' : 'qn';
    const glue = opts.glue ? '' : ' ';
    return `<div class="q">${box}<span class="${cls}">${label}</span>${glue}${body}${rnd() < 0.6 ? choices() : ''}</div>`;
  };
  for (let set = 0; set < 3; set++) {
    const a = n + 1;
    const b = n + 3;
    probHtml += `<div class="stem"><b class="rg">[${String(a).padStart(4, '0')}~${String(b).padStart(4, '0')}]</b> 다음 글을 읽고 물음에 답하시오.<br>${explanation(3, false)}</div>`;
    for (let k = 0; k < 3; k++) {
      n++;
      probKeys.push(String(n));
      ansKeys.push(String(n));
      probHtml += q(`${n}.`, pick(Q), { check: k === 1, glue: k === 2 });
      ansHtml += `<div class="a"><b class="an">${n}.</b> 정답 ${pick(CH)} ${explanation(int(2, 4))} 따라서 답은 ③이다.${marker(String(n))}</div>`;
    }
    for (let k = 0; k < 3; k++) {
      n++;
      probKeys.push(String(n));
      ansKeys.push(String(n));
      probHtml += q(`${n}.`, pick(Q) + (rnd() < 0.3 ? fig() : ''), { check: k === 0, odd: set === 1 && k === 1 });
      ansHtml += `<div class="a"><b class="an">${n}.</b> 정답 ${pick(CH)} ${explanation(int(2, 4))} 따라서 답은 ①이다.${marker(String(n))}</div>`;
    }
  }
  const common = `body{font-family:${FONT};color:#151515;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .eq{margin:2px 0;font-style:italic}.mk{font-size:1px;color:#fff;line-height:0}`;
  const prob = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:20mm 14mm 16mm 14mm}
    ${common} body{font-size:10pt;line-height:1.6}
    .cols{column-count:2;column-gap:2mm}
    .stem{border:.6pt solid #888;border-radius:1.5mm;padding:2.5mm;margin-bottom:5mm;break-inside:avoid;background:#f6f6f6}
    .rg{font-family:'DejaVu Sans';color:#333}
    .q{margin-bottom:9mm;break-inside:avoid}
    .cb{font-size:11pt;margin-right:1.5mm;color:#666}
    .qn{font-family:'DejaVu Sans';font-weight:700;font-size:12pt;color:#1d5bd8}
    .qn.odd{font-family:'Liberation Serif';font-weight:400;font-size:11pt;color:#c0392b}
    .ch{margin-top:1.5mm}
  </style></head><body><div class="cols">${probHtml}</div></body></html>`;
  const ansDoc = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:20mm 14mm 16mm 14mm}
    ${common} body{font-size:9pt;line-height:1.55;column-count:2;column-gap:8mm;column-rule:.4pt solid #ccc}
    .a{margin-bottom:4mm}.an{font-family:'DejaVu Sans';font-size:10.5pt;color:#1d5bd8}
  </style></head><body>${ansHtml}</body></html>`;
  return { prob, ans: ansDoc, probKeys, ansKeys, longKeys: [], header: '실전 모의 문제', ansHeader: '정답과 해설' };
}

const headerTpl = (label, color) =>
  `<div style="width:100%;font-family:${FONT};font-size:7.5pt;margin:0 12mm;display:flex;justify-content:space-between;align-items:center;border-bottom:.8pt solid ${color};padding-bottom:1mm;color:${color};-webkit-print-color-adjust:exact"><b>${label}</b><span class="title"></span></div>`;
const footerTpl = (color) =>
  `<div style="width:100%;font-family:${FONT};font-size:8pt;margin:0 12mm;text-align:right;color:${color}"><span class="pageNumber"></span></div>`;

const browser = await chromium.launch();
const page = await browser.newPage();
async function pdf(html, file, label, color, size) {
  await page.setContent(html, { waitUntil: 'load' });
  writeFileSync(
    join(outDir, file),
    await page.pdf({ printBackground: true, displayHeaderFooter: true, headerTemplate: headerTpl(label, color), footerTemplate: footerTpl(color), preferCSSPageSize: true, ...size }),
  );
}
const expected = {};
for (const [name, make, color] of [
  ['ssen', ssenBooks, '#1f4fbf'],
  ['suteuk', suteukBooks, '#0b6e4f'],
  ['hard', hardBooks, '#444444'],
]) {
  seed = name === 'ssen' ? 11 : name === 'suteuk' ? 23 : 37;
  const b = make();
  await pdf(b.prob, `${name}-problem.pdf`, b.header, color, {});
  await pdf(b.ans, `${name}-answer.pdf`, b.ansHeader, color, {});
  const label = (k) =>
    /^E/.test(k) ? `예제 ${k.split('-').pop()}` : /^Y/.test(k) ? k.split('-').pop() : /^L/.test(k) ? k.split('-').pop().padStart(2, '0') : k;
  expected[name] = { probKeys: b.probKeys, probLabels: b.probKeys.map(label), ansKeys: b.ansKeys, longKeys: b.longKeys };
}
await browser.close();
writeFileSync(join(outDir, 'books-expected.json'), JSON.stringify(expected, null, 1));
// 스캔본 답지 (OCR 경로 확인용)
execFileSync('python3', [join(here, 'make-scan.py'), join(outDir, 'ssen-answer.pdf'), join(outDir, 'ssen-answer-scan.pdf')], { stdio: 'inherit' });
console.log('books →', outDir);
