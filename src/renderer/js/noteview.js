// 학생 오답노트 화면: 책 고르기 → 틀린 번호 고르기 → 시험지 양식 PDF 내보내기

import { h, clear, toast, modal, confirmDialog, icon, animateOut, countUp } from './ui.js';
import { buildPdf, makeBlocks, itemName, SPACE_OPTIONS, DEFAULT_EXPORT_OPTIONS } from './exporter.js';
import { buildHwpx, renderStack, cropImage, blockSegs } from './hwpx.js';
import { geminiTranscribe, geminiTranscribeBatch, canvasToBase64Jpeg } from './gemini.js';
import { transcribeParts } from './pdfmath.js';
import { pageLabel, computeMatches, findItem, missingNumbers, noteSelection, setNoteSelection, noteSelectedCount, selectedItems, parseQuickSelect } from './store.js';
import { api, state, nav, leaveHooks, makeSaver, getSources, renderPreview, renderQTable, geminiReady, aiOptions, aiLabel, aiModelText, jobDialog, findJob, holdSource } from './shared.js';
import { topbar, renderUpdateBadge } from './chrome.js';
import { spineFor } from './home.js';

const saver = makeSaver((n) => api.saveNote(n));

const ns = {
  note: null,
  books: new Map(), // id → book
  sources: new Map(), // id → {problem, answer}
  matches: new Map(), // id → Map
  active: null, // 지금 보고 있는 책 id
  focus: null,
  onlySelected: false,
};

window.addEventListener('beforeunload', () => {
  if (ns.note && state.view === 'note') {
    saver.cancel();
    ns.note.updatedAt = Date.now();
    api.saveNoteSync(ns.note);
  }
});

const markDirty = () => saver.dirty();

export async function openNote(id) {
  const note = await api.getNote(id);
  note.bookIds ||= [];
  note.selected ||= {};
  note.exportOptions = { ...DEFAULT_EXPORT_OPTIONS, ...(note.exportOptions || {}) };
  ns.note = note;
  ns.books = new Map();
  ns.sources = new Map();
  ns.matches = new Map();
  ns.focus = null;
  ns.onlySelected = false;
  saver.set(note);
  state.view = 'note';
  leaveHooks.add(async () => {
    saver.cancel();
    await saver.flush();
    ns.note = null;
  });
  // 책 읽기 (지워진 책은 빼기)
  const missingBooks = [];
  for (const bid of note.bookIds) {
    try {
      const b = await api.getBook(bid);
      ns.books.set(bid, b);
      ns.matches.set(bid, computeMatches(b));
    } catch {
      missingBooks.push(bid);
    }
  }
  if (missingBooks.length) {
    note.bookIds = note.bookIds.filter((b) => !missingBooks.includes(b));
    markDirty();
  }
  // 책에서 사라진 문항은 선택에서 정리
  for (const [bid, b] of ns.books) {
    const ids = new Set((b.docs.problem?.items || []).map((it) => it.id));
    const sel = noteSelection(note, bid);
    const kept = sel.filter((x) => ids.has(x));
    if (kept.length !== sel.length) {
      setNoteSelection(note, bid, kept);
      markDirty();
      toast(`${b.name}: 책에서 바뀌거나 지워진 문항 ${sel.length - kept.length}개를 선택에서 뺐어요.`, { timeout: 6000 });
    }
  }
  ns.active = note.bookIds.includes(ns.active) ? ns.active : note.bookIds[0] || null;
  render({ enter: true });
  await loadActiveSources();
}

async function loadActiveSources() {
  const b = ns.books.get(ns.active);
  if (!b) return;
  if (!ns.sources.has(b.id)) ns.sources.set(b.id, await getSources(b));
  renderPreviewBox();
}

// ===========================================================================
function render({ enter = false } = {}) {
  const n = ns.note;
  if (!n) return;
  const root = document.getElementById('app');
  clear(root);
  const titleInput = h('input.title-input', {
    value: n.title,
    title: '오답노트 제목',
    onchange: (e) => {
      n.title = e.target.value.trim() || n.title;
      markDirty();
      syncExamFields();
    },
  });
  const studentInput = h('input.student-input', {
    value: n.student || '',
    placeholder: '학생 이름',
    title: '학생 이름',
    onchange: (e) => {
      n.student = e.target.value.trim();
      markDirty();
      syncExamFields();
    },
  });
  root.append(
    topbar(
      h(
        'div.topbar-crumb',
        h('button.btn.btn-ghost.btn-round#back-btn', { onclick: () => nav.home({ tab: 'notes' }), title: '오답노트 목록으로' }, icon('back')),
        h('span.crumb-kind', icon('notebook'), '오답노트'),
        h('span.crumb-sep', '/'),
        titleInput,
        h('label.student-chip', icon('user'), studentInput),
        h('span.save-status', ''),
      ),
    ),
    h(`main.sheet.note-sheet${enter ? '.view-enter' : ''}`, bookBar(), h('section.note-body', noteBody())),
  );
  renderUpdateBadge();
}

