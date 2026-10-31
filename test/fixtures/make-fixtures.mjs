// 테스트용 가짜 문제집/답지 PDF 생성 (Chromium 인쇄 + 스캔본 흉내)
// 사용: node test/fixtures/make-fixtures.mjs
import { chromium } from '../lib/playwright.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'generated');
mkdirSync(outDir, { recursive: true });

const FONT = `'WenQuanYi Zen Hei', 'Noto Sans CJK KR', 'Malgun Gothic', sans-serif`;

// 결정적 의사난수
let seed = 7;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const SENTENCES = [
  '다음 식의 값을 구하시오.',
  '이차방정식 x² − 5x + 6 = 0 의 두 근을 α, β 라 할 때, α² + β² 의 값은?',
  '함수 f(x) = 2x³ − 3x² + 1 의 극댓값과 극솟값의 합은?',
  '실수 a 에 대하여 log₂ a + log₄ a = 6 일 때, a 의 값은?',
  '등차수열 {aₙ} 에서 a₃ = 7, a₇ = 19 일 때, a₁₀ 의 값은?',
  '두 점 A(1, 2), B(5, −2) 를 지나는 직선의 기울기를 구하시오.',
  '부등식 |x − 3| < 5 를 만족시키는 정수 x 의 개수는?',
  '좌표평면 위의 원 x² + y² = 25 위의 점 P 에 대하여 다음 물음에 답하시오.',
];

function problemHtml(numLabel, k) {
  const lines = [];
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) lines.push(pick(SENTENCES));
  // 줄 맨 앞에 숫자가 오는 본문(오인식 함정)
  if (k % 4 === 2) lines.push('<br>2 이상의 자연수 n 에 대하여 성립하는 값을 모두 고르시오.');
  if (k % 5 === 3) lines.push('<div class="sub">(1) 첫째 항을 구하시오.<br>(2) 공차를 구하시오.</div>');
  const fig = k % 3 === 1 ? '<svg width="150" height="90"><rect x="10" y="10" width="120" height="70" fill="none" stroke="#333"/><line x1="10" y1="80" x2="130" y2="10" stroke="#333"/><text x="0" y="90" font-size="10">A</text></svg>' : '';
  const choices = k % 5 === 3 ? '' : '<div class="choices">① 1　② 2　③ 3　④ 4　⑤ 5</div>';
  return `<div class="prob"><span class="no">${numLabel}</span><div class="body">${lines.join(' ')}${fig}${choices}</div></div>`;
}

