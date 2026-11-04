// 실행: node test/e2e/hwpeqview-sample.mjs [--screenshot]
// 그림은 기존 Playwright 연결과 설치된 Electron으로 생성합니다. 새 패키지는 설치하지 않습니다.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eqToMathML, parseEq } from '../../src/renderer/js/hwpeqview.js';

const OUT = fileURLToPath(new URL('./out/', import.meta.url));
const HTML = join(OUT, 'hwpeqview.html');
const PNG = join(OUT, 'hwpeqview.png');
const PROFILE = join(OUT, 'hwpeqview-profile');
const samples = [
  ['근의 공식', 'x={{-b +- sqrt {b^2-4ac}} over {2a}}'],
  ['연분수', '{1} over {1+{{1} over {2+{{1} over {x}}}}}'],
  ['조합·선 없는 분수', 'LEFT ( n atop r RIGHT ) = binom n r'],
  ['중첩 근호', 'sqrt {a sqrt {a sqrt {a}}}'],
  ['거듭제곱근', 'root {3} of {x^2+y^2}'],
  ['첨자 순서·겹침', 'x_1^2+x^2_1+x^{a^b}'],
  ['왼쪽 첨자', 'C lsub n sub r = {{n!} over {r!(n-r)!}}'],
  ['합·범위 호환', 'sum from {k=1} to n {k^2} = {{n(n+1)(2n+1)} over 6}'],
  ['곱·큰 집합', 'prod _{i=1} ^n a_i ~ union _{i=1} ^n A_i'],
  ['정적분', 'int _0 ^1 {x^2} dx = {{1} over {3}}'],
  ['적분 종류', 'oint _C f(z) dz ~ dint _D f ~ tint _V f ~ odint ~ otint'],
  ['극한', 'lim _{x -> 0} {{sin x} over {x}} = 1'],
  ['삼각함수', 'sin ^2 theta + cos ^2 theta = 1'],
  ['로그', 'log _{sqrt {2}} 8 = 6'],
  ['늘어나는 괄호', 'LEFT [ {1+x} over {1-x} RIGHT ]_a^b'],
  ['보이지 않는 왼쪽 괄호', 'LEFT . {x^3} over 3 RIGHT |_0^1'],
  ['경우', 'f(x)=cases {x^2 & x>=0 # -x & x<0}'],
  ['행렬', 'matrix {a&b#c&d}'],
  ['소괄호 행렬', 'pmatrix {1&2#3&4}'],
  ['대괄호 행렬', 'bmatrix {a&0#0&a}'],
  ['행렬식', 'dmatrix {a&b#c&d}=ad-bc'],
  ['쌓기 정렬', 'lpile {a+b#c} ~ pile {a+b#c} ~ rpile {a+b#c}'],
  ['수식 줄 맞춤', 'eqalign {a+b &= c # 2a &= c-b # a &= {{c-b} over 2}}'],
  ['열 단위 행렬', 'matrix {lcol {a+b#c} rcol {d#e+f}}'],
  ['선·벡터·호', 'bar {AB} ~ vec {a} ~ dyad {AB} ~ arch {ABC} ~ under {x+y}'],
  ['장식 전체', 'hat x ~ check x ~ tilde x ~ acute x ~ grave x ~ dot x ~ ddot x'],
  ['그리스 문자', 'alpha+beta=gamma ~ pi ~ PI ~ theta ~ Theta ~ vartheta ~ phi ~ varphi'],
  ['집합·논리', 'forall x in A ~ x notin B ~ A subseteq B cup C ~ therefore A cap B != emptyset'],
  ['화살표·관계 설명', 'larrow ~ LARROW ~ lrarrow ~ LRARROW ~ A rel -> {+2} {-5} B'],
  ['글꼴·색·크기', '{rm AB} ~ {it AB} ~ {bold AB12} ~ {rmbold AB12} ~ COLOR {200,30,40}{x} ~ size 18 {y}'],
  ['한글·안전한 따옴표', '"넓이" = {{a times h} over 2} ~ "<script>alert(1)</script>"'],
  ['불완전 입력 복구', 'sqrt {x} + mystery + (a] + {끝나지 않은 식'],
];

