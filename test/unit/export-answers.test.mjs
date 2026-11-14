import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAnswer, headAnswer, answerFromBlocks, shortAnswer, tablePairs, uniqueTable, createAnswerReader, resolveExportAnswers, MISSING_ANSWER, mayHaveAnswers, missingAnswerMessage } from '../../src/renderer/js/export-answers.js';
import { transcriptKey } from '../../src/renderer/js/transcript-store.js';
import { geminiTranscribeBatch } from '../../src/renderer/js/gemini.js';
import { blockSegs } from '../../src/renderer/js/hwpx.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { makeBlocks, buildPdf } from '../../src/renderer/js/exporter.js';
import { buildHwpx } from '../../src/renderer/js/hwpx.js';
import { inflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const para = text => ({ type: 'para', text });
const token = (str, x0, y0 = 0.1) => ({ str, x0, x1: x0 + str.length * 0.008, y0, y1: y0 + 0.02 });
const row = (text, y = 0.1) => text.split(' ').map((str, i) => token(str, 0.05 + i * 0.08, y));
const rect = { page: 0, x: 0, y: 0, w: 1, h: 1 };
const entry = (number, extra = {}) => ({ problem: { id: `p${number}`, number: String(number), page: 0, rects: [rect] }, ...extra });
const label = () => 'p.1';

test('해설 전체: 끝·번호 줄·math·choices·runs, 같은 답만 여러 번 허용', () => {
  assert.equal(answerFromBlocks([para('풀이'), para('계산'), para('참고'), para('답 ③'), para('다른 풀이')]), '③');
  assert.equal(answerFromBlocks([para('017 답: 12 풀이를 확인한다')]), '12');
  assert.equal(answerFromBlocks([para('정답 ③'), para('답: ③')]), '③');
  assert.equal(answerFromBlocks([para('정답 ③'), para('답: ⑤')]), '');
  assert.equal(answerFromBlocks([para('대답 ③, 정답률 80, 답이 없다, 답지 12')]), '');
  assert.equal(answerFromBlocks([para('정답률 80'), para('답이 3이다'), para('답 12')]), '12');
  assert.equal(answerFromBlocks([para('답 (1) 14 (2) 10√2 참고 다른 풀이')]), '(1) 14 (2) 10√2');
  assert.equal(answerFromBlocks([{ type: 'math', text: '답 $x^2$' }]), 'x²');
  assert.equal(answerFromBlocks([{ type: 'math', latex: '\\text{답 } \\sqrt{2}' }]), '√2');
  assert.equal(answerFromBlocks([{ type: 'choices', items: ['본문', '정답 $\\sqrt{2}$'] }]), '√2');
  assert.equal(answerFromBlocks([{ type: 'para', runs: [{ text: '답 ' }, { eq: 'x^{2}' }] }]), 'x²');
  for (const text of ['답 ③', '정답 -12', '답 3/4', '정답 x = -3', '정답 ③ 풀이', '답 ③ (참고)']) {
    assert.equal(answerFromBlocks([para(text)]), headAnswer([para(text)]), text);
  }
});

test('답 뒤 한글: 이음말·단위·끝 낱말은 답에 포함, 해설 문장 앞에서 자르고, 조건이 이어지면 쓰지 않음', () => {
  assert.equal(answerFromBlocks([para('답 x=−2 또는 x=1±2i')]), 'x=−2 또는 x=1±2i');
  assert.equal(answerFromBlocks([para('답 $x=3$ 또는 $x=5$')]), 'x=3 또는 x=5');
  assert.equal(answerFromBlocks([para('답 x<−2 또는 x>3 다른 풀이 생략')]), 'x<−2 또는 x>3');
  assert.equal(answerFromBlocks([para('답 2×2 행렬')]), '2×2 행렬');
  assert.equal(answerFromBlocks([para('답 2000원')]), '2000원');
  assert.equal(answerFromBlocks([para('답 −3')]), '−3');
  assert.equal(answerFromBlocks([para('1 정답 ③ 이차방정식의 두 근의 합은 따라서 구하는 값은 37 이다.')]), '③');
  assert.equal(answerFromBlocks([para('답 3 이므로 구하는 값')]), '3');
  assert.equal(answerFromBlocks([para('답 3 이다')]), '3');
  assert.equal(answerFromBlocks([para('답 ③ 풀이')]), '③');
  for (const text of ['답 x=1 일 때 최댓값 3', '답 x=1 이고 y=2', '답 3이다', '답 실수부분: 1, 허수부분: 0']) {
    assert.equal(answerFromBlocks([para(text)]), '', text);
  }
});

test('LaTeX 답: 위첨자·근호·분수·부등호·그리스 문자, 손실·괄호 오류는 거부', () => {
  const cases = [
    ['x^{23}', 'x²³'], ['x^{-12}', 'x⁻¹²'], ['\\sqrt{2}', '√2'], ['\\pm 2', '±2'],
    ['x\\le 2', 'x≤2'], ['x\\ge 2', 'x≥2'], ['x\\ne 2', 'x≠2'], ['2\\times 3', '2×3'],
    ['\\frac{a}{b}', 'a/b'], ['\\frac{a+b}{c-d}', '(a+b)/(c-d)'],
    ['\\frac{1}{\\frac{a}{b}}', '1/(a/b)'], ['\\pi+\\alpha+\\Gamma', 'π+α+Γ'],
  ];
  for (const [latex, expected] of cases) assert.equal(answerFromBlocks([para(`답 $${latex}$`)]), expected, latex);
  for (const value of ['$\\begin{matrix}1\\end{matrix}$', '$\\mystery{2}$', '$\\frac{1}{2$', '$x^$', '$\\hat{x}$', '$x+2', '(1] 12', '1'.repeat(41)]) {
    assert.equal(answerFromBlocks([para(`답 ${value}`)]), '', value);
  }
  assert.equal(answerFromBlocks([para(`답 ${'1'.repeat(40)}`)]).length, 40);
  assert.equal(answerFromBlocks([para('답 $\\mystery{2}$'), para('답 2')]), '', '못 읽은 답을 무시하지 않음');
});

test('짝 PDF: 모든 rect의 끝 답만, 영역 밖 답·숨은 OCR 제외', async () => {
  const src = { pages: [{ kind: 'pdf' }, { kind: 'pdf' }], getTextTokens: async page => page ? [...row('풀이', 0.1), ...row('답 12', 0.3), ...row('답 13', 0.8)] : row('풀이') };
  const reader = createAnswerReader(), item = { rects: [rect, { ...rect, page: 1, h: 0.5 }] };
  assert.equal(await reader.region(src, item), '12');
  assert.equal((await reader.readRegion({ ...src, hasOnlyHiddenText: async () => true }, item)).scanned, true);
});

// 기존 시험과 같은 IPC 흉내. 실제 geminiTranscribeBatch를 거치되 서비스 요청은 없다.
// Windows 배포 서버는 CRLF 로 받으므로 줄바꿈을 맞춘 뒤 잘라 냄
const transcribeSource = readFileSync(new URL('../../src/renderer/js/transcribe.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const aiBody = transcribeSource.slice(transcribeSource.indexOf('export async function transcribeAiBlocks'), transcribeSource.indexOf('/**\n * 0)')).replace('export ', '');
let fixtureId = 0;
function aiFixture(t, { count = 5, batch = 2, concurrency = 2, respond } = {}) {
  const previous = globalThis.window, calls = [], renders = [], progress = [], store = { items: {}, dirty: false };
  let saves = 0, active = 0, maxActive = 0;
  const abort = new AbortController();
  globalThis.window = { ohdap: {
    aiGenerate: async args => {
      calls.push(args);
      maxActive = Math.max(maxActive, ++active);
      try {
        await new Promise(resolve => setTimeout(resolve, 2));
        if (respond) return await respond(args, calls.length, abort);
        const n = args.body.contents[0].parts.filter(p => p.inlineData).length;
        const blocks = [para('풀이'), para('답 $\\sqrt{2}$'), para('참고')];
        const reply = n === 1 ? { blocks } : { items: Array.from({ length: n }, (_, i) => ({ index: i + 1, blocks })) };
        return { ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] } };
      } finally { active--; }
    }, aiAbort: async () => true,
  } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const options = { batch, concurrency, rpm: 600000, models: [`answer-test-${++fixtureId}`] };
  const run = runInNewContext(`${aiBody}; transcribeAiBlocks`, {
    Error, DOMException, transcriptKey, blockSegs, TRANSCRIBE_WIDTH: 1500, geminiTranscribeBatch,
    aiOptions: () => options,
    renderStack: async (segs, width) => { renders.push({ segs, width }); return {}; },
    canvasToBase64Jpeg: (_canvas, quality) => { assert.equal(quality, 0.85); return 'FAKE'; },
  });
  const src = { files: [{ name: 'answer.pdf', kind: 'pdf' }], pages: [{ kind: 'pdf', w: 595, h: 842 }], getTextTokens: async () => [] };
  const entries = Array.from({ length: count }, (_, i) => entry(i + 1, { bookId: 'synthetic', src: { answer: src }, answer: { id: `a${i}`, rects: [rect] } }));
  const transcriber = { load: async () => store, save: async () => { saves++; }, run };
  const resolveAnswers = extra => resolveExportAnswers(entries, { aiReady: true, convert: 'ai', transcriber, signal: abort.signal, onProgress: msg => progress.push(msg), ...extra });
  const key = i => transcriptKey({ role: 'answer', src, item: entries[i].answer });
  return { calls, renders, progress, store, abort, entries, transcriber, resolveAnswers, key, saves: () => saves, maxActive: () => maxActive };
}

test('스캔 AI: 같은 묶음·동시 요청, 저장 열쇠, 중복·두 번째 내보내기는 재호출 없음', async t => {
  const f = aiFixture(t);
  f.entries.push(f.entries[0]);
  const r = await f.resolveAnswers();
  assert.equal(r.missing, 0);
  assert.deepEqual(r.entries.map(e => e.exportAnswer), Array(6).fill('√2'));
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map(c => c.body.contents[0].parts.filter(p => p.inlineData).length).sort(), [1, 2, 2]);
  assert.equal(f.maxActive(), 2);
  assert.ok(f.calls.every(c => JSON.stringify(c.body).includes('Keep the answer line')));
  assert.equal(f.renders.length, 5);
  assert.ok(f.renders.every(r => r.width === 1500 && r.segs[0].block.role === 'answer'));
  assert.equal(Object.keys(f.store.items).length, 5);
  assert.ok(f.store.items[f.key(0)].blocks.length);
  assert.equal(f.saves(), 1);
  assert.equal((await f.resolveAnswers()).missing, 0);
  assert.equal(f.calls.length, 3);
  assert.equal(f.progress[0], 'AI 로 해설을 읽는 중… (0/6)');
  assert.equal(f.progress.at(-1), 'AI 로 해설을 읽는 중… (6/6)');
});

test('스캔 저장 순서: 고친 글 → AI, local·pdf 안 씀, 표와 충돌 검사', async t => {
  const f = aiFixture(t, { count: 1 });
  f.store.items[f.key(0)] = { blocks: [para('답 12')] };
  f.store.items[f.key(0) + '|edit'] = { blocks: [para('답 ③')] };
  f.store.items[f.key(0) + '|local'] = { blocks: [para('답 ⑤')] };
  assert.equal((await f.resolveAnswers()).entries[0].exportAnswer, '③');
  delete f.store.items[f.key(0) + '|edit'];
  assert.equal((await f.resolveAnswers()).entries[0].exportAnswer, '12');
  const src = f.entries[0].src.answer;
  src.pages.push({ kind: 'pdf' });
  src.getTextTokens = async page => page === 1 ? row('1 ⑤') : [];
  f.entries[0].bookObj = { docs: { answer: { pageInfo: { 1: { exclusion: { role: 'answer_table' } } } } } };
  assert.equal((await f.resolveAnswers()).conflicts, 1);
  delete f.store.items[f.key(0)];
  f.store.items[f.key(0) + '|pdf'] = { blocks: [para('답 12')] };
  assert.equal((await f.resolveAnswers({ convert: 'ocr' })).entries[0].exportAnswer, '⑤');
  delete f.entries[0].bookObj;
  assert.equal((await f.resolveAnswers({ convert: 'ocr' })).missing, 1);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.resolveAnswers()).entries[0].exportAnswer, '√2', 'local·pdf가 있어도 AI 옮김이 없으면 읽음');
  assert.equal(f.calls.length, 1);
});

test('디지털 글자층은 저장된 AI보다 우선, 직접 쓴 해설 끝 답은 자동 출처보다 우선', async t => {
  const f = aiFixture(t, { count: 1 });
  f.entries[0].src.answer.getTextTokens = async () => row('답 12');
  f.store.items[f.key(0)] = { blocks: [para('답 ⑤')] };
  assert.equal((await f.resolveAnswers()).entries[0].exportAnswer, '12');
  f.entries[0].writtenAnswer = { blocks: [para('풀이'), para('계산'), para('참고'), para('답 ③')] };
  assert.equal((await f.resolveAnswers()).entries[0].exportAnswer, '③');
  assert.equal(f.calls.length, 0);
});

test('스캔 AI 꺼짐·ocr 방식: 호출 0, 누락·안내·이미지 답지 단추', async t => {
  const f = aiFixture(t, { count: 1 });
  for (const extra of [{ aiReady: false }, { convert: 'ocr' }]) {
    const r = await f.resolveAnswers(extra);
    assert.equal(r.missing, 1); assert.equal(r.scannedMissing, 1);
    assert.equal(missingAnswerMessage(r.missing, r.scannedMissing), '답을 찾지 못한 문항 1개. 스캔한 해설은 AI 연동을 켜면 답을 읽을 수 있어요.');
  }
  assert.equal(f.calls.length, 0);
  const book = { docs: { answer: { files: [{ kind: 'image' }] } } };
  assert.equal(mayHaveAnswers(book, true), true);
  assert.equal(mayHaveAnswers(book, false), false);
});

test('스캔 AI 한도: 뒤 요청 중단, 앞 결과 저장·사용', async t => {
  const f = aiFixture(t, { count: 4, batch: 1, concurrency: 1 });
  let calls = 0;
  const original = globalThis.window.ohdap.aiGenerate;
  globalThis.window.ohdap.aiGenerate = args => ++calls === 1 ? original(args) : Promise.resolve({ ok: false, status: 429, error: 'quota', json: { error: { message: 'PerDay' } } });
  const r = await f.resolveAnswers();
  assert.equal(calls, 2);
  assert.equal(r.entries[0].exportAnswer, '√2');
  assert.equal(r.missing, 3);
  assert.equal(Object.keys(f.store.items).length, 1);
  assert.equal(f.saves(), 1);
});

test('스캔 AI 취소: 앞 답만 유지, 남은 답은 누락', async t => {
  const f = aiFixture(t, { count: 3, batch: 1, concurrency: 1 });
  const original = f.transcriber.run;
  f.transcriber.run = (blocks, opts) => original(blocks, { ...opts, onResult: (...args) => { opts.onResult(...args); f.abort.abort(); } });
  const r = await f.resolveAnswers();
  assert.equal(r.entries[0].exportAnswer, '√2');
  assert.equal(r.missing, 2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.saves(), 1);
});

test('스캔 AI 오류·미리 취소: 뒤 요청 없음, 저장된 답은 유지', async t => {
  const f = aiFixture(t, { count: 3, batch: 1, concurrency: 1 });
  f.store.items[f.key(0)] = { blocks: [para('답 ③')] };
  globalThis.window.ohdap.aiGenerate = async () => {
    f.calls.push('error');
    return { ok: false, status: 400, error: '시험용 읽기 오류' };
  };
  const r = await f.resolveAnswers();
  assert.equal(f.calls.length, 1);
  assert.equal(r.entries[0].exportAnswer, '③');
  assert.equal(r.missing, 2);
  f.abort.abort();
  assert.equal((await f.resolveAnswers()).missing, 2);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.resolveAnswers({ aiReady: false })).missing, 3, 'AI 꺼짐은 저장된 AI도 쓰지 않음');
});

test('같은 열쇠도 책이 다르면 각각 읽고 저장', async t => {
  const f = aiFixture(t, { count: 1 });
  const other = { items: {}, dirty: false };
  f.entries.push({ ...f.entries[0], bookId: 'other' });
  f.transcriber.load = async id => id === 'other' ? other : f.store;
  assert.equal((await f.resolveAnswers()).missing, 0);
  assert.equal(f.renders.length, 2);
  assert.ok(other.items[f.key(0)]?.blocks.length);
  assert.ok(f.store.items[f.key(0)]?.blocks.length);
});

test('기존 HWPX 네 모드: 답 추출 전후 바이트 동일', async t => {
  const originalDate = globalThis.Date;
  globalThis.Date = class extends originalDate {
    constructor(...args) { super(...(args.length ? args : ['2026-11-14T00:00:00Z'])); }
    static now() { return Date.parse('2026-11-14T00:00:00Z'); }
  };
  t.after(() => { globalThis.Date = originalDate; });
  const entries = [entry(1, { writtenAnswer: { answer: '③', blocks: [para('기존 해설')] } }), entry(2)];
  const resolved = (await resolveExportAnswers(entries)).entries;
  for (const mode of ['problems', 'answers', 'both-inline', 'both-end']) {
    for (const options of [{ space: 'none' }, { columns: 2, labels: false, renumber: false, space: 'page' }]) {
      const bytes = [];
      for (const list of [entries, resolved]) bytes.push(await buildHwpx({
        blocks: makeBlocks(mode, list, options, label), options,
        renderSeg: () => assert.fail('시험용 항목에는 원본 그림 없음'),
      }));
      assert.deepEqual(bytes[0], bytes[1], `${mode}: 기존 HWPX 바이트`);
    }
  }
});

test('답 우선순위: 저장 답 → 입력한 해설 → 짝 영역 → 정답표', () => {
  const e = entry(1, { writtenAnswer: { answer: '③', blocks: [para('정답 12')] } });
  assert.equal(chooseAnswer(e, '⑤', '①').answer, '③');
  delete e.writtenAnswer.answer;
  assert.equal(chooseAnswer(e, '⑤', '①').answer, '12');
  delete e.writtenAnswer;
  assert.equal(chooseAnswer(e, '⑤', '').answer, '⑤');
  assert.equal(chooseAnswer(e, '', '①').answer, '①');
  assert.deepEqual(chooseAnswer(e, '⑤', '①'), { answer: '', source: '', conflict: true });
  assert.equal(chooseAnswer(e, '①', '①').answer, '①');
  assert.equal(chooseAnswer(e, 'x = 3', 'x=3').conflict, false, '식의 공백만 다른 경우 같은 답');
});

test('답 모양: 객관식·숫자·분수·식, 40자 초과와 잘린 식·줄바꿈 제외', () => {
  for (const value of ['③', '-12', '3/4', 'x = -3']) assert.equal(headAnswer([para(`정답 ${value}`)]), value);
  assert.equal(headAnswer([para('정답 ③ 풀이를 확인한다')]), '③');
  assert.equal(headAnswer([para('정답 3+4')]), '');
  assert.equal(headAnswer([para('정답 ③④')]), '');
  assert.equal(headAnswer([para(`정답 ${'1'.repeat(41)}`)]), '');
  assert.equal(shortAnswer('1'.repeat(40)).length, 40);
  assert.equal(shortAnswer('1'.repeat(41)), '');
  assert.equal(shortAnswer('3\n4'), '');
  assert.equal(headAnswer([para('본문'), para('본문'), para('본문'), para('정답 ③')]), '');
  assert.equal(headAnswer([para('글'.repeat(201) + ' 정답 ③')]), '', '긴 본문 뒤의 답은 머리가 아님');
  assert.equal(headAnswer([para('답지 참고'), para('정답 ③')]), '③', '답지라는 단어가 뒤의 명시적 정답을 가리지 않음');
  assert.equal(headAnswer([para('글'.repeat(190) + ' 정답 ' + '1'.repeat(20))]), '', '200자 경계에서 잘린 숫자는 버림');
});

test('정답표: 번호·답 쌍과 숫자 답, 번호 재등장 시 같은 답도 제외', () => {
  const pairs = tablePairs([...row('0001 ③ 0002 12 0003 ⑤'), ...row('0001 ③ 0002 ①', 0.2)]);
  assert.equal(pairs.length, 5);
  const table = uniqueTable(pairs);
  assert.deepEqual([...table], [['3', '⑤']]);
  assert.deepEqual(tablePairs(row('1 2 3 4 5 6')), []);
  assert.deepEqual(tablePairs(row('1 ③ 본문 2 ①')), []);
  assert.equal(uniqueTable([{ number: 1, answer: 'a'.repeat(41) }]).size, 0);
  const partlyUnreadable = tablePairs([...row('1 a+b 2 12'), ...row('1 ③ 2 ①', 0.2)]);
  assert.equal(uniqueTable(partlyUnreadable).size, 0, '못 읽은 답도 번호 중복에 포함');
  assert.deepEqual(tablePairs(row('0001③ 0002⑤')).map(p => p.answer), ['③', '⑤']);
  assert.equal(uniqueTable([...tablePairs(row('1 ③ 2 12')), ...tablePairs(row('1 ③', 0.2))]).has('1'), false, '한 쌍뿐인 마지막 줄도 중복 검사');
});

test('짝 PDF: 영역 안 머리만, 이미지·빈 글자층은 건너뜀, 쪽 캐시 공유', async () => {
  let reads = 0;
  const src = { pages: [{ kind: 'pdf' }, { kind: 'image' }], getTextTokens: async () => { reads++; return [...row('정답 ③'), ...row('정답 ⑤', 0.8)]; } };
  const reader = createAnswerReader();
  const item = { rects: [{ ...rect, h: 0.4 }] };
  assert.equal(await reader.region(src, item), '③');
  assert.equal(await reader.region(src, item), '③');
  assert.equal(reads, 1);
  assert.equal(await reader.region(src, { rects: [{ ...rect, page: 1 }] }), '');
  assert.equal(reads, 1);
  assert.equal(await reader.region({ pages: [{ kind: 'pdf' }], getTextTokens: async () => [] }, item), '');
});

test('내보내기 답: 영역·표 충돌 집계, 없는 답 안내, 저장 원본 불변', async () => {
  const src = { pages: [{ kind: 'pdf' }, { kind: 'pdf' }], getTextTokens: async page => page ? row('1 ⑤ 2 12') : row('정답 ③') };
  const doc = { pageInfo: { 1: { exclusion: { role: 'answer_table' } } } };
  const entries = [entry(1, { answer: { rects: [rect] }, src: { answer: src }, bookObj: { docs: { answer: doc } } }), entry(2, { src: { answer: src }, bookObj: { docs: { answer: doc } } }), entry(3)];
  const before = JSON.stringify(entries);
  const result = await resolveExportAnswers(entries);
  assert.equal(result.missing, 2);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.entries.map(e => e.exportAnswer), ['', '12', '']);
  assert.equal(JSON.stringify(entries), before);
  assert.equal(makeBlocks('answer-inline', result.entries, {}, label)[1].text, MISSING_ANSWER);
});

test('새 모드: 바로 뒤 블록 순서·간격, 맨 뒤 제목·촘촘한 표·원래 번호', () => {
  const entries = [entry(8, { exportAnswer: '③' }), entry(9)];
  const inline = makeBlocks('answer-inline', entries, { space: 'page' }, label);
  assert.deepEqual(inline.map(b => b.kind), ['problem', 'answer-text', 'problem', 'answer-text']);
  assert.equal(inline[0].addSpace, false);
  assert.equal(inline[1].addSpace, true);
  assert.equal(inline[1].source, '답 · p.1 8번');
  assert.equal(inline[3].text, MISSING_ANSWER);
  const end = makeBlocks('answer-end', entries, { labels: false, renumber: false }, label);
  assert.deepEqual(end.map(b => b.kind), ['problem', 'problem', 'section', 'answer-table']);
  assert.equal(end[2].text, '정답');
  assert.deepEqual(end[3].cells, [{ num: '8.', text: '③', source: '' }, { num: '9.', text: MISSING_ANSWER, source: '' }]);
});

test('기존 네 모드: 답 전용 정보가 있어도 결과 완전히 같음 (문제은행 포함)', () => {
  const entries = [entry(1, { answer: { rects: [rect], number: '1', page: 0 } }), entry(2, { writtenAnswer: { answer: '③', blocks: [] } }), entry(3)];
  for (const mode of ['problems', 'answers', 'both-inline', 'both-end']) {
    for (const options of [{}, { labels: false, renumber: false, space: 'page' }]) {
      assert.deepEqual(makeBlocks(mode, entries, options, label), makeBlocks(mode, entries.map(e => ({ ...e, exportAnswer: '⑤' })), options, label));
    }
  }
  assert.deepEqual(makeBlocks('problems', entries, {}, label).map(b => [b.kind, b.num, b.source, b.addSpace]), [['problem', '1.', 'p.1 1번', true], ['problem', '2.', 'p.1 2번', true], ['problem', '3.', 'p.1 3번', true]]);
  assert.deepEqual(makeBlocks('answers', entries, {}, label).map(b => [b.kind, b.num, b.source]), [['answer', '1.', '해설 · p.1 1번'], ['answer', '2.', '해설 · p.1 2번'], ['note', '3.', '해설 · p.1 3번']]);
});

test('단추 사전 판단: 저장 답은 허용, PDF는 읽기 전 막지 않고 이미지만 있으면 막음', () => {
  assert.ok(mayHaveAnswers({ docs: { answer: { files: [{ kind: 'pdf' }] } } }));
  assert.ok(!mayHaveAnswers({ docs: { answer: { files: [{ kind: 'image' }] } } }));
  assert.ok(mayHaveAnswers({ docs: { problem: { items: [{ id: 'p' }] } }, $answers: { items: { p: { answer: '③' } } } }));
});

function sectionXml(bytes) {
  const buf = Buffer.from(bytes), end = buf.lastIndexOf(Buffer.from([80, 75, 5, 6]));
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const len = buf.readUInt16LE(at + 28), name = buf.toString('utf8', at + 46, at + 46 + len), offset = buf.readUInt32LE(at + 42);
    if (name === 'Contents/section0.xml') {
      const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
      const data = buf.subarray(start, start + buf.readUInt32LE(at + 20));
      return (buf.readUInt16LE(at + 10) === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    at += 46 + len + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
}

test('HWPX: 답은 실제 글자, 여러 개 한 줄, 옮기기 대상으로 넘기지 않음', async () => {
  const entries = [entry(1, { exportAnswer: '③' }), entry(2, { exportAnswer: '12' }), entry(3)];
  for (const mode of ['answer-inline', 'answer-end']) {
    const blocks = makeBlocks(mode, entries, { labels: false, space: 'none' }, label).filter(b => b.kind !== 'problem');
    const bytes = await buildHwpx({ blocks, options: { space: 'none' }, transcribe: () => assert.fail('답은 옮기지 않음') });
    const xml = sectionXml(bytes);
    assert.ok(xml.includes('③'));
    assert.ok(xml.includes(MISSING_ANSWER));
    if (mode === 'answer-end') {
      assert.match(xml, /<hp:t>정답<\/hp:t>/);
      assert.match(xml, /1\. ③   2\. 12/);
    }
  }
});

test('PDF: 답·정답 제목·누락 안내를 그림으로 배치, 인쇄 창 호출 없음', async t => {
  const require = createRequire(import.meta.url);
  const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await import(pathToFileURL(pdfjsPath).href);
  const root = resolve(dirname(pdfjsPath), '../..').replaceAll('\\', '/');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const before = globalThis.document;
  const drawn = [];
  globalThis.document = { createElement: () => {
    const canvas = { toBlob: fn => fn(new Blob([png])) };
    const ctx = {
      measureText(s) { return { width: Array.from(s).reduce((sum, c) => sum + (c === 'i' ? 0.25 : 1), 0) * Number(this.font.match(/([\d.]+)px/)[1]) }; },
      fillText(text) { drawn.push({ text, color: this.fillStyle, font: this.font, canvas }); },
    };
    canvas.getContext = () => ctx;
    return canvas;
  } };
  t.after(() => { if (before === undefined) delete globalThis.document; else globalThis.document = before; });
  const imageCounts = async bytes => {
    const task = pdfjs.getDocument({ data: bytes, standardFontDataUrl: `${root}/standard_fonts/` });
    try {
      const doc = await task.promise, counts = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const ops = await (await doc.getPage(p)).getOperatorList();
        counts.push(ops.fnArray.filter(fn => fn === pdfjs.OPS.paintImageXObject).length);
      }
      return counts;
    } finally { await task.destroy(); }
  };
  for (const mode of ['answer-inline', 'answer-end']) {
    const blocks = makeBlocks(mode, [entry(1, { exportAnswer: '③' }), entry(2, { exportAnswer: 'x=3' }), entry(3)], { labels: false, space: 'none' }, label).filter(b => b.kind !== 'problem');
    const baseline = await imageCounts(await buildPdf({ blocks: blocks.filter(b => b.kind === 'section'), options: { space: 'none' } }));
    drawn.length = 0;
    const bytes = await buildPdf({ blocks, options: { space: 'none' }, renderAnswerPdf: () => assert.fail('인쇄 창 호출 금지') });
    const counts = await imageCounts(bytes);
    assert.equal(counts.length, baseline.length);
    counts.forEach((count, p) => assert.ok(count > baseline[p], `${mode}: 쪽마다 답 그림 증가`));
    const answers = drawn.filter(d => d.color === '#0f5f58').map(d => d.text).join('');
    assert.ok(answers.includes('③'));
    assert.ok(answers.includes('x=3'));
    assert.ok(answers.includes(MISSING_ANSWER));
    if (mode === 'answer-end') assert.ok(drawn.some(d => d.text === '정답' && d.color === '#111' && d.font.startsWith('700 ')), '기존 굵은 검정 section 그림');
  }
  // 좁은 2단에서도 긴 답·출처를 생략하지 않고, 그림 높이로 다음 단·쪽에 넘긴다.
  drawn.length = 0;
  const long = 'W'.repeat(40), source = '긴 출처 '.repeat(15);
  const blocks = [
    ...Array.from({ length: 40 }, () => ({ kind: 'answer-text', text: long })),
    { kind: 'section', text: '정답', answerSection: true },
    { kind: 'answer-table', cells: [{ num: '1.', text: long, source }, { num: '2.', text: 'iii' }, { num: '3.', text: '③' }] },
  ];
  const counts = await imageCounts(await buildPdf({ blocks, options: { columns: 2, space: 'none' }, renderAnswerPdf: () => assert.fail('인쇄 창 호출 금지') }));
  assert.ok(counts.length >= 3, '긴 답은 그림 높이를 계산해 다음 단·쪽에 배치');
  assert.ok(counts.every(n => n > 0));
  const answers = drawn.filter(d => d.color === '#0f5f58');
  assert.equal(answers.map(d => d.text).join('').replace(/\s/g, ''), (long.repeat(40) + `1. ${long} (${source})` + '2. iii   3. ③').replace(/\s/g, ''));
  assert.ok(answers.some(d => d.text.includes('2. iii   3. ③')), '짧은 답 여러 개는 한 줄에 유지');
  assert.ok(answers.some(d => d.canvas.height > 53), '긴 바로 뒤 답은 여러 줄 그림');
  assert.ok(answers.every(d => d.canvas.width / 4 <= (595.28 - 38 * 2 - 22) / 2), '그림은 단 너비 안');
  // 실제 PDF 글자 위치 → DocSource 토큰 → 정답표까지 이어서 확인.
  const { PDFDocument } = await import('../../src/renderer/vendor/pdf-lib.esm.min.js');
  const { DocSource } = await import('../../src/renderer/js/docsource.js');
  const fixture = await PDFDocument.create();
  fixture.addPage([595, 842]).drawText('1 12 2 34 3 56', { x: 40, y: 700, size: 12 });
  const task = pdfjs.getDocument({ data: await fixture.save(), standardFontDataUrl: `${root}/standard_fonts/` });
  try {
    const page = await (await task.promise).getPage(1);
    const src = new DocSource([], name => name);
    src.pages = [{ kind: 'pdf' }];
    src.getTextTokens = () => src._textTokens(page);
    const table = await createAnswerReader().table(src, { pageInfo: { 0: { exclusion: { role: 'answer_table' } } } });
    assert.deepEqual([...table], [['1', '12'], ['2', '34'], ['3', '56']]);
  } finally { await task.destroy(); }
});
