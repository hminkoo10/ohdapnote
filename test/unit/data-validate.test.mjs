import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';

// JSON 읽기 목록: settings(.verified), book, note, student, profile, renames, transcripts,
// legacy settings/book/note/project, academy-info, trust, requests/*.done, installed, tokenizer.
// 0.4.0: academy.json 은 미사용. 창 위치·최근 목록·책장 순서는 JSON 으로 저장하지 않음.

const require = createRequire(import.meta.url);
const path = require('node:path');
const mainFile = fileURLToPath(new URL('../../src/main/main.js', import.meta.url));
const localRequire = createRequire(mainFile);
const root = mkdtempSync(fileURLToPath(new URL('../.validate-', import.meta.url)));
after(() => rmSync(root, { recursive: true, force: true }));

// Electron 은 켜지 않고 실제 로더·IPC 를 임시 worktree 데이터로 실행.
function loadMain({ key = '', academy = false, cloudOverrides = {} } = {}) {
  const dir = mkdtempSync(path.join(root, 'main-'));
  const session = { dataDir: dir, localDir: path.join(dir, 'local'), academyDir: academy ? path.join(dir, 'academy') : '', user: { id: 'dev', name: '선생님', academy: '학원', role: 'director' } };
  const handlers = new Map();
  const opened = [];
  const logs = [];
  const log = { initialize() {}, transports: { file: {} }, info: (s) => logs.push(s), warn: (s) => logs.push(s), error: (s) => logs.push(s) };
  const app = { isPackaged: false, getPath: () => dir, setPath() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }) };
  const req = (name) => {
    if (name === 'electron') return { app, shell: { openExternal: async (url) => { opened.push(url); } }, protocol: { registerSchemesAsPrivileged() {} }, ipcMain: { handle: (k, fn) => handlers.set(k, fn), on: (k, fn) => handlers.set(k, fn) } };
    if (name === 'electron-log/main') return log;
    if (name === './magoedu-cloud') return { ...localRequire(name), ...cloudOverrides, check: () => session };
    if (name === './ai' || name === './mathocr') return {};
    return localRequire(name);
  };
  const mod = { exports: {} };
  const source = readFileSync(mainFile, 'utf8');
  const exposed = 'sanitizeSettings, sanitizeBook, sanitizeNote, sanitizeProfile, sanitizeRenames, sanitizeTranscripts, sanitizeLegacyProject, readJson, readJsonSync, loadSettings, listBooks, listAllNotes, listStudents, memberNames, saveProfile, loadRenames, mergedTranscripts, importLegacy, registerIpc, DEFAULT_SETTINGS';
  new Function('require', 'module', '__dirname', 'process', `${source}\nmodule.exports = { ${exposed} };`)(req, mod, path.dirname(mainFile), { ...process, env: { ...process.env, MAGOEDU_DATA_KEY: key } });
  return { ...mod.exports, session, dir, logs, handlers, opened };
}

function loadCloud(env = process.env) {
  const file = fileURLToPath(new URL('../../src/main/magoedu-cloud.js', import.meta.url));
  const mod = { exports: {} };
  const source = readFileSync(file, 'utf8');
  new Function('require', 'module', 'process', `${source}\nObject.assign(module.exports, { sanitizeAcademyInfo, sanitizeTrust, sanitizeRequestResult, sanitizeInstalled, loadKeys, ask });`)(createRequire(file), mod, { ...process, env });
  return mod.exports;
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

const {
  sanitizeSettings,
  sanitizeBook,
  sanitizeNote,
  sanitizeProfile,
  sanitizeRenames,
  sanitizeTranscripts,
  sanitizeLegacyProject,
} = loadMain();
const cloud = loadCloud();
const { sanitizeStudent, sanitizeAcademyInfo, sanitizeTrust, sanitizeRequestResult, sanitizeInstalled } = cloud;
const { relativePath } = require('../../src/main/data-validate.js');

test('데이터 보존 회귀: 학원 명단·개인 학생의 teacher와 새 필드는 그대로 읽음', async () => {
  const m = loadMain();
  const student = { id: 'student-1', name: '학생', teacher: { id: 'teacher-1', name: '담당 교사', color: 'blue' }, extra: { tags: ['새 필드'], enabled: false }, memo: '<보기>\nx < 2' };
  const file = path.join(m.dir, 'academy-info.json');
  const info = { students: [student], future: { version: 10 } };
  writeJson(file, info);
  assert.deepEqual(cloud.academyInfo({ academyInfoFile: file }), info);
  writeJson(path.join(m.dir, 'shared/students/student-1.json'), student);
  assert.deepEqual(await m.listStudents(), [student]);
});

test('데이터 보존 회귀: 책의 새 문항 필드·전사 블록 타입은 IPC 로드·저장 후 동일', async () => {
  const m = loadMain();
  m.registerIpc();
  const book = { id: 'book-1234', kind: 'book', version: 10, name: '<보기>', createdBy: { id: 'dev', name: '교사', extra: 1 }, extra: { enabled: false }, docs: { problem: { files: [], items: [null, { id: 'q', future: { value: 0 }, type: 'new-item' }], options: { future: true } }, future: { data: [1, 2] } } };
  const transcripts = { version: 10, future: 'new', items: { q: { model: 'future-model', extra: true, blocks: [{ type: 'future-block', value: { html: '<b>원문</b>', numbers: [0, -1] } }, null, { type: 'math', latex: 'x < 2', future: 'keep' }] } } };
  const dir = path.join(m.dir, 'shared/books/book-1234');
  writeJson(path.join(dir, 'book.json'), book);
  writeJson(path.join(dir, 'transcripts.json'), transcripts);
  const loaded = await m.handlers.get('books:get')(null, book.id);
  const { $canEdit, $shared, $subjectOpen, ...data } = loaded;
  assert.equal($subjectOpen, true);
  assert.deepEqual(data, book);
  await m.handlers.get('books:save')(null, loaded);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'book.json'), 'utf8')), book);
  const tr = await m.mergedTranscripts(book.id);
  assert.deepEqual(tr, transcripts);
  await m.handlers.get('books:saveTranscripts')(null, { bookId: book.id, data: tr });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'transcripts.json'), 'utf8')), transcripts);
});

