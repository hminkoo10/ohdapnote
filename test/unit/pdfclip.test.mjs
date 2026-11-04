import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from '../../src/renderer/vendor/pdf-lib.esm.min.js';
import { filterContent, fontMetrics, stripHiddenText } from '../../src/renderer/js/pdfclip.js';
import { buildPdf } from '../../src/renderer/js/exporter.js';

// CI는 로컬 의존성, worktree는 NODE_PATH의 읽기 전용 의존성 사용.
const require = createRequire(import.meta.url);
const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjs = await import(pathToFileURL(pdfjsPath).href);
const pdfjsRoot = resolve(dirname(pdfjsPath), '../..');
const bytes = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));
const text = (b) => Buffer.from(b).toString('latin1');
const key = (s) => PDFName.of(s);
const read = (stream) => decodePDFRawStream(stream).decode();
const box = [0, 380, 600, 430];
const metrics = { codeBytes: 1, width: () => 500 };
const fonts = new Map([['F1', metrics]]);
const filter = (s, bbox = box, fs = fonts) => text(filterContent(bytes(s), bbox, fs));
const line = (s, x, y) => `1 0 0 1 ${x} ${y} Tm (${s}) Tj`;

async function fixture(content, { font, resources, bbox = box, extraBoxes = [] } = {}) {
  const src = await PDFDocument.create();
  const ctx = src.context;
  const helv = await src.embedFont(StandardFonts.Helvetica);
  await helv.embed();
  const fontDict = ctx.lookup(helv.ref);
  fontDict.set(key('FirstChar'), ctx.obj(32));
  fontDict.set(key('LastChar'), ctx.obj(126));
  fontDict.set(key('Widths'), ctx.obj(Array.from({ length: 95 }, (_, i) => helv.widthOfTextAtSize(String.fromCharCode(32 + i), 1000))));
  const page = src.addPage([600, 800]);
  page.node.set(key('Resources'), resources?.(ctx, helv.ref) || ctx.obj({ Font: { F1: font?.(ctx) || helv.ref } }));
  page.node.set(key('Contents'), ctx.register(ctx.flateStream(bytes(content))));
  const out = await PDFDocument.create();
  const boxes = [bbox, ...extraBoxes];
  const [embedded, ...others] = await out.embedPages(boxes.map(() => page), boxes.map(([left, bottom, right, top]) => ({ left, bottom, right, top })));
  out.addPage([600, 800]).drawPage(embedded, { x: 0, y: 0 });
  await embedded.embed();
  for (const other of others) await other.embed();
  return { src, out, embedded, others, root: () => out.context.lookup(embedded.ref) };
}

async function inspect(data, render = false) {
  const task = pdfjs.getDocument({ data: data.slice(), standardFontDataUrl: resolve(pdfjsRoot, 'standard_fonts').replaceAll('\\', '/') + '/' });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const items = (await page.getTextContent()).items.filter((i) => i.str?.trim());
    const result = { items, strings: items.map((i) => i.str) };
    if (render) {
      const viewport = page.getViewport({ scale: 2 });
      const surface = doc.canvasFactory.create(viewport.width, viewport.height);
      await page.render({ canvasContext: surface.context, viewport }).promise;
      result.pixels = new Uint8Array(surface.context.getImageData(0, 0, viewport.width, viewport.height).data);
      doc.canvasFactory.destroy(surface);
    }
    return result;
  } finally { await task.destroy(); }
}

async function compare(f, expected, render = false) {
  const before = await inspect(await f.out.save(), render);
  await stripHiddenText(f.out, f.embedded);
  const after = await inspect(await f.out.save(), render);
  assert.deepEqual(after.strings, expected);
  for (const item of after.items) {
    const old = before.items.find((i) => i.str === item.str);
    assert.ok(old, item.str);
    assert.deepEqual(item.transform, old.transform, item.str);
  }
  if (render) assert.deepEqual(after.pixels, before.pixels);
  return { before, after };
}

