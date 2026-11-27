import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildHwpx, blockSegs } from '../../src/renderer/js/hwpx.js';
import { itemName, CONVERT_MODES } from '../../src/renderer/js/exporter.js';
import { transcriptKey, pickTranscript, trimTranscripts } from '../../src/renderer/js/transcript-store.js';
import { countLow } from '../../src/renderer/js/lowconf.js';

const source = readFileSync(new URL('../../src/renderer/js/transcribe.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '').replace(/^export \{.*;\r?$/gm, '').replace(/\bexport /g, '');
const para = (text) => ({ type: 'para', text });
const success = () => ({ blocks: [para('합성 문항')], reliable: true, reasons: [] });
const plain = (value) => JSON.parse(JSON.stringify(value));

function element(tag, attrs, ...children) {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs) || attrs.tag) {
    children.unshift(attrs); attrs = {};
  }
  return {
    tag, dataset: {}, style: {}, textContent: '', ...attrs, children: children.flat().filter(Boolean),
    querySelector(selector) {
      return this.children.find((c) => typeof c === 'object' && c.tag.includes(selector))
        || this.children.flatMap((c) => typeof c === 'object' ? [c.querySelector(selector)] : []).find(Boolean);
    },
    scrollIntoView() {},
  };
}

function fixture({ scan = success, ai = false, ocr = true, respond, initial = {}, pdf = null, crop, render, background = false } = {}) {
  const toastOptions = [];
  const renders = [], delays = [], statusCalls = [], aiCalls = [];
  const calls = [], saves = [], dialogs = [], toasts = [], pictures = [], warnings = [];
  const src = { pages: [{ w: 600, h: 800 }], files: ['synthetic.pdf'], getMathLayer: async () => pdf ? {} : null };
  const block = (number, kind = 'problem', extra = {}) => ({
    kind, role: kind, src, item: { id: `${kind}-${number}`, number: String(number), rects: [{ page: 0, x: 0, y: 0, w: 1, h: 0.2 }] }, ...extra,
  });
  const context = {
    h: element, toast: (msg, opts) => { toasts.push(msg); toastOptions.push(opts); }, itemName, CONVERT_MODES, blockSegs, transcriptKey, pickTranscript, trimTranscripts, countLow,
    buildHwpx: (opts) => buildHwpx({ ...opts, renderSeg: async (seg) => {
      pictures.push(seg.block.item.id);
      return { ext: 'png', bytes: new Uint8Array([137, 80, 78, 71]), pxW: 600, pxH: 160 };
    } }),
    renderStack: async (segs) => { renders.push(segs[0].block.item.id); return render ? render(segs) : { block: segs[0].block, width: 600, height: 160 }; },
    cropImage: crop || (async () => ({ ext: 'png', bytes: new Uint8Array([137, 80, 78, 71]), pxW: 20, pxH: 20 })),
    scanTranscribe: async (canvas, opts) => { calls.push(canvas.block.item.id); return scan(canvas, opts); },
    geminiTranscribeBatch: async (images) => { aiCalls.push(...images); return respond ? respond(images) : images.map(() => [para('AI 합성 문항')]); },
    canvasToBase64Jpeg: (canvas) => canvas.block.item.id,
    groupMathReview: (list) => list, transcribeParts: (parts) => typeof pdf === 'function' ? pdf(parts) : pdf,
    subjectOf: () => 'math',
    api: {
      getTranscripts: async () => ({ items: initial }),
      saveTranscripts: async (_bookId, data) => { saves.push(plain(data)); return true; },
      mathocrStatus: async () => { statusCalls.push(true); return { installed: ocr }; },
    },
    state: {}, nav: {}, geminiReady: () => ai, aiOff: () => false,
    aiOptions: () => ({ batch: 2, concurrency: 1 }), aiLabel: () => 'AI', aiModelText: () => '합성 모델',
    restartSaveHooks: new Set(), restartPendingChecks: new Set(), holdSource: () => () => {},
    jobDialog: (opts) => {
      const dialog = { ...opts, closes: 0, results: [], job: { progress() {} },
        finish(r) { this.results.push(r); return background; }, close() { this.closes++; } };
      dialogs.push(dialog); return dialog;
    },
    setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(fn, 0); }, clearTimeout,
    AbortController, DOMException, Error, console: { warn: (...args) => warnings.push(args) },
  };
  const exports = runInNewContext(`${source}\n;({ exportHwpx, retryScan, fallbackSummary, fallbackHint: typeof fallbackHint === 'function' ? fallbackHint : undefined })`, context);
  return {
    ...exports, block, src, renders, delays, statusCalls, aiCalls, toastOptions, calls, saves, dialogs, toasts, pictures, warnings,
    async run(blocks, options = {}) {
      return exports.exportHwpx(blocks, [{ bookId: 'synthetic-book', bookObj: {}, src: { problem: src, answer: src } }],
        { convert: 'ocr', ...options }, {}, { key: 'synthetic', sig: 'synthetic' });
    },
  };
}

