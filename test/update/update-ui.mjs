// 업데이트 알림 화면 확인: 구버전 앱(패키징본)을 띄워 로컬 서버의 새 버전을 받게 하고 화면을 캡처
// 먼저 update-e2e.mjs 주석의 방법으로 dist-update/old, dist-update/new 를 빌드해 두세요.
// 실행: xvfb-run -a node test/update/update-ui.mjs
import http from 'node:http';
import { createReadStream, statSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '../lib/playwright.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const NEW_DIR = join(ROOT, 'dist-update/new');
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });
const server = http.createServer((req, res) => {
  const file = join(NEW_DIR, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(NEW_DIR) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-length': statSync(file).size });
  createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const app = await electron.launch({
  executablePath: join(ROOT, 'dist-update/old/linux-unpacked/ohdapnote'),
  args: ['--no-sandbox'],
  env: {
    ...process.env,
    OHDAP_UPDATE_URL: `http://127.0.0.1:${server.address().port}/`,
    APPIMAGE: join(tmpdir(), 'fake-ohdap.AppImage'), // 리눅스 업데이터 활성화용(설치는 하지 않음)
    OHDAP_USER_DATA: mkdtempSync(join(tmpdir(), 'ohdap-ui-')),
    ELECTRON_DISABLE_SANDBOX: '1',
  },
});
const win = await app.firstWindow();
let ok = false;
try {
  await win.waitForSelector('.update-badge .btn', { timeout: 120000 });
  await win.waitForTimeout(800);
  await win.screenshot({ path: join(OUT, 'update-1-ready.png') });
  await win.click('#settings-btn');
  await win.waitForSelector('.update-card .uc-notes');
  await win.waitForTimeout(500);
  await win.screenshot({ path: join(OUT, 'update-2-settings.png') });
  const txt = await win.$eval('.update-card', (e) => e.innerText);
  console.log(txt);
  ok = txt.includes('0.1.1') && txt.includes('준비 완료');
} catch (err) {
  console.error(err);
  await win.screenshot({ path: join(OUT, 'update-fail.png') }).catch(() => {});
}
await app.close();
server.close();
console.log(ok ? '✅ 업데이트 알림·설정 카드 확인' : '❌ 실패');
process.exit(ok ? 0 : 1);
