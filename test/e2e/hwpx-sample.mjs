// 한글(HWPX) 내보내기 견본 만들기: Gemini 대신 미리 적어 둔 "옮긴 결과"와 그림 한 장으로
//   node test/e2e/hwpx-sample.mjs  → test/e2e/out/sample.hwpx (2단, 해설은 뒤에), sample-1col.hwpx (1단, 문제만)
// 한글에서 열어 수식을 두 번 누르면 수식 편집기로 고칠 수 있어야 합니다.

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
const item = (id, n, page, y, h = 0.18) => ({ id, number: String(n).padStart(4, '0'), prefix: '', page, rects: [{ page, x: 0.06, y, w: 0.42, h }] });
const entries = [
  { bookId: 'b', book: '쎈 수학Ⅰ', problem: item('p1', 153, 0, 0.08), answer: item('a1', 153, 1, 0.05, 0.1), src: { problem: src, answer: src } },
  { bookId: 'b', book: '쎈 수학Ⅰ', problem: item('p2', 154, 0, 0.3), answer: item('a2', 154, 1, 0.2, 0.1), src: { problem: src, answer: src } },
  { bookId: 'b', book: '쎈 수학Ⅰ', problem: item('p3', 161, 0, 0.55, 0.12), answer: item('a3', 161, 1, 0.35, 0.1), src: { problem: src, answer: src } },
  { bookId: 'b', book: '쎈 수학Ⅰ', problem: item('p4', 172, 0, 0.7), answer: null, src: { problem: src, answer: src } },
];

// Gemini 가 돌려줬다고 치는 결과
const TRANSCRIBED = {
  p1: [
    { type: 'para', text: '두 실수 $a$, $b$ 에 대하여 $a=\\sqrt[3]{27}$, $b=\\log_{2} 32$ 일 때, $\\frac{a+b}{2}$ 의 값은? [3점]' },
    { type: 'choices', items: ['$1$', '$2$', '$3$', '$4$', '$5$'] },
  ],
  p2: [
    { type: 'para', text: '함수 $f(x)=x^{2}-1$ 의 그래프가 그림과 같을 때, 다음 식의 값을 구하시오.' },
    { type: 'figure', box: { x: 0.45, y: 0.3, w: 0.5, h: 0.6 } },
    { type: 'math', latex: '\\lim_{x \\to 1} \\frac{f(x)}{x-1} + \\sum_{k=1}^{3} f(k)' },
    { type: 'choices', items: ['$\\frac{1}{2}$', '$\\sqrt{2}$', '$2^{3}$', '$\\log_{3} 81$', '$\\frac{\\sqrt{3}}{3}$'] },
  ],
  // p3: 옮기지 못했다고 침 → 그림으로
  p4: [
    { type: 'para', text: '부등식 $\\left| x-2 \\right| \\le 3$ 을 만족시키는 정수 $x$ 의 개수를 구하시오. (단, $x \\ne 0$)' },
    { type: 'para', text: '<보기>' },
    { type: 'para', text: 'ㄱ. $\\overline{AB}=\\sqrt{2}$' },
    { type: 'para', text: 'ㄴ. $\\angle ABC=90^{\\circ}$' },
    { type: 'para', text: 'ㄷ. $\\begin{cases} x+y=3 \\\\ x-y=1 \\end{cases}$ 의 해는 $x=2$, $y=1$' },
    { type: 'choices', items: ['ㄱ', 'ㄴ', 'ㄱ, ㄴ', 'ㄴ, ㄷ', 'ㄱ, ㄴ, ㄷ'] },
  ],
  a1: [{ type: 'para', text: '$a=3$, $b=5$ 이므로 $\\frac{a+b}{2}=\\frac{8}{2}=4$' }, { type: 'para', text: '답 ④' }],
  a2: [
    { type: 'para', text: '$\\lim_{x \\to 1} \\frac{x^{2}-1}{x-1}=\\lim_{x \\to 1}(x+1)=2$' },
    { type: 'para', text: '$\\sum_{k=1}^{3} f(k)=0+3+8=11$ 이므로 답은 $13$' },
  ],
  a3: [{ type: 'para', text: '$x^{2}-5x+6=0$ 에서 $(x-2)(x-3)=0$ $\\therefore x=2$ 또는 $x=3$' }],
};

async function sample(name, mode, options) {
  const blocks = makeBlocks(mode, entries, options, (role, it) => `p.${it.page + 12}`);
  const bytes = await buildHwpx({
    blocks,
    options,
    title: '수학Ⅰ 오답노트',
    info: { title: '수학Ⅰ 오답노트', subtitle: '문제 4문항 · 정답 및 해설', academy: '오답수학학원', teacher: '김선생', student: '홍길동', date: '2026. 11. 1.' },
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
