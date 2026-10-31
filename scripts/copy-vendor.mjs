// node_modules 에 있는 브라우저용 라이브러리를 src/renderer/vendor 로 복사합니다.
// (npm install 시 postinstall 로 자동 실행)
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => join(root, 'node_modules', ...p);
const out = (...p) => join(root, 'src', 'renderer', 'vendor', ...p);

if (!existsSync(nm('pdfjs-dist'))) {
  console.log('[copy-vendor] devDependencies 가 없어 건너뜁니다.');
  process.exit(0);
}

rmSync(out(), { recursive: true, force: true });
mkdirSync(out('pdfjs'), { recursive: true });
mkdirSync(out('tesseract', 'core'), { recursive: true });
mkdirSync(out('tesseract', 'lang'), { recursive: true });

const copies = [
  [nm('pdfjs-dist', 'build', 'pdf.min.mjs'), out('pdfjs', 'pdf.min.mjs')],
  [nm('pdfjs-dist', 'build', 'pdf.worker.min.mjs'), out('pdfjs', 'pdf.worker.min.mjs')],
  [nm('pdfjs-dist', 'cmaps'), out('pdfjs', 'cmaps')],
  [nm('pdfjs-dist', 'standard_fonts'), out('pdfjs', 'standard_fonts')],
  [nm('pdfjs-dist', 'wasm'), out('pdfjs', 'wasm')],
  [nm('pdfjs-dist', 'iccs'), out('pdfjs', 'iccs')],
  [nm('pdf-lib', 'dist', 'pdf-lib.esm.min.js'), out('pdf-lib.esm.min.js')],
  [nm('tesseract.js', 'dist', 'tesseract.esm.min.js'), out('tesseract', 'tesseract.esm.min.js')],
  [nm('tesseract.js', 'dist', 'worker.min.js'), out('tesseract', 'worker.min.js')],
  [nm('@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), out('tesseract', 'lang', 'eng.traineddata.gz')],
  [nm('@tesseract.js-data', 'kor', '4.0.0_best_int', 'kor.traineddata.gz'), out('tesseract', 'lang', 'kor.traineddata.gz')],
];
for (const variant of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
  copies.push([nm('tesseract.js-core', `tesseract-core-${variant}.wasm.js`), out('tesseract', 'core', `tesseract-core-${variant}.wasm.js`)]);
}
for (const [from, to] of copies) cpSync(from, to, { recursive: true });
console.log(`[copy-vendor] ${copies.length}개 항목 복사 완료 → src/renderer/vendor`);
