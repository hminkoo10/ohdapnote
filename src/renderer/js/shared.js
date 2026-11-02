// 여러 화면이 같이 쓰는 것들: 상태, 화면 이동, 원본 파일 열기, 문항 표, 미리보기, 뒤에서 도는 작업, AI 실행 창

import { h, clear, toast, modal, confirmDialog, icon, debounce } from './ui.js';
import { openDocSource, bookFileUrl } from './docsource.js';
import { detectPageWithGemini, replacePageItems } from './analyze.js';
import { itemName } from './exporter.js';
import { ROLE_NAME, pageLabel, bookPage, itemsByPage, findItem, flaggedPages, normalizeDoc } from './store.js';
import { sortItems } from './detect.js';
import { PROVIDERS, providerOf } from './aiproviders.js';

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

const heldSources = new Map(); // key → 붙잡은 수 (뒤에서 도는 작업이 쓰는 원본은 정리하지 않음)

/** 작업이 끝날 때까지 이 원본이 정리(닫기)되지 않게 붙잡음 → 놓아 주는 함수를 돌려줌 */
export function holdSource(book, role) {
  const key = sourceKey(book, role);
  if (!key) return () => {};
  heldSources.set(key, (heldSources.get(key) || 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const n = heldSources.get(key) - 1;
    if (n > 0) heldSources.set(key, n);
    else heldSources.delete(key);
    trimSources();
  };
}

function trimSources() {
  if (sourceCache.size <= MAX_SOURCES) return;
  const sorted = [...sourceCache.entries()].filter(([key]) => !heldSources.has(key)).sort((a, b) => a[1].used - b[1].used);
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
// 뒤에서 도는 작업 (책 분석, AI 인식 …)
//  - 진행 창에서 [백그라운드에서 계속]을 누르면 창만 닫히고 작업은 계속됨 → 위쪽 막대(chrome.js)에 진행 상황
//  - 위쪽 막대를 누르면 job.open() → 진행 창(또는 그 책 화면)을 다시 보여 줌. 취소는 거기서
//  - 뒤에서 끝나면 토스트 + 창이 앞에 없으면 윈도우 알림
//  - 같은 key 로 또 시작하려 하면 findJob(key)?.open() 으로 도는 것을 보여 줌
//  - 작업이 남아 있으면 프로그램을 끄기 전에 물어봄
// ===========================================================================
/** @type {Map<string, object>} key → job */
export const jobs = new Map();
/** 작업이 생기거나 바뀌거나 끝나면 부름 (위쪽 막대) */
export const jobListeners = new Set();
let jobsTimer = null;
function tellJobs() {
  jobsTimer ||= setTimeout(() => {
    jobsTimer = null;
    jobListeners.forEach((fn) => fn());
  }, 100);
}

/**
 * 작업 등록. 끝나면(성공·실패·취소 모두) 꼭 job.finish() 를 불러 주세요.
 * @param {object} o
 *   key      같은 작업인지 알아보는 열쇠 (예: `analyze:<책 id>:problem`) — 이미 있으면 오류
 *   title    위쪽 막대·알림에 보일 이름
 *   abort    AbortController (job.cancel() 이 abort() 를 부름)
 *   open()   진행 창(또는 그 화면)을 다시 보여 주기 — 위쪽 막대를 누르면 부름
 *   here()   지금 그 진행 창·화면이 보이는지. 안 보이면 '뒤에서 도는 중' (위쪽 막대에 보이고, 끝나면 알림)
 *   bookId?  이 책을 지우면 작업도 멈춤 (home.js)
 *   done?, total?, label?  처음 진행 상황. 그 밖의 값(role 등)도 job 에 그대로 붙음
 * @returns job
 *   job.progress({done, total, label})  진행 상황 (위쪽 막대에 total 이 있으면 %)
 *   job.cancel()                        취소 (abort)
 *   job.finish({message, type, actions}) 끝 — 뒤에서 끝났고 message 가 있으면 토스트·윈도우 알림을 띄우고 true,
 *                                       화면에서 끝났으면 false (부른 쪽이 평소처럼 알림). 여러 번 불러도 됨
 *   job.background, job.cancelled, job.finished(Promise)
 */
export function startJob(o) {
  if (jobs.has(o.key)) throw new Error(`이미 도는 작업이에요: ${o.key}`);
  let resolveFinished;
  const job = {
    done: 0,
    total: 0,
    label: '',
    ...o,
    cancelled: false,
    finished: new Promise((r) => (resolveFinished = r)),
    get background() {
      return !o.here?.();
    },
    progress(p) {
      Object.assign(job, p);
      tellJobs();
    },
    cancel() {
      job.cancelled = true;
      o.abort?.abort();
    },
    finish({ message = '', type = 'success', actions = [] } = {}) {
      if (jobs.get(job.key) !== job) return false;
      const bg = job.background;
      jobs.delete(job.key);
      tellJobs();
      resolveFinished();
      if (!bg || !message) return false;
      toast(message, { type, timeout: type === 'error' ? 0 : 15000, actions });
      notifyOs(job.title, message, actions[0]?.onClick);
      return true;
    },
  };
  jobs.set(job.key, job);
  tellJobs();
  return job;
}

export const findJob = (key) => jobs.get(key) || null;

/** 고른 작업들을 멈추고, 모두 끝날 때까지(저장까지) 기다림 */
export async function stopJobs(test = () => true) {
  const list = [...jobs.values()].filter(test);
  list.forEach((j) => j.cancel());
  await Promise.all(list.map((j) => j.finished));
}

/** 창이 앞에 없을 때 윈도우 알림 (누르면 창을 앞으로 + onClick) */
function notifyOs(title, body, onClick) {
  if (document.hasFocus() || typeof Notification !== 'function') return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      onClick?.();
    };
  } catch (err) {
    console.warn('윈도우 알림을 띄우지 못함', err);
  }
}