test('재현: BBox 밖 추출 글자 제거, 안쪽 transform·픽셀 보존', async () => {
  const f = await fixture(`BT /F1 20 Tf ${line('TOP LINE HIDDEN', 50, 700)} ${line('MIDDLE VISIBLE', 50, 400)} ${line('BOTTOM HIDDEN', 50, 100)} ET`);
  const original = f.root();
  const { before } = await compare(f, ['MIDDLE VISIBLE'], true);
  assert.ok(before.strings.includes('TOP LINE HIDDEN'));
  const filtered = text(read(f.root()));
  assert.doesNotMatch(filtered, /TOP LINE HIDDEN|BOTTOM HIDDEN/);
  for (const name of ['Type', 'Subtype', 'FormType', 'BBox', 'Matrix', 'Resources']) {
    assert.equal(f.root().dict.get(key(name)), original.dict.get(key(name)), name);
  }
  const once = f.root();
  await stripHiddenText(f.out, f.embedded);
  assert.equal(f.root(), once, '저장·재호출 때 되돌리지 않음');
});

test('한 BT의 바깥-안-바깥-안: Td 없이 이어 써도 위치 보존', async () => {
  const f = await fixture('BT /F1 20 Tf 1 0 0 1 -100 400 Tm (HIDDEN) Tj [-3000] TJ (FIRST) Tj 0 -200 Td (BOTTOM) Tj 100 200 Td (SECOND) Tj ET', { bbox: [0, 380, 200, 430] });
  await compare(f, ['FIRST', 'SECOND'], true);
  assert.doesNotMatch(text(read(f.root())), /HIDDEN|BOTTOM/);
});

test('경계 걸침·1pt 여유는 원문 바이트 그대로 남김', () => {
  for (const [x, y] of [[-6, 400], [600.5, 400], [20, 431.5], [20, 369.5]]) {
    const source = `% before\r\nBT /F1 10 Tf ${line('A', x, y)} ET % after`;
    assert.equal(filter(source), source);
  }
  assert.doesNotMatch(filter(`BT /F1 10 Tf ${line('OUT', 602, 400)} ET`), /OUT/);
});

test("작은따옴표·큰따옴표: 줄 행렬·Tw·Tc 보존", async () => {
  const source = `BT /F1 20 Tf 100 TL 1 0 0 1 50 700 Tm (HIDE1) ' 7 2 (HIDE2) " (VISIBLE) ' (END) Tj ET`;
  const f = await fixture(source);
  await compare(f, ['VISIBLEEND'], true);
  const result = text(read(f.root()));
  assert.match(result, /7 Tw 2 Tc T\*/);
  assert.doesNotMatch(result, /HIDE1|HIDE2/);
  assert.equal((result.match(/Tm/g) || []).length, 1);
});

test('TJ 숫자·Tz/Tc/Tw·Ts·TD: 진행폭·픽셀 보존', async () => {
  const source = 'BT /F1 10 Tf 80 Tz 2 Tc 3 Tw 2 Ts 1 0 0 1 -80 400 Tm [(HI D) 120 (E)] TJ [-9000] TJ (VISIBLE) Tj 0 -100 TD (HIDE) Tj 80 100 Td (SECOND) Tj ET';
  const f = await fixture(source, { bbox: [0, 380, 220, 430] });
  const before = await inspect(await f.out.save(), true);
  await stripHiddenText(f.out, f.embedded);
  const after = await inspect(await f.out.save(), true);
  assert.deepEqual(after.strings, ['V I S I B L E', 'S E C O N D']);
  assert.deepEqual(after.pixels, before.pixels);
  assert.deepEqual(after.items[1].transform, before.items[1].transform);
  // pdf.js 6.4.299는 페이지 밖 글자의 Tc를 누락하고 빈 TJ에도 Tc를 더함.
  // 이 조합의 첫 추출 좌표는 비교 불가. 렌더 픽셀과 PDF 진행폭은 별도 검증.
  assert.doesNotMatch(text(read(f.root())), /HI D|\(E\)|HIDE/);
  const result = filter('BT /F1 10 Tf 50 Tz 2 Tc 3 Tw 1 0 0 1 0 700 Tm [(A ) 100 (B)] TJ ET');
  assert.match(result, /\[-2300\] TJ/); // ((15 - 1) + 6 + 3) × .5 = 11.5
});

