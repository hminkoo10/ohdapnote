// 학생 오답노트 화면: 책 고르기 → 틀린 번호 고르기 → 시험지 양식 PDF 내보내기

import { h, clear, toast, modal, confirmDialog, icon, animateOut, countUp } from './ui.js';
import { buildPdf, makeBlocks, itemName, SPACE_OPTIONS, DEFAULT_EXPORT_OPTIONS, CONVERT_MODES } from './exporter.js';
import { buildHwpx, renderStack, cropImage, blockSegs } from './hwpx.js';
import { geminiTranscribeBatch, canvasToBase64Jpeg } from './gemini.js';
import { scanTranscribe } from './scanocr.js';
import { transcribeParts } from './pdfmath.js';
import { pageLabel, computeMatches, findItem, missingNumbers, noteSelection, setNoteSelection, noteSelectedCount, selectedItems, parseQuickSelect, transcriptFiles } from './store.js';
import { api, state, nav, leaveHooks, makeSaver, getSources, renderPreview, renderQTable, geminiReady, aiOff, aiOptions, aiLabel, aiModelText, jobDialog, findJob, holdSource, restartGuard, restartSaveHooks, restartPendingChecks } from './shared.js';
import { topbar } from './chrome.js';
import { spineFor, studentSearch } from './home.js';

// 바뀐 횟수 / 저장할 때의 횟수 — 실시간으로 다시 읽을 때 고치는 중인지 보려고 (makeSaver 는 알려 주지 않음)
let dirtySeq = 0;
let savedSeq = 0;
const snapshot = (n) => JSON.parse(JSON.stringify(n));
const saver = makeSaver(async (n) => {
  if (n.$readonly) return; // 보기만 하는 오답노트는 저장하지 않음 (main 도 받지 않음)
  const seq = dirtySeq;
  const sent = snapshot(n);
  // 학생 오답노트는 학원 사람 누구나 고침: 그사이 다른 사람이 고쳤으면 main 이 ns.base(열 때 받은 것)와 견줘 합쳐서 저장
  const r = await api.saveNote(n, ns.note === n ? ns.base : null);
  if (ns.note === n) ns.base = sent; // 다음 저장은 지금 보낸 것에서 바뀐 것만
  savedSeq = seq;
  if (r?.merged && ns.note === n) {
    toast('다른 선생님이 고친 내용과 합쳐서 저장했어요.');
    noteDataChanged({ books: [], notes: [n.id] }); // 고치는 중이 아니면 합친 것을 다시 읽음
  }
});

const ns = {
  note: null,
  base: null, // 열 때(또는 지난번 저장 때) 받은 내용 — 저장할 때 다른 사람이 고친 것과 합치는 기준
  readonly: false, // 보기만 (지운 학생의 오답노트 · 원장이 보는 다른 선생님 것) — 보기와 내보내기만
  books: new Map(), // id → book (읽지 못한 책은 없음 → '지워진 책')
  sources: new Map(), // id → {problem, answer}
  matches: new Map(), // id → Map
  active: null, // 지금 보고 있는 책 id
  focus: null,
  onlySelected: false,
};

window.addEventListener('beforeunload', () => {
  if (ns.note && state.view === 'note' && !ns.note.$readonly) {
    saver.cancel();
    ns.note.updatedAt = Date.now();
    api.saveNoteSync(ns.note, ns.base);
  }
});

const markDirty = () => {
  if (ns.note?.$readonly) return; // 보기만: 내보내기 설정 등은 이 화면에서만 바뀜
  dirtySeq++;
  saver.dirty();
};

/** 읽어 온 오답노트를 화면에서 쓰는 모양으로 */
function prepareNote(note) {
  note.bookIds ||= [];
  note.selected ||= {};
  note.exportOptions = { ...DEFAULT_EXPORT_OPTIONS, ...(note.exportOptions || {}) };
  return note;
}

/** 처음 보여 줄 책: 읽은 책 먼저 */
const firstBook = (n) => n.bookIds.find((bid) => ns.books.has(bid)) || n.bookIds[0] || null;

/**
 * 책 읽기 → 바뀐 게 있으면 true. 읽지 못한 책(다른 선생님이 지움 등)은 ns.books 에서 빠져 '지워진 책'으로 보이고 문항은 빠짐.
 * 저장된 내용이 그대로인 책(원본 파일만 받은 경우 등)은 그대로 둠
 */
async function loadBooks(ids) {
  const { books, matches, sources } = ns; // 읽는 사이 다른 오답노트를 열어도 그쪽에 쓰지 않게
  let changed = false;
  for (const bid of ids) {
    let b = null;
    let m = null;
    try {
      b = await api.getBook(bid);
      b.docs ||= { problem: null, answer: null };
      m = computeMatches(b);
    } catch {
      b = null;
    }
    const old = books.get(bid);
    if (!b) {
      if (books.delete(bid)) changed = true;
      matches.delete(bid);
      continue;
    }
    if (old && old.updatedAt === b.updatedAt && old.$canEdit === b.$canEdit) continue;
    books.set(bid, b);
    matches.set(bid, m);
    sources.delete(bid); // 파일을 바꿨을 수 있음 → 볼 때 다시 엶 (같은 파일이면 열어 둔 것을 씀)
    changed = true;
  }
  return changed;
}

