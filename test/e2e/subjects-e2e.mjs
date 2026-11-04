// 과목 계약 E2E: 학원이 계약한 과목(academy.subjects)만 교재 등록, 계약에서 빠진 과목의 교재는 보기만
//  수학·영어 계약 학원의 선생님(teacher-a)으로 켬 → 새 책 등록 창에 수학·영어만 (국어 없음) → 영어로 등록 (book.json subject)
//  → 미리 넣어 둔 국어 교재·과목 없는 예전 교재(= 수학) → 국어 교재는 흐리게·고칠 수 없음, 열면 보기만 · 새 오답노트에 못 고름
//  → 운영자가 영어 계약을 빼면 (academy-info.json) 켠 채로 영어 교재도 보기만 → 오답노트에서 영어 교재 문항은 고르기·내보내기 없음
//  → 계약한 과목이 하나도 없으면 등록 창 대신 안내
// 통합 클라우드 없이 개발용 환경 변수(MAGOEDU_DEV=1 …)로 학원 공간을, test/lib/fake-cloud.mjs 로 학원 정보를 흉내냄
// 실행: xvfb-run -a node test/e2e/subjects-e2e.mjs
import { _electron as electron } from '../lib/playwright.mjs';
import { fakeCloud } from '../lib/fake-cloud.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIX = join(ROOT, 'test/fixtures/generated');
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'ohdap-subjects-'));
const userData = join(tmp, 'local');
const academy = join(tmp, 'academy');
const dataDir = join(tmp, 'data');
mkdirSync(userData, { recursive: true });

// 미리 넣어 둔 교재: 국어(계약 안 함) · 과목 없는 예전 교재(수학으로 봄) — 둘 다 내가 만든 것, 분석된 문항 하나씩
const koreanId = 'cccccccc-0000-4000-8000-000000000001';
const oldId = 'cccccccc-0000-4000-8000-000000000002';
const items = [{ id: '0:1', page: 0, number: '1', num: 1, rects: [{ page: 0, x: 0.1, y: 0.1, w: 0.8, h: 0.2 }] }];
const doc = (file) => ({ files: [{ name: file, originalName: 'book-unit.pdf', kind: 'pdf' }], originalName: 'book-unit.pdf', pageCount: 1, range: '', options: { flow: 'column', numberStyle: 'auto' }, pageOffset: 0, pageOffsetAuto: true, items, pageInfo: {}, analyzedAt: Date.now() });
const seedBook = (id, name, extra) => {
  const dir = join(academy, 'books', id);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(FIX, 'book-unit.pdf'), join(dir, 'problem-seed-000.pdf'));
  const now = Date.now() - 5000;
  writeFileSync(join(dir, 'book.json'), JSON.stringify({ id, kind: 'book', version: 2, name, createdAt: now, updatedAt: now, createdBy: { id: 'teacher-a', name: '김선생' }, docs: { problem: doc('problem-seed-000.pdf'), answer: null }, answerOverrides: {}, ...extra }));
};
seedBook(koreanId, '국어 독해 교재', { subject: 'korean' });
seedBook(oldId, '예전 수학 교재', {});

const cloud = fakeCloud({
  dir: join(tmp, 'cloud'),
  academyDir: academy,
  members: [{ id: 'teacher-a', name: '김선생', role: 'teacher' }],
  subjects: ['english', 'math'], // 순서가 섞여 와도 수학 · 영어 순으로
});

const app = await electron.launch({
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
    ...cloud.env,
    MAGOEDU_USER_ID: 'teacher-a',
    MAGOEDU_USER_NAME: '김선생',
    MAGOEDU_ROLE: 'teacher',
  },
});
const win = await app.firstWindow();
const step = (name) => console.log(`▶ ${name}`);
const errors = [];
win.on('console', (m) => {
  if (m.type() === 'error') {
    errors.push(m.text());
    console.log('[renderer error]', m.text());
  }
});
win.on('pageerror', (e) => {
  errors.push(e.message);
  console.log('[pageerror]', e.message);
});
const shot = (name) => win.screenshot({ path: join(OUT, `subjects-${name}.png`) });
const call = (fn, ...args) => win.evaluate(([f, a]) => window.ohdap[f](...a), [fn, args]);
const fails = (fn, ...args) => win.evaluate(([f, a]) => window.ohdap[f](...a).then(() => null, (e) => String(e?.message || e)), [fn, args]);
const assert = (ok, msg) => {
  if (!ok) throw new Error(msg);
};
const card = (name) => win.locator('.shelf-body .book-card', { hasText: name });
const bookJson = (id) => JSON.parse(readFileSync(join(academy, 'books', id, 'book.json'), 'utf8'));

