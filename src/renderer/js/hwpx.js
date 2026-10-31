// 선택한 문항(문제/해설)을 한글 문서(HWPX, OWPML)로 만듭니다.
//  - 한글(2014 이상)에서 열어 고칠 수 있는 시험지: 글자는 글자로, 수식은 한글 수식(hp:equation)으로
//  - 글자로 옮긴(transcribe) 문항은 글자+수식, 못 옮긴 문항은 원본 영역을 그림으로
//  - 그림 그리기(renderSeg)와 글자 옮기기(transcribe)는 밖에서 넣을 수 있어 Node 에서도 시험할 수 있음
//  - ZIP 묶기도 직접 (mimetype 은 맨 앞에 압축 없이)

import { convertLatex } from './hwpeq.js';
import { DEFAULT_EXPORT_OPTIONS, SPACE_OPTIONS, unitScale } from './exporter.js';

// 길이 단위: HWPUNIT (1pt = 100)
const PT = 100;
const mm = (v) => Math.round((v * 7200) / 25.4);
const PAGE = { w: 59528, h: 84188 }; // A4
// 본문 위 = top + header, 본문 아래 = bottom + footer (쪽 번호는 꼬리말 자리에)
const MARGIN = { left: mm(13), right: mm(13), top: mm(5), header: mm(11), bottom: mm(5), footer: mm(10) };
const CONTENT_W = PAGE.w - MARGIN.left - MARGIN.right;
const BODY_H = PAGE.h - MARGIN.top - MARGIN.header - MARGIN.bottom - MARGIN.footer;
const COL_GAP = 22 * PT;
const RASTER_DPI = 200;
const BASE_UNIT = 1000; // 수식 글자 크기 10pt
const FONT = '맑은 고딕';
const EQ_FONT = 'HancomEQN';
const CHOICE_MARKS = '①②③④⑤⑥⑦⑧⑨⑩';

const NS =
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
const UNIT_NS = 'http://www.hancom.co.kr/hwpml/2016/HwpUnitChar';

