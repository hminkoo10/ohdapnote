// build/icon.svg → build/icon.png(512) + build/icon.ico (Chromium 으로 렌더링, ICO 는 Pillow)
// 사용: node scripts/build-app-icon.mjs  (개발용: Playwright Chromium, python3+Pillow 필요)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '../test/lib/playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'build/icon.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`);
const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await browser.close();
const big = join(root, 'build/icon-1024.png');
writeFileSync(big, png);
execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open(${JSON.stringify(big)}).convert('RGBA')
im.resize((512, 512), Image.LANCZOS).save(${JSON.stringify(join(root, 'build/icon.png'))})
im.save(${JSON.stringify(join(root, 'build/icon.ico'))}, sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
`]);
console.log('build/icon.png, build/icon.ico 생성');
