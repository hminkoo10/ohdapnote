import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createFileQueue } from '../../src/main/file-queue.js';

const require = createRequire(import.meta.url);
const { createJsonWriter } = require('../../src/main/json-atomic.js');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'json-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'book.json');
  fs.writeFileSync(file, JSON.stringify({ value: 'original' }));
  return { dir, file, ...createJsonWriter(options),
    value: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    clean: () => assert.deepEqual(fs.readdirSync(dir), ['book.json']) };
}

for (const sync of [false, true]) {
  const mode = sync ? '동기' : '비동기';
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) test(`${mode}: ${code} 두 번 뒤 저장·내용·임시 파일 정리`, async (t) => {
    let calls = 0;
    const waits = [];
    const io = { ...fs, renameSync(...args) {
      if (++calls <= 2) throw Object.assign(new Error('locked'), { code });
      return fs.renameSync(...args);
    } };
    const f = fixture(t, { io, sleep: async (ms) => waits.push(ms), sleepSync: (ms) => waits.push(ms) });
    await f[sync ? 'writeJsonAtomicSync' : 'writeJsonAtomic'](f.file, { value: 'changed' });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [20, 40]);
    assert.deepEqual(f.value(), { value: 'changed' }); f.clean();
  });

  test(`${mode}: 계속 EPERM이면 첫 오류·원본 보존·임시 파일 정리`, async (t) => {
    const original = Object.assign(new Error('first lock'), { code: 'EPERM' });
    let calls = 0;
    const waits = [];
    const f = fixture(t, { io: { ...fs, renameSync() {
      if (++calls === 1) throw original;
      throw Object.assign(new Error('later lock'), { code: 'EPERM' });
    } }, sleep: async (ms) => waits.push(ms), sleepSync: (ms) => waits.push(ms) });
    const run = () => f[sync ? 'writeJsonAtomicSync' : 'writeJsonAtomic'](f.file, { value: 'changed' });
    if (sync) assert.throws(run, (err) => err === original);
    else await assert.rejects(run, (err) => err === original);
    assert.equal(calls, 7); assert.equal(waits.reduce((a, b) => a + b, 0), 620);
    assert.deepEqual(f.value(), { value: 'original' }); f.clean();
  });

  test(`${mode}: ENOSPC는 재시도 없이 원본·오류 보존`, async (t) => {
    const error = Object.assign(new Error('full'), { code: 'ENOSPC' });
    let calls = 0;
    const f = fixture(t, { io: { ...fs, renameSync() { calls++; throw error; } },
      sleep: async () => assert.fail('재시도 금지'), sleepSync: () => assert.fail('재시도 금지') });
    const run = () => f[sync ? 'writeJsonAtomicSync' : 'writeJsonAtomic'](f.file, { value: 'changed' });
    if (sync) assert.throws(run, (err) => err === error);
    else await assert.rejects(run, (err) => err === error);
    assert.equal(calls, 1); assert.deepEqual(f.value(), { value: 'original' }); f.clean();
  });

  test(`${mode}: 임시 파일 쓰기 실패도 정리`, async (t) => {
    const error = Object.assign(new Error('full'), { code: 'ENOSPC' });
    const f = fixture(t, { io: { ...fs,
      writeFileSync(file) { fs.writeFileSync(file, 'partial'); throw error; },
      promises: { ...fs.promises, async writeFile(file) { await fs.promises.writeFile(file, 'partial'); throw error; } },
    } });
    const run = () => f[sync ? 'writeJsonAtomicSync' : 'writeJsonAtomic'](f.file, {});
    if (sync) assert.throws(run, (err) => err === error);
    else await assert.rejects(run, (err) => err === error);
    assert.deepEqual(f.value(), { value: 'original' }); f.clean();
  });
}

