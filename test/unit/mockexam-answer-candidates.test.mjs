import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { selections } from '../../src/renderer/js/mockexam.js';
import { parseAnswerKey, answerKeyToAnswers, numberRunAnswers } from '../../src/renderer/js/mockexam-answers.js';
const source = readFileSync(new URL('../../src/renderer/js/mockexam-import.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function readAnswers('), source.indexOf('// 자동 받기'));
function setup(candidates, count = 3, selection = null) {
  const saved = [], read = [];
  let current;
  const readAnswers = runInNewContext(`${body}; readAnswers`, {
    Blob, URL, parseAnswerKey, answerKeyToAnswers, selections, examForm: () => null,
    api: {
      scanExamRead: async (path) => { current = candidates[path]; read.push(path); return ''; },
      saveAnswer: async (_book, id, entry) => saved.push({ id, entry, reads: read.length }),
    },
    openDocSource: async () => ({ numPages: 1, pages: [{ kind: current.ocr ? 'image' : 'pdf' }],
      getPdfPage: async () => ({ getTextContent: async () => ({ items: [{ str: current.text }] }) }),
      renderPage: async () => '', destroy: async () => {} }),
    recognizeWords: async () => [{ str: current.text, y0: 0 }],
  });
  const book = { id: 'book', subject: 'math', docs: { problem: { items: Array.from({ length: count }, (_, i) => ({ number: i + 1, id: `q${i + 1}` })) } } };
  const row = { metadata: { selection }, files: candidates.map((candidate, i) => ({ localPath: i, filename: `${i}.pdf`, metadata: { part: candidate.part || 'answerKey', subject: 'math', selection } })) };
  return { run: () => readAnswers(book, row), saved, read };
}
test('일부 OCR 후보 뒤 전체 글자 후보만 저장, 다시 읽어도 동일', async () => {
  const s = setup([{ ocr: true, text: '1 ⑤' }, { part: 'solution', text: '1 ① 2 ② 3 ③' }]);
  assert.equal((await s.run()).connected, 3);
  assert.deepEqual(s.saved.map(x => x.entry.answer), ['1', '2', '3']);
  assert.ok(s.saved.every(x => x.reads === 2 && x.entry.blocks.length === 0));
  await s.run();
  assert.deepEqual(s.saved.slice(3).map(x => x.entry.answer), ['1', '2', '3']);
});
test('부분 연결 수 같으면 OCR보다 글자 후보 우선, 서로 섞지 않음', async () => {
  const s = setup([{ ocr: true, text: '1 ⑤' }, { text: '2 ②' }]);
  assert.equal((await s.run()).low, 0);
  assert.deepEqual(s.saved.map(x => x.id), ['q2']);
});
test('글자로 전부 연결한 후보는 뒤 후보 생략', async () => {
  const s = setup([{ text: '1 ① 2 ② 3 ③' }, { ocr: true, text: '1 ⑤' }]);
  assert.equal((await s.run()).low, 0);
  assert.deepEqual(s.read, [0]);
});
test('OCR 로 전부 연결해도 뒤 글자 후보를 보고, 더 적으면 OCR 확인 표시 유지', async () => {
  const s = setup([{ ocr: true, text: '1 ⑤ 2 ④ 3 ③' }, { text: '1 ①' }]);
  assert.equal((await s.run()).low, 3);
  assert.deepEqual(s.read, [0, 1]);
  assert.ok(s.saved.every(x => x.entry.blocks[0].low[0].reason === 'ocr'));
});
test('OCR 와 글자 후보가 모두 전부 연결하면 확인 표시 없는 글자 후보', async () => {
  const s = setup([{ ocr: true, text: '1 ⑤ 2 ④ 3 ③' }, { part: 'solution', text: '1 ① 2 ② 3 ③' }]);
  assert.equal((await s.run()).low, 0);
  assert.deepEqual(s.saved.map(x => x.entry.answer), ['1', '2', '3']);
});

test('명시된 현대 선택 책만 공통 OCR과 선택 글자 정답을 보완', async () => {
  const common=Array.from({length:22},(_,i)=>`${i+1} ${'①②③④⑤'[i%5]}`).join(' ');
  const tail=Array.from({length:8},(_,i)=>`${i+23} ${'①②③④⑤'[i%5]}`).join(' ');
  const s=setup([{ocr:true,text:common},{part:'solution',text:tail}],30,'미적분');
  const result=await s.run();
  assert.equal(result.connected,30);assert.equal(result.low,22);
  assert.equal(s.saved.find(x=>x.id==='q23').entry.answer,'1');
  assert.equal(s.saved.find(x=>x.id==='q23').entry.blocks.length,0);
  const conflicting=setup([{ocr:true,text:common+' 23 ⑤'},{part:'solution',text:tail}],30,'미적분');
  assert.equal((await conflicting.run()).connected,29);
  assert.ok(!conflicting.saved.some(x=>x.id==='q23'));
  // 더 많이 읽은 기존 후보로 돌아가도 상충한 답을 되살리지 않는다.
  const full=setup([{ocr:true,text:common+' '+tail},{part:'solution',text:tail.replace('23 ①','23 ⑤')}],30,'미적분');
  assert.equal((await full.run()).connected,29);
  assert.ok(!full.saved.some(x=>x.id==='q23'));
});

test('문항 번호 나열을 번호·답 쌍으로 읽은 후보는 버리고 다음 후보 사용', async () => {
  const s = setup([{ text: '1 2 3 4 5 6 7 8 9 10 11 12' }, { part: 'solution', text: '1 ① 2 ② 3 ③' }], 12);
  assert.equal((await s.run()).connected, 3);
  assert.deepEqual(s.saved.map(x => [x.id, x.entry.answer]), [['q1', '1'], ['q2', '2'], ['q3', '3']]);
  // 앞 번호의 ②~⑤ 는 실제 답일 수 있다.
  assert.equal(numberRunAnswers([[1, '2'], [2, '3'], [3, '4'], [4, '5'], [23, '1'], [24, '2']]), false);
  assert.equal(numberRunAnswers([[1, '3'], [2, '3'], [3, '4'], [20, '7'], [21, '22'], [22, '5']]), false);
  assert.equal(numberRunAnswers([[1, '2'], [3, '4'], [5, '6'], [7, '8'], [9, '10'], [10, '120']]), true);
});

test('번호만 늘어선 국어 정답표 줄은 답 범위로 거르기 전에 통째로 건너뜀', () => {
  const lines = ['언어 영역', `문항번호 ${Array.from({ length: 20 }, (_, i) => i + 1).join(' ')}`, '정 답'];
  const p = parseAnswerKey(lines.map((str) => ({ str, hasEOL: true })), { subject: 'korean' });
  assert.deepEqual(p.answers.korean || {}, {});
  assert.ok(p.warnings.some((w) => w.includes('번호 나열')));
  const real = parseAnswerKey([{ str: '언어 영역', hasEOL: true }, { str: '1 ② 2 ③ 3 ④ 4 ⑤ 5 ① 6 ② 7 ⑤', hasEOL: true }], { subject: 'korean' });
  assert.equal(Object.keys(real.answers.korean).length, 7);
});
