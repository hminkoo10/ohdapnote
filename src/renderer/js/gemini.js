// AI 보조 인식 - 선택 기능 (기본은 Google Gemini, 설정 → 세부 설정에서 OpenAI 호환·Claude·ChatGPT 구독으로 바꿈)
// 실제 호출은 메인 프로세스(window.ohdap.aiGenerate)에서 합니다. AI 마다 다른 요청·응답 모양은 aiproviders.js

import { providerOf } from './aiproviders.js';

const api = () => window.ohdap;

const PROMPTS = {
  problem: `This image is one page of a Korean math workbook (문제집).
Find every numbered problem on this page.
For each problem return:
- "number": the problem number exactly as printed, digits only (e.g. "7", "12", "0153"). Do not include sub-question markers like (1), ①.
- "box_2d": [ymin, xmin, ymax, xmax] normalized to 0-1000, covering the WHOLE problem: its number, text, formulas, figures, tables and answer choices, but not neighbouring problems, page headers/footers or section titles.
List problems in reading order (left column top→bottom, then right column).
Ignore text that continues from the previous page without a number. If there are no numbered problems, return [].`,
  answer: `This image is one page of a Korean math answer/solution book (정답과 해설).
Find every solution entry. Each entry starts with the problem number it answers.
For each entry return:
- "number": the problem number exactly as printed, digits only (e.g. "7", "12", "0153"). Do not include sub-question markers like (1), ①.
- "box_2d": [ymin, xmin, ymax, xmax] normalized to 0-1000, covering the whole entry on this page (answer and explanation up to the next entry), but not page headers/footers.
List entries in reading order (column by column, top→bottom).
Ignore a quick-answer table (빠른 정답) if present. If there are no entries, return [].`,
};

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      number: { type: 'STRING' },
      box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
    },
    required: ['number', 'box_2d'],
  },
};

const exhausted = new Map(); // "AI:모델" → 이 시각까지 쓰지 않음(한도 초과)

const abortError = () => new DOMException('취소됨', 'AbortError');

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true },
    );
  });

/**
 * 동시에 보내는 요청 수와 분당 요청 수를 지키는 줄 세우기
 * - 동시에 concurrency 개까지 (나머지는 순서대로 기다림)
 * - 요청을 "시작"하는 간격이 60/rpm 초 이상 (앞 요청이 끝나기를 기다리지는 않음)
 * - 취소하면 기다리던 것도 바로 멈춤
 * now·wait 는 시험할 때 가짜 시계로 바꿔 끼움
 */
export function createLimiter({ now = () => Date.now(), wait = sleep } = {}) {
  let active = 0;
  let nextAt = 0;
  const queue = [];
  const pump = () => {
    while (queue.length && active < queue[0].concurrency) {
      const w = queue.shift();
      w.signal?.removeEventListener('abort', w.onAbort);
      active++;
      w.resolve();
    }
  };
  return async function run(fn, { rpm = 8, concurrency = 1, signal } = {}) {
    if (signal?.aborted) throw abortError();
    concurrency = Math.max(1, concurrency | 0);
    if (active < concurrency && !queue.length) active++;
    else {
      await new Promise((resolve, reject) => {
        const w = { resolve, concurrency, signal };
        w.onAbort = () => {
          queue.splice(queue.indexOf(w), 1);
          reject(abortError());
        };
        signal?.addEventListener('abort', w.onAbort, { once: true });
        queue.push(w);
      });
    }
    try {
      const t = now();
      const at = Math.max(t, nextAt);
      nextAt = at + 60000 / Math.max(1, rpm || 8);
      if (at > t) await wait(at - t, signal);
      return await fn();
    } finally {
      active--;
      pump();
    }
  };
}

const limited = createLimiter();

function retryDelayMs(res) {
  const details = res.json?.error?.details || [];
  for (const d of details) {
    if (d.retryDelay) {
      const s = parseFloat(String(d.retryDelay));
      if (s > 0) return s * 1000;
    }
  }
  return res.retryAfter > 0 ? res.retryAfter * 1000 : 0;
}

