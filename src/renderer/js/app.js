// 오답노트 화면 컨트롤러

import { h, clear, toast, modal, confirmDialog, promptDialog, debounce, formatDate, icon, logo, animateOut } from './ui.js';
import { openDocSource, projectFileUrl } from './docsource.js';
import { analyzeDocument, parsePageRange, reanalyzeSinglePage, detectPageWithGemini, replacePageItems } from './analyze.js';
import { buildPdf, makeBlocks, itemName, SPACE_OPTIONS, DEFAULT_EXPORT_OPTIONS } from './exporter.js';
import {
  ROLES,
  ROLE_NAME,
  newDoc,
  pageLabel,
  bookPage,
  itemsByPage,
  findItem,
  computeMatches,
  selectedItems,
  normalizeDoc,
  parseQuickSelect,
} from './store.js';
import { sortItems } from './detect.js';
import { createEditor } from './editor.js';

const api = window.ohdap;
const root = document.getElementById('app');

const state = {
  appInfo: null,
  settings: null,
  update: { status: 'idle' },
  project: null,
  sources: { problem: null, answer: null },
  matches: new Map(),
  tab: 'select',
  focus: null, // 미리보기 중인 문제 id
  busy: null, // {role, label, done, total, abort}
  filter: { onlySelected: false, query: '' },
  docsOpen: null, // 자료 칸 펼침 여부 (null = 자동)
};

