// 오답노트 화면 시작점: 화면 이동(첫 화면 ↔ 책 ↔ 오답노트), 설정, 실시간 반영

import { h, toast, ripple, animateOut } from './ui.js';
import { api, state, nav, restartGuard, runLeaveHooks } from './shared.js';
import { openSettings, applyMotion } from './chrome.js';
import { showHome } from './home.js';
import { openBook, bookDataChanged } from './bookview.js';
import { openNote, renderFormatHint, noteDataChanged } from './noteview.js';

const root = document.getElementById('app');
let current = { view: 'home', args: [] };
let navigating = Promise.resolve();

/** 지금 화면을 나가는 애니메이션 → 저장 등 정리 → 새 화면 */
function go(view, fn, ...args) {
  restartGuard.busy('navigation', true);
  navigating = navigating.then(async () => {
    const main = root.querySelector('main');
    const dir = view === 'home' ? 'leave-down' : 'leave-up';
    await Promise.all([animateOut(main, dir, 260), runLeaveHooks()]);
    current = { view, args };
    try {
      await fn(...args);
    } catch (err) {
      console.error(err);
      root.append(h('div.fatal', `화면을 여는 중 문제가 생겼어요: ${err.message}`));
    }
    window.scrollTo(0, 0);
  });
  return navigating.finally(() => restartGuard.busy('navigation', false));
}

function onUpdateAvailable() {
  if (document.getElementById('update-notice')) return;
  const notice = h('div.toasts#update-notice',
    h('div.toast.toast-info', h('div.toast-msg', '새 버전이 설치됐어요. 쉬는 동안 자동으로 다시 켜요.'),
      h('div.toast-actions', h('button.btn.btn-small', {
        onclick: async () => {
          restartGuard.report();
          if (!(await api.requestUpdateRestart())) toast('저장·작업을 마치고 입력 창을 닫은 뒤 다시 켤 수 있어요.', { timeout: 6000 });
        },
      }, '지금 다시 켜기'))));
  document.body.append(notice);
}

nav.home = (opts) => go('home', showHome, opts);
nav.book = (id, opts) => go('book', openBook, id, opts);
nav.note = (id) => go('note', openNote, id);
nav.settings = () => openSettings();
nav.refresh = () => {
  // 설정이 바뀐 뒤 지금 화면 다시 그리기
  if (current.view === 'home') return go('home', showHome);
  if (current.view === 'note') renderFormatHint(); // Gemini 키를 넣거나 뺐으면 한글 내보내기 안내도
  return null;
};

// 서명이 없거나 맞지 않는 settings.json (통합 클라우드가 서명 키를 줄 때만 — src/main/datasign.js)
const SETTINGS_REJECTED = '앱 밖에서 바꾼 설정이라 적용하지 않았어요.';

/** 다른 컴퓨터·선생님이 바꾼 데이터가 들어오면 지금 화면에 반영 */
async function onDataChanged(change) {
  if (change.settings) {
    state.settings = await api.getSettings(); // 학원 AI 가 생기거나 바뀌었을 수도 (통합 클라우드에서 원장이 정함)
    state.appInfo.subjects = (await api.appInfo()).subjects; // 학원이 계약한 과목도 (운영자가 바꿈)
    if (state.view === 'note') renderFormatHint();
  }
  if (change.settingsRejected) toast(SETTINGS_REJECTED, { timeout: 6000 });
  // 화면 이동이 끝난 뒤에 (이동 중인 화면을 덮어쓰지 않게)
  navigating = navigating.then(async () => {
    try {
      if (state.view === 'home') {
        if (!(change.books?.length || change.notes?.length || change.students)) return;
        if (document.querySelector('.modal-overlay:not(.closing)')) return; // 창이 열려 있으면 그대로 둠
        const top = root.querySelector('main.home')?.scrollTop || 0;
        await showHome(); // 보던 탭 그대로
        const main = root.querySelector('main.home');
        if (main) main.scrollTop = top;
      } else if (state.view === 'book') {
        // 기다리지 않음: 책 화면이 첫 화면으로 돌아가면(지워진 책) 그 이동이 이 뒤에 줄을 섬
        restartGuard.track('sync', () => bookDataChanged(change)).catch((err) => console.error(err));
      } else if (state.view === 'note') {
        restartGuard.track('sync', () => noteDataChanged(change)).catch((err) => console.error(err));
      }
    } catch (err) {
      console.error(err);
    }
  });
  await navigating;
}

// 아직 받지 않은 교재 원본을 받는 동안 알림 하나 (책마다 받는 중인 묶음 수)
const fetching = new Map();
let closeFetchToast = null;
function onFilesFetching({ bookId, done }) {
  const n = (fetching.get(bookId) || 0) + (done ? -1 : 1);
  if (n > 0) fetching.set(bookId, n);
  else fetching.delete(bookId);
  if (fetching.size && !closeFetchToast) closeFetchToast = toast('교재 파일 받는 중…', { timeout: 0 });
  else if (!fetching.size && closeFetchToast) {
    closeFetchToast();
    closeFetchToast = null;
  }
}

async function boot() {
  if (!api) {
    root.append(h('div.fatal', '이 화면은 오답노트 프로그램 안에서 실행해야 합니다.'));
    return;
  }
  [state.appInfo, state.settings] = await Promise.all([api.appInfo(), api.getSettings()]);
  if (state.appInfo.settingsRejected) toast(SETTINGS_REJECTED, { timeout: 6000 });
  applyMotion(state.settings.motion);
  document.fonts?.load('600 14px "Pretendard Variable"').catch(() => {});
  api.onDataChanged((change) => restartGuard.track('sync', () => onDataChanged(change)).catch((err) => console.error(err)));
  api.onFilesFetching(onFilesFetching);
  if (state.appInfo.updateRestartEnabled) {
    api.onUpdateAvailable(onUpdateAvailable);
    api.onUpdateRestart(async (request) => {
      if (!(await restartGuard.prepare(request)) && request.manual) toast('저장·작업이 끝나지 않아 다시 켜기를 미뤘어요.', { timeout: 6000 });
    });
    for (const type of ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel', 'input']) {
      window.addEventListener(type, () => restartGuard.activity(), { capture: true, passive: true });
    }
    window.addEventListener('pagehide', () => restartGuard.stop());
  }
  // 누른 자리에서 퍼지는 물결
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.btn, .export-btn, .card, .seg-tab, .book-tab');
    if (el && !el.disabled) ripple({ currentTarget: el, clientX: e.clientX, clientY: e.clientY });
  });
  await showHome();
  if (state.appInfo.updateRestartEnabled) await restartGuard.start();
}

boot().catch((err) => {
  console.error(err);
  root.append(h('div.fatal', `시작하다가 문제가 생겼어요: ${err.message}`));
});