/** 하루 한도·사용량 소진처럼 오래 기다려야 하는 한도 초과인지 */
function isDailyQuota(res) {
  const text = JSON.stringify(res.json?.error || res.error || '');
  return /per ?day|PerDay|daily|insufficient_quota|usage limit/i.test(text);
}

const modelName = (m) => m || '기본 모델';

let reqSeq = 0;
/** 메인 프로세스 호출. 취소하면 요청을 끊고 바로 AbortError */
function callAi(provider, model, body, signal) {
  const requestId = `g${Date.now().toString(36)}-${++reqSeq}`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      api().aiAbort?.(requestId);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    api()
      .aiGenerate({ provider, model, body, requestId })
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', onAbort));
  });
}

/**
 * AI 호출: 동시 요청 수·분당 요청 수를 지키고, 1순위 모델이 한도 초과·사용 불가면 2순위 모델로
 * @param {{images:string[], labels?:boolean, prompt:string, schema:object}} req  그림은 base64 JPEG
 * @param {{provider?:string, models?:string[], model?:string, rpm?:number, concurrency?:number, signal?:AbortSignal, onStatus?:(msg:string)=>void}} opts
 * @returns {Promise<{json:object, model:string, provider:string}>}
 */
async function generate(req, { provider = 'gemini', models, model, rpm, concurrency = 1, signal, onStatus } = {}) {
  const P = providerOf(provider);
  const list = [...new Set([...(models || []), model].map((m) => String(m || '').trim().replace(/^models\//, '')).filter(Boolean))];
  if (!list.length) list.push(P.defaultModel); // Codex 는 '' = CLI 기본 모델
  // 한도가 찬 모델은 뒤로
  const now = Date.now();
  const full = (m) => exhausted.get(`${provider}:${m}`) > now;
  const ordered = [...list.filter((m) => !full(m)), ...list.filter(full)];
  let lastError = null;
  for (let mi = 0; mi < ordered.length; mi++) {
    const m = ordered[mi];
    const isLast = mi === ordered.length - 1;
    let body = P.body({ model: m, ...req });
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw abortError();
      const res = await limited(() => callAi(provider, m, body, signal), { rpm: rpm || P.defaultRpm, concurrency, signal });
      if (res.aborted) throw abortError();
      if (res.ok) return { json: res.json, model: m, provider };
      attempt++;
      // 이 모델·서버가 모르는 설정(생각·온도·JSON 모양 …) → 빼고 다시
      if (res.status === 400) {
        const relaxed = P.relax(body, res.error || '');
        if (relaxed) {
          body = relaxed;
          continue;
        }
      }
      if (res.status === 429) {
        const daily = isDailyQuota(res);
        exhausted.set(`${provider}:${m}`, Date.now() + (daily ? 6 * 3600e3 : 60e3));
        lastError = `${modelName(m)}: 사용 한도 초과${daily ? '(오늘 사용량)' : ''}`;
        if (!isLast) {
          onStatus?.(`${modelName(m)} 한도 초과 → ${modelName(ordered[mi + 1])} 로 바꿔서 시도`);
          break;
        }
        if (daily || attempt > 2) throw new Error(`${P.label} 사용 한도를 초과했습니다. (${lastError}) 설정에서 2순위 모델을 정하거나 잠시 뒤에 다시 해 주세요.`);
        const delay = Math.min(65000, retryDelayMs(res) || 15000 * attempt);
        onStatus?.(`한도 초과 — ${Math.round(delay / 1000)}초 기다렸다가 다시 시도`);
        await sleep(delay, signal);
        continue;
      }
      // 모델 이름이 틀렸거나 쓸 수 없는 모델
      if (res.status === 404 || res.status === 403 || (res.status === 400 && /model/i.test(res.error || ''))) {
        lastError = `${modelName(m)}: ${res.error || res.status}`;
        if (!isLast) {
          onStatus?.(`${modelName(m)} 사용 불가 → ${modelName(ordered[mi + 1])} 로 시도`);
          break;
        }
        throw new Error(`${P.label} 오류: ${lastError}`);
      }
      const retriable = res.status >= 500 || res.status === 0;
      if (retriable && attempt <= 2) {
        await sleep(2500 * attempt, signal);
        continue;
      }
      lastError = `${modelName(m)}: ${res.error || res.status}`;
      if (!isLast) break;
      throw new Error(`${P.label} 오류: ${lastError}`);
    }
  }
  throw new Error(`${P.label} 오류: ${lastError || '알 수 없음'}`);
}

/** AI 가 준 글자에서 JSON 꺼내기. 내용이 없으면 null */
export function parseJsonText(text) {
  const t = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // 앞뒤에 설명을 붙여 답하는 모델 → 처음 { [ 부터 마지막 } ] 까지
    const start = t.search(/[[{]/);
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        /* 아래에서 */
      }
    }
    throw new Error('AI 응답을 해석하지 못했습니다.');
  }
}

/** AI 응답(provider 모양) → JSON 값 */
const responseJson = (json, provider = 'gemini') => parseJsonText(providerOf(provider).text(json));

/** [ymin, xmin, ymax, xmax] (0~1000) → {x, y, w, h} (0~1). 너무 작으면 null */
function boxRect(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  let [ymin, xmin, ymax, xmax] = box.map((v) => Math.max(0, Math.min(1000, Number(v) || 0)) / 1000);
  if (ymax < ymin) [ymin, ymax] = [ymax, ymin];
  if (xmax < xmin) [xmin, xmax] = [xmax, xmin];
  if (ymax - ymin < 0.005 || xmax - xmin < 0.01) return null;
  return { x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin };
}

/** 쪽 인식 응답 → 문항 목록 (배열 그대로든 {items: 배열}이든) */
export function parseResponse(json, provider = 'gemini') {
  const data = responseJson(json, provider);
  const arr = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const e of arr) {
    const digits = String(e?.number ?? '').replace(/\D/g, '');
    const rect = boxRect(e?.box_2d);
    if (!digits || !rect) continue;
    out.push({ number: digits, num: parseInt(digits, 10), rect });
  }
  return out;
}

/**
 * 페이지 이미지로 문항 위치 인식
 * 1순위 모델이 한도 초과·사용 불가면 2순위 모델로 넘어갑니다.
 * @param {string} base64Jpeg
 * @param {{role?:string, provider?:string, models?:string[], model?:string, rpm?:number, signal?:AbortSignal, onStatus?:(msg:string)=>void}} opts
 * @returns {Promise<{number:string,num:number,rect:{x:number,y:number,w:number,h:number}}[]>} (배열에 .model = 실제로 쓴 모델)
 */
export async function geminiDetect(base64Jpeg, { role = 'problem', ...opts } = {}) {
  const out = await generate({ images: [base64Jpeg], prompt: PROMPTS[role] || PROMPTS.problem, schema: RESPONSE_SCHEMA }, opts);
  const list = parseResponse(out.json, out.provider);
  list.model = out.model;
  return list;
}

// ---------------------------------------------------------------------------
// 문항 그림 → 글자 + 수식 (한글 문서 내보내기)
// ---------------------------------------------------------------------------
const TRANSCRIBE_COMMON = `Transcribe the content in reading order so it can be retyped in a word processor with an equation editor.
Return "blocks", each one of:
- {"type":"para","text":...}: one paragraph of text. Copy Korean text exactly as printed (do not translate, summarize, correct or solve anything). Write every mathematical expression, variable and number with mathematical meaning as LaTeX between single dollar signs, e.g. "함수 $f(x)=x^{2}-2x$ 의 최솟값은?". Start a new para where the printed text starts a new line of meaning (e.g. each line of a <보기> box: ㄱ. ㄴ. ㄷ.).
- {"type":"math","latex":...}: an equation displayed on its own line, LaTeX without dollar signs.
- {"type":"choices","items":[...]}: the answer choices ①②③④⑤ in order; each item is the choice content WITHOUT the circled number, math in $...$.
- {"type":"figure","box_2d":[ymin,xmin,ymax,xmax]}: a graph, diagram, geometric figure, table or picture that cannot be written as text, as a box normalized to 0-1000 on this image. Text inside the figure is not transcribed separately.
Use standard LaTeX: \\frac{a}{b}, \\sqrt{x}, \\sqrt[n]{x}, x^{2}, a_{n}, \\log_{a} b, \\lim_{x \\to a}, \\sum_{k=1}^{n}, \\int_{a}^{b}, \\left( \\right), \\overline{AB}, \\angle, \\triangle, \\begin{cases} ... \\end{cases}. Use \\text{...} for Korean words inside math.
Ignore page headers/footers and anything that belongs to a neighbouring item.`;

const ROLE_NOTE = {
  problem: `Do not include the problem number itself at the start (e.g. "0153", "12.", "유제 3") — it is printed separately. Keep score marks such as [4점].`,
  answer: `Do not include the problem number the entry refers to at the start — it is printed separately. Keep the answer line (e.g. "답 ③") and the whole explanation.`,
};

const TRANSCRIBE_PROMPTS = {
  problem: `This image is ONE problem cropped from a Korean high-school math workbook (문제집).
${TRANSCRIBE_COMMON}
${ROLE_NOTE.problem}`,
  answer: `This image is ONE solution entry cropped from a Korean high-school math answer book (정답과 해설).
${TRANSCRIBE_COMMON}
${ROLE_NOTE.answer}`,
};

/** 그림 여러 장(문항마다 한 장)을 한 번에 옮기는 지시문 */
function batchPrompt(role, n) {
  const what = role === 'answer' ? `${n} DIFFERENT solution entries cropped from a Korean high-school math answer book (정답과 해설)` : `${n} DIFFERENT problems cropped from a Korean high-school math workbook (문제집)`;
  return `These ${n} images are ${what}, given in order as Image 1 … Image ${n}. Treat every image on its own and never mix content between images.
For EACH image:
${TRANSCRIBE_COMMON}
Figure boxes are normalized to the image they belong to.
${ROLE_NOTE[role] || ROLE_NOTE.problem}
Return {"items":[{"index":1,"blocks":[...]}, ...]} with exactly one entry per image, where "index" is the image number (1 … ${n}).`;
}

const BLOCKS_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      type: { type: 'STRING', enum: ['para', 'math', 'choices', 'figure'] },
      text: { type: 'STRING' },
      latex: { type: 'STRING' },
      items: { type: 'ARRAY', items: { type: 'STRING' } },
      box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
    },
    required: ['type'],
  },
};

