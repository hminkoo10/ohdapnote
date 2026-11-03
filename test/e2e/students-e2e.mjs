// 학생별 오답노트 E2E (0.4): 통합 클라우드 학생 명단 · 학생 폴더의 오답노트를 학원 사람 누구나 · 동시에 고치면 합침 · 지운 학생은 보기만 · 학원 AI
//  김선생(teacher-a)으로 켬 → 명단은 academy-info.json → 학생 오답노트는 students/<학생>/notes/ → 첫 화면 학생별 묶음
//  → 다른 선생님의 나만 보기 교재는 '볼 수 없는 교재'(고른 문항은 그대로) → 고치는 중에 다른 곳에서 고치면 저장할 때 합침
//  → 담당 바꾸기 · 그사이 고친 학생은 conflict → 미지정 노트에 학생을 정하면 학생 폴더로 옮김 → 학생 지우기(보기만)·되살리기
//  → 학원 AI / 내 키 → 박선생(teacher-b, 새 담당)으로 켜서 같은 노트를 고침 → 원장은 선생님의 미지정 노트를 보기만
// 통합 클라우드 대신 test/lib/fake-cloud.mjs 가 명단 파일을 쓰고 requests/ 에 답함
// 실행: xvfb-run -a node test/e2e/students-e2e.mjs
import { _electron as electron } from '../lib/playwright.mjs';
import { fakeCloud } from '../lib/fake-cloud.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIX = join(ROOT, 'test/fixtures/generated');
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'ohdap-students-'));
const userData = join(tmp, 'local');
const academy = join(tmp, 'academy');
const dataDir = join(tmp, 'data');
mkdirSync(userData, { recursive: true });

const members = [
  { id: 'teacher-a', name: '김선생', role: 'teacher' },
  { id: 'teacher-b', name: '박선생', role: 'teacher' },
  { id: 'boss', name: '원장님', role: 'director' },
];
const cloud = fakeCloud({ dir: join(tmp, 'cloud'), academyDir: academy, members });
const sky = cloud.add({ id: 'stu-0000-0001', name: '김하늘', school: '한빛고', grade: '고2', teacherId: 'teacher-a' });
const sea = cloud.add({ id: 'stu-0000-0002', name: '이바다', school: '한빛고', grade: '고1', teacherId: 'teacher-b' });

// 박선생의 책: 학원 공유 하나 + 나만 보기 하나 (김선생은 볼 수 없음)
const sharedBook = 'bbbbbbbb-0000-4000-8000-000000000001';
const privateBook = 'bbbbbbbb-0000-4000-8000-000000000002';
// 문항 s1·s2·p1·p2·p3 (오답노트를 열 때 책에 없는 문항은 선택에서 빠지므로)
const item = (id, num) => ({ id, page: 1, number: String(num), num, prefix: '', col: 0, rects: [{ page: 1, x: 0.1, y: 0.1 * num, w: 0.3, h: 0.08 }] });
const doc = (file, ids) => ({ files: [{ name: file, originalName: 'book-unit.pdf', kind: 'pdf' }], originalName: 'book-unit.pdf', pageCount: 1, range: '', options: { flow: 'column', numberStyle: 'auto' }, pageOffset: 0, pageOffsetAuto: true, items: ids.map((id, i) => item(id, i + 1)), pageInfo: {}, analyzedAt: Date.now() - 5000 });
const seedBook = (dir, id, name, ids) => {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(FIX, 'book-unit.pdf'), join(dir, 'problem-seed-000.pdf'));
  const now = Date.now() - 5000;
  writeFileSync(join(dir, 'book.json'), JSON.stringify({ id, kind: 'book', version: 2, name, createdAt: now, updatedAt: now, createdBy: { id: 'teacher-b', name: '박선생' }, docs: { problem: doc('problem-seed-000.pdf', ids), answer: null }, answerOverrides: {} }));
};
seedBook(join(academy, 'books', sharedBook), sharedBook, '박선생 공유 문제집', ['s1', 's2']);
seedBook(join(academy, 'members', 'teacher-b', 'books', privateBook), privateBook, '박선생 비밀 문제집', ['p1', 'p2', 'p3']);