// 작업이 남아 있으면 끄기 전에 물어봄. Electron 에서는 beforeunload 를 막으면 창이 조용히 안 닫히므로
// 직접 물어보고, 끄기로 하면 다시 닫음
let closeOk = false;
let askingClose = false;
window.addEventListener('beforeunload', (e) => {
  if (closeOk || !jobs.size) {
    // 끄기로 했으면 뒤에서 작업하던 책도 그때까지 바뀐 대로 저장 (AI 로 바꾼 쪽 등. 열려 있는 책 화면은 bookview 가 저장)
    for (const { book } of liveBooks.values()) api?.saveBookSync(book);
    return;
  }
  e.preventDefault();
  e.returnValue = false;
  if (askingClose) return;
  askingClose = true;
  setTimeout(async () => {
    const ok = await confirmStopJobs('끄기');
    askingClose = false;
    if (ok) window.close();
  }, 0);
});

/** 도는 작업이 있으면 멈출지 물어봄 → 멈추기로 하면 true (그 뒤로는 창 닫기를 막지 않음) */
export async function confirmStopJobs(ok = '멈추고 끄기') {
  if (!jobs.size) return true;
  const names = [...jobs.values()].map((j) => `· ${j.title}${j.total ? ` (${Math.round((j.done / j.total) * 100)}%)` : ''}`).join('\n');
  if (!(await confirmDialog(`아직 끝나지 않은 작업이 있어요.\n${names}\n지금 끄면 작업이 멈춰요.`, { title: '작업 중', ok, danger: true }))) return false;
  closeOk = true;
  stopJobs();
  return true;
}

/**
 * 진행 창 + [백그라운드에서 계속]
 *   [취소]·X·Esc·바깥 누르기 = 작업 취소 (예전과 같음)
 *   [백그라운드에서 계속] = 창만 닫고 작업은 계속 → 위쪽 막대에 보이고, 누르면 같은 창이 다시 열림
 * @param {object} o
 *   title, body, width?, className?  창 (body 는 작업이 계속 고쳐 써도 됨 — 다시 열면 그대로 다시 붙음)
 *   jobTitle?  위쪽 막대·알림에 보일 이름 (없으면 title)
 *   그 밖의 값(key, abort, bookId, total …)은 startJob 으로 (open·here 는 이 창)
 * @returns {{job, finish(r?): boolean, close(): void, closed: Promise<void>}}
 *   finish(r)  작업이 끝남 → 창이 열려 있으면 [닫기]만 남김, 닫혀 있었으면 r.message 로 알림 (job.finish 와 같음)
 *   close()    창이 열려 있으면 닫음 (작업은 건드리지 않음 — 취소하려면 job.cancel())
 *   closed     작업이 끝나고 창도 닫히면 resolve
 */