const TRANSCRIBE_SCHEMA = {
  type: 'OBJECT',
  properties: { blocks: BLOCKS_SCHEMA },
  required: ['blocks'],
};

const TRANSCRIBE_BATCH_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { index: { type: 'INTEGER' }, blocks: BLOCKS_SCHEMA },
        required: ['index', 'blocks'],
      },
    },
  },
  required: ['items'],
};

/** 블록 다듬기: 모르는 종류·빈 내용은 빼고 그림 상자는 0~1 비율로 */
function cleanBlocks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const b of list) {
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    if (b?.type === 'para' && str(b.text)) out.push({ type: 'para', text: str(b.text) });
    else if (b?.type === 'math' && str(b.latex)) out.push({ type: 'math', latex: str(b.latex).replace(/^\$+|\$+$/g, '') });
    else if (b?.type === 'choices' && Array.isArray(b.items)) {
      const items = b.items.map(str).filter(Boolean);
      if (items.length) out.push({ type: 'choices', items });
    } else if (b?.type === 'figure') {
      const box = boxRect(b.box_2d);
      if (box) out.push({ type: 'figure', box });
    }
  }
  return out;
}

/** 옮긴 결과(그림 한 장) 다듬기 */
export function parseTranscription(json, provider = 'gemini') {
  const obj = responseJson(json, provider);
  return cleanBlocks(Array.isArray(obj) ? obj : obj?.blocks);
}