/** 이 노트에 쓰는 책들 (알약 모양) + 책 추가 */
function bookBar() {
  const n = ns.note;
  const bar = h('section.book-bar');
  n.bookIds.forEach((bid, i) => {
    const b = ns.books.get(bid);
    if (!b) return;
    const cnt = noteSelection(n, bid).length;
    bar.append(
      h(
        `button.book-tab${ns.active === bid ? '.active' : ''}`,
        { style: { '--spine': spineFor(bid), '--i': i }, onclick: () => switchBook(bid), dataset: { book: bid } },
        h('span.bt-spine'),
        h('span.bt-name', b.name),
        h('span.bt-count', cnt ? String(cnt) : ''),
        h('span.bt-x', { title: '이 오답노트에서 책 빼기', onclick: (e) => { e.stopPropagation(); removeBook(bid); } }, icon('x')),
      ),
    );
  });
  bar.append(h('button.btn.btn-small.btn-ghost.add-book', { onclick: addBook }, icon('plus'), '책 추가'));
  bar.append(h('span.spacer'), h('button.btn.btn-small.btn-ghost', { onclick: () => ns.active && nav.book(ns.active), disabled: !ns.active, title: '이 책의 인식 결과를 고치러 책 화면으로' }, icon('edit'), '책 인식 고치기'));
  return bar;
}

async function switchBook(bid) {
  if (ns.active === bid) return;
  ns.active = bid;
  ns.focus = null;
  document.querySelectorAll('.book-tab').forEach((t) => t.classList.toggle('active', t.dataset.book === bid));
  const body = document.querySelector('.note-body');
  await animateOut(body.querySelector('.select-main'), 'leave-fade', 150);
  clear(body);
  body.append(noteBody());
  body.querySelector('.select-main')?.classList.add('swap-in');
  await loadActiveSources();
}

async function addBook() {
  const all = await api.listBooks();
  const n = ns.note;
  const rest = all.filter((b) => !n.bookIds.includes(b.id));
  if (!rest.length) {
    const go = await confirmDialog(all.length ? '책장에 있는 책을 모두 쓰고 있어요. 새 책을 등록할까요?' : '책장에 등록한 책이 없어요. 새 책을 등록할까요?', { ok: '책장으로' });
    if (go) nav.home({ tab: 'books' });
    return;
  }
  const picked = new Set();
  const list = h(
    'div.book-pick',
    rest.map((b) =>
      h(
        'label.book-opt',
        { style: { '--spine': spineFor(b.id) } },
        h('input', { type: 'checkbox', onchange: (e) => { if (e.target.checked) picked.add(b.id); else picked.delete(b.id); e.target.closest('.book-opt').classList.toggle('on', e.target.checked); } }),
        h('span.bo-spine'),
        h('span.bo-name', b.name),
        h('span.bo-meta', b.problemCount ? `${b.problemCount}문항` : '분석 전'),
        h('span.bo-check', icon('check')),
      ),
    ),
  );
  const r = await modal({ title: '책 추가', body: list, width: 480, buttons: [{ label: '취소', value: null }, { label: '추가', primary: true, onClick: () => [...picked] }] });
  if (!r?.length) return;
  for (const bid of r) {
    const b = await api.getBook(bid);
    ns.books.set(bid, b);
    ns.matches.set(bid, computeMatches(b));
    n.bookIds.push(bid);
    noteSelection(n, bid);
  }
  ns.active = r[0];
  markDirty();
  render();
  await loadActiveSources();
}

async function removeBook(bid) {
  const n = ns.note;
  const b = ns.books.get(bid);
  const cnt = noteSelection(n, bid).length;
  if (cnt && !(await confirmDialog(`"${b?.name}"에서 고른 ${cnt}문항이 이 오답노트에서 빠져요. 계속할까요?`, { ok: '빼기', danger: true }))) return;
  n.bookIds = n.bookIds.filter((x) => x !== bid);
  delete n.selected[bid];
  if (ns.active === bid) ns.active = n.bookIds[0] || null;
  markDirty();
  render();
  await loadActiveSources();
}

