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

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('취소됨', 'AbortError'));
    });
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

/** 분당 요청 수 제한을 지키며 순서대로 호출 */
function throttled(fn, rpm, signal) {
  const run = async () => {
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

/**
 * 페이지 이미지로 문항 위치 인식
 * @param {string} base64Jpeg
 * @returns {Promise<{number:string,num:number,rect:{x:number,y:number,w:number,h:number}}[]>}
 */
export async function geminiDetect(base64Jpeg, { role = 'problem', model, rpm = 8, signal } = {}) {
  const body = {
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

  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
    const res = await throttled(() => api().geminiGenerate({ model, body }), rpm, signal);
    if (res.ok) return parseResponse(res.json);
    attempt++;
    const retriable = res.status === 429 || res.status === 500 || res.status === 503 || res.status === 0;
    if (!retriable || attempt > 3) {
      const msg = res.status === 429 ? `Gemini 사용 한도를 초과했습니다. (${res.error || ''})` : `Gemini 오류: ${res.error || res.status}`;
      throw new Error(msg);
    }
    const delay = retryDelayMs(res.json) || 4000 * 2 ** (attempt - 1);
    await sleep(Math.min(delay, 90000), signal);
  }
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
