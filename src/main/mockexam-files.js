'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inflateRawSync } = require('node:zlib');
const supported = /\.(pdf|png|jpe?g)$/i;
const hash = (b) => createHash('sha256').update(b).digest('hex');
// 중앙 디렉터리만 신뢰하고, 원래 경로 대신 해시 이름으로 풀어 경로 탈출을 막는다.
function readExamZip(buf) {
  let end = buf.length - 22;
  for (; end >= Math.max(0, buf.length - 65557); end--) if (buf.readUInt32LE(end) === 0x06054b50 && end + 22 + buf.readUInt16LE(end + 20) === buf.length) break;
  if (end < 0 || buf.readUInt32LE(end) !== 0x06054b50) throw Error('ZIP 끝을 읽지 못했어요.');
  if (buf.readUInt16LE(end + 4) || buf.readUInt16LE(end + 6)) throw Error('나뉜 ZIP은 지원하지 않아요.');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16), total = 0;
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || buf.readUInt32LE(at) !== 0x02014b50) throw Error('ZIP 목록을 읽지 못했어요.');
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 24), compressed = buf.readUInt32LE(at + 20);
    const len = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32);
    const name = new TextDecoder(flags & 2048 ? 'utf-8' : 'euc-kr').decode(buf.subarray(at + 46, at + 46 + len));
    const offset = buf.readUInt32LE(at + 42);
    at += 46 + len + extra + comment;
    if (!supported.test(name)) { if (!name.endsWith('/')) entries.push({ name, skipped: true }); continue; }
    total += size;
    if (flags & 1 || ![0, 8].includes(method) || size > 128 * 1024 * 1024 || total > 512 * 1024 * 1024) throw Error('암호화되었거나 너무 큰 ZIP이에요.');
    if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== 0x04034b50) throw Error('ZIP 파일이 손상됐어요.');
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    if (start + compressed > buf.length) throw Error('ZIP 파일이 잘렸어요.');
    const raw = buf.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }) : raw;
    if (data.length !== size) throw Error('ZIP 파일 크기가 맞지 않아요.');
    entries.push({ name, data });
  }
  return entries;
}
async function scanExamPaths(paths, cacheDir) {
  const files = [], skipped = [];
  async function visit(p) {
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) { skipped.push(p); return; }
    if (st.isDirectory()) { for (const name of (await fs.readdir(p)).sort()) await visit(path.join(p, name)); return; }
    if (!supported.test(p) && !/\.zip$/i.test(p)) { skipped.push(p); return; }
    if (st.size > 256 * 1024 * 1024) { skipped.push(p); return; }
    const data = await fs.readFile(p);
    if (/\.zip$/i.test(p)) {
      await fs.mkdir(cacheDir, { recursive: true });
      for (const entry of readExamZip(data)) {
        if (entry.skipped) { skipped.push(`${p}/${entry.name}`); continue; }
        const sha256 = hash(entry.data), dest = path.join(cacheDir, sha256 + path.extname(entry.name).toLowerCase());
        await fs.writeFile(dest, entry.data);
        files.push({ filename: entry.name, path: `${p}/${entry.name}`, localPath: dest, sha256 });
      }
    } else files.push({ filename: path.basename(p), path: p, localPath: p, sha256: hash(data) });
  }
  for (const p of paths) await visit(p);
  return { files, skipped };
}
module.exports = { readExamZip, scanExamPaths };