/**
 * 한 번에 옮긴 결과(그림 n장) → 그림마다 블록 (빠졌거나 빈 것은 null). 묶음 모양이 아니면 null
 * @returns {(object[]|null)[] | null}
 */
export function parseTranscriptionBatch(json, n, provider = 'gemini') {
  const obj = responseJson(json, provider);
  const list = Array.isArray(obj) ? obj : obj?.items;
  if (!Array.isArray(list)) return null;
  const zeroBased = list.some((e) => e?.index === 0);
  const out = new Array(n).fill(null);
  list.forEach((e, i) => {
    const k = Number.isInteger(e?.index) ? e.index - (zeroBased ? 0 : 1) : i;
    if (k < 0 || k >= n || out[k]) return;
    const blocks = cleanBlocks(Array.isArray(e) ? e : e?.blocks);
    if (blocks.length) out[k] = blocks;
  });
  return out;
}

/**
 * 문제(또는 해설) 하나를 자른 그림 → 글자·수식 블록
 * @param {string} base64Jpeg
 * @param {{role?:'problem'|'answer', provider?:string, models?:string[], model?:string, rpm?:number, concurrency?:number, signal?:AbortSignal, onStatus?:(msg:string)=>void}} opts
 * @returns {Promise<{type:'para'|'math'|'choices'|'figure', text?:string, latex?:string, items?:string[], box?:{x,y,w,h}}[]>} (배열에 .model)
 */
