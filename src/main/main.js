'use strict';

// 오답노트 - Electron 메인 프로세스
// - app:// 프로토콜로 화면(renderer)과 프로젝트 파일을 제공
// - 책(문제집/답지 파일 + 분석 결과)과 오답노트(학생별 선택) 저장소
// - AI 호출(선택 기능): Gemini(기본) · OpenAI 호환 · Claude · ChatGPT 구독(Codex CLI) — src/main/ai.js
// - GitHub Releases 기반 자동 업데이트

const { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const log = require('electron-log/main');
const ai = require('./ai');

log.initialize();
log.transports.file.level = 'info';

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const isSmokeTest = process.env.OHDAP_E2E === '1';

if (process.env.OHDAP_USER_DATA) {
  app.setPath('userData', process.env.OHDAP_USER_DATA);
}

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
// 경로/저장소 유틸
// ---------------------------------------------------------------------------

const dataDir = () => path.join(app.getPath('userData'), 'data');
const projectsDir = () => path.join(dataDir(), 'projects'); // 예전 버전(책+선택이 한 파일) — 처음 실행 때 옮김
const booksDir = () => path.join(dataDir(), 'books');
const notesDir = () => path.join(dataDir(), 'notes');
const settingsFile = () => path.join(dataDir(), 'settings.json');

function isValidId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id);
}

function bookDir(id) {
  if (!isValidId(id)) throw new Error('잘못된 책 ID');
  return path.join(booksDir(), id);
}
const bookFile = (id) => path.join(bookDir(id), 'book.json');

function noteFile(id) {
  if (!isValidId(id)) throw new Error('잘못된 오답노트 ID');
  return path.join(notesDir(), `${id}.json`);
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

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fsp.rename(tmp, file);
}

function writeJsonAtomicSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

const DEFAULT_SETTINGS = {
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

async function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(await readJson(settingsFile(), {})) };
}

// ---------------------------------------------------------------------------
// app:// 프로토콜
//   app://bundle/<path>            → src/renderer/<path>
//   app://book/<id>/<file>         → <userData>/data/books/<id>/<file>
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
        return await serveFile(safeJoin(bookDir(id), rest.join('/')));
      }
      return new Response('not found', { status: 404 });
    } catch (err) {
      log.warn('[protocol]', request.url, err.message);
      return new Response('not found', { status: 404 });
    }
  });
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
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
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
// 책 / 오답노트 저장소
// ---------------------------------------------------------------------------

const count = (d) => (d && Array.isArray(d.items) ? d.items.length : 0);
const flaggedPages = (d) => Object.values(d?.pageInfo || {}).filter((pi) => pi?.flags?.length).length;

function summarizeBook(book) {
  const docs = book.docs || {};
  return {
    id: book.id,
    name: book.name,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    problemFile: docs.problem?.originalName || '',
    answerFile: docs.answer?.originalName || '',
    problemCount: count(docs.problem),
    answerCount: count(docs.answer),
    problemAnalyzed: !!docs.problem?.analyzedAt,
    answerAnalyzed: !!docs.answer?.analyzedAt,
    flagged: flaggedPages(docs.problem) + flaggedPages(docs.answer),
  };
}

function summarizeNote(note) {
  const selected = note.selected || {};
  return {
    id: note.id,
    title: note.title,
    student: note.student || '',
    bookIds: note.bookIds || [],
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    selectedCount: Object.values(selected).reduce((s, list) => s + (Array.isArray(list) ? list.length : 0), 0),
  };
}

async function listJson(dir, fileOf) {
  await fsp.mkdir(dir, { recursive: true });
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const file = fileOf(entry);
    if (!file) continue;
    const value = await readJson(file, null);
    if (value) out.push(value);
  }
  return out;
}

const listBooks = () =>
  listJson(booksDir(), (e) => (e.isDirectory() && isValidId(e.name) ? path.join(booksDir(), e.name, 'book.json') : null));
const listNotes = () =>
  listJson(notesDir(), (e) => (e.isFile() && /^[a-zA-Z0-9-]{8,64}\.json$/.test(e.name) ? path.join(notesDir(), e.name) : null));

