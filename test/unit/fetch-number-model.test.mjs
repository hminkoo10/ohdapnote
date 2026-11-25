import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fetchVerifiedFile, pruneModelFolders } from '../../scripts/fetch-model.mjs';
const MODEL_DIR_NAME = 'ohdap-pnd-1';

test('bundling: stubbed fetch verifies size/hash, skips correct cache, preserves both model folders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'number-fetch-'));
  const bytes = Buffer.from('synthetic model payload');
  const spec = { name: 'model.onnx', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  let calls = 0;
  const run = (body = bytes) => fetchVerifiedFile({ dir: join(dir, MODEL_DIR_NAME), spec, url: 'https://invalid.test/model', fetch: async () => { calls++; return new Response(body); } });
  try {
    await run(); await run(); assert.equal(calls, 1);
    assert.deepEqual(readFileSync(join(dir, MODEL_DIR_NAME, spec.name)), bytes);
    writeFileSync(join(dir, MODEL_DIR_NAME, spec.name), Buffer.alloc(bytes.length));
    await assert.rejects(run(Buffer.alloc(bytes.length)), /sha256/);
    await assert.rejects(run(bytes.subarray(1)), /size/);
    await assert.rejects(run(Buffer.concat([bytes, bytes])), /size/);
    await assert.rejects(fetchVerifiedFile({ dir, spec, url: '', fetch: async () => new Response('', { status: 404 }) }), /HTTP 404/);
    assert.equal(readdirSync(join(dir, MODEL_DIR_NAME)).includes('model.onnx.part'), false);
    await run();
    mkdirSync(join(dir, 'ohdap-mfr-1')); mkdirSync(join(dir, 'obsolete'));
    writeFileSync(join(dir, 'ohdap-mfr-1', 'keep'), 'keep');
    pruneModelFolders(dir);
    assert.deepEqual(readdirSync(dir).sort(), ['ohdap-mfr-1', 'ohdap-pnd-1']);
    assert.equal(readFileSync(join(dir, 'ohdap-mfr-1', 'keep'), 'utf8'), 'keep');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