const escapeHTML = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function writeSample() {
  mkdirSync(OUT, { recursive: true });
  const cards = samples.map(([title, script], i) => {
    const tree = parseEq(script);
    return `<article><h2>${i + 1}. ${escapeHTML(title)}${tree.error ? ' <small>복구 예시</small>' : ''}</h2><div class="formula">${eqToMathML(script, { display: true })}</div><pre>${escapeHTML(script)}</pre></article>`;
  }).join('\n');
  writeFileSync(HTML, `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>한글 수식 · MathML 표시 샘플</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: #f4f6fa; color: #172338; font-family: 'Malgun Gothic', sans-serif; }
  header { margin-bottom: 24px; }
  h1 { margin: 0 0 10px; font-size: 28px; }
  header p { margin: 0; color: #526278; }
  main { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  article { padding: 20px; background: white; border: 1px solid #dce2eb; border-radius: 12px; }
  h2 { margin: 0; font-size: 16px; }
  small { font-size: 11px; color: #9c4725; }
  .formula { min-height: 120px; display: flex; align-items: center; justify-content: center; overflow-x: auto; padding: 18px 2px; }
  math { font-family: 'Cambria Math', math; font-size: 25px; }
  pre { margin: 0; padding: 12px; background: #f1f4f8; color: #526278; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 Consolas, 'Malgun Gothic', monospace; }
</style></head><body><header><h1>한글 수식 → MathML</h1><p>32개 예시 · Chromium 내장 표시 · 마지막 카드는 오류 복구 예시</p></header><main>${cards}</main></body></html>
`, 'utf8');
  console.log(`HTML: ${HTML}`);
}

writeSample();
if (process.argv.includes('--screenshot')) {
  const { _electron } = await import('../lib/playwright.mjs');
  const require = createRequire(import.meta.url);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // 프로필·로그·캐시는 작업 폴더 아래에만 둡니다. 실제 앱의 사용자 자료는 열지 않습니다.
  // Electron 메인은 CJS로 고정해 저장소의 브라우저용 ESM을 메인에서 가져오지 않습니다.
  mkdirSync(PROFILE, { recursive: true });
  const main = join(OUT, 'hwpeqview-main.cjs');
  writeFileSync(main, `const { app, BrowserWindow } = require('electron');
const profile = ${JSON.stringify(PROFILE)};
for (const name of ['appData', 'userData', 'sessionData', 'crashDumps']) app.setPath(name, profile);
app.setAppLogsPath(require('node:path').join(profile, 'logs'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 1100, show: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await win.loadFile(${JSON.stringify(HTML)});
});
app.on('window-all-closed', () => app.quit());
`, 'utf8');
  const app = await _electron.launch({ executablePath: require('electron'), args: [main, `--user-data-dir=${PROFILE}`], env, timeout: 60000 });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('math');
    await page.evaluate(() => document.fonts.ready);
    const xml = samples.map(([, script]) => eqToMathML(script));
    const result = await page.evaluate(formulas => {
      const maths = [...document.querySelectorAll('math')];
      const errors = formulas.flatMap((formula, i) => {
        const doc = new DOMParser().parseFromString(formula, 'application/xml');
        return doc.querySelector('parsererror') ? [i] : [];
      });
      const visible = maths.every(math => {
        const box = math.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && math.namespaceURI === 'http://www.w3.org/1998/Math/MathML';
      });
      const fraction = document.querySelector('mfrac');
      const [numerator, denominator] = [...fraction.children].map(child => child.getBoundingClientRect());
      const rows = [...document.querySelector('mtable').children].map(row => row.getBoundingClientRect());
      return {
        count: maths.length, visible, xmlErrors: errors,
        fractionStacked: numerator.bottom <= denominator.top,
        tableStacked: rows[0].top < rows[1].top,
        tableRows: rows.map(row => ({ top: row.top, bottom: row.bottom })),
        roots: document.querySelectorAll('msqrt, mroot').length,
        injectionElements: document.querySelectorAll('script, img, iframe').length,
        textLiteral: maths.some(math => math.textContent.includes('<script>alert(1)</script>')),
      };
    }, xml);
    await page.screenshot({ path: PNG, fullPage: true });
    console.log(JSON.stringify(result));
    assert.equal(result.count, samples.length);
    assert.equal(result.visible, true);
    assert.deepEqual(result.xmlErrors, []);
    assert.equal(result.fractionStacked, true);
    assert.equal(result.tableStacked, true);
    assert.ok(result.roots >= 4);
    assert.equal(result.injectionElements, 0);
    assert.equal(result.textLiteral, true);
    console.log(`PNG: ${PNG}`);
  } finally {
    await app.close();
  }
}
