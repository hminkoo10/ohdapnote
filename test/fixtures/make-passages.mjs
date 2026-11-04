// 국어·영어 시험지와 시중 교재를 흉내 낸 테스트용 PDF — 지문 세트([1~3] 다음 글을 읽고 …)와 거기 딸린 문항 묶기 채점용
//  - korean-exam : 수능·모의고사 국어형 2단. 지문이 단·쪽을 넘어감, (가)(나)(다), [A] 표시, ㉠㉡·ⓐ 밑줄, <보기>, 지문 없는 단독 문항
//  - english-exam: 수능·모의고사 영어형 2단. 듣기 1~17([16~17] 세트), 문항마다 짧은 지문 18~40, [41~42]·[43~45] 세트
//  - korean-book : 시중 교재형 1단. 단원 띠, [01~03] 머리, 상자 지문, 01 번호, 지문이 문항 안에 든 단독 문항
//  - english-book: 시중 교재형 2단. UNIT 띠, 01 번호, 문항마다 지문 + [05~06] 세트
//  + 스캔본 흉내(make-scan.py): korean-exam-scan, english-exam-scan, korean-book-scan
// 지문·문항 글에는 흰색 1px 표식(ZZP…, ZZQ…)을 넣어, 실제로 어디 있는지 PDF 글자로 확인할 수 있게 합니다 (make-books.mjs 와 같은 방식).
// 정답은 generated/passages-expected.json: 문항마다 번호·세트, 세트마다 지문 표식, 문항마다 문항 표식.
// 글은 모두 이 저장소를 위해 새로 쓴 것 (passage-texts.mjs)
// 사용: node test/fixtures/make-passages.mjs
import { chromium } from '../lib/playwright.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as T from './passage-texts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'generated');
mkdirSync(outDir, { recursive: true });

const SERIF = `'Batang', 'Noto Serif KR', 'Noto Serif CJK KR', 'Nanum Myeongjo', serif`;
const SANS = `'Malgun Gothic', 'Noto Sans KR', 'Noto Sans CJK KR', 'NanumGothic', sans-serif`;
const EN = `'Times New Roman', 'Liberation Serif', ${SERIF}`;

let seed = 5;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const CH = ['①', '②', '③', '④', '⑤'];

/** 정답 기록 + 표식 */
function builder() {
  const exp = { questions: [], sets: [] };
  // 앞 글자에 붙임 (U+2060 줄바꿈 금지: 꽉 찬 줄 끝의 표식이 혼자 빈 다음 줄로 넘어가 글자 없는 자리에 놓이지 않게)
  const mk = (k) => `&#8288;<span class="mk">ZZ${k}</span>`;
  return {
    exp,
    set(a, b) {
      const s = { label: `${a}~${b}`, keys: [] };
      exp.sets.push(s);
      const id = exp.sets.length;
      return { label: s.label, mark: () => mk(`P${id}k${s.keys.push(`P${id}k${s.keys.length}`) - 1}`) };
    },
    question(n, setLabel = '') {
      const q = { n, set: setLabel, keys: [] };
      exp.questions.push(q);
      const id = exp.questions.length;
      return { mark: () => mk(`Q${id}k${q.keys.push(`Q${id}k${q.keys.length}`) - 1}`) };
    },
  };
}

/** 문장 몇 개를 고르되, 화제 순서를 지키며 (돌아가며) */
function sentences(topic, count, from = 0) {
  return Array.from({ length: count }, (_, i) => topic[(from + i) % topic.length]);
}
/** 첫 낱말 몇 개에 ㉠ 같은 표시 + 밑줄 */
const underline = (s, sign, words = 3) => {
  const w = s.split(' ');
  return `${sign}<u>${w.slice(0, words).join(' ')}</u> ${w.slice(words).join(' ')}`;
};
/** 발문: 첫 낱말 뒤에 시작 표식 */
const askWithMark = (ask, mark) => {
  const w = esc(ask).split(' ');
  return `${w[0]}${mark} ${w.slice(1).join(' ')}`;
};
/** 선지 다섯 줄 (마지막 줄 끝에 끝 표식) */
const choiceLines = (pool, end) => `<div class="ch">${CH.map((c, i) => `<div>${c} ${esc(pick(pool))}${i === 4 ? end : ''}</div>`).join('')}</div>`;
const choiceGrid = (list, end) => `<div class="chg">${CH.map((c, i) => `<span>${c} ${esc(list[i % list.length])}${i === 4 ? end : ''}</span>`).join('')}</div>`;
const bogiBox = (text) => `<div class="bogi"><div class="bt">&lt;보 기&gt;</div>${text}</div>`;

