'use strict';

// 수식 인식 (AI 없이 내 컴퓨터에서) — Pix2Text 의 수식 인식 모델 MFR-1.5 (MIT) 를 onnxruntime-node 로 실행
// - 앱에서는 메인 프로세스가 아니라 utilityProcess(mathocr-worker.js) 안에서 돌립니다(계산하는 동안 창·IPC 가 멈추지 않게).
// - 모델 파일은 처음 한 번 Hugging Face 에서 받아 <userData>/models/pix2text-mfr-1.5/ 에 둡니다(고정한 커밋, 크기·sha256 확인).
// - 전처리·디코딩·후처리는 Python Pix2Text(LatexOCR + TrOCRProcessor) 와 같은 글자가 나오도록 그대로 옮겼습니다.
//   · 그림: RGB 로 바꾼 뒤 Pillow BICUBIC 으로 384×384 (Pillow 의 정수 계산까지 똑같이), /255, (x-0.5)/0.5
//   · 디코딩: 가장 높은 토큰을 고르는 greedy (디코더에 KV 캐시가 없어 매 단계 전체 길이를 다시 돌림)
//   · 토큰 → 글자: tokenizer.json 의 ByteLevel BPE, 특수 토큰 뺌 → Pix2Text post_process
// - Electron 없이 Node 에서도 씁니다(평가 스크립트 등):
//
//     const { createMathOcr, installModel, modelStatus } = require('./mathocr');
//     await installModel({ dir, onProgress: (p) => console.log(p.percent), signal });   // 이미 있으면 확인만
//     const ocr = createMathOcr({ modelDir: dir, threads: 4 });                          // 세션은 처음 쓸 때 만듦
//     const [{ latex, ms, conf, truncated }] = await ocr.recognize([{ data: rgba, width, height }], { signal, maxTokens: 256 });
//     await ocr.close();
//
//   images[].data: RGBA 화소(Uint8Array | Uint8ClampedArray, 캔버스의 ImageData.data 그대로)
//   conf: { mean: 토큰 확률의 기하평균, min: 가장 낮은 토큰 확률, n: 토큰 수 } — 특수 토큰(<s>, </s> 등)은 뺌
//   maxTokens: 한 수식에서 만들 토큰 수 한도(기본 256, 최대 1024). 한도에서 끊긴 결과는 truncated: true (대개 수식이 아닌 상자)

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { once } = require('node:events');

// ---------------------------------------------------------------------------
// 모델 파일
// ---------------------------------------------------------------------------

const MODEL_REPO = 'breezedeus/pix2text-mfr-1.5';
const MODEL_REVISION = '1cef9f0bdcd6a4c63df7de1311fb0894593340cc'; // 2025-07-25 커밋 (main)
// 실행에 필요한 파일만. 나머지 설정 값(config.json 등)은 아래 상수로 옮겨 둠
const MODEL_FILES = [
  { name: 'encoder_model.onnx', size: 87510770, sha256: '080a3f660f08bc9ebcacdd96e34be6b6400f8c7e62d7cd0dd8251badc37f610b' },
  { name: 'decoder_model.onnx', size: 32026253, sha256: '917deb98e91a0453c5f234f58a0f32f9fb037de8527c7eb4ed394daf9e692f2a' },
  { name: 'tokenizer.json', size: 113168, sha256: '4ffbeb2143e6a38324bb6111b7a8109530d38a076a8439aa5777535f0a32758a' },
];
const MODEL_BYTES = MODEL_FILES.reduce((sum, f) => sum + f.size, 0);
const fileUrl = (name) => `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${name}`;

// generation_config.json / config.json / preprocessor_config.json (위 커밋) 의 값
const START_ID = 1; // decoder_start_token_id
const EOS_ID = 2; // eos_token_id
const MAX_NEW_TOKENS = 1024; // max_new_tokens (maxTokens 의 최대)
// 문제집 스캔 수식 126개에서 모델이 만든 토큰은 가장 긴 것이 97개(Σ 넷을 이은 줄) — 그 몇 배를 넘는 것은 수식이 아닌 상자(그래프 등)
const DEFAULT_MAX_TOKENS = 256;
const SPECIAL_IDS = new Set([0, 1, 2, 3, 4]); // <pad> <s> </s> <unk> <mask>
const SIZE = 384; // size {384, 384}, resample 3 (BICUBIC)
const RESCALE = 0.00392156862745098; // rescale_factor (1/255)

