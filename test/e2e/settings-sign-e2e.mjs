// 설정 서명 E2E: 통합 클라우드가 서명 키(MAGOEDU_DATA_KEY)를 주면 settings.json 을 서명해서 쓰고,
// 앱 밖에서 고친 파일은 적용하지 않고 되돌림 (켜 둔 채 / 꺼져 있는 동안). 키는 화면·환경 변수에 남기지 않음.
// 키가 없으면(예전 통합 클라우드) 예전처럼. 개발 실행: userData = 이 컴퓨터 폴더, userData/data = 동기화 폴더
// 실행: xvfb-run -a node test/e2e/settings-sign-e2e.mjs
import { _electron as electron } from '../lib/playwright.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { verify } = require('../../src/main/datasign.js');
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const userData = mkdtempSync(join(tmpdir(), 'ohdap-sign-'));
const settingsFile = join(userData, 'data', 'settings.json');
const KEY = 'e2e-Data-Key_0123456789abcdefghijklmnopqrstu';
const REJECTED = '앱 밖에서 바꾼 설정이라 적용하지 않았어요';

const launch = (key = KEY) =>
  electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', ROOT],
    env: { ...process.env, OHDAP_E2E: '1', OHDAP_USER_DATA: userData, MAGOEDU_DATA_KEY: key },
  });
const step = (s) => console.log(`▶ ${s}`);
const errors = [];
let app;
let win;
const open = async (key) => {
  app = await launch(key);
  win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForSelector('.seg-tab[data-tab="books"]', { timeout: 20000 });
};
const toastShown = () => win.evaluate((t) => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(t)), REJECTED);
const waitToast = () => win.waitForFunction((t) => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(t)), REJECTED, { timeout: 10000 });
const settings = () => win.evaluate(() => window.ohdap.getSettings());
const signed = () => verify(readFileSync(settingsFile), KEY);

try {
  step('예전 버전이 쓴 서명 없는 설정 → 이 컴퓨터에서 처음 한 번 받아들이고 서명해 둠');
  mkdirSync(join(userData, 'data'), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ teacher: '예전선생', motion: 'reduce' }));
  await open();
  if ((await settings()).teacher !== '예전선생') throw new Error('서명 없는 예전 설정을 받아들이지 않음');
  if (!signed()) throw new Error('받아들인 설정을 서명해 두지 않음');
  if (await toastShown()) throw new Error('예전 설정인데 알림이 뜸');
  if (!existsSync(join(userData, 'settings.verified.json'))) throw new Error('이 컴퓨터 표시가 없음');
  // 키는 화면·하위 프로세스로 넘기지 않음
  const seen = JSON.stringify([await win.evaluate(() => window.ohdap.appInfo()), await settings()]);
  if (seen.includes(KEY)) throw new Error('화면에 키가 보임');
  if (await app.evaluate(() => process.env.MAGOEDU_DATA_KEY)) throw new Error('메인 프로세스 환경 변수에 키가 남아 있음');
  if ([readFileSync(settingsFile, 'utf8'), readFileSync(join(userData, 'settings.verified.json'), 'utf8')].some((t) => t.includes(KEY))) throw new Error('파일에 키가 남음');

  step('앱에서 저장 → 서명해서 씀');
  await win.evaluate(() => window.ohdap.setSettings({ teacher: '김선생' }));
  if (!signed() || JSON.parse(readFileSync(settingsFile, 'utf8')).teacher !== '김선생') throw new Error('저장한 설정이 서명되지 않음');
  const good = readFileSync(settingsFile, 'utf8');

  step('켜 둔 채 settings.json 을 손으로 고침 → 알림 + 되돌림');
  await win.waitForTimeout(3500); // 방금 내가 쓴 파일의 알림은 3초 동안 건너뜀 (main.js OWN_MS)
  writeFileSync(settingsFile, good.replace('김선생', '해커'));
  await waitToast();
  await win.waitForTimeout(300);
  if (readFileSync(settingsFile, 'utf8') !== good) throw new Error('손으로 고친 설정이 되돌려지지 않음');
  if ((await settings()).teacher !== '김선생') throw new Error('손으로 고친 설정이 적용됨');

  step('꺼져 있는 동안 고침(서명을 지움) → 다시 켜면 알림 + 되돌림');
  await app.close();
  writeFileSync(settingsFile, JSON.stringify({ teacher: '해커' }));
  await open();
  await waitToast();
  if ((await settings()).teacher !== '김선생') throw new Error('다시 켰을 때 손으로 고친 설정이 적용됨');
  if (!signed() || JSON.parse(readFileSync(settingsFile, 'utf8')).teacher !== '김선생') throw new Error('다시 켰을 때 되돌려지지 않음');

  step('키 없이(예전 통합 클라우드) 켜면 예전처럼: 서명 없이 쓰고, 고친 파일도 그대로');
  await app.close();
  writeFileSync(settingsFile, JSON.stringify({ teacher: '키없음' }));
  await open('');
  await win.waitForTimeout(500);
  if ((await settings()).teacher !== '키없음') throw new Error('키가 없는데 설정을 거부함');
  if (await toastShown()) throw new Error('키가 없는데 알림이 뜸');
  await win.evaluate(() => window.ohdap.setSettings({ motion: 'full' }));
  if ('sig' in JSON.parse(readFileSync(settingsFile, 'utf8'))) throw new Error('키가 없는데 서명함');
  console.log('✅ 설정 서명 E2E 통과');
} catch (err) {
  console.error('❌ 설정 서명 E2E 실패:', err);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}
if (errors.length) {
  console.log('renderer errors:', errors);
  process.exitCode = 1;
}
