// 첫 화면: 학생 오답노트 목록 / 책장(등록한 책)

import { h, clear, toast, modal, confirmDialog, promptDialog, formatDate, icon, countUp, animateOut } from './ui.js';
import { api, state, nav, dropSources, liveBook, stopJobs } from './shared.js';
import { topbar } from './chrome.js';

const SPINES = [
  'linear-gradient(180deg, #ffb27d, #f0743e)',
  'linear-gradient(180deg, #7fd6c8, #2a9d8f)',
  'linear-gradient(180deg, #ffa3a3, #e06767)',
  'linear-gradient(180deg, #a9b8ff, #6878e0)',
  'linear-gradient(180deg, #ffd27f, #eba13a)',
  'linear-gradient(180deg, #c3a6ff, #8f6be0)',
];
export function spineFor(id) {
  let hsh = 0;
  for (const ch of String(id)) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  return SPINES[hsh % SPINES.length];
}

let homeTab = 'notes';

export async function showHome({ tab } = {}) {
  if (tab) homeTab = tab;
  const [notes, books] = await Promise.all([api.listNotes(), api.listBooks()]);
  const bookById = new Map(books.map((b) => [b.id, b]));
  const root = document.getElementById('app');
  clear(root);
  state.view = 'home';

  const body = h('section.home-body');
  const segBtn = (key, ic, label, n) =>
    h(`button.seg-tab${homeTab === key ? '.active' : ''}`, { dataset: { tab: key }, onclick: () => switchTab(key) }, icon(ic), h('span', label), h('span.seg-count', String(n)));
  const thumb = h('span.seg-thumb');
  const tabs = h('nav.seg-tabs', thumb, segBtn('notes', 'notebook', '학생 오답노트', notes.length), segBtn('books', 'library', '책장', books.length));

  root.append(
    topbar(h('div.brand', h('span.brand-mark'), h('span.brand-name', '오답노트'))),
    h(
      'main.home.view-enter',
      h(
        'div.home-hero',
        h('div.hero-text', h('h1', homeTab === 'notes' ? '학생 오답노트' : '책장'), h('p', homeTab === 'notes' ? '책장에 등록한 책에서 틀린 문제만 골라 시험지처럼 묶어 드려요.' : '문제집과 답지를 한 번만 올려 두면, 여러 학생 오답노트에서 같이 써요.')),
        tabs,
      ),
      body,
      h('footer.home-foot', h('span', `버전 ${state.appInfo.version}`), h('span.dot'), h('span', `개발 ${state.appInfo.developer || '구현민'}`)),
    ),
  );
  requestAnimationFrame(() => placeSegThumb(tabs));
  renderBody();

  async function switchTab(key) {
    if (key === homeTab) return;
    homeTab = key;
    tabs.querySelectorAll('.seg-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    placeSegThumb(tabs);
    const hero = root.querySelector('.hero-text');
    await animateOut(body, 'leave-fade', 160);
    hero.querySelector('h1').textContent = key === 'notes' ? '학생 오답노트' : '책장';
    hero.querySelector('p').textContent = key === 'notes' ? '책장에 등록한 책에서 틀린 문제만 골라 시험지처럼 묶어 드려요.' : '문제집과 답지를 한 번만 올려 두면, 여러 학생 오답노트에서 같이 써요.';
    body.classList.remove('leave-fade');
    renderBody();
  }

  function renderBody() {
    clear(body);
    body.classList.remove('swap-in');
    void body.offsetWidth;
    body.classList.add('swap-in');
    if (homeTab === 'notes') body.append(notesGrid());
    else body.append(booksGrid());
  }

  function notesGrid() {
    return h(
      'div.card-grid',
      h(
        'button.card.card-new',
        { onclick: () => createNote(books), style: { '--i': 0 } },
        h('div.new-plus', icon('plus')),
        h('div.cn-title', '새 오답노트'),
        h('div.cn-sub', books.length ? '학생 이름을 쓰고 책을 고르면 시작' : '먼저 책장에 책을 등록해 주세요'),
      ),
      notes.map((n, i) => {
        const statNum = h('strong');
        countUp(statNum, n.selectedCount);
        return h(
          'div.card.note-card',
          {
            tabIndex: 0,
            onclick: () => nav.note(n.id),
            onkeydown: (e) => e.key === 'Enter' && nav.note(n.id),
            style: { '--i': Math.min(i + 1, 14) },
          },
          h('div.nc-top', h('span.nc-avatar', (n.student || n.title || '?').trim().slice(0, 1)), h('div.nc-who', h('div.nc-title', n.title), h('div.nc-student', n.student ? `${n.student} 학생` : '학생 이름 없음'))),
          h(
            'div.nc-books',
            n.bookIds.length
              ? n.bookIds.map((id) => h('span.book-pill', { style: { '--spine': spineFor(id) } }, bookById.get(id)?.name || '지워진 책'))
              : h('span.muted.small', '책 없음'),
          ),
          h('div.nc-foot', h('span.nc-count', statNum, '문항 고름'), h('span.nc-date', formatDate(n.updatedAt))),
          h(
            'div.card-actions',
            h('button.btn.btn-ghost.btn-icon', { title: '이름 바꾸기', onclick: (e) => { e.stopPropagation(); renameNote(n); } }, icon('edit')),
            h('button.btn.btn-ghost.btn-icon', { title: '삭제', onclick: (e) => { e.stopPropagation(); deleteNote(n); } }, icon('trash')),
          ),
        );
      }),
    );
  }

  function booksGrid() {
    return h(
      'div.card-grid',
      h(
        'button.card.card-new',
        { onclick: createBook, style: { '--i': 0 } },
        h('div.new-plus', icon('bookPlus')),
        h('div.cn-title', '새 책 등록'),
        h('div.cn-sub', '문제집 PDF·사진과 답지를 올려 분석해요'),
      ),
      books.map((b, i) =>
        h(
          'div.card.book-card',
          {
            tabIndex: 0,
            onclick: () => nav.book(b.id),
            onkeydown: (e) => e.key === 'Enter' && nav.book(b.id),
            style: { '--i': Math.min(i + 1, 14), '--spine': spineFor(b.id) },
          },
          h('div.bc-title', b.name),
          h(
            'div.bc-files',
            h(`div${b.problemFile ? '' : '.muted'}`, icon('book'), h('span', b.problemFile || '문제집 없음')),
            h(`div${b.answerFile ? '' : '.muted'}`, icon('bookCheck'), h('span', b.answerFile || '답지 없음')),
          ),
          h(
            'div.bc-stats',
            h('span.stat', h('b', String(b.problemCount)), '문항'),
            h('span.stat.teal', h('b', String(b.answerCount)), '해설'),
            b.flagged ? h('span.stat.warn', icon('warn'), `확인 ${b.flagged}쪽`) : null,
            !b.problemAnalyzed && b.problemFile ? h('span.stat.muted', '분석 전') : null,
          ),
          h('div.bc-date', formatDate(b.updatedAt)),
          h(
            'div.card-actions',
            h('button.btn.btn-ghost.btn-icon', { title: '이름 바꾸기', onclick: (e) => { e.stopPropagation(); renameBook(b); } }, icon('edit')),
            h('button.btn.btn-ghost.btn-icon', { title: '삭제', onclick: (e) => { e.stopPropagation(); deleteBook(b, notes); } }, icon('trash')),
          ),
        ),
      ),
    );
  }
}

export function placeSegThumb(tabs, from) {
  const thumb = tabs?.querySelector('.seg-thumb');
  const active = tabs?.querySelector('.seg-tab.active');
  if (!thumb || !active) return;
  if (from) {
    thumb.style.transition = 'none';
    thumb.style.transform = `translateX(${from.x}px)`;
    thumb.style.width = `${from.w}px`;
    void thumb.offsetWidth;
    thumb.style.transition = '';
  }
  thumb.style.transform = `translateX(${active.offsetLeft}px)`;
  thumb.style.width = `${active.offsetWidth}px`;
}

// ---------------------------------------------------------------------------
async function createBook() {
  const name = await promptDialog('책 이름을 적어 주세요. (예: 쎈 수학Ⅰ, 수능특강 미적분)', { title: '새 책 등록', placeholder: '책 이름', ok: '등록' });
  if (name == null) return;
  const book = await api.createBook(name);
  await nav.book(book.id);
}

async function renameBook(b) {
  const name = await promptDialog('새 이름', { title: '책 이름 바꾸기', value: b.name });
  if (!name) return;
  // 뒤에서 분석 중인 책이면 그 작업이 들고 있는 책을 고침 (작업이 끝나며 저장할 때 이름이 되돌아가지 않게)
  const book = liveBook(b.id) || (await api.getBook(b.id));
  book.name = name.trim();
  book.updatedAt = Date.now();
  await api.saveBook(book);
  showHome();
}

async function deleteBook(b, notes) {
  const using = notes.filter((n) => n.bookIds.includes(b.id));
  const msg = `"${b.name}"을(를) 책장에서 지울까요?\n올린 파일과 분석 결과가 모두 지워집니다.${using.length ? `\n이 책을 쓰는 오답노트 ${using.length}개에서도 이 책의 문항이 빠집니다.` : ''}`;
  if (!(await confirmDialog(msg, { title: '책 삭제', ok: '삭제', danger: true }))) return;
  await stopJobs((j) => j.bookId === b.id); // 이 책에서 뒤에서 도는 작업은 멈추고 (저장까지) 끝난 뒤에 지움
  dropSources(b.id);
  await api.deleteBook(b.id);
  showHome();
}

/** 새 오답노트: 제목·학생 이름·책 고르기 */
export async function createNote(books) {
  if (!books.length) {
    const go = await confirmDialog('오답노트는 책장에 등록한 책에서 문제를 골라 만들어요.\n먼저 책을 등록할까요?', { title: '책이 없어요', ok: '책 등록하기' });
    if (go) {
      homeTab = 'books';
      await createBook();
    }
    return;
  }
  const titleInput = h('input.input', { placeholder: '예: 1학기 중간고사 대비 오답', value: '' });
  const studentInput = h('input.input', { placeholder: '학생 이름' });
  const picked = new Set(books.length === 1 ? [books[0].id] : []);
  const list = h(
    'div.book-pick',
    books.map((b) =>
      h(
        `label.book-opt${picked.has(b.id) ? '.on' : ''}`,
        { style: { '--spine': spineFor(b.id) } },
        h('input', {
          type: 'checkbox',
          checked: picked.has(b.id),
          onchange: (e) => {
            if (e.target.checked) picked.add(b.id);
            else picked.delete(b.id);
            e.target.closest('.book-opt').classList.toggle('on', e.target.checked);
          },
        }),
        h('span.bo-spine'),
        h('span.bo-name', b.name),
        h('span.bo-meta', b.problemCount ? `${b.problemCount}문항` : '분석 전'),
        h('span.bo-check', icon('check')),
      ),
    ),
  );
  const body = h(
    'div.form',
    h('label.field-v', h('span', '학생 이름'), studentInput),
    h('label.field-v', h('span', '오답노트 제목'), titleInput),
    h('div.field-v', h('span', '어떤 책에서 고를까요? (여러 권 가능)'), list),
  );
  const r = await modal({
    title: '새 오답노트',
    body,
    width: 520,
    buttons: [
      { label: '취소', value: null },
      {
        label: '만들기',
        primary: true,
        onClick: () => {
          if (!picked.size) {
            toast('책을 하나 이상 골라 주세요.', { type: 'error' });
            return false;
          }
          const student = studentInput.value.trim();
          const title = titleInput.value.trim() || (student ? `${student} 오답노트` : '오답노트');
          return { title, student, bookIds: books.filter((b) => picked.has(b.id)).map((b) => b.id) };
        },
      },
    ],
  });
  if (!r) return;
  const note = await api.createNote(r);
  await nav.note(note.id);
}

async function renameNote(n) {
  const name = await promptDialog('새 제목', { title: '오답노트 제목 바꾸기', value: n.title });
  if (!name) return;
  const note = await api.getNote(n.id);
  note.title = name.trim();
  note.updatedAt = Date.now();
  await api.saveNote(note);
  showHome();
}

async function deleteNote(n) {
  if (!(await confirmDialog(`"${n.title}" 오답노트를 삭제할까요?\n고른 문항 목록만 지워지고, 책장의 책은 그대로 남아요.`, { title: '오답노트 삭제', ok: '삭제', danger: true }))) return;
  await api.deleteNote(n.id);
  showHome();
}
