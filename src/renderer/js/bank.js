// 문제은행: 찾기·담기·지문 묶음 (DOM·저장 API 없음)
import { sortItems } from './detect.js';
import { computeMatches, findItem, bookPage } from './store.js';
import { subjectOf } from './subjects.js';
import { makeBlocks, itemName } from './exporter.js';
import { countLow } from './lowconf.js';

/** 마고 공용 책장 책은 읽기 전용이라 학원이 확인 표시를 고칠 수 없음 → 세지 않음. 표시 자료는 그대로 둠. */
export const reviewable = (book) => !(book?.$library || book?.library);
export const reviewMarks = (book, blocks) => reviewable(book) ? countLow(blocks) : 0;
/**
 * 시험지 저장 알림의 '확인 필요' 수 = 내 책 문항 몫만. lowOf(entry, block) 는 그 문항 옮긴 글의 표시 수.
 * hwpxCount(한글 변환이 책 구분 없이 센 수)를 주면 거기서 마고 책 문항 몫만 뺌.
 */
export function exportReviewCount(blocks, entries, lowOf, hwpxCount) {
  const sum = (wanted) => blocks.reduce((n, block) => {
    const entry = entries.find((e) => e.src?.[block.role] === block.src);
    return n + (block.answerBlocks || !entry || !block.item || !wanted(entry.bookObj) ? 0 : lowOf(entry, block));
  }, 0);
  return hwpxCount === undefined ? sum(reviewable) : Math.max(0, hwpxCount - sum((book) => !reviewable(book)));
}

export const choiceMark = (i) => '①②③④⑤'[i] || `${i + 1}.`;

export function blocksToText(blocks) {
  return (blocks || []).map((b) => {
    if (b.type === 'para') return b.text || '';
    if (b.type === 'math') return b.latex || '';
    if (b.type === 'choices') return (b.items || []).map((s, i) => `${choiceMark(i)} ${s}`).join(' ');
    return b.type === 'figure' ? '[그림]' : '';
  }).join(' ').replace(/\s+/g, ' ').trim();
}

export function stemKey(item) {
  if (item.stemId) return 'id:' + item.stemId;
  return item.stem?.length ? JSON.stringify(item.stem.map((r) => [r.page, r.x, r.y, r.w, r.h])) : '';
}

export function passageItem(item) {
  const key = stemKey(item);
  if (!key) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
  return { id: `stem:${(hash >>> 0).toString(36)}`, page: item.stem[0].page, rects: item.stem, number: item.stemLabel || '', prefix: '지문', passage: true };
}

export function bankEntries(books) {
  return books.flatMap((book) => {
    const matches = computeMatches(book);
    return sortItems(book.docs.problem?.items || []).map((item) => ({
      bookId: book.id, bookName: book.name, bookObj: book, subject: subjectOf(book),
      open: book.subjectOpen !== false && book.$subjectOpen !== false,
      item, answer: findItem(book.docs.answer, matches.get(item.id)), stemKey: stemKey(item),
    }));
  });
}

const compact = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
const matchesRange = (value, query) => {
  const q = String(query || '').trim();
  if (!q) return true;
  const range = /^(\d+)\s*[-~]\s*(\d+)$/.exec(q);
  if (range) return +value >= +range[1] && +value <= +range[2];
  if (/^\d+$/.test(String(value)) && /^\d+$/.test(q)) return +value === +q;
  return String(value) === q;
};

/** 공용 책장은 시험 종류 또는 연도를 고른 뒤에만 읽음. */
export function librarySelected(book, filters = {}) {
  return !!(filters.exam || String(filters.year || '').trim()) && examMatches(book, filters);
}
export function examMatches(book, { exam = '', year = '', grade = '', month = '', subject = '', bookId = '' } = {}) {
  const meta = book.exam;
  const library = book.library || book.$library;
  return (!exam || (exam === 'library' ? !!library : !!meta && (exam === 'all' || meta.exam === exam)))
    && (!year || String(meta?.schoolYear || meta?.year) === String(year).trim())
    && (!grade || String(meta?.grade) === String(grade))
    && (!month || String(meta?.exam === 'csat' ? 11 : meta?.month) === String(month))
    && (!subject || (book.subject || 'math') === subject) && (!bookId || book.id === bookId);
}
export function filterBank(entries, filters = {}, textOf = () => '') {
  const { page = '', number = '', text = '' } = filters;
  const q = compact(text);
  const n = String(number).trim().replace(/^[^\d]+\s*/, '').replace(/번$/, '').trim();
  return entries.filter((e) => (!(e.bookObj.$library || e.bookObj.library) || librarySelected(e.bookObj, filters))
    && examMatches(e.bookObj, filters)
    && matchesRange(bookPage(e.bookObj?.docs.problem, e.item.page), page)
    && matchesRange(e.item.number, n) && (!q || compact(`${itemName(e.item)} ${textOf(e)}`).includes(q)));
}

export function orderPicked(picked, entries) {
  const books = [...new Set(picked.map((p) => p.bookId))];
  const keys = new Set(picked.map((p) => JSON.stringify([p.bookId, p.itemId || p.item?.id])));
  return books.flatMap((id) => {
    const list = entries.filter((e) => e.bookId === id && keys.has(JSON.stringify([id, e.item.id])));
    const byId = new Map(list.map((e) => [e.item.id, e]));
    return sortItems(list.map((e) => e.item)).map((it) => byId.get(it.id));
  });
}

/** 기존 내보내기 모양 그대로, 지문만 별도 블록으로 한 번씩 */
export function makeBankBlocks(mode, entries, options, pageLabel) {
  const adapted = entries.map((e) => ({ ...e, problem: e.item, book: e.bookName }));
  const blocks = makeBlocks(mode, adapted, options, pageLabel);
  let previous = '';
  let index = 0;
  return blocks.flatMap((b) => {
    if (b.kind !== 'problem') return [b];
    const e = adapted[index++];
    const key = stemKey(e.item);
    const same = key ? JSON.stringify([e.bookId, key]) : '';
    const add = same && same !== previous;
    previous = same;
    b.stem = null;
    if (!add) return [b];
    const item = passageItem(e.item);
    const source = options?.labels === false ? '' : `${e.bookName} ${pageLabel('problem', item, e)} 지문${item.number ? ` [${item.number}]` : ''}`;
    return [{ kind: 'problem', role: 'problem', item, src: e.src?.problem, stem: null, addSpace: false, num: '', source, passage: true }, b];
  });
}

export function bankTargets(book) {
  const stems = new Set();
  const out = [];
  for (const item of sortItems(book.docs.problem?.items || [])) {
    const key = stemKey(item);
    if (key && !stems.has(key)) {
      stems.add(key);
      out.push({ kind: 'problem', role: 'problem', item: passageItem(item), stem: null, passage: true });
    }
    out.push({ kind: 'problem', role: 'problem', item, stem: null });
  }
  return out;
}
