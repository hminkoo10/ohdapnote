'use strict';
const fs = require('node:fs');
const path = require('node:path');
const LIBRARY_READ_ONLY = '마고 공용 책장의 문제는 고칠 수 없어요.';
function libraryLocation(root, id) {
  if (!root || !/^[a-zA-Z0-9-]{8,64}$/.test(id)) return null;
  const dir = path.join(root, 'books', id);
  return fs.existsSync(path.join(dir, 'book.json')) ? { dir, place: 'library' } : null;
}
function assertLibraryWritable(place) {
  if (place === 'library') throw new Error(LIBRARY_READ_ONLY);
}
function createSummaryCache() {
  const cache = new Map();
  const pending = new Map();
  const list = async (root, readSummary) => {
    const entries = await fs.promises.readdir(path.join(root, 'books'), { withFileTypes: true }).catch(() => []);
    const files = entries.filter((e) => e.isDirectory() && /^[a-zA-Z0-9-]{8,64}$/.test(e.name)).map((e) => path.join(root, 'books', e.name, 'book.json'));
    const seen = new Set(files);
    const out = new Array(files.length);
    let next = 0;
    // 첫 수신 때도 파일을 하나씩 기다리지 않음. 동시에 여는 파일 수는 제한.
    await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= files.length) return;
        const file = files[index];
        try {
          const stat = await fs.promises.stat(file);
          let item = cache.get(file);
          if (!item || item.mtime !== stat.mtimeMs || item.size !== stat.size) {
            item = { mtime: stat.mtimeMs, size: stat.size, summary: await readSummary(file) };
            cache.set(file, item);
          }
          out[index] = item.summary;
        } catch { cache.delete(file); }
      }
    }));
    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    return out.filter(Boolean);
  };
  return { async list(root, readSummary) {
    if (!root) { cache.clear(); return []; }
    if (!pending.has(root)) pending.set(root, list(root, readSummary).finally(() => pending.delete(root)));
    return pending.get(root);
  } };
}
module.exports = { libraryLocation, assertLibraryWritable, createSummaryCache, LIBRARY_READ_ONLY };
