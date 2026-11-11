// 지어낸 책: 보통 문항 → 식만 있는 밀집 문항 → 바로 뒤 정답표.
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { chromium } from '../lib/playwright.mjs';
import { startServer } from '../lib/server.mjs';
import { setPriority, constants, freemem } from 'node:os';
import { statfsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const start = Date.now();
const guard = (initial = false) => {
  assert.ok(freemem() >= (initial ? 4 : 2) * 2**30, 'memory guard');
  const disk = statfsSync('C:/');
  assert.ok(disk.bavail * disk.bsize >= 15 * 2**30, 'disk guard');
  assert.ok(Date.now() - start < 120000, '2 minute cap');
};
guard(true);
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let index = 0; index < 3; index++) {
  const page = pdf.addPage([600,800]);
  const count = index === 0 ? 4 : 48;
  for (let k = 0; k < count; k++) {
    const col = index === 0 ? 0 : Math.floor(k/24);
    const row = index === 0 ? k : k%24;
    const number = index === 1 ? k+5 : k+1;
    page.drawText(`${number}.   ${index === 2 ? '= 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 2' : '(3 + 8) = ____ + ____ + ____ + ____'}`, {
      x: 45 + col*285, y: 730-row*(index === 0 ? 140 : 27), size: 9, font,
    });
  }
}
const bytes = await pdf.save();
const { server, url } = await startServer();
let browser;
let timer;
const errors = [];
try {
  browser = await chromium.launch({ headless: true, args: ['--renderer-process-limit=1','--js-flags=--single-threaded','--num-raster-threads=2'] });
  timer = setInterval(() => { try { guard(); } catch (e) { errors.push(e.message); browser.close(); } },5000);
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => Object.defineProperty(navigator,'hardwareConcurrency',{ get: () => 2 }));
  await page.route('**/*', r => {
    const target = r.request().url();
    if (target === url+'/synthetic.pdf') return r.fulfill({ contentType:'application/pdf', body:Buffer.from(bytes) });
    // 식과 번호가 내장된 가상 PDF. OCR 호출이 필요하면 시험 실패로 드러냅니다.
    if (target.endsWith('/ocr.js')) return r.fulfill({ contentType:'text/javascript',body:'export const OCR_WORKERS=1; export async function recognizeWords(){throw Error("unexpected OCR");} export async function recognizeLine(){throw Error("unexpected OCR");}' });
    return target.startsWith(url) || /^(blob:|data:)/.test(target) ? r.continue() : r.abort();
  });
  await page.goto(url+'/test/e2e/harness.html');
  await page.waitForFunction(() => window.harnessReady);
  const measured = await page.evaluate(async url => {
    const { openDocSource } = await import('/src/renderer/js/docsource.js');
    const { analyzeDocument } = await import('/src/renderer/js/analyze.js');
    const { createEditor } = await import('/src/renderer/js/editor.js');
    window.src = await openDocSource([{name:url+'/synthetic.pdf',kind:'pdf'}],n=>n);
    window.options = {pages:[0,1,2],role:'problem',flow:'column'};
    window.doc = await analyzeDocument(window.src,window.options);
    const style = document.createElement('link'); style.rel='stylesheet';style.href='/src/renderer/styles.css';
    await new Promise(resolve => { style.onload=resolve; document.head.append(style); });
    window.editor = createEditor({project:()=>({docs:{problem:window.doc}}),source:()=>window.src,onItemsChanged:()=>{}});
    const app = document.createElement('div'); app.id='app'; app.append(window.editor.el);
    document.body.replaceChildren(app);
    window.editor.el.style.height='850px';
    window.editor.show('problem',1);
    return { active:window.doc.items.length, pages:window.doc.pageInfo,
      dense:window.doc.pageInfo[1]?.exclusion?.items.length || window.doc.items.filter(it=>it.page===1).length };
  },url);
  console.log(JSON.stringify({active:measured.active,dense:measured.dense,excluded:Object.entries(measured.pages).filter(([,v])=>v.exclusion).map(([k])=>k)}));
  assert.equal(measured.dense,48,'all dense detections retained');
  assert.ok(measured.pages[1].exclusion,'worst case deliberately exercises a false exclusion');
  const shots = process.env.PORT_SHOTS;
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800); // 글꼴 적용 뒤 첫 페인트까지 기다립니다.
  if (shots) {
    mkdirSync(shots,{recursive:true});
    await page.evaluate(() => {
      window.excludedDoc=window.doc;
      window.doc={...window.doc,items:[...window.doc.items,...Object.values(window.doc.pageInfo).flatMap(pi=>pi.exclusion?.items || [])],
        pageInfo:Object.fromEntries(Object.entries(window.doc.pageInfo).map(([k,v])=>[k,{...v,exclusion:undefined}]))};
      window.editor.refresh();
    });
    await page.screenshot({animations:'disabled',path:join(shots,'turn13-review-before.png')});
    await page.evaluate(()=>{window.doc=window.excludedDoc;window.editor.refresh();});
  }
  if (shots) { mkdirSync(shots,{recursive:true}); await page.screenshot({animations:'disabled',path:join(shots,'turn13-review-excluded.png')}); }
  await page.getByRole('button',{name:'문항으로 되돌리기',exact:true}).click();
  const restored = await page.evaluate(async () => {
    const count=window.doc.items.filter(it=>it.page===1).length;
    const saved=JSON.parse(JSON.stringify(window.doc));
    const {analyzeDocument,reanalyzeSinglePage}=await import('/src/renderer/js/analyze.js');
    window.doc=await analyzeDocument(window.src,{...window.options,previousDoc:saved});
    const single=await reanalyzeSinglePage(window.src,window.doc,1);
    window.editor.refresh();
    return {count,after:window.doc.items.filter(it=>it.page===1).length,single:single.items.length,restored:window.doc.pageInfo[1].exclusion.restored};
  });
  assert.deepEqual(restored,{count:48,after:48,single:48,restored:true});
  if(shots) await page.screenshot({animations:'disabled',path:join(shots,'turn13-review-restored.png')});
  assert.deepEqual(errors,[]);
  const result={denseFalseExcludedPages:1,restored,seconds:(Date.now()-start)/1000};
  if(process.env.PORT_REPORT)writeFileSync(process.env.PORT_REPORT,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {
  clearInterval(timer);
  if(browser)await browser.close();
  server.close();
}
