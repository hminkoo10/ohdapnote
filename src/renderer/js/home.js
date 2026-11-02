// 첫 화면: 학생 오답노트 목록 / 책장(등록한 책) / 학생 명단

import { h, clear, toast, modal, confirmDialog, promptDialog, formatDate, icon, countUp, animateOut } from './ui.js';
import { api, state, nav, dropSources, liveBook, stopJobs, errMsg } from './shared.js';
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

/** 탭마다 위쪽 제목·설명 */
function heroText(key) {
  if (key === 'books') return ['책장', '문제집과 답지를 한 번만 올려 두면, 여러 학생 오답노트에서 같이 써요.'];
  if (key === 'students') return ['학생 명단', state.appInfo.academy ? '학원 선생님들이 함께 쓰는 학생 명단이에요. 오답노트를 만들 때 골라 쓸 수 있어요.' : '학생을 적어 두면 오답노트를 만들 때 골라 쓸 수 있어요.'];
  return ['학생 오답노트', '책장에 등록한 책에서 틀린 문제만 골라 시험지처럼 묶어 드려요.'];
}

export async function showHome({ tab } = {}) {
  if (tab) homeTab = tab;
  const [notes, books, students] = await Promise.all([api.listNotes(), api.listBooks(), api.listStudents()]);
  const bookById = new Map(books.map((b) => [b.id, b]));
  const root = document.getElementById('app');
  clear(root);
  state.view = 'home';

  const body = h('section.home-body');
  const segBtn = (key, ic, label, n) =>
    h(`button.seg-tab${homeTab === key ? '.active' : ''}`, { dataset: { tab: key }, onclick: () => switchTab(key) }, icon(ic), h('span', label), h('span.seg-count', String(n)));
  const thumb = h('span.seg-thumb');
  const tabs = h('nav.seg-tabs', thumb, segBtn('notes', 'notebook', '학생 오답노트', notes.length),segBtn('books', 'library', '책장', books.length), segBtn('students', 'user', '학생 명단', students.length));
  const [heroTitle, heroSub] = heroText(homeTab);

  root.append(
    topbar(h('div.brand', h('span.brand-mark'), h('span.brand-name', '오답노트'))),
    h(
      'main.home.view-enter',
      h(
        'div.home-hero',
        h('div.hero-text', h('h1', heroTitle), h('p', heroSub)),
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
    [hero.querySelector('h1').textContent, hero.querySelector('p').textContent] = heroText(key);
    body.classList.remove('leave-fade');
    renderBody();
  }

  function renderBody() {
    clear(body);
    body.classList.remove('swap-in');
    void body.offsetWidth;
    body.classList.add('swap-in');
    if (homeTab === 'notes') body.append(notesGrid());
    else if (homeTab === 'students') body.append(studentsGrid());
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
          // 원장이 보는 다른 선생님 오답노트: 누구 것인지 (열면 보기·내보내기만)
          n.mine === false ? h('div.creator', icon('user'), `${n.ownerName || '다른'} 선생님`) : null,
          h(
            'div.nc-books',
            n.bookIds.length
              ? n.bookIds.map((id) => h('span.book-pill', { style: { '--spine': spineFor(id) } }, bookById.get(id)?.name || '지워진 책'))
              : h('span.muted.small', '책 없음'),
          ),
          h('div.nc-foot', h('span.nc-count', statNum, '문항 고름'), h('span.nc-date', formatDate(n.updatedAt))),
          n.mine !== false
            ? h(
                'div.card-actions',
                h('button.btn.btn-ghost.btn-icon', { title: '이름 바꾸기', onclick: (e) => { e.stopPropagation(); renameNote(n); } }, icon('edit')),
                h('button.btn.btn-ghost.btn-icon', { title: '삭제', onclick: (e) => { e.stopPropagation(); deleteNote(n); } }, icon('trash')),
              )
            : null,
        );
      }),
    );
  }

  function studentsGrid() {
    return h(
      'div.card-grid',
      h(
        'button.card.card-new',
        { onclick: () => editStudent(), style: { '--i': 0 } },
        h('div.new-plus', icon('plus')),
        h('div.cn-title', '새 학생'),
        h('div.cn-sub', '이름·학교·학년을 적어 두면 오답노트를 만들 때 골라요'),
      ),
      students.map((st, i) =>
        h(
          `div.card.student-card${st.canEdit ? '.can-edit' : ''}`,
          {
            tabIndex: st.canEdit ? 0 : null,
            onclick: st.canEdit ? () => editStudent(st) : null,
            onkeydown: st.canEdit ? (e) => e.key === 'Enter' && editStudent(st) : null,
            style: { '--i': Math.min(i + 1, 14) },
          },
          h('div.nc-top', h('span.nc-avatar', (st.name || '?').trim().slice(0, 1)), h('div.nc-who', h('div.nc-title', st.name), h('div.nc-student', [st.school, st.grade].filter(Boolean).join(' · ') || '학교·학년 없음'))),
          st.memo ? h('div.sc-memo', st.memo) : null,
          h('div.nc-foot', st.createdBy?.name ? h('span.creator', `등록: ${st.createdBy.name}`) : h('span'), h('span.nc-date', formatDate(st.updatedAt))),
          st.canEdit
            ? h(
                'div.card-actions',
                h('button.btn.btn-ghost.btn-icon', { title: '고치기', onclick: (e) => { e.stopPropagation(); editStudent(st); } }, icon('edit')),
                h('button.btn.btn-ghost.btn-icon', { title: '삭제', onclick: (e) => { e.stopPropagation(); deleteStudent(st); } }, icon('trash')),
              )
            : null,
        ),
      ),
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
          state.appInfo.academy && b.createdBy ? h('div.creator', `생성자: ${b.createdBy.name || '알 수 없음'}`) : null,
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
          // 고칠 수 없는 책(다른 선생님이 만든 책)은 이름 바꾸기·삭제 대신 내 책으로 복사
          b.canEdit
            ? h(
                'div.card-actions',
                h('button.btn.btn-ghost.btn-icon', { title: '이름 바꾸기', onclick: (e) => { e.stopPropagation(); renameBook(b); } }, icon('edit')),
                h('button.btn.btn-ghost.btn-icon', { title: '삭제', onclick: (e) => { e.stopPropagation(); deleteBook(b, notes); } }, icon('trash')),
              )
            : h('div.card-actions', h('button.btn.btn-ghost.btn-icon', { title: '내 책으로 복사', onclick: (e) => { e.stopPropagation(); copyBook(b, e.currentTarget); } }, icon('files'))),
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

/** 다른 선생님이 만든 책을 내 책으로 (원본 파일을 받은 뒤 복사 — 오래 걸릴 수 있어서 버튼을 잠가 둠) */
async function copyBook(b, btn) {
  btn.disabled = true;
  try {
    await api.copyBook(b.id);
  } catch (err) {
    btn.disabled = false;
    toast(`책을 복사하지 못했어요: ${errMsg(err)}`, { type: 'error', timeout: 8000 });
    return;
  }
  toast(`"${b.name}"을(를) 내 책으로 복사했어요.`, { type: 'success' });
  if (state.view === 'home') showHome({ tab: 'books' }); // 받는 동안 다른 화면으로 갔으면 그대로
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
  // 학생 명단에서 고르면 이름을 채우고 그 학생을 기억 (이름을 다르게 고치면 직접 입력으로)
  const students = await api.listStudents().catch(() => []);
  let student = null;
  const studentSelect = students.length
    ? h(
        'select.input',
        {
          onchange: () => {
            student = students.find((st) => st.id === studentSelect.value) || null;
            if (student) studentInput.value = student.name;
            else studentInput.focus();
          },
        },
        h('option', { value: '' }, '직접 입력'),
        students.map((st) => h('option', { value: st.id }, [st.name, [st.school, st.grade].filter(Boolean).join(' ')].filter(Boolean).join(' · '))),
      )
    : null;
  studentInput.addEventListener('input', () => {
    if (student && studentInput.value.trim() !== student.name) {
      student = null;
      studentSelect.value = '';
    }
  });
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
    studentSelect ? h('div.field-v', h('span', '학생 이름'), h('div.student-pick', studentInput, studentSelect)) : h('label.field-v', h('span', '학생 이름'), studentInput),
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
          const name = studentInput.value.trim();
          const title = titleInput.value.trim() || (name ? `${name} 오답노트` : '오답노트');
          return { title, student: name, studentId: student?.id || '', bookIds: books.filter((b) => picked.has(b.id)).map((b) => b.id) };
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

// ---------------------------------------------------------------------------
/** 학생 등록 / 고치기: 이름·학교·학년·메모 */
async function editStudent(st = null) {
  const nameInput = h('input.input', { value: st?.name || '', placeholder: '학생 이름' });
  const schoolInput = h('input.input', { value: st?.school || '', placeholder: '예: 한빛고' });
  const gradeInput = h('input.input', { value: st?.grade || '', placeholder: '예: 고2' });
  const memoInput = h('textarea.input', { rows: 3, placeholder: '예: 함수 단원이 약해요 (선택)' }, st?.memo || '');
  const r = await modal({
    title: st ? '학생 정보 고치기' : '새 학생',
    body: h(
      'div.form',
      h('label.field-v', h('span', '학생 이름'), nameInput),
      h('div.form-2', h('label.field-v', h('span', '학교'), schoolInput), h('label.field-v', h('span', '학년'), gradeInput)),
      h('label.field-v', h('span', '메모'), memoInput),
    ),
    buttons: [
      { label: '취소', value: null },
      {
        label: st ? '저장' : '등록',
        primary: true,
        onClick: async () => {
          const name = nameInput.value.trim();
          if (!name) {
            toast('학생 이름을 적어 주세요.', { type: 'error' });
            return false;
          }
          try {
            await api.saveStudent({ id: st?.id, name, school: schoolInput.value.trim(), grade: gradeInput.value.trim(), memo: memoInput.value.trim() });
          } catch (err) {
            toast(`저장하지 못했어요: ${errMsg(err)}`, { type: 'error' });
            return false;
          }
          return true;
        },
      },
    ],
  });
  if (r) showHome({ tab: 'students' });
}

async function deleteStudent(st) {
  if (!(await confirmDialog(`"${st.name}" 학생을 명단에서 지울까요?\n이 학생으로 만든 오답노트는 그대로 남아요.`, { title: '학생 삭제', ok: '삭제', danger: true }))) return;
  try {
    await api.deleteStudent(st.id);
  } catch (err) {
    toast(`지우지 못했어요: ${errMsg(err)}`, { type: 'error' });
    return;
  }
  showHome({ tab: 'students' });
}