test('데이터 보존 회귀: profile·학생·노트 수정은 새 필드를 지우지 않음', async () => {
  const m = loadMain({ academy: true });
  const profile = path.join(m.session.academyDir, 'members/dev/profile.json');
  writeJson(profile, { name: '이전 이름', future: { keep: true } });
  await m.saveProfile();
  assert.deepEqual(JSON.parse(readFileSync(profile, 'utf8')).future, { keep: true });
  const personal = loadMain();
  personal.registerIpc();
  const student = { id: 'student-1', name: '학생', teacher: { id: 'dev', name: '담당' }, future: { keep: true } };
  const studentFile = path.join(personal.dir, 'shared/students/student-1.json');
  writeJson(studentFile, student);
  await personal.handlers.get('students:save')(null, { id: student.id, name: '변경' });
  const saved = JSON.parse(readFileSync(studentFile, 'utf8'));
  assert.deepEqual(saved.teacher, student.teacher);
  assert.deepEqual(saved.future, student.future);
  const note = { id: 'note-1234', bookIds: [], selected: {}, renamesSeen: {}, future: { keep: [null, 1] }, exportOptions: { newOption: true } };
  const noteFile = path.join(personal.dir, 'shared/members/dev/notes/note-1234.json');
  writeJson(noteFile, note);
  const loaded = await personal.handlers.get('notes:get')(null, note.id);
  await personal.handlers.get('notes:save')(null, loaded);
  const savedNote = JSON.parse(readFileSync(noteFile, 'utf8'));
  assert.deepEqual(savedNote.future, note.future);
  assert.deepEqual(savedNote.exportOptions, note.exportOptions);
});

test('데이터 보존 회귀: renames 새 필드 보존, 잘못된 카운터는 사용 시 거부', async () => {
  const m = loadMain();
  m.registerIpc();
  const dir = path.join(m.dir, 'shared/books/book-1234');
  writeJson(path.join(dir, 'book.json'), { id: 'book-1234' });
  const file = path.join(dir, 'renames.json');
  const record = { last: 1, future: { keep: true }, log: [null, { n: 1, future: ['new'], renames: {}, removed: [] }] };
  writeJson(file, record);
  assert.deepEqual(m.loadRenames('book-1234'), record);
  await m.handlers.get('books:renameItems')(null, { bookId: 'book-1234', renames: { a: 'b' }, removed: [] });
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.future, record.future);
  assert.deepEqual(saved.log.slice(0, 2), record.log);
  for (const last of [-1, 1e100, '1']) {
    const bad = { ...record, last };
    writeJson(file, bad);
    assert.deepEqual(m.loadRenames('book-1234'), bad);
    await assert.rejects(m.handlers.get('books:renameItems')(null, { bookId: 'book-1234' }), /변경 기록/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), bad);
  }
});

test('데이터 보존 회귀: 개인 전사 메타데이터·신규 블록도 저장 후 유지', async () => {
  const m = loadMain({ academy: true });
  m.session.user.role = 'teacher';
  m.registerIpc();
  const dir = path.join(m.session.academyDir, 'books/book-1234');
  writeJson(path.join(dir, 'book.json'), { id: 'book-1234', createdBy: { id: 'other' } });
  const shared = { version: 5, extra: 'shared', items: { a: { blocks: [{ type: 'future', data: 1 }] } } };
  const mine = { version: 6, future: { keep: true }, items: { b: { blocks: [{ type: 'new', data: 2 }] } } };
  writeJson(path.join(dir, 'transcripts.json'), shared);
  const file = path.join(m.session.academyDir, 'members/dev/transcripts/book-1234.json');
  writeJson(file, mine);
  const loaded = await m.handlers.get('books:getTranscripts')(null, 'book-1234');
  assert.deepEqual(loaded, { ...shared, ...mine, items: { ...shared.items, ...mine.items } });
  await m.handlers.get('books:saveTranscripts')(null, { bookId: 'book-1234', data: loaded });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...shared, ...mine, items: mine.items });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'transcripts.json'), 'utf8')), shared);
  writeJson(file, { future: mine.future, items: {} });
  assert.deepEqual(await m.mergedTranscripts('book-1234'), { ...shared, future: mine.future });
});

