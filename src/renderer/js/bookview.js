// 책 화면: 문제집·답지 올리기 → 따로따로 분석 → 인식 결과 확인(확인할 쪽, 빠진 번호) → 페이지 검토·수정

import { h, clear, toast, confirmDialog, debounce, formatDate, icon, animateOut } from './ui.js';
import { analyzeDocument, parsePageRange, reanalyzeSinglePage, replacePageItems } from './analyze.js';
import { ROLES, ROLE_NAME, newDoc, pageLabel, bookPage, computeMatches, normalizeDoc, findItem, flaggedPages, missingNumbers, missingCount } from './store.js';
import { api, state, nav, leaveHooks, makeSaver, getSource, getSources, dropSources, clearPreviewCache, renderPreview, renderQTable, runGeminiPages, geminiReady, jobs, findJob, startJob, holdBook, holdSource, liveBook } from './shared.js';
import { topbar, renderUpdateBadge } from './chrome.js';
import { createEditor } from './editor.js';
import { placeSegThumb } from './home.js';

const saver = makeSaver((b) => api.saveBook(b));

const bs = {
  book: null,
  sources: { problem: null, answer: null },
  matches: new Map(),
  tab: 'result', // result | review
  role: 'problem', // 인식 결과에서 보는 쪽
  focus: null,
  pendingRenames: {},
  pendingRemoved: [],
};
let editor = null;

window.addEventListener('beforeunload', () => {
  if (bs.book && state.view === 'book') {
    saver.cancel();
    bs.book.updatedAt = Date.now();
    api.saveBookSync(bs.book);
  }
});

// ---------------------------------------------------------------------------
// 뒤에서 도는 작업 (분석은 화면을 떠나도 계속 — shared.js 의 startJob)
// ---------------------------------------------------------------------------
const analysisKey = (id, role) => `analyze:${id}:${role}`;
/** 이 책에서 도는 분석 (한 책에 하나만) */
const analysisJob = (b = bs.book) => (b ? findJob(analysisKey(b.id, 'problem')) || findJob(analysisKey(b.id, 'answer')) : null);
/** 이 책에 도는 작업(분석·AI 인식)이 있으면 파일 바꾸기·분석을 막음 */
const bookBusy = (b = bs.book) => !!b && [...jobs.values()].some((j) => j.bookId === b.id);
/** 지금 이 책 화면인지 */
const onBook = (b) => state.view === 'book' && !!b && bs.book === b;

/** 작업 결과 저장: 그 책 화면이면 화면과 같이, 떠났으면 그 책만 (지금 열린 다른 화면은 건드리지 않음) */
async function saveJobBook(b) {
  if (bs.book === b) {
    rematch();
    await saver.flush();
    return;
  }
  b.updatedAt = Date.now();
  await api.saveBook(b).catch((err) => toast(`${b.name}: 저장하지 못했어요: ${err.message}`, { type: 'error', timeout: 8000 }));
}

/** 작업이 바꾼 문항 ID 를 오답노트에도 (그 책 화면이면 평소처럼 모아서) */
function noteRenamesFor(b, renames, removed = []) {
  if (bs.book === b) return noteRenames(renames, removed);
  if (!Object.keys(renames || {}).length && !removed.length) return;
  const run = () => api.renameBookItems(b.id, renames || {}, removed).catch((err) => console.error(err));
  // 오답노트 화면이 열려 있으면 그 화면이 나가면서 저장할 때 덮어쓰지 않게, 나간 뒤에
  if (state.view === 'note') leaveHooks.add(run);
  else run();
}

function markDirty() {
  saver.dirty();
}

/** 문항 ID 가 바뀐 것을 모아 두었다가 저장할 때 오답노트에도 반영 */
function noteRenames(renames, removed = []) {
  Object.assign(bs.pendingRenames, renames || {});
  bs.pendingRemoved.push(...removed);
  flushRenamesSoon();
}
const flushRenamesSoon = debounce(flushRenames, 800);
async function flushRenames() {
  const renames = bs.pendingRenames;
  const removed = bs.pendingRemoved;
  bs.pendingRenames = {};
  bs.pendingRemoved = [];
  if (!bs.book || (!Object.keys(renames).length && !removed.length)) return;
  await api.renameBookItems(bs.book.id, renames, removed).catch((err) => console.error(err));
}

function rematch() {
  bs.matches = bs.book ? computeMatches(bs.book) : new Map();
}

