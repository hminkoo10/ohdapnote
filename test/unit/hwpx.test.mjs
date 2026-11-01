import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { buildHwpx, splitMath, crc32, stripStemLabel } from '../../src/renderer/js/hwpx.js';
import { convertLatex } from '../../src/renderer/js/hwpeq.js';
import { makeBlocks } from '../../src/renderer/js/exporter.js';

// ---------------------------------------------------------------------------
// 시험용 도구: ZIP 풀기, XML 읽기(짝 맞음 확인)
// ---------------------------------------------------------------------------
function unzip(bytes) {
  const buf = Buffer.from(bytes);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'EOCD 없음');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let k = 0; k < count; k++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, '중앙 디렉터리 서명');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `${name}: 로컬 헤더 서명`);
    const localExtra = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + localExtra;
    const packed = buf.subarray(start, start + csize);
    const data = method === 0 ? packed : zlib.inflateRawSync(packed);
    assert.equal(data.length, usize, `${name}: 크기`);
    entries.push({ name, method, crc, data, offset, localExtra });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** 아주 작은 XML 읽기: 태그 짝, 속성 모양, & 쓰임을 확인하고 나무 구조를 돌려줌 */
function parseXml(src, label) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const checkText = (s) => {
    assert.ok(!s.includes('<'), `${label}: 글자 속 <`);
    for (let j = s.indexOf('&'); j >= 0; j = s.indexOf('&', j + 1)) {
      assert.match(s.slice(j, j + 12), /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/, `${label}: 잘못된 & 쓰임`);
    }
  };
  while (i < src.length) {
    if (src.startsWith('<?', i)) {
      const j = src.indexOf('?>', i);
      assert.ok(j > 0, `${label}: <? 닫힘`);
      i = j + 2;
      continue;
    }
    if (src[i] === '<') {
      const j = src.indexOf('>', i);
      assert.ok(j > 0, `${label}: 태그 닫힘`);
      const tag = src.slice(i + 1, j);
      if (tag.startsWith('/')) {
        const top = stack.pop();
        assert.equal(tag.slice(1), top?.name, `${label}: 닫는 태그 짝`);
      } else {
        const self = tag.endsWith('/');
        const body = self ? tag.slice(0, -1) : tag;
        const name = /^[A-Za-z_][\w.:-]*/.exec(body)?.[0];
        assert.ok(name, `${label}: 태그 이름 <${tag}>`);
        const attrs = {};
        const rest = body.slice(name.length);
        const re = /\s+([A-Za-z_][\w.:-]*)="([^"]*)"/y;
        let m;
        let pos = 0;
        while ((re.lastIndex = pos), (m = re.exec(rest))) {
          assert.ok(!(m[1] in attrs), `${label}: 속성 겹침 ${m[1]}`);
          checkText(m[2]);
          attrs[m[1]] = unescape(m[2]);
          pos = re.lastIndex;
        }
        assert.equal(rest.slice(pos).trim(), '', `${label}: 속성 모양 <${tag}>`);
        const el = { name, attrs, children: [], text: '' };
        stack[stack.length - 1].children.push(el);
        if (!self) stack.push(el);
      }
      i = j + 1;
    } else {
      const j = src.indexOf('<', i);
      const text = src.slice(i, j < 0 ? src.length : j);
      checkText(text);
      if (stack.length === 1) assert.equal(text.trim(), '', `${label}: 바깥 글자`);
      stack[stack.length - 1].text += unescape(text);
      i = j < 0 ? src.length : j;
    }
  }
  assert.equal(stack.length, 1, `${label}: 안 닫힌 태그 ${stack.map((e) => e.name).join('>')}`);
  assert.equal(root.children.length, 1, `${label}: 뿌리 하나`);
  return root.children[0];
}

const all = (el, name, out = []) => {
  if (el.name === name) out.push(el);
  for (const c of el.children) all(c, name, out);
  return out;
};
const textOf = (el) => el.text + el.children.map(textOf).join('');