test('동기 임시 이름은 같은 시각에도 UUID로 다름', (t) => {
  const names = [];
  const f = fixture(t, { io: { ...fs, writeFileSync(file, ...args) { names.push(file); fs.writeFileSync(file, ...args); } } });
  t.mock.method(Date, 'now', () => 1);
  f.writeJsonAtomicSync(f.file, { value: 1 }); f.writeJsonAtomicSync(f.file, { value: 2 });
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every((name) => /\.[0-9a-f-]{36}\.tmp$/.test(name)));
  f.clean();
});

test('실제 열린 읽기 핸들을 잠시 뒤 닫으면 비동기 저장 성공', async (t) => {
  const f = fixture(t);
  let handle = fs.openSync(f.file, 'r');
  let blocked = false;
  fs.writeFileSync(f.file + '.probe', JSON.stringify({ value: 'original' }));
  try { fs.renameSync(f.file + '.probe', f.file); }
  catch (err) { assert.equal(err.code, 'EPERM'); blocked = true; }
  finally { if (fs.existsSync(f.file + '.probe')) fs.unlinkSync(f.file + '.probe'); }
  let released = false;
  const timer = setTimeout(() => { fs.closeSync(handle); handle = null; released = true; }, 100);
  try {
    if (process.platform === 'win32') assert.equal(blocked, true, '대상 교체 잠금 재현 필요');
    await f.writeJsonAtomic(f.file, { value: 'after release' });
    if (blocked) assert.equal(released, true);
    assert.deepEqual(f.value(), { value: 'after release' }); f.clean();
  } finally { clearTimeout(timer); if (handle !== null) fs.closeSync(handle); }
});

test('같은 파일의 읽기와 저장은 줄 세우고 다른 파일은 막지 않음', async (t) => {
  const queue = createFileQueue();
  let queued = 0;
  const withJsonFile = (file, run) => { queued++; return queue(file, run); };
  const f = fixture(t, { withJsonFile });
  const held = deferred(); let handle;
  const read = withJsonFile(f.file, async () => { handle = fs.openSync(f.file, 'r'); try { await held.promise; } finally { fs.closeSync(handle); } });
  await Promise.resolve();
  const save = f.writeJsonAtomic(f.file, { value: 'queued' });
  try {
    assert.equal(queued, 2, '읽기와 쓰기가 같은 줄에 들어가야 함');
    await withJsonFile(path.join(f.dir, 'other.json'), () => assert.deepEqual(f.value(), { value: 'original' }));
  } finally { held.resolve(); }
  await Promise.all([read, save]);
  assert.deepEqual(f.value(), { value: 'queued' }); f.clean();
});

for (const stage of ['queue', 'write', 'retry']) test(`순서: ${stage} 대기 중 옛 비동기 저장보다 새 동기 저장 우선`, async (t) => {
  const entered = deferred(), release = deferred();
  const withJsonFile = createFileQueue();
  let blocked = false;
  const io = { ...fs, promises: { ...fs.promises, async writeFile(...args) {
    await fs.promises.writeFile(...args);
    if (stage === 'write') { entered.resolve(); await release.promise; }
  } }, renameSync(...args) {
    if (stage === 'retry' && !blocked) { blocked = true; throw Object.assign(new Error('locked'), { code: 'EPERM' }); }
    return fs.renameSync(...args);
  } };
  const f = fixture(t, { io, withJsonFile, sleep: async () => { entered.resolve(); await release.promise; } });
  const head = stage === 'queue' ? withJsonFile(f.file, async () => { entered.resolve(); await release.promise; }) : null;
  const old = f.writeJsonAtomic(f.file, { value: 'old' });
  await entered.promise;
  try { f.writeJsonAtomicSync(f.file, { value: 'new' }); } finally { release.resolve(); }
  await Promise.all([head, old]);
  assert.deepEqual(f.value(), { value: 'new' }); f.clean();
  await f.writeJsonAtomic(f.file, { value: 'newer' });
  assert.deepEqual(f.value(), { value: 'newer' }); f.clean();
});
