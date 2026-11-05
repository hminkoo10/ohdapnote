// 책 화면: 문제집·답지 올리기 → 따로따로 분석 → 인식 결과 확인(확인할 쪽, 빠진 번호) → 페이지 검토·수정

import { h, clear, toast, confirmDialog, debounce, formatDate, icon, animateOut } from './ui.js';
import { analyzeDocument, parsePageRange, reanalyzeSinglePage, replacePageItems } from './analyze.js';
import { ROLES, ROLE_NAME, pageLabel, bookPage, computeMatches, normalizeDoc, findItem, flaggedPages, missingNumbers, missingCount } from './store.js';
import { api, state, nav, leaveHooks, makeSaver, getSource, getSources, dropSources, clearPreviewCache, renderPreview, renderQTable, runGeminiPages, geminiReady, aiOff, jobs, findJob, startJob, holdBook, holdSource, liveBook, errMsg, restartSaveHooks, restartPendingChecks, setRestartBusy } from './shared.js';
import { topbar } from './chrome.js';
import { createEditor } from './editor.js';
import { placeSegThumb } from './home.js';
import { importBookFiles } from './photoimport.js';
import { subjectOf, subjectName, contractedSubjects } from './subjects.js';

/** 고칠 수 있는 책인지 — 학원 공간에서 남이 만든 책은 절대 저장하지 않음 (통합 클라우드가 되돌리고 충돌 사본을 남김) */
const canSave = (b) => !!b && b.$canEdit !== false;

// 바뀐 횟수 / 저장할 때의 횟수 — 실시간으로 다시 읽을 때 고치는 중인지 보려고 (makeSaver 는 알려 주지 않음)
let dirtySeq = 0;
let savedSeq = 0;
const saver = makeSaver(async (b) => {
  if (!canSave(b)) return;
  const seq = dirtySeq;
  await api.saveBook(b);
  savedSeq = seq;
});
const renameSaver = makeSaver((batch) => api.renameBookItems(batch.bookId, batch.renames, batch.removed));
const jobSaver = makeSaver((book) => api.saveBook(book));
const deferredRenames = new Set();

const bs = {
  book: null,
  readonly: false, // 보기만 (만든 사람과 원장만 고칠 수 있음)
  sources: { problem: null, answer: null },
  matches: new Map(),
  tab: 'result', // result | review
  role: 'problem', // 인식 결과에서 보는 쪽
  focus: null,
  pendingRenames: {},
  pendingRemoved: [],
  working: 0, // 꼼꼼히 다시 찾는 중 — 그동안은 실시간으로 다시 읽지 않음
};
let editor = null;

