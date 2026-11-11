import { examImportButton } from './mockexam-view.js';
// 문제은행 탭: 교재 넣기 → 찾기·미리보기 → 시험지 바구니
import { h, clear, icon, toast, modal, debounce } from './ui.js';
import { api, state, nav, getSources, holdSource, itemImage, findJob, jobListeners, restartGuard, restartPendingChecks } from './shared.js';
import { SUBJECTS, subjectName, contractedSubjects, subjectOpen } from './subjects.js';
import { pageLabel } from './store.js';
import { buildPdf, itemName, SPACE_OPTIONS, DEFAULT_EXPORT_OPTIONS, CONVERT_MODES } from './exporter.js';
import { bankEntries, filterBank, librarySelected, orderPicked, makeBankBlocks, bankTargets, passageItem, blocksToText, choiceMark } from './bank.js';
import { loadTranscripts, bestTranscript, setEditedTranscript, clearEditedTranscript, exportHwpx } from './transcribe.js';
import { putBank } from './bank-transcribe.js';
import { answerEditorButton, showAnswerPreview } from './answer-editor.js';
import { attachAnswers } from './answers.js';
import { answerContent } from './answer-model.js';
import { blockSegs, renderStack } from './hwpx.js';
import { TRANSCRIBE_WIDTH } from './transcribe.js';
import { REVIEW_HELP, reviewPanel } from './review-ui.js';
import { countLow } from './lowconf.js';

const readLocal = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const writeLocal = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 공간이 없어도 현재 화면은 그대로 사용 */ }
};
const saved = readLocal('ohdap.bankBasket', {});
const bs = {
  filters: { subject: '', bookId: '', page: '', number: '', text: '', review: false },
  picked: Array.isArray(saved?.picked) ? saved.picked.filter((p) => p?.bookId && p?.itemId) : [],
  opts: { ...DEFAULT_EXPORT_OPTIONS, ...(saved?.options || {}), convert: CONVERT_MODES[saved?.options?.convert] ? saved.options.convert : 'ocr' },
  info: saved?.info || {}, focus: null, limit: 200, scroll: 0, previewScroll: 0, homeScroll: 0,
  intro: !readLocal('ohdap.bankIntro', false), intake: true, typing: null,
};
const cache = new Map(); // 책 id → updatedAt가 같은 전체 교재 (원본 PDF는 미리보기·작업 때만 엶)
let active = null;
let refresh = () => {};
let refreshJobs = () => {};
jobListeners.add(() => { if (active?.isConnected) refreshJobs(); });
const persist = () => writeLocal('ohdap.bankBasket', { picked: bs.picked, options: bs.opts, info: bs.info });
const keyOf = (e) => JSON.stringify([e.bookId, e.item.id]);
const pickedKey = (p) => JSON.stringify([p.bookId, p.itemId]);
const open = (e) => e.open && subjectOpen(e.bookObj, state.appInfo);
const fail = (err) => toast(err.message || String(err), { type: 'error', timeout: 10000 });
const attempt = (fn) => Promise.resolve().then(fn).catch(fail);
const changed = () => { if (active?.isConnected) refresh(); };
const pathName = { edit: '고침', ai: '정밀 인식', ocr: '스캔 인식', pdf: 'PDF' };
// 검색용 열쇠만 만들 때는 파일 이름만 필요. 실제 그림·옮기기·내보내기의 src는 항상 getSources의 원본
const lookupBlock = (e, item = e.item) => ({ kind: 'problem', role: 'problem', item, stem: null, src: { files: e.bookObj.docs.problem.files } });
const result = (e, item = e.item) => bestTranscript(e.bookId, lookupBlock(e, item));
const textOf = (e) => [blocksToText(result(e)?.entry.blocks), e.stemKey ? blocksToText(result(e, passageItem(e.item))?.entry.blocks) : ''].join(' ');
const reviewCount = (e) => countLow(result(e)?.entry.blocks) + (e.stemKey ? countLow(result(e, passageItem(e.item))?.entry.blocks) : 0);

export function openBankReview(bookId) {
  bs.filters = { subject: '', bookId, page: '', number: '', text: '', review: true };
  bs.limit = 200; bs.scroll = 0; bs.intake = false;
  nav.home({ tab: 'bank' });
}

/** 첫 화면을 실시간으로 다시 그리기 직전, 입력 위치·스크롤을 기억 */
export function rememberBankView() {
  if (!active?.isConnected) return;
  bs.homeScroll = active.closest('main')?.scrollTop || 0;
  const input = document.activeElement;
  bs.typing = input?.dataset.bankFocus ? { key: input.dataset.bankFocus, start: input.selectionStart, end: input.selectionEnd } : null;
}