export async function openBook(id, { tab, role, page, itemId } = {}) {
  // 뒤에서 작업 중인 책이면 그 작업이 들고 있는 책을 그대로 씀 (저장된 예전 것을 열어 서로 덮어쓰지 않게)
  const book = liveBook(id) || (await api.getBook(id));
  book.docs ||= { problem: null, answer: null };
  book.answerOverrides ||= {};
  bs.book = book;
  bs.tab = tab || 'result';
  bs.role = role || (book.docs.problem ? 'problem' : book.docs.answer ? 'answer' : 'problem');
  bs.focus = null;
  saver.set(book);
  state.view = 'book';
  leaveHooks.add(async () => {
    const job = analysisJob(book);
    if (job && !job.cancelled) toast(`${ROLE_NAME[job.role]} 분석은 뒤에서 계속해요. 위쪽 막대에서 진행 상황을 볼 수 있어요.`);
    saver.cancel();
    await saver.flush();
    flushRenamesSoon.cancel();
    await flushRenames();
    editor?.reset();
    bs.book = null;
  });
  render({ enter: true });
  bs.sources = await getSources(book);
  rematch();
  render();
  if (page != null) {
    switchTab('review', { role: role || 'problem', page, itemId, instant: true });
  }
}

// ===========================================================================
function render({ enter = false, tabAnim = null, thumbFrom = null } = {}) {
  const b = bs.book;
  if (!b) return;
  const root = document.getElementById('app');
  clear(root);
  const nameInput = h('input.title-input', {
    value: b.name,
    title: '책 이름 바꾸기',
    onchange: (e) => {
      b.name = e.target.value.trim() || b.name;
      markDirty();
    },
  });
  const tab = (key, ic, label, extra) => h(`button.seg-tab${bs.tab === key ? '.active' : ''}`, { dataset: { tab: key }, onclick: () => switchTab(key) }, icon(ic), h('span', label), extra);
  const flaggedN = ROLES.reduce((s, r) => s + flaggedPages(b.docs[r]).length, 0);
  const tabs = h('nav.seg-tabs', h('span.seg-thumb'), tab('result', 'list', '인식 결과', flaggedN ? h('span.seg-count.warn', String(flaggedN)) : null), tab('review', 'scan', '페이지 검토·수정'));
  root.append(
    topbar(h('div.topbar-crumb', h('button.btn.btn-ghost.btn-round#back-btn', { onclick: () => nav.home({ tab: 'books' }), title: '책장으로' }, icon('back')), h('span.crumb-kind', icon('library'), '책장'), h('span.crumb-sep', '/'), nameInput, h('span.save-status', ''))),
    h(
      `main.sheet${enter ? '.view-enter' : ''}`,
      h(`section.doc-row${bs.tab === 'review' ? '.compact' : ''}`, ROLES.map((role, i) => docCard(role, i))),
      h('div.tabs-row', tabs),
      h(`section.tab-body${tabAnim ? `.enter-${tabAnim}` : ''}`, bs.tab === 'result' ? resultView() : reviewView()),
    ),
  );
  requestAnimationFrame(() => placeSegThumb(tabs, thumbFrom));
  renderUpdateBadge();
}

async function switchTab(tab, { role, page, itemId, instant = false } = {}) {
  if (bs.tab === tab && !instant) {
    if (tab === 'review' && role) getEditor().show(role, page, itemId);
    return;
  }
  const order = ['result', 'review'];
  const dir = order.indexOf(tab) > order.indexOf(bs.tab) ? 'right' : 'left';
  const tabs = document.querySelector('.tabs-row .seg-tabs');
  const thumb = tabs?.querySelector('.seg-thumb');
  const from = thumb ? { x: new DOMMatrix(getComputedStyle(thumb).transform).m41 || 0, w: thumb.offsetWidth } : null;
  if (thumb) {
    const target = tabs.querySelector(`.seg-tab[data-tab="${tab}"]`);
    if (target) {
      thumb.style.transform = `translateX(${target.offsetLeft}px)`;
      thumb.style.width = `${target.offsetWidth}px`;
    }
  }
  if (!instant) await animateOut(document.querySelector('.tab-body'), dir === 'right' ? 'leave-left' : 'leave-right', 200);
  bs.tab = tab;
  const moved = document.querySelector('.tabs-row .seg-thumb');
  render({ tabAnim: dir, thumbFrom: moved ? { x: new DOMMatrix(getComputedStyle(moved).transform).m41 || from?.x || 0, w: moved.offsetWidth } : from });
  if (tab === 'review' && role) requestAnimationFrame(() => getEditor().show(role, page, itemId));
}

