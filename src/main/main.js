'use strict';

// 오답노트 - Electron 메인 프로세스
// - 마고에듀 통합 클라우드에서만 켜짐 (src/main/magoedu-cloud.js). 데이터는 통합 클라우드가 맞춰 주는 폴더에 저장해서
//   같은 아이디의 컴퓨터끼리, 같은 학원 선생님끼리 실시간으로 함께 씀 — 아래 '저장 위치'
// - app:// 프로토콜로 화면(renderer)과 책 파일을 제공
// - 책(문제집/답지 파일 + 분석 결과), 오답노트(학생별 선택), 학생 명단 저장소
// - AI 호출(선택 기능): Gemini(기본) · OpenAI 호환 · Claude · ChatGPT 구독(Codex CLI) — src/main/ai.js
// - 수식 인식(선택 기능, AI 없이 내 컴퓨터에서): Pix2Text MFR — src/main/mathocr.js 를 utilityProcess(mathocr-worker.js)에서
// - 업데이트는 통합 클라우드가 받아 둠 → 종료 코드 75 로 끝내면 새 버전으로 다시 켜짐

const { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu, net, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const log = require('electron-log/main');
const ai = require('./ai');
const mathocr = require('./mathocr');
const cloud = require('./magoedu-cloud');

log.initialize();
log.transports.file.level = 'info';

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const isSmokeTest = process.env.OHDAP_E2E === '1';
// 배포본에서는 개발자 도구를 막는다 (창의 개발자 도구, 원격 디버깅으로 붙기). 개발 실행에서만 열 수 있음
const devTools = !app.isPackaged;
if (app.isPackaged && ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk'].some((s) => app.commandLine.hasSwitch(s))) app.exit(1);

if (process.env.OHDAP_USER_DATA) {
  app.setPath('userData', process.env.OHDAP_USER_DATA);
}

// 통합 클라우드에서 켜졌는지 확인. 개발 실행·시험(빌드 전)은 통합 클라우드 없이 userData 아래 폴더를 씀
function startCloudSession() {
  let env = process.env;
  if (!app.isPackaged && !env.MAGOEDU_TICKET && env.MAGOEDU_DEV !== '1') {
    const base = app.getPath('userData');
    env = { ...env, MAGOEDU_DEV: '1', MAGOEDU_DATA_DIR: path.join(base, 'data'), MAGOEDU_LOCAL_DIR: base };
  }
  return cloud.check('ohdapnote', { packaged: app.isPackaged, env });
}
const session = startCloudSession();
if (session) app.setPath('userData', session.localDir); // 이 컴퓨터에만 두는 것 (모델, 로그, 화면 캐시)
const me = session?.user || {}; // { id: 계정 ID, name, role, academy: 학원 이름 }

// 작업이 끝났다는 윈도우 알림이 설치한 바로가기(appId)와 같은 앱으로 뜨게
if (process.platform === 'win32') app.setAppUserModelId('io.github.hminkoo10.ohdapnote');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/octet-stream',
};

const PDF_EXT = new Set(['.pdf']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);

// ---------------------------------------------------------------------------
// 저장 위치
//   학원 공간 (MAGOEDU_ACADEMY_DIR, 같은 학원 선생님 모두가 봄 — 통합 클라우드 docs/INTEGRATION.md 4-1)
//     books/<id>/book.json · 원본 파일 · transcripts.json · renames.json   학원 공유 교재 (만든 사람·원장만 고침)
//     students/<id>.json                                                   학생 명단 (누구나 등록, 등록한 사람·원장만 고침)
//     academy.json                                                         학원 공용 AI 키 (원장만 고침)
//     members/<계정>/notes/<id>.json · transcripts/<책 id>.json · profile.json   내 오답노트 (나와 원장만 봄, 나만 고침)
//     members/<계정>/books/<id>/ (books/<id>/ 와 같은 구조)                   나만 보기 교재 (나와 원장만 봄, 나만 고침)
//   학원이 없는 계정은 개인 공간의 shared/ 를 같은 구조로 씀 (공유는 안 됨)
//   개인 공간 (MAGOEDU_DATA_DIR): settings.json — 내 AI 키·화면 설정 (같은 아이디의 컴퓨터끼리)
//   이 컴퓨터만 (MAGOEDU_LOCAL_DIR = userData): 수식 인식 모델, 로그, legacy/ (예전에 따로 깔아 쓰던 데이터 — 처음 켤 때 옮김)
// ---------------------------------------------------------------------------

const academyMode = () => !!session.academyDir; // 학원 선생님끼리 함께 씀
const isManager = () => me.role === 'director' || me.role === 'admin'; // 원장(운영자): 남의 교재도 고치고 오답노트를 모두 봄
const sharedDir = () => session.academyDir || path.join(session.dataDir, 'shared');
const dataDir = sharedDir;
const booksDir = () => path.join(sharedDir(), 'books');
const studentsDir = () => path.join(sharedDir(), 'students');
const academyFile = () => path.join(sharedDir(), 'academy.json');
const membersDir = () => path.join(sharedDir(), 'members');
const settingsFile = () => path.join(session.dataDir, 'settings.json');
const legacyDir = () => path.join(session.localDir, 'legacy');

function isValidId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id);
}

function memberDir(uid) {
  if (typeof uid !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(uid)) throw new Error('잘못된 계정');
  return path.join(membersDir(), uid);
}
const myBooksDir = () => path.join(memberDir(me.id), 'books'); // 나만 보기 교재 (학원 공간에서만)

/** 새 책 폴더: 학원 공유면 books/<id>, 나만 보기면 members/<나>/books/<id> (학원이 없으면 늘 books/) */
function newBookDir(id, shared = true) {
  if (!isValidId(id)) throw new Error('잘못된 책 ID');
  return path.join(academyMode() && !shared ? myBooksDir() : booksDir(), id);
}

/**
 * 책 폴더 찾기 → { dir, place }  place: shared(학원 공유) | private(내 나만 보기) | others(다른 선생님의 나만 보기)
 * books/<id> → members/<나>/books/<id> → 원장이면 members/<다른 계정>/books/<id> (선생님 오답노트에 쓴 책을 열 수 있게).
 * book.json 이 있는 첫 곳. 없으면 books/<id>
 */
function locateBook(id) {
  const shared = newBookDir(id);
  if (!academyMode() || fs.existsSync(path.join(shared, 'book.json'))) return { dir: shared, place: 'shared' };
  const mine = path.join(myBooksDir(), id);
  if (fs.existsSync(path.join(mine, 'book.json'))) return { dir: mine, place: 'private' };
  if (isManager()) {
    let uids = [];
    try {
      uids = fs.readdirSync(membersDir(), { withFileTypes: true }).filter((e) => e.isDirectory() && /^[A-Za-z0-9-]{1,64}$/.test(e.name) && e.name !== me.id).map((e) => e.name);
    } catch {
      /* members/ 없음 */
    }
    for (const uid of uids) {
      const dir = path.join(membersDir(), uid, 'books', id);
      if (fs.existsSync(path.join(dir, 'book.json'))) return { dir, place: 'others' };
    }
  }
  return { dir: shared, place: 'shared' };
}
const bookDir = (id) => locateBook(id).dir;
const bookFile = (id) => path.join(bookDir(id), 'book.json');