async function exportFromView(view, f, blocks, entries, options = {}) {
  const viewSource = readFileSync(new URL(`../../src/renderer/js/${view}.js`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const name = view === 'noteview' ? 'buildExportHeld' : 'buildBankExport';
  const start = viewSource.indexOf(`async function ${name}(`);
  const body = viewSource.slice(start, viewSource.indexOf('\n}', start) + 2);
  const messages = [], savedBytes = [], exported = [];
  const opts = { format: 'hwpx', convert: 'ocr', ...options };
  const context = {
    ns: { note: { id: 'synthetic-note', exportOptions: opts }, sources: new Map(entries.map((e) => [e.bookId, e.src])) },
    allEntries: () => entries, bs: { opts, picked: entries }, state: { appInfo: {} },
    api: {
      listBooks: async () => entries.map((e) => e.bookObj), ensureBookFiles: async () => ({ ok: true }),
      saveFile: async ({ data }) => { savedBytes.push(data); return { path: 'synthetic.hwpx' }; },
    },
    getSources: async (book) => entries.find((e) => e.bookId === book.id).src,
    subjectOpen: () => true, orderPicked: () => entries, holdSource: () => () => {}, attachAnswers: async () => {},
    makeBlocks: () => blocks, makeBankBlocks: () => blocks, pageLabel: () => '',
    examInfo: () => ({}), exportSig: () => 'synthetic', findJob: () => null, exportRuns: 0,
    document: { querySelector: () => null }, exporting: new Map(), exportDone() {},
    exportHwpx: async (...args) => { const bytes = await f.exportHwpx(...args); exported.push(bytes); return bytes; },
    fallbackSummary: f.fallbackSummary, bestTranscript: () => null, countLow, exportReviewCount: () => 0,
    pendingExports: view === 'noteview' ? new Map() : new Set(),
    restartGuard: { report() {}, track: (_key, run) => run() }, attempt: (run) => run(),
    toast: (message) => { messages.push(message); return () => {}; }, fail: (err) => { throw err; },
    console: { error: (err) => { throw err; } },
  };
  const run = runInNewContext(`${body}; ${name}`, context);
  await run('problems', []);
  return { messages, savedBytes, bytes: exported[0] };
}

function viewEntries(f, digital = false) {
  const entry = (bookId, src) => ({ bookId, bookObj: { id: bookId, docs: { problem: {}, answer: {} } }, src: { problem: src, answer: src } });
  const entries = [entry('synthetic-book', f.src)];
  if (digital) entries.push(entry('synthetic-digital', {
    pages: f.src.pages, files: ['synthetic-digital.pdf'],
    getMathLayer: async () => ({ blocks: [{ type: 'figure', box: { x: 0, y: 0, w: 1, h: 1 } }] }),
  }));
  return entries;
}

test('OCR 예외: 실제 HWPX 그림과 실패 목록·행·완료 요약, 실패 저장 없음', async () => {
  const f = fixture({ scan: async () => { throw new Error('합성 OCR 실패'); } });
  const b = f.block(12);
  const bytes = await f.run([b]);
  assert.deepEqual(bytes.stats, { text: 0, picture: 1 });
  assert.deepEqual(plain(bytes.fallbacks), [{ bookId: 'synthetic-book', role: 'problem', itemId: b.item.id, name: '문제 12번', reason: '합성 OCR 실패' }]);
  assert.deepEqual(f.pictures, [b.item.id]);
  assert.equal(f.saves.length, 0);
  const body = f.dialogs[0].body;
  assert.equal(body.querySelector('.gem-msg').textContent, '합성 OCR 실패 → 그림으로');
  const summary = body.querySelector('.gem-summary');
  assert.equal(summary.hidden, false);
  assert.equal(summary.tag, 'p.small.gem-summary');
  assert.equal(summary.textContent, '1문항은 글자로 옮기지 못해 그림으로 넣었어요: 문제 12번. 다시 내보내면 다시 시도해요.');
  bytes.job.finish({ message: '완료' });
  assert.equal(f.dialogs[0].closes, 0, '실패 요약은 닫기 전까지 남음');
});

test('빈 OCR 결과와 내용 없는 블록도 그림으로 알리고 저장하지 않음', async () => {
  for (const blocks of [[], [para('   ')], [{ type: 'math', latex: '' }], [{ type: 'unknown' }]]) {
    const f = fixture({ scan: async () => ({ ...success(), blocks }) });
    const bytes = await f.run([f.block(1, 'answer')]);
    assert.equal(bytes.stats.picture, 1);
    assert.equal(bytes.fallbacks.length, 1);
    assert.equal(bytes.fallbacks[0].name, '해설 1번');
    assert.match(bytes.fallbacks[0].reason, /읽은 내용이 없음|한글 문서에 넣을 내용이 없음/);
    assert.ok(f.saves.every((data) => Object.keys(data.items).length === 0));
  }
});

test('성공한 OCR·AI·PDF 결과와 디지털 PDF 안 그림은 실패 목록에 없음', async () => {
  for (const options of [{}, { ai: true }, { pdf: [para('PDF 글자')] }, { pdf: [{ type: 'figure', box: { x: 0, y: 0, w: 1, h: 1 } }] }]) {
    const f = fixture(options);
    const bytes = await f.run([f.block(1)], options.ai ? { convert: 'ai' } : {});
    assert.deepEqual(plain(bytes.fallbacks), []);
    assert.equal(bytes.stats.text, 1);
    bytes.job?.finish({ message: '완료' });
    assert.ok(f.dialogs.every((d) => d.closes === 1), '성공하면 기존처럼 창 닫음');
  }
});

test('인식 수단 없음·설정상 쓰지 않는 수단·원본 영역 없음은 실패가 아님', async () => {
  for (const mode of ['ocr', 'ai', 'mix']) {
    const f = fixture({ ocr: false, ai: false });
    const bytes = await f.run([f.block(1), f.block(2, 'problem', { item: { id: 'no-region', rects: [] } })], { convert: mode });
    assert.deepEqual(plain(bytes.fallbacks), []);
    assert.equal(bytes.stats.picture, 1);
    assert.equal(f.toasts.length, 1, '기존 설정 안내 유지');
    assert.equal(f.dialogs.length, 0);
  }
});

test('AI 실패·빈 결과는 목록에 넣지만 OCR 결과가 남으면 실패 그림이 아님', async () => {
  for (const result of [new Error('합성 AI 실패'), []]) {
    const f = fixture({ ai: true, ocr: false, respond: (images) => images.map(() => result) });
    const bytes = await f.run([f.block(3)], { convert: 'ai' });
    assert.equal(bytes.fallbacks.length, 1);
    assert.equal(bytes.stats.picture, 1);
    assert.equal(f.saves.length, 0);
  }
  const f = fixture({ ai: true, scan: () => ({ ...success(), reliable: false, reasons: ['합성 확인'] }), respond: (images) => images.map(() => new Error('합성 AI 실패')) });
  const bytes = await f.run([f.block(3)], { convert: 'mix' });
  assert.deepEqual(plain(bytes.fallbacks), []);
  assert.equal(bytes.stats.text, 1);
});

test('OCR 실패 뒤 AI 성공은 실패 목록에 없음', async () => {
  const f = fixture({ ai: true, scan: () => { throw new Error('합성 OCR 실패'); } });
  const bytes = await f.run([f.block(3)], { convert: 'mix' });
  assert.deepEqual(plain(bytes.fallbacks), []);
  assert.equal(bytes.stats.text, 1);
});

test('다시 내보내기: 실패한 스캔만 재인식, 성공한 스캔은 저장 결과 재사용', async () => {
  let fail = true;
  const f = fixture({ scan: (canvas) => {
    if (fail && canvas.block.item.number === '2') throw new Error('합성 실패');
    return success();
  } });
  const blocks = [f.block(1), f.block(2)];
  const first = await f.run(blocks);
  assert.equal(first.fallbacks.length, 1);
  assert.deepEqual(Object.keys(f.saves.at(-1).items), [`${transcriptKey(blocks[0])}|local`]);
  fail = false;
  const second = await f.run(blocks);
  assert.deepEqual(f.calls, ['problem-1', 'problem-2', 'problem-2', 'problem-2']);
  assert.deepEqual(plain(second.fallbacks), []);
  assert.deepEqual(second.stats, { text: 2, picture: 0 });
});

test('내용 없는 저장 결과도 실패 목록에 넣고 자동 결과만 지워 재시도', async () => {
  const initial = {};
  const f = fixture({ initial });
  const b = f.block(4);
  initial[`${transcriptKey(b)}|local`] = { blocks: [para(' ')], model: 'ocr', reliable: true };
  const first = await f.run([b]);
  assert.equal(first.stats.picture, 1);
  assert.equal(first.fallbacks.length, 1);
  assert.equal(f.dialogs.length, 0, '저장 결과만으로 끝나면 늦게 창을 열지 않음');
  assert.equal(first.job, null);
  assert.deepEqual(f.saves.at(-1).items, {});
  const second = await f.run([b]);
  assert.equal(second.stats.text, 1);
  assert.deepEqual(f.calls, ['problem-4']);
});

test('요약: 0개·3개·여러 개 줄임과 같은 문항 표시 이름', () => {
  const f = fixture();
  const names = [f.block(12), f.block(15), f.block(3, 'answer'), f.block(4), f.block(5)]
    .map((b) => ({ name: `${b.kind === 'answer' ? '해설' : '문제'} ${itemName(b.item)}` }));
  assert.equal(f.fallbackSummary([]), '');
  assert.equal(f.fallbackSummary(names.slice(0, 3)), '3문항은 글자로 옮기지 못해 그림으로 넣었어요: 문제 12번, 문제 15번, 해설 3번.');
  assert.equal(f.fallbackSummary(names), '5문항은 글자로 옮기지 못해 그림으로 넣었어요: 문제 12번, 문제 15번, 해설 3번 외 2개.');
});

test('뒤에서 완료하면 실패 요약을 남기고 기존 finish 알림을 전달', async () => {
  const f = fixture({ background: true, scan: () => { throw new Error('합성 실패'); } });
  const bytes = await f.run([f.block(1)]);
  const message = `준비 완료 · ${f.fallbackSummary(bytes.fallbacks)}`;
  assert.equal(bytes.job.finish({ message }), true);
  assert.equal(f.dialogs[0].results[0].message, message);
});

test('실제 스캔 경로: 수식 API 실패·예외와 글자 읽기 예외를 합성해 그림 전환 확인', async () => {
  const scanSource = readFileSync(new URL('../../src/renderer/js/scanocr.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace('export async function', 'async function');
  for (const failure of ['math-result', 'math-throw', 'text-throw']) {
    let mathCalls = 0;
    const scan = runInNewContext(`${scanSource}; scanTranscribe`, {
      recognizeWords: async () => { if (failure === 'text-throw') throw new Error('합성 글자 읽기 실패'); return []; },
      planScan: () => ({ formulas: [{}] }), cropFormula: () => ({}), Error, DOMException,
    });
    const f = fixture({ scan: (canvas, opts) => scan({ ...canvas, getContext: () => ({ getImageData: () => ({}) }) }, {
      ...opts, api: { mathocrRecognize: async () => {
        mathCalls++;
        if (failure === 'math-throw') throw new Error('합성 수식 인식 실패');
        return { ok: false };
      } },
    }) });
    const bytes = await f.run([f.block(1)]);
    assert.equal(bytes.stats.picture, 1);
    assert.equal(bytes.fallbacks.length, 1);
    assert.equal(mathCalls, failure === 'text-throw' ? 0 : 2);
    assert.equal(bytes.fallbacks[0].reason, { 'math-result': '수식을 인식하지 못했어요.', 'math-throw': '합성 수식 인식 실패', 'text-throw': '합성 글자 읽기 실패' }[failure]);
    assert.equal(f.saves.length, 0);
  }
});

test('그림 자르기 예외는 까닭을 남기되 내용 있는 자동 결과는 보존', async () => {
  const blocks = [{ type: 'figure', box: { x: 0, y: 0, w: 1, h: 1 } }];
  for (const mode of ['ocr', 'ai', 'pdf']) {
    const f = fixture({ scan: () => ({ ...success(), blocks }), ai: mode === 'ai', respond: (images) => images.map(() => blocks),
      pdf: mode === 'pdf' ? blocks : null, crop: async () => { throw new Error('합성 그림 자르기 실패'); } });
    const bytes = await f.run([f.block(1)], { convert: mode === 'ai' ? 'ai' : 'ocr' });
    assert.equal(bytes.stats.picture, 1);
    assert.equal(bytes.fallbacks[0].reason, '합성 그림 자르기 실패');
    assert.equal(Object.keys(f.saves.at(-1).items).length, 1);
    assert.equal(Object.values(f.saves.at(-1).items)[0].blocks[0].type, 'figure');
  }
});

test('원격 AI의 메모리 오류에는 이 컴퓨터의 프로그램을 닫으라는 안내 없음', async () => {
  const f = fixture({ ai: true, ocr: false, respond: (images) => images.map(() => new Error('out of memory')) });
  const bytes = await f.run([f.block(1)], { convert: 'ai' });
  assert.equal(bytes.fallbacks.length, 1);
  assert.equal(bytes.fallbacks[0].hint, undefined);
  assert.equal(f.fallbackSummary(bytes.fallbacks).includes('다른 프로그램'), false);
});

test('확실한 메모리 부족만 안내하고 일반 오류·자원 부족은 추측하지 않음', async () => {
  const { fallbackHint } = fixture();
  for (const err of [Object.assign(new Error(''), { name: 'OutOfMemoryError' }), new Error('out of memory'),
    new Error('RuntimeError: Not enough memory for the image buffer'), new Error('메모리가 부족합니다')]) {
    assert.equal(fallbackHint(err), '다른 프로그램을 닫고 다시 해 보세요.');
  }
  for (const err of [new RangeError('Invalid typed array length'), new Error('Array buffer allocation failed'),
    new Error('insufficient resources'), new Error('메모리 상태를 알 수 없음'), new Error('합성 실패'),
    new Error('not out of memory'), new Error('out of memory 여부를 알 수 없음'), null]) {
    assert.equal(fallbackHint(err), '');
  }
  const f = fixture({ scan: () => { throw new Error('out of memory'); } });
  const bytes = await f.run([f.block(1), f.block(2)]);
  assert.ok(f.fallbackSummary(bytes.fallbacks).endsWith('다른 프로그램을 닫고 다시 해 보세요.'));
  assert.equal((f.fallbackSummary(bytes.fallbacks).match(/다른 프로그램/g) || []).length, 1);
  assert.equal(f.saves.length, 0);
});

test('내용 없는 OCR·AI·PDF 자동 결과만 지우고 저장된 성공 결과는 보존', async () => {
  for (const mode of ['ocr', 'ai', 'pdf']) {
    const initial = {};
    const f = fixture({ initial, ai: mode === 'ai', pdf: mode === 'pdf' ? [para(' ')] : null });
    const b = f.block(1), good = f.block(2);
    const suffix = { ocr: '|local', ai: '', pdf: '|pdf' }[mode];
    const key = transcriptKey(b) + suffix, goodKey = transcriptKey(good) + '|local';
    initial[key] = { blocks: [para(' ')], model: mode, reliable: true };
    initial[goodKey] = { blocks: [para('보존할 글')], model: 'ocr', reliable: true };
    const bytes = await f.run([b], { convert: mode === 'ai' ? 'ai' : 'ocr' });
    assert.equal(bytes.fallbacks.length, 1);
    assert.equal(f.dialogs.length, 0);
    assert.equal(f.saves.at(-1).items[key], undefined);
    assert.equal(f.saves.at(-1).items[goodKey].blocks[0].text, '보존할 글');
  }
});

test('사람이 고친 내용 없는 결과는 알리되 편집 원문은 지우지 않음', async () => {
  const initial = {};
  const f = fixture({ initial });
  const b = f.block(1);
  const key = `${transcriptKey(b)}|edit`;
  initial[key] = { blocks: [para(' ')], model: 'edit' };
  const bytes = await f.run([b]);
  assert.equal(bytes.stats.picture, 1);
  assert.equal(bytes.fallbacks.length, 1);
  assert.ok(initial[key]);
  assert.equal(f.saves.length, 0);
});

test('취소는 그림 전환이나 실패 저장 없이 그대로 전달', async () => {
  const f = fixture({ scan: () => { throw new DOMException('합성 취소', 'AbortError'); } });
  await assert.rejects(f.run([f.block(1)]), { name: 'AbortError' });
  assert.deepEqual(f.pictures, []);
  assert.equal(f.saves.length, 0);
  assert.equal(f.dialogs[0].closes, 1);
});

test('요약 이름·순서: 문제·해설·지문은 창의 itemName 표시와 같음', async () => {
  const f = fixture({ scan: async () => { throw new Error('합성 실패'); } });
  const blocks = [f.block(3, 'answer'), f.block(1), f.block(2)];
  blocks[1].item.prefix = '예제';
  blocks[2].item.passage = true;
  const bytes = await f.run(blocks);
  assert.deepEqual(plain(bytes.fallbacks.map((f) => f.name)), ['해설 3번', '문제 예제 1', itemName(blocks[2].item)]);
});

test('노트·문제은행 내보내기: 실패만 그림·알림에 포함, 도형·디지털 그림 제외, 실패 0이면 안내 없음', async () => {
  for (const view of ['noteview', 'bankview']) for (const failed of [false, true]) for (const background of [false, true]) {
    const f = fixture({ background, pdf: (parts) => parts[0].layer.blocks || null, scan: (canvas) => {
      if (failed && canvas.block.item.number === '12') throw new Error('합성 OCR 실패');
      return { ...success(), blocks: [para('합성 글과 도형'), { type: 'figure', box: { x: 0, y: 0, w: 0.5, h: 0.5 } }] };
    } });
    const entries = viewEntries(f, true);
    const blocks = [f.block(12), f.block(13), f.block(14, 'problem', { src: entries[1].src.problem })];
    const result = await exportFromView(view, f, blocks, entries);
    assert.ok(result.bytes, `${view}: 실제 exportHwpx 완료`);
    assert.deepEqual(result.bytes.stats, { text: failed ? 2 : 3, picture: failed ? 1 : 0 });
    assert.deepEqual(f.pictures, failed ? ['problem-12'] : []);
    assert.deepEqual(plain(result.bytes.fallbacks.map((f) => f.name)), failed ? ['문제 12번'] : []);
    const finish = f.dialogs[0].results[0];
    if (background) {
      assert.equal(result.savedBytes.length, 0);
      assert.equal(finish.actions[0].label, '저장하기');
      await finish.actions[0].onClick();
    }
    assert.equal(result.savedBytes.length, 1);
    assert.equal(result.savedBytes[0], result.bytes, '실제 HWPX 바이트 저장 경로');
    const messages = [finish.message, ...result.messages];
    const notices = messages.filter((msg) => msg.includes('글자로 옮기지 못해'));
    assert.equal(notices.length, failed ? 2 : 0, '실패 0이면 완료·저장 모두 실패 안내 없음');
    for (const notice of notices) {
      assert.ok(notice.includes('1문항은 글자로 옮기지 못해 그림으로 넣었어요: 문제 12번.'));
      assert.equal((notice.match(/그림으로/g) || []).length, 1, '같은 알림에 중복 없음');
      assert.equal(notice.includes('문제 13번'), false);
      assert.equal(notice.includes('문제 14번'), false);
      assert.equal(notice.includes('다른 프로그램'), false, '원인 불명 오류에 추측 안내 없음');
    }
    assert.equal(f.dialogs[0].body.querySelector('.gem-summary').hidden, !failed);
  }
});

test('노트·문제은행 내보내기: noConvertToast의 원래 그림은 실패 알림에 포함하지 않음', async () => {
  for (const view of ['noteview', 'bankview']) {
    const f = fixture({ ocr: false, pdf: (parts) => parts[0].layer.blocks || null });
    const entries = viewEntries(f, true);
    const blocks = [f.block(1), f.block(2), f.block(3, 'problem', { src: entries[1].src.problem })];
    const result = await exportFromView(view, f, blocks, entries);
    assert.deepEqual(result.bytes.stats, { text: 1, picture: 2 });
    assert.deepEqual(plain(result.bytes.fallbacks), []);
    assert.deepEqual(f.pictures, ['problem-1', 'problem-2']);
    assert.equal(f.dialogs.length, 0);
    assert.equal(f.toasts.length, 1, '기존 인식 설정 안내는 유지');
    assert.equal(result.messages.some((msg) => msg.includes('글자로 옮기지 못해')), false);
    assert.equal(result.savedBytes.length, 1);
  }
});

test('노트·문제은행 저장 알림: 저장 결과가 그림이 되어도 늦은 창 없이 실패 요약 표시', async () => {
  for (const view of ['noteview', 'bankview']) {
    const initial = {};
    const f = fixture({ initial });
    const b = f.block(12);
    initial[`${transcriptKey(b)}|local`] = { blocks: [para(' ')], model: 'ocr', reliable: true };
    const result = await exportFromView(view, f, [b], viewEntries(f));
    assert.deepEqual(result.bytes.stats, { text: 0, picture: 1 });
    assert.deepEqual(f.pictures, ['problem-12']);
    assert.equal(f.dialogs.length, 0);
    assert.equal(result.bytes.job, null);
    const saved = result.messages.find((msg) => msg.startsWith(view === 'noteview' ? '저장했어요' : '저장 완료'));
    assert.ok(saved.includes('1문항은 글자로 옮기지 못해 그림으로 넣었어요: 문제 12번.'));
    assert.equal((saved.match(/그림으로/g) || []).length, 1);
    assert.equal(result.savedBytes.length, 1);
  }
});

test('노트·문제은행 저장 알림: 합성한 로컬 메모리 부족 오류에만 도움말 표시', async () => {
  for (const view of ['noteview', 'bankview']) {
    const f = fixture({ scan: () => { throw new Error('out of memory'); } });
    const result = await exportFromView(view, f, [f.block(12)], viewEntries(f));
    const saved = result.messages.find((msg) => msg.startsWith(view === 'noteview' ? '저장했어요' : '저장 완료'));
    assert.ok(saved.includes('1문항은 글자로 옮기지 못해 그림으로 넣었어요: 문제 12번. 다른 프로그램을 닫고 다시 해 보세요.'));
    assert.equal((saved.match(/다른 프로그램/g) || []).length, 1);
    assert.equal(result.bytes.stats.picture, 1);
  }
});

test('retry scan or render once', async () => {
  for (const stage of ['scan', 'render']) {
    let attempts = 0;
    const f = fixture(stage === 'scan' ? { scan: () => {
      if (++attempts === 1) throw new Error('temporary scan');
      return success();
    } } : { render: (segs) => {
      if (++attempts === 1) throw new Error('temporary render');
      return { block: segs[0].block, width: 600, height: 160 };
    } });
    const bytes = await f.run([f.block(1)]);
    assert.deepEqual(bytes.stats, { text: 1, picture: 0 });
    assert.deepEqual(f.renders, ['problem-1', 'problem-1']);
    assert.deepEqual(f.delays, [1000]);
    assert.equal(attempts, 2);
  }
});

test('persistent failure and cancellation', async () => {
  const f = fixture({ scan: () => { throw new Error('persistent scan'); } });
  const bytes = await f.run([f.block(1)]);
  assert.deepEqual(f.calls, ['problem-1', 'problem-1']);
  assert.equal(bytes.stats.picture, 1);
  assert.equal(bytes.fallbacks[0].reason, 'persistent scan');
  for (const stage of ['scan', 'render']) {
    const fail = () => { throw new DOMException('cancel', 'AbortError'); };
    const f = fixture(stage === 'scan' ? { scan: fail } : { render: fail });
    await assert.rejects(f.run([f.block(1)]), { name: 'AbortError' });
    assert.equal(f.renders.length, 1);
    assert.deepEqual(f.delays, []);
  }
});

test('AI unavailable uses local OCR', async () => {
  const f = fixture();
  const bytes = await f.run([f.block(1), f.block(2)], { convert: 'ai' });
  assert.deepEqual(bytes.stats, { text: 2, picture: 0 });
  assert.equal(f.statusCalls.length, 1);
  assert.deepEqual(f.toasts, ['정밀 인식을 쓸 수 없어서 이 컴퓨터에서 옮겨요.']);
  assert.equal(f.toastOptions[0].actions[0].label, '설정 열기');
  assert.deepEqual(f.aiCalls, []);
});

test('AI failure uses OCR only for failed items', async () => {
  for (const reliable of [true, false]) {
    const f = fixture({ ai: true,
      respond: (images) => images.map((id) => id === 'problem-1' ? [para('AI success')] : new Error('AI failure')),
      scan: () => ({ ...success(), reliable, reasons: reliable ? [] : ['검토'] }),
    });
    const bytes = await f.run([f.block(1), f.block(2), f.block(3)], { convert: 'ai' });
    assert.deepEqual(bytes.stats, { text: 3, picture: 0 });
    assert.deepEqual(f.calls, ['problem-2', 'problem-3']);
    assert.equal(f.statusCalls.length, 1);
    assert.deepEqual(plain(bytes.fallbacks), []);
    const rows = f.dialogs[0].body.querySelector('div.gem-list').children;
    assert.equal(rows[1].dataset.state, 'ok');
    assert.equal(rows[1].querySelector('.gem-path').dataset.path, 'OCR');
    assert.equal(rows[1].querySelector('.gem-msg').textContent.includes('확인 필요'), !reliable);
  }
  const f = fixture({ ai: true });
  await f.run([f.block(1)], { convert: 'ai' });
  assert.equal(f.statusCalls.length, 0);
});

test('OCR only never sends externally', async () => {
  const f = fixture({ ai: true, ocr: false });
  const bytes = await f.run([f.block(1)], { convert: 'ocr' });
  assert.equal(bytes.stats.picture, 1);
  assert.deepEqual(f.aiCalls, []);
  assert.deepEqual(f.calls, []);
  assert.equal(f.toasts.length, 1);
  assert.match(f.toasts[0], /수식 인식 모델.*그림으로/);
});


test('cancellation during retry delay stops before second attempt', async () => {
  const f = fixture(), controller = new AbortController();
  let attempts = 0;
  const run = f.retryScan(async () => { attempts++; throw new Error('temporary'); }, controller.signal);
  for (let i = 0; i < 20 && !f.delays.length; i++) await Promise.resolve();
  assert.deepEqual(f.delays, [1000]);
  controller.abort();
  await assert.rejects(run, { name: 'AbortError' });
  assert.equal(attempts, 1);
  assert.deepEqual(f.delays, [1000]);
});

test('AI failure reuses stored local result and does not retry empty OCR', async () => {
  const initial = {};
  const f = fixture({ ai: true, initial, respond: (images) => images.map(() => new Error('AI failed')) });
  const b = f.block(1);
  initial[`${transcriptKey(b)}|local`] = { ...success(), model: 'ocr' };
  const bytes = await f.run([b], { convert: 'ai' });
  assert.equal(bytes.stats.text, 1);
  assert.deepEqual(f.calls, []);
  const empty = fixture({ ai: true, respond: (images) => images.map(() => []), scan: () => ({ ...success(), blocks: [] }) });
  const result = await empty.run([empty.block(1)], { convert: 'ai' });
  assert.equal(result.stats.picture, 1);
  assert.equal(result.fallbacks[0].reason, '읽은 내용이 없음');
  assert.equal(empty.calls.length, 1);
  assert.deepEqual(empty.delays, []);
});