/** 받아 둔 모델 상태: 파일이 다 있고 크기가 맞으면 installed */
function modelStatus(dir) {
  let bytes = 0;
  let installed = true;
  for (const f of MODEL_FILES) {
    try {
      const st = fs.statSync(path.join(dir, f.name));
      bytes += st.size;
      if (st.size !== f.size) installed = false;
    } catch {
      installed = false;
    }
  }
  return { installed, dir, bytes };
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const abortError = () => Object.assign(new Error('취소했어요.'), { name: 'AbortError' });

/**
 * 모델 받기: 파일마다 .part 로 받아 크기·sha256 을 확인한 뒤 이름을 바꿈. 이미 맞는 파일은 건너뜀
 * @param {{dir:string, onProgress?:(p:{file:string, received:number, total:number, percent:number})=>void,
 *          signal?:AbortSignal, fetch?:typeof fetch}} opts  Electron 에서는 net.fetch 를 넘기면 시스템 프록시를 따름
 */
async function installModel({ dir, onProgress, signal, fetch: fetchFn = globalThis.fetch } = {}) {
  if (!dir) throw new Error('모델 폴더가 없어요.');
  await fsp.mkdir(dir, { recursive: true });
  let done = 0; // 끝난 파일들의 바이트
  let lastReport = 0;
  const report = (file, received, force) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReport < 100) return;
    lastReport = now;
    const total = MODEL_BYTES;
    onProgress({ file, received: done + received, total, percent: Math.floor(((done + received) / total) * 100) });
  };

  for (const f of MODEL_FILES) {
    if (signal?.aborted) throw abortError();
    const dest = path.join(dir, f.name);
    const st = await fsp.stat(dest).catch(() => null);
    if (st?.size === f.size && (await sha256File(dest)) === f.sha256) {
      done += f.size;
      report(f.name, 0, true);
      continue;
    }
    const part = `${dest}.part`;
    try {
      const res = await fetchFn(fileUrl(f.name), { signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`${f.name} 을(를) 받지 못했어요 (HTTP ${res.status}).`);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(part);
      const closed = new Promise((resolve, reject) => {
        out.on('close', resolve);
        out.on('error', reject);
      });
      closed.catch(() => {}); // 오류는 아래 finally 에서 받음 (그 전에 처리 안 된 거부로 튀지 않게)
      let received = 0;
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          received += value.byteLength;
          if (received > f.size) throw new Error(`${f.name} 이(가) 예상보다 커요.`);
          hash.update(value);
          if (!out.write(value)) await once(out, 'drain'); // 쓰기 오류면 여기서 멈춤
          report(f.name, received);
        }
      } catch (err) {
        reader.cancel().catch(() => {});
        throw err;
      } finally {
        out.end();
        await closed;
      }
      if (received !== f.size) throw new Error(`${f.name} 을(를) 끝까지 받지 못했어요 (${received}/${f.size} 바이트).`);
      if (hash.digest('hex') !== f.sha256) throw new Error(`${f.name} 이(가) 손상됐어요 (sha256 불일치).`);
      await fsp.rename(part, dest);
      done += f.size;
      report(f.name, 0, true);
    } catch (err) {
      await fsp.rm(part, { force: true }).catch(() => {});
      if (signal?.aborted) throw abortError();
      throw err;
    }
  }
  return modelStatus(dir);
}

// ---------------------------------------------------------------------------
// 전처리: RGBA → [3, 384, 384] float32
// ---------------------------------------------------------------------------

// Pillow(Resample.c) 의 BICUBIC (a = -0.5)
function bicubic(x) {
  const a = -0.5;
  if (x < 0) x = -x;
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
  return 0;
}

const PRECISION_BITS = 32 - 8 - 2;
const ONE = 2 ** PRECISION_BITS;

