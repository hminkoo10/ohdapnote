'use strict';

const { shouldRestartForUpdate } = require('./restart-idle');

const CHECK_MS = 2 * 60 * 1000;
const PREPARE_MS = 30 * 1000;

/** 설치 확인과 저장 확인을 분리한다. 화면이 답하지 않거나 상태가 바뀌면 종료하지 않는다. */
function createUpdateMonitor({ app, ipcMain, cloud, session, isSmokeTest, isBusy, now = Date.now }) {
  const enabled = app.isPackaged && !!session && !session.dev && !isSmokeTest;
  let win = null;
  let timer = null;
  let state = null;
  let version = null;
  let pending = null;
  let sequence = 0;
  let unfocusedSince = null;
  let lastInputAt = now();
  let operations = 0;
  const alive = () => win && !win.isDestroyed() && !win.webContents.isDestroyed();
  const send = (channel, value) => { if (alive()) win.webContents.send(channel, value); };
  const trusted = (event) => alive() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  const windowState = () => {
    const unfocused = win.isMinimized() || !win.isFocused();
    if (unfocused) unfocusedSince ??= now();
    else unfocusedSince = null;
    return unfocused;
  };
  const receive = (value) => {
    state = value && typeof value === 'object' ? value : null;
    if (Number.isFinite(state?.lastInputAt)) lastInputAt = Math.max(lastInputAt, Math.min(now(), state.lastInputAt));
  };
  const safe = (manual, preparing = false) => alive() && shouldRestartForUpdate({
    updateAvailable: !!version,
    pendingSaves: preparing && manual && state?.pendingSaves === true ? false : state?.pendingSaves,
    busy: state?.busy === false && Number.isFinite(state.lastInputAt) ? operations > 0 || isBusy() : true,
    windowUnfocused: windowState(),
    unfocusedForMs: unfocusedSince == null ? 0 : now() - unfocusedSince,
    inactiveForMs: now() - lastInputAt,
    manual,
  });
  const installed = () => {
    const next = cloud.newerVersionInstalled('ohdapnote', app.getVersion());
    if (next && next !== version) send('app:update-available', next);
    version = next;
    return next;
  };
  const request = (manual = false) => {
    if (!enabled || !alive() || !state) return false;
    if (pending && now() - pending.at < PREPARE_MS) return false;
    pending = null;
    if (!installed() || !safe(manual, true)) return false;
    pending = { id: ++sequence, manual, at: now(), lastInputAt };
    send('app:update-restart', { id: pending.id, manual });
    return true;
  };
  const check = () => {
    if (!enabled || !alive() || !state) return;
    windowState();
    request();
  };
  const stop = () => {
    clearInterval(timer);
    timer = null;
    state = null;
    pending = null;
    version = null;
  };
  if (enabled) {
    ipcMain.on('app:restart-state', (event, value) => { if (trusted(event)) receive(value); });
    ipcMain.handle('app:restart-ready', (event, value) => {
      if (!trusted(event)) return false;
      receive(value);
      if (!timer) {
        timer = setInterval(check, CHECK_MS);
        timer.unref?.();
      }
      check();
      return true;
    });
    ipcMain.handle('app:restart-for-update', (event) => trusted(event) && request(true));
    ipcMain.handle('app:finish-update-restart', (event, result) => {
      if (!trusted(event) || !pending || result?.id !== pending.id) return false;
      const attempt = pending;
      pending = null;
      receive(result.state);
      if (!result.ok || now() - attempt.at >= PREPARE_MS || !installed() || !safe(attempt.manual)) return false;
      // 저장하는 사이 다시 입력했으면 수동 요청도 취소한다.
      if (lastInputAt > attempt.lastInputAt) return false;
      app.exit(cloud.RESTART_EXIT_CODE);
      return true;
    });
    app.on('will-quit', stop);
  }
  return {
    enabled,
    attach(window) {
      if (!enabled) return;
      win = window;
      windowState();
      for (const event of ['blur', 'minimize', 'focus', 'restore']) win.on(event, () => {
        if (!windowState()) lastInputAt = now();
        check();
      });
      win.webContents.on('did-start-loading', stop);
      win.on('closed', stop);
    },
    async track(fn) {
      operations += 1;
      try {
        return await fn();
      } finally {
        operations -= 1;
      }
    },
  };
}

module.exports = { CHECK_MS, PREPARE_MS, createUpdateMonitor };
