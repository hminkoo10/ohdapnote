// 프로젝트 데이터 도우미

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
export function computeMatches(project) {
  const p = project.docs.problem;
  const a = project.docs.answer;
  const result = new Map();
  if (!p?.items?.length) return result;
  const auto = a?.items?.length ? matchItems(sortItems(p.items), sortItems(a.items)) : new Map();
  const answerIds = new Set((a?.items || []).map((i) => i.id));
  const overrides = project.answerOverrides || {};
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

/** 선택한 문제들(읽는 순서) */
export function selectedItems(project) {
  const doc = project.docs.problem;
  if (!doc) return [];
  const sel = new Set(project.selected || []);
  return sortItems(doc.items.filter((it) => sel.has(it.id)));
}

/** 문항 목록이 바뀐 뒤 ID 재부여 + 선택/짝 정리 */
export function normalizeDoc(project, role) {
  const doc = project.docs[role];
  if (!doc) return;
  const before = new Map(doc.items.map((it) => [it, it.id]));
  doc.items = assignIds(sortItems(doc.items));
  // ID 가 바뀐 항목은 선택/짝 정보도 옮김
  const renamed = new Map();
  for (const it of doc.items) {
    const old = before.get(it);
    if (old && old !== it.id) renamed.set(old, it.id);
  }
  if (!renamed.size) return;
  if (role === 'problem') {
    project.selected = (project.selected || []).map((id) => renamed.get(id) || id);
    const ov = {};
    for (const [k, v] of Object.entries(project.answerOverrides || {})) ov[renamed.get(k) || k] = v;
    project.answerOverrides = ov;
  } else {
    for (const k of Object.keys(project.answerOverrides || {})) {
      const v = project.answerOverrides[k];
      if (v && renamed.has(v)) project.answerOverrides[k] = renamed.get(v);
    }
  }
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