// ---------------------------------------------------------------------------
// 문제집/답지 카드
// ---------------------------------------------------------------------------
function docCard(role, i) {
  const b = bs.book;
  const doc = b.docs[role];
  const src = bs.sources[role];
  const job = analysisJob();
  const busy = job?.role === role;
  const locked = bookBusy();
  const card = h(`div.doc-card${doc ? '' : '.empty'}${role === 'answer' ? '.teal' : ''}`, { dataset: { role }, style: { '--i': i } });

  const pick = async () => {
    const paths = await api.pickFiles(`${ROLE_NAME[role]} 파일 선택 (PDF 1개 또는 사진 여러 장)`);
    if (paths.length) await importFiles(role, paths);
  };
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    card.classList.add('drop');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drop'));
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    card.classList.remove('drop');
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) await importFiles(role, paths);
  });

  card.append(
    h(
      'div.doc-head',
      h('span.doc-icon', icon(role === 'problem' ? 'book' : 'bookCheck')),
      h('div.doc-titles', h('div.doc-title', ROLE_NAME[role]), doc ? h('div.doc-file', { title: doc.originalName }, doc.originalName, h('span.muted', src ? ` · ${src.numPages}쪽` : ' · 여는 중…')) : h('div.doc-file.muted', '아직 파일이 없어요')),
      doc ? h('button.btn.btn-ghost.btn-small', { onclick: pick, disabled: locked }, icon('refresh'), '파일 바꾸기') : null,
    ),
  );

  if (!doc) {
    card.append(
      h(
        'button.drop-zone',
        { onclick: pick, disabled: locked },
        h('span.dz-icon', icon('upload')),
        h('div.dz-title', '파일을 끌어오거나 눌러서 고르기'),
        h('div.muted.small', 'PDF 한 개, 또는 사진(JPG·PNG) 여러 장'),
      ),
    );
    return card;
  }

  const rangeInput = h('input.input.input-small', {
    value: doc.range || '',
    placeholder: '전체',
    title: '분석할 쪽 (PDF 쪽 번호). 예: 5-120 또는 3-10, 15. 답지는 "빠른 정답" 쪽을 빼면 좋아요.',
    onchange: (e) => {
      doc.range = e.target.value.trim();
      markDirty();
    },
  });
  const styleSelect = h(
    'select.input.input-small',
    {
      title: '문제 번호 모양. 자동으로 잘 안 잡히면 직접 고르세요.',
      onchange: (e) => {
        doc.options.numberStyle = e.target.value;
        markDirty();
      },
    },
    [
      ['auto', '자동'],
      ['plain', '1, 2, 3'],
      ['dot', '1. 2. 3.'],
      ['pad', '0001, 0002'],
      ['bracket', '[1] (1)'],
    ].map(([v, t]) => h('option', { value: v, selected: doc.options.numberStyle === v }, t)),
  );
  const flowCheck = h('input', {
    type: 'checkbox',
    checked: doc.options.flow === 'continue',
    onchange: (e) => {
      doc.options.flow = e.target.checked ? 'continue' : 'column';
      markDirty();
    },
  });
  const offsetInput = h('input.input.input-tiny', {
    type: 'number',
    value: String(bookPage(doc, 0)),
    title: 'PDF 1쪽이 책의 몇 쪽인지 (쪽 번호 표시용)',
    onchange: (e) => {
      const v = parseInt(e.target.value, 10);
      if (Number.isFinite(v)) {
        doc.pageOffset = v - 1;
        doc.pageOffsetAuto = false;
        markDirty();
        render();
      }
    },
  });
  card.append(
    h(
      'div.doc-options',
      h('label', h('span', '쪽 범위'), rangeInput),
      h('label', h('span', '번호 모양'), styleSelect),
      h('label', { title: 'PDF 1쪽이 책의 몇 쪽인지 (쪽 번호 표시용)' }, h('span', 'PDF 1쪽 = 책'), offsetInput, '쪽'),
      h('label.check', { title: '해설이 다음 단이나 다음 쪽으로 넘어가며 이어지는 경우 (답지는 보통 켜 둠)' }, flowCheck, h('span', '다음 단·쪽으로 이어짐')),
    ),
  );

  const flagged = flaggedPages(doc).length;
  const missing = role === 'problem' ? missingCount(doc) : 0;
  let foot;
  if (busy) {
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
    foot = h(
      'div.doc-foot.busy',
      h('div.doc-progress', h('div.progress', h('div.progress-bar', { style: { width: `${pct}%` } })), h('div.small.num.progress-label', `${job.label} (${job.done}/${job.total})`)),
      h('button.btn.btn-small', { onclick: () => job.cancel() }, icon('stop'), '멈추기'),
      h(
        'button.btn.btn-small.btn-primary.bg-btn',
        { onclick: () => nav.home({ tab: 'books' }), title: '분석은 계속하고 책장으로 나가요. 다른 책이나 오답노트를 보는 동안 위쪽 막대에서 진행 상황을 볼 수 있어요.' },
        icon('collapse'),
        '백그라운드에서 계속',
      ),
    );
  } else {
    foot = h(
      'div.doc-foot',
      doc.analyzedAt
        ? h(
            'div.doc-summary',
            h('span.sum-main', icon('circleCheck'), h('b', String(doc.items.length)), role === 'problem' ? '문항' : '해설'),
            flagged ? h('button.sum-chip.warn', { onclick: () => showResult(role) }, icon('warn'), `확인 ${flagged}쪽`) : null,
            missing ? h('button.sum-chip.warn', { onclick: () => showResult(role) }, `빠진 번호 ${missing}`) : null,
            h('span.muted.small', formatDate(doc.analyzedAt)),
          )
        : h('div.doc-summary.muted', '아직 분석 전이에요.'),
      h(
        `button.btn${doc.analyzedAt ? '' : '.btn-primary'}`,
        { onclick: () => analyzeRole(role), disabled: locked || !src },
        icon('scan'),
        doc.analyzedAt ? '다시 분석' : `${ROLE_NAME[role]} 분석`,
      ),
    );
  }
  card.append(foot);
  return card;
}

