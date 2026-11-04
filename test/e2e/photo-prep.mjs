// 합성 사진의 전후 검출·쪽 좌표·12MP 처리 시간 확인 (after: 가져올 때 보정해 저장한 쪽을 엶).
// 사용: node test/e2e/photo-prep.mjs [before|after]
import { chromium } from '../lib/playwright.mjs';
import { startServer } from '../lib/server.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const mode = process.argv[2] || 'after';
const root = new URL('../fixtures/generated/photo-spreads/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('expected.json', root)));
const { server, url } = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const results = [];
let failures = 0;
try {
  await page.goto(`${url}/test/e2e/harness.html`);
  await page.waitForFunction(() => window.harnessReady);
  for (const c of manifest.cases) {
    const result = await page.evaluate(async ({ file, mode }) => {
      const { DocSource, openDocSource } = await import('/src/renderer/js/docsource.js');
      const { analyzeDocument } = await import('/src/renderer/js/analyze.js');
      const { encodePhoto } = await import('/src/renderer/js/photoimport.js');
      const started = performance.now();
      let src, urls = [];
      if (mode === 'before') {
        src = new DocSource([{ name: file, kind: 'image' }], (n) => n);
        const bmp = await src._loadImage(0);
        src.pages.push({ fileIndex: 0, pageIndex: 0, kind: 'image', w: 595.28,
          h: 595.28*bmp.height/bmp.width, pxW: bmp.width, pxH: bmp.height, rotate: 0 });
      } else {
        // 가져오기와 같은 길: 보정·JPEG 저장 → 저장된 쪽 크기로 열기
        const photo = await encodePhoto(file);
        const files = photo.status === 'prepared'
          ? photo.pages.map((p) => ({ name: URL.createObjectURL(new Blob([p.data], { type: 'image/jpeg' })), kind: 'image', width: p.width, height: p.height }))
          : [{ name: file, kind: 'image', width: photo.width, height: photo.height }];
        urls = files.map((f) => f.name).filter((n) => n.startsWith('blob:'));
        src = await openDocSource(files, (n) => n);
      }
      const prepMs = performance.now() - started;
      const t0 = performance.now();
      const detected = await analyzeDocument(src, { pages: src.pages.map((_, i) => i), role: 'problem', flow: 'column' });
      const detectMs = performance.now() - t0;
      const thumbnails = [];
      for (let i = 0; i < src.numPages; i++) thumbnails.push((await src.renderPage(i, 750)).toDataURL('image/png').split(',')[1]);
      const r = { prepMs, detectMs, pages: src.numPages, sizes: src.pages.map((p) => [p.pxW, p.pxH]),
        items: detected.items.map((i) => ({ number: i.number, page: i.page, rects: i.rects })),
        info: detected.pageInfo, thumbnails };
      await src.destroy();
      urls.forEach((u) => URL.revokeObjectURL(u));
      return r;
    }, { file: `${url}/test/fixtures/generated/photo-spreads/${c.file}`, mode });
    const expected = c.questions.map((q) => q.number);
    const got = result.items.map((i) => i.number);
    const remaining = [...expected];
    let correct = 0;
    for (const n of got) {
      const index = remaining.indexOf(n);
      if (index >= 0) { correct++; remaining.splice(index, 1); }
    }
    result.thumbnails.forEach((png, i) => writeFileSync(new URL(`${c.file}-${mode}-${i}.png`, root), Buffer.from(png, 'base64')));
    delete result.thumbnails;
    const positions = result.items.filter((item) => {
      const q = c.questions.find((q) => q.number === item.number);
      if (!q) return false;
      const x = mode === 'before' ? q.photoPolygon.reduce((s, p) => s+p[0], 0)/4/c.width : (q.rect[0]+q.rect[2])/2;
      const y = mode === 'before' ? q.photoPolygon.reduce((s, p) => s+p[1], 0)/4/c.height : (q.rect[1]+q.rect[3])/2;
      return item.rects.some((r) => r.page === (mode === 'before' ? 0 : q.page) && x >= r.x-0.01 && x <= r.x+r.w+0.01 && y >= r.y-0.01 && y <= r.y+r.h+0.01);
    }).length;
    if (mode === 'after' && (result.pages !== 2 || correct !== expected.length || got.length !== expected.length || positions !== expected.length)) failures++;
    results.push({ file: c.file, expected, correct, positions, recall: correct/expected.length,
      precision: correct/Math.max(1, got.length), ...result });
    console.log(`${mode} ${c.file}: pages=${result.pages}, found=${got.length}/${expected.length}, correct=${correct}/${expected.length}, positions=${positions}/${expected.length}, prep=${Math.round(result.prepMs)}ms, detect=${Math.round(result.detectMs)}ms, numbers=${got.join(',')}`);
  }
  writeFileSync(new URL(`${mode}.json`, root), JSON.stringify(results, null, 2));
  if (mode === 'after') {
    const checks = await page.evaluate(async () => {
      const { openDocSource } = await import('/src/renderer/js/docsource.js');
      const { preparePhoto } = await import('/src/renderer/js/photoprep.js');
      const { encodePhoto } = await import('/src/renderer/js/photoimport.js');
      const base = '/test/fixtures/generated/';
      const imageUrl = base+'photo-spreads/spread-3deg.jpg';
      const load = async (u) => createImageBitmap(await (await fetch(u)).blob());
      const out = {};
      for (const file of ['photo-spreads/flat-1.png', 'photos/photo-1.jpg']) {
        const bmp = await load(base+file), p = await preparePhoto(bmp);
        out[file] = !p.changed && p.pages.length === 1 && p.pages[0] === bmp;
        bmp.close();
      }
      const photo = await encodePhoto(imageUrl);
      const prepared = photo.pages.map((p) => ({ name: URL.createObjectURL(new Blob([p.data], { type: 'image/jpeg' })), kind: 'image', width: p.width, height: p.height }));
      out.prepared = photo.status === 'prepared' && prepared.length === 2;
      const files = [{ name: imageUrl, kind: 'image' }, { name: base+'book-serial.pdf', kind: 'pdf' }, ...prepared];
      const src = await openDocSource(files, (n) => n);
      // 크기를 저장한 쪽은 열 때 그림을 읽지 않음 (크기 모르는 첫 사진만 읽음)
      out.lazyOpen = src._images.size <= 1 && !src._images.has(2) && !src._images.has(3);
      out.mixedMapping = src.numPages === 6 && src.files.map((f) => f.pageCount).join() === '1,3,1,1'
        && src.pages[4].fileIndex === 2 && src.pages[5].fileIndex === 3 && src.pages[5].pxW === prepared[1].width;
      const p = src.pages[5], full = await src.renderPage(5, p.pxW);
      const x = 100, y = 150, w = 400, h = 600;
      const crop = await src.renderRegion(5, { x: x/p.pxW, y: y/p.pxH, w: w/p.pxW, h: h/p.pxH }, p.pxW);
      const a = full.getContext('2d').getImageData(x, y, w, h).data;
      const b = crop.getContext('2d').getImageData(0, 0, w, h).data;
      let error = 0;
      for (let i = 0; i < a.length; i++) error += Math.abs(a[i]-b[i]);
      out.cropCoordinates = error/a.length < 0.1;
      const thumb = (await src.renderPage(5, 240)).toDataURL();
      await src.destroy();
      out.destroy = src._images.size === 0;
      const reopened = await openDocSource(files, (n) => n);
      out.reopen = thumb === (await reopened.renderPage(5, 240)).toDataURL();
      await reopened.destroy();
      prepared.forEach((f) => URL.revokeObjectURL(f.name));
      const bmp = await load(imageUrl), timings = [];
      for (let i = 0; i < 3; i++) {
        const p = await preparePhoto(bmp);
        timings.push(p.ms);
        for (const c of p.pages) if (c !== bmp) { c.width = 1; c.height = 1; }
      }
      bmp.close();
      return { checks: out, timings };
    });
    writeFileSync(new URL('integration.json', root), JSON.stringify(checks, null, 2));
    console.log('integration:', JSON.stringify(checks));
    assert.ok(Object.values(checks.checks).every(Boolean), '이미지·PDF·좌표·재열기 회귀');
    console.log(`photo cases: pass=${results.length-failures}, fail=${failures}; integration: pass=${Object.values(checks.checks).filter(Boolean).length}, fail=${Object.values(checks.checks).filter((x) => !x).length}`);
  }
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failures ? 1 : 0;