/** 통합 클라우드에 받기·지우기를 부탁할 때 쓰는 학원 공간 안의 경로 ('/' 로 구분) */
const cloudRel = (file) => path.relative(sharedDir(), file).split(path.sep).join('/');
const notesDirOf = (uid) => path.join(memberDir(uid), 'notes');
const myTranscriptsFile = (bookId) => path.join(memberDir(me.id), 'transcripts', `${bookId}.json`);

function noteFile(id, uid = me.id) {
  if (!isValidId(id)) throw new Error('잘못된 오답노트 ID');
  return path.join(notesDirOf(uid), `${id}.json`);
}

function studentFile(id) {
  if (!isValidId(id)) throw new Error('잘못된 학생 ID');
  return path.join(studentsDir(), `${id}.json`);
}

/** base 아래에 있는 경로인지 확인(디렉터리 탈출 방지) */
function safeJoin(base, rel) {
  const resolved = path.resolve(base, rel);
  const baseResolved = path.resolve(base) + path.sep;
  if (!resolved.startsWith(baseResolved)) throw new Error('잘못된 경로');
  return resolved;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonSync(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value), 'utf8');
  markOwn(file);
  await fsp.rename(tmp, file);
}

function writeJsonAtomicSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  markOwn(file);
  fs.renameSync(tmp, file);
}

const DEFAULT_SETTINGS = {
  aiEnabled: true, // false 면 AI 를 전혀 쓰지 않음 (디지털 PDF 는 PDF 글자로, 나머지는 그림으로)
  aiProvider: 'gemini', // gemini | openai(OpenAI 호환) | anthropic(Claude) | codex(ChatGPT 구독)
  geminiApiKey: '',
  geminiModel: 'gemini-flash-latest', // 1순위
  geminiModel2: '', // 1순위 한도가 다 찼거나 안 될 때 쓰는 2순위
  geminiRpm: 8,
  geminiBaseUrl: '', // 비우면 Google 주소, 게이트웨이를 쓰면 그 주소
  openaiBaseUrl: '', // 비우면 https://api.openai.com/v1 (로컬: http://localhost:11434/v1 등)
  openaiApiKey: '', // 로컬 서버면 비워 둠
  openaiModel: '',
  openaiModel2: '',
  openaiRpm: 60,
  anthropicApiKey: '',
  anthropicModel: 'claude-opus-5-5',
  anthropicModel2: '',
  anthropicRpm: 50,
  anthropicBaseUrl: '',
  codexModel: '', // 비우면 Codex CLI 기본 모델
  codexPath: '', // 비우면 자동으로 찾음
  aiConcurrency: 3, // 동시에 보내는 요청 수
  aiBatch: 4, // 한글 내보내기: 한 요청에 담는 문항 수
  ocrLang: 'kor+eng',
  academy: '', // 학원 이름 (내보내기 기본값)
  teacher: '', // 선생님 이름 (내보내기 기본값)
  motion: 'full', // full: 애니메이션 켜기, reduce: 줄이기
};

/** 내 설정 (개인 공간). 학원·선생님 이름이 비어 있으면 통합 클라우드 계정에서 */
async function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...(await readJson(settingsFile(), {})) };
  if (!s.academy) s.academy = me.academy || '';
  if (!s.teacher) s.teacher = me.name || '';
  return s;
}

// 학원 공용 AI 키 (academy.json 의 ai, 원장만 고침): 내 키가 없으면 이것을 씀
const ACADEMY_KEYS = ['geminiApiKey', 'openaiApiKey', 'anthropicApiKey'];

async function loadAcademyAi() {
  if (!academyMode()) return {};
  const a = await readJson(academyFile(), {});
  return Object.fromEntries(ACADEMY_KEYS.filter((k) => typeof a?.ai?.[k] === 'string' && a.ai[k]).map((k) => [k, a.ai[k]]));
}

/** 화면에는 학원 키가 있는지만 알려 줌 (선생님에게 키를 보이지 않음) */
const academyAiFlags = (ai) => ({ gemini: !!ai.geminiApiKey, openai: !!ai.openaiApiKey, anthropic: !!ai.anthropicApiKey });

/** AI 를 부를 때 쓰는 설정: 내 키가 없으면 학원 공용 키 */
async function effectiveSettings() {
  const [s, ai] = await Promise.all([loadSettings(), loadAcademyAi()]);
  for (const k of ACADEMY_KEYS) if (!s[k] && ai[k]) s[k] = ai[k];
  return s;
}

// ---------------------------------------------------------------------------
// app:// 프로토콜
//   app://bundle/<path>            → src/renderer/<path>
//   app://book/<id>/<file>         → 그 책 폴더의 <file> (locateBook. 아직 받지 않은 원본은 통합 클라우드에 받아 달라고 한 뒤)
// ---------------------------------------------------------------------------

async function serveFile(file) {
  const ext = path.extname(file).toLowerCase();
  const data = await fsp.readFile(file);
  return new Response(data, {
    status: 200,
    headers: {
      'content-type': MIME[ext] || 'application/octet-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    },
  });
}

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (url.host === 'bundle') {
        return await serveFile(safeJoin(RENDERER_DIR, rel || 'index.html'));
      }
      if (url.host === 'book') {
        const [id, ...rest] = rel.split('/');
        const file = safeJoin(bookDir(id), rest.join('/'));
        if (!fs.existsSync(file)) await fetchBookFiles(id, [rest.join('/')]);
        return await serveFile(file);
      }
      return new Response('not found', { status: 404 });
    } catch (err) {
      log.warn('[protocol]', request.url, err.message);
      return new Response('not found', { status: 404 });
    }
  });
}

/** 책의 원본 파일 이름들 (문제집·답지) */
const sourceFiles = (book) =>
  ['problem', 'answer'].flatMap((role) => (book?.docs?.[role]?.files || []).map((f) => f?.name)).filter((n) => typeof n === 'string' && n);

// 원본 파일(PDF·그림)은 크니까 학원 공간에서 '열 때만 받음' (magoedu-app.json 의 shared.lazy)
const fetching = new Map(); // 학원 공간 경로 → 받는 중 (Promise)

/** 아직 받지 않은 원본을 통합 클라우드에 받아 달라고 하고 기다림 → { ok, missing, error? } */
async function fetchBookFiles(id, names) {
  const dir = bookDir(id);
  const rels = [...new Set(names)].filter((n) => n && !fs.existsSync(safeJoin(dir, n))).map((n) => cloudRel(safeJoin(dir, n)));
  if (!rels.length) return { ok: true, missing: [] };
  const fresh = rels.filter((r) => !fetching.has(r));
  if (fresh.length) {
    send('files:fetching', { bookId: id, count: fresh.length });
    const p = cloud.requestFiles(session, fresh).finally(() => {
      for (const r of fresh) fetching.delete(r);
      send('files:fetched', { bookId: id });
    });
    for (const r of fresh) fetching.set(r, p);
  }
  const results = await Promise.all([...new Set(rels.map((r) => fetching.get(r)).filter(Boolean))]);
  const missing = rels.filter((r) => results.some((x) => (x.missing || []).includes(r)));
  return { ok: !missing.length, missing, error: results.find((x) => x.error)?.error };
}

