// lucide-static 에서 필요한 아이콘만 골라 src/renderer/js/icons.js 로 만듭니다.
// 사용: node scripts/build-icons.mjs   (lucide-static 은 개발용 의존성)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP = {
  back: 'arrow-left',
  gear: 'settings-2',
  plus: 'plus',
  upload: 'file-up',
  download: 'download',
  trash: 'trash-2',
  left: 'chevron-left',
  right: 'chevron-right',
  scan: 'scan-line',
  sparkle: 'sparkles',
  box: 'square-dashed',
  warn: 'triangle-alert',
  check: 'check',
  circleCheck: 'circle-check',
  eye: 'eye',
  edit: 'pencil',
  book: 'book-open',
  bookCheck: 'book-check',
  x: 'x',
  zoomIn: 'zoom-in',
  zoomOut: 'zoom-out',
  refresh: 'refresh-cw',
  folder: 'folder-open',
  note: 'notebook-pen',
  files: 'file-stack',
  file: 'file-text',
  images: 'images',
  search: 'search',
  wand: 'wand-sparkles',
  collapse: 'panel-top-close',
  expand: 'panel-top-open',
  pointer: 'mouse-pointer-click',
};
const out = {};
for (const [name, file] of Object.entries(MAP)) {
  const svg = readFileSync(join(root, 'node_modules/lucide-static/icons', `${file}.svg`), 'utf8');
  out[name] = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .replace(/\s*\n\s*/g, '')
    .trim();
}
const body = `// 자동 생성 파일 (scripts/build-icons.mjs) — 손으로 고치지 마세요.
// 아이콘: Lucide (https://lucide.dev) — ISC License, Copyright (c) Lucide Contributors
export const ICONS = ${JSON.stringify(out, null, 2)};
`;
writeFileSync(join(root, 'src/renderer/js/icons.js'), body);
console.log(`icons.js: ${Object.keys(out).length}개`);