// ---------------------------------------------------------------------------
function noteBody() {
  const n = ns.note;
  const view = h('div.select-view');
  const left = h('div.select-main');
  const right = h('aside.select-side', h('div.preview-box'), exportPanel());
  view.append(left, right);
  const b = ns.books.get(ns.active);
  const doc = b?.docs?.problem;
  if (!b) {
    left.append(h('div.empty-state', h('div.empty-art', icon('library')), h('h3', '책을 추가해 주세요'), h('p.muted', '위의 [책 추가]를 눌러 책장에 등록한 책을 고르세요.')));
    setTimeout(renderExportSummary, 0);
    return view;
  }
  if (!doc?.items?.length) {
    left.append(
      h(
        'div.empty-state',
        h('div.empty-art', icon('scan')),
        h('h3', doc ? '이 책은 아직 분석 전이에요' : '이 책에는 문제집 파일이 없어요'),
        h('p.muted', '책 화면에서 문제집(과 답지)을 올리고 분석하면 여기서 번호를 고를 수 있어요.'),
        h('button.btn.btn-primary', { onclick: () => nav.book(b.id) }, icon('arrowRight'), '책 화면으로'),
      ),
    );
    setTimeout(renderExportSummary, 0);
    return view;
  }

  const quick = h('input.input', { placeholder: '빠르게 고르기 — 12쪽: 3, 5, 7-9  또는  15, 22' });
  const applyQuick = () => {
    const text = quick.value.trim();
    if (!text) return;
    const { ids, unknown } = parseQuickSelect(text, doc);
    setNoteSelection(n, b.id, [...noteSelection(n, b.id), ...ids]);
    markDirty();
    quick.value = '';
    refresh();
    if (ids.length) toast(`${ids.length}문항을 골랐어요.`);
    if (unknown.length) toast(`찾지 못함: ${unknown.slice(0, 8).join(', ')}`, { type: 'error' });
  };
  quick.addEventListener('keydown', (e) => e.key === 'Enter' && applyQuick());
  left.append(
    h(
      'div.select-toolbar',
      h('div.search', icon('search'), quick),
      h('button.btn', { onclick: applyQuick }, '고르기'),
      h('label.switch.small', h('input', { type: 'checkbox', checked: ns.onlySelected, onchange: (e) => { ns.onlySelected = e.target.checked; drawTable(); } }), h('span.sw'), '고른 것만'),
      h('button.btn.btn-ghost.btn-small', { onclick: async () => { if (noteSelection(n, b.id).length && (await confirmDialog(`${b.name}에서 고른 문항을 모두 해제할까요?`))) { setNoteSelection(n, b.id, []); markDirty(); refresh(); } } }, '모두 해제'),
    ),
    h(
      'div.legend.small',
      h('span', h('span.chip.demo.on', '3'), '고른 문제'),
      h('span', h('span.chip.demo.noans', '3'), '해설 짝 없음'),
      h('span', h('span.chip.demo.missing', '4', h('span.chip-q', '?')), '인식 못한 번호'),
      h('span', '쪽 번호를 누르면 그 쪽 전체 선택'),
    ),
  );
  const table = h('div.qtable');
  left.append(table);
  const missing = missingNumbers(doc);

  function drawTable() {
    renderQTable(table, {
      doc,
      selected: new Set(noteSelection(n, b.id)),
      matches: ns.matches.get(b.id),
      hasAnswers: !!b.docs.answer?.items?.length,
      missing,
      onlySelected: ns.onlySelected,
      focusId: ns.focus,
      onChip: (it, page, items) => toggleOne(it, page, items),
      onHover: (it) => schedulePreview(it),
      onPage: (page, items, el) => togglePage(page, items, el),
      onMissing: async (page, m) => {
        const go = await confirmDialog(`${pageLabel(doc, page)}에서 ${m.prefix ? `${m.prefix} ` : ''}${m.num}번을 찾지 못했어요.\n책 화면에서 그 쪽을 열어 직접 추가할까요?`, { ok: '책 화면에서 열기', title: '인식 못한 번호' });
        if (go) nav.book(b.id, { tab: 'review', role: 'problem', page });
      },
    });
  }
  function refresh() {
    drawTable();
    renderExportSummary();
    updateBookCount();
  }
  function toggleOne(it, page, items) {
    const set = new Set(noteSelection(n, b.id));
    const on = !set.has(it.id);
    if (on) set.add(it.id);
    else set.delete(it.id);
    setNoteSelection(n, b.id, [...set]);
    markDirty();
    ns.focus = it.id;
    if (ns.onlySelected && !on) {
      refresh();
    } else {
      const chipEl = table.querySelector(`.chip[data-id="${CSS.escape(it.id)}"]`);
      chipEl?.classList.toggle('on', on);
      if (on) {
        chipEl?.classList.remove('pop');
        void chipEl?.offsetWidth;
        chipEl?.classList.add('pop');
      }
      table.querySelectorAll('.chip.focus').forEach((c) => c.classList.remove('focus'));
      chipEl?.classList.add('focus');
      table.querySelector(`.qpage[data-page="${page}"]`)?.classList.toggle('on', items.length > 0 && items.every((x) => set.has(x.id)));
      renderExportSummary();
      updateBookCount();
    }
    renderPreviewBox();
  }
  function togglePage(page, items, el) {
    if (!items.length) return;
    const set = new Set(noteSelection(n, b.id));
    const all = items.every((x) => set.has(x.id));
    if (all) items.forEach((it) => set.delete(it.id));
    else items.forEach((it) => set.add(it.id));
    setNoteSelection(n, b.id, [...set]);
    markDirty();
    if (ns.onlySelected) return refresh();
    el.classList.toggle('on', !all);
    items.forEach((it, k) => {
      const c = table.querySelector(`.chip[data-id="${CSS.escape(it.id)}"]`);
      c?.classList.toggle('on', !all);
      if (!all && c) {
        c.style.setProperty('--d', `${k * 18}ms`);
        c.classList.remove('pop');
        void c.offsetWidth;
        c.classList.add('pop');
      }
    });
    renderExportSummary();
    updateBookCount();
  }
  let hoverTimer = null;
  function schedulePreview(it) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (ns.focus === it.id) return;
      ns.focus = it.id;
      table.querySelectorAll('.chip.focus').forEach((c) => c.classList.remove('focus'));
      table.querySelector(`.chip[data-id="${CSS.escape(it.id)}"]`)?.classList.add('focus');
      renderPreviewBox();
    }, 130);
  }
  drawTable();
  setTimeout(() => {
    renderPreviewBox();
    renderExportSummary();
  }, 0);
  return view;
}

function updateBookCount() {
  const n = ns.note;
  for (const el of document.querySelectorAll('.book-tab')) {
    const c = el.querySelector('.bt-count');
    const cnt = noteSelection(n, el.dataset.book).length;
    if (c && c.textContent !== String(cnt || '')) {
      c.textContent = cnt ? String(cnt) : '';
      c.classList.remove('bump');
      void c.offsetWidth;
      c.classList.add('bump');
    }
  }
}

