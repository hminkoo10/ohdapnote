import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CHECK_MS, PREPARE_MS, createUpdateMonitor } = require('../../src/main/update-restart');

function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000000 });
  const app = Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '0.4.0', exit: (code) => exits.push(code) });
  const handlers = new Map();
  const ipcMain = Object.assign(new EventEmitter(), { handle: (channel, fn) => handlers.set(channel, fn) });
  const sent = [];
  const exits = [];
  let version = '0.4.1';
  let reads = 0;
  let focused = true;
  let minimized = false;
  let busy = false;
  let destroyed = false;
  const webContents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => destroyed, send: (channel, value) => sent.push({ channel, value }) });
  const win = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => destroyed, isFocused: () => focused, isMinimized: () => minimized });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const monitor = createUpdateMonitor({ app, ipcMain, session: { dev: false }, isSmokeTest: false, isBusy: () => busy,
    cloud: { RESTART_EXIT_CODE: 75, newerVersionInstalled: (id, current) => { assert.equal(id, 'ohdapnote'); assert.equal(current, '0.4.0'); reads++; return version; } }, ...options });
  monitor.attach(win);
  t.after(() => app.emit('will-quit'));
  const state = (patch = {}) => ({ pendingSaves: false, busy: false, lastInputAt: Date.now(), ...patch });
  const call = (channel, value, from = event) => handlers.get(channel)?.(from, value);
  const report = (value) => ipcMain.emit('app:restart-state', event, value);
  const request = () => sent.filter((s) => s.channel === 'app:update-restart').at(-1)?.value;
  return { monitor, handlers, app, win, exits, sent, state, call, report, request,
    reads: () => reads,
    ready: (patch) => call('app:restart-ready', state(patch)),
    tick: (ms) => t.mock.timers.tick(ms),
    finish: (patch = {}, extra = {}) => call('app:finish-update-restart', { id: request()?.id, ok: true, state: state(patch), ...extra }),
    version: (value) => { version = value; },
    busy: (value) => { busy = value; },
    destroy: () => { destroyed = true; },
    focus: () => { focused = true; minimized = false; win.emit('focus'); },
    blur: () => { focused = false; win.emit('blur'); },
    minimize: () => { minimized = true; win.emit('minimize'); },
  };
}

test('업데이트 감시: 화면 준비 후 알림, 2분마다 확인, 비활성 2분 뒤 저장 확인 → 75', (t) => {
  const x = setup(t);
  x.tick(CHECK_MS);
  assert.equal(x.reads(), 0);
  x.ready();
  assert.equal(x.sent[0].channel, 'app:update-available');
  assert.equal(x.request(), undefined);
  const before = x.reads();
  x.blur();
  assert.ok(x.reads() > before);
  x.tick(CHECK_MS);
  assert.ok(x.request());
  assert.deepEqual(x.exits, []);
  assert.equal(x.finish({ lastInputAt: 1000000 }), true);
  assert.deepEqual(x.exits, [75]);
  assert.equal(x.finish(), false);
});

test('업데이트 감시: 최소화도 확인, 다시 돌아오면 유휴 시간 초기화', (t) => {
  const x = setup(t);
  x.ready();
  x.minimize();
  x.tick(CHECK_MS - 1);
  x.focus();
  x.tick(1);
  assert.equal(x.request(), undefined);
  x.tick(2 * CHECK_MS);
  assert.ok(x.request());
});

test('업데이트 감시: 개발·시험·세션 없음이면 타이머·IPC·설치 조회 없음', (t) => {
  for (const options of [{ session: null }, { session: { dev: true } }, { isSmokeTest: true }, { app: { isPackaged: false } }]) {
    const x = setup(t, options);
    assert.equal(x.monitor.enabled, false);
    x.blur();
    x.tick(CHECK_MS * 3);
    assert.equal(x.handlers.size, 0);
    assert.equal(x.reads(), 0);
    t.mock.timers.reset();
  }
});

