// 여러 화면이 같이 쓰는 것들: 상태, 화면 이동, 원본 파일 열기, 문항 표, 미리보기, Gemini 실행 창

import { h, clear, toast, modal, icon, debounce } from './ui.js';
import { openDocSource, bookFileUrl } from './docsource.js';
import { detectPageWithGemini, replacePageItems } from './analyze.js';
import { itemName } from './exporter.js';
import { ROLE_NAME, pageLabel, bookPage, itemsByPage, findItem, flaggedPages, normalizeDoc } from './store.js';
import { sortItems } from './detect.js';

export const api = window.ohdap;

export const state = {
  appInfo: null,
  settings: null,
  update: { status: 'idle' },
  view: null, // 'home' | 'book' | 'note'
};

/** 화면 이동 (app.js 에서 채움) */
export const nav = {
  home: async () => {},
  book: async () => {},
  note: async () => {},
  settings: async () => {},
};

/** 화면을 떠나기 전에 할 일(저장 등) */
export const leaveHooks = new Set();
export async function runLeaveHooks() {
  for (const fn of [...leaveHooks]) {
    try {
      await fn();
    } catch (err) {
      console.error(err);
    }
  }
  leaveHooks.clear();
}

// ===========================================================================
// 저장 도우미: 바뀐 뒤 잠깐 기다렸다가 저장
// ===========================================================================
export function makeSaver(saveFn) {
  let target = null;
  const setStatus = (text) => {
    const el = document.querySelector('.save-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('saving', text.endsWith('…'));
  };
  const now = async () => {
    if (!target) return;
    target.updatedAt = Date.now();
    try {
      await saveFn(target);
      setStatus('저장됨');
    } catch (err) {
      setStatus('저장 실패');
      toast(`저장하지 못했어요: ${err.message}`, { type: 'error' });
    }
  };
  const soon = debounce(now, 600);
  return {
    set(obj) {
      target = obj;
    },
    dirty() {
      setStatus('저장 중…');
      soon();
    },
    async flush() {
      soon.cancel();
      await now();
    },
    cancel: () => soon.cancel(),
    get target() {
      return target;
    },
  };
}

// ===========================================================================
// 원본 파일(DocSource) — 책마다 열어 두고 여러 화면이 같이 씀
// ===========================================================================
const sourceCache = new Map(); // key → {promise, used}
const MAX_SOURCES = 8;

const sourceKey = (book, role) => {
  const d = book?.docs?.[role];
  return d?.files?.length ? `${book.id}:${role}:${d.files.map((f) => f.name).join(',')}` : null;
};

export async function getSource(book, role) {
  const key = sourceKey(book, role);
  if (!key) return null;
  let entry = sourceCache.get(key);
  if (!entry) {
    const promise = openDocSource(book.docs[role].files, (name) => bookFileUrl(book.id, name));
    entry = { promise, used: Date.now() };
    sourceCache.set(key, entry);
    promise.catch(() => sourceCache.delete(key));
    trimSources();
  }
  entry.used = Date.now();
  try {
    const src = await entry.promise;
    book.docs[role].pageCount = src.numPages;
    return src;
  } catch (err) {
    toast(`${book.name}의 ${ROLE_NAME[role]} 파일을 열지 못했어요: ${err.message}`, { type: 'error', timeout: 8000 });
    return null;
  }
}

export async function getSources(book) {
  const [problem, answer] = await Promise.all([getSource(book, 'problem'), getSource(book, 'answer')]);
  return { problem, answer };
}

function trimSources() {
  if (sourceCache.size <= MAX_SOURCES) return;
  const sorted = [...sourceCache.entries()].sort((a, b) => a[1].used - b[1].used);
  for (const [key, entry] of sorted.slice(0, sourceCache.size - MAX_SOURCES)) {
    sourceCache.delete(key);
    entry.promise.then((s) => s.destroy()).catch(() => {});
  }
}

/** 파일을 바꾸거나 책을 지웠을 때 */
export function dropSources(bookId, role = null) {
  for (const [key, entry] of sourceCache) {
    const [id, r] = key.split(':');
    if (id === bookId && (!role || r === role)) {
      sourceCache.delete(key);
      entry.promise.then((s) => s.destroy()).catch(() => {});
    }
  }
  clearPreviewCache();
}

// ===========================================================================
// 문항 그림 (미리보기)
// ===========================================================================
const previewCache = new Map();
const srcIds = new WeakMap();
let srcSeq = 0;
const srcId = (src) => {
  if (!srcIds.has(src)) srcIds.set(src, ++srcSeq);
  return srcIds.get(src);
};
export const clearPreviewCache = () => previewCache.clear();

/** 문항 영역(여러 조각이면 이어 붙여서) → data URL */
export async function itemImage(src, item, widthPx, { stem = null } = {}) {
  if (!src || !item) return null;
  const rects = [...(stem || []), ...item.rects];
  const key = `${srcId(src)}|${widthPx}|${JSON.stringify(rects)}`;
  if (previewCache.has(key)) return previewCache.get(key);
  const parts = [];
  for (const r of rects) {
    if (!src.pages[r.page]) continue;
    const pageW = Math.min(2400, Math.round(widthPx / Math.max(0.15, r.w)));
    parts.push(await src.renderRegion(r.page, r, pageW));
  }
  if (!parts.length) return null;
  const W = Math.max(...parts.map((c) => c.width));
  const gap = 10;
  const H = parts.reduce((s, c) => s + c.height, 0) + gap * (parts.length - 1);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  let y = 0;
  parts.forEach((c, i) => {
    ctx.drawImage(c, 0, y);
    y += c.height;
    if (i < parts.length - 1) {
      ctx.strokeStyle = '#d5d9de';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y + gap / 2);
      ctx.lineTo(W, y + gap / 2);
      ctx.stroke();
      y += gap;
    }
  });
  const url = canvas.toDataURL('image/png');
  if (previewCache.size > 200) previewCache.delete(previewCache.keys().next().value);
  previewCache.set(key, url);
  return url;
}

