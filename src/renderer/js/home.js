// 첫 화면: 학생 오답노트 목록 / 책장(등록한 책) / 학생 명단

import { h, clear, toast, modal, confirmDialog, promptDialog, formatDate, icon, countUp, animateOut } from './ui.js';
import { api, state, nav, dropSources, liveBook, stopJobs, errMsg } from './shared.js';
import { topbar } from './chrome.js';
import { SUBJECTS, subjectOf, subjectName, contractedSubjects } from './subjects.js';
import { bankView, rememberBankView } from './bankview.js';

let homeTab = 'notes';
let shelf = 'mine'; // 책장 안 (학원 공간에서만): mine 내 책장 | shared 공유 책장
// 학생 오답노트 · 학생 명단 탭에서 보던 것 (실시간으로 다시 그려도 그대로)
let openSid = null; // 학생 오답노트 탭에서 연 학생 (id, '' 학생 미지정). null 이면 학생 목록
let noteQ = ''; // 학생 오답노트 탭 검색어
let rosterQ = ''; // 학생 명단 탭 검색어
let scope = null; // mine 내 담당 | all 전체 (null: 아직 안 고름 → 내 담당 학생이 있으면 mine)
let showGone = false; // 학생 명단: 지운 학생 보기

const DAY = 86400000;
const stMeta = (st) => [st.school, st.grade].filter(Boolean).join(' · ');
const initial = (name) => String(name || '').trim().slice(0, 1) || '?';
/** 검색어(소문자)가 학생 이름·학교·학년에 들어 있는지 */
const matchStudent = (st, q) => !q || [st.name, st.school, st.grade].some((v) => String(v || '').toLowerCase().includes(q));

/** 지운 학생이 완전히 지워지기까지 */
function purgeText(st) {
  const at = st.purgeAt || st.deletedAt + (state.appInfo.purgeDays || 30) * DAY;
  const days = Math.ceil((at - Date.now()) / DAY);
  return days > 0 ? `${days}일 뒤 완전 삭제` : '곧 완전 삭제';
}

/** 통합 클라우드가 낮은 버전이라 학원 명단을 못 받음 */
const rosterNotice = () => h('div.readonly-banner.roster-notice', icon('warn'), h('span', '학생 명단을 받으려면 통합 클라우드를 업데이트하세요.'));

/** 탭마다 위쪽 제목·설명 */
function heroText(key) {
  const { academy, purgeDays } = state.appInfo;
  if (key === 'bank') return ['문제은행', '학원 안에서 함께 써요.'];
  if (key === 'books') return ['책장', academy ? '공유 책장은 다른 선생님의 책이에요.' : ''];
  if (key === 'students') return ['학생 명단', academy ? `학원 공용 명단이에요. 삭제 후 ${purgeDays || 30}일 안에 복구해요.` : ''];
  return ['학생 오답노트', ''];
}

