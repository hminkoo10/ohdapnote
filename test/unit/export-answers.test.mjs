import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAnswer, headAnswer, shortAnswer, tablePairs, uniqueTable, createAnswerReader, resolveExportAnswers, MISSING_ANSWER, mayHaveAnswers } from '../../src/renderer/js/export-answers.js';
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