test('파일 받기 결과: missing 생략은 허용, 잘못된 타입은 사용 시 실패 처리', async () => {
  let response;
  const m = loadMain({ cloudOverrides: { requestFiles: async () => response } });
  m.registerIpc();
  writeJson(path.join(m.dir, 'shared/books/book-1234/book.json'), { id: 'book-1234', docs: { problem: { files: [{ name: 'a.pdf' }] } } });
  for (const value of [{ ok: true }, { ok: true, missing: null }, { ok: true, missing: [] }]) {
    response = value;
    assert.equal((await m.handlers.get('books:ensureFiles')(null, 'book-1234')).ok, true);
  }
  for (const value of [{ ok: false }, { ok: 'yes' }, { ok: true, missing: {} }, { ok: true, missing: 'bad' }]) {
    response = value;
    assert.equal((await m.handlers.get('books:ensureFiles')(null, 'book-1234')).ok, false);
    assert.equal(response, value);
  }
});

test('데이터 보존 회귀: 실제 요청 응답도 새 필드·학생 teacher 보존', async () => {
  const dir = mkdtempSync(path.join(root, 'request-data-'));
  const pending = cloud.ask({ requestDir: dir }, { op: 'test' }, 1000);
  const req = readdirSync(dir).find((name) => name.endsWith('.json'));
  const response = { ok: true, student: { id: 'student-1', teacher: { id: 'dev', name: '담당' }, future: 9 }, future: [null, { value: '<b>원문</b>' }], missing: ['../untrusted'] };
  writeJson(path.join(dir, req.replace('.json', '.done.json')), { ...response, constructor: { polluted: true } });
  assert.deepEqual(await pending, response);
});

test('정상 Codex 설치 경로·빈 모델·수식·SSO 만료시각 보존', () => {
  const codexPath = process.platform === 'win32'
    ? path.join(process.env.APPDATA || process.cwd(), 'npm', 'codex.cmd')
    : path.join(require('node:os').homedir(), '.local', 'bin', 'codex'); // CI(리눅스)
  assert.equal(sanitizeSettings({ codexPath }).codexPath, codexPath);
  assert.equal(sanitizeSettings({ openaiModel: '' }).openaiModel, '');
  const t = sanitizeTranscripts({ items: { q: { blocks: [{ type: 'math', latex: 'x < 2' }] } } });
  assert.equal(t.items.q.blocks[0].latex, 'x < 2');
  const expiresAt = Date.now() + 60000;
  assert.equal(sanitizeRequestResult({ ok: true, expiresAt }).expiresAt, expiresAt);
});

test('문서 구조·내보내기 옵션: 알려지지 않은 필드와 값 보존', () => {
  const book = { id: 'book-1234', docs: { answer: { signatures: { future: 1 }, pageCount: 100000, extra: [null, false] } } };
  const note = { id: 'note-1234', exportOptions: { cover: true, labels: 'future', extra: { a: 1 } } };
  assert.deepEqual(sanitizeBook(book), book);
  assert.deepEqual(sanitizeNote(note), note);
});

test('settings: 비정상 타입·범위·URL·prototype 키를 버리고 기본값 병합용 값만 남김', () => {
  const raw = JSON.parse('{"aiEnabled":"yes","aiProvider":"shell","geminiRpm":999,"aiConcurrency":0,"geminiBaseUrl":"javascript:alert(1)","openaiBaseUrl":"https://api.example/v1","__proto__":{"polluted":true}}');
  const out = sanitizeSettings(raw);
  assert.deepEqual(out, { openaiBaseUrl: 'https://api.example/v1' });
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(sanitizeSettings({ codexPath: 'C:\\Windows\\System32\\cmd.exe' }).codexPath, undefined);
  assert.equal(sanitizeSettings({ codexPath: '..\\codex.exe' }).codexPath, undefined);
});

test('book: 경로는 읽을 때 보존하고 파일 사용 직전에 이탈 거부', async () => {
  const m = loadMain();
  m.registerIpc();
  const file = path.join(m.dir, 'shared/books/book-1234/book.json');
  for (const name of ['../evil.pdf', '..\\evil.pdf', '/evil.pdf', 'C:\\evil.pdf', 'C:evil.pdf', 'a.pdf:stream', 'NUL.pdf', 'x.pdf ']) {
    const book = { id: 'book-1234', docs: { problem: { files: [{ name, future: 1 }] } } };
    writeJson(file, book);
    assert.deepEqual(await m.readJson(file, null, sanitizeBook), book);
    for (const channel of ['books:ensureFiles', 'books:copy', 'books:delete']) await assert.rejects(m.handlers.get(channel)(null, book.id), /경로/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), book);
  }
  const book = { id: 'book-1234', docs: { problem: { files: [{ name: 'sub/future.format' }] } } };
  writeJson(file, book);
  mkdirSync(path.join(path.dirname(file), 'sub'), { recursive: true });
  writeFileSync(path.join(path.dirname(file), 'sub/future.format'), 'source');
  assert.deepEqual(await m.handlers.get('books:ensureFiles')(null, book.id), { ok: true, missing: [] });
  await assert.rejects(m.handlers.get('books:get')(null, '../escape'), /ID/);
  await assert.rejects(m.handlers.get('books:getTranscripts')(null, '../escape'), /ID/);
  await assert.rejects(m.handlers.get('books:save')(null, { id: '../escape' }), /잘못된 책/);
});