// 박선생이 만든 김하늘 오답노트 (공유 책 + 박선생의 나만 보기 책)
const skyNote = 'nnnnnnnn-0000-4000-8000-000000000001';
const studentNote = (sid, id) => join(academy, 'students', sid, 'notes', `${id}.json`);
const memberNote = (uid, id) => join(academy, 'members', uid, 'notes', `${id}.json`);
const readNote = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeOutside = (file, value) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(`${file}.ext`, JSON.stringify(value));
  renameSync(`${file}.ext`, file);
};
writeOutside(studentNote(sky.id, skyNote), {
  id: skyNote,
  kind: 'note',
  version: 2,
  title: '하늘 1학기',
  student: '김하늘',
  studentId: sky.id,
  bookIds: [sharedBook, privateBook],
  selected: { [sharedBook]: ['s1'], [privateBook]: ['p1', 'p2'] },
  renamesSeen: { [sharedBook]: 0, [privateBook]: 0 },
  exportOptions: null,
  createdAt: Date.now() - 4000,
  updatedAt: Date.now() - 4000,
});

// 학원 AI 가 보내는 키를 받아 보는 OpenAI 호환 서버 (통합 클라우드의 학원 AI 중계 /api/ai/relay/ohdapnote/… 노릇도)
const seenKeys = [];
const seenUrls = [];
const aiServer = createServer((req, res) => {
  seenKeys.push(req.headers.authorization || '');
  seenUrls.push(req.url);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
});
await new Promise((r) => aiServer.listen(0, '127.0.0.1', r));
const aiUrl = `http://127.0.0.1:${aiServer.address().port}/v1`;
const TICKET = 'MGT1.e2e-ticket'; // 통합 클라우드가 넘기는 실행 허가증 (학원 AI 중계의 키 자리에)

const launch = (user) => {
  cloud.as(user.MAGOEDU_USER_ID);
  return electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', ROOT],
    env: {
      ...process.env,
      OHDAP_E2E: '1',
      OHDAP_USER_DATA: userData,
      MAGOEDU_DEV: '1',
      MAGOEDU_ACADEMY: '테스트학원',
      MAGOEDU_ACADEMY_DIR: academy,
      MAGOEDU_DATA_DIR: join(dataDir, user.MAGOEDU_USER_ID),
      MAGOEDU_LOCAL_DIR: userData,
      MAGOEDU_SERVER: `http://127.0.0.1:${aiServer.address().port}`,
      MAGOEDU_TICKET: TICKET,
      ...cloud.env,
      ...user,
    },
  });
};

