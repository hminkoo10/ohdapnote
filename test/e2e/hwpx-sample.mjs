// 한글(HWPX) 내보내기 견본 만들기: Gemini 대신 미리 적어 둔 "옮긴 결과"와 그림 한 장으로
//   node test/e2e/hwpx-sample.mjs  → test/e2e/out/sample.hwpx (2단, 해설은 뒤에), sample-1col.hwpx (1단, 문제만)
// 한글에서 열어 수식을 두 번 누르면 수식 편집기로 고칠 수 있어야 합니다.
// 담은 것: 공통 지문을 쓰는 문항 셋(범위 표시 "[0030~0037]" 은 떼야 함), 한글 글자 바로 옆 수식,
//          분수·거듭제곱·거듭제곱근, 길이가 다른 보기(한 줄 / 3+2 / 한 줄에 하나), 도형, 글자로 못 옮긴 문항(그림)

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { buildHwpx } from '../../src/renderer/js/hwpx.js';
import { makeBlocks } from '../../src/renderer/js/exporter.js';

const OUT = fileURLToPath(new URL('./out/', import.meta.url));

/** 아주 작은 PNG 만들기 (RGB). paint(x, y) → [r, g, b] */
function makePng(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8비트
  ihdr[9] = 2; // RGB
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return { bytes: new Uint8Array(png), ext: 'png', pxW: w, pxH: h };
}

const WHITE = [255, 255, 255];
const INK = [30, 30, 30];

/** 포물선 그래프 (그림으로 잘라 넣는 도형 자리) */
const graph = () =>
  makePng(600, 420, (x, y) => {
    const ox = 300;
    const oy = 330;
    if (Math.abs(x - ox) < 2 || Math.abs(y - oy) < 2) return INK; // 축
    const fx = (x - ox) / 60;
    const fy = oy - 60 * (fx * fx - 1); // y = x² - 1
    if (Math.abs(y - fy) < 2.5) return [20, 90, 200];
    if ((x - ox) % 60 === 0 || (y - oy) % 60 === 0) return [228, 232, 238]; // 모눈
    return WHITE;
  });

/** 글자로 옮기지 못한 문항 자리: 글줄처럼 보이는 막대와 상자 */
const scanned = () =>
  makePng(1100, 360, (x, y) => {
    if (x < 6 || x > 1093 || y < 6 || y > 353) return [200, 205, 212];
    const line = Math.floor((y - 30) / 44);
    const inLine = (y - 30) % 44 < 18 && line >= 0 && line < 4;
    const lengths = [960, 1010, 880, 520];
    if (inLine && x > 40 && x < lengths[line] && (x * 7 + line * 13) % 97 > 18) return [70, 70, 70];
    if (y > 230 && y < 320 && x > 640 && x < 1040 && (x === 641 || x === 1039 || y === 231 || y === 319)) return INK;
    return WHITE;
  });

// 가짜 원본(쪽 크기만 있으면 됨)과 문항
const src = { pages: [{ w: 595, h: 842, kind: 'pdf' }, { w: 595, h: 842, kind: 'pdf' }], files: [{ name: 'sample.pdf' }] };
const STEM = [{ page: 0, x: 0.06, y: 0.04, w: 0.42, h: 0.04 }]; // [0030~0037] 다음 식을 간단히 하시오.
const item = (id, n, page, y, h = 0.12, stem = null) => ({ id, number: String(n).padStart(4, '0'), prefix: '', page, rects: [{ page, x: 0.06, y, w: 0.42, h }], ...(stem ? { stem } : {}) });
const entry = (problem, answer = null) => ({ bookId: 'b', book: '', problem, answer, src: { problem: src, answer: src } });
const entries = [
  entry(item('p30', 30, 0, 0.1, 0.06, STEM), item('a30', 30, 1, 0.05, 0.08)),
  entry(item('p32', 32, 0, 0.18, 0.06, STEM), item('a32', 32, 1, 0.15, 0.08)),
  entry(item('p33', 33, 0, 0.26, 0.06, STEM)),
  entry(item('p119', 119, 0, 0.36), item('a119', 119, 1, 0.25, 0.1)),
  entry(item('p54', 54, 0, 0.5)),
  entry(item('p75', 75, 0, 0.62)),
  entry(item('p81', 81, 0, 0.74)),
  entry(item('p90', 90, 0, 0.84)),
  entry(item('p153', 153, 1, 0.4, 0.2), item('a153', 153, 1, 0.65, 0.08)),
  entry(item('p161', 161, 1, 0.62, 0.12)),
  entry(item('p124', 124, 1, 0.76, 0.2)),
];