/** XML 글자/속성 값 이스케이프 (XML 에 넣을 수 없는 제어 문자는 뺌) */
export function esc(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// header.xml: 글자 모양·문단 모양·테두리·탭을 쓰는 대로 모아 번호를 매김
// ---------------------------------------------------------------------------
const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
const LANG_ATTR = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
const perLang = (v) => LANG_ATTR.map((k) => `${k}="${v}"`).join(' ');

const CHAR_DEFAULT = { size: 1000, bold: false, color: '#000000' };
const PARA_DEFAULT = { align: 'JUSTIFY', line: 160, prev: 0, next: 0, left: 0, indent: 0, keep: 0, tab: 0, fill: 2 };
const NO_LINE = ['NONE', '0.1 mm', '#000000'];

function makeHead() {
  const lists = { fill: [], char: [], para: [], tab: [] };
  const ids = new Map();
  const add = (kind, spec, base = 0) => {
    const key = `${kind}:${JSON.stringify(spec)}`;
    if (!ids.has(key)) {
      ids.set(key, lists[kind].length + base);
      lists[kind].push(spec);
    }
    return ids.get(key);
  };
  const head = {
    /** 테두리/배경 (id 는 1부터) */
    fill: (spec) => add('fill', { left: NO_LINE, right: NO_LINE, top: NO_LINE, bottom: NO_LINE, face: null, ...spec }, 1),
    char: (spec = {}) => add('char', { ...CHAR_DEFAULT, ...spec }),
    para: (spec = {}) => add('para', { ...PARA_DEFAULT, ...spec }),
    /** 탭 위치: [{pos, type:'LEFT'|'RIGHT'}] */
    tab: (items = []) => add('tab', items),
    lists,
  };
  // 기본값을 0번(테두리는 1·2번)에 고정
  head.fill({}); // 1: 쪽 테두리 등 (선 없음)
  head.fill({ face: 'none' }); // 2: 글자·문단 기본
  head.char({});
  head.para({});
  head.tab([]);
  return head;
}

function fillXml(spec, id) {
  const line = (tag, [type, width, color]) => `<hh:${tag} type="${type}" width="${width}" color="${color}"/>`;
  const brush = spec.face ? `<hc:fillBrush><hc:winBrush faceColor="${spec.face}" hatchColor="#999999" alpha="0"/></hc:fillBrush>` : '';
  return (
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
    '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
    line('leftBorder', spec.left) +
    line('rightBorder', spec.right) +
    line('topBorder', spec.top) +
    line('bottomBorder', spec.bottom) +
    '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>' +
    `${brush}</hh:borderFill>`
  );
}

function charXml(spec, id) {
  return (
    `<hh:charPr id="${id}" height="${spec.size}" textColor="${spec.color}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">` +
    `<hh:fontRef ${perLang(0)}/><hh:ratio ${perLang(100)}/><hh:spacing ${perLang(0)}/><hh:relSz ${perLang(100)}/><hh:offset ${perLang(0)}/>` +
    (spec.bold ? '<hh:bold/>' : '') +
    '<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/>' +
    '<hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/></hh:charPr>'
  );
}

function paraXml(spec, id) {
  // 예전 형식(hp:default)은 여백 값을 두 배로 적음 (한글이 쓰는 방식 그대로)
  const margin = (k) =>
    `<hh:margin><hc:intent value="${spec.indent * k}" unit="HWPUNIT"/><hc:left value="${spec.left * k}" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/>` +
    `<hc:prev value="${spec.prev * k}" unit="HWPUNIT"/><hc:next value="${spec.next * k}" unit="HWPUNIT"/></hh:margin>` +
    `<hh:lineSpacing type="PERCENT" value="${spec.line}" unit="HWPUNIT"/>`;
  return (
    `<hh:paraPr id="${id}" tabPrIDRef="${spec.tab}" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0" textDir="LTR">` +
    `<hh:align horizontal="${spec.align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>` +
    `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="${spec.keep}" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>` +
    '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>' +
    `<hp:switch><hp:case hp:required-namespace="${UNIT_NS}">${margin(1)}</hp:case><hp:default>${margin(2)}</hp:default></hp:switch>` +
    `<hh:border borderFillIDRef="${spec.fill}" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`
  );
}

function tabXml(items, id) {
  if (!items.length) return `<hh:tabPr id="${id}" autoTabLeft="0" autoTabRight="0"/>`;
  const item = (t, k) => `<hh:tabItem pos="${t.pos * k}" type="${t.type}" leader="NONE"${k === 1 ? ' unit="HWPUNIT"' : ''}/>`;
  return (
    `<hh:tabPr id="${id}" autoTabLeft="0" autoTabRight="0"><hp:switch>` +
    `<hp:case hp:required-namespace="${UNIT_NS}">${items.map((t) => item(t, 1)).join('')}</hp:case>` +
    `<hp:default>${items.map((t) => item(t, 2)).join('')}</hp:default></hp:switch></hh:tabPr>`
  );
}

const NUMBER_FORMATS = [
  ['DIGIT', '^1.'], ['HANGUL_SYLLABLE', '^2.'], ['DIGIT', '^3)'], ['HANGUL_SYLLABLE', '^4)'], ['DIGIT', '(^5)'],
  ['HANGUL_SYLLABLE', '(^6)'], ['CIRCLED_DIGIT', '^7'], ['CIRCLED_HANGUL_SYLLABLE', '^8'], ['HANGUL_JAMO', ''], ['ROMAN_SMALL', ''],
];

function headerXml(head, pageNumChar) {
  const { fill, char, para, tab } = head.lists;
  const font = `<hh:font id="0" face="${FONT}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="5" proportion="3" contrast="2" strokeVariation="0" armStyle="0" letterform="2" midline="0" xHeight="4"/></hh:font>`;
  const numbering = NUMBER_FORMATS.map(([fmt, text], i) => {
    const attrs = `start="1" level="${i + 1}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="${fmt}" charPrIDRef="4294967295" checkable="${i === 6 || i === 7 || i === 9 ? 1 : 0}"`;
    return text ? `<hh:paraHead ${attrs}>${text}</hh:paraHead>` : `<hh:paraHead ${attrs}/>`;
  }).join('');
  return (
    `${XML_HEAD}<hh:head ${NS} version="1.5" secCnt="1">` +
    '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>' +
    `<hh:fontfaces itemCnt="${LANGS.length}">${LANGS.map((l) => `<hh:fontface lang="${l}" fontCnt="1">${font}</hh:fontface>`).join('')}</hh:fontfaces>` +
    `<hh:borderFills itemCnt="${fill.length}">${fill.map((s, i) => fillXml(s, i + 1)).join('')}</hh:borderFills>` +
    `<hh:charProperties itemCnt="${char.length}">${char.map(charXml).join('')}</hh:charProperties>` +
    `<hh:tabProperties itemCnt="${tab.length}">${tab.map(tabXml).join('')}</hh:tabProperties>` +
    `<hh:numberings itemCnt="1"><hh:numbering id="1" start="0">${numbering}</hh:numbering></hh:numberings>` +
    `<hh:paraProperties itemCnt="${para.length}">${para.map(paraXml).join('')}</hh:paraProperties>` +
    '<hh:styles itemCnt="2">' +
    '<hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>' +
    `<hh:style id="1" type="CHAR" name="쪽 번호" engName="Page Number" paraPrIDRef="0" charPrIDRef="${pageNumChar}" nextStyleIDRef="0" langID="1042" lockForm="0"/>` +
    '</hh:styles></hh:refList>' +
    '<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>' +
    '<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>' +
    '<hh:trackchageConfig flags="56"/></hh:head>'
  );
}

// ---------------------------------------------------------------------------
// section0.xml 조각
// ---------------------------------------------------------------------------
function secPrXml() {
  const note = (len, place) =>
    `<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="${len}" type="SOLID" width="0.12 mm" color="#000000"/>` +
    `<hp:noteSpacing betweenNotes="${place === 'EACH_COLUMN' ? 283 : 0}" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="${place}" beneathText="0"/>`;
  const border = (type) =>
    `<hp:pageBorderFill type="${type}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`;
  return (
    '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">' +
    '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
    '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>' +
    '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>' +
    `<hp:pagePr landscape="WIDELY" width="${PAGE.w}" height="${PAGE.h}" gutterType="LEFT_ONLY">` +
    `<hp:margin header="${MARGIN.header}" footer="${MARGIN.footer}" gutter="0" left="${MARGIN.left}" right="${MARGIN.right}" top="${MARGIN.top}" bottom="${MARGIN.bottom}"/></hp:pagePr>` +
    `<hp:footNotePr>${note(-1, 'EACH_COLUMN')}</hp:footNotePr><hp:endNotePr>${note(14692344, 'END_OF_DOCUMENT')}</hp:endNotePr>` +
    `${border('BOTH')}${border('EVEN')}${border('ODD')}</hp:secPr>`
  );
}

function colPrXml(cols) {
  if (cols < 2) return '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>';
  return `<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="${cols}" sameSz="1" sameGap="${COL_GAP}"><hp:colLine type="SOLID" width="0.12 mm" color="#B4B4B4"/></hp:colPr></hp:ctrl>`;
}

const PAGE_NUM_XML = '<hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl>';

const POS_INLINE =
  '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>';
const sizeXml = (w, h) => `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`;

function equationXml(eq, ids) {
  return (
    `<hp:equation id="${ids.obj()}" zOrder="${ids.z()}" numberingType="EQUATION" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" ` +
    `version="Equation Version 60" baseLine="${eq.baseLine}" textColor="#000000" baseUnit="${BASE_UNIT}" lineMode="CHAR" font="${EQ_FONT}">` +
    `${sizeXml(eq.width, eq.height)}${POS_INLINE}<hp:outMargin left="56" right="56" top="0" bottom="0"/>` +
    `<hp:shapeComment>수식입니다.</hp:shapeComment><hp:script>${esc(eq.script)}</hp:script></hp:equation>`
  );
}

/** 글자처럼 줄에 놓이는 그림. w,h: HWPUNIT, img: {binId, pxW, pxH} */
function picXml(img, w, h, ids) {
  const dimW = img.pxW * 75; // 그림 원래 크기(96 DPI 기준)
  const dimH = img.pxH * 75;
  const id = ids.obj();
  return (
    `<hp:pic id="${id}" zOrder="${ids.z()}" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id - 1000000}" reverse="0">` +
    `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="0" vertical="0"/>` +
    `<hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/>` +
    '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>' +
    `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>` +
    `<hp:imgClip left="0" right="${dimW}" top="0" bottom="${dimH}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
    `<hp:imgDim dimwidth="${dimW}" dimheight="${dimH}"/><hc:img binaryItemIDRef="${img.binId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>` +
    `${sizeXml(w, h)}${POS_INLINE}<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment>그림입니다.</hp:shapeComment></hp:pic>`
  );
}

/** 한 줄짜리 표. cells: {text, cp, fill, width}[], tableFill: 표 자체 테두리 */
function tableXml(cells, height, ids, { cellPara, tableFill }) {
  const width = cells.reduce((s, c) => s + c.width, 0);
  let x = 0;
  const tcs = cells
    .map((c, i) => {
      const run = c.text ? `<hp:run charPrIDRef="${c.cp}"><hp:t>${esc(c.text)}</hp:t></hp:run>` : `<hp:run charPrIDRef="${c.cp}"/>`;
      x += c.width;
      return (
        `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${c.fill}">` +
        '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">' +
        `<hp:p id="2147483648" paraPrIDRef="${c.pp ?? cellPara}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${run}</hp:p></hp:subList>` +
        `<hp:cellAddr colAddr="${i}" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${c.width}" height="${height}"/>` +
        '<hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>'
      );
    })
    .join('');
  return (
    `<hp:tbl id="${ids.obj()}" zOrder="${ids.z()}" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="1" colCnt="${cells.length}" cellSpacing="0" borderFillIDRef="${tableFill}" noAdjust="0">` +
    `${sizeXml(width, height)}${POS_INLINE}<hp:outMargin left="141" right="141" top="141" bottom="141"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>` +
    `<hp:tr>${tcs}</hp:tr></hp:tbl>`
  );
}

// ---------------------------------------------------------------------------
// 글 + 수식
// ---------------------------------------------------------------------------
/**
 * "함수 $f(x)=x^2$ 의 …" → [{type:'text'|'math', v, display?}]
 * $…$ / \(…\) 는 글 속 수식, $$…$$ / \[…\] 는 따로 한 줄. \$ 는 글자 $.
 */
export function splitMath(text) {
  const out = [];
  const s = String(text ?? '');
  let buf = '';
  let i = 0;
  const pushText = () => {
    if (buf) out.push({ type: 'text', v: buf });
    buf = '';
  };
  while (i < s.length) {
    if (s[i] === '\\' && s[i + 1] === '$') {
      buf += '$';
      i += 2;
      continue;
    }
    const open = s.startsWith('$$', i) ? '$$' : s[i] === '$' ? '$' : s.startsWith('\\(', i) ? '\\(' : s.startsWith('\\[', i) ? '\\[' : null;
    if (open) {
      const close = { $$: '$$', $: '$', '\\(': '\\)', '\\[': '\\]' }[open];
      let j = i + open.length;
      while (j < s.length && !(s.startsWith(close, j) && s[j - 1] !== '\\')) j++;
      if (j < s.length) {
        pushText();
        const v = s.slice(i + open.length, j).trim();
        if (v) out.push({ type: 'math', v, display: open === '$$' || open === '\\[' });
        i = j + close.length;
        continue;
      }
    }
    buf += s[i];
    i++;
  }
  pushText();
  return out;
}

/** 글자 폭 대충 (HWPUNIT, 10pt 기준) */
function textWidth(s, size = 1000) {
  let w = 0;
  for (const ch of String(s)) w += /[ᄀ-ᇿ㄰-㆏가-힯①-⓿　-鿿]/.test(ch) ? 1 : /[ .,:;'!|()[\]]/.test(ch) ? 0.32 : 0.56;
  return Math.round(w * size);
}

// ---------------------------------------------------------------------------
// ZIP (직접 씀: CRC32 + 저장/압축)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** @param {{name:string, data:Uint8Array|string, store?:boolean}[]} files */
export async function makeZip(files) {
  const enc = new TextEncoder();
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const name = enc.encode(f.name);
    const crc = crc32(raw);
    const packed = f.store ? null : await deflateRaw(raw);
    const method = packed && packed.length < raw.length ? 8 : 0;
    const body = method === 8 ? packed : raw;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 그림 (브라우저에서 기본으로 쓰는 것)
// ---------------------------------------------------------------------------
/** canvas → {bytes, ext, pxW, pxH} */
export async function canvasImage(canvas, ext = 'jpg') {
  const type = ext === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
  if (!blob) throw new Error('그림을 만들지 못했어요.');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext, pxW: canvas.width, pxH: canvas.height };
}

/** 원본 영역 하나 → JPEG (PDF 내보내기의 이미지 방식과 같은 200 DPI) */
export async function renderSegImage(seg) {
  const widthPx = seg.meta.kind === 'image' && seg.meta.pxW ? seg.meta.pxW : Math.round(((seg.meta.w * unitScale(seg.meta)) / 72) * RASTER_DPI);
  return canvasImage(await seg.src.renderRegion(seg.rect.page, seg.rect, widthPx), 'jpg');
}

/** 문항의 여러 영역(공통 지문 + 이어지는 부분)을 같은 배율로 위아래로 이어 붙인 canvas (폭 widthPx) */
export async function renderStack(segs, widthPx = 1500) {
  const maxW = Math.max(...segs.map((s) => s.wPt));
  const scale = widthPx / maxW; // px / pt
  const parts = [];
  for (const s of segs) parts.push(await s.src.renderRegion(s.rect.page, s.rect, Math.min(8000, s.meta.w * unitScale(s.meta) * scale)));
  const gap = 12;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(...parts.map((c) => c.width));
  canvas.height = parts.reduce((sum, c) => sum + c.height, 0) + gap * (parts.length - 1);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 0;
  for (const c of parts) {
    ctx.drawImage(c, 0, y);
    y += c.height + gap;
  }
  return canvas;
}

/** canvas 에서 box({x,y,w,h} 0~1) 만큼 잘라 PNG 로 */
export async function cropImage(canvas, box) {
  const x = Math.max(0, Math.floor(box.x * canvas.width));
  const y = Math.max(0, Math.floor(box.y * canvas.height));
  const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(box.w * canvas.width)));
  const h = Math.max(1, Math.min(canvas.height - y, Math.ceil(box.h * canvas.height)));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return canvasImage(out, 'png');
}

