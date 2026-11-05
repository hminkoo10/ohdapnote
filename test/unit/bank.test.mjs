import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bankEntries, bankTargets, blocksToText, stemKey, passageItem, filterBank, orderPicked, makeBankBlocks } from '../../src/renderer/js/bank.js';
import { itemName } from '../../src/renderer/js/exporter.js';
import { blockSegs, buildHwpx } from '../../src/renderer/js/hwpx.js';
import { transcribeParts } from '../../src/renderer/js/pdfmath.js';

const rect = (page = 0, y = 0.3) => ({ page, x: 0.1, y, w: 0.8, h: 0.1 });
const stem = [rect(0, 0.05)];
const item = (n, page = 0, extra = {}) => ({ id: `p${page}-${n}`, number: String(n), num: n, page, rects: [rect(page, 0.2 + n * 0.1)], ...extra });
const first = item(1, 0, { stem, stemLabel: '1~2' });
const second = item(2, 0, { stem: structuredClone(stem), stemLabel: '1~2' });
const prefix = item(3, 1, { prefix: '유제' });
const book = { id: 'a', name: '수학 교재', docs: { problem: { items: [prefix, second, first], pageOffset: 11 }, answer: { items: [item(1, 2), item(2, 2)] } } };
const other = { id: 'b', name: '영어 교재', subject: 'english', docs: { problem: { items: [item(4, 3)] }, answer: null } };
const entries = bankEntries([book, other]);
const label = (role, it, e) => `p.${it.page + 1 + (e.bookObj.docs[role]?.pageOffset || 0)}`;

test('문제은행 해설: 사람 글 우선, 답지 없는 교재의 정답도 출력', () => {
  for (const original of [entries[0], entries.at(-1)]) {
    const e = { ...original, writtenAnswer: { answer: '③', blocks: [{ type: 'para', text: '직접 쓴 풀이' }] } };
    const blocks = makeBankBlocks('answers', [e], {}, label);
    assert.deepEqual(blocks[0].answerBlocks, e.writtenAnswer.blocks);
    assert.equal(blocks[0].bookId, original.bookId);
    e.writtenAnswer = { answer: '12', blocks: [] };
    assert.equal(makeBankBlocks('answers', [e], {}, label)[0].answerBlocks[0].text, '정답 12');
  }
});

test('문제은행 일반 PDF: 명시해서 켜면 본문도 옮기고, 기존 기본값은 유지', () => {
  const text = 'Read the passage 다음 글';
  const glyphs = [...text].map((c, i) => ({ c, fam: 'Helvetica', style: '', x0: 50 + i * 8, x1: 58 + i * 8, base: 100, top: 92, bottom: 102, size: 10, xem: 10, rot: false, seq: i }));
  const part = { layer: { w: 600, h: 800, glyphs, lines: [], shapes: [] }, rect: { x: 0, y: 0, w: 1, h: 1 }, place: { x: 0, y: 0, w: 1, h: 1 } };
  assert.equal(transcribeParts([part]), null);
  assert.deepEqual(transcribeParts([part], { plain: true }), [{ type: 'para', text }]);
  part.layer.glyphs[0] = { ...glyphs[0], c: '\u0001', fam: 'EHsang' };
  assert.equal(transcribeParts([part], { plain: true }), null, '모르는 수식은 허용하지 않음');
});

test('지문 열쇠와 가짜 문항: 저장 후에도 같은 영역은 같은 id, 속성 순서 무관', () => {
  const copy = JSON.parse(JSON.stringify(second));
  copy.stem = copy.stem.map(({ page, x, y, w, h }) => ({ h, w, y, x, page }));
  assert.equal(stemKey(first), stemKey(copy));
  assert.equal(passageItem(first).id, passageItem(copy).id);
  assert.equal(stemKey(prefix), '');
  assert.equal(passageItem(prefix), null);
  assert.equal(itemName(passageItem(first)), '지문 1~2');
  assert.deepEqual(passageItem(first).rects, stem);
  assert.equal(passageItem(first).page, 0);
  assert.equal(passageItem(first).passage, true);
  assert.notEqual(stemKey(first), stemKey({ stem: [rect(1)] }));
});

test('목록: 읽는 순서·말머리 문항·해설 짝·계약 빠진 과목도 보기', () => {
  assert.deepEqual(entries.map((e) => e.item.number), ['1', '2', '3', '4']);
  assert.equal(entries[0].answer.number, '1');
  assert.equal(entries[2].answer, null);
  assert.equal(entries[2].item.prefix, '유제');
  assert.equal(entries[3].subject, 'english');
  assert.equal(bankEntries([{ ...book, subjectOpen: false }])[0].open, false);
  assert.equal(bankEntries([{ ...book, $subjectOpen: false }])[0].open, false);
  const override = bankEntries([{ ...book, answerOverrides: { [first.id]: null, [second.id]: 'p2-1' } }]);
  assert.equal(override[0].answer, null);
  assert.equal(override[1].answer.number, '1');
});