/** 예전 버전 데이터(projects/<id>/project.json: 책 + 선택)를 책 + 오답노트로 나눔 */
async function migrateProjects() {
  let entries;
  try {
    entries = await fsp.readdir(projectsDir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidId(entry.name)) continue;
    const from = path.join(projectsDir(), entry.name);
    const project = await readJson(path.join(from, 'project.json'), null);
    if (!project) continue;
    try {
      const id = project.id && isValidId(project.id) ? project.id : entry.name;
      const book = {
        id,
        kind: 'book',
        version: 2,
        name: project.name || '책',
        createdAt: project.createdAt || Date.now(),
        updatedAt: project.updatedAt || Date.now(),
        docs: project.docs || { problem: null, answer: null },
        answerOverrides: project.answerOverrides || {},
      };
      await fsp.mkdir(booksDir(), { recursive: true });
      await fsp.rename(from, bookDir(id));
      await writeJsonAtomic(bookFile(id), book);
      await fsp.rm(path.join(bookDir(id), 'project.json'), { force: true });
      const noteId = crypto.randomUUID();
      await writeJsonAtomic(noteFile(noteId), {
        id: noteId,
        kind: 'note',
        version: 2,
        title: project.name || '오답노트',
        student: '',
        bookIds: [id],
        selected: { [id]: project.selected || [] },
        exportOptions: project.exportOptions || null,
        createdAt: project.createdAt || Date.now(),
        updatedAt: project.updatedAt || Date.now(),
      });
      log.info('[migrate] project → book + note', id);
    } catch (err) {
      log.error('[migrate]', entry.name, err);
    }
  }
  try {
    if (!(await fsp.readdir(projectsDir())).length) await fsp.rmdir(projectsDir());
  } catch {
    /* 무시 */
  }
}