export async function showHome({ tab } = {}) {
  if (tab) homeTab = tab;
  const [notes, books, students] = await Promise.all([api.listNotes(), api.listBooks(), api.listStudents()]);
  const bookById = new Map(books.map((b) => [b.id, b]));
  const { roster, purgeDays = 30 } = state.appInfo;
  const cloud = roster === 'cloud'; // 학원 명단 (담당 선생님·지운 학생이 있음)
  const myId = state.appInfo.user?.id || '';
  const stById = new Map(students.map((st) => [st.id, st]));
  const active = students.filter((st) => !st.deletedAt);
  // 학생마다 오답노트 (새것 먼저). 학생을 안 정했거나 명단에 없는 학생이면 '' (학생 미지정)
  const notesOf = new Map();
  for (const n of notes) {
    const sid = stById.has(n.studentId) ? n.studentId : '';
    if (!notesOf.has(sid)) notesOf.set(sid, []);
    notesOf.get(sid).push(n);
  }
  const isMine = (st) => !!myId && st.teacher?.id === myId;
  const mineCount = active.filter(isMine).length;
  const curScope = () => scope || (mineCount ? 'mine' : 'all');
  const inScope = (st) => !cloud || curScope() === 'all' || isMine(st);
  // 연 학생이 명단에서 없어졌으면(완전히 지움 등) 학생 목록으로
  if (openSid && !stById.has(openSid)) openSid = null;
  if (openSid === '' && !notesOf.has('')) openSid = null;
  // 검색칸에 쓰던 중이었으면 다시 그린 뒤에도 이어서
  const focused = document.activeElement;
  const typing = focused?.matches?.('.home-search input') ? [focused.selectionStart, focused.selectionEnd] : null;
  const root = document.getElementById('app');
  rememberBankView();
  clear(root);
  state.view = 'home';

  const body = h('section.home-body');
  const segBtn = (key, ic, label, n) =>
    h(`button.seg-tab${homeTab === key ? '.active' : ''}`, { dataset: { tab: key }, onclick: () => switchTab(key) }, icon(ic), h('span', label), h('span.seg-count', String(n)));
  const thumb = h('span.seg-thumb');
  const tabs = h('nav.seg-tabs', thumb, segBtn('notes', 'notebook', '학생 오답노트', notes.length), segBtn('books', 'library', '책장', books.filter((b) => !b.library).length), segBtn('bank', 'layers', '문제은행', books.reduce((n, b) => n + (b.problemCount || 0), 0)), segBtn('students', 'user', '학생 명단', active.length));
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
  if (typing) {
    const input = body.querySelector('.home-search input');
    input?.focus();
    input?.setSelectionRange(...typing);
  }

  async function switchTab(key) {
    if (key === homeTab) {
      // 학생 화면에서 학생 오답노트 탭을 또 누르면 학생 목록으로
      if (key === 'notes' && openSid != null) {
        openSid = null;
        renderBody();
      }
      return;
    }
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
    rememberBankView();
    clear(body);
    body.classList.remove('swap-in');
    void body.offsetWidth;
    body.classList.add('swap-in');
    if (homeTab === 'notes') body.append(notesView());
    else if (homeTab === 'bank') body.append(bankView(books));
    else if (homeTab === 'students') body.append(studentsView());
    else body.append(booksGrid());
  }

  /**
   * 검색칸 + 내 담당/전체 (학원 명단에서만) + extra. 검색어·담당을 바꾸면 refill (목록만 다시 그림)
   * → { el, seg }
   */
  function toolbar({ value, placeholder, onInput, refill, extra = null }) {
    const input = h('input.input', { type: 'search', value, placeholder, autocomplete: 'off', spellcheck: 'false' });
    input.addEventListener('input', () => {
      onInput(input.value);
      refill();
    });
    const scopeBtn = (key, label, n) => h(`button${curScope() === key ? '.active' : ''}`, { dataset: { scope: key }, onclick: () => setScope(key) }, label, h('span.mini-count', String(n)));
    const seg = cloud ? h('div.seg-toggle.scope-seg', scopeBtn('mine', '내 담당', mineCount), scopeBtn('all', '전체', active.length)) : null;
    function setScope(key) {
      if (key === curScope()) return;
      scope = key;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.scope === key));
      refill();
    }
    return { el: h('div.home-tools', h('label.home-search', icon('search'), input), h('span.spacer'), seg, extra), seg };
  }

  // ---- 학생 오답노트 탭: 학생 목록 → 한 학생의 오답노트 ----
  function notesView() {
    if (roster === 'missing') return h('div.home-stack', rosterNotice(), notesGrid(notes));
    if (openSid != null) return groupView(openSid);
    const list = h('div.home-list');
    const refill = (quiet = true) => {
      clear(list).classList.toggle('quiet', quiet); // 글자마다 카드가 다시 떠오르지 않게
      list.append(...groupList());
    };
    const tools = toolbar({ value: noteQ, placeholder: '학생 이름·학교·학년, 오답노트 제목으로 찾기', onInput: (v) => (noteQ = v), refill });
    refill(false);
    return h('div.home-stack', tools.el, list);
  }

  /** 새 오답노트, 학생 카드 (오답노트가 있는 학생 먼저 — 최근에 고친 순, 나머지는 이름순), 학생 미지정, 지운 학생 */
  function groupList() {
    const q = noteQ.trim().toLowerCase();
    const has = (v) => String(v || '').toLowerCase().includes(q);
    // 학생 이름·학교·학년이 맞으면 true, 아니면 제목(미지정은 적어 둔 학생 이름도)이 맞는 오답노트 (카드에 보여 줌)
    const hitOf = (st, list) => (st ? matchStudent(st, q) : !q) || list.find((n) => has(n.title) || (!st && has(n.student))) || null;
    const groups = [];
    for (const st of students) {
      const list = notesOf.get(st.id) || [];
      if (!inScope(st) || (st.deletedAt && !list.length)) continue;
      const hit = hitOf(st, list);
      if (hit) groups.push({ st, list, hit: hit === true ? null : hit });
    }
    const recent = (a, b) => (b.list[0]?.updatedAt || 0) - (a.list[0]?.updatedAt || 0);
    const live = groups.filter((g) => !g.st.deletedAt);
    const shown = [...live.filter((g) => g.list.length).sort(recent), ...live.filter((g) => !g.list.length)];
    const gone = groups.filter((g) => g.st.deletedAt).sort(recent);
    const loose = notesOf.get('') || [];
    const looseHit = loose.length ? hitOf(null, loose) : null;
    let i = 1;
    const out = [h('div.card-grid', newNoteCard(), shown.map((g) => groupCard(g, i++)), looseHit ? groupCard({ st: null, list: loose, hit: looseHit === true ? null : looseHit }, i++) : null)];
    if (!shown.length) {
      const why = q ? `"${noteQ.trim()}"에 맞는 학생이 없어요.` : active.length ? '내 담당 학생이 없어요. [전체]에서 찾아요.' : '아직 등록한 학생이 없어요.';
      out.push(h('p.muted.home-hint', why));
    }
    if (gone.length) {
      out.push(
        h(
          'section.gone-section',
          h('div.gone-head', h('h3', '지운 학생'), h('span.muted.small', `보기만 가능해요. 학생 삭제 ${purgeDays}일 뒤 오답노트도 완전히 지워져요.`)),
          h('div.card-grid', gone.map((g) => groupCard(g, i++))),
        ),
      );
    }
    return out;
  }

  function teacherLine(st) {
    return h('div.creator.sg-teacher', icon('user'), st.teacher?.name ? `담당 ${st.teacher.name}${isMine(st) ? ' (나)' : ''}` : '담당 없음');
  }

  /** 학생 카드 (st 가 없으면 학생 미지정). hit: 검색어가 제목에 맞은 오답노트 */
  function groupCard({ st, list, hit }, i) {
    const sid = st?.id || '';
    const open = () => openGroup(sid);
    return h(
      `div.card.student-group${st ? '' : '.loose'}${st?.deletedAt ? '.gone' : ''}`,
      { tabIndex: 0, dataset: { student: sid }, onclick: open, onkeydown: (e) => e.key === 'Enter' && open(), style: { '--i': Math.min(i, 14) } },
      h('div.nc-top', h('span.nc-avatar', st ? initial(st.name) : icon('files')), h('div.nc-who', h('div.nc-title', st ? st.name : '학생 미지정'), h('div.nc-student', st ? stMeta(st) || '학교·학년 없음' : '학생을 정하지 않은 오답노트'))),
      st?.deletedAt ? h('div.purge-badge', icon('trash'), purgeText(st)) : st && cloud ? teacherLine(st) : null,
      hit ? h('div.sg-hit', icon('search'), h('span', hit.title)) : null,
      h('div.nc-foot', h('span.sg-count', list.length ? ['노트 ', h('b', String(list.length)), '개'] : '노트 없음'), h('span.nc-date', list.length ? formatDate(list[0].updatedAt) : '')),
    );
  }

  function openGroup(sid) {
    openSid = sid;
    renderBody();
    root.querySelector('main.home')?.scrollTo({ top: 0 });
  }

  /** 한 학생의 오답노트 (지운 학생은 보기만) */
  function groupView(sid) {
    const st = sid ? stById.get(sid) : null;
    const gone = !!st?.deletedAt;
    const sub = st ? [stMeta(st), cloud ? (st.teacher?.name ? `담당 ${st.teacher.name}` : '담당 없음') : ''].filter(Boolean).join(' · ') || '학교·학년 없음' : '학생을 정하지 않은 오답노트예요.';
    const back = () => {
      openSid = null;
      renderBody();
    };
    return h(
      'div.home-stack',
      h(
        `div.student-head${st ? '' : '.loose'}`,
        h('button.btn.back-list', { onclick: back }, icon('back'), '학생 목록'),
        h('span.nc-avatar', st ? initial(st.name) : icon('files')),
        h('div.sh-who', h('h2', st ? st.name : '학생 미지정'), h('p', sub)),
        gone ? h('span.purge-badge', icon('trash'), purgeText(st)) : null,
      ),
      gone ? h('div.readonly-banner', icon('eye'), h('span', '지운 학생의 노트예요. 학생 명단에서 복구하면 고칠 수 있어요.')) : null,
      notesGrid(notesOf.get(sid) || [], { newCard: !gone, student: st }),
    );
  }

  /** 새 오답노트 카드 (student: 그 학생을 골라 둔 채로) */
  function newNoteCard(student = null) {
    return h(
      'button.card.card-new',
      { onclick: () => createNote(books, { student }), style: { '--i': 0 } },
      h('div.new-plus', icon('plus')),
      h('div.cn-title', '새 오답노트'),
      h('div.cn-sub', !books.length ? '책 등록이 필요해요' : student ? `` : ''),
    );
  }

  function notesGrid(list, { newCard = true, student = null } = {}) {
    return h('div.card-grid', newCard ? newNoteCard(student) : null, list.map((n, i) => noteCard(n, i + 1)));
  }

  function noteCard(n, i) {
    const statNum = h('strong');
    countUp(statNum, n.selectedCount);
    const name = stById.get(n.studentId)?.name || n.student;
    // 학생 폴더의 오답노트를 다른 사람이 마지막으로 고쳤으면
    const editor = n.shared && n.updatedBy?.id && n.updatedBy.id !== myId ? n.updatedBy.name || '다른 사람' : '';
    return h(
      'div.card.note-card',
      {
        tabIndex: 0,
        onclick: () => nav.note(n.id),
        onkeydown: (e) => e.key === 'Enter' && nav.note(n.id),
        style: { '--i': Math.min(i, 14) },
      },
      h('div.nc-top', h('span.nc-avatar', initial(name || n.title)), h('div.nc-who', h('div.nc-title', n.title), h('div.nc-student', name ? `${name} 학생` : '학생 이름 없음'))),
      // 원장이 보는 다른 선생님 오답노트: 누구 것인지 (열면 보기·내보내기만)
      n.mine === false ? h('div.creator', icon('user'), `${n.ownerName || '다른'} 선생님`) : null,
      editor ? h('div.creator', icon('edit'), `고친 사람: ${editor}`) : null,
      h(
        'div.nc-books',
        n.bookIds.length
          ? n.bookIds.map((id) => {
              const b = bookById.get(id);
              return h('span.book-pill', { title: b ? null : '지워졌거나 다른 선생님의 나만 보기 교재예요' }, b?.name || '볼 수 없는 교재');
            })
          : h('span.muted.small', '책 없음'),
      ),
      h('div.nc-foot', h('span.nc-count', statNum, '문항 고름'), h('span.nc-date', formatDate(n.updatedAt))),
      n.canEdit
        ? h(
            'div.card-actions',
            h('button.btn.btn-ghost.btn-small', { title: '', onclick: (e) => { e.stopPropagation(); renameNote(n); } }, icon('edit'), '이름 변경'),
            h('button.btn.btn-ghost.btn-small', { title: '', onclick: (e) => { e.stopPropagation(); deleteNote(n); } }, icon('trash'), '삭제'),
          )
        : null,
    );
  }

  // ---- 학생 명단 탭 ----
  function studentsView() {
    if (roster === 'missing') return h('div.home-stack', rosterNotice());
    if (!cloud) showGone = false;
    const goneCount = students.filter((st) => st.deletedAt).length;
    const list = h('div.home-list');
    const refill = (quiet = true) => {
      clear(list).classList.toggle('quiet', quiet);
      list.append(...(showGone ? goneList() : rosterList()));
    };
    // 지운 학생은 담당과 상관없이 모두 (내 담당/전체는 잠금)
    const lockScope = () => tools.seg?.querySelectorAll('button').forEach((b) => (b.disabled = showGone));
    const goneBtn = cloud
      ? h(
          `button.btn.btn-small.gone-toggle${showGone ? '.btn-active' : ''}`,
          {
            onclick: () => {
              showGone = !showGone;
              goneBtn.classList.toggle('btn-active', showGone);
              lockScope();
              refill(false);
            },
          },
          icon('trash'),
          `지운 학생 (${goneCount})`,
        )
      : null;
    const tools = toolbar({ value: rosterQ, placeholder: '학생 이름·학교·학년으로 찾기', onInput: (v) => (rosterQ = v), refill, extra: goneBtn });
    lockScope();
    refill(false);
    return h('div.home-stack', tools.el, list);
  }

  function rosterList() {
    const q = rosterQ.trim().toLowerCase();
    const shown = active.filter((st) => inScope(st) && matchStudent(st, q));
    const out = [
      h(
        'div.card-grid',
        h(
          'button.card.card-new',
          { onclick: () => editStudent(), style: { '--i': 0 } },
          h('div.new-plus', icon('plus')),
          h('div.cn-title', '새 학생'),
          h('div.cn-sub', ''),
        ),
        shown.map((st, i) => rosterCard(st, i + 1)),
      ),
    ];
    if (!shown.length && active.length) out.push(h('p.muted.home-hint', q ? `"${rosterQ.trim()}"에 맞는 학생이 없어요.` : '내 담당 학생이 없어요. [전체]에서 찾아요.'));
    return out;
  }

  function rosterCard(st, i) {
    const by = st.updatedBy?.name ? `고친 사람: ${st.updatedBy.name}` : st.createdBy?.name ? `등록: ${st.createdBy.name}` : '';
    const edit = () => editStudent(st);
    return h(
      `div.card.student-card.roster-card${st.canEdit ? '.can-edit' : ''}`,
      {
        tabIndex: st.canEdit ? 0 : null,
        dataset: { student: st.id },
        onclick: st.canEdit ? edit : null,
        onkeydown: st.canEdit ? (e) => e.key === 'Enter' && edit() : null,
        style: { '--i': Math.min(i, 14) },
      },
      h('div.nc-top', h('span.nc-avatar', initial(st.name)), h('div.nc-who', h('div.nc-title', st.name), h('div.nc-student', stMeta(st) || '학교·학년 없음'))),
      cloud ? teacherLine(st) : null,
      st.memo ? h('div.sc-memo', st.memo) : null,
      h('div.nc-foot', by ? h('span.creator', by) : h('span'), h('span.nc-date', formatDate(st.updatedAt))),
      st.canEdit
        ? h(
            'div.card-actions',
            h('button.btn.btn-ghost.btn-small', { title: '', onclick: (e) => { e.stopPropagation(); edit(); } }, icon('edit'), '정보 수정'),
            h('button.btn.btn-ghost.btn-small', { title: '', onclick: (e) => { e.stopPropagation(); deleteStudent(st); } }, icon('trash'), '삭제'),
          )
        : null,
    );
  }

  /** 지운 학생 (최근에 지운 학생 먼저) — 되살리기만 */
  function goneList() {
    const q = rosterQ.trim().toLowerCase();
    const shown = students.filter((st) => st.deletedAt && matchStudent(st, q)).sort((a, b) => b.deletedAt - a.deletedAt);
    if (!shown.length) {
      return [h('div.empty-state', h('h3', q ? '맞는 학생이 없어요' : '지운 학생이 없어요'), h('p.muted', `삭제 ${purgeDays}일 뒤 오답노트도 완전히 지워져요.`))];
    }
    return [
      h(
        'div.card-grid',
        shown.map((st, i) => {
          const k = (notesOf.get(st.id) || []).length;
          return h(
            'div.card.student-card.roster-card.gone',
            { dataset: { student: st.id }, style: { '--i': Math.min(i, 14) } },
            h('div.nc-top', h('span.nc-avatar', initial(st.name)), h('div.nc-who', h('div.nc-title', st.name), h('div.nc-student', stMeta(st) || '학교·학년 없음'))),
            h('div.purge-badge', icon('trash'), purgeText(st)),
            st.memo ? h('div.sc-memo', st.memo) : null,
            h('div.nc-foot', h('span.creator', k ? `오답노트 ${k}개` : '오답노트 없음'), h('button.btn.btn-small.restore-btn', { onclick: (e) => restoreStudent(st, e.currentTarget) }, icon('refresh'), '되살리기')),
          );
        }),
      ),
    ];
  }

  // 학원 공간: 내 책장(내가 만든 책 — 학원 공유든 나만 보기든) / 공유 책장(다른 선생님이 학원에 공유한 책). 학원이 없으면 책장 하나
  function booksGrid() {
    if (!state.appInfo.academy) return bookCards(books.filter((b) => !b.library), true);
    const mine = books.filter((b) => !b.library && b.mine);
    const others = books.filter((b) => !b.library && !b.mine);
    const shelfBtn = (key, ic, label, n) =>
      h(`button.seg-tab${shelf === key ? '.active' : ''}`, { dataset: { shelf: key }, onclick: () => switchShelf(key) }, icon(ic), h('span', label), h('span.seg-count', String(n)));
    const tabs = h('nav.seg-tabs.shelf-tabs', h('span.seg-thumb'), shelfBtn('mine', 'user', '내 책장', mine.length), shelfBtn('shared', 'school', '공유 책장', others.length));
    const holder = h('div.shelf-body', shelfBody());
    requestAnimationFrame(() => placeSegThumb(tabs));
    return h('div.shelf', tabs, holder);

    function shelfBody() {
      if (shelf === 'mine') return bookCards(mine, true);
      if (!others.length) return h('div.empty-state', h('h3', '아직 공유된 책이 없어요'));
      return bookCards(others, false);
    }

    async function switchShelf(key) {
      if (key === shelf) return;
      shelf = key;
      tabs.querySelectorAll('.seg-tab').forEach((b) => b.classList.toggle('active', b.dataset.shelf === key));
      placeSegThumb(tabs);
      await animateOut(holder, 'leave-fade', 160);
      holder.classList.remove('leave-fade', 'swap-in');
      clear(holder).append(shelfBody());
      void holder.offsetWidth;
      holder.classList.add('swap-in');
    }
  }

  /** 책 카드들 (withNew: 맨 앞에 새 책 등록) */
  function bookCards(list, withNew) {
    const academy = state.appInfo.academy;
    // 과목 표시: 학원이 여러 과목을 계약했거나 수학이 아닌 교재가 있을 때만 (수학만 쓰는 학원은 예전 그대로)
    const showSubject = contractedSubjects(state.appInfo).length > 1 || books.some((b) => subjectOf(b) !== 'math' || b.subjectOpen === false);
    return h(
      'div.card-grid',
      withNew
        ? h(
            'button.card.card-new',
            { onclick: createBook, style: { '--i': 0 } },
            h('div.new-plus', icon('bookPlus')),
            h('div.cn-title', '새 책 등록'),
            h('div.cn-sub', ''),
          )
        : null,
      list.map((b, i) =>
        h(
          `div.card.book-card${b.subjectOpen === false ? '.subject-closed' : ''}`,
          {
            tabIndex: 0,
            onclick: () => nav.book(b.id),
            onkeydown: (e) => e.key === 'Enter' && nav.book(b.id),
            style: { '--i': Math.min(i + 1, 14) },
          },
          h('div.bc-title', b.name),
          showSubject
            ? h(
                'div.bc-subject',
                h('span.subject-badge', { dataset: { subject: subjectOf(b) } }, subjectName(subjectOf(b))),
                b.subjectOpen === false ? h('span.subject-closed-note', { title: '학원이 이 과목을 계약하지 않아서 보기만 할 수 있어요' }, icon('eye'), '계약 없음 · 보기만') : null,
              )
            : null,
          // 내 책: 학원 공유인지 / 다른 선생님 책: 누가 만들었는지
          academy && b.mine
            ? h(`div.share-badge${b.shared ? '' : '.private'}`, icon(b.shared ? 'school' : 'user'), b.shared ? '학원 공유' : state.appInfo.manager ? '나만 보기' : '나만 보기 (원장 볼 수 있음)')
            : academy && b.createdBy
              ? h('div.creator', `생성자: ${b.createdBy.name || '알 수 없음'}`)
              : null,
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
          // 고칠 수 없는 책(다른 선생님이 만든 책)은 이름 바꾸기·삭제 대신 내 책으로 복사. 계약 빠진 과목은 둘 다 없음
          b.subjectOpen === false
            ? null
            : b.canEdit
            ? h(
                'div.card-actions',
                h('button.btn.btn-ghost.btn-small', { title: '', onclick: (e) => { e.stopPropagation(); renameBook(b); } }, icon('edit'), '이름 변경'),
                h('button.btn.btn-ghost.btn-small', { title: '', onclick: (e) => { e.stopPropagation(); deleteBook(b, notes); } }, icon('trash'), '삭제'),
              )
            : h('div.card-actions', h('button.btn.btn-ghost.btn-small', { title: '', onclick: (e) => { e.stopPropagation(); copyBook(b, e.currentTarget); } }, icon('files'), '내 책으로 복사')),
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
/** 새 책: 이름 + 과목 (학원이 계약한 과목만 고를 수 있음) */
async function createBook() {
  const allowed = contractedSubjects(state.appInfo);
  if (!allowed.length) {
    await modal({
      title: '새 책 등록',
      body: h('p.modal-text', '계약한 과목이 없어 등록할 수 없어요. 원장님께 계약 과목을 확인하세요.'),
      buttons: [{ label: '확인', value: null, primary: true }],
    });
    return;
  }
  const input = h('input.input', { placeholder: '책 이름 (예: 쎈 수학Ⅰ, 수능특강 영어)' });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.closest('.modal').querySelector('.btn-primary').click();
  });
  let subject = allowed[0];
  const closed = SUBJECTS.filter((s) => !allowed.includes(s.code)).map((s) => s.name);
  // 과목이 하나뿐이면 고를 것 없이 보여만 줌
  const pick =
    allowed.length === 1
      ? h('div.subject-pick.one', h('span.subject-badge', { dataset: { subject } }, subjectName(subject)))
      : h(
          'div.subject-pick',
          allowed.map((code) =>
            h(
              'label.subject-opt',
              h('input', { type: 'radio', name: 'new-book-subject', value: code, checked: code === subject, onchange: () => (subject = code) }),
              h('span.subject-badge', { dataset: { subject: code } }, subjectName(code)),
            ),
          ),
        );
  const r = await modal({
    title: '새 책 등록',
    body: h(
      'div.form',
      h('label.field-v', h('span', '책 이름'), input),
      h('div.field-v', h('span', '과목'), pick, closed.length ? h('p.small.muted', `${closed.join('·')}은(는) 학원 계약에 없어서 고를 수 없어요.`) : null),
    ),
    buttons: [
      { label: '취소', value: null },
      { label: '등록', primary: true, onClick: () => ({ name: input.value, subject }) },
    ],
  });
  if (!r) return;
  let book;
  try {
    book = await api.createBook(r.name, undefined, r.subject);
  } catch (err) {
    toast(`책을 등록하지 못했어요: ${errMsg(err)}`, { type: 'error', timeout: 8000 });
    return;
  }
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
  const msg = `"${b.name}"의 파일·분석 결과가 모두 지워져요.${using.length ? ` 오답노트 ${using.length}개에서도 이 책의 문항이 빠져요.` : ''}`;
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
  shelf = 'mine'; // 복사본은 내 책장에
  if (state.view === 'home') showHome({ tab: 'books' }); // 받는 동안 다른 화면으로 갔으면 그대로
}

/** 새 오답노트: 제목·학생 이름·책 고르기 (student: 학생 화면에서 열면 그 학생을 골라 둠) */
export async function createNote(allBooks, { student: preset = null } = {}) {
  // 학원이 계약하지 않은 과목의 교재는 새 오답노트에 쓸 수 없음 (보기만)
  const books = allBooks.filter((b) => b.subjectOpen !== false);
  if (!books.length && allBooks.length) {
    await modal({
      title: '쓸 수 있는 교재가 없어요',
      body: h('p.modal-text', '현재 교재는 계약에 없는 과목이에요. 계약한 과목의 교재를 등록하세요.'),
      buttons: [{ label: '확인', value: null, primary: true }],
    });
    return;
  }
  if (!books.length) {
    const go = await confirmDialog('아직 등록한 책이 없어요.', { title: '책이 없어요', ok: '책 등록하기' });
    if (go) {
      homeTab = 'books';
      shelf = 'mine';
      await createBook();
    }
    return;
  }
  const titleInput = h('input.input', { placeholder: '예: 1학기 중간고사 대비 오답', value: '' });
  const student = studentSearch((await api.listStudents().catch(() => [])).filter((st) => !st.deletedAt), { picked: preset });
  const picked = new Set(books.length === 1 ? [books[0].id] : []);
  const manySubjects = new Set(books.map(subjectOf)).size > 1;
  const list = h(
    'div.book-pick',
    books.map((b) =>
      h(
        `label.book-opt${picked.has(b.id) ? '.on' : ''}`,
        h('input', {
          type: 'checkbox',
          checked: picked.has(b.id),
          onchange: (e) => {
            if (e.target.checked) picked.add(b.id);
            else picked.delete(b.id);
            e.target.closest('.book-opt').classList.toggle('on', e.target.checked);
          },
        }),
        h('span.bo-name', b.name),
        h('span.bo-meta', [manySubjects ? subjectName(subjectOf(b)) : '', b.problemCount ? `${b.problemCount}문항` : '분석 전'].filter(Boolean).join(' · ')),
        h('span.bo-check', icon('check')),
      ),
    ),
  );
  const body = h(
    'div.form',
    student.field,
    h('label.field-v', h('span', '오답노트 제목'), titleInput),
    h('div.field-v', h('span', '어떤 책에서 고를까요? (여러 권 가능)'), list),
  );
  const asked = modal({
    title: '새 오답노트',
    body,
    width: 520,
    onClose: () => student.close(),
    buttons: [
      { label: '취소', value: null },
      {
        label: '만들기',
        primary: true,
        onClick: () => {
          if (!picked.size) {
            toast('책을 하나 이상 고르세요.', { type: 'error' });
            return false;
          }
          const name = student.input.value.trim();
          const title = titleInput.value.trim() || (name ? `${name} 오답노트` : '오답노트');
          return { title, student: name, studentId: student.picked()?.id || '', bookIds: books.filter((b) => picked.has(b.id)).map((b) => b.id) };
        },
      },
    ],
  });
  if (preset) titleInput.focus(); // 학생은 골라 뒀으니 제목부터
  const r = await asked;
  if (!r) return;
  const note = await api.createNote(r);
  await nav.note(note.id);
}

const STUDENT_MAX = 50; // 찾은 학생 목록에 보이는 수 (더 있으면 더 적게)

/**
 * 학생 이름 칸 + 학생 명단에서 찾기: 이름·학교·학년 일부를 적으면 맞는 학생 목록 (↑↓ Enter 로 고르고 Esc 로 닫음, 눌러도 고름).
 * 고르면 이름을 채우고 그 학생을 기억, 이름을 다르게 고치면 직접 입력으로. 명단이 비었으면 이름 칸만.
 * students 는 고를 수 있는 학생만 (지운 학생 빼고), picked: 처음부터 골라 둘 학생
 * → { field, input, picked(): 고른 학생 | null, close() }
 */
export function studentSearch(students, { picked: preset = null } = {}) {
  const input = h('input.input', { placeholder: students.length ? '학생 이름 (명단에서 찾기)' : '학생 이름', autocomplete: 'off' });
  let picked = null;
  if (!students.length) {
    if (preset) {
      picked = preset;
      input.value = preset.name || '';
    }
    return { field: h('label.field-v', h('span', '학생 이름'), input), input, picked: () => picked, close() {} };
  }
  const meta = (st) => [st.school, st.grade].filter(Boolean).join(' · ');
  const list = h('div.student-results', { role: 'listbox', hidden: true });
  const info = h('div.student-picked', { hidden: true });
  let shown = [];
  let active = -1;
  let shownQ = null; // 지금 목록을 만든 검색어
  // 목록이 열려 있으면 Esc 는 목록만 닫음 (창을 닫는 모달의 Esc 보다 먼저 받음)
  const onEsc = (e) => {
    if (e.key !== 'Escape' || list.hidden) return;
    e.stopPropagation();
    e.preventDefault();
    close();
  };
  function close() {
    list.hidden = true;
    active = -1;
    shownQ = null;
    window.removeEventListener('keydown', onEsc, true);
  }
  function open() {
    const q = input.value.trim().toLowerCase();
    if (q === shownQ && !list.hidden) return; // 한글 조합이 끝날 때 같은 검색어로 또 옴 → 고르던 자리 그대로
    shownQ = q;
    const has = (v) => String(v || '').toLowerCase().includes(q);
    const rank = (st) => (String(st.name || '').toLowerCase().startsWith(q) ? 0 : has(st.name) ? 1 : 2); // 이름이 맞는 학생 먼저
    shown = q ? students.filter((st) => has(st.name) || has(st.school) || has(st.grade)).sort((a, b) => rank(a) - rank(b)).slice(0, STUDENT_MAX + 1) : [];
    if (!shown.length) return close();
    const more = shown.length > STUDENT_MAX;
    shown = shown.slice(0, STUDENT_MAX);
    active = -1;
    clear(list).append(
      ...shown.map((st, i) =>
        h(
          'div.student-opt',
          { role: 'option', onmousedown: (e) => { e.preventDefault(); pick(st); }, onmousemove: () => active !== i && setActive(i) },
          h('span.so-name', st.name),
          h('span.so-meta', meta(st)),
        ),
      ),
    );
    if (more) list.append(h('div.student-more', `${STUDENT_MAX}명까지 보여요. 이름을 더 적으세요.`));
    list.hidden = false;
    list.scrollTop = 0;
    window.addEventListener('keydown', onEsc, true);
  }
  function setActive(i) {
    active = i;
    list.querySelectorAll('.student-opt').forEach((el, k) => {
      el.classList.toggle('active', k === i);
      el.setAttribute('aria-selected', String(k === i));
    });
    list.querySelectorAll('.student-opt')[i]?.scrollIntoView({ block: 'nearest' });
  }
  function pick(st) {
    picked = st;
    input.value = st.name;
    clear(info).append(icon('check'), `명단의 학생${meta(st) ? ` · ${meta(st)}` : ''}`);
    info.hidden = false;
    close();
  }
  input.addEventListener('input', () => {
    if (picked && input.value.trim() !== picked.name) {
      picked = null;
      info.hidden = true;
    }
    open();
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if (e.key === 'ArrowDown' && input.value.trim() && !picked) {
        e.preventDefault();
        open();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((active + 1) % shown.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active <= 0 ? shown.length - 1 : active - 1);
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      if (active >= 0) pick(shown[active]);
      else close();
    }
  });
  input.addEventListener('blur', close);
  // 고르지 않았어도 명단에 이름이 똑같은 학생이 한 명뿐이면 그 학생
  const exact = () => {
    const same = students.filter((st) => st.name === input.value.trim());
    return same.length === 1 ? same[0] : null;
  };
  if (preset) pick(preset);
  return { field: h('div.field-v', h('span', '학생 이름'), h('div.student-search', input, list), info), input, picked: () => picked || exact(), close };
}

async function renameNote(n) {
  const name = await promptDialog('새 제목', { title: '오답노트 제목 바꾸기', value: n.title });
  if (!name) return;
  try {
    const note = await api.getNote(n.id);
    const base = structuredClone(note); // 그사이 다른 사람이 고쳤으면 합쳐서 저장
    note.title = name.trim();
    note.updatedAt = Date.now();
    await api.saveNote(note, base);
  } catch (err) {
    toast(`제목을 바꾸지 못했어요: ${errMsg(err)}`, { type: 'error' });
  }
  showHome();
}

async function deleteNote(n) {
  if (!(await confirmDialog(`"${n.title}" 오답노트를 삭제할까요?\n고른 문항 목록만 지워지고, 책장의 책은 그대로 남아요.`, { title: '오답노트 삭제', ok: '삭제', danger: true }))) return;
  try {
    await api.deleteNote(n.id);
  } catch (err) {
    toast(`지우지 못했어요: ${errMsg(err)}`, { type: 'error' });
  }
  showHome();
}

// ---------------------------------------------------------------------------
/** 학생 등록 / 고치기: 이름·학교·학년·담당 선생님(학원 명단)·메모 */
async function editStudent(st = null) {
  const { roster, user } = state.appInfo;
  const cloud = roster === 'cloud';
  const nameInput = h('input.input', { value: st?.name || '', placeholder: '학생 이름' });
  const schoolInput = h('input.input', { value: st?.school || '', placeholder: '예: 한빛고' });
  const gradeInput = h('input.input', { value: st?.grade || '', placeholder: '예: 고2' });
  const memoInput = h('textarea.input', { rows: 3, placeholder: '예: 함수 단원이 약해요 (선택)' }, st?.memo || '');
  // 담당 선생님: 학원 사람 중에서 (새 학생은 나). 담당이 학원을 나간 사람이면 그 이름도 남겨 둠
  let teacherSel = null;
  if (cloud) {
    const members = await api.listMembers().catch(() => []);
    const left = st?.teacher?.id && !members.some((m) => m.id === st.teacher.id) ? st.teacher : null;
    teacherSel = h(
      'select.input',
      h('option', { value: '' }, '담당 없음'),
      members.map((m) => h('option', { value: m.id }, m.roleLabel ? `${m.name} · ${m.roleLabel}` : m.name)),
      left ? h('option', { value: left.id }, `${left.name || '알 수 없음'} (학원에 없음)`) : null,
    );
    teacherSel.value = st ? st.teacher?.id || '' : members.some((m) => m.id === user?.id) ? user.id : '';
  }
  const form = h(
    'div.form',
    h('label.field-v', h('span', '학생 이름'), nameInput),
    h('div.form-2', h('label.field-v', h('span', '학교'), schoolInput), h('label.field-v', h('span', '학년'), gradeInput)),
    teacherSel ? h('label.field-v', h('span', '담당 선생님'), teacherSel) : null,
    h('label.field-v', h('span', '메모'), memoInput),
  );
  const r = await modal({
    title: st ? '학생 정보 고치기' : '새 학생',
    body: form,
    buttons: [
      { label: '취소', value: null },
      {
        label: st ? '저장' : '등록',
        primary: true,
        onClick: async () => {
          const name = nameInput.value.trim();
          if (!name) {
            toast('학생 이름을 적으세요.', { type: 'error' });
            return false;
          }
          const btn = form.closest('.modal')?.querySelector('.modal-footer .btn-primary');
          if (btn) btn.disabled = true; // 통합 클라우드가 답할 때까지 두 번 누르지 않게
          try {
            await api.saveStudent({ id: st?.id, rev: st?.rev, name, school: schoolInput.value.trim(), grade: gradeInput.value.trim(), memo: memoInput.value.trim(), teacherId: teacherSel ? teacherSel.value : undefined });
          } catch (err) {
            if (btn) btn.disabled = false;
            toast(`저장하지 못했어요: ${errMsg(err)}`, { type: 'error' });
            // 그사이 다른 사람이 고쳤거나 지웠으면 창을 닫고 새 명단으로 (명단은 이미 새로 읽혀 있음)
            if (st && cloud) {
              const now = (await api.listStudents().catch(() => [])).find((x) => x.id === st.id);
              if (!now || now.rev !== st.rev || now.deletedAt) return 'stale';
            }
            return false;
          }
          return true;
        },
      },
    ],
  });
  if (r && state.view === 'home') showHome({ tab: 'students' });
}

async function deleteStudent(st) {
  const { roster, purgeDays = 30 } = state.appInfo;
  const cloud = roster === 'cloud';
  const msg = cloud
    ? `"${st.name}" 학생을 지울까요?\n학원 사람 누구나 ${purgeDays}일 안에 되살릴 수 있어요. 그 뒤에는 이 학생의 오답노트도 함께 완전히 지워져요.`
    : `"${st.name}" 학생을 명단에서 지울까요?\n이 학생으로 만든 오답노트는 그대로 남아요.`;
  if (!(await confirmDialog(msg, { title: '학생 삭제', ok: '삭제', danger: true }))) return;
  try {
    await api.deleteStudent(st.id);
    if (cloud) toast(`"${st.name}" 학생을 지웠어요.`, { type: 'success', actions: [{ label: '되돌리기', onClick: () => restoreStudent(st) }] });
  } catch (err) {
    toast(`지우지 못했어요: ${errMsg(err)}`, { type: 'error' });
  }
  if (state.view === 'home') showHome(); // 못 지웠어도 새 명단으로
}

/** 지운 학생 되살리기 (학원 명단) */
async function restoreStudent(st, btn = null) {
  if (btn) btn.disabled = true; // 통합 클라우드가 답할 때까지
  try {
    await api.restoreStudent(st.id);
    toast(`"${st.name}" 학생을 되살렸어요.`, { type: 'success' });
  } catch (err) {
    toast(`되살리지 못했어요: ${errMsg(err)}`, { type: 'error' });
  }
  if (state.view === 'home') showHome();
}
