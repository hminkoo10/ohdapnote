// 로컬 전용 비교 시트. manifest: [{file,page,rect,beforeEq?,beforeReason?,label?}].
// 원본/manifest/생성물은 공개 저장소에 넣지 않는다.
// node scripts/review-hancom.mjs <manifest.json> <출력 폴더>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { readPageLayer, hancomEquationRegions } from '../src/renderer/js/pdfmath.js';
import { eqToMathML } from '../src/renderer/js/hwpeqview.js';

const [manifest, output] = process.argv.slice(2);
if (!manifest || !output) throw new Error('manifest.json과 출력 폴더 필요');
const out = resolve(output);
mkdirSync(out, { recursive: true });
const input = JSON.parse(readFileSync(manifest, 'utf8'));
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const records = [];
let task, doc, current, pageNo, canvas, layer, groups;
try {
  for (const row of input) {
    if (current !== row.file) {
      if (task) await task.destroy();
      task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(row.file)), fontExtraProperties: true,
        cMapUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url)).replaceAll('\\', '/'), cMapPacked: true,
        standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/') });
      doc = await task.promise;
      current = row.file;
      pageNo = undefined;
    }
    if (pageNo !== row.page) {
      const page = await doc.getPage(row.page);
      layer = await readPageLayer(page, pdfjs);
      groups = hancomEquationRegions(layer);
      const viewport = page.getViewport({ scale: 2 });
      canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      pageNo = row.page;
    }
    const r = row.rect;
    const group = groups.map((g) => ({ g, distance: Math.abs(g.rect.x - r.x) + Math.abs(g.rect.y - r.y) }))
      .sort((a, b) => a.distance - b.distance)[0];
    const enclosing = groups.find((g) => r.x + r.w / 2 >= g.rect.x && r.x + r.w / 2 <= g.rect.x + g.rect.w && r.y + r.h / 2 >= g.rect.y && r.y + r.h / 2 <= g.rect.y + g.rect.h);
    if (!group || group.distance > 0.02 && !enclosing) throw new Error(`영역 대응 실패: ${row.label}`);
    const after = group.distance <= 0.02 ? group.g : enclosing;
    const box = { x: Math.min(r.x, after.rect.x), y: Math.min(r.y, after.rect.y),
      x1: Math.max(r.x + r.w, after.rect.x + after.rect.w), y1: Math.max(r.y + r.h, after.rect.y + after.rect.h) };
    const crop = createCanvas(Math.max(1, Math.ceil((box.x1 - box.x) * canvas.width)), Math.max(1, Math.ceil((box.y1 - box.y) * canvas.height)));
    crop.getContext('2d').drawImage(canvas, box.x * canvas.width, box.y * canvas.height, crop.width, crop.height, 0, 0, crop.width, crop.height);
    const id = records.length + 1;
    writeFileSync(join(out, `source-${id}.png`), crop.toBuffer('image/png'));
    const eq = after.blocks.map((b) => b.eq || '').join('\n');
    records.push({ ...row, id, afterEq: eq, afterReason: after.reason, afterRect: after.rect,
      beforeVerdict: row.beforeReason ? '그림' : '미검토', afterVerdict: after.reason ? '그림' : '미검토', evidence: after.reason || '' });
    console.log('row', id, basename(row.file), row.page);
  }
} finally { if (task) await task.destroy(); }

const render = (eq, reason) => reason ? `<p>그림+low: ${esc(reason)}</p>` : `${eqToMathML(eq, { display: true })}<pre>${esc(eq)}</pre>`;
const html = (rows) => `<!doctype html><meta charset="utf-8"><title>수식 재검토</title>
<style>body{font:14px 'Malgun Gothic'}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aaa;padding:10px}img{max-width:430px}math{font-size:23px}pre{white-space:pre-wrap}td:first-child{width:180px}</style>
<h1>수식 재검토 · ${input.length}행</h1><p>모든 출력 low. 기존 시트 실제 60행. 요청 연도 미도착 시 대체 표본을 별도 표시. 판정 근거는 audit.json 참조.</p>
<table><tr><th>출처·유형</th><th>원본</th><th>전</th><th>후</th><th>판정·근거</th></tr>${rows.map((r) => `<tr><td>#${r.id} ${esc(r.label)}<br>${esc(basename(r.file))} ${r.page}쪽<br>유형 ${esc(r.types || '')}</td><td><img src="source-${r.id}.png"></td><td>${render(r.beforeEq, r.beforeReason)}</td><td>${render(r.afterEq, r.afterReason)}</td><td>${esc(r.beforeVerdict)} → ${esc(r.afterVerdict)}<p>${esc(r.evidence)}</p></td></tr>`).join('')}</table>`;
writeFileSync(join(out, 'audit.json'), JSON.stringify(records, null, 2) + '\n');
for (let i = 0; i < records.length; i += 40) writeFileSync(join(out, `part-${1 + i / 40}.html`), html(records.slice(i, i + 40)));
writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><h1>수식 재검토 ${records.length}행</h1>${Array.from({ length: Math.ceil(records.length / 40) }, (_, i) => `<p><a href="part-${i + 1}.html">${i * 40 + 1}~${Math.min(records.length, (i + 1) * 40)}행</a></p>`).join('')}`);