/** Pillow precompute_coeffs + normalize_coeffs_8bpc: 출력 칸마다 [시작, 개수] 와 고정소수점 가중치 */
function precomputeCoeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterscale = scale < 1 ? 1 : scale;
  const support = 2 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Int32Array(outSize * ksize);
  const k = new Float64Array(ksize);
  const ss = 1 / filterscale;
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      const w = bicubic((x + xmin - center + 0.5) * ss);
      k[x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) {
      const v = ww !== 0 ? k[x] / ww : k[x];
      kk[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * ONE) : Math.trunc(0.5 + v * ONE);
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, kk };
}

const clip8 = (v) => {
  const x = v >> PRECISION_BITS;
  return x < 0 ? 0 : x > 255 ? 255 : x;
};

/** 가로 방향 한 번 (Pillow ImagingResampleHorizontal_8bpc, RGB) */
function resampleHorizontal(src, width, height, outW) {
  const { ksize, bounds, kk } = precomputeCoeffs(width, outW);
  const out = new Uint8Array(outW * height * 3);
  for (let y = 0; y < height; y++) {
    const row = y * width * 3;
    for (let xx = 0; xx < outW; xx++) {
      const xmin = bounds[xx * 2];
      const xmax = bounds[xx * 2 + 1];
      const kb = xx * ksize;
      let s0 = ONE / 2;
      let s1 = ONE / 2;
      let s2 = ONE / 2;
      for (let x = 0; x < xmax; x++) {
        const p = row + (x + xmin) * 3;
        const c = kk[kb + x];
        s0 += src[p] * c;
        s1 += src[p + 1] * c;
        s2 += src[p + 2] * c;
      }
      const o = (y * outW + xx) * 3;
      out[o] = clip8(s0);
      out[o + 1] = clip8(s1);
      out[o + 2] = clip8(s2);
    }
  }
  return out;
}

/** 세로 방향 한 번 (Pillow ImagingResampleVertical_8bpc, RGB) */
function resampleVertical(src, width, height, outH) {
  const { ksize, bounds, kk } = precomputeCoeffs(height, outH);
  const out = new Uint8Array(width * outH * 3);
  for (let yy = 0; yy < outH; yy++) {
    const ymin = bounds[yy * 2];
    const ymax = bounds[yy * 2 + 1];
    const kb = yy * ksize;
    for (let xx = 0; xx < width; xx++) {
      let s0 = ONE / 2;
      let s1 = ONE / 2;
      let s2 = ONE / 2;
      for (let y = 0; y < ymax; y++) {
        const p = ((y + ymin) * width + xx) * 3;
        const c = kk[kb + y];
        s0 += src[p] * c;
        s1 += src[p + 1] * c;
        s2 += src[p + 2] * c;
      }
      const o = (yy * width + xx) * 3;
      out[o] = clip8(s0);
      out[o + 1] = clip8(s1);
      out[o + 2] = clip8(s2);
    }
  }
  return out;
}

/**
 * RGB(3바이트) 그림을 Pillow 13 Image.resize(BICUBIC) 와 똑같이 줄이거나 늘림 (Resample.c ImagingResampleInner)
 * - 한 방향씩 두 번, 중간 결과도 8비트로 자름. 크기가 같은 방향은 건너뜀
 * - 세로를 가로보다 두 배 넘게 더 줄일 때만 세로 먼저 (Pillow 의 순서 규칙 — 순서에 따라 값이 조금 달라짐)
 */
function resizeBicubicRGB(rgb, width, height, outW, outH) {
  const needH = outW !== width;
  const needV = outH !== height;
  const horizontalFirst = !(height - outH > 0 && height - outH > (width - outW) * 2);
  let img = rgb;
  if (horizontalFirst) {
    if (needH) img = resampleHorizontal(img, width, height, outW);
    if (needV) img = resampleVertical(img, outW, height, outH);
  } else {
    if (needV) img = resampleVertical(img, width, height, outH);
    if (needH) img = resampleHorizontal(img, width, outH, outW);
  }
  return img === rgb ? Uint8Array.from(rgb) : img;
}