const aiRequests = new Map(); // requestId → AbortController

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    dataDir: dataDir(),
    platform: process.platform,
    developer: '구현민',
  }));

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', async (_e, patch) => {
    const next = { ...(await loadSettings()), ...(patch || {}) };
    await writeJsonAtomic(settingsFile(), next);
    return next;
  });

  // ---- 책 ----
  ipcMain.handle('books:list', async () => {
    const list = (await listBooks()).map(summarizeBook);
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
  });

  ipcMain.handle('books:create', async (_e, { name } = {}) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const book = {
      id,
      kind: 'book',
      version: 2,
      name: (name || '').trim() || '새 책',
      createdAt: now,
      updatedAt: now,
      docs: { problem: null, answer: null },
      answerOverrides: {},
    };
    await writeJsonAtomic(bookFile(id), book);
    return book;
  });

  ipcMain.handle('books:get', async (_e, id) => {
    const book = await readJson(bookFile(id), null);
    if (!book) throw new Error('책을 찾을 수 없습니다.');
    return book;
  });

  ipcMain.handle('books:save', async (_e, book) => {
    if (!book || !isValidId(book.id)) throw new Error('잘못된 책');
    await writeJsonAtomic(bookFile(book.id), book);
    return true;
  });

  // 창을 닫을 때 마지막 변경 사항을 동기적으로 저장
  ipcMain.on('books:saveSync', (event, book) => {
    try {
      if (book && isValidId(book.id)) writeJsonAtomicSync(bookFile(book.id), book);
      event.returnValue = true;
    } catch (err) {
      log.error('[books:saveSync]', err);
      event.returnValue = false;
    }
  });

  ipcMain.handle('books:delete', async (_e, id) => {
    await fsp.rm(bookDir(id), { recursive: true, force: true });
    // 이 책을 쓰던 오답노트에서 빼기
    for (const note of await listNotes()) {
      if (!(note.bookIds || []).includes(id)) continue;
      note.bookIds = note.bookIds.filter((b) => b !== id);
      if (note.selected) delete note.selected[id];
      await writeJsonAtomic(noteFile(note.id), note);
    }
    return true;
  });

  /** 책에서 문항 ID 가 바뀌었을 때(번호 고침 등) 오답노트의 선택도 따라 바꿈 */
  ipcMain.handle('books:renameItems', async (_e, { bookId, renames, removed }) => {
    if (!isValidId(bookId)) return 0;
    const map = new Map(Object.entries(renames || {}));
    const gone = new Set(removed || []);
    let changed = 0;
    for (const note of await listNotes()) {
      const list = note.selected?.[bookId];
      if (!Array.isArray(list) || !list.length) continue;
      const next = [...new Set(list.filter((id) => !gone.has(id)).map((id) => map.get(id) || id))];
      if (next.length === list.length && next.every((v, i) => v === list[i])) continue;
      note.selected[bookId] = next;
      await writeJsonAtomic(noteFile(note.id), note);
      changed++;
    }
    return changed;
  });

  // ---- 오답노트 ----
  ipcMain.handle('notes:list', async () => {
    const list = (await listNotes()).map(summarizeNote);
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
  });

  ipcMain.handle('notes:create', async (_e, { title, student, bookIds } = {}) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const ids = (Array.isArray(bookIds) ? bookIds : []).filter(isValidId);
    const note = {
      id,
      kind: 'note',
      version: 2,
      title: (title || '').trim() || '오답노트',
      student: (student || '').trim(),
      bookIds: ids,
      selected: Object.fromEntries(ids.map((b) => [b, []])),
      exportOptions: null,
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(noteFile(id), note);
    return note;
  });

  ipcMain.handle('notes:get', async (_e, id) => {
    const note = await readJson(noteFile(id), null);
    if (!note) throw new Error('오답노트를 찾을 수 없습니다.');
    return note;
  });

  ipcMain.handle('notes:save', async (_e, note) => {
    if (!note || !isValidId(note.id)) throw new Error('잘못된 오답노트');
    await writeJsonAtomic(noteFile(note.id), note);
    return true;
  });

  ipcMain.on('notes:saveSync', (event, note) => {
    try {
      if (note && isValidId(note.id)) writeJsonAtomicSync(noteFile(note.id), note);
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

    // 이전 파일 삭제
    for (const name of await fsp.readdir(dir)) {
      if (name.startsWith(`${role}-`)) await fsp.rm(path.join(dir, name), { force: true });
    }

    const stamp = Date.now().toString(36);
    const files = [];
    let index = 0;
    for (const p of sorted) {
      const ext = path.extname(p).toLowerCase();
      const stored = `${role}-${stamp}-${String(index).padStart(3, '0')}${ext}`;
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

  // 한글 문서로 내보낼 때 AI 로 옮긴 글자·수식 (책 폴더에 따로 저장해 다시 묻지 않음)
  ipcMain.handle('books:getTranscripts', async (_e, id) => readJson(path.join(bookDir(id), 'transcripts.json'), {}));
  ipcMain.handle('books:saveTranscripts', async (_e, { bookId, data } = {}) => {
    const dir = bookDir(bookId);
    if (!fs.existsSync(dir)) return false; // 그 사이 지워진 책
    await writeJsonAtomic(path.join(dir, 'transcripts.json'), data || {});
    return true;
  });

  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('shell:openDataDir', () => shell.openPath(dataDir()));
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
    const settings = await loadSettings();
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
    ai.listModels({ provider, apiKey, baseUrl, settings: await loadSettings(), fetch: (...a) => net.fetch(...a) }),
  );
  ipcMain.handle('ai:codexStatus', async (_e, { path: exe } = {}) => ai.codexStatus(exe ?? (await loadSettings()).codexPath));

  // ---- 업데이트 ----
  ipcMain.handle('update:check', () => checkForUpdates(true));
  ipcMain.handle('update:install', () => {
    if (!updater) return false;
    setImmediate(() => installUpdateNow());
    return true;
  });
  ipcMain.handle('update:getState', () => updateState);
}

// ---------------------------------------------------------------------------
// 자동 업데이트 (GitHub Releases)
// ---------------------------------------------------------------------------

let updater = null;
let updateState = { status: 'idle', current: app.getVersion() };

// 테스트용: 업데이트 과정을 파일에 남김 (OHDAP_UPDATE_TEST=1)
function testLog(line) {
  if (process.env.OHDAP_UPDATE_TEST !== '1') return;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'update-test.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 무시 */
  }
}

function setUpdateState(state) {
  updateState = { current: app.getVersion(), ...state };
  testLog(`state ${JSON.stringify(updateState)}`);
  send('update:status', updateState);
}

/** 업데이트 오류 → 사용자에게 보여 줄 짧은 문구 (긴 HTTP 응답·스택은 로그에만) */
function friendlyUpdateError(err) {
  const raw = String(err?.message || err || '');
  log.warn('[update] error', raw);
  if (/latest\.yml|404/.test(raw)) return '새 버전 파일을 아직 올리는 중이거나 찾지 못했어요. 잠시 뒤에 다시 확인해 주세요.';
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|net::|network/i.test(raw)) return '인터넷에 연결할 수 없어요. 연결을 확인한 뒤 다시 시도해 주세요.';
  if (/sha512|checksum/i.test(raw)) return '내려받은 파일이 손상됐어요. 다시 확인을 눌러 주세요.';
  return raw.split('\n')[0].slice(0, 160);
}

