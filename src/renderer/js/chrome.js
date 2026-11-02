// 위쪽 막대, 뒤에서 도는 작업·업데이트 표시, 설정 창

import { h, clear, toast, modal, icon } from './ui.js';
import { api, state, nav, runLeaveHooks, jobs, jobListeners, findJob, confirmStopJobs, errMsg } from './shared.js';
import { aiSettingsCard, academyAiCard } from './aisettings.js';

export const updateListeners = new Set();
const fmtMB = (b) => (b ? `${(b / 1048576).toFixed(1)}MB` : '');

export function topbar(left, right = null) {
  const jobBadge = h('span.job-badge');
  renderJobBadge(jobBadge);
  return h(
    'header.topbar',
    h('div.topbar-left', left),
    h(
      'div.topbar-right',
      right,
      jobBadge,
      h('span.update-badge'),
      h('button.btn.btn-ghost#settings-btn', { onclick: () => openSettings(), title: '설정' }, icon('gear'), h('span', '설정')),
    ),
  );
}

/** 뒤에서 도는 작업 (누르면 진행 창이나 그 책 화면을 다시 열기 — 멈추기도 거기서) */
export function renderJobBadge(el = document.querySelector('.job-badge')) {
  if (!el) return;
  const shown = [...jobs.values()].filter((j) => j.background);
  for (const chip of [...el.children]) if (!shown.some((j) => j.key === chip.dataset.key)) chip.remove();
  for (const job of shown) {
    let chip = [...el.children].find((c) => c.dataset.key === job.key);
    if (!chip) {
      chip = h('button.job-chip', { dataset: { key: job.key }, onclick: () => findJob(job.key)?.open() }, h('span.job-spin'), h('span.job-name'), h('span.job-pct.num'));
      el.append(chip);
    }
    chip.querySelector('.job-name').textContent = job.title;
    chip.querySelector('.job-pct').textContent = job.total ? `${Math.round((job.done / job.total) * 100)}%` : '';
    chip.title = `${job.title}${job.label ? ` — ${job.label}` : ''}\n눌러서 진행 상황 보기 (멈출 수도 있어요)`;
  }
}
jobListeners.add(() => renderJobBadge());

export function renderUpdateBadge() {
  const el = document.querySelector('.update-badge');
  if (!el) return;
  clear(el);
  const s = state.update || {};
  if (s.status === 'downloaded') el.append(h('button.btn.btn-small.btn-primary', { onclick: installUpdate }, icon('refresh'), `재시작하고 ${s.version} 설치`));
}

export async function installUpdate() {
  if (!(await confirmStopJobs('멈추고 다시 시작'))) return;
  await runLeaveHooks();
  api.installUpdate();
}

export function onUpdateStatus(s) {
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
}

// 수식 인식 모델 받기 — 설정 창을 닫아도 계속 받고, 다시 열면 진행이 이어서 보임
const mathocrDl = { running: false, percent: 0, render: null };

/**
 * 설정: 스캔본 수식 인식 (AI 없이). 켜고 끄는 스위치는 없음 — 쓸지는 한글로 내보낼 때 고름
 * 모델 상태 · [모델 받기] (진행 막대 · 취소) — 모델은 설치 파일에 들어 있어서 받기는 개발 실행 때만 보임
 */
function mathOcrCard() {
  const status = h('span.small.muted', '확인하는 중…');
  const getBtn = h('button.btn.btn-small', { onclick: () => install() }, icon('download'), '모델 받기 (약 120MB)');
  const cancelBtn = h('button.btn.btn-small.btn-ghost', { hidden: true, onclick: () => api.mathocrCancelInstall() }, '취소');
  const bar = h('div.progress-bar');
  const progress = h('div.progress.mathocr-progress', { hidden: true }, bar);
  const card = h(
    'section.set-card',
    h('h4', icon('scan'), '스캔본 수식 인식 (AI 없이)'),
    h('p.small.muted', '스캔본 문제를 AI 없이 이 컴퓨터에서 글자·한글 수식으로 옮겨요. 쓸지는 한글(HWPX)로 내보낼 때 고를 수 있어요.'),
    h('div.field-row', getBtn, cancelBtn, status),
    progress,
  );
  const render = async () => {
    if (!card.isConnected && card.dataset.mounted) {
      if (mathocrDl.render === render) mathocrDl.render = null;
      return;
    }
    if (mathocrDl.running) {
      getBtn.hidden = true;
      cancelBtn.hidden = false;
      progress.hidden = false;
      bar.style.width = `${mathocrDl.percent}%`;
      status.textContent = `받는 중… ${mathocrDl.percent}%`;
      return;
    }
    cancelBtn.hidden = true;
    progress.hidden = true;
    let st = null;
    try {
      st = await api.mathocrStatus();
    } catch (err) {
      console.warn('수식 인식 모델 상태를 알지 못함', err);
    }
    if (mathocrDl.running) return render();
    getBtn.hidden = !!st?.installed;
    status.textContent = st?.bundled ? '설치돼 있어요' : st?.installed ? `받아 둠 (${fmtMB(st.bytes)})` : st?.bytes ? '받다 만 파일이 있어요 — 다시 받으면 이어서 받아요' : '아직 받지 않았어요';
  };
  const install = async () => {
    if (mathocrDl.running) return;
    mathocrDl.running = true;
    mathocrDl.percent = 0;
    mathocrDl.render?.();
    const off = api.onMathocrProgress((p) => {
      mathocrDl.percent = Math.max(0, Math.min(100, p.percent || 0));
      mathocrDl.render?.();
    });
    let r;
    try {
      r = await api.mathocrInstall();
    } catch (err) {
      r = { ok: false, error: err.message };
    } finally {
      off();
      mathocrDl.running = false;
    }
    if (r?.ok) toast('수식 인식 모델을 받았어요. 이제 스캔본도 이 컴퓨터에서 옮길 수 있어요.', { type: 'success' });
    else if (!r?.aborted) toast(`수식 인식 모델을 받지 못했어요: ${r?.error || '알 수 없는 오류'}`, { type: 'error', timeout: 8000 });
    await mathocrDl.render?.();
    document.dispatchEvent(new Event('mathocr:changed')); // 오답노트 화면의 한글 내보내기 안내도
  };
  mathocrDl.render = render;
  card.dataset.mounted = '';
  render().then(() => (card.dataset.mounted = '1'));
  return card;
}