export function bankView(summaries) {
  const root = h('div.bank-view', h('p.empty-hint', '문제은행을 여는 중…'));
  active = root;
  const load = async () => {
    const books = [];
    const failed = [];
    const unread = new Set();
    for (const id of cache.keys()) if (!summaries.some((b) => b.id === id)) cache.delete(id);
    for (const summary of summaries) {
      if (summary.library) continue;
      if (!summary.problemCount && !summary.problemAnalyzed) continue;
      try {
        let cached = cache.get(summary.id);
        if (!cached || cached.updatedAt !== summary.updatedAt || !!cached.book.$library !== !!summary.library) {
          cached = { updatedAt: summary.updatedAt, book: await api.getBook(summary.id) };
          cache.set(summary.id, cached);
        }
        Object.assign(cached.book, { subjectOpen: summary.subjectOpen, $subjectOpen: summary.subjectOpen, $canEdit: summary.canEdit, subject: summary.subject, name: summary.name });
        cached.book.$answers = await api.getAnswers(summary.id);
        await loadTranscripts(summary.id, { reload: true });
        books.push(cached.book);
      } catch (err) {
        unread.add(summary.id);
        failed.push(`${summary.name}: ${err.message}`);
      }
    }
    if (active !== root) return;
    const entries = bankEntries(books);
    const valid = new Set(entries.map(keyOf));
    bs.picked = bs.picked.filter((p) => valid.has(pickedKey(p)) || unread.has(p.bookId) || summaries.some((s) => s.library && s.id === p.bookId));
    persist();
    renderBank(root, summaries, books, entries, failed);
    requestAnimationFrame(() => {
      if (!root.isConnected) return;
      const input = [...root.querySelectorAll('[data-bank-focus]')].find((el) => el.dataset.bankFocus === bs.typing?.key);
      input?.focus({ preventScroll: true });
      if (input && bs.typing?.start != null && input.setSelectionRange) input.setSelectionRange(bs.typing.start, bs.typing.end);
      root.closest('main').scrollTop = bs.homeScroll;
    });
  };
  load().catch((err) => { if (active === root) clear(root).append(h('p.empty-hint', `문제은행을 열지 못했어요: ${err.message}`)); });
  return root;
}

