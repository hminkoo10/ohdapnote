import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';

function harness(packaged = false) {
  const source = readFileSync(new URL('../../src/main/main.js', import.meta.url), 'utf8');
  const worker = source.slice(source.indexOf('const numberdetDir ='), source.indexOf('function registerIpc()'));
  const handlers = source.slice(source.indexOf("  handle('numbers:status'"), source.indexOf("  handle('mathocr:status'"));
  const map = new Map(), processes = [], timers = [];
  const utilityProcess = { fork(file, args, opts) {
    assert.ok(file.endsWith('numberdet-worker.js'));
    const proc = new EventEmitter(); proc.sent = [];
    proc.postMessage = msg => proc.sent.push(msg);
    proc.kill = () => proc.emit('exit', 0);
    processes.push(proc); return proc;
  } };
  const numberdet = { MODEL_DIR_NAME: 'ohdap-pnd-1', modelStatus: dir => ({ installed: true, dir }) };
  new Function('app', 'path', 'process', 'utilityProcess', 'numberdet', '__dirname', 'setTimeout', 'clearTimeout', 'handle',
    worker + handlers)({ isPackaged: packaged }, path, { env: { OHDAP_PND_DIR: 'local-model' }, resourcesPath: 'bundled' }, utilityProcess,
    numberdet, 'main', (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, t => { if (t) t.cleared = true; }, (key, fn) => map.set(key, fn));
  return { map, processes, timers };
}

test('numbers IPC: development override, idle stop, reuse and pending request failure', async () => {
  const { map, processes, timers } = harness();
  assert.equal(map.get('numbers:status')().dir, 'local-model');
  const detect = map.get('numbers:detect');
  const p = detect(null, { image: { width: 1 } });
  const proc = processes[0], msg = proc.sent[0];
  assert.equal(msg.type, 'detect'); assert.equal(msg.modelDir, 'local-model');
  proc.emit('message', { type: 'done', id: msg.id, ok: true, boxes: [] });
  assert.equal((await p).ok, true); assert.equal(timers[0].ms, 120000);
  const next = detect(null, { image: { width: 2 } });
  assert.equal(processes.length, 1); assert.equal(timers[0].cleared, true);
  proc.emit('exit', 1); assert.equal((await next).ok, false);
  const third = detect(null, { image: { width: 3 } });
  assert.equal(processes.length, 2);
  processes[1].emit('message', { type: 'done', id: processes[1].sent[0].id, ok: true, boxes: [] });
  await third; timers.at(-1).fn();
  const fourth = detect(null, { image: { width: 4 } });
  assert.equal(processes.length, 3); processes[2].emit('exit', 0); await fourth;
  assert.equal(harness(true).map.get('numbers:status')().dir, path.join('bundled', 'models', 'ohdap-pnd-1'));
  assert.match(readFileSync(new URL('../../src/main/main.js', import.meta.url), 'utf8'), /app\.on\('will-quit',[\s\S]*?stopNumberdetWorker\(\)/);
});

test('preload forwards only the number status and image request', async () => {
  let api;
  const calls = [];
  const electron = { contextBridge: { exposeInMainWorld(name, value) { api = value; } }, ipcRenderer: { invoke: async (...args) => calls.push(args) } };
  new Function('require', readFileSync(new URL('../../src/main/preload.js', import.meta.url), 'utf8'))(() => electron);
  await api.numbersStatus(); await api.numbersDetect({ image: { width: 1 }, ignored: true });
  assert.deepEqual(calls, [['numbers:status'], ['numbers:detect', { image: { width: 1 } }]]);
});
