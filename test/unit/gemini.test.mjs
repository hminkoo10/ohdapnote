import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiDetect } from '../../src/renderer/js/gemini.js';

const okJson = (list) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(list) }] } }] });
const install = (fn) => {
  const calls = [];
  globalThis.window = {
    ohdap: {
      geminiGenerate: async (args) => {
        calls.push(args);
        return fn(args, calls.length);
      },
      geminiAbort: async (id) => calls.push({ abort: id }),
    },
  };
  return calls;
};

test('gemini: 1순위 하루 한도 초과 → 2순위 모델로', async () => {
  const calls = install(({ model }) =>
    model === 'a-model'
      ? { ok: false, status: 429, error: 'quota', json: { error: { message: 'GenerateRequestsPerDayPerProjectPerModel' } } }
      : { ok: true, status: 200, json: okJson([{ number: '7', box_2d: [100, 100, 300, 500] }]) },
  );
  const r = await geminiDetect('x', { models: ['a-model', 'b-model'], rpm: 6000 });
  assert.equal(r.model, 'b-model');
  assert.equal(r[0].number, '7');
  assert.deepEqual(calls.map((c) => c.model), ['a-model', 'b-model']);
  // 한도가 찬 모델은 다음부터 뒤로 미룸
  const calls2 = install(() => ({ ok: true, status: 200, json: okJson([]) }));
  await geminiDetect('x', { models: ['a-model', 'b-model'], rpm: 6000 });
  assert.equal(calls2[0].model, 'b-model');
});

test('gemini: 생각(thinking) 설정을 모르는 모델이면 빼고 다시', async () => {
  const calls = install(({ body }) =>
    body.generationConfig.thinkingConfig
      ? { ok: false, status: 400, error: 'Unknown name "thinkingLevel": thinking is not supported' }
      : { ok: true, status: 200, json: okJson([]) },
  );
  await geminiDetect('x', { models: ['gemini-9-flash'], rpm: 6000 });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.generationConfig.thinkingConfig);
  assert.equal(calls[1].body.generationConfig.thinkingConfig, undefined);
});

test('gemini: 취소하면 응답을 기다리지 않고 바로 멈춤 + 요청 끊기', async () => {
  const calls = install(() => new Promise((r) => setTimeout(() => r({ ok: true, status: 200, json: okJson([]) }), 5000)));
  const ctrl = new AbortController();
  const t0 = Date.now();
  const p = geminiDetect('x', { models: ['z-model'], rpm: 6000, signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 50);
  await assert.rejects(p, { name: 'AbortError' });
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(calls.some((c) => c.abort));
});