function renderPreviewBox() {
  const box = document.querySelector('.select-side .preview-box');
  const b = ns.books.get(ns.active);
  if (!box || !b) return;
  const doc = b.docs.problem;
  const item = ns.focus && doc ? findItem(doc, ns.focus) : null;
  const sources = ns.sources.get(b.id) || {};
  const n = ns.note;
  const selected = item ? noteSelection(n, b.id).includes(item.id) : false;
  renderPreview(box, {
    book: b,
    sources,
    item,
    matches: ns.matches.get(b.id),
    selected,
    onShow: (role, page, id) => nav.book(b.id, { tab: 'review', role, page, itemId: id }),
    onToggleSelect: (it) => {
      const set = new Set(noteSelection(n, b.id));
      if (set.has(it.id)) set.delete(it.id);
      else set.add(it.id);
      setNoteSelection(n, b.id, [...set]);
      markDirty();
      document.querySelector(`.qtable .chip[data-id="${CSS.escape(it.id)}"]`)?.classList.toggle('on', set.has(it.id));
      renderPreviewBox();
      renderExportSummary();
      updateBookCount();
    },
  });
}

// ===========================================================================
// 내보내기
// ===========================================================================
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
};

function examInfo() {
  const n = ns.note;
  const s = state.settings;
  return {
    title: n.title,
    student: n.student || '',
    academy: n.academy ?? s.academy ?? '',
    teacher: n.teacher ?? s.teacher ?? '',
    date: n.examDate || today(),
  };
}

function syncExamFields() {
  const info = examInfo();
  for (const [k, v] of Object.entries(info)) {
    const el = document.querySelector(`.exam-field [data-key="${k}"]`);
    if (el && document.activeElement !== el) el.value = v;
  }
  renderExamMock();
}

function exportPanel() {
  const n = ns.note;
  const o = n.exportOptions;
  const set = (k, v) => {
    o[k] = v;
    markDirty();
  };
  const seg = (name, current, options, onChange) =>
    h(
      'div.seg',
      options.map(([value, label]) => h('label', h('input', { type: 'radio', name, value, checked: String(current) === String(value), onchange: () => onChange(value) }), h('span', label))),
    );
  const info = examInfo();
  const field = (key, label, ic, placeholder) =>
    h(
      'label.exam-field',
      h('span.ef-label', icon(ic), label),
      h('input.input.input-small', {
        value: info[key] || '',
        placeholder,
        dataset: { key },
        oninput: (e) => {
          const v = e.target.value;
          if (key === 'title') n.title = v.trim() || n.title;
          else if (key === 'student') n.student = v.trim();
          else if (key === 'date') n.examDate = v.trim();
          else n[key] = v.trim();
          markDirty();
          renderExamMock();
          if (key === 'title') {
            const t = document.querySelector('.topbar .title-input');
            if (t) t.value = n.title;
          }
          if (key === 'student') {
            const t = document.querySelector('.topbar .student-input');
            if (t) t.value = n.student;
          }
        },
      }),
    );
  const anyAnswers = [...ns.books.values()].some((b) => b.docs.answer?.items?.length);
  const needAns = anyAnswers ? '' : '책에 답지를 올리고 분석하면 쓸 수 있어요';
  const exportBtn = (mode, title, sub, tip, disabled) =>
    h('button.export-btn', { onclick: () => doExport(mode), dataset: { mode }, disabled, title: tip }, h('span.xb-icon', icon('download')), h('span.xb-text', h('b', title), sub ? h('small', sub) : null));
  return h(
    'div.export-panel',
    h('div.export-head', h('h3', '시험지로 내보내기'), h('div.sel-count')),
    h('div.export-summary'),
    h(
      'details.exam-box',
      { open: true },
      h('summary', icon('school'), '시험지 머리', h('span.small.muted', '학원·선생님 기본값은 설정에서')),
      h('div.exam-mock'),
      h(
        'div.exam-fields',
        field('title', '제목', 'notebook', '오답노트 제목'),
        field('student', '학생', 'user', '학생 이름'),
        field('academy', '학원', 'school', state.settings.academy || '학원 이름'),
        field('teacher', '선생님', 'user', state.settings.teacher || '선생님 이름'),
        field('date', '날짜', 'calendar', today()),
      ),
    ),
    h(
      'div.export-options',
      h(
        'div.opt-row',
        h('span.opt-label', '파일'),
        seg('format', o.format, [['pdf', 'PDF'], ['hwpx', '한글(HWPX)']], (v) => {
          set('format', v);
          renderFormatHint();
        }),
      ),
      h('div.opt-row', h('span.opt-label', '배치'), seg('cols', o.columns, [[1, '1단'], [2, '2단']], (v) => set('columns', +v))),
      h('div.opt-row', h('span.opt-label', '풀이 여백'), seg('space', o.space, Object.entries(SPACE_OPTIONS).map(([k, v]) => [k, v.short]), (v) => set('space', v))),
      h(
        'div.opt-row',
        h('span.opt-label', '표시'),
        h('label.switch', h('input', { type: 'checkbox', checked: o.labels, onchange: (e) => set('labels', e.target.checked) }), h('span.sw'), '출처(책·쪽·번호)'),
        h('label.switch', h('input', { type: 'checkbox', checked: o.renumber, onchange: (e) => set('renumber', e.target.checked) }), h('span.sw'), '새 번호'),
      ),
      formatHint(),
    ),
    h(
      'div.export-buttons',
      exportBtn('problems', '문제지', '고른 문제만', '고른 문제만', false),
      exportBtn('answers', '해설지', '고른 문제의 해설만', needAns || '고른 문제의 해설만', !anyAnswers),
      exportBtn('both-inline', '문제 + 해설', '문제마다 바로 뒤에', needAns || '문제마다 바로 뒤에 그 문제의 해설', !anyAnswers),
      exportBtn('both-end', '문제 + 해설', '해설은 맨 뒤에', needAns || '문제를 모두 싣고, 해설은 맨 뒤에 모아서', !anyAnswers),
    ),
  );
}

