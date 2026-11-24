import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import cloud from '../../src/main/magoedu-cloud.js';
import { blocked, guard, message } from '../../src/main/view-only.js';
import { harness } from '../lib/view-only-harness.mjs';
const expectedBlocked = [
  'books:create', 'books:save', 'books:saveSync', 'books:delete', 'books:copy', 'books:setShared', 'books:renameItems',
  'files:import', 'files:photo', 'files:commit', 'files:discard',
  'answers:save', 'answers:saveSync', 'answers:putImage',
  'notes:create', 'notes:save', 'notes:saveSync', 'notes:delete',
  'students:save', 'students:delete', 'students:restore',
];
const bookId = 'book-12345678', noteId = 'note-12345678', sid = 'student-12345678';
function fixture(h) {
  h.write(`books/${bookId}/book.json`, { id: bookId, name: 'Book', docs: { problem: { items: [{ id: 'q2', number: '2', page: 1 }], files: [] }, answer: null } });
  h.write(`books/${bookId}/renames.json`, { last: 1, log: [{ n: 1, renames: { q1: 'q2' } }] });
  h.write(`students/${sid}/notes/${noteId}.json`, { id: noteId, title: 'Note', bookIds: [bookId], selected: { [bookId]: ['q1'] } });
  h.write('members/teacher/profile.json', { name: 'Old' });
  h.write(`members/teacher/notes/private-12345678.json`, { id: 'private-12345678', bookIds: [] });
  h.write('members/other/profile.json', { name: 'Other' });
  h.write('members/other/books/other-book-1234/book.json', { id: 'other-book-1234', name: 'Private', docs: {} });
  h.write('members/other/notes/other-note-1234.json', { id: 'other-note-1234', bookIds: [] });
}
test('view-only: real main IPC reads and all writes leave academy/sync hashes unchanged', async () => {
  assert.deepEqual([...blocked], expectedBlocked);
  const h = harness(); fixture(h);
  h.session.user.role = 'operator';
  const legacy = path.join(h.session.localDir, 'legacy', 'books', bookId);
  fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, 'book.json'), JSON.stringify({ id: bookId, name: 'Legacy' }));
  const before = h.hash();
  assert.equal(h.call('app:info').viewOnly, true);
  for (const ch of ['books:list', 'notes:list', 'students:list', 'students:members', 'settings:get']) await h.call(ch);
  assert.equal((await h.call('books:get', bookId)).$canEdit, false);
  assert.ok((await h.call('notes:list')).some(n => n.id === 'other-note-1234'));
  assert.equal((await h.call('books:get', 'other-book-1234')).$canEdit, false);
  assert.equal((await h.call('notes:get', 'other-note-1234')).$readonly, true);
  const n = await h.call('notes:get', noteId); assert.equal(n.$readonly, true); assert.deepEqual(Array.from(n.selected[bookId]), ['q2']);
  await h.call('notes:get', 'private-12345678');
  await h.call('books:ensureFiles', bookId); await h.call('answers:get', bookId); await h.call('books:getTranscripts', bookId);
  for (const ch of expectedBlocked) {
    if (ch.endsWith('Sync')) { const event = {}; h.listeners.get(ch)(event, {}); assert.equal(event.returnValue.error, message, ch); }
    else await assert.rejects(async () => h.call(ch, {}), /보기 전용이라 고칠 수 없어요/, ch);
  }
  await h.call('books:saveTranscripts', { bookId, data: { items: { x: {} } } });
  await h.autos.saveProfile(); await h.autos.importLegacy(); await h.autos.removeRemoteOnly(bookId, ['absent.pdf']);
  assert.deepEqual(h.hash(), before);
  assert.ok(fs.existsSync(path.join(h.session.localDir, 'legacy', 'books', bookId, 'book.json')));
});
test('normal mode: real main create/save and rename catchup still persist', async () => {
  const h = harness(false); fixture(h);
  const b = await h.call('books:create', { name: 'New' }); assert.ok(fs.existsSync(path.join(h.session.academyDir, 'books', b.id, 'book.json')));
  const before = h.hash(); await h.call('notes:get', noteId); await h.autos.saveProfile(); assert.notDeepEqual(h.hash(), before);
  for (const ch of blocked) assert.equal(guard(false, ch, () => 7)(), 7);
});
test('SDK: signed view only, academy mismatch, app cannot enable via env, development flag', () => {
  const h = harness(); const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trust = path.join(h.root, 'trust.json'); fs.writeFileSync(trust, JSON.stringify({ keys: [{ kid: 'test', x: publicKey.export({ format: 'jwk' }).x }] }));
  const token = (typ, aca = 'aca') => { const p = Buffer.from(JSON.stringify({ kid: 'test', typ, aca, app: 'ohdapnote', sub: 'teacher', exp: Date.now()/1000+600 })).toString('base64url'); return `MGT1.${p}.${sign(null, Buffer.from(`MGT1.${p}`), privateKey).toString('base64url')}`; };
  const env = { MAGOEDU_TRUST_FILE: trust, MAGOEDU_DATA_DIR: h.session.dataDir, MAGOEDU_LOCAL_DIR: h.session.localDir, MAGOEDU_ACADEMY_ID: 'aca', MAGOEDU_VIEW_ONLY: '1' };
  const check = (ticket) => cloud.check('ohdapnote', { packaged: false, env: { ...env, MAGOEDU_TICKET: ticket } });
  assert.equal(check(token('view')).viewOnly, true); assert.equal(check(token('view', 'other')), null); assert.equal(check(token('app')).viewOnly, false); assert.equal(check(token('ro')), null);
  assert.equal(cloud.check('ohdapnote', { packaged: false, env: { ...env, MAGOEDU_DEV: '1' } }).viewOnly, true);
  assert.equal(cloud.academyAi({ viewOnly: true, ticket: 'not-to-send' }, { ai: { provider: 'gemini', relay: true } }), null);
});

test('view-only exports write only selected external path; blank signing key supports temporary settings', async () => {
  const h = harness(); fixture(h);
  assert.equal((await h.call('settings:set', { teacher: 'Temporary' })).teacher, 'Temporary');
  const before = h.hash();
  for (const ch of ['files:savePdf', 'files:saveFile']) {
    const dest = path.join(h.root, ch.endsWith('Pdf') ? 'out.pdf' : 'out.hwpx');
    h.dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest });
    await h.call(ch, { data: [1, 2, 3] }); assert.deepEqual([...fs.readFileSync(dest)], [1, 2, 3]);
    h.dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(h.session.academyDir, 'books', bookId, 'book.json') });
    await assert.rejects(h.call(ch, { data: [9] }), /학원 자료 폴더 밖/);
    h.dialog.showSaveDialog = async () => ({ canceled: true }); assert.equal((await h.call(ch, { data: [9] })).canceled, true);
  }
  assert.deepEqual(h.hash(), before);
});
