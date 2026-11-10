'use strict';
const path = require('node:path');

// Windows에서는 읽는 중인 JSON을 rename으로 교체할 수 없다.
// 같은 파일의 비동기 읽기와 원자적 쓰기를 함께 줄 세운다.
function createFileQueue() {
  const pending = new Map();
  return function withFile(file, operation) {
    const key = path.resolve(file).toLowerCase();
    const run = (pending.get(key) || Promise.resolve()).then(operation);
    const settled = run.catch(() => {});
    pending.set(key, settled);
    settled.then(() => { if (pending.get(key) === settled) pending.delete(key); });
    return run;
  };
}
module.exports = { createFileQueue };
