// Google Gemini API(무료 티어 가능) 보조 인식 - 선택 기능
// 실제 HTTP 호출은 메인 프로세스(window.ohdap.geminiGenerate)에서 합니다.

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

let lastCallAt = 0;
let chain = Promise.resolve();
const exhausted = new Map(); // 모델 → 이 시각까지 쓰지 않음(한도 초과)

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

function retryDelayMs(json) {
  const details = json?.error?.details || [];
  for (const d of details) {
    if (d.retryDelay) {
      const s = parseFloat(String(d.retryDelay));
      if (s > 0) return s * 1000;
    }
  }
  return 0;
}

/** 하루 한도처럼 오래 기다려야 하는 한도 초과인지 */
function isDailyQuota(res) {
  const text = JSON.stringify(res.json?.error || res.error || '');
  return /per ?day|PerDay|daily/i.test(text);
}

/** 분당 요청 수 제한을 지키며 순서대로 호출 (취소하면 기다리던 것도 바로 멈춤) */
function throttled(fn, rpm, signal) {
  const run = async () => {
    if (signal?.aborted) throw abortError();
    const gap = 60000 / Math.max(1, rpm || 8);
    const wait = lastCallAt + gap - Date.now();
    if (wait > 0) await sleep(wait, signal);
    lastCallAt = Date.now();
    return fn();
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/** 생각(thinking)을 줄여 빨리 답하게 하는 설정 — 모델마다 이름이 달라서 추측하고, 안 되면 빼고 다시 보냄 */
function thinkingFor(model) {
  const m = String(model || '').toLowerCase();
  if (/2\.5-flash/.test(m)) return { thinkingBudget: 0 };
  if (/2\.5-pro/.test(m)) return { thinkingBudget: 128 };
  if (/gemini-[3-9]/.test(m) || /-latest$/.test(m)) return { thinkingLevel: 'low' };
  return null;
}

let reqSeq = 0;
/** 메인 프로세스 호출. 취소하면 요청을 끊고 바로 AbortError */
function callGemini(model, body, signal) {
  const requestId = `g${Date.now().toString(36)}-${++reqSeq}`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      api().geminiAbort?.(requestId);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    api()
      .geminiGenerate({ model, body, requestId })
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', onAbort));
  });
}

/**
 * 페이지 이미지로 문항 위치 인식
 * 1순위 모델이 한도 초과·사용 불가면 2순위 모델로 넘어갑니다.
 * @param {string} base64Jpeg
 * @param {{role?:string, models?:string[], model?:string, rpm?:number, signal?:AbortSignal, onStatus?:(msg:string)=>void}} opts
 * @returns {Promise<{number:string,num:number,rect:{x:number,y:number,w:number,h:number}}[]>} (배열에 .model = 실제로 쓴 모델)
 */
export async function geminiDetect(base64Jpeg, { role = 'problem', models, model, rpm = 8, signal, onStatus } = {}) {
  const list = [...new Set([...(models || []), model].map((m) => String(m || '').trim().replace(/^models\//, '')).filter(Boolean))];
  if (!list.length) list.push('gemini-flash-latest');
  const baseBody = {
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/jpeg', data: base64Jpeg } }, { text: PROMPTS[role] || PROMPTS.problem }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };
  // 한도가 찬 모델은 뒤로
  const now = Date.now();
  const ordered = [...list.filter((m) => !(exhausted.get(m) > now)), ...list.filter((m) => exhausted.get(m) > now)];
  let lastError = null;
  for (let mi = 0; mi < ordered.length; mi++) {
    const m = ordered[mi];
    const isLast = mi === ordered.length - 1;
    let thinking = thinkingFor(m);
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw abortError();
      const body = thinking ? { ...baseBody, generationConfig: { ...baseBody.generationConfig, thinkingConfig: thinking } } : baseBody;
      const res = await throttled(() => callGemini(m, body, signal), rpm, signal);
      if (res.aborted) throw abortError();
      if (res.ok) {
        const out = parseResponse(res.json);
        out.model = m;
        return out;
      }
      attempt++;
      // 생각 설정을 모르는 모델 → 빼고 다시
      if (res.status === 400 && thinking && /think/i.test(res.error || '')) {
        thinking = null;
        continue;
      }
      if (res.status === 429) {
        const daily = isDailyQuota(res);
        exhausted.set(m, Date.now() + (daily ? 6 * 3600e3 : 60e3));
        lastError = `${m}: 사용 한도 초과${daily ? '(오늘 사용량)' : ''}`;
        if (!isLast) {
          onStatus?.(`${m} 한도 초과 → ${ordered[mi + 1]} 로 바꿔서 시도`);
          break;
        }
        if (daily || attempt > 2) throw new Error(`Gemini 사용 한도를 초과했습니다. (${lastError}) 설정에서 2순위 모델을 정하거나 잠시 뒤에 다시 해 주세요.`);
        const delay = Math.min(65000, retryDelayMs(res.json) || 15000 * attempt);
        onStatus?.(`한도 초과 — ${Math.round(delay / 1000)}초 기다렸다가 다시 시도`);
        await sleep(delay, signal);
        continue;
      }
      // 모델 이름이 틀렸거나 쓸 수 없는 모델
      if (res.status === 404 || res.status === 403 || (res.status === 400 && /model/i.test(res.error || ''))) {
        lastError = `${m}: ${res.error || res.status}`;
        if (!isLast) {
          onStatus?.(`${m} 사용 불가 → ${ordered[mi + 1]} 로 시도`);
          break;
        }
        throw new Error(`Gemini 오류: ${lastError}`);
      }
      const retriable = res.status >= 500 || res.status === 0;
      if (retriable && attempt <= 2) {
        await sleep(2500 * attempt, signal);
        continue;
      }
      lastError = `${m}: ${res.error || res.status}`;
      if (!isLast) break;
      throw new Error(`Gemini 오류: ${lastError}`);
    }
  }
  throw new Error(`Gemini 오류: ${lastError || '알 수 없음'}`);
}

export function parseResponse(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const text = parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  if (!text.trim()) return [];
  let arr;
  try {
    arr = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error('Gemini 응답을 해석하지 못했습니다.');
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const e of arr) {
    const digits = String(e?.number ?? '').replace(/\D/g, '');
    const box = e?.box_2d;
    if (!digits || !Array.isArray(box) || box.length !== 4) continue;
    let [ymin, xmin, ymax, xmax] = box.map((v) => Math.max(0, Math.min(1000, Number(v) || 0)) / 1000);
    if (ymax < ymin) [ymin, ymax] = [ymax, ymin];
    if (xmax < xmin) [xmin, xmax] = [xmax, xmin];
    if (ymax - ymin < 0.005 || xmax - xmin < 0.01) continue;
    out.push({ number: digits, num: parseInt(digits, 10), rect: { x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin } });
  }
  return out;
}

export function canvasToBase64Jpeg(canvas, quality = 0.85) {
  const url = canvas.toDataURL('image/jpeg', quality);
  return url.slice(url.indexOf(',') + 1);
}
