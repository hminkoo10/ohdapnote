// 통합 클라우드 없이 켰을 때(src/main/magoedu-cloud.js shouldHandOff): 통합 클라우드가 있으면 안내 없이 넘김
// (통합 클라우드를 실제로 열지는 않음 — 판단만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cloud = require('../../src/main/magoedu-cloud.js');

test('shouldHandOff: 통합 클라우드가 설치되어 있고 통합 클라우드가 켠 게 아니면 넘김', () => {
  assert.equal(cloud.shouldHandOff({ installed: true, env: {} }), true);
  // 바로 가기·exe 로 켬 + 통합 클라우드 없음 → 안내
  assert.equal(cloud.shouldHandOff({ installed: false, env: {} }), false);
  // 통합 클라우드가 켰는데 허가증 확인이 안 됨 → 다시 넘기면 서로 계속 켜니 안내
  assert.equal(cloud.shouldHandOff({ installed: true, env: { MAGOEDU_TICKET: 'MGT1.bad.sig' } }), false);
  assert.equal(cloud.shouldHandOff({ installed: true, env: { MAGOEDU_TICKET: '' } }), true);
});

test('check: 통합 클라우드 없이 켜면 null (이때 shouldHandOff 로 넘길지 정함)', () => {
  assert.equal(cloud.check('ohdapnote', { packaged: true, env: {} }), null);
  assert.match(cloud.reason(), /통합 클라우드에서만/);
});
