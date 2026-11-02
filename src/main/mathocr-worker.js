'use strict';

// 수식 인식 일꾼 — Electron utilityProcess 로 띄움 (main.js). onnxruntime 의 계산은 JS 스레드를 붙잡으므로
// 메인 프로세스 대신 여기서 돌려 창·IPC 가 멈추지 않게 합니다. 엔진(세션)은 처음 요청 때 만들어 계속 씁니다.
// 메인 → 일꾼: {type:'recognize', id, modelDir, images, maxTokens} · {type:'abort', id}
// 일꾼 → 메인: {type:'done', id, ok, results?, error?, aborted?}

const { createMathOcr } = require('./mathocr');

const port = process.parentPort;
let ocr = null;
const running = new Map(); // 요청 id → AbortController

port.on('message', async ({ data: msg }) => {
  if (msg?.type === 'abort') {
    running.get(msg.id)?.abort();
    return;
  }
  if (msg?.type !== 'recognize') return;
  const ctrl = new AbortController();
  running.set(msg.id, ctrl);
  try {
    if (!ocr) ocr = createMathOcr({ modelDir: msg.modelDir });
    const results = await ocr.recognize(msg.images || [], { signal: ctrl.signal, maxTokens: msg.maxTokens });
    port.postMessage({ type: 'done', id: msg.id, ok: true, results });
  } catch (err) {
    port.postMessage({ type: 'done', id: msg.id, ok: false, aborted: err?.name === 'AbortError', error: String(err?.message || err) });
  } finally {
    running.delete(msg.id);
  }
});