// ===========================================================================
// 저장
// ===========================================================================
const saveNow = async () => {
  if (!state.project) return;
  state.project.updatedAt = Date.now();
  try {
    await api.saveProject(state.project);
    setSaveStatus('저장됨');
  } catch (err) {
    setSaveStatus('저장 실패');
    toast(`저장하지 못했어요: ${err.message}`, { type: 'error' });
  }
};
const saveSoon = debounce(saveNow, 600);
function markDirty() {
  setSaveStatus('저장 중…');
  saveSoon();
}
function setSaveStatus(text) {
  const el = document.querySelector('.save-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('saving', text.endsWith('…'));
}
window.addEventListener('beforeunload', () => {
  if (state.project) {
    saveSoon.cancel();
    state.project.updatedAt = Date.now();
    api.saveProjectSync(state.project);
  }
});

// ===========================================================================
// 시작
// ===========================================================================
async function boot() {
  if (!api) {
    root.append(h('div.fatal', '이 화면은 오답노트 프로그램 안에서 실행해야 합니다.'));
    return;
  }
  [state.appInfo, state.settings, state.update] = await Promise.all([api.appInfo(), api.getSettings(), api.getUpdateState()]);
  // 천천히 움직이는 배경 빛
  document.body.prepend(h('div.backdrop', h('i'), h('i'), h('i')));
  document.fonts?.load('600 14px "Pretendard Variable"').catch(() => {});
  api.onUpdateStatus((s) => {
    state.update = s;
    renderUpdateBadge();
    updateListeners.forEach((fn) => fn(s));
    if (s.status === 'downloaded') {
      toast(`새 버전 ${s.version}을(를) 받아 두었어요.${s.notes ? `\n${s.notes.split('\n')[0].slice(0, 80)}` : ''}`, {
        type: 'success',
        timeout: 0,
        actions: [{ label: '지금 재시작해서 설치', onClick: () => installUpdate() }],
      });
    }
  });
  await showHome();
}

const updateListeners = new Set();
const fmtMB = (b) => (b ? `${(b / 1048576).toFixed(1)}MB` : '');

/** 설정 화면의 업데이트 카드 (상태에 따라 실시간으로 바뀜) */
function updateCard() {
  const card = h('div.update-card');
  const render = (u = state.update || {}) => {
    if (!card.isConnected && card.dataset.mounted) {
      updateListeners.delete(render);
      return;
    }
    card.dataset.mounted = '1';
    clear(card);
    const packaged = state.appInfo.isPackaged;
    const statusText =
      {
        disabled: '개발 모드에서는 자동 업데이트가 꺼져 있어요.',
        checking: '새 버전이 있는지 확인하는 중…',
        latest: '최신 버전을 쓰고 있어요.',
        available: `새 버전 ${u.version}을(를) 받기 시작했어요.`,
        downloading: `새 버전 ${u.version} 받는 중 · ${u.percent || 0}% ${u.total ? `(${fmtMB(u.transferred)} / ${fmtMB(u.total)})` : ''}`,
        downloaded: `새 버전 ${u.version} 준비 완료 — 다시 시작하면 설치돼요.`,
        error: `업데이트 확인 실패: ${u.message || ''}`,
        idle: packaged ? '프로그램을 켤 때와 4시간마다 자동으로 확인해요.' : '설치한 프로그램에서만 업데이트를 확인할 수 있어요.',
      }[u.status] || '';
    const parts = [
      h(
        'div.uc-head',
        h('span.uc-icon', icon('refresh')),
        h('div', h('strong', '업데이트'), h('div.small.muted', `지금 버전 ${state.appInfo.version}`)),
        h('span.spacer'),
        u.status === 'downloaded'
          ? h('button.btn.btn-small.btn-primary', { onclick: installUpdate }, icon('refresh'), '지금 다시 시작해서 설치')
          : h(
              'button.btn.btn-small',
              {
                disabled: !packaged || ['checking', 'downloading', 'available'].includes(u.status),
                onclick: async () => {
                  state.update = await api.checkForUpdates();
                  render(state.update);
                },
              },
              '업데이트 확인',
            ),
      ),
      h(`div.uc-status${u.status === 'error' ? '.warn-text' : ''}`, statusText),
      u.status === 'downloading' || u.status === 'available' ? h('div.progress', h('div.progress-bar', { style: { width: `${u.percent || 0}%` } })) : null,
      u.notes ? h('div.uc-notes', h('div.small.muted', `${u.version} 에서 바뀐 점`), h('pre', u.notes)) : null,
    ];
    card.append(...parts.filter(Boolean));
  };
  updateListeners.add(render);
  render();
  return card;
}

async function installUpdate() {
  if (state.project) {
    saveSoon.cancel();
    await saveNow();
  }
  api.installUpdate();
}

function topbar(left) {
  return h(
    'header.topbar',
    h('div.topbar-left', left),
    h('div.topbar-right', h('span.update-badge'), h('button.btn.btn-glass#settings-btn', { onclick: openSettings, title: '설정' }, icon('gear'), h('span', '설정'))),
  );
}

function renderUpdateBadge() {
  const el = document.querySelector('.update-badge');
  if (!el) return;
  clear(el);
  const s = state.update || {};
  if (s.status === 'downloading') el.append(h('span.badge', icon('download'), `업데이트 받는 중 ${s.percent || 0}%`));
  else if (s.status === 'available') el.append(h('span.badge', icon('download'), `새 버전 ${s.version}`));
  else if (s.status === 'downloaded') el.append(h('button.btn.btn-small.btn-dark', { onclick: installUpdate }, icon('refresh'), `재시작하고 ${s.version} 설치`));
}

// ===========================================================================
// 홈 (오답노트 목록)
// ===========================================================================
const SPINES = [
  'linear-gradient(180deg, #ffb443, #f2561d)',
  'linear-gradient(180deg, #2fc0aa, #0f6f66)',
  'linear-gradient(180deg, #ff8a70, #c2362a)',
  'linear-gradient(180deg, #6b4a36, #2b1609)',
  'linear-gradient(180deg, #f6c14b, #d9822b)',
  'linear-gradient(180deg, #8e9cff, #4b52c8)',
];
function spineFor(id) {
  let hsh = 0;
  for (const ch of String(id)) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  return SPINES[hsh % SPINES.length];
}

async function showHome() {
  const leaving = animateOut(document.querySelector('main.sheet'), 'leave-down');
  await closeProject();
  const projects = await api.listProjects();
  await leaving;
  const list = h(
    'div.project-grid',
    h(
      'button.project-card.new',
      { onclick: createProject, style: { '--i': 0 } },
      h('div.new-plus', icon('plus')),
      h('div.pc-title', '새 오답노트'),
      h('div.pc-sub', '문제집과 답지를 올려서 시작하기'),
    ),
    projects.map((p, i) =>
      h(
        'div.project-card',
        {
          onclick: () => openProject(p.id),
          tabIndex: 0,
          onkeydown: (e) => e.key === 'Enter' && openProject(p.id),
          style: { '--i': Math.min(i + 1, 12), '--spine': spineFor(p.id) },
        },
        h('div.pc-title', p.name),
        h(
          'div.pc-files',
          h('div', icon('book'), h('span', p.problemFile || '문제집 없음')),
          h('div', icon('bookCheck'), h('span', p.answerFile || '답지 없음')),
        ),
        h(
          'div.pc-stats',
          h('span.pc-stat', `문항 ${p.problemCount}`),
          h('span.pc-stat', `해설 ${p.answerCount}`),
          p.selectedCount ? h('span.pc-stat.hot', `고른 문제 ${p.selectedCount}`) : null,
        ),
        h('div.pc-date', formatDate(p.updatedAt)),
        h(
          'div.pc-actions',
          h('button.btn.btn-ghost.btn-small', { title: '이름 바꾸기', onclick: (e) => { e.stopPropagation(); renameProject(p); } }, icon('edit')),
          h('button.btn.btn-ghost.btn-small', { title: '삭제', onclick: (e) => { e.stopPropagation(); deleteProject(p); } }, icon('trash')),
        ),
      ),
    ),
  );
  {
    clear(root);
    root.append(
      topbar(h('div.brand', logo(), h('span.brand-name', '오답노트'))),
      h(
        'main.home',
        h(
          'div.home-hero',
          h(
            'div',
            h('h1', h('span', '내 ', h('em', '오답노트')), projects.length ? h('span.hero-count', `${projects.length}권`) : null),
            h('p', '문제집과 답지를 올리고 틀린 번호만 고르면, 다시 풀 수 있게 PDF로 묶어 드려요.'),
          ),
        ),
        list,
        h('p.small.home-foot', `버전 ${state.appInfo.version}`),
      ),
    );
    renderUpdateBadge();
  }
}

async function createProject() {
  const name = await promptDialog('어떤 책의 오답노트인가요? (예: 쎈 수학Ⅰ, 수능특강 미적분)', { title: '새 오답노트', placeholder: '오답노트 이름', ok: '만들기' });
  if (name == null) return;
  const project = await api.createProject(name);
  await openProject(project.id);
}

async function renameProject(p) {
  const name = await promptDialog('새 이름', { title: '이름 바꾸기', value: p.name });
  if (!name) return;
  const project = await api.getProject(p.id);
  project.name = name.trim();
  project.updatedAt = Date.now();
  await api.saveProject(project);
  showHome();
}

async function deleteProject(p) {
  if (!(await confirmDialog(`"${p.name}" 오답노트를 삭제할까요?\n올린 파일과 분석 결과가 모두 지워집니다.`, { title: '삭제', ok: '삭제', danger: true }))) return;
  await api.deleteProject(p.id);
  showHome();
}

// ===========================================================================
// 프로젝트 열기/닫기
// ===========================================================================
let editor = null;

async function closeProject() {
  if (state.project) {
    saveSoon.cancel();
    await saveNow();
  }
  state.busy?.abort?.abort();
  state.busy = null;
  for (const role of ROLES) {
    await state.sources[role]?.destroy();
    state.sources[role] = null;
  }
  state.project = null;
  state.focus = null;
  previewCache.clear();
  editor?.reset();
}

async function openProject(id) {
  const leaving = animateOut(document.querySelector('main.home'), 'leave-up');
  await closeProject();
  const project = await api.getProject(id);
  await leaving;
  project.docs ||= { problem: null, answer: null };
  project.selected ||= [];
  project.answerOverrides ||= {};
  project.exportOptions = { ...DEFAULT_EXPORT_OPTIONS, ...(project.exportOptions || {}) };
  state.project = project;
  state.tab = 'select';
  state.filter = { onlySelected: false, query: '' };
  state.docsOpen = null;
  state.anim = { sheet: true };
  renderProject();
  for (const role of ROLES) {
    if (project.docs[role]) await loadSource(role);
  }
  rematch();
  renderProject();
}

async function loadSource(role) {
  const doc = state.project.docs[role];
  await state.sources[role]?.destroy();
  state.sources[role] = null;
  if (!doc) return;
  try {
    const pid = state.project.id;
    const src = await openDocSource(doc.files, (name) => projectFileUrl(pid, name));
    state.sources[role] = src;
    doc.pageCount = src.numPages;
  } catch (err) {
    toast(`${ROLE_NAME[role]} 파일을 열지 못했어요: ${err.message}`, { type: 'error', timeout: 8000 });
  }
}

function rematch() {
  state.matches = state.project ? computeMatches(state.project) : new Map();
}

// ===========================================================================
// 프로젝트 화면
// ===========================================================================
function renderProject() {
  const p = state.project;
  if (!p) return;
  clear(root);
  const nameInput = h('input.title-input', {
    value: p.name,
    title: '이름 바꾸기',
    onchange: (e) => {
      p.name = e.target.value.trim() || p.name;
      markDirty();
    },
  });
  const nSel = p.selected.length;
  const anim = state.anim || {};
  state.anim = null;
  const tab = (key, ic, label, extra) =>
    h(`button.tab${state.tab === key ? '.active' : ''}`, { onclick: () => switchTab(key), dataset: { tab: key } }, icon(ic), h('span', label), extra);
  const thumb = h('span.tab-thumb');
  root.append(
    topbar(h('div.topbar-project', h('button.btn.btn-glass.btn-round#back-btn', { onclick: showHome, title: '목록으로' }, icon('back')), nameInput, h('span.save-status', ''))),
    h(
      `main.sheet${anim.sheet ? '.enter' : ''}`,
      docsSection(anim.docs),
      h(
        'div.tabs-row',
        h(
          'nav.tabs',
          thumb,
          tab('select', 'pointer', '문항 고르기', nSel ? h('span.tab-count', String(nSel)) : null),
          tab('review', 'scan', '페이지 검토·수정'),
        ),
      ),
      h(`section.tab-body${anim.tab ? `.enter-${anim.tab}` : ''}`, state.tab === 'select' ? selectView() : reviewView()),
    ),
  );
  placeThumb(thumb, anim.thumbFrom);
  renderUpdateBadge();
}

/** 탭 아래 흰 표시를 활성 탭으로 미끄러지듯 옮김 */
function placeThumb(thumb, from) {
  const active = thumb.parentElement?.querySelector('.tab.active');
  if (!active) return;
  const to = { x: active.offsetLeft, w: active.offsetWidth };
  if (from) {
    thumb.style.transition = 'none';
    thumb.style.transform = `translateX(${from.x}px)`;
    thumb.style.width = `${from.w}px`;
    void thumb.offsetWidth;
    thumb.style.transition = '';
  }
  thumb.style.transform = `translateX(${to.x}px)`;
  thumb.style.width = `${to.w}px`;
}

function updateTabCount() {
  const tabEl = document.querySelector('.tab[data-tab="select"]');
  if (!tabEl) return;
  const n = state.project.selected.length;
  let c = tabEl.querySelector('.tab-count');
  if (!n) return c?.remove();
  if (!c) {
    c = h('span.tab-count');
    tabEl.append(c);
  }
  c.textContent = String(n);
}

function docsSection(enter) {
  const p = state.project;
  const analyzed = !!p.docs.problem?.analyzedAt;
  const open = state.busy || !analyzed ? true : state.docsOpen ?? false;
  const toggle = async (v) => {
    await animateOut(document.querySelector('.docs-bar'), 'leave-fade', 200);
    state.docsOpen = v;
    state.anim = { docs: true };
    renderProject();
  };
  if (open) {
    return h(
      `section.docs-bar${enter ? '.enter' : ''}`,
      ROLES.map((role) => docCard(role)),
      analyzePanel(),
      analyzed && !state.busy ? h('button.btn.btn-small.docs-toggle', { onclick: () => toggle(false), title: '파일·분석 칸 접기' }, icon('collapse'), '접기') : null,
    );
  }
  const summary = (role) => {
    const d = p.docs[role];
    const ic = h(`span.doc-icon${role === 'answer' ? '.teal' : ''}`, icon(role === 'problem' ? 'book' : 'bookCheck'));
    if (!d) return h('span.docs-sum-item.muted', ic, `${ROLE_NAME[role]} 없음`);
    const flagged = Object.values(d.pageInfo || {}).filter((pi) => pi.flags?.length).length;
    return h(
      'span.docs-sum-item',
      ic,
      h('strong', d.originalName),
      d.analyzedAt ? h('span.ok-text', `${d.items.length}개`) : h('span.muted', '분석 전'),
      flagged ? h('span.warn-text', icon('warn'), `확인 ${flagged}쪽`) : null,
    );
  };
  return h(
    `section.docs-bar.collapsed${enter ? '.enter' : ''}`,
    summary('problem'),
    summary('answer'),
    h('span.spacer'),
    h('button.btn.btn-small', { onclick: () => toggle(true) }, icon('expand'), '파일·분석 설정'),
  );
}

async function switchTab(tab) {
  if (state.tab === tab || state.switching) return;
  const order = ['select', 'review'];
  const dir = order.indexOf(tab) > order.indexOf(state.tab) ? 'right' : 'left';
  const thumbEl = document.querySelector('.tab-thumb');
  const thumbFrom = thumbEl ? { x: thumbEl.offsetLeft + (new DOMMatrix(getComputedStyle(thumbEl).transform).m41 || 0), w: thumbEl.offsetWidth } : null;
  // 표시가 먼저 움직이고, 내용이 옆으로 빠지며 바뀜
  if (thumbEl) {
    const target = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (target) {
      thumbEl.style.transform = `translateX(${target.offsetLeft}px)`;
      thumbEl.style.width = `${target.offsetWidth}px`;
    }
  }
  state.switching = true;
  try {
    await animateOut(document.querySelector('.tab-body'), dir === 'right' ? 'leave-left' : 'leave-right', 220);
    const movedThumb = document.querySelector('.tab-thumb');
    const from = movedThumb ? { x: new DOMMatrix(getComputedStyle(movedThumb).transform).m41 || thumbFrom?.x || 0, w: movedThumb.offsetWidth } : thumbFrom;
    state.tab = tab;
    state.anim = { tab: dir, thumbFrom: from };
    renderProject();
  } finally {
    state.switching = false;
  }
}

// ---------------------------------------------------------------------------
// 문제집/답지 카드
// ---------------------------------------------------------------------------
function docCard(role) {
  const p = state.project;
  const doc = p.docs[role];
  const src = state.sources[role];
  const busy = state.busy && state.busy.role === role;
  const card = h(`div.doc-card${doc ? '' : '.empty'}`, { dataset: { role } });

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
      h('span.doc-title', h(`span.doc-icon${role === 'answer' ? '.teal' : ''}`, icon(role === 'problem' ? 'book' : 'bookCheck')), ROLE_NAME[role]),
      doc ? h('button.btn.btn-ghost.btn-small', { onclick: pick, disabled: !!state.busy }, icon('refresh'), '파일 바꾸기') : null,
    ),
  );

  if (!doc) {
    card.append(
      h(
        'button.drop-zone',
        { onclick: pick, disabled: !!state.busy },
        h('span.dz-icon', icon('upload')),
        h('div.dz-title', '파일을 여기로 끌어오거나 눌러서 고르기'),
        h('div.muted.small', 'PDF 한 개, 또는 사진(JPG·PNG) 여러 장'),
      ),
    );
    return card;
  }

  const items = doc.items || [];
  const flagged = Object.values(doc.pageInfo || {}).filter((pi) => pi.flags?.length).length;
  card.append(h('div.doc-file', { title: doc.originalName }, h('strong', doc.originalName), h('span.muted.small.num', src ? `${src.numPages}쪽` : '여는 중…')));

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
        renderProject();
      }
    },
  });
  card.append(
    h(
      'div.doc-options',
      h('label', '쪽 범위', rangeInput),
      h('label', '번호 모양', styleSelect),
      h('label', { title: 'PDF 1쪽이 책의 몇 쪽인지 (쪽 번호 표시용)' }, 'PDF 1쪽 = 책', offsetInput, '쪽'),
      h('label.check', { title: '해설이 다음 단이나 다음 쪽으로 넘어가며 이어지는 경우 (답지는 보통 켜 둠)' }, flowCheck, '다음 단·쪽으로 이어짐'),
    ),
  );

  let status;
  if (busy) {
    const b = state.busy;
    const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
    status = h('div.doc-status', h('div.progress', h('div.progress-bar', { style: { width: `${pct}%` } })), h('div.small.num', `${b.label} (${b.done}/${b.total})`), h('button.btn.btn-small', { onclick: () => b.abort.abort() }, '취소'));
  } else if (doc.analyzedAt) {
    status = h(
      'div.doc-status',
      h('span.ok-text', icon('circleCheck'), `${items.length}개 찾음`),
      flagged ? h('button.link.warn-text', { onclick: () => { switchTab('review'); getEditor().show(role); } }, icon('warn'), `확인할 쪽 ${flagged}`) : null,
      h('span.muted.small', formatDate(doc.analyzedAt)),
    );
  } else {
    status = h('div.doc-status.muted', '아직 분석 전이에요.');
  }
  card.append(status);
  return card;
}

