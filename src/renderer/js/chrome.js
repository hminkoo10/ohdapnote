// 위쪽 막대, 뒤에서 도는 작업·업데이트 표시, 설정 창

import { h, clear, toast, modal, icon } from './ui.js';
import { api, state, nav, runLeaveHooks, jobs, jobListeners, findJob, confirmStopJobs } from './shared.js';
import { aiSettingsCard } from './aisettings.js';

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
  if (s.status === 'downloading') el.append(h('span.badge', icon('download'), `업데이트 받는 중 ${s.percent || 0}%`));
  else if (s.status === 'available') el.append(h('span.badge', icon('download'), `새 버전 ${s.version}`));
  else if (s.status === 'downloaded') el.append(h('button.btn.btn-small.btn-primary', { onclick: installUpdate }, icon('refresh'), `재시작하고 ${s.version} 설치`));
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

export function applyMotion(motion) {
  document.documentElement.dataset.motion = motion === 'reduce' ? 'reduce' : 'full';
}

export async function openSettings() {
  const s = { ...state.settings };
  const ai = aiSettingsCard(s); // AI 보조 인식 (기본 Gemini, 세부 설정에서 다른 AI)
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
    h('section.set-card',
      h('h4', icon('scan'), '스캔본 글자 인식 (OCR)'),
      h('label.field', h('span', '언어'), ocrSelect),
    ),
    h('section.set-card',
      h('h4', icon('gear'), '프로그램'),
      h('label.field', h('span', '애니메이션'), motionSelect),
      updateCard(),
      h('div.field-row', h('button.btn.btn-small', { onclick: () => api.openDataDir() }, icon('folder'), '데이터 폴더 열기'), h('span.small.muted', '올린 파일과 분석 결과가 저장되는 곳')),
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