try {
  step('계약 과목은 수학 · 영어 (약속 1 순서)');
  await win.waitForSelector('.seg-tab[data-tab="books"]', { timeout: 30000 });
  const info = await call('appInfo');
  assert(JSON.stringify(info.subjects) === '["math","english"]', '계약 과목: ' + JSON.stringify(info.subjects));

  step('책장: 국어 교재는 흐리게 · 고치기 없음, 예전 교재는 수학');
  await win.click('.seg-tab[data-tab="books"]');
  await win.waitForSelector('.shelf-body .book-card', { timeout: 10000 });
  assert(await card('국어 독해 교재').evaluate((e) => e.classList.contains('subject-closed')), '국어 교재가 잠기지 않았습니다');
  assert((await card('국어 독해 교재').textContent()).includes('계약 없음'), '국어 교재에 계약 없음 표시가 없습니다');
  assert((await card('국어 독해 교재').locator('.card-actions').count()) === 0, '국어 교재에 이름 바꾸기·삭제가 있습니다');
  assert((await card('예전 수학 교재').locator('.subject-badge').textContent()) === '수학', '예전 교재가 수학이 아닙니다');
  const list = await call('listBooks');
  const kor = list.find((b) => b.id === koreanId);
  assert(kor.subject === 'korean' && kor.subjectOpen === false && kor.canEdit === false, '국어 교재 요약: ' + JSON.stringify(kor));
  assert(await fails('saveBook', { ...(await call('getBook', koreanId)), name: '고침' }), '계약 빠진 과목 교재를 고쳤습니다');
  assert(await fails('deleteBook', koreanId), '계약 빠진 과목 교재를 지웠습니다');
  assert(await fails('copyBook', koreanId), '계약 빠진 과목 교재를 복사했습니다');
  assert(await fails('createBook', '몰래 국어', undefined, 'korean'), '계약 안 한 과목으로 등록했습니다');
  await shot('1-shelf');

  step('국어 교재를 열면 보기만 (이유 안내, 분석·복사 없음)');
  await card('국어 독해 교재').click();
  await win.waitForSelector('.readonly-banner.subject-closed', { timeout: 10000 });
  assert((await win.textContent('.readonly-banner.subject-closed')).includes('국어'), '보기만 이유에 과목이 없습니다');
  assert(!(await win.$('.readonly-banner button')), '계약 빠진 교재에 내 책으로 복사가 있습니다');
  assert(!(await win.$('.doc-foot button:has-text("분석")')), '계약 빠진 교재에 분석 버튼이 있습니다');
  await win.click('#back-btn');
  await win.waitForSelector('.shelf-body .book-card', { timeout: 10000 });

  step('새 책 등록: 수학 · 영어만 고를 수 있음 → 영어로 등록');
  await win.click('.card-new:has-text("새 책 등록")');
  await win.waitForSelector('.modal .subject-opt');
  const opts = await win.$$eval('.modal .subject-opt input', (els) => els.map((e) => e.value));
  assert(JSON.stringify(opts) === '["math","english"]', '고를 수 있는 과목: ' + JSON.stringify(opts));
  assert((await win.textContent('.modal')).includes('국어은(는) 학원 계약에 없어서'), '계약 없는 과목 안내가 없습니다');
  await win.fill('.modal input', '수능특강 영어');
  await win.click('.modal .subject-opt:has-text("영어")');
  await shot('2-create');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.doc-card[data-role="problem"] .drop-zone', { timeout: 10000 });
  const english = (await call('listBooks')).find((b) => b.name === '수능특강 영어');
  assert(english?.subject === 'english' && english.subjectOpen && english.canEdit, '영어 교재: ' + JSON.stringify(english));
  assert(bookJson(english.id).subject === 'english', 'book.json 에 subject 가 없습니다');
  assert((await win.inputValue('.topbar .subject-select')) === 'english', '책 화면의 과목이 영어가 아닙니다');
  await win.click('#back-btn');
  await win.waitForSelector('.shelf-body .book-card', { timeout: 10000 });
  // 영어 교재에 문항 하나 (분석한 것처럼) — 아래 오답노트에서 씀. 책 화면을 나간 뒤에 (나갈 때 화면의 책을 저장함)
  const eb = await call('getBook', english.id);
  copyFileSync(join(FIX, 'book-unit.pdf'), join(academy, 'books', english.id, 'problem-seed-000.pdf'));
  await call('saveBook', { ...eb, docs: { problem: doc('problem-seed-000.pdf'), answer: null } });

  step('새 오답노트: 국어 교재는 고를 수 없음');
  await win.click('.seg-tab[data-tab="notes"]');
  await win.click('.card-new:has-text("새 오답노트")');
  await win.waitForSelector('.modal .book-opt');
  const names = await win.$$eval('.modal .book-opt .bo-name', (els) => els.map((e) => e.textContent));
  assert(!names.includes('국어 독해 교재') && names.includes('수능특강 영어') && names.includes('예전 수학 교재'), '고를 수 있는 교재: ' + names);
  await win.locator('.modal .book-opt', { hasText: '수능특강 영어' }).click();
  await win.locator('.modal .book-opt', { hasText: '예전 수학 교재' }).click();
  await win.fill('.modal input[placeholder*="중간고사"]', '과목 시험 노트');
  await win.click('.modal .btn-primary');
  await win.waitForSelector('.book-bar', { timeout: 20000 });
  await win.click('.book-tab:has-text("수능특강 영어")');
  await win.waitForSelector('.qtable .chip', { timeout: 20000 });
  await win.click('.qtable .chip');
  await win.waitForFunction(() => document.querySelector('.export-head .sel-count')?.textContent.includes('1'), null, { timeout: 5000 });

  step('운영자가 영어 계약을 빼면: 켠 채로 영어 교재도 보기만, 오답노트에서 고르기·내보내기 없음');
  cloud.setSubjects(['math']);
  await win.waitForFunction(() => document.querySelector('.book-tab.subject-closed')?.textContent.includes('수능특강 영어'), null, { timeout: 15000 });
  await win.click('.book-tab:has-text("예전 수학 교재")');
  await win.click('.book-tab:has-text("수능특강 영어")');
  await win.waitForSelector('.select-main .readonly-banner.subject-closed', { timeout: 10000 });
  assert((await win.textContent('.export-summary')).includes('빼고 내보내요'), '내보내기에서 빠진다는 안내가 없습니다');
  const before = await win.$$eval('.qtable .chip.on', (els) => els.length);
  await win.click('.qtable .chip');
  await win.waitForTimeout(300);
  assert((await win.$$eval('.qtable .chip.on', (els) => els.length)) === before, '계약 빠진 교재에서 문항을 고를 수 있습니다');
  assert(!(await win.$('.select-toolbar .search')), '계약 빠진 교재에 빠르게 고르기가 있습니다');
  await shot('3-note-closed');
  const englishNow = (await call('listBooks')).find((b) => b.id === english.id);
  assert(englishNow.subjectOpen === false && englishNow.canEdit === false, '영어 계약을 뺐는데 영어 교재를 고칠 수 있습니다');
  await win.click('#back-btn');

  step('계약한 과목이 하나도 없으면: 등록 창 대신 안내');
  cloud.setSubjects([]);
  await win.waitForFunction(async () => JSON.stringify((await window.ohdap.appInfo()).subjects) === '[]', null, { timeout: 10000 });
  await win.waitForTimeout(600);
  await win.click('.seg-tab[data-tab="books"]');
  await win.click('.card-new:has-text("새 책 등록")');
  await win.waitForSelector('.modal');
  assert((await win.textContent('.modal')).includes('계약한 과목이 없어서'), '계약 과목이 없을 때 안내가 없습니다: ' + (await win.textContent('.modal')));
  assert(!(await win.$('.modal input')), '계약 과목이 없는데 이름 칸이 있습니다');
  await shot('4-none');
  await win.click('.modal .btn-primary');
  console.log('✅ 과목 계약 E2E 통과');
} catch (err) {
  console.error('❌ 과목 계약 E2E 실패:', err);
  await win.screenshot({ path: join(OUT, 'subjects-fail.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  cloud.stop();
  rmSync(tmp, { recursive: true, force: true });
}
if (errors.length) {
  console.log('renderer errors:', errors.length);
  process.exitCode = 1;
}
