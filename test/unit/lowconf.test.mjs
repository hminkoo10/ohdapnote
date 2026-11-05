import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { LOW_CONF, countLow, listLow, nextLow, clearLow, moveLow, textLow, mathLow, relativeBox } from '../../src/renderer/js/lowconf.js';
import { textSymbols, splitLine, assembleBlocks, judgeScan, trimLatex, T } from '../../src/renderer/js/scanmath.js';
import { normalizeLatex } from '../../src/renderer/js/latexnorm.js';
import { importAnswerBlocks } from '../../src/renderer/js/answer-model.js';

const require = createRequire(import.meta.url);
const { sanitizeTranscripts } = require('../../src/main/transcript-review.js');
const { sanitizeAnswer } = require('../../src/main/answers.js');
const mark = (start, end, extra = {}) => ({ start, end, reason: 'ocr', ...extra });

test('표시 위치: 앞·뒤·겹침, 삽입 경계, 여러 표시와 한글 조합 문자열', () => {
  const low = [mark(0, 2), mark(3, 5), mark(6, 8)];
  assert.deepEqual(moveLow(low, '가나 다라 마바', '가나 수정문장 마바'), [low[0], mark(8, 10)]);
  assert.deepEqual(moveLow(low, '가나 다라 마바', '앞 가나 다라 마바'), [mark(2, 4), mark(5, 7), mark(8, 10)]);
  assert.deepEqual(moveLow(low, '가나 다라 마바', '가나 다라 마바 끝'), low);
  assert.deepEqual(moveLow([mark(1, 3)], 'abcd', 'abXcd'), []);
  assert.deepEqual(moveLow([mark(1, 3)], 'abcd', 'aXbcd'), [mark(2, 4)]);
  assert.deepEqual(moveLow([mark(1, 3)], 'abcd', 'abcXd'), [mark(1, 3)]);
  const composed = '한글 😀 뒤';
  assert.deepEqual(moveLow([mark(0, 3), mark(8, 9)], composed, '한글 😀 뒤'), [mark(6, 7)]);
  assert.deepEqual(moveLow([mark(0, 1), mark(3, 4)], 'ㅎ 뒤쪽', '한글 뒤쪽'), [mark(4, 5)]);
  assert.deepEqual(low, [mark(0, 2), mark(3, 5), mark(6, 8)], '원래 배열 불변');
});

test('수식 전체·보기 일부 수정, 세기·지우기·앞뒤 순환과 옛 블록', () => {
  const blocks = [{ type: 'para', text: '옛 글' }, { type: 'math', latex: 'x', low: [{ reason: 'math' }] }, { type: 'choices', items: ['가나', '다라'], low: [mark(0, 1, { item: 0 }), { item: 1, reason: 'ocr' }] }];
  assert.equal(countLow(blocks), 3);
  assert.equal(countLow(undefined), 0);
  assert.equal(countLow(blocks[0]), 0);
  const list = listLow(blocks);
  assert.deepEqual(nextLow(blocks), list[0]);
  assert.deepEqual(nextLow(blocks, list[2]), list[0]);
  assert.deepEqual(nextLow(blocks, list[0], -1), list[2]);
  assert.equal(nextLow([]), null);
  assert.deepEqual(clearLow(blocks[2].low, 0), [blocks[2].low[1]]);
  assert.deepEqual(moveLow(blocks[2].low, '가나', '수정', 0), [blocks[2].low[1]]);
  assert.deepEqual(moveLow(blocks[1].low, 'x', 'y'), []);
});

test('표시 기준은 기존 수식 판정과 같고 경계 점수는 표시하지 않음', () => {
  assert.equal(T.confMean, LOW_CONF.confMean);
  assert.equal(T.confMin, LOW_CONF.confMin);
  assert.deepEqual(textLow({ str: '가', conf: 70 }), []);
  assert.equal(textLow({ str: '가', conf: 69 })[0].reason, 'ocr');
  assert.equal(textLow({ str: '가나', conf: 98, wordConf: 60 })[0].conf, 0.6);
  assert.equal(textLow({ str: '가', conf: 99, check: true })[0].reason, 'disagree');
  assert.equal(mathLow({ mean: 0.93, min: 0.3 }), null);
  assert.equal(mathLow({ mean: 0.92, min: 0.5 }).reason, 'math');
  assert.equal(mathLow({ mean: 0.99, min: 0.29 }).conf, 0.29);
  assert.equal(mathLow(undefined), null);
  assert.equal(mathLow({ mean: 0.9 }).conf, 0.9);
  assert.deepEqual(relativeBox({ x0: -10, y0: 20, x1: 120, y1: 50 }, 100, 100), { x: 0, y: 0.2, w: 1, h: 0.3 });
});

function samplePlan() {
  const text = (s, x0, y0, conf, check = false) => ({ str: s, x0, y0, x1: x0 + 30, y1: y0 + 20, conf, check });
  const tokens = (syms) => splitLine([], syms, 20).tokens;
  const first = tokens([text('함수', 10, 10, 98), text('값은', 60, 10, 60)]);
  const second = tokens([text('참', 10, 40, 98, true)]);
  const formula = { t: 'math', f: 0, box: { x0: 60, y0: 40, x1: 100, y1: 60 } };
  return { W: 200, H: 200, h: 20, textConf: 95, formulas: [{ box: formula.box }], figures: [], lines: [
    { kind: 'text', seg: 0, y0: 10, y1: 30, x0: 10, x1: 100, tokens: first },
    { kind: 'text', seg: 0, y0: 40, y1: 60, x0: 10, x1: 100, tokens: [...second, formula] },
    { kind: 'choice', seg: 0, y0: 80, y1: 100, x0: 10, x1: 100, items: [tokens([text('보기', 10, 80, 50)]), [formula]] },
  ] };
}

