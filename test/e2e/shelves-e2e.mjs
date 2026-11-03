// 학원 공간 E2E: 내 책장 / 공유 책장 · 학원 공유 켜고 끄기 · 새 오답노트의 학생 찾기
//  선생님(teacher-a)으로 켬 → 다른 선생님(teacher-b)이 공유한 책은 공유 책장에만, 보기만 / 나만 보기 책은 보이지 않음
//  → 내 책 등록(학원 공유) → 공유 끄기(members/<나>/books/ 로 옮김, 그대로 열리고 고칠 수 있음) → 다시 켜기
//  → 학생 명단에서 찾아 키보드로 고르기 → 원장으로 다시 켜서 선생님의 나만 보기 책을 보기만 할 수 있는지
// 통합 클라우드 없이 개발용 환경 변수(MAGOEDU_DEV=1 …)로 학원 공간을 흉내냄
// 실행: xvfb-run -a node test/e2e/shelves-e2e.mjs
import { _electron as electron } from '../lib/playwright.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIX = join(ROOT, 'test/fixtures/generated');
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'ohdap-shelves-'));
const userData = join(tmp, 'local');
const academy = join(tmp, 'academy');
const dataDir = join(tmp, 'data');
mkdirSync(userData, { recursive: true });

// 다른 선생님(teacher-b)의 책: 학원 공유 하나 + 나만 보기 하나
const otherShared = 'bbbbbbbb-0000-4000-8000-000000000001';
const otherPrivate = 'bbbbbbbb-0000-4000-8000-000000000002';
const doc = (file) => ({ files: [{ name: file, originalName: 'book-unit.pdf', kind: 'pdf' }], originalName: 'book-unit.pdf', pageCount: 0, range: '', options: { flow: 'column', numberStyle: 'auto' }, pageOffset: 0, pageOffsetAuto: true, items: [], pageInfo: {}, analyzedAt: null });
const seedBook = (dir, id, name) => {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(FIX, 'book-unit.pdf'), join(dir, 'problem-seed-000.pdf'));
  const now = Date.now() - 5000;
  writeFileSync(join(dir, 'book.json'), JSON.stringify({ id, kind: 'book', version: 2, name, createdAt: now, updatedAt: now, createdBy: { id: 'teacher-b', name: '박선생' }, docs: { problem: doc('problem-seed-000.pdf'), answer: null }, answerOverrides: {} }));
};
seedBook(join(academy, 'books', otherShared), otherShared, '박선생 공유 문제집');
seedBook(join(academy, 'members', 'teacher-b', 'books', otherPrivate), otherPrivate, '박선생 비밀 문제집');

const launch = (user) =>
  electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', ROOT],
    env: {
      ...process.env,
      OHDAP_E2E: '1',
      OHDAP_USER_DATA: userData,
      MAGOEDU_DEV: '1',
      MAGOEDU_ACADEMY: '테스트학원',
      MAGOEDU_ACADEMY_DIR: academy,
      MAGOEDU_DATA_DIR: dataDir,
      MAGOEDU_LOCAL_DIR: userData,
      ...user,
    },
  });

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
const shot = (name) => win.screenshot({ path: join(OUT, `shelves-${name}.png`) });
const stubOpen = (paths) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p }); }, paths);
const waitToast = (text, timeout = 30000) => win.waitForFunction((t) => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(t)), text, { timeout });
const clearToasts = () => win.$$eval('.toast', (els) => els.forEach((e) => e.remove()));
const call = (fn, ...args) => win.evaluate(([f, a]) => window.ohdap[f](...a), [fn, args]);
const fails = (fn, ...args) => win.evaluate(([f, a]) => window.ohdap[f](...a).then(() => null, (e) => String(e?.message || e)), [fn, args]);
const cards = () => win.$$eval('.shelf-body .book-card', (els) => els.map((e) => e.textContent));
const assert = (ok, msg) => {
  if (!ok) throw new Error(msg);
};
const sharedDir = (id) => join(academy, 'books', id);
const privateDir = (id) => join(academy, 'members', 'teacher-a', 'books', id);

