import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPhotoImports } = require('../../src/main/photo-import.js');

const JPEG = [255, 216, 255, 217];

function setup(files = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-import-'));
  const dir = path.join(root, 'book');
  const src = path.join(root, 'src');
  fs.mkdirSync(dir); fs.mkdirSync(src);
  for (const f of files) fs.writeFileSync(path.join(dir, f.name), 'old');
  let book = { id: 'b1', docs: { problem: { files } } };
  const remote = [];
  const imports = createPhotoImports({
    readBook: () => JSON.parse(JSON.stringify(book)),
    saveBook: (draft) => { book = JSON.parse(JSON.stringify(draft)); },
    dirFor: () => dir, markOwn: () => {},
    removeRemoteOnly: async (_id, names) => { remote.push(...names); },
    log: { warn() {} },
  });
  const photo = path.join(src, 'p1.jpg');
  fs.writeFileSync(photo, 'photo');
  return { root, dir, imports, photo, remote, get book() { return book; }, set book(b) { book = b; } };
}

const list = (dir) => fs.readdirSync(dir).sort();

async function importOne(t, add) {
  const r = await t.imports.begin('b1', 'problem', [t.photo], add);
  const [file] = r.files;
  const pages = await t.imports.photo({ token: r.token, name: file.name, status: 'prepared', pages: [{ width: 10, height: 10, data: JPEG }, { width: 10, height: 10, data: JPEG }] });
  const prev = t.book.docs.problem.files;
  const files = add ? [...prev, ...pages.map((f) => ({ ...f, added: true }))] : pages;
  return { r, file, pages, draft: { ...t.book, docs: { problem: { files } } } };
}

test('바꾸기: 넣은 뒤 예전 파일·보정 전 원본 사진을 지우고 학원 공간에만 있는 예전 파일도 지움', async () => {
  const t = setup([{ name: 'problem-old-000.png', kind: 'image' }, { name: 'problem-old-001.png', kind: 'image' }]);
  const { r, file, pages, draft } = await importOne(t, false);
  await t.imports.commit(r.token, draft);
  assert.deepEqual(list(t.dir), pages.map((f) => f.name).sort());
  assert.ok(!list(t.dir).includes(file.name));
  assert.deepEqual(t.remote.sort(), ['problem-old-000.png', 'problem-old-001.png']);
  assert.ok(pages.every((f) => !('original' in f)));
  await t.imports.discard(r.token); // 넣은 뒤 discard 는 아무것도 안 지움
  assert.deepEqual(list(t.dir), pages.map((f) => f.name).sort());
});

test('더하기: 예전 파일은 그대로, 보정 전 원본 사진만 지움', async () => {
  const t = setup([{ name: 'problem-old-000.png', kind: 'image' }]);
  const { r, file, pages, draft } = await importOne(t, true);
  await t.imports.commit(r.token, draft);
  assert.deepEqual(list(t.dir), ['problem-old-000.png', ...pages.map((f) => f.name)].sort());
  assert.ok(!list(t.dir).includes(file.name));
  assert.deepEqual(t.remote, []);
});

test('취소: 이번에 복사·보정한 파일만 지우고 예전 파일은 그대로', async () => {
  const t = setup([{ name: 'problem-old-000.png', kind: 'image' }]);
  const { r } = await importOne(t, false);
  await t.imports.discard(r.token);
  assert.deepEqual(list(t.dir), ['problem-old-000.png']);
  await assert.rejects(t.imports.commit(r.token, {}), /다시 파일을 골라/);
});

test('넣는 사이 교재가 바뀌면 넣지 않고, 아무 파일도 지우지 않음 (discard 로 새 파일만 정리)', async () => {
  const t = setup([{ name: 'problem-old-000.png', kind: 'image' }]);
  const { r, draft } = await importOne(t, false);
  t.book = { ...t.book, updatedAt: 1 };
  await assert.rejects(t.imports.commit(r.token, draft), /교재가 바뀌었어요/);
  assert.ok(list(t.dir).includes('problem-old-000.png'));
  await t.imports.discard(r.token);
  assert.deepEqual(list(t.dir), ['problem-old-000.png']);
  assert.deepEqual(t.remote, []);
});
