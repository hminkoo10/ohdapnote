import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiDetect, geminiTranscribe, geminiTranscribeBatch, createLimiter, parseTranscriptionBatch } from '../../src/renderer/js/gemini.js';
import { jsonSchema } from '../../src/renderer/js/aiproviders.js';

const okJson = (list) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(list) }] } }] });
const install = (fn) => {
  const calls = [];
  globalThis.window = {
    ohdap: {
      aiGenerate: async (args) => {
        calls.push(args);
        return fn(args, calls.length);
      },
      aiAbort: async (id) => calls.push({ abort: id }),
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
  assert.equal(calls[0].provider, 'gemini'); // 기본은 Gemini
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

test('gemini: 문항 글자로 옮기기 — JSON 블록 다듬기 + 2순위 모델', async () => {
  const reply = {
    blocks: [
      { type: 'para', text: ' 함수 $f(x)=x^{2}$ 의 값은? ' },
      { type: 'math', latex: '$a_{n}=2n$' },
      { type: 'choices', items: ['$1$', '', '$2$'] },
      { type: 'figure', box_2d: [100, 500, 600, 900] },
      { type: 'figure', box_2d: [1, 2] },
      { type: 'para', text: '' },
      { type: 'unknown', text: 'x' },
    ],
  };
  const calls = install(({ model }) =>
    model === 'q-model' ? { ok: false, status: 429, error: 'quota', json: { error: { message: 'PerDay' } } } : { ok: true, status: 200, json: okJson(reply) },
  );
  const out = await geminiTranscribe('x', { role: 'answer', models: ['q-model', 'r-model'], rpm: 6000 });
  assert.equal(out.model, 'r-model');
  assert.deepEqual([...out], [
    { type: 'para', text: '함수 $f(x)=x^{2}$ 의 값은?' },
    { type: 'math', latex: 'a_{n}=2n' },
    { type: 'choices', items: ['$1$', '$2$'] },
    { type: 'figure', box: { x: 0.5, y: 0.1, w: 0.4, h: 0.5 } },
  ]);
  const body = calls[0].body;
  assert.equal(body.generationConfig.responseSchema.properties.blocks.type, 'ARRAY');
  assert.match(body.contents[0].parts[1].text, /solution entry/);
});

// ---------------------------------------------------------------------------
// AI 종류마다 요청·응답 모양
// ---------------------------------------------------------------------------
const box7 = [{ number: '7', box_2d: [100, 100, 300, 500] }];

test('OpenAI 호환: 그림은 data URL, 답 모양은 json_schema(바깥은 객체), 답은 choices[0].message.content', async () => {
  const calls = install(() => ({ ok: true, status: 200, json: { choices: [{ message: { content: '```json\n{"items":[{"number":"7","box_2d":[100,100,300,500]}]}\n```' } }] } }));
  const r = await geminiDetect('QUJD', { provider: 'openai', models: ['qwen2.5vl:7b'], rpm: 6000 });
  assert.equal(r.model, 'qwen2.5vl:7b');
  assert.equal(r[0].number, '7');
  const { provider, model, body } = calls[0];
  assert.equal(provider, 'openai');
  assert.equal(model, 'qwen2.5vl:7b');
  assert.equal(body.model, 'qwen2.5vl:7b');
  const [img, txt] = body.messages[0].content;
  assert.deepEqual(img, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } });
  assert.match(txt.text, /numbered problem/);
  assert.match(txt.text, /JSON Schema/); // 모양 지정을 모르는 서버를 위해 지시문에도
  assert.equal(body.temperature, 0);
  const schema = body.response_format.json_schema.schema;
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.items.type, 'array');
  assert.equal(schema.properties.items.items.properties.box_2d.items.type, 'integer');
  assert.equal(schema.properties.items.items.additionalProperties, false);
});

