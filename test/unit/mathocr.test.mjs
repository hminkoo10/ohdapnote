// 메인 프로세스의 수식 인식(src/main/mathocr.js): 전처리·후처리·토큰 디코드가 Python Pix2Text 와 같은지, 모델 받기
// 기준값은 Python(Pillow 13.0.0, transformers 4.57.6 DeiTImageProcessor, pix2text 1.1 LatexOCR)으로 셈한 것입니다.
// 모델이 있어야 하는 시험은 OHDAP_MFR_DIR 에 모델 폴더(encoder_model.onnx · decoder_model.onnx · tokenizer.json)를 줄 때만 돌립니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const mathocr = require('../../src/main/mathocr.js');
const MODEL_DIR = process.env.OHDAP_MFR_DIR;
const r = String.raw;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// 시험용 그림 (Python 쪽과 같은 식): 무늬 / 흰 바탕의 검은 획
function gradient(w, h) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) rgba[(y * w + x) * 4 + c] = (x * 7 + y * 13 + c * 50 + ((x * y) % 31)) % 256;
      rgba[(y * w + x) * 4 + 3] = 255;
    }
  return rgba;
}
function shape(kind, w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let ink = false;
      if (kind === 'bar') ink = y >= 14 && y < 18 && x >= 12 && x < 52;
      if (kind === 'cross') ink = (Math.abs(x - y) <= 1 || Math.abs(x + y - (w - 1)) <= 1) && x >= 6 && x < w - 6;
      if (kind === 'plus') ink = (y >= 22 && y < 26 && x >= 8 && x < 40) || (x >= 22 && x < 26 && y >= 8 && y < 40);
      if (ink) rgba.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
    }
  return rgba;
}
const toRgb = (rgba) => Uint8Array.from({ length: (rgba.length / 4) * 3 }, (_, i) => rgba[Math.floor(i / 3) * 4 + (i % 3)]);