function showResult(role) {
  bs.role = role;
  if (bs.tab !== 'result') switchTab('result');
  else render();
}

async function importFiles(role, paths) {
  const b = bs.book;
  if (bookBusy(b)) {
    toast('이 책의 작업이 끝난 뒤에 파일을 바꿔 주세요.');
    return;
  }
  const old = b.docs[role];
  if (old?.items?.length && !(await confirmDialog(`${ROLE_NAME[role]} 파일을 바꾸면 기존 분석 결과가 지워집니다. 계속할까요?`, { ok: '바꾸기', danger: true }))) return;
  const pdfs = paths.filter((x) => /\.pdf$/i.test(x));
  if (pdfs.length > 1 && !(await confirmDialog(`PDF ${pdfs.length}개를 이름 순서대로 이어 붙여 하나의 ${ROLE_NAME[role]}(으)로 씁니다. 계속할까요?`))) return;
  try {
    const removed = (old?.items || []).map((it) => it.id);
    const imported = await api.importFiles(b.id, role, paths);
    dropSources(b.id, role);
    b.docs[role] = newDoc(role, imported);
    b.answerOverrides = {};
    if (role === 'problem' && removed.length) noteRenames({}, removed);
    await saver.flush();
    bs.sources[role] = await getSource(b, role);
    rematch();
    bs.role = role;
    render();
    toast(`${ROLE_NAME[role]}을(를) 올렸어요. [${ROLE_NAME[role]} 분석]을 눌러 주세요.`, { type: 'success' });
  } catch (err) {
    toast(err.message, { type: 'error', timeout: 8000 });
  }
}