/** 한글(HWPX)을 고르면 옵션 아래에 보이는 짧은 안내 */
function formatHint() {
  const el = h('p.small.muted.export-hint');
  setFormatHint(el);
  return el;
}

function setFormatHint(el) {
  el.hidden = ns.note?.exportOptions.format !== 'hwpx';
  el.textContent = geminiReady()
    ? `문제·해설을 글자와 수식으로 옮겨 한글 수식 편집기로 고칠 수 있어요 (디지털 PDF 는 PDF 글자 그대로, 나머지는 ${aiLabel()} 사용)`
    : '디지털 PDF(EBS 교재 등)는 글자와 수식으로 옮겨요. 스캔본은 AI 를 설정하지 않으면 그림으로 들어가요 (설정에서 AI 키 입력)';
}

export function renderFormatHint() {
  const el = document.querySelector('.export-hint');
  if (el) setFormatHint(el);
}

/** 시험지 머리 미리보기 (작은 종이 모양) */
function renderExamMock() {
  const el = document.querySelector('.exam-mock');
  if (!el) return;
  const info = examInfo();
  clear(el);
  el.append(
    h('div.em-top', h('span', info.academy || '학원'), h('span', info.date)),
    h('div.em-title', info.title || '오답노트'),
    h('div.em-lines'),
    h(
      'div.em-cells',
      [
        ['학원', info.academy],
        ['선생님', info.teacher],
        ['학생', info.student],
        ['점수', ''],
      ].map(([k, v]) => h('div.em-cell', h('span', k), h('b', v || ''))),
    ),
  );
}

/** 모든 책에서 고른 문항(노트의 책 순서 → 책 안에서 읽는 순서) */
function allEntries() {
  const n = ns.note;
  const out = [];
  for (const bid of n.bookIds) {
    const b = ns.books.get(bid);
    if (!b) continue;
    const m = ns.matches.get(bid);
    for (const it of selectedItems(b, noteSelection(n, bid))) {
      const aid = m?.get(it.id);
      out.push({ bookId: bid, book: n.bookIds.length > 1 ? b.name : '', bookObj: b, problem: it, answer: aid ? findItem(b.docs.answer, aid) : null });
    }
  }
  return out;
}

function renderExportSummary() {
  const el = document.querySelector('.export-summary');
  const countEl = document.querySelector('.export-head .sel-count');
  renderExamMock();
  if (!el) return;
  clear(el);
  const entries = allEntries();
  if (countEl) {
    clear(countEl);
    if (entries.length) {
      const num = h('strong');
      countEl.append(num, '문항');
      num.textContent = String(entries.length);
    }
  }
  if (!entries.length) {
    el.append(h('p.empty-hint', '왼쪽 표에서 틀린 번호를 골라 주세요.'));
    return;
  }
  const noAns = entries.filter((e) => e.bookObj.docs.answer?.items?.length && !e.answer).length;
  if (noAns) el.append(h('p.warn-text.small', icon('warn'), `해설 짝이 없는 문항 ${noAns}개`));
  el.append(
    h(
      'div.sel-list',
      entries.map((e) =>
        h(
          'span.sel-chip',
          {
            style: { '--spine': spineFor(e.bookId) },
            onclick: () => {
              if (ns.active !== e.bookId) {
                switchBook(e.bookId).then(() => {
                  ns.focus = e.problem.id;
                  renderPreviewBox();
                });
              } else {
                ns.focus = e.problem.id;
                renderPreviewBox();
              }
            },
            title: `${e.bookObj.name} — 미리보기`,
          },
          `${pageLabel(e.bookObj.docs.problem, e.problem.page)} ${itemName(e.problem)}`,
          h(
            'button.sel-x',
            {
              title: '빼기',
              onclick: (ev) => {
                ev.stopPropagation();
                const n = ns.note;
                setNoteSelection(n, e.bookId, noteSelection(n, e.bookId).filter((x) => x !== e.problem.id));
                markDirty();
                document.querySelector(`.qtable .chip[data-id="${CSS.escape(e.problem.id)}"]`)?.classList.remove('on');
                const chipEl = ev.currentTarget.closest('.sel-chip');
                animateOut(chipEl, 'leave-pop', 180).then(() => {
                  renderExportSummary();
                  updateBookCount();
                  if (ns.active === e.bookId) renderPreviewBox();
                });
              },
            },
            icon('x'),
          ),
        ),
      ),
    ),
  );
}