export async function openNote(id) {
  const note = prepareNote(await api.getNote(id));
  ns.note = note;
  ns.base = snapshot(note);
  ns.readonly = !!note.$readonly;
  ns.books = new Map();
  ns.sources = new Map();
  ns.matches = new Map();
  ns.focus = null;
  ns.onlySelected = false;
  saver.set(note);
  savedSeq = dirtySeq;
  state.view = 'note';
  leaveHooks.add(async () => {
    saver.cancel();
    await saver.flush();
    ns.note = null;
  });
  // 책 읽기 (지워진 책은 '지워진 책'으로 남기고 문항은 빼고 보여 줌)
  await loadBooks(note.bookIds);
  // 책에서 사라진 문항은 선택에서 정리 (보기만 하는 오답노트는 그대로)
  for (const [bid, b] of ns.books) {
    const ids = new Set((b.docs.problem?.items || []).map((it) => it.id));
    const sel = noteSelection(note, bid);
    const kept = sel.filter((x) => ids.has(x));
    if (kept.length !== sel.length && !ns.readonly) {
      setNoteSelection(note, bid, kept);
      markDirty();
      toast(`${b.name}: 책에서 바뀌거나 지워진 문항 ${sel.length - kept.length}개를 선택에서 뺐어요.`, { timeout: 6000 });
    }
  }
  ns.active = note.bookIds.includes(ns.active) ? ns.active : firstBook(note);
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
  const ro = ns.readonly; // 보기만: 제목·학생 이름도 그대로
  const titleInput = h('input.title-input', {
    value: n.title,
    title: '오답노트 제목',
    readOnly: ro,
    onchange: (e) => {
      n.title = e.target.value.trim() || n.title;
      markDirty();
      syncExamFields();
    },
  });
  // 누구의 오답노트인지: 누르면 학생 바꾸기 (명단의 학생이면 그 학생 오답노트로 옮겨짐)
  const studentChip = h(
    'button.student-chip',
    { title: ro ? '학생' : '학생 바꾸기', disabled: ro, onclick: changeStudent },
    icon('user'),
    h('span.student-name', studentLabel(n)),
  );
  const why = n.$why === 'deleted' ? '지운 학생의 오답노트예요 · 학생을 되살리면 다시 고칠 수 있어요. 지금은 보기와 내보내기만 할 수 있어요' : `${n.$ownerName || '다른'} 선생님의 오답노트 · 보기와 내보내기만 할 수 있어요`;
  root.append(
    topbar(
      h(
        'div.topbar-crumb',
        h('button.btn.btn-ghost.btn-round#back-btn', { onclick: () => nav.home({ tab: 'notes' }), title: '오답노트 목록으로' }, icon('back')),
        h('span.crumb-kind', icon('notebook'), '오답노트'),
        h('span.crumb-sep', '/'),
        titleInput,
        studentChip,
        ro ? null : h('span.save-status', ''),
      ),
    ),
    h(
      `main.sheet.note-sheet${enter ? '.view-enter' : ''}`,
      ro ? h('div.readonly-banner', icon('eye'), h('span', why)) : null,
      bookBar(),
      h('section.note-body', noteBody()),
    ),
  );
}

/** 위쪽 학생 칩: 명단의 학생이면 명단 이름, 아니면 적어 둔 이름 (시험지 머리의 학생 이름은 따로 고칠 수 있음) */
const studentLabel = (n) => n.$studentName || n.student || '학생 미지정';

/** 학생 바꾸기: 명단의 학생을 고르면 그 학생 오답노트가 됨 (저장할 때 그 학생 폴더로 옮겨짐), 명단에 없는 이름은 학생 미지정 */
async function changeStudent() {
  const n = ns.note;
  if (!n || ns.readonly) return;
  const students = (await api.listStudents().catch(() => [])).filter((st) => !st.deletedAt);
  const cur = students.find((st) => st.id === n.studentId) || null;
  const search = studentSearch(students, { picked: cur });
  if (!cur) search.input.value = n.student || '';
  const shared = state.appInfo.roster === 'cloud';
  const r = await modal({
    title: '학생 바꾸기',
    body: h(
      'div.form',
      search.field,
      shared ? h('p.small.muted', '명단의 학생을 고르면 그 학생의 오답노트가 돼요. 학원 사람 누구나 이어서 고칠 수 있어요. 명단에 없는 이름을 적으면 학생 미지정 오답노트가 되고 나만 고칠 수 있어요.') : null,
    ),
    width: 460,
    onClose: () => search.close(),
    buttons: [
      { label: '취소', value: null },
      { label: '바꾸기', primary: true, onClick: () => ({ st: search.picked(), name: search.input.value.trim() }) },
    ],
  });
  if (!r || ns.note !== n) return;
  const nextId = r.st?.id || '';
  const nextName = r.st ? r.st.name : r.name;
  if (nextId === (n.studentId || '') && nextName === (n.student || '')) return;
  if (shared && n.$shared && !r.st && !(await confirmDialog('학생 미지정으로 바꾸면 이 오답노트는 내 폴더로 옮겨져서 다른 선생님은 볼 수 없어요. 바꿀까요?', { title: '학생 미지정', ok: '바꾸기' }))) return;
  n.studentId = nextId;
  n.student = nextName;
  if (r.st) n.$studentName = r.st.name;
  else delete n.$studentName;
  n.$shared = shared && !!r.st;
  markDirty();
  syncExamFields();
  const t = document.querySelector('.topbar .student-name');
  if (t) t.textContent = studentLabel(n);
}