// ---------------------------------------------------------------------------
// 분석
// ---------------------------------------------------------------------------
async function analyzeRole(role) {
  const b = bs.book;
  const doc = b.docs[role];
  const src = bs.sources[role];
  if (!doc || !src) return;
  const running = analysisJob(b) || [...jobs.values()].find((j) => j.bookId === b.id);
  if (running) {
    // 이 책에서 도는 작업이 있으면 새로 시작하지 않고 그것을 보여 줌 (분석은 이 카드, AI 인식은 그 창)
    if (running === analysisJob(b)) render();
    else running.open();
    return;
  }
  if (doc.edited && !(await confirmDialog(`${ROLE_NAME[role]}에서 직접 고친 내용이 있습니다. 다시 분석하면 사라집니다. 계속할까요?`, { ok: '다시 분석', danger: true }))) return;
  let pages;
  try {
    pages = parsePageRange(doc.range, src.numPages);
  } catch (err) {
    toast(err.message, { type: 'error' });
    return;
  }
  if (!pages.length) {
    toast('분석할 쪽이 없어요. 쪽 범위를 확인해 주세요.', { type: 'error' });
    return;
  }
  // 화면을 떠나도 계속 돌고(위쪽 막대에 표시), 결과는 이 책(b)에만 씀
  const abort = new AbortController();
  const job = startJob({
    key: analysisKey(b.id, role),
    title: `${b.name} · ${ROLE_NAME[role]} 분석`,
    bookId: b.id,
    role,
    abort,
    here: () => onBook(b),
    open: () => nav.book(b.id, { role }),
    label: '준비 중',
    total: pages.length,
  });
  const releaseBook = holdBook(b);
  const releaseSrc = holdSource(b, role);
  render();
  const t0 = Date.now();
  const updateProgress = debounce(() => {
    if (!onBook(b)) return; // 다른 화면(다른 책)에 쓰지 않게
    const el = document.querySelector(`.doc-card[data-role="${role}"] .doc-foot.busy`);
    if (!el) return;
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
    el.querySelector('.progress-bar')?.style.setProperty('width', `${pct}%`);
    const t = el.querySelector('.progress-label');
    if (t) t.textContent = `${job.label} (${job.done}/${job.total})`;
  }, 50);
  const openAction = [{ label: '책 열기', onClick: () => nav.book(b.id, { role }) }];
  try {
    const before = (doc.items || []).map((it) => it.id);
    const res = await analyzeDocument(src, {
      pages,
      role,
      flow: doc.options.flow,
      numberStyle: doc.options.numberStyle,
      ocrLang: state.settings.ocrLang,
      signal: abort.signal,
      onProgress: ({ done, total, message }) => {
        job.progress({ done, total, label: message });
        updateProgress();
      },
    });
    doc.items = res.items;
    doc.pageInfo = res.pageInfo;
    doc.signature = res.signature;
    doc.signatures = res.signatures || (res.signature ? [res.signature] : []);
    doc.analyzedAt = Date.now();
    doc.edited = false;
    if (doc.pageOffsetAuto !== false && res.pageOffset != null) doc.pageOffset = res.pageOffset;
    const ids = new Set(doc.items.map((it) => it.id));
    if (role === 'problem') {
      for (const k of Object.keys(b.answerOverrides)) if (!ids.has(k)) delete b.answerOverrides[k];
      noteRenamesFor(b, {}, before.filter((id) => !ids.has(id)));
    } else {
      for (const [k, v] of Object.entries(b.answerOverrides)) if (v && !ids.has(v)) delete b.answerOverrides[k];
    }
    clearPreviewCache();
    await saveJobBook(b);
    const sec = Math.round((Date.now() - t0) / 1000);
    const flagged = flaggedPages(doc).length;
    const miss = role === 'problem' ? missingCount(doc) : 0;
    const msg = `${ROLE_NAME[role]}: ${doc.items.length}개 인식 (${sec}초${res.ocrPages ? `, OCR ${res.ocrPages}쪽` : ''})${flagged ? ` · 확인할 쪽 ${flagged}` : ''}${miss ? ` · 빠진 번호 ${miss}` : ''}`;
    if (!job.finish({ message: `${b.name} · ${msg}`, actions: openAction })) toast(msg, { type: 'success', timeout: 6000 });
    if (onBook(b)) bs.role = role;
  } catch (err) {
    if (err?.name === 'AbortError') {
      job.finish();
      toast('분석을 멈췄어요.');
    } else {
      console.error(err);
      const msg = `분석 중 오류: ${err.message}`;
      if (!job.finish({ message: `${b.name} · ${ROLE_NAME[role]} ${msg}`, type: 'error', actions: openAction })) toast(msg, { type: 'error', timeout: 10000 });
    }
  } finally {
    job.finish();
    releaseSrc();
    releaseBook();
    if (onBook(b)) render();
  }
}