test('OpenAI 호환: 서버가 모르는 설정은 하나씩 빼고 다시 (온도 → json_schema → json_object)', async () => {
  const calls = install(({ body }) => {
    if ('temperature' in body) return { ok: false, status: 400, error: "Unsupported value: 'temperature' does not support 0" };
    if (body.response_format) return { ok: false, status: 400, error: `'response_format.type' : value is not one of the allowed values (${body.response_format.type})` };
    return { ok: true, status: 200, json: { choices: [{ message: { content: 'Here you go: [{"number":"7","box_2d":[100,100,300,500]}] thanks' } }] } };
  });
  const r = await geminiDetect('x', { provider: 'openai', models: ['gpt-x'], rpm: 6000 });
  assert.equal(r[0].number, '7'); // 앞뒤 설명이 붙은 답에서도 JSON 꺼냄
  assert.deepEqual(
    calls.map((c) => [('temperature' in c.body), c.body.response_format?.type || null]),
    [[true, 'json_schema'], [false, 'json_schema'], [false, 'json_object'], [false, null]],
  );
});

test('Claude: base64 이미지 블록 + output_config(형식·effort) + 서버 쪽 대체 모델, 답은 content 의 text', async () => {
  const calls = install(() => ({ ok: true, status: 200, json: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"items":[{"number":"7","box_2d":[100,100,300,500]}]}' }] } }));
  const r = await geminiDetect('QUJD', { provider: 'anthropic', models: ['claude-opus-5-5'], rpm: 6000 });
  assert.equal(r[0].number, '7');
  const { body } = calls[0];
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.max_tokens, 16000);
  assert.deepEqual(body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
  assert.equal(body.messages[0].content[1].type, 'text');
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.output_config.format.schema.type, 'object');
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.betas, ['server-side-fallback-2026-07-01']);
  assert.equal('temperature' in body, false);
  // 대체 모델을 지원하지 않는 모델에는 넣지 않음
  const calls2 = install(() => ({ ok: true, status: 200, json: { content: [{ type: 'text', text: '{"items":[]}' }] } }));
  await geminiDetect('x', { provider: 'anthropic', models: ['claude-haiku-5-5'], rpm: 6000 });
  assert.equal(calls2[0].body.fallbacks, undefined);
  assert.equal(calls2[0].body.betas, undefined);
});

test('Claude: effort 를 모르는 모델이면 빼고 다시, 거절(refusal)은 오류', async () => {
  const calls = install(({ body }) =>
    body.output_config?.effort
      ? { ok: false, status: 400, error: 'output_config.effort: This model does not support the effort parameter.' }
      : { ok: true, status: 200, json: { stop_reason: 'refusal', content: [] } },
  );
  await assert.rejects(geminiTranscribe('x', { provider: 'anthropic', models: ['claude-old'], rpm: 6000 }), /답하지 않았습니다/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.output_config.effort, undefined);
  assert.equal(calls[1].body.output_config.format.type, 'json_schema');
});

test('ChatGPT 구독(Codex): 그림·지시문·엄격한 스키마를 넘기고 답은 text, 모델을 비우면 CLI 기본', async () => {
  const calls = install(() => ({ ok: true, status: 200, json: { text: '{"blocks":[{"type":"para","text":"$x$ 의 값","latex":null,"items":null,"box_2d":null}]}' } }));
  const out = await geminiTranscribe('QUJD', { provider: 'codex', models: [''], rpm: 6000 });
  assert.deepEqual([...out], [{ type: 'para', text: '$x$ 의 값' }]);
  assert.equal(out.model, '');
  const { provider, model, body } = calls[0];
  assert.equal(provider, 'codex');
  assert.equal(model, '');
  assert.deepEqual(body.images, ['QUJD']);
  assert.match(body.prompt, /ONE problem/);
  // --output-schema 는 엄격 모드: 모든 칸 required, 없어도 되던 칸은 null 허용
  const item = body.schema.properties.blocks.items;
  assert.deepEqual(item.required, ['type', 'text', 'latex', 'items', 'box_2d']);
  assert.deepEqual(item.properties.text.type, ['string', 'null']);
  assert.equal(item.properties.type.type, 'string');
  assert.equal(item.additionalProperties, false);
  assert.equal(body.schema.additionalProperties, false);
});