// ---------------------------------------------------------------------------

/** 문제/해설 블록 → 원본 영역 목록 (buildPdf 와 같은 방식) */
export function blockSegs(block, sources = {}) {
  if ((block.kind !== 'problem' && block.kind !== 'answer') || !block.item) return [];
  const src = block.src || sources[block.role];
  if (!src) return [];
  const rects = [...(block.stem || []).map((r) => ({ ...r, stem: true })), ...block.item.rects];
  const segs = [];
  for (const rect of rects) {
    const meta = src.pages[rect.page];
    if (!meta) continue;
    const k = unitScale(meta);
    segs.push({ block, src, rect, meta, wPt: rect.w * meta.w * k, hPt: rect.h * meta.h * k });
  }
  return segs;
}

/**
 * @param {object} args
 *   blocks, sources, options, title, info: buildPdf 와 같음
 *   onProgress(done, total)
 *   transcribe?(block, segs) → Promise<null | {blocks:{type:'para'|'math'|'choices'|'figure', text?, latex?, items?, box?}[], crop?(box)→Promise<Img>}>
 *       null 이거나 실패하면 그 문항은 그림으로. AbortError 는 그대로 던짐(내보내기 취소)
 *   renderSeg?(seg) → Promise<Img>   Img = {bytes:Uint8Array, ext:'jpg'|'png', pxW, pxH}
 * @returns {Promise<Uint8Array>} .hwpx 파일 내용 (결과.stats = {text, picture} 문항 수)
 */