/** 이 노트에 쓰는 책들 (알약 모양) + 책 추가 */
function bookBar() {
  const n = ns.note;
  const bar = h('section.book-bar');
  n.bookIds.forEach((bid, i) => {
    // 읽지 못한 책(지워졌거나 다른 선생님의 나만 보기)은 '볼 수 없는 교재'로 — 고른 문항은 보이지 않고 내보내기에서도 빠짐
    const b = ns.books.get(bid);
    const cnt = b ? noteSelection(n, bid).length : 0;
    bar.append(
      h(
        `button.book-tab${ns.active === bid ? '.active' : ''}`,
        { style: { '--spine': spineFor(bid), '--i': i }, onclick: () => switchBook(bid), dataset: { book: bid }, title: b ? null : '지워졌거나 다른 선생님의 나만 보기 교재예요' },
        h('span.bt-spine'),
        h('span.bt-name', b ? b.name : '볼 수 없는 교재'),
        h('span.bt-count', cnt ? String(cnt) : ''),
        ns.readonly ? null : h('span.bt-x', { title: '이 오답노트에서 책 빼기', onclick: (e) => { e.stopPropagation(); removeBook(bid); } }, icon('x')),
      ),
    );
  });
  if (!ns.readonly) bar.append(h('button.btn.btn-small.btn-ghost.add-book', { onclick: addBook }, icon('plus'), '책 추가'));
  bar.append(h('span.spacer'), h('button.btn.btn-small.btn-ghost', { onclick: () => ns.books.has(ns.active) && nav.book(ns.active), disabled: !ns.active, title: '이 책의 인식 결과를 고치러 책 화면으로' }, icon('edit'), '책 인식 고치기'));
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
  // 고르는 사이 지워진 책은 넣지 않음
  await loadBooks(r);
  const added = r.filter((bid) => ns.books.has(bid) && !n.bookIds.includes(bid));
  if (added.length < r.length) toast('지워졌거나 열 수 없는 책은 넣지 못했어요.', { type: 'error' });
  if (!added.length) return;
  for (const bid of added) {
    n.bookIds.push(bid);
    noteSelection(n, bid);
  }
  ns.active = added[0];
  markDirty();
  render();
  await loadActiveSources();
}

