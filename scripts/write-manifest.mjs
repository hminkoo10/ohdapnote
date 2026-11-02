// 통합 클라우드용 묶음: 빌드한 폴더(dist/win-unpacked)에 magoedu-app.json 을 지금 버전으로 넣습니다.
// 그다음 폴더 안의 파일을 zip 으로 묶어 OhdapNote-<버전>-win-x64.zip 으로 Release 에 올리면 통합 클라우드가 설치·업데이트합니다.
// (npm run dist · 배포 워크플로가 electron-builder 다음에 실행. 형식은 MagoEdu docs/INTEGRATION.md)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'win-unpacked');
if (!existsSync(join(out, 'OhdapNote.exe'))) {
  console.error('[write-manifest] dist/win-unpacked/OhdapNote.exe 가 없습니다. electron-builder --win dir 를 먼저 실행해 주세요.');
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = { ...JSON.parse(readFileSync(join(root, 'magoedu-app.json'), 'utf8')), version };
writeFileSync(join(out, 'magoedu-app.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[write-manifest] ${version} → dist/win-unpacked/magoedu-app.json`);
