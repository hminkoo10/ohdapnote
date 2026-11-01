// Tesseract.js(오프라인 OCR) 래퍼 - 스캔본/사진에서 번호를 읽을 때 사용합니다.
// 워커를 여러 개 띄워 여러 쪽을 동시에 읽습니다(CPU 코어 수에 맞춰 최대 8개, 워커 하나에 메모리 90MB 안팎).
import Tesseract from '../vendor/tesseract/tesseract.esm.min.js';

const BASE = new URL('../vendor/tesseract/', import.meta.url).href;

/** 동시에 돌리는 OCR 워커 수 */
export const OCR_WORKERS = Math.max(1, Math.min(8, Math.floor((globalThis.navigator?.hardwareConcurrency || 2) / 2)));

/** @type {{lang: string, promise: Promise<any>, busy: boolean, params: Record<string,string>}[]} */
let slots = [];
/** @type {{lang: string, wake: () => void}[]} */
const waiters = [];

function createSlot(lang) {
  const slot = { lang, busy: true, params: {} };
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

async function retire(slot) {
  slots = slots.filter((s) => s !== slot);
  try {
    (await slot.promise).terminate();
  } catch {
    /* 무시 */
  }
}

// 한동안 쓰지 않으면 워커를 정리해서 메모리를 돌려줌 (워커마다 언어 데이터를 따로 들고 있음)
const IDLE_MS = 60000;
let idleTimer = null;

async function acquire(lang) {
  clearTimeout(idleTimer);
  for (;;) {
    const free = slots.find((s) => !s.busy && s.lang === lang);
    if (free) {
      free.busy = true;
      return free;
    }
    if (slots.length < OCR_WORKERS) return createSlot(lang);
    // 다른 언어로 띄운 워커가 쉬고 있으면 정리하고 이 언어로 새로 띄움
    const other = slots.find((s) => !s.busy);
    if (other) {
      retire(other);
      return createSlot(lang);
    }
    await new Promise((wake) => waiters.push({ lang, wake }));
  }
}

function release(slot) {
  slot.busy = false;
  // 같은 언어를 기다리는 작업부터 깨움 (언어가 다른 작업이 섞여 있을 때 워커를 자꾸 바꾸지 않게)
  const k = waiters.findIndex((w) => w.lang === slot.lang);
  if (waiters.length) waiters.splice(k >= 0 ? k : 0, 1)[0].wake();
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
 * 캔버스 → 회색 PGM 파일 바이트. 캔버스를 그대로 넘기면 PNG 로 압축했다가 워커에서 다시 푸는데,
 * 쪽 하나에 0.4초쯤 걸려서 압축 없는 회색 이미지로 넘김 (회색 변환은 Tesseract 와 같은 0.3·0.5·0.2)
 */
function toPgm(canvas) {
  const { width: w, height: h } = canvas;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
  const head = new TextEncoder().encode(`P5\n${w} ${h}\n255\n`);
  const buf = new Uint8Array(head.length + w * h);
  buf.set(head);
  for (let i = 0, j = head.length; i < data.length; i += 4, j++) buf[j] = (data[i] * 3 + data[i + 1] * 5 + data[i + 2] * 2 + 5) / 10;
  return buf;
}

/**
 * 캔버스에서 단어를 인식합니다.
 * @returns {Promise<{str:string,x0:number,y0:number,x1:number,y1:number,conf:number}[]>} 좌표는 캔버스 픽셀
 */
export async function recognizeWords(canvas, { lang = 'kor+eng', psm = '11' } = {}) {
  const image = toPgm(canvas);
  const { data } = await withWorker(lang, { tessedit_pageseg_mode: psm, user_defined_dpi: '220', tessedit_char_whitelist: '' }, (w) =>
    w.recognize(image, {}, { text: false, blocks: true }),
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
  const image = toPgm(canvas);
  const { data } = await withWorker(lang, { tessedit_pageseg_mode: '7', tessedit_char_whitelist: whitelist }, (w) => w.recognize(image, {}, { text: true }));
  return { text: (data.text || '').trim(), conf: data.confidence ?? 0 };
}

export async function terminateOcr() {
  const old = slots;
  slots = [];
  for (const s of old) {
    try {
      (await s.promise).terminate();
    } catch {
      /* 무시 */
    }
  }
}