/** 이 컴퓨터에 받지 않은 원본은 폴더에서 지울 수 없으니 서버에서 지워 달라고 함 (책을 지우거나 원본을 바꿀 때) */
async function removeRemoteOnly(id, names) {
  const dir = bookDir(id);
  const gone = names.filter((n) => !fs.existsSync(path.join(dir, n))).map((n) => cloudRel(path.join(dir, n)));
  if (gone.length) await cloud.removeFiles(session, gone).catch((err) => log.warn('[remove]', err.message));
}

/** 책 폴더를 통째로 복사 (학원 공유 켜고 끌 때). book.json 은 맨 나중에 — 다 옮기기 전에는 새 자리를 책으로 보지 않게 */
async function copyBookFiles(from, to) {
  const files = [];
  const walk = async (rel) => {
    for (const e of await fsp.readdir(path.join(from, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) await walk(r);
      else if (e.isFile() && !/\.(tmp|magoedu-dl|part)$/i.test(e.name)) files.push(r);
    }
  };
  await walk('');
  files.sort((a, b) => (a === 'book.json') - (b === 'book.json'));
  for (const r of files) {
    await fsp.mkdir(path.dirname(path.join(to, r)), { recursive: true });
    markOwn(path.join(to, r));
    await fsp.copyFile(path.join(from, r), path.join(to, r));
  }
}

// ---------------------------------------------------------------------------
// 창
// ---------------------------------------------------------------------------

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: '오답노트',
    backgroundColor: '#f4f5f7',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://bundle/')) event.preventDefault();
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (devTools && input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.loadURL('app://bundle/index.html');
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// 책 / 오답노트 / 학생 저장소
// ---------------------------------------------------------------------------

const count = (d) => (d && Array.isArray(d.items) ? d.items.length : 0);
const flaggedPages = (d) => Object.values(d?.pageInfo || {}).filter((pi) => pi?.flags?.length).length;
const createdByMe = () => ({ id: me.id, name: me.name || '' });

/** 고칠 수 있는지 (교재·학생): 학원 공간에서는 만든 사람과 원장만. 서버도 같은 규칙이라 다른 사람이 고치면 통합 클라우드가 되돌림 */
function canEdit(obj) {
  return !academyMode() || isManager() || obj?.createdBy?.id === me.id;
}

/** 책을 고칠 수 있는지: 다른 선생님의 나만 보기 책(members/<그 사람>/)은 그 사람만 고침 — 원장도 보기만 */
const canEditBook = (book, place) => canEdit(book) && place !== 'others';

/** 화면에 넘길 때만 붙이는 값($로 시작)은 저장하지 않음 */
function stripMeta(obj) {
  const out = { ...obj };
  for (const k of Object.keys(out)) if (k.startsWith('$')) delete out[k];
  return out;
}

function summarizeBook(book, place = 'shared') {
  const docs = book.docs || {};
  return {
    id: book.id,
    name: book.name,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    createdBy: book.createdBy || null,
    canEdit: canEditBook(book, place),
    shared: academyMode() && place === 'shared', // 학원 공유 (끄면 나만 보기 — 원장은 볼 수 있음)
    mine: !academyMode() || book.createdBy?.id === me.id, // 내 책장 (학원 공간에서)
    problemFile: docs.problem?.originalName || '',
    answerFile: docs.answer?.originalName || '',
    problemCount: count(docs.problem),
    answerCount: count(docs.answer),
    problemAnalyzed: !!docs.problem?.analyzedAt,
    answerAnalyzed: !!docs.answer?.analyzedAt,
    flagged: flaggedPages(docs.problem) + flaggedPages(docs.answer),
  };
}

function summarizeNote(note, owner, ownerName) {
  const selected = note.selected || {};
  return {
    id: note.id,
    title: note.title,
    student: note.student || '',
    studentId: note.studentId || '',
    bookIds: note.bookIds || [],
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    selectedCount: Object.values(selected).reduce((s, list) => s + (Array.isArray(list) ? list.length : 0), 0),
    mine: owner === me.id, // 원장이 보는 다른 선생님 오답노트는 false (보기·내보내기만)
    owner,
    ownerName,
  };
}

async function listJson(dir, fileOf) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const file = fileOf(entry);
    if (!file) continue;
    const value = await readJson(file, null);
    if (value) out.push(value);
  }
  return out;
}

const JSON_ID = /^[a-zA-Z0-9-]{8,64}\.json$/;
/** 책장: 학원 공유(books/) + 내 나만 보기(members/<나>/books/, 학원 공간에서만) → [{ book, place }] */
async function listBooks() {
  const inDir = async (dir, place) =>
    (await listJson(dir, (e) => (e.isDirectory() && isValidId(e.name) ? path.join(dir, e.name, 'book.json') : null))).map((book) => ({ book, place }));
  const shared = await inDir(booksDir(), 'shared');
  if (!academyMode()) return shared;
  const ids = new Set(shared.map((x) => x.book.id)); // 두 곳에 다 있으면 locateBook 처럼 학원 공유 쪽
  return [...shared, ...(await inDir(myBooksDir(), 'private')).filter((x) => !ids.has(x.book.id))];
}
const listNotesOf = (uid) => listJson(notesDirOf(uid), (e) => (e.isFile() && JSON_ID.test(e.name) ? path.join(notesDirOf(uid), e.name) : null));
const listNotes = () => listNotesOf(me.id);
const listStudents = () => listJson(studentsDir(), (e) => (e.isFile() && JSON_ID.test(e.name) ? path.join(studentsDir(), e.name) : null));

