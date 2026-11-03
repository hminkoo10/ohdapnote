// 설정 파일 서명(src/main/datasign.js): 마고 타종과 같은 서명 값, 손으로 고친 settings.json 거부·되돌리기,
// 서명을 쓰기 전 파일은 한 번 받아들임, 키가 없으면 예전처럼
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { signText, signJson, verify, signedJsonFile, SIG_ZERO } = require('../../src/main/datasign.js');

const KEY = 'k3y-Xq9_base64url-like-0123456789abcdefghijklm';

test('서명 값: 타종(Python·Kotlin)과 같은 고정 벡터', () => {
  const text = `{"app":"tajong","sig":"${SIG_ZERO}","v":1}`;
  const signed = signText(text, 'test-key');
  assert.equal(signed, '{"app":"tajong","sig":"04ea5198af2926906353ebd72e8967c86760cb18b8bebba19f1f7998ead70484","v":1}');
  assert.equal(verify(Buffer.from(signed, 'utf8'), 'test-key'), true);
  assert.equal(verify(Buffer.from(signed, 'utf8'), 'other-key'), false);
});

test('확인: 파일 바이트 그대로 (공백·BOM 을 정리하지 않음), 서명 자리는 꼭 하나', () => {
  const signed = signJson({ a: 1, name: '김선생' }, KEY);
  assert.equal(verify(Buffer.from(signed), KEY), true);
  assert.equal(verify(Buffer.from(`${signed}\n`), KEY), false); // 끝에 줄바꿈만 더해도
  assert.equal(verify(Buffer.from(`﻿${signed}`), KEY), false);
  assert.equal(verify(Buffer.from(signed.replace('"a":1', '"a":2')), KEY), false);
  // 다른 프로그램이 "sig" : "…" 처럼 공백을 넣어 써도 그 글자 그대로 확인
  const spaced = signText(`{ "v": 1, "sig" : "${SIG_ZERO}" }`, KEY);
  assert.equal(verify(Buffer.from(spaced), KEY), true);
  const sig = /"sig":"([0-9a-f]{64})"/.exec(signed)[1];
  assert.equal(verify(Buffer.from(signed.replace('{', `{"x":{"sig":"${sig}"},`)), KEY), false); // 서명 자리가 둘
  assert.equal(verify(Buffer.from('{"a":1}'), KEY), false);
  assert.equal(verify(Buffer.from(signed.replace(sig, sig.toUpperCase())), KEY), false); // 소문자 16진수만
});