async function doExport(mode) {
  const n = ns.note;
  const entries = allEntries();
  if (!entries.length) {
    toast('먼저 표에서 문항을 골라 주세요.', { type: 'error' });
    return;
  }
  // 고른 책들의 원본 파일 열기
  for (const e of entries) {
    if (!ns.sources.has(e.bookId)) ns.sources.set(e.bookId, await getSources(e.bookObj));
    e.src = ns.sources.get(e.bookId);
  }
  const opts = n.exportOptions;
  const jobKey = `hwpx:${n.id}`;
  if (opts.format === 'hwpx' && findJob(jobKey)) {
    findJob(jobKey).open(); // 이 오답노트의 한글 문서를 뒤에서 만드는 중
    return;
  }
  const label = (role, it, e) => pageLabel(e.bookObj.docs[role], it.page);
  const blocks = makeBlocks(mode, entries, opts, label);
  const modeName = { problems: '문제지', answers: '해설지', 'both-inline': '문제+해설', 'both-end': '문제+해설(해설 뒤)' }[mode];
  const info = examInfo();
  const sub = { problems: `문제 ${entries.length}문항`, answers: `해설 ${entries.length}문항`, 'both-inline': `문제·해설 ${entries.length}문항`, 'both-end': `문제 ${entries.length}문항 · 정답 및 해설` }[mode];
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const btn = document.querySelector(`.export-btn[data-mode="${mode}"]`);
  const hwpx = opts.format === 'hwpx';
  const kindName = hwpx ? '한글 문서' : 'PDF';
  btn?.classList.add('working');
  const closeToast = toast(`${modeName} ${kindName} 만드는 중…`, { timeout: 0 });
  try {
    const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    const fname = [safe(info.student), safe(info.title), modeName, ymd].filter(Boolean).join('_');
    let res;
    let note = '';
    const saved = (r) => {
      if (r.canceled) return;
      toast(`저장했어요${note} — ${r.path}`, {
        type: 'success',
        timeout: 10000,
        actions: [
          { label: '열기', onClick: () => api.openPath(r.path) },
          { label: '폴더 보기', onClick: () => api.showItemInFolder(r.path) },
        ],
      });
    };
    if (hwpx) {
      const bytes = await exportHwpx(blocks, entries, opts, { ...info, subtitle: sub }, jobKey);
      closeToast();
      if (bytes.stats?.picture && bytes.stats?.text) note = ` (그림으로 넣은 문항 ${bytes.stats.picture}개)`;
      const save = () => api.saveFile({ defaultName: `${fname}.hwpx`, data: bytes, filters: [{ name: '한글 문서', extensions: ['hwpx'] }], title: '한글 문서 저장' });
      // 옮기기를 뒤로 보내 둔 채 끝났으면 저장 창을 바로 띄우지 않고 알림의 [저장하기]로 (다른 화면을 보고 있을 수 있음)
      if (bytes.job?.finish({ message: `${info.student ? `${info.student} · ` : ''}${modeName} 한글 문서가 준비됐어요`, actions: [{ label: '저장하기', onClick: async () => saved(await save()) }] })) return;
      res = await save();
    } else {
      const bytes = await buildPdf({ blocks, options: opts, title: info.title, info: { ...info, subtitle: sub } });
      closeToast();
      res = await api.savePdf(`${fname}.pdf`, bytes);
    }
    saved(res);
  } catch (err) {
    closeToast();
    if (err?.name === 'AbortError') {
      toast('한글 문서 만들기를 멈췄어요. 그때까지 옮긴 문항은 저장해 두었어요.');
      return;
    }
    console.error(err);
    toast(`${kindName}를 만들지 못했어요: ${err.message}`, { type: 'error', timeout: 10000 });
  } finally {
    btn?.classList.remove('working');
  }
}

// ===========================================================================
// 한글 문서(HWPX): 문항을 글자·수식으로 옮겨 넣음 — 디지털 PDF 는 PDF 글자로, 나머지는 AI 로 (못 옮긴 문항은 그림으로)
// ===========================================================================
const TRANSCRIBE_WIDTH = 1500; // AI 에 보내는 그림 폭(px)
const MAX_TRANSCRIPTS = 3000; // 책 하나에 저장해 두는 개수
const transcripts = new Map(); // 책 id → {items: {열쇠: {blocks, model, at}}, dirty}  (책 폴더의 transcripts.json)

async function loadTranscripts(bookId) {
  if (!transcripts.has(bookId)) {
    let data = null;
    try {
      data = await api.getTranscripts(bookId);
    } catch (err) {
      console.warn('저장해 둔 옮긴 결과를 읽지 못함', err);
    }
    transcripts.set(bookId, { items: data?.items || {}, dirty: false });
  }
  return transcripts.get(bookId);
}

async function saveTranscripts() {
  for (const [bookId, t] of transcripts) {
    if (!t.dirty) continue;
    const keys = Object.keys(t.items);
    if (keys.length > MAX_TRANSCRIPTS) {
      keys.sort((a, b) => (t.items[a].at || 0) - (t.items[b].at || 0));
      for (const k of keys.slice(0, keys.length - MAX_TRANSCRIPTS)) delete t.items[k];
    }
    try {
      await api.saveTranscripts(bookId, { version: 1, items: t.items });
      t.dirty = false;
    } catch (err) {
      console.warn('옮긴 결과를 저장하지 못함', err);
    }
  }
}

/** 같은 문항·같은 영역·같은 원본 파일이면 같은 열쇠 */
function transcriptKey(block) {
  const raw = JSON.stringify({ files: (block.src?.files || []).map((f) => f.name), rects: block.item.rects, stem: block.stem || null });
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) hash = Math.imul(hash ^ raw.charCodeAt(i), 0x01000193);
  return `${block.role}|${block.item.id}|${(hash >>> 0).toString(36)}`;
}

/**
 * 수식 글꼴로 만든 디지털 PDF 는 AI 없이 쪽의 글자·선을 그대로 읽어 옮김. 못 하면 null
 * 그림 상자(box)는 renderStack 으로 쌓은 그림 기준 (같은 폭·같은 틈)
 */
