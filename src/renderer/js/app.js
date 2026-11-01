// 오답노트 화면 시작점: 화면 이동(첫 화면 ↔ 책 ↔ 오답노트), 설정, 업데이트 알림

import { h, ripple, animateOut } from './ui.js';
import { api, state, nav, runLeaveHooks } from './shared.js';
import { onUpdateStatus, openSettings, applyMotion } from './chrome.js';
import { showHome } from './home.js';
import { openBook } from './bookview.js';
import { openNote, renderFormatHint } from './noteview.js';

const root = document.getElementById('app');
let current = { view: 'home', args: [] };
let navigating = Promise.resolve();

/** 지금 화면을 나가는 애니메이션 → 저장 등 정리 → 새 화면 */
function go(view, fn, ...args) {
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
  return navigating;
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

async function boot() {
  if (!api) {
    root.append(h('div.fatal', '이 화면은 오답노트 프로그램 안에서 실행해야 합니다.'));
    return;
  }
  [state.appInfo, state.settings, state.update] = await Promise.all([api.appInfo(), api.getSettings(), api.getUpdateState()]);
  applyMotion(state.settings.motion);
  document.fonts?.load('600 14px "Pretendard Variable"').catch(() => {});
  api.onUpdateStatus(onUpdateStatus);
  // 누른 자리에서 퍼지는 물결
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.btn, .export-btn, .card, .seg-tab, .book-tab');
    if (el && !el.disabled) ripple({ currentTarget: el, clientX: e.clientX, clientY: e.clientY });
  });
  await showHome();
}

boot().catch((err) => {
  console.error(err);
  root.append(h('div.fatal', `시작하다가 문제가 생겼어요: ${err.message}`));
});
