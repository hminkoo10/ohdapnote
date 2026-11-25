import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { roundEven, letterbox, preprocess, decode, modelStatus, MODEL_FILES, MODEL_DIR_NAME, createNumberDetector } = require('../../src/main/numberdet.js');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const tensor = rows => ({ dims: [1, 5, rows.length], data: Float32Array.from(Array.from({ length: 5 }, (_, k) => rows.map(r => r[k])).flat()) });

test('letterbox: Python half-even sizes and biased symmetric padding', () => {
  assert.deepEqual([-2.5, -1.5, 0.5, 1.5, 2.5, 3.5].map(roundEven), [-2, -2, 0, 2, 2, 4]);
  assert.deepEqual(letterbox(512, 1024), { width: 512, height: 1024, r: 1, nw: 512, nh: 1024, left: 256, top: 0 });
  assert.deepEqual(letterbox(2048, 1025), { width: 2048, height: 1025, r: 0.5, nw: 1024, nh: 512, left: 0, top: 256 });
  assert.equal(letterbox(2048, 1027).nh, 514);
  assert.equal(letterbox(1023, 1024).left, 0);
  assert.equal(letterbox(1021, 1024).left, 1);
  assert.equal(letterbox(1024, 1021).top, 1);
  assert.throws(() => letterbox(0, 1));
  assert.throws(() => letterbox(1.5, 1));
});

test('preprocess: RGB NCHW, /255, padding and bilinear resize', () => {
  const data = new Uint8Array(1024 * 4);
  for (let x = 0; x < 1024; x++) data.set([255, 128, 0, 255], 4 * x);
  const { pixels, geometry } = preprocess({ data, width: 1024, height: 1 });
  assert.equal(geometry.top, 511);
  const plane = 1024 * 1024, i = 511 * 1024;
  near(pixels[0], 114 / 255); near(pixels[i], 1);
  near(pixels[plane + i], 128 / 255); near(pixels[2 * plane + i], 0);
  near(pixels[512 * 1024], 114 / 255);
  const resized = preprocess({ data: Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255]), width: 2, height: 1 });
  near(resized.pixels[256 * 1024], 0);
  near(resized.pixels[256 * 1024 + 511], 127 / 255);
  near(resized.pixels[256 * 1024 + 512], 128 / 255);
  near(resized.pixels[256 * 1024 + 1023], 1);
  assert.throws(() => preprocess({ data: [], width: 1, height: 1 }));
});

test('decode: confidence, stable score order, clipping, empty boxes, NMS and fractions', () => {
  const output = tensor([
    [356, 100, 100, 40, 0.9], [357, 100, 100, 40, 0.8],
    [600, 400, 40, 60, 0.9], [256, 0, 40, 40, 0.25],
    [20, 100, 10, 20, 0.99], [400, 200, 0, 20, 0.99],
    [400, 200, 10, 20, 0.24], [NaN, 100, 10, 20, 0.99],
  ]);
  const boxes = decode(output, letterbox(512, 1024));
  assert.equal(boxes.length, 3);
  near(boxes[0].x0, 50 / 512); near(boxes[0].x1, 150 / 512);
  near(boxes[0].y0, 80 / 1024); near(boxes[0].y1, 120 / 1024);
  near(boxes[1].x0, 324 / 512);
  assert.equal(boxes[2].x0, 0); assert.equal(boxes[2].y0, 0);
  assert.equal(decode(output, letterbox(512, 1024), { nms: 1 }).length, 4);
  const scaled = decode(tensor([[512, 512, 512, 256, 1]]), letterbox(2048, 1024));
  assert.deepEqual(scaled, [{ x0: 0.25, x1: 0.75, y0: 0.25, y1: 0.75, score: 1 }]);
  const many = tensor(Array.from({ length: 350 }, (_, i) => [10 + i * 2, 500, 1, 1, 1]));
  assert.equal(decode(many, letterbox(1024, 1024)).length, 300);
  assert.throws(() => decode({ data: [], dims: [1, 6, 1] }, letterbox(1, 1)));
});

test('model metadata and absent model status need no native runtime', () => {
  assert.equal(MODEL_DIR_NAME, 'ohdap-pnd-1');
  assert.equal(MODEL_FILES[0].size, 10826781);
  assert.equal(MODEL_FILES[0].sha256, '62e470db870f7a1c59ed779c0d2d77ecf66306c1d7c3fd969b544ce1df433419');
  assert.equal(modelStatus(join(tmpdir(), 'absent-number-model')).installed, false);
  assert.throws(() => createNumberDetector());
});

test('session: CPU options, actual input name, serialized requests, recovery and release', async () => {
  const actualRequire = require;
  let options, active = 0, released = 0, runs = 0;
  const session = { inputNames: ['actual_input'], outputNames: ['actual_output'],
    async run(feeds) {
      assert.equal(++active, 1);
      assert.deepEqual(Object.keys(feeds), ['actual_input']);
      assert.deepEqual(feeds.actual_input.dims, [1, 3, 1024, 1024]);
      await new Promise(setImmediate);
      active--; runs++;
      return { actual_output: tensor([[512, 512, 10, 10, 0.9]]) };
    }, async release() { released++; } };
  const fakeRequire = name => {
    if (name === 'node:fs') return { statSync: () => ({ size: 10826781, isFile: () => true }) };
    if (name === 'onnxruntime-node') return { Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } },
      InferenceSession: { async create(file, opts) { options = opts; return session; } } };
    return actualRequire(name);
  };
  const module = { exports: {} };
  new Function('require', 'module', readFileSync(new URL('../../src/main/numberdet.js', import.meta.url), 'utf8'))(fakeRequire, module);
  const detector = module.exports.createNumberDetector({ modelDir: 'synthetic', threads: 2 });
  const image = { data: new Uint8Array(1024 * 4), width: 1024, height: 1 };
  await assert.rejects(detector.detect({ ...image, data: [] }), /RGBA/);
  const result = await Promise.all([detector.detect(image), detector.detect(image)]);
  assert.equal(runs, 2); assert.equal(result.length, 2);
  assert.deepEqual(options, { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1, graphOptimizationLevel: 'all' });
  await detector.close(); assert.equal(released, 1);
  await assert.rejects(detector.detect(image), /closed/);
});

test('real number model: serialized blank-page inference and close', { skip: !process.env.OHDAP_PND_DIR }, async () => {
  const detector = createNumberDetector({ modelDir: process.env.OHDAP_PND_DIR, threads: 2 });
  const image = { data: new Uint8Array(724 * 1024 * 4).fill(255), width: 724, height: 1024 };
  try {
    const results = await Promise.all([detector.detect(image), detector.detect(image)]);
    assert.deepEqual(results, [[], []]);
  } finally { await detector.close(); }
  await assert.rejects(detector.detect(image), /closed/);
});