function previewImg() {
  const img = h('img.preview-img', { alt: '' });
  img.addEventListener('load', () => {
    img.classList.add('loaded');
    img.closest('.preview-scroll')?.classList.add('ready');
  });
  return img;
}

/**
 * 미리보기 상자 그리기 (문제 + 짝이 되는 해설)
 * @param {HTMLElement} box
 * @param {object} o {book, sources, item, matches, selected?:boolean, onToggleSelect?, onOverride?, onShow?(role,page,id)}
 */
let previewToken = 0;
export async function renderPreview(box, o) {
  if (!box) return;
  const token = ++previewToken;
  clear(box);
  const { book, sources, item, matches } = o;
  if (!item) {
    box.append(
      h(
        'div.preview-empty',
        h('span.pe-icon', icon('eye')),
        h('div', o.emptyText || ['번호 위에 마우스를 올리면', h('br'), '문제와 해설을 여기서 볼 수 있어요.']),
      ),
    );
    return;
  }
  const doc = book.docs.problem;
  const ansDoc = book.docs.answer;
  const ansId = matches?.get(item.id);
  const ans = ansId ? findItem(ansDoc, ansId) : null;
  const width = Math.max(320, Math.round((box.clientWidth || 380) * Math.min(2, window.devicePixelRatio || 1)));
  const probImg = previewImg();
  const ansImg = previewImg();
  box.append(
    h(
      'div.preview-head',
      h('span.tag', '문제'),
      h('strong', `${pageLabel(doc, item.page)} ${itemName(item)}`),
      item.stemLabel ? h('span.tag.soft', { title: '공통 지문이 함께 나가요' }, `지문 ${item.stemLabel}`) : null,
      h('span.push'),
      o.onShow ? h('button.btn.btn-small.btn-ghost', { title: '책 화면에서 이 쪽 보기', onclick: () => o.onShow('problem', item.page, item.id) }, icon('eye')) : null,
      o.onToggleSelect
        ? h(
            `button.btn.btn-small${o.selected ? '.btn-active' : '.btn-primary'}`,
            { onclick: () => o.onToggleSelect(item) },
            o.selected ? icon('check') : icon('plus'),
            o.selected ? '골랐음' : '고르기',
          )
        : null,
    ),
    h('div.preview-scroll', probImg),
  );
  if (ansDoc) {
    const options = sortItems(ansDoc.items || []).filter((a) => a.num === item.num);
    const overrides = book.answerOverrides || {};
    const has = Object.prototype.hasOwnProperty.call(overrides, item.id);
    const sel = o.onOverride
      ? h(
          'select.input.input-small',
          { title: '짝이 되는 해설 바꾸기', onchange: (e) => o.onOverride(item, e.target.value) },
          h('option', { value: '__auto' }, '자동으로 찾기'),
          options.map((a) => h('option', { value: a.id, selected: has && ans?.id === a.id }, `답지 ${pageLabel(ansDoc, a.page)} ${itemName(a)}`)),
          h('option', { value: '', selected: has && !overrides[item.id] }, '해설 없음'),
        )
      : null;
    box.append(
      h(
        'div.preview-head.ans',
        h('span.tag.teal', '해설'),
        h('strong', ans ? `답지 ${pageLabel(ansDoc, ans.page)} ${itemName(ans)}` : '짝을 못 찾음'),
        h('span.push'),
        sel,
        ans && o.onShow ? h('button.btn.btn-small.btn-ghost', { title: '답지에서 보기', onclick: () => o.onShow('answer', ans.page, ans.id) }, icon('eye')) : null,
      ),
      ans
        ? h('div.preview-scroll', ansImg)
        : h('p.muted.small.pad', '답지에서 같은 번호를 찾지 못했어요. 목록에서 직접 고르거나, 책 화면의 페이지 검토에서 답지 영역을 그려 주세요.'),
    );
  }
  const [pu, au] = await Promise.all([
    itemImage(sources.problem, item, width, { stem: item.stem }),
    ans ? itemImage(sources.answer, ans, width) : null,
  ]);
  if (token !== previewToken) return;
  if (pu) probImg.src = pu;
  if (au) ansImg.src = au;
}

