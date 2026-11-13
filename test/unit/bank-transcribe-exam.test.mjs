import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { countLow } from '../../src/renderer/js/lowconf.js';
import { examScanEntry } from '../../src/renderer/js/mockexam-save.js';
const source = readFileSync(new URL('../../src/renderer/js/bank-transcribe.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('const OCR_MAX_SIDE')).replace('export ', '');

test('모의고사 일괄: OCR 한계를 넘는 문항 그림은 읽지 않고 확인 표시만 남기고 다음 문항 계속', async () => {
  // 1번 세로·3번 가로가 한계를 넘고, 2번은 딱 한계라 읽는다.
  const sizes = { q1: [1500, 49696], q2: [1500, 32767], q3: [32768, 40] };
  const items = Object.keys(sizes).map((id, i) => ({ id, number: i + 1 }));
  const canvases = {}, ocr = [], events = [];
  const store = { items: {} };
  const transcribeExam = runInNewContext(`${body}; transcribeExam`, {
    getSources: async () => ({ problem: {} }), loadTranscripts: async () => store, saveTranscripts: async () => true,
    saveExamTranscripts: async (save) => save(), bankTargets: () => items.map((item) => ({ item })),
    transcriptKey: (b) => b.item.id, bestTranscript: (_id, b) => (store.items[`${b.item.id}|local`] ? { entry: store.items[`${b.item.id}|local`] } : null),
    pdfTranscribe: async () => null, blockSegs: (b) => b.item.id, subjectOf: () => 'english', TRANSCRIBE_WIDTH: 1500,
    renderStack: async (id) => (canvases[id] = { width: sizes[id][0], height: sizes[id][1] }),
    scanTranscribe: async (canvas) => { ocr.push(canvas); return { blocks: [{ type: 'para', text: '합성 글' }] }; },
    itemName: (item) => `${item.number}번`, examScanEntry, countLow, api: {},
  });
  const low = await transcribeExam({ id: 'synthetic' }, { onProgress: (p) => events.push(p) });
  assert.deepEqual(ocr, [canvases.q2]);
  assert.deepEqual(JSON.parse(JSON.stringify(events.filter((p) => p.phase === 'ocr-skip'))), [
    { phase: 'ocr-skip', item: '1번', size: '1500x49696' }, { phase: 'ocr-skip', item: '3번', size: '32768x40' }]);
  for (const id of ['q1', 'q3']) {
    assert.deepEqual([canvases[id].width, canvases[id].height], [1, 1]);
    assert.equal(store.items[`${id}|local`].reliable, false);
    assert.equal(countLow(store.items[`${id}|local`].blocks), 1);
  }
  assert.equal(store.items['q2|local'].blocks[0].text, '합성 글');
  assert.equal(low, 2);
  assert.equal(events.filter((p) => p.phase === 'transcribe').at(-1).done, 3);
});
