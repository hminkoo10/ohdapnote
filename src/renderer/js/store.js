// 책·오답노트 데이터 도우미

import { matchItems } from './match.js';
import { sortItems, assignIds } from './detect.js';

export const ROLES = ['problem', 'answer'];
export const ROLE_NAME = { problem: '문제집', answer: '답지' };

export function newDoc(role, imported) {
  return {
    files: imported.files,
    originalName: imported.originalName,
    pageCount: 0,
    range: '',
    options: { flow: role === 'answer' ? 'continue' : 'column', numberStyle: 'auto' },
    pageOffset: 0,
    pageOffsetAuto: true,
    items: [],
    pageInfo: {},
    signature: null,
    analyzedAt: null,
    edited: false,
  };
}

export function bookPage(doc, pageIndex) {
  return pageIndex + 1 + (doc?.pageOffset || 0);
}

export function pageLabel(doc, pageIndex) {
  return `p.${bookPage(doc, pageIndex)}`;
}

export function itemsByPage(doc) {
  const map = new Map();
  for (const it of sortItems(doc?.items || [])) {
    if (!map.has(it.page)) map.set(it.page, []);
    map.get(it.page).push(it);
  }
  return map;
}

export function findItem(doc, id) {
  return (doc?.items || []).find((it) => it.id === id) || null;
}

/** 자동 매칭 + 사용자가 직접 고친 짝 */
export function computeMatches(book) {
  const p = book.docs.problem;
  const a = book.docs.answer;
  const result = new Map();
  if (!p?.items?.length) return result;
  const auto = a?.items?.length ? matchItems(sortItems(p.items), sortItems(a.items)) : new Map();
  const answerIds = new Set((a?.items || []).map((i) => i.id));
  const overrides = book.answerOverrides || {};
  for (const it of p.items) {
    if (Object.prototype.hasOwnProperty.call(overrides, it.id)) {
      const v = overrides[it.id];
      result.set(it.id, v && answerIds.has(v) ? v : null);
    } else {
      result.set(it.id, auto.get(it.id) || null);
    }
  }
  return result;
}

/** 오답노트에서 이 책에서 고른 문항 ID 목록 */
export function noteSelection(note, bookId) {
  note.selected ||= {};
  if (!Array.isArray(note.selected[bookId])) note.selected[bookId] = [];
  return note.selected[bookId];
}

export function setNoteSelection(note, bookId, ids) {
  note.selected ||= {};
  note.selected[bookId] = [...new Set(ids)];
}

export function noteSelectedCount(note) {
  return Object.values(note?.selected || {}).reduce((s, list) => s + (Array.isArray(list) ? list.length : 0), 0);
}

/** 이 책에서 고른 문제들(읽는 순서). 책에서 사라진 문항은 빠짐 */
export function selectedItems(book, ids) {
  const doc = book?.docs?.problem;
  if (!doc) return [];
  const sel = new Set(ids || []);
  return sortItems(doc.items.filter((it) => sel.has(it.id)));
}

/**
 * 문항 목록이 바뀐 뒤 ID 재부여 + 짝 정리
 * @returns {{renames: Object<string,string>}} 바뀐 문제 ID (오답노트 선택을 따라 바꾸는 데 씀)
 */
export function normalizeDoc(book, role) {
  const doc = book.docs[role];
  const renamesOut = {};
  if (!doc) return { renames: renamesOut };
  const before = new Map(doc.items.map((it) => [it, it.id]));
  doc.items = assignIds(sortItems(doc.items));
  // ID 가 바뀐 항목은 짝 정보도 옮김
  const renamed = new Map();
  for (const it of doc.items) {
    const old = before.get(it);
    if (old && old !== it.id) renamed.set(old, it.id);
  }
  if (!renamed.size) return { renames: renamesOut };
  if (role === 'problem') {
    for (const [k, v] of renamed) renamesOut[k] = v;
    if (Array.isArray(book.selected)) book.selected = book.selected.map((id) => renamed.get(id) || id);
    const ov = {};
    for (const [k, v] of Object.entries(book.answerOverrides || {})) ov[renamed.get(k) || k] = v;
    book.answerOverrides = ov;
  } else {
    for (const k of Object.keys(book.answerOverrides || {})) {
      const v = book.answerOverrides[k];
      if (v && renamed.has(v)) book.answerOverrides[k] = renamed.get(v);
    }
  }
  return { renames: renamesOut };
}

/** 확인이 필요한 쪽 (사용자가 "문제없음"으로 넘긴 쪽은 뺌) */
export function flaggedPages(doc) {
  return Object.entries(doc?.pageInfo || {})
    .filter(([, pi]) => pi?.flags?.length && !pi.ok)
    .map(([k]) => Number(k))
    .sort((a, b) => a - b);
}

