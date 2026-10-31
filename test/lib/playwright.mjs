// 테스트용: 전역(사전 설치) 또는 로컬 playwright 를 불러옵니다.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/node-tools/node_modules/playwright');
}
export const { chromium, _electron } = pw;
