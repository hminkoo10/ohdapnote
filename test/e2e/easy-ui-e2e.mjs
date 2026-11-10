// 작은 화면 회귀 시험. OHDAP_USER_DATA 필수. 외부 서비스·설치된 앱 데이터는 사용하지 않음.
// OHDAP_REVIEW_DIR을 주면 화면별 두 해상도를 한 PNG에 담음 (원본 캡처는 메모리에만).
import assert from 'node:assert/strict';
import { _electron as electron } from '../lib/playwright.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from 'pdf-lib';

assert.ok(process.env.OHDAP_USER_DATA, '시험용 OHDAP_USER_DATA 경로 필요');
const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tmp = mkdtempSync(join(process.env.OHDAP_USER_DATA, 'easy-ui-'));
const id = 'aaaaaaaa-1234-4000-8000-000000000050';
const dir = join(tmp, 'data/shared/books', id);
mkdirSync(dir, { recursive: true });
const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]);
const font = await pdf.embedFont(StandardFonts.Helvetica);
page.drawText('Review workbook', { x: 45, y: 770, font, size: 18 });
for (let i = 0; i < 4; i++) page.drawText(`${i + 1}. Solve the equation: x + ${i + 2} = 10`, { x: 45, y: 680 - 130 * i, font, size: 14 });
writeFileSync(join(dir, 'problem.pdf'), await pdf.save());
copyFileSync(join(dir, 'problem.pdf'), join(dir, 'answer.pdf'));
const doc = (role) => ({ files: [{ name: `${role}.pdf`, originalName: '수학 연습 교재.pdf', kind: 'pdf' }],
  originalName: '수학 연습 교재.pdf', pageCount: 1, range: '', options: { flow: 'column', numberStyle: 'auto' },
  pageOffset: 0, pageOffsetAuto: true, analyzedAt: Date.now(),
  pageInfo: { 0: { analyzed: true, source: 'text', flags: ['번호 확인 필요'] } },
  items: [0, 1, 2, 3].map((i) => ({ id: `${role}-${i + 1}`, page: 0, number: String(i + 1), num: i + 1,
    rects: [{ page: 0, x: 0.06, y: 0.16 + i * 0.154, w: 0.88, h: 0.11 }] })) });
writeFileSync(join(dir, 'book.json'), JSON.stringify({ id, kind: 'book', version: 2, subject: 'math', name: '수학 중간고사 대비 연습 교재',
  createdAt: Date.now(), updatedAt: Date.now(), docs: { problem: doc('problem'), answer: doc('answer') }, answerOverrides: {} }));
