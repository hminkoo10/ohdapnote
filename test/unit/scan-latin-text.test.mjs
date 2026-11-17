import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { T, textSymbols, splitLine, planScan, assembleBlocks, toInk, components } from '../../src/renderer/js/scanmath.js';

const h = 20;
const latin = (passes, height = h) => textSymbols(passes, height).filter((u) => u.kind === 'latin');
const word = (str, x0, y0 = 20, conf = 96, height = 16) => ({
  str, x0, y0, x1: x0 + [...str].length * 8 - 2, y1: y0 + height, conf,
  symbols: [...str].map((str, i) => ({ str, x0: x0 + i * 8, x1: x0 + i * 8 + 6, y0, y1: y0 + height, conf })),
});
const row = (strings, { y = 20, gap = 2, x = 20 } = {}) => strings.map((str) => {
  const w = word(str, x, y);
  x = w.x1 + gap;
  return w;
});

function paper(words = []) {
  const width = 1200;
  const height = 200;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const fill = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  };
  const ring = (x, y) => {
    fill(x, y, x + 20, y + 2);
    fill(x, y + 18, x + 20, y + 20);
    fill(x, y, x + 2, y + 20);
    fill(x + 18, y, x + 20, y + 20);
    fill(x + 8, y + 6, x + 12, y + 14);
  };
  for (const w of words) for (const s of w.symbols) fill(s.x0, s.y0, s.x1, s.y1);
  return { img: { data, width, height }, fill, ring };
}

test('(a) English prose becomes text with spaces even at narrow word gaps', () => {
  const words = row(['Quiet', 'birds', 'gather', 'nearby.']);
  const passes = [{ words }];
  const units = latin(passes);
  assert.deepEqual(units.map((u) => u.str), words.map((w) => w.str));
  assert.ok(units.every((u) => u.conf === 96));
  const plan = planScan(paper(words).img, passes);
  assert.equal(plan.formulas.length, 0);
  assert.equal(plan.hangul, 0);
  assert.equal(plan.textConf, 100);
  assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'para', text: 'Quiet birds gather nearby.' }]);
});

test('(a) Apostrophes, hyphens and allowed surrounding punctuation stay in words', () => {
  const strings = ['(“Quiet', "birds’", "don't", 'scatter', 'well-lit', 'feathers.”)'];
  const words = row(strings);
  assert.deepEqual(latin([{ words }]).map((u) => u.str), strings);
  const plan = planScan(paper(words).img, [{ words }]);
  assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'para', text: strings.join(' ') }]);
});

test('(a) Separate nearby punctuation attaches without adding a space before it', () => {
  const words = row(['Quiet', 'birds', 'gather']);
  const end = words.at(-1).x1;
  const comma = word(',', end + 2, 24, 96, 8);
  const units = textSymbols([{ words: [...words, comma] }], h);
  assert.equal(units.at(-1).kind, 'punct');
  assert.equal(splitLine([], units, h).tokens[0].s, 'Quiet birds gather,');
  const manual = [
    { ...word('hello', 0), kind: 'latin' },
    { ...word(',world', 100), kind: 'latin' },
  ];
  assert.equal(splitLine([], manual, h).tokens[0].s, 'hello,world');
});

test('(a) Word and symbol confidence, glyph size, shape and mixed-pass source gate words', () => {
  const anchors = row(['Quiet', 'birds', 'gather']);
  const candidate = () => word('nearby', 300);
  const rejected = [
    { ...candidate(), conf: T.latinWordConf - 1 },
    { ...candidate(), symbols: candidate().symbols.map((s, i) => ({ ...s, conf: i ? 96 : T.latinSymbolConf - 1 })) },
    word('nearby', 300, 20, 96, T.latinMinH * h - 1),
    word('nearby', 300, 20, 96, T.latinMaxH * h + 1),
    { ...candidate(), symbols: [] },
    ...['f(x)', 'x+y', 'bird2', "'birds", 'birds_', 'two--birds', 'x', 'P'].map((str) => word(str, 300)),
  ];
  for (const w of rejected) assert.deepEqual(latin([{ words: [...anchors, w] }]).map((u) => u.str), ['Quiet', 'birds', 'gather'], w.str);
  for (const height of [T.latinMinH * h, T.latinMaxH * h]) {
    const w = word('nearby', 300, 20, T.latinSymbolConf, height);
    w.conf = T.latinWordConf;
    assert.equal(latin([{ words: [...anchors, w] }]).at(-1).str, 'nearby');
  }
  const tinyGlyph = candidate();
  tinyGlyph.symbols[0].y1 = tinyGlyph.symbols[0].y0 + T.latinMinH * h - 1;
  assert.equal(latin([{ words: [...anchors, tinyGlyph] }]).length, 4);
  const tallGlyph = candidate();
  tallGlyph.symbols[0].y1 = tallGlyph.symbols[0].y0 + T.latinMaxH * h + 1;
  assert.equal(latin([{ words: [...anchors, tallGlyph] }]).length, 3);
  assert.deepEqual(latin([{ words: anchors, kor: true }]), []);
  assert.equal(latin([{ words: anchors }, { words: [candidate()], kor: true }]).length, 3);
});