// ===========================================================================
// 인식 결과: 확인할 쪽 + 쪽별 번호 표 + 미리보기
// ===========================================================================
function resultView() {
  const b = bs.book;
  const view = h('div.result-view');
  const role = b.docs[bs.role] ? bs.role : b.docs.problem ? 'problem' : 'answer';
  const doc = b.docs[role];
  if (!doc) {
    view.append(h('div.empty-state', h('div.empty-art', icon('upload')), h('h3', '문제집부터 올려 주세요'), h('p.muted', '위 칸에 PDF나 사진을 끌어다 놓고 [분석]을 누르면 쪽마다 문제 번호를 찾아 보여 줘요.')));
    return view;
  }
  const left = h('div.result-main');
  const right = h('aside.result-side', h('div.preview-box'));
  view.append(left, right);

  // 문제집/답지 전환
  const roleSeg = h(
    'div.mini-seg',
    ROLES.map((r) =>
      h(
        `button${role === r ? '.active' : ''}${r === 'answer' ? '.teal' : ''}`,
        {
          disabled: !b.docs[r],
          onclick: () => {
            if (bs.role === r) return;
            bs.role = r;
            const body = document.querySelector('.tab-body');
            animateOut(body?.firstElementChild, 'leave-fade', 140).then(() => {
              clear(body);
              body.append(resultView());
            });
          },
        },
        ROLE_NAME[r],
        b.docs[r]?.items?.length ? h('span.mini-count', String(b.docs[r].items.length)) : null,
      ),
    ),
  );
  left.append(h('div.result-toolbar', roleSeg, h('span.spacer'), h('span.small.muted', '번호를 누르면 오른쪽에서 볼 수 있어요')));

  if (!doc.analyzedAt) {
    left.append(h('div.empty-state', h('div.empty-art', icon('scan')), h('h3', '아직 분석 전이에요'), h('p.muted', `위 ${ROLE_NAME[role]} 카드에서 [분석]을 눌러 주세요.`)));
    return view;
  }

  // ---- 확인할 쪽 ----
  const flagged = flaggedPages(doc);
  const missing = role === 'problem' ? missingNumbers(doc) : new Map();
  const checkPages = [...new Set([...flagged, ...missing.keys()])].sort((a, b2) => a - b2);
  if (checkPages.length) left.append(checkPanel(role, doc, checkPages, missing));
  else left.append(h('div.all-good', icon('circleCheck'), h('span', '확인이 필요한 쪽이 없어요. 번호가 모두 이어져 있어요.')));

  // ---- 표 ----
  const table = h('div.qtable');
  left.append(table);
  const draw = () =>
    renderQTable(table, {
      doc,
      role,
      matches: role === 'problem' ? bs.matches : null,
      hasAnswers: role === 'problem' && !!b.docs.answer?.items?.length,
      missing,
      flagged: new Set(flagged),
      focusId: bs.focus,
      onChip: (it) => focusItem(role, it),
      onHover: (it) => schedulePreview(role, it),
      onPage: (page) => switchTab('review', { role, page }),
      onMissing: (page) => switchTab('review', { role, page }),
      onFlag: (page) => switchTab('review', { role, page }),
    });
  draw();
  let hoverTimer = null;
  function schedulePreview(r, it) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => focusItem(r, it), 140);
  }
  function focusItem(r, it) {
    if (bs.focus === it.id) return;
    bs.focus = it.id;
    table.querySelectorAll('.chip.focus').forEach((c) => c.classList.remove('focus'));
    table.querySelector(`.chip[data-id="${CSS.escape(it.id)}"]`)?.classList.add('focus');
    showPreview(r, it);
  }
  setTimeout(() => {
    const it = bs.focus ? findItem(doc, bs.focus) : null;
    showPreview(role, it);
  }, 0);
  return view;
}

function showPreview(role, it) {
  const box = document.querySelector('.result-side .preview-box');
  const b = bs.book;
  if (role === 'answer') {
    // 답지 문항: 해설만
    renderPreview(box, {
      book: { ...b, docs: { problem: b.docs.answer, answer: null } },
      sources: { problem: bs.sources.answer },
      item: it,
      matches: null,
      emptyText: ['번호 위에 마우스를 올리면', h('br'), '해설을 여기서 볼 수 있어요.'],
      onShow: (_r, page, id) => switchTab('review', { role: 'answer', page, itemId: id }),
    });
    return;
  }
  renderPreview(box, {
    book: b,
    sources: bs.sources,
    item: it,
    matches: bs.matches,
    onShow: (r, page, id) => switchTab('review', { role: r, page, itemId: id }),
    onOverride: (item, value) => {
      if (value === '__auto') delete b.answerOverrides[item.id];
      else b.answerOverrides[item.id] = value;
      markDirty();
      rematch();
      document.querySelector(`.qtable .chip[data-id="${CSS.escape(item.id)}"]`)?.classList.toggle('noans', !bs.matches.get(item.id));
      showPreview(role, item);
    },
  });
}

