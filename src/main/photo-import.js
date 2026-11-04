'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// 파일을 먼저 완성하고, 책 목록은 마지막에 한 번만 바꾼다.
function createPhotoImports({ readBook, saveBook, dirFor, markOwn, removeRemoteOnly = async () => {}, log = console }) {
  const pending = new Map();
  // 이 넣기에서 만든 파일(복사본·보정본·임시)은 이름에 token 이 들어 있다
  async function removeSessionFiles(dir, token) {
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (name.includes(token)) await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
    }
  }
  async function atomicFile(dir, name, write) {
    const dest = path.join(dir, name), tmp = `${dest}.${randomUUID()}.tmp`;
    try { await write(tmp); markOwn(dest); await fsp.rename(tmp, dest); }
    finally { await fsp.rm(tmp, { force: true }); }
  }
  function session(token) {
    const s = pending.get(token);
    if (!s) throw new Error('사진 넣기가 끝났어요. 다시 파일을 골라 주세요.');
    return s;
  }
  return {
    get size() { return pending.size; },
    async begin(bookId, role, paths, add = false) {
      if (!['problem', 'answer'].includes(role) || !Array.isArray(paths) || !paths.length) throw new Error('잘못된 파일 목록');
      if ([...pending.values()].some((s) => s.bookId === bookId)) throw new Error('이 책에 파일을 넣고 있어요. 잠시 기다려 주세요.');
      const book = readBook(bookId);
      if (!book) throw new Error('책을 찾을 수 없습니다.');
      const sorted = [...paths].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true, sensitivity: 'base' }));
      if (sorted.some((p) => !/\.(pdf|png|jpe?g|webp|bmp|gif)$/i.test(p))) throw new Error('지원하지 않는 파일 형식입니다.');
      const token = randomUUID(), dir = dirFor(bookId);
      const s = { bookId, role, add, dir, base: JSON.stringify(book), files: [], results: new Map() };
      pending.set(token, s);
      try {
        await fsp.mkdir(dir, { recursive: true });
        for (const [i, p] of sorted.entries()) {
          const name = `${role}-${token}-${String(i).padStart(3, '0')}${path.extname(p).toLowerCase()}`;
          await atomicFile(dir, name, (tmp) => fsp.copyFile(p, tmp));
          s.files.push({ name, originalName: path.basename(p), kind: /\.pdf$/i.test(p) ? 'pdf' : 'image' });
        }
        return { token, files: s.files, originalName: sorted.length === 1 ? path.basename(sorted[0]) : `${path.basename(sorted[0])} 외 ${sorted.length - 1}개` };
      } catch (err) { pending.delete(token); await removeSessionFiles(dir, token); throw err; }
    },
    async photo({ token, name, status, reason, width, height, pages = [] }) {
      const s = session(token), file = s.files.find((f) => f.name === name && f.kind === 'image');
      if (!file || s.results.has(name)) throw new Error('잘못된 사진');
      if (!['prepared', 'unchanged', 'failed'].includes(status)) throw new Error('잘못된 보정 상태');
      const dimensions = (w, h) => Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w*h <= 100000000;
      const photoPrep = { version: 1, status, reason: String(reason || '').slice(0, 100) };
      const result = [];
      if (status === 'prepared') {
        if (!pages.length || pages.length > 2) throw new Error('잘못된 보정 쪽');
        for (const [i, p] of pages.entries()) {
          if (!dimensions(p.width, p.height)) throw new Error('잘못된 쪽 크기');
          const data = Buffer.from(p.data);
          if (data.length < 4 || data[0] !== 255 || data[1] !== 216) throw new Error('JPEG 파일이 아닙니다.');
          const output = `${path.parse(name).name}-page-${i+1}.jpg`;
          await atomicFile(s.dir, output, (tmp) => fsp.writeFile(tmp, data));
          result.push({ ...file, name: output, width: p.width, height: p.height, photoPrep });
        }
      } else result.push({ ...file, photoPrep, ...(dimensions(width, height) ? { width, height } : {}) });
      s.results.set(name, result);
      return result;
    },
    async commit(token, draft) {
      const s = session(token);
      if (draft?.id !== s.bookId) throw new Error('잘못된 책');
      const current = readBook(s.bookId);
      if (!current || dirFor(s.bookId) !== s.dir || JSON.stringify(current) !== s.base) throw new Error('사진을 정리하는 동안 교재가 바뀌었어요. 교재를 다시 열고 파일을 넣어 주세요.');
      const files = s.files.flatMap((f) => {
        if (f.kind === 'pdf') return [f];
        if (!s.results.has(f.name)) throw new Error('아직 정리하지 않은 사진이 있어요.');
        return s.results.get(f.name);
      });
      const expected = s.add ? [...(current.docs?.[s.role]?.files || []), ...files.map((f) => ({ ...f, added: true }))] : files;
      if (JSON.stringify(draft.docs?.[s.role]?.files) !== JSON.stringify(expected)) throw new Error('교재 파일 목록이 바뀌었어요. 다시 열어 주세요.');
      // 동시 저장이 끼어들지 않도록 검사와 교체를 동기 실행한다.
      saveBook(draft, current);
      pending.delete(token);
      // 교재가 바뀐 뒤에만 정리: 바꾸기면 이 역할의 예전 파일(학원 공간에만 있는 것 포함), 보정한 사진은 원본 파일
      const keep = new Set(expected.map((f) => f.name));
      try {
        if (!s.add) {
          const old = (current.docs?.[s.role]?.files || []).map((f) => f?.name).filter((n) => typeof n === 'string' && n.startsWith(`${s.role}-`) && !keep.has(n));
          await removeRemoteOnly(s.bookId, old);
          for (const name of await fsp.readdir(s.dir)) {
            if (name.startsWith(`${s.role}-`) && !keep.has(name)) await fsp.rm(path.join(s.dir, name), { force: true });
          }
        } else {
          for (const name of await fsp.readdir(s.dir)) {
            if (name.includes(token) && !keep.has(name)) await fsp.rm(path.join(s.dir, name), { force: true });
          }
        }
      } catch (err) { log.warn('[photo-import] 예전 파일 정리 실패:', err.message); }
      return true;
    },
    async discard(token) {
      const s = pending.get(token);
      if (!s) return; // 이미 넣었거나 없는 넣기
      pending.delete(token);
      await removeSessionFiles(s.dir, token);
    },
  };
}

module.exports = { createPhotoImports };