try {
  step('책장: 내 책장(기본) / 공유 책장 — 다른 선생님 책은 공유 책장에만, 나만 보기 책은 안 보임');
  await win.waitForSelector('.seg-tab[data-tab="books"]', { timeout: 20000 });
  await win.click('.seg-tab[data-tab="books"]');
  await win.waitForSelector('.shelf-tabs .seg-tab[data-shelf="mine"].active', { timeout: 5000 });
  assert((await cards()).length === 0, '내 책장에 남의 책이 있습니다: ' + (await cards()));
  assert(await win.$('.shelf-body .card-new'), '내 책장에 새 책 등록이 없습니다');
  await win.click('.shelf-tabs .seg-tab[data-shelf="shared"]');
  await win.waitForSelector('.shelf-body .book-card', { timeout: 5000 });
  const sharedCards = await cards();
  assert(sharedCards.length === 1 && sharedCards[0].includes('박선생 공유 문제집') && sharedCards[0].includes('생성자: 박선생'), '공유 책장: ' + sharedCards);
  assert(!(await win.$('.shelf-body .card-new')), '공유 책장에 새 책 등록이 있습니다');
  assert(!(await call('listBooks')).some((b) => b.id === otherPrivate), '다른 선생님의 나만 보기 책이 목록에 있습니다');
  assert(await fails('getBook', otherPrivate), '다른 선생님의 나만 보기 책이 열립니다');
  await win.waitForTimeout(400);
  await shot('1-shared-shelf');

  step('공유 책장의 책은 보기만 (학원 공유 스위치 없음)');
  await win.click('.book-card:has-text("박선생 공유 문제집")');
  await win.waitForSelector('.readonly-banner', { timeout: 10000 });
  assert(!(await win.$('.tabs-row .seg-tab[data-tab="review"]')), '보기만 하는 책에 페이지 검토가 있습니다');
  assert(!(await win.$('.share-switch')), '남의 책에 학원 공유 스위치가 있습니다');
  assert(await fails('setBookShared', otherShared, false), '남의 책 공유를 바꿀 수 있습니다');
  assert(!(await win.$('.doc-head button:has-text("파일 추가")')) && !(await win.$('.doc-head button:has-text("파일 바꾸기")')), '보기만 하는 책에 파일 추가·바꾸기가 있습니다');
  assert(await fails('importFiles', otherShared, 'problem', [join(FIX, 'book-unit.pdf')], true), '남의 책에 파일을 더할 수 있습니다');
  await win.click('#back-btn');

  step('내 책 등록 → 내 책장, 학원 공유로 (books/<id>)');
  await win.waitForSelector('.shelf-tabs', { timeout: 10000 });
  await win.click('.shelf-tabs .seg-tab[data-shelf="mine"]');
  await win.click('.card-new:has-text("새 책 등록")');
  await win.fill('.modal input', '김선생 문제집');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.doc-card[data-role="problem"] .drop-zone');
  assert(await win.isChecked('.share-switch input'), '새 책이 학원 공유가 아닙니다');
  await stubOpen([join(FIX, 'book-unit.pdf')]);
  await win.click('.doc-card[data-role="problem"] .drop-zone');
  await win.waitForSelector('.doc-card[data-role="problem"] .doc-foot');
  assert(await win.$('.doc-card[data-role="problem"] .doc-head button:has-text("파일 추가")'), '내 책에 파일 추가가 없습니다');
  const mine = (await call('listBooks')).find((b) => b.name === '김선생 문제집');
  assert(mine && mine.mine && mine.shared && mine.canEdit, '내 책 요약: ' + JSON.stringify(mine));
  const id = mine.id;
  assert(existsSync(join(sharedDir(id), 'book.json')), '새 책이 books/ 에 없습니다');
  await win.click('#back-btn');
  await win.waitForSelector('.shelf-body .book-card', { timeout: 10000 });
  const myCards = await cards();
  assert(myCards.length === 1 && myCards[0].includes('김선생 문제집') && myCards[0].includes('학원 공유'), '내 책장: ' + myCards);
  await shot('2-my-shelf');
  await win.click('.shelf-tabs .seg-tab[data-shelf="shared"]');
  await win.waitForTimeout(400);
  assert(!(await cards()).some((t) => t.includes('김선생 문제집')), '내 책이 공유 책장에 있습니다');
  await win.click('.shelf-tabs .seg-tab[data-shelf="mine"]');

  step('학원 공유 끄기 → 확인 창 → members/<나>/books/<id> 로 옮김');
  await win.click('.book-card:has-text("김선생 문제집")');
  await win.waitForSelector('.share-switch');
  await win.waitForSelector('.doc-card[data-role="problem"] .doc-foot');
  await win.click('.share-switch');
  await win.waitForSelector('.modal:has-text("학원 공유 끄기")');
  const confirmText = await win.textContent('.modal');
  assert(confirmText.includes('지워진 책') && confirmText.includes('원장'), '확인 창 안내: ' + confirmText);
  await shot('3-confirm-off');
  await win.click('.modal .btn-danger');
  await waitToast('나만 보기로 바꿨어요');
  await clearToasts();
  const files = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
  assert(!existsSync(sharedDir(id)), 'books/<id> 가 남아 있습니다: ' + files(sharedDir(id)));
  assert(existsSync(join(privateDir(id), 'book.json')), 'members/<나>/books/<id>/book.json 이 없습니다');
  const problemFile = JSON.parse(readFileSync(join(privateDir(id), 'book.json'), 'utf8')).docs.problem.files[0].name;
  assert(existsSync(join(privateDir(id), problemFile)), '원본 파일이 옮겨지지 않았습니다: ' + files(privateDir(id)));
  assert(!(await win.isChecked('.share-switch input')), '스위치가 꺼지지 않았습니다');
  const got = await call('getBook', id);
  assert(got.$canEdit === true && got.$shared === false, '옮긴 책: ' + JSON.stringify({ canEdit: got.$canEdit, shared: got.$shared }));
  const status = await win.evaluate((u) => fetch(u).then((r) => r.status), `app://book/${id}/${problemFile}`);
  assert(status === 200, `옮긴 원본을 열지 못함: ${status}`);

  step('나만 보기 책: 그대로 열리고 고칠 수 있음 (이름 바꾸기가 새 자리에 저장)');
  assert(!(await win.$('.readonly-banner')) && (await win.$('.tabs-row .seg-tab[data-tab="review"]')), '나만 보기 책이 보기만으로 열립니다');
  await win.fill('.title-input', '김선생 문제집 (나만)');
  await win.press('.title-input', 'Enter');
  await win.click('.tabs-row .seg-tab[data-tab="result"]'); // 이름 칸에서 나가며 change
  await win.waitForFunction(() => document.querySelector('.save-status')?.textContent === '저장됨', null, { timeout: 10000 });
  const renamed = JSON.parse(readFileSync(join(privateDir(id), 'book.json'), 'utf8'));
  assert(renamed.name === '김선생 문제집 (나만)', '새 자리에 저장되지 않았습니다: ' + renamed.name);
  assert(!existsSync(sharedDir(id)), '저장하면서 books/<id> 가 다시 생겼습니다');
  await shot('4-private-book');
  await win.click('#back-btn');
  await win.waitForSelector('.shelf-body .book-card', { timeout: 10000 });
  const privCards = await cards();
  assert(privCards.length === 1 && privCards[0].includes('나만 보기 (원장 볼 수 있음)'), '나만 보기 표시: ' + privCards);
  assert((await call('listBooks')).find((b) => b.id === id)?.shared === false, '목록의 shared 가 false 가 아닙니다');

  step('다른 컴퓨터에서 나만 보기 책이 바뀌면 (members/<나>/books/<id>) 화면에 반영');
  await win.waitForTimeout(3500); // 방금 내가 쓴 파일은 지켜보기에서 건너뜀 (3초)
  const outside = { ...renamed, name: '다른 컴퓨터에서 바꾼 이름', updatedAt: Date.now() };
  writeFileSync(join(privateDir(id), 'book.json.ext'), JSON.stringify(outside));
  renameSync(join(privateDir(id), 'book.json.ext'), join(privateDir(id), 'book.json'));
  await win.waitForSelector('.shelf-body .book-card:has-text("다른 컴퓨터에서 바꾼 이름")', { timeout: 10000 });

  step('다시 열면 스위치는 꺼져 있음 → 다시 켜기 (확인 창 없이) → books/<id>');
  await win.click('.book-card:has-text("다른 컴퓨터에서 바꾼 이름")');
  await win.waitForSelector('.share-switch');
  assert(!(await win.isChecked('.share-switch input')), '다시 열었을 때 스위치가 켜져 있습니다');
  await win.click('.share-switch');
  await waitToast('학원에 공유했어요');
  await clearToasts();
  assert(!(await win.$('.modal')), '켤 때 확인 창이 떴습니다');
  assert(existsSync(join(sharedDir(id), 'book.json')) && existsSync(join(sharedDir(id), problemFile)), 'books/<id> 로 돌아오지 않았습니다');
  assert(!existsSync(privateDir(id)), 'members/<나>/books/<id> 가 남아 있습니다');
  assert(await win.isChecked('.share-switch input'), '스위치가 켜지지 않았습니다');
  assert((await call('getBook', id)).$shared === true, 'getBook $shared');
  await win.click('#back-btn');

  step('새 오답노트: 학생 명단에서 찾기 (이름·학교 일부, ↑↓ Enter, Esc 는 목록만 닫음)');
  const studentIds = {};
  for (const [name, school, grade] of [['김하늘', '한빛고', '고2'], ['김하늘', '새솔중', '중3'], ['이바다', '한빛고', '고1'], ['박지민', '푸른고', '고2']]) {
    studentIds[`${name}/${school}`] = (await call('saveStudent', { name, school, grade })).id;
  }
  await win.waitForSelector('.seg-tab[data-tab="notes"]');
  await win.click('.seg-tab[data-tab="notes"]');
  await win.click('.card-new:has-text("새 오답노트")');
  await win.waitForSelector('.modal .book-opt');
  const opts = await win.$$eval('.modal .book-opt .bo-name', (els) => els.map((e) => e.textContent));
  assert(opts.includes('다른 컴퓨터에서 바꾼 이름') && opts.includes('박선생 공유 문제집'), '고를 수 있는 책: ' + opts);
  const input = '.modal .student-search input';
  const rows = () => win.$$eval('.student-results:not([hidden]) .student-opt', (els) => els.map((e) => e.textContent));
  await win.fill(input, '김');
  await win.waitForSelector('.student-results:not([hidden])');
  await win.press(input, 'Escape');
  assert(await win.$('.student-results[hidden]'), 'Esc 로 목록이 닫히지 않았습니다');
  assert(await win.isVisible('.modal:has-text("새 오답노트")'), 'Esc 가 목록 대신 창을 닫았습니다');
  await win.fill(input, '푸른');
  assert(JSON.stringify(await rows()) === JSON.stringify(['박지민푸른고 · 고2']), '학교로 찾기: ' + (await rows()));
  await win.fill(input, '하늘');
  const found = await rows();
  assert(found.length === 2 && found.includes('김하늘한빛고 · 고2') && found.includes('김하늘새솔중 · 중3'), '이름으로 찾기: ' + found);
  await shot('5-student-search');
  const target = found[1].includes('새솔중') ? '김하늘/새솔중' : '김하늘/한빛고';
  await win.press(input, 'ArrowDown');
  await win.press(input, 'ArrowDown');
  await win.press(input, 'Enter');
  assert((await win.inputValue(input)) === '김하늘', '고른 이름이 채워지지 않았습니다');
  assert(await win.$('.student-results[hidden]'), '고른 뒤 목록이 닫히지 않았습니다');
  const pickedInfo = await win.textContent('.student-picked');
  assert(pickedInfo.includes(target.split('/')[1]), '고른 학생 표시: ' + pickedInfo);
  assert(await win.isVisible('.modal:has-text("새 오답노트")'), 'Enter 가 창을 닫았습니다');
  await win.locator('.modal .book-opt', { hasText: '다른 컴퓨터에서 바꾼 이름' }).click();
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.book-bar', { timeout: 20000 });
  const note1 = (await call('listNotes')).find((n) => n.title === '김하늘 오답노트');
  assert(note1?.studentId === studentIds[target] && note1.student === '김하늘', '오답노트 학생: ' + JSON.stringify(note1));

  step('새 오답노트: 고른 뒤 이름을 고치면 직접 입력 / 명단에 없는 이름도 그대로');
  await win.click('#back-btn');
  await win.waitForSelector('.seg-tab[data-tab="notes"]');
  await win.click('.card-new:has-text("새 오답노트")');
  await win.waitForSelector('.modal .book-opt');
  await win.fill(input, '이바');
  await win.press(input, 'ArrowDown');
  await win.press(input, 'Enter');
  assert((await win.inputValue(input)) === '이바다', '마우스 없이 이바다를 고르지 못했습니다');
  await win.fill(input, '최새봄');
  assert(await win.$('.student-picked[hidden]'), '이름을 고쳤는데 고른 학생이 남아 있습니다');
  assert(await win.$('.student-results[hidden]'), '맞는 학생이 없는데 목록이 열렸습니다');
  await win.locator('.modal .book-opt', { hasText: '박선생 공유 문제집' }).click();
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.book-bar', { timeout: 20000 });
  const note2 = (await call('listNotes')).find((n) => n.title === '최새봄 오답노트');
  assert(note2 && note2.studentId === '' && note2.student === '최새봄', '직접 입력한 학생: ' + JSON.stringify(note2));
  await win.click('#back-btn');
  await win.waitForSelector('.seg-tabs');

  step('원장으로 다시 켬: 선생님의 나만 보기 책은 목록엔 없고, 열면 보기만');
  await app.close();
  app = await launch({ MAGOEDU_USER_ID: 'boss', MAGOEDU_USER_NAME: '원장님', MAGOEDU_ROLE: 'director' });
  win = await app.firstWindow();
  watch(win);
  await win.waitForSelector('.seg-tab[data-tab="books"]', { timeout: 20000 });
  const bossBooks = await call('listBooks');
  assert(!bossBooks.some((b) => b.id === otherPrivate), '원장 책장 목록에 선생님의 나만 보기 책이 있습니다');
  const bShared = bossBooks.find((b) => b.id === otherShared);
  assert(bShared?.canEdit === true && bShared.mine === false && bShared.shared === true, '원장: 공유된 남의 책은 고칠 수 있어야 함: ' + JSON.stringify(bShared));
  const priv = await call('getBook', otherPrivate);
  assert(priv.$canEdit === false && priv.$shared === false, '원장: 나만 보기 책 ' + JSON.stringify({ canEdit: priv.$canEdit, shared: priv.$shared }));
  const privStatus = await win.evaluate((u) => fetch(u).then((r) => r.status), `app://book/${otherPrivate}/problem-seed-000.pdf`);
  assert(privStatus === 200, `원장: 나만 보기 책 원본을 열지 못함: ${privStatus}`);
  assert(await fails('saveBook', { ...priv, name: '고침' }), '원장이 선생님의 나만 보기 책을 고쳤습니다');
  assert(await fails('setBookShared', id, false), '원장이 남의 책 공유를 바꿨습니다');
  assert(JSON.parse(readFileSync(join(academy, 'members', 'teacher-b', 'books', otherPrivate, 'book.json'), 'utf8')).name === '박선생 비밀 문제집', '나만 보기 책이 바뀌었습니다');
  await win.click('.seg-tab[data-tab="books"]');
  await win.waitForSelector('.shelf-tabs .seg-tab[data-shelf="mine"].active', { timeout: 5000 });
  await win.click('.shelf-tabs .seg-tab[data-shelf="shared"]');
  await win.waitForSelector('.shelf-body .book-card:has-text("다른 컴퓨터에서 바꾼 이름")', { timeout: 5000 });
  await shot('6-director-shared');
  console.log('✅ 책장·학생 찾기 E2E 통과');
} catch (err) {
  console.error('❌ 책장·학생 찾기 E2E 실패:', err);
  await win.screenshot({ path: join(OUT, 'shelves-fail.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
if (errors.length) {
  console.log('renderer errors:', errors.length);
  process.exitCode = 1;
}