test('(a) Sentence evidence uses lowercase long words on the same line only', () => {
  assert.deepEqual(latin([{ words: row(['Quiet']) }]), []);
  assert.equal(latin([{ words: row(['Quiet', 'birds']) }]).length, 2);
  assert.deepEqual(latin([{ words: row(['of', 'to', 'an', 'BIRDS', 'GATHER']) }]), []);
  const words = [...row(['Quiet']), ...row(['gather'], { y: 60 })];
  assert.deepEqual(latin([{ words }]), []);
  const near = [...row(['Quiet']), word('gather', 300, 31)];
  assert.equal(latin([{ words: near }]).length, 2);
  near[1] = word('gather', 300, 32);
  assert.deepEqual(latin([{ words: near }]), []);
  const repeated = row(['Quiet']);
  assert.deepEqual(latin([{ words: repeated }, { words: repeated }, { words: repeated }]), []);
  const saved = T.latinLineWords;
  try {
    T.latinLineWords = 3;
    assert.deepEqual(latin([{ words: row(['Quiet', 'birds']) }]), []);
  } finally {
    T.latinLineWords = saved;
  }
});

test('(a) A, a and I need an ordinary immediate neighbor on either side', () => {
  for (const strings of [
    ['A', 'small', 'bird', 'rests', 'quietly.'],
    ['Quiet', 'birds', 'watch', 'A', 'small', 'boat.'],
    ['I', 'think', 'clouds', 'move', 'slowly.'],
    ['Quiet', 'birds', 'notice', 'there', 'was', 'a'],
  ]) {
    const words = row(strings);
    assert.deepEqual(latin([{ words }]).map((u) => u.str), strings);
    const plan = planScan(paper(words).img, [{ words }]);
    assert.equal(plan.formulas.length, 0);
    assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'para', text: strings.join(' ') }]);
  }
  assert.deepEqual(latin([{ words: row(['A', 'x', 'Quiet', 'birds', 'gather']) }]).map((u) => u.str), ['Quiet', 'birds', 'gather']);
  assert.deepEqual(latin([{ words: row(['Quiet', 'birds', 'gather', 'a', 'A']) }]).map((u) => u.str), ['Quiet', 'birds', 'gather', 'a']);
});

test('(a) Uppercase abbreviations still need ordinary words on both sides', () => {
  const strings = ['the', 'USA', 'and', 'TV', 'signal', 'looks', 'clear'];
  assert.deepEqual(latin([{ words: row(strings) }]).map((u) => u.str), strings);
  const words = row(['USA', 'Quiet', 'birds', 'watch', 'TV'], { gap: 8 });
  const plan = planScan(paper(words).img, [{ words }]);
  assert.deepEqual(latin([{ words }]).map((u) => u.str), ['Quiet', 'birds', 'watch']);
  assert.equal(plan.formulas.length, 2);
  assert.deepEqual(assembleBlocks(plan, (i) => ['USA', 'TV'][i]), [{ type: 'para', text: '$USA$ Quiet birds watch $TV$' }]);
});

test('(a) Interior x, P and l remain mathematical variables', () => {
  const words = row(['Quiet', 'x', 'birds', 'P', 'gather', 'l', 'nearby'], { gap: 8 });
  assert.deepEqual(latin([{ words }]).map((u) => u.str), ['Quiet', 'birds', 'gather', 'nearby']);
  const plan = planScan(paper(words).img, [{ words }]);
  assert.equal(plan.formulas.length, 3);
  assert.deepEqual(assembleBlocks(plan, (i) => ['x', 'P', 'l'][i]), [{ type: 'para', text: 'Quiet $x$ birds $P$ gather $l$ nearby' }]);
});