/** 학원 공간 members/ 아래 계정들 (원장만 남의 것을 받음) */
async function memberIds() {
  const out = (await fsp.readdir(membersDir(), { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && /^[A-Za-z0-9-]{1,64}$/.test(e.name))
    .map((e) => e.name);
  return out.includes(me.id) ? out : [...out, me.id];
}

/** 계정 → 이름 (members/<계정>/profile.json) */
async function memberNames() {
  const names = { [me.id]: me.name || '' };
  for (const uid of await memberIds()) {
    const p = await readJson(path.join(memberDir(uid), 'profile.json'), null);
    if (p?.name && uid !== me.id) names[uid] = String(p.name);
  }
  return names;
}

/** 원장이 오답노트 목록에서 누구 것인지 알 수 있게 내 이름을 남김 */
async function saveProfile() {
  if (!academyMode()) return;
  const file = path.join(memberDir(me.id), 'profile.json');
  if ((await readJson(file, null))?.name === me.name) return;
  await writeJsonAtomic(file, { name: me.name || '', updatedAt: Date.now() });
}

/** 오답노트 목록: 내 것, 원장이면 학원 모든 선생님 것 → [{ note, owner }] */
async function listAllNotes() {
  const uids = academyMode() && isManager() ? await memberIds() : [me.id];
  const out = [];
  for (const uid of uids) for (const note of await listNotesOf(uid)) out.push({ note, owner: uid });
  return out;
}

/** 오답노트 파일 찾기: 내 것, 원장이면 다른 선생님 것도 → { file, owner } */
async function findNote(id) {
  const mine = noteFile(id);
  if (fs.existsSync(mine) || !academyMode() || !isManager()) return { file: mine, owner: me.id };
  for (const uid of await memberIds()) {
    const f = noteFile(id, uid);
    if (fs.existsSync(f)) return { file: f, owner: uid };
  }
  return { file: mine, owner: me.id };
}

// 문항 ID 는 위치로 정해져서 책 주인이 번호를 고치면 바뀜. 다른 선생님의 오답노트는 내가 고칠 수 없으니
// 책에 바뀐 기록(renames.json { last, log: [{ n, renames, removed }] })을 남기고, 각자 오답노트를 열 때 따라 바꿈
// (오답노트의 renamesSeen[책 id] = 어디까지 따라 바꿨는지)
const RENAME_KEEP = 200;
const renamesFile = (bookId) => path.join(bookDir(bookId), 'renames.json');

function loadRenames(bookId) {
  const r = readJsonSync(renamesFile(bookId));
  return { last: Number(r?.last) || 0, log: Array.isArray(r?.log) ? r.log : [] };
}

/** 오답노트의 선택을 바뀐 ID 대로. 바뀌었으면 true */
function applyRenames(note, bookId, renames, removed) {
  const list = note.selected?.[bookId];
  if (!Array.isArray(list) || !list.length) return false;
  const map = new Map(Object.entries(renames || {}));
  const gone = new Set(removed || []);
  const next = [...new Set(list.filter((id) => !gone.has(id)).map((id) => map.get(id) || id))];
  if (next.length === list.length && next.every((v, i) => v === list[i])) return false;
  note.selected[bookId] = next;
  return true;
}

/** 아직 따라 바꾸지 않은 기록을 적용. 바뀌었으면 true */
function catchUpRenames(note) {
  let changed = false;
  note.renamesSeen ||= {};
  for (const bookId of note.bookIds || []) {
    if (!isValidId(bookId)) continue;
    const r = loadRenames(bookId);
    const seen = Number(note.renamesSeen[bookId]) || 0;
    for (const e of r.log) if (e?.n > seen && applyRenames(note, bookId, e.renames, e.removed)) changed = true;
    if (r.last !== seen) {
      note.renamesSeen[bookId] = r.last;
      changed = true;
    }
  }
  return changed;
}

/** 오답노트에 새로 넣은 책은 지금까지의 기록을 이미 따른 것으로 */
function stampRenames(note) {
  note.renamesSeen ||= {};
  for (const bookId of note.bookIds || []) {
    if (isValidId(bookId) && note.renamesSeen[bookId] === undefined) note.renamesSeen[bookId] = loadRenames(bookId).last;
  }
  return note;
}

/**
 * 예전에 따로 깔아 쓰던 오답노트 데이터(%APPDATA%\OhdapNote\data)는 통합 클라우드가 처음 켤 때 물어보고 legacy/ 로 복사해 줌
 * (magoedu-app.json 의 legacy). 여기서 새 자리로 옮김: 책 → 학원 공간(만든 사람 = 나), 오답노트 → 내 오답노트,
 * AI 키 같은 설정 → 내 설정의 빈 칸. 더 예전 버전(projects/<id>/project.json: 책 + 선택이 한 파일)은 책 + 오답노트로 나눔.
 * 같은 ID 가 이미 있으면 건너뜀 (다른 컴퓨터에서 먼저 옮김). 다 옮기면 legacy/ 를 지움
 */
async function importLegacy() {
  const src = legacyDir();
  if (!fs.existsSync(src)) return null;
  const done = { books: 0, notes: 0 };
  const dirs = async (sub) => (await fsp.readdir(path.join(src, sub), { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && isValidId(e.name)).map((e) => e.name);
  // 옮긴 책은 새 책처럼 학원 공유 (books/)
  const copyBook = async (from, id, book) => {
    await fsp.cp(from, newBookDir(id), { recursive: true, filter: (f) => !/\.tmp$/i.test(f) && path.basename(f) !== 'project.json' });
    await writeJsonAtomic(path.join(newBookDir(id), 'book.json'), { ...book, id, createdBy: createdByMe() });
    done.books += 1;
  };
  const addNote = async (note) => {
    await writeJsonAtomic(noteFile(note.id), stampRenames(note));
    done.notes += 1;
  };

  for (const id of await dirs('books')) {
    const book = await readJson(path.join(src, 'books', id, 'book.json'), null);
    if (!book || fs.existsSync(bookFile(id))) continue;
    await copyBook(path.join(src, 'books', id), id, book).catch((err) => log.error('[legacy] book', id, err));
  }
  for (const name of await dirs('projects')) {
    const from = path.join(src, 'projects', name);
    const project = await readJson(path.join(from, 'project.json'), null);
    const id = project?.id && isValidId(project.id) ? project.id : name;
    if (!project || fs.existsSync(bookFile(id))) continue;
    try {
      const at = { createdAt: project.createdAt || Date.now(), updatedAt: project.updatedAt || Date.now() };
      await copyBook(from, id, { id, kind: 'book', version: 2, name: project.name || '책', ...at, docs: project.docs || { problem: null, answer: null }, answerOverrides: project.answerOverrides || {} });
      const noteId = crypto.randomUUID();
      await addNote({ id: noteId, kind: 'note', version: 2, title: project.name || '오답노트', student: '', bookIds: [id], selected: { [id]: project.selected || [] }, exportOptions: project.exportOptions || null, ...at });
      log.info('[legacy] project → book + note', id);
    } catch (err) {
      log.error('[legacy] project', name, err);
    }
  }
  for (const e of await fsp.readdir(path.join(src, 'notes'), { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile() || !JSON_ID.test(e.name)) continue;
    const id = e.name.slice(0, -5);
    const note = await readJson(path.join(src, 'notes', e.name), null);
    if (!note || fs.existsSync(noteFile(id))) continue;
    await addNote({ ...note, id }).catch((err) => log.error('[legacy] note', id, err));
  }
  const old = await readJson(path.join(src, 'settings.json'), null);
  if (old && typeof old === 'object') {
    const cur = await readJson(settingsFile(), {});
    const filled = Object.fromEntries(Object.entries(cur).filter(([, v]) => v !== '' && v != null));
    await writeJsonAtomic(settingsFile(), { ...old, ...filled });
  }
  await fsp.rm(src, { recursive: true, force: true });
  log.info('[legacy] imported', done);
  return done;
}

/** 책의 수식 변환 결과 + 내가 따로 만든 것 */
async function mergedTranscripts(id) {
  const shared = await readJson(path.join(bookDir(id), 'transcripts.json'), {});
  const mine = academyMode() ? await readJson(myTranscriptsFile(id), {}) : {};
  if (!Object.keys(mine?.items || {}).length) return shared || {};
  return { ...shared, version: 1, items: { ...(shared?.items || {}), ...mine.items } };
}

const aiRequests = new Map(); // requestId → AbortController

// 수식 인식: 모델 폴더, 일꾼(utilityProcess — 처음 인식할 때 띄우고 2분 쉬면 끔), 진행 중인 설치·인식
// 모델은 설치 파일에 들어 있음(resources/models). 없으면(개발 실행) 설정에서 받아 둔 userData/models 를 씀
const mathocrBundledDir = () => path.join(process.resourcesPath, 'models', 'pix2text-mfr-1.5');
const mathocrDownloadDir = () => path.join(app.getPath('userData'), 'models', 'pix2text-mfr-1.5');
const mathocrDir = () => (mathocr.modelStatus(mathocrBundledDir()).installed ? mathocrBundledDir() : mathocrDownloadDir());
const MATHOCR_IDLE_MS = 2 * 60 * 1000;
let mathocrWorker = null; // { proc, pending: Map<일꾼 요청 id, resolve>, idle }
let mathocrInstall = null; // AbortController
let mathocrSeq = 0;
const mathocrRequests = new Map(); // 화면의 requestId → 일꾼 요청 id

function startMathocrWorker() {
  if (mathocrWorker) return mathocrWorker;
  const proc = utilityProcess.fork(path.join(__dirname, 'mathocr-worker.js'), [], { serviceName: 'OhdapNote 수식 인식' });
  const w = { proc, pending: new Map(), idle: null };
  proc.on('message', (msg) => {
    if (msg?.type !== 'done') return;
    const resolve = w.pending.get(msg.id);
    w.pending.delete(msg.id);
    resolve?.(msg);
    if (!w.pending.size) {
      clearTimeout(w.idle);
      w.idle = setTimeout(() => mathocrWorker === w && stopMathocrWorker(), MATHOCR_IDLE_MS);
    }
  });
  proc.on('exit', (code) => {
    if (mathocrWorker === w) mathocrWorker = null;
    clearTimeout(w.idle);
    for (const resolve of w.pending.values()) resolve({ ok: false, error: `수식 인식이 멈췄어요 (코드 ${code}).` });
    w.pending.clear();
    if (code) log.warn('[mathocr] worker exit', code);
  });
  mathocrWorker = w;
  return w;
}

function stopMathocrWorker() {
  const w = mathocrWorker;
  if (!w) return;
  mathocrWorker = null;
  clearTimeout(w.idle);
  w.proc.kill(); // 남은 요청은 'exit' 에서 실패로 끝남
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    dataDir: dataDir(),
    platform: process.platform,
    developer: '구현민',
    user: { id: me.id || '', name: me.name || '', role: me.role || '', academy: me.academy || '' },
    academy: academyMode(), // 학원 선생님끼리 교재·학생 명단을 함께 씀
    manager: isManager(), // 원장: 남의 교재도 고치고, 학원 오답노트를 모두 봄 (남의 오답노트는 보기만)
  }));

  ipcMain.handle('settings:get', async () => ({ ...(await loadSettings()), academyAi: academyAiFlags(await loadAcademyAi()) }));
  ipcMain.handle('settings:set', async (_e, patch) => {
    const next = { ...(await loadSettings()), ...(patch || {}) };
    delete next.academyAi;
    await writeJsonAtomic(settingsFile(), next);
    return { ...next, academyAi: academyAiFlags(await loadAcademyAi()) };
  });

  // ---- 학원 공용 AI 키 (원장만 보고 고침) ----
  ipcMain.handle('academy:getAi', async () => (academyMode() && isManager() ? loadAcademyAi() : {}));
  ipcMain.handle('academy:setAi', async (_e, ai) => {
    if (!academyMode() || !isManager()) throw new Error('원장만 학원 공용 AI 키를 바꿀 수 있어요.');
    const cur = await readJson(academyFile(), {});
    const keys = Object.fromEntries(ACADEMY_KEYS.map((k) => [k, String(ai?.[k] || '').trim()]).filter(([, v]) => v));
    await writeJsonAtomic(academyFile(), { ...cur, ai: keys });
    return academyAiFlags(keys);
  });

  // ---- 책 ----
  ipcMain.handle('books:list', async () => {
    const list = (await listBooks()).map(({ book, place }) => summarizeBook(book, place));
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
  });

  // 새 책은 학원 공유가 기본 (shared: false 면 나만 보기)
  ipcMain.handle('books:create', async (_e, { name, shared = true } = {}) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const book = {
      id,
      kind: 'book',
      version: 2,
      name: (name || '').trim() || '새 책',
      createdAt: now,
      updatedAt: now,
      createdBy: createdByMe(),
      docs: { problem: null, answer: null },
      answerOverrides: {},
    };
    await writeJsonAtomic(path.join(newBookDir(id, shared), 'book.json'), book);
    return { ...book, $canEdit: true, $shared: academyMode() && !!shared };
  });

  // $shared: 학원 공유인지 (학원 공간에서만 true 가 될 수 있음)
  ipcMain.handle('books:get', async (_e, id) => {
    const { dir, place } = locateBook(id);
    const book = await readJson(path.join(dir, 'book.json'), null);
    if (!book) throw new Error('책을 찾을 수 없습니다.');
    return { ...book, $canEdit: canEditBook(book, place), $shared: academyMode() && place === 'shared' };
  });

  /** 지금 저장된 책을 고칠 수 있는지 (만든 사람은 바뀌지 않음) → 저장된 책 */
  function checkBookWrite(id) {
    const { dir, place } = locateBook(id);
    const cur = readJsonSync(path.join(dir, 'book.json'));
    if (cur && !canEditBook(cur, place)) throw new Error(place === 'others' ? '나만 보기 책은 만든 선생님만 고칠 수 있어요.' : '만든 사람과 원장만 고칠 수 있어요.');
    return cur;
  }
  const toSave = (book, cur) => ({ ...stripMeta(book), createdBy: cur?.createdBy || book.createdBy || createdByMe() });

  ipcMain.handle('books:save', async (_e, book) => {
    if (!book || !isValidId(book.id)) throw new Error('잘못된 책');
    const cur = checkBookWrite(book.id);
    await writeJsonAtomic(bookFile(book.id), toSave(book, cur));
    return true;
  });

  // 창을 닫을 때 마지막 변경 사항을 동기적으로 저장
  ipcMain.on('books:saveSync', (event, book) => {
    try {
      if (book && isValidId(book.id)) writeJsonAtomicSync(bookFile(book.id), toSave(book, checkBookWrite(book.id)));
      event.returnValue = true;
    } catch (err) {
      log.error('[books:saveSync]', err);
      event.returnValue = false;
    }
  });

  ipcMain.handle('books:delete', async (_e, id) => {
    const book = checkBookWrite(id);
    await removeRemoteOnly(id, sourceFiles(book));
    await fsp.rm(bookDir(id), { recursive: true, force: true });
    // 내 오답노트에서 빼기 (다른 선생님 오답노트에는 '지워진 책'으로 남음)
    for (const note of await listNotes()) {
      if (!(note.bookIds || []).includes(id)) continue;
      note.bookIds = note.bookIds.filter((b) => b !== id);
      if (note.selected) delete note.selected[id];
      if (note.renamesSeen) delete note.renamesSeen[id];
      await writeJsonAtomic(noteFile(note.id), note);
    }
    return true;
  });

  /** 남의 책을 내 책으로 복사 (원본 파일을 먼저 받음): 새 ID, 만든 사람 = 나, 이름에 (복사본) */
  ipcMain.handle('books:copy', async (_e, id) => {
    const book = await readJson(bookFile(id), null);
    if (!book) throw new Error('책을 찾을 수 없습니다.');
    const files = sourceFiles(book);
    const got = await fetchBookFiles(id, files);
    if (!got.ok) throw new Error('교재 파일을 받지 못해 복사할 수 없어요. 인터넷 연결을 확인해 주세요.');
    const newId = crypto.randomUUID();
    const now = Date.now();
    const from = bookDir(id);
    const to = newBookDir(newId); // 새 책처럼 학원 공유
    await fsp.mkdir(to, { recursive: true });
    for (const name of files) {
      markOwn(path.join(to, name));
      await fsp.copyFile(path.join(from, name), path.join(to, name));
    }
    const tr = await mergedTranscripts(id);
    if (Object.keys(tr.items || {}).length) await writeJsonAtomic(path.join(to, 'transcripts.json'), tr);
    const copy = { ...stripMeta(book), id: newId, name: `${book.name || '책'} (복사본)`, createdBy: createdByMe(), createdAt: now, updatedAt: now };
    await writeJsonAtomic(path.join(to, 'book.json'), copy);
    return summarizeBook(copy);
  });

  /**
   * 학원 공유 켜고 끄기 (만든 사람만): 책 폴더를 books/<id> ↔ members/<나>/books/<id> 로 옮김 → 새 요약.
   * 끄면 다른 선생님에게는 지워진 책처럼 보임 (원장은 볼 수 있음)
   */
  ipcMain.handle('books:setShared', async (_e, { id, shared } = {}) => {
    if (!academyMode()) throw new Error('학원 공간에서만 공유를 바꿀 수 있어요.');
    const { dir: from, place } = locateBook(id);
    const book = readJsonSync(path.join(from, 'book.json'));
    if (!book) throw new Error('책을 찾을 수 없습니다.');
    if (place === 'others' || book.createdBy?.id !== me.id) throw new Error('책을 만든 사람만 공유를 바꿀 수 있어요.');
    const to = newBookDir(id, !!shared);
    if (path.resolve(to) === path.resolve(from)) return summarizeBook(book, place);
    // 받지 않은 원본은 옮길 수 없으니 먼저 모두 받음
    const got = await fetchBookFiles(id, sourceFiles(book));
    if (!got.ok) throw new Error('교재 파일을 다 받지 못해 공유를 바꾸지 못했어요. 인터넷 연결을 확인해 주세요.');
    // 먼저 복사하고(지난번에 옮기다 남은 것은 지움) 다 되면 예전 폴더를 지움 → 중간에 멈춰도 잃는 것이 없음
    await fsp.rm(to, { recursive: true, force: true });
    await copyBookFiles(from, to);
    await fsp.rm(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return summarizeBook(readJsonSync(path.join(to, 'book.json')) || book, shared ? 'shared' : 'private');
  });

  /** 책을 열 때: 아직 받지 않은 원본 파일을 미리 받음 → { ok, missing, error? } */
  ipcMain.handle('books:ensureFiles', async (_e, id) => {
    const book = await readJson(bookFile(id), null);
    return book ? fetchBookFiles(id, sourceFiles(book)) : { ok: false, missing: [] };
  });

  /** 책에서 문항 ID 가 바뀌었을 때(번호 고침 등) 오답노트의 선택도 따라 바꿈 (다른 선생님 것은 각자 열 때) */
  ipcMain.handle('books:renameItems', async (_e, { bookId, renames, removed }) => {
    if (!isValidId(bookId)) return 0;
    const { dir, place } = locateBook(bookId);
    const book = readJsonSync(path.join(dir, 'book.json'));
    if (!book || !canEditBook(book, place)) return 0;
    const r = loadRenames(bookId);
    const n = r.last + 1;
    await writeJsonAtomic(renamesFile(bookId), { last: n, log: [...r.log, { n, renames: renames || {}, removed: removed || [] }].slice(-RENAME_KEEP) });
    let changed = 0;
    for (const note of await listNotes()) {
      if (!(note.bookIds || []).includes(bookId) || !catchUpRenames(note)) continue;
      await writeJsonAtomic(noteFile(note.id), note);
      changed++;
    }
    return changed;
  });

  // ---- 오답노트 ----
  ipcMain.handle('notes:list', async () => {
    const names = await memberNames();
    const list = (await listAllNotes()).map(({ note, owner }) => summarizeNote(note, owner, names[owner] || ''));
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
  });

  ipcMain.handle('notes:create', async (_e, { title, student, studentId, bookIds } = {}) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const ids = (Array.isArray(bookIds) ? bookIds : []).filter(isValidId);
    const note = stampRenames({
      id,
      kind: 'note',
      version: 2,
      title: (title || '').trim() || '오답노트',
      student: (student || '').trim(),
      studentId: isValidId(studentId) ? studentId : '',
      bookIds: ids,
      selected: Object.fromEntries(ids.map((b) => [b, []])),
      exportOptions: null,
      createdAt: now,
      updatedAt: now,
    });
    await writeJsonAtomic(noteFile(id), note);
    return note;
  });

  // 다른 선생님 오답노트(원장만 열 수 있음)는 $readonly — 저장하지 않음
  ipcMain.handle('notes:get', async (_e, id) => {
    const { file, owner } = await findNote(id);
    const note = await readJson(file, null);
    if (!note) throw new Error('오답노트를 찾을 수 없습니다.');
    if (catchUpRenames(note) && owner === me.id) await writeJsonAtomic(file, note);
    if (owner === me.id) return note;
    return { ...note, $readonly: true, $ownerName: (await memberNames())[owner] || '' };
  });

  ipcMain.handle('notes:save', async (_e, note) => {
    if (!note || !isValidId(note.id)) throw new Error('잘못된 오답노트');
    if (note.$readonly) return false;
    await writeJsonAtomic(noteFile(note.id), stampRenames(stripMeta(note)));
    return true;
  });

  ipcMain.on('notes:saveSync', (event, note) => {
    try {
      if (note && isValidId(note.id) && !note.$readonly) writeJsonAtomicSync(noteFile(note.id), stampRenames(stripMeta(note)));
      event.returnValue = true;
    } catch (err) {
      log.error('[notes:saveSync]', err);
      event.returnValue = false;
    }
  });

  ipcMain.handle('notes:delete', async (_e, id) => {
    await fsp.rm(noteFile(id), { force: true });
    return true;
  });

  // ---- 학생 명단 (학원 공용: 누구나 등록, 등록한 선생님·원장만 고치고 지움) ----
  ipcMain.handle('students:list', async () => {
    const list = (await listStudents()).map((s) => ({ ...s, canEdit: canEdit(s) }));
    list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko'));
    return list;
  });

  ipcMain.handle('students:save', async (_e, s = {}) => {
    const id = isValidId(s.id) ? s.id : crypto.randomUUID();
    const cur = readJsonSync(studentFile(id));
    if (cur && !canEdit(cur)) throw new Error('학생을 등록한 선생님과 원장만 고칠 수 있어요.');
    const name = String(s.name || '').trim();
    if (!name) throw new Error('학생 이름을 적어 주세요.');
    const now = Date.now();
    const text = (v) => String(v || '').trim().slice(0, 200);
    const student = {
      id,
      name: name.slice(0, 60),
      school: text(s.school),
      grade: text(s.grade),
      memo: text(s.memo),
      createdBy: cur?.createdBy || createdByMe(),
      createdAt: cur?.createdAt || now,
      updatedAt: now,
    };
    await writeJsonAtomic(studentFile(id), student);
    return { ...student, canEdit: true };
  });

  ipcMain.handle('students:delete', async (_e, id) => {
    const cur = readJsonSync(studentFile(id));
    if (cur && !canEdit(cur)) throw new Error('학생을 등록한 선생님과 원장만 지울 수 있어요.');
    await fsp.rm(studentFile(id), { force: true });
    return true;
  });

  ipcMain.handle('files:pick', async (_e, { title } = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || '파일 선택',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'PDF 또는 이미지', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
        { name: '모든 파일', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  // 선택한 파일(들)을 책 폴더로 복사
  ipcMain.handle('files:import', async (_e, { bookId, role, paths }) => {
    if (!['problem', 'answer'].includes(role)) throw new Error('잘못된 문서 종류');
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('파일이 없습니다.');
    const cur = checkBookWrite(bookId);
    const dir = bookDir(bookId);
    await fsp.mkdir(dir, { recursive: true });

    // 이미지 여러 장은 파일 이름 순(숫자 자연 정렬)으로 정렬
    const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
    const sorted = [...paths].sort((a, b) => collator.compare(path.basename(a), path.basename(b)));
    for (const p of sorted) {
      const ext = path.extname(p).toLowerCase();
      if (!PDF_EXT.has(ext) && !IMAGE_EXT.has(ext)) {
        throw new Error(`지원하지 않는 파일 형식입니다: ${path.basename(p)}`);
      }
    }

    // 이전 파일 삭제 (이 컴퓨터에 받지 않은 것은 서버에서)
    await removeRemoteOnly(bookId, (cur?.docs?.[role]?.files || []).map((f) => f?.name).filter((n) => typeof n === 'string' && n.startsWith(`${role}-`)));
    for (const name of await fsp.readdir(dir)) {
      if (name.startsWith(`${role}-`)) await fsp.rm(path.join(dir, name), { force: true });
    }

    const stamp = Date.now().toString(36);
    const files = [];
    let index = 0;
    for (const p of sorted) {
      const ext = path.extname(p).toLowerCase();
      const stored = `${role}-${stamp}-${String(index).padStart(3, '0')}${ext}`;
      markOwn(path.join(dir, stored));
      await fsp.copyFile(p, path.join(dir, stored));
      files.push({ name: stored, originalName: path.basename(p), kind: PDF_EXT.has(ext) ? 'pdf' : 'image' });
      index += 1;
    }
    const originalName =
      sorted.length === 1 ? path.basename(sorted[0]) : `${path.basename(sorted[0])} 외 ${sorted.length - 1}개`;
    return { files, originalName };
  });

  ipcMain.handle('files:savePdf', async (_e, { defaultName, data }) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'PDF 저장',
      defaultPath: path.join(app.getPath('documents'), defaultName || '오답노트.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.writeFile(result.filePath, Buffer.from(data));
    return { canceled: false, path: result.filePath };
  });

  // 아무 종류의 파일 저장 (한글 문서 등): 저장 창에서 고른 곳에
  ipcMain.handle('files:saveFile', async (_e, { defaultName, data, filters, title } = {}) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: title || '파일 저장',
      defaultPath: path.join(app.getPath('documents'), path.basename(String(defaultName || '오답노트'))),
      filters: Array.isArray(filters) && filters.length ? filters : undefined,
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.writeFile(result.filePath, Buffer.from(data));
    return { canceled: false, path: result.filePath };
  });

  // 한글 문서로 내보낼 때 AI 로 옮긴 글자·수식 (다시 묻지 않게 저장): 책을 고칠 수 있으면 책 폴더(모두가 함께 씀),
  // 남의 책이면 책에 있는 것과 다른 것만 내 폴더(members/<나>/transcripts/<책 id>.json)에 — 읽을 때 합침
  ipcMain.handle('books:getTranscripts', async (_e, id) => mergedTranscripts(id));
  ipcMain.handle('books:saveTranscripts', async (_e, { bookId, data } = {}) => {
    const { dir, place } = locateBook(bookId);
    if (!fs.existsSync(dir)) return false; // 그 사이 지워진 책
    if (canEditBook(readJsonSync(path.join(dir, 'book.json')), place)) {
      await writeJsonAtomic(path.join(dir, 'transcripts.json'), data || {});
      return true;
    }
    const shared = (await readJson(path.join(dir, 'transcripts.json'), {}))?.items || {};
    const items = Object.fromEntries(Object.entries(data?.items || {}).filter(([k, v]) => JSON.stringify(shared[k]) !== JSON.stringify(v)));
    await writeJsonAtomic(myTranscriptsFile(bookId), { version: 1, items });
    return true;
  });

  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('cloud:open', () => cloud.openCloud());
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url);
    return false;
  });

  // ---- AI (선택 기능) ----
  ipcMain.handle('ai:abort', (_e, requestId) => {
    const ctrl = aiRequests.get(requestId);
    if (ctrl) ctrl.abort();
    return !!ctrl;
  });
  ipcMain.handle('ai:generate', async (_e, { provider, model, body, requestId } = {}) => {
    const settings = await effectiveSettings();
    const ctrl = new AbortController();
    if (requestId) aiRequests.set(requestId, ctrl);
    try {
      return await ai.generate({ provider, model, body, settings, signal: ctrl.signal, fetch: (...a) => net.fetch(...a) });
    } catch (err) {
      log.error('[ai]', err);
      return { ok: false, status: 0, error: err.message };
    } finally {
      if (requestId) aiRequests.delete(requestId);
    }
  });
  ipcMain.handle('ai:listModels', async (_e, { provider, apiKey, baseUrl } = {}) =>
    ai.listModels({ provider, apiKey, baseUrl, settings: await effectiveSettings(), fetch: (...a) => net.fetch(...a) }),
  );
  ipcMain.handle('ai:codexStatus', async (_e, { path: exe } = {}) => ai.codexStatus(exe ?? (await effectiveSettings()).codexPath));

  // ---- 수식 인식 (선택 기능, 모델을 한 번 받아 두면 인터넷 없이) ----
  ipcMain.handle('mathocr:status', () => {
    const dir = mathocrDir();
    return { ...mathocr.modelStatus(dir), bundled: dir !== mathocrDownloadDir() };
  });
  ipcMain.handle('mathocr:install', async () => {
    if (mathocrInstall) return { ok: false, error: '이미 받고 있어요.' };
    const ctrl = new AbortController();
    mathocrInstall = ctrl;
    try {
      // 새로 받은 파일을 쓰도록 모델을 열어 둔 일꾼은 끔
      stopMathocrWorker();
      await mathocr.installModel({
        dir: mathocrDownloadDir(),
        signal: ctrl.signal,
        fetch: (...a) => net.fetch(...a),
        onProgress: (p) => send('mathocr:progress', p),
      });
      return { ok: true };
    } catch (err) {
      if (err.name === 'AbortError') return { ok: false, aborted: true, error: err.message };
      log.error('[mathocr] install', err);
      return { ok: false, error: err.message };
    } finally {
      mathocrInstall = null;
    }
  });
  ipcMain.handle('mathocr:cancelInstall', () => {
    if (mathocrInstall) mathocrInstall.abort();
    return !!mathocrInstall;
  });
  ipcMain.handle('mathocr:abort', (_e, requestId) => {
    const id = mathocrRequests.get(requestId);
    if (id && mathocrWorker) mathocrWorker.proc.postMessage({ type: 'abort', id });
    return !!id;
  });
  ipcMain.handle('mathocr:recognize', async (_e, { images, requestId, maxTokens } = {}) => {
    if (mathocrInstall) return { ok: false, error: '모델을 받는 중이에요.' };
    if (!mathocr.modelStatus(mathocrDir()).installed) return { ok: false, error: '수식 인식 모델이 아직 설치되지 않았어요.' };
    const id = ++mathocrSeq;
    if (requestId) mathocrRequests.set(requestId, id);
    try {
      const w = startMathocrWorker();
      clearTimeout(w.idle);
      const msg = await new Promise((resolve) => {
        w.pending.set(id, resolve);
        w.proc.postMessage({ type: 'recognize', id, modelDir: mathocrDir(), images: images || [], maxTokens });
      });
      if (msg.ok) return { ok: true, results: msg.results };
      if (msg.aborted) return { ok: false, aborted: true, error: msg.error };
      log.error('[mathocr] recognize', msg.error);
      return { ok: false, error: msg.error };
    } catch (err) {
      log.error('[mathocr] recognize', err);
      return { ok: false, error: err.message };
    } finally {
      if (requestId) mathocrRequests.delete(requestId);
    }
  });
}

