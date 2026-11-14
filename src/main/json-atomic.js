'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFileQueue } = require('./file-queue');

const RETRY_MS = [20, 40, 80, 120, 160, 200]; // 잠깐 열린 파일만 기다림 (합계 620ms)
const retryable = (err) => ['EPERM', 'EACCES', 'EBUSY'].includes(err.code);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function createJsonWriter({ io = fs, withJsonFile = createFileQueue(), markOwn = () => {},
  sleep = pause, sleepSync = (ms) => Atomics.wait(waitCell, 0, 0, ms) } = {}) {
  let sequence = 0;
  const syncWrites = new Map();
  const keyOf = (file) => path.resolve(file).toLowerCase();

  async function writeJsonAtomic(file, value) {
    const request = ++sequence;
    const key = keyOf(file);
    const stale = () => (syncWrites.get(key) || 0) > request;
    return withJsonFile(file, async () => {
      if (stale()) return;
      await io.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await io.promises.writeFile(tmp, JSON.stringify(value), 'utf8');
        let firstError;
        for (let attempt = 0; ; attempt++) {
          if (stale()) return;
          try {
            markOwn(file);
            // 번호 확인과 교체는 한 차례에. 진행 중인 비동기 rename이 동기 저장 뒤에 끝나지 않게 함.
            io.renameSync(tmp, file);
            return;
          } catch (err) {
            if (!retryable(err)) throw err;
            firstError ||= err;
            if (attempt === RETRY_MS.length) throw firstError;
            await sleep(RETRY_MS[attempt]);
          }
        }
      } finally { await io.promises.unlink(tmp).catch(() => {}); }
    });
  }

  function writeJsonAtomicSync(file, value) {
    const request = ++sequence;
    io.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      io.writeFileSync(tmp, JSON.stringify(value), 'utf8');
      let firstError;
      for (let attempt = 0; ; attempt++) {
        try {
          markOwn(file);
          io.renameSync(tmp, file);
          syncWrites.set(keyOf(file), request);
          return;
        } catch (err) {
          if (!retryable(err)) throw err;
          firstError ||= err;
          if (attempt === RETRY_MS.length) throw firstError;
          sleepSync(RETRY_MS[attempt]);
        }
      }
    } finally { try { io.unlinkSync(tmp); } catch {} }
  }
  return { writeJsonAtomic, writeJsonAtomicSync };
}
module.exports = { createJsonWriter };
