'use strict';

// 오답노트 - Electron 메인 프로세스
// - 마고에듀 통합 클라우드에서만 켜짐 (src/main/magoedu-cloud.js). 데이터는 통합 클라우드가 맞춰 주는 폴더에 저장해서
//   같은 아이디의 컴퓨터끼리, 같은 학원 선생님끼리 실시간으로 함께 씀 — 아래 '저장 위치'
// - app:// 프로토콜로 화면(renderer)과 책 파일을 제공
// - 책(문제집/답지 파일 + 분석 결과), 오답노트(학생별 선택), 학생 명단 저장소
// - AI 호출(선택 기능): Gemini(기본) · OpenAI 호환 · Claude · ChatGPT 구독(Codex CLI) — src/main/ai.js
// - 수식 인식(선택 기능, AI 없이 내 컴퓨터에서): Pix2Text MFR — src/main/mathocr.js 를 utilityProcess(mathocr-worker.js)에서
// - 업데이트는 통합 클라우드가 받아 둠 → 종료 코드 75 로 끝내면 새 버전으로 다시 켜짐

const { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu, net, utilityProcess, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { createFileQueue } = require('./file-queue');
const { libraryLocation, assertLibraryWritable, createSummaryCache } = require('./library');
const librarySummaries = createSummaryCache();
const withJsonFile = createFileQueue();
const crypto = require('node:crypto');
const log = require('electron-log/main');
const ai = require('./ai');
const mathocr = require('./mathocr');
const cloud = require('./magoedu-cloud');
const { createUpdateMonitor } = require('./update-restart');
const { createPhotoImports } = require('./photo-import');
const { editorShortcut } = require('./editor-shortcuts');
const datasign = require('./datasign');
const { isObj, line, model, int, url, codexPath, sanitizeData, relativePath, invalidJson, cleanJson: cleanValue } = require('./data-validate');
const { key } = require('./data-validate');
const { sanitizeStudent } = cloud;
const { mergeNote } = require('./notemerge');
const subjects = require('./subjects');
const { sanitizeAnswer, sanitizeAnswers, imageFile, imageBytes, MAX_IMAGE_BYTES } = require('./answers');

log.initialize();
log.transports.file.level = 'info';

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const { parseExamBatch, makeSummary, createExamWriter } = require('./exam-batch');
let batch, batchArgumentError;
try { batch = parseExamBatch(process.argv, app.isPackaged); }
catch (err) { batchArgumentError = err; }
const isBatch = !!batch || !!batchArgumentError;
const isSmokeTest = !isBatch && process.env.OHDAP_E2E === '1';
// 일괄 처리: 창이 없으니 시작 중 오류도 오류 창 대신 종료 코드 2로 끝낸다(오류 창은 화면 없는 서버에서 멈춘 채 남음).
const earlyBatchFatal = (err) => { process.stdout.write(JSON.stringify({ event: 'fatal', error: String(err?.message || err).replace(/[\r\n]+/g, ' ') }) + '\n'); app.exit(2); };
if (isBatch) {
  process.on('uncaughtException', earlyBatchFatal);
  // 낮출 때만 바꾼다. nice 로 이미 더 낮게 띄웠으면 올리는 셈이라 권한이 없어 실패한다.
  const os = require('node:os');
  try { if (os.getPriority(0) < os.constants.priority.PRIORITY_BELOW_NORMAL) os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
}
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
const session = isBatch ? {
  localDir: app.getPath('userData'), dataDir: path.join(app.getPath('userData'), 'data'),
  user: { id: 'local-' + crypto.createHash('sha256').update(require('node:os').userInfo().username).digest('hex').slice(0, 24), name: '' },
} : startCloudSession();
if (session) app.setPath('userData', session.localDir); // 이 컴퓨터에만 두는 것 (모델, 로그, 화면 캐시)
const me = session?.user || {}; // { id: 계정 ID, name, role, academy: 학원 이름 }
// 설정 서명 키 (매니페스트 dataSigning — 예전 통합 클라우드는 주지 않음). 다른 프로그램(Codex 등)에 넘어가지 않게 환경 변수에서 지움
const dataKey = process.env.MAGOEDU_DATA_KEY || '';
delete process.env.MAGOEDU_DATA_KEY;

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
//     students/<학생 id>/notes/<id>.json                                    학생 오답노트 (학원 사람 누구나 고침, 지운 학생은 보기만)
//     members/<계정>/notes/<id>.json                                        학생을 정하지 않은 오답노트 (나와 원장만 봄, 나만 고침)
//     members/<계정>/transcripts/<책 id>.json · profile.json
//     members/<계정>/books/<id>/ (books/<id>/ 와 같은 구조)                   나만 보기 교재 (나와 원장만 봄, 나만 고침)
//   학생 명단·학원 AI 는 통합 클라우드에 있음 (MAGOEDU_ACADEMY_INFO 파일로 받고 고칠 때는 통합 클라우드에 부탁 — 4-2)
//     예전 0.3 의 students/<id>.json · academy.json 은 읽지 않음 (서버가 명단·학원 AI 로 가져감)
//   학원이 없는 계정은 개인 공간의 shared/ 를 같은 구조로 씀 (공유는 안 됨): 오답노트는 모두 members/<나>/notes/,
//     학생 명단은 students/<id>.json
//   개인 공간 (MAGOEDU_DATA_DIR): settings.json — 내 AI 키·화면 설정 (같은 아이디의 컴퓨터끼리)
//   이 컴퓨터만 (MAGOEDU_LOCAL_DIR = userData): 수식 인식 모델, 로그, legacy/ (예전에 따로 깔아 쓰던 데이터 — 처음 켤 때 옮김)
// ---------------------------------------------------------------------------

const academyMode = () => !!session.academyDir; // 학원 선생님끼리 함께 씀
const isManager = () => me.role === 'director' || me.role === 'admin'; // 원장(운영자): 남의 교재도 고치고 오답노트를 모두 봄
const sharedDir = () => session.academyDir || path.join(session.dataDir, 'shared');
const dataDir = sharedDir;
const booksDir = () => path.join(sharedDir(), 'books');
const studentsDir = () => path.join(sharedDir(), 'students');
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
  if (fs.existsSync(path.join(shared, 'book.json'))) return { dir: shared, place: 'shared' };
  const mine = academyMode() ? path.join(myBooksDir(), id) : shared;
  if (fs.existsSync(path.join(mine, 'book.json'))) return { dir: mine, place: 'private' };
  if (academyMode() && isManager()) {
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
  return libraryLocation(session.libraryDir, id) || { dir: shared, place: 'shared' };
}
const bookDir = (id) => locateBook(id).dir;
const bookFile = (id) => path.join(bookDir(id), 'book.json');

/** 통합 클라우드에 받기·지우기를 부탁할 때 쓰는 학원 공간 안의 경로 ('/' 로 구분) */
const cloudRel = (file) => path.relative(sharedDir(), file).split(path.sep).join('/');
const notesDirOf = (uid) => path.join(memberDir(uid), 'notes');
function myTranscriptsFile(bookId) {
  if (!isValidId(bookId)) throw new Error('잘못된 책 ID');
  return path.join(memberDir(me.id), 'transcripts', `${bookId}.json`);
}

function noteFile(id, uid = me.id) {
  if (!isValidId(id)) throw new Error('잘못된 오답노트 ID');
  return path.join(notesDirOf(uid), `${id}.json`);
}

/** 학생 오답노트 폴더 (학원 공간에서만) */
function studentNotesDir(sid) {
  if (!isValidId(sid)) throw new Error('잘못된 학생 ID');
  return path.join(studentsDir(), sid, 'notes');
}

/** 오답노트가 있는 곳 → 파일. loc: { sid } 학생 폴더 | { owner } 선생님 폴더 */
function locFile(loc, id) {
  if (!isValidId(id)) throw new Error('잘못된 오답노트 ID');
  return loc.sid ? path.join(studentNotesDir(loc.sid), `${id}.json`) : noteFile(id, loc.owner);
}

// 학원이 없는 계정의 학생 명단 (개인 공간 students/<id>.json)
function studentFile(id) {
  if (!isValidId(id)) throw new Error('잘못된 학생 ID');
  return path.join(studentsDir(), `${id}.json`);
}

/** base 아래에 있는 경로인지 확인(디렉터리 탈출 방지) */
function safeJoin(base, rel) {
  const relative = relativePath(rel);
  if (!relative) throw new Error('잘못된 경로');
  const resolved = path.resolve(base, relative);
  const baseResolved = path.resolve(base) + path.sep;
  if (!resolved.startsWith(baseResolved)) throw new Error('잘못된 경로');
  return resolved;
}

const inLibrary = (file) => !!session?.libraryDir && !path.relative(path.resolve(session.libraryDir), path.resolve(file)).startsWith('..') && !path.isAbsolute(path.relative(session.libraryDir, file));
const badJson = (file) => { if (!inLibrary(file)) invalidJson(file, log); };
const cleanJson = (value, sanitize, file) => inLibrary(file) ? sanitize(value) : cleanValue(value, sanitize, file, log);

const MAX_DATA_JSON = 256 * 1024 * 1024; // 쪽수가 많은 책도 읽게 넉넉히 (너무 큰 파일만 거름)
async function readJson(file, fallback, sanitize = sanitizeData) {
  return withJsonFile(file, async () => {
  try {
    if ((await fsp.stat(file)).size > MAX_DATA_JSON) {
      badJson(file);
      return fallback;
    }
    const value = JSON.parse(await fsp.readFile(file, 'utf8'));
    const clean = cleanJson(value, sanitize, file);
    return clean == null ? fallback : clean;
  } catch (err) {
    if (err.code !== 'ENOENT') badJson(file);
    return fallback;
  }
  });
}

function readJsonSync(file, fallback = null, sanitize = sanitizeData) {
  try {
    if (fs.statSync(file).size > MAX_DATA_JSON) {
      badJson(file);
      return fallback;
    }
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const clean = cleanJson(value, sanitize, file);
    return clean == null ? fallback : clean;
  } catch (err) {
    if (err.code !== 'ENOENT') badJson(file);
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  return withJsonFile(file, async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(value), 'utf8');
      markOwn(file);
      await fsp.rename(tmp, file);
    } finally { await fsp.unlink(tmp).catch(() => {}); }
  });
}

function writeJsonAtomicSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  markOwn(file);
  fs.renameSync(tmp, file);
}

// 파일의 값은 서명 여부와 별개로, 화면에서 만들 수 있는 모양만 받음.
function sanitizeSettings(v) {
  if (!isObj(v)) return {};
  const out = {};
  if (typeof v.aiEnabled === 'boolean') out.aiEnabled = v.aiEnabled;
  if (['academy', 'personal'].includes(v.aiSource)) out.aiSource = v.aiSource;
  if (['gemini', 'openai', 'anthropic', 'codex'].includes(v.aiProvider)) out.aiProvider = v.aiProvider;
  for (const p of ['geminiApiKey', 'openaiApiKey', 'anthropicApiKey']) if (line(v[p], 4096) !== undefined) out[p] = v[p];
  for (const p of ['geminiModel', 'geminiModel2', 'openaiModel', 'openaiModel2', 'anthropicModel', 'anthropicModel2', 'codexModel']) if (model(v[p]) !== undefined) out[p] = v[p];
  for (const p of ['geminiBaseUrl', 'openaiBaseUrl', 'anthropicBaseUrl']) if (url(v[p]) !== undefined) out[p] = v[p];
  if (codexPath(v.codexPath) !== undefined) out.codexPath = v.codexPath;
  for (const [p, max] of [['geminiRpm', 60], ['openaiRpm', 1000], ['anthropicRpm', 1000], ['aiConcurrency', 8], ['aiBatch', 8]]) if (int(v[p], 1, max) !== undefined) out[p] = v[p];
  if (['kor+eng', 'eng', 'kor'].includes(v.ocrLang)) out.ocrLang = v.ocrLang;
  for (const p of ['academy', 'teacher']) if (line(v[p], 200) !== undefined) out[p] = v[p];
  if (['full', 'reduce'].includes(v.motion)) out.motion = v.motion;
  return out;
}

const DEFAULT_SETTINGS = {
  aiEnabled: true, // false 면 AI 를 전혀 쓰지 않음 (디지털 PDF 는 PDF 글자로, 나머지는 그림으로)
  aiSource: 'academy', // academy: 학원 AI 가 있으면 그것 (원장이 통합 클라우드에서 정함) | personal: 아래 내 AI 설정
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

// 내 설정 파일: 통합 클라우드가 서명 키를 주면 서명해서 쓰고, 앱 밖에서 고친 파일(서명이 없거나 틀림)은 적용하지 않고 되돌림
// (src/main/datasign.js. 마지막으로 확인한 설정은 이 컴퓨터 폴더의 settings.verified.json). 키가 없으면 예전처럼
let settingsRejectedAtStart = false; // 창이 뜨기 전에 그런 일이 있었음 → app:info 로 알림
const settingsStore =
  session &&
  datasign.signedJsonFile({
    file: settingsFile(),
    stateFile: path.join(session.localDir, 'settings.verified.json'),
    key: dataKey,
    markOwn,
    log,
    onRejected: () => {
      if (mainWindow) send('data:changed', { books: [], notes: [], settingsRejected: true });
      else settingsRejectedAtStart = true;
    },
  });

/** 내 설정 (개인 공간). 학원·선생님 이름이 비어 있으면 통합 클라우드 계정에서 */
async function loadSettings() {
  const raw = settingsStore.read();
  const clean = cleanJson(raw, sanitizeSettings, settingsFile());
  const s = { ...DEFAULT_SETTINGS, ...(clean || {}) };
  if (!s.academy) s.academy = me.academy || '';
  if (!s.teacher) s.teacher = me.name || '';
  return s;
}

// ---------------------------------------------------------------------------
// 학원 학생 명단·학원 AI: 통합 클라우드가 academy-info.json 으로 넘겨 줌 (켤 때와 바뀔 때마다 새로 씀)
//   { me, members, students(지운 학생 포함: deletedAt), purged, purgeDays, ai(이 프로그램용 학원 AI 또는 null), updatedAt }
// ---------------------------------------------------------------------------
let academyInfoCache;
/** 학원 명단·AI (학원이 없거나 통합 클라우드가 1.2.0 보다 낮으면 null) */
function academyInfo() {
  if (!academyMode()) return null;
  if (academyInfoCache === undefined) academyInfoCache = cloud.academyInfo(session);
  return academyInfoCache;
}
const reloadAcademyInfo = () => {
  academyInfoCache = undefined;
  return academyInfo();
};

/** 학원이 계약한 과목 (통합 클라우드의 academy.subjects, 없으면 수학만) */
const contractSubjects = () => isBatch ? subjects.SUBJECTS : subjects.contractSubjects(academyInfo()?.academy?.subjects);
/** 이 교재의 과목을 학원이 계약했는지 — 안 했으면 보기만 (고치기·분석·문제은행·내보내기 막음) */
const subjectOpen = (book) => contractSubjects().includes(subjects.bookSubject(book));
const SUBJECT_CLOSED = '학원이 계약하지 않은 과목의 교재라 보기만 할 수 있어요.';

/** 학원 명단의 그 학생 (지운 학생 포함, 없으면 null) */
const rosterStudent = (sid) => (academyInfo()?.students || []).find((s) => s.id === sid) || null;

/** 학생 폴더에 쓸 수 있는지: 지운 학생·완전히 지운 학생은 보기만 (서버도 같은 규칙 — 쓰면 통합 클라우드가 되돌림) */
function studentWritable(sid) {
  const info = academyInfo();
  if (info?.purged?.includes(sid)) return false;
  return !rosterStudent(sid)?.deletedAt;
}

const AI_PROVIDERS = ['gemini', 'openai', 'anthropic'];
/**
 * 이 프로그램이 쓸 학원 AI: 부를 주소와 키 자리 값 (없으면 null). 학원 AI 키는 통합 클라우드 서버에만 있고,
 * 보통은 서버 중계 주소 + 실행 허가증, 학원 안 주소면 그 주소로 바로 (키 없음)
 */
function academyAi() {
  const a = cloud.academyAi(session, academyInfo());
  return a && AI_PROVIDERS.includes(a.provider) ? a : null;
}
/** 화면에 넘기는 학원 AI: 키는 있는지만 (선생님에게 키를 보이지 않음) */
function academyAiView() {
  const a = academyAi();
  return a && { provider: a.provider, model: a.model || '', model2: a.model2 || '', rpm: a.rpm || null, baseUrl: a.baseUrl || '', hasKey: !!a.apiKey };
}

/** AI 를 부를 때 쓰는 설정: 학원 AI 를 고르고(기본) 학원 AI 가 있으면 그 종류·키·모델, 아니면 내 설정 */
async function effectiveSettings() {
  const s = await loadSettings();
  const a = academyAi();
  if (s.aiSource === 'personal' || !a) return s;
  const p = a.provider;
  return {
    ...s,
    aiProvider: p,
    [`${p}ApiKey`]: a.apiKey || '',
    [`${p}Model`]: a.model || DEFAULT_SETTINGS[`${p}Model`],
    [`${p}Model2`]: a.model2 || '',
    [`${p}BaseUrl`]: a.baseUrl || '',
    [`${p}Rpm`]: a.rpm || DEFAULT_SETTINGS[`${p}Rpm`],
  };
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
  ['problem', 'answer'].flatMap((role) => {
    const files = book?.docs?.[role]?.files;
    if (files == null) return [];
    if (!Array.isArray(files)) throw new Error('잘못된 교재 파일 목록');
    return files.map((f) => {
      if (!relativePath(f?.name)) throw new Error('잘못된 교재 파일 경로');
      return f.name;
    });
  });

// 원본 파일(PDF·그림)은 크니까 학원 공간에서 '열 때만 받음' (magoedu-app.json 의 shared.lazy)
const fetching = new Map(); // 학원 공간 경로 → 받는 중 (Promise)

/** 아직 받지 않은 원본을 통합 클라우드에 받아 달라고 하고 기다림 → { ok, missing, error? } */
async function fetchBookFiles(id, names) {
  const { dir, place } = locateBook(id);
  const library = place === 'library';
  const rel = (file) => library ? path.relative(session.libraryDir, file).split(path.sep).join('/') : cloudRel(file);
  const rels = [...new Set(names)].filter((n) => n && !fs.existsSync(safeJoin(dir, n))).map((n) => rel(safeJoin(dir, n)));
  if (!rels.length) return { ok: true, missing: [] };
  const fetchKey = (r) => `${library ? 'library' : 'academy'}:${r}`;
  const fresh = rels.filter((r) => !fetching.has(fetchKey(r)));
  if (fresh.length) {
    send('files:fetching', { bookId: id, count: fresh.length });
    const p = (library ? cloud.requestLibraryFiles(session, fresh) : cloud.requestFiles(session, fresh)).finally(() => {
      for (const r of fresh) fetching.delete(fetchKey(r));
      send('files:fetched', { bookId: id });
    });
    for (const r of fresh) fetching.set(fetchKey(r), p);
  }
  const results = await Promise.all([...new Set(rels.map((r) => fetching.get(fetchKey(r))).filter(Boolean))]);
  const missing = rels.filter((r) => results.some((x) => x.ok !== true || (x.missing != null && !Array.isArray(x.missing)) || x.missing?.includes(r)));
  return { ok: !missing.length, missing, error: results.find((x) => x.error)?.error };
}

/** 이 컴퓨터에 받지 않은 원본은 폴더에서 지울 수 없으니 서버에서 지워 달라고 함 (책을 지우거나 원본을 바꿀 때) */
async function removeRemoteOnly(id, names) {
  const dir = bookDir(id);
  const files = names.map((n) => safeJoin(dir, n));
  const gone = files.filter((file) => !fs.existsSync(file)).map(cloudRel);
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
let editorShortcutScope = '';
ipcMain.handle('editor:shortcut-scope', (event, scope) => {
  if (event.sender !== mainWindow?.webContents || !['', 'answer', 'equation'].includes(scope)) return;
  editorShortcutScope = scope;
  event.sender.setIgnoreMenuShortcuts(false);
});
let photoImports;
const updateMonitor = createUpdateMonitor({
  app, ipcMain, cloud, session, isSmokeTest: isSmokeTest || isBatch,
  isBusy: () => fetching.size > 0 || changedPaths.size > 0 || photoImports?.size > 0,
});

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
      backgroundThrottling: !isBatch,
      additionalArguments: isBatch && batch ? [`--exam-ocr-threads=${batch.threads}`] : [],
      devTools,
    },
  });

  if (!isBatch) mainWindow.once('ready-to-show', () => mainWindow.show());
  updateMonitor.attach(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://bundle/')) event.preventDefault();
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    mainWindow.webContents.setIgnoreMenuShortcuts(editorShortcut(editorShortcutScope, input));
    if (input.isComposing) return;
    if (devTools && input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  const clearEditorShortcuts = () => {
    editorShortcutScope = '';
    if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.setIgnoreMenuShortcuts(false);
  };
  mainWindow.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) clearEditorShortcuts(); });
  mainWindow.webContents.on('render-process-gone', clearEditorShortcuts);

  mainWindow.loadURL(isBatch ? 'app://bundle/exam-batch.html' : 'app://bundle/index.html');
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

