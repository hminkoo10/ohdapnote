// 메인 프로세스의 AI 요청(src/main/ai.js): 주소·헤더·요청 내용, Claude SDK, Codex CLI 실행
// 실제 AI 는 부르지 않고 내 컴퓨터의 가짜 서버와 가짜 codex 로 확인합니다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ai = require('../../src/main/ai.js');

// ---- 가짜 HTTP 서버: 받은 요청을 적어 두고 정해 둔 답을 돌려줌 ----
const seen = [];
let reply = () => ({ status: 200, body: {} });
const server = createServer((req, res) => {
  let data = '';
  req.on('data', (d) => (data += d));
  req.on('end', () => {
    const entry = { method: req.method, url: req.url, headers: req.headers, body: data ? JSON.parse(data) : null };
    seen.push(entry);
    const r = reply(entry);
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
    res.end(JSON.stringify(r.body));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test('baseUrl: 기본 주소, 끝의 / 와 /v1beta·/v1 정리, http(s) 만', () => {
  assert.equal(ai.baseUrl('gemini', ''), 'https://generativelanguage.googleapis.com');
  assert.equal(ai.baseUrl('gemini', 'https://gateway.ai.cloudflare.com/v1/acc/gw/google-ai-studio/v1beta/'), 'https://gateway.ai.cloudflare.com/v1/acc/gw/google-ai-studio');
  assert.equal(ai.baseUrl('openai', ''), 'https://api.openai.com/v1');
  assert.equal(ai.baseUrl('openai', 'http://localhost:11434'), 'http://localhost:11434/v1');
  assert.equal(ai.baseUrl('openai', 'http://localhost:1234/v1/'), 'http://localhost:1234/v1');
  assert.equal(ai.baseUrl('anthropic', 'https://api.anthropic.com/v1'), 'https://api.anthropic.com');
  assert.equal(ai.baseUrl('openai', 'file:///etc/passwd'), null);
  assert.equal(ai.baseUrl('openai', 'not a url'), null);
});

test('Gemini: 게이트웨이 주소 + x-goog-api-key, 요청 내용 그대로', async () => {
  seen.length = 0;
  reply = () => ({ status: 200, body: { candidates: [] } });
  const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
  const r = await ai.generate({ provider: 'gemini', model: 'gemini-flash-latest', body, settings: { geminiApiKey: 'g-key', geminiBaseUrl: `${base}/gw/v1beta` }, fetch });
  assert.equal(r.ok, true);
  assert.equal(seen[0].url, '/gw/v1beta/models/gemini-flash-latest:generateContent');
  assert.equal(seen[0].headers['x-goog-api-key'], 'g-key');
  assert.deepEqual(seen[0].body, body);
  const bad = await ai.generate({ provider: 'gemini', model: '../x', body, settings: { geminiApiKey: 'k' }, fetch });
  assert.equal(bad.ok, false);
});

test('OpenAI 호환: /chat/completions, 키가 있을 때만 Bearer, 429 의 retry-after', async () => {
  seen.length = 0;
  reply = () => ({ status: 200, body: { choices: [{ message: { content: '{}' } }] } });
  const body = { model: 'x', messages: [] };
  let r = await ai.generate({ provider: 'openai', model: 'qwen2.5vl:7b', body, settings: { openaiBaseUrl: base }, fetch });
  assert.equal(r.ok, true);
  assert.equal(seen[0].url, '/v1/chat/completions');
  assert.equal(seen[0].headers.authorization, undefined); // 로컬 서버: 키 없음
  assert.equal(seen[0].body.model, 'qwen2.5vl:7b');
  reply = () => ({ status: 429, headers: { 'retry-after': '7' }, body: { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } } });
  r = await ai.generate({ provider: 'openai', model: 'gpt-x', body, settings: { openaiBaseUrl: `${base}/v1`, openaiApiKey: 'sk-test' }, fetch });
  assert.equal(seen[1].headers.authorization, 'Bearer sk-test');
  assert.deepEqual([r.ok, r.status, r.error, r.reason, r.retryAfter], [false, 429, 'Rate limit reached', 'rate_limit_exceeded', 7]);
  r = await ai.generate({ provider: 'openai', model: '', body, settings: {}, fetch });
  assert.match(r.error, /모델/);
});

test('Claude: 공식 SDK 로 /v1/messages — API 키, anthropic-version, betas 는 anthropic-beta 헤더로', async () => {
  seen.length = 0;
  const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '{"items":[]}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  reply = () => ({ status: 200, body: message });
  const body = {
    max_tokens: 16000,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  const settings = { anthropicApiKey: 'sk-ant-test', anthropicBaseUrl: base };
  let r = await ai.generate({ provider: 'anthropic', model: 'claude-opus-5-5', body, settings, fetch });
  assert.equal(r.ok, true);
  assert.equal(r.json.content[0].text, '{"items":[]}');
  const req = seen[0];
  assert.match(req.url, /^\/v1\/messages/);
  // 키는 SDK 가 붙임 (1.x 는 Authorization: Bearer)
  assert.ok(req.headers['x-api-key'] === 'sk-ant-test' || req.headers.authorization === 'Bearer sk-ant-test', JSON.stringify(req.headers));
  assert.ok(req.headers['anthropic-version']);
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.fallbacks, 'default');
  assert.equal(req.body.betas, undefined);
  assert.equal(seen.length, 1); // SDK 재시도는 끔
  // betas 가 없으면 일반 경로, 오류는 상태 번호 + 메시지로
  reply = () => ({ status: 429, headers: { 'retry-after': '3' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } } });
  r = await ai.generate({ provider: 'anthropic', model: 'claude-haiku-5-5', body: { max_tokens: 10, messages: [] }, settings, fetch });
  assert.equal(seen[1].headers['anthropic-beta'], undefined);
  assert.deepEqual([r.ok, r.status, r.reason, r.retryAfter], [false, 429, 'rate_limit_error', 3]);
  assert.match(r.error, /rate limit/);
  assert.equal(seen.length, 2);
  // 키가 없으면 보내지 않음
  r = await ai.generate({ provider: 'anthropic', model: 'x', body: {}, settings: {}, fetch });
  assert.match(r.error, /키/);
  assert.equal(seen.length, 2);
});

test('Claude: 취소하면 요청을 끊고 aborted', async () => {
  reply = () => ({ status: 200, body: {} });
  const slow = createServer(() => {}); // 답하지 않는 서버
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 100);
  const t0 = Date.now();
  const r = await ai.generate({ provider: 'anthropic', model: 'm', body: { max_tokens: 1, messages: [] }, settings: { anthropicApiKey: 'k', anthropicBaseUrl: `http://127.0.0.1:${slow.address().port}` }, fetch, signal: ctrl.signal });
  assert.equal(r.aborted, true);
  assert.ok(Date.now() - t0 < 3000);
  slow.closeAllConnections();
  slow.close();
});

test('모델 목록: OpenAI 호환 /models, Claude models.list', async () => {
  seen.length = 0;
  reply = (req) =>
    req.url.startsWith('/v1/models') && /sk-ant-test/.test(req.headers['x-api-key'] || req.headers.authorization || '')
      ? { status: 200, body: { data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' } }
      : { status: 200, body: { object: 'list', data: [{ id: 'qwen2.5vl:7b', object: 'model' }] } };
  let r = await ai.listModels({ provider: 'openai', baseUrl: base, settings: {}, fetch });
  assert.deepEqual(r, { ok: true, models: [{ name: 'qwen2.5vl:7b', displayName: 'qwen2.5vl:7b' }] });
  r = await ai.listModels({ provider: 'anthropic', apiKey: 'sk-ant-test', baseUrl: base, settings: {}, fetch });
  assert.deepEqual(r, { ok: true, models: [{ name: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' }] });
  r = await ai.listModels({ provider: 'codex', settings: {}, fetch });
  assert.equal(r.ok, false);
});

test('codexEvents: 마지막 답 · 실패 메시지', () => {
  const out = [
    '{"type":"thread.started","thread_id":"t"}',
    'not json',
    '{"type":"item.completed","item":{"id":"1","type":"reasoning","text":"생각"}}',
    '{"type":"item.completed","item":{"id":"2","type":"agent_message","text":"{\\"blocks\\":[]}"}}',
    '{"type":"turn.completed","usage":{}}',
  ].join('\n');
  assert.deepEqual(ai.codexEvents(out), { text: '{"blocks":[]}', error: null });
  assert.deepEqual(ai.codexEvents('{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}'), { text: null, error: "You've hit your usage limit." });
});

// ---- 가짜 codex: 받은 인자·표준 입력·환경을 적어 두고 --json 이벤트를 출력 ----
const fakeDir = mkdtempSync(join(tmpdir(), 'ohdap-fake-codex-'));
after(() => rmSync(fakeDir, { recursive: true, force: true }));
const record = join(fakeDir, 'record.json');
writeFileSync(
  join(fakeDir, 'fake-codex.js'),
  `const fs = require('fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const images = [];
  args.forEach((a, i) => { if (a === '-i') images.push({ file: args[i + 1], bytes: fs.readFileSync(args[i + 1]).length }); });
  const schemaFile = args[args.indexOf('--output-schema') + 1];
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, input, cwd: process.cwd(), images, schema: JSON.parse(fs.readFileSync(schemaFile, 'utf8')), openaiKey: process.env.OPENAI_API_KEY || null }));
  if (input.includes('SLOW')) return setTimeout(() => {}, 60000);
  if (input.includes('LIMIT')) { console.log(JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } })); process.exit(1); }
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 't' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: '{"blocks":[]}' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
});
`,
);
const fakeCodex = process.platform === 'win32' ? join(fakeDir, 'codex.cmd') : join(fakeDir, 'codex');
writeFileSync(fakeCodex, process.platform === 'win32' ? `@node "%~dp0fake-codex.js" %*\r\n` : `#!/bin/sh\nexec node "$(dirname "$0")/fake-codex.js" "$@"\n`, { mode: 0o755 });

test('Codex: 임시 폴더에서 읽기 전용으로 실행, 그림은 파일로, 지시문은 표준 입력, API 키는 넘기지 않음', async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-should-not-pass';
  try {
    const body = { images: [Buffer.from('jpeg-1').toString('base64'), Buffer.from('jpeg-22').toString('base64')], prompt: '두 그림을 "옮겨" 주세요\n둘째 줄', schema: { type: 'object', properties: {}, required: [], additionalProperties: false } };
    const r = await ai.generate({ provider: 'codex', model: 'gpt-5.5-codex', body, settings: { codexPath: fakeCodex } });
    assert.deepEqual(r, { ok: true, status: 200, json: { text: '{"blocks":[]}' } });
    const rec = JSON.parse(readFileSync(record, 'utf8'));
    assert.equal(rec.openaiKey, null);
    assert.equal(rec.input, body.prompt);
    assert.deepEqual(rec.images.map((i) => i.bytes), [6, 7]);
    assert.deepEqual(rec.schema, body.schema);
    for (const flag of ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config']) assert.ok(rec.args.includes(flag), flag);
    assert.equal(rec.args[rec.args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(rec.args[rec.args.indexOf('-m') + 1], 'gpt-5.5-codex');
    assert.equal(rec.args[rec.args.indexOf('-C') + 1].toLowerCase(), rec.cwd.replace(/[\\/]$/, '').toLowerCase());
    assert.ok(rec.cwd.includes('ohdap-codex-'));
    assert.equal(existsSync(rec.cwd), false); // 끝나면 임시 폴더를 지움
    // 모델을 비우면 -m 없이 (CLI 기본 모델)
    await ai.generate({ provider: 'codex', model: '', body, settings: { codexPath: fakeCodex } });
    assert.equal(JSON.parse(readFileSync(record, 'utf8')).args.includes('-m'), false);
  } finally {
    if (saved == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test('Codex: 사용 한도 → 429, 취소하면 프로세스를 끄고 aborted, 없는 경로는 오류', async () => {
  const body = (prompt) => ({ images: [], prompt, schema: {} });
  let r = await ai.generate({ provider: 'codex', model: '', body: body('LIMIT'), settings: { codexPath: fakeCodex } });
  assert.equal(r.status, 429);
  assert.match(r.error, /usage limit/);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 1500);
  const t0 = Date.now();
  r = await ai.generate({ provider: 'codex', model: '', body: body('SLOW'), settings: { codexPath: fakeCodex }, signal: ctrl.signal });
  assert.equal(r.aborted, true);
  assert.ok(Date.now() - t0 < 10000);
  assert.equal(readdirSync(tmpdir()).some((d) => d === JSON.parse(readFileSync(record, 'utf8')).cwd.split(/[\\/]/).pop()), false);
  r = await ai.generate({ provider: 'codex', model: '', body: body('x'), settings: { codexPath: join(fakeDir, 'nope.exe') } });
  assert.match(r.error, /찾지 못했습니다/);
});