function renderBank(root, summaries, books, entries, failed) {
  clear(root);
  root.append(examImportButton());
  const intro = h('div');
  const introButton = h('button.btn.btn-ghost.btn-small', { hidden: bs.intro, onclick: () => { bs.intro = true; writeLocal('ohdap.bankIntro', false); renderIntro(); } }, '사용 순서');
  const intake = h('details.bank-intake', { open: bs.intake, ontoggle: (e) => { bs.intake = e.target.open; } }, h('summary', icon('bookPlus'), '교재 넣기', null));
  const bookList = h('div.bank-books');
  intake.append(bookList);
  const list = h('div.bank-list', { onscroll: () => { bs.scroll = list.scrollTop; } });
  const count = h('span.small.muted');
  const preview = h('section.bank-preview', { onscroll: () => { bs.previewScroll = preview.scrollTop; } });
  const basket = h('section.bank-basket');
  const filters = h('div.bank-filters');
  let previewRun = 0;
  const selected = (e) => bs.picked.some((p) => pickedKey(p) === keyOf(e));
  const show = (e) => {
    bs.focus = keyOf(e);
    bs.previewScroll = 0;
    renderList();
    renderPreview();
  };
  const pick = (e, checked) => {
    if (!open(e)) return;
    bs.picked = bs.picked.filter((p) => pickedKey(p) !== keyOf(e));
    if (checked) bs.picked.push({ bookId: e.bookId, itemId: e.item.id });
    persist();
    renderList();
    renderBasket();
  };

  function renderIntro() {
    introButton.hidden = bs.intro;
    clear(intro);
    if (!bs.intro) return;
    intro.append(h('section.bank-intro',
      h('div.bank-heading', h('h3', '문제은행 사용 순서'), h('button.btn.btn-ghost.btn-small', { title: '', onclick: () => { bs.intro = false; writeLocal('ohdap.bankIntro', true); renderIntro(); } }, '닫기')),
      h('div.bank-steps', [
        ['1. 교재 넣기', '[교재 넣기]에서 교재마다 [문제은행에 넣기]를 누르세요.'],
        ['2. 문항 담기', '문항 목록에서 고른 문항이 시험지 바구니에 담겨요.'],
        ['3. 시험지 저장', '바구니 아래에서 [문제지]·[해설지]를 누르세요.'],
      ].map(([title, text]) => h('div', h('strong', title), h('p.small.muted', text))))));
  }

  function renderBooks() {
    clear(bookList);
    if (!summaries.length) bookList.append(h('p.muted', '아직 등록한 교재가 없어요.'));
    const libraries = summaries.filter((s) => s.library);
    if (libraries.length) bookList.append(h('p.small.muted', `마고 모의고사 ${libraries.length}권 (계약 과목)`));
    for (const s of summaries.filter((s) => !s.library)) {
      const book = books.find((b) => b.id === s.id);
      const items = entries.filter((e) => e.bookId === s.id);
      const n = items.filter((e) => result(e) && (!e.stemKey || result(e, passageItem(e.item)))).length;
      const low = book ? bankTargets(book).reduce((sum, b) => sum + countLow(bestTranscript(book.id, { ...b, src: { files: book.docs.problem.files } })?.entry.blocks), 0) : 0;
      const total = items.length || s.problemCount || 0;
      const job = findJob(`bank:${s.id}`);
      const locked = s.subjectOpen === false || !subjectOpen(s, state.appInfo);
      const card = h(`div.bank-book${locked ? '.bank-locked' : ''}`, { dataset: { book: s.id } },
        h('div.bank-heading', h('strong', s.name), h('span.small.muted', subjectName(s.subject))));
      if (!locked && (job || n > 0 && n < total)) card.append(
        h('div.progress', h('div.progress-bar', { style: { width: `${job?.total ? job.done * 100 / job.total : total ? n * 100 / total : 0}%` } })));
      if (locked) card.append(h('p.small.muted', '학원 계약에 없는 과목 · 보기만'));
      else if (job) card.append(h('p.small.muted', `넣는 중 ${job.done} / ${job.total || total}`), h('button.btn', { onclick: () => job.open() }, '진행 보기'));
      else if (!s.problemAnalyzed && !total) card.append(h('p.small.muted', '책 분석이 필요해요'), h('button.btn', { onclick: () => nav.book(s.id) }, '책 열기'));
      else if (!book) card.append(h('p.small.warn-text', '교재를 읽지 못했어요. 책장에서 확인하세요.'), h('button.btn', { onclick: () => nav.book(s.id) }, '책 열기'));
      else if (total && n === total) card.append(h('p.small.bank-complete', `${total}문항 다 넣었어요`));
      else card.append(h('p.small.muted', n ? `${total}문항 중 ${n}문항 넣었어요` : `${total}문항 · 아직 안 넣었어요`), h('button.btn.btn-primary', { onclick: () => attempt(() => putBank(book, { onChange: changed })) }, n || bankTargets(book).some((b) => bestTranscript(book.id, { ...b, src: { files: book.docs.problem.files } })) ? '이어서 넣기' : '문제은행에 넣기'));
      if (low) card.append(h('button.btn.btn-ghost.btn-small.bank-review-count', { onclick: () => {
        bs.filters.bookId = s.id; bs.filters.review = true; bs.limit = 200; bs.scroll = 0;
        filters.querySelector('[data-bank-focus="bookId"]').value = s.id;
        filters.querySelector('[data-bank-focus="review"]').checked = true;
        renderList(); list.scrollIntoView({ block: 'start' });
      } }, `확인할 곳 ${low}군데`));
      bookList.append(card);
    }
  }

  let loadRun = 0;
  const loading = h('p.small.muted', { hidden: true });
  const loadLibrary = async () => {
    const run = ++loadRun;
    const selected = summaries.filter((s) => s.library && s.subjectOpen !== false && subjectOpen(s, state.appInfo) && (librarySelected(s, bs.filters) || bs.picked.some((p) => p.bookId === s.id)));
    if (!selected.length) { loading.hidden = true; return; }
    const needed = selected.filter((s) => !cache.has(s.id) || cache.get(s.id).updatedAt !== s.updatedAt);
    loading.hidden = !needed.length;
    for (let i = 0; i < selected.length; i++) {
      if (run !== loadRun || active !== root) return;
      const summary = selected[i];
      let cached = cache.get(summary.id);
      if (!cached || cached.updatedAt !== summary.updatedAt || !!cached.book.$library !== !!summary.library) {
        loading.textContent = `모의고사를 불러오는 중 ${i + 1} / ${selected.length}`;
        try {
          const book = await api.getBook(summary.id);
          book.$answers = await api.getAnswers(summary.id);
          await loadTranscripts(summary.id, { reload: true });
          cached = { updatedAt: summary.updatedAt, book };
          cache.set(summary.id, cached);
        } catch (err) { if (run === loadRun) { loading.textContent = '모의고사를 읽지 못했어요. 다시 고르세요.'; loading.hidden = false; } return; }
      }
      Object.assign(cached.book, { $library: true, $canEdit: false, $subjectOpen: summary.subjectOpen, subjectOpen: summary.subjectOpen, name: summary.name, subject: summary.subject });
      const at = books.findIndex((b) => b.id === summary.id);
      if (at < 0) books.push(cached.book); else books[at] = cached.book;
    }
    if (run !== loadRun || active !== root) return;
    entries.splice(0, entries.length, ...bankEntries(books));
    loading.hidden = true;
    renderList(); renderBasket(); renderPreview();
  };
  const updateFilter = debounce(() => { if (root.isConnected) { bs.limit = 200; bs.scroll = 0; renderList(); loadLibrary().catch(fail); } }, 180);
  const field = (key, label, placeholder) => h('label.bank-filter', h('span.small', label), h('input.input', {
    value: bs.filters[key], placeholder, type: 'search', dataset: { bankFocus: key },
    oninput: (e) => { bs.filters[key] = e.target.value; updateFilter(); },
  }));
  const selectFilter = (key, label, options) => h('label.bank-filter', h('span.small', label), h('select.input', {
    dataset: { bankFocus: key }, onchange: (e) => { bs.filters[key] = e.target.value; updateFilter.flush(); },
  }, options.map(([v, text]) => h('option', { value: v, selected: bs.filters[key] === v }, text))));
  const subjects = SUBJECTS.filter((s) => contractedSubjects(state.appInfo).includes(s.code) || summaries.some((b) => (b.subject || 'math') === s.code));
  filters.append(
    ...(subjects.length > 1 ? [selectFilter('subject', '과목', [['', '모든 과목'], ...subjects.map((s) => [s.code, s.name])])] : []),
    selectFilter('exam', '모의고사', [['', '모든 교재'], ['all', '모의고사 전체'], ['csat', '수능'], ['kice', '모평'], ['edu', '학평'], ...(summaries.some((s) => s.library) ? [['library', '마고 모의고사']] : [])]),
    field('year', '연도', '예: 2024'),
    selectFilter('month', '월', [['', '모든 월'], ...[3, 4, 6, 7, 9, 10, 11].map((m) => [String(m), `${m}월`])]),
    selectFilter('grade', '학년', [['', '모든 학년'], ['1', '고1'], ['2', '고2'], ['3', '고3']]),
    selectFilter('bookId', '책', [['', '모든 교재'], ...summaries.filter((b) => !b.library).map((b) => [b.id, b.name])]),
    field('page', '쪽', '예: 12 또는 12-15'), field('number', '번호', '예: 3 또는 3-7'), field('text', '글자로 찾기', '예: 이차함수, 빈칸'),
    h('label.bank-check', h('input', { type: 'checkbox', checked: bs.filters.review, dataset: { bankFocus: 'review' }, onchange: (ev) => { bs.filters.review = ev.target.checked; updateFilter.flush(); } }), '확인할 문항만'),
    h('button.btn', { onclick: () => { Object.keys(bs.filters).forEach((k) => { bs.filters[k] = k === 'review' ? false : ''; }); filters.querySelectorAll('input, select').forEach((el) => { if (el.type === 'checkbox') el.checked = false; else el.value = ''; }); updateFilter.flush(); } }, '지우기'));

  function renderList() {
    const top = bs.scroll;
    clear(list);
    const found = filterBank(entries, bs.filters, textOf).filter((e) => !bs.filters.review || reviewCount(e));
    count.textContent = `${found.length}문항`;
    if (summaries.some((s) => s.library) && !bs.filters.exam && !String(bs.filters.year || '').trim()) list.append(h('p.small.muted', '마고 모의고사는 시험 종류나 연도를 고르면 보여요.'));
    if (!summaries.length || !entries.length && !Object.values(bs.filters).some(Boolean) && !summaries.some((s) => s.library)) {
      list.append(h('div.empty-state', h('p', '책장에서 교재를 등록하고 분석하세요.'), h('button.btn.btn-primary', { onclick: () => nav.home({ tab: 'books' }) }, '책장으로')));
    } else if (!found.length && !(summaries.some((s) => s.library) && !bs.filters.exam && !String(bs.filters.year || '').trim())) list.append(h('div.empty-state', h('p', '맞는 문항이 없어요. 찾는 말을 줄이거나 바꿔 보세요')));
    let bookId = null;
    let bookGroup = null;
    let previousStem = '';
    let setBox = null;
    for (const e of found.slice(0, bs.limit)) {
      if (bookId !== e.bookId) {
        bookId = e.bookId;
        previousStem = '';
        bookGroup = h('section.bank-book-group', h('h3', e.bookName, h('span.small.muted', `${subjectName(e.subject)}${e.bookObj.$library ? ' · 마고' : ''}`)));
        list.append(bookGroup);
      }
      if (e.stemKey && previousStem !== e.stemKey) {
        const stem = passageItem(e.item);
        setBox = h('div.bank-set',
          h('div.bank-set-head', h('strong', `지문${stem.number ? ` [${stem.number}]` : ''}`),
            h('button.btn.btn-small', { disabled: !open(e), onclick: () => {
              for (const member of entries.filter((x) => x.bookId === e.bookId && x.stemKey === e.stemKey && open(x))) {
                if (!selected(member)) bs.picked.push({ bookId: member.bookId, itemId: member.item.id });
              }
              persist(); renderList(); renderBasket();
            } }, '세트 모두 담기')),
          h('p.bank-snippet.small.muted', blocksToText(result(e, stem)?.entry.blocks) || '지문도 함께 글자로 옮겨요.'));
        bookGroup.append(setBox);
      }
      previousStem = e.stemKey;
      const r = result(e);
      const row = h(`div.bank-row${open(e) ? '' : '.bank-locked'}${bs.focus === keyOf(e) ? '.active' : ''}`, {
        tabIndex: 0, role: 'button', dataset: { book: e.bookId, item: e.item.id }, 'aria-label': `${e.bookName} ${itemName(e.item)} 미리보기`,
        onclick: () => show(e), onkeydown: (ev) => { if (ev.target === ev.currentTarget && ['Enter', ' '].includes(ev.key)) { ev.preventDefault(); show(e); } },
      },
      h('label.bank-check', { title: open(e) ? '시험지 바구니에 담기' : '학원 계약에 없는 과목 · 보기만', onclick: (ev) => ev.stopPropagation() },
        h('input', { type: 'checkbox', checked: selected(e), disabled: !open(e), 'aria-label': `${itemName(e.item)} 담기`, onchange: (ev) => pick(e, ev.target.checked) })),
      h('div.bank-row-text', h('strong', e.bookObj.exam ? `${e.bookName} ${itemName(e.item)}` : `${pageLabel(e.bookObj.docs.problem, e.item.page)} · ${itemName(e.item)}`),
        reviewCount(e) ? h('span.small.bank-review-count', `확인 필요 ${reviewCount(e)}군데`) : null,
        h(`span.bank-snippet${r ? '' : '.muted'}`, blocksToText(r?.entry.blocks) || '아직 글자로 옮기지 않았어요')),
      r ? h('span.small.muted.bank-path', pathName[r.path]) : null);
      (e.stemKey ? setBox : bookGroup).append(row);
    }
    if (found.length > bs.limit) list.append(h('button.btn.bank-more', { onclick: () => { bs.limit += 200; renderList(); } }, `더 보기 (${Math.min(bs.limit, found.length)} / ${found.length})`));
    list.scrollTop = top;
  }

  async function renderPreview() {
    const run = ++previewRun;
    const top = bs.previewScroll;
    const e = entries.find((x) => keyOf(x) === bs.focus);
    clear(preview);
    if (!e) { preview.append(h('h3', '미리보기'), h('p.empty-hint', '문항을 누르면 미리보기가 열려요.')); return; }
    preview.append(h('h3', `${e.bookName} · ${itemName(e.item)}`), h('p.small.muted', '문제 그림을 여는 중…'));
    const releases = ['problem', 'answer'].map((role) => holdSource(e.bookObj, role));
    try {
      const ready = await api.ensureBookFiles(e.bookId);
      if (!ready?.ok) throw new Error('교재 파일을 받지 못했어요. 책장에서 확인하세요.');
      const src = await getSources(e.bookObj);
      const [problem, answer] = await Promise.all([itemImage(src.problem, e.item, 700, { stem: e.item.stem }), e.answer ? itemImage(src.answer, e.answer, 700) : null]);
      if (run !== previewRun || !root.isConnected) return;
      clear(preview).append(h('h3', `${e.bookName} · ${itemName(e.item)}`));
      if (e.bookObj.$library) preview.append(h('p.small.muted', '마고 공용 책장 · 읽기 전용'), h('button.btn.btn-ghost.btn-small', { onclick: (ev) => { const button = ev.currentTarget; button.disabled = true; attempt(async () => { try { const copy = await api.copyBook(e.bookId); toast('내 책으로 복사했어요.'); nav.book(copy.id); } finally { button.disabled = false; } }); } }, '내 책으로 복사'));
      if (!open(e)) preview.append(h('p.readonly-banner', '학원 계약에 없는 과목 · 보기만'));
      if (problem) preview.append(h('img.bank-image', { src: problem, alt: '지문을 포함한 문제 그림' }));
      if (answer) preview.append(h('h4', '짝 해설'), h('img.bank-image', { src: answer, alt: '짝 해설 그림' }));
      else preview.append(h('p.small.muted', '짝이 되는 해설이 없어요.'));
      if (e.stemKey) preview.append(transcriptPanel(e, passageItem(e.item), src.problem));
      preview.append(transcriptPanel(e, e.item, src.problem));
      const written = h('div.answer-preview');
      preview.append(written);
      showAnswerPreview(written, e.bookId, e.item.id).catch(fail);
      bs.previewScroll = top;
      preview.scrollTop = top;
    } catch (err) {
      if (run === previewRun && root.isConnected) preview.append(h('p.warn-text', err.message));
    } finally { releases.forEach((release) => release()); }
  }

  function transcriptPanel(e, item, src) {
    const block = { kind: 'problem', role: 'problem', item, src, stem: null };
    const r = bestTranscript(e.bookId, block);
    const panel = h('div.bank-transcript', { dataset: { passage: String(!!item.passage) } },
      h('div.bank-heading', h('h4', item.passage ? `${itemName(item)} · 옮긴 글` : '옮긴 글'),
        r ? h('span.small.muted', pathName[r.path]) : null,
        open(e) && !e.bookObj.$library ? h('button.btn.btn-small', { onclick: () => attempt(() => editTranscript(e, block)) }, '글 고치기') : null,
        !item.passage && !e.bookObj.$library ? answerEditorButton({ book: e.bookObj, item: e.item, answerItem: e.answer, onChange: changed }) : null));
    if (r) panel.append(...r.entry.blocks.map((b) => b.type === 'para' ? h('p.bank-para', b.text)
      : b.type === 'math' ? h('div.bank-math', b.latex)
        : b.type === 'choices' ? h('div.bank-choices', b.items.map((v, i) => h('p', `${choiceMark(i)} ${v}`))) : h('p.muted', '[그림]')));
    else {
      panel.append(h('p.small.muted', open(e) ? '아직 글자로 옮긴 결과가 없어요.' : '아직 글자로 옮긴 결과가 없어요.'));
      if (open(e) && !e.bookObj.$library) panel.append(h('button.btn', { onclick: () => attempt(() => putBank(e.bookObj, { item: e.item, onChange: changed })) }, '이 문항만 옮기기'));
    }
    return panel;
  }

  function renderBasket() {
    clear(basket);
    const picked = orderPicked(bs.picked, entries);
    basket.append(h('div.export-panel', h('div.export-head', h('h3', '시험지 바구니'), h('span.sel-count', h('strong', String(picked.length)), '문항')),
      picked.length ? h('div.sel-list', picked.map((e) => h('span.sel-chip',
        h('button.bank-chip-open', { title: `${e.bookName} · 미리보기`, onclick: () => show(e) }, `${e.bookName} ${itemName(e.item)}`),
        h('button.sel-x', { title: '빼기', onclick: () => { bs.picked = bs.picked.filter((p) => pickedKey(p) !== keyOf(e)); persist(); renderList(); renderBasket(); } }, icon('x'))))) : h('p.empty-hint', '아직 담은 문항이 없어요.'),
      picked.length ? h('button.btn.btn-small', { onclick: () => { bs.picked = []; persist(); renderList(); renderBasket(); } }, '모두 비우기') : null,
      picked.some((e) => e.stemKey) ? h('p.small.muted', '지문도 함께 들어가요') : null,
      exportOptions(picked, entries)));
  }

  refreshJobs = renderBooks;
  refresh = () => { renderBooks(); renderList(); renderPreview(); renderBasket(); };
  root.append(h('div.bank-heading', h('h2', '찾아서 시험지로'), introButton),
    intro, intake, ...failed.map((s) => h('p.warn-text', s)),
    h('div.bank-columns', h('section.bank-main', filters, loading, h('div.bank-heading', h('h3', '문항 목록'), count), list), h('aside.bank-side', preview, basket)));
  renderIntro();
  refresh();
  loadLibrary().catch(fail);
}