const step = (name) => console.log(`▶ ${name}`);
const errors = [];
let app = await launch({ MAGOEDU_USER_ID: 'teacher-a', MAGOEDU_USER_NAME: '김선생', MAGOEDU_ROLE: 'teacher' });
let win = await app.firstWindow();
const watch = (w) => {
  w.on('console', (m) => {
    if (m.type() === 'error') {
      errors.push(m.text());
      console.log('[renderer error]', m.text());
    }
  });
  w.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('[pageerror]', e.message);
  });
};
watch(win);
const shot = (name) => win.screenshot({ path: join(OUT, `students-${name}.png`) });
const waitToast = (text, timeout = 15000) => win.waitForFunction((t) => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(t)), text, { timeout });
const call = (fn, ...args) => win.evaluate(([f, a]) => window.ohdap[f](...a), [fn, args]);
const fails = (fn, ...args) => win.evaluate(([f, a]) => window.ohdap[f](...a).then(() => null, (e) => String(e?.message || e)), [fn, args]);
const assert = (ok, msg) => {
  if (!ok) throw new Error(msg);
};
const until = async (fn, msg, timeout = 10000) => {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(msg);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const OWN_MS = 3500; // 방금 내가 쓴 파일은 지켜보기에서 건너뜀 (3초)

/** 화면을 새로 읽고(API 로 바꾼 것은 내가 쓴 파일이라 알림이 오지 않음) 학생 오답노트 탭에서 '전체' (기본은 내 담당 학생만) */
async function showAll() {
  await win.reload();
  await win.waitForSelector('.seg-tab[data-tab="notes"]', { timeout: 20000 });
  await win.click('.seg-tab[data-tab="notes"]');
  const all = await win.$('.scope-seg button[data-scope="all"]:not(.active)');
  if (all) await all.click();
}

/** 첫 화면 → 학생 오답노트 탭 → 그 학생 → 오답노트 */
async function openNoteFromHome(sid, title) {
  await showAll();
  await win.click(`.student-group[data-student="${sid}"]`);
  await win.click(`.note-card:has-text("${title}")`);
  await win.waitForSelector('.book-bar', { timeout: 20000 });
}

try {
  step('명단은 통합 클라우드에서: 두 학생, 담당 선생님');
  await win.waitForSelector('.seg-tabs', { timeout: 20000 });
  const info = await call('appInfo');
  assert(info.roster === 'cloud' && info.purgeDays === 30, 'appInfo: ' + JSON.stringify(info));
  const roster = await call('listStudents');
  assert(roster.length === 2 && roster.find((s) => s.id === sky.id)?.teacher?.id === 'teacher-a', '명단: ' + JSON.stringify(roster));
  assert((await call('listMembers')).length === 3, '학원 사람');

  step('학생 오답노트는 학원 사람 누구나: 박선생이 만든 김하늘 노트를 김선생도 고칠 수 있음');
  const listed = (await call('listNotes')).find((n) => n.id === skyNote);
  assert(listed?.shared && listed.canEdit && listed.studentId === sky.id, '목록: ' + JSON.stringify(listed));

  step('새 오답노트: 학생을 고르면 그 학생 폴더에');
  const created = await call('createNote', { title: '하늘 기말', student: '김하늘', studentId: sky.id, bookIds: [sharedBook] });
  assert(existsSync(studentNote(sky.id, created.id)) && !existsSync(memberNote('teacher-a', created.id)), '새 노트 자리');
  assert(created.answersForStudent === false && readNote(studentNote(sky.id, created.id)).answersForStudent === false, '새 노트의 학생 답지 공개 기본값');

  step('첫 화면: 학생별 → 김하늘 → 노트 2개');
  await showAll();
  await win.waitForSelector(`.student-group[data-student="${sky.id}"]`, { timeout: 10000 });
  await shot('1-students');
  await win.click(`.student-group[data-student="${sky.id}"]`);
  await win.waitForSelector('.note-card:has-text("하늘 기말")', { timeout: 10000 });
  assert((await win.$$('.note-card')).length === 2, '김하늘 노트 수');
  await shot('2-student-notes');

  step('다른 선생님의 나만 보기 교재는 "볼 수 없는 교재" — 고른 문항은 남음');
  await win.click('.note-card:has-text("하늘 1학기")');
  await win.waitForSelector('.book-bar', { timeout: 20000 });
  const tabs = await win.$$eval('.book-tab .bt-name', (els) => els.map((e) => e.textContent));
  assert(tabs.includes('박선생 공유 문제집') && tabs.includes('볼 수 없는 교재'), '책 탭: ' + tabs);
  assert((await win.textContent('.student-chip')).includes('김하늘'), '학생 칩');

  step('학생 답지 공개: 예전 노트는 기본 끔, 켜기·다시 열기·끄기');
  assert((await call('getNote', skyNote)).answersForStudent === false, '예전 노트의 학생 답지 공개 기본값');
  assert(!(await win.isChecked('#answers-for-student')), '예전 노트의 스위치가 켜졌습니다');
  assert((await win.textContent('#answers-for-student-hint')).includes('학생이 받는 PDF'), '학생 PDF 설명');
  await win.click('.note-student-settings .switch');
  await until(() => readNote(studentNote(sky.id, skyNote)).answersForStudent === true, '학생 답지 공개가 저장되지 않았습니다');
  await openNoteFromHome(sky.id, '하늘 1학기');
  assert(await win.isChecked('#answers-for-student'), '다시 연 노트의 학생 답지 공개가 꺼졌습니다');
  await win.click('.note-student-settings .switch');
  await until(() => readNote(studentNote(sky.id, skyNote)).answersForStudent === false, '학생 답지 공개 끄기가 저장되지 않았습니다');

  step('고치는 중에 다른 곳에서 고치면 저장할 때 합침 (제목은 내 것, 고른 문항은 둘 다)');
  await win.waitForTimeout(OWN_MS);
  await win.fill('.title-input', '하늘 1학기 (김선생)');
  await win.press('.title-input', 'Tab'); // change → 0.6초 뒤 저장
  const outside = readNote(studentNote(sky.id, skyNote));
  outside.selected[sharedBook] = ['s1', 's2'];
  outside.exportOptions = { ...(outside.exportOptions || {}), cover: true };
  outside.answersForStudent = true;
  outside.updatedAt = Date.now();
  writeOutside(studentNote(sky.id, skyNote), outside);
  await waitToast('합쳐서 저장');
  await until(() => readNote(studentNote(sky.id, skyNote)).title === '하늘 1학기 (김선생)', '합친 제목이 저장되지 않았습니다');
  const merged = readNote(studentNote(sky.id, skyNote));
  assert(JSON.stringify(merged.selected[sharedBook]) === '["s1","s2"]', '공유 책 선택: ' + JSON.stringify(merged.selected));
  assert(JSON.stringify(merged.selected[privateBook]) === '["p1","p2"]', '볼 수 없는 교재의 선택이 사라졌습니다: ' + JSON.stringify(merged.selected));
  assert(merged.exportOptions?.cover === true, '다른 곳에서 고친 내보내기 설정: ' + JSON.stringify(merged.exportOptions));
  assert(merged.updatedBy?.id === 'teacher-a', 'updatedBy');
  assert(merged.answersForStudent === true, '다른 곳에서 켠 학생 답지 공개가 사라졌습니다');
  await win.waitForFunction(() => document.querySelector('#answers-for-student')?.checked === true);
  await shot('3-merged');

  step('고치는 중이 아니면 다른 곳에서 고친 것을 바로 다시 읽음');
  await win.waitForTimeout(OWN_MS);
  writeOutside(studentNote(sky.id, skyNote), { ...readNote(studentNote(sky.id, skyNote)), title: '박선생이 바꾼 제목', answersForStudent: false, updatedAt: Date.now() });
  await win.waitForFunction(() => document.querySelector('.title-input')?.value === '박선생이 바꾼 제목', null, { timeout: 10000 });
  assert(!(await win.isChecked('#answers-for-student')), '다른 곳에서 끈 학생 답지 공개가 화면에 반영되지 않았습니다');
  await win.click('#back-btn');

  step('담당 바꾸기 (통합 클라우드에 부탁) · 그사이 다른 사람이 고친 학생은 conflict');
  const cur = (await call('listStudents')).find((s) => s.id === sky.id);
  const saved = await call('saveStudent', { ...cur, teacherId: 'teacher-b' });
  assert(saved.teacher?.id === 'teacher-b' && cloud.student(sky.id).teacher.id === 'teacher-b', '담당: ' + JSON.stringify(saved));
  await until(async () => (await call('listStudents')).find((s) => s.id === sky.id)?.teacher?.id === 'teacher-b', '명단에 새 담당이 보이지 않습니다');
  cloud.edit(sky.id, { memo: '다른 컴퓨터에서 고침' });
  const conflict = await fails('saveStudent', { ...saved, memo: '내 메모' });
  assert(conflict?.includes('그사이'), 'conflict: ' + conflict);
  const added = await call('saveStudent', { name: '최새봄', school: '푸른고', grade: '고3' });
  assert(added.id && cloud.student(added.id)?.name === '최새봄', '학생 추가: ' + JSON.stringify(added));

  step('학생 미지정 노트 → 학생을 정하면 학생 폴더로 옮김');
  const loose = await call('createNote', { title: '이름만 적은 노트', student: '바다', studentId: '', bookIds: [sharedBook] });
  assert(existsSync(memberNote('teacher-a', loose.id)), '미지정 노트는 내 폴더에');
  const got = await call('getNote', loose.id);
  await call('saveNote', { ...got, answersForStudent: true }, got);
  assert(readNote(memberNote('teacher-a', loose.id)).answersForStudent === false, '미지정 노트의 학생 답지 공개를 켰습니다');
  const base = structuredClone(got);
  got.studentId = sea.id;
  got.student = '이바다';
  await call('saveNote', got, base);
  assert(existsSync(studentNote(sea.id, loose.id)) && !existsSync(memberNote('teacher-a', loose.id)), '학생 폴더로 옮겨지지 않았습니다');
  const loose2 = await call('createNote', { title: '김선생 미지정', student: '', studentId: '', bookIds: [] });

  step('학생 지정·해제: 답지 공개 설정 표시·숨김, 해제하면 기본 끔');
  await openNoteFromHome('', '김선생 미지정');
  assert((await win.$('#answers-for-student')) === null, '미지정 노트에 학생 답지 공개가 보입니다');
  await win.click('.student-chip');
  await win.fill('.modal .student-search input', '하늘');
  await win.press('.modal .student-search input', 'ArrowDown');
  await win.press('.modal .student-search input', 'Enter');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.note-student-settings .switch');
  assert(!(await win.isChecked('#answers-for-student')), '학생을 정한 노트의 학생 답지 공개 기본값');
  await win.click('.note-student-settings .switch');
  await until(() => existsSync(studentNote(sky.id, loose2.id)) && readNote(studentNote(sky.id, loose2.id)).answersForStudent === true, '학생 지정 후 공개가 저장되지 않았습니다');
  await win.waitForSelector('.modal-overlay', { state: 'detached' });
  await win.click('.student-chip');
  await win.fill('.modal .student-search input', '명단에 없는 이름');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.modal:has-text("학생 미지정") .btn-primary');
  await win.click('.modal:has-text("학생 미지정") .btn-primary');
  await until(() => existsSync(memberNote('teacher-a', loose2.id)) && !existsSync(studentNote(sky.id, loose2.id)), '학생 해제 후 내 폴더로 옮겨지지 않았습니다');
  assert((await win.$('#answers-for-student')) === null, '학생 해제 후에도 학생 답지 공개가 보입니다');
  assert(readNote(memberNote('teacher-a', loose2.id)).answersForStudent === false, '학생 해제 후에도 답지 공개가 켜져 있습니다');
  await win.click('#back-btn');

  step('노트 화면에서 학생 바꾸기 (명단에서 고름)');
  await openNoteFromHome(sea.id, '이름만 적은 노트');
  await win.click('.student-chip');
  await win.waitForSelector('.modal .student-search input');
  await win.fill('.modal .student-search input', '새봄');
  await win.press('.modal .student-search input', 'ArrowDown');
  await win.press('.modal .student-search input', 'Enter');
  await win.click('.modal .btn-primary');
  await until(() => existsSync(studentNote(added.id, loose.id)) && !existsSync(studentNote(sea.id, loose.id)), '노트 화면에서 바꾼 학생 폴더로 옮겨지지 않았습니다');
  assert((await win.textContent('.student-chip')).includes('최새봄'), '학생 칩이 바뀌지 않았습니다');
  await win.click('#back-btn');

  step('학생 지우기 → 그 학생 노트는 보기만 → 되살리면 다시 고칠 수 있음');
  await call('deleteStudent', added.id);
  await until(async () => (await call('listStudents')).find((s) => s.id === added.id)?.deletedAt, '지운 학생이 명단에 반영되지 않았습니다');
  const ro = await call('getNote', loose.id);
  assert(ro.$readonly && ro.$why === 'deleted', '지운 학생 노트: ' + JSON.stringify({ ro: ro.$readonly, why: ro.$why }));
  const denied = await fails('saveNote', { ...ro, $readonly: false, title: '고침', answersForStudent: true }, ro);
  assert(denied?.includes('지운 학생'), '지운 학생 노트를 고쳤습니다: ' + denied);
  assert(readNote(studentNote(added.id, loose.id)).answersForStudent === false, '지운 학생의 답지 공개를 켰습니다');
  assert((await call('listNotes')).find((n) => n.id === loose.id)?.canEdit === false, '목록 canEdit');
  await showAll();
  await win.waitForSelector(`.student-group[data-student="${added.id}"]`, { timeout: 10000 });
  await win.click(`.student-group[data-student="${added.id}"]`);
  await win.click('.note-card:has-text("이름만 적은 노트")');
  await win.waitForSelector('.readonly-banner', { timeout: 10000 });
  assert((await win.textContent('.readonly-banner')).includes('지운 학생'), '보기만 안내');
  assert(await win.isDisabled('#answers-for-student'), '보기만 하는 학생 노트의 답지 공개를 바꿀 수 있습니다');
  await shot('4-deleted-student');
  await win.click('#back-btn');
  await call('restoreStudent', added.id);
  await until(async () => !(await call('getNote', loose.id)).$readonly, '되살린 학생 노트가 아직 보기만입니다');

  step('학생 명단 탭: 지운 학생 되살리기 버튼');
  await call('deleteStudent', added.id);
  await win.click('.seg-tab[data-tab="students"]');
  await win.waitForSelector('.roster-card', { timeout: 10000 });
  await shot('5-roster');

  step('학원 AI (기본, 서버 중계) / 내 키');
  // 통합 클라우드는 키 없이 알려 줌 → 프로그램은 서버 중계 주소에 실행 허가증을 키 자리에 넣어 부름
  cloud.setAi({ provider: 'openai', model: 'm-academy', model2: '', rpm: null, source: 'default', hasKey: true, relay: true });
  await until(async () => (await call('getSettings')).academyAi?.model === 'm-academy', '학원 AI 가 설정에 보이지 않습니다');
  const s1 = await call('getSettings');
  assert(s1.academyAi.hasKey === true && !('apiKey' in s1.academyAi) && !JSON.stringify(s1).includes(TICKET), '실행 허가증이 화면에 넘어갔습니다');
  const listed1 = await call('aiListModels', { provider: 'openai' });
  assert(listed1.ok && seenKeys.at(-1) === `Bearer ${TICKET}`, '학원 AI 중계로 부르지 않았습니다: ' + seenKeys.at(-1));
  assert(seenUrls.at(-1) === '/api/ai/relay/ohdapnote/models', '중계 주소가 아닙니다: ' + seenUrls.at(-1));
  await call('setSettings', { aiSource: 'personal', openaiBaseUrl: aiUrl, openaiApiKey: 'my-key' });
  await call('aiListModels', { provider: 'openai' });
  assert(seenKeys.at(-1) === 'Bearer my-key', '내 키로 부르지 않았습니다: ' + seenKeys.at(-1));
  await call('setSettings', { aiSource: 'academy' });
  await win.click('#settings-btn');
  await win.waitForSelector('.modal .settings .ai-source');
  assert((await win.textContent('.ai-source')).includes('m-academy'), '학원 AI 안내');
  await shot('6-ai-source');
  await win.keyboard.press('Escape');
  await win.waitForSelector('.modal .settings', { state: 'detached', timeout: 5000 });

  step('박선생(새 담당)으로 켬: 같은 김하늘 노트를 고침 · 김선생의 미지정 노트는 안 보임');
  await app.close();
  app = await launch({ MAGOEDU_USER_ID: 'teacher-b', MAGOEDU_USER_NAME: '박선생', MAGOEDU_ROLE: 'teacher' });
  win = await app.firstWindow();
  watch(win);
  await win.waitForSelector('.seg-tabs', { timeout: 20000 });
  const bNotes = await call('listNotes');
  assert(bNotes.some((n) => n.id === skyNote && n.canEdit) && !bNotes.some((n) => n.id === loose2.id), '박선생 목록: ' + JSON.stringify(bNotes.map((n) => n.title)));
  const bGot = await call('getNote', skyNote);
  const bBase = structuredClone(bGot);
  bGot.selected[privateBook] = [...bGot.selected[privateBook], 'p3'];
  await call('saveNote', bGot, bBase);
  const afterB = readNote(studentNote(sky.id, skyNote));
  assert(afterB.updatedBy?.id === 'teacher-b' && afterB.selected[privateBook].includes('p3') && afterB.title === '박선생이 바꾼 제목', '박선생 저장: ' + JSON.stringify(afterB));
  await openNoteFromHome(sky.id, '박선생이 바꾼 제목');
  const bTabs = await win.$$eval('.book-tab .bt-name', (els) => els.map((e) => e.textContent));
  assert(bTabs.includes('박선생 비밀 문제집'), '박선생은 자기 나만 보기 책을 봐야 함: ' + bTabs);
  await win.click('#back-btn');

  step('원장: 선생님의 미지정 노트는 보기만');
  await app.close();
  app = await launch({ MAGOEDU_USER_ID: 'boss', MAGOEDU_USER_NAME: '원장님', MAGOEDU_ROLE: 'director' });
  win = await app.firstWindow();
  watch(win);
  await win.waitForSelector('.seg-tabs', { timeout: 20000 });
  const bossNote = (await call('listNotes')).find((n) => n.id === loose2.id);
  assert(bossNote && bossNote.mine === false && bossNote.canEdit === false && bossNote.ownerName === '김선생', '원장 목록: ' + JSON.stringify(bossNote));
  const bossGot = await call('getNote', loose2.id);
  assert(bossGot.$readonly && bossGot.$why === 'other', '원장이 남의 미지정 노트를 고칠 수 있음');
  console.log('✅ 학생별 오답노트 E2E 통과');
} catch (err) {
  console.error('❌ 학생별 오답노트 E2E 실패:', err);
  await win.screenshot({ path: join(OUT, 'students-fail.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  cloud.stop();
  aiServer.close();
  rmSync(tmp, { recursive: true, force: true });
}
if (errors.length) {
  console.log('renderer errors:', errors.length);
  process.exitCode = 1;
}