test('note/student/profile: 알 수 없는 필드·타입·문자열·큰 수는 그대로', () => {
  const raw = { id: '../future', name: '<b>x</b>', bookIds: ['constructor', '../bad'], selected: { q: [null, 'prototype'] }, exportOptions: { columns: 9, format: 'future' }, updatedAt: 2 ** 50, extra: { a: false } };
  for (const fn of [sanitizeNote, sanitizeStudent, sanitizeProfile]) assert.deepEqual(fn(raw), raw);
});

test('renames/transcripts: 새 기록·블록·HTML 원문 보존', () => {
  const renames = { last: 2 ** 40, extra: true, log: [null, { n: 1, future: 'keep', renames: { q: 'next' }, removed: ['prototype', '<bad>'] }] };
  const transcripts = { version: 50, items: { q: { blocks: [{ type: 'para', text: '<img src=x onerror=1>', extra: true }, { type: 'future', value: 3 }], at: -1 } }, extra: [] };
  assert.deepEqual(sanitizeRenames(renames), renames);
  assert.deepEqual(sanitizeTranscripts(transcripts), transcripts);
});

test('cloud JSON: 데이터 보존, trust 키·요청 경로 검증 유지', () => {
  const info = { purgeDays: 0, ai: { provider: 'openai', baseUrl: 'file:///tmp/x', model: '<x>' }, students: [{ id: 'student-1', name: '민수' }], future: true };
  assert.deepEqual(sanitizeAcademyInfo(info), info);
  assert.equal(sanitizeTrust({ keys: [{ kid: 'k', x: 'too-short' }, { kid: 'k2', x: 'A'.repeat(43) }] }).keys.length, 1);
  assert.equal(sanitizeInstalled({ version: '../evil' }), null);
  assert.equal(relativePath('../escape'), undefined);
  assert.equal(relativePath('books/book-1234/a.pdf'), 'books/book-1234/a.pdf');
  const result = { ok: true, missing: ['books/a.pdf', '/etc/passwd', '../x'], future: { status: 5 }, student: { teacher: { id: 'dev', name: '교사' } } };
  assert.deepEqual(sanitizeRequestResult(result), result);
});