test('Short phrases follow the two-word sentence-evidence requirement', () => {
  for (const phrase of ['if a is positive', 'triangle ABC is']) {
    const words = row(phrase.split(' '), { gap: 8 });
    assert.deepEqual(latin([{ words }]), [], phrase);
    const plan = planScan(paper(words).img, [{ words }]);
    assert.ok(plan.formulas.length > 0, phrase);
    assert.ok(plan.lines.every((l) => l.tokens.every((t) => t.t === 'math')), phrase);
  }
  for (const [phrase, math, expected] of [
    ['the value of x is', ['x'], 'the value of $x$ is'],
    ['point P on line l', ['P', 'l'], 'point $P$ on line $l$'],
  ]) {
    const strings = phrase.split(' ');
    const words = row(strings, { gap: 8 });
    assert.deepEqual(latin([{ words }]).map((u) => u.str), strings.filter((str) => !math.includes(str)), phrase);
    const plan = planScan(paper(words).img, [{ words }]);
    assert.equal(plan.formulas.length, math.length, phrase);
    assert.deepEqual(assembleBlocks(plan, (i) => math[i]), [{ type: 'para', text: expected }], phrase);
  }
});

test('Sentence context keeps x, P and l as math, but accepts a and interior ABC', () => {
  const cases = [
    ['the value of x is', ['x'], 'Please consider the value of $x$ is'],
    ['point P on line l', ['P', 'l'], 'Please consider point $P$ on line $l$'],
    ['if a is positive', [], 'Please consider if a is positive'],
    ['triangle ABC is', [], 'Please consider triangle ABC is'],
  ];
  for (const [phrase, math, expected] of cases) {
    const strings = ['Please', 'consider', ...phrase.split(' ')];
    const words = row(strings, { gap: 8 });
    const plan = planScan(paper(words).img, [{ words }]);
    assert.deepEqual(latin([{ words }]).map((u) => u.str), strings.filter((str) => !math.includes(str)), phrase);
    assert.equal(plan.formulas.length, math.length, phrase);
    assert.deepEqual(assembleBlocks(plan, (i) => math[i]), [{ type: 'para', text: expected }], phrase);
  }
});

test('Word size admits x-height-only words and shorter individual letters', () => {
  const strings = ['we', 'move', 'on', 'near', 'green', 'rooms.'];
  const words = row(strings);
  for (const w of words) {
    if (w.str === 'we' || w.str === 'on') {
      w.y0 = 27;
      for (const s of w.symbols) s.y0 = 27;
    } else {
      for (const s of w.symbols) if (/[aeo]/.test(s.str)) s.y0 = 30;
    }
  }
  assert.deepEqual(latin([{ words }]).map((u) => u.str), strings);
  const plan = planScan(paper(words).img, [{ words }]);
  assert.equal(plan.formulas.length, 0);
  assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'para', text: strings.join(' ') }]);
});

test('Word size admits ascenders and descenders with an inferred text height', () => {
  const strings = ['Quiet', 'birds', 'enjoy', 'typing', 'nearby.'];
  const words = row(strings);
  const tall = words[3];
  tall.y0 = 14;
  tall.y1 = 44;
  for (const s of tall.symbols) {
    s.y0 = s.str === 't' ? 14 : 24;
    s.y1 = /[ypg]/.test(s.str) ? 44 : 36;
  }
  const plan = planScan(paper(words).img, [{ words }]);
  assert.ok(tall.y1 - tall.y0 > 1.3 * plan.h);
  assert.equal(plan.formulas.length, 0);
  assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'para', text: strings.join(' ') }]);
});

test('Contractions, hyphens and attached straight quotes preserve exact spacing', () => {
  const strings = ['Quiet', 'birds', "don't", 'ignore', 'well-known', '"quoted"', 'words.'];
  const words = row(strings);
  const plan = planScan(paper(words).img, [{ words }]);
  assert.equal(plan.formulas.length, 0);
  assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'para', text: 'Quiet birds don\'t ignore well-known "quoted" words.' }]);
});

test('Periods, commas and questions attach exactly for joined or separate OCR words', () => {
  for (const mark of ['.', ',', '?']) for (const separate of [false, true]) {
    const strings = ['Quiet', 'birds', 'gather', separate ? 'nearby' : `nearby${mark}`];
    const words = row(strings);
    if (separate) {
      const p = word(mark, words.at(-1).x1 + 2, 32, 96, 4);
      p.x1 = p.x0 + 3;
      p.symbols[0].x1 = p.x1;
      words.push(p);
    }
    const plan = planScan(paper(words).img, [{ words }]);
    assert.equal(plan.formulas.length, 0);
    assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'para', text: `Quiet birds gather nearby${mark}` }]);
  }
});

