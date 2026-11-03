import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { INPUT_IDLE_MS, UNFOCUSED_IDLE_MS, shouldRestartForUpdate } = require('../../src/main/restart-idle.js');

const ready = (overrides = {}) => shouldRestartForUpdate({
  updateAvailable: true,
  pendingSaves: false,
  busy: false,
  windowUnfocused: true,
  unfocusedForMs: UNFOCUSED_IDLE_MS,
  inactiveForMs: 0,
  ...overrides,
});

test('업데이트 재시작: 창을 오래 떠났으면 재시작', () => {
  assert.equal(ready(), true);
});

test('업데이트 재시작: 입력이 오래 없으면 창이 focused 여도 재시작', () => {
  assert.equal(ready({ windowUnfocused: false, unfocusedForMs: 0, inactiveForMs: INPUT_IDLE_MS }), true);
});

test('업데이트 재시작: 저장·작업 중에는 재시작하지 않음', () => {
  assert.equal(ready({ pendingSaves: true }), false);
  assert.equal(ready({ busy: true }), false);
});

test('업데이트 재시작: 아직 활동 중이면 재시작하지 않음', () => {
  assert.equal(ready({ windowUnfocused: false, unfocusedForMs: 0, inactiveForMs: INPUT_IDLE_MS - 1 }), false);
  assert.equal(ready({ unfocusedForMs: UNFOCUSED_IDLE_MS - 1 }), false);
});

test('업데이트 재시작: 상태를 아직 받지 못했거나 업데이트가 없으면 보류', () => {
  assert.equal(shouldRestartForUpdate(), false);
  assert.equal(ready({ updateAvailable: false }), false);
  assert.equal(ready({ pendingSaves: undefined }), false);
  assert.equal(ready({ busy: undefined }), false);
});

test('업데이트 재시작: 수동 요청은 유휴 시간만 생략', () => {
  assert.equal(ready({ manual: true, windowUnfocused: false, inactiveForMs: 0 }), true);
  assert.equal(ready({ manual: true, pendingSaves: true }), false);
  assert.equal(ready({ manual: true, busy: true }), false);
});
