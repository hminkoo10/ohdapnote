import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocSource } from '../../src/renderer/js/docsource.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeSource(onCleanup = async () => {}) {
  const src = new DocSource([{ name: 'fake.pdf', kind: 'pdf' }], (name) => name);
  const commonObjs = new Map();
  const state = { busy: 0, page: -1, cleaning: null, failed: false, commonObjs };
  const events = [];
  let cleanupCalls = 0;
  const pages = Array.from({ length: 3 }, (_, i) => ({ pageNumber: i + 1, commonObjs, cleanup() {} }));
  src.pages = pages.map((_, pageIndex) => ({ fileIndex: 0, pageIndex, kind: 'pdf', w: 600, h: 800, rotate: 0 }));
  src._pdfUse.set(0, state);
  src._pdfDocs.set(0, {
    async getPage(n) {
      events.push(`getPage:${n}`);
      return pages[n - 1];
    },
    async cleanup() {
      cleanupCalls++;
      events.push('cleanup:start');
      await onCleanup();
      commonObjs.clear();
      events.push('cleanup:end');
    },
  });
  const loadFonts = (n) => {
    for (let i = 0; i < n; i++) commonObjs.set(`g_d12_f${i}`, {});
  };
  return { src, state, commonObjs, events, pages, loadFonts, get cleanupCalls() { return cleanupCalls; } };
}

test('글꼴이 100개 이하면 다른 쪽으로 넘어가도 정리하지 않음', async () => {
  for (const count of [0, 99, 100]) {
    const f = fakeSource();
    await f.src._usePdfPage(0, () => {});
    f.loadFonts(count);
    // 글꼴이 아닌 공용 객체와 글꼴 이름의 일부만 닮은 객체는 세지 않는다.
    for (let i = 0; i < 101; i++) f.commonObjs.set(`img_${i}`, {});
    for (const id of ['g_d1_f', 'g_dx_f1', 'g_d1_f2_extra', 'prefix_g_d1_f2']) f.commonObjs.set(id, {});
    assert.equal(await f.src._usePdfPage(1, (page) => page.pageNumber), 2);
    assert.equal(f.cleanupCalls, 0, `글꼴 ${count}개`);
    assert.equal(f.state.busy, 0);
  }
});

test('글꼴 101개·유휴·다른 쪽이면 작업 전에 한 번 정리', async () => {
  const f = fakeSource();
  await f.src._usePdfPage(0, () => {});
  f.loadFonts(101);
  f.events.length = 0;
  const result = await f.src._usePdfPage(1, (page) => {
    f.events.push('use');
    assert.equal(page, f.pages[1]);
    assert.equal(f.cleanupCalls, 1);
    assert.equal(f.commonObjs.size, 0);
    assert.equal(f.state.busy, 1);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.deepEqual(f.events, ['cleanup:start', 'cleanup:end', 'getPage:2', 'use']);
  assert.equal(f.cleanupCalls, 1);
  assert.equal(f.state.busy, 0);
});

test('글꼴이 많아도 같은 쪽 작업 사이에는 정리하지 않음', async () => {
  const f = fakeSource();
  await f.src._usePdfPage(0, () => {});
  f.loadFonts(150);
  for (let n = 0; n < 3; n++) {
    assert.equal(await f.src._usePdfPage(0, (page) => page.pageNumber), 1);
    assert.equal(f.cleanupCalls, 0);
  }
  assert.equal(f.commonObjs.size, 150);
  assert.equal(f.state.busy, 0);
});

test('다른 쪽 작업이 진행 중이면 글꼴이 많아도 정리하지 않음', async () => {
  const f = fakeSource();
  const entered = deferred(), release = deferred();
  const first = f.src._usePdfPage(0, async () => {
    entered.resolve();
    await release.promise;
    return 'first';
  });
  try {
    await entered.promise;
    f.loadFonts(101);
    assert.equal(f.state.busy, 1);
    assert.equal(await f.src._usePdfPage(1, (page) => {
      assert.equal(f.state.busy, 2);
      assert.equal(f.cleanupCalls, 0);
      return page.pageNumber;
    }), 2);
    assert.equal(f.cleanupCalls, 0);
    assert.equal(f.state.busy, 1);
  } finally {
    release.resolve();
    await first;
  }
  assert.equal(f.cleanupCalls, 0);
  assert.equal(f.state.busy, 0);
});

test('정리 중에 시작한 작업은 끝날 때까지 기다리고 다시 정리하지 않음', async () => {
  const release = deferred();
  const f = fakeSource(() => release.promise);
  await f.src._usePdfPage(0, () => {});
  f.loadFonts(101);
  f.events.length = 0;
  const use = (name) => (page) => { f.events.push(name); return page.pageNumber; };
  const first = f.src._usePdfPage(1, use('use:first'));
  const waiting = f.src._usePdfPage(2, use('use:waiting'));
  try {
    // 한 이벤트 루프를 지나도 cleanup의 Promise가 풀리기 전에는 use/getPage에 들어가면 안 된다.
    await new Promise(setImmediate);
    assert.equal(f.cleanupCalls, 1);
    assert.ok(f.state.cleaning);
    assert.equal(f.state.busy, 0);
    assert.deepEqual(f.events, ['cleanup:start']);
  } finally {
    release.resolve();
    await Promise.all([first, waiting]);
  }
  assert.deepEqual(await Promise.all([first, waiting]), [2, 3]);
  assert.equal(f.cleanupCalls, 1);
  assert.ok(f.events.indexOf('cleanup:end') < f.events.indexOf('use:first'));
  assert.ok(f.events.indexOf('cleanup:end') < f.events.indexOf('use:waiting'));
  assert.equal(f.state.cleaning, null);
  assert.equal(f.state.busy, 0);
});

test('정리가 거부돼도 작업은 실행하고 그 파일은 다시 정리하지 않음', async () => {
  const f = fakeSource(async () => { throw new Error('fake cleanup failure'); });
  await f.src._usePdfPage(0, () => {});
  f.loadFonts(101);
  let uses = 0;
  for (const i of [1, 2, 0, 1]) {
    const result = await f.src._usePdfPage(i, (page) => { uses++; return page.pageNumber; });
    assert.equal(result, i + 1);
    assert.equal(f.cleanupCalls, 1);
    assert.equal(f.state.failed, true);
    assert.equal(f.state.cleaning, null);
    assert.equal(f.state.busy, 0);
  }
  assert.equal(uses, 4);
  assert.equal(f.commonObjs.size, 101);
  assert.equal(f.cleanupCalls, 1);
});