// 8비트 값 → 모델 입력: numpy 와 같은 순서로 float32 반올림 (float64 *1/255 → float32, -0.5, /0.5)
const NORM = new Float32Array(256);
for (let v = 0; v < 256; v++) NORM[v] = Math.fround(Math.fround(Math.fround(v * RESCALE) - 0.5) / 0.5);

/**
 * RGBA → RGB. 반투명 화소는 흰 바탕에 얹음 (Pix2Text 는 RGB 그림만 받으므로 불투명한 그림은 그대로)
 */
function rgbaToRgb(data, width, height) {
  const n = width * height;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    for (let c = 0; c < 3; c++) {
      const v = data[i * 4 + c];
      rgb[i * 3 + c] = a === 255 ? v : Math.round((v * a + 255 * (255 - a)) / 255);
    }
  }
  return rgb;
}

/** RGBA 그림 → 인코더 입력 pixel_values (CHW float32, 3×384×384) */
function preprocess({ data, width, height }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('그림 크기가 이상해요.');
  if (!data || data.length < width * height * 4) throw new Error('그림 화소(RGBA)가 모자라요.');
  const resized = resizeBicubicRGB(rgbaToRgb(data, width, height), width, height, SIZE, SIZE);
  const plane = SIZE * SIZE;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = NORM[resized[i * 3]];
    out[plane + i] = NORM[resized[i * 3 + 1]];
    out[2 * plane + i] = NORM[resized[i * 3 + 2]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 토큰 → 글자 (tokenizer.json: BPE + ByteLevel decoder)
// ---------------------------------------------------------------------------

// GPT-2 bytes_to_unicode 의 역: 글자 → 바이트
const BYTE_OF_CHAR = (() => {
  const bs = [];
  for (let b = 0x21; b <= 0x7e; b++) bs.push(b);
  for (let b = 0xa1; b <= 0xac; b++) bs.push(b);
  for (let b = 0xae; b <= 0xff; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  const map = new Map();
  bs.forEach((b, i) => map.set(String.fromCodePoint(cs[i]), b));
  return map;
})();

// 고정 모델의 사전은 기본값을 만들 수 없으므로 원본 해시가 맞는 것만 읽음.
function sanitizeTokenizer(bytes) {
  const spec = MODEL_FILES.find((f) => f.name === 'tokenizer.json');
  if (bytes.length !== spec.size || crypto.createHash('sha256').update(bytes).digest('hex') !== spec.sha256) {
    console.info('[data] 잘못된 값 무시 (tokenizer.json)');
    return null;
  }
  return JSON.parse(bytes.toString('utf8'));
}

/** tokenizer.json(객체) → { decode(ids) } — skip_special_tokens=True, clean_up_tokenization_spaces=False */
function createTokenizer(json) {
  if (json?.model?.type !== 'BPE' || json?.decoder?.type !== 'ByteLevel') throw new Error('알 수 없는 tokenizer.json 형식이에요.');
  const idToToken = [];
  for (const [tok, id] of Object.entries(json.model.vocab)) idToToken[id] = tok;
  const special = new Set();
  for (const t of json.added_tokens || []) {
    idToToken[t.id] = t.content;
    if (t.special) special.add(t.id);
  }
  const utf8 = new TextDecoder('utf-8'); // 깨진 바이트는 U+FFFD (Rust from_utf8_lossy 와 같음)
  return {
    decode(ids) {
      const bytes = [];
      for (const id of ids) {
        if (special.has(id)) continue;
        const tok = idToToken[id];
        if (tok === undefined) continue;
        const mapped = [];
        let ok = true;
        for (const ch of tok) {
          const b = BYTE_OF_CHAR.get(ch);
          if (b === undefined) {
            ok = false;
            break;
          }
          mapped.push(b);
        }
        // ByteLevel 표에 없는 글자가 섞인 토큰은 UTF-8 그대로 (tokenizers 와 같음)
        if (ok) bytes.push(...mapped);
        else bytes.push(...Buffer.from(tok, 'utf8'));
      }
      return utf8.decode(Uint8Array.from(bytes));
    },
  };
}

// ---------------------------------------------------------------------------
// Pix2Text LatexOCR.post_process 를 그대로 (pix2text/latex_ocr.py)
// ---------------------------------------------------------------------------

// Python 의 \s (str.isspace) 와 같은 글자들 — JS 의 \s 와 조금 다름(\x1c-\x1f, \x85 포함, \ufeff 제외)
const S = '[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const SPACE_RE = new RegExp(`^${S}$`, 'u');
const re = (src, flags = 'gu') => new RegExp(src.replaceAll('\\s', S), flags);
const pyStrip = (s) => s.replace(re(`^\\s+|\\s+$`), '');

function removeRedundantScript(text) {
  let s = text.replace(re('^\\^\\s*\\{\\s*(.*?)\\s*\\}', 'u'), '$1');
  s = s.replace(re('^_\\s*\\{\\s*(.*?)\\s*\\}', 'u'), '$1');
  return pyStrip(s);
}

const LATEX_SPACES = ['\\\\ +', '\\\\quad\\s*', '\\\\qquad\\s*', '\\\\,\\s*', '\\\\:\\s*', '\\\\;\\s*', '\\\\enspace\\s*', '\\\\thinspace\\s*', '\\\\!\\s*'];
const TRAILING_SPACE_RE = re(`(?:${LATEX_SPACES.join('|')})+$`, 'u');
const removeTrailingWhitespace = (s) => pyStrip(s.replace(TRAILING_SPACE_RE, ''));

function replaceIllegalSymbols(s) {
  return s.replace(/\\\./g, '\\ .').replace(/\\=/g, '\\ =').replace(/\\-/g, '\\ -').replace(/\\~/g, '\\ ~');
}

const EMPTY_RES = ['\\\\hat', '\\^', '_', '\\\\text', '\\\\tilde', '\\\\bar', '\\\\vec', '\\\\acute', '\\\\grave', '\\\\breve', '\\\\overline', '\\\\dot', '\\\\ddot', '\\\\widehat', '\\\\widetilde'].map((p) =>
  re(`${p}\\s*\\{\\s*\\}`),
);
function removeEmptyText(s) {
  for (const r of EMPTY_RES) s = s.replace(r, '');
  return pyStrip(s);
}

const isAsciiLetter = (c) => c !== undefined && /^[A-Za-z]$/.test(c);
const isAlpha = (c) => c !== undefined && /^\p{L}$/u.test(c);
const isSpace = (c) => c !== undefined && SPACE_RE.test(c);

/** find_all_left_or_right: re.finditer(r'\\left\s*\S') 와 뒤따르는 처리 (글자 단위 = 코드 포인트) */
function findLeftOrRight(chars, word) {
  const key = ['\\', ...word];
  const prefixLen = word.length + 1;
  const infos = [];
  let i = 0;
  while (i <= chars.length - key.length) {
    if (!key.every((c, k) => chars[i + k] === c)) {
      i++;
      continue;
    }
    let j = i + key.length;
    while (j < chars.length && isSpace(chars[j])) j++;
    if (j >= chars.length) {
      i++;
      continue;
    }
    const start = i;
    let end = j + 1;
    i = end; // finditer 는 겹치지 않게 찾음
    if (isAsciiLetter(chars[end - 1])) continue;
    while (chars[end - 1] === '\\' || chars[end - 1] === ' ') {
      end += 1;
      while (end < chars.length && isAlpha(chars[end])) end += 1;
    }
    infos.push({ str: pyStrip(chars.slice(start + prefixLen, end).join('')), start, end });
  }
  return infos;
}

const MATCH_PAIRS = new Set(
  [
    ['', ''], ['(', ')'], ['\\{', '.'], ['⟮', '⟯'], ['[', ']'], ['⟨', '⟩'], ['{', '}'], ['⌈', '⌉'], ['┌', '┐'], ['⌊', '⌋'], ['└', '┘'], ['⎰', '⎱'],
    ['lt', 'gt'], ['lang', 'rang'], ['langle', 'rangle'], ['lbrace', 'rbrace'], ['lBrace', 'rBrace'], ['lbracket', 'rbracket'], ['lceil', 'rceil'],
    ['lcorner', 'rcorner'], ['lfloor', 'rfloor'], ['lgroup', 'rgroup'], ['lmoustache', 'rmoustache'], ['lparen', 'rparen'], ['lvert', 'rvert'], ['lVert', 'rVert'],
  ].map((p) => p.join('\u0000')),
);

/** match_left_right — Pix2Text 는 (right, left) 순서로 부르고 앞 글자를 잘라 내므로 그 동작 그대로 */
function matchLeftRight(leftStr, rightStr) {
  let l = [...pyStrip(leftStr).replaceAll(' ', '')].slice('left'.length + 1);
  let r = [...pyStrip(rightStr).replaceAll(' ', '')].slice('right'.length + 1);
  while (l.length && r.length && l[0] === r[0]) {
    l = l.slice(1);
    r = r.slice(1);
  }
  return MATCH_PAIRS.has(`${l.join('')}\u0000${r.join('')}`);
}

function fixLatex(latex) {
  const chars = [...latex];
  const lefts = findLeftOrRight(chars, 'left');
  const rights = findLeftOrRight(chars, 'right');
  for (const l of lefts) {
    for (const r of rights) {
      if (!r.matched && r.start > l.start && matchLeftRight(r.str, l.str)) {
        l.matched = true;
        r.matched = true;
        break;
      }
    }
  }
  // 짝이 없는 \left, \right 는 같은 길이의 빈칸으로
  for (const l of lefts) if (!l.matched) for (let k = 0; k < 5; k++) if (l.start + k < chars.length) chars[l.start + k] = ' ';
  for (const r of rights) if (!r.matched) for (let k = 0; k < 6; k++) if (r.start + k < chars.length) chars[r.start + k] = ' ';
  return pyStrip(chars.join('').replace(re('\\s+'), ' '));
}

function removeUnnecessarySpaces(s) {
  s = s.replace(/\\([a-zA-Z]+) (?=[a-zA-Z])/g, '\\$1 ');
  s = s.replace(re('\\\\([a-zA-Z]+)\\s+(?![a-zA-Z])'), '\\$1');
  s = s.replace(re('(\\{)\\s+'), '$1');
  s = s.replace(re('\\s+(\\})'), '$1');
  s = s.replace(re('(?<=[^\\\\])\\s*([+\\-=])\\s*'), '$1');
  s = s.replace(re('\\s*(\\^|_)\\s*'), '$1');
  return s;
}

/** LatexOCR.post_process */
function postProcess(text) {
  let s = removeRedundantScript(text);
  s = removeTrailingWhitespace(s);
  s = replaceIllegalSymbols(s);
  for (let i = 0; i < 10; i++) {
    const next = removeEmptyText(s);
    if (next === s) break;
    s = next;
  }
  s = fixLatex(s);
  s = removeUnnecessarySpaces(s);
  return pyStrip(s);
}

// ---------------------------------------------------------------------------
// 엔진
// ---------------------------------------------------------------------------

const defaultThreads = () => {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.min(8, Math.max(1, Math.round(cores / 2)));
};

/**
 * @param {{modelDir:string, threads?:number}} opts
 * @returns {{recognize:(images:{data:Uint8Array|Uint8ClampedArray,width:number,height:number}[], opts?:{signal?:AbortSignal, maxTokens?:number})
 *            => Promise<{latex:string, ms:number, conf:{mean:number,min:number,n:number}, truncated:boolean}[]>, close:()=>Promise<void>}}
 */
function createMathOcr({ modelDir, threads } = {}) {
  if (!modelDir) throw new Error('모델 폴더가 없어요.');
  const intraOpNumThreads = Number.isInteger(threads) && threads > 0 ? threads : defaultThreads();
  let loading = null; // Promise<{ort, encoder, decoder, tokenizer}>
  let queue = Promise.resolve(); // 한 번에 하나씩 (스레드를 서로 뺏지 않게)
  let closed = false;

  const load = () => {
    if (!loading) {
      loading = (async () => {
        const status = modelStatus(modelDir);
        if (!status.installed) throw new Error('수식 인식 모델이 아직 설치되지 않았어요.');
        const tokenFile = path.join(modelDir, 'tokenizer.json');
        const tokenSize = MODEL_FILES.find((f) => f.name === 'tokenizer.json').size;
        const json = sanitizeTokenizer((await fsp.stat(tokenFile)).size === tokenSize ? await fsp.readFile(tokenFile) : Buffer.alloc(0));
        if (!json) throw new Error('수식 인식 사전이 손상됐어요. 모델을 다시 받아 주세요.');
        const ort = require('onnxruntime-node');
        const options = { executionProviders: ['cpu'], intraOpNumThreads, interOpNumThreads: 1, graphOptimizationLevel: 'all' };
        const encoder = await ort.InferenceSession.create(path.join(modelDir, 'encoder_model.onnx'), options);
        const decoder = await ort.InferenceSession.create(path.join(modelDir, 'decoder_model.onnx'), options);
        const tokenizer = createTokenizer(json);
        return { ort, encoder, decoder, tokenizer };
      })();
      loading.catch(() => (loading = null)); // 실패하면 다음에 다시 시도
    }
    return loading;
  };

  async function recognizeOne(m, image, signal, maxTokens) {
    const t0 = performance.now();
    const pixels = preprocess(image);
    const { last_hidden_state: hidden } = await m.encoder.run({ pixel_values: new m.ort.Tensor('float32', pixels, [1, 3, SIZE, SIZE]) });
    const ids = [START_ID];
    let logSum = 0;
    let minP = 1;
    let n = 0;
    let truncated = true;
    for (let step = 0; step < maxTokens; step++) {
      if (signal?.aborted) throw abortError();
      const inputIds = new m.ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);
      const { logits } = await m.decoder.run({ input_ids: inputIds, encoder_hidden_states: hidden });
      const vocab = logits.dims[2];
      const row = logits.data.subarray((ids.length - 1) * vocab, ids.length * vocab);
      // 가장 큰 값(같으면 앞의 것 — torch.argmax 와 같음)
      let best = 0;
      let max = row[0];
      for (let v = 1; v < vocab; v++) {
        if (row[v] > max) {
          max = row[v];
          best = v;
        }
      }
      ids.push(best);
      if (!SPECIAL_IDS.has(best)) {
        let sum = 0;
        for (let v = 0; v < vocab; v++) sum += Math.exp(row[v] - max);
        const p = 1 / sum; // 고른 토큰의 softmax 확률
        logSum += Math.log(p);
        if (p < minP) minP = p;
        n++;
      }
      if (best === EOS_ID) {
        truncated = false;
        break;
      }
    }
    const latex = postProcess(m.tokenizer.decode(ids));
    return { latex, ms: Math.round(performance.now() - t0), conf: { mean: n ? Math.exp(logSum / n) : 0, min: n ? minP : 0, n }, truncated };
  }

  return {
    recognize(images, { signal, maxTokens } = {}) {
      const cap = Number.isInteger(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, MAX_NEW_TOKENS) : DEFAULT_MAX_TOKENS;
      const run = queue.then(async () => {
        if (closed) throw new Error('이미 닫은 엔진이에요.');
        if (signal?.aborted) throw abortError();
        const m = await load();
        const results = [];
        for (const image of images || []) {
          if (signal?.aborted) throw abortError();
          results.push(await recognizeOne(m, image, signal, cap));
        }
        return results;
      });
      queue = run.catch(() => {});
      return run;
    },
    async close() {
      closed = true;
      await queue;
      const m = loading ? await loading.catch(() => null) : null;
      loading = null;
      if (m) {
        await m.encoder.release();
        await m.decoder.release();
      }
    },
  };
}

module.exports = {
  MODEL_REPO,
  MODEL_REVISION,
  MODEL_FILES,
  modelStatus,
  installModel,
  createMathOcr,
  // 시험용
  preprocess,
  resizeBicubicRGB,
  createTokenizer,
  sanitizeTokenizer,
  postProcess,
};
