// 자동 업데이트 실제 동작 확인 (리눅스 AppImage + 로컬 업데이트 서버)
//  1) 구버전(OLD)과 새 버전(NEW) AppImage 를 미리 빌드해 둡니다:
//       npx electron-builder --linux AppImage --x64 --publish never -c.directories.output=dist-update/old
//       npx electron-builder --linux AppImage --x64 --publish never -c.directories.output=dist-update/new -c.extraMetadata.version=0.1.1
//  2) xvfb-run -a node test/update/update-e2e.mjs
// 구버전을 실행 → 로컬 서버에서 새 버전 확인·다운로드 → 설치 후 다시 실행 → 새 버전으로 켜졌는지 확인
import http from 'node:http';
import { createReadStream, statSync, readFileSync, existsSync, mkdtempSync, copyFileSync, chmodSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OLD_DIR = join(ROOT, 'dist-update/old');
const NEW_DIR = join(ROOT, 'dist-update/new');
const oldApp = readdirSync(OLD_DIR).find((f) => f.endsWith('.AppImage'));
const newYml = readFileSync(join(NEW_DIR, 'latest-linux.yml'), 'utf8');
const newVersion = /version:\s*(\S+)/.exec(newYml)[1];
let requests = [];

// Range 요청을 지원하는 간단한 정적 서버
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = join(NEW_DIR, name);
  requests.push(`${req.method} /${name} ${req.headers.range || ''}`);
  if (!file.startsWith(NEW_DIR) || !existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  const size = statSync(file).size;
  const type = extname(file) === '.yml' ? 'text/yaml' : 'application/octet-stream';
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = +m[1];
    const end = m[2] ? +m[2] : size - 1;
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    createReadStream(file).pipe(res);
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const feed = `http://127.0.0.1:${server.address().port}/`;

const work = mkdtempSync(join(tmpdir(), 'ohdap-update-'));
const appPath = join(work, 'OhdapNote.AppImage');
copyFileSync(join(OLD_DIR, oldApp), appPath);
chmodSync(appPath, 0o755);
const userData = join(work, 'userdata');
const logFile = join(userData, 'update-test.log');
const sha = (f) => createHash('sha512').update(readFileSync(f)).digest('base64');
const before = sha(appPath);

console.log(`구버전: ${oldApp} → 새 버전 ${newVersion} (서버 ${feed})`);
const child = spawn(appPath, ['--no-sandbox'], {
  // 이 테스트 컨테이너는 root 라서 샌드박스를 끔(다시 켜지는 새 버전에도 전달되도록 환경 변수로)
  env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', APPIMAGE_EXTRACT_AND_RUN: '1', OHDAP_UPDATE_URL: feed, OHDAP_UPDATE_TEST: '1', OHDAP_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '0' },
  stdio: 'ignore',
  detached: true,
});
child.unref();

const deadline = Date.now() + 240000;
let ok = false;
let text = '';
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  if (text.includes(`start ${newVersion}`)) {
    ok = true;
    break;
  }
}
const lines = text.trim().split('\n').map((l) => l.replace(/^\S+ /, '').slice(0, 160));
console.log('— 앱 기록 —');
lines.forEach((l) => console.log('  ' + l));
console.log('— 서버 요청 —');
requests.slice(0, 8).forEach((r) => console.log('  ' + r));
const after = existsSync(appPath) ? sha(appPath) : '(없음)';
const expected = /sha512:\s*(\S+)/.exec(newYml)[1];
console.log(`AppImage 파일 교체: ${before !== after ? '예' : '아니오'}, 새 버전 파일과 일치: ${after === expected ? '예' : '아니오'}`);
// 새로 켜진 앱 종료
try {
  process.kill(-child.pid);
} catch {
  /* 이미 종료 */
}
spawn('pkill', ['-f', work]);
spawn('pkill', ['-f', ['appimage', 'extracted'].join('_') + '_']);
server.close();
console.log(ok ? `✅ 자동 업데이트 성공: ${newVersion} 으로 다시 실행됨` : '❌ 자동 업데이트 실패');
process.exit(ok ? 0 : 1);