export async function buildHwpx({ blocks, sources = {}, options, title, info, onProgress, transcribe, renderSeg = renderSegImage }) {
  const opts = { ...DEFAULT_EXPORT_OPTIONS, ...(options || {}) };
  const exam = { title: title || '오답노트', ...(info || {}) };
  const cols = Math.max(1, Math.min(2, opts.columns | 0));
  const colW = Math.floor((CONTENT_W - COL_GAP * (cols - 1)) / cols);
  const space = SPACE_OPTIONS[opts.space] || SPACE_OPTIONS.none;

  // ---- 1) 영역 준비 + 글자로 옮기기 ----
  const prepared = new Map(); // block → {segs, t}
  const work = blocks.filter((b) => blockSegs(b, sources).length);
  let done = 0;
  for (const block of work) {
    const segs = blockSegs(block, sources);
    let t = null;
    if (transcribe) {
      try {
        t = await transcribe(block, segs);
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        console.warn('글자로 옮기기 실패 → 그림으로', err);
        t = null;
      }
    }
    if (!t?.blocks?.length) t = null;
    prepared.set(block, { segs, t });
    onProgress?.(++done, work.length);
  }

  // ---- 2) 모양 ----
  const head = makeHead();
  const C = {
    body: head.char({}),
    num: head.char({ size: 1100, bold: true, color: '#111111' }),
    numAns: head.char({ size: 1100, bold: true, color: '#0F5F58' }),
    source: head.char({ size: 800, color: '#8A8F98' }),
    note: head.char({ size: 900, color: '#888888' }),
    academy: head.char({ size: 900, bold: true, color: '#555555' }),
    date: head.char({ size: 900, color: '#777777' }),
    title: head.char({ size: 2100, bold: true, color: '#111111' }),
    subtitle: head.char({ size: 950, color: '#666666' }),
    cellHead: head.char({ size: 850, bold: true, color: '#333333' }),
    cellValue: head.char({ size: 900, color: '#111111' }),
    section: head.char({ size: 1400, bold: true, color: '#111111' }),
    tiny: head.char({ size: 300 }),
    pageNum: head.char({ size: 900, color: '#595959' }),
  };
  const gray = '#8C8C8C';
  const F = {
    rule: head.fill({ top: ['SOLID', '0.6 mm', '#1A1A1A'], bottom: ['SOLID', '0.12 mm', '#1A1A1A'] }),
    sectionLine: head.fill({ bottom: ['SOLID', '0.4 mm', '#1A1A1A'] }),
    stemLine: head.fill({ bottom: ['DASH', '0.12 mm', '#BFBFBF'] }),
    cellHead: head.fill({ left: ['SOLID', '0.12 mm', gray], right: ['SOLID', '0.12 mm', gray], top: ['SOLID', '0.12 mm', gray], bottom: ['SOLID', '0.12 mm', gray], face: '#F2F2F2' }),
    cell: head.fill({ left: ['SOLID', '0.12 mm', gray], right: ['SOLID', '0.12 mm', gray], top: ['SOLID', '0.12 mm', gray], bottom: ['SOLID', '0.12 mm', gray] }),
  };
  const PP = {
    title: head.para({ align: 'CENTER', line: 130 }),
    subtitle: head.para({ align: 'CENTER', line: 130, prev: 100 }),
    rule: head.para({ align: 'LEFT', line: 100, prev: 500, next: 700, fill: F.rule }),
    table: head.para({ align: 'CENTER', line: 100, next: 1200 }),
    cell: head.para({ align: 'CENTER', line: 100 }),
    label: head.para({ align: 'LEFT', line: 130, prev: 1200, next: 250, keep: 1 }),
    section: head.para({ align: 'LEFT', line: 130, next: 1000, fill: F.sectionLine }),
    note: head.para({ align: 'LEFT', line: 150 }),
  };
  const content = (spec = {}, last = false) => head.para({ align: 'JUSTIFY', line: 160, next: 300, keep: last ? 0 : 1, ...spec });

  // ---- 3) 문단 ----
  const images = []; // {name, bytes, ext}
  let objSeq = 1700000000;
  let zSeq = 0;
  const ids = { obj: () => ++objSeq, z: () => zSeq++ };
  const addImage = (img) => {
    const n = images.length + 1;
    const ext = img.ext === 'png' ? 'png' : 'jpg';
    images.push({ id: `image${n}`, name: `BinData/image${n}.${ext}`, ext, bytes: img.bytes });
    return { binId: `image${n}`, pxW: img.pxW, pxH: img.pxH };
  };

  const paras = [];
  const preview = [];
  const stats = { text: 0, picture: 0 }; // 글자로 넣은 / 그림으로 넣은 문항 수
  let first = true; // 첫 문단에 구역 설정(secPr)
  let needCols = cols > 1; // 본문 첫 문단에서 다단 시작
  let pendingBreak = false;
  let atTop = true; // 쪽 나누기 직후(아직 내용 없음)
  /** runs: {cp, xml}[] (xml 은 hp:run 안쪽) */
  const addPara = (pp, runs = [], { body = true } = {}) => {
    let pre = '';
    if (first) {
      pre = `<hp:run charPrIDRef="0">${secPrXml()}${colPrXml(1)}${PAGE_NUM_XML}</hp:run>`;
      first = false;
    }
    if (body && needCols) {
      pre += `<hp:run charPrIDRef="0">${colPrXml(cols)}</hp:run>`;
      needCols = false;
    }
    const inner = runs.length ? runs.map((r) => (r.xml ? `<hp:run charPrIDRef="${r.cp}">${r.xml}</hp:run>` : `<hp:run charPrIDRef="${r.cp}"/>`)).join('') : pre ? '' : '<hp:run charPrIDRef="0"/>';
    const brk = pendingBreak && !atTop ? 1 : 0;
    pendingBreak = false;
    atTop = false;
    paras.push(`<hp:p id="${paras.length ? 2147483648 : 0}" paraPrIDRef="${pp}" styleIDRef="0" pageBreak="${brk}" columnBreak="0" merged="0">${pre}${inner}</hp:p>`);
  };
  const breakPage = () => {
    pendingBreak = true;
  };
  const text = (s) => `<hp:t>${esc(s)}</hp:t>`;
  const tab = (w, type) => `<hp:t><hp:tab width="${Math.max(100, Math.round(w))}" leader="0" type="${type === 'RIGHT' ? 2 : 1}"/></hp:t>`;

  // ---- 시험지 머리 (첫 쪽) ----
  if (exam.academy || exam.date) {
    const tabs = head.tab([{ pos: CONTENT_W, type: 'RIGHT' }]);
    const runs = [];
    if (exam.academy) runs.push({ cp: C.academy, xml: text(exam.academy) });
    if (exam.date) runs.push({ cp: C.date, xml: tab(CONTENT_W - textWidth(exam.academy || '', 900) - textWidth(exam.date, 900), 'RIGHT') + text(exam.date) });
    addPara(head.para({ align: 'LEFT', line: 130, tab: tabs }), runs, { body: false });
  }
  addPara(PP.title, [{ cp: C.title, xml: text(exam.title) }], { body: false });
  if (exam.subtitle) addPara(PP.subtitle, [{ cp: C.subtitle, xml: text(exam.subtitle) }], { body: false });
  addPara(PP.rule, [{ cp: C.tiny }], { body: false });
  {
    const group = Math.floor((CONTENT_W - 282) / 4);
    const headW = 42 * PT;
    const cells = [
      ['학원', exam.academy],
      ['선생님', exam.teacher],
      ['학생', exam.student],
      ['점수', ''],
    ].flatMap(([k, v]) => [
      { text: k, cp: C.cellHead, fill: F.cellHead, width: headW },
      { text: v || '', cp: C.cellValue, fill: F.cell, width: group - headW },
    ]);
    addPara(PP.table, [{ cp: C.body, xml: `${tableXml(cells, 21 * PT, ids, { cellPara: PP.cell, tableFill: F.cell })}<hp:t/>` }], { body: false });
  }
  preview.push(exam.title, exam.subtitle || '', '');
  atTop = true;

  // ---- 본문 ----
  const picRun = (img, w, h) => ({ cp: C.body, xml: `${picXml(addImage(img), w, h, ids)}<hp:t/>` });

  /** 글+수식 조각 → hp:run 안쪽 xml (수식은 hp:equation) */
  const richXml = (segs) =>
    segs
      .map((sg) => {
        if (sg.type === 'text') return sg.v ? text(sg.v) : '';
        const eq = convertLatex(sg.v, { baseUnit: BASE_UNIT });
        return eq.script ? equationXml(eq, ids) : '';
      })
      .join('');
  const richWidth = (segs) => segs.reduce((w, sg) => w + (sg.type === 'text' ? textWidth(sg.v) : convertLatex(sg.v, { baseUnit: BASE_UNIT }).width + 112), 0);

  /** 글 문단(가운데 수식이 따로 있으면 나눔). 문단 목록 [{pp, runs}] */
  const paraItems = (textValue) => {
    const items = [];
    for (const line of String(textValue ?? '').replace(/\t/g, ' ').split(/\r?\n/)) {
      let cur = [];
      const flush = () => {
        if (cur.some((sg) => sg.type === 'math' || sg.v.trim())) items.push({ kind: 'text', segs: cur });
        cur = [];
      };
      for (const sg of splitMath(line)) {
        if (sg.type === 'math' && sg.display) {
          flush();
          items.push({ kind: 'display', segs: [sg] });
        } else cur.push(sg);
      }
      flush();
    }
    return items;
  };

  /** 보기 ①~⑤: 한 줄에 다 들어가면 한 줄, 아니면 3개씩, 그래도 길면 하나씩 */
  const choiceItems = (list) => {
    const items = list.map((s, i) => [{ type: 'text', v: `${CHOICE_MARKS[i] || `(${i + 1})`} ` }, ...splitMath(String(s ?? '').replace(/^\s*(?:[①-⑩]|\(\s*\d+\s*\))\s*/, ''))]);
    const widths = items.map(richWidth);
    const n = items.length;
    const perLine = [n, Math.ceil(n / 2), 1].find((k) => widths.every((w) => w <= colW / k - 500)) || 1;
    const slot = Math.floor(colW / perLine);
    const tabs = perLine > 1 ? head.tab(Array.from({ length: perLine - 1 }, (_, i) => ({ pos: slot * (i + 1), type: 'LEFT' }))) : 0;
    const out = [];
    for (let r = 0; r < n; r += perLine) {
      let xml = '';
      let x = 0; // 이 줄에서 지금까지 쓴 폭(대충)
      items.slice(r, r + perLine).forEach((segs, j) => {
        if (j > 0) {
          xml += tab(slot * j - x, 'LEFT');
          x = slot * j;
        }
        xml += richXml(segs);
        x += widths[r + j];
      });
      out.push({ xml, tab: tabs });
    }
    return out;
  };

  /** 그림을 단 폭에 맞춘 크기(HWPUNIT) */
  const fitPic = (wPt, hPt, scale) => {
    let w = Math.max(1, Math.round(wPt * PT * scale));
    let h = Math.max(1, Math.round(hPt * PT * scale));
    if (w > colW) {
      h = Math.round((h * colW) / w);
      w = colW;
    }
    return [w, h];
  };

  for (const block of blocks) {
    if (block.kind === 'pagebreak') {
      breakPage();
      continue;
    }
    if (block.kind === 'section') {
      breakPage();
      addPara(PP.section, [{ cp: C.section, xml: text(block.text) }]);
      preview.push('', block.text);
      atTop = false;
      continue;
    }
    // 라벨: 굵은 새 번호 + 회색 출처
    if (block.num || block.source) {
      const runs = [];
      if (block.num) runs.push({ cp: block.kind === 'answer' ? C.numAns : C.num, xml: text(block.num) });
      if (block.source) runs.push({ cp: C.source, xml: text(`${block.num ? '  ' : ''}${block.source}`) });
      addPara(PP.label, runs);
      preview.push([block.num, block.source].filter(Boolean).join(' '));
    }
    const prep = prepared.get(block);
    if (!prep) {
      if (block.text) addPara(PP.note, [{ cp: C.note, xml: text(block.text) }]);
      continue;
    }
    // 이 블록의 문단들: {pp(spec), runs}
    const list = [];
    if (prep.t) {
      const maxW = Math.max(...prep.segs.map((s) => s.wPt));
      const scale = Math.min(1, colW / (maxW * PT));
      for (const b of prep.t.blocks) {
        if (b.type === 'para') {
          for (const it of paraItems(b.text)) {
            list.push({ spec: it.kind === 'display' ? { align: 'CENTER' } : {}, runs: [{ cp: C.body, xml: richXml(it.segs) }] });
            preview.push(it.segs.map((sg) => sg.v).join(''));
          }
        } else if (b.type === 'math' && b.latex) {
          list.push({ spec: { align: 'CENTER' }, runs: [{ cp: C.body, xml: richXml([{ type: 'math', v: b.latex }]) }] });
        } else if (b.type === 'choices' && b.items?.length) {
          for (const row of choiceItems(b.items)) list.push({ spec: { align: 'LEFT', tab: row.tab }, runs: [{ cp: C.body, xml: row.xml }] });
          preview.push(b.items.map((s, i) => `${CHOICE_MARKS[i] || ''} ${s}`).join('  '));
        } else if (b.type === 'figure' && b.box && prep.t.crop) {
          try {
            const img = await prep.t.crop(b.box);
            const [w, h] = fitPic(b.box.w * maxW, (b.box.w * maxW * img.pxH) / img.pxW, scale);
            list.push({ spec: { align: 'CENTER', line: 100 }, runs: [picRun(img, w, h)] });
          } catch (err) {
            console.warn('그림 자르기 실패', err);
          }
        }
      }
    }
    stats[list.length ? 'text' : 'picture']++;
    if (!list.length) {
      // 그림으로: 단 폭에 맞추고, 한 쪽보다 길면 줄임
      const maxW = Math.max(...prep.segs.map((s) => s.wPt));
      let scale = Math.min(1, colW / (maxW * PT));
      const totalH = prep.segs.reduce((s, sg) => s + sg.hPt * PT * scale, 0);
      if (totalH > BODY_H * 0.92) scale *= (BODY_H * 0.92) / totalH;
      for (const [i, seg] of prep.segs.entries()) {
        const img = await renderSeg(seg);
        const [w, h] = fitPic(seg.wPt, seg.hPt, scale);
        const stemEnd = seg.rect.stem && prep.segs[i + 1] && !prep.segs[i + 1].rect.stem;
        list.push({ spec: { align: 'LEFT', line: 100, next: 200, fill: stemEnd ? F.stemLine : 2 }, runs: [picRun(img, w, h)] });
      }
      preview.push('[그림]');
    }
    list.forEach((p, i) => addPara(content(p.spec, i === list.length - 1), p.runs));

    if (block.kind === 'problem' && block.addSpace) {
      if (space.pageBreak) breakPage();
      else if (space.pt > 0) addPara(head.para({ align: 'LEFT', line: 100, next: Math.max(0, space.pt * PT - 1000) }), [{ cp: C.body }]);
    }
  }
  if (needCols) addPara(0, []); // 문항이 하나도 없을 때도 구역은 닫힘

  // ---- 4) 묶기 ----
  const section = `${XML_HEAD}<hs:sec ${NS}>${paras.join('')}</hs:sec>`;
  const header = headerXml(head, C.pageNum);
  const bytes = await makeZip([
    { name: 'mimetype', data: 'application/hwp+zip', store: true },
    { name: 'version.xml', data: versionXml() },
    { name: 'META-INF/container.xml', data: containerXml() },
    { name: 'META-INF/manifest.xml', data: `${XML_HEAD}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>` },
    { name: 'META-INF/container.rdf', data: containerRdf() },
    { name: 'Contents/content.hpf', data: contentHpf(exam, images) },
    { name: 'Contents/header.xml', data: header },
    { name: 'Contents/section0.xml', data: section },
    { name: 'settings.xml', data: `${XML_HEAD}<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>` },
    { name: 'Preview/PrvText.txt', data: preview.join('\r\n').slice(0, 1024) },
    ...images.map((img) => ({ name: img.name, data: img.bytes, store: true })),
  ]);
  bytes.stats = stats;
  return bytes;
}

