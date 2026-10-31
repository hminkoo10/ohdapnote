// 오답노트 화면 컨트롤러

import { h, clear, toast, modal, confirmDialog, promptDialog, debounce, formatDate, icon } from './ui.js';
import { openDocSource, projectFileUrl } from './docsource.js';
import { analyzeDocument, parsePageRange, reanalyzeSinglePage, detectPageWithGemini, replacePageItems } from './analyze.js';
import { buildPdf, makeBlocks, SPACE_OPTIONS, DEFAULT_EXPORT_OPTIONS } from './exporter.js';
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
    toast(`저장하지 못했습니다: ${err.message}`, { type: 'error' });
  }
};
const saveSoon = debounce(saveNow, 600);
function markDirty() {
  setSaveStatus('저장 중…');
  saveSoon();
}
function setSaveStatus(text) {
  const el = document.querySelector('.save-status');
  if (el) el.textContent = text;
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
  api.onUpdateStatus((s) => {
    state.update = s;
    renderUpdateBadge();
    if (s.status === 'downloaded') {
      toast(`새 버전 ${s.version} 이(가) 준비됐습니다.`, {
        type: 'success',
        timeout: 0,
        actions: [{ label: '지금 재시작해서 설치', onClick: () => installUpdate() }],
      });
    }
  });
  await showHome();
}

async function installUpdate() {
  if (state.project) {
    saveSoon.cancel();
    await saveNow();
  }
  api.installUpdate();
}

function topbar(left, right) {
  return h('header.topbar', h('div.topbar-left', left), h('div.topbar-right', right, h('span.update-badge'), h('button.btn.btn-ghost', { onclick: openSettings, title: '설정' }, icon('gear'), ' 설정')));
}

function renderUpdateBadge() {
  const el = document.querySelector('.update-badge');
  if (!el) return;
  clear(el);
  const s = state.update || {};
  if (s.status === 'downloading') el.append(h('span.badge', `업데이트 다운로드 ${s.percent || 0}%`));
  else if (s.status === 'available') el.append(h('span.badge', `새 버전 ${s.version} 받는 중`));
  else if (s.status === 'downloaded') el.append(h('button.btn.btn-small.btn-primary', { onclick: installUpdate }, `재시작하여 ${s.version} 설치`));
}

// ===========================================================================
// 홈 (오답노트 목록)
// ===========================================================================
async function showHome() {
  await closeProject();
  const projects = await api.listProjects();
  clear(root);
  const list = h(
    'div.project-grid',
    h(
      'button.project-card.new',
      { onclick: createProject },
      h('div.new-plus', icon('plus')),
      h('div.pc-title', '새 오답노트 만들기'),
      h('div.pc-sub', '문제집과 답지 PDF·사진을 올려서 시작'),
    ),
    projects.map((p) =>
      h(
        'div.project-card',
        { onclick: () => openProject(p.id), tabIndex: 0, onkeydown: (e) => e.key === 'Enter' && openProject(p.id) },
        h('div.pc-title', p.name),
        h('div.pc-files', h('div', '📘 ', p.problemFile || '문제집 없음'), h('div', '📗 ', p.answerFile || '답지 없음')),
        h('div.pc-stats', `문항 ${p.problemCount}개 · 해설 ${p.answerCount}개 · 선택 ${p.selectedCount}개`),
        h('div.pc-date', formatDate(p.updatedAt)),
        h(
          'div.pc-actions',
          h('button.btn.btn-ghost.btn-small', { title: '이름 바꾸기', onclick: (e) => { e.stopPropagation(); renameProject(p); } }, icon('edit')),
          h('button.btn.btn-ghost.btn-small', { title: '삭제', onclick: (e) => { e.stopPropagation(); deleteProject(p); } }, icon('trash')),
        ),
      ),
    ),
  );
  root.append(
    topbar(h('div.brand', h('span.brand-mark', '오'), h('span', '오답노트')), null),
    h(
      'main.home',
      h('div.home-hero', h('h1', '내 오답노트'), h('p.muted', '문제집과 답지를 올리면 문제 번호를 자동으로 찾아 표로 만들어 줍니다. 틀린 번호만 골라 문제·해설 PDF로 내보내세요.')),
      list,
      h('p.muted.small.home-foot', `버전 ${state.appInfo.version}`),
    ),
  );
  renderUpdateBadge();
}

