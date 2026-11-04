// 런처·설치 파일·종료는 흉내만 내고, 별도 데이터 폴더에서 실제 화면·IPC를 확인한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { _electron as electron } from '../lib/playwright.mjs';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });

test('업데이트 재시작 화면·IPC', { timeout: 60000 }, async (t) => {
  const userData = mkdtempSync(join(OUT, 'restart-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MAGOEDU_|OHDAP_)/.test(key)));
  const app = await electron.launch({ executablePath: require('electron'), args: [ROOT, `--user-data-dir=${userData}`], env: { ...env, OHDAP_E2E: '1', OHDAP_USER_DATA: userData } });
  try {
    const win = await app.firstWindow();
    const errors = [];
    win.on('pageerror', (err) => errors.push(err.message));
    await win.waitForSelector('.home');
    const info = await win.evaluate(() => window.ohdap.appInfo());
    await t.test('개발·시험 실행은 감시와 알림 비활성', async () => {
      assert.equal(info.updateRestartEnabled, false);
      assert.equal(await win.locator('#update-notice').count(), 0);
    });

    await app.evaluate(async ({ app, ipcMain, BrowserWindow }, { root, info }) => {
      const { createRequire } = process.getBuiltinModule('module');
      const require = createRequire(`${root}/package.json`);
      const { createUpdateMonitor } = require(`${root}/src/main/update-restart.js`);
      globalThis.restartTest = { exits: [], now: Date.now(), busy: false };
      const monitor = createUpdateMonitor({
        app: { isPackaged: true, getVersion: () => '0.4.0', exit: (code) => globalThis.restartTest.exits.push(code), on: app.on.bind(app) },
        ipcMain, session: { dev: false }, isSmokeTest: false,
        cloud: { RESTART_EXIT_CODE: 75, newerVersionInstalled: () => '0.4.1' },
        isBusy: () => globalThis.restartTest.busy,
        now: () => globalThis.restartTest.now,
      });
      monitor.attach(BrowserWindow.getAllWindows()[0]);
      ipcMain.removeHandler('app:info');
      ipcMain.handle('app:info', () => ({ ...info, updateRestartEnabled: true }));
    }, { root: ROOT, info });
    await win.reload();
    await win.waitForSelector('#update-notice button');
    const exits = () => app.evaluate(() => globalThis.restartTest.exits);
    const waitExits = async (count) => {
      for (let i = 0; i < 100 && (await exits()).length < count; i++) await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(await exits(), Array(count).fill(75));
    };

    await t.test('새 버전 알림은 다른 알림이 쌓여도 유지', async () => {
      assert.match(await win.locator('#update-notice').innerText(), /지금 다시 켜기/);
      await win.evaluate(async () => {
        const { toast } = await import('./js/ui.js');
        for (let i = 0; i < 6; i++) toast(`시험 알림 ${i}`);
      });
      assert.equal(await win.locator('#update-notice button').count(), 1);
      await win.screenshot({ path: join(OUT, 'restart-notice.png') });
    });

    await t.test('열린 설정 입력창은 버튼을 눌러도 유지', async () => {
      await win.evaluate(() => { import('./js/chrome.js').then((m) => m.openSettings()); });
      await win.waitForSelector('.settings-modal');
      await win.click('#update-notice button');
      assert.deepEqual(await exits(), []);
      assert.equal(await win.locator('.settings-modal').count(), 1);
      await win.click('.settings-modal .modal-x');
      await win.waitForSelector('.modal-overlay', { state: 'detached' });
    });

    await t.test('취소 중 분석과 중첩 내보내기·동기화는 완료까지 재시작 보류', async () => {
      await win.evaluate(async () => {
        const { startJob, setRestartBusy } = await import('./js/shared.js');
        window.restartJob = startJob({ key: 'restart-test', title: '분석 시험', here: () => true });
        window.restartJob.cancel();
        setRestartBusy('export:test', true);
        setRestartBusy('export:test', true);
        setRestartBusy('export:test', false);
      });
      await win.click('#update-notice button');
      assert.deepEqual(await exits(), []);
      await win.evaluate(() => window.restartJob.finish());
      await win.click('#update-notice button');
      assert.deepEqual(await exits(), []);
      await win.evaluate(async () => (await import('./js/shared.js')).setRestartBusy('export:test', false));
      await app.evaluate(() => { globalThis.restartTest.busy = true; });
      await win.click('#update-notice button');
      assert.deepEqual(await exits(), []);
      await app.evaluate(() => { globalThis.restartTest.busy = false; });
    });

    await t.test('저장 실패는 화면 보존, 버튼 재시도는 실제 파일 저장 뒤 75 요청', async () => {
      await win.evaluate(async () => {
        const { makeSaver, leaveHooks } = await import('./js/shared.js');
        window.restartBook = await window.ohdap.createBook('재시작 저장 시험');
        window.restartSaveFail = true;
        window.restartLeaveCalls = 0;
        leaveHooks.add(() => { window.restartLeaveCalls++; });
        const saver = makeSaver(async (book) => {
          if (window.restartSaveFail) throw new Error('시험용 저장 실패');
          await window.ohdap.saveBook(book);
        });
        saver.set(window.restartBook);
        window.restartBook.name = '저장된 새 제목';
        saver.dirty();
      });
      await win.click('#update-notice button');
      await win.waitForFunction(() => document.body.textContent.includes('시험용 저장 실패'));
      assert.deepEqual(await exits(), []);
      assert.equal(await win.evaluate(() => window.restartLeaveCalls), 0);
      assert.equal(await win.evaluate(() => document.body.inert), false);
      await win.evaluate(() => { window.restartSaveFail = false; });
      await win.click('#update-notice button');
      await win.waitForFunction(async () => (await window.ohdap.getBook(window.restartBook.id)).name === '저장된 새 제목');
      await waitExits(1);
      assert.equal(await win.evaluate(() => window.restartLeaveCalls), 0);
    });

    await t.test('백그라운드 내보내기와 인식 결과 저장 실패는 보류, 모두 저장 후 재시작', async () => {
      const { PDFDocument, StandardFonts } = require('pdf-lib');
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      pdf.addPage([400, 500]).drawText('1. Find x: x + 1 = 2.', { x: 30, y: 440, size: 18, font });
      const source = join(userData, 'problem.pdf');
      const output = join(userData, 'result.hwpx');
      writeFileSync(source, await pdf.save());
      await app.evaluate(({ ipcMain, dialog }, output) => {
        globalThis.restartTest.transcriptFail = true;
        const save = ipcMain._invokeHandlers.get('books:saveTranscripts');
        ipcMain.removeHandler('books:saveTranscripts');
        ipcMain.handle('books:saveTranscripts', (...args) => {
          if (globalThis.restartTest.transcriptFail) throw new Error('시험용 인식 결과 저장 실패');
          return save(...args);
        });
        ipcMain.removeHandler('ai:generate');
        ipcMain.handle('ai:generate', async () => {
          await new Promise((r) => setTimeout(r, 1500));
          return { ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ blocks: [{ type: 'para', text: '$x+1=2$' }] }) }] } }] } };
        });
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
      }, output);
      await win.evaluate(async (source) => {
        const { api, state, nav } = await import('./js/shared.js');
        const { newDoc } = await import('./js/store.js');
        const book = window.restartBook;
        const files = await api.importFiles(book.id, 'problem', [source]);
        book.docs.problem = newDoc('problem', files);
        Object.assign(book.docs.problem, { pageCount: 1, analyzedAt: Date.now(), items: [{ id: 'q1', number: '1', prefix: '', page: 0, rects: [{ page: 0, x: 0.05, y: 0.05, w: 0.9, h: 0.3 }] }] });
        await api.saveBook(book);
        state.settings = await api.setSettings({ aiEnabled: true, aiProvider: 'gemini', aiSource: 'personal', geminiApiKey: 'test-key' });
        const note = await api.createNote({ title: '내보내기 시험', bookIds: [book.id] });
        window.restartNoteId = note.id;
        note.selected[book.id] = ['q1'];
        note.exportOptions = { format: 'hwpx', convert: 'ai' };
        await api.saveNote(note);
        await nav.note(note.id);
      }, source);
      await win.click('.export-btn[data-mode="problems"]');
      await win.click('.gem-modal .modal-footer .btn:has-text("다른 일 하면서 기다리기")');
      await win.waitForSelector('.toast:has-text("한글 문서가 준비됐어요")', { timeout: 15000 });
      assert.equal(await win.evaluate(async () => (await import('./js/shared.js')).restartGuard.getState().pendingSaves), true);
      await win.click('#update-notice button');
      assert.deepEqual(await exits(), [75]);
      assert.equal(existsSync(output), false);
      await win.click('.toast .toast-actions .btn:has-text("저장하기")');
      await win.waitForSelector('.toast:has-text("저장했어요")');
      assert.equal(existsSync(output), true);
      assert.equal(await win.evaluate(async () => (await import('./js/shared.js')).restartGuard.getState().pendingSaves), true);
      await app.evaluate(() => { globalThis.restartTest.transcriptFail = false; });
      await win.click('#update-notice button');
      await win.waitForFunction(async () => !(await import('./js/shared.js')).restartGuard.getState().pendingSaves);
      await waitExits(2);
      const stored = await win.evaluate(() => window.ohdap.getTranscripts(window.restartBook.id));
      assert.ok(Object.keys(stored.items).length > 0);
    });

    await t.test('제목을 입력한 직후 버튼을 누르면 변경 확정·예약 저장까지 완료', async () => {
      await win.fill('.title-input', '재시작 직전 새 제목');
      await win.click('#update-notice button');
      await win.waitForFunction(async () => (await window.ohdap.getNote(window.restartNoteId)).title === '재시작 직전 새 제목');
      await waitExits(3);
    });

    await t.test('한 쪽 꼼꼼히 다시 찾기도 재시작 차단, 오류 후 작업 상태 해제', async () => {
      await win.evaluate(async () => {
        const { nav } = await import('./js/shared.js');
        await nav.book(window.restartBook.id, { tab: 'review', page: 0 });
      });
      await win.waitForSelector('.editor-toolbar');
      await win.evaluate(async () => {
        const { getSources } = await import('./js/shared.js');
        const source = (await getSources(window.restartBook)).problem;
        const render = source.renderPage;
        source.renderPage = () => new Promise((_resolve, reject) => {
          window.endDeepTest = () => { source.renderPage = render; reject(new Error('시험용 다시 찾기 실패')); };
        });
      });
      await win.click('.editor-toolbar button:has-text("꼼꼼히 다시 찾기")');
      await win.waitForFunction(() => !!window.endDeepTest);
      assert.equal(await win.evaluate(async () => (await import('./js/shared.js')).restartGuard.getState().busy), true);
      await win.click('#update-notice button');
      assert.deepEqual(await exits(), [75, 75, 75]);
      await win.evaluate(() => window.endDeepTest());
      await win.waitForFunction(async () => !(await import('./js/shared.js')).restartGuard.getState().busy);
    });

    await t.test('최소화 뒤 유휴 시간이 지나면 자동으로 동일 안전 경로 실행', async () => {
      await app.evaluate(() => { globalThis.restartTest.now = Date.now() + 1000; });
      await win.waitForFunction(async () => !(await import('./js/shared.js')).restartGuard.getState().busy);
      await win.evaluate(async () => {
        (await import('./js/shared.js')).restartGuard.report();
        await window.ohdap.appInfo();
      });
      await app.evaluate(async ({ BrowserWindow }) => {
        globalThis.restartTest.now = Date.now() + 1000;
        const window = BrowserWindow.getAllWindows()[0];
        await new Promise((resolve) => { window.once('minimize', resolve); window.minimize(); });
      });
      await app.evaluate(({ BrowserWindow }) => {
        globalThis.restartTest.now += 2 * 60 * 1000;
        BrowserWindow.getAllWindows()[0].emit('minimize');
      });
      await win.waitForFunction(() => !document.body.inert);
      await waitExits(4);
    });
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});
