// 앱에서 사진 넣기: 보정한 쪽만 저장, 더하기·바꾸기 때 파일 정리, 열 때 그림을 읽지 않음.
// 실행: python test/fixtures/make-photo-spreads.py 뒤 node --test test/e2e/photo-import-app.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from '../lib/playwright.mjs';
import { fakeCloud } from '../lib/fake-cloud.mjs';
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PHOTOS = join(ROOT, 'test/fixtures/generated/photo-spreads');
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(OUT, 'photo-import-'));
const academy = join(tmp, 'academy');
const cloud = fakeCloud({ dir: join(tmp, 'cloud'), academyDir: academy, members: [{ id: 'teacher-a', name: '김선생', role: 'teacher' }] });
let app, win, bookId, dir;
const errors = [];
const call = (fn, ...args) => win.evaluate(([f, a]) => window.ohdap[f](...a), [fn, args]);

function findBookDir(root, id) {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(root, e.name);
    if (e.name === id && existsSync(join(p, 'book.json'))) return p;
    const found = findBookDir(p, id);
    if (found) return found;
  }
  return null;
}
const stored = () => readdirSync(dir).filter((n) => n.startsWith('problem-')).sort();

// 화면의 넣기 함수를 그대로 부름 (파일 고르는 창만 건너뜀)
const importPhotos = (paths, add = false) => win.evaluate(async ([id, paths, add]) => {
  const { importBookFiles } = await import('./js/photoimport.js');
  const book = await window.ohdap.getBook(id);
  await importBookFiles(book, 'problem', paths, add);
  return (await window.ohdap.getBook(id)).docs.problem.files;
}, [bookId, paths, add]);

before(async () => {
  const entry = join(tmp, 'launch.cjs');
  writeFileSync(entry, `require('node:module')._initPaths();\nrequire(${JSON.stringify(join(ROOT, 'src/main/main.js'))});\n`);
  app = await electron.launch({
    executablePath: require('electron'), args: ['--no-sandbox', entry], timeout: 30000,
    env: {
      ...process.env, OHDAP_E2E: '1', OHDAP_USER_DATA: join(tmp, 'local'),
      MAGOEDU_DEV: '1', MAGOEDU_ACADEMY: '테스트학원', MAGOEDU_ACADEMY_DIR: academy,
      MAGOEDU_DATA_DIR: join(tmp, 'data'), MAGOEDU_LOCAL_DIR: join(tmp, 'local'),
      MAGOEDU_USER_ID: 'teacher-a', MAGOEDU_USER_NAME: '김선생', MAGOEDU_ROLE: 'teacher',
      ...cloud.env,
    },
  });
  win = await app.firstWindow();
  win.setDefaultTimeout(60000);
  win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForSelector('.seg-tab', { timeout: 20000 });
  bookId = (await call('createBook', '사진 교재')).id;
  dir = findBookDir(tmp, bookId);
  assert.ok(dir, '책 폴더');
});
after(async () => {
  await app?.close();
  cloud.stop();
  assert.deepEqual(errors, []);
});

test('펼친 사진 → 보정한 두 쪽만 남고 원본 사진은 지움', async () => {
  const files = await importPhotos([join(PHOTOS, 'spread-3deg.jpg')]);
  assert.equal(files.length, 2);
  for (const f of files) {
    assert.match(f.name, /^problem-.*-page-[12]\.jpg$/);
    assert.equal(f.photoPrep.status, 'prepared');
    assert.ok(f.width > 1000 && f.height > 1000);
    assert.equal(f.originalName, 'spread-3deg.jpg');
  }
  assert.deepEqual(stored(), files.map((f) => f.name).sort());
});

test('반듯한 그림 더하기 → 그대로 한 쪽, 앞 파일은 그대로', async () => {
  const before = stored();
  const files = await importPhotos([join(PHOTOS, 'flat-1.png')], true);
  assert.equal(files.length, 3);
  const added = files[2];
  assert.equal(added.photoPrep.status, 'unchanged');
  assert.match(added.name, /\.png$/);
  assert.ok(added.width > 0 && added.height > 0);
  assert.deepEqual(stored(), [...before, added.name].sort());
});

test('바꾸기 → 예전 파일은 지우고 새 쪽만, 열 때 그림을 읽지 않음', async () => {
  const files = await importPhotos([join(PHOTOS, 'spread-minus5deg.jpg')]);
  assert.equal(files.length, 2);
  assert.deepEqual(stored(), files.map((f) => f.name).sort());
  const opened = await win.evaluate(async (id) => {
    const { getSource } = await import('./js/shared.js');
    const src = await getSource(await window.ohdap.getBook(id), 'problem');
    const lazy = src._images.size;
    const canvas = await src.renderPage(1, 400);
    return { pages: src.numPages, lazy, w: canvas.width };
  }, bookId);
  assert.deepEqual(opened, { pages: 2, lazy: 0, w: 400 });
});
