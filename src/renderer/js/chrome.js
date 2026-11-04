// 위쪽 막대, 뒤에서 도는 작업 표시, 설정 창 (업데이트는 통합 클라우드가 맡음)

import { h, toast, modal, icon } from './ui.js';
import { api, state, nav, jobs, jobListeners, findJob, setRestartBusy } from './shared.js';
import { aiSettingsCard } from './aisettings.js';

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
    setRestartBusy('mathocr', true);
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
      setRestartBusy('mathocr', false);
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

/** 통합 클라우드 계정 (이름 · 학원 · 원장/선생님) */
function accountText() {
  const u = state.appInfo.user || {};
  if (!u.name) return '개발 실행';
  const role = { director: '원장', admin: '운영자' }[u.role] || '선생님';
  return [u.name, u.academy, role].filter(Boolean).join(' · ');
}

export function applyMotion(motion) {
  document.documentElement.dataset.motion = motion === 'reduce' ? 'reduce' : 'full';
}

export async function openSettings() {
  const s = { ...state.settings };
  const ai = aiSettingsCard(s); // AI 보조 인식 (학원 AI 또는 내 키 — 기본 Gemini, 세부 설정에서 다른 AI)
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
      h('p.small.muted', 'PDF·한글 시험지 머리에 들어가요. 학원 명단 학생은 담당 선생님 이름이 먼저 들어가고, 오답노트마다 바꿀 수 있어요.'),
      h('label.field', h('span', '학원 이름'), academyInput),
      h('label.field', h('span', '시험지에 쓸 선생님 이름(기본값)'), teacherInput),
    ),
    ai.card,
    h('section.set-card',
      h('h4', icon('scan'), '스캔본 글자 인식 (OCR)'),
      h('label.field', h('span', '언어'), ocrSelect),
    ),
    mathOcrCard(),
    h('section.set-card',
      h('h4', icon('gear'), '프로그램'),
      h('label.field', h('span', '애니메이션'), motionSelect),
      h('div.field', h('span', '통합 클라우드 계정'), h('div.field-row', h('span', accountText()), h('button.btn.btn-small', { onclick: () => api.openCloud() }, '통합 클라우드 열기'))),
      h('p.small.muted', '업데이트는 통합 클라우드가 받아 둬요. 오답노트를 다시 켜면 새 버전으로 바뀌어요.'),
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