// [너비, 높이, Pillow resize((384,384), BICUBIC) 의 sha256, pixel_values(float32) 의 sha256, [위치, 값]…]
// 640×1200, 500×700 은 Pillow 가 세로를 먼저 줄이는 경우
const RESIZE = [
  [50, 20, '6c5c78a3da553dc8252aa4ae5bc459be88226659ac79149b696e5a7f58290047', '37d3ce450bed3561fb7ee883cc8e552244f2d736110d4d00a734881553092669', [[0, -1], [383, -0.34117645025253296], [50000, 0.3803921937942505], [147456, -0.6313725709915161], [300000, 0.46666669845581055], [442367, 0.3960784673690796]]],
  [17, 9, 'aac851cb6bc4597106d38b6862863a220524cb21fa549e4e7e4e2e8e8e03fb53', 'bfd339719dc6a580d51842bf8c51dd26a8f21245c15eb0b088f7167f9568c745', [[0, -1], [383, -0.1450980305671692], [50000, -0.5058823823928833], [147456, -0.6313725709915161], [300000, -0.019607841968536377], [442367, -0.5215686559677124]]],
  [1000, 150, '8b193e4878ff0040ac6f44f942eeaf946a1082b34f6b059573bb1929889f8c30', 'eb2a6ac1f39ea6d2622a4c3ab120b7a591e29bc5af1ee40534d78873953e874a', [[0, -0.9607843160629272], [383, -0.427450954914093], [50000, -0.3333333134651184], [147456, -0.5686274766921997], [300000, 0.08235299587249756], [442367, -0.35686272382736206]]],
  [384, 100, '446a874b7771aaac95c01b680580ba336b7072eb605f775164e5b8d56f32a9ee', '526d33997e7fc4225d5ab7632b80db0d2d31fb2a8016f401df93ec4d7643435a', [[0, -1], [383, -0.07450979948043823], [50000, -0.07450979948043823], [147456, -0.615686297416687], [300000, -0.5921568870544434], [442367, 0.8117647171020508]]],
  [200, 384, '63b59d318d32d21d2e04c1a65ab44e88f3a650211cd27f62910de5c16364fd4f', 'c9138919a5fe99636c9f328f3841caadbf1ce917d406ad40fe20cbafc0991b23', [[0, -1], [383, -0.10588234663009644], [50000, 0.6235294342041016], [147456, -0.615686297416687], [300000, 0.050980448722839355], [442367, -0.270588219165802]]],
  [384, 384, 'fc7573a5a090abf90fd14a47ef3e72cde8620fd7b670fc39c407eaf7c13f0a66', '03393f48a13b71158bfd3b1f3238b8310df150cb257efc71933788f0052f0975', [[0, -1], [383, -0.05098038911819458], [50000, 0.7019608020782471], [147456, -0.6078431606292725], [300000, 0.41960787773132324], [442367, -0.15294116735458374]]],
  [640, 1200, '5988dc108b282d90542df0529b1d5ae9463b429921cf85c18eb6008e376889ad', '9696f9f080461461cc4cb162380f6300b90eca13250877f4fe4de9db8ad9d277', [[0, -0.8588235378265381], [383, 0.13725495338439941], [50000, -0.1764705777168274], [147456, -0.46666663885116577], [300000, 0.48235297203063965], [442367, 0.46666669845581055]]],
  [2, 2, 'f67dac6169c2edb6da0f4d84f1d75487083317236eec5b61263be1fe3f03e2b4', '5e247b4374c2f2e5a1abf86646c2b8a6dd9dff2d5810f2d1b8288ad50e3d52f2', [[0, -1], [383, -0.9529411792755127], [50000, -0.9843137264251709], [147456, -0.6313725709915161], [300000, -0.23137253522872925], [442367, -0.027450978755950928]]],
  [500, 700, '1f9befd993d9960a2eacec1d666cf2173c5f5aac8410693349d242b1b8d16f40', 'd4d00e12d600c43886b019df7187818ebcca703068b3f42abbe1be863df1d59a', [[0, -0.9450980424880981], [383, 0.34117650985717773], [50000, 0.9529411792755127], [147456, -0.5529412031173706], [300000, -0.772549033164978], [442367, 0.12156867980957031]]],
  [500, 600, 'e6f512b4e28301aa0a287de018c85618bdd56ae766d15cd2e09f8d24e381a581', '26c99e49d2db20270e68335680cc85ecb6f8072117eac47332ead8d761c4adb0', [[0, -0.9607843160629272], [383, 0.32549023628234863], [50000, -0.5372549295425415], [147456, -0.5686274766921997], [300000, 0.843137264251709], [442367, 0.08235299587249756]]],
  [400, 433, 'f92147220c2a3713588dba4e419ef9009687d5f1cb428e37dff138141ba8db7e', 'f1a128223c32500a285207f98d0472a988a1ca49a7cc68eed4c1cc141d591beb', [[0, -0.9921568632125854], [383, 0.6627451181411743], [50000, 0.6235294342041016], [147456, -0.6000000238418579], [300000, 0.8588235378265381], [442367, -0.46666663885116577]]],
  [1, 500, '297428a085ce2c9c766e0545b8d4b76b38646bc22988e2f1159b95e48a0dcd51', '41ed70bb7993a797d4adcd84c42c1a7d2323333a3b91bf01ae9bf45eca954e5a', [[0, -0.9843137264251709], [383, -0.9843137264251709], [50000, 0.21568632125854492], [147456, -0.5921568870544434], [300000, -0.4823529124259949], [442367, 0.45098042488098145]]],
];

// [모양, 너비, 높이, pixel_values 의 sha256, Python LatexOCR 결과]
const SHAPES = [
  ['bar', 64, 32, 'c0f95e2c85d7ad306e2b5bfa5474a26ca1ec64d689ea16251c8ced6a804e3a6b', r`\underline{{\quad}}`],
  ['cross', 40, 40, '6e148f22f88f86bddd8a614b13c7a90f4ae81d7d8e8be043242c600efeebfc69', r`\times`],
  ['plus', 48, 48, '656a8028155b333b5ecd6911a4db8304d3c0d63a0b887f598ae4ed5b45b0bcc2', r`\,+`],
];

