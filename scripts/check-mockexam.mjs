// 로컬 표본 점검. 내용/글꼴 데이터는 쓰지 않고 코드·통계만 출력한다.
// node scripts/check-mockexam.mjs <정답표.pdf>
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPageLayer, transcribeParts } from '../src/renderer/js/pdfmath.js';
import { parseAnswerKey } from '../src/renderer/js/mockexam-answers.js';
import { isPrivateChar } from '../src/renderer/js/hancom.js';
const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(process.argv[2])), fontExtraProperties: true, disableFontFace: true });
try {
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const result = parseAnswerKey(content.items);
  console.log('sections', Object.fromEntries(Object.entries(result.answers).map(([k, v]) => [k, Object.keys(v).length])));
  console.log('warnings', result.warnings);
  const layer = await readPageLayer(page, pdfjs);
  console.log('PUA fonts/codes', [...new Set(layer.glyphs.filter((g) => isPrivateChar(g.c)).map((g) => `${g.fam}: ${[...g.c].map((c) => c.codePointAt(0).toString(16)).join(',')}`))]);
  const blocks = transcribeParts([{ layer, rect: { x: 0, y: 0, w: 1, h: 1 }, place: { x: 0, y: 0, w: 1, h: 1 } }], { explain: true });
  console.log('blocks', Array.isArray(blocks) ? blocks.map((b) => ({ type: b.type, low: b.low?.length || 0 })) : blocks);
} finally { await task.destroy(); }