// ---------------------------------------------------------------------------
// 시험용 문서: 글자+수식 문제(보기·그림 포함), 그림으로 들어가는 문제, 해설, 2단, 해설 따로 모으기
// ---------------------------------------------------------------------------
const fakeImg = (ext, pxW, pxH) => ({ bytes: new Uint8Array([1, 2, 3, 4, pxW & 255, pxH & 255]), ext, pxW, pxH });
const src = { pages: [{ w: 595, h: 842, kind: 'pdf' }, { w: 595, h: 842, kind: 'pdf' }], files: [{ name: 'p.pdf' }] };
const rect = (page, y) => ({ page, x: 0.08, y, w: 0.4, h: 0.12 });
const item = (id, n, page, y) => ({ id, number: String(n), prefix: '', page, rects: [rect(page, y)] });
const entries = [
  { bookId: 'b1', book: '', problem: item('p1', 3, 0, 0.1), answer: item('a1', 3, 1, 0.1), src: { problem: src, answer: src } },
  { bookId: 'b1', book: '', problem: item('p2', 7, 0, 0.5), answer: item('a2', 7, 1, 0.5), src: { problem: src, answer: src } },
];
const label = (role, it) => `p.${it.page + 1}`;
const TRANSCRIBED = {
  p1: [
    { type: 'para', text: '함수 $f(x)=\\frac{1}{2}x^{2}$ 에 대하여 $\\sqrt[3]{8}+\\log_{2} 4$ 의 값은? [3점] & <확인>' },
    { type: 'math', latex: 'a_{n}=2^{n}-1' },
    { type: 'figure', box: { x: 0.5, y: 0.2, w: 0.4, h: 0.5 } },
    { type: 'choices', items: ['$1$', '$2$', '$\\frac{5}{2}$', '$3$', '$\\sqrt{10}$'] },
  ],
  a1: [{ type: 'para', text: '$f(2)=2$ 이므로 답은 ②' }],
};

async function build(overrides = {}) {
  const calls = { transcribe: [], render: [] };
  const opts = { columns: 2, space: 'small', labels: true, renumber: true, ...(overrides.options || {}) };
  const blocks = makeBlocks(overrides.mode || 'both-end', entries, opts, label);
  const bytes = await buildHwpx({
    blocks,
    options: opts,
    title: '수학 <오답> & 복습',
    info: { title: '수학 <오답> & 복습', subtitle: '문제 2문항', academy: '오답학원', teacher: '김선생', student: '홍길동', date: '2026. 11. 1.' },
    transcribe:
      overrides.transcribe ||
      (async (block, segs) => {
        calls.transcribe.push(block.item.id);
        assert.ok(segs.length > 0);
        const list = TRANSCRIBED[block.item.id];
        return list ? { blocks: list, crop: async () => fakeImg('png', 300, 200) } : null;
      }),
    renderSeg: async (seg) => {
      calls.render.push(seg.block.item.id);
      return fakeImg('jpg', 1100, 330);
    },
  });
  const files = unzip(bytes);
  const get = (name) => files.find((f) => f.name === name);
  const xml = (name) => parseXml(get(name).data.toString('utf8'), name);
  return { bytes, files, get, xml, calls };
}

// ---------------------------------------------------------------------------
test('hwpx: ZIP — mimetype 이 맨 앞·압축 없음, CRC 맞음, 필요한 파일 모두', async () => {
  const { files } = await build();
  const first = files[0];
  assert.equal(first.name, 'mimetype');
  assert.equal(first.method, 0);
  assert.equal(first.offset, 0);
  assert.equal(first.localExtra, 0);
  assert.equal(first.data.toString('ascii'), 'application/hwp+zip');
  for (const f of files) {
    assert.equal(crc32(f.data), f.crc, `${f.name} CRC(직접 셈)`);
    assert.equal(zlib.crc32(f.data), f.crc, `${f.name} CRC(zlib)`);
  }
  const names = files.map((f) => f.name);
  for (const need of ['version.xml', 'META-INF/container.xml', 'META-INF/manifest.xml', 'Contents/content.hpf', 'Contents/header.xml', 'Contents/section0.xml', 'settings.xml']) {
    assert.ok(names.includes(need), need);
  }
  // XML 은 압축, 그림은 그대로
  assert.equal(files.find((f) => f.name === 'Contents/section0.xml').method, 8);
  for (const f of files.filter((x) => x.name.startsWith('BinData/'))) assert.equal(f.method, 0);
});

