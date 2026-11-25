'use strict';

// Single-class visual number detector. No numbering/sequence assumptions here.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MODEL_DIR_NAME = 'ohdap-pnd-1';
const MODEL_FILES = [
  { name: 'model.onnx', size: 10826781, sha256: '62e470db870f7a1c59ed779c0d2d77ecf66306c1d7c3fd969b544ce1df433419' },
];
const SIZE = 1024;

function modelStatus(dir) {
  let bytes = 0;
  let installed = true;
  for (const file of MODEL_FILES) {
    try {
      const st = fs.statSync(path.join(dir, file.name));
      bytes += st.size;
      if (!st.isFile() || st.size !== file.size) installed = false;
    } catch { installed = false; }
  }
  return { installed, dir, bytes };
}

// Python round(): ties go to the even integer, including odd padding widths.
function roundEven(x) {
  const lo = Math.floor(x);
  return (x - lo === 0.5 ? lo + (lo % 2 !== 0 ? 1 : 0) : Math.round(x)) || 0;
}

function letterbox(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Invalid image dimensions');
  const r = Math.min(SIZE / width, SIZE / height);
  const nw = roundEven(width * r), nh = roundEven(height * r);
  return { width, height, r, nw, nh, left: roundEven((SIZE - nw) / 2 - 0.1), top: roundEven((SIZE - nh) / 2 - 0.1) };
}

/** RGBA -> RGB bilinear letterbox -> float32 NCHW /255. Alpha is not a model input. */
function preprocess({ data, width, height }) {
  const geometry = letterbox(width, height);
  if (!data || data.length !== width * height * 4) throw new Error('Invalid RGBA length');
  const { nw, nh, left, top } = geometry;
  const plane = SIZE * SIZE;
  const pixels = new Float32Array(3 * plane).fill(114 / 255);
  for (let y = 0; y < nh; y++) {
    const sy = Math.max(0, Math.min(height - 1, (y + 0.5) * height / nh - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < nw; x++) {
      const sx = Math.max(0, Math.min(width - 1, (x + 0.5) * width / nw - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(width - 1, x0 + 1), fx = sx - x0;
      const dest = (y + top) * SIZE + x + left;
      for (let c = 0; c < 3; c++) {
        const a = data[(y0 * width + x0) * 4 + c] * (1 - fx) + data[(y0 * width + x1) * 4 + c] * fx;
        const b = data[(y1 * width + x0) * 4 + c] * (1 - fx) + data[(y1 * width + x1) * 4 + c] * fx;
        const rgb = nw === width && nh === height ? a : Math.round(a * (1 - fy) + b * fy);
        pixels[c * plane + dest] = rgb / 255;
      }
    }
  }
  return { pixels, geometry };
}

function iou(a, b) {
  const intersection = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const area = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - intersection;
  return area > 0 ? intersection / area : 0;
}

/** Decode [1,5,N], stable score order, clipped boxes, greedy IoU > .7 NMS. */
function decode({ data, dims }, geometry, { conf = 0.25, nms = 0.7, max = 300 } = {}) {
  if (dims?.length !== 3 || dims[0] !== 1 || dims[1] !== 5 || data.length !== 5 * dims[2]) throw new Error('Invalid detector output');
  const n = dims[2], { width, height, r, left, top } = geometry;
  const order = Array.from({ length: n }, (_, i) => i).filter(i => Number.isFinite(data[4 * n + i]));
  order.sort((a, b) => data[4 * n + b] - data[4 * n + a] || a - b);
  const kept = [];
  for (const i of order) {
    const score = data[4 * n + i];
    if (score < conf || kept.length >= max) break;
    const cx = data[i], cy = data[n + i], bw = data[2 * n + i], bh = data[3 * n + i];
    if (![cx, cy, bw, bh].every(Number.isFinite)) continue;
    const box = {
      x0: Math.max(0, Math.min(width, (cx - bw / 2 - left) / r)),
      y0: Math.max(0, Math.min(height, (cy - bh / 2 - top) / r)),
      x1: Math.max(0, Math.min(width, (cx + bw / 2 - left) / r)),
      y1: Math.max(0, Math.min(height, (cy + bh / 2 - top) / r)), score,
    };
    if (box.x1 <= box.x0 || box.y1 <= box.y0 || kept.some(b => iou(b, box) > nms)) continue;
    kept.push(box);
  }
  return kept.map(b => ({ x0: b.x0 / width, y0: b.y0 / height, x1: b.x1 / width, y1: b.y1 / height, score: b.score }));
}

function createNumberDetector({ modelDir, threads } = {}) {
  if (!modelDir) throw new Error('Missing model directory');
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const intraOpNumThreads = Number.isInteger(threads) && threads > 0 ? threads : Math.min(8, Math.max(1, Math.round(cores / 2)));
  let loading = null, queue = Promise.resolve(), closed = false;
  const load = () => {
    if (!loading) {
      loading = (async () => {
        if (!modelStatus(modelDir).installed) throw new Error('Number model is not installed');
        const ort = require('onnxruntime-node');
        const session = await ort.InferenceSession.create(path.join(modelDir, MODEL_FILES[0].name), {
          executionProviders: ['cpu'], intraOpNumThreads, interOpNumThreads: 1, graphOptimizationLevel: 'all',
        });
        return { ort, session };
      })();
      loading.catch(() => { loading = null; });
    }
    return loading;
  };
  return {
    detect(image) {
      const run = queue.then(async () => {
        if (closed) throw new Error('Number detector is closed');
        const { pixels, geometry } = preprocess(image);
        const { ort, session } = await load();
        const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', pixels, [1, 3, SIZE, SIZE]) });
        return decode(outputs[session.outputNames[0]], geometry);
      });
      queue = run.catch(() => {});
      return run;
    },
    async close() {
      closed = true;
      await queue;
      const model = loading ? await loading.catch(() => null) : null;
      loading = null;
      if (model) await model.session.release();
    },
  };
}

module.exports = { MODEL_DIR_NAME, MODEL_FILES, modelStatus, createNumberDetector, roundEven, letterbox, preprocess, decode };