// ===========================================================================
// 문항 표 (쪽마다 번호 칩)
// ===========================================================================
/**
 * @param {object} o
 *   doc, role
 *   selected?: Set<string>          (오답노트: 고른 문항)
 *   matches?: Map, hasAnswers?: boolean
 *   missing?: Map<page, {...}[]>    (빠진 것 같은 번호)
 *   flagged?: Set<number>           (확인 필요 쪽)
 *   onlySelected?: boolean
 *   focusId?: string
 *   onChip(it, page, items), onPage(page, items, el), onHover(it), onMissing(page, m), onFlag(page)
 */
export function renderQTable(table, o) {
  clear(table);
  const { doc } = o;
  const byPage = itemsByPage(doc);
  // 빠진 번호만 있는 쪽도 줄을 만듦
  for (const page of o.missing?.keys() || []) if (!byPage.has(page)) byPage.set(page, []);
  for (const page of o.flagged || []) if (!byPage.has(page)) byPage.set(page, []);
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const sel = o.selected || new Set();
  let rowIndex = 0;
  const rows = [];
  for (const page of pages) {
    const items = byPage.get(page);
    const shown = o.onlySelected ? items.filter((it) => sel.has(it.id)) : items;
    if (o.onlySelected && !shown.length) continue;
    const allOn = !!o.selected && items.length > 0 && items.every((it) => sel.has(it.id));
    const flagged = o.flagged?.has(page);
    const missing = o.onlySelected ? [] : o.missing?.get(page) || [];
    // 빠진 번호를 제자리(앞 문항 바로 뒤)에 끼워 넣음
    const chips = [];
    const missingBefore = new Map();
    for (const m of missing) {
      const key = m.beforeId;
      if (!missingBefore.has(key)) missingBefore.set(key, []);
      missingBefore.get(key).push(m);
    }
    for (const it of shown) {
      for (const m of missingBefore.get(it.id) || []) chips.push(missingChip(m, page));
      const ans = o.matches?.get(it.id);
      chips.push(
        h(
          `button.chip${sel.has(it.id) ? '.on' : ''}${o.hasAnswers && !ans ? '.noans' : ''}${o.focusId === it.id ? '.focus' : ''}${it.source === 'manual' ? '.manual' : ''}`,
          {
            dataset: { id: it.id },
            title: `${pageLabel(doc, it.page)} ${itemName(it)}${o.hasAnswers && !ans ? ' (해설 짝 없음)' : ''}${it.stemLabel ? ` · 공통 지문 ${it.stemLabel}` : ''}`,
            onclick: () => o.onChip?.(it, page, items),
            onmouseenter: () => o.onHover?.(it),
          },
          it.prefix ? h('span.chip-pre', it.prefix) : null,
          it.number,
          it.stem ? h('span.chip-dot', { title: '공통 지문' }) : null,
        ),
      );
    }
    for (const m of missing.filter((x) => !shown.some((it) => it.id === x.beforeId))) chips.push(missingChip(m, page));

    rows.push(
      h(
        `div.qrow${flagged ? '.flagged' : ''}`,
        { style: { '--i': Math.min(rowIndex++, 24) }, dataset: { page: String(page) } },
        h(
          `button.qpage${allOn ? '.on' : ''}`,
          {
            dataset: { page: String(page) },
            title: o.selected ? `${pageLabel(doc, page)} (PDF ${page + 1}쪽) — 눌러서 이 쪽 전체 선택/해제` : `${pageLabel(doc, page)} (PDF ${page + 1}쪽)`,
            onclick: (e) => o.onPage?.(page, items, e.currentTarget),
          },
          h('span.qpage-num', `${bookPage(doc, page)}`),
          h('span.qpage-unit', '쪽'),
        ),
        h('div.qchips', chips.length ? chips : h('span.muted.small', '찾은 문항 없음')),
        flagged
          ? h(
              'button.qflag',
              { title: `${(doc.pageInfo?.[page]?.flags || []).join(', ')} — 눌러서 확인`, onclick: () => o.onFlag?.(page) },
              icon('warn'),
            )
          : null,
      ),
    );
  }
  if (!rows.length) table.append(h('p.muted.pad', o.onlySelected ? '아직 고른 문항이 없어요.' : '문항이 없어요.'));
  table.append(...rows);

  function missingChip(m, page) {
    return h(
      'button.chip.missing',
      {
        title: `${m.prefix ? `${m.prefix} ` : ''}${m.num}번을 찾지 못했어요 — 눌러서 확인`,
        onclick: () => o.onMissing?.(page, m),
      },
      m.prefix ? h('span.chip-pre', m.prefix) : null,
      m.digits ? String(m.num).padStart(m.digits, '0') : String(m.num),
      h('span.chip-q', '?'),
    );
  }
}

