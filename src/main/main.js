'use strict';

// 오답노트 - Electron 메인 프로세스
// - app:// 프로토콜로 화면(renderer)과 프로젝트 파일을 제공
// - 프로젝트(문제집/답지 파일 + 분석 결과) 저장소
// - Gemini API 호출(선택 기능)
// - GitHub Releases 기반 자동 업데이트

const { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const log = require('electron-log/main');

log.initialize();
log.transports.file.level = 'info';

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const isSmokeTest = process.env.OHDAP_E2E === '1';

if (process.env.OHDAP_USER_DATA) {
  app.setPath('userData', process.env.OHDAP_USER_DATA);
}

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
const projectsDir = () => path.join(dataDir(), 'projects');
const settingsFile = () => path.join(dataDir(), 'settings.json');

function isValidId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id);
}

function projectDir(id) {
  if (!isValidId(id)) throw new Error('잘못된 프로젝트 ID');
  return path.join(projectsDir(), id);
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
  geminiApiKey: '',
  geminiModel: 'gemini-flash-latest',
  geminiRpm: 8,
  geminiMode: 'auto',
  ocrLang: 'kor+eng',
};

async function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(await readJson(settingsFile(), {})) };
}

// ---------------------------------------------------------------------------
// app:// 프로토콜
//   app://bundle/<path>            → src/renderer/<path>
//   app://project/<id>/<file>      → <userData>/data/projects/<id>/<file>
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
      if (url.host === 'project') {
        const [id, ...rest] = rel.split('/');
        return await serveFile(safeJoin(projectDir(id), rest.join('/')));
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
// 프로젝트 저장소 IPC
// ---------------------------------------------------------------------------

function summarize(project) {
  const docs = project.docs || {};
  const count = (d) => (d && Array.isArray(d.items) ? d.items.length : 0);
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    problemFile: docs.problem?.originalName || '',
    answerFile: docs.answer?.originalName || '',
    problemCount: count(docs.problem),
    answerCount: count(docs.answer),
    selectedCount: Array.isArray(project.selected) ? project.selected.length : 0,
  };
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    dataDir: dataDir(),
    platform: process.platform,
  }));

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', async (_e, patch) => {
    const next = { ...(await loadSettings()), ...(patch || {}) };
    await writeJsonAtomic(settingsFile(), next);
    return next;
  });

  ipcMain.handle('projects:list', async () => {
    await fsp.mkdir(projectsDir(), { recursive: true });
    const entries = await fsp.readdir(projectsDir(), { withFileTypes: true });
    const list = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidId(entry.name)) continue;
      const project = await readJson(path.join(projectsDir(), entry.name, 'project.json'), null);
      if (project) list.push(summarize(project));
    }
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
  });

  ipcMain.handle('projects:create', async (_e, { name } = {}) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const project = {
      id,
      version: 1,
      name: (name || '').trim() || '새 오답노트',
      createdAt: now,
      updatedAt: now,
      docs: { problem: null, answer: null },
      selected: [],
      answerOverrides: {},
      exportOptions: null,
    };
    await writeJsonAtomic(path.join(projectDir(id), 'project.json'), project);
    return project;
  });

  ipcMain.handle('projects:get', async (_e, id) => {
    const project = await readJson(path.join(projectDir(id), 'project.json'), null);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
    return project;
  });

  ipcMain.handle('projects:save', async (_e, project) => {
    if (!project || !isValidId(project.id)) throw new Error('잘못된 프로젝트');
    await writeJsonAtomic(path.join(projectDir(project.id), 'project.json'), project);
    return true;
  });

  // 창을 닫을 때 마지막 변경 사항을 동기적으로 저장
  ipcMain.on('projects:saveSync', (event, project) => {
    try {
      if (project && isValidId(project.id)) {
        writeJsonAtomicSync(path.join(projectDir(project.id), 'project.json'), project);
      }
      event.returnValue = true;
    } catch (err) {
      log.error('[saveSync]', err);
      event.returnValue = false;
    }
  });

  ipcMain.handle('projects:delete', async (_e, id) => {
    await fsp.rm(projectDir(id), { recursive: true, force: true });
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

  // 선택한 파일(들)을 프로젝트 폴더로 복사
  ipcMain.handle('files:import', async (_e, { projectId, role, paths }) => {
    if (!['problem', 'answer'].includes(role)) throw new Error('잘못된 문서 종류');
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('파일이 없습니다.');
    const dir = projectDir(projectId);
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

  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('shell:openDataDir', () => shell.openPath(dataDir()));
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url);
    return false;
  });

  // ---- Gemini (선택 기능) ----
  ipcMain.handle('gemini:generate', async (_e, { model, body, apiKey }) => {
    const settings = await loadSettings();
    const key = apiKey || settings.geminiApiKey;
    if (!key) return { ok: false, status: 0, error: 'Gemini API 키가 설정되지 않았습니다.' };
    const modelName = String(model || settings.geminiModel || DEFAULT_SETTINGS.geminiModel).replace(/^models\//, '');
    if (!/^[\w.-]+$/.test(modelName)) return { ok: false, status: 0, error: '모델 이름이 올바르지 않습니다.' };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
    try {
      const res = await net.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 무시 */
      }
      return { ok: res.ok, status: res.status, json, error: res.ok ? null : json?.error?.message || text.slice(0, 500) };
    } catch (err) {
      return { ok: false, status: 0, error: `네트워크 오류: ${err.message}` };
    }
  });

  ipcMain.handle('gemini:listModels', async (_e, { apiKey } = {}) => {
    const settings = await loadSettings();
    const key = apiKey || settings.geminiApiKey;
    if (!key) return { ok: false, error: 'Gemini API 키를 먼저 입력하세요.' };
    try {
      const res = await net.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
        headers: { 'x-goog-api-key': key },
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, error: json?.error?.message || `HTTP ${res.status}` };
      const models = (json?.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => ({ name: m.name.replace(/^models\//, ''), displayName: m.displayName || m.name }));
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: `네트워크 오류: ${err.message}` };
    }
  });

  // ---- 업데이트 ----
  ipcMain.handle('update:check', () => checkForUpdates(true));
  ipcMain.handle('update:install', () => {
    if (!updater) return false;
    setImmediate(() => updater.quitAndInstall(false, true));
    return true;
  });
  ipcMain.handle('update:getState', () => updateState);
}

// ---------------------------------------------------------------------------
// 자동 업데이트 (GitHub Releases)
// ---------------------------------------------------------------------------

let updater = null;
let updateState = { status: 'idle' };

function setUpdateState(state) {
  updateState = state;
  send('update:status', state);
}

function setupAutoUpdater() {
  if (!app.isPackaged || isSmokeTest) {
    updateState = { status: 'disabled', message: '개발 모드에서는 자동 업데이트가 꺼져 있습니다.' };
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

  updater.on('checking-for-update', () => setUpdateState({ status: 'checking' }));
  updater.on('update-available', (info) => setUpdateState({ status: 'available', version: info.version }));
  updater.on('update-not-available', () => setUpdateState({ status: 'latest', version: app.getVersion() }));
  updater.on('download-progress', (p) =>
    setUpdateState({ status: 'downloading', percent: Math.round(p.percent || 0), version: updateState.version }),
  );
  updater.on('update-downloaded', (info) => setUpdateState({ status: 'downloaded', version: info.version }));
  updater.on('error', (err) => setUpdateState({ status: 'error', message: String(err?.message || err) }));

  setTimeout(() => checkForUpdates(false), 4000);
  setInterval(() => checkForUpdates(false), 4 * 60 * 60 * 1000);
}

async function checkForUpdates(manual) {
  if (!updater) return updateState;
  if (['downloading', 'downloaded', 'checking'].includes(updateState.status)) return updateState;
  try {
    await updater.checkForUpdates();
  } catch (err) {
    log.warn('업데이트 확인 실패', err);
    if (manual) setUpdateState({ status: 'error', message: String(err?.message || err) });
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

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerAppProtocol();
    registerIpc();
    createWindow();
    setupAutoUpdater();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