export function jobDialog({ title, jobTitle = title, body, width = 480, className = '', ...jobOpts }) {
  let dialog = null; // 지금 열린 창 (.modal)
  let finished = false;
  let resolveClosed;
  const closed = new Promise((r) => (resolveClosed = r));
  const show = () => {
    if (dialog) return;
    modal({
      title,
      body,
      width,
      className,
      buttons: finished
        ? [{ label: '닫기', value: 'close', primary: true }]
        : [
            { label: '취소', value: 'cancel' },
            { label: '백그라운드에서 계속', value: 'background', primary: true },
          ],
      onClose: (value) => {
        dialog = null;
        if (!finished && value !== 'background') job.cancel();
        if (finished) resolveClosed();
        tellJobs();
      },
    });
    dialog = body.closest('.modal');
    tellJobs();
  };
  const job = startJob({ ...jobOpts, title: jobTitle, open: show, here: () => !!dialog });
  show();
  return {
    job,
    closed,
    finish(r) {
      finished = true;
      const bg = job.finish(r);
      if (!dialog) resolveClosed();
      else {
        // [취소] → [닫기], [백그라운드에서 계속]은 없앰
        const [cancelBtn, bgBtn] = dialog.querySelectorAll('.modal-footer .btn');
        bgBtn?.remove();
        if (cancelBtn) {
          cancelBtn.textContent = '닫기';
          cancelBtn.classList.add('btn-primary');
        }
      }
      return bg;
    },
    close() {
      dialog?.close?.('close');
    },
  };
}

// 뒤에서 작업 중인 책: 그 작업이 들고 있는 책 객체를 책 화면(다시 열 때)·책 이름 바꾸기도 같이 써서
// 작업 결과와 그 사이에 고친 내용이 서로 덮어쓰지 않게 함
const liveBooks = new Map(); // id → {book, n}

/** 작업이 끝날 때까지 이 책 객체를 '살아 있는 책'으로 → 놓아 주는 함수를 돌려줌 */
export function holdBook(book) {
  const entry = liveBooks.get(book.id) || { book, n: 0 };
  entry.n++;
  liveBooks.set(book.id, entry);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--entry.n <= 0 && liveBooks.get(book.id) === entry) liveBooks.delete(book.id);
  };
}

/** 뒤에서 작업 중인 책이면 그 책 객체 (아니면 null → 저장된 것을 읽으면 됨) */
export const liveBook = (id) => liveBooks.get(id)?.book || null;

// ===========================================================================
// AI (기본 Gemini, 설정 → 세부 설정에서 다른 AI): 사용자가 고른 쪽만 보내고, 진행 상황·즉시 취소
// ===========================================================================
/** 설정에서 고른 AI 종류 (gemini | openai | anthropic | codex) */
export function aiProvider() {
  const p = state.settings?.aiProvider;
  return PROVIDERS[p] ? p : 'gemini';
}

/** 화면에 보이는 AI 이름 (Gemini, Claude …) */
export const aiLabel = () => providerOf(aiProvider()).label;

/** 설정에서 AI 를 껐는지 */
export const aiOff = () => state.settings?.aiEnabled === false;

/** 고른 AI 를 쓸 준비가 됐는지 (이름은 예전 그대로) — 꺼 두었으면 false */
export function geminiReady() {
  const s = state.settings || {};
  if (aiOff()) return false;
  const p = aiProvider();
  if (p === 'openai') return !!String(s.openaiModel || '').trim(); // 로컬 서버는 키 없이도 됨
  if (p === 'anthropic') return !!s.anthropicApiKey;
  if (p === 'codex') return true; // CLI·로그인은 설정 화면에서 확인, 안 되면 요청할 때 알려 줌
  return !!s.geminiApiKey;
}

/** 1순위·2순위 모델 (Codex 는 '' = CLI 기본 모델) */
export function geminiModels() {
  const s = state.settings || {};
  const p = aiProvider();
  if (p === 'codex') return [String(s.codexModel || '').trim()];
  return [s[`${p}Model`] || PROVIDERS[p].defaultModel, s[`${p}Model2`]].filter(Boolean);
}

/** AI 호출에 넘기는 공통 설정 */
export function aiOptions() {
  const s = state.settings || {};
  const provider = aiProvider();
  const clamp = (v, d) => Math.max(1, Math.min(8, v | 0 || d));
  // batch: 한글 내보내기에서 한 요청에 담는 문항 수
  return { provider, models: geminiModels(), rpm: s[`${provider}Rpm`], concurrency: clamp(s.aiConcurrency, 3), batch: clamp(s.aiBatch, 4) };
}

/** 진행 창에 보이는 "AI · 모델" */
export const aiModelText = () => `${aiLabel()} · ${geminiModels().map((m) => m || '기본 모델').join(' → ')}`;