async function importFiles(role, paths) {
  const p = state.project;
  const old = p.docs[role];
  if (old?.items?.length && !(await confirmDialog(`${ROLE_NAME[role]} 파일을 바꾸면 기존 분석 결과가 지워집니다. 계속할까요?`, { ok: '바꾸기', danger: true }))) return;
  const pdfs = paths.filter((x) => /\.pdf$/i.test(x));
  if (pdfs.length > 1 && !(await confirmDialog(`PDF ${pdfs.length}개를 이름 순서대로 이어 붙여 하나의 ${ROLE_NAME[role]}(으)로 씁니다. 계속할까요?`))) return;
  try {
    const imported = await api.importFiles(p.id, role, paths);
    p.docs[role] = newDoc(role, imported);
    if (role === 'problem') {
      p.selected = [];
      p.answerOverrides = {};
    } else {
      p.answerOverrides = {};
    }
    previewCache.clear();
    await saveNow();
    await loadSource(role);
    rematch();
    renderProject();
    toast(`${ROLE_NAME[role]}을(를) 올렸어요. 이제 [분석 시작]을 눌러 주세요.`, { type: 'success' });
  } catch (err) {
    toast(err.message, { type: 'error', timeout: 8000 });
  }
}

// ---------------------------------------------------------------------------
// 분석
// ---------------------------------------------------------------------------
function analyzePanel() {
  const p = state.project;
  const hasAny = ROLES.some((r) => p.docs[r]);
  const s = state.settings;
  const keyOk = !!s.geminiApiKey;
  const geminiSelect = h(
    'select.input.input-small',
    {
      disabled: !keyOk || !!state.busy,
      title: keyOk ? 'Gemini AI 보조 인식' : '설정에서 Gemini API 키를 넣으면 쓸 수 있어요',
      onchange: async (e) => {
        state.settings = await api.setSettings({ geminiMode: e.target.value });
      },
    },
    [
      ['off', '사용 안 함'],
      ['auto', '애매한 쪽만'],
      ['all', '모든 쪽'],
    ].map(([v, t]) => h('option', { value: v, selected: (keyOk ? s.geminiMode || 'off' : 'off') === v }, t)),
  );
  return h(
    'div.analyze-panel',
    h(`button.btn.btn-primary.btn-big${state.busy ? '.busy' : ''}`, { disabled: !hasAny || !!state.busy, onclick: () => analyzeAll() }, icon('scan'), state.busy ? '분석하는 중…' : '분석 시작'),
    h('label.small', h('span', 'Gemini 보조'), geminiSelect),
    keyOk ? null : h('button.link.small', { onclick: openSettings }, 'Gemini 키 넣기'),
  );
}