/** 확인할 쪽 목록: 사용자가 먼저 보고 → 문제없음 / 직접 고치기 / 꼼꼼히 다시 찾기 / AI */
function checkPanel(role, doc, pages, missing) {
  const picked = new Set();
  const panel = h('section.check-panel');
  const head = h(
    'div.cp-head',
    h('span.cp-icon', icon('warn')),
    h('div', h('strong', `확인이 필요한 쪽 ${pages.length}곳`), h('div.small.muted', '번호가 건너뛰었거나 인식이 애매한 쪽이에요. 직접 보고 판단해 주세요.')),
    h('span.spacer'),
    h('button.btn.btn-small', { onclick: () => dismissPages(role, pages), title: '모두 이대로 괜찮다고 표시' }, icon('checkAll'), '모두 문제없음'),
  );
  const gemBtn = h('button.btn.btn-small', { disabled: true, onclick: () => sendToGemini(role, [...picked]) }, icon('sparkle'), 'AI로 보내기');
  const updateGem = () => {
    gemBtn.disabled = !picked.size;
    gemBtn.lastChild.textContent = picked.size ? `고른 ${picked.size}쪽 AI로` : 'AI로 보내기';
  };
  const list = h(
    'div.cp-list',
    pages.map((p, i) => {
      const flags = [...(doc.pageInfo?.[p]?.flags || [])];
      const miss = missing.get(p) || [];
      if (miss.length) flags.push(`빠진 번호 ${miss.map((m) => m.num).slice(0, 6).join(', ')}${miss.length > 6 ? ' …' : ''}`);
      return h(
        'div.cp-row',
        { style: { '--i': Math.min(i, 12) }, dataset: { page: String(p) } },
        h('label.cp-pick', { title: 'AI로 보낼 쪽 고르기' }, h('input', { type: 'checkbox', onchange: (e) => { if (e.target.checked) picked.add(p); else picked.delete(p); updateGem(); } })),
        h('button.cp-page', { onclick: () => switchTab('review', { role, page: p }) }, pageLabel(doc, p)),
        h('span.cp-why', [...new Set(flags)].join(' · ')),
        h(
          'div.cp-actions',
          h('button.btn.btn-small.btn-ghost', { onclick: () => switchTab('review', { role, page: p }), title: '페이지 검토에서 직접 보고 고치기' }, icon('eye'), '검토'),
          h('button.btn.btn-small.btn-ghost', { onclick: () => deepPage(role, p), title: '이 쪽만 더 꼼꼼하게(고해상도 OCR + 앞뒤 번호에 맞춰) 다시 찾기' }, icon('search'), '꼼꼼히 다시 찾기'),
          h('button.btn.btn-small.btn-ghost', { onclick: () => sendToGemini(role, [p]), title: 'AI로 이 쪽 인식' }, icon('sparkle')),
          h('button.btn.btn-small.btn-ok', { onclick: () => dismissPages(role, [p]), title: '이대로 괜찮아요' }, icon('check'), '문제없음'),
        ),
      );
    }),
  );
  panel.append(head, list, h('div.cp-foot', h('span.small.muted', geminiReady() ? '애매한 쪽은 골라서 AI에게 맡길 수 있어요.' : '설정에서 AI 키를 넣으면 애매한 쪽을 AI에게 맡길 수 있어요.'), h('span.spacer'), gemBtn));
  return panel;
}

async function dismissPages(role, pages) {
  const doc = bs.book.docs[role];
  for (const p of pages) {
    doc.pageInfo[p] = { ...(doc.pageInfo[p] || {}), ok: true };
  }
  markDirty();
  // 줄이 접히며 사라지는 효과
  const rows = pages.map((p) => document.querySelector(`.cp-row[data-page="${p}"]`)).filter(Boolean);
  await Promise.all(rows.map((r) => animateOut(r, 'leave-collapse', 260)));
  render();
  toast(pages.length > 1 ? `${pages.length}쪽을 문제없음으로 표시했어요.` : `${pageLabel(doc, pages[0])}을(를) 문제없음으로 표시했어요.`);
}

async function sendToGemini(role, pages) {
  const b = bs.book;
  // 진행 창을 닫고(백그라운드에서 계속) 다른 화면으로 가도 결과는 이 책(b)에 저장
  await runGeminiPages(b, role, pages, {
    onDone: async (changed, renames) => {
      if (role === 'problem') noteRenamesFor(b, renames);
      clearPreviewCache();
      await saveJobBook(b);
    },
    open: () => nav.book(b.id, { role }),
    isOpen: () => onBook(b),
  });
  if (onBook(b)) render();
}