test('전처리: Pillow BICUBIC 384×384 + /255 + (x-0.5)/0.5 가 Python 과 비트까지 같음', () => {
  for (const [w, h, resized, pixels, samples] of RESIZE) {
    const rgba = gradient(w, h);
    assert.equal(sha(mathocr.resizeBicubicRGB(toRgb(rgba), w, h, 384, 384)), resized, `${w}x${h} resize`);
    const pv = mathocr.preprocess({ data: rgba, width: w, height: h });
    assert.equal(pv.length, 3 * 384 * 384);
    assert.equal(sha(Buffer.from(pv.buffer)), pixels, `${w}x${h} pixel_values`);
    for (const [i, v] of samples) assert.equal(pv[i], v, `${w}x${h} [${i}]`);
  }
  for (const [kind, w, h, pixels] of SHAPES) {
    const pv = mathocr.preprocess({ data: shape(kind, w, h), width: w, height: h });
    assert.equal(sha(Buffer.from(pv.buffer)), pixels, kind);
  }
});

test('전처리: 투명한 곳은 흰 바탕, 크기·화소가 틀리면 오류', () => {
  const clear = new Uint8ClampedArray(30 * 20 * 4); // 전부 (0,0,0,0)
  const white = new Uint8ClampedArray(30 * 20 * 4).fill(255);
  assert.deepEqual(mathocr.preprocess({ data: clear, width: 30, height: 20 }), mathocr.preprocess({ data: white, width: 30, height: 20 }));
  assert.throws(() => mathocr.preprocess({ data: new Uint8Array(10), width: 30, height: 20 }));
  assert.throws(() => mathocr.preprocess({ data: white, width: 0, height: 20 }));
  assert.throws(() => mathocr.preprocess({ data: white, width: 2.5, height: 20 }));
});

// [디코드한 글자, Pix2Text post_process 결과]
const POST = [
  ['^ { abc } x', 'abc x'],
  ['_ { 1 } + 2', '1+2'],
  [r`a \, \quad `, 'a'],
  [r`x \! \; `, 'x'],
  [r`a \. b \= c \- d \~ e`, r`a \ . b \ =c \ -d \ ~ e`],
  [r`\hat { } x ^ { } + \text { } y`, 'x+y'],
  [r`\bar { \vec { } } z`, 'z'],
  [r`\left( x \right)`, r`\left( x \right)`],
  [r`\left\langle x \right\rangle`, r`\langle x \rangle`], // Pix2Text 의 짝 맞추기 버릇 그대로
  [r`\left( x`, '( x'],
  [r`x \right)`, 'x )'],
  [r`\left\{ a \right.`, r`\left\{a \right.`],
  [r`\left \big( x \right \big)`, r`\left\big( x \right\big)`],
  [r`\leftarrow \left[ a \right] \rightarrow`, r`\leftarrow\left[ a \right] \rightarrow`],
  [r`\sin  x + \cos 3`, r`\sin x+\cos3`],
  ['a + b = c - d', 'a+b=c-d'],
  ['x _ { 1 } ^ { 2 }', 'x_{1}^{2}'],
  [r`\log 2 . 5 4`, r`\log2 . 5 4`],
  [r`\{ a \}`, r`\{a \}`],
  [r`\operatorname { l o g } _ { 2 } 3 2 \! = \! 5`, r`\operatorname{l o g}_{2} 3 2 \!=\! 5`],
  [r`y { = } a \sin \left( b x { - } c \right)`, r`y {=} a \sin\left( b x {-} c \right)`],
  [r`\left| x \right| + \left\| y \right\|`, r`\left| x \right|+\left\| y \right\|`],
  [r`\left\lfloor x \right\rfloor`, r`\lfloor x \rfloor`],
  [r`\left. x \right|`, r`\left. x \right|`],
  [r`\left\left( x \right)`, r`\left\left( x \right)`],
  [r`  \alpha  \beta X `, r`\alpha\beta X`],
  [r`\frac { 1 } { 2 } \, `, r`\frac{1} {2}`],
  [r`\left( \frac { a } { b } \right) ^ { 2 } + \left[ x \right] \right)`, r`\left( \frac{a} {b} \right)^{2}+\left[ x \right] )`],
  [r`\right) \left(`, ') ('],
  ['a\u001c+\u0085b﻿= c', 'a+b﻿=c'], // Python 의 공백(\x1c, \x85)과 아닌 것(﻿)
  ['x 　 y', 'x y'],
  [r`\underset { k = 1 } { \overset { 1 0 } { \sum } } a _ { k }`, r`\underset{k=1} {\overset{1 0} {\sum}} a_{k}`],
  [r`\left\{ \begin{array} { l } x \\ y \end{array} \right.`, r`\left\{\begin{array} {l} x \\ y \end{array} \right.`],
  ['가 나 + 1', '가 나+1'],
  [r`\left( 𝑥 \right)`, r`\left( 𝑥 \right)`],
];