test('cm·q/Q·회전 Tm: 위치와 화면 보존', async () => {
  const source = `q 1 0 0 1 0 300 cm BT /F1 20 Tf ${line('HIDE', 50, 400)} ET Q
    q 0 1 -1 0 300 300 cm BT /F1 20 Tf ${line('ROTATED', 100, 100)} ET Q
    BT /F1 20 Tf 0 1 -1 0 200 390 Tm (TURN) Tj ET
    BT /F1 20 Tf ${line('NORMAL', 50, 400)} ET`;
  const f = await fixture(source);
  await compare(f, ['ROTATED', 'TURN', 'NORMAL'], true);
  assert.doesNotMatch(text(read(f.root())), /HIDE/);
});

test('문자열 중첩·이스케이프·8진·줄 연결·%·16진·BDC 사전', () => {
  const kept = '/Span << /ActualText (100% (source)) /Info << /A [1 2 (x)] >> >> BDC\nBT /F#31 10 Tf 1 0 0 1 20 400 Tm (a\\(b\\) (c) % \\101\\\r\nD) Tj ET EMC';
  const source = `${kept}\nBT /F1 10 Tf 1 0 0 1 20 700 Tm (a\\(b\\) (c) % \\101\\\r\nD) Tj <41 4> Tj ET`;
  const result = filter(source);
  assert.ok(result.startsWith(kept));
  assert.match(result.slice(kept.length), /\[-1000\] TJ/); // 홀수 16진수는 0으로 채움.
  assert.equal((result.match(/100%/g) || []).length, 1);
  assert.equal((result.match(/\\101/g) || []).length, 1);
});

test('인라인 이미지: 바이너리 Tj·괄호·가짜 EI를 건너뜀', () => {
  const binary = bytes('Tj) %\x00 EI (BT <ff> "');
  const image = `BI /W ${binary.length} /H 1 /BPC 8 /CS /G ID\n${text(binary)}\nEI`;
  const source = `q ${image} Q\nBT /F1 10 Tf ${line('HIDE', 10, 700)} ET`;
  const result = filter(source);
  assert.ok(result.startsWith(`q ${image} Q\n`));
  assert.doesNotMatch(result, /HIDE/);
});

test('인라인 이미지: Flate·ASCIIHex·ASCII85·RunLength·JPEG 경계', () => {
  const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 6, 255, 217, 84, 106, 255, 218, 0, 2, 41, 255, 0, 255, 217]);
  const images = [
    ['Fl', deflateSync(bytes('Tj) EI BT'))], ['AHx', bytes('54 6a 29>')], ['A85', bytes('z~>')],
    ['RL', Uint8Array.from([2, 84, 106, 41, 128])], ['DCT', jpeg],
  ];
  const prefix = images.map(([f, b]) => `BI /W 1 /H 1 /BPC 8 /CS /G /F /${f} ID\n${text(b)}\nEI`).join('\n');
  const result = filter(`${prefix}\nBT /F1 10 Tf ${line('HIDE', 10, 700)} ET`);
  assert.ok(result.startsWith(prefix));
  assert.doesNotMatch(result, /HIDE/);
});

function cidFont(ctx, encoding = 'Identity-H') {
  return ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'TestCID', Encoding: encoding,
    DescendantFonts: [{ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'TestCID',
      CIDSystemInfo: { Registry: 'Adobe', Ordering: 'Identity', Supplement: 0 }, DW: 900,
      W: [1, [400, 600], 10, 12, 700] }] });
}