/**
 * 번호가 이어지지 않는 곳 → 빠진 것 같은 번호
 * 같은 머리말(유제·예제 등)끼리 순서대로 보고, 1~30 사이로 건너뛴 번호만 셉니다.
 * @returns {Map<number, {num:number, prefix:string, digits:number, afterId:string|null}[]>} 쪽 → 빠진 번호
 */
export function missingNumbers(doc, { maxGap = 30 } = {}) {
  const out = new Map();
  if (!doc?.items?.length) return out;
  const sorted = sortItems(doc.items);
  const byPrefix = new Map(); // prefix → 그 머리말 문항들(읽는 순서)
  for (const it of sorted) {
    const key = it.prefix || '';
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key).push(it);
  }
  for (const [key, list] of byPrefix) {
    const reported = new Map(); // 번호 → 이미 빠졌다고 알린 쪽 (같은 번호를 두 번 알리지 않게)
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const it = list[i];
      if (!(it.num > prev.num + 1) || it.num - prev.num - 1 > maxGap) continue;
      const page = it.page;
      if (doc.pageInfo?.[page]?.ok || doc.pageInfo?.[prev.page]?.ok) continue;
      // 가까운 곳(앞뒤 쪽, 앞뒤 maxGap 문항)에 이미 있는 번호는 빠진 게 아님 (번호 하나만 잘못 읽은 경우)
      // 단원이 바뀌어 1번부터 다시 시작하는 먼 쪽의 번호는 세지 않음
      const near = new Set(
        list
          .slice(Math.max(0, i - maxGap), i + maxGap)
          .filter((x) => x.page >= prev.page - 1 && x.page <= it.page + 1)
          .map((x) => x.num),
      );
      const miss = [];
      for (let n = prev.num + 1; n < it.num; n++) {
        if (near.has(n) || Math.abs((reported.get(n) ?? -99) - page) <= 1) continue;
        reported.set(n, page);
        miss.push(n);
      }
      if (!miss.length) continue;
      if (!out.has(page)) out.set(page, []);
      for (const n of miss) {
        out.get(page).push({ num: n, prefix: key, digits: it.number.length > String(it.num).length ? it.number.length : 0, afterId: prev.page === page ? prev.id : null, beforeId: it.id });
      }
    }
  }
  return out;
}

export function missingCount(doc) {
  let n = 0;
  for (const list of missingNumbers(doc).values()) n += list.length;
  return n;
}

/**
 * 빠른 선택 문법 해석
 *   "12쪽 3, 5"  "p12: 3 5"  "3, 7-9"(번호만 - 같은 번호가 여러 쪽에 있으면 모두)
 * @returns {{ids:string[], unknown:string[]}}
 */
export function parseQuickSelect(text, doc) {
  const ids = [];
  const unknown = [];
  const byPage = itemsByPage(doc);
  const all = doc.items;
  const pushNumbers = (list, numbers) => {
    for (const n of numbers) {
      const hit = list.filter((it) => it.num === n);
      if (hit.length) ids.push(...hit.map((it) => it.id));
      else unknown.push(String(n));
    }
  };
  const expand = (s) => {
    const out = [];
    for (const part of s.split(/[,\s]+/).filter(Boolean)) {
      const m = /^(\d+)\s*[~-]\s*(\d+)$/.exec(part);
      if (m) for (let k = +m[1]; k <= +m[2] && out.length < 2000; k++) out.push(k);
      else if (/^\d+$/.test(part)) out.push(+part);
      else unknown.push(part);
    }
    return out;
  };
  for (const chunk of String(text).split(/[;/\n]+/).map((s) => s.trim()).filter(Boolean)) {
    let m = /^(?:p\.?\s*)?(\d+)\s*(?:쪽|p|페이지)?\s*[:：]\s*(.+)$/i.exec(chunk) || /^(?:p\.?\s*)?(\d+)\s*(?:쪽|페이지)\s+(.+)$/i.exec(chunk) || /^p\.?\s*(\d+)\s+(.+)$/i.exec(chunk);
    if (m) {
      const pageNum = +m[1];
      const pageIdx = pageNum - 1 - (doc.pageOffset || 0);
      const list = byPage.get(pageIdx) || [];
      if (!list.length) unknown.push(`${pageNum}쪽`);
      pushNumbers(list, expand(m[2]));
      continue;
    }
    pushNumbers(all, expand(chunk));
  }
  return { ids: [...new Set(ids)], unknown };
}