// ===========================================================================
// 꼼꼼히 다시 찾기 (한 쪽)
// ===========================================================================
async function deepPage(role, page) {
  const b = bs.book;
  const doc = b.docs[role];
  const src = bs.sources[role];
  if (!doc || !src) return;
  const close = toast(`${pageLabel(doc, page)} 꼼꼼히 다시 찾는 중… (고해상도로 한 번 더 읽어요)`, { timeout: 0 });
  try {
    const before = (doc.items || []).filter((it) => it.page === page);
    const { items, page: info, meta } = await reanalyzeSinglePage(src, doc, page, { ocrLang: state.settings.ocrLang, deep: true, role });
    close();
    const sameAsBefore = items.length === before.length && items.every((it, k) => it.num === before[k]?.num);
    if (items.length < before.length) {
      const keep = await confirmDialog(`다시 찾은 결과(${items.length}개)가 지금(${before.length}개)보다 적어요. 그래도 바꿀까요?`, { ok: '바꾸기', title: '꼼꼼히 다시 찾기' });
      if (!keep) return;
    }
    if (sameAsBefore) {
      toast(`더 찾은 번호가 없어요 (${items.length}개 그대로). 페이지 검토에서 점선 후보를 눌러 추가하거나, AI로 보내 보세요.`, {
        timeout: 9000,
        actions: [
          { label: '페이지 검토', onClick: () => switchTab('review', { role, page }) },
          ...(geminiReady() ? [{ label: 'AI로', onClick: () => sendToGemini(role, [page]) }] : []),
        ],
      });
      doc.pageInfo[page] = { ...(doc.pageInfo[page] || {}), ...meta };
      markDirty();
      if (bs.tab === 'review') editor?.refresh();
      return;
    }
    const removedIds = before.map((it) => it.id);
    doc.items = replacePageItems(doc.items, page, items);
    doc.pageInfo[page] = { ...(doc.pageInfo[page] || {}), analyzed: true, source: info.source, blank: info.layout.blank, columns: info.layout.columns.length, ...meta, flags: [] };
    doc.edited = true;
    const { renames } = normalizeDoc(b, role);
    if (role === 'problem') {
      const ids = new Set(doc.items.map((it) => it.id));
      noteRenames(renames, removedIds.filter((id) => !ids.has(id) && !renames[id]));
    }
    rematch();
    clearPreviewCache();
    markDirty();
    const diff = items.length - before.length;
    toast(diff > 0 ? `${diff}개를 더 찾았어요 (모두 ${items.length}개).` : `다시 찾았어요 (${items.length}개).`, { type: 'success' });
    if (bs.tab === 'review') editor?.refresh();
    else render();
  } catch (err) {
    close();
    console.error(err);
    toast(`다시 찾기 실패: ${err.message}`, { type: 'error' });
  }
}

// ===========================================================================
// 페이지 검토 화면
// ===========================================================================
function getEditor() {
  if (!editor) {
    editor = createEditor({
      project: () => bs.book,
      source: (role) => bs.sources[role],
      onItemsChanged: (role, item) => {
        const { renames } = normalizeDoc(bs.book, role);
        if (role === 'problem') noteRenames(renames);
        rematch();
        clearPreviewCache();
        markDirty();
        return item?.id;
      },
      onSelect: (role, id) => {
        if (role === 'problem') bs.focus = id;
      },
      onItemDeleted: (role, item) => {
        const b = bs.book;
        if (role === 'problem') {
          delete b.answerOverrides[item.id];
          noteRenames({}, [item.id]);
          if (bs.focus === item.id) bs.focus = null;
        } else {
          for (const [k, v] of Object.entries(b.answerOverrides)) if (v === item.id) delete b.answerOverrides[k];
        }
      },
      onDismiss: (role, page) => {
        const doc = bs.book.docs[role];
        doc.pageInfo[page] = { ...(doc.pageInfo[page] || {}), ok: true };
        markDirty();
        toast(`${pageLabel(doc, page)}을(를) 문제없음으로 표시했어요.`);
      },
      reanalyzePage: (role, page) => deepPage(role, page),
      geminiPage: (role, page) => sendToGemini(role, [page]),
      missing: (role) => (role === 'problem' ? missingNumbers(bs.book.docs.problem) : new Map()),
    });
  }
  return editor;
}

function reviewView() {
  const ed = getEditor();
  const b = bs.book;
  if (!b.docs.problem && !b.docs.answer) {
    return h('div.empty-state', h('div.empty-art', icon('files')), h('h3', '먼저 파일을 올려 주세요'), h('p.muted', '문제집이나 답지를 올리고 분석하면 여기서 쪽마다 인식 결과를 확인하고 고칠 수 있어요.'));
  }
  const wrap = h('div.review-view', ed.el);
  const role = b.docs[ed.role] ? ed.role : b.docs.problem ? 'problem' : 'answer';
  requestAnimationFrame(() => ed.show(role, ed.page));
  requestAnimationFrame(() => requestAnimationFrame(() => ed.redraw()));
  return wrap;
}