export async function geminiTranscribe(base64Jpeg, { role = 'problem', ...opts } = {}) {
  const out = await generate({ images: [base64Jpeg], prompt: TRANSCRIBE_PROMPTS[role] || TRANSCRIBE_PROMPTS.problem, schema: TRANSCRIBE_SCHEMA }, opts);
  const blocks = parseTranscription(out.json, out.provider);
  blocks.model = out.model;
  return blocks;
}

/** 실패를 그 자리의 Error 로 (취소만 그대로 던짐) */
const settle = (p) =>
  p.catch((err) => {
    if (err?.name === 'AbortError') throw err;
    return err instanceof Error ? err : new Error(String(err));
  });

/**
 * 문항 여러 개를 한 요청으로: 그림 여러 장 → 그림마다 블록
 * 답을 해석하지 못했거나 빠진 그림만 한 장씩 다시 보냅니다.
 * 요청 자체가 실패하면(한도 초과 등) 던짐.
 * @param {string[]} images base64 JPEG
 * @param {object} opts geminiTranscribe 와 같음
 * @returns {Promise<(object[] | Error)[]>} 그림 순서대로 블록 배열(.model) 또는 그 그림의 오류
 */
export async function geminiTranscribeBatch(images, { role = 'problem', ...opts } = {}) {
  if (images.length <= 1) return Promise.all(images.map((img) => settle(geminiTranscribe(img, { role, ...opts }))));
  const out = await generate({ images, labels: true, prompt: batchPrompt(role, images.length), schema: TRANSCRIBE_BATCH_SCHEMA }, opts);
  let parsed = null;
  try {
    parsed = parseTranscriptionBatch(out.json, images.length, out.provider);
  } catch {
    parsed = null;
  }
  const results = images.map((_, i) => {
    const b = parsed?.[i];
    if (b) b.model = out.model;
    return b || null;
  });
  const missing = results.flatMap((r, i) => (r ? [] : [i]));
  if (missing.length) opts.onStatus?.(`한 번에 보낸 답에서 ${missing.length}개를 읽지 못해 하나씩 다시 보내요`);
  const singles = await Promise.all(missing.map((i) => settle(geminiTranscribe(images[i], { role, ...opts }))));
  missing.forEach((i, k) => {
    results[i] = singles[k];
  });
  return results;
}

export function canvasToBase64Jpeg(canvas, quality = 0.85) {
  const url = canvas.toDataURL('image/jpeg', quality);
  return url.slice(url.indexOf(',') + 1);
}