/** 동기화 폴더(sync) + 이 컴퓨터 폴더(local) */
function setup(key = KEY) {
  const dir = mkdtempSync(join(tmpdir(), 'ohdap-sign-'));
  const file = join(dir, 'sync', 'settings.json');
  const stateFile = join(dir, 'local', 'settings.verified.json');
  const rejected = [];
  const quiet = { info() {}, warn() {}, error() {} };
  const open = () => signedJsonFile({ file, stateFile, key, log: quiet, onRejected: () => rejected.push(Date.now()) });
  const raw = () => readFileSync(file, 'utf8');
  const put = (text) => {
    mkdirSync(join(dir, 'sync'), { recursive: true });
    writeFileSync(file, text, 'utf8');
  };
  return { dir, file, stateFile, rejected, open, raw, put, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('서명 켬: 앱이 쓴 파일은 서명, 손으로 고친 파일은 적용하지 않고 되돌림 (켜 둔 채 / 다시 켤 때)', () => {
  const t = setup();
  try {
    const store = t.open();
    store.write({ geminiApiKey: 'my-key', motion: 'full' });
    assert.equal(verify(readFileSync(t.file), KEY), true);
    assert.ok(existsSync(t.stateFile));
    assert.ok(!t.raw().includes(KEY) && !readFileSync(t.stateFile, 'utf8').includes(KEY)); // 키는 파일에 남기지 않음
    const good = t.raw();
    assert.deepEqual(store.read(), { geminiApiKey: 'my-key', motion: 'full' });

    // 켜 둔 채 손으로 고침 (서명은 예전 그대로) → 적용하지 않고 되돌림
    t.put(good.replace('"full"', '"reduce"'));
    assert.deepEqual(store.read(), { geminiApiKey: 'my-key', motion: 'full' });
    assert.equal(t.rejected.length, 1);
    assert.equal(t.raw(), good);
    // 서명을 지우고 고침 → 마찬가지
    t.put(JSON.stringify({ geminiApiKey: 'stolen', motion: 'full' }));
    assert.equal(store.read().geminiApiKey, 'my-key');
    assert.equal(t.rejected.length, 2);
    assert.equal(t.raw(), good);

    // 꺼져 있는 동안 고치고 다시 켬 → 이 컴퓨터에 남긴 마지막 설정으로 되돌림
    t.put(JSON.stringify({ geminiApiKey: 'stolen' }));
    const again = t.open();
    assert.deepEqual(again.read(), { geminiApiKey: 'my-key', motion: 'full' });
    assert.equal(t.rejected.length, 3);
    assert.equal(t.raw(), good);
    assert.equal(again.read().geminiApiKey, 'my-key');
    assert.equal(t.rejected.length, 3); // 되돌린 뒤에는 알리지 않음
  } finally {
    t.done();
  }
});

test('서명 켬: 다른 컴퓨터가 서명해 쓴 파일(동기화)은 적용', () => {
  const t = setup();
  try {
    const store = t.open();
    store.write({ motion: 'full' });
    t.put(signJson({ motion: 'reduce', teacher: '박선생' }, KEY));
    assert.deepEqual(store.read(), { motion: 'reduce', teacher: '박선생' });
    assert.equal(t.rejected.length, 0);
    // 그 뒤 손으로 고치면 방금 받은 설정으로 되돌림
    t.put(JSON.stringify({ motion: 'full' }));
    assert.deepEqual(store.read(), { motion: 'reduce', teacher: '박선생' });
    assert.deepEqual(t.open().read(), { motion: 'reduce', teacher: '박선생' });
  } finally {
    t.done();
  }
});

test('서명 켬: 예전 버전이 쓴 서명 없는 파일은 이 컴퓨터에서 한 번만 받아들이고 서명해 둠', () => {
  const t = setup();
  try {
    t.put(JSON.stringify({ geminiApiKey: 'old-key', academy: '한빛' }));
    const store = t.open();
    assert.deepEqual(store.read(), { geminiApiKey: 'old-key', academy: '한빛' });
    assert.equal(t.rejected.length, 0);
    assert.equal(verify(readFileSync(t.file), KEY), true); // 받아들이면서 서명해 씀
    assert.ok(existsSync(t.stateFile));
    // 그 뒤로는 서명 없는 파일을 받지 않음 (다시 켜도)
    t.put(JSON.stringify({ geminiApiKey: 'other', academy: '한빛' }));
    assert.equal(t.open().read().geminiApiKey, 'old-key');
    assert.equal(t.rejected.length, 1);
    assert.equal(JSON.parse(t.raw()).geminiApiKey, 'old-key');
  } finally {
    t.done();
  }
});

test('서명 켬: 처음 켜는 컴퓨터에서 서명이 틀린 파일은 덮어쓰지 않고 기본값', () => {
  const t = setup();
  try {
    const signed = signJson({ geminiApiKey: 'a' }, 'another-server-key');
    t.put(signed);
    const store = t.open();
    assert.deepEqual(store.read(), {});
    assert.equal(t.rejected.length, 1);
    assert.equal(t.raw(), signed); // 서버의 파일 그대로
    assert.ok(!existsSync(t.stateFile));
    // 깨진 JSON 도 마찬가지
    t.put('{"geminiApiKey": ');
    assert.deepEqual(store.read(), {});
    assert.equal(t.raw(), '{"geminiApiKey": ');
    // 파일이 없으면 기본값 (예전과 같음)
    rmSync(t.file);
    assert.deepEqual(store.read(), {});
  } finally {
    t.done();
  }
});

test('서명 끔(키 없음 = 예전 통합 클라우드): 예전처럼 서명 없이 쓰고, 고친 파일도 그대로 읽음', () => {
  const t = setup('');
  try {
    const store = t.open();
    store.write({ motion: 'full', teacher: '김선생' });
    assert.equal(t.raw(), JSON.stringify({ motion: 'full', teacher: '김선생' }));
    assert.ok(!existsSync(t.stateFile));
    t.put(JSON.stringify({ motion: 'reduce' }));
    assert.deepEqual(store.read(), { motion: 'reduce' });
    t.put('not json');
    assert.deepEqual(store.read(), {});
    // 서명 켠 컴퓨터가 쓴 파일도 읽음 (sig 는 설정으로 쓰지 않음)
    t.put(signJson({ motion: 'reduce' }, KEY));
    assert.deepEqual(store.read(), { motion: 'reduce' });
    assert.equal(t.rejected.length, 0);
  } finally {
    t.done();
  }
});