test('stemId: 영역이 달라도 같은 지문, 다른 쪽의 여러 조각을 함께 내보냄', async () => {
  const pieces = [rect(0, 0.05), rect(1, 0.05)];
  const a = item(1, 1, { stemId: '3:1~3', stem: pieces });
  const b = item(2, 1, { stemId: '3:1~3', stem: pieces.map((r) => ({ ...r, h: r.h + 0.001 })) });
  assert.equal(stemKey(a), 'id:3:1~3');
  assert.equal(stemKey(a), stemKey(b));
  assert.equal(passageItem(a).id, passageItem(b).id);
  assert.notEqual(stemKey(a), stemKey({ ...a, stemId: '3:4~6' }));
  const grouped = { ...book, docs: { problem: { items: [b, a] } } };
  const targets = bankTargets(grouped);
  assert.equal(targets.length, 3);
  assert.deepEqual(targets[0].item.rects, pieces);
  const src = { pages: Array(2).fill({ w: 595, h: 842, kind: 'pdf' }) };
  const list = bankEntries([grouped]).map((e) => ({ ...e, src: { problem: src } }));
  assert.ok(list.every((e) => e.stemKey === 'id:3:1~3'));
  const blocks = makeBankBlocks('problems', list, {}, label);
  assert.equal(blocks.filter((b) => b.passage).length, 1);
  assert.equal(blocks[0].item.id, targets[0].item.id);
  assert.deepEqual(blockSegs(blocks[0]).map((s) => s.rect), pieces);
  const seen = [];
  const bytes = await buildHwpx({ blocks, transcribe: async (block, segs) => {
    if (block.passage) seen.push(segs.map((s) => s.rect.page));
    return { blocks: [{ type: 'para', text: '여러 쪽 지문과 문항' }] };
  } });
  assert.deepEqual(seen, [[0, 1]]);
  assert.equal(bytes.stats.text, 3);
});

test('찾기: 과목·책·인쇄된 쪽·쪽 범위', () => {
  assert.equal(filterBank(entries, { subject: 'english' }).length, 1);
  assert.equal(filterBank(entries, { bookId: 'a' }).length, 3);
  assert.equal(filterBank(entries, { page: '12' }).length, 2);
  assert.equal(filterBank(entries, { page: '12-13' }).length, 3);
  assert.equal(filterBank(entries, { page: '13-15', subject: 'math', bookId: 'a' })[0].item, prefix);
  assert.equal(filterBank(entries, { page: '잘못된 쪽' }).length, 0);
});

test('찾기: 번호 일치·범위·유제 번호', () => {
  assert.equal(filterBank(entries, { number: '1' })[0].item, first);
  assert.deepEqual(filterBank(entries, { number: '2-4' }).map((e) => e.item.number), ['2', '3', '4']);
  assert.equal(filterBank(entries, { number: '유제 3' })[0].item, prefix);
  assert.equal(filterBank(entries, { number: '3번' })[0].item, prefix);
});

test('글자로 찾기: 공백·대소문자 무시, 공통 지문의 글로도 문항 검색', () => {
  const textOf = (e) => e.stemKey ? '이차 함수 Read the passage' : '빈칸';
  assert.equal(filterBank(entries, { text: '이차함수' }, textOf).length, 2);
  assert.equal(filterBank(entries, { text: 'READ\nTHE PASSAGE' }, textOf).length, 2);
  assert.equal(filterBank(entries, { text: '빈 칸', number: '3' }, textOf)[0].item, prefix);
  assert.equal(filterBank(entries, { text: '삼각함수' }, textOf).length, 0);
});

test('번호 찾기: 앞의 0은 숫자끼리만 무시하고 범위·말머리도 유지', () => {
  const list = ['0153', '153', '0154', '153a'].map((number) => ({ ...entries[0], item: { ...first, number } }));
  for (const number of ['153', '0153', '유제 153번']) {
    assert.deepEqual(filterBank(list, { number }).map((e) => e.item.number), ['0153', '153']);
  }
  assert.equal(filterBank(list, { number: '153-154' }).length, 3);
  assert.deepEqual(filterBank(list, { number: '153a' }).map((e) => e.item.number), ['153a']);
});

test('담은 순서: 처음 담은 책 순서 → 책 안 읽는 순서, 없어진 문항·중복 제외', () => {
  const picked = [{ bookId: 'b', itemId: 'p3-4' }, { bookId: 'a', itemId: prefix.id }, { bookId: 'a', itemId: first.id }, { bookId: 'a', itemId: first.id }, { bookId: 'a', itemId: '없음' }];
  assert.deepEqual(orderPicked(picked, entries).map((e) => e.item.number), ['4', '1', '3']);
});