async function editTranscript(e, block) {
  if (!open(e)) return;
  const found = bestTranscript(e.bookId, block);
  const blocks = JSON.parse(JSON.stringify(found?.entry.blocks || [{ type: 'para', text: '' }]));
  const fields = h('div.bank-edit-fields');
  const release = holdSource(e.bookObj, block.role);
  let stack;
  const review = reviewPanel(blocks, () => (stack ||= renderStack(blockSegs(block), TRANSCRIBE_WIDTH)), () => draw());
  const draw = () => {
    review.resetFields();
    clear(fields);
    blocks.forEach((b, i) => {
      const move = (d) => { [blocks[i], blocks[i + d]] = [blocks[i + d], blocks[i]]; draw(); };
      fields.append(h('section.bank-edit-block',
        h('div.bank-heading', h('strong', `${i + 1}. ${{ para: '글', math: '수식', choices: '보기', figure: '그림' }[b.type]}`),
          h('button.btn.btn-small', { disabled: !i, onclick: () => move(-1) }, '위로'),
          h('button.btn.btn-small', { disabled: i === blocks.length - 1, onclick: () => move(1) }, '아래로'),
          h('button.btn.btn-small', { onclick: () => { blocks.splice(i, 1); draw(); } }, '빼기')),
        b.type === 'para' ? review.field(i)
          : b.type === 'math' ? review.field(i)
            : b.type === 'choices' ? h('div.bank-edit-choices', b.items.map((v, j) => h('div', choiceMark(j), review.field(i, j))))
              : h('p', '[그림]')));
    });
    review.update();
  };
  draw();
  let busy = false;
  const store = async (reset) => {
    if (busy) return false;
    if (!open(e)) { toast('학원 계약에 없는 과목이라 보기만 할 수 있어요.'); return false; }
    if (!reset && !blocksToText(blocks)) { toast('글이나 수식 칸에 내용을 적으세요.'); return false; }
    busy = true;
    try {
      if (reset) await clearEditedTranscript(e.bookId, block);
      else await setEditedTranscript(e.bookId, block, blocks);
      changed();
      toast(reset ? '원래대로 복원 완료' : '저장 완료', { type: 'success' });
      return true;
    } catch (err) { fail(err); return false; } finally { busy = false; }
  };
  await modal({ title: `${itemName(block.item)} · 글 고치기`, width: 980, className: 'review-modal',
    onKeyDown: review.keydown,
    onClose: () => { review.close(); release(); stack = null; },
    body: h('div.bank-editor', h('p.small.muted.review-help', REVIEW_HELP), review.toolbar,
      h('div.review-layout', h('section', fields,
        h('div.bank-heading', h('button.btn', { onclick: () => { blocks.push({ type: 'para', text: '' }); draw(); } }, '글 칸 더하기'), h('button.btn', { onclick: () => { blocks.push({ type: 'math', latex: '' }); draw(); } }, '수식 칸 더하기'))), review.aside)),
    buttons: [{ label: '취소', value: false }, ...(found?.path === 'edit' ? [{ label: '원래대로', onClick: () => store(true) }] : []), { label: '저장', primary: true, onClick: () => store(false) }],
  });
}

