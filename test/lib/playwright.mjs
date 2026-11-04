// 테스트용: 전역(사전 설치) 또는 로컬 playwright 를 불러옵니다.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/node-tools/node_modules/playwright');
}
export const { _electron } = pw;

// Playwright 브라우저를 받아 두지 않은 PC 에서는 받아 둔 전체 Chromium, 그것도 없으면 설치된 Chrome 으로 띄움 (임시 프로필)
export const chromium = {
  async launch(opts = {}) {
    let last;
    for (const channel of opts.channel ? [opts.channel] : [undefined, 'chromium', 'chrome']) {
      try {
        return await pw.chromium.launch(channel ? { ...opts, channel } : opts);
      } catch (err) {
        if (!/Executable doesn't exist|is not found at|Chromium distribution .* is not found/.test(err.message)) throw err;
        last = err;
      }
    }
    throw last;
  },
};