// ---------------------------------------------------------------------------
// 실시간: 다른 컴퓨터·선생님이 바꾼 파일이 통합 클라우드를 통해 들어오면 화면에 알림 (data:changed)
// ---------------------------------------------------------------------------

const ownWrites = new Map(); // 방금 내가 쓴 파일 → 그때 (지켜보기에서 건너뜀)
const OWN_MS = 3000;
let watchers = [];
let changedPaths = new Set();
let changeTimer = null;

function markOwn(file) {
  const now = Date.now();
  if (ownWrites.size > 500) for (const [k, t] of ownWrites) if (now - t > OWN_MS) ownWrites.delete(k);
  ownWrites.set(path.resolve(file), now);
}

function watchData() {
  const roots = session.academyDir ? [session.academyDir, session.dataDir] : [session.dataDir];
  for (const root of roots) {
    try {
      fs.mkdirSync(root, { recursive: true });
      const w = fs.watch(root, { recursive: true }, (_type, name) => {
        if (!name) return;
        const abs = path.resolve(root, String(name));
        if (/\.(tmp|magoedu-dl|part)$/i.test(abs)) return;
        if (Date.now() - (ownWrites.get(abs) || 0) < OWN_MS) return;
        try {
          if (fs.statSync(abs).isDirectory()) return; // 안의 파일이 바뀌면 폴더도 알려 옴 (파일 쪽 알림으로 충분)
        } catch {
          /* 지워짐 → 알림 */
        }
        changedPaths.add(abs);
        clearTimeout(changeTimer);
        changeTimer = setTimeout(flushChanges, 400);
      });
      w.on('error', (err) => log.warn('[watch]', err.message));
      watchers.push(w);
    } catch (err) {
      log.warn('[watch]', root, err.message);
    }
  }
}