test('후처리: Pix2Text LatexOCR.post_process 와 같음', () => {
  for (const [src, want] of POST) assert.equal(mathocr.postProcess(src), want, src);
});

// 작은 가짜 tokenizer.json: ByteLevel 글자(Ġ=빈칸, ê°Ģ = '가' 의 UTF-8 세 바이트), 표에 없는 글자는 UTF-8 그대로
const TINY = {
  added_tokens: ['<pad>', '<s>', '</s>', '<unk>', '<mask>'].map((content, id) => ({ id, content, special: true })),
  decoder: { type: 'ByteLevel' },
  model: { type: 'BPE', vocab: { '<pad>': 0, '<s>': 1, '</s>': 2, '<unk>': 3, '<mask>': 4, '\\': 5, frac: 6, 'Ġ{': 7, 'ê°Ģ': 8, x: 9, 가: 10, ê: 11 } },
};

test('토큰 → 글자: 특수 토큰 빼기, ByteLevel 바이트 → UTF-8', () => {
  const tok = mathocr.createTokenizer(TINY);
  assert.equal(tok.decode([1, 5, 6, 7, 9, 2]), r`\frac {x`);
  assert.equal(tok.decode([1, 8, 2]), '가');
  assert.equal(tok.decode([10]), '가'); // 표에 없는 글자 → 그대로
  assert.equal(tok.decode([0, 3, 4, 1, 2]), '');
  assert.equal(tok.decode([11]), '�'); // 끊긴 UTF-8
  assert.equal(tok.decode([11, 8]), '�가');
  assert.throws(() => mathocr.createTokenizer({ ...TINY, model: { type: 'WordPiece', vocab: {} } }));
});