test('Type0 Identity-H: 2바이트 CID·두 W 형식·DW·Tw 제외', async () => {
  const doc = await PDFDocument.create();
  const cid = fontMetrics(cidFont(doc.context));
  assert.deepEqual([1, 2, 10, 11, 12, 32].map(cid.width), [400, 600, 700, 700, 700, 900]);
  const result = filter('BT /F1 10 Tf 100 Tw 1 Tc 50 Tz 1 0 0 1 0 700 Tm <00010002000a0020> Tj ET', box, new Map([['F1', cid]]));
  assert.match(result, /\[-3000\] TJ/);
  const f = await fixture('BT /F1 20 Tf 1 0 0 1 20 700 Tm <0001> Tj 1 0 0 1 20 400 Tm <0002> Tj ET', { font: cidFont });
  await stripHiddenText(f.out, f.embedded);
  assert.doesNotMatch(text(read(f.root())), /<0001>/);
  assert.match(text(read(f.root())), /<0002>/);
  const defaultFont = cidFont(doc.context);
  defaultFont.lookup(key('DescendantFonts')).lookup(0).delete(key('DW'));
  assert.equal(fontMetrics(defaultFont).width(99), 1000);
});

test('단순 글꼴: FirstChar·Widths·MissingWidth, 기본 MissingWidth 0', async () => {
  const doc = await PDFDocument.create();
  for (const subtype of ['Type1', 'TrueType', 'MMType1']) {
    const font = doc.context.obj({ Subtype: subtype, FirstChar: 65, Widths: [600, 700], FontDescriptor: { MissingWidth: 300 } });
    assert.deepEqual([32, 65, 66, 67].map(fontMetrics(font).width), [300, 600, 700, 300]);
    font.delete(key('FontDescriptor'));
    assert.equal(fontMetrics(font).width(32), 0);
  }
});

test('표준14·Type3·다른 CMap·Identity-V·0 크기/배율은 보수적으로 유지', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  await font.embed();
  const unknowns = [doc.context.lookup(font.ref), doc.context.obj({ Subtype: 'Type3' }), cidFont(doc.context, 'Identity-V'), cidFont(doc.context, 'UniKS-UCS2-H')];
  for (const unknown of unknowns) {
    assert.equal(fontMetrics(unknown), null);
    const source = `BT /F1 20 Tf ${line('HIDDEN', 50, 700)} ET`;
    assert.equal(filter(source, box, new Map([['F1', fontMetrics(unknown)]])), source);
  }
  for (const settings of ['/F1 0 Tf', '/F1 10 Tf 0 Tz']) {
    const source = `BT ${settings} ${line('HIDDEN', 50, 700)} ET`;
    assert.equal(filter(source), source);
  }
  const odd = 'BT /F1 10 Tf 1 0 0 1 0 700 Tm <001> Tj ET';
  // 실제 홀수 바이트 CID는 폭 미상.
  const source = odd.replace('<001>', '<00>');
  assert.equal(filter(source, box, new Map([['F1', fontMetrics(cidFont(doc.context))]])), source);
});

test('미상 폭 뒤는 Tm/Td/T*로 위치가 확정될 때까지 유지', () => {
  const source = 'BT /Unknown 20 Tf 1 0 0 1 0 700 Tm (UNKNOWN) Tj /F1 20 Tf (KEEP) Tj 0 -300 Td (VISIBLE) Tj 0 300 Td (REMOVE) Tj ET';
  const result = filter(source);
  assert.match(result, /UNKNOWN.*KEEP.*VISIBLE/);
  assert.doesNotMatch(result, /REMOVE/);
});

test('TJ 역방향 조정: 중간에 보이는 글자를 순 진행폭만으로 지우지 않음', () => {
  const source = 'BT /F1 10 Tf 1 0 0 1 -100 400 Tm [-11000 (VISIBLE) 20000 (END)] TJ ET';
  assert.equal(filter(source), source);
});

test('클리핑·윤곽선 글자는 모양 보존을 위해 유지', () => {
  for (const mode of [1, 2, 4, 5, 6, 7]) {
    const source = `BT /F1 10 Tf ${mode} Tr ${line('KEEP', 20, 700)} ET`;
    assert.equal(filter(source), source);
  }
});

