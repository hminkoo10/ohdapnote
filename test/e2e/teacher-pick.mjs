// 실행: node --test test/e2e/teacher-pick.mjs (외부 설치본은 NODE_PATH로 읽어요)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from '../lib/playwright.mjs';
import { fakeCloud } from '../lib/fake-cloud.mjs';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(OUT, 'teacher-pick-'));
const academy = join(tmp, 'academy');
const members = [
  { id: 'teacher-a', name: '김선생', role: 'teacher' },
  { id: 'teacher-b', name: '박선생', role: 'teacher' },
  { id: 'boss', name: '원장님', role: 'director' },
];
const cloud = fakeCloud({ dir: join(tmp, 'cloud'), academyDir: academy, members });
const student = cloud.add({ id: 'student-001', name: '김하늘', teacherId: 'teacher-b' });
const unassigned = cloud.add({ id: 'student-002', name: '이바다' });
const teacherInput = '.exam-field input[data-key="teacher"]';
const teacherSelect = '.exam-field select[aria-label="선생님"]';
let app, win;
const errors = [];

function seed(id, sid = student.id, extra = {}) {
  const dir = join(academy, 'students', sid, 'notes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    id, kind: 'note', version: 2, title: id, student: '김하늘', studentId: sid,
    bookIds: [], selected: {}, createdAt: Date.now(), updatedAt: Date.now(), ...extra,
  }));
}
const call = (fn, ...args) => win.evaluate(([f, a]) => window.ohdap[f](...a), [fn, args]);
async function open(id) {
  await win.evaluate(async (id) => {
    const { nav } = await import('./js/shared.js');
    await nav.note(id);
  }, id);
  await win.waitForSelector('.export-panel');
}
async function preview(name) {
  await win.waitForFunction((name) => document.querySelectorAll('.em-cell b')[1]?.textContent === name, name);
  assert.equal(await win.locator(teacherInput).inputValue(), name);
}
async function reopen(id, name) {
  await win.click('#back-btn');
  assert.equal((await call('getNote', id)).teacher, name);
  await open(id);
  await preview(name);
}

before(async () => {
  seed('note-default');
  seed('note-unassigned', unassigned.id);
  seed('note-legacy', student.id, { teacher: '예전 선생님' });
  seed('note-empty', student.id, { teacher: '' });
  seed('note-readonly', 'student-gone', { teacher: '보기 선생님' });
  const gone = cloud.add({ id: 'student-gone', name: '지운 학생', teacherId: 'teacher-b' });
  cloud.edit(gone.id, { deletedAt: Date.now() });
  // Electron도 외부 node_modules를 읽도록 시험용 진입점에서 초기화해요.
  const entry = join(tmp, 'launch.cjs');
  writeFileSync(entry, `require('node:module')._initPaths();\nrequire(${JSON.stringify(join(ROOT, 'src/main/main.js'))});\n`);
  app = await electron.launch({
    executablePath: require('electron'), args: ['--no-sandbox', entry], timeout: 30000,
    env: {
      ...process.env, OHDAP_E2E: '1', OHDAP_USER_DATA: join(tmp, 'local'),
      MAGOEDU_DEV: '1', MAGOEDU_ACADEMY: '테스트학원', MAGOEDU_ACADEMY_DIR: academy,
      MAGOEDU_DATA_DIR: join(tmp, 'data'), MAGOEDU_LOCAL_DIR: join(tmp, 'local'),
      MAGOEDU_USER_ID: 'teacher-a', MAGOEDU_USER_NAME: '김선생', MAGOEDU_ROLE: 'teacher',
      ...cloud.env,
    },
  });
  win = await app.firstWindow();
  win.setDefaultTimeout(10000);
  win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForSelector('.seg-tab', { timeout: 20000 });
  await call('setSettings', { teacher: '설정 선생님', motion: 'reduce' });
  await win.reload();
  await win.waitForSelector('.seg-tab');
});
after(async () => {
  await app?.close();
  cloud.stop();
  assert.deepEqual(errors, []);
});

test('담당 선생님 기본값 → 목록 선택 → 저장 후 다시 열기', async () => {
  await open('note-default');
  await preview('박선생');
  const options = await win.locator(`${teacherSelect} option`).allTextContents();
  assert.ok(options.some((s) => s.includes('원장님')));
  assert.equal(options.at(-1), '직접 쓰기…');
  await win.selectOption(teacherSelect, { label: options.find((s) => s.includes('김선생')) });
  await preview('김선생');
  await reopen('note-default', '김선생');
  assert.equal(await win.locator(teacherInput).isVisible(), false);
});

test('직접 쓰기 → 미리보기 → 저장 후 다시 열기', async () => {
  await open('note-default');
  await win.selectOption(teacherSelect, { label: '직접 쓰기…' });
  await win.fill(teacherInput, '초빙 선생님');
  await preview('초빙 선생님');
  await reopen('note-default', '초빙 선생님');
  assert.equal(await win.locator(teacherInput).isVisible(), true);
  await win.screenshot({ path: join(tmp, 'direct-input.png') });
});

test('담당이 없으면 설정의 기본 이름, 저장된 이름·빈 이름은 그대로', async () => {
  await open('note-unassigned');
  await preview('설정 선생님');
  await open('note-legacy');
  await preview('예전 선생님');
  assert.equal(await win.locator(teacherInput).isVisible(), true);
  await open('note-empty');
  await preview('');
  assert.equal(await win.locator(teacherInput).isVisible(), true);
});

test('보기만 하는 노트는 선생님을 고치지 못해요', async () => {
  await open('note-readonly');
  await preview('보기 선생님');
  assert.equal(await win.locator(teacherSelect).isDisabled(), true);
  assert.equal(await win.locator(teacherInput).evaluate((el) => el.readOnly), true);
});

test('명단 요청 실패·빈 명단은 글자 칸으로, 저장된 이름 유지', async () => {
  for (const failure of [true, false]) {
    await app.evaluate(({ ipcMain }, failure) => {
      ipcMain.removeHandler('students:members');
      ipcMain.handle('students:members', () => {
        if (failure) throw new Error('시험용 명단 오류');
        return [];
      });
    }, failure);
    await open('note-default');
    await preview('초빙 선생님');
    assert.equal(await win.locator(teacherSelect).count(), 0);
    assert.equal(await win.locator(teacherInput).isVisible(), true);
  }
});

test('설정 문구는 시험지 기본 이름으로 안내해요', async () => {
  await win.click('#settings-btn');
  assert.equal(await win.getByText('시험지에 쓸 선생님 이름(기본값)', { exact: true }).count(), 1);
  assert.equal(JSON.parse(readFileSync(join(academy, 'students', student.id, 'notes', 'note-default.json'), 'utf8')).teacher, '초빙 선생님');
});