async function pdfTranscribe(segs) {
  const scale = TRANSCRIBE_WIDTH / Math.max(...segs.map((s) => s.wPt));
  const W = Math.max(...segs.map((s) => s.wPt * scale));
  const H = segs.reduce((sum, s) => sum + s.hPt * scale, 0) + 12 * (segs.length - 1);
  const parts = [];
  let y = 0;
  for (const s of segs) {
    const layer = await s.src.getMathLayer?.(s.rect.page);
    if (!layer) return null;
    parts.push({ layer, rect: s.rect, place: { x: 0, y: y / H, w: (s.wPt * scale) / W, h: (s.hPt * scale) / H } });
    y += s.hPt * scale + 12;
  }
  try {
    return transcribeParts(parts);
  } catch (err) {
    console.warn('PDF 글자로 옮기지 못함', err);
    return null;
  }
}

/**
 * 0) 디지털 PDF 문항은 PDF 글자로 바로 옮김 (AI 를 쓰지 않음)
 * 1) 나머지 중 새로 옮길 문항을 먼저 AI 로 옮겨 저장: 문항 여러 개를 한 요청에 묶고(설정 aiBatch), 요청 여러 개를 동시에(aiConcurrency)
 * 2) buildHwpx 는 문항마다 transcribe 를 부르는데, 미리 옮겨 둔 결과를 그대로 씀
 */
