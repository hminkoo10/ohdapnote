// 통합 클라우드 없이 켰을 때(src/main/magoedu-cloud.js shouldHandOff): 통합 클라우드가 있으면 안내 없이 넘김
// (통합 클라우드를 실제로 열지는 않음 — 판단만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
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

test('verifyTicket: JSON payload가 null/배열이어도 예외 없이 거부', () => {
  const key = { kid: 'test', x: 'A'.repeat(43) };
  for (const payload of ['null', '[]']) {
    const token = `MGT1.${Buffer.from(payload).toString('base64url')}.bad`;
    assert.doesNotThrow(() => cloud.verifyTicket(token, [key], { appId: 'ohdapnote' }));
    assert.equal(cloud.verifyTicket(token, [key], { appId: 'ohdapnote' }), null);
  }
  assert.doesNotThrow(() => cloud.verifyTicket('MGT1.bad.bad', null));
});

test('verifyTicket: 서명이 맞아도 무한 만료시각은 거부, 정상 허가증은 보존', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys = [{ kid: 'test', x: publicKey.export({ format: 'jwk' }).x }];
  const ticket = (json) => {
    const data = Buffer.from(json).toString('base64url');
    return `MGT1.${data}.${sign(null, Buffer.from(`MGT1.${data}`), privateKey).toString('base64url')}`;
  };
  const valid = { kid: 'test', app: 'ohdapnote', exp: Math.floor(Date.now() / 1000) + 60 };
  assert.deepEqual(cloud.verifyTicket(ticket(JSON.stringify(valid)), keys, { appId: 'ohdapnote' }), valid);
  assert.equal(cloud.verifyTicket(ticket('{"kid":"test","app":"ohdapnote","exp":1e400}'), keys, { appId: 'ohdapnote' }), null);
});

test('check: 통합 클라우드 없이 켜면 null (이때 shouldHandOff 로 넘길지 정함)', () => {
  assert.equal(cloud.check('ohdapnote', { packaged: true, env: {} }), null);
  assert.match(cloud.reason(), /통합 클라우드에서만/);
});
