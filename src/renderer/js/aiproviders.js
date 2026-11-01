// AI 종류마다 다른 요청·응답 모양 (공통: 그림 여러 장 + 지시문 → JSON 으로 답)
// 키·주소를 붙여 실제로 보내는 일은 메인 프로세스(src/main/ai.js)에서 합니다.

/** 생각(thinking)을 줄여 빨리 답하게 하는 설정 — 모델마다 이름이 달라서 추측하고, 안 되면 빼고 다시 보냄 */
function thinkingFor(model) {
  const m = String(model || '').toLowerCase();
  if (/2\.5-flash/.test(m)) return { thinkingBudget: 0 };
  if (/2\.5-pro/.test(m)) return { thinkingBudget: 128 };
  if (/gemini-[3-9]/.test(m) || /-latest$/.test(m)) return { thinkingLevel: 'low' };
  return null;
}

/** 맨 바깥이 배열인 스키마 → {items: 배열} (OpenAI·Claude·Codex 는 바깥이 객체여야 함) */
function rootObject(schema) {
  return schema.type === 'ARRAY' ? { type: 'OBJECT', properties: { items: schema }, required: ['items'] } : schema;
}

/**
 * Gemini 모양 스키마(type: 'ARRAY' …) → 표준 JSON Schema
 * strict: 모든 칸을 required 로 두고, 원래 없어도 되던 칸은 null 도 허용 (Codex --output-schema)
 */
export function jsonSchema(schema, { strict = false, optional = false } = {}) {
  const type = String(schema.type).toLowerCase();
  let out;
  if (type === 'object') {
    const required = schema.required || [];
    const properties = {};
    for (const [k, v] of Object.entries(schema.properties || {})) properties[k] = jsonSchema(v, { strict, optional: !required.includes(k) });
    out = { type, properties, required: strict ? Object.keys(properties) : required, additionalProperties: false };
  } else if (type === 'array') {
    out = { type, items: jsonSchema(schema.items, { strict }) };
  } else {
    out = { type };
    if (schema.enum) out.enum = [...schema.enum];
  }
  if (strict && optional) {
    out.type = [type, 'null'];
    if (out.enum) out.enum.push(null);
  }
  return out;
}

/** 답의 모양을 지시문에도 적어 둠 (JSON 모양 지정을 모르는 서버·모델도 맞춰 답하게) */
const jsonHint = (schema, opts) => `\n\nAnswer with JSON only (no other text), matching this JSON Schema:\n${JSON.stringify(jsonSchema(rootObject(schema), opts))}`;

const textOf = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('') : '');

/** 경로(a.b)의 값을 지운 사본 (그래서 비게 된 a 도 지움) */
function without(body, ...paths) {
  const copy = structuredClone(body);
  for (const p of paths) {
    const [k1, k2] = p.split('.');
    if (!k2) delete copy[k1];
    else if (copy[k1]) {
      delete copy[k1][k2];
      if (!Object.keys(copy[k1]).length) delete copy[k1];
    }
  }
  return copy;
}

/** Claude 에서 서버 쪽 대체 모델(fallbacks)을 켜 두는 모델 */
const CLAUDE_FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

/**
 * AI 종류
 *   body({model, images, labels, prompt, schema}) → 메인 프로세스로 보낼 요청 내용
 *   text(json) → 답 글자 (JSON 이 들어 있음)
 *   relax(body, error) → 400 오류가 이 요청의 고를 수 있는 설정 때문이면 그 설정을 뺀 요청, 아니면 null
 */