async function exportHwpx(blocks, entries, opts, info, jobKey) {
  const bookOf = new Map(); // 원본(DocSource) → 책 id
  for (const e of entries) for (const src of [e.src?.problem, e.src?.answer]) if (src) bookOf.set(src, e.bookId);
  // buildHwpx 가 글자로 옮기려는 문항 (그릴 영역이 있는 문제·해설)
  const work = blocks.filter((b) => (b.kind === 'problem' || b.kind === 'answer') && b.item && bookOf.has(b.src) && blockSegs(b).length);
  const fromPdf = new Map(); // 문항 → PDF 글자로 옮긴 결과
  for (const b of work) {
    const list = await pdfTranscribe(blockSegs(b));
    if (list) fromPdf.set(b, list);
  }
  const useAi = geminiReady() && work.some((b) => !fromPdf.has(b));
  const { batch: batchSize, ...ai } = aiOptions();
  const abort = new AbortController();
  const storeOf = (block) => transcripts.get(bookOf.get(block.src));
  const failed = new Set(); // 이번에 미리 옮기지 못한 문항 → 그림으로 (다시 묻지 않음)
  let quota = false; // 한도가 차면 나머지는 묻지 않고 그림으로
  let ui = null;
  const releases = [];

  /** 새로 옮길 문항을 묶음으로 동시에 옮겨 저장 (같은 열쇠의 문항은 한 번만) */
  const prefetch = async (pending) => {
    const groups = new Map(); // 열쇠 → 블록들
    for (const b of pending) {
      const key = transcriptKey(b);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    // 문제와 해설은 지시문이 달라서 따로 묶음
    const batches = [];
    for (const role of ['problem', 'answer']) {
      const keys = [...groups.keys()].filter((k) => groups.get(k)[0].role === role);
      for (let i = 0; i < keys.length; i += batchSize) batches.push({ role, keys: keys.slice(i, i + batchSize) });
    }
    let done = work.length - pending.length;
    ui.progress(done, work.length);
    const settle = (key, stateName, msg) => {
      for (const b of groups.get(key)) ui.row(b).set(stateName, msg);
      done += groups.get(key).length;
      ui.progress(done, work.length);
    };
    const giveUp = (key, stateName, msg) => {
      for (const b of groups.get(key)) failed.add(b);
      settle(key, stateName, msg);
    };

    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const { role, keys } = batches[next++];
        if (quota) {
          for (const k of keys) giveUp(k, 'empty', '한도 초과 → 그림으로');
          continue;
        }
        for (const k of keys) for (const b of groups.get(k)) ui.row(b).set('run', '옮기는 중…');
        let results;
        try {
          // buildHwpx 가 transcribe 에 넘기는 것과 같은 영역(blockSegs)·같은 폭의 그림
          const images = [];
          for (const k of keys) images.push(canvasToBase64Jpeg(await renderStack(blockSegs(groups.get(k)[0]), TRANSCRIBE_WIDTH), 0.85));
          results = await geminiTranscribeBatch(images, { role, ...ai, signal: abort.signal, onStatus: (msg) => ui.status(msg) });
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          results = keys.map(() => err);
        }
        keys.forEach((k, i) => {
          const r = results[i];
          if (r instanceof Error) {
            if (/한도/.test(r.message)) {
              quota = true;
              ui.status(r.message);
            }
            giveUp(k, 'err', `${r.message} → 그림으로`);
          } else if (!r.length) {
            giveUp(k, 'empty', '읽은 내용이 없음 → 그림으로');
          } else {
            const store = storeOf(groups.get(k)[0]);
            store.items[k] = { blocks: [...r], model: r.model, at: Date.now() };
            store.dirty = true;
            settle(k, 'ok', `글자·수식으로 옮김 · ${r.model || '기본 모델'}`);
          }
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(ai.concurrency, batches.length) }, worker));
  };

  const transcribe = async (block, segs) => {
    if (abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
    let stack = null;
    const getStack = async () => (stack ||= await renderStack(segs, TRANSCRIBE_WIDTH));
    // 그림(그래프·도형)은 바로 잘라 두고 큰 canvas 는 버림
    const finish = async (list) => {
      const crops = new Map();
      for (const b of list) if (b.type === 'figure') crops.set(b.box, await cropImage(await getStack(), b.box));
      stack = null;
      return {
        blocks: list,
        crop: async (box) => {
          if (!crops.has(box)) throw new Error('잘라 둔 그림이 없음');
          return crops.get(box);
        },
      };
    };
    if (fromPdf.has(block)) return finish(fromPdf.get(block));
    const store = useAi && storeOf(block);
    if (!store) return null;
    const key = transcriptKey(block);
    const row = ui?.row(block);
    const cached = store.items[key];
    if (cached?.blocks?.length) return finish(cached.blocks);
    if (failed.has(block)) return null;
    if (quota) {
      row?.set('empty', '한도 초과 → 그림으로');
      return null;
    }
    // 미리 옮기기에서 빠진 문항만 여기서 하나씩
    row?.set('run', '옮기는 중…');
    try {
      const result = await geminiTranscribe(canvasToBase64Jpeg(await getStack(), 0.85), {
        role: block.role,
        ...ai,
        signal: abort.signal,
        onStatus: (msg) => ui?.status(msg),
      });
      if (!result.length) {
        row?.set('empty', '읽은 내용이 없음 → 그림으로');
        return null;
      }
      store.items[key] = { blocks: [...result], model: result.model, at: Date.now() };
      store.dirty = true;
      row?.set('ok', `글자·수식으로 옮김 · ${result.model || '기본 모델'}`);
      return finish(store.items[key].blocks);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      if (/한도/.test(err.message)) {
        quota = true;
        ui?.status(err.message);
      }
      row?.set('err', `${err.message} → 그림으로`);
      return null;
    }
  };

  try {
    if (useAi) {
      for (const bid of new Set(work.map((b) => bookOf.get(b.src)))) await loadTranscripts(bid);
      const pending = work.filter((b) => !fromPdf.has(b) && !storeOf(b).items[transcriptKey(b)]?.blocks?.length);
      if (pending.length) {
        ui = transcribeDialog(work, pending.length, abort, { key: jobKey, jobTitle: `${info.student ? `${info.student} · ` : ''}한글 문서 (문항 ${work.length}개)` });
        // 뒤에서 도는 동안 다른 책을 열어도 이 원본들은 닫히지 않게
        for (const e of entries) for (const role of ['problem', 'answer']) releases.push(holdSource(e.bookObj, role));
        for (const b of work) if (!pending.includes(b)) ui.row(b).set('ok', fromPdf.has(b) ? 'PDF 글자로 옮김' : '저장해 둔 결과');
        await prefetch(pending);
        ui.status('한글 문서를 만드는 중…');
      }
    }
    const bytes = await buildHwpx({ blocks, options: opts, title: info.title, info, transcribe: useAi || fromPdf.size ? transcribe : null });
    bytes.job = ui; // 옮기기 창을 띄웠으면 부른 쪽이 finish() — 앞에 보이면 창을 닫고, 뒤로 보내 두었으면 [저장하기] 알림
    return bytes;
  } catch (err) {
    ui?.finish();
    throw err;
  } finally {
    releases.forEach((release) => release());
    await saveTranscripts();
  }
}

/** 옮기는 동안 보이는 창 (문항별 상태, 진행 막대). [취소]하면 바로 요청을 끊고, [백그라운드에서 계속]이면 창만 닫고 계속 */
function transcribeDialog(work, pendingCount, abort, { key, jobTitle }) {
  const rows = new Map();
  const list = h(
    'div.gem-list',
    work.map((b) => {
      const row = h('div.gem-row', { dataset: { state: 'wait' } }, h('span.gem-dot'), h('strong', `${b.kind === 'answer' ? '해설' : '문제'} ${itemName(b.item)}`), h('span.gem-msg.muted', '기다리는 중'));
      rows.set(b, row);
      return row;
    }),
  );
  const status = h('div.small.muted.gem-status', `모델: ${aiModelText()}`);
  const bar = h('div.progress-bar');
  const jd = jobDialog({
    key,
    abort,
    jobTitle,
    total: work.length,
    title: `문항 ${work.length}개를 글자·수식으로`,
    body: h(
      'div.gem-run',
      h('p.small.muted', `새로 옮길 문항 ${pendingCount}개를 AI(${aiLabel()})에게 보내요. 여러 문항을 한 요청에 묶어 동시에 보내요. 옮기지 못한 문항은 그림으로 넣어요. 옮긴 결과는 저장해 두어 다음에는 다시 묻지 않아요.`),
      h('div.progress', bar),
      status,
      list,
    ),
    width: 480,
    className: 'gem-modal',
  });
  return {
    row: (block) => ({
      set(stateName, msg) {
        const row = rows.get(block);
        if (!row) return;
        row.dataset.state = stateName;
        row.querySelector('.gem-msg').textContent = msg;
        if (stateName === 'run') row.scrollIntoView({ block: 'nearest' });
      },
    }),
    status: (msg) => {
      status.textContent = msg;
      jd.job.progress({ label: msg });
    },
    progress: (done, total) => {
      bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
      jd.job.progress({ done, total });
    },
    /** 끝: 창이 앞에 있으면 닫고 false, 뒤로 보내 두었고 r.message 가 있으면 알림(토스트·윈도우)을 띄우고 true */
    finish(r) {
      const bg = jd.finish(r);
      if (!bg) jd.close();
      return bg;
    },
  };
}

export { noteSelectedCount };
