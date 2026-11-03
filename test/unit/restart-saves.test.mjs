import assert from 'node:assert/strict';
import test from 'node:test';
import { createSaveQueue } from '../../src/renderer/js/save-queue.js';
import { createRestartGuard } from '../../src/renderer/js/restart.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('저장: 예약 저장을 기다리고, 중간 수정은 순차 저장하며 동시 flush 도 겹치지 않음', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = deferred();
  const calls = [];
  let active = 0;
  const saver = createSaveQueue(async (value) => {
    assert.equal(++active, 1);
    calls.push(value.name);
    if (calls.length === 1) await first.promise;
    active--;
  });
  const object = { name: '처음' };
  saver.set(object);
  saver.dirty();
  assert.equal(saver.pending, true);
  t.mock.timers.tick(600);
  await Promise.resolve();
  assert.equal(saver.saving, true);
  object.name = '수정';
  saver.dirty();
  t.mock.timers.tick(600);
  const a = saver.flushPending();
  const b = saver.flushPending();
  first.resolve();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.deepEqual(calls, ['처음', '수정']);
  assert.equal(saver.pending, false);
  assert.equal(saver.saving, false);
});

test('저장: 실패한 이전 화면 내용도 유지, 재시도하며 깨끗한 오래된 객체는 덮어쓰지 않음', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fail = true;
  const calls = [];
  const saver = createSaveQueue(async (value) => {
    if (fail) throw new Error('저장 실패');
    calls.push(value.id);
  });
  saver.set({ id: '이전' });
  saver.dirty();
  assert.equal(await saver.flushPending(), false);
  saver.set({ id: '현재' });
  saver.dirty();
  fail = false;
  assert.equal(await saver.flushPending(), true);
  assert.deepEqual(calls, ['이전', '현재']);
  await saver.flushPending();
  assert.deepEqual(calls, ['이전', '현재']);
  await saver.flush();
  assert.deepEqual(calls, ['이전', '현재', '현재']);
});

test('저장: cancel 은 예약만 취소, 수정 내용은 flushPending 으로 저장', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const saver = createSaveQueue(async () => calls++);
  saver.set({});
  saver.dirty();
  saver.cancel();
  t.mock.timers.tick(1000);
  assert.equal(calls, 0);
  assert.equal(saver.pending, true);
  assert.equal(await saver.flushPending(), true);
  assert.equal(calls, 1);
});

async function guardFor(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  const reports = [];
  const finishes = [];
  const locks = [];
  let work = false;
  let draft = false;
  let accepted = true;
  const guard = createRestartGuard({
    api: {
      reportRestartState: (s) => reports.push(s),
      updateRestartReady: async (s) => reports.push(s),
      finishUpdateRestart: async (r) => { finishes.push(r); return r.ok && accepted; },
    },
    hasWork: () => work,
    hasDraft: () => draft,
    lock: (locked) => locks.push(locked),
  });
  t.after(() => guard.stop());
  await guard.start();
  return { guard, reports, finishes, locks,
    work: (value) => { work = value; },
    draft: (value) => { draft = value; },
    accepted: (value) => { accepted = value; },
    prepare: (manual = false) => guard.prepare({ id: finishes.length + 1, manual }),
  };
}

test('재시작 저장: 자동은 수정 중 보류, 수동은 저장·연관 저장을 모두 끝내고 확인', async (t) => {
  const x = await guardFor(t);
  const calls = [];
  const saver = createSaveQueue(async () => calls.push('저장'));
  x.guard.savers.add(saver);
  x.guard.saveHooks.add(async () => calls.push('문항 번호 반영'));
  saver.set({});
  saver.dirty();
  assert.equal(await x.prepare(), false);
  assert.deepEqual(calls, []);
  assert.equal(await x.prepare(true), true);
  assert.deepEqual(calls, ['저장', '문항 번호 반영']);
  assert.deepEqual(x.finishes.at(-1), { id: 2, ok: true, state: { pendingSaves: false, busy: false, lastInputAt: 1000 } });
  assert.deepEqual(x.locks.slice(-2), [true, false]);
});

test('재시작 저장: 저장 실패 시 잠그거나 종료하지 않고 다음 요청에서 재시도', async (t) => {
  const x = await guardFor(t);
  let fail = true;
  const saver = createSaveQueue(async () => { if (fail) throw new Error('디스크 오류'); });
  x.guard.savers.add(saver);
  saver.set({});
  saver.dirty();
  assert.equal(await x.prepare(true), false);
  assert.equal(x.locks.includes(true), false);
  assert.equal(x.guard.getState().pendingSaves, true);
  fail = false;
  assert.equal(await x.prepare(true), true);
  assert.equal(x.guard.getState().pendingSaves, false);
});

test('재시작 저장: 분석·OCR·중첩 내보내기·열린 입력창은 수동도 보류', async (t) => {
  const x = await guardFor(t);
  x.work(true);
  assert.equal(await x.prepare(true), false);
  x.work(false);
  x.draft(true);
  assert.equal(await x.prepare(true), false);
  x.draft(false);
  x.guard.busy('export:note', true);
  x.guard.busy('export:note', true);
  x.guard.busy('export:note', false);
  assert.equal(await x.prepare(true), false);
  x.guard.busy('export:note', false);
  assert.equal(await x.prepare(true), true);
});

test('재시작 저장: 저장 중 새 입력·새 작업은 중단, 활동 시간은 상태 보고에도 보존', async (t) => {
  const x = await guardFor(t);
  const saving = deferred();
  x.guard.saveHooks.add(() => saving.promise);
  const attempt = x.prepare(true);
  t.mock.timers.tick(1);
  x.guard.activity();
  x.guard.report();
  assert.equal(x.reports.at(-1).lastInputAt, 1001);
  saving.resolve();
  assert.equal(await attempt, false);
  x.guard.saveHooks.clear();
  x.guard.saveHooks.add(() => x.work(true));
  assert.equal(await x.prepare(true), false);
});

test('재시작 저장: 지연된 문항 번호 변경도 저장, 실패하거나 main 이 거부하면 편집 잠금 해제', async (t) => {
  const x = await guardFor(t);
  let pending = true;
  x.guard.pendingChecks.add(() => pending);
  x.guard.saveHooks.add(async () => { pending = false; });
  assert.equal(await x.prepare(), false);
  x.accepted(false);
  assert.equal(await x.prepare(true), false);
  assert.equal(x.locks.at(-1), false);
  x.accepted(true);
  x.guard.saveHooks.add(async () => false);
  assert.equal(await x.prepare(true), false);
});

test('재시작 저장: 동기화 완료·실패 모두 작업 해제, 주기 보고로 입력창 닫힘 반영', async (t) => {
  const x = await guardFor(t);
  const syncing = deferred();
  const job = x.guard.track('sync', () => syncing.promise);
  assert.equal(await x.prepare(true), false);
  syncing.resolve();
  await job;
  await assert.rejects(x.guard.track('sync', async () => { throw new Error('연결 끊김'); }));
  assert.equal(x.guard.getState().busy, false);
  x.draft(true);
  t.mock.timers.tick(30000);
  assert.equal(x.reports.at(-1).busy, true);
  x.draft(false);
  t.mock.timers.tick(30000);
  assert.equal(x.reports.at(-1).busy, false);
});