const examInfo = () => ({ title: '문제은행 시험지', student: '', academy: state.settings.academy || '', teacher: state.settings.teacher || '', date: new Date().toLocaleDateString('ko-KR'), ...bs.info });

function exportOptions(picked, entries) {
  const info = examInfo();
  const o = bs.opts;
  const set = (key, value) => { o[key] = value; persist(); };
  const seg = (key, values, onChange = () => {}) => h('div.seg', values.map(([v, text, tip]) => h('label', { title: tip },
    h('input', { type: 'radio', name: `bank-${key}`, value: v, checked: String(o[key]) === String(v), onchange: () => { set(key, v); onChange(); } }), h('span', text))));
  const hint = h('p.small.muted');
  const convertText = {
    mix: ['자동 선택', '확인할 문항만 외부 서비스로 전송'],
    ai: ['정밀 인식', '문항을 외부 서비스로 전송'],
    ocr: ['스캔 인식', '이 컴퓨터에서 인식'],
  };
  const convert = h('div.opt-row', h('span.opt-label', '스캔본'), seg('convert', Object.keys(CONVERT_MODES).map((key) => [key, ...convertText[key]]), () => formatHint()));
  const formatHint = () => {
    convert.hidden = hint.hidden = o.format !== 'hwpx';
    hint.textContent = (convertText[o.convert] || convertText.ocr)[1];
  };
  formatHint();
  const anyAnswers = picked.some((e) => open(e) && (e.answer || answerContent(e.bookObj.$answers?.items[e.item.id])));
  return h('div.bank-export',
    h('details.exam-box', { open: true }, h('summary', icon('school'), '시험지 머리'),
      h('div.exam-fields', [['title', '제목'], ['student', '학생'], ['academy', '학원'], ['teacher', '선생님'], ['date', '날짜']].map(([key, name]) => h('label.exam-field',
        h('span.ef-label', name), h('input.input.input-small', { value: info[key], dataset: { bankFocus: `exam-${key}` }, placeholder: key === 'student' ? '비워 두면 이름 쓰는 칸' : name,
          oninput: (ev) => { bs.info[key] = ev.target.value; persist(); } }))))),
    h('div.export-options',
      h('div.opt-row', h('span.opt-label', '파일'), seg('format', [['pdf', 'PDF'], ['hwpx', '한글(HWPX)']], formatHint)), convert,
      h('div.opt-row', h('span.opt-label', '배치'), seg('columns', [[1, '1단'], [2, '2단']])),
      h('div.opt-row', h('span.opt-label', '풀이 여백'), seg('space', Object.entries(SPACE_OPTIONS).map(([k, v]) => [k, v.short]))),
      h('div.opt-row', [['labels', '출처(책·쪽·번호)'], ['renumber', '새 번호']].map(([key, label]) => h('label.switch',
        h('input', { type: 'checkbox', checked: o[key], onchange: (ev) => set(key, ev.target.checked) }), h('span.sw'), label))), hint),
    h('div.export-buttons', [['problems', '문제지', ''], ['answers', '해설지', ''], ['both-inline', '문제 + 해설', '문제마다 바로 뒤에'], ['both-end', '문제 + 해설', '해설은 맨 뒤에']].map(([mode, title, sub]) => h('button.export-btn', {
      dataset: { mode }, disabled: !picked.length || mode !== 'problems' && !anyAnswers,
      title: !picked.length ? '먼저 문항을 담으세요.' : mode !== 'problems' && !anyAnswers ? '정답·해설을 직접 쓰거나 답지를 올리세요.' : sub,
      onclick: () => attempt(() => restartGuard.track('export', () => exportBank(mode, entries))),
    }, h('span.xb-icon', icon('download')), h('span.xb-text', h('b', title), h('small', sub))))));
}

