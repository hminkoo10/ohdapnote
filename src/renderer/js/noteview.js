// 학생 오답노트 화면: 책 고르기 → 틀린 번호 고르기 → 시험지 양식 PDF 내보내기

import { h, clear, toast, modal, confirmDialog, icon, animateOut, countUp } from './ui.js';
import { buildPdf, makeBlocks, itemName, SPACE_OPTIONS, DEFAULT_EXPORT_OPTIONS } from './exporter.js';
import { pageLabel, computeMatches, findItem, missingNumbers, noteSelection, setNoteSelection, noteSelectedCount, selectedItems, parseQuickSelect } from './store.js';
import { api, state, nav, leaveHooks, makeSaver, getSources, renderPreview, renderQTable } from './shared.js';
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
      h('div.opt-row', h('span.opt-label', '배치'), seg('cols', o.columns, [[1, '1단'], [2, '2단']], (v) => set('columns', +v))),
      h('div.opt-row', h('span.opt-label', '풀이 여백'), seg('space', o.space, Object.entries(SPACE_OPTIONS).map(([k, v]) => [k, v.short]), (v) => set('space', v))),
      h(
        'div.opt-row',
        h('span.opt-label', '표시'),
        h('label.switch', h('input', { type: 'checkbox', checked: o.labels, onchange: (e) => set('labels', e.target.checked) }), h('span.sw'), '출처(책·쪽·번호)'),
        h('label.switch', h('input', { type: 'checkbox', checked: o.renumber, onchange: (e) => set('renumber', e.target.checked) }), h('span.sw'), '새 번호'),
      ),
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
  const label = (role, it, e) => pageLabel(e.bookObj.docs[role], it.page);
  const opts = n.exportOptions;
  const blocks = makeBlocks(mode, entries, opts, label);
  const modeName = { problems: '문제지', answers: '해설지', 'both-inline': '문제+해설', 'both-end': '문제+해설(해설 뒤)' }[mode];
  const info = examInfo();
  const sub = { problems: `문제 ${entries.length}문항`, answers: `해설 ${entries.length}문항`, 'both-inline': `문제·해설 ${entries.length}문항`, 'both-end': `문제 ${entries.length}문항 · 정답 및 해설` }[mode];
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const btn = document.querySelector(`.export-btn[data-mode="${mode}"]`);
  btn?.classList.add('working');
  const closeToast = toast(`${modeName} PDF 만드는 중…`, { timeout: 0 });
  try {
    const bytes = await buildPdf({ blocks, options: opts, title: info.title, info: { ...info, subtitle: sub } });
    closeToast();
    const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    const fname = [safe(info.student), safe(info.title), modeName, ymd].filter(Boolean).join('_');
    const res = await api.savePdf(`${fname}.pdf`, bytes);
    if (res.canceled) return;
    toast(`저장했어요 — ${res.path}`, {
      type: 'success',
      timeout: 10000,
      actions: [
        { label: '열기', onClick: () => api.openPath(res.path) },
        { label: '폴더 보기', onClick: () => api.showItemInFolder(res.path) },
      ],
    });
  } catch (err) {
    closeToast();
    console.error(err);
    toast(`PDF를 만들지 못했어요: ${err.message}`, { type: 'error', timeout: 10000 });
  } finally {
    btn?.classList.remove('working');
  }
}

export { noteSelectedCount };