test('업데이트 감시: 수동은 저장을 기다릴 수 있지만 작업 중에는 보류', async (t) => {
  const x = setup(t);
  x.ready({ pendingSaves: true });
  assert.equal(x.call('app:restart-for-update'), true);
  assert.equal(x.finish({ pendingSaves: true }), false);
  assert.equal(x.call('app:restart-for-update'), true);
  assert.equal(x.finish(), true);
  x.report(x.state({ busy: true }));
  assert.equal(x.call('app:restart-for-update'), false);
  x.report(x.state());
  x.busy(true);
  assert.equal(x.call('app:restart-for-update'), false);
  x.busy(false);
  let release;
  const job = x.monitor.track(() => new Promise((r) => { release = r; }));
  assert.equal(x.call('app:restart-for-update'), false);
  release();
  await job;
  assert.equal(x.call('app:restart-for-update'), true);
});

test('업데이트 감시: 확인 중 입력·작업·설치 취소·저장 실패가 생기면 종료하지 않음', async (t) => {
  const x = setup(t);
  x.ready();
  x.call('app:restart-for-update');
  x.tick(1);
  assert.equal(x.finish(), false);
  x.call('app:restart-for-update');
  assert.equal(x.finish({ busy: true }), false);
  x.report(x.state());
  x.call('app:restart-for-update');
  x.version(null);
  assert.equal(x.finish(), false);
  x.version('0.4.2');
  x.call('app:restart-for-update');
  assert.equal(x.finish({}, { ok: false }), false);
  x.call('app:restart-for-update');
  let release;
  const saving = x.monitor.track(() => new Promise((r) => { release = r; }));
  assert.equal(x.finish(), false);
  release();
  await saving;
  assert.deepEqual(x.exits, []);
});

test('업데이트 감시: 응답 유실·오래된 응답·다른 화면 응답은 안전하게 재시도', (t) => {
  const x = setup(t);
  x.ready();
  x.call('app:restart-for-update');
  const old = x.request().id;
  assert.equal(x.call('app:restart-for-update'), false);
  x.tick(PREPARE_MS);
  assert.equal(x.finish({ lastInputAt: 1000000 }), false);
  x.call('app:restart-for-update');
  assert.notEqual(x.request().id, old);
  assert.equal(x.finish({}, { id: old }), false);
  assert.equal(x.call('app:finish-update-restart', { id: x.request().id, ok: true, state: x.state() }, { sender: x.win.webContents, senderFrame: {} }), false);
  assert.equal(x.finish({ lastInputAt: 1000000 }), true);
});

test('업데이트 감시: 새로고침은 상태·알림 초기화, 닫힌 창과 종료 뒤에는 감시 중지', (t) => {
  const x = setup(t);
  x.ready();
  x.call('app:restart-for-update');
  x.win.webContents.emit('did-start-loading');
  const reads = x.reads();
  x.tick(CHECK_MS * 3);
  assert.equal(x.reads(), reads);
  assert.equal(x.finish(), false);
  x.ready();
  assert.equal(x.sent.filter((s) => s.channel === 'app:update-available').length, 2);
  x.destroy();
  x.tick(CHECK_MS);
  assert.equal(x.call('app:restart-for-update'), false);
  x.win.emit('closed');
});

test('업데이트 감시: 설치 없음·불완전 상태는 보류, 실패한 main 작업은 누적하지 않음', async (t) => {
  const x = setup(t);
  x.version(null);
  x.ready();
  x.tick(CHECK_MS * 2);
  assert.equal(x.sent.length, 0);
  x.version('0.4.2');
  x.report({ pendingSaves: false, busy: false });
  assert.equal(x.call('app:restart-for-update'), false);
  x.report(x.state());
  await assert.rejects(x.monitor.track(async () => { throw new Error('저장 오류'); }));
  assert.equal(x.call('app:restart-for-update'), true);
});