test('중첩 Form: Matrix 반영·문항별 Resources/XObject 복제·공유 원본 보존', async () => {
  let originalChild;
  const f = await fixture('/Wrapper Do', { extraBoxes: [[0, 680, 600, 730]], resources: (ctx, fontRef) => {
    const leaf = ctx.register(ctx.flateStream(bytes(`BT /F1 20 Tf ${line('TOP', 50, 600)} ${line('MIDDLE', 50, 300)} ET`), {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 600, 800], Matrix: [1, 0, 0, 1, 0, 100], Resources: { Font: { F1: fontRef } },
    }));
    const wrapper = ctx.register(ctx.flateStream(bytes('/Leaf Do'), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 600, 800], Resources: { XObject: { Leaf: leaf } } }));
    return ctx.obj({ XObject: { Wrapper: wrapper } });
  } });
  const [other] = f.others;
  const oldRoot = f.root(), resources = oldRoot.dict.lookup(key('Resources'));
  const originalWrapper = resources.lookup(key('XObject')).lookup(key('Wrapper'));
  originalChild = originalWrapper.dict.lookup(key('Resources')).lookup(key('XObject')).lookup(key('Leaf'));
  const originalBytes = read(originalChild).slice();
  await compare(f, ['MIDDLE'], true);
  const newResources = f.root().dict.lookup(key('Resources'));
  assert.notEqual(newResources, resources);
  assert.notEqual(newResources.lookup(key('XObject')), resources.lookup(key('XObject')));
  const wrapper = newResources.lookup(key('XObject')).lookup(key('Wrapper'));
  const child = wrapper.dict.lookup(key('Resources')).lookup(key('XObject')).lookup(key('Leaf'));
  assert.doesNotMatch(text(read(child)), /TOP/);
  assert.match(text(read(child)), /MIDDLE/);
  assert.deepEqual(read(originalChild), originalBytes);
  assert.ok(f.out.context.lookup(other.ref).dict.lookup(key('Resources')).lookup(key('XObject')).lookup(key('Wrapper')) === originalWrapper);
  await stripHiddenText(f.out, other);
  const otherWrapper = f.out.context.lookup(other.ref).dict.lookup(key('Resources')).lookup(key('XObject')).lookup(key('Wrapper'));
  const otherChild = otherWrapper.dict.lookup(key('Resources')).lookup(key('XObject')).lookup(key('Leaf'));
  assert.match(text(read(otherChild)), /TOP/);
  assert.doesNotMatch(text(read(otherChild)), /MIDDLE/);
  assert.doesNotMatch(text(read(child)), /TOP/);
});

test('동일 Form 이름의 여러 CTM 호출: 어느 호출에서든 보이면 유지', async () => {
  const f = await fixture('/Child Do q 1 0 0 1 0 -300 cm /Child Do Q', { resources: (ctx, fontRef) => {
    const child = ctx.register(ctx.flateStream(bytes(`BT /F1 20 Tf ${line('KEEP', 50, 700)} ${line('REMOVE', 50, 100)} ET`), {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 600, 800], Resources: { Font: { F1: fontRef } },
    }));
    return ctx.obj({ XObject: { Child: child } });
  } });
  const before = await inspect(await f.out.save(), true);
  await stripHiddenText(f.out, f.embedded);
  const after = await inspect(await f.out.save(), true);
  assert.deepEqual(after.pixels, before.pixels);
  const child = f.root().dict.lookup(key('Resources')).lookup(key('XObject')).lookup(key('Child'));
  assert.match(text(read(child)), /KEEP/);
  assert.doesNotMatch(text(read(child)), /REMOVE/);
  assert.equal(text(read(f.root())).trim(), '/Child Do q 1 0 0 1 0 -300 cm /Child Do Q');
});

test('이미지 XObject·순환 Form·깊이 제한은 원본 보존', async () => {
  const f = await fixture('/Image Do /Cycle Do /Deep Do', { resources: (ctx) => {
    const image = ctx.register(ctx.stream(bytes(') Tj'), { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
    const cycle = ctx.flateStream(bytes('/Self Do'), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 600, 800] });
    const ref = ctx.register(cycle);
    cycle.dict.set(key('Resources'), ctx.obj({ XObject: { Self: ref } }));
    let deep = ref;
    for (let i = 0; i < 12; i++) deep = ctx.register(ctx.flateStream(bytes('/Next Do'), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 600, 800], Resources: { XObject: { Next: deep } } }));
    return ctx.obj({ XObject: { Image: image, Cycle: ref, Deep: deep } });
  } });
  const original = f.root();
  await stripHiddenText(f.out, f.embedded);
  assert.equal(f.root(), original);
});