// ---------------------------------------------------------------------------
// 국어 시험지
// ---------------------------------------------------------------------------
function koreanExam() {
  const B = builder();
  let n = 0;
  const parts = [];
  const head = (a, b, text = '다음 글을 읽고 물음에 답하시오.') => {
    const s = B.set(a, b);
    parts.push(`<div class="sh">[${a}～${b}] ${text}${s.mark()}</div>`);
    return s;
  };
  const para = (s, html, cls = '') => `<p${cls ? ` class="${cls}"` : ''}>${html}${s.mark()}</p>`;
  const q = (setLabel, ask, { bogi = null, short = null, split = false } = {}) => {
    n++;
    const m = B.question(n, setLabel);
    const start = askWithMark(ask, m.mark());
    const body = `${bogi ? bogiBox(bogi) : ''}${short ? choiceGrid(short, m.mark()) : choiceLines(T.KO_CHOICES, m.mark())}`;
    parts.push(`<div class="q${split ? ' split' : ''}"><span class="qn">${n}.</span><div class="qb"><div class="ask">${start}</div>${body}</div></div>`);
  };

  // [1~3] 독서: 기억
  let s = head(1, 3);
  const mem = T.KO_TOPICS.memory;
  parts.push(`<div class="psg">${para(s, sentences(mem, 3).join(' '))}${para(s, underline(mem[3], '㉠') + ' ' + sentences(mem, 2, 4).join(' '))}${para(s, sentences(mem, 3, 5).join(' '))}</div>`);
  q(s.label, T.KO_ASK[0]);
  q(s.label, T.KO_ASK[1]);
  q(s.label, T.KO_ASK_BOGI, { bogi: T.KO_BOGI[1] });

  // [4~9] (가) 분류 + (나) 화폐 — 긴 지문, 단을 넘어감
  s = head(4, 9, '(가)와 (나)를 읽고 물음에 답하시오.');
  const cl = T.KO_TOPICS.classify;
  const mo = T.KO_TOPICS.money;
  parts.push(
    `<div class="psg"><div class="lab">(가)</div>${para(s, sentences(cl, 3).join(' '))}${para(s, underline(cl[3], '㉠') + ' ' + cl[4])}${para(s, sentences(cl, 3, 5).join(' ') + ' ' + sentences(cl, 2, 0).join(' '))}` +
      `<div class="lab">(나)</div>${para(s, sentences(mo, 3).join(' '))}${para(s, mo[3] + ' ' + underline(mo[4], '㉡', 4) + ' ' + mo[5])}${para(s, sentences(mo, 4, 4).join(' ') + ' ' + mo[1])}</div>`,
  );
  q(s.label, T.KO_ASK[2]);
  q(s.label, T.KO_ASK_BOGI, { bogi: T.KO_BOGI[0], split: true });
  q(s.label, T.KO_ASK[3], { short: T.KO_SHORT_CHOICES });
  q(s.label, T.KO_ASK[0]);
  q(s.label, T.KO_ASK_BOGI, { bogi: T.KO_BOGI[0] + ' ' + T.KO_BOGI[1], split: true });
  q(s.label, T.KO_ASK[4]);

  // [10~13] 독서: 광합성, [A] 표시
  s = head(10, 13);
  const li = T.KO_TOPICS.light;
  parts.push(
    `<div class="psg">${para(s, sentences(li, 3).join(' '))}<div class="brk">${para(s, sentences(li, 3, 3).join(' '))}<span class="bl">[A]</span></div>${para(s, sentences(li, 2, 6).join(' ') + ' ' + li[0])}</div>`,
  );
  q(s.label, T.KO_ASK[1]);
  q(s.label, T.KO_ASK_LIT[1]);
  q(s.label, T.KO_ASK[5]);
  q(s.label, T.KO_ASK_BOGI, { bogi: T.KO_BOGI[1] });

  // [14~17] 문학: (가) 시, (나) 시, (다) 산문 [A]
  s = head(14, 17, '다음 글을 읽고 물음에 답하시오.');
  const poem = (p) => `<div class="poem">${p.lines.map((l) => (l ? esc(l) : '')).join('<br>')}</div><div class="src">${s.mark()}${esc(p.src)}</div>`;
  const pr = T.KO_PROSE;
  parts.push(
    `<div class="psg"><div class="lab">(가)</div>${poem(T.KO_POEMS[0])}<div class="lab">(나)</div>${poem(T.KO_POEMS[1])}<div class="lab">(다)</div>` +
      `${para(s, pr.slice(0, 2).join(' '))}<div class="brk">${para(s, pr.slice(2, 4).join(' '))}<span class="bl">[A]</span></div>${para(s, pr.slice(4, 8).join(' '))}<div class="src">- 서다온, 「우체국 가는 길」 -</div></div>`,
  );
  q(s.label, T.KO_ASK_LIT[0]);
  q(s.label, T.KO_ASK_LIT[1]);
  q(s.label, T.KO_ASK_LIT[3]);
  q(s.label, T.KO_ASK_BOGI, { bogi: T.KO_BOGI[3] });

  // 단독 문항 (지문 없음)
  q('', T.KO_ASK_GRAMMAR[0], { bogi: T.KO_BOGI[2], short: T.KO_SHORT_CHOICES });
  q('', T.KO_ASK_GRAMMAR[1], { bogi: T.KO_BOGI[2] });

  // [20~22] 독서: 법의 해석 ("1990년대 이후 …" 숫자로 시작하는 문장)
  s = head(20, 22);
  const la = T.KO_TOPICS.law;
  parts.push(`<div class="psg">${para(s, sentences(la, 4).join(' '))}${para(s, sentences(la, 3, 4).join(' '))}${para(s, la[7] + ' ' + la[0])}</div>`);
  q(s.label, T.KO_ASK[0]);
  q(s.label, T.KO_ASK[1]);
  q(s.label, T.KO_ASK[2]);

  // [23~26] 독서: 별의 밝기 + 화폐 일부
  s = head(23, 26);
  const st = T.KO_TOPICS.stars;
  parts.push(`<div class="psg">${para(s, sentences(st, 3).join(' '))}${para(s, underline(st[3], '㉠') + ' ' + sentences(st, 2, 4).join(' '))}${para(s, sentences(st, 2, 6).join(' ') + ' ' + sentences(mo, 2, 5).join(' '))}</div>`);
  q(s.label, T.KO_ASK[0]);
  q(s.label, T.KO_ASK[3], { short: T.KO_SHORT_CHOICES });
  q(s.label, T.KO_ASK[2]);
  q(s.label, T.KO_ASK_BOGI, { bogi: T.KO_BOGI[0], split: true });

  q('', T.KO_ASK_GRAMMAR[0], { bogi: T.KO_BOGI[2] });

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:18mm 13mm 15mm 13mm}
    body{font-family:${SERIF};font-size:9.6pt;line-height:1.62;color:#111;margin:0;text-align:justify;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .title{text-align:center;border-bottom:1.6pt solid #000;padding-bottom:2mm;margin-bottom:4mm;font-family:${SANS}}
    .title .t1{font-size:10pt}.title .t2{font-size:22pt;font-weight:800;letter-spacing:4pt}
    .cols{column-count:2;column-gap:9mm;column-rule:.6pt solid #222}
    .sh{font-family:${SANS};font-weight:700;margin:3.5mm 0 1.6mm}
    .psg{margin-bottom:3mm}.psg p{margin:0;text-indent:1em}
    .lab{margin:1mm 0 .4mm}
    .poem{margin:1mm 0 1mm 1.5em;text-align:left}
    .src{text-align:right;font-size:8.8pt;margin:.6mm 0 1.6mm}
    .brk{position:relative;margin-right:8mm;break-inside:avoid}
    .brk::after{content:'';position:absolute;right:-3.4mm;top:.8mm;bottom:.8mm;width:1.4mm;border:.7pt solid #000;border-left:0}
    .brk .bl{position:absolute;right:-8.8mm;top:calc(50% - .65em);font-family:${SANS};font-size:8.4pt}
    .q{display:flex;gap:1.2mm;margin:2.4mm 0 5mm;break-inside:avoid}.q.split{break-inside:auto}
    .qn{font-family:${SANS};font-weight:700;font-size:10.4pt;min-width:5.8mm;line-height:1.5}
    .qb{flex:1}.ask{margin-bottom:1mm}
    .ch div{padding-left:1.2em;text-indent:-1.2em}
    .chg{display:grid;grid-template-columns:repeat(3,1fr)}
    .bogi{border:.7pt solid #000;padding:1.8mm 2.6mm;margin:1.2mm 0 1.8mm}.bogi .bt{text-align:center;font-family:${SANS};font-size:8.8pt;margin-bottom:.8mm}
    u{text-underline-offset:1.5pt}
    .mk{font-size:1px;color:#fff;line-height:0}
  </style></head><body>
    <div class="title"><div class="t1">2027학년도 9월 고2 학력평가 문제지</div><div class="t2">국어 영역</div></div>
    <div class="cols">${parts.join('')}</div></body></html>`;
  return { html, exp: B.exp, header: '국어 영역' };
}

// ---------------------------------------------------------------------------
// 영어 시험지
// ---------------------------------------------------------------------------
function englishExam() {
  const B = builder();
  let n = 0;
  const parts = [];
  const head = (a, b, text) => {
    const s = B.set(a, b);
    parts.push(`<div class="sh">[${a}～${b}] ${text}${s.mark()}</div>`);
    return s;
  };
  const topics = Object.values(T.EN_TOPICS);
  // 듣기 1~15
  parts.push('<div class="note">1번부터 17번까지는 듣고 답하는 문제입니다. 1번부터 15번까지는 한 번만 들려주고, 16번부터 17번까지는 두 번 들려줍니다. 방송을 잘 듣고 답을 하기 바랍니다.</div>');
  const listen = (setLabel, ask, short) => {
    n++;
    const m = B.question(n, setLabel);
    const body = short ? choiceGrid(short, m.mark()) : choiceLines(T.LISTEN_CHOICES, m.mark());
    parts.push(`<div class="q"><span class="qn">${n}.</span><div class="qb"><div class="ask">${askWithMark(ask, m.mark())}</div>${body}</div></div>`);
  };
  for (let i = 0; i < 15; i++) {
    const ask = T.LISTEN_ASK[i % T.LISTEN_ASK.length];
    listen('', ask, /금액|그림/.test(ask) ? T.LISTEN_SHORT.slice(/금액/.test(ask) ? 0 : 5) : null);
  }
  let s = head(16, 17, '다음을 듣고, 물음에 답하시오.');
  listen(s.label, '여자가 하는 말의 주제로 가장 적절한 것은?');
  listen(s.label, '언급된 장소가 아닌 것은?', T.LISTEN_SHORT.slice(5));
  parts.push('<div class="note c">이제 듣기 문제는 끝났습니다. 18번부터는 문제지의 지시에 따라 답을 하시기 바랍니다.</div>');

  // 18~40: 문항마다 짧은 지문
  for (let k = 0; k < 23; k++) {
    n++;
    const m = B.question(n);
    const ask = n >= 36 && n <= 37 ? '주어진 글 다음에 이어질 글의 순서로 가장 적절한 것을 고르시오.' : n >= 38 && n <= 39 ? '글의 흐름으로 보아, 주어진 문장이 들어가기에 가장 적절한 곳을 고르시오.' : n === 40 ? '다음 글의 내용을 한 문장으로 요약하고자 한다. 빈칸 (A), (B)에 들어갈 말로 가장 적절한 것은?' : T.EN_ASK[k % T.EN_ASK.length];
    const topic = topics[k % topics.length];
    const from = Math.floor(rnd() * 8);
    let body = '';
    if (n >= 36 && n <= 37) {
      body = `<div class="given">${esc(topic[from % 8])}</div>${['(A)', '(B)', '(C)'].map((l, i) => `<p class="ord">${l} ${esc(sentences(topic, 2, from + 1 + i * 2).join(' '))}</p>`).join('')}${m.mark()}`;
    } else if (n >= 38 && n <= 39) {
      body = `<div class="given">${esc(topic[from % 8])}</div><p class="en">${sentences(topic, 5, from + 1).map((x, i) => `${esc(x)} ( ${CH[i]} )`).join(' ')}${m.mark()}</p>`;
    } else {
      const sent = sentences(topic, 5 + Math.floor(rnd() * 3), from).map(esc);
      if (/빈칸/.test(ask)) sent[2] = sent[2].replace(/ [a-z]+ [a-z]+\.$/, ' ____________.');
      if (/밑줄/.test(ask)) sent[1] = `<u>${sent[1]}</u>`;
      body = `<p class="en">${sent.join(' ')}${m.mark()}</p>${rnd() < 0.35 ? '<div class="fn">* keystone: 핵심 요소  ** reproduce: 재현하다</div>' : ''}`;
      if (n === 40) body += `<div class="sum">→ Small changes in the (A) ____________ can make good habits (B) ____________.</div>`;
    }
    const choices = /심경|순서|들어가기|어법|낱말|관계 없는/.test(ask)
      ? choiceGrid(/순서/.test(ask) ? ['(A) － (C) － (B)', '(B) － (A) － (C)', '(B) － (C) － (A)', '(C) － (A) － (B)', '(C) － (B) － (A)'] : /심경/.test(ask) ? ['calm → nervous', 'proud → sad', 'bored → excited', 'nervous → relieved', 'angry → grateful'] : ['①', '②', '③', '④', '⑤'].map(() => ''), m.mark())
      : /요지|주장|목적|요약/.test(ask)
        ? choiceLines(T.KO_CHOICES_EN, m.mark())
        : choiceLines(T.EN_CHOICES, m.mark());
    parts.push(`<div class="q${k % 5 === 3 ? ' split' : ''}"><span class="qn">${n}.</span><div class="qb"><div class="ask">${askWithMark(ask, m.mark())}</div>${body}${choices}</div></div>`);
  }

  // [41~42]
  s = head(41, 42, '다음 글을 읽고, 물음에 답하시오.');
  const sd = T.EN_TOPICS.study;
  const marks = ['(a)', '(b)', '(c)', '(d)', '(e)'];
  parts.push(`<div class="psg"><p class="en">${sd.slice(0, 4).map((x, i) => `${esc(x).replace(/^(\S+ \S+)/, `$1 ${marks[i]}`)}`).join(' ')}${s.mark()}</p><p class="en">${esc(sd.slice(4).join(' '))} ${marks[4]} ${esc(T.EN_TOPICS.music[3])}${s.mark()}</p></div>`);
  const setQ = (label, ask, opts) => {
    n++;
    const m = B.question(n, label);
    const choices = opts.short ? choiceGrid(opts.short, m.mark()) : choiceLines(opts.pool, m.mark());
    parts.push(`<div class="q"><span class="qn">${n}.</span><div class="qb"><div class="ask">${askWithMark(ask, m.mark())}</div>${choices}</div></div>`);
  };
  setQ(s.label, '윗글의 제목으로 가장 적절한 것은?', { pool: T.EN_CHOICES });
  setQ(s.label, '밑줄 친 (a)～(e) 중에서 문맥상 낱말의 쓰임이 적절하지 않은 것은? [3점]', { short: marks });
  // [43~45] (A)~(D)
  s = head(43, 45, '다음 글을 읽고, 물음에 답하시오.');
  const story = T.EN_STORY;
  parts.push(`<div class="psg">${['(A)', '(B)', '(C)', '(D)'].map((l, i) => `<p class="en ord">${l} ${esc(story.slice(i * 2, i * 2 + 2).join(' '))}${s.mark()}</p>`).join('')}</div>`);
  setQ(s.label, '주어진 글 (A)에 이어질 내용을 순서에 맞게 배열한 것으로 가장 적절한 것은?', { short: ['(B) － (D) － (C)', '(C) － (B) － (D)', '(C) － (D) － (B)', '(D) － (B) － (C)', '(D) － (C) － (B)'] });
  setQ(s.label, '밑줄 친 (a)～(e) 중에서 가리키는 대상이 나머지 넷과 다른 것은?', { short: marks });
  setQ(s.label, '윗글에 관한 내용으로 적절하지 않은 것은?', { pool: T.KO_CHOICES_EN });

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:18mm 13mm 15mm 13mm}
    body{font-family:${SERIF};font-size:9.5pt;line-height:1.58;color:#111;margin:0;text-align:justify;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .title{text-align:center;border-bottom:1.6pt solid #000;padding-bottom:2mm;margin-bottom:4mm;font-family:${SANS}}
    .title .t1{font-size:10pt}.title .t2{font-size:22pt;font-weight:800;letter-spacing:4pt}
    .cols{column-count:2;column-gap:9mm;column-rule:.6pt solid #222}
    .note{border:.6pt solid #444;padding:1.6mm 2.4mm;margin:0 0 3mm;font-size:9pt}.note.c{border:0;text-align:center;font-family:${SANS};font-size:8.6pt}
    .sh{font-family:${SANS};font-weight:700;margin:3.5mm 0 1.6mm}
    .psg{margin-bottom:3mm}
    .en{font-family:${EN};font-size:10pt;margin:.6mm 0;text-indent:1em}.ord{text-indent:0}
    .given{border:.6pt solid #000;padding:1.4mm 2.2mm;margin:1mm 0 1.6mm;font-family:${EN};font-size:10pt}
    .fn{text-align:right;font-size:8pt;margin:.4mm 0 .8mm}
    .sum{border:.6pt solid #000;padding:1.4mm 2.2mm;margin:1mm 0;font-family:${EN};font-size:10pt}
    .q{display:flex;gap:1.2mm;margin:2.4mm 0 5mm;break-inside:avoid}.q.split{break-inside:auto}
    .qn{font-family:${SANS};font-weight:700;font-size:10.4pt;min-width:6.6mm;line-height:1.5}
    .qb{flex:1}.ask{margin-bottom:1mm}
    .ch div{padding-left:1.2em;text-indent:-1.2em;font-family:${EN}}
    .chg{display:grid;grid-template-columns:repeat(3,1fr);font-family:${EN}}
    u{text-underline-offset:1.5pt}
    .mk{font-size:1px;color:#fff;line-height:0}
  </style></head><body>
    <div class="title"><div class="t1">2027학년도 9월 고2 학력평가 문제지</div><div class="t2">영어 영역</div></div>
    <div class="cols">${parts.join('')}</div></body></html>`;
  return { html, exp: B.exp, header: '영어 영역' };
}

// ---------------------------------------------------------------------------
// 국어 시중 교재 (1단)
// ---------------------------------------------------------------------------
function koreanBook() {
  const B = builder();
  let n = 0;
  const parts = [];
  const p2 = (k) => String(k).padStart(2, '0');
  const band = (label, title) => parts.push(`<div class="band">${label}<small>${title}</small></div>`);
  const head = (a, b) => {
    const s = B.set(a, b);
    parts.push(`<div class="sh">[${p2(a)}~${p2(b)}] 다음 글을 읽고 물음에 답하시오.${s.mark()}</div>`);
    return s;
  };
  const para = (s, html) => `<p>${html}${s.mark()}</p>`;
  const q = (setLabel, ask, { bogi = null, short = null, own = null } = {}) => {
    n++;
    const m = B.question(n, setLabel);
    const ownBox = own ? `<div class="box">${own.map((x) => `<p>${esc(x)}</p>`).join('')}${m.mark()}</div>` : '';
    const body = `${ownBox}${bogi ? bogiBox(bogi) : ''}${short ? choiceGrid(short, m.mark()) : choiceLines(T.KO_CHOICES, m.mark())}`;
    parts.push(`<div class="q"><span class="qn">${p2(n)}</span><div class="qb"><div class="ask">${askWithMark(ask, m.mark())}</div>${body}</div></div>`);
  };
  band('독서 01', '인문 · 기억의 원리');
  let s = head(1, 3);
  const mem = T.KO_TOPICS.memory;
  parts.push(`<div class="box">${para(s, sentences(mem, 4).join(' '))}${para(s, underline(mem[4], '㉠') + ' ' + sentences(mem, 3, 5).join(' '))}</div>`);
  q(s.label, T.KO_ASK[0]);
  q(s.label, T.KO_ASK[1]);
  q(s.label, T.KO_ASK_BOGI, { bogi: T.KO_BOGI[1] });

  band('독서 02', '과학 · 광합성과 빛');
  s = head(4, 7);
  const li = T.KO_TOPICS.light;
  const cl = T.KO_TOPICS.classify;
  parts.push(`<div class="box">${para(s, sentences(li, 4).join(' '))}${para(s, sentences(li, 4, 4).join(' '))}${para(s, sentences(cl, 4).join(' '))}${para(s, sentences(cl, 4, 4).join(' '))}${para(s, sentences(li, 5, 2).join(' '))}</div>`);
  q(s.label, T.KO_ASK[2]);
  q(s.label, T.KO_ASK[3], { short: T.KO_SHORT_CHOICES });
  q(s.label, T.KO_ASK_BOGI, { bogi: T.KO_BOGI[0] });
  q(s.label, T.KO_ASK[4]);

  // 지문이 문항 안에 든 단독 문항
  q('', '다음 글의 중심 내용으로 가장 적절한 것은?', { own: [sentences(T.KO_TOPICS.money, 5).join(' ')] });

  band('문학 01', '현대시');
  s = head(9, 11);
  const poem = (p) => `<div class="poem">${p.lines.map((l) => esc(l)).join('<br>')}</div><div class="src">${s.mark()}${esc(p.src)}</div>`;
  parts.push(`<div class="box"><div class="lab">(가)</div>${poem(T.KO_POEMS[2])}<div class="lab">(나)</div>${poem(T.KO_POEMS[0])}</div>`);
  q(s.label, T.KO_ASK_LIT[0]);
  q(s.label, T.KO_ASK_LIT[3]);
  q(s.label, T.KO_ASK_BOGI, { bogi: T.KO_BOGI[3] });

  q('', T.KO_ASK_GRAMMAR[0], { bogi: T.KO_BOGI[2], short: T.KO_SHORT_CHOICES });

  band('독서 03', '사회 · 법의 해석');
  s = head(13, 15);
  const la = T.KO_TOPICS.law;
  parts.push(`<div class="box">${para(s, sentences(la, 4).join(' '))}${para(s, sentences(la, 4, 4).join(' '))}</div>`);
  q(s.label, T.KO_ASK[0]);
  q(s.label, T.KO_ASK[1]);
  q(s.label, T.KO_ASK[5]);

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:20mm 18mm 18mm 18mm}
    body{font-family:${SERIF};font-size:10pt;line-height:1.62;color:#141414;margin:0;text-align:justify;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .band{font-family:${SANS};font-size:14pt;font-weight:800;color:#fff;background:#2c5aa0;padding:2mm 4mm;margin:5mm 0 4mm;break-after:avoid}
    .band small{font-size:10.5pt;font-weight:600;margin-left:4mm}
    .sh{font-family:${SANS};font-weight:700;margin:2mm 0 2mm}
    .box{border:.7pt solid #7a8fb5;padding:3mm 4mm;margin:0 0 4mm}.box p{margin:0;text-indent:1em}
    .lab{margin:1mm 0 .4mm}.poem{margin:1mm 0 1mm 1.5em;text-align:left}.src{text-align:right;font-size:9pt;margin:.6mm 0 1.6mm}
    .q{display:flex;gap:2.5mm;margin:3mm 0 6mm;break-inside:avoid}
    .qn{font-family:${SANS};font-weight:800;font-size:13pt;color:#2c5aa0;min-width:8mm;line-height:1.3}
    .qb{flex:1}.ask{margin-bottom:1.2mm;font-weight:600}
    .ch div{padding-left:1.2em;text-indent:-1.2em}
    .chg{display:grid;grid-template-columns:repeat(5,1fr)}
    .bogi{border:.7pt solid #000;padding:1.8mm 2.6mm;margin:1.2mm 0 1.8mm}.bogi .bt{text-align:center;font-family:${SANS};font-size:9pt;margin-bottom:.8mm}
    u{text-underline-offset:1.5pt}
    .mk{font-size:1px;color:#fff;line-height:0}
  </style></head><body>${parts.join('')}</body></html>`;
  return { html, exp: B.exp, header: '수능 국어 독해 연습' };
}

// ---------------------------------------------------------------------------
// 영어 시중 교재 (2단)
// ---------------------------------------------------------------------------
function englishBook() {
  const B = builder();
  let n = 0;
  const parts = [];
  const p2 = (k) => String(k).padStart(2, '0');
  const topics = Object.values(T.EN_TOPICS);
  const band = (label, title) => parts.push(`<div class="band">${label}<small>${title}</small></div>`);
  const item = (setLabel, ask, passage, { short = null, pool = T.EN_CHOICES } = {}) => {
    n++;
    const m = B.question(n, setLabel);
    const psg = passage ? `<p class="en">${passage}${m.mark()}</p>` : '';
    const choices = short ? choiceGrid(short, m.mark()) : choiceLines(pool, m.mark());
    parts.push(`<div class="q"><span class="qn">${p2(n)}</span><div class="qb"><div class="ask">${askWithMark(ask, m.mark())}</div>${psg}${choices}</div></div>`);
  };
  const head = (a, b) => {
    const s = B.set(a, b);
    parts.push(`<div class="sh">[${p2(a)}~${p2(b)}] 다음 글을 읽고, 물음에 답하시오.${s.mark()}</div>`);
    return s;
  };
  const passage = (k, count = 6) => esc(sentences(topics[k % topics.length], count, k).join(' '));

  band('UNIT 01', '주제 · 제목 파악');
  for (let k = 0; k < 4; k++) item('', T.EN_ASK[5 + (k % 3)], passage(k));
  let s = head(5, 6);
  parts.push(`<div class="psg"><p class="en">${passage(4, 5)}${s.mark()}</p><p class="en">${passage(5, 4)}${s.mark()}</p></div>`);
  item(s.label, '윗글의 제목으로 가장 적절한 것은?', '');
  item(s.label, '윗글의 내용과 일치하지 않는 것은?', '', { pool: T.KO_CHOICES_EN });

  band('UNIT 02', '빈칸 추론');
  for (let k = 0; k < 4; k++) item('', '다음 빈칸에 들어갈 말로 가장 적절한 것을 고르시오.', passage(k + 2, 6).replace(/ [a-z]+ [a-z]+\.$/, ' ____________.'));
  s = head(11, 13);
  const story = T.EN_STORY;
  parts.push(`<div class="psg">${['(A)', '(B)', '(C)', '(D)'].map((l, i) => `<p class="en ord">${l} ${esc(story.slice(i * 2, i * 2 + 2).join(' '))}${s.mark()}</p>`).join('')}</div>`);
  item(s.label, '주어진 글 (A)에 이어질 내용을 순서에 맞게 배열한 것으로 가장 적절한 것은?', '', { short: ['(B)-(D)-(C)', '(C)-(B)-(D)', '(C)-(D)-(B)', '(D)-(B)-(C)', '(D)-(C)-(B)'] });
  item(s.label, '윗글의 Mina에 관한 내용으로 적절하지 않은 것은?', '', { pool: T.KO_CHOICES_EN });
  item(s.label, '윗글의 제목으로 가장 적절한 것은?', '');

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:20mm 15mm 17mm 15mm}
    body{font-family:${SERIF};font-size:9.6pt;line-height:1.55;color:#151515;margin:0;text-align:justify;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .cols{column-count:2;column-gap:10mm}
    .band{column-span:all;font-family:${SANS};font-size:15pt;font-weight:800;color:#b03a2e;border-bottom:2pt solid #b03a2e;padding:1mm 0;margin:4mm 0 4mm}
    .band small{font-size:10.5pt;font-weight:600;margin-left:4mm;color:#333}
    .sh{font-family:${SANS};font-weight:700;margin:3mm 0 1.6mm}
    .psg{margin-bottom:3mm}
    .en{font-family:${EN};font-size:10pt;margin:.8mm 0;text-indent:1em}.ord{text-indent:0}
    .q{display:flex;gap:2mm;margin:2.4mm 0 6mm;break-inside:avoid}
    .qn{font-family:${SANS};font-weight:800;font-size:13pt;color:#b03a2e;min-width:7.5mm;line-height:1.25}
    .qb{flex:1}.ask{margin-bottom:1mm}
    .ch div{padding-left:1.2em;text-indent:-1.2em;font-family:${EN}}
    .chg{display:grid;grid-template-columns:repeat(2,1fr);font-family:${EN}}
    .mk{font-size:1px;color:#fff;line-height:0}
  </style></head><body><div class="cols">${parts.join('')}</div></body></html>`;
  return { html, exp: B.exp, header: 'READING PRACTICE 영어 독해' };
}

// ---------------------------------------------------------------------------
const headerTpl = (label) =>
  `<div style="width:100%;font-family:${SANS};font-size:8pt;margin:0 13mm;text-align:center;border-bottom:.5pt solid #555;padding-bottom:1mm;color:#333">${label}</div>`;
const footerTpl = () => `<div style="width:100%;font-family:${SANS};font-size:8.5pt;text-align:center;color:#333"><span class="pageNumber"></span></div>`;

const browser = await chromium.launch();
const page = await browser.newPage();
const expected = {};
for (const [name, make, s0] of [
  ['korean-exam', koreanExam, 5],
  ['english-exam', englishExam, 17],
  ['korean-book', koreanBook, 29],
  ['english-book', englishBook, 41],
]) {
  seed = s0;
  const b = make();
  await page.setContent(b.html, { waitUntil: 'load' });
  writeFileSync(
    join(outDir, `${name}.pdf`),
    await page.pdf({ printBackground: true, displayHeaderFooter: true, headerTemplate: headerTpl(b.header), footerTemplate: footerTpl(), preferCSSPageSize: true }),
  );
  expected[name] = b.exp;
}
await browser.close();
writeFileSync(join(outDir, 'passages-expected.json'), JSON.stringify(expected, null, 1));
for (const name of ['korean-exam', 'english-exam', 'korean-book']) {
  execFileSync('python3', [join(here, 'make-scan.py'), join(outDir, `${name}.pdf`), join(outDir, `${name}-scan.pdf`)], { stdio: 'inherit' });
}
console.log('passages →', outDir);