// Gemini 가 돌려줬다고 치는 결과 (공통 지문을 함께 옮긴 결과는 범위 표시로 시작)
const TRANSCRIBED = {
  p30: [
    { type: 'para', text: '[0030~0037] 다음 식을 간단히 하시오. (단, $a>0$, $b>0$)' },
    { type: 'math', latex: '\\left(2^{\\frac{9}{4}}\\right)^{2} \\times 2^{\\frac{1}{2}}' },
  ],
  p32: [
    { type: 'para', text: '［0030～0037］ 다음 식을 간단히 하시오. (단, $a>0$, $b>0$)' },
    { type: 'para', text: '0032 $\\left(\\sqrt[9]{a^{6}} \\times \\sqrt[4]{b^{2}}\\right)^{6}$' },
  ],
  p33: [
    { type: 'para', text: '$[30 \\sim 37]$ 다음 식을 간단히 하시오. (단, $a>0$, $b>0$)' },
    { type: 'math', latex: '(a^{2}b^{3})^{\\frac{1}{6}} \\times \\left(a^{\\frac{1}{3}}b^{\\frac{3}{4}}\\right)^{2}' },
  ],
  p119: [
    { type: 'para', text: '$a>b>0$인 $a$, $b$에 대하여 $a^{\\frac{2}{3}}+b^{\\frac{2}{3}}=2$이고' },
    { type: 'math', latex: 'x=a+3a^{\\frac{1}{3}}b^{\\frac{2}{3}}, \\quad y=b+3a^{\\frac{2}{3}}b^{\\frac{1}{3}}' },
    { type: 'para', text: '일 때, $(x+y)^{\\frac{2}{3}}+(x-y)^{\\frac{2}{3}}$의 값을 구하시오.' },
  ],
  p54: [
    { type: 'para', text: '세 수 $\\sqrt{3\\sqrt[3]{3}}$, $\\sqrt{4\\sqrt[3]{2}}$, $\\sqrt[3]{5\\sqrt{5}}$ 중에서 가장 작은 수를 $a$, 가장 큰 수를 $b$라 할 때, 부등식 $a<\\sqrt[6]{n}<b$를 만족시키는 자연수 $n$의 개수는? [3점]' },
    { type: 'choices', items: ['$42$', '$43$', '$44$', '$45$', '$46$'] },
  ],
  p75: [
    { type: 'para', text: '$a=\\sqrt{5}$, $b=\\sqrt[3]{3}$일 때, $15^{\\frac{1}{6}}$을 $a$, $b$를 이용하여 나타내면?' },
    { type: 'choices', items: ['$a^{\\frac{1}{6}}b^{\\frac{1}{3}}$', '$a^{\\frac{1}{3}}b^{\\frac{1}{6}}$', '$a^{\\frac{1}{3}}b^{\\frac{1}{2}}$', '$a^{\\frac{1}{2}}b^{\\frac{1}{3}}$', '$a^{\\frac{1}{2}}b^{\\frac{1}{2}}$'] },
  ],
  p81: [
    { type: 'para', text: '이차부등식 $x^{2}-2x-3<0$의 해가 $\\alpha<x<\\beta$일 때, 다음 중 $\\log_{2}(\\beta-\\alpha)$와 같은 것은?' },
    { type: 'choices', items: ['$\\log_{2} 3+\\log_{4} 4$', '$2\\log_{4} 3-\\log_{2} 1$', '$\\frac{1}{2}\\log_{2} 16$', '$\\log_{\\sqrt{2}} 2+1$', '$3-\\log_{3} 9$'] },
  ],
  p90: [
    { type: 'para', text: '함수 $f(x)=\\log_{2}(x+1)$에 대한 설명으로 옳은 것은?' },
    {
      type: 'choices',
      items: ['정의역은 $\\{x \\mid x>-1\\}$이고 치역은 실수 전체의 집합이다.', '그래프는 점 $(1, 2)$를 지난다.', '$x$의 값이 증가하면 $f(x)$의 값은 감소한다.', '그래프의 점근선은 직선 $x=1$이다.', '$f(3)+f(7)=5$'],
    },
  ],
  p153: [
    { type: 'para', text: '함수 $f(x)=x^{2}-1$ 의 그래프가 그림과 같을 때, 다음 식의 값을 구하시오.' },
    { type: 'figure', box: { x: 0.45, y: 0.3, w: 0.5, h: 0.6 } },
    { type: 'math', latex: '\\lim_{x \\to 1} \\frac{f(x)}{x-1} + \\sum_{k=1}^{3} f(k)' },
    { type: 'choices', items: ['$\\frac{1}{2}$', '$\\sqrt{2}$', '$2^{3}$', '$\\log_{3} 81$', '$\\frac{\\sqrt{3}}{3}$'] },
  ],
  // p161: 옮기지 못했다고 침 → 그림으로
  p124: [
    { type: 'para', text: '지면으로부터 $H_{1}$인 높이에서 풍속이 $V_{1}$이고 지면으로부터 $H_{2}$인 높이에서 풍속이 $V_{2}$일 때, 대기 안정도 계수 $k$는 다음 식을 만족시킨다.' },
    { type: 'math', latex: 'V_{2}=V_{1} \\times \\left(\\frac{H_{2}}{H_{1}}\\right)^{\\frac{2}{2-k}}' },
    { type: 'para', text: '(단, $H_{1}<H_{2}$이고, 높이의 단위는 $\\text{m}$, 풍속의 단위는 $\\text{m/s}$이다.)' },
    { type: 'para', text: 'A 지역에서 지면으로부터 $12 \\text{ m}$와 $36 \\text{ m}$인 높이에서 풍속이 각각 $2 \\text{ m/s}$와 $8 \\text{ m/s}$일 때, $k$의 값은?' },
    { type: 'choices', items: ['$\\frac{4}{5}$', '$1$', '$\\frac{6}{5}$', '$\\frac{7}{5}$', '$\\frac{8}{5}$'] },
  ],
  a30: [{ type: 'para', text: '$\\left(2^{\\frac{9}{4}}\\right)^{2} \\times 2^{\\frac{1}{2}}=2^{\\frac{9}{2}+\\frac{1}{2}}=2^{5}=32$' }],
  a32: [{ type: 'para', text: '$\\left(a^{\\frac{2}{3}}b^{\\frac{1}{2}}\\right)^{6}=a^{4}b^{3}$' }],
  a119: [
    { type: 'para', text: '$x+y=a+3a^{\\frac{1}{3}}b^{\\frac{2}{3}}+3a^{\\frac{2}{3}}b^{\\frac{1}{3}}+b=\\left(a^{\\frac{1}{3}}+b^{\\frac{1}{3}}\\right)^{3}$ 이므로' },
    { type: 'para', text: '$(x+y)^{\\frac{2}{3}}+(x-y)^{\\frac{2}{3}}=2\\left(a^{\\frac{2}{3}}+b^{\\frac{2}{3}}\\right)=4$' },
    { type: 'para', text: '답 $4$' },
  ],
  a153: [
    { type: 'para', text: '$\\lim_{x \\to 1} \\frac{x^{2}-1}{x-1}=\\lim_{x \\to 1}(x+1)=2$' },
    { type: 'para', text: '$\\sum_{k=1}^{3} f(k)=0+3+8=11$ 이므로 답은 $13$' },
  ],
};

async function sample(name, mode, options) {
  const blocks = makeBlocks(mode, entries, options, (role, it) => `p.${it.page + 9}`);
  const bytes = await buildHwpx({
    blocks,
    options,
    title: '지수와 로그 오답노트',
    info: { title: '지수와 로그 오답노트', subtitle: `문제 ${entries.length}문항${mode === 'both-end' ? ' · 정답 및 해설' : ''}`, academy: '오답수학학원', teacher: '김선생', student: '홍길동', date: '2026. 11. 1.' },
    transcribe: async (block) => {
      const list = TRANSCRIBED[block.item.id];
      return list ? { blocks: list, crop: async () => graph() } : null;
    },
    renderSeg: async () => scanned(),
  });
  await mkdir(OUT, { recursive: true });
  const file = `${OUT}${name}`;
  await writeFile(file, bytes);
  console.log(`${file}  (${bytes.length} bytes, 글자 ${bytes.stats.text}문항 / 그림 ${bytes.stats.picture}문항)`);
}

await sample('sample.hwpx', 'both-end', { columns: 2, space: 'small', labels: true, renumber: true });
await sample('sample-1col.hwpx', 'problems', { columns: 1, space: 'none', labels: true, renumber: true });