test('gs의 글꼴 변경과 q/Q의 글자 상태 복원', async () => {
  const f = await fixture(`BT /F1 20 Tf q /GS gs ${line('UNKNOWN', 50, 700)} Q ${line('REMOVE', 50, 700)} ${line('VISIBLE', 50, 400)} ET`, { resources: (ctx, fontRef) => {
    const unknown = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
    return ctx.obj({ Font: { F1: fontRef }, ExtGState: { GS: { Font: [unknown, 30] } } });
  } });
  await stripHiddenText(f.out, f.embedded);
  const result = text(read(f.root()));
  assert.match(result, /UNKNOWN/);
  assert.match(result, /VISIBLE/);
  assert.doesNotMatch(result, /REMOVE/);
});

test('깨진 문자열·배열·사전·인라인 이미지·연산 피연산자는 예외', () => {
  for (const source of ['(abc', '(abc\\', '<zz>', '<ab', '[1 (a)', '<< /A (a)', 'BI /W 3 ID ) Tj', 'BT /F1 Tf ET', 'Q', 'BT (a) TJ ET', 'BT /F1 10 Tf', '12']) {
    assert.throws(() => filter(source), /PDF/ , source);
  }
});

test('중첩 파싱 실패: 앞의 삭제·자식 복제도 반영하지 않음', async () => {
  const f = await fixture(`BT /F1 20 Tf ${line('HIDDEN', 50, 700)} ET /Good Do /Bad Do`, { resources: (ctx, fontRef) => {
    const form = (source) => ctx.register(ctx.flateStream(bytes(source), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 600, 800], Resources: { Font: { F1: fontRef } } }));
    return ctx.obj({ Font: { F1: fontRef }, XObject: { Good: form(`BT /F1 20 Tf ${line('CHILD', 50, 700)} ET`), Bad: form('BT (broken') } });
  } });
  const root = f.root(), original = read(root).slice();
  const count = f.out.context.enumerateIndirectObjects().length;
  await assert.rejects(stripHiddenText(f.out, f.embedded), /PDF/);
  assert.equal(f.root(), root);
  assert.deepEqual(read(f.root()), original);
  assert.equal(f.out.context.enumerateIndirectObjects().length, count);
});

test('exporter: 실패 경고 후 원본 벡터 스트림 유지, 다음 문항은 계속 정리', async (t) => {
  const f = await fixture('BT /F1 20 Tf 1 0 0 1 50 700 Tm (broken');
  const sourceBytes = await f.src.save();
  const src = { pages: [{ kind: 'pdf', fileIndex: 0, pageIndex: 0, w: 600, h: 800 }],
    getFileBytes: async () => sourceBytes, renderRegion: () => assert.fail('래스터 대체 금지') };
  const good = await fixture(`BT /F1 20 Tf ${line('HIDDEN', 50, 700)} ${line('VISIBLE', 50, 400)} ET`);
  const goodBytes = await good.src.save();
  const goodSrc = { ...src, getFileBytes: async () => goodBytes };
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  // 머리글용 캔버스만 대체. 문항 벡터 경로는 실제 실행.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ measureText: (s) => ({ width: s.length * 5 }), fillText() {} }), toBlob: (fn) => fn(new Blob([png])) }) };
  t.after(() => { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; });
  const blocks = [src, goodSrc].map((source) => ({ kind: 'problem', src: source, item: { rects: [{ page: 0, x: 0, y: 0.4625, w: 1, h: 0.0625 }] } }));
  const data = await buildPdf({ blocks, options: { space: 'none' } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /원본 유지/);
  const result = await PDFDocument.load(data);
  const forms = result.context.enumerateIndirectObjects().map(([, object]) => object).filter((object) => object instanceof PDFRawStream && object.dict.get(key('Subtype')) === key('Form'));
  assert.ok(forms.some((form) => text(read(form)).includes('(broken')));
  assert.ok(forms.some((form) => text(read(form)).includes('(VISIBLE)') && !text(read(form)).includes('(HIDDEN)')));
});