test('jsonSchema: 바깥 배열·enum·엄격 모드 변환', () => {
  const s = { type: 'OBJECT', properties: { kind: { type: 'STRING', enum: ['a', 'b'] }, n: { type: 'INTEGER' } }, required: ['kind'] };
  assert.deepEqual(jsonSchema(s), { type: 'object', properties: { kind: { type: 'string', enum: ['a', 'b'] }, n: { type: 'integer' } }, required: ['kind'], additionalProperties: false });
  assert.deepEqual(jsonSchema(s, { strict: true }).properties.n, { type: ['integer', 'null'] });
  assert.deepEqual(jsonSchema(s, { strict: true }).required, ['kind', 'n']);
});

// ---------------------------------------------------------------------------
// 한 요청에 여러 문항
// ---------------------------------------------------------------------------
const para = (t) => ({ type: 'para', text: t });

test('여러 문항 한 번에: 그림마다 번호표를 붙여 한 요청, 답은 그림 순서대로', async () => {
  const calls = install(() => ({ ok: true, status: 200, json: okJson({ items: [{ index: 2, blocks: [para('둘')] }, { index: 1, blocks: [para('하나')] }, { index: 3, blocks: [para('셋')] }] }) }));
  const out = await geminiTranscribeBatch(['A', 'B', 'C'], { models: ['m'], rpm: 6000 });
  assert.equal(calls.length, 1);
  assert.deepEqual(out.map((r) => r[0].text), ['하나', '둘', '셋']);
  assert.equal(out[0].model, 'm');
  const parts = calls[0].body.contents[0].parts;
  assert.deepEqual(parts.slice(0, 6).map((p) => p.text || p.inlineData.data), ['Image 1:', 'A', 'Image 2:', 'B', 'Image 3:', 'C']);
  assert.match(parts[6].text, /3 DIFFERENT problems/);
  assert.equal(calls[0].body.generationConfig.responseSchema.properties.items.items.properties.blocks.type, 'ARRAY');
});

test('여러 문항 한 번에: 답을 해석하지 못하면 한 장씩, 빠진 그림만 다시', async () => {
  // 1) 묶음 답이 엉망 → 그림마다 다시
  let calls = install(({ body }) => {
    const n = body.contents[0].parts.filter((p) => p.inlineData).length;
    if (n > 1) return { ok: true, status: 200, json: okJson('not json at all') };
    return { ok: true, status: 200, json: okJson({ blocks: [para(`한 장 ${body.contents[0].parts[0].inlineData.data}`)] }) };
  });
  let out = await geminiTranscribeBatch(['A', 'B'], { models: ['m'], rpm: 6000 });
  assert.equal(calls.length, 3);
  assert.deepEqual(out.map((r) => r[0].text), ['한 장 A', '한 장 B']);
  // 2) 하나만 빠짐 → 그것만 다시
  calls = install(({ body }) => {
    const n = body.contents[0].parts.filter((p) => p.inlineData).length;
    if (n > 1) return { ok: true, status: 200, json: okJson({ items: [{ index: 1, blocks: [para('하나')] }, { index: 3, blocks: [] }] }) };
    const data = body.contents[0].parts[0].inlineData.data;
    if (data === 'C') return { ok: false, status: 400, error: 'bad image' };
    return { ok: true, status: 200, json: okJson({ blocks: [para(`다시 ${data}`)] }) };
  });
  out = await geminiTranscribeBatch(['A', 'B', 'C'], { models: ['m'], rpm: 6000 });
  assert.equal(calls.length, 3); // 묶음 1 + B·C 하나씩
  assert.equal(out[0][0].text, '하나');
  assert.equal(out[1][0].text, '다시 B');
  assert.ok(out[2] instanceof Error); // 그 그림만 실패 → 그림으로
  // 3) 묶음 요청이 한도 초과 → 던짐 (하나씩 보내지 않음)
  calls = install(() => ({ ok: false, status: 429, error: 'quota', json: { error: { message: 'PerDay' } } }));
  await assert.rejects(geminiTranscribeBatch(['A', 'B'], { models: ['quota-model'], rpm: 6000 }), /한도/);
  assert.equal(calls.length, 1);
});