const secondId = 'bbbbbbbb-1234-4000-8000-000000000050';
const secondDir = join(tmp, 'data/shared/books', secondId);
mkdirSync(secondDir, { recursive: true });
copyFileSync(join(dir, 'problem.pdf'), join(secondDir, 'problem.pdf'));
copyFileSync(join(dir, 'answer.pdf'), join(secondDir, 'answer.pdf'));
writeFileSync(join(secondDir, 'book.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')), id: secondId, name: '후속 연습 교재' }));
let app;
const errors = [];
let passed = 0;
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', ROOT],
    env: { ...process.env, OHDAP_E2E: '1', OHDAP_USER_DATA: tmp } });
  const win = await app.firstWindow();
  win.setDefaultTimeout(20000);
  win.on('pageerror', (error) => errors.push(error.message));
  const call = (name, ...args) => win.evaluate(([name, args]) => window.ohdap[name](...args), [name, args]);
  const nav = (name, ...args) => win.evaluate(async ([name, args]) => (await import('./js/shared.js')).nav[name](...args), [name, args]);
  await win.waitForSelector('.seg-tab');
  await call('setSettings', { motion: 'reduce' });
  await win.evaluate(() => document.documentElement.dataset.motion = 'reduce');
  const student = await call('saveStudent', { name: '김하늘', school: '한빛고', grade: '고2' });
  const note = await call('createNote', { title: '중간고사 대비 오답', studentId: student.id, student: student.name, bookIds: [id] });
  const saved = await call('getNote', note.id);
  saved.selected[id] = ['problem-1', 'problem-2'];
  await call('saveNote', saved);
  const seedTranscripts = () => win.evaluate(async (id) => {
    const { transcriptKey } = await import('./js/transcript-store.js');
    const b = await window.ohdap.getBook(id);
    const items = {};
    for (const item of b.docs.problem.items) {
      const key = transcriptKey({ role: 'problem', item, src: { files: b.docs.problem.files } });
      items[key] = { blocks: [{ type: 'para', text: `${item.number}. 다음 방정식의 값을 구하시오.` }], model: 'test-fixture', at: Date.now() };
    }
    await window.ohdap.saveTranscripts(id, { version: 1, items });
  }, id);
  await seedTranscripts();

  async function capture(name, inspect, prepare = async () => {}) {
    const frames = [];
    for (const [width, height] of [[1280, 800], [1024, 768]]) {
      await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(0, 0); w.setSize(...size); }, [width, height]);
      await prepare();
      await win.waitForTimeout(350);
      const issues = await win.evaluate((selector) => {
        const issues = [];
        if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('가로 화면 넘침');
        const visible = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
        for (const el of document.querySelectorAll(selector)) {
          if (!visible(el)) continue;
          const r = el.getBoundingClientRect();
          if (el.scrollWidth > el.clientWidth + 2) issues.push(`${el.textContent.trim()}: 글자 잘림`);
          if (r.left < -1 || r.right > innerWidth + 1) issues.push(`${el.textContent.trim()}: 화면 밖`);
          let scrollableY = false;
          for (let p = el.parentElement; p; p = p.parentElement) {
            const style = getComputedStyle(p);
            const box = p.getBoundingClientRect();
            if (/auto|scroll/.test(style.overflowY) && p.scrollHeight > p.clientHeight) scrollableY = true;
            if (!scrollableY && /hidden|clip/.test(style.overflowY) && (r.top < box.top - 1 || r.bottom > box.bottom + 1)) issues.push(`${el.textContent.trim()}: 세로 잘림 (${p.className})`);
            if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
              if (r.left < box.left - 1 || r.right > box.right + 1) issues.push(`${el.textContent.trim()}: 가로 잘림 (${p.className})`);
            }
          }
        }
        return [...new Set(issues)];
      }, `${inspect}, .topbar .btn`);
      console.log(`LAYOUT ${name} ${width}x${height}: ${JSON.stringify(issues)}`);
      if (process.env.OHDAP_REVIEW_DIR) frames.push((await win.screenshot()).toString('base64'));
      if (issues.length && process.env.OHDAP_REVIEW_DIR) await win.screenshot({ path: join(ROOT, '.task-tmp/layout-fail.png') });
      assert.deepEqual(issues, [], `${name} ${width}x${height}`);
      passed++;
    }
    if (frames.length) {
      const png = await win.evaluate(async (frames) => {
        const bitmaps = await Promise.all(frames.map(async (data) => createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())));
        const c = new OffscreenCanvas(bitmaps[0].width + bitmaps[1].width, Math.max(...bitmaps.map((b) => b.height)));
        const ctx = c.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(bitmaps[0], 0, 0); ctx.drawImage(bitmaps[1], bitmaps[0].width, 0);
        bitmaps.forEach((b) => b.close());
        return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())];
      }, frames);
      mkdirSync(process.env.OHDAP_REVIEW_DIR, { recursive: true });
      const target = join(process.env.OHDAP_REVIEW_DIR, `${name}.png`);
      writeFileSync(target, Buffer.from(png));
      if (statSync(target).size >= 390000) execFileSync('python', ['-c',
        'from PIL import Image; import sys; p=sys.argv[1]; im=Image.open(p).convert("RGB"); im.quantize(colors=256).save(p,optimize=True)', target]);
      assert.ok(statSync(target).size < 400000, `${name} PNG 크기 제한`);
    }
  }
  await nav('home', { tab: 'books' });
  await capture('책장', '.card-actions .btn, .seg-tab');
  assert.equal(await win.locator('.card-actions').first().evaluate((el) => getComputedStyle(el).opacity), '1'); passed++;
  await nav('home', { tab: 'students' });
  await capture('학생명단', '.card-actions .btn, .seg-tab');
  await nav('home', { tab: 'notes' });
  await win.click(`.student-group[data-student="${student.id}"]`);
  await capture('학생오답노트', '.card-actions .btn, .seg-tab');
  await nav('book', id);
  await win.waitForSelector('.qtable .chip');
  await win.locator('.qtable .chip').first().click();
  await win.waitForSelector('.preview-img[src^="data:"]');
  await capture('인식결과', '.doc-head .btn, .tabs-row .seg-tab, .cp-actions .btn, .cp-foot .btn, .preview-head .btn');
  await win.click('.seg-tab[data-tab="review"]');
  await win.waitForSelector('.page-overlay .box');
  assert.equal(await win.locator('.page-overlay .box').first().evaluate((el) => getComputedStyle(el).borderTopStyle), 'solid', '검토 상자 테두리가 보여야 함');
  await capture('페이지검토', '.editor-toolbar .btn, .doc-head .btn');
  await win.locator('.page-overlay .box').first().click();
  const before = await win.locator('.page-overlay .box').count();
  await win.click('.editor-toolbar .btn:has-text("삭제")');
  await win.click('.modal .btn:has-text("취소")');
  assert.equal(await win.locator('.page-overlay .box').count(), before); passed++;
  await win.click('.editor-toolbar .btn:has-text("삭제")');
  await win.click('.modal .btn-danger');
  assert.equal(await win.locator('.page-overlay .box').count(), before - 1); passed++;
  await nav('home', { tab: 'books' });
  await seedTranscripts();
  await nav('home', { tab: 'bank' });
  await win.waitForSelector('.bank-intro');
  assert.equal(await win.locator('.bank-path').first().textContent(), '정밀 인식'); passed++;
  await capture('문제은행', '.bank-heading .btn, .bank-intro .btn', async () => {
    await win.locator('main.home').evaluate((el) => el.scrollTop = 0);
  });
  await win.locator('.bank-row .bank-check input').first().check();
  await win.click('.bank-export label:has(input[name="bank-format"][value="hwpx"])');
  await capture('문제은행-내보내기', '.bank-heading .btn, .bank-intro .btn, .bank-book .btn, .bank-export .seg label, .bank-export .export-btn', async () => {
    await win.locator('main.home').evaluate((el) => el.scrollTop = el.scrollHeight);
  });
  await nav('note', note.id);
  await win.waitForSelector('.export-panel');
  await win.click('.seg label:has(input[name="format"][value="hwpx"])');
  await capture('내보내기', '.export-btn, .convert-row .seg label, .select-toolbar .btn', async () => {
    await win.locator('.export-panel').evaluate((el) => { el.parentElement.scrollTop = el.parentElement.scrollHeight; });
  });
  const chosen = await win.locator('.sel-chip').count();
  assert.ok(chosen > 0);
  await win.locator('.sel-x').first().click();
  await win.click('.toast-actions .btn:has-text("되돌리기")');
  assert.equal(await win.locator('.sel-chip').count(), chosen); passed++;
  assert.doesNotMatch(await win.locator('.sel-chip-label').first().innerText(), /수학 중간고사 대비 연습 교재/);
  const two = await call('createNote', { title: '두 교재 오답', bookIds: [id, secondId] });
  two.selected[id] = [(await call('getBook', id)).docs.problem.items[0].id]; two.selected[secondId] = ['problem-1'];
  await call('saveNote', two); await nav('note', two.id);
  await win.waitForSelector('.sel-chip-label');
  const labels = await win.locator('.sel-chip-label').allTextContents();
  assert.ok(labels.some((text) => text.includes('수학 중간고사 대비 연습 교재')));
  assert.ok(labels.some((text) => text.includes('후속 연습 교재')));
  assert.equal(await win.locator('.sel-chip-label').first().evaluate((el) => getComputedStyle(el).textOverflow), 'ellipsis'); passed++;
  await capture('두교재-시험지저장', '.sel-chip-label, .sel-x', async () => {
    await win.locator('.export-panel .sel-list').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  });
  await win.click('#settings-btn');
  await win.waitForSelector('.settings');
  assert.equal(await win.locator('.set-adv').evaluate((el) => el.open), false); passed++;
  assert.equal(await win.locator('input[list="ai-models-gemini"]').first().isVisible(), false); passed++;
  await capture('설정', '.modal-header .btn, .settings .btn, .modal-footer .btn, .settings .field input');
  await win.click('.set-adv summary');
  assert.equal(await win.locator('input[list="ai-models-gemini"]').first().isVisible(), true); passed++;
  await capture('설정-고급', '.modal-header .btn, .settings .btn, .modal-footer .btn, .settings .field input', async () => {
    await win.locator('.set-adv').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  });
  await win.fill('input[list="ai-models-gemini"] >> nth=0', 'review-model');
  await win.click('.modal-footer .btn-primary');
  assert.equal((await call('getSettings')).geminiModel, 'review-model'); passed++;
  assert.deepEqual(errors, []); passed++;
  console.log(`RESULT easy-ui: ${passed} passed, 0 failed`);
} finally {
  await app?.close();
  rmSync(tmp, { recursive: true, force: true });
}