export const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    choice: 'Google Gemini (기본)',
    defaultModel: 'gemini-flash-latest',
    defaultRpm: 8,
    body({ model, images, labels, prompt, schema }) {
      const parts = [];
      images.forEach((data, i) => {
        if (labels) parts.push({ text: `Image ${i + 1}:` });
        parts.push({ inlineData: { mimeType: 'image/jpeg', data } });
      });
      parts.push({ text: prompt });
      const thinking = thinkingFor(model);
      return {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: schema,
          ...(thinking ? { thinkingConfig: thinking } : {}),
        },
      };
    },
    text(json) {
      const parts = json?.candidates?.[0]?.content?.parts || [];
      return parts
        .filter((p) => typeof p.text === 'string' && !p.thought)
        .map((p) => p.text)
        .join('');
    },
    relax(body, error) {
      // 생각 설정을 모르는 모델
      if (body.generationConfig?.thinkingConfig && /think/i.test(error)) return without(body, 'generationConfig.thinkingConfig');
      return null;
    },
  },

  openai: {
    label: 'OpenAI 호환',
    choice: 'OpenAI 호환 (게이트웨이 · 로컬 Ollama 등)',
    defaultModel: '',
    defaultRpm: 60,
    body({ model, images, labels, prompt, schema }) {
      const content = [];
      images.forEach((data, i) => {
        if (labels) content.push({ type: 'text', text: `Image ${i + 1}:` });
        content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } });
      });
      content.push({ type: 'text', text: prompt + jsonHint(schema) });
      return {
        model,
        messages: [{ role: 'user', content }],
        temperature: 0,
        response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: jsonSchema(rootObject(schema)), strict: false } },
      };
    },
    text(json) {
      return textOf(json?.choices?.[0]?.message?.content);
    },
    relax(body, error) {
      if ('temperature' in body && /temperature/i.test(error)) return without(body, 'temperature');
      if (body.response_format && /response_format|json_schema|json_object|schema|structured/i.test(error)) {
        // JSON 모양 지정을 모르면 JSON 모드로, 그것도 모르면 지시문만으로
        if (body.response_format.type === 'json_schema') return { ...without(body, 'response_format'), response_format: { type: 'json_object' } };
        return without(body, 'response_format');
      }
      return null;
    },
  },

  anthropic: {
    label: 'Claude',
    choice: 'Anthropic Claude',
    defaultModel: 'claude-opus-5-5',
    defaultRpm: 50,
    body({ model, images, labels, prompt, schema }) {
      const content = [];
      images.forEach((data, i) => {
        if (labels) content.push({ type: 'text', text: `Image ${i + 1}:` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
      });
      content.push({ type: 'text', text: prompt + jsonHint(schema) });
      const body = {
        model,
        max_tokens: 16000,
        messages: [{ role: 'user', content }],
        // 글자 옮기기는 깊이 생각할 일이 아니라 빠르게
        output_config: { effort: 'low', format: { type: 'json_schema', schema: jsonSchema(rootObject(schema)) } },
      };
      // 안전 분류기가 거절하면 서버에서 다른 모델로 다시 (지원하는 모델만)
      if (CLAUDE_FALLBACK_MODELS.test(model)) Object.assign(body, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
      return body;
    },
    text(json) {
      if (json?.stop_reason === 'refusal') throw new Error('Claude 가 이 그림에 답하지 않았습니다.');
      return (json?.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    },
    relax(body, error) {
      if (body.fallbacks && /fallback/i.test(error)) return without(body, 'fallbacks', 'betas');
      if (body.output_config?.effort && /effort/i.test(error)) return without(body, 'output_config.effort');
      if (body.output_config?.format && /output_config|format|schema|structured/i.test(error)) return without(body, 'output_config.format');
      return null;
    },
  },

  codex: {
    label: 'ChatGPT(Codex)',
    choice: 'ChatGPT Plus/Pro 구독 (Codex CLI)',
    defaultModel: '', // 비우면 Codex CLI 의 기본 모델
    defaultRpm: 60,
    body({ images, prompt, schema }) {
      // 메인 프로세스가 그림을 임시 폴더에 파일로 쓰고 codex exec 에 붙여 보냄 (명령은 돌리지 말고 그림만 보고 답하게)
      const lead = `Answer directly from the ${images.length > 1 ? `${images.length} attached images (in the order attached)` : 'attached image'}. Do not run any commands or read any files.\n\n`;
      return { images, prompt: lead + prompt + jsonHint(schema, { strict: true }), schema: jsonSchema(rootObject(schema), { strict: true }) };
    },
    text(json) {
      return typeof json?.text === 'string' ? json.text : '';
    },
    relax: () => null,
  },
};

export const providerOf = (id) => PROVIDERS[id] || PROVIDERS.gemini;