test('모델 상태: 빈 폴더는 설치 안 됨, 받을 파일은 고정한 커밋의 세 개', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ohdap-mfr-'));
  try {
    assert.deepEqual(mathocr.modelStatus(dir), { installed: false, dir, bytes: 0 });
    assert.match(mathocr.MODEL_REVISION, /^[0-9a-f]{40}$/);
    assert.deepEqual(mathocr.MODEL_FILES.map((f) => f.name), ['encoder_model.onnx', 'decoder_model.onnx', 'tokenizer.json']);
    for (const f of mathocr.MODEL_FILES) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('모델 받기: 덜 받거나 HTTP 오류면 .part 를 지우고 실패, 고정한 커밋 주소로 받음', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ohdap-mfr-'));
  try {
    const urls = [];
    const short = async (url) => {
      urls.push(url);
      return new Response(new Uint8Array(1000));
    };
    await assert.rejects(mathocr.installModel({ dir, fetch: short }), /끝까지/);
    assert.equal(urls[0], `https://huggingface.co/breezedeus/pix2text-mfr-1.5/resolve/${mathocr.MODEL_REVISION}/encoder_model.onnx`);
    assert.deepEqual(readdirSync(dir), []);
    await assert.rejects(mathocr.installModel({ dir, fetch: async () => new Response('no', { status: 404 }) }), /HTTP 404/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('모델 받기: 받는 중에 취소하면 AbortError, 진행 상황을 알림', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ohdap-mfr-'));
  try {
    const ctrl = new AbortController();
    const progress = [];
    // 조금씩 끝없이 흘려보내는 가짜 서버: 신호가 오면 스트림을 끊음
    const slow = async (_url, { signal }) =>
      new Response(
        new ReadableStream({
          async pull(c) {
            await new Promise((res) => setTimeout(res, 20));
            if (signal.aborted) c.error(signal.reason);
            else c.enqueue(new Uint8Array(64 * 1024));
          },
        }),
      );
    const run = mathocr.installModel({ dir, fetch: slow, signal: ctrl.signal, onProgress: (p) => progress.push(p) });
    setTimeout(() => ctrl.abort(), 300);
    await assert.rejects(run, { name: 'AbortError' });
    assert.ok(progress.length > 0 && progress[0].total === mathocr.MODEL_FILES.reduce((s, f) => s + f.size, 0));
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('인식: 모델이 없으면 알려 줌', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ohdap-mfr-'));
  try {
    const ocr = mathocr.createMathOcr({ modelDir: dir });
    await assert.rejects(ocr.recognize([{ data: shape('bar', 64, 32), width: 64, height: 32 }]), /설치되지 않았/);
    await ocr.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 아래는 모델이 있을 때만 (OHDAP_MFR_DIR) ----
const withModel = { skip: MODEL_DIR ? false : 'OHDAP_MFR_DIR 에 모델 폴더를 주면 돌립니다' };

test('토큰 → 글자: 실제 tokenizer.json (Python tokenizers 와 같음)', withModel, () => {
  const tok = mathocr.createTokenizer(JSON.parse(readFileSync(join(MODEL_DIR, 'tokenizer.json'), 'utf8')));
  assert.equal(tok.decode([1, 92, 2]), 'x');
  assert.equal(tok.decode([1, ...Array.from({ length: 59 }, (_, i) => i + 1), 2]), '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVW');
  assert.equal(tok.decode([1, 700, 701, 1500, 1867, 3, 4, 0, 2]), 'colonuparrowvartrianglelefttextasteriskcentered');
  assert.equal(tok.decode([1, 99, 100, 2]), '��');
});

test('인식: Python Pix2Text 와 같은 LaTeX + 확신도, 취소', withModel, async () => {
  const ocr = mathocr.createMathOcr({ modelDir: MODEL_DIR });
  try {
    const images = SHAPES.map(([kind, w, h]) => ({ data: shape(kind, w, h), width: w, height: h }));
    const results = await ocr.recognize(images);
    assert.deepEqual(results.map((x) => x.latex), SHAPES.map((s) => s[4]));
    for (const { ms, conf, truncated } of results) {
      assert.ok(ms >= 0);
      assert.ok(conf.n > 0 && conf.min > 0 && conf.min <= conf.mean && conf.mean <= 1, JSON.stringify(conf));
      assert.equal(truncated, false);
    }
    // 토큰 수 한도: 끊기면 truncated
    const [cut] = await ocr.recognize(images.slice(0, 1), { maxTokens: 2 });
    assert.equal(cut.truncated, true);
    assert.equal(cut.conf.n, 2);
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(ocr.recognize(images, { signal: ctrl.signal }), { name: 'AbortError' });
    assert.equal((await ocr.recognize(images.slice(0, 1)))[0].latex, SHAPES[0][4]); // 취소 뒤에도 그대로 씀
  } finally {
    await ocr.close();
  }
});