// ===========================================================================
// Gemini: 사용자가 고른 쪽만 보내고, 진행 상황·즉시 취소
// ===========================================================================
export function geminiReady() {
  return !!state.settings?.geminiApiKey;
}

export function geminiModels() {
  const s = state.settings || {};
  return [s.geminiModel || 'gemini-flash-latest', s.geminiModel2].filter(Boolean);
}

/**
 * @param {object} book
 * @param {'problem'|'answer'} role
 * @param {number[]} pages
 * @param {{onDone?:(changed:number)=>void, onRenames?:(renames)=>void}} hooks
 */
export async function runGeminiPages(book, role, pages, hooks = {}) {
  if (!geminiReady()) {
    toast('설정에서 Gemini API 키를 먼저 넣어 주세요.', { type: 'error', actions: [{ label: '설정 열기', onClick: () => nav.settings() }] });
    return;
  }
  const doc = book.docs[role];
  const src = await getSource(book, role);
  if (!doc || !src || !pages.length) return;
  const abort = new AbortController();
  const s = state.settings;
  const rows = new Map();
  const list = h(
    'div.gem-list',
    pages.map((p) => {
      const row = h('div.gem-row', { dataset: { state: 'wait' } }, h('span.gem-dot'), h('strong', pageLabel(doc, p)), h('span.gem-msg.muted', '기다리는 중'));
      rows.set(p, row);
      return row;
    }),
  );
  const status = h('div.small.muted.gem-status', `모델: ${geminiModels().join(' → ')}`);
  const bar = h('div.progress-bar');
  let finished = false;
  const body = h(
    'div.gem-run',
    h('p.small.muted', '고른 쪽을 Gemini에게 보내 문항 위치를 다시 찾아요. 한 쪽에 몇 초~수십 초 걸려요. 그 쪽에 있던 문항은 Gemini 결과로 바뀝니다.'),
    h('div.progress', bar),
    status,
    list,
  );
  const dialogPromise = modal({
    title: `Gemini로 ${pages.length}쪽 인식`,
    body,
    width: 480,
    className: 'gem-modal',
    buttons: [{ label: '취소', value: 'cancel' }],
    onClose: () => {
      if (!finished) abort.abort();
    },
  });
  const footerBtn = () => document.querySelector('.gem-modal .modal-footer .btn');
  let changed = 0;
  let errors = 0;
  let allRenames = {};
  try {
    for (let k = 0; k < pages.length; k++) {
      const p = pages[k];
      const row = rows.get(p);
      row.dataset.state = 'run';
      row.querySelector('.gem-msg').textContent = '인식 중…';
      row.scrollIntoView({ block: 'nearest' });
      try {
        const found = await detectPageWithGemini(src, p, {
          role,
          gemini: { models: geminiModels(), rpm: s.geminiRpm },
          signal: abort.signal,
          onStatus: (msg) => {
            status.textContent = msg;
          },
        });
        if (found.length) {
          doc.items = replacePageItems(doc.items, p, found);
          doc.pageInfo[p] = { ...(doc.pageInfo[p] || {}), analyzed: true, source: 'gemini', flags: [], ok: true };
          doc.edited = true;
          const { renames } = normalizeDoc(book, role);
          allRenames = { ...allRenames, ...renames };
          changed++;
          row.dataset.state = 'ok';
          row.querySelector('.gem-msg').textContent = `${found.length}개 찾음${found.model ? ` · ${found.model}` : ''}`;
        } else {
          row.dataset.state = 'empty';
          row.querySelector('.gem-msg').textContent = '문항을 찾지 못함 (그대로 둠)';
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        errors++;
        row.dataset.state = 'err';
        row.querySelector('.gem-msg').textContent = err.message;
        if (/한도/.test(err.message)) {
          status.textContent = err.message;
          break;
        }
      }
      bar.style.width = `${Math.round(((k + 1) / pages.length) * 100)}%`;
    }
    finished = true;
    status.textContent = `끝났어요 — ${changed}쪽 바꿈${errors ? `, 실패 ${errors}쪽` : ''}`;
    const btn = footerBtn();
    if (btn) {
      btn.textContent = '닫기';
      btn.classList.add('btn-primary');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') throw err;
    finished = true;
    toast(`Gemini 인식을 멈췄어요.${changed ? ` (${changed}쪽은 바뀌었어요)` : ''}`);
    document.querySelector('.gem-modal')?.close?.('cancel');
  }
  if (changed) hooks.onDone?.(changed, allRenames);
  await dialogPromise;
}

/** 확인 필요한 쪽 목록 (UI 용) */
export function flaggedSet(doc) {
  return new Set(flaggedPages(doc));
}
