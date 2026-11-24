import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const main = path.resolve('src/main/main.js');
const realRequire = createRequire(main);
export function harness(viewOnly = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opv2-unit-'));
  const academyDir = path.join(root, 'academy'), dataDir = path.join(root, 'sync'), localDir = path.join(root, 'local');
  for (const d of [academyDir, dataDir, localDir]) fs.mkdirSync(d);
  const session = { viewOnly, academyDir, dataDir, localDir, user: { id: 'teacher', name: 'Teacher', role: 'admin', academy: 'Test' } };
  const handles = new Map(), listeners = new Map();
  const dialog = { showSaveDialog: async () => ({ canceled: true }) };
  const ipcMain = { handle: (k, f) => handles.set(k, f), on: (k, f) => listeners.set(k, f) };
  const noop = () => {};
  const log = { initialize: noop, transports: { file: {} }, info: noop, warn: noop, error: noop };
  const app = { isPackaged: false, getPath: () => localDir, setPath: noop, setAppUserModelId: noop, on: noop, whenReady: () => new Promise(noop), requestSingleInstanceLock: () => true, getVersion: () => 'test' };
  const cloud = realRequire('./magoedu-cloud');
  const context = { require: (id) => id === 'electron' ? { app, ipcMain, dialog, protocol: { registerSchemesAsPrivileged: noop } } : id === 'electron-log/main' ? log : id === './magoedu-cloud' ? { ...cloud, check: () => session } : id === './update-restart' ? { createUpdateMonitor: () => ({ track: (fn) => fn() }) } : realRequire(id), __dirname: path.dirname(main), process: { env: { MAGOEDU_DEV: '1' }, argv: ['node', main], platform: process.platform }, Buffer, URL, console, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(main, 'utf8') + '\nregisterIpc(); globalThis.autos = {saveProfile, importLegacy, removeRemoteOnly};', context, { filename: main });
  const write = (rel, value) => { const f = path.join(academyDir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(value)); };
  const hash = () => {
    const out = {};
    for (const base of [academyDir, dataDir]) for (const rel of fs.readdirSync(base, { recursive: true })) { const f = path.join(base, rel); if (fs.statSync(f).isFile()) out[path.relative(root, f)] = createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
    return out;
  };
  return { root, session, dialog, handles, listeners, write, hash, autos: context.autos, call: (ch, ...args) => handles.get(ch)({}, ...args) };
}
