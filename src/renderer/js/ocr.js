// Tesseract.js(오프라인 OCR) 래퍼 - 스캔본/사진에서 번호를 읽을 때 사용합니다.
import Tesseract from '../vendor/tesseract/tesseract.esm.min.js';

const BASE = new URL('../vendor/tesseract/', import.meta.url).href;

let workerPromise = null;
let workerLang = null;
let currentPsm = null;

async function getWorker(lang) {
  if (workerPromise && workerLang === lang) return workerPromise;
  if (workerPromise) {
    try {
      (await workerPromise).terminate();
    } catch {
      /* 무시 */
    }
  }
  workerLang = lang;
  currentPsm = null;
  workerPromise = Tesseract.createWorker(lang, Tesseract.OEM?.LSTM_ONLY ?? 1, {
    workerPath: `${BASE}worker.min.js`,
    corePath: `${BASE}core/`,
    langPath: `${BASE}lang`,
    workerBlobURL: false,
    gzip: true,
    cacheMethod: 'none',
  }).catch((err) => {
    workerPromise = null;
    throw new Error(`OCR 엔진을 시작하지 못했습니다: ${err?.message || err}`);
  });
  return workerPromise;
}

/**
 * 캔버스에서 단어를 인식합니다.
 * @returns {Promise<{str:string,x0:number,y0:number,x1:number,y1:number,conf:number}[]>} 좌표는 캔버스 픽셀
 */
export async function recognizeWords(canvas, { lang = 'kor+eng', psm = '11' } = {}) {
  const worker = await getWorker(lang);
  if (currentPsm !== psm) {
    await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: '220' });
    currentPsm = psm;
  }
  const { data } = await worker.recognize(canvas, {}, { text: false, blocks: true });
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
  const worker = await getWorker(lang);
  await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: whitelist });
  currentPsm = '7';
  try {
    const { data } = await worker.recognize(canvas, {}, { text: true });
    return { text: (data.text || '').trim(), conf: data.confidence ?? 0 };
  } finally {
    await worker.setParameters({ tessedit_char_whitelist: '' });
  }
}

export async function terminateOcr() {
  if (!workerPromise) return;
  try {
    (await workerPromise).terminate();
  } catch {
    /* 무시 */
  }
  workerPromise = null;
  workerLang = null;
}