test('hwpx: 모든 XML 이 바른 모양', async () => {
  const { files } = await build();
  for (const f of files.filter((x) => /\.(xml|hpf|rdf)$/.test(x.name))) {
    const text = f.data.toString('utf8');
    assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-8"'), `${f.name} XML 선언`);
    parseXml(text, f.name);
  }
});

test('hwpx: header 의 개수(itemCnt)와 모든 IDRef 가 맞음', async () => {
  const { xml, files } = await build();
  const head = xml('Contents/header.xml');
  const sec = xml('Contents/section0.xml');
  const hpf = xml('Contents/content.hpf');
  const ids = (name) => new Set(all(head, name).map((e) => e.attrs.id));
  for (const [list, child] of [
    ['hh:fontfaces', 'hh:fontface'],
    ['hh:borderFills', 'hh:borderFill'],
    ['hh:charProperties', 'hh:charPr'],
    ['hh:tabProperties', 'hh:tabPr'],
    ['hh:numberings', 'hh:numbering'],
    ['hh:paraProperties', 'hh:paraPr'],
    ['hh:styles', 'hh:style'],
  ]) {
    const el = all(head, list)[0];
    assert.ok(el, list);
    const kids = el.children.filter((c) => c.name === child);
    assert.equal(Number(el.attrs.itemCnt), kids.length, `${list} itemCnt`);
    assert.equal(kids.length, el.children.length, `${list} 다른 자식 없음`);
    if (child !== 'hh:fontface') assert.equal(new Set(kids.map((k) => k.attrs.id)).size, kids.length, `${child} id 겹침`);
  }
  assert.deepEqual(all(head, 'hh:fontface').map((f) => f.attrs.lang), ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER']);
  for (const f of all(head, 'hh:fontface')) assert.equal(Number(f.attrs.fontCnt), f.children.length);
  assert.deepEqual(all(head, 'hh:fontface')[0].children.map((f) => f.attrs.face), ['함초롬바탕', '함초롬돋움']);

  const refs = {
    charPrIDRef: ids('hh:charPr'),
    paraPrIDRef: ids('hh:paraPr'),
    borderFillIDRef: ids('hh:borderFill'),
    tabPrIDRef: ids('hh:tabPr'),
    styleIDRef: ids('hh:style'),
    outlineShapeIDRef: ids('hh:numbering'),
  };
  const fontIds = new Set(all(head, 'hh:font').map((f) => f.attrs.id));
  let checked = 0;
  for (const root of [head, sec]) {
    const walk = (el) => {
      for (const [attr, set] of Object.entries(refs)) {
        // 4294967295(0xFFFFFFFF) 는 한글이 "없음"으로 쓰는 값 (문단 번호의 글자 모양)
        if (attr in el.attrs && !(el.name === 'hh:paraHead' && el.attrs[attr] === '4294967295')) {
          assert.ok(set.has(el.attrs[attr]), `${el.name} ${attr}=${el.attrs[attr]}`);
          checked++;
        }
      }
      if (el.name === 'hh:fontRef') for (const v of Object.values(el.attrs)) assert.ok(fontIds.has(v), `fontRef ${v}`);
      el.children.forEach(walk);
    };
    walk(root);
  }
  assert.ok(checked > 50);
  // 그림: 본문이 가리키는 것 = content.hpf 목록 = ZIP 안의 BinData
  const manifest = all(hpf, 'opf:item').filter((i) => i.attrs.href.startsWith('BinData/'));
  const binNames = files.filter((f) => f.name.startsWith('BinData/')).map((f) => f.name).sort();
  assert.deepEqual(manifest.map((i) => i.attrs.href).sort(), binNames);
  for (const i of manifest) {
    assert.equal(i.attrs.isEmbeded, '1');
    assert.equal(i.attrs['media-type'], i.attrs.href.endsWith('.png') ? 'image/png' : 'image/jpg');
  }
  const used = all(sec, 'hc:img').map((e) => e.attrs.binaryItemIDRef);
  assert.deepEqual([...new Set(used)].sort(), manifest.map((i) => i.attrs.id).sort());
  for (const href of ['Contents/header.xml', 'Contents/section0.xml', 'settings.xml']) assert.ok(all(hpf, 'opf:item').some((i) => i.attrs.href === href), href);
});

test('hwpx: 시험지 — 머리 표, 수식, 그림, 보기, 2단, 해설 쪽 나누기, 쪽 번호', async () => {
  const { xml, calls } = await build();
  const sec = xml('Contents/section0.xml');
  const paras = sec.children.filter((c) => c.name === 'hp:p');
  // 첫 문단: 구역 설정 + 1단 + 쪽 번호
  const first = paras[0];
  assert.ok(all(first, 'hp:secPr').length === 1);
  const pagePr = all(first, 'hp:pagePr')[0];
  assert.equal(pagePr.attrs.width, '59528');
  assert.equal(pagePr.attrs.height, '84188');
  assert.equal(all(first, 'hp:colPr')[0].attrs.colCount, '1');
  assert.deepEqual(all(first, 'hp:pageNum')[0].attrs, { pos: 'BOTTOM_CENTER', formatType: 'DIGIT', sideChar: '-' });
  assert.equal(all(sec, 'hp:secPr').length, 1);
  // 2단은 본문 첫 문단에서 시작 (구분선 포함)
  const cols2 = all(sec, 'hp:colPr').filter((c) => c.attrs.colCount === '2');
  assert.equal(cols2.length, 1);
  assert.equal(cols2[0].children[0].name, 'hp:colLine');
  // 머리: 제목(이스케이프), 학원·선생님·학생·점수 8칸 표
  const text = textOf(sec);
  assert.ok(text.includes('수학 <오답> & 복습'));
  const tbl = all(sec, 'hp:tbl')[0];
  assert.equal(tbl.attrs.colCnt, '8');
  assert.equal(all(tbl, 'hp:tc').length, 8);
  assert.deepEqual(all(tbl, 'hp:t').map(textOf), ['학원', '오답학원', '선생님', '김선생', '학생', '홍길동', '점수']);
  // 라벨: 새 번호 + 출처
  assert.ok(text.includes('1.') && text.includes('p.1 3번'));
  // 수식: 글 속 수식 + 따로 한 줄 + 보기
  const scripts = all(sec, 'hp:script').map(textOf);
  assert.ok(scripts.includes('f(x)={{1} over {2}}x^{2}'), scripts.join(' | '));
  assert.ok(scripts.includes('root {3} of {8} + log _{2} 4'));
  assert.ok(scripts.includes('a_{n}=2^{n}-1'));
  assert.ok(scripts.includes('{5} over {2}') && scripts.includes('sqrt {10}'));
  for (const eq of all(sec, 'hp:equation')) {
    assert.equal(eq.attrs.version, 'Equation Version 60');
    assert.equal(eq.attrs.baseUnit, '1000');
    assert.deepEqual(eq.children.map((c) => c.name), ['hp:sz', 'hp:pos', 'hp:outMargin', 'hp:shapeComment', 'hp:script']);
    assert.equal(all(eq, 'hp:pos')[0].attrs.treatAsChar, '1');
    assert.ok(Number(all(eq, 'hp:sz')[0].attrs.width) > 0);
  }
  assert.ok(text.includes('[3점] & <확인>'));
  // 보기 5개는 한 줄 (탭으로 띄움)
  const choicePara = paras.find((p) => textOf(p).includes('①'));
  assert.ok(['②', '③', '④', '⑤'].every((m) => textOf(choicePara).includes(m)));
  assert.equal(all(choicePara, 'hp:tab').length, 4);
  // 그림: 2번 문제는 그림으로(글자로 못 옮김), 1번 문제의 도형은 잘라서
  assert.deepEqual(calls.transcribe, ['p1', 'p2', 'a1', 'a2']);
  assert.deepEqual(calls.render, ['p2', 'a2']);
  const pics = all(sec, 'hp:pic');
  assert.equal(pics.length, 3);
  for (const pic of pics) {
    assert.equal(all(pic, 'hp:pos')[0].attrs.treatAsChar, '1');
    const names = pic.children.map((c) => c.name);
    for (const need of ['hp:offset', 'hp:orgSz', 'hp:curSz', 'hp:flip', 'hp:rotationInfo', 'hp:renderingInfo', 'hc:img', 'hp:imgRect', 'hp:imgClip', 'hp:inMargin', 'hp:imgDim', 'hp:effects', 'hp:sz', 'hp:outMargin']) {
      assert.ok(names.includes(need), need);
    }
    // 단 폭(2단) 안에 들어감
    assert.ok(Number(all(pic, 'hp:sz')[0].attrs.width) <= (59528 - 2 * 3685 - 2200) / 2 + 1);
  }
  // 해설은 새 쪽에서 "정답 및 해설"
  const sectionPara = paras.find((p) => textOf(p) === '정답 및 해설');
  assert.ok(sectionPara);
  assert.equal(sectionPara.attrs.pageBreak, '1');
  assert.equal(paras.filter((p) => p.attrs.pageBreak === '1').length, 1);
});

test('hwpx: 한 쪽에 한 문제 → 문제마다 쪽 나누기, 1단', async () => {
  const { xml } = await build({ mode: 'problems', options: { columns: 1, space: 'page' } });
  const sec = xml('Contents/section0.xml');
  assert.equal(all(sec, 'hp:colPr').length, 1);
  const breaks = sec.children.filter((p) => p.attrs.pageBreak === '1');
  assert.equal(breaks.length, 1); // 두 문제 사이 한 번 (마지막 뒤에는 빈 쪽을 만들지 않음)
  assert.ok(textOf(breaks[0]).startsWith('2.'));
});

test('hwpx: 옮기기 실패는 그 문항만 그림으로, 취소(AbortError)는 그대로 던짐', async () => {
  const { xml, calls } = await build({
    mode: 'problems',
    transcribe: async (block) => {
      if (block.item.id === 'p1') throw new Error('Gemini 오류');
      return { blocks: TRANSCRIBED.p1 };
    },
  });
  const sec = xml('Contents/section0.xml');
  assert.deepEqual(calls.render, ['p1']);
  assert.ok(all(sec, 'hp:equation').length > 0);
  await assert.rejects(
    build({
      transcribe: async () => {
        throw new DOMException('취소됨', 'AbortError');
      },
    }),
    { name: 'AbortError' },
  );
});

test('hwpx: 옮기기가 없으면 모두 그림', async () => {
  const blocks = makeBlocks('problems', entries, {}, label);
  const bytes = await buildHwpx({ blocks, options: {}, title: 't', info: {}, renderSeg: async () => fakeImg('jpg', 800, 240) });
  assert.deepEqual(bytes.stats, { text: 0, picture: 2 });
  const sec = parseXml(unzip(bytes).find((f) => f.name === 'Contents/section0.xml').data.toString('utf8'), 'section0');
  assert.equal(all(sec, 'hp:pic').length, 2);
  assert.equal(all(sec, 'hp:equation').length, 0);
});

test('splitMath: 글 속 수식과 따로 줄 수식', () => {
  assert.deepEqual(splitMath('값 $x^2$ 과 $$y=1$$ 끝 \\$5'), [
    { type: 'text', v: '값 ' },
    { type: 'math', v: 'x^2', display: false },
    { type: 'text', v: ' 과 ' },
    { type: 'math', v: 'y=1', display: true },
    { type: 'text', v: ' 끝 $5' },
  ]);
  assert.deepEqual(splitMath('짝 없는 $ 기호'), [{ type: 'text', v: '짝 없는 $ 기호' }]);
  assert.deepEqual(splitMath('\\(a\\) 와 \\[b\\]'), [
    { type: 'math', v: 'a', display: false },
    { type: 'text', v: ' 와 ' },
    { type: 'math', v: 'b', display: true },
  ]);
});

test('stripStemLabel: 공통 지문 앞의 범위 표시만 뗌', () => {
  const cases = [
    ['[0030~0037] 다음 식을 간단히 하시오.', '다음 식을 간단히 하시오.'],
    ['[30~37] 다음', '다음'],
    ['［0030～0037］다음', '다음'],
    ['【0030∼0037】 다음', '다음'],
    ['〔0030 〜 0037〕 다음', '다음'],
    ['[0030-0037] 다음', '다음'],
    ['[0030~0037번] 다음', '다음'],
    ['$[0030 \\sim 0037]$ 다음', '다음'],
    ['[0030$\\sim$0037] 다음', '다음'],
    ['[0030~0037] $a>0$ 일 때', '$a>0$ 일 때'], // 같이 떼어진 $ 는 되돌림
    ['$[0030 \\sim 0037]$', ''],
  ];
  for (const [input, want] of cases) assert.equal(stripStemLabel(input), want, input);
  for (const keep of ['[보기] 다음', '[3점] 다음', '다음 [0030~0037] 에서', '[1, 2] 에서', '$[1, 3]$ 에서 정의된', '0030 다음']) {
    assert.equal(stripStemLabel(keep), keep);
  }
});

// ---------------------------------------------------------------------------
// 공통 지문: 이어지는 문항마다 지문을 싣고, 범위 표시와 다시 적힌 문항 번호는 뗌
// ---------------------------------------------------------------------------
test('hwpx: 공통 지문 — 문항마다 싣고 "[0030~0037]" 과 다시 적힌 번호는 뗌', async () => {
  const STEM = [{ page: 0, x: 0.08, y: 0.02, w: 0.4, h: 0.04 }];
  const list = ['0030', '0032', '0033'].map((n, i) => ({ bookId: 'b1', book: '', problem: { ...item(`s${n}`, n, 0, 0.1 + i * 0.1), stem: STEM }, answer: null, src: { problem: src, answer: src } }));
  const T = {
    s0030: [{ type: 'para', text: '[0030~0037] 다음 식을 간단히 하시오. (단, $a>0$, $b>0$)' }, { type: 'math', latex: '2^{3}' }],
    s0032: [{ type: 'para', text: '［0030～0037］다음 식을 간단히 하시오. (단, $a>0$, $b>0$)' }, { type: 'para', text: '0032 $\\sqrt{a}$' }],
    s0033: [{ type: 'para', text: '$[30 \\sim 37]$ 다음 식을 간단히 하시오. (단, $a>0$, $b>0$)' }, { type: 'para', text: '$b^{2}$' }],
  };
  const stemSegs = [];
  const opts = { columns: 2, space: 'none', labels: true, renumber: true };
  const bytes = await buildHwpx({
    blocks: makeBlocks('problems', list, opts, label),
    options: opts,
    title: '지문',
    info: {},
    transcribe: async (block, segs) => {
      stemSegs.push(segs.filter((s) => s.rect.stem).length);
      return { blocks: T[block.item.id] };
    },
  });
  // 글자로 옮길 때도 문항마다 지문 영역이 함께 감
  assert.deepEqual(stemSegs, [1, 1, 1]);
  const files = unzip(bytes);
  const sec = parseXml(files.find((f) => f.name === 'Contents/section0.xml').data.toString('utf8'), 'section0');
  const paras = sec.children.filter((c) => c.name === 'hp:p');
  const stemParas = paras.filter((p) => textOf(p).includes('다음 식을 간단히 하시오.'));
  assert.equal(stemParas.length, 3);
  // (textOf 는 수식의 설명·스크립트 글자도 이어 붙임)
  stemParas.forEach((p, i) => assert.equal(textOf(p), `${i + 1}.다음 식을 간단히 하시오. (단, 수식입니다.a>0, 수식입니다.b>0)`));
  // 0032 는 지문 아래에 다시 적힌 문항 번호 → 뗌
  const p32 = paras.find((p) => all(p, 'hp:script').some((s) => textOf(s) === 'sqrt {a}'));
  assert.equal(textOf(p32), '수식입니다.sqrt {a}');
  const prv = files.find((f) => f.name === 'Preview/PrvText.txt').data.toString('utf8');
  assert.ok(!/0030~0037|～|30 \\sim/.test(prv), prv);
});

// ---------------------------------------------------------------------------
// 시험지 모양
// ---------------------------------------------------------------------------
test('hwpx: 시험지 모양 — 번호 내어쓰기·강조색, 출처는 작고 흐리게, 둘째 쪽부터 머리말', async () => {
  const { xml } = await build();
  const head = xml('Contents/header.xml');
  const sec = xml('Contents/section0.xml');
  const charPr = new Map(all(head, 'hh:charPr').map((c) => [c.attrs.id, c]));
  const paraPr = new Map(all(head, 'hh:paraPr').map((p) => [p.attrs.id, p]));
  const tabPr = new Map(all(head, 'hh:tabPr').map((t) => [t.attrs.id, t]));
  const paras = sec.children.filter((c) => c.name === 'hp:p');
  const runOf = (p, s) => p.children.find((r) => r.name === 'hp:run' && all(r, 'hp:t').some((t) => t.text === s));
  const margin = (p) => {
    const m = all(paraPr.get(p.attrs.paraPrIDRef), 'hp:case')[0];
    return Object.fromEntries(all(m, 'hh:margin')[0].children.map((c) => [c.name.slice(3), Number(c.attrs.value)]));
  };

  // 번호: 첫 글 문단 앞에 굵은 강조색으로, 내어쓰기 + 번호 자리 탭
  const p1 = paras.find((p) => textOf(p).startsWith('1.') && textOf(p).includes('함수'));
  assert.ok(p1, '번호와 문제 글이 한 문단');
  const num = charPr.get(runOf(p1, '1.').attrs.charPrIDRef);
  assert.equal(num.attrs.textColor, '#1F4E8C');
  assert.ok(all(num, 'hh:bold').length === 1);
  assert.ok(margin(p1).intent < 0 && margin(p1).left === 0);
  const hang = -margin(p1).intent;
  const tabs = all(tabPr.get(paraPr.get(p1.attrs.paraPrIDRef).attrs.tabPrIDRef), 'hp:case')[0];
  assert.deepEqual(all(tabs, 'hh:tabItem').map((t) => Number(t.attrs.pos)), [hang]);
  // 같은 문항의 다음 문단(보기 등)은 번호 자리만큼 들여 씀
  const choice = paras.find((p) => textOf(p).includes('①'));
  assert.equal(margin(choice).left, hang);
  // 번호 글자 모양은 문항마다 같음
  const numIds = paras.flatMap((p) => p.children.filter((r) => r.name === 'hp:run' && /^\d+\.$/.test(all(r, 'hp:t').map(textOf).join(''))).map((r) => r.attrs.charPrIDRef));
  assert.ok(numIds.length >= 4);
  assert.equal(new Set(numIds).size, 1);
  // 출처: 작고 회색, 오른쪽 정렬
  const srcPara = paras.find((p) => textOf(p) === 'p.1 3번');
  const srcChar = charPr.get(srcPara.children[0].attrs.charPrIDRef);
  assert.equal(srcChar.attrs.height, '800');
  assert.equal(srcChar.attrs.textColor, '#8A8F98');
  assert.equal(all(paraPr.get(srcPara.attrs.paraPrIDRef), 'hh:align')[0].attrs.horizontal, 'RIGHT');
  // 본문은 바탕체, 번호는 돋움체
  const body = charPr.get(p1.children.find((r) => r.name === 'hp:run' && r !== runOf(p1, '1.') && all(r, 'hp:t').length).attrs.charPrIDRef);
  assert.equal(all(body, 'hh:fontRef')[0].attrs.hangul, '0');
  assert.equal(all(num, 'hh:fontRef')[0].attrs.hangul, '1');
  // 둘째 쪽부터 머리말 (학원 · 제목 … 학생), 첫 쪽은 숨김
  assert.equal(all(paras[0], 'hp:visibility')[0].attrs.hideFirstHeader, '1');
  const header = all(paras[0], 'hp:header')[0];
  assert.ok(header);
  assert.equal(textOf(header), '오답학원  ·  수학 <오답> & 복습홍길동');
});

test('hwpx: 보기 — 짧으면 한 줄, 중간이면 3+2, 길면 한 줄에 하나', async () => {
  const short = ['$1$', '$2$', '$3$', '$4$', '$5$'];
  const medium = ['$\\log_{2} 3 + 1$', '$\\log_{2} 5 + 1$', '$\\log_{2} 6 + 1$', '$\\log_{2} 7 + 1$', '$\\log_{2} 9 + 1$'];
  const long = ['그래프는 점 $(1, 2)$를 지나고 직선 $y=x$에 대하여 대칭이다.', '둘', '셋', '넷', '다섯'];
  const { xml } = await build({
    mode: 'problems',
    transcribe: async (block) => (block.item.id === 'p1' ? { blocks: [{ type: 'para', text: '보기' }, ...[short, medium, long].map((items) => ({ type: 'choices', items }))] } : null),
  });
  const head = xml('Contents/header.xml');
  const sec = xml('Contents/section0.xml');
  const paraPr = new Map(all(head, 'hh:paraPr').map((p) => [p.attrs.id, p]));
  const tabPr = new Map(all(head, 'hh:tabPr').map((t) => [t.attrs.id, t]));
  const rows = sec.children.filter((p) => p.name === 'hp:p' && /[①-⑤]/.test(textOf(p)));
  const marks = rows.map((p) => textOf(p).match(/[①-⑤]/g).join(''));
  assert.deepEqual(marks, ['①②③④⑤', '①②③', '④⑤', '①', '②', '③', '④', '⑤']);
  assert.deepEqual(rows.map((p) => all(p, 'hp:tab').length), [4, 2, 1, 0, 0, 0, 0, 0]);
  // 3+2 의 탭 위치: 번호 자리(들여 쓴 만큼)에서 시작해 같은 간격
  const stops = all(all(tabPr.get(paraPr.get(rows[1].attrs.paraPrIDRef).attrs.tabPrIDRef), 'hp:case')[0], 'hh:tabItem').map((t) => Number(t.attrs.pos));
  const left = Number(all(all(paraPr.get(rows[1].attrs.paraPrIDRef), 'hp:case')[0], 'hc:left')[0].attrs.value);
  assert.equal(stops.length, 2);
  assert.ok(left > 0);
  assert.equal(stops[1] - stops[0], stops[0] - left);
});

test('hwpx: 수식 크기는 한글 수식 크기 셈(convertLatex)과 같음 — 글 속 수식이 뒤 글자와 겹치지 않게', async () => {
  const { xml } = await build();
  const sec = xml('Contents/section0.xml');
  const eq = all(sec, 'hp:equation').find((e) => textOf(all(e, 'hp:script')[0]) === 'f(x)={{1} over {2}}x^{2}');
  const want = convertLatex('f(x)=\\frac{1}{2}x^{2}');
  const sz = all(eq, 'hp:sz')[0].attrs;
  assert.equal(Number(sz.width), want.width);
  assert.equal(Number(sz.height), want.height);
  assert.equal(Number(eq.attrs.baseLine), want.baseLine);
  assert.ok(want.width >= 5335); // 한글이 잰 폭
});