test('parseTranscriptionBatch: 0부터 센 번호, 배열의 배열, 묶음 모양이 아니면 null', () => {
  assert.deepEqual(parseTranscriptionBatch(okJson({ items: [{ index: 0, blocks: [para('a')] }, { index: 1, blocks: [para('b')] }] }), 2).map((b) => b[0].text), ['a', 'b']);
  assert.deepEqual(parseTranscriptionBatch(okJson([[para('a')], [para('b')]]), 2).map((b) => b[0].text), ['a', 'b']);
  assert.equal(parseTranscriptionBatch(okJson({ blocks: [para('a')] }), 2), null);
  assert.deepEqual(parseTranscriptionBatch(okJson({ items: [{ index: 9, blocks: [para('a')] }] }), 2), [null, null]);
});

// ---------------------------------------------------------------------------
// 동시 요청 수 · 분당 요청 수 (가짜 시계)
// ---------------------------------------------------------------------------
function fakeClock() {
  let t = 0;
  const timers = [];
  const wait = (ms) => new Promise((resolve) => timers.push({ at: t + ms, resolve }));
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    now: () => t,
    wait,
    /** 모든 타이머가 끝날 때까지 시간을 앞으로 */
    async run() {
      for (;;) {
        await flush();
        await flush();
        if (!timers.length) return;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        t = Math.max(t, next.at);
        next.resolve();
      }
    },
  };
}

async function startTimes({ concurrency, rpm, jobs, duration }) {
  const clock = fakeClock();
  const run = createLimiter({ now: clock.now, wait: clock.wait });
  const starts = [];
  const all = Promise.all(
    Array.from({ length: jobs }, (_, i) =>
      run(
        async () => {
          starts[i] = clock.now();
          await clock.wait(duration);
          return i;
        },
        { concurrency, rpm },
      ),
    ),
  );
  await clock.run();
  assert.deepEqual(await all, Array.from({ length: jobs }, (_, i) => i));
  return starts;
}

test('줄 세우기: 분당 요청 수는 "시작" 간격 — 앞 요청이 끝나기를 기다리지 않음', async () => {
  // 분당 60개 = 1초 간격, 요청 하나에 5초, 동시에 4개까지
  assert.deepEqual(await startTimes({ concurrency: 4, rpm: 60, jobs: 4, duration: 5000 }), [0, 1000, 2000, 3000]);
  // 동시에 2개까지면 앞 요청이 끝나야 다음 것이 시작
  assert.deepEqual(await startTimes({ concurrency: 2, rpm: 60, jobs: 4, duration: 5000 }), [0, 1000, 5000, 6000]);
  // 예전처럼 하나씩 (끝난 뒤 다음)
  assert.deepEqual(await startTimes({ concurrency: 1, rpm: 60, jobs: 3, duration: 5000 }), [0, 5000, 10000]);
  // 분당 요청 수가 더 촘촘하면 간격이 지켜짐
  assert.deepEqual(await startTimes({ concurrency: 8, rpm: 6, jobs: 3, duration: 100 }), [0, 10000, 20000]);
});

test('줄 세우기: 기다리던 요청을 취소하면 바로 AbortError, 자리는 다음 요청에', async () => {
  const clock = fakeClock();
  const run = createLimiter({ now: clock.now, wait: clock.wait });
  const ctrl = new AbortController();
  const order = [];
  const job = (name) => async () => {
    order.push(name);
    await clock.wait(1000);
  };
  const a = run(job('a'), { concurrency: 1, rpm: 6000 });
  const b = run(job('b'), { concurrency: 1, rpm: 6000, signal: ctrl.signal });
  const c = run(job('c'), { concurrency: 1, rpm: 6000 });
  ctrl.abort();
  await assert.rejects(b, { name: 'AbortError' });
  await clock.run();
  await Promise.all([a, c]);
  assert.deepEqual(order, ['a', 'c']);
});