async function createProject() {
  const name = await promptDialog('오답노트 이름을 입력하세요. (예: 쎈 수학Ⅰ, 수능특강 미적분)', { title: '새 오답노트', placeholder: '오답노트 이름', ok: '만들기' });
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
  await closeProject();
  const project = await api.getProject(id);
  project.docs ||= { problem: null, answer: null };
  project.selected ||= [];
  project.answerOverrides ||= {};
  project.exportOptions = { ...DEFAULT_EXPORT_OPTIONS, ...(project.exportOptions || {}) };
  state.project = project;
  state.tab = 'select';
  state.filter = { onlySelected: false, query: '' };
  state.docsOpen = null;
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
    toast(`${ROLE_NAME[role]} 파일을 열지 못했습니다: ${err.message}`, { type: 'error', timeout: 8000 });
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
    onchange: (e) => {
      p.name = e.target.value.trim() || p.name;
      markDirty();
    },
  });
  root.append(
    topbar(
      h('div.topbar-project', h('button.btn.btn-ghost', { onclick: showHome, title: '목록으로' }, icon('back'), ' 목록'), nameInput, h('span.save-status.muted.small', '')),
      null,
    ),
    docsSection(),
    h(
      'nav.tabs',
      h(`button.tab${state.tab === 'select' ? '.active' : ''}`, { onclick: () => switchTab('select') }, '문항 선택'),
      h(`button.tab${state.tab === 'review' ? '.active' : ''}`, { onclick: () => switchTab('review') }, '페이지 검토·수정'),
    ),
    h('section.tab-body', state.tab === 'select' ? selectView() : reviewView()),
  );
  renderUpdateBadge();
}

function docsSection() {
  const p = state.project;
  const analyzed = !!p.docs.problem?.analyzedAt;
  const open = state.busy || !analyzed ? true : state.docsOpen ?? false;
  if (open) {
    return h(
      'section.docs-bar',
      ROLES.map((role) => docCard(role)),
      analyzePanel(),
      analyzed && !state.busy
        ? h('button.btn.btn-ghost.btn-small.docs-toggle', { onclick: () => { state.docsOpen = false; renderProject(); }, title: '자료 칸 접기' }, '▲ 접기')
        : null,
    );
  }
  const summary = (role) => {
    const d = p.docs[role];
    if (!d) return h('span.muted', `${role === 'problem' ? '📘' : '📗'} ${ROLE_NAME[role]} 없음`);
    const flagged = Object.values(d.pageInfo || {}).filter((pi) => pi.flags?.length).length;
    return h(
      'span.docs-sum-item',
      `${role === 'problem' ? '📘' : '📗'} `,
      h('strong', d.originalName),
      d.analyzedAt ? h('span.ok-text', ` ${d.items.length}개`) : h('span.muted', ' 분석 전'),
      flagged ? h('span.warn-text', ` · 확인 필요 ${flagged}쪽`) : null,
    );
  };
  return h(
    'section.docs-bar.collapsed',
    summary('problem'),
    summary('answer'),
    h('span.spacer'),
    h('button.btn.btn-small', { onclick: () => { state.docsOpen = true; renderProject(); } }, '▼ 파일·분석 설정 열기'),
  );
}