function sanitizeBook(v) {
  return sanitizeData(v);
}

function sanitizeNote(v) {
  return sanitizeData(v);
}

const count = (d) => (d && Array.isArray(d.items) ? d.items.length : 0);
const flaggedPages = (d) => Object.values(d?.pageInfo || {}).filter((pi) => pi?.flags?.length).length;
const createdByMe = () => ({ id: me.id, name: me.name || '' });

/** 교재를 고칠 수 있는지: 학원 공간에서는 만든 사람과 원장만. 서버도 같은 규칙이라 다른 사람이 고치면 통합 클라우드가 되돌림 */
function canEdit(obj) {
  return !academyMode() || isManager() || obj?.createdBy?.id === me.id;
}

/** 책을 고칠 수 있는지: 다른 선생님의 나만 보기 책(members/<그 사람>/)은 그 사람만 고침 — 원장도 보기만. 계약에서 빠진 과목은 아무도 */
const canEditBook = (book, place) => canEdit(book) && place !== 'others' && place !== 'library' && subjectOpen(book);

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
    subject: subjects.bookSubject(book),
    exam: book.exam || null,
    subjectOpen: subjectOpen(book), // 학원이 이 과목을 계약했는지 (아니면 보기만)
    canEdit: canEditBook(book, place),
    shared: academyMode() && place === 'shared', // 학원 공유 (끄면 나만 보기 — 원장은 볼 수 있음)
    library: place === 'library',
    mine: place !== 'library' && (!academyMode() || book.createdBy?.id === me.id), // 내 책장 (학원 공간에서)
    problemFile: docs.problem?.originalName || '',
    answerFile: docs.answer?.originalName || '',
    problemCount: count(docs.problem),
    answerCount: count(docs.answer),
    problemAnalyzed: !!docs.problem?.analyzedAt,
    answerAnalyzed: !!docs.answer?.analyzedAt,
    flagged: flaggedPages(docs.problem) + flaggedPages(docs.answer),
  };
}

/** 오답노트를 고칠 수 있는지: 학생 폴더는 학원 사람 누구나 (지운 학생은 보기만), 선생님 폴더는 그 선생님만 */
const canWriteLoc = (loc) => (loc.sid ? studentWritable(loc.sid) : loc.owner === me.id);

/** 학생 폴더에 있으면 그 학생 (서버가 옮긴 0.3 노트는 studentId 가 비어 있을 수 있음) */
const studentIdOf = (note, loc) => loc.sid || (isValidId(note.studentId) ? note.studentId : '');

function summarizeNote(note, loc, ownerName) {
  const selected = note.selected || {};
  const studentId = studentIdOf(note, loc);
  return {
    id: note.id,
    title: note.title,
    student: note.student || '',
    studentId,
    bookIds: note.bookIds || [],
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    updatedBy: note.updatedBy || null,
    selectedCount: Object.values(selected).reduce((s, list) => s + (Array.isArray(list) ? list.length : 0), 0),
    shared: !!loc.sid, // 학생 폴더 (학원 사람 누구나)
    canEdit: canWriteLoc(loc),
    mine: !!loc.sid || loc.owner === me.id, // 원장이 보는 다른 선생님의 (학생을 정하지 않은) 오답노트는 false (보기·내보내기만)
    owner: loc.owner || '',
    ownerName,
  };
}

async function listJson(dir, fileOf, sanitize) {
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
    const value = await readJson(file, null, sanitize);
    if (value) out.push(value);
  }
  return out;
}

const JSON_ID = /^[a-zA-Z0-9-]{8,64}\.json$/;
/** 책장: 학원 공유(books/) + 내 나만 보기(members/<나>/books/, 학원 공간에서만) → [{ book, place }] */
async function listBooks() {
  const inDir = async (dir, place) =>
    (await listJson(dir, (e) => (e.isDirectory() && isValidId(e.name) ? path.join(dir, e.name, 'book.json') : null), sanitizeBook)).map((book) => ({ book, place }));
  const shared = await inDir(booksDir(), 'shared');
  const ids = new Set(shared.map((x) => x.book.id));
  const local = [...shared, ...(academyMode() ? await inDir(myBooksDir(), 'private') : []).filter((x) => !ids.has(x.book.id))];
  const localIds = new Set(local.map((x) => x.book.id));
  const library = await librarySummaries.list(session.libraryDir, async (file) => {
    const book = await readJson(file, null, sanitizeBook);
    return book ? summarizeBook(book, 'library') : null;
  });
  return [...local, ...library.filter((summary) => !localIds.has(summary.id) && subjectOpen(summary)).map((summary) => ({ summary, place: 'library' }))];
}
const listNotesOf = (uid) => listJson(notesDirOf(uid), (e) => (e.isFile() && JSON_ID.test(e.name) ? path.join(notesDirOf(uid), e.name) : null), sanitizeNote);
const listStudents = () => listJson(studentsDir(), (e) => (e.isFile() && JSON_ID.test(e.name) ? path.join(studentsDir(), e.name) : null), sanitizeStudent);