window.addEventListener('beforeunload', () => {
  if (bs.book && state.view === 'book' && canSave(bs.book)) {
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
  if (!canSave(b)) return;
  if (bs.book === b) {
    rematch();
    await saver.flush();
    return;
  }
  jobSaver.set(b);
  await jobSaver.flush();
}

/** 작업이 바꾼 문항 ID 를 오답노트에도 (그 책 화면이면 평소처럼 모아서) */
function noteRenamesFor(b, renames, removed = []) {
  if (!canSave(b)) return;
  if (bs.book === b) return noteRenames(renames, removed);
  if (!Object.keys(renames || {}).length && !removed.length) return;
  const run = async () => {
    if (!deferredRenames.delete(run)) return true;
    restartSaveHooks.delete(run);
    renameSaver.set({ bookId: b.id, renames: renames || {}, removed });
    return renameSaver.flush();
  };
  deferredRenames.add(run);
  // 오답노트 화면이 열려 있으면 그 화면이 나가면서 저장할 때 덮어쓰지 않게, 나간 뒤에
  if (state.view === 'note') {
    leaveHooks.add(run);
    restartSaveHooks.add(run);
  } else run();
}

function markDirty() {
  if (!canSave(bs.book)) return;
  dirtySeq++;
  saver.dirty();
}

/** 문항 ID 가 바뀐 것을 모아 두었다가 저장할 때 오답노트에도 반영 */
function noteRenames(renames, removed = []) {
  Object.assign(bs.pendingRenames, renames || {});
  bs.pendingRemoved.push(...removed);
  flushRenamesSoon();
}
const flushRenamesSoon = debounce(flushRenames, 800);
restartSaveHooks.add(flushRenames);
restartPendingChecks.add(() => deferredRenames.size > 0 || Object.keys(bs.pendingRenames).length > 0 || bs.pendingRemoved.length > 0);
async function flushRenames() {
  const renames = bs.pendingRenames;
  const removed = bs.pendingRemoved;
  bs.pendingRenames = {};
  bs.pendingRemoved = [];
  if (!canSave(bs.book) || (!Object.keys(renames).length && !removed.length)) return;
  renameSaver.set({ bookId: bs.book.id, renames, removed });
  return renameSaver.flush();
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
  bs.readonly = !canSave(book);
  bs.tab = bs.readonly ? 'result' : tab || 'result';
  bs.role = role || (book.docs.problem ? 'problem' : book.docs.answer ? 'answer' : 'problem');
  // 보기만 하는 책은 페이지 검토 대신 인식 결과에서 그 문항을 보여 줌
  bs.focus = bs.readonly && itemId ? itemId : null;
  saver.set(book);
  savedSeq = dirtySeq;
  state.view = 'book';
  leaveHooks.add(async () => {
    const job = analysisJob(book);
    if (job && !job.cancelled) toast(`${ROLE_NAME[job.role]} 분석 중이에요. 진행은 위쪽 막대에 보여요.`);
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
  if (page != null && !bs.readonly) {
    switchTab('review', { role: role || 'problem', page, itemId, instant: true });
  }
}

/** 보기만 하는 책: 누가 만들었는지 + 내 책으로 복사 (계약에서 빠진 과목은 그 이유만) */
function readonlyBanner(b) {
  if (b.$subjectOpen === false) {
    return h('div.readonly-banner.subject-closed', icon('eye'), h('span', `${subjectName(subjectOf(b))} 계약 없음: 보기만 가능해요. 계약은 원장님께 확인하세요.`));
  }
  return h(
    'div.readonly-banner',
    icon('eye'),
    // 원장이 보는 다른 선생님의 나만 보기 책은 그 선생님만 고침
    h('span', `생성자: ${b.createdBy?.name || '알 수 없음'} · ${b.$shared === false ? '나만 보기 책이라 만든 선생님만 고칠 수 있어요' : '보기만 할 수 있어요 (만든 사람과 원장만 고칠 수 있어요)'}`),
    h('button.btn.btn-small.btn-primary', { onclick: (e) => copyToMine(b, e.currentTarget) }, icon('bookPlus'), '내 책으로 복사'),
  );
}

async function copyToMine(b, btn) {
  const label = btn.lastChild;
  btn.disabled = true;
  label.textContent = '복사하는 중…';
  try {
    // 원본 파일을 먼저 받아서 복사 (못 받으면 오류)
    const copy = await api.copyBook(b.id);
    toast(`내 책으로 복사했어요: ${copy.name}`, { type: 'success' });
    nav.book(copy.id);
  } catch (err) {
    toast(errMsg(err), { type: 'error', timeout: 8000 });
    btn.disabled = false;
    label.textContent = '내 책으로 복사';
  }
}

/** 학원 공유 켜고 끄기 (학원 공간의 내 책). 끄면 다른 선생님에게는 볼 수 없는 교재가 되어서 먼저 물어봄 */
async function toggleShared(b, input) {
  const on = input.checked;
  input.checked = !on; // 바뀌기 전까지는 그대로
  if (bookBusy(b)) {
    toast('이 책의 작업이 끝난 뒤 바꿀 수 있어요.');
    return;
  }
  const msg = '학원 공유를 끄면 이 책은 나만 보기가 돼요 (원장은 볼 수 있어요).\n다른 선생님 책장에서 사라지고, 이 책을 쓰는 학생 오답노트를 다른 선생님이 열면 ‘볼 수 없는 교재’로 보여요 (고른 문항은 그대로 남아요).\n다시 켜면 그대로 돌아와요.';
  if (!on && !(await confirmDialog(msg, { title: '학원 공유 끄기', ok: '공유 끄기', danger: true }))) return;
  input.disabled = true;
  try {
    // 고친 내용을 먼저 저장 (옮기는 폴더에 같이 가게)
    saver.cancel();
    if (dirtySeq !== savedSeq) await saver.flush();
    flushRenamesSoon.cancel();
    await flushRenames();
    const s = await api.setBookShared(b.id, on);
    b.$shared = s.shared;
    toast(s.shared ? '학원 선생님 모두에게 공유했어요.' : '나만 보기로 바꿨어요.', { type: 'success' });
  } catch (err) {
    toast(`공유를 바꾸지 못했어요: ${errMsg(err)}`, { type: 'error', timeout: 8000 });
  }
  if (bs.book === b && state.view === 'book') render();
}

// ---------------------------------------------------------------------------
// 실시간: 다른 컴퓨터·선생님이 이 책을 바꾸면 (app.js 가 책 화면에서 부름)
// ---------------------------------------------------------------------------
/** 다시 읽은 것으로 바꿔 끼움 (같은 책 객체를 붙잡고 있는 저장·작업이 그대로 쓰게) */
function replaceInPlace(target, fresh) {
  for (const k of Object.keys(target)) if (!(k in fresh)) delete target[k];
  return Object.assign(target, fresh);
}

/** 다시 읽어도 되는지: 이 책에 도는 작업, 고치고 아직 저장하지 않은 내용, 열린 확인 창이 없을 때만 */
const canReload = (b) =>
  !bookBusy(b) && !bs.working && dirtySeq === savedSeq && !Object.keys(bs.pendingRenames).length && !bs.pendingRemoved.length && !document.querySelector('.modal-overlay:not(.closing)');

let changeQueue = Promise.resolve();

/** change: {books: [책 id], notes, students, settings} */
export function bookDataChanged(change) {
  changeQueue = changeQueue.then(() => reloadBook(change)).catch((err) => console.error(err));
  return changeQueue;
}

async function reloadBook(change) {
  const b = bs.book;
  if (!b || state.view !== 'book' || !(change?.books?.includes(b.id) || change?.books?.includes('*')) || !canReload(b)) return;
  let fresh;
  try {
    fresh = await api.getBook(b.id);
  } catch {
    if (bs.book !== b || !canReload(b)) return;
    // 지워진 책: 나가면서 저장해 되살리지 않게
    saver.set(null);
    toast('다른 곳에서 이 책을 지웠어요');
    nav.home({ tab: 'books' });
    return;
  }
  // 저장된 내용이 그대로면(원본 파일만 받았거나 옮긴 결과만 바뀜) 다시 그리지 않음
  if (fresh.updatedAt === b.updatedAt && fresh.$canEdit === b.$canEdit && fresh.$shared === b.$shared && fresh.$subjectOpen === b.$subjectOpen && JSON.stringify(fresh.$answers) === JSON.stringify(b.$answers)) return;
  fresh.docs ||= { problem: null, answer: null };
  fresh.answerOverrides ||= {};
  const sources = await getSources(fresh);
  if (bs.book !== b || state.view !== 'book' || !canReload(b)) return;
  replaceInPlace(b, fresh);
  bs.readonly = !canSave(b);
  if (bs.readonly) bs.tab = 'result';
  bs.sources = sources;
  rematch();
  render();
}

// ===========================================================================
function render({ enter = false, tabAnim = null, thumbFrom = null } = {}) {
  const b = bs.book;
  if (!b) return;
  const root = document.getElementById('app');
  clear(root);
  const ro = bs.readonly;
  const nameInput = h('input.title-input', {
    value: b.name,
    title: ro ? b.name : '책 이름 바꾸기',
    readOnly: ro,
    onchange: ro
      ? null
      : (e) => {
          b.name = e.target.value.trim() || b.name;
          markDirty();
        },
  });
  // 과목: 고칠 수 있는 책은 학원이 계약한 과목 안에서 바꿀 수 있음 (계약 과목이 하나뿐이고 이미 그 과목이면 표시만)
  const subject = subjectOf(b);
  const allowed = contractedSubjects(state.appInfo);
  const subjectEl =
    ro || (allowed.length === 1 && allowed[0] === subject)
      ? h('span.subject-badge', { dataset: { subject } }, subjectName(subject))
      : h(
          'select.input.input-small.subject-select',
          {
            title: '이 교재의 과목',
            onchange: (e) => {
              b.subject = e.target.value;
              markDirty();
            },
          },
          [...new Set([subject, ...allowed])].map((code) => h('option', { value: code, selected: code === subject }, subjectName(code))),
        );
  // 학원 공간에서는 누가 만든 책인지 (내 책도)
  const creator = state.appInfo?.academy && b.createdBy ? h('span.creator', `생성자: ${b.createdBy.name || '알 수 없음'}`) : null;
  // 학원 공간의 내 책: 학원 공유 켜고 끄기 (끄면 나만 보기 — 원장은 볼 수 있음)
  const share =
    state.appInfo?.academy && b.createdBy?.id && b.createdBy.id === state.appInfo.user?.id
      ? h(
          'label.switch.small.share-switch',
          { title: b.$shared ? '학원 선생님 모두가 이 책을 보고 오답노트에 써요' : '나만 봐요 (원장도 볼 수 있어요)' },
          h('input', { type: 'checkbox', checked: !!b.$shared, onchange: (e) => toggleShared(b, e.target) }),
          h('span.sw'),
          '학원 공유',
        )
      : null;
  const tab = (key, ic, label, extra) => h(`button.seg-tab${bs.tab === key ? '.active' : ''}`, { dataset: { tab: key }, onclick: () => switchTab(key) }, icon(ic), h('span', label), extra);
  const flaggedN = ROLES.reduce((s, r) => s + flaggedPages(b.docs[r]).length, 0);
  // 보기만 하는 책은 페이지 검토(고치는 화면) 없이 인식 결과만
  const tabs = h('nav.seg-tabs', h('span.seg-thumb'), tab('result', 'list', '인식 결과', flaggedN ? h('span.seg-count.warn', String(flaggedN)) : null), ro ? null : tab('review', 'scan', '페이지 검토·수정'));
  root.append(
    topbar(h('div.topbar-crumb', h('button.btn.btn-ghost.btn-small#back-btn', { onclick: () => nav.home({ tab: 'books' }), title: '' }, icon('back'), '책장'), nameInput, subjectEl, creator, share, ro ? null : h('span.save-status', ''))),
    h(
      `main.sheet${enter ? '.view-enter' : ''}`,
      ro ? readonlyBanner(b) : null,
      h(`section.doc-row${bs.tab === 'review' ? '.compact' : ''}`, ROLES.map((role, i) => docCard(role, i))),
      h('div.tabs-row', tabs, h('span.small.muted', '')),
      h(`section.tab-body${tabAnim ? `.enter-${tabAnim}` : ''}`, bs.tab === 'result' ? resultView() : reviewView()),
    ),
  );
  requestAnimationFrame(() => placeSegThumb(tabs, thumbFrom));
}

async function switchTab(tab, { role, page, itemId, instant = false } = {}) {
  if (tab === 'review' && bs.readonly) return; // 보기만 하는 책은 페이지 검토 없음
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
  const ro = bs.readonly; // 보기만: 파일 바꾸기·끌어 놓기·설정·분석 없음
  const card = h(`div.doc-card${doc ? '' : '.empty'}${role === 'answer' ? '.teal' : ''}`, { dataset: { role }, style: { '--i': i } });

  const pick = async () => {
    const paths = await api.pickFiles(`${ROLE_NAME[role]} 파일 선택 (PDF 1개 또는 사진 여러 장)`);
    if (paths.length) await importFiles(role, paths);
  };
  const pickMore = async () => {
    const paths = await api.pickFiles(`${ROLE_NAME[role]}에 더할 파일 선택 (지금 파일 뒤에 이어 붙여요)`);
    if (paths.length) await importFiles(role, paths, { add: true });
  };
  card.addEventListener('dragover', (e) => {
    if (ro) return;
    e.preventDefault();
    card.classList.add('drop');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drop'));
  card.addEventListener('drop', async (e) => {
    if (ro) return;
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
      doc && !ro ? h('button.btn.btn-ghost.btn-small', { onclick: pickMore, disabled: locked, title: '기존 파일·분석 결과는 그대로 남아요' }, icon('plus'), '파일 추가') : null,
      doc && !ro ? h('button.btn.btn-ghost.btn-small', { onclick: pick, disabled: locked }, icon('refresh'), '파일 바꾸기') : null,
    ),
  );

  if (!doc) {
    if (ro) return card;
    card.append(
      h(
        'button.drop-zone',
        { onclick: pick, disabled: locked },
        h('span.dz-icon', icon('upload')),
        h('div.dz-title', '파일 선택 (끌어 놓기도 가능)'),
        h('div.muted.small', 'PDF 한 개, 또는 사진(JPG·PNG) 여러 장'),
      ),
    );
    return card;
  }

  const rangeInput = h('input.input.input-small', {
    value: doc.range || '',
    placeholder: '전체',
    title: 'PDF 쪽 번호예요. 예: 5-120, 3-10, 15',
    disabled: ro,
    onchange: (e) => {
      doc.range = e.target.value.trim();
      markDirty();
    },
  });
  const styleSelect = h(
    'select.input.input-small',
    {
      title: '자동 인식이 안 되면 번호 모양을 골라요',
      disabled: ro,
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
    disabled: ro,
    onchange: (e) => {
      doc.options.flow = e.target.checked ? 'continue' : 'column';
      markDirty();
    },
  });
  const offsetInput = h('input.input.input-tiny', {
    type: 'number',
    value: String(bookPage(doc, 0)),
    title: 'PDF 첫 쪽에 적힌 책 쪽 번호예요',
    disabled: ro,
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
      h('label', { title: 'PDF 첫 쪽에 적힌 책 쪽 번호예요' }, h('span', 'PDF 1쪽 = 책'), offsetInput, '쪽'),
      h('label.check', { title: '이어지는 해설을 묶어요. 답지는 켜 두는 편이 좋아요' }, flowCheck, h('span', '다음 단·쪽으로 이어짐')),
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
        { onclick: () => nav.home({ tab: 'books' }), title: '분석은 계속돼요. 진행은 위쪽 막대에 보여요' },
        icon('collapse'),
        '다른 일 하면서 기다리기',
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
        : h('div.doc-summary.muted', ''),
      ro
        ? null
        : h(
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

/** add: 파일 추가 — 지금 파일·분석 결과는 그대로 두고 뒤에 이어 붙임 (분석한 쪽이면 새 쪽만 분석) */
async function importFiles(role, paths, { add = false } = {}) {
  const b = bs.book;
  if (!canSave(b)) return;
  if (bookBusy(b)) {
    toast('이 책의 작업이 끝난 뒤에 파일을 바꿔 주세요.');
    return;
  }
  const old = b.docs[role];
  if (add && old) return addMoreFiles(role, paths);
  if (old && !(await confirmDialog(`${ROLE_NAME[role]}의 기존 파일·분석 결과가 새 파일로 바뀌어요.`, { ok: '바꾸기', danger: true }))) return;
  const pdfs = paths.filter((x) => /\.pdf$/i.test(x));
  if (pdfs.length > 1 && !(await confirmDialog(`PDF ${pdfs.length}개를 이름순으로 이어 붙여 ${ROLE_NAME[role]}(으)로 써요.`))) return;
  try {
    const removed = (old?.items || []).map((it) => it.id);
    await saver.flush();
    await importBookFiles(b, role, paths);
    dropSources(b.id, role);
    if (role === 'problem' && removed.length) noteRenamesFor(b, {}, removed);
    const src = await getSource(b, role);
    if (!onBook(b)) return;
    bs.sources[role] = src;
    rematch();
    bs.role = role;
    render();
    toast(`${role === 'problem' ? '문제집을' : '답지를'} 올렸어요. [${ROLE_NAME[role]} 분석]을 눌러 주세요.`, { type: 'success' });
  } catch (err) {
    toast(errMsg(err), { type: 'error', timeout: 8000 });
  }
}

/**
 * 파일 추가: 지금 파일 뒤에 이어 붙임. 새 쪽은 맨 뒤에 생겨서 지금 문항·영역·쪽 정보, 오답노트에서 고른 문항,
 * 저장해 둔 옮긴 결과는 그대로. 이미 분석했으면 새 쪽만 분석해서 더함
 */
async function addMoreFiles(role, paths) {
  const b = bs.book;
  let doc = b.docs[role];
  const pdfs = paths.filter((x) => /\.pdf$/i.test(x));
  if (pdfs.length > 1 && !(await confirmDialog(`PDF ${pdfs.length}개를 이름순으로 ${ROLE_NAME[role]} 뒤에 붙여요.`))) return;
  try {
    const before = doc.files.length;
    await saver.flush();
    await importBookFiles(b, role, paths, true);
    dropSources(b.id, role);
    doc = b.docs[role];
    const src = await getSource(b, role);
    if (!onBook(b)) return; // 그 사이 다른 화면으로 감 (파일은 더해 두었음)
    bs.sources[role] = src;
    rematch();
    bs.role = role;
    render();
    if (!src) return; // 열지 못함 (getSource 가 알림)
    const pages = src.pages.flatMap((p, i) => (p.fileIndex >= before ? [i] : []));
    // 쪽 범위를 정해 두었으면 새 쪽도 넣음 (다시 분석할 때 빠지지 않게)
    if (doc.range && pages.length) {
      doc.range = `${doc.range}, ${pages[0] + 1}-${pages[pages.length - 1] + 1}`;
      markDirty();
      render();
    }
    if (doc.analyzedAt && pages.length) await analyzeRole(role, { only: pages });
    else toast(`${ROLE_NAME[role]}에 ${pages.length}쪽을 더했어요.${doc.analyzedAt ? '' : ` [${ROLE_NAME[role]} 분석]을 눌러 주세요.`}`, { type: 'success' });
  } catch (err) {
    toast(errMsg(err), { type: 'error', timeout: 8000 });
  }
}

// ---------------------------------------------------------------------------
// 분석
// ---------------------------------------------------------------------------
/** only: 이 쪽만 분석해서 지금 결과에 더함 (파일 추가로 생긴 쪽 — 지금 문항·쪽 정보는 그대로) */
async function analyzeRole(role, { only = null } = {}) {
  const b = bs.book;
  const doc = b.docs[role];
  const src = bs.sources[role];
  if (!doc || !src || !canSave(b)) return;
  const running = analysisJob(b) || [...jobs.values()].find((j) => j.bookId === b.id);
  if (running) {
    // 이 책에서 도는 작업이 있으면 새로 시작하지 않고 그것을 보여 줌 (분석은 이 카드, AI 인식은 그 창)
    if (running === analysisJob(b)) render();
    else running.open();
    return;
  }
  if (!only && doc.edited && !(await confirmDialog(`다시 분석하면 ${ROLE_NAME[role]}에서 직접 고친 내용이 사라져요.`, { ok: '다시 분석', danger: true }))) return;
  let pages;
  try {
    pages = only || parsePageRange(doc.range, src.numPages);
  } catch (err) {
    toast(err.message, { type: 'error' });
    return;
  }
  if (!pages.length) {
    toast('분석할 쪽이 없어요. 쪽 범위를 확인하세요.', { type: 'error' });
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
      subject: b.subject,
      flow: doc.options.flow,
      numberStyle: doc.options.numberStyle,
      ocrLang: state.settings.ocrLang,
      signal: abort.signal,
      onProgress: ({ done, total, message }) => {
        job.progress({ done, total, label: message });
        updateProgress();
      },
    });
    if (only) {
      // 새 쪽 것만 더함 (번호 모양·쪽 번호 맞춤·직접 고친 표시는 처음 분석한 대로)
      doc.items = [...doc.items.filter((it) => !only.includes(it.page)), ...res.items];
      doc.pageInfo = { ...doc.pageInfo, ...res.pageInfo };
    } else {
      doc.items = res.items;
      doc.pageInfo = res.pageInfo;
      doc.signature = res.signature;
      doc.signatures = res.signatures || (res.signature ? [res.signature] : []);
      doc.edited = false;
      if (doc.pageOffsetAuto !== false && res.pageOffset != null) doc.pageOffset = res.pageOffset;
    }
    doc.analyzedAt = Date.now();
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
    const msg = `${ROLE_NAME[role]}: ${only ? `새 쪽에서 ${res.items.length}개, 모두 ` : ''}${doc.items.length}개 인식 (${sec}초${res.ocrPages ? `, 스캔 인식 ${res.ocrPages}쪽` : ''})${flagged ? ` · 확인할 쪽 ${flagged}` : ''}${miss ? ` · 빠진 번호 ${miss}` : ''}`;
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
    if (bs.readonly) view.append(h('div.empty-state', h('div.empty-art', icon('upload')), h('h3', '아직 올린 파일이 없어요'), h('p.muted', '만든 사람이 파일을 올려야 해요.')));
    else view.append(h('div.empty-state', h('div.empty-art', icon('upload')), h('h3', '문제집부터 올려 주세요'), h('p.muted', '')));
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
  left.append(h('div.result-toolbar', roleSeg, h('span.spacer'), h('span.small.muted', '번호를 누르면 미리보기가 열려요')));

  if (!doc.analyzedAt) {
    left.append(h('div.empty-state', h('div.empty-art', icon('scan')), h('h3', '아직 분석 전이에요'), h('p.muted', bs.readonly ? '만든 사람이 분석해야 해요.' : `[${ROLE_NAME[role]} 분석]을 누르세요.`)));
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
  const ro = bs.readonly; // 보기만: 페이지 검토로 가기·해설 짝 바꾸기 없음
  if (role === 'answer') {
    // 답지 문항: 해설만
    renderPreview(box, {
      book: { ...b, docs: { problem: b.docs.answer, answer: null } },
      sources: { problem: bs.sources.answer },
      item: it,
      matches: null,
      emptyText: ['번호를 누르면', h('br'), '해설을 여기서 볼 수 있어요.'],
      onShow: ro ? null : (_r, page, id) => switchTab('review', { role: 'answer', page, itemId: id }),
    });
    return;
  }
  renderPreview(box, {
    book: b,
    sources: bs.sources,
    item: it,
    matches: bs.matches,
    onShow: ro ? null : (r, page, id) => switchTab('review', { role: r, page, itemId: id }),
    onOverride: ro ? null : (item, value) => {
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
  const ro = bs.readonly; // 보기만: 어느 쪽인지만 보여 주고 고치는 버튼은 없음
  const panel = h('section.check-panel');
  const head = h(
    'div.cp-head',
    h('span.cp-icon', icon('warn')),
    h('div', h('strong', `확인이 필요한 쪽 ${pages.length}곳`), h('div.small.muted', ro ? '번호가 건너뛰었거나 인식이 애매한 쪽이에요.' : '번호가 건너뛰었거나 인식이 애매한 쪽이에요. 직접 보고 판단하세요.')),
    h('span.spacer'),
    ro ? null : h('button.btn.btn-small', { onclick: () => dismissPages(role, pages), title: '모두 이대로 괜찮다고 표시' }, icon('checkAll'), '모두 문제없음'),
  );
  const gemBtn = h('button.btn.btn-small', { disabled: true, hidden: aiOff(), onclick: () => sendToGemini(role, [...picked]) }, icon('scan'), '정밀 인식');
  const updateGem = () => {
    gemBtn.disabled = !picked.size;
    gemBtn.lastChild.textContent = picked.size ? `고른 ${picked.size}쪽 정밀 인식` : '정밀 인식';
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
        ro ? null : h('label.cp-pick', { title: '정밀 인식할 쪽 고르기', hidden: aiOff() }, h('input', { type: 'checkbox', onchange: (e) => { if (e.target.checked) picked.add(p); else picked.delete(p); updateGem(); } })),
        h('button.cp-page', { onclick: () => switchTab('review', { role, page: p }) }, pageLabel(doc, p)),
        h('span.cp-why', [...new Set(flags)].join(' · ')),
        ro
          ? null
          : h(
              'div.cp-actions',
              h('button.btn.btn-small.btn-ghost', { onclick: () => switchTab('review', { role, page: p }), title: '페이지 검토에서 직접 보고 고치기' }, icon('eye'), '검토'),
              h('button.btn.btn-small.btn-ghost', { onclick: () => deepPage(role, p), title: '이 쪽을 크게 읽고 앞뒤 번호에 맞춰 다시 찾기' }, icon('search'), '꼼꼼히 다시 찾기'),
              h('button.btn.btn-small.btn-ghost', { onclick: () => sendToGemini(role, [p]), title: '이 쪽 정밀 인식', hidden: aiOff() }, icon('scan'), '정밀 인식'),
              h('button.btn.btn-small.btn-ok', { onclick: () => dismissPages(role, [p]), title: '이대로 괜찮아요' }, icon('check'), '문제없음'),
            ),
      );
    }),
  );
  panel.append(head, list);
  if (!ro) panel.append(h('div.cp-foot', h('span.small.muted', geminiReady() ? '' : aiOff() ? '설정에서 정밀 인식을 켜세요.' : '설정에서 서비스 키를 입력하세요.'), h('span.spacer'), gemBtn));
  return panel;
}

async function dismissPages(role, pages) {
  if (!canSave(bs.book)) return;
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
  if (!canSave(b)) return;
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
  if (!doc || !src || !canSave(b)) return;
  const close = toast(`${pageLabel(doc, page)} 꼼꼼히 다시 찾는 중…`, { timeout: 0 });
  bs.working++;
  setRestartBusy('deep-page', true);
  try {
    const before = (doc.items || []).filter((it) => it.page === page);
    const { items, page: info, meta } = await reanalyzeSinglePage(src, doc, page, { ocrLang: state.settings.ocrLang, deep: true, role, subject: b.subject });
    close();
    const sameAsBefore = items.length === before.length && items.every((it, k) => it.num === before[k]?.num);
    if (items.length < before.length) {
      const keep = await confirmDialog(`다시 찾은 결과(${items.length}개)가 지금(${before.length}개)보다 적어요. 그래도 바꿀까요?`, { ok: '바꾸기', title: '꼼꼼히 다시 찾기' });
      if (!keep) return;
    }
    if (sameAsBefore) {
      toast(`페이지 검토·정밀 인식으로 확인하세요. 더 찾은 번호는 없어요 (${items.length}개).`, {
        timeout: 9000,
        actions: [
          { label: '페이지 검토', onClick: () => switchTab('review', { role, page }) },
          ...(geminiReady() ? [{ label: '정밀 인식', onClick: () => sendToGemini(role, [page]) }] : []),
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
  } finally {
    bs.working--;
    setRestartBusy('deep-page', false);
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
    return h('div.empty-state', h('div.empty-art', icon('files')), h('h3', '먼저 파일을 올려 주세요'), h('p.muted', ''));
  }
  const wrap = h('div.review-view', ed.el);
  const role = b.docs[ed.role] ? ed.role : b.docs.problem ? 'problem' : 'answer';
  requestAnimationFrame(() => ed.show(role, ed.page));
  requestAnimationFrame(() => requestAnimationFrame(() => ed.redraw()));
  return wrap;
}