function switchTab(tab) {
  state.tab = tab;
  renderProject();
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

  card.append(h('div.doc-head', h('span.doc-role', role === 'problem' ? '📘 문제집' : '📗 답지'), doc ? h('button.btn.btn-ghost.btn-small', { onclick: pick, disabled: !!state.busy }, '파일 바꾸기') : null));

  if (!doc) {
    card.append(
      h('button.drop-zone', { onclick: pick, disabled: !!state.busy }, icon('file'), h('div', `${ROLE_NAME[role]} 파일을 끌어다 놓거나 클릭해서 선택`), h('div.muted.small', 'PDF 또는 사진(JPG·PNG) 여러 장')),
    );
    return card;
  }

  const items = doc.items || [];
  const flagged = Object.values(doc.pageInfo || {}).filter((pi) => pi.flags?.length).length;
  card.append(h('div.doc-file', { title: doc.originalName }, doc.originalName), h('div.muted.small', src ? `${src.numPages}쪽` : '불러오는 중…'));

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
      h('label', '분석 쪽 ', rangeInput),
      h('label', '번호 모양 ', styleSelect),
      h('label', { title: '해설이 다음 단이나 다음 쪽으로 넘어가며 이어지는 경우 체크 (답지는 보통 체크)' }, flowCheck, ' 다음 단/쪽으로 이어짐'),
      h('label', { title: 'PDF 1쪽이 책의 몇 쪽인지 (쪽 번호 표시용)' }, 'PDF 1쪽 = 책 ', offsetInput, '쪽'),
    ),
  );

  let status;
  if (busy) {
    const b = state.busy;
    const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
    status = h('div.doc-status', h('div.progress', h('div.progress-bar', { style: { width: `${pct}%` } })), h('div.small', `${b.label} (${b.done}/${b.total})`), h('button.btn.btn-small', { onclick: () => b.abort.abort() }, '취소'));
  } else if (doc.analyzedAt) {
    status = h(
      'div.doc-status',
      h('span.ok-text', icon('check'), ` ${items.length}개 인식`),
      flagged ? h('button.link.warn-text', { onclick: () => { switchTab('review'); editor?.show(role); } }, ` · 확인 필요 ${flagged}쪽`) : null,
      h('span.muted.small', ` · ${formatDate(doc.analyzedAt)}`),
    );
  } else {
    status = h('div.doc-status.muted', '아직 분석하지 않았습니다.');
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
    toast(`${ROLE_NAME[role]} 파일을 올렸습니다. [분석 시작]을 눌러 주세요.`, { type: 'success' });
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
      title: keyOk ? 'Gemini AI 보조 인식' : '설정에서 Gemini API 키를 넣으면 사용할 수 있습니다',
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
    h('button.btn.btn-primary.btn-big', { disabled: !hasAny || !!state.busy, onclick: () => analyzeAll() }, icon('scan'), state.busy ? ' 분석 중…' : ' 분석 시작'),
    h('label.small', 'Gemini 보조 ', geminiSelect),
    keyOk ? null : h('button.link.small', { onclick: openSettings }, 'Gemini 키 설정'),
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
    toast('분석할 쪽이 없습니다. 쪽 범위를 확인하세요.', { type: 'error' });
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
    if (err?.name === 'AbortError') toast('분석을 취소했습니다.');
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
    left.append(
      h(
        'div.empty-state',
        h('h3', !doc ? '문제집 파일을 올려 주세요' : doc.analyzedAt ? '문제 번호를 찾지 못했습니다' : '분석을 시작해 주세요'),
        h(
          'p.muted',
          !doc
            ? '위의 문제집 칸에 PDF(또는 사진)를 끌어다 놓으세요. 답지도 함께 올리면 해설까지 자동으로 짝을 맞춰 줍니다.'
            : doc.analyzedAt
              ? '"페이지 검토·수정" 탭에서 직접 문항을 그리거나, 번호 모양·쪽 범위를 바꿔 다시 분석해 보세요. Gemini 보조 인식도 도움이 됩니다.'
              : '[분석 시작]을 누르면 문제 번호를 자동으로 찾아 표로 보여 줍니다.',
        ),
      ),
    );
    right.append(exportPanel());
    setTimeout(renderExportSummary, 0);
    return view;
  }

  // ---- 도구줄 ----
  const quick = h('input.input', { placeholder: '빠른 선택: 예) 12쪽: 3, 5, 7-9   또는   15, 22' });
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
    if (ids.length) toast(`${ids.length}개 선택했습니다.`);
    if (unknown.length) toast(`찾지 못함: ${unknown.slice(0, 8).join(', ')}`, { type: 'error' });
  };
  quick.addEventListener('keydown', (e) => e.key === 'Enter' && applyQuick());
  left.append(
    h(
      'div.select-toolbar',
      quick,
      h('button.btn', { onclick: applyQuick }, '선택'),
      h('label.check.small', h('input', { type: 'checkbox', checked: state.filter.onlySelected, onchange: (e) => { state.filter.onlySelected = e.target.checked; refreshSelect(); } }), ' 선택한 것만'),
      h('button.btn.btn-ghost.btn-small', { onclick: async () => { if (p.selected.length && (await confirmDialog('선택을 모두 해제할까요?'))) { p.selected = []; markDirty(); refreshSelect(); } } }, '선택 모두 해제'),
    ),
    h('div.legend.small.muted', h('span.chip.demo', '3'), ' 선택 안 됨  ', h('span.chip.demo.on', '3'), ' 선택됨  ', h('span.chip.demo.noans', '3'), ' 답지 짝 없음   · 쪽 번호를 누르면 그 쪽 문항을 모두 선택/해제'),
  );
  const table = h('div.qtable');
  left.append(table);
  right.append(h('div.preview-box'), exportPanel());

  function refreshSelect() {
    renderTable();
    renderExportSummary();
  }

  function renderTable() {
    clear(table);
    const byPage = itemsByPage(doc);
    const sel = new Set(p.selected);
    const hasAnswers = !!p.docs.answer?.items?.length;
    const rows = [];
    for (const [page, items] of byPage) {
      const shown = state.filter.onlySelected ? items.filter((it) => sel.has(it.id)) : items;
      if (!shown.length) continue;
      const allOn = items.every((it) => sel.has(it.id));
      const flagged = doc.pageInfo?.[page]?.flags?.length;
      rows.push(
        h(
          `div.qrow${flagged ? '.flagged' : ''}`,
          h(
            `button.qpage${allOn ? '.on' : ''}`,
            {
              title: `${pageLabel(doc, page)} (PDF ${page + 1}쪽) — 클릭: 이 쪽 전체 선택/해제`,
              onclick: () => {
                const s2 = new Set(p.selected);
                if (allOn) items.forEach((it) => s2.delete(it.id));
                else items.forEach((it) => s2.add(it.id));
                p.selected = [...s2];
                markDirty();
                refreshSelect();
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
                  title: `${pageLabel(doc, it.page)} ${it.number}번${hasAnswers && !ans ? ' (답지 짝 없음)' : ''}`,
                  onclick: () => {
                    const s2 = new Set(p.selected);
                    if (s2.has(it.id)) s2.delete(it.id);
                    else s2.add(it.id);
                    p.selected = [...s2];
                    markDirty();
                    state.focus = it.id;
                    refreshSelect();
                    renderPreview();
                  },
                  onmouseenter: () => schedulePreview(it.id),
                },
                it.number,
              );
            }),
          ),
          flagged ? h('span.qflag', { title: doc.pageInfo[page].flags.join(', ') }, icon('warn')) : null,
        ),
      );
    }
    if (!rows.length) table.append(h('p.muted.pad', state.filter.onlySelected ? '선택한 문항이 없습니다.' : '문항이 없습니다.'));
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
  const item = state.focus ? findItem(doc, state.focus) : null;
  const token = ++previewToken;
  clear(box);
  if (!item) {
    box.append(h('div.preview-empty.muted', '번호에 마우스를 올리면 문제와 해설이 여기에 보입니다.'));
    return;
  }
  const ansId = state.matches.get(item.id);
  const ansDoc = p.docs.answer;
  const ans = ansId ? findItem(ansDoc, ansId) : null;
  const width = Math.max(320, Math.round((box.clientWidth || 380) * Math.min(2, window.devicePixelRatio || 1)));

  const probImg = h('img.preview-img', { alt: '' });
  const ansImg = h('img.preview-img', { alt: '' });
  const selected = p.selected.includes(item.id);
  box.append(
    h(
      'div.preview-head',
      h('strong', `${pageLabel(doc, item.page)} ${item.number}번`),
      h('span.muted.small', ` PDF ${item.page + 1}쪽`),
      h('button.btn.btn-small.btn-ghost', { title: '페이지 검토에서 보기', onclick: () => { switchTab('review'); editor.show('problem', item.page, item.id); } }, icon('eye')),
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
        },
      }, selected ? '✓ 선택됨' : '선택'),
    ),
    h('div.preview-scroll', probImg),
  );
  if (ansDoc) {
    // 답지 짝 바꾸기
    const options = sortItems(ansDoc.items || []).filter((a) => a.num === item.num);
    const sel = h(
      'select.input.input-small',
      {
        onchange: (e) => {
          p.answerOverrides[item.id] = e.target.value;
          if (e.target.value === '__auto') delete p.answerOverrides[item.id];
          markDirty();
          rematch();
          document.querySelector(`.chip[data-id="${CSS.escape(item.id)}"]`)?.classList.toggle('noans', !state.matches.get(item.id));
          renderPreview();
        },
      },
      h('option', { value: '__auto' }, '자동 매칭'),
      options.map((a) => h('option', { value: a.id, selected: ans?.id === a.id && Object.prototype.hasOwnProperty.call(p.answerOverrides, item.id) }, `답지 ${pageLabel(ansDoc, a.page)} ${a.number}번`)),
      h('option', { value: '', selected: Object.prototype.hasOwnProperty.call(p.answerOverrides, item.id) && !p.answerOverrides[item.id] }, '해설 없음'),
    );
    box.append(
      h('div.preview-head.ans', h('strong', ans ? `해설: 답지 ${pageLabel(ansDoc, ans.page)} ${ans.number}번` : '해설: 찾지 못함'), sel, ans ? h('button.btn.btn-small.btn-ghost', { title: '답지에서 보기', onclick: () => { switchTab('review'); editor.show('answer', ans.page, ans.id); } }, icon('eye')) : null),
      ans ? h('div.preview-scroll', ansImg) : h('p.muted.small.pad', '답지에서 같은 번호를 찾지 못했습니다. 위 목록에서 직접 고르거나, 페이지 검토에서 답지 영역을 추가하세요.'),
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
  const radio = (name, value, label, current, onChange) =>
    h('label.radio', h('input', { type: 'radio', name, value, checked: current === value, onchange: () => onChange(value) }), ` ${label}`);
  const hasAnswer = !!p.docs.answer?.items?.length;
  return h(
    'div.export-panel',
    h('h3', '내보내기'),
    h('div.export-summary'),
    h(
      'div.export-options',
      h('div.opt-row', h('span.opt-label', '배치'), radio('cols', '1', '1단', String(o.columns), (v) => set('columns', +v)), radio('cols', '2', '2단', String(o.columns), (v) => set('columns', +v))),
      h(
        'div.opt-row',
        h('span.opt-label', '풀이 여백'),
        h('select.input.input-small', { onchange: (e) => set('space', e.target.value) }, Object.entries(SPACE_OPTIONS).map(([k, v]) => h('option', { value: k, selected: o.space === k }, v.label))),
      ),
      h('div.opt-row', h('span.opt-label', '문제+해설'), radio('order', 'append', '문제 모두 → 해설 모두', o.bothOrder, (v) => set('bothOrder', v)), radio('order', 'interleave', '문제·해설 번갈아', o.bothOrder, (v) => set('bothOrder', v))),
      h(
        'div.opt-row',
        h('span.opt-label', '표시'),
        h('label.check', h('input', { type: 'checkbox', checked: o.labels, onchange: (e) => set('labels', e.target.checked) }), ' 쪽·번호 표시'),
        h('label.check', h('input', { type: 'checkbox', checked: o.renumber, onchange: (e) => set('renumber', e.target.checked) }), ' 1, 2, 3… 새 번호'),
      ),
    ),
    h(
      'div.export-buttons',
      h('button.btn.btn-primary', { onclick: () => doExport('problems') }, icon('download'), ' 문제 PDF'),
      h('button.btn.btn-primary', { onclick: () => doExport('answers'), disabled: !hasAnswer, title: hasAnswer ? '' : '답지를 올리고 분석해야 합니다' }, icon('download'), ' 답지 PDF'),
      h('button.btn.btn-primary', { onclick: () => doExport('both'), disabled: !hasAnswer, title: hasAnswer ? '' : '답지를 올리고 분석해야 합니다' }, icon('download'), ' 문제+답지 PDF'),
    ),
  );
}

function renderExportSummary() {
  const el = document.querySelector('.export-summary');
  if (!el) return;
  clear(el);
  const items = selectedItems(state.project);
  const doc = state.project.docs.problem;
  if (!items.length) {
    el.append(h('p.muted.small', '내보낼 문항을 표에서 골라 주세요.'));
    return;
  }
  const noAns = state.project.docs.answer?.items?.length ? items.filter((it) => !state.matches.get(it.id)).length : 0;
  el.append(
    h('div.sel-count', h('strong', `${items.length}개`), ' 선택됨', noAns ? h('span.warn-text.small', ` (해설 없음 ${noAns}개)`) : null),
    h(
      'div.sel-list',
      items.map((it) =>
        h(
          'span.sel-chip',
          { onclick: () => { state.focus = it.id; renderPreview(); }, title: '미리보기' },
          `${pageLabel(doc, it.page)} ${it.number}번`,
          h('button.sel-x', {
            title: '선택 해제',
            onclick: (e) => {
              e.stopPropagation();
              state.project.selected = state.project.selected.filter((x) => x !== it.id);
              markDirty();
              document.querySelector(`.chip[data-id="${CSS.escape(it.id)}"]`)?.classList.remove('on');
              renderExportSummary();
            },
          }, '×'),
        ),
      ),
    ),
  );
}

async function doExport(mode) {
  const p = state.project;
  const items = selectedItems(p);
  if (!items.length) {
    toast('먼저 표에서 문항을 선택하세요.', { type: 'error' });
    return;
  }
  const entries = items.map((it) => {
    const aid = state.matches.get(it.id);
    return { problem: it, answer: aid ? findItem(p.docs.answer, aid) : null };
  });
  const label = (role, it) => pageLabel(p.docs[role], it.page);
  const opts = p.exportOptions;
  const blocks = makeBlocks(mode, entries, opts, label);
  const modeName = { problems: '문제', answers: '해설', both: '문제+해설' }[mode];
  const today = new Date();
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const closeToast = toast(`${modeName} PDF 만드는 중…`, { timeout: 0 });
  try {
    const bytes = await buildPdf({ blocks, sources: state.sources, options: opts, title: `${p.name} · 오답노트 ${modeName} (${items.length}문항)` });
    closeToast();
    const safeName = p.name.replace(/[\\/:*?"<>|]/g, '_');
    const res = await api.savePdf(`${safeName}_오답_${modeName}_${ymd}.pdf`, bytes);
    if (res.canceled) return;
    toast(`저장했습니다: ${res.path}`, {
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
    toast(`PDF를 만들지 못했습니다: ${err.message}`, { type: 'error', timeout: 10000 });
  }
}

// ===========================================================================
// 페이지 검토 화면
// ===========================================================================
function reviewView() {
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
      reanalyzePage,
      geminiPage,
    });
  }
  const wrap = h('div.review-view', editor.el);
  const p = state.project;
  if (!p.docs.problem && !p.docs.answer) {
    return h('div.empty-state', h('h3', '먼저 문제집이나 답지 파일을 올려 주세요.'));
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
    toast(`${items.length}개 찾았습니다.`);
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
    toast('설정에서 Gemini API 키를 먼저 입력하세요.', { type: 'error', actions: [{ label: '설정 열기', onClick: openSettings }] });
    return;
  }
  const close = toast(`Gemini 로 ${pageLabel(doc, page)} 인식 중…`, { timeout: 0 });
  try {
    const found = await detectPageWithGemini(src, page, { role, gemini: { model: s.geminiModel, rpm: s.geminiRpm } });
    close();
    if (!found.length) {
      toast('Gemini 가 이 쪽에서 문항을 찾지 못했습니다.');
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
    toast(`Gemini: ${found.length}개 찾았습니다.`, { type: 'success' });
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
  const updateMsg = h('span.small.muted');
  const showUpdate = (u) => {
    updateMsg.textContent =
      {
        disabled: u.message || '자동 업데이트 꺼짐',
        checking: '확인 중…',
        latest: '최신 버전입니다.',
        available: `새 버전 ${u.version} 다운로드 시작`,
        downloading: `다운로드 중 ${u.percent || 0}%`,
        downloaded: `새 버전 ${u.version} 준비됨 — 재시작하면 설치됩니다.`,
        error: `업데이트 오류: ${u.message || ''}`,
        idle: '',
      }[u.status] || '';
  };
  showUpdate(state.update || {});

  const body = h(
    'div.settings',
    h('h4', 'Gemini AI 보조 인식 (선택)'),
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
    h('h4', '문자 인식(OCR)'),
    h('label.field', h('span', '언어'), ocrSelect),
    h('h4', '프로그램'),
    h('div.field-row', h('span', `버전 ${state.appInfo.version}`), h('button.btn.btn-small', {
      onclick: async () => {
        if (!state.appInfo.isPackaged) {
          updateMsg.textContent = '설치된 프로그램에서만 업데이트를 확인할 수 있습니다.';
          return;
        }
        updateMsg.textContent = '확인 중…';
        showUpdate(await api.checkForUpdates());
      },
    }, '업데이트 확인'), updateMsg),
    h('div.field-row', h('button.btn.btn-small', { onclick: () => api.openDataDir() }, '데이터 폴더 열기'), h('span.small.muted', '오답노트 파일과 분석 결과가 저장되는 곳')),
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
  root.append(h('div.fatal', `시작 중 오류가 발생했습니다: ${err.message}`));
});