/** 바뀐 파일 → { books: [책 id], notes: [오답노트 id], students, academy, settings } */
function flushChanges() {
  const out = { books: new Set(), notes: new Set(), students: false, academy: false, settings: false };
  for (const abs of changedPaths) {
    if (abs === path.resolve(settingsFile())) {
      out.settings = true;
      continue;
    }
    const rel = path.relative(sharedDir(), abs).split(path.sep);
    if (rel[0] === 'books' && isValidId(rel[1])) out.books.add(rel[1]);
    else if (rel[0] === 'members' && rel[2] === 'books' && isValidId(rel[3])) out.books.add(rel[3]); // 나만 보기 교재
    else if (rel[0] === 'members' && rel[2] === 'notes' && JSON_ID.test(rel[3] || '')) out.notes.add(rel[3].slice(0, -5));
    else if (rel[0] === 'members' && rel[2] === 'profile.json') out.notes.add('*');
    else if (rel[0] === 'students') out.students = true;
    else if (rel[0] === 'academy.json') out.academy = true;
  }
  changedPaths = new Set();
  send('data:changed', { ...out, books: [...out.books], notes: [...out.notes] });
}

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------

if (!session) {
  // 통합 클라우드에서 켜지 않음 → 안내하고 통합 클라우드를 열어 줌
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({ type: 'info', title: '오답노트', message: cloud.reason(), buttons: ['확인'] });
    cloud.openCloud('ohdapnote');
    app.exit(0);
  });
} else if (!isSmokeTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    await importLegacy().catch((err) => log.error('[legacy]', err));
    await saveProfile().catch((err) => log.warn('[profile]', err.message));
    registerAppProtocol();
    registerIpc();
    createWindow();
    watchData();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
  app.on('will-quit', () => {
    ai.killAll(); // 돌고 있던 codex 도 같이 끔
    stopMathocrWorker();
    for (const w of watchers) w.close();
    watchers = [];
  });
}