/** 학원 공간 members/ 아래 계정들 (원장만 남의 것을 받음) */
async function memberIds() {
  const out = (await fsp.readdir(membersDir(), { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && /^[A-Za-z0-9-]{1,64}$/.test(e.name))
    .map((e) => e.name);
  return out.includes(me.id) ? out : [...out, me.id];
}

function sanitizeProfile(v) {
  return sanitizeData(v);
}

/** 계정 → 이름 (members/<계정>/profile.json) */
async function memberNames() {
  const names = { [me.id]: me.name || '' };
  for (const uid of await memberIds()) {
    const p = await readJson(path.join(memberDir(uid), 'profile.json'), null, sanitizeProfile);
    if (p?.name && uid !== me.id) names[uid] = String(p.name);
  }
  return names;
}

/** 원장이 오답노트 목록에서 누구 것인지 알 수 있게 내 이름을 남김 */
async function saveProfile() {
  if (!academyMode()) return;
  const file = path.join(memberDir(me.id), 'profile.json');
  const cur = await readJson(file, null, sanitizeProfile);
  if (cur?.name === me.name) return;
  await writeJsonAtomic(file, { ...cur, name: me.name || '', updatedAt: Date.now() });
}

/** 학원 공간 students/ 아래 학생 폴더들 (예전 0.3 의 students/<id>.json 파일은 빼고) */
function studentDirIds() {
  if (!academyMode()) return [];
  try {
    return fs.readdirSync(studentsDir(), { withFileTypes: true }).filter((e) => e.isDirectory() && isValidId(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

const listNotesIn = (dir) => listJson(dir, (e) => (e.isFile() && JSON_ID.test(e.name) ? path.join(dir, e.name) : null), sanitizeNote);

/**
 * 오답노트 목록 → [{ note, loc }]: 내 (학생을 정하지 않은) 오답노트 + 학원의 모든 학생 오답노트,
 * 원장이면 다른 선생님의 학생을 정하지 않은 오답노트도 (보기만)
 */
async function listAllNotes() {
  const uids = academyMode() && isManager() ? await memberIds() : [me.id];
  const out = [];
  for (const uid of uids) for (const note of await listNotesOf(uid)) out.push({ note, loc: { owner: uid } });
  for (const sid of studentDirIds()) for (const note of await listNotesIn(studentNotesDir(sid))) out.push({ note, loc: { sid } });
  return out;
}

/** 오답노트가 있는 곳 → { sid } | { owner } | null: 내 폴더 → 학생 폴더 → 원장이면 다른 선생님 폴더 */
function findNote(id) {
  if (fs.existsSync(noteFile(id))) return { owner: me.id };
  for (const sid of studentDirIds()) if (fs.existsSync(locFile({ sid }, id))) return { sid };
  if (academyMode() && isManager()) {
    let uids = [];
    try {
      uids = fs.readdirSync(membersDir(), { withFileTypes: true }).filter((e) => e.isDirectory() && /^[A-Za-z0-9-]{1,64}$/.test(e.name) && e.name !== me.id).map((e) => e.name);
    } catch {
      /* members/ 없음 */
    }
    for (const uid of uids) if (fs.existsSync(noteFile(id, uid))) return { owner: uid };
  }
  return null;
}

/**
 * 저장할 곳: 학생이 정해져 있으면 그 학생 폴더 (학원 공간에서, 명단에 있고 지우지 않은 학생),
 * 아니면 내 폴더. 지금 학생 폴더에 있고 학생이 그대로면 그대로 (명단을 아직 못 받았어도 옮기지 않게)
 */
function targetLoc(note, cur) {
  const sid = isValidId(note.studentId) ? note.studentId : '';
  if (cur?.sid && cur.sid === sid) return cur;
  const st = sid && academyMode() ? rosterStudent(sid) : null;
  if (st && !st.deletedAt) return { sid };
  return { owner: me.id };
}

const sameLoc = (a, b) => !!a && !!b && (a.sid || '') === (b.sid || '') && (a.owner || '') === (b.owner || '');

// 3-way 병합의 '그사이 바뀌었는지': 오답노트마다 이 창이 마지막으로 읽거나 쓴 내용
const noteSeen = new Map(); // id → JSON
const noteSig = (note) => JSON.stringify(stripMeta(note));

/**
 * 오답노트 저장 (창을 닫을 때도 써서 동기로 — 오답노트 파일은 작음).
 * base: 화면이 열 때(또는 지난번 저장 때) 받은 내용. 그사이 다른 사람이 파일을 고쳤으면 base·내 것·지금 파일을 합쳐서 씀.
 * 학생을 바꿨으면 파일을 그 학생 폴더(또는 내 폴더)로 옮김 → 합쳤으면 { merged: true }, 아니면 true
 */
function saveNoteFile(note, base) {
  const mine = stampRenames(stripMeta(note));
  mine.answersForStudent = mine.answersForStudent === true;
  const cur = findNote(mine.id);
  if (cur && !canWriteLoc(cur)) throw new Error(cur.sid ? '지운 학생의 오답노트는 고칠 수 없어요. 학생을 되살리면 고칠 수 있어요.' : '다른 선생님의 오답노트는 고칠 수 없어요.');
  const onDisk = cur ? readJsonSync(locFile(cur, mine.id), null, sanitizeNote) : null;
  let out = mine;
  let merged = false;
  if (onDisk && base && noteSig(onDisk) !== noteSeen.get(mine.id)) {
    out = mergeNote(stripMeta(base), mine, onDisk);
    merged = noteSig(out) !== noteSig(mine);
  }
  out.updatedBy = createdByMe();
  const to = targetLoc(out, cur);
  if (to.sid) out.studentId = to.sid;
  out.answersForStudent = !!to.sid && out.answersForStudent === true;
  writeJsonAtomicSync(locFile(to, out.id), out);
  if (cur && !sameLoc(cur, to)) {
    markOwn(locFile(cur, out.id));
    fs.rmSync(locFile(cur, out.id), { force: true });
  }
  noteSeen.set(out.id, noteSig(out));
  return merged ? { merged: true } : true;
}

// 문항 ID 는 위치로 정해져서 책 주인이 번호를 고치면 바뀜. 다른 선생님의 오답노트는 내가 고칠 수 없으니
// 책에 바뀐 기록(renames.json { last, log: [{ n, renames, removed }] })을 남기고, 각자 오답노트를 열 때 따라 바꿈
// (오답노트의 renamesSeen[책 id] = 어디까지 따라 바꿨는지)
const RENAME_KEEP = 200;
const renamesFile = (bookId) => path.join(bookDir(bookId), 'renames.json');

function sanitizeRenames(v) {
  return sanitizeData(v);
}

function loadRenames(bookId) {
  return readJsonSync(renamesFile(bookId), { last: 0, log: [] }, sanitizeRenames);
}

/** 오답노트의 선택을 바뀐 ID 대로. 바뀌었으면 true */
function applyRenames(note, bookId, renames, removed) {
  const list = note.selected?.[bookId];
  if (!Array.isArray(list) || !list.length) return false;
  const map = new Map(Object.entries(isObj(renames) ? renames : {}));
  const gone = new Set(Array.isArray(removed) ? removed : []);
  const next = [...new Set(list.filter((id) => !gone.has(id)).map((id) => map.get(id) || id))];
  if (next.length === list.length && next.every((v, i) => v === list[i])) return false;
  note.selected[bookId] = next;
  return true;
}

/** 아직 따라 바꾸지 않은 기록을 적용. 바뀌었으면 true */
function catchUpRenames(note) {
  if (!Array.isArray(note.bookIds) || (note.renamesSeen != null && !isObj(note.renamesSeen))) return false;
  let changed = false;
  note.renamesSeen ||= {};
  for (const bookId of note.bookIds || []) {
    if (!isValidId(bookId)) continue;
    const r = loadRenames(bookId);
    if (!Array.isArray(r.log) || int(r.last, 0, Number.MAX_SAFE_INTEGER) === undefined) continue;
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
  if (!Array.isArray(note.bookIds) || (note.renamesSeen != null && !isObj(note.renamesSeen))) return note;
  note.renamesSeen ||= {};
  for (const bookId of note.bookIds || []) {
    if (isValidId(bookId) && note.renamesSeen[bookId] === undefined) note.renamesSeen[bookId] = int(loadRenames(bookId).last, 0, Number.MAX_SAFE_INTEGER) ?? 0;
  }
  return note;
}

/**
 * 예전에 따로 깔아 쓰던 오답노트 데이터(%APPDATA%\OhdapNote\data)는 통합 클라우드가 처음 켤 때 물어보고 legacy/ 로 복사해 줌
 * (magoedu-app.json 의 legacy). 여기서 새 자리로 옮김: 책 → 학원 공간(만든 사람 = 나), 오답노트 → 내 오답노트,
 * AI 키 같은 설정 → 내 설정의 빈 칸. 더 예전 버전(projects/<id>/project.json: 책 + 선택이 한 파일)은 책 + 오답노트로 나눔.
 * 같은 ID 가 이미 있으면 건너뜀 (다른 컴퓨터에서 먼저 옮김). 다 옮기면 legacy/ 를 지움
 */
function sanitizeLegacyProject(v) {
  return sanitizeData(v);
}

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
    const book = await readJson(path.join(src, 'books', id, 'book.json'), null, sanitizeBook);
    if (!book || fs.existsSync(bookFile(id))) continue;
    await copyBook(path.join(src, 'books', id), id, book).catch((err) => log.error('[legacy] book', id, err));
  }
  for (const name of await dirs('projects')) {
    const from = path.join(src, 'projects', name);
    const project = await readJson(path.join(from, 'project.json'), null, sanitizeLegacyProject);
    const id = project?.id && isValidId(project.id) ? project.id : name;
    if (!project || fs.existsSync(bookFile(id))) continue;
    try {
      const at = { createdAt: project.createdAt || Date.now(), updatedAt: project.updatedAt || Date.now() };
      await copyBook(from, id, { ...project, id, kind: 'book', version: 2, name: project.name || '책', ...at, docs: project.docs || { problem: null, answer: null }, answerOverrides: project.answerOverrides || {} });
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
    const note = await readJson(path.join(src, 'notes', e.name), null, sanitizeNote);
    if (!note || fs.existsSync(noteFile(id))) continue;
    await addNote({ ...note, id }).catch((err) => log.error('[legacy] note', id, err));
  }
  const old = await readJson(path.join(src, 'settings.json'), null, sanitizeSettings);
  if (old && typeof old === 'object') {
    const cur = sanitizeSettings(settingsStore.read());
    const filled = Object.fromEntries(Object.entries(cur).filter(([, v]) => v !== '' && v != null));
    settingsStore.write({ ...old, ...filled });
  }
  await fsp.rm(src, { recursive: true, force: true });
  log.info('[legacy] imported', done);
  return done;
}

function sanitizeTranscripts(v) {
  return require('./transcript-review').sanitizeTranscripts(v);
}

/** 책의 수식 변환 결과 + 내가 따로 만든 것 */
async function mergedTranscripts(id) {
  const shared = await readJson(path.join(bookDir(id), 'transcripts.json'), {}, sanitizeTranscripts);
  const mine = academyMode() && locateBook(id).place !== 'library' ? await readJson(myTranscriptsFile(id), {}, sanitizeTranscripts) : {};
  if (!Object.keys(mine).length) return shared || {};
  return { ...shared, ...mine, items: { ...(shared?.items || {}), ...mine.items } };
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
  // 저장·파일 받기·내보내기·AI 요청이 끝나기 전에는 재시작하지 않는다.
  const handle = (channel, fn) => ipcMain.handle(channel, (...args) => updateMonitor.track(() => fn(...args)));
  handle('app:info', () => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    updateRestartEnabled: updateMonitor.enabled,
    dataDir: dataDir(),
    platform: process.platform,
    developer: '구현민',
    user: { id: me.id || '', name: me.name || '', role: me.role || '', academy: me.academy || '' },
    academy: academyMode(), // 학원 선생님끼리 교재·학생 오답노트를 함께 씀
    manager: isManager(), // 원장: 남의 교재도 고치고, 선생님들의 학생을 정하지 않은 오답노트도 봄 (보기만)
    roster: academyMode() ? (academyInfo() ? 'cloud' : 'missing') : 'local', // 학생 명단: 통합 클라우드 | 통합 클라우드가 낮은 버전 | 이 계정만
    purgeDays: academyInfo()?.purgeDays || 30, // 지운 학생을 되살릴 수 있는 날 수
    subjects: contractSubjects(), // 학원이 계약한 과목 (math · english · korean) — 교재 등록은 이 과목만
    settingsRejected: settingsRejectedAtStart, // 켤 때 앱 밖에서 고친 설정을 적용하지 않았음 (화면에 알림)
  }));

  // academyAi: 이 프로그램이 쓸 학원 AI (키는 있는지만, 없으면 null)
  handle('settings:get', async () => ({ ...(await loadSettings()), academyAi: academyAiView() }));
  handle('settings:set', async (_e, patch) => {
    const next = { ...(await loadSettings()), ...cleanJson(patch, sanitizeSettings, settingsFile()) };
    delete next.academyAi;
    settingsStore.write(next);
    return { ...next, academyAi: academyAiView() };
  });

  // ---- 책 ----
  handle('books:list', async () => {
    const list = (await listBooks()).map(({ book, place, summary }) => summary ? { ...summary, subjectOpen: subjectOpen(summary) } : summarizeBook(book, place));
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
  });

  // 새 책은 학원 공유가 기본 (shared: false 면 나만 보기). 과목은 학원이 계약한 것만
  handle('books:create', async (_e, { name, shared = true, subject = 'math' } = {}) => {
    if (!contractSubjects().includes(subject)) throw new Error('학원이 계약하지 않은 과목이라 교재를 등록할 수 없어요.');
    const id = crypto.randomUUID();
    const now = Date.now();
    const book = {
      id,
      kind: 'book',
      version: 2,
      name: (name || '').trim() || '새 책',
      subject,
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
  handle('books:get', async (_e, id) => {
    const { dir, place } = locateBook(id);
    const book = await readJson(path.join(dir, 'book.json'), null, sanitizeBook);
    if (!book) throw new Error('책을 찾을 수 없습니다.');
    return { ...book, ...(place === 'library' ? { $library: true } : {}), $canEdit: canEditBook(book, place), $shared: academyMode() && place === 'shared', $subjectOpen: subjectOpen(book), $answers: readAnswers(id) };
  });

  /** 지금 저장된 책을 고칠 수 있는지 (만든 사람은 바뀌지 않음) → 저장된 책 */
  function checkBookWrite(id) {
    const { dir, place } = locateBook(id);
    assertLibraryWritable(place);
    const cur = readJsonSync(path.join(dir, 'book.json'), null, sanitizeBook);
    if (cur && !subjectOpen(cur)) throw new Error(SUBJECT_CLOSED);
    if (cur && !canEditBook(cur, place)) throw new Error(place === 'others' ? '나만 보기 책은 만든 선생님만 고칠 수 있어요.' : '만든 사람과 원장만 고칠 수 있어요.');
    return cur;
  }
  const toSave = (book, cur) => ({ ...stripMeta(book), createdBy: cur?.createdBy || book.createdBy || createdByMe() });
  const answersFile = (id) => path.join(bookDir(id), 'answers.json');
  const readAnswers = (id) => readJsonSync(answersFile(id), { version: 1, items: {} }, sanitizeAnswers);
  const saveAnswer = ({ bookId, itemId, data } = {}) => {
    if (!key(itemId, 200)) throw new Error('잘못된 문항 번호예요.');
    const book = checkBookWrite(bookId);
    if (!book?.docs?.problem?.items?.some((item) => item.id === itemId)) throw new Error('문항이 없어졌어요. 책을 다시 열어 주세요.');
    const entry = sanitizeAnswer(data);
    if (!entry) throw new Error('정답·해설의 길이나 그림 경로를 확인해 주세요.');
    const all = readAnswers(bookId);
    all.items[itemId] = { ...entry, updatedAt: Date.now(), by: createdByMe() };
    if (Object.keys(all.items).length > 20000) throw new Error('한 책에는 정답·해설을 2만 문항까지 저장할 수 있어요.');
    if (Buffer.byteLength(JSON.stringify(all)) > 16 * 1024 * 1024) throw new Error('해설 용량이 너무 커요. 그림이나 긴 글을 줄여 주세요.');
    writeJsonAtomicSync(answersFile(bookId), all);
    send('data:changed', { books: [bookId], notes: [], answers: true });
    return all.items[itemId];
  };
  handle('answers:get', (_e, id) => readAnswers(id));
  handle('answers:save', (_e, args) => saveAnswer(args));
  ipcMain.on('answers:saveSync', (event, args) => {
    try { event.returnValue = saveAnswer(args); }
    catch (err) { log.warn('[answers:saveSync]', err.message); event.returnValue = false; }
  });
  const answerImagePath = (id, file) => {
    if (!imageFile(file)) throw new Error('잘못된 그림 경로예요.');
    const dir = path.join(bookDir(id), 'answer-images');
    const dest = path.join(bookDir(id), file);
    for (const p of [dir, dest]) {
      if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('연결된 그림 경로는 사용할 수 없어요.');
    }
    return dest;
  };
  handle('answers:putImage', (_e, { bookId, data } = {}) => {
    if (!checkBookWrite(bookId)) throw new Error('책을 찾을 수 없어요.');
    const bytes = imageBytes(data);
    const img = nativeImage.createFromBuffer(bytes);
    const { width, height } = img.getSize();
    if (img.isEmpty() || width * height > 32000000 || width > 20000 || height > 20000) throw new Error('그림이 손상되었거나 너무 커요.');
    const png = img.toPNG();
    if (png.length > MAX_IMAGE_BYTES) throw new Error('변환된 그림이 8MB를 넘어요. 크기를 줄여 주세요.');
    const file = `answer-images/${crypto.createHash('sha256').update(png).digest('hex').slice(0, 16)}.png`;
    const dest = answerImagePath(bookId, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) { markOwn(dest); fs.writeFileSync(dest, png); }
    return file;
  });
  const getAnswerImage = async ({ bookId, file } = {}) => {
    let dest = answerImagePath(bookId, file);
    if (!fs.existsSync(dest)) await fetchBookFiles(bookId, [file]);
    dest = answerImagePath(bookId, file);
    if (fs.statSync(dest).size > MAX_IMAGE_BYTES) throw new Error('그림이 너무 커요.');
    const bytes = imageBytes(fs.readFileSync(dest));
    return `data:image/png;base64,${bytes.toString('base64')}`;
  };
  handle('answers:getImage', (_e, args) => getAnswerImage(args));
  let answerPrintQueue = Promise.resolve();
  handle('answers:renderPdf', (_e, args = {}) => {
    const run = async () => {
      const { bookId, widthPt } = args;
      const book = readJsonSync(bookFile(bookId), null, sanitizeBook);
      if (!book || !subjectOpen(book)) throw new Error(SUBJECT_CLOSED);
      const data = sanitizeAnswer({ answer: '', blocks: args.blocks });
      if (!data || !Number.isFinite(widthPt) || widthPt < 100 || widthPt > 600) throw new Error('잘못된 해설 인쇄 크기예요.');
      const images = {};
      for (const b of data.blocks) if (b.type === 'figure' && !images[b.file]) images[b.file] = await getAnswerImage({ bookId, file: b.file });
      const win = new BrowserWindow({ show: false, width: Math.ceil(widthPt * 4 / 3), height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      try {
        await win.loadURL('app://bundle/answer-print.html');
        const height = await win.webContents.executeJavaScript(`window.renderAnswer(${JSON.stringify({ ...data, images, widthPt })})`);
        return new Uint8Array(await win.webContents.printToPDF({ printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 }, pageSize: { width: widthPt / 72, height: Math.max(24, Math.min(620, height)) / 72 }, displayHeaderFooter: false, generateTaggedPDF: true }));
      } finally { win.destroy(); }
    };
    const next = answerPrintQueue.then(run, run);
    answerPrintQueue = next.catch(() => {});
    return next;
  });
  photoImports = createPhotoImports({ readBook: checkBookWrite, dirFor: bookDir, markOwn, removeRemoteOnly, log,
    saveBook: (book, cur) => writeJsonAtomicSync(bookFile(book.id), toSave(book, cur)) });

  handle('books:save', async (_e, book) => {
    if (!book || !isValidId(book.id)) throw new Error('잘못된 책');
    const cur = checkBookWrite(book.id);
    if (!subjectOpen(book)) throw new Error('학원이 계약하지 않은 과목으로는 바꿀 수 없어요.');
    writeJsonAtomicSync(bookFile(book.id), toSave(book, cur));
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

  handle('books:delete', async (_e, id) => {
    const book = checkBookWrite(id);
    await removeRemoteOnly(id, sourceFiles(book));
    await fsp.rm(bookDir(id), { recursive: true, force: true });
    // 고칠 수 있는 오답노트(내 것 · 학생 오답노트)에서 빼기 (나머지에는 '볼 수 없는 교재'로 남음)
    // 열어 둔 화면이 저장하면 그 노트의 base 와 견줘 합쳐지므로 noteSeen 은 그대로 둠
    for (const { note, loc } of await listAllNotes()) {
      if (!(note.bookIds || []).includes(id) || !canWriteLoc(loc)) continue;
      note.bookIds = note.bookIds.filter((b) => b !== id);
      if (note.selected) delete note.selected[id];
      if (note.renamesSeen) delete note.renamesSeen[id];
      await writeJsonAtomic(locFile(loc, note.id), note);
    }
    return true;
  });

  /** 남의 책을 내 책으로 복사 (원본 파일을 먼저 받음): 새 ID, 만든 사람 = 나, 이름에 (복사본) */
  handle('books:copy', async (_e, id) => {
    const book = await readJson(bookFile(id), null, sanitizeBook);
    if (!book) throw new Error('책을 찾을 수 없습니다.');
    if (!subjectOpen(book)) throw new Error('학원이 계약하지 않은 과목의 교재는 복사할 수 없어요.');
    const files = sourceFiles(book);
    const got = await fetchBookFiles(id, files);
    if (!got.ok) throw new Error('교재 파일을 받지 못해 복사할 수 없어요. 인터넷 연결을 확인해 주세요.');
    const newId = crypto.randomUUID();
    const now = Date.now();
    const from = bookDir(id);
    const to = newBookDir(newId); // 새 책처럼 학원 공유
    await fsp.mkdir(to, { recursive: true });
    for (const name of files) {
      const target = safeJoin(to, name);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      markOwn(target);
      await fsp.copyFile(safeJoin(from, name), target);
    }
    const tr = await mergedTranscripts(id);
    if (Object.keys(tr.items || {}).length) await writeJsonAtomic(path.join(to, 'transcripts.json'), tr);
    const answers = readAnswers(id);
    if (Object.keys(answers.items || {}).length) await writeJsonAtomic(path.join(to, 'answers.json'), answers);
    const copy = { ...stripMeta(book), id: newId, name: `${book.name || '책'} (복사본)`, createdBy: createdByMe(), createdAt: now, updatedAt: now };
    await writeJsonAtomic(path.join(to, 'book.json'), copy);
    return summarizeBook(copy);
  });

  /**
   * 학원 공유 켜고 끄기 (만든 사람만): 책 폴더를 books/<id> ↔ members/<나>/books/<id> 로 옮김 → 새 요약.
   * 끄면 다른 선생님에게는 지워진 책처럼 보임 (원장은 볼 수 있음)
   */
  handle('books:setShared', async (_e, { id, shared } = {}) => {
    if (!academyMode()) throw new Error('학원 공간에서만 공유를 바꿀 수 있어요.');
    const { dir: from, place } = locateBook(id);
    assertLibraryWritable(place);
    const book = readJsonSync(path.join(from, 'book.json'), null, sanitizeBook);
    if (!book) throw new Error('책을 찾을 수 없습니다.');
    if (place === 'others' || book.createdBy?.id !== me.id) throw new Error('책을 만든 사람만 공유를 바꿀 수 있어요.');
    if (!subjectOpen(book)) throw new Error(SUBJECT_CLOSED);
    const to = newBookDir(id, !!shared);
    if (path.resolve(to) === path.resolve(from)) return summarizeBook(book, place);
    // 받지 않은 원본은 옮길 수 없으니 먼저 모두 받음
    const got = await fetchBookFiles(id, sourceFiles(book));
    if (!got.ok) throw new Error('교재 파일을 다 받지 못해 공유를 바꾸지 못했어요. 인터넷 연결을 확인해 주세요.');
    // 먼저 복사하고(지난번에 옮기다 남은 것은 지움) 다 되면 예전 폴더를 지움 → 중간에 멈춰도 잃는 것이 없음
    await fsp.rm(to, { recursive: true, force: true });
    await copyBookFiles(from, to);
    await fsp.rm(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return summarizeBook(readJsonSync(path.join(to, 'book.json'), null, sanitizeBook) || book, shared ? 'shared' : 'private');
  });

  /** 책을 열 때: 아직 받지 않은 원본 파일을 미리 받음 → { ok, missing, error? } */
  handle('books:ensureFiles', async (_e, id) => {
    const book = await readJson(bookFile(id), null, sanitizeBook);
    return book ? fetchBookFiles(id, sourceFiles(book)) : { ok: false, missing: [] };
  });

  /** 책에서 문항 ID 가 바뀌었을 때(번호 고침 등) 오답노트의 선택도 따라 바꿈 (다른 선생님 것은 각자 열 때) */
  handle('books:renameItems', async (_e, { bookId, renames, removed }) => {
    if (!isValidId(bookId)) return 0;
    const { dir, place } = locateBook(bookId);
    assertLibraryWritable(place);
    const book = readJsonSync(path.join(dir, 'book.json'), null, sanitizeBook);
    if (!book || !canEditBook(book, place)) return 0;
    const r = loadRenames(bookId);
    if (!Array.isArray(r.log) || int(r.last, 0, Number.MAX_SAFE_INTEGER - 1) === undefined) throw new Error('잘못된 문항 변경 기록');
    const n = r.last + 1;
    await writeJsonAtomic(renamesFile(bookId), { ...r, last: n, log: [...r.log, { n, renames: renames || {}, removed: removed || [] }].slice(-RENAME_KEEP) });
    let changed = 0;
    for (const { note, loc } of await listAllNotes()) {
      if (!(note.bookIds || []).includes(bookId) || !canWriteLoc(loc) || !catchUpRenames(note)) continue;
      await writeJsonAtomic(locFile(loc, note.id), note);
      changed++;
    }
    return changed;
  });

  // ---- 오답노트 ----
  handle('notes:list', async () => {
    const names = await memberNames();
    const list = (await listAllNotes()).map(({ note, loc }) => summarizeNote(note, loc, loc.owner ? names[loc.owner] || '' : ''));
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
  });

  // 학생을 고르면 학원 공간의 그 학생 폴더에 (학원 사람 누구나 이어서 고침), 아니면 내 폴더에
  handle('notes:create', async (_e, { title, student, studentId, bookIds } = {}) => {
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
      answersForStudent: false,
      bookIds: ids,
      selected: Object.fromEntries(ids.map((b) => [b, []])),
      exportOptions: null,
      createdBy: createdByMe(),
      createdAt: now,
      updatedAt: now,
    });
    const loc = targetLoc(note);
    if (loc.sid) note.studentId = loc.sid;
    await writeJsonAtomic(locFile(loc, id), note);
    noteSeen.set(id, noteSig(note));
    return note;
  });

  // 보기만 하는 오답노트는 $readonly ($why: deleted 지운 학생 | other 다른 선생님 것을 원장이 봄) — 저장하지 않음
  handle('notes:get', async (_e, id) => {
    const loc = findNote(id);
    const note = loc && (await readJson(locFile(loc, id), null, sanitizeNote));
    if (!note) throw new Error('오답노트를 찾을 수 없습니다.');
    const writable = canWriteLoc(loc);
    if (catchUpRenames(note) && writable) await writeJsonAtomic(locFile(loc, id), note);
    if (loc.sid) note.studentId = loc.sid;
    const st = note.studentId ? rosterStudent(note.studentId) : null;
    note.answersForStudent = !!loc.sid && note.answersForStudent === true;
    const meta = { $shared: !!loc.sid, $studentName: st?.name || '' };
    if (writable) {
      noteSeen.set(id, noteSig(readJsonSync(locFile(loc, id), null, sanitizeNote) || note));
      return { ...note, ...meta };
    }
    return { ...note, ...meta, $readonly: true, $why: loc.sid ? 'deleted' : 'other', $ownerName: loc.owner ? (await memberNames())[loc.owner] || '' : '' };
  });

  // base: 화면이 열 때 받은 내용 (그사이 바뀐 파일과 합칠 때) → true | { merged: true } (합쳤으니 다시 읽어 주세요)
  handle('notes:save', async (_e, note, base) => {
    if (!note || !isValidId(note.id)) throw new Error('잘못된 오답노트');
    if (note.$readonly) return false;
    return saveNoteFile(note, base);
  });

  ipcMain.on('notes:saveSync', (event, note, base) => {
    try {
      if (note && isValidId(note.id) && !note.$readonly) saveNoteFile(note, base);
      event.returnValue = true;
    } catch (err) {
      log.error('[notes:saveSync]', err);
      event.returnValue = false;
    }
  });

  handle('notes:delete', async (_e, id) => {
    const loc = findNote(id);
    if (!loc) return true;
    if (!canWriteLoc(loc)) throw new Error(loc.sid ? '지운 학생의 오답노트는 지울 수 없어요.' : '다른 선생님의 오답노트는 지울 수 없어요.');
    await fsp.rm(locFile(loc, id), { force: true });
    noteSeen.delete(id);
    return true;
  });

  // ---- 학생 명단 ----
  //   학원: 통합 클라우드 명단 (학원 사람 누구나 추가·고치기·지우기·되살리기, 인터넷 필요 — 통합 클라우드에 부탁하면
  //         명단 파일을 새로 써 준 뒤 답함). 지운 학생도 deletedAt 과 함께 (purgeAt 에 완전히 지워짐)
  //   학원이 없는 계정: 개인 공간 students/<id>.json
  handle('students:list', async () => {
    const list = academyMode() ? (academyInfo()?.students || []).map((s) => ({ ...s, canEdit: !s.deletedAt })) : (await listStudents()).map((s) => ({ ...s, canEdit: true }));
    list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko'));
    return list;
  });

  /** 학원 사람 (담당 선생님 고르기) */
  handle('students:members', () => academyInfo()?.members || []);

  const UPDATE_CLOUD = '학생 명단을 바꾸려면 통합 클라우드를 최신 버전으로 업데이트한 뒤 오답노트를 다시 켜 주세요.';
  /** 통합 클라우드에 부탁한 결과 → 학생, 못 했으면 알아듣기 쉬운 말로 던짐 */
  const rosterOp = async (run) => {
    if (!academyInfo()) throw new Error(UPDATE_CLOUD); // 1.2.0 보다 낮은 통합 클라우드는 학생 부탁을 모름
    const r = await run();
    if (r.ok && !r.student) throw new Error(UPDATE_CLOUD);
    if (r.ok) {
      reloadAcademyInfo();
      return { ...r.student, canEdit: !r.student?.deletedAt };
    }
    if (r.errorCode === 'conflict') reloadAcademyInfo();
    const msg = {
      conflict: '그사이 다른 사람이 이 학생을 고쳤어요. 새 내용을 보고 다시 고쳐 주세요.',
      student_deleted: '지운 학생이에요. 되살린 뒤 고쳐 주세요.',
      offline: '인터넷에 연결돼 있어야 학생 명단을 바꿀 수 있어요.',
      timeout: '통합 클라우드가 답하지 않아요. 통합 클라우드가 켜져 있는지 확인해 주세요.',
      no_request_dir: UPDATE_CLOUD,
    }[r.errorCode];
    throw new Error(msg || r.error || '하지 못했어요.');
  };

  handle('students:save', async (_e, s = {}) => {
    if (academyMode()) {
      const text = (v) => String(v || '').trim();
      const student = { name: text(s.name), school: text(s.school), grade: text(s.grade), memo: text(s.memo) };
      if (s.teacherId !== undefined) student.teacherId = s.teacherId || null;
      if (isValidId(s.id) && s.rev) Object.assign(student, { id: s.id, rev: s.rev });
      else student.id = isValidId(s.id) ? s.id : crypto.randomUUID();
      if (!student.name) throw new Error('학생 이름을 적어 주세요.');
      return rosterOp(() => cloud.saveStudent(session, student));
    }
    return saveLocalStudent(s);
  });

  handle('students:delete', async (_e, id) => {
    if (academyMode()) return rosterOp(() => cloud.deleteStudent(session, id));
    await fsp.rm(studentFile(id), { force: true });
    return true;
  });

  handle('students:restore', async (_e, id) => rosterOp(() => cloud.restoreStudent(session, id)));

  /** 학원이 없는 계정의 학생 명단 (예전처럼 개인 공간에) */
  async function saveLocalStudent(s) {
    const id = isValidId(s.id) ? s.id : crypto.randomUUID();
    const cur = readJsonSync(studentFile(id), null, sanitizeStudent);
    const name = String(s.name || '').trim();
    if (!name) throw new Error('학생 이름을 적어 주세요.');
    const now = Date.now();
    const text = (v) => String(v || '').trim().slice(0, 200);
    const student = {
      ...cur,
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
  }

  handle('exams:pick', async (_e, folder) => {
    const r = await dialog.showOpenDialog(mainWindow, { title: '???? ???', properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'], filters: [{ name: '???', extensions: ['pdf', 'zip', 'png', 'jpg', 'jpeg'] }] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('exams:read', (_e, p) => fsp.readFile(p));
  handle('exams:scan', (_e, paths) => require('./mockexam-files').scanExamPaths(paths, path.join(app.getPath('userData'), 'exam-input')));

  handle('files:pick', async (_e, { title } = {}) => {
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

  // 사진은 보정한 쪽까지 저장한 뒤 목록을 한 번에 바꾼다 (begin → photo → commit, 취소는 discard). 예전 파일은 commit 뒤에 정리.
  handle('files:import', async (_e, { bookId, role, paths, add = false }) => {
    return photoImports.begin(bookId, role, paths, add);
  });
  handle('files:photo', (_e, photo) => photoImports.photo(photo));
  handle('files:commit', (_e, { token, book }) => photoImports.commit(token, book));
  handle('files:discard', (_e, token) => photoImports.discard(token));

  handle('files:savePdf', async (_e, { defaultName, data }) => {
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
  handle('files:saveFile', async (_e, { defaultName, data, filters, title } = {}) => {
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
  handle('books:getTranscripts', async (_e, id) => mergedTranscripts(id));
  handle('books:saveTranscripts', async (_e, { bookId, data } = {}) => {
    data = sanitizeTranscripts(data) || {};
    const { dir, place } = locateBook(bookId);
    assertLibraryWritable(place);
    if (!fs.existsSync(dir)) return false; // 그 사이 지워진 책
    const cur = readJsonSync(path.join(dir, 'book.json'), null, sanitizeBook);
    if (!subjectOpen(cur)) return false; // 계약에서 빠진 과목: 보기만
    if (canEditBook(cur, place)) {
      await writeJsonAtomic(path.join(dir, 'transcripts.json'), data || {});
      return true;
    }
    const shared = (await readJson(path.join(dir, 'transcripts.json'), {}, sanitizeTranscripts))?.items || {};
    const items = Object.fromEntries(Object.entries(data?.items || {}).filter(([k, v]) => JSON.stringify(shared[k]) !== JSON.stringify(v)));
    await writeJsonAtomic(myTranscriptsFile(bookId), { ...data, items });
    return true;
  });

  handle('shell:openPath', (_e, p) => shell.openPath(p));
  handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
  handle('cloud:open', () => cloud.openCloud());
  handle('shell:openExternal', (_e, url) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url);
    return false;
  });

  // ---- AI (선택 기능) ----
  handle('ai:abort', (_e, requestId) => {
    const ctrl = aiRequests.get(requestId);
    if (ctrl) ctrl.abort();
    return !!ctrl;
  });
  handle('ai:generate', async (_e, { provider, model, body, requestId } = {}) => {
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
  handle('ai:listModels', async (_e, { provider, apiKey, baseUrl } = {}) =>
    ai.listModels({ provider, apiKey, baseUrl, settings: await effectiveSettings(), fetch: (...a) => net.fetch(...a) }),
  );
  handle('ai:codexStatus', async (_e, { path: exe } = {}) => ai.codexStatus(exe ?? (await effectiveSettings()).codexPath));

  // ---- 수식 인식 (선택 기능, 모델을 한 번 받아 두면 인터넷 없이) ----
  handle('mathocr:status', () => {
    const dir = mathocrDir();
    return { ...mathocr.modelStatus(dir), bundled: dir !== mathocrDownloadDir() };
  });
  handle('mathocr:install', async () => {
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
  handle('mathocr:cancelInstall', () => {
    if (mathocrInstall) mathocrInstall.abort();
    return !!mathocrInstall;
  });
  handle('mathocr:abort', (_e, requestId) => {
    const id = mathocrRequests.get(requestId);
    if (id && mathocrWorker) mathocrWorker.proc.postMessage({ type: 'abort', id });
    return !!id;
  });
  handle('mathocr:recognize', async (_e, { images, requestId, maxTokens } = {}) => {
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

  // 사용 설명서는 통합 클라우드 서버에서 열기 (학원 안의 http 서버도 허용).
  handle('app:openHelp', (_e, section = '') => {
    if (typeof section !== 'string' || /[^a-z0-9-]/.test(section)) return false;
    const checked = url(session?.server);
    const server = checked && /^https?:\/\/[^\\?#]+$/i.test(checked)
      ? checked.replace(/\/+$/, '')
      : 'https://mago.milky.kr';
    return shell.openExternal(`${server}/help/ohdapnote.html${section ? '#' + section : ''}`);
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
  const roots = [...new Set([session.academyDir, session.dataDir, session.libraryDir].filter(Boolean))];
  for (const root of roots) {
    try {
      if (root !== session.libraryDir) fs.mkdirSync(root, { recursive: true });
      const w = fs.watch(root, { recursive: true }, (_type, name) => {
        if (!name) return;
        const abs = path.resolve(root, String(name));
        if (/\.(tmp|magoedu-dl|part)$/i.test(abs)) return;
        if (Date.now() - (ownWrites.get(abs) || 0) < OWN_MS) return;
        try {
          if (fs.statSync(abs).isDirectory() && !inLibrary(abs)) return; // 공용 책 폴더 자체가 들어오거나 옮겨져도 알림
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
  // 학원 명단·학원 AI: 학생이 지워지거나 되살아나면 그 학생 오답노트를 고칠 수 있는지도 바뀜 → 오답노트도 '*'
  // 계약 과목이 바뀌면 교재를 고칠 수 있는지도 바뀜 → 책도 '*'
  const stop = cloud.watchAcademyInfo(session, (info) => {
    const before = contractSubjects().join();
    academyInfoCache = info;
    send('data:changed', { books: contractSubjects().join() === before ? [] : ['*'], notes: ['*'], students: true, settings: true });
  });
  watchers.push({ close: stop });
}

/** 바뀐 파일 → { books: [책 id], notes: [오답노트 id], students, settings } */
function flushChanges() {
  const out = { books: new Set(), notes: new Set(), students: false, settings: false };
  for (const abs of changedPaths) {
    if (abs === path.resolve(settingsFile())) {
      settingsStore.read(); // 앱 밖에서 고친 것이면 여기서 되돌림 (화면에는 settingsRejected 로 알림)
      out.settings = true;
      continue;
    }
    if (inLibrary(abs)) {
      const rel = path.relative(session.libraryDir, abs).split(path.sep);
      if (rel[0] === 'books' && isValidId(rel[1])) out.books.add(rel[1]);
      continue;
    }
    const rel = path.relative(sharedDir(), abs).split(path.sep);
    if (rel[0] === 'books' && isValidId(rel[1])) out.books.add(rel[1]);
    else if (rel[0] === 'members' && rel[2] === 'books' && isValidId(rel[3])) out.books.add(rel[3]); // 나만 보기 교재
    else if (rel[0] === 'members' && rel[2] === 'notes' && JSON_ID.test(rel[3] || '')) out.notes.add(rel[3].slice(0, -5));
    else if (rel[0] === 'members' && rel[2] === 'profile.json') out.notes.add('*');
    else if (rel[0] === 'students' && isValidId(rel[1]) && rel[2] === 'notes' && JSON_ID.test(rel[3] || '')) out.notes.add(rel[3].slice(0, -5)); // 학생 오답노트
    else if (rel[0] === 'students' && rel.length === 2 && !academyMode()) out.students = true; // 학원이 없는 계정의 학생 명단
  }
  changedPaths = new Set();
  send('data:changed', { ...out, books: [...out.books], notes: [...out.notes] });
}

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------

if (isBatch) {
  runExamBatch();
} else if (!session) {
  // 통합 클라우드에서 켜지 않음 → 통합 클라우드가 설치되어 있으면 안내 없이 넘겨서 켜 달라고 함.
  // 없거나 넘기지 못했거나 통합 클라우드가 켰는데 확인이 안 됐으면 안내 (통합 클라우드가 있으면 열어 줌)
  app.whenReady().then(() => {
    const installed = !!app.getApplicationNameForProtocol('magoedu://launch/ohdapnote');
    const handOff = cloud.shouldHandOff({ installed });
    if (handOff && cloud.openCloud('ohdapnote')) return app.exit(0);
    dialog.showMessageBoxSync({ type: 'info', title: '오답노트', message: cloud.reason(), buttons: ['확인'] });
    if (installed && !handOff) cloud.openCloud('ohdapnote');
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
    settingsStore.read(); // 꺼져 있는 동안 앱 밖에서 고친 설정이면 창을 띄우기 전에 되돌림
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

// Batch lifecycle excludes interactive startup.
async function runExamBatch() {
  const startedAt = new Date().toISOString();
  let ended = false;
  const emit = (event, done) => process.stdout.write(JSON.stringify(event) + '\n', done);
  const fatal = (err) => {
    if (ended) return;
    ended = true;
    // 화면 처리 프로세스가 죽은 뒤 app.exit 이 끝나지 않고 남은 적이 있다(Windows). 5초 뒤에는 강제로 끝낸다.
    setTimeout(() => process.exit(2), 5000).unref();
    emit({ event: 'fatal', error: String(err?.message || err).replace(/[\r\n]+/g, ' ') }, () => app.exit(2));
  };
  process.off('uncaughtException', earlyBatchFatal);
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  try {
    if (batchArgumentError) throw batchArgumentError;
    await fsp.mkdir(batch.output, { recursive: true });
    await fsp.access(batch.output, fs.constants.W_OK);
    // git 없이 풀어 놓은 소스(서버 배포본)에서는 OHDAP_COMMIT 으로 받는다.
    let commit = process.env.OHDAP_COMMIT || null;
    if (!commit) try { commit = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(__dirname, '../..'), encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { commit = null; }
    await app.whenReady();
    Menu.setApplicationMenu(null);
    registerAppProtocol();
    registerIpc();
    ipcMain.handle('exam-batch:config', () => ({ input: batch.input }));
    ipcMain.on('exam-batch:event', (_event, data) => {
      if (['exam-start', 'exam-end'].includes(data?.event)) emit(data);
    });
    const writeExam = createExamWriter(batch.output, { startedAt, version: app.getVersion(), commit }, bookDir);
    ipcMain.handle('exam-batch:checkpoint', (_event, queue) => writeExam(queue));
    ipcMain.handle('exam-batch:finish', async (_event, queue) => {
      try {
        const summary = await writeExam(queue, false);
        const code = summary.errors.length ? 1 : 0;
        ended = true;
        emit({ event: 'finished', code, exams: summary.exams.length, errors: summary.errors.length }, () => app.exit(code));
      } catch (err) { fatal(err); }
    });
    ipcMain.on('exam-batch:fatal', (_event, error) => fatal(Error(error)));
    emit({ event: 'started', startedAt, version: app.getVersion(), commit, threads: batch.threads });
    createWindow();
    mainWindow.webContents.on('render-process-gone', (_event, details) => fatal(Error(`renderer: ${details.reason}`)));
    mainWindow.webContents.on('did-fail-load', (_event, code, description) => fatal(Error(`load ${code}: ${description}`)));
    mainWindow.on('closed', () => { if (!ended) fatal(Error('Batch window closed')); });
  } catch (err) { fatal(err); }
}