test('A long blank keeps surrounding prose spaced and is not a formula', () => {
  const words = [...row(['Quiet', 'birds']), ...row(['gather', 'nearby.'], { x: 260 })];
  const sheet = paper(words);
  sheet.fill(130, 34, 240, 36);
  const passes = [{ words: [...words, word('____', 130)] }];
  const plan = planScan(sheet.img, passes);
  assert.equal(plan.formulas.length, 0);
  assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'para', text: 'Quiet birds gather nearby.' }]);
});

test('Korean and Latin text retain left-to-right order on mixed lines', () => {
  for (const strings of [
    ['다음', 'Quiet', 'birds', 'gather', '문장을', '읽으시오.'],
    ['안내', 'Quiet', 'birds', 'gather', 'nearby.'],
  ]) {
    const words = row(strings, { gap: 8 });
    for (const w of words) if (/[가-힣]/.test(w.str)) {
      w.y1 = w.y0 + h;
      for (const s of w.symbols) s.y1 = w.y1;
    }
    const plan = planScan(paper(words).img, [{ words }]);
    assert.equal(plan.formulas.length, 0);
    assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'para', text: strings.join(' ') }]);
  }
});

test('(b) Short choices count sentence evidence across all five choices', () => {
  const choices = [['gentle'], ['silent', 'birds'], ['bright'], ['warm'], ['calm']];
  const words = choices.flatMap((strings, i) => row(strings, { x: 50 + 210 * i }));
  const sheet = paper(words);
  for (let i = 0; i < 5; i++) sheet.ring(20 + 210 * i, 18);
  const plan = planScan(sheet.img, [{ words }]);
  assert.equal(plan.lines[0].kind, 'choice');
  assert.equal(plan.formulas.length, 0);
  assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'choices', items: choices.map((c) => c.join(' ')) }]);
});

test('(c) Korean mathematical labels and function names remain math', () => {
  const words = [word('다음', 10, 20, 96, 20), ...row(['ABC', 'P,', 'Q', 'f(x)', 'sin', 'log', 'dx'], { x: 80, gap: 10 })];
  const passes = [{ words }];
  assert.deepEqual(latin(passes), []);
  const plan = planScan(paper(words).img, passes);
  assert.ok(plan.formulas.length > 0);
  const math = plan.formulas.flatMap((f) => f.comps);
  for (const w of words.slice(1)) for (const s of w.symbols) {
    const c = plan.comps.find((c) => c.x0 === s.x0 && c.y0 === s.y0);
    assert.ok(math.includes(c.id), w.str);
  }
});

test('(d) English math prose leaves variables and expressions as math', () => {
  const strings = ['Find', 'the', 'value', 'of', 'x', 'when', 'f(x)=x^2+1', 'holds.'];
  const words = row(strings, { gap: 8 });
  const plan = planScan(paper(words).img, [{ words }]);
  assert.deepEqual(latin([{ words }]).map((u) => u.str), strings.filter((s) => s !== 'x' && s !== 'f(x)=x^2+1'));
  assert.equal(plan.formulas.length, 2);
  assert.deepEqual(assembleBlocks(plan, (i) => ['x', 'f(x)=x^2+1'][i]), [{ type: 'para', text: 'Find the value of $x$ when $f(x)=x^2+1$ holds.' }]);
  // A tight variable must not be discarded as a leftover Hangul stroke.
  const tight = row(['Find', 'the', 'value', 'x', 'when', 'ready']);
  const tightPlan = planScan(paper(tight).img, [{ words: tight }]);
  assert.equal(tightPlan.formulas.length, 1);
});

test('(d) Mathematical function names are excluded even inside English prose', () => {
  const names = 'sin cos tan sec csc cot log ln lim exp max min det mod gcd lcm sinh arcsin'.split(' ');
  for (const name of names) {
    const words = row(['Find', 'the', name, 'value', 'nearby']);
    assert.ok(!latin([{ words }]).some((u) => u.str === name), name);
  }
});

