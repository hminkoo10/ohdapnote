'use strict';

// AI 요청 (메인 프로세스) — 화면에서 만든 요청 내용(body)에 저장된 키·주소를 붙여 보냅니다.
// - gemini:    Google Gemini generateContent (주소를 바꾸면 게이트웨이를 거쳐서)
// - openai:    OpenAI 호환 Chat Completions (OpenAI, OpenRouter, LiteLLM, Cloudflare AI Gateway,
//              내 컴퓨터의 Ollama · LM Studio · llama.cpp 서버 — 로컬이면 인터넷 없이)
// - anthropic: Claude Messages API (공식 SDK)
// - codex:     ChatGPT Plus/Pro 구독 — 사용자가 설치하고 `codex login` 해 둔 공식 Codex CLI 를
//              임시 폴더에서 읽기 전용으로 실행합니다. 로그인 정보(~/.codex)는 읽지 않고 API 키도 넘기지 않습니다.
// 돌려주는 값: {ok, status, json, error, reason, retryAfter(초), aborted}

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_BASE = {
  gemini: 'https://generativelanguage.googleapis.com',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};
// 응답을 기다리는 최대 시간 (로컬 서버·Codex 는 여러 장을 한 번에 보내면 오래 걸림)
const TIMEOUT_MS = { gemini: 120e3, openai: 300e3, anthropic: 300e3, codex: 300e3 };

const fail = (error, status = 0) => ({ ok: false, status, error });

/** 사용자가 적은 주소 → 끝의 / 를 뗀 기본 주소. 틀리면 null */
function baseUrl(provider, value) {
  let u;
  try {
    u = new URL(String(value || '').trim() || DEFAULT_BASE[provider]);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (provider === 'openai' && u.pathname === '/') u.pathname = '/v1'; // http://localhost:11434 → …/v1
  let s = u.toString().replace(/\/+$/, '');
  if (provider === 'gemini') s = s.replace(/\/v1(beta)?$/, ''); // …/v1beta/models/… 는 여기서 붙임
  if (provider === 'anthropic') s = s.replace(/\/v1$/, ''); // SDK 가 /v1/messages 를 붙임
  return s;
}

const errorText = (json, text) => json?.error?.message || (typeof json?.error === 'string' ? json.error : '') || json?.message || String(text || '').slice(0, 500);

async function fetchJson(fetch, url, { method = 'POST', headers = {}, body, signal }) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 무시 */
  }
  return {
    ok: res.ok,
    status: res.status,
    json,
    error: res.ok ? null : errorText(json, text),
    reason: res.ok ? '' : String(json?.error?.status || json?.error?.type || json?.error?.code || ''),
    retryAfter: Number(res.headers.get('retry-after')) || 0,
  };
}

