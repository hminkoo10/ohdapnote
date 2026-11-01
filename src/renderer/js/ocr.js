// Tesseract.js(오프라인 OCR) 래퍼 - 스캔본/사진에서 번호를 읽을 때 사용합니다.
// 워커를 여러 개 띄워 여러 쪽을 동시에 읽습니다(CPU 코어 수에 맞춰 최대 4개).
import Tesseract from '../vendor/tesseract/tesseract.esm.min.js';

const BASE = new URL('../vendor/tesseract/', import.meta.url).href;

/** 동시에 돌리는 OCR 워커 수 */
export const OCR_WORKERS = Math.max(1, Math.min(4, Math.floor((globalThis.navigator?.hardwareConcurrency || 2) / 2)));

let poolLang = null;
/** @type {{promise: Promise<any>, busy: boolean, params: Record<string,string>}[]} */
let slots = [];
const waiters = [];

function createSlot(lang) {
  const slot = { busy: true, params: {} };
  slot.promise = Tesseract.createWorker(lang, Tesseract.OEM?.LSTM_ONLY ?? 1, {
    workerPath: `${BASE}worker.min.js`,
    corePath: `${BASE}core/`,
    langPath: `${BASE}lang`,
    workerBlobURL: false,
    gzip: true,
    cacheMethod: 'none',
  }).catch((err) => {
    slots = slots.filter((s) => s !== slot);
    throw new Error(`OCR 엔진을 시작하지 못했습니다: ${err?.message || err}`);
  });
  slots.push(slot);
  return slot;
}

// 한동안 쓰지 않으면 워커를 정리해서 메모리를 돌려줌 (워커마다 언어 데이터를 따로 들고 있음)
const IDLE_MS = 60000;
let idleTimer = null;

async function acquire(lang) {
  clearTimeout(idleTimer);
  if (poolLang !== lang) {
    await terminateOcr();
    poolLang = lang;
  }
  for (;;) {
    const free = slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return free;
    }
    if (slots.length < OCR_WORKERS) return createSlot(lang);
    await new Promise((ok) => waiters.push(ok));
  }
}

function release(slot) {
  slot.busy = false;
  waiters.shift()?.();
  const idle = () => !waiters.length && slots.every((s) => !s.busy);
  if (idle()) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle() && terminateOcr(), IDLE_MS);
  }
}

/** 쉬는 워커 하나를 빌려 parameters 를 맞춘 뒤 fn 실행 */
async function withWorker(lang, params, fn) {
  const slot = await acquire(lang);
  try {
    const worker = await slot.promise;
    const changed = Object.fromEntries(Object.entries(params).filter(([k, v]) => slot.params[k] !== v));
    if (Object.keys(changed).length) {
      await worker.setParameters(changed);
      Object.assign(slot.params, changed);
    }
    return await fn(worker);
  } finally {
    release(slot);
  }
}

/**
 * 캔버스에서 단어를 인식합니다.
 * @returns {Promise<{str:string,x0:number,y0:number,x1:number,y1:number,conf:number}[]>} 좌표는 캔버스 픽셀
 */
export async function recognizeWords(canvas, { lang = 'kor+eng', psm = '11' } = {}) {
  const { data } = await withWorker(lang, { tessedit_pageseg_mode: psm, user_defined_dpi: '220', tessedit_char_whitelist: '' }, (w) =>
    w.recognize(canvas, {}, { text: false, blocks: true }),
  );
  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) {
          const str = (w.text || '').trim();
          if (!str) continue;
          words.push({ str, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, conf: w.confidence ?? 0 });
        }
      }
    }
  }
  return words;
}

/**
 * 한 줄짜리 작은 영역을 인식(번호 재탐색용). whitelist 로 숫자만 읽게 할 수 있음.
 * @returns {Promise<{text:string, conf:number}>}
 */
export async function recognizeLine(canvas, { lang = 'kor+eng', whitelist = '' } = {}) {
  const { data } = await withWorker(lang, { tessedit_pageseg_mode: '7', tessedit_char_whitelist: whitelist }, (w) => w.recognize(canvas, {}, { text: true }));
  return { text: (data.text || '').trim(), conf: data.confidence ?? 0 };
}

export async function terminateOcr() {
  const old = slots;
  slots = [];
  poolLang = null;
  for (const s of old) {
    try {
      (await s.promise).terminate();
    } catch {
      /* 무시 */
    }
  }
}