/**
 * 진행 창에서 [백그라운드에서 계속]을 누르면 창만 닫히고 계속 돔 (위쪽 막대에서 다시 열기).
 * 같은 책·같은 문서(문제집/답지)에서 이미 돌고 있으면 새로 시작하지 않고 그 창을 보여 줌.
 * book 은 그 책 화면의 책 객체 — 끝날 때까지 holdBook 으로 붙잡아 둠
 * @param {object} book
 * @param {'problem'|'answer'} role
 * @param {number[]} pages
 * @param {{onDone?:(changed:number, renames)=>Promise|void, open?:()=>void, isOpen?:()=>boolean}} hooks
 *   onDone  바뀐 쪽이 있을 때 (결과 저장 — 그 책 화면을 떠났어도 그 책에)
 *   open    뒤에서 끝났을 때 알림의 [책 열기]
 *   isOpen  지금 그 책 화면인지 (그러면 [책 열기]를 붙이지 않음)
 */
export async function runGeminiPages(book, role, pages, hooks = {}) {
  if (!geminiReady()) {
    toast(aiOff() ? '설정에서 AI 가 꺼져 있어요.' : '설정에서 AI(API 키·모델)를 먼저 정해 주세요.', { type: 'error', actions: [{ label: '설정 열기', onClick: () => nav.settings() }] });
    return;
  }
  const key = `gemini:${book.id}:${role}`;
  const doc = book.docs[role];
  const src = await getSource(book, role);
  if (!doc || !src || !pages.length) return;
  if (findJob(key)) {
    findJob(key).open();
    return;
  }
  const abort = new AbortController();
  const rows = new Map();
  const list = h(
    'div.gem-list',
    pages.map((p) => {
      const row = h('div.gem-row', { dataset: { state: 'wait' } }, h('span.gem-dot'), h('strong', pageLabel(doc, p)), h('span.gem-msg.muted', '기다리는 중'));
      rows.set(p, row);
      return row;
    }),
  );
  const status = h('div.small.muted.gem-status', `모델: ${aiModelText()}`);
  const bar = h('div.progress-bar');
  const body = h(
    'div.gem-run',
    h('p.small.muted', `고른 쪽을 AI(${aiLabel()})에게 보내 문항 위치를 다시 찾아요. 한 쪽에 몇 초~수십 초 걸려요. 그 쪽에 있던 문항은 AI 결과로 바뀝니다.`),
    h('div.progress', bar),
    status,
    list,
  );
  const releaseBook = holdBook(book);
  const releaseSrc = holdSource(book, role);
  const ui = jobDialog({
    key,
    bookId: book.id,
    role,
    abort,
    total: pages.length,
    title: `AI로 ${pages.length}쪽 인식`,
    jobTitle: `${book.name} · AI ${pages.length}쪽`,
    body,
    width: 480,
    className: 'gem-modal',
  });
  let changed = 0;
  let errors = 0;
  let allRenames = {};
  let aborted = false;
  let failure = null;
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
          gemini: aiOptions(),
          signal: abort.signal,
          onStatus: (msg) => {
            status.textContent = msg;
            ui.job.progress({ label: msg });
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
      ui.job.progress({ done: k + 1 });
    }
    status.textContent = `끝났어요 — ${changed}쪽 바꿈${errors ? `, 실패 ${errors}쪽` : ''}`;
  } catch (err) {
    if (err?.name !== 'AbortError') failure = err;
    else {
      aborted = true;
      toast(`AI 인식을 멈췄어요.${changed ? ` (${changed}쪽은 바뀌었어요)` : ''}`);
    }
  }
  try {
    if (changed) await hooks.onDone?.(changed, allRenames);
  } finally {
    // 결과를 저장한 뒤에 끝냄 (책을 지울 때 stopJobs 가 저장까지 기다리게)
    const actions = hooks.open && !hooks.isOpen?.() ? [{ label: '책 열기', onClick: hooks.open }] : [];
    ui.finish(aborted || failure ? {} : { message: `${book.name} · ${ROLE_NAME[role]}: AI 인식 끝 — ${changed}쪽 바꿈${errors ? `, 실패 ${errors}쪽` : ''}`, actions });
    if (aborted || failure) ui.close();
    releaseSrc();
    releaseBook();
  }
  if (failure) throw failure;
  await ui.closed;
}

/** 확인 필요한 쪽 목록 (UI 용) */
export function flaggedSet(doc) {
  return new Set(flaggedPages(doc));
}
