// 설치 파일에 넣을 수식 인식 모델(Pix2Text MFR-1.5, MIT)을 build/models 에 받아 둡니다.
// 저장소에는 올리지 않고(.gitignore), electron-builder 가 extraResources 로 resources/models 에 넣습니다.
// (npm run dist · 배포 워크플로가 빌드 전에 실행. 이미 받아 둔 파일은 크기·sha256 이 맞으면 건너뜀)
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { installModel, modelStatus, MODEL_REPO, MODEL_REVISION } = createRequire(import.meta.url)(join(root, 'src', 'main', 'mathocr.js'));
const dir = join(root, 'build', 'models', 'pix2text-mfr-1.5');

let shown = -10;
await installModel({
  dir,
  onProgress: ({ file, percent }) => {
    if (percent < shown + 10) return;
    shown = percent;
    console.log(`[fetch-model] ${percent}% (${file})`);
  },
});
const st = modelStatus(dir);
if (!st.installed) throw new Error(`[fetch-model] 모델 파일이 맞지 않습니다: ${dir}`);

// 모델 저장소에는 라이선스 파일이 없어서(모델 카드에 MIT 로만 적힘) Pix2Text 의 MIT 라이선스를 함께 넣음
writeFileSync(
  join(dir, 'LICENSE.txt'),
  `Pix2Text MFR-1.5 — https://huggingface.co/${MODEL_REPO} (revision ${MODEL_REVISION})
Pix2Text — https://github.com/breezedeus/Pix2Text

MIT License

Copyright (c) 2022 BreezeDeus

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
);
console.log(`[fetch-model] 준비됨: ${dir} (${Math.round(st.bytes / 1e6)}MB)`);