/** 설정 화면의 업데이트 카드 (상태에 따라 실시간으로 바뀜) — 새 버전은 통합 클라우드가 받아 둠 */
function updateCard() {
  const card = h('div.update-card');
  const render = (u = state.update || {}) => {
    if (!card.isConnected && card.dataset.mounted) {
      updateListeners.delete(render);
      return;
    }
    card.dataset.mounted = '1';
    clear(card);
    const statusText =
      {
        disabled: '개발 실행에서는 업데이트를 확인하지 않아요.',
        latest: '최신 버전을 쓰고 있어요.',
        downloaded: `새 버전 ${u.version} 준비 완료 — 다시 시작하면 바뀌어요.`,
        idle: '통합 클라우드가 새 버전을 받아 두면 여기에서 알려 드려요.',
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
                disabled: u.status === 'disabled',
                onclick: async () => {
                  state.update = await api.checkForUpdates();
                  render(state.update);
                },
              },
              '업데이트 확인',
            ),
      ),
      h('div.uc-status', statusText),
      u.notes ? h('div.uc-notes', h('div.small.muted', `${u.version} 에서 바뀐 점`), h('pre', u.notes)) : null,
    ];
    card.append(...parts.filter(Boolean));
  };
  updateListeners.add(render);
  render();
  return card;
}

export function applyMotion(motion) {
  document.documentElement.dataset.motion = motion === 'reduce' ? 'reduce' : 'full';
}

export async function openSettings() {
  const s = { ...state.settings };
  const ai = aiSettingsCard(s); // AI 보조 인식 (기본 Gemini, 세부 설정에서 다른 AI)
  const academyAi = academyAiCard(s); // 학원 공용 AI 키 (학원 공간에서만, 고치기는 원장만)
  const ocrSelect = h(
    'select.input',
    [
      ['kor+eng', '한국어+영어 (권장)'],
      ['eng', '영어만 (더 빠름)'],
    ].map(([v, t]) => h('option', { value: v, selected: s.ocrLang === v }, t)),
  );
  const academyInput = h('input.input', { value: s.academy || '', placeholder: '예: 한빛수학학원' });
  const teacherInput = h('input.input', { value: s.teacher || '', placeholder: '예: 김선생' });
  const motionSelect = h(
    'select.input',
    [
      ['full', '켜기 (권장)'],
      ['reduce', '줄이기'],
    ].map(([v, t]) => h('option', { value: v, selected: (s.motion || 'full') === v }, t)),
  );
  motionSelect.addEventListener('change', () => applyMotion(motionSelect.value));
  const body = h(
    'div.settings',
    h('section.set-card',
      h('h4', icon('school'), '내보내기 기본값'),
      h('p.small.muted', 'PDF 시험지 머리에 들어가요. 오답노트마다 따로 바꿀 수도 있어요.'),
      h('label.field', h('span', '학원 이름'), academyInput),
      h('label.field', h('span', '선생님 이름'), teacherInput),
    ),
    ai.card,
    academyAi?.card,
    h('section.set-card',
      h('h4', icon('scan'), '스캔본 글자 인식 (OCR)'),
      h('label.field', h('span', '언어'), ocrSelect),
    ),
    mathOcrCard(),
    h('section.set-card',
      h('h4', icon('gear'), '프로그램'),
      h('label.field', h('span', '애니메이션'), motionSelect),
      updateCard(),
      h('div.field-row', h('button.btn.btn-small', { onclick: () => api.openDataDir() }, icon('folder'), '데이터 폴더 열기'), h('span.small.muted', '교재와 오답노트가 저장되는 곳')),
      h('div.credit', h('span', `오답노트 ${state.appInfo.version}`), h('span.dot'), h('span', `개발 ${state.appInfo.developer || '구현민'}`)),
    ),
  );
  const r = await modal({
    title: '설정',
    body,
    width: 600,
    className: 'settings-modal',
    buttons: [
      { label: '취소', value: null },
      {
        label: '저장',
        primary: true,
        onClick: async () => {
          // 학원 키 먼저 (그래야 아래에서 돌려받는 설정의 academyAi 가 새 키 기준)
          try {
            await academyAi?.save();
          } catch (err) {
            toast(`학원 공용 AI 키를 저장하지 못했어요: ${errMsg(err)}`, { type: 'error', timeout: 8000 });
            return false;
          }
          state.settings = await api.setSettings({
            ...ai.values(),
            ocrLang: ocrSelect.value,
            academy: academyInput.value.trim(),
            teacher: teacherInput.value.trim(),
            motion: motionSelect.value,
          });
          return true;
        },
      },
    ],
  });
  applyMotion(state.settings.motion);
  if (r) nav.refresh?.();
}