test('settings: 기본값과 UI 경계값은 보존, 잘못된 필드는 각각 제외', () => {
  const { DEFAULT_SETTINGS } = loadMain();
  assert.deepEqual(sanitizeSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  for (const [field, max] of [['geminiRpm', 60], ['openaiRpm', 1000], ['anthropicRpm', 1000], ['aiConcurrency', 8], ['aiBatch', 8]]) {
    for (const value of [1, max]) assert.equal(sanitizeSettings({ [field]: value })[field], value);
    for (const value of [null, false, '2', 0, -1, 1.5, NaN, Infinity, max + 1]) assert.equal(sanitizeSettings({ [field]: value })[field], undefined);
  }
  for (const [field, values] of Object.entries({ aiProvider: ['gemini', 'openai', 'anthropic', 'codex'], aiSource: ['academy', 'personal'], motion: ['full', 'reduce'], ocrLang: ['eng', 'kor', 'kor+eng'] })) {
    for (const value of values) assert.equal(sanitizeSettings({ [field]: value })[field], value);
    assert.equal(sanitizeSettings({ [field]: 'unknown' })[field], undefined);
  }
  for (const field of ['geminiModel', 'geminiModel2', 'openaiModel', 'openaiModel2', 'anthropicModel', 'anthropicModel2', 'codexModel']) {
    for (const value of ['', 'qwen2.5vl:7b', 'org/model-name']) assert.equal(sanitizeSettings({ [field]: value })[field], value);
    for (const value of [null, [], '../x', 'x/../y', '<img src=x>', 'x'.repeat(201)]) assert.equal(sanitizeSettings({ [field]: value })[field], undefined);
  }
  for (const field of ['geminiApiKey', 'openaiApiKey', 'anthropicApiKey']) {
    assert.equal(sanitizeSettings({ [field]: 'secret-key' })[field], 'secret-key');
    for (const value of ['key\r\nHeader: bad', 'x'.repeat(4097), {}]) assert.equal(sanitizeSettings({ [field]: value })[field], undefined);
  }
  assert.equal(sanitizeSettings({ aiEnabled: false, teacher: '홍길동', academy: '수학 <보기>' }).aiEnabled, false);
  assert.equal(sanitizeSettings({ teacher: 'x'.repeat(201), academy: '<svg onload=1>' }).teacher, undefined);
});

test('settings: endpoint는 http/https만, Codex는 허용 설치 폴더 안 실행 파일만', () => {
  for (const field of ['geminiBaseUrl', 'openaiBaseUrl', 'anthropicBaseUrl']) {
    for (const value of ['', 'http://localhost:11434/v1', 'https://example.test/v1']) assert.equal(sanitizeSettings({ [field]: value })[field], value);
    for (const value of ['file:///C:/x', 'javascript:alert(1)', 'data:text/html,x', 'https://a\n.test', 'https://user:pass@example.test', 'http://', 'x'.repeat(2049)]) assert.equal(sanitizeSettings({ [field]: value })[field], undefined);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = path.join(root, 'bin');
  try {
    const allowed = path.join(root, 'bin', 'codex.exe');
    assert.equal(sanitizeSettings({ codexPath: allowed }).codexPath, allowed);
    assert.equal(sanitizeSettings({ codexPath: '' }).codexPath, '');
    for (const value of [path.join(root, 'bin-other', 'codex.exe'), path.join(root, 'bin', 'sub', 'codex.exe'), path.join(root, 'bin', 'cmd.exe'), 'bin/codex.exe', `${root}/bin/../codex.exe`, '\\server\share\codex.exe']) assert.equal(sanitizeSettings({ codexPath: value }).codexPath, undefined);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('settings 로드: 키 없음·최초 서명·유효한 서명·복구본 모두 같은 검증', async () => {
  const { signJson } = localRequire('./datasign');
  for (const mode of ['unsigned', 'first', 'signed', 'recovered']) {
    const key = mode === 'unsigned' ? '' : 'test-key';
    const m = loadMain({ key });
    const file = path.join(m.dir, 'settings.json');
    const bad = { aiBatch: -10, geminiRpm: '999', aiProvider: 'openai', openaiBaseUrl: 'file:///x', teacher: '정상', unknown: 1 };
    writeFileSync(file, mode === 'signed' ? signJson(bad, key) : JSON.stringify(bad));
    if (mode === 'recovered') {
      mkdirSync(m.session.localDir, { recursive: true });
      writeFileSync(path.join(m.session.localDir, 'settings.verified.json'), signJson(bad, key));
      writeFileSync(file, '{broken');
    }
    const out = await m.loadSettings();
    assert.equal(out.aiBatch, m.DEFAULT_SETTINGS.aiBatch, mode);
    assert.equal(out.geminiRpm, m.DEFAULT_SETTINGS.geminiRpm, mode);
    assert.equal(out.aiProvider, 'openai', mode);
    assert.equal(out.openaiBaseUrl, '', mode);
    assert.equal(out.teacher, '정상', mode);
    assert.equal(out.unknown, undefined, mode);
    assert.ok(m.logs.some((s) => s.includes('[data]')));
  }
});

test('settings IPC: 저장 전 검증, 빈 모델·경로로 초기화 가능', async () => {
  const m = loadMain();
  m.registerIpc();
  await m.handlers.get('settings:set')(null, { aiConcurrency: Infinity, motion: 'reduce', openaiModel: 'gpt-test' });
  let out = await m.handlers.get('settings:get')();
  assert.equal(out.aiConcurrency, 3);
  assert.equal(out.motion, 'reduce');
  await m.handlers.get('settings:set')(null, { openaiModel: '', codexPath: '' });
  out = await m.loadSettings();
  assert.equal(out.openaiModel, '');
  assert.equal(out.codexPath, '');
});

test('settings·복구본: 과대 파일과 문법 오류도 예외 없이 기본값', async () => {
  for (const key of ['', 'test-key']) {
    const m = loadMain({ key });
    const file = path.join(m.dir, 'settings.json');
    writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
    mkdirSync(m.session.localDir, { recursive: true });
    writeFileSync(path.join(m.session.localDir, 'settings.verified.json'), ' '.repeat(1024 * 1024 + 1));
    assert.equal((await m.loadSettings()).aiBatch, 4);
    writeFileSync(file, '{');
    assert.equal((await m.loadSettings()).aiBatch, 4);
  }
});

test('데이터 가드: 최상위 객체만 허용, 중첩 prototype 키만 제거', async () => {
  const sanitizers = [sanitizeBook, sanitizeNote, sanitizeStudent, sanitizeProfile, sanitizeRenames, sanitizeTranscripts, sanitizeLegacyProject, sanitizeAcademyInfo, sanitizeRequestResult];
  const raw = JSON.parse('{"id":"note-1234","bookIds":["constructor","prototype","__proto__"],"extra":{"keep":1,"__proto__":{"polluted":true}},"items":[null,{"type":"new","constructor":{"prototype":{"polluted":true}},"nested":[{"prototype":1,"text":"<b>원문</b>"}]}],"__proto__":{"polluted":true},"constructor":7,"prototype":9}');
  const expected = { id: 'note-1234', bookIds: ['constructor', 'prototype', '__proto__'], extra: { keep: 1 }, items: [null, { type: 'new', nested: [{ text: '<b>원문</b>' }] }] };
  const before = JSON.stringify(raw);
  const m = loadMain();
  const file = path.join(m.dir, 'data.json');
  for (const fn of sanitizers) {
    for (const value of [null, false, true, 0, 'x', [], [null]]) {
      assert.equal(fn(value), null, fn.name);
      writeJson(file, value);
      assert.deepEqual(await m.readJson(file, {}, fn), {});
      assert.deepEqual(m.readJsonSync(file, {}, fn), {});
    }
    assert.deepEqual(fn(raw), expected, fn.name);
    writeJson(file, raw);
    assert.deepEqual(await m.readJson(file, null, fn), expected);
    assert.deepEqual(m.readJsonSync(file, null, fn), expected);
  }
  assert.equal(JSON.stringify(raw), before);
  assert.equal(Object.prototype.polluted, undefined);
});

test('book: 편집 메타데이터·신규 문서와 서식·배열 원소를 전부 보존', () => {
  const signature = { sizes: [0.02], relX: 0.01, style: 'new-style', future: [1] };
  const pi = { source: 'new-source', columns: 50, cands: [null, { future: true }], extra: 'keep' };
  const doc = { signature, signatures: [signature], pageInfo: { 0: pi }, items: [null, { id: 'q', rects: [{ page: -1, x: 2 }], future: 'keep' }], files: [{ name: '../x.pdf', type: 'new' }] };
  const book = { id: 'book-1234', docs: { problem: doc, supplement: { future: 1 } }, extra: false };
  assert.deepEqual(sanitizeBook(book), book);
});

test('데이터 배열은 자르지 않음, trust 키 제한은 유지', () => {
  assert.equal(sanitizeNote({ id: 'note-1234', bookIds: Array.from({ length: 101 }, (_, i) => `book-${String(i).padStart(4, '0')}`), selected: { 'book-1234': Array.from({ length: 5001 }, (_, i) => `q${i}`) } }).bookIds.length, 101);
  assert.equal(sanitizeNote({ id: 'note-1234', selected: { 'book-1234': Array.from({ length: 5001 }, (_, i) => `q${i}`) } }).selected['book-1234'].length, 5001);
  assert.equal(sanitizeRenames({ last: 300, log: Array.from({ length: 201 }, (_, i) => ({ n: i + 1 })) }).log.length, 201);
  const items = Object.fromEntries(Array.from({ length: 3001 }, (_, i) => [`q${i}`, { blocks: [] }]));
  assert.equal(Object.keys(sanitizeTranscripts({ items }).items).length, 3001);
  assert.equal(sanitizeTranscripts({ items: { q: { blocks: Array(1001).fill({ type: 'para', text: 'x' }) } } }).items.q.blocks.length, 1001);
  assert.equal(sanitizeAcademyInfo({ students: Array(10001).fill({ id: 'student-1', name: '학생' }) }).students.length, 10001);
  assert.equal(sanitizeTrust({ keys: Array(51).fill({ kid: 'k', x: 'A'.repeat(43) }) }).keys.length, 50);
});

test('transcripts: 원문·알 수 없는 블록도 보존, 오염 키만 제거', () => {
  const blocks = [{ type: 'math', latex: '0 < x < 2' }, { type: 'para', text: '<보기>\nㄱ. 조건\nㄴ. 조건' }, { type: 'choices', items: ['1', '2'] }, { type: 'figure', box: { x: 0, y: 0, w: 1, h: 1 } }];
  assert.deepEqual(sanitizeTranscripts({ items: { q: { blocks } } }).items.q.blocks, blocks);
  assert.deepEqual(sanitizeTranscripts(JSON.parse('{"items":{"constructor":{"blocks":[]},"q":{"blocks":[{"type":"script"},{"type":"figure","box":{"x":0,"y":0,"w":0,"h":1}}]}}}')).items, { q: { blocks: [{ type: 'script' }, { type: 'figure', box: { x: 0, y: 0, w: 0, h: 1 } }] } });
});

test('실제 로더: 공유·개인 교재, 모든 노트, profile, 학생, transcript 병합', async () => {
  const m = loadMain({ academy: true });
  const base = m.session.academyDir;
  writeJson(path.join(base, 'books/book-1234/book.json'), { id: 'book-1234', name: '<img src=x>', docs: [] });
  writeJson(path.join(base, 'members/dev/books/book-5678/book.json'), { id: 'book-5678', name: '개인 책' });
  for (const dir of ['members/dev/notes', 'members/other/notes', 'students/student-1/notes']) writeJson(path.join(base, dir, 'note-1234.json'), { id: 'note-1234', title: '<script>x</script>', selected: 'bad' });
  writeJson(path.join(base, 'members/other/profile.json'), { name: '<img src=x>', updatedAt: -1 });
  writeJson(path.join(base, 'books/book-1234/transcripts.json'), { items: { q1: { blocks: [{ type: 'math', latex: 'x < 2' }] } } });
  writeJson(path.join(base, 'members/dev/transcripts/book-1234.json'), { items: { q2: { blocks: [{ type: 'para', text: '개인' }] } } });
  assert.equal((await m.listBooks()).length, 2);
  assert.equal((await m.listBooks())[0].book.name, '<img src=x>');
  const notes = await m.listAllNotes();
  assert.equal(notes.length, 3);
  assert.ok(notes.every(({ note }) => note.title === '<script>x</script>' && note.selected === 'bad'));
  assert.equal((await m.memberNames()).other, '<img src=x>');
  assert.deepEqual(Object.keys((await m.mergedTranscripts('book-1234')).items), ['q1', 'q2']);
  const personal = loadMain();
  writeJson(path.join(personal.dir, 'shared/students/student-1.json'), { id: 'student-1', name: '학생', school: [] });
  assert.deepEqual((await personal.listStudents())[0].school, []);
});

test('JSON 로더: 문법 오류·과대 파일·누락은 기본값, 로그에 값·비밀 없음', async () => {
  const m = loadMain();
  const file = path.join(m.dir, 'profile.json');
  writeFileSync(file, '{"secret":"do-not-log"');
  assert.equal(await m.readJson(file, null, sanitizeProfile), null);
  assert.equal(m.readJsonSync(file, null, sanitizeProfile), null);
  assert.equal(m.logs.length, 1);
  assert.ok(!m.logs[0].includes('do-not-log'));
  writeFileSync(file, ' '.repeat(16 * 1024 * 1024 + 1));
  assert.equal(await m.readJson(file, null, sanitizeProfile), null);
  assert.equal(m.readJsonSync(file, null, sanitizeProfile), null);
  assert.equal(await m.readJson(`${file}.missing`, null, sanitizeProfile), null);
});

test('legacy: 설정은 검증, project·book·note 데이터 보존, academy.json 미사용', async () => {
  const m = loadMain();
  const legacy = path.join(m.session.localDir, 'legacy');
  assert.ok(legacy.startsWith(root + path.sep));
  writeJson(path.join(legacy, 'settings.json'), { aiBatch: -1, motion: 'reduce' });
  writeJson(path.join(legacy, 'projects/book-1234/project.json'), { name: '구형 책', future: { keep: true }, selected: ['q', '__proto__'], docs: { problem: { files: [{ name: '../bad.pdf' }] } }, exportOptions: { columns: 999 } });
  writeJson(path.join(legacy, 'books/book-5678/book.json'), { id: 'book-5678', name: '교재' });
  writeJson(path.join(legacy, 'notes/note-1234.json'), { id: 'note-1234', title: '<script>x</script>' });
  writeJson(path.join(legacy, 'academy.json'), { ai: { provider: 'shell' } });
  assert.deepEqual(await m.importLegacy(), { books: 2, notes: 2 });
  assert.equal((await m.loadSettings()).aiBatch, 4);
  assert.equal((await m.loadSettings()).motion, 'reduce');
  const imported = (await m.listBooks()).find(({ book }) => book.id === 'book-1234').book;
  assert.deepEqual(imported.docs.problem.files, [{ name: '../bad.pdf' }]);
  assert.deepEqual(imported.future, { keep: true });
  assert.ok((await m.listAllNotes()).some(({ note }) => note.selected?.['book-1234']?.includes('__proto__')));
});

test('cloud 파일 로더: 데이터 보존, AI 주소·종류·요청 수는 사용 직전에 검증', () => {
  const dir = mkdtempSync(path.join(root, 'cloud-'));
  const file = path.join(dir, 'academy-info.json');
  const raw = { members: [null, { id: 'dev', name: '선생님', role: 'future' }], students: 'future', ai: { provider: 'gemini', rpm: 100001, baseUrl: 'javascript:x', extra: true } };
  writeJson(file, raw);
  const info = cloud.academyInfo({ academyInfoFile: file });
  assert.deepEqual(info, raw);
  for (const baseUrl of ['javascript:x', 'file:///C:/x', 'data:text/plain,x', 123]) assert.equal(cloud.academyAi({}, { ai: { ...info.ai, baseUrl } }), null);
  const safe = cloud.academyAi({}, { ai: { ...info.ai, baseUrl: 'http://localhost:11434/v1' } });
  assert.equal(safe.baseUrl, 'http://localhost:11434/v1');
  assert.equal(safe.rpm, null);
  assert.equal(cloud.academyAi({}, { ai: { provider: 'shell' } }), null);
  assert.equal(cloud.academyAi({ server: 'file:///C:/x', ticket: 'test' }, { ai: { provider: 'gemini', relay: true } }), null);
  assert.deepEqual(info, raw);
  writeJson(file, { keys: [null, { kid: 'valid', x: 'A'.repeat(43) }, { kid: 'bad', x: {} }] });
  assert.equal(cloud.loadKeys(file).length, 1);
  for (const value of [null, [], 'x', 1, false]) {
    writeJson(file, value);
    assert.equal(cloud.academyInfo({ academyInfoFile: file }), null);
    assert.deepEqual(cloud.loadKeys(file), []);
  }
  writeFileSync(file, '{broken');
  assert.equal(cloud.academyInfo({ academyInfoFile: file }), null);
  writeFileSync(file, ' '.repeat(16 * 1024 * 1024 + 1));
  assert.equal(cloud.academyInfo({ academyInfoFile: file }), null);
});

test('cloud 요청: 경로 이탈 거부·정상 경로 중복 제거·실제 done JSON 검증', async () => {
  const dir = mkdtempSync(path.join(root, 'request-'));
  const session = { requestDir: dir, academyDir: dir };
  for (const paths of [null, ['../x'], ['C:\\Windows\\x'], ['\\\\server\\x'], ['a.pdf:stream'], ['x\u0000']]) {
    assert.equal((await cloud.requestFiles(session, paths)).ok, false);
    assert.equal((await cloud.removeFiles(session, paths)).ok, false);
  }
  writeFileSync(path.join(dir, 'a.pdf'), '');
  assert.equal((await cloud.requestFiles(session, ['a.pdf', 'a.pdf'])).ok, true);
  const result = cloud.ssoCode(session, { timeoutMs: 1000 });
  const req = readdirSync(dir).find((name) => name.endsWith('.json'));
  const expiresAt = Date.now() + 60000;
  writeJson(path.join(dir, req.replace('.json', '.done.json')), { ok: true, ssoCode: 'code-test', expiresAt, constructor: { polluted: true } });
  assert.deepEqual(await result, { ok: true, code: 'code-test', expiresAt });
});

test('installed.json: 버전 형식 제한, 잘못된 업데이트 메타데이터 제외', () => {
  for (const version of ['0.4.0', '1.2.3-beta.1', '1.2.3+build.1']) assert.deepEqual(sanitizeInstalled({ version, unknown: true }), { version });
  for (const version of ['../0.4.0', '1'.repeat(100), 'x', 4, {}, '1.2.3<script>']) assert.equal(sanitizeInstalled({ version }), null);
  if (process.platform === 'win32') {
    const dir = mkdtempSync(path.join(root, 'installed-'));
    const c = loadCloud({ LOCALAPPDATA: dir });
    const file = path.join(dir, 'MagoEduCloud/apps/ohdapnote/installed.json');
    writeJson(file, { version: '0.5.0' });
    assert.equal(c.newerVersionInstalled('ohdapnote', '0.4.0'), '0.5.0');
    writeJson(file, { version: '0.3.0' });
    assert.equal(c.newerVersionInstalled('ohdapnote', '0.4.0'), null);
    writeFileSync(file, 'null');
    assert.equal(c.newerVersionInstalled('ohdapnote', '0.4.0'), null);
  }
});

test('tokenizer.json: 같은 크기로 고친 사전도 해시로 거부', () => {
  const mathocr = localRequire('./mathocr');
  const size = mathocr.MODEL_FILES.find((f) => f.name === 'tokenizer.json').size;
  assert.equal(mathocr.sanitizeTokenizer(Buffer.from('{"model":{"vocab":{"x":"__proto__"}}}')), null);
  assert.equal(mathocr.sanitizeTokenizer(Buffer.alloc(size, 32)), null);
});

test('legacy 짝 정보·신규 source·큰 시각 보존, 재검증은 동일', () => {
  const project = sanitizeLegacyProject({ answerOverrides: { q: 'a' }, selected: ['q'], exportOptions: { columns: 2 }, docs: { problem: { pageInfo: { 0: { source: 'shell' } } } } });
  assert.deepEqual(project.answerOverrides, { q: 'a' });
  assert.equal(project.docs.problem.pageInfo[0].source, 'shell');
  assert.equal(sanitizeProfile({ name: '정상', updatedAt: 2 ** 50 }).updatedAt, 2 ** 50);
  for (const [fn, input] of [[sanitizeSettings, loadMain().DEFAULT_SETTINGS], [sanitizeBook, { id: 'book-1234', docs: { problem: {} } }], [sanitizeNote, { id: 'note-1234' }], [sanitizeStudent, { id: 'student-1', name: '학생', teacherId: 'dev', memo: '첫 줄\n다음 줄' }], [sanitizeProfile, { name: '교사' }], [sanitizeRenames, { last: 1, log: [{ n: 1 }] }], [sanitizeTranscripts, { items: { q: { blocks: [] } } }], [sanitizeAcademyInfo, { students: [] }], [sanitizeRequestResult, { ok: true }]]) {
    const value = fn(input);
    assert.deepEqual(fn(value), value, fn.name);
  }
});

test('도움말 IPC: 세션 서버·http·하위 경로·끝 슬래시와 앵커', async () => {
  const m = loadMain();
  m.registerIpc();
  const open = m.handlers.get('app:openHelp');
  for (const [server, base] of [
    ['https://school.example///', 'https://school.example'],
    ['http://192.168.0.10:8080/', 'http://192.168.0.10:8080'],
    ['https://school.example/cloud/', 'https://school.example/cloud'],
  ]) {
    m.session.server = server;
    for (const section of ['', 'book', 'students', 'note', 'export', 'settings', 'part-2']) {
      await open(null, section);
      assert.equal(m.opened.at(-1), `${base}/help/ohdapnote.html${section ? '#' + section : ''}`);
    }
  }
});

test('도움말 IPC: 비어 있거나 이상한 서버는 기본 서버', async () => {
  const m = loadMain();
  m.registerIpc();
  for (const server of [undefined, '', null, 123, {}, 'not a url', 'http://', 'https:example.com', 'file:///C:/x', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/?x=1', 'https://example.com/#x', 'https://example.com\\x', 'https://example.com\n']) {
    m.session.server = server;
    await m.handlers.get('app:openHelp')(null);
    assert.equal(m.opened.at(-1), 'https://mago.milky.kr/help/ohdapnote.html');
  }
});

test('도움말 IPC: 문자열 아닌 값·앵커 밖 문자는 외부 열기 거부', async () => {
  const m = loadMain();
  m.registerIpc();
  for (const section of [null, 1, {}, [], '#book', 'Book', '책', 'book/name', 'book?x=1', 'book_name', 'book\n', 'book\r', ' book']) {
    assert.equal(await m.handlers.get('app:openHelp')(null, section), false);
  }
  assert.deepEqual(m.opened, []);
});

test('일반 외부 링크 IPC: 기존 https 제한 유지', async () => {
  const m = loadMain();
  m.registerIpc();
  assert.equal(await m.handlers.get('shell:openExternal')(null, 'http://school.example'), false);
  await m.handlers.get('shell:openExternal')(null, 'https://school.example');
  assert.deepEqual(m.opened, ['https://school.example']);
});