async function analyzeAll(roles = ROLES) {
  const p = state.project;
  const targets = roles.filter((r) => p.docs[r] && state.sources[r]);
  if (!targets.length) return;
  const edited = targets.filter((r) => p.docs[r].edited);
  if (edited.length && !(await confirmDialog(`${edited.map((r) => ROLE_NAME[r]).join(', ')}에서 직접 고친 내용이 있습니다. 다시 분석하면 사라집니다. 계속할까요?`, { ok: '다시 분석', danger: true }))) return;
  for (const role of targets) {
    const ok = await analyzeRole(role);
    if (!ok) break;
  }
}

async function analyzeRole(role) {
  const p = state.project;
  const doc = p.docs[role];
  const src = state.sources[role];
  let pages;
  try {
    pages = parsePageRange(doc.range, src.numPages);
  } catch (err) {
    toast(err.message, { type: 'error' });
    return false;
  }
  if (!pages.length) {
    toast('분석할 쪽이 없어요. 쪽 범위를 확인해 주세요.', { type: 'error' });
    return false;
  }
  const abort = new AbortController();
  state.busy = { role, label: '준비 중', done: 0, total: pages.length, abort };
  renderProject();
  const s = state.settings;
  const gemini = s.geminiApiKey && s.geminiMode && s.geminiMode !== 'off' ? { mode: s.geminiMode, model: s.geminiModel, rpm: s.geminiRpm } : null;
  const t0 = Date.now();
  const updateProgress = debounce(() => {
    const card = document.querySelector(`.doc-card[data-role="${role}"] .doc-status`);
    if (!card || !state.busy) return;
    const b = state.busy;
    const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
    card.querySelector('.progress-bar')?.style.setProperty('width', `${pct}%`);
    const t = card.querySelector('.small');
    if (t) t.textContent = `${b.label} (${b.done}/${b.total})`;
  }, 50);
  try {
    const res = await analyzeDocument(src, {
      pages,
      role,
      flow: doc.options.flow,
      numberStyle: doc.options.numberStyle,
      ocrLang: s.ocrLang,
      gemini,
      signal: abort.signal,
      onProgress: ({ done, total, message }) => {
        Object.assign(state.busy, { done, total, label: message });
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
    // 사라진 문항은 선택/짝에서 제거
    const ids = new Set(doc.items.map((it) => it.id));
    if (role === 'problem') {
      p.selected = p.selected.filter((id) => ids.has(id));
      for (const k of Object.keys(p.answerOverrides)) if (!ids.has(k)) delete p.answerOverrides[k];
    } else {
      for (const [k, v] of Object.entries(p.answerOverrides)) if (v && !ids.has(v)) delete p.answerOverrides[k];
    }
    previewCache.clear();
    rematch();
    await saveNow();
    const sec = Math.round((Date.now() - t0) / 1000);
    const flagged = Object.values(doc.pageInfo).filter((pi) => pi.flags?.length).length;
    toast(`${ROLE_NAME[role]}: ${doc.items.length}개 인식 (${sec}초${res.ocrPages ? `, OCR ${res.ocrPages}쪽` : ''})${flagged ? ` · 확인 필요 ${flagged}쪽` : ''}`, { type: 'success', timeout: 6000 });
    if (res.geminiErrors?.length) toast(`Gemini 오류: ${res.geminiErrors[0]}${res.geminiErrors.length > 1 ? ` 외 ${res.geminiErrors.length - 1}건` : ''}`, { type: 'error', timeout: 10000 });
    return true;
  } catch (err) {
    if (err?.name === 'AbortError') toast('분석을 멈췄어요.');
    else {
      console.error(err);
      toast(`분석 중 오류: ${err.message}`, { type: 'error', timeout: 10000 });
    }
    return false;
  } finally {
    state.busy = null;
    renderProject();
  }
}

// ===========================================================================
// 문항 선택 화면
// ===========================================================================
function selectView() {
  const p = state.project;
  const doc = p.docs.problem;
  const view = h('div.select-view');
  const left = h('div.select-main');
  const right = h('aside.select-side');
  view.append(left, right);

  if (!doc || !doc.items?.length) {
    const [title, desc, ic] = !doc
      ? ['문제집부터 올려 주세요', '위 칸에 PDF나 사진을 끌어다 놓으면 됩니다. 답지도 같이 올리면 해설까지 짝을 맞춰 줘요.', 'upload']
      : doc.analyzedAt
        ? ['문제 번호를 찾지 못했어요', '번호 모양이나 쪽 범위를 바꿔 다시 분석하거나, "페이지 검토·수정"에서 직접 문항을 그려 주세요.', 'search']
        : ['이제 분석을 시작하세요', '[분석 시작]을 누르면 쪽마다 문제 번호를 찾아 표로 보여 줍니다.', 'scan'];
    left.append(h('div.empty-state', h('div.empty-art', icon(ic)), h('h3', title), h('p.muted', desc)));
    right.append(h('div.preview-box'), exportPanel());
    setTimeout(() => {
      renderPreview();
      renderExportSummary();
    }, 0);
    return view;
  }

  // ---- 도구줄 ----
  const quick = h('input.input', { placeholder: '빠르게 고르기 — 12쪽: 3, 5, 7-9  또는  15, 22' });
  const applyQuick = () => {
    const text = quick.value.trim();
    if (!text) return;
    const { ids, unknown } = parseQuickSelect(text, doc);
    const set = new Set(p.selected);
    ids.forEach((id) => set.add(id));
    p.selected = [...set];
    markDirty();
    quick.value = '';
    refreshSelect();
    if (ids.length) toast(`${ids.length}문항을 골랐어요.`);
    if (unknown.length) toast(`찾지 못함: ${unknown.slice(0, 8).join(', ')}`, { type: 'error' });
  };
  quick.addEventListener('keydown', (e) => e.key === 'Enter' && applyQuick());
  left.append(
    h(
      'div.select-toolbar',
      h('div.search', icon('search'), quick),
      h('button.btn', { onclick: applyQuick }, '고르기'),
      h('label.check.small', h('input', { type: 'checkbox', checked: state.filter.onlySelected, onchange: (e) => { state.filter.onlySelected = e.target.checked; refreshSelect(); } }), '고른 것만'),
      h('button.btn.btn-ghost.btn-small', { onclick: async () => { if (p.selected.length && (await confirmDialog('고른 문항을 모두 해제할까요?'))) { p.selected = []; markDirty(); refreshSelect(); } } }, '모두 해제'),
    ),
    h(
      'div.legend.small',
      h('span', h('span.chip.demo.on', '3'), '고른 문제'),
      h('span', h('span.chip.demo.noans', '3'), '해설 짝 없음'),
      h('span', '쪽 번호를 누르면 그 쪽 전체 선택'),
    ),
  );
  const table = h('div.qtable');
  left.append(table);
  right.append(h('div.preview-box'), exportPanel());

  function refreshSelect() {
    renderTable();
    renderExportSummary();
    updateTabCount();
  }

  // 한 문항 선택/해제 — 표 전체를 다시 그리지 않고 그 버튼만 바꿈
  function toggleOne(it, page, items) {
    const s2 = new Set(p.selected);
    const on = !s2.has(it.id);
    if (on) s2.add(it.id);
    else s2.delete(it.id);
    p.selected = [...s2];
    markDirty();
    state.focus = it.id;
    if (state.filter.onlySelected && !on) {
      refreshSelect();
    } else {
      const chipEl = table.querySelector(`.chip[data-id="${CSS.escape(it.id)}"]`);
      chipEl?.classList.toggle('on', on);
      table.querySelectorAll('.chip.focus').forEach((c) => c.classList.remove('focus'));
      chipEl?.classList.add('focus');
      table.querySelector(`.qpage[data-page="${page}"]`)?.classList.toggle('on', items.every((x) => s2.has(x.id)));
      renderExportSummary();
      updateTabCount();
    }
    renderPreview();
  }

  function renderTable() {
    clear(table);
    const byPage = itemsByPage(doc);
    const sel = new Set(p.selected);
    const hasAnswers = !!p.docs.answer?.items?.length;
    const rows = [];
    let rowIndex = 0;
    for (const [page, items] of byPage) {
      const shown = state.filter.onlySelected ? items.filter((it) => sel.has(it.id)) : items;
      if (!shown.length) continue;
      const allOn = items.every((it) => sel.has(it.id));
      const flagged = doc.pageInfo?.[page]?.flags?.length;
      rows.push(
        h(
          `div.qrow${flagged ? '.flagged' : ''}`,
          { style: { '--i': Math.min(rowIndex++, 24) } },
          h(
            `button.qpage${allOn ? '.on' : ''}`,
            {
              dataset: { page: String(page) },
              title: `${pageLabel(doc, page)} (PDF ${page + 1}쪽) — 눌러서 이 쪽 전체 선택/해제`,
              onclick: (e) => {
                const s2 = new Set(p.selected);
                const all = items.every((x) => s2.has(x.id));
                if (all) items.forEach((it) => s2.delete(it.id));
                else items.forEach((it) => s2.add(it.id));
                p.selected = [...s2];
                markDirty();
                if (state.filter.onlySelected) return refreshSelect();
                // 그 줄만 바꿈 (표 전체를 다시 그리지 않음)
                e.currentTarget.classList.toggle('on', !all);
                for (const it of items) table.querySelector(`.chip[data-id="${CSS.escape(it.id)}"]`)?.classList.toggle('on', !all);
                renderExportSummary();
                updateTabCount();
              },
            },
            h('span.qpage-num', `${bookPage(doc, page)}`),
            h('span.qpage-unit', '쪽'),
          ),
          h(
            'div.qchips',
            shown.map((it) => {
              const ans = state.matches.get(it.id);
              return h(
                `button.chip${sel.has(it.id) ? '.on' : ''}${hasAnswers && !ans ? '.noans' : ''}${state.focus === it.id ? '.focus' : ''}`,
                {
                  dataset: { id: it.id },
                  title: `${pageLabel(doc, it.page)} ${itemName(it)}${hasAnswers && !ans ? ' (해설 짝 없음)' : ''}`,
                  onclick: () => toggleOne(it, page, items),
                  onmouseenter: () => schedulePreview(it.id),
                },
                it.prefix ? h('span.chip-pre', it.prefix) : null,
                it.number,
              );
            }),
          ),
          flagged ? h('span.qflag', { title: doc.pageInfo[page].flags.join(', ') }, icon('warn')) : null,
        ),
      );
    }
    if (!rows.length) table.append(h('p.muted.pad', state.filter.onlySelected ? '아직 고른 문항이 없어요.' : '문항이 없어요.'));
    table.append(...rows);
  }

  let hoverTimer = null;
  function schedulePreview(id) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (state.focus !== id) {
        state.focus = id;
        table.querySelectorAll('.chip.focus').forEach((c) => c.classList.remove('focus'));
        table.querySelector(`.chip[data-id="${CSS.escape(id)}"]`)?.classList.add('focus');
        renderPreview();
      }
    }, 120);
  }

  renderTable();
  setTimeout(() => {
    renderPreview();
    renderExportSummary();
  }, 0);
  return view;
}