/** 취소(signal) + 시간 초과를 함께 걸어 HTTP 요청 */
async function withTimeout(provider, signal, fn) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS[provider]);
  try {
    return await fn(signal ? AbortSignal.any([signal, timeout]) : timeout);
  } catch (err) {
    if (signal?.aborted) return { ok: false, status: 0, aborted: true, error: '취소됨' };
    if (timeout.aborted) return fail(`응답이 ${TIMEOUT_MS[provider] / 1000}초 안에 오지 않았습니다.`);
    return fail(`네트워크 오류: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Gemini · OpenAI 호환
// ---------------------------------------------------------------------------
function geminiGenerate({ model, body, settings, fetch, signal }) {
  const key = settings.geminiApiKey;
  if (!key) return fail('Gemini API 키가 설정되지 않았습니다.');
  const name = String(model || '').replace(/^models\//, '');
  if (!/^[\w.-]+$/.test(name)) return fail('모델 이름이 올바르지 않습니다.');
  const base = baseUrl('gemini', settings.geminiBaseUrl);
  if (!base) return fail('Gemini 주소(게이트웨이)가 올바르지 않습니다.');
  return withTimeout('gemini', signal, (s) =>
    fetchJson(fetch, `${base}/v1beta/models/${name}:generateContent`, { headers: { 'x-goog-api-key': key }, body, signal: s }),
  );
}

function openaiGenerate({ model, body, settings, fetch, signal }) {
  const name = String(model || '').trim();
  if (!name || name.length > 200) return fail('모델 이름을 설정에서 먼저 정해 주세요.');
  const base = baseUrl('openai', settings.openaiBaseUrl);
  if (!base) return fail('OpenAI 호환 주소가 올바르지 않습니다.');
  const key = settings.openaiApiKey; // 로컬 서버면 없어도 됨
  return withTimeout('openai', signal, (s) =>
    fetchJson(fetch, `${base}/chat/completions`, { headers: key ? { authorization: `Bearer ${key}` } : {}, body: { ...body, model: name }, signal: s }),
  );
}

// ---------------------------------------------------------------------------
// Anthropic Claude (공식 SDK — 재시도는 화면 쪽에서 1·2순위 모델과 함께 하므로 끔)
// ---------------------------------------------------------------------------
function claudeClient(settings, fetch, apiKey = settings.anthropicApiKey, base = settings.anthropicBaseUrl) {
  const baseURL = baseUrl('anthropic', base);
  if (!baseURL) return null;
  return new Anthropic({ apiKey, baseURL, maxRetries: 0, timeout: TIMEOUT_MS.anthropic, fetch });
}

function claudeError(err) {
  if (err instanceof Anthropic.APIUserAbortError) return { ok: false, status: 0, aborted: true, error: '취소됨' };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return fail(`응답이 ${TIMEOUT_MS.anthropic / 1000}초 안에 오지 않았습니다.`);
  if (err instanceof Anthropic.APIConnectionError) return fail(`네트워크 오류: ${err.message}`);
  if (err instanceof Anthropic.APIError) {
    return {
      ok: false,
      status: err.status || 0,
      json: err.error || null,
      error: err.error?.error?.message || err.message,
      reason: err.error?.error?.type || '',
      retryAfter: Number(err.headers?.get?.('retry-after')) || 0,
    };
  }
  return fail(err?.message || String(err));
}

async function anthropicGenerate({ model, body, settings, fetch, signal }) {
  if (!settings.anthropicApiKey) return fail('Claude API 키가 설정되지 않았습니다.');
  const client = claudeClient(settings, fetch);
  if (!client) return fail('Claude 주소(게이트웨이)가 올바르지 않습니다.');
  const params = { ...body, model: String(model || '').trim() };
  try {
    // betas(서버 쪽 대체 모델 등)가 있으면 beta 경로로
    const message = params.betas ? await client.beta.messages.create(params, { signal }) : await client.messages.create(params, { signal });
    return { ok: true, status: 200, json: message };
  } catch (err) {
    return claudeError(err);
  }
}

// ---------------------------------------------------------------------------
// ChatGPT 구독 (Codex CLI)
// ---------------------------------------------------------------------------
const running = new Set(); // 돌고 있는 codex 프로세스 (프로그램을 끌 때 같이 끔)

const isFile = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

/** codex 실행 파일 찾기: 설정에 적은 경로 → PATH 의 codex.exe → Codex 설치 폴더 → npm 전역 설치 등의 codex.cmd */
function findCodex(custom) {
  if (custom) return isFile(custom) ? custom : null;
  const win = process.platform === 'win32';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (!win) return dirs.map((d) => path.join(d, 'codex')).find(isFile) || null;
  const exe = dirs.map((d) => path.join(d, 'codex.exe')).find(isFile);
  if (exe) return exe;
  const root = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  try {
    const newest = fs
      .readdirSync(root)
      .map((d) => path.join(root, d, 'codex.exe'))
      .filter(isFile)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (newest) return newest;
  } catch {
    /* 없음 */
  }
  const shims = [...dirs, path.join(process.env.APPDATA || '', 'npm'), path.join(os.homedir(), '.local', 'bin')].map((d) => path.join(d, 'codex.cmd'));
  return shims.find(isFile) || null;
}

/** codex 에 넘기는 환경 변수: API 키는 빼서 반드시 로그인한 ChatGPT 계정으로만 */
function codexEnv() {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

function killTree(child) {
  if (child.exitCode != null || child.killed) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
  else child.kill('SIGKILL');
}

/** codex 실행 → {code, out, err, killed: null|'abort'|'timeout'} */
function runCodex(exe, args, { input = '', cwd, signal, timeout }) {
  return new Promise((resolve) => {
    // codex.cmd 같은 배치 파일은 cmd.exe 로만 실행됨 (인자는 우리가 만든 것뿐이고 따옴표로 감쌈 — 따옴표·% 가 들어간 경로는 거절)
    const shell = /\.(cmd|bat)$/i.test(exe);
    if (shell && [exe, ...args].some((a) => /["%\r\n]/.test(a))) return resolve({ code: -1, out: '', err: 'codex 경로에 쓸 수 없는 글자(" 또는 %)가 있습니다.', killed: null });
    const child = shell
      ? spawn([exe, ...args].map((a) => `"${a}"`).join(' '), { cwd, env: codexEnv(), shell: true, windowsHide: true })
      : spawn(exe, args, { cwd, env: codexEnv(), windowsHide: true });
    running.add(child);
    let out = '';
    let err = '';
    let killed = null;
    let done = false;
    const finish = (code, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      running.delete(child);
      resolve({ code, out, err: err + extra, killed });
    };
    const kill = (why) => {
      killed = why;
      killTree(child);
    };
    const onAbort = () => kill('abort');
    const timer = setTimeout(() => kill('timeout'), timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      if (err.length < 20000) err += d;
    });
    child.on('error', (e) => finish(-1, e.message));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** codex exec --json 의 줄마다 나오는 이벤트에서 마지막 답과 오류 꺼내기 */
function codexEvents(out) {
  let text = null;
  let error = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') text = ev.item.text;
    else if (ev.type === 'turn.failed') error = ev.error?.message || error;
    else if (ev.type === 'error') error = ev.message || error;
  }
  return { text, error };
}

/** codex 오류 글 → 상태 번호 (화면 쪽의 한도 초과·모델 바꾸기·다시 시도 처리에 맞춤) */
function codexStatusCode(msg) {
  if (/usage limit|rate limit|too many requests|429|quota/i.test(msg)) return 429;
  if (/not logged in|log ?in|unauthori[sz]ed|401|auth/i.test(msg)) return 401;
  if (/model/i.test(msg) && /not (found|supported|exist)|unsupported|does not exist|invalid/i.test(msg)) return 404;
  return 500;
}

async function codexGenerate({ model, body, settings, signal }) {
  const exe = findCodex(settings.codexPath);
  if (!exe) return fail('Codex CLI 를 찾지 못했습니다. 설치한 뒤 명령 프롬프트에서 codex login 으로 ChatGPT 계정에 로그인해 주세요.');
  const name = String(model || '').trim();
  if (name && !/^[\w.:-]+$/.test(name)) return fail('모델 이름이 올바르지 않습니다.');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ohdap-codex-'));
  try {
    const images = Array.isArray(body?.images) ? body.images : [];
    const files = [];
    for (const [i, data] of images.entries()) {
      const f = path.join(dir, `image-${i + 1}.jpg`);
      await fsp.writeFile(f, Buffer.from(String(data), 'base64'));
      files.push(f);
    }
    const schemaFile = path.join(dir, 'schema.json');
    await fsp.writeFile(schemaFile, JSON.stringify(body?.schema || {}));
    const args = [
      'exec',
      '--json',
      '--color', 'never',
      '--ephemeral', // 세션 기록을 남기지 않음
      '--skip-git-repo-check',
      '--ignore-user-config', // 사용자 config.toml(다른 공급자·MCP 등)을 읽지 않음 — 로그인만 씀
      '--sandbox', 'read-only',
      '-C', dir,
      '--output-schema', schemaFile,
      '-c', 'model_reasoning_effort=low',
    ];
    if (name) args.push('-m', name);
    for (const f of files) args.push('-i', f);
    // 지시문은 표준 입력으로 (따옴표·줄바꿈이 인자에서 깨지지 않게)
    const r = await runCodex(exe, args, { input: String(body?.prompt || ''), cwd: dir, signal, timeout: TIMEOUT_MS.codex });
    if (r.killed === 'abort' || signal?.aborted) return { ok: false, status: 0, aborted: true, error: '취소됨' };
    if (r.killed === 'timeout') return fail(`Codex 가 ${TIMEOUT_MS.codex / 1000}초 안에 답하지 않았습니다.`);
    const ev = codexEvents(r.out);
    if (r.code === 0 && ev.text != null) return { ok: true, status: 200, json: { text: ev.text } };
    const msg = ev.error || r.err.trim().split(/\r?\n/).slice(-3).join(' ') || `codex 종료 코드 ${r.code}`;
    const status = codexStatusCode(msg);
    return fail(status === 401 ? `Codex 에 로그인되어 있지 않습니다. 명령 프롬프트에서 codex login 을 실행해 주세요. (${msg})` : `Codex: ${msg}`, status);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 설정 화면용: codex 를 찾았는지, 버전, 어떤 방식으로 로그인했는지 (로그인 정보 자체는 보지 않음) */
async function codexStatus(custom) {
  const exe = findCodex(custom);
  if (!exe) return { found: false };
  const opts = { cwd: os.tmpdir(), timeout: 20000 };
  const [ver, login] = [await runCodex(exe, ['--version'], opts), await runCodex(exe, ['login', 'status'], opts)];
  const text = `${login.out}\n${login.err}`;
  const method = login.code !== 0 ? null : /chatgpt/i.test(text) ? 'chatgpt' : /api key/i.test(text) ? 'apikey' : null;
  return { found: true, path: exe, version: ver.code === 0 ? ver.out.trim().split(/\r?\n/)[0] : '', loggedIn: !!method, method };
}

function killAll() {
  for (const child of running) killTree(child);
}

// ---------------------------------------------------------------------------
const GENERATE = { gemini: geminiGenerate, openai: openaiGenerate, anthropic: anthropicGenerate, codex: codexGenerate };

/** @param {{provider, model, body, settings, fetch, signal}} args */
async function generate(args) {
  const fn = GENERATE[args.provider || 'gemini'];
  if (!fn) return fail('알 수 없는 AI 종류입니다.');
  return fn(args);
}

/** 설정 화면의 "모델 목록" (저장 전에 입력한 키·주소로) → {ok, models:[{name, displayName}]} | {ok:false, error} */
async function listModels({ provider = 'gemini', settings, apiKey, baseUrl: base, fetch }) {
  try {
    if (provider === 'gemini') {
      const key = apiKey || settings.geminiApiKey;
      if (!key) return { ok: false, error: 'Gemini API 키를 먼저 입력하세요.' };
      const url = baseUrl('gemini', base ?? settings.geminiBaseUrl);
      if (!url) return { ok: false, error: '주소가 올바르지 않습니다.' };
      const r = await withTimeout('gemini', null, (s) => fetchJson(fetch, `${url}/v1beta/models?pageSize=200`, { method: 'GET', headers: { 'x-goog-api-key': key }, signal: s }));
      if (!r.ok) return { ok: false, error: r.error || `HTTP ${r.status}` };
      const models = (r.json?.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .filter((m) => /gemini|gemma/i.test(m.name) && !/embedding|tts|image-generation|live|audio/i.test(m.name))
        .map((m) => ({ name: m.name.replace(/^models\//, ''), displayName: m.displayName || m.name, description: m.description || '' }));
      return { ok: true, models };
    }
    if (provider === 'openai') {
      const key = apiKey ?? settings.openaiApiKey;
      const url = baseUrl('openai', base ?? settings.openaiBaseUrl);
      if (!url) return { ok: false, error: '주소가 올바르지 않습니다.' };
      const r = await withTimeout('openai', null, (s) => fetchJson(fetch, `${url}/models`, { method: 'GET', headers: key ? { authorization: `Bearer ${key}` } : {}, signal: s }));
      if (!r.ok) return { ok: false, error: r.error || `HTTP ${r.status}` };
      const list = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json?.models) ? r.json.models : [];
      return { ok: true, models: list.map((m) => ({ name: String(m.id || m.name || ''), displayName: String(m.name || m.id || '') })).filter((m) => m.name) };
    }
    if (provider === 'anthropic') {
      const key = apiKey || settings.anthropicApiKey;
      if (!key) return { ok: false, error: 'Claude API 키를 먼저 입력하세요.' };
      const client = claudeClient(settings, fetch, key, base ?? settings.anthropicBaseUrl);
      if (!client) return { ok: false, error: '주소가 올바르지 않습니다.' };
      const models = [];
      for await (const m of client.models.list({ limit: 100 })) {
        models.push({ name: m.id, displayName: m.display_name || m.id });
        if (models.length >= 200) break;
      }
      return { ok: true, models };
    }
    return { ok: false, error: '이 AI 는 모델 목록을 따로 주지 않아요. 비워 두면 기본 모델을 씁니다.' };
  } catch (err) {
    const e = claudeError(err);
    return { ok: false, error: e.error };
  }
}

module.exports = { generate, listModels, codexStatus, killAll, baseUrl, codexEvents, findCodex };