test('(d) Existing assembly joins English wrapped lines with one space', () => {
  const words = [...row(['Quiet', 'birds', 'gather', 'nearby']), ...row(['Soft', 'clouds', 'drift'], { y: 60 })];
  const plan = planScan(paper(words).img, [{ words }]);
  assert.equal(plan.lines.length, 2);
  assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'para', text: 'Quiet birds gather nearby Soft clouds drift' }]);
});

test('Latin prose beside a figure stays text, while labels inside it are filtered', () => {
  const words = row(['Quiet', 'birds', 'gather']);
  const beside = paper(words);
  const x = words.at(-1).x1 + 4;
  beside.fill(x, 20, x + 2, 110);
  beside.fill(x, 90, x + 100, 92);
  const outside = planScan(beside.img, [{ words }]);
  assert.equal(outside.figures.length, 1);
  assert.equal(outside.lines[0].tokens[0].s, 'Quiet birds gather');
  assert.equal(outside.formulas.length, 0);
  const inside = paper(words);
  inside.fill(198, 10, 200, 110);
  inside.fill(10, 90, 200, 92);
  const labels = planScan(inside.img, [{ words }]);
  assert.equal(labels.figures.length, 1);
  assert.deepEqual(labels.lines, []);
});

test('Existing Korean small-line filtering also removes overlapping Latin units', () => {
  const words = [word('가나다', 20, 20, 96, 20), word('마바', 20, 70, 96, 12), ...row(['Quiet', 'birds', 'gather'], { x: 80, y: 70 })];
  const plan = planScan(paper(words).img, [{ words }]);
  assert.equal(plan.h, 20);
  assert.ok(plan.comps.some((c) => c.kind === 'small'));
  assert.deepEqual(assembleBlocks(plan, () => ''), [{ type: 'para', text: '가나다' }]);
});

// Match the box helper used by scanmath.test.mjs for its Korean fixtures.
const koreanWord = (str, x0, y0, x1, y1, conf = 96, symbols = null) => ({
  str, x0, y0, x1, y1, conf,
  symbols: symbols || [...str].map((str, i, a) => ({ str, x0: x0 + Math.round((x1 - x0) * i / a.length), x1: x0 + Math.round((x1 - x0) * (i + 1) / a.length), y0, y1, conf })),
});

// Generated once from git show 4147f69:src/renderer/js/scanmath.js, using eight fixtures with/without ink; own undefined values serialize as null.
// The last fixture ("Quiet birds ABC dx") is a sentence line under the two-word rule: only Latin units may be added there.
test('(e) Korean-only textSymbols output equals the pinned baseline without git', () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/scan-latin-korean-baseline.json', import.meta.url), 'utf8'));
  const jsonUnits = (units) => JSON.parse(JSON.stringify(units, (_, value) => value === undefined ? null : value));
  const nonLatin = (units) => jsonUnits(units.filter((u) => u.kind !== 'latin'));
  assert.equal(baseline.ref, '4147f69');
  assert.equal(baseline.cases.length, 8);
  baseline.cases.forEach(({ passes, h: height, withoutInk, withInk }, i) => {
    const { img } = paper(passes.flatMap((p) => p.words));
    const { ink } = toInk(img);
    const { comps } = components(ink, img.width, img.height);
    const sentence = i === baseline.cases.length - 1;
    assert.equal(latin(passes, height).length > 0, sentence, String(i));
    const pick = sentence ? nonLatin : jsonUnits;
    assert.deepEqual(pick(textSymbols(passes, height)), withoutInk);
    assert.deepEqual(pick(textSymbols(passes, height, comps)), withInk);
  });
});

test('(f) Latin words overlapping selected Hangul or jamo are discarded', () => {
  for (const str of ['한글', 'ㄱ.']) {
    const words = row(['Quiet', 'birds', 'gather', 'nearby']);
    const conflict = koreanWord(str, words[1].x0, 20, words[1].x1, 40);
    const passes = [{ words }, { words: [conflict], kor: true }];
    assert.deepEqual(latin(passes).map((u) => u.str), ['Quiet', 'gather', 'nearby']);
    const korean = textSymbols(passes, h).filter((u) => u.kind !== 'latin');
    assert.deepEqual(korean, textSymbols([{ words: [] }, { words: [conflict], kor: true }], h));
  }
  const words = row(['Quiet', 'birds']);
  const overlap = koreanWord('한글', words[1].x0, 20, words[1].x1, 40);
  assert.deepEqual(latin([{ words }, { words: [overlap], kor: true }]), []);
});
