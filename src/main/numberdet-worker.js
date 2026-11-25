'use strict';

const { createNumberDetector } = require('./numberdet');
let detector = null;
process.parentPort.on('message', async ({ data: msg }) => {
  if (msg?.type !== 'detect') return;
  try {
    if (!detector) detector = createNumberDetector({ modelDir: msg.modelDir, threads: process.env.OHDAP_E2E === '1' ? 2 : undefined });
    const boxes = await detector.detect(msg.image);
    process.parentPort.postMessage({ type: 'done', id: msg.id, ok: true, boxes });
  } catch (err) {
    process.parentPort.postMessage({ type: 'done', id: msg.id, ok: false, error: String(err?.message || err) });
  }
});