/** GitHub 릴리스 설명(HTML/마크다운) → 짧은 일반 글 */
function plainNotes(notes) {
  const raw = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes || '');
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 2000);
}

function setupAutoUpdater() {
  testLog(`start ${app.getVersion()} packaged=${app.isPackaged}`);
  if (!app.isPackaged || isSmokeTest) {
    updateState = { status: 'disabled', current: app.getVersion(), message: '개발 모드에서는 자동 업데이트가 꺼져 있습니다.' };
    return;
  }
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (err) {
    log.error('electron-updater 로드 실패', err);
    return;
  }
  updater.logger = log;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  // 테스트용: GitHub 대신 다른 주소에서 업데이트 받기
  if (process.env.OHDAP_UPDATE_URL) updater.setFeedURL({ provider: 'generic', url: process.env.OHDAP_UPDATE_URL });

  let pending = null; // 새 버전 정보
  updater.on('checking-for-update', () => setUpdateState({ status: 'checking' }));
  updater.on('update-available', (info) => {
    pending = { version: info.version, notes: plainNotes(info.releaseNotes), date: info.releaseDate };
    setUpdateState({ status: 'available', ...pending });
  });
  updater.on('update-not-available', () => setUpdateState({ status: 'latest' }));
  updater.on('download-progress', (p) =>
    setUpdateState({
      status: 'downloading',
      ...pending,
      percent: Math.round(p.percent || 0),
      transferred: p.transferred,
      total: p.total,
      speed: p.bytesPerSecond,
    }),
  );
  updater.on('update-downloaded', (info) => {
    setUpdateState({ status: 'downloaded', ...pending, version: info.version });
    if (process.env.OHDAP_UPDATE_TEST === '1') setTimeout(() => installUpdateNow(), 800);
  });
  updater.on('error', (err) => setUpdateState({ status: 'error', ...pending, message: friendlyUpdateError(err) }));

  setTimeout(() => checkForUpdates(false), process.env.OHDAP_UPDATE_TEST === '1' ? 1500 : 4000);
  setInterval(() => checkForUpdates(false), 4 * 60 * 60 * 1000);
}

/** 받아 둔 새 버전 설치 후 다시 실행 */
function installUpdateNow() {
  if (!updater) return false;
  testLog('install');
  // 새로 켜질 앱이 "한 번에 하나만 실행" 잠금에 막히지 않게 먼저 풀어 줌
  try {
    app.releaseSingleInstanceLock();
  } catch {
    /* 무시 */
  }
  updater.quitAndInstall(false, true);
  return true;
}

async function checkForUpdates(manual) {
  if (!updater) return updateState;
  if (['downloading', 'downloaded', 'checking'].includes(updateState.status)) return updateState;
  try {
    await updater.checkForUpdates();
  } catch (err) {
    log.warn('업데이트 확인 실패', err);
    if (manual) setUpdateState({ status: 'error', message: friendlyUpdateError(err) });
  }
  return updateState;
}

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------

if (!isSmokeTest && !app.requestSingleInstanceLock()) {
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
    await migrateProjects().catch((err) => log.error('[migrate]', err));
    registerAppProtocol();
    registerIpc();
    createWindow();
    setupAutoUpdater();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
  app.on('will-quit', () => ai.killAll()); // 돌고 있던 codex 도 같이 끔
}
