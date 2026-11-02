// 스캔본 문항 그림 → 글자 + 한글 수식 (AI 없이, 이 컴퓨터에서)
//  1) Tesseract 로 두 번 읽음: 한국어+영어(psm 6, 글자 상자가 고름) · 한국어만(psm 11, 수식에 붙은 조사를 잘 읽음)
//  2) scanmath.planScan 이 글 / 수식 상자 / 그림 / 보기를 나눔
//  3) 수식 상자를 잘라 메인 프로세스의 수식 인식(Pix2Text MFR)에 한 번에 보냄
//     → 짝 없는 괄호·끝 쉼표를 먼저 떼어 두고(trimLatex — "(단, a>0)" 의 ")") normalizeLatex
//  4) assembleBlocks 로 AI 가 옮긴 것과 같은 모양의 블록으로

import { recognizeWords } from './ocr.js';
import { planScan, cropFormula, assembleBlocks, judgeScan, trimLatex } from './scanmath.js';
import { normalizeLatex } from './latexnorm.js';

let seq = 0;

/**
 * @param {HTMLCanvasElement} canvas renderStack 그림 (canvas.parts = 쌓은 영역들)
 * @param {object} o
 *   number     문항 번호 (첫 줄에서 뺌)
 *   signal     AbortSignal — 멈추면 인식도 끊음
 *   onStatus?(msg)
 *   api        window.ohdap (mathocrRecognize / mathocrAbort)
 * @returns {Promise<{blocks: object[], reliable: boolean, reasons: string[], formulas: number}>}
 */
export async function scanTranscribe(canvas, { number = '', signal, onStatus, api }) {
  const abortErr = () => new DOMException('취소됨', 'AbortError');
  if (signal?.aborted) throw abortErr();
  const { width: W, height: H } = canvas;
  const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  onStatus?.('글자 읽는 중…');
  const [mixed, kor] = await Promise.all([
    recognizeWords(canvas, { lang: 'kor+eng', psm: '6', symbols: true }),
    recognizeWords(canvas, { lang: 'kor', psm: '11', symbols: true }),
  ]);
  if (signal?.aborted) throw abortErr();
  const segments = (canvas.parts || []).map((p) => ({ y: p.y, h: p.h, stem: p.stem }));
  const plan = planScan(img, [{ words: mixed }, { words: kor, kor: true }], { number, segments });
  let results = [];
  if (plan.formulas.length) {
    onStatus?.(`수식 ${plan.formulas.length}개 인식 중…`);
    const images = plan.formulas.map((f) => cropFormula(img, plan, f));
    const requestId = `scan-${Date.now()}-${++seq}`;
    const stop = () => api.mathocrAbort(requestId);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const r = await api.mathocrRecognize({ images, requestId });
      if (signal?.aborted) throw abortErr();
      if (!r?.ok) throw new Error(r?.error || '수식을 인식하지 못했어요.');
      results = r.results;
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  }
  // normalizeLatex 는 짝 없는 ")" 를 지우므로, 글로 옮길 괄호·쉼표는 먼저 떼어 두었다가 다시 붙임
  const parts = results.map((x) => trimLatex(x?.latex || ''));
  const latex = parts.map((p) => normalizeLatex(p.latex));
  const blocks = assembleBlocks(plan, (i) => (latex[i] ? `${parts[i].before}${latex[i]}${parts[i].after}` : ''));
  const reasons = judgeScan(plan, results, latex);
  return { blocks, reliable: !reasons.length, reasons, formulas: plan.formulas.length };
}