async function removeBook(bid) {
  const n = ns.note;
  const b = ns.books.get(bid);
  const cnt = noteSelection(n, bid).length;
  if (cnt && !(await confirmDialog(`"${b?.name || '볼 수 없는 교재'}"에서 고른 ${cnt}문항이 이 오답노트에서 빠져요. 계속할까요?`, { ok: '빼기', danger: true }))) return;
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
  const ro = ns.readonly; // 보기만: 문항 고르기·빼기 없음 (누르면 미리보기만)
  if (!b) {
    if (ns.active) {
      // 읽지 못한 책: 지워졌거나 다른 선생님의 나만 보기 교재 (학생 오답노트는 학원 사람 누구나 열어서)
      left.append(
        h(
          'div.empty-state',
          h('div.empty-art', icon('eye')),
          h('h3', '볼 수 없는 교재예요'),
          h('p.muted', '책장에서 지워졌거나 다른 선생님의 나만 보기 교재라서, 이 책에서 고른 문항은 보이지 않고 내보내기에서도 빠져요.'),
          ro ? null : h('button.btn', { onclick: () => removeBook(ns.active) }, icon('x'), '이 오답노트에서 빼기'),
        ),
      );
    } else if (ro) left.append(h('div.empty-state', h('div.empty-art', icon('library')), h('h3', '아직 책이 없어요')));
    else left.append(h('div.empty-state', h('div.empty-art', icon('library')), h('h3', '책을 추가해 주세요'), h('p.muted', '위의 [책 추가]를 눌러 책장에 등록한 책을 고르세요.')));
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
      ro ? null : h('div.search', icon('search'), quick),
      ro ? null : h('button.btn', { onclick: applyQuick }, '고르기'),
      h('label.switch.small', h('input', { type: 'checkbox', checked: ns.onlySelected, onchange: (e) => { ns.onlySelected = e.target.checked; drawTable(); } }), h('span.sw'), '고른 것만'),
      ro ? null : h('button.btn.btn-ghost.btn-small', { onclick: async () => { if (noteSelection(n, b.id).length && (await confirmDialog(`${b.name}에서 고른 문항을 모두 해제할까요?`))) { setNoteSelection(n, b.id, []); markDirty(); refresh(); } } }, '모두 해제'),
    ),
    h(
      'div.legend.small',
      h('span', h('span.chip.demo.on', '3'), '고른 문제'),
      h('span', h('span.chip.demo.noans', '3'), '해설 짝 없음'),
      h('span', h('span.chip.demo.missing', '4', h('span.chip-q', '?')), '인식 못한 번호'),
      ro ? null : h('span', '쪽 번호를 누르면 그 쪽 전체 선택'),
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
      onChip: ro ? (it) => schedulePreview(it) : (it, page, items) => toggleOne(it, page, items),
      onHover: (it) => schedulePreview(it),
      onPage: ro ? null : (page, items, el) => togglePage(page, items, el),
      onMissing: async (page, m) => {
        // 남이 만든 책은 그 책 화면에서도 고칠 수 없음
        if (b.$canEdit === false) {
          toast(`${pageLabel(doc, page)}에서 ${m.prefix ? `${m.prefix} ` : ''}${m.num}번을 찾지 못했어요. 이 책은 만든 사람과 원장만 고칠 수 있어요.`, { timeout: 6000 });
          return;
        }
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
    const cnt = ns.books.has(el.dataset.book) ? noteSelection(n, el.dataset.book).length : 0; // 지워진 책은 세지 않음
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
    onToggleSelect: ns.readonly ? null : (it) => {
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
      options.map(([value, label, tip]) => h('label', { title: tip }, h('input', { type: 'radio', name, value, checked: String(current) === String(value), onchange: () => onChange(value) }), h('span', label))),
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
        readOnly: ns.readonly, // 보기만: 시험지 머리는 저장된 그대로
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
            const t = document.querySelector('.topbar .student-name');
            if (t) t.textContent = studentLabel(n);
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
      // 한글(HWPX)일 때만: 스캔본을 글자·수식으로 옮기는 방법
      h(
        'div.opt-row.convert-row',
        { hidden: o.format !== 'hwpx' },
        h('span.opt-label', '스캔본'),
        seg('convert', CONVERT_MODES[o.convert] ? o.convert : 'mix', Object.entries(CONVERT_MODES).map(([k, v]) => [k, v.label, v.hint]), (v) => {
          set('convert', v);
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
  refreshOcrInstalled();
  return el;
}

/** 수식 인식 모델을 받아 두었는지 (안내 문구용 · 모르면 null) — 설정에서 받으면 다시 확인 */
let ocrInstalled = null;
document.addEventListener('mathocr:changed', () => renderFormatHint());
function refreshOcrInstalled() {
  Promise.resolve(api.mathocrStatus?.())
    .then((s) => {
      if (ocrInstalled === !!s?.installed) return;
      ocrInstalled = !!s?.installed;
      renderFormatHint();
    })
    .catch(() => {});
}

function setFormatHint(el) {
  const o = ns.note?.exportOptions;
  el.hidden = o?.format !== 'hwpx';
  const mode = CONVERT_MODES[o?.convert] ? o.convert : 'mix';
  const ai = geminiReady();
  const noAi = aiOff() ? '설정에서 AI 가 꺼져 있어' : 'AI 를 설정하지 않아';
  const noModel = ocrInstalled === false;
  const now =
    mode === 'ai'
      ? ai
        ? ` (${aiLabel()})`
        : ` — 지금은 ${noAi} 그림으로 들어가요`
      : mode === 'ocr'
        ? noModel
          ? '. 지금은 모델이 없어 그림으로 들어가요 (설정에서 받기)'
          : ''
        : noModel && !ai
          ? ` — 지금은 수식 인식 모델이 없고 ${noAi} 그림으로 들어가요`
          : noModel
            ? ` — 수식 인식 모델이 없어 지금은 모두 AI(${aiLabel()})로`
            : !ai
              ? ` — ${noAi} 지금은 이 컴퓨터에서만`
              : '';
  el.textContent = `디지털 PDF(EBS 교재 등)는 PDF 글자 그대로 옮겨요. 스캔본은 ${CONVERT_MODES[mode].hint}${now}.`;
}

/** 내보내기 안내 다시 쓰기 (설정에서 AI·수식 인식 모델이 바뀌었을 때도) */
export function renderFormatHint() {
  const el = document.querySelector('.export-hint');
  if (!el) return;
  setFormatHint(el);
  const row = document.querySelector('.convert-row');
  if (row) row.hidden = ns.note?.exportOptions.format !== 'hwpx';
  refreshOcrInstalled();
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
          ns.readonly ? null : h(
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

function doExport(mode) {
  return restartGuard.track('export', () => buildExport(mode));
}

const pendingExports = new Map();
restartPendingChecks.add(() => pendingExports.size > 0);

async function buildExport(mode) {
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
  const label = (role, it, e) => pageLabel(e.bookObj.docs[role], it.page);
  const blocks = makeBlocks(mode, entries, opts, label);
  const modeName = { problems: '문제지', answers: '해설지', 'both-inline': '문제+해설', 'both-end': '문제+해설(해설 뒤)' }[mode];
  const info = examInfo();
  // 이 오답노트의 한글 문서를 뒤에서 만드는 중: 내용이 같으면 그 창을 보여 주고,
  // 멈추는 중이거나 그 사이 오답노트를 고쳤으면 그것을 멈추고 고친 내용으로 새로 만듦
  const sig = exportSig(mode, blocks, opts, info);
  const old = opts.format === 'hwpx' && findJob(jobKey);
  if (old) {
    if (!old.cancelled && old.sig === sig) {
      old.open();
      return;
    }
    if (!old.cancelled) toast('오답노트가 바뀌어서 만들던 한글 문서를 멈추고 고친 내용으로 다시 만들어요.');
    old.cancel();
    await old.finished;
  }
  const sub = { problems: `문제 ${entries.length}문항`, answers: `해설 ${entries.length}문항`, 'both-inline': `문제·해설 ${entries.length}문항`, 'both-end': `문제 ${entries.length}문항 · 정답 및 해설` }[mode];
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const btn = document.querySelector(`.export-btn[data-mode="${mode}"]`);
  const hwpx = opts.format === 'hwpx';
  const kindName = hwpx ? '한글 문서' : 'PDF';
  const run = String(++exportRuns);
  if (btn) btn.dataset.run = run;
  btn?.classList.add('working');
  const closeToast = toast(`${modeName} ${kindName} 만드는 중…`, { timeout: 0 });
  const pendingKey = `${n.id}:${mode}`;
  exporting.set(n.id, (exporting.get(n.id) || 0) + 1);
  try {
    const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    const fname = [safe(info.student), safe(info.title), modeName, ymd].filter(Boolean).join('_');
    let res;
    let note = '';
    const saved = (r) => {
      if (r.canceled) return;
      if (pendingExports.get(pendingKey) === run) pendingExports.delete(pendingKey);
      restartGuard.report();
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
      const bytes = await exportHwpx(blocks, entries, opts, { ...info, subtitle: sub }, { key: jobKey, sig });
      closeToast();
      if (bytes.stats?.picture && bytes.stats?.text) note = ` (그림으로 넣은 문항 ${bytes.stats.picture}개)`;
      const save = () => api.saveFile({ defaultName: `${fname}.hwpx`, data: bytes, filters: [{ name: '한글 문서', extensions: ['hwpx'] }], title: '한글 문서 저장' });
      // 옮기기를 뒤로 보내 둔 채 끝났으면 저장 창을 바로 띄우지 않고 알림의 [저장하기]로 (다른 화면을 보고 있을 수 있음)
      if (bytes.job?.finish({ message: `${info.student ? `${info.student} · ` : ''}${modeName} 한글 문서가 준비됐어요`, actions: [{ label: '저장하기', onClick: async () => saved(await save()) }] })) {
        pendingExports.set(pendingKey, run);
        return;
      }
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
    if (btn?.dataset.run === run) btn.classList.remove('working'); // 멈춘 앞 작업이 새로 시작한 작업의 표시를 지우지 않게
    exportDone(n.id);
  }
}

let exportRuns = 0;

// ===========================================================================
// 실시간: 다른 컴퓨터·선생님이 바꾼 데이터 (app.js 가 오답노트 화면에서 부름)
// ===========================================================================
const exporting = new Map(); // 오답노트 id → 내보내는 중인 수 (그동안은 다시 읽지 않고 끝난 뒤에)
let deferred = null; // 내보내는 동안 들어온 변경 {id, books, notes}
let changeQueue = Promise.resolve();

function exportDone(id) {
  const left = (exporting.get(id) || 1) - 1;
  if (left > 0) {
    exporting.set(id, left);
    return;
  }
  exporting.delete(id);
  if (deferred?.id !== id) return;
  const change = deferred;
  deferred = null;
  noteDataChanged(change);
}

/** 다시 읽은 것으로 바꿔 끼움 (같은 오답노트 객체를 붙잡고 있는 저장·화면 처리가 그대로 쓰게) */
function replaceInPlace(target, fresh) {
  for (const k of Object.keys(target)) if (!(k in fresh)) delete target[k];
  return Object.assign(target, fresh);
}

/** change: {books: [책 id], notes: [오답노트 id | '*'], students, settings} */
export function noteDataChanged(change) {
  changeQueue = changeQueue.then(() => applyChange(change)).catch((err) => console.error(err));
  return changeQueue;
}

async function applyChange(change) {
  const n = ns.note;
  if (!n || state.view !== 'note' || !change) return;
  const hit = (list, id) => Array.isArray(list) && (list.includes(id) || list.includes('*'));
  const bookIds = n.bookIds.filter((bid) => hit(change.books, bid));
  const noteHit = hit(change.notes, n.id);
  if (!bookIds.length && !noteHit) return;
  if (exporting.get(n.id)) {
    const merge = (a, b) => [...new Set([...(a || []), ...(b || [])])];
    const prev = deferred?.id === n.id ? deferred : {};
    deferred = { id: n.id, books: merge(prev.books, change.books), notes: merge(prev.notes, change.notes) };
    return;
  }
  // 책: 저장된 내용이 바뀐 것만 다시 읽음 (지워졌으면 '지워진 책')
  let changed = await loadBooks(bookIds);
  if (ns.note !== n) return;
  // 오답노트: 고치는 중이 아니면(보기만이면 늘) 다시 읽음. 책이 바뀌었을 때도 — 책에서 바뀐 문항 ID 는 오답노트를 읽을 때 따라 바뀜
  const canReload = () => ns.readonly || dirtySeq === savedSeq;
  if (canReload()) {
    let fresh = null;
    try {
      fresh = prepareNote(await api.getNote(n.id));
    } catch {
      if (ns.note === n && noteHit) {
        // 지워진 오답노트: 나가면서 저장해 되살리지 않게
        saver.set(null);
        toast('다른 곳에서 이 오답노트를 지웠어요');
        nav.home({ tab: 'notes' });
        return;
      }
    }
    if (ns.note !== n) return;
    if (fresh && ns.readonly) fresh.exportOptions = n.exportOptions; // 보기만: 이 화면에서 고른 내보내기 설정은 그대로
    if (fresh && canReload() && JSON.stringify(fresh) !== JSON.stringify(n)) {
      replaceInPlace(n, fresh);
      ns.base = snapshot(n);
      ns.readonly = !!n.$readonly;
      await loadBooks(n.bookIds.filter((bid) => !ns.books.has(bid)));
      if (ns.note !== n) return;
      if (!n.bookIds.includes(ns.active)) ns.active = firstBook(n);
      changed = true;
    }
  }
  if (!changed) return;
  render();
  await loadActiveSources();
}

/** 한글 문서 내용이 같은지 견주는 열쇠 (문항·영역·지문·번호·출처 + 내보내기 설정·시험지 머리) */
function exportSig(mode, blocks, opts, info) {
  return JSON.stringify({ mode, opts, info, blocks: blocks.map((b) => [b.kind, b.item?.id, b.item?.rects, b.stem, b.num, b.source, b.text]) });
}

// ===========================================================================
// 한글 문서(HWPX): 문항을 글자·수식으로 옮겨 넣음 — 디지털 PDF 는 PDF 글자로, 스캔본은 OCR·AI 로 (못 옮긴 문항은 그림으로)
// ===========================================================================
const TRANSCRIBE_WIDTH = 1500; // AI·OCR 에 넘기는 그림 폭(px)
const MAX_TRANSCRIPTS = 3000; // 책 하나에 저장해 두는 개수
const transcripts = new Map(); // 책 id → {items: {열쇠: {blocks, model, at}}, dirty}  (책 폴더의 transcripts.json)
restartPendingChecks.add(() => [...transcripts.values()].some((t) => t.dirty));
restartSaveHooks.add(saveTranscripts);

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

/** 같은 문항·같은 영역·같은 원본 파일이면 같은 열쇠 (나중에 더한 파일은 넣지 않음 — 더해도 지금 결과를 그대로 씀) */
function transcriptKey(block) {
  const raw = JSON.stringify({ files: transcriptFiles(block.src?.files), rects: block.item.rects, stem: block.stem || null });
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
 * 0) 디지털 PDF 문항은 PDF 글자로 바로 옮김 (어느 방식이든)
 * 1) 스캔본 문항은 내보내기 설정 convert 에 따라
 *    - 'ai'  : AI 로 (문항 여러 개를 한 요청에 묶고(설정 aiBatch), 요청 여러 개를 동시에(aiConcurrency))
 *    - 'ocr' : 이 컴퓨터의 OCR + 수식 인식으로만 (AI 는 부르지 않음)
 *    - 'mix' : 먼저 OCR 로, 결과가 미덥지 않은 문항만 AI 로 (AI 가 실패하면 OCR 결과를 씀)
 *    옮긴 결과는 책마다 저장 (AI 는 transcriptKey, OCR 은 transcriptKey + '|local')
 * 2) buildHwpx 는 문항마다 transcribe 를 부르는데, 미리 옮겨 둔 결과를 그대로 씀
 */
async function exportHwpx(blocks, entries, opts, info, job) {
  const bookOf = new Map(); // 원본(DocSource) → 책 id
  for (const e of entries) for (const src of [e.src?.problem, e.src?.answer]) if (src) bookOf.set(src, e.bookId);
  // buildHwpx 가 글자로 옮기려는 문항 (그릴 영역이 있는 문제·해설)
  const work = blocks.filter((b) => (b.kind === 'problem' || b.kind === 'answer') && b.item && bookOf.has(b.src) && blockSegs(b).length);
  const fromPdf = new Map(); // 문항 → PDF 글자로 옮긴 결과
  for (const b of work) {
    const list = await pdfTranscribe(blockSegs(b));
    if (list) fromPdf.set(b, list);
  }
  const scanned = work.filter((b) => !fromPdf.has(b));
  const mode = CONVERT_MODES[opts.convert] ? opts.convert : 'mix';
  let ocrReady = false;
  if (scanned.length && mode !== 'ai') {
    try {
      ocrReady = !!(await api.mathocrStatus())?.installed;
    } catch (err) {
      console.warn('수식 인식 모델 상태를 알지 못함', err);
    }
  }
  const useAi = scanned.length > 0 && mode !== 'ocr' && geminiReady();
  const useOcr = scanned.length > 0 && mode !== 'ai' && ocrReady;
  if (scanned.length && !useAi && !useOcr) noConvertToast(mode, scanned.length);
  const { batch: batchSize, ...ai } = aiOptions();
  const abort = new AbortController();
  const storeOf = (block) => transcripts.get(bookOf.get(block.src));
  const aiKey = (b) => transcriptKey(b);
  const ocrKey = (b) => `${transcriptKey(b)}|local`;
  const aiResult = (b) => (useAi ? storeOf(b)?.items[aiKey(b)] : null);
  const ocrResult = (b) => (useOcr ? storeOf(b)?.items[ocrKey(b)] : null);
  const has = (r) => !!r?.blocks?.length;
  /** 쓸 결과: AI 결과가 있으면 그것, 없으면 OCR 결과 */
  const resultOf = (b) => (has(aiResult(b)) ? aiResult(b) : has(ocrResult(b)) ? ocrResult(b) : null);
  /** AI 에게 보낼 문항인지 ('섞어서'는 OCR 결과가 없거나 미덥지 않을 때만) */
  const needsAi = (b) => useAi && !has(aiResult(b)) && !(has(ocrResult(b)) && ocrResult(b).reliable);
  let quota = false; // 한도가 차면 나머지는 묻지 않음 (OCR 결과가 있으면 그것, 없으면 그림)
  let ui = null;
  const releases = [];
  const settled = new Set();
  const settle = (b, stateName, msg, path) => {
    ui.row(b).set(stateName, msg, path);
    settled.add(b);
    ui.progress(settled.size, work.length);
  };
  /** AI 가 못 옮긴 문항: OCR 결과가 있으면 그것으로, 없으면 그림으로 */
  const aiFailed = (b, why) => {
    if (has(ocrResult(b))) settle(b, 'ok', `${why} → OCR 결과로`, 'OCR');
    else settle(b, why === '읽은 내용이 없음' || why === '한도 초과' ? 'empty' : 'err', `${why} → 그림으로`, 'AI');
  };

  /** 이 컴퓨터에서 옮기기 (문항 둘을 겹쳐서: 하나가 수식을 인식하는 동안 다음 문항의 글자를 읽음) */
  const runOcr = async (pending) => {
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        if (abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
        const b = pending[next++];
        const row = ui.row(b);
        row.set('run', '글자 읽는 중…', 'OCR');
        try {
          const canvas = await renderStack(blockSegs(b), TRANSCRIBE_WIDTH);
          const r = await scanTranscribe(canvas, { number: b.item.number, signal: abort.signal, api, onStatus: (msg) => row.set('run', msg, 'OCR') });
          if (abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
          if (!r.blocks.length) {
            if (useAi) row.set('wait', '읽은 내용이 없음 → AI 에게', 'OCR');
            else settle(b, 'empty', '읽은 내용이 없음 → 그림으로', 'OCR');
            continue;
          }
          const store = storeOf(b);
          store.items[ocrKey(b)] = { blocks: r.blocks, model: 'ocr', reliable: r.reliable, reasons: r.reasons, at: Date.now() };
          store.dirty = true;
          const what = `글자·수식으로 옮김${r.formulas ? ` (수식 ${r.formulas}개)` : ''}`;
          if (r.reliable) settle(b, 'ok', what, 'OCR');
          else if (useAi) row.set('wait', `미덥지 않음 (${r.reasons[0]}) → AI 에게`, 'OCR');
          else settle(b, 'ok', `${what} · 확인 필요 (${r.reasons[0]})`, 'OCR');
        } catch (err) {
          if (err?.name === 'AbortError' || abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
          console.warn('OCR 로 옮기지 못함', err);
          if (useAi) row.set('wait', `${err.message} → AI 에게`, 'OCR');
          else settle(b, 'err', `${err.message} → 그림으로`, 'OCR');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, pending.length) }, worker));
  };

  /** AI 로 옮기기: 묶음으로 동시에 (같은 열쇠의 문항은 한 번만) */
  const runAi = async (pending) => {
    const groups = new Map(); // 열쇠 → 블록들
    for (const b of pending) {
      const key = aiKey(b);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    // 문제와 해설은 지시문이 달라서 따로 묶음
    const batches = [];
    for (const role of ['problem', 'answer']) {
      const keys = [...groups.keys()].filter((k) => groups.get(k)[0].role === role);
      for (let i = 0; i < keys.length; i += batchSize) batches.push({ role, keys: keys.slice(i, i + batchSize) });
    }
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        if (abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
        const { role, keys } = batches[next++];
        if (quota) {
          for (const k of keys) for (const b of groups.get(k)) aiFailed(b, '한도 초과');
          continue;
        }
        for (const k of keys) for (const b of groups.get(k)) ui.row(b).set('run', '옮기는 중…', 'AI');
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
        if (abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
        keys.forEach((k, i) => {
          const r = results[i];
          if (r instanceof Error) {
            if (/한도/.test(r.message)) {
              quota = true;
              ui.status(r.message);
            }
            for (const b of groups.get(k)) aiFailed(b, r.message);
          } else if (!r.length) {
            for (const b of groups.get(k)) aiFailed(b, '읽은 내용이 없음');
          } else {
            const store = storeOf(groups.get(k)[0]);
            store.items[k] = { blocks: [...r], model: r.model, at: Date.now() };
            store.dirty = true;
            for (const b of groups.get(k)) settle(b, 'ok', `글자·수식으로 옮김 · ${r.model || '기본 모델'}`, 'AI');
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
    const r = (useAi || useOcr) && storeOf(block) ? resultOf(block) : null;
    return r ? finish(r.blocks) : null;
  };

  try {
    if (useAi || useOcr) {
      for (const bid of new Set(scanned.map((b) => bookOf.get(b.src)))) await loadTranscripts(bid);
      const pendingOcr = useOcr ? scanned.filter((b) => !has(aiResult(b)) && !has(ocrResult(b))) : [];
      const pendingAi = scanned.filter((b) => !pendingOcr.includes(b) && needsAi(b));
      if (pendingOcr.length || pendingAi.length) {
        ui = transcribeDialog(work, { ocr: pendingOcr.length, ai: pendingAi.length, useAi, useOcr }, abort, {
          ...job,
          jobTitle: `${info.student ? `${info.student} · ` : ''}한글 문서 (문항 ${work.length}개)`,
        });
        // 뒤에서 도는 동안 다른 책을 열어도 이 원본들은 닫히지 않게
        for (const e of entries) for (const role of ['problem', 'answer']) releases.push(holdSource(e.bookObj, role));
        for (const b of work) {
          if (fromPdf.has(b)) settle(b, 'ok', 'PDF 글자로 옮김', 'PDF');
          else if (!pendingOcr.includes(b) && !pendingAi.includes(b)) {
            const r = resultOf(b);
            if (r) settle(b, 'ok', '저장해 둔 결과', r === aiResult(b) ? 'AI' : 'OCR');
            else settle(b, 'empty', '그림으로', '');
          }
        }
        ui.progress(settled.size, work.length);
        await runOcr(pendingOcr);
        // OCR 결과가 미덥지 않은 문항(과 OCR 이 못 읽은 문항)만 AI 로
        const toAi = scanned.filter((b) => !settled.has(b) && needsAi(b));
        if (toAi.length) await runAi(toAi);
        for (const b of scanned) if (!settled.has(b)) settle(b, 'empty', '그림으로', '');
        ui.status('한글 문서를 만드는 중…');
      }
    }
    const bytes = await buildHwpx({ blocks, options: opts, title: info.title, info, transcribe: useAi || useOcr || fromPdf.size ? transcribe : null });
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

/** 스캔본 문항을 글자로 옮길 수 없어 그림으로 넣을 때 알림 (설정 열기) */
function noConvertToast(mode, n) {
  const why =
    mode === 'ocr'
      ? '수식 인식 모델을 받지 않아서'
      : mode === 'ai'
        ? aiOff()
          ? '설정에서 AI 가 꺼져 있어서'
          : 'AI 를 설정하지 않아서'
        : 'AI 도 수식 인식 모델도 쓸 수 없어서';
  toast(`${why} 스캔본 문항 ${n}개는 그림으로 넣어요.`, { timeout: 8000, actions: [{ label: '설정 열기', onClick: () => nav.settings() }] });
}

/**
 * 옮기는 동안 보이는 창 (문항별 상태 · 어떤 방법으로 옮겼는지(PDF/OCR/AI), 진행 막대).
 * [취소]하면 바로 요청·인식을 끊고, [백그라운드에서 계속]이면 창만 닫고 계속
 */
function transcribeDialog(work, { ocr, ai: aiCount, useAi, useOcr }, abort, { key, sig, jobTitle }) {
  const rows = new Map();
  const list = h(
    'div.gem-list',
    work.map((b) => {
      const row = h(
        'div.gem-row',
        { dataset: { state: 'wait' } },
        h('span.gem-dot'),
        h('strong', `${b.kind === 'answer' ? '해설' : '문제'} ${itemName(b.item)}`),
        h('span.gem-path'),
        h('span.gem-msg.muted', '기다리는 중'),
      );
      rows.set(b, row);
      return row;
    }),
  );
  const how = useOcr && useAi ? `먼저 이 컴퓨터에서 OCR·수식 인식으로 옮기고, 결과가 미덥지 않은 문항만 AI(${aiLabel()})에게 보내요.` : useOcr ? '이 컴퓨터에서 OCR·수식 인식으로 옮겨요 (AI 를 쓰지 않아요). 한 문항에 몇 초~수십 초 걸려요.' : `AI(${aiLabel()})에게 보내요. 여러 문항을 한 요청에 묶어 동시에 보내요.`;
  const status = h('div.small.muted.gem-status', useAi ? `모델: ${aiModelText()}` : '수식 인식: 이 컴퓨터 (Pix2Text)');
  const bar = h('div.progress-bar');
  const jd = jobDialog({
    key,
    sig,
    abort,
    jobTitle,
    total: work.length,
    title: `문항 ${work.length}개를 글자·수식으로`,
    body: h(
      'div.gem-run',
      h('p.small.muted', `새로 옮길 문항 ${ocr + aiCount}개 — ${how} 옮기지 못한 문항은 그림으로 넣어요. 옮긴 결과는 저장해 두어 다음에는 다시 하지 않아요.`),
      h('div.progress', bar),
      status,
      list,
    ),
    width: 480,
    className: 'gem-modal',
  });
  return {
    /** path: 'PDF' | 'OCR' | 'AI' — 이 문항을 어떤 방법으로 옮겼는지 */
    row: (block) => ({
      set(stateName, msg, path) {
        const row = rows.get(block);
        if (!row) return;
        row.dataset.state = stateName;
        row.querySelector('.gem-msg').textContent = msg;
        if (path != null) {
          const tag = row.querySelector('.gem-path');
          tag.textContent = path;
          tag.dataset.path = path;
        }
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