function bookHtml({ units, numbering, title }) {
  let k = 0;
  let serial = 0;
  const parts = [];
  units.forEach((count, u) => {
    parts.push(`<section class="unit"><div class="unit-title">0${u + 1}  단원 ${u + 1} 유형 연습</div><div class="cols">`);
    for (let i = 1; i <= count; i++) {
      serial++;
      const label = numbering === 'serial' ? String(serial).padStart(4, '0') : String(i);
      parts.push(problemHtml(label, k++));
    }
    parts.push('</div></section>');
  });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 22mm 15mm 18mm 15mm; }
    body { font-family: ${FONT}; font-size: 10pt; line-height: 1.55; color: #111; margin: 0; }
    .unit { break-before: page; }
    .unit:first-child { break-before: auto; }
    .unit-title { background: #23408e; color: #fff; padding: 3mm 4mm; font-size: 13pt; font-weight: bold; margin-bottom: 6mm; }
    .cols { column-count: 2; column-gap: 11mm; column-rule: 0.4pt solid #888; }
    .prob { break-inside: avoid; display: flex; gap: 2.5mm; margin-bottom: 13mm; }
    .no { font-size: 13pt; font-weight: bold; color: #1b4fd6; min-width: 7mm; line-height: 1.25; }
    .body { flex: 1; }
    .choices { margin-top: 2mm; letter-spacing: 0.5pt; }
    .sub { margin-top: 1.5mm; }
    svg { display: block; margin: 2mm 0; }
  </style></head><body>${parts.join('')}</body></html>`;
}

function answerHtml({ units, numbering }) {
  let serial = 0;
  const parts = [];
  units.forEach((count, u) => {
    parts.push(`<div class="unit-title">0${u + 1}  단원 ${u + 1}</div>`);
    for (let i = 1; i <= count; i++) {
      serial++;
      const label = numbering === 'serial' ? String(serial).padStart(4, '0') : String(i);
      const long = (serial % 3 === 0 ? 4 : 1) + Math.floor(rnd() * 2);
      const body = Array.from({ length: long }, () => pick(SENTENCES).replace('구하시오.', '구하면 된다.')).join(' ');
      parts.push(`<div class="ans"><span class="no">${label}</span> <b>정답 ${pick(['①', '②', '③', '④', '⑤'])}</b> ${body} 따라서 구하는 값은 ${Math.floor(rnd() * 90) + 10} 이다.</div>`);
    }
  });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 20mm 14mm 18mm 14mm; }
    body { font-family: ${FONT}; font-size: 9pt; line-height: 1.5; color: #111; margin: 0; column-count: 2; column-gap: 9mm; }
    .unit-title { font-weight: bold; font-size: 11pt; border-bottom: 1.2pt solid #333; margin: 2mm 0 3mm; break-after: avoid; }
    .ans { margin-bottom: 4mm; }
    .no { font-weight: bold; font-size: 10.5pt; color: #c2185b; }
  </style></head><body>${parts.join('')}</body></html>`;
}

const footer = (label) => `<div style="font-size:8pt;width:100%;padding:0 15mm;font-family:${FONT};color:#444;display:flex;justify-content:space-between"><span>${label}</span><span class="pageNumber"></span></div>`;
const header = (label) => `<div style="font-size:8pt;width:100%;padding:0 15mm;font-family:${FONT};color:#666;border-bottom:0.5pt solid #aaa;padding-bottom:1mm">${label}</div>`;

const browser = await chromium.launch();
const page = await browser.newPage();

async function toPdf(html, file, label) {
  await page.setContent(html, { waitUntil: 'load' });
  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: header(label),
    footerTemplate: footer(label),
    preferCSSPageSize: true,
  });
  writeFileSync(join(outDir, file), pdf);
  return pdf;
}

const unitBook = { units: [14, 10], numbering: 'unit' };
const serialBook = { units: [9, 8], numbering: 'serial' };

await toPdf(bookHtml(unitBook), 'book-unit.pdf', '수학Ⅰ 유형 연습');
seed = 7;
await toPdf(answerHtml(unitBook), 'answer-unit.pdf', '정답과 해설');
seed = 99;
await toPdf(bookHtml(serialBook), 'book-serial.pdf', '수학Ⅱ 실력 다지기');
seed = 99;
await toPdf(answerHtml(serialBook), 'answer-serial.pdf', '정답과 해설');

// 정답(기대값) 저장
writeFileSync(
  join(outDir, 'expected.json'),
  JSON.stringify({
    'book-unit.pdf': unitBook.units.flatMap((c) => Array.from({ length: c }, (_, i) => String(i + 1))),
    'answer-unit.pdf': unitBook.units.flatMap((c) => Array.from({ length: c }, (_, i) => String(i + 1))),
    'book-serial.pdf': Array.from({ length: 17 }, (_, i) => String(i + 1).padStart(4, '0')),
    'answer-serial.pdf': Array.from({ length: 17 }, (_, i) => String(i + 1).padStart(4, '0')),
  }, null, 2),
);
await browser.close();

// 스캔본 흉내: 페이지를 이미지로 바꾸고 약간 기울이고 노이즈를 넣은 뒤 이미지 PDF 로
execFileSync('python3', [join(here, 'make-scan.py'), join(outDir, 'book-unit.pdf'), join(outDir, 'book-unit-scan.pdf'), join(outDir, 'photos')], { stdio: 'inherit' });
console.log('fixtures →', outDir);