// ---------------------------------------------------------------------------
// 꾸러미 정보
// ---------------------------------------------------------------------------
function versionXml() {
  return `${XML_HEAD}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="Hancom Office Hangul" appVersion="13, 0, 0, 0 WIN32LEWindows_10"/>`;
}

function containerXml() {
  return (
    `${XML_HEAD}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles>` +
    '<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>' +
    '<ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></ocf:rootfiles></ocf:container>'
  );
}

function containerRdf() {
  const part = (file, type) =>
    `<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="${file}"/></rdf:Description>` +
    `<rdf:Description rdf:about="${file}"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#${type}"/></rdf:Description>`;
  return (
    `${XML_HEAD}<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${part('Contents/header.xml', 'HeaderFile')}${part('Contents/section0.xml', 'SectionFile')}` +
    '<rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description></rdf:RDF>'
  );
}

function contentHpf(exam, images) {
  const now = new Date();
  const iso = `${now.toISOString().slice(0, 19)}Z`;
  const author = [exam.academy, exam.teacher].filter(Boolean).join(' ') || '오답노트';
  const items = images.map((img) => `<opf:item id="${img.id}" href="${img.name}" media-type="${img.ext === 'png' ? 'image/png' : 'image/jpg'}" isEmbeded="1"/>`).join('');
  return (
    `${XML_HEAD}<opf:package ${NS} version="" unique-identifier="" id=""><opf:metadata>` +
    `<opf:title>${esc(exam.title)}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">${esc(author)}</opf:meta>` +
    '<opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/><opf:meta name="lastsaveby" content="text">오답노트</opf:meta>' +
    `<opf:meta name="CreatedDate" content="text">${iso}</opf:meta><opf:meta name="ModifiedDate" content="text">${iso}</opf:meta>` +
    '<opf:meta name="keyword" content="text"/></opf:metadata>' +
    `<opf:manifest>${items}<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>` +
    '<opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>' +
    '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>'
  );
}