test('블록 글: 글·수식·보기·그림, 공백 하나로', () => {
  assert.equal(blocksToText([{ type: 'para', text: '첫 줄\n 다음 줄' }, { type: 'math', latex: 'x^2' }, { type: 'choices', items: ['1', '2'] }, { type: 'figure', box: rect() }]), '첫 줄 다음 줄 x^2 ① 1 ② 2 [그림]');
  assert.equal(blocksToText(null), '');
});

test('교재 넣기 대상: 같은 지문 한 번, 문제마다 지문 없음, 해설 없음', () => {
  const targets = bankTargets(book);
  assert.equal(targets.length, 4);
  assert.equal(targets[0].item.passage, true);
  assert.ok(targets.every((b) => b.role === 'problem' && b.stem === null));
  assert.deepEqual(targets.slice(1).map((b) => b.item.id), [first.id, second.id, prefix.id]);
});

test('문제 내보내기: 지문 한 번·번호는 문제만·출처·원본은 그대로', () => {
  const src = { files: [{ name: '교재.pdf' }] };
  const list = entries.slice(0, 3).map((e) => ({ ...e, src: { problem: src } }));
  const blocks = makeBankBlocks('problems', list, { renumber: true }, label);
  assert.deepEqual(blocks.map((b) => b.num), ['', '1.', '2.', '3.']);
  assert.equal(blocks[0].source, '수학 교재 p.12 지문 [1~2]');
  assert.equal(blocks[0].src, src);
  assert.equal(blocks[0].addSpace, false);
  assert.ok(blocks.slice(1).every((b) => b.addSpace && b.stem === null));
  assert.equal(blocks[1].source, '수학 교재 p.12 1번');
  assert.deepEqual(first.stem, stem);
  const bare = makeBankBlocks('problems', list, { labels: false, renumber: false }, label);
  assert.ok(bare.every((b) => !b.source && !b.num));
});

test('지문 바뀜·지문 없는 문제·다른 교재 뒤에 다시 나오면 지문 다시 싣기', () => {
  const a = entries[0];
  const b = { ...a, item: { ...second, stem: [rect(1)] } };
  const list = [a, b, a, entries[2], a, { ...a, bookId: 'c' }];
  assert.equal(makeBankBlocks('problems', list, {}, label).filter((x) => x.passage).length, 5);
});

test('해설지만: 지문 없음·문제 번호 유지·없는 해설 안내', () => {
  const blocks = makeBankBlocks('answers', entries.slice(0, 3), {}, label);
  assert.deepEqual(blocks.map((b) => b.kind), ['answer', 'answer', 'note']);
  assert.ok(blocks.every((b) => !b.passage && !b.stem));
  assert.equal(blocks[2].num, '3.');
});

test('문제마다 해설: 해설·쪽 나눔이 끼어도 지문은 한 번', () => {
  const blocks = makeBankBlocks('both-inline', entries.slice(0, 2), { space: 'page' }, label);
  assert.deepEqual(blocks.map((b) => b.kind), ['problem', 'problem', 'answer', 'pagebreak', 'problem', 'answer', 'pagebreak']);
  assert.equal(blocks.filter((b) => b.passage).length, 1);
  assert.deepEqual(blocks.filter((b) => b.kind === 'answer').map((b) => b.num), ['1.', '2.']);
});

test('맨 뒤에 해설: 지문 하나·문제 뒤 구분 제목·해설 순서', () => {
  const blocks = makeBankBlocks('both-end', entries.slice(0, 2), {}, label);
  assert.deepEqual(blocks.map((b) => b.kind), ['problem', 'problem', 'problem', 'section', 'answer', 'answer']);
  assert.equal(blocks.filter((b) => b.passage).length, 1);
  assert.equal(blocks[3].text, '정답 및 해설');
});

test('HWPX 기존 그리기와 호환: 지문 자체 영역 한 번, 문제는 지문 없이', async () => {
  const src = { pages: [{ w: 595, h: 842, kind: 'pdf' }] };
  const blocks = makeBankBlocks('problems', entries.slice(0, 2).map((e) => ({ ...e, src: { problem: src } })), {}, label);
  assert.deepEqual(blockSegs(blocks[0]).map((s) => s.rect), stem);
  assert.deepEqual(blockSegs(blocks[1]).map((s) => s.rect), first.rects);
  const seen = [];
  const bytes = await buildHwpx({ blocks, transcribe: async (b) => {
    seen.push(b.item.id);
    return { blocks: [{ type: 'para', text: b.item.passage ? '함께 읽는 지문' : '문제 내용' }] };
  } });
  assert.equal(bytes.stats.text, 3);
  assert.equal(seen.filter((id) => id.startsWith('stem:')).length, 1);
  assert.ok(bytes.length > 1000);
});