test('이미 읽은 단어 점수 전달: 글자 선택 점수는 바꾸지 않고 단어를 표시', () => {
  const word = { str: '함수', x0: 10, y0: 10, x1: 50, y1: 30, conf: 60, symbols: [
    { str: '함', x0: 10, y0: 10, x1: 30, y1: 30, conf: 98 },
    { str: '수', x0: 30, y0: 10, x1: 50, y1: 30, conf: 98 },
  ] };
  const units = textSymbols([{ words: [word] }], 20);
  assert.equal(units[0].conf, 98);
  const token = splitLine([], units, 20).tokens[0];
  assert.equal(token.s, '함수');
  assert.equal(token.low[0].conf, 0.6);
  assert.equal(token.s.slice(token.low[0].start, token.low[0].end), '함수');
});

test('scanTranscribe 합성 계획: 실제 조합의 글자 위치·보기·수식·원본 비율 보존', async () => {
  const source = readFileSync(new URL('../../src/renderer/js/scanocr.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace('export async function', 'async function');
  let reads = 0;
  const scan = new Function('recognizeWords', 'planScan', 'cropFormula', 'assembleBlocks', 'judgeScan', 'trimLatex', 'normalizeLatex', `${source}\nreturn scanTranscribe;`)(async () => { reads++; return []; }, samplePlan, () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }), assembleBlocks, judgeScan, trimLatex, normalizeLatex);
  const canvas = { width: 200, height: 200, getContext: () => ({ getImageData: () => ({}) }) };
  const result = await scan(canvas, { api: { mathocrRecognize: async () => ({ ok: true, results: [{ latex: 'x+1)', conf: { mean: 0.9, min: 0.2 } }] }) } });
  assert.equal(reads, 2);
  const [para, choices] = result.blocks;
  assert.equal(para.text, '함수 값은 참 $x+1$)');
  assert.deepEqual(para.low.map((m) => [para.text.slice(m.start, m.end), m.reason]), [['값은', 'ocr'], ['참', 'disagree'], ['$x+1$', 'math']]);
  assert.deepEqual(para.low[0].box, { x: 0.3, y: 0.05, w: 0.15, h: 0.1 });
  assert.deepEqual(choices.low.map((m) => [m.item, choices.items[m.item].slice(m.start, m.end)]), [[0, '보기'], [1, '$x+1$']]);
  assert.equal(result.reliable, false);
  assert.deepEqual(sanitizeTranscripts({ items: { q: { blocks: result.blocks } } }).items.q.blocks, result.blocks);
});

test('main 검사: 정상 표시 보존, 나쁜 위치·범위·상자·과대 배열 제거, 옛 파일 유지', () => {
  const blocks = [{ type: 'para', text: '가나다', low: [mark(0, 1, { conf: 0.6, box: { x: 0.2, y: 0, w: 0.2, h: 1 } })] }, { type: 'math', latex: 'x', low: [{ reason: 'math' }] }, { type: 'choices', items: ['a'], low: [{ item: 0, reason: 'disagree' }] }];
  const data = { version: 1, items: { q: { blocks, newer: true } } };
  assert.deepEqual(sanitizeTranscripts(data), data);
  const dirty = { type: 'para', text: '가나다', low: [null, mark(-1, 1), mark(1, 9), mark(0.5, 2), mark(2, 2), mark(0, 1, { reason: 'future', conf: NaN, box: { x: 0.9, y: 0, w: 0.5, h: 1 } }), mark(1, 2, { conf: 2, box: { x: -1, y: 0, w: 1, h: 1 } })] };
  assert.deepEqual(sanitizeTranscripts({ items: { q: { blocks: [dirty] } } }).items.q.blocks[0].low, [mark(0, 1), mark(1, 2)]);
  const invalid = [{ type: 'para', text: 'a', runs: [{ text: 'a' }], low: [mark(0, 1)] }, { type: 'choices', items: ['a'], low: [{ item: 3, reason: 'ocr' }] }, { type: 'math', latex: 'x', low: 'bad' }];
  assert.ok(sanitizeTranscripts({ items: { q: { blocks: invalid } } }).items.q.blocks.every((b) => !b.low));
  assert.equal(sanitizeTranscripts({ items: { q: { blocks: [{ type: 'para', text: 'a', low: Array(2001).fill(mark(0, 1)) }] } } }).items.q.blocks[0].low.length, 2000);
  const old = { version: 1, items: { q: { blocks: [{ type: 'para', text: '옛 파일' }, { type: 'future', value: 3 }] } } };
  assert.deepEqual(sanitizeTranscripts(old), old);
});

test('답지 표시: 수식 변환·보기 앞 번호의 위치, 사람 글 저장에는 남기지 않음', () => {
  const source = [{ type: 'para', text: '답 $x^{2}$ 뒤', low: [mark(2, 9, { reason: 'math' }), mark(10, 11)] }, { type: 'choices', items: ['가나'], low: [mark(0, 1, { item: 0 })] }];
  const imported = importAnswerBlocks(source, { review: true });
  assert.equal(imported[0].text.slice(imported[0].reviewLow[1].start, imported[0].reviewLow[1].end), '뒤');
  assert.equal(imported[1].text.slice(imported[1].reviewLow[0].start, imported[1].reviewLow[0].end), '가');
  const saved = sanitizeAnswer({ answer: '', blocks: imported });
  assert.ok(saved.blocks.every((b) => !b.low && !b.reviewLow));
  assert.ok(importAnswerBlocks(source).every((b) => !b.low && !b.reviewLow));
});