// ---------------------------------------------------------------------------
// 미리보기
// ---------------------------------------------------------------------------
const previewCache = new Map();

async function itemImage(role, item, widthPx) {
  const src = state.sources[role];
  if (!src || !item) return null;
  const key = `${role}|${item.id}|${widthPx}|${JSON.stringify(item.rects)}`;
  if (previewCache.has(key)) return previewCache.get(key);
  const parts = [];
  for (const r of item.rects) {
    const meta = src.pages[r.page];
    if (!meta) continue;
    const pageW = Math.min(2400, Math.round(widthPx / Math.max(0.15, r.w)));
    parts.push(await src.renderRegion(r.page, r, pageW));
  }
  if (!parts.length) return null;
  const W = Math.max(...parts.map((c) => c.width));
  const gap = 8;
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
      ctx.strokeStyle = '#ccc';
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

let previewToken = 0;
async function renderPreview() {
  const box = document.querySelector('.preview-box');
  if (!box) return;
  const p = state.project;
  const doc = p.docs.problem;
  const item = state.focus && doc ? findItem(doc, state.focus) : null;
  const token = ++previewToken;
  clear(box);
  if (!item) {
    box.append(h('div.preview-empty', h('span.pe-icon', icon('eye')), h('div', '번호 위에 마우스를 올리면', h('br'), '문제와 해설을 여기서 볼 수 있어요.')));
    return;
  }
  const ansId = state.matches.get(item.id);
  const ansDoc = p.docs.answer;
  const ans = ansId ? findItem(ansDoc, ansId) : null;
  const width = Math.max(320, Math.round((box.clientWidth || 380) * Math.min(2, window.devicePixelRatio || 1)));

  const imgEl = () => {
    const img = h('img.preview-img', { alt: '' });
    img.addEventListener('load', () => {
      img.classList.add('loaded');
      img.parentElement?.classList.add('ready');
    });
    return img;
  };
  const probImg = imgEl();
  const ansImg = imgEl();
  const selected = p.selected.includes(item.id);
  box.append(
    h(
      'div.preview-head',
      h('span.tag', '문제'),
      h('strong', `${pageLabel(doc, item.page)} ${itemName(item)}`),
      h('span.muted.small', `PDF ${item.page + 1}쪽`),
      h('button.btn.btn-small.btn-ghost.push', { title: '페이지 검토에서 보기', onclick: () => { switchTab('review'); getEditor().show('problem', item.page, item.id); } }, icon('eye')),
      h(`button.btn.btn-small${selected ? '.btn-active' : ''}`, {
        onclick: () => {
          const s2 = new Set(p.selected);
          if (s2.has(item.id)) s2.delete(item.id);
          else s2.add(item.id);
          p.selected = [...s2];
          markDirty();
          document.querySelector(`.chip[data-id="${CSS.escape(item.id)}"]`)?.classList.toggle('on', s2.has(item.id));
          renderPreview();
          renderExportSummary();
          updateTabCount();
        },
      }, selected ? icon('check') : icon('plus'), selected ? '골랐음' : '고르기'),
    ),
    h('div.preview-scroll', probImg),
  );
  if (ansDoc) {
    // 답지 짝 바꾸기
    const options = sortItems(ansDoc.items || []).filter((a) => a.num === item.num);
    const has = Object.prototype.hasOwnProperty.call(p.answerOverrides, item.id);
    const sel = h(
      'select.input.input-small',
      {
        title: '짝이 되는 해설 바꾸기',
        onchange: (e) => {
          p.answerOverrides[item.id] = e.target.value;
          if (e.target.value === '__auto') delete p.answerOverrides[item.id];
          markDirty();
          rematch();
          document.querySelector(`.chip[data-id="${CSS.escape(item.id)}"]`)?.classList.toggle('noans', !state.matches.get(item.id));
          renderPreview();
        },
      },
      h('option', { value: '__auto' }, '자동으로 찾기'),
      options.map((a) => h('option', { value: a.id, selected: has && ans?.id === a.id }, `답지 ${pageLabel(ansDoc, a.page)} ${itemName(a)}`)),
      h('option', { value: '', selected: has && !p.answerOverrides[item.id] }, '해설 없음'),
    );
    box.append(
      h(
        'div.preview-head.ans',
        h('span.tag.teal', '해설'),
        h('strong', ans ? `답지 ${pageLabel(ansDoc, ans.page)} ${itemName(ans)}` : '짝을 못 찾음'),
        h('span.push', sel),
        ans ? h('button.btn.btn-small.btn-ghost', { title: '답지에서 보기', onclick: () => { switchTab('review'); getEditor().show('answer', ans.page, ans.id); } }, icon('eye')) : null,
      ),
      ans ? h('div.preview-scroll', ansImg) : h('p.muted.small.pad', '답지에서 같은 번호를 찾지 못했어요. 위 목록에서 직접 고르거나, 페이지 검토에서 답지 영역을 그려 주세요.'),
    );
  }
  const [pu, au] = await Promise.all([itemImage('problem', item, width), ans ? itemImage('answer', ans, width) : null]);
  if (token !== previewToken) return;
  if (pu) probImg.src = pu;
  if (au) ansImg.src = au;
}

// ---------------------------------------------------------------------------
// 내보내기
// ---------------------------------------------------------------------------
function exportPanel() {
  const p = state.project;
  const o = p.exportOptions;
  const set = (k, v) => {
    o[k] = v;
    markDirty();
  };
  const seg = (name, current, options, onChange) =>
    h(
      'div.seg',
      options.map(([value, label]) =>
        h('label', h('input', { type: 'radio', name, value, checked: String(current) === String(value), onchange: () => onChange(value) }), h('span', label)),
      ),
    );
  const hasAnswer = !!p.docs.answer?.items?.length;
  const needAns = hasAnswer ? '' : '답지를 올리고 분석하면 쓸 수 있어요';
  return h(
    'div.export-panel',
    h('div.export-head', h('h3', 'PDF로 내보내기'), h('div.sel-count')),
    h('div.export-summary'),
    h(
      'div.export-options',
      h('div.opt-row', h('span.opt-label', '배치'), seg('cols', o.columns, [[1, '1단'], [2, '2단']], (v) => set('columns', +v))),
      h('div.opt-row', h('span.opt-label', '풀이 여백'), seg('space', o.space, Object.entries(SPACE_OPTIONS).map(([k, v]) => [k, v.short]), (v) => set('space', v))),
      h(
        'div.opt-row',
        h('span.opt-label', '표시'),
        h('label.check', h('input', { type: 'checkbox', checked: o.labels, onchange: (e) => set('labels', e.target.checked) }), '쪽·번호'),
        h('label.check', h('input', { type: 'checkbox', checked: o.renumber, onchange: (e) => set('renumber', e.target.checked) }), '새 번호 매기기'),
      ),
    ),
    h(
      'div.export-buttons',
      h('button.btn.btn-primary', { onclick: () => doExport('problems'), dataset: { mode: 'problems' }, title: '고른 문제만' }, icon('download'), h('span.eb', h('b', '문제만'))),
      h('button.btn.btn-primary', { onclick: () => doExport('answers'), dataset: { mode: 'answers' }, disabled: !hasAnswer, title: needAns || '고른 문제의 해설만' }, icon('download'), h('span.eb', h('b', '해설만'))),
      h(
        'button.btn.btn-primary',
        { onclick: () => doExport('both-inline'), dataset: { mode: 'both-inline' }, disabled: !hasAnswer, title: needAns || '문제마다 바로 뒤에 그 문제의 해설' },
        icon('download'),
        h('span.eb', h('b', '문제 + 해설'), h('small', '문제마다 바로 뒤에')),
      ),
      h(
        'button.btn.btn-primary',
        { onclick: () => doExport('both-end'), dataset: { mode: 'both-end' }, disabled: !hasAnswer, title: needAns || '문제를 모두 싣고, 해설은 맨 뒤에 모아서' },
        icon('download'),
        h('span.eb', h('b', '문제 + 해설'), h('small', '해설은 맨 뒤에')),
      ),
    ),
  );
}

function renderExportSummary() {
  const el = document.querySelector('.export-summary');
  const countEl = document.querySelector('.export-head .sel-count');
  if (!el) return;
  clear(el);
  const items = selectedItems(state.project);
  const doc = state.project.docs.problem;
  if (countEl) {
    clear(countEl);
    if (items.length) countEl.append(h('strong', String(items.length)), '문항');
  }
  if (!items.length) {
    el.append(h('p.empty-hint', '왼쪽 표에서 틀린 번호를 골라 주세요.'));
    return;
  }
  const noAns = state.project.docs.answer?.items?.length ? items.filter((it) => !state.matches.get(it.id)).length : 0;
  if (noAns) el.append(h('p.warn-text.small', icon('warn'), `해설 짝이 없는 문항 ${noAns}개`));
  el.append(
    h(
      'div.sel-list',
      items.map((it) =>
        h(
          'span.sel-chip',
          { onclick: () => { state.focus = it.id; renderPreview(); }, title: '미리보기' },
          `${pageLabel(doc, it.page)} ${itemName(it)}`,
          h('button.sel-x', {
            title: '빼기',
            onclick: (e) => {
              e.stopPropagation();
              state.project.selected = state.project.selected.filter((x) => x !== it.id);
              markDirty();
              document.querySelector(`.chip[data-id="${CSS.escape(it.id)}"]`)?.classList.remove('on');
              renderExportSummary();
              updateTabCount();
            },
          }, icon('x')),
        ),
      ),
    ),
  );
}

async function doExport(mode) {
  const p = state.project;
  const items = selectedItems(p);
  if (!items.length) {
    toast('먼저 표에서 문항을 골라 주세요.', { type: 'error' });
    return;
  }
  const entries = items.map((it) => {
    const aid = state.matches.get(it.id);
    return { problem: it, answer: aid ? findItem(p.docs.answer, aid) : null };
  });
  const label = (role, it) => pageLabel(p.docs[role], it.page);
  const opts = p.exportOptions;
  const blocks = makeBlocks(mode, entries, opts, label);
  const modeName = { problems: '문제', answers: '해설', 'both-inline': '문제+해설(바로)', 'both-end': '문제+해설(뒤)' }[mode];
  const today = new Date();
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const closeToast = toast(`${modeName} PDF 만드는 중…`, { timeout: 0 });
  try {
    const bytes = await buildPdf({ blocks, sources: state.sources, options: opts, title: `${p.name} · 오답노트 ${modeName} (${items.length}문항)` });
    closeToast();
    const safeName = p.name.replace(/[\\/:*?"<>|]/g, '_');
    const res = await api.savePdf(`${safeName}_오답_${modeName}_${ymd}.pdf`, bytes);
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
  }
}

// ===========================================================================
// 페이지 검토 화면
// ===========================================================================
function getEditor() {
  if (!editor) {
    editor = createEditor({
      project: () => state.project,
      source: (role) => state.sources[role],
      onItemsChanged: (role, item) => {
        normalizeDoc(state.project, role);
        rematch();
        previewCache.clear();
        markDirty();
        return item?.id;
      },
      onSelect: (role, id) => {
        if (role === 'problem') state.focus = id;
      },
      onItemDeleted: (role, item) => {
        // 지운 문항의 ID 가 다른 문항에 다시 쓰이지 않도록 선택/짝 정보에서 먼저 제거
        const p = state.project;
        if (role === 'problem') {
          p.selected = p.selected.filter((id) => id !== item.id);
          delete p.answerOverrides[item.id];
          if (state.focus === item.id) state.focus = null;
        } else {
          for (const [k, v] of Object.entries(p.answerOverrides)) if (v === item.id) delete p.answerOverrides[k];
        }
      },
      reanalyzePage,
      geminiPage,
    });
  }
  return editor;
}

function reviewView() {
  const editor = getEditor();
  const wrap = h('div.review-view', editor.el);
  const p = state.project;
  if (!p.docs.problem && !p.docs.answer) {
    return h('div.empty-state', h('div.empty-art', icon('files')), h('h3', '먼저 파일을 올려 주세요'), h('p.muted', '문제집이나 답지를 올리고 분석하면 여기서 쪽마다 인식 결과를 확인하고 고칠 수 있어요.'));
  }
  const role = p.docs[editor.role] ? editor.role : p.docs.problem ? 'problem' : 'answer';
  requestAnimationFrame(() => editor.show(role, editor.page));
  requestAnimationFrame(() => requestAnimationFrame(() => editor.redraw()));
  return wrap;
}

async function reanalyzePage(role, page) {
  const p = state.project;
  const doc = p.docs[role];
  const src = state.sources[role];
  if (!doc || !src) return;
  const close = toast(`${pageLabel(doc, page)} 다시 인식 중…`, { timeout: 0 });
  try {
    const { items, page: info } = await reanalyzeSinglePage(src, doc, page, { ocrLang: state.settings.ocrLang });
    doc.items = replacePageItems(doc.items, page, items);
    doc.pageInfo[page] = { analyzed: true, source: info.source, blank: info.layout.blank, columns: info.layout.columns.length, flags: [] };
    doc.edited = true;
    normalizeDoc(p, role);
    rematch();
    previewCache.clear();
    markDirty();
    editor.refresh();
    close();
    toast(`${items.length}개 찾았어요.`);
  } catch (err) {
    close();
    toast(`다시 인식 실패: ${err.message}`, { type: 'error' });
  }
}

async function geminiPage(role, page) {
  const p = state.project;
  const doc = p.docs[role];
  const src = state.sources[role];
  const s = state.settings;
  if (!doc || !src) return;
  if (!s.geminiApiKey) {
    toast('설정에서 Gemini API 키를 먼저 넣어 주세요.', { type: 'error', actions: [{ label: '설정 열기', onClick: openSettings }] });
    return;
  }
  const close = toast(`Gemini 로 ${pageLabel(doc, page)} 인식 중…`, { timeout: 0 });
  try {
    const found = await detectPageWithGemini(src, page, { role, gemini: { model: s.geminiModel, rpm: s.geminiRpm } });
    close();
    if (!found.length) {
      toast('Gemini도 이 쪽에서 문항을 찾지 못했어요.');
      return;
    }
    doc.items = replacePageItems(doc.items, page, found);
    doc.pageInfo[page] = { ...(doc.pageInfo[page] || {}), analyzed: true, source: 'gemini', flags: [] };
    doc.edited = true;
    normalizeDoc(p, role);
    rematch();
    previewCache.clear();
    markDirty();
    editor.refresh();
    toast(`Gemini가 ${found.length}개를 찾았어요.`, { type: 'success' });
  } catch (err) {
    close();
    toast(err.message, { type: 'error', timeout: 10000 });
  }
}

// ===========================================================================
// 설정
// ===========================================================================
async function openSettings() {
  const s = { ...state.settings };
  const keyInput = h('input.input', { type: 'password', value: s.geminiApiKey || '', placeholder: 'AIza…', autocomplete: 'off' });
  const modelInput = h('input.input', { value: s.geminiModel || 'gemini-flash-latest', list: 'gemini-models' });
  const modelList = h('datalist#gemini-models');
  const rpmInput = h('input.input.input-tiny', { type: 'number', min: 1, max: 60, value: String(s.geminiRpm || 8) });
  const ocrSelect = h('select.input', [
    ['kor+eng', '한국어+영어 (권장)'],
    ['eng', '영어만 (더 빠름)'],
  ].map(([v, t]) => h('option', { value: v, selected: s.ocrLang === v }, t)));
  const modelMsg = h('span.small.muted');

  const body = h(
    'div.settings',
    h('h4', icon('sparkle'), 'Gemini 보조 인식 (선택)'),
    h(
      'p.small.muted',
      '무료로 쓸 수 있는 Google AI Studio API 키를 넣으면, 자동 인식이 애매한 쪽을 AI로 다시 인식할 수 있습니다. ',
      h('button.link', { onclick: () => api.openExternal('https://aistudio.google.com/apikey') }, 'API 키 받기'),
      ' · 무료 사용량에는 하루/분당 한도가 있고, 무료 등급에서는 보낸 이미지가 Google 서비스 개선에 쓰일 수 있습니다.',
    ),
    h('label.field', h('span', 'API 키'), keyInput),
    h(
      'label.field',
      h('span', '모델'),
      h('div.field-row', modelInput, modelList, h('button.btn.btn-small', {
        onclick: async () => {
          modelMsg.textContent = '불러오는 중…';
          const r = await api.geminiListModels(keyInput.value.trim());
          if (!r.ok) {
            modelMsg.textContent = r.error;
            return;
          }
          clear(modelList);
          r.models.forEach((m) => modelList.append(h('option', { value: m.name }, m.displayName)));
          modelMsg.textContent = `${r.models.length}개 모델 — 입력칸을 눌러 고르세요. (flash 계열 권장)`;
        },
      }, '모델 목록')),
    ),
    modelMsg,
    h('label.field', h('span', '분당 요청 수'), h('div.field-row', rpmInput, h('span.small.muted', '무료 한도를 넘지 않게 천천히 보냅니다'))),
    h('h4', icon('scan'), '스캔본 글자 인식 (OCR)'),
    h('label.field', h('span', '언어'), ocrSelect),
    h('h4', icon('gear'), '프로그램'),
    updateCard(),
    h('div.field-row', h('button.btn.btn-small', { onclick: () => api.openDataDir() }, icon('folder'), '데이터 폴더 열기'), h('span.small.muted', '올린 파일과 분석 결과가 저장되는 곳')),
  );
  const r = await modal({
    title: '설정',
    body,
    width: 560,
    buttons: [
      { label: '취소', value: null },
      {
        label: '저장',
        primary: true,
        onClick: async () => {
          const rpm = Math.max(1, Math.min(60, parseInt(rpmInput.value, 10) || 8));
          state.settings = await api.setSettings({
            geminiApiKey: keyInput.value.trim(),
            geminiModel: modelInput.value.trim() || 'gemini-flash-latest',
            geminiRpm: rpm,
            ocrLang: ocrSelect.value,
          });
          return true;
        },
      },
    ],
  });
  if (r && state.project) renderProject();
}

boot().catch((err) => {
  console.error(err);
  root.append(h('div.fatal', `시작하다가 문제가 생겼어요: ${err.message}`));
});
