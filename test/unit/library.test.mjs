import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cloud from '../../src/main/magoedu-cloud.js';
import { libraryLocation, assertLibraryWritable, createSummaryCache } from '../../src/main/library.js';
import { librarySelected, filterBank } from '../../src/renderer/js/bank.js';
import { fakeCloud } from '../lib/fake-cloud.mjs';

const testRoot = mkdtempSync(join(tmpdir(), 'ohdap-library-unit-'));
after(() => {
  if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', "try { Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:LIBRARY_CLEANUP, 'OnlyErrorDialogs', 'SendToRecycleBin') } catch { Write-Output $env:LIBRARY_CLEANUP }"], { env: { ...process.env, LIBRARY_CLEANUP: testRoot } });
  else rmSync(testRoot, { recursive: true, force: true });
});

test('공용 책장 SDK: 환경 변수·경로 검사·요청 구분·중복 제외', async () => {
  const dir = mkdtempSync(join(testRoot, 'sdk-'));
  const library = join(dir, 'library'); mkdirSync(library);
  const fake = fakeCloud({ dir, academyDir: join(dir, 'academy'), libraryDir: library, members: [{ id: 'teacher', name: '선생님', role: 'teacher' }] });
  try {
    const session = cloud.check('ohdapnote', { packaged: false, env: { MAGOEDU_DEV: '1', MAGOEDU_DEV_DIR: dir, ...fake.env } });
    assert.equal(session.libraryDir, library);
    assert.equal(cloud.check('ohdapnote', { packaged: false, env: { MAGOEDU_DEV: '1', MAGOEDU_DEV_DIR: dir } }).libraryDir, '');
    for (const p of ['../escape', '/escape', 'C:/escape', 'a/../b', 'a\\..\\b', 'a//b', 'a\0b']) assert.equal((await cloud.requestLibraryFiles(session, [p])).ok, false, p);
    const result = await cloud.requestLibraryFiles(session, ['books/test.pdf', 'books/test.pdf'], { timeoutMs: 2000 });
    assert.deepEqual(result.missing, ['books/test.pdf']);
    assert.deepEqual(fake.requests, [{ library: true, paths: ['books/test.pdf'] }]);
    writeFileSync(join(library, 'present.pdf'), 'synthetic');
    assert.equal((await cloud.requestLibraryFiles(session, ['present.pdf'])).ok, true);
    assert.equal(fake.requests.length, 1);
    assert.equal((await cloud.requestLibraryFiles({}, ['missing.pdf'])).ok, false);
  } finally { fake.stop(); }
});

test('공용 위치·쓰기 거절·요약 캐시 변경과 삭제', async () => {
  const root = mkdtempSync(join(testRoot, 'cache-'));
  const dir = join(root, 'books', 'exam-0123456789abcdef'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'book.json'); writeFileSync(file, '{"id":"a"}');
  assert.deepEqual(libraryLocation(root, 'exam-0123456789abcdef'), { dir, place: 'library' });
  assert.equal(libraryLocation(root, '../outside'), null);
  assert.equal(libraryLocation('', 'exam-0123456789abcdef'), null);
  assert.throws(() => assertLibraryWritable('library'), /마고 공용 책장/);
  for (const place of ['shared', 'private', 'others']) assert.doesNotThrow(() => assertLibraryWritable(place));
  const cache = createSummaryCache(); let reads = 0;
  const read = async () => ({ read: ++reads });
  assert.equal((await cache.list(root, read))[0].read, 1);
  assert.equal((await cache.list(root, read))[0].read, 1);
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal((await cache.list(root, read))[0].read, 2);
  writeFileSync(file, '{"id":"longer"}');
  assert.equal((await cache.list(root, read))[0].read, 3);
  renameSync(file, join(dir, 'removed.json'));
  assert.deepEqual(await cache.list(root, read), []);
});

test('공용 지연 읽기 조건·시험·연도·학년·과목·월', () => {
  const book = { id: 'exam', library: true, subject: 'math', exam: { exam: 'csat', schoolYear: 2024, year: 2023, grade: 3 }, docs: { problem: {} } };
  assert.equal(librarySelected(book, {}), false);
  assert.equal(librarySelected(book, { month: '11', subject: 'math', grade: '3' }), false);
  for (const filters of [{ exam: 'csat' }, { year: '2024' }, { exam: 'library', month: '11' }]) assert.equal(librarySelected(book, filters), true);
  for (const filters of [{ year: '2023' }, { exam: 'edu' }, { exam: 'all', month: '9' }, { exam: 'all', subject: 'english' }]) assert.equal(librarySelected(book, filters), false);
  const entry = { bookObj: book, bookId: book.id, subject: 'math', item: { page: 0, number: '1' } };
  assert.equal(filterBank([entry], {}).length, 0);
  assert.equal(filterBank([entry], { exam: 'library', month: '11' }).length, 1);
  assert.equal(filterBank([{ ...entry, bookObj: { ...book, exam: { exam: 'edu', year: 2024, month: 3 } } }], { year: '2024', month: '3' }).length, 1);
});