const pendingExports = new Set();
restartPendingChecks.add(() => pendingExports.size > 0);
let exportRun = null;

async function exportBank(mode, all) {
  const sig = JSON.stringify({ mode, picked: bs.picked, options: bs.opts, info: examInfo(),
    items: orderPicked(bs.picked, all).map((e) => [e.bookId, e.item.id, e.item.rects, e.item.stem, e.bookObj.updatedAt]) });
  if (exportRun) {
    const old = exportRun;
    const job = findJob('hwpx:bank');
    if (old.sig === sig) { job?.open(); return; }
    if (!job) { toast('앞 시험지를 만드는 중이에요. 끝나면 다시 누르세요.'); return; }
    toast('바구니가 바뀌어서 만들던 한글 문서를 멈추고 다시 만들어요.');
    job.cancel();
    await old.promise;
    if (exportRun && exportRun !== old) return;
  }
  const run = { sig };
  exportRun = run;
  try {
    run.promise = buildBankExport(mode, all);
    await run.promise;
  } finally { if (exportRun === run) exportRun = null; }
}

async function buildBankExport(mode, all) {
  const releases = [];
  const closeToast = toast('시험지를 만드는 중…', { timeout: 0 });
  try {
    // 계약이 바뀌었으면, 화면을 연 뒤 담은 문항도 내보내지 않음
    const latest = new Map((await api.listBooks()).map((b) => [b.id, b]));
    const picked = orderPicked(bs.picked, all);
    const entries = picked.filter((e) => latest.has(e.bookId) && latest.get(e.bookId).subjectOpen !== false && subjectOpen(latest.get(e.bookId), state.appInfo));
    if (entries.length !== picked.length) {
      const allowed = new Set(entries.map(keyOf));
      bs.picked = bs.picked.filter((p) => allowed.has(pickedKey(p)));
      persist(); changed();
      toast('없어졌거나 학원 계약에 없는 과목의 문항은 뺐어요.');
    }
    if (!entries.length) { toast('내보낼 문항을 먼저 담으세요.'); return; }
    const sources = new Map();
    for (const e of entries) {
      if (!sources.has(e.bookId)) {
        releases.push(...['problem', 'answer'].map((role) => holdSource(e.bookObj, role)));
        const ready = await api.ensureBookFiles(e.bookId);
        if (!ready?.ok) throw new Error(`${e.bookName} 원본을 받지 못했어요.`);
        sources.set(e.bookId, await getSources(e.bookObj));
      }
      e.src = sources.get(e.bookId);
      if (!e.src.problem || e.answer && !e.src.answer && mode !== 'problems') throw new Error(`${e.bookName} 원본을 열지 못했어요.`);
    }
    const opts = { ...bs.opts, plainPdf: true };
    await attachAnswers(entries);
    const info = { ...examInfo(), subtitle: `문제 ${entries.length}문항` };
    const blocks = makeBankBlocks(mode, entries, opts, (role, it, e) => pageLabel(e.bookObj.docs[role], it.page));
    let remaining = blocks.reduce((sum, block) => {
      const entry = entries.find((e) => e.src?.[block.role] === block.src);
      return sum + (block.answerBlocks || !entry || !block.item ? 0 : countLow(bestTranscript(entry.bookId, block)?.entry.blocks));
    }, 0);
    const reviewNote = () => remaining ? ` · 확인 필요 ${remaining}군데` : '';
    const sig = JSON.stringify({ mode, opts, info, blocks: blocks.map((b) => [b.item?.id, b.item?.rects, b.num, b.source, b.answerBlocks]) });
    const modeName = { problems: '문제지', answers: '해설지', 'both-inline': '문제+해설', 'both-end': '문제+해설(해설 뒤)' }[mode];
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const name = `문제은행_${info.title || '시험지'}_${modeName}_${ymd}`.replace(/[\\/:*?"<>|]/g, '_');
    const saved = (res, token) => {
      if (res.canceled) return;
      pendingExports.delete(token);
      restartGuard.report();
      toast(`저장 완료${reviewNote()}`, { type: 'success', timeout: 10000, actions: [{ label: '열기', onClick: () => api.openPath(res.path) }, { label: '폴더 보기', onClick: () => api.showItemInFolder(res.path) }] });
    };
    if (opts.format === 'hwpx') {
      const bytes = await exportHwpx(blocks, entries, opts, info, { key: 'hwpx:bank', sig });
      remaining = bytes.reviewCount || 0;
      const token = {};
      const save = () => restartGuard.track('export', async () => saved(await api.saveFile({ defaultName: `${name}.hwpx`, data: bytes, filters: [{ name: '한글 문서', extensions: ['hwpx'] }], title: '한글 문서 저장' }), token));
      if (bytes.job?.finish({ message: `한글 시험지 준비 완료${reviewNote()}`, actions: [{ label: '저장하기', onClick: () => attempt(save) }] })) {
        pendingExports.add(token);
        restartGuard.report();
      } else await save();
    } else {
      const bytes = await buildPdf({ blocks, options: opts, title: info.title, info });
      saved(await api.savePdf(`${name}.pdf`, bytes));
    }
  } catch (err) {
    if (err.name === 'AbortError') toast('만들기를 멈췄어요. 옮긴 글은 남아 있어요.');
    else fail(err);
  } finally { closeToast(); releases.forEach((release) => release()); }
}
