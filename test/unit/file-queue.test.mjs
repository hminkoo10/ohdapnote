import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFileQueue } from '../../src/main/file-queue.js';

test('열린 읽기 핸들을 닫은 뒤 같은 파일을 교체하고 다른 파일은 계속 저장', async () => {
  const queue = createFileQueue();
  let release, open = false, renamed = false;
  const read = queue('fake.json', async () => { open = true; await new Promise((r) => { release = r; }); open = false; });
  await Promise.resolve();
  const write = queue('FAKE.json', () => { assert.equal(open, false); renamed = true; });
  await queue('other.json', () => assert.equal(renamed, false));
  release();
  await Promise.all([read, write]);
  assert.equal(renamed, true);
});

test('실패한 저장이 다음 읽기와 저장을 막지 않음', async () => {
  const queue = createFileQueue();
  await assert.rejects(queue('fake.json', () => { throw Error('잠김'); }));
  assert.equal(await queue('fake.json', () => 42), 42);
});
