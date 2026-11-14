import { recognizedAnswer, runsText } from './answer-model.js';
import { convertLatex } from './hwpeq.js';
import { eqToText, parseEq } from './hwpeqview.js';
import { transcriptKey } from './transcript-store.js';

export const MISSING_ANSWER = '(답을 찾지 못했어요)';

export function shortAnswer(value) {
  if (typeof value !== 'string' || /[\r\n\u0000-\u001f]/.test(value)) return '';
  const answer = value.trim();
  return answer && answer.length <= 40 ? answer : '';
}

/** 머리의 답만 읽음. 긴 답이나 식의 앞부분만 잘라 쓰지 않는다. */
export function headAnswer(blocks = []) {
  const head = blocks.slice(0, 3).map(b => b.text || (b.runs ? runsText(b.runs) : '')).join('\n');
  const answer = recognizedAnswer([{ text: head }]);
  if (!shortAnswer(answer)) return '';
  const match = /(?:정답|답)\s*[:：]?\s*([①-⑤]|[-+]?\d+(?:\.\d+)?(?:\/\d+)?|[a-zA-Z]\s*=\s*[-+]?\d+(?:\.\d+)?)/.exec(head);
  if (!match || match[1] !== answer) return '';
  const tail = head.slice(match.index + match[0].length).split('\n')[0];
  // 숫자·수식·복수 선택지가 더 이어지면 일부만 답으로 삼지 않음
  if (tail && !/^\s+(?:[가-힣]|\[|\()/.test(tail)) return '';
  return answer;
}

const superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const readablePowers = text => text.replace(/\^(?:\((-?\d+)\)|(-?\d+))/g, (_, a, b) =>
  [...(a || b)].map(c => c === '-' ? '⁻' : superscripts[Number(c)]).join(''));

function balanced(text) {
  const stack = [], pairs = { ')': '(', ']': '[', '}': '{' };
  for (const c of text) {
    if ('([{'.includes(c)) stack.push(c);
    else if (pairs[c] && stack.pop() !== pairs[c]) return false;
  }
  return !stack.length;
}

/** 기존 수식 변환을 쓰되, 손실·구문 오류·표 형태는 답으로 내보내지 않는다. */
function readableEquation(value, latex = true) {
  if (!balanced(value) || /\\(?:begin|end)\b|[_^]\s*$/.test(value)) return '';
  const converted = latex ? convertLatex(value) : { script: value };
  const tree = parseEq(converted.script);
  const unsupported = node => {
    if (['empty', 'table', 'raw', 'accent', 'relation', 'negation', 'bigop'].includes(node.type)) return true;
    return Object.values(node).some(v => (Array.isArray(v) ? v : [v]).some(c => c && typeof c === 'object' && c.type && unsupported(c)));
  };
  if (converted.lossyCommands?.length || tree.error || unsupported(tree)) return '';
  const text = readablePowers(eqToText(converted.script));
  return /[\\{}$]/.test(text) || !balanced(text) ? '' : text;
}

function readableAnswer(value) {
  let failed = false;
  const text = value.replace(/\$([^$]+)\$/g, (_, latex) => {
    const converted = readableEquation(latex);
    if (!converted) failed = true;
    return converted;
  });
  return failed || /[\\${}]/.test(text) || !balanced(text) ? '' : shortAnswer(readablePowers(text));
}

// 답 뒤 같은 줄의 한글
// - 이음말(또는·및), 끝의 짧은 낱말(2×2 행렬), 숫자 단위(2000원)는 답의 일부
// - '일 때'·'이고'처럼 값에 조건·다른 값이 이어지면 어디까지가 답인지 몰라 쓰지 않음 ('x=1 일 때 최댓값 3' 을 'x=1' 로 만들지 않게)
// - 그 밖의 한글(해설 문장, 풀이·참고 머리말, [참고])이 이어지면 그 앞까지가 답 ('정답 ③ 이차방정식의…' → ③)
const JOINER = /^(?:또는|혹은|및|그리고|또)$/;
const CLAUSE = /^(?:일|일때|때|이때|이면|이고|이며|에서|와|과)$/;
const HEADING = /^[[(]?(?:다른|풀이|참고|해설|보충|주의|채점)/;
const NOT_UNIT = /(?:이다|이고|이며|이면|이므로|입니다|일때|에서)$/;
function answerPart(value) {
  const words = value.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!/[가-힣]/.test(w) || JOINER.test(w)) continue;
    if (CLAUSE.test(w)) return '';
    const unit = !NOT_UNIT.test(w) && !HEADING.test(w) &&
      (/^[가-힣]{1,3}$/.test(w) ? i === words.length - 1 : /^\d+(?:\.\d+)?[가-힣]{1,2}$/.test(w));
    if (!unit) return words.slice(0, i).join(' ');
  }
  return value;
}

/** 문단·번호 줄·해설 끝의 명시적 답. 다른 답이나 못 읽는 답이 섞이면 비운다. */
export function answerFromBlocks(blocks = []) {
  const texts = blocks.flatMap(b => {
    if (b.type === 'choices') return b.items || [];
    if (b.runs) return [b.runs.map(r => r.eq !== undefined ? readableEquation(r.eq, false) || '\\unreadable' : r.text || '').join('')];
    if (b.type === 'math') {
      if (b.text) return [b.text];
      if (b.latex) return [b.latex.replace(/\\(?:text|textrm|mathrm)\{(정답|답)\s*\}/g, '$1 ')
        .replace(/((?:^|\s)(?:정답|답)(?![가-힣])\s*[:：]?\s*)(.+)/g, (_, marker, value) => `${marker}$${value}$`)];
      return [b.eq ? readableEquation(b.eq, false) : ''];
    }
    return b.type === 'para' || !b.type ? [b.text || ''] : [];
  });
  const answers = [];
  for (const line of texts.flatMap(text => text.split(/\r?\n/))) {
    const markers = [...line.matchAll(/(?:^|\s)(?:정답|답)(?![가-힣])\s*[:：]?\s*(?=\S)/g)];
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      const value = answerPart(line.slice(m.index + m[0].length, markers[i + 1]?.index ?? line.length).trim());
      // 답의 앞부분만 잘라 쓰지 않음 ('x=3 또는 x=5' 를 'x=3' 으로 만들지 않게 headAnswer 는 쓰지 않음)
      const answer = /^[①-⑳\dA-Za-zα-ωΑ-Ω(+\-−±√$\\]/.test(value) ? readableAnswer(value) : '';
      if (!answer) return '';
      answers.push(answer);
    }
  }
  return answers.length && answers.every(a => a.replace(/\s/g, '') === answers[0].replace(/\s/g, '')) ? answers[0] : '';
}

/** PDF 토큰을 같은 줄끼리 묶어 위에서부터, 줄 안은 왼쪽부터 읽는다. */
export function tokenLines(tokens) {
  const rows = [];
  for (const token of [...tokens].filter(t => t.str?.trim()).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
    const middle = (token.y0 + token.y1) / 2;
    const row = rows.find(r => Math.abs(r.y - middle) <= Math.min(r.h, token.y1 - token.y0) * 0.5);
    if (row) row.tokens.push(token);
    else rows.push({ y: middle, h: token.y1 - token.y0, tokens: [token] });
  }
  return rows.sort((a, b) => a.y - b.y).map(r => r.tokens.sort((a, b) => a.x0 - b.x0));
}

const lineText = row => row.map((t, i) => {
  const prev = row[i - 1];
  // PDF 안에서 한 글자씩 나뉜 '정답', 숫자·식은 원래 붙어 있으면 다시 붙인다.
  return (prev && t.x0 - prev.x1 > Math.min(t.y1 - t.y0, prev.y1 - prev.y0) * 0.18 ? ' ' : '') + t.str;
}).join('');
const numberKey = number => /^\d+$/.test(String(number)) ? String(Number(number)) : '';

/** 역할이 확인된 정답표의 번호·답 쌍. 여러 쌍이면 연속 번호만 인정한다. */
export function tablePairs(tokens) {
  return tokenLines(tokens).flatMap(row => {
    const text = lineText(row).replace(/(\d)([①-⑤])/g, '$1 $2');
    // 읽지 못한 답도 번호의 등장 횟수에는 포함한다.
    const pairs = [...text.matchAll(/(?:^|\s)(\d{1,6})[.)]?\s+([a-zA-Z]\s*=\s*[-+]?\d+(?:\.\d+)?(?:\/\d+)?|\S+)(?=\s|$)/g)];
    if (!pairs.length || pairs.some((p, i) => i && Number(p[1]) !== Number(pairs[i - 1][1]) + 1)) return [];
    if (pairs.length === 1 && (text.slice(0, pairs[0].index).trim() || text.slice(pairs[0].index + pairs[0][0].length).trim())) return [];
    // 쌍 사이에 풀이 문장 등이 끼어 있으면 표로 쓰지 않음
    if (pairs.some((p, i) => i && text.slice(pairs[i - 1].index + pairs[i - 1][0].length, p.index).trim())) return [];
    return pairs.map(p => ({ number: numberKey(p[1]), answer: /^[①-⑤]$|^(?:[a-zA-Z]\s*=\s*)?[-+]?\d+(?:\.\d+)?(?:\/\d+)?$/.test(p[2]) ? shortAnswer(p[2]) : '' }));
  });
}

/** 같은 번호가 두 번 나오면 답이 같더라도 버림. */
export function uniqueTable(pairs) {
  const seen = new Map();
  for (const { number, answer } of pairs) {
    const key = numberKey(number);
    if (key) seen.set(key, seen.has(key) ? '' : shortAnswer(answer));
  }
  return new Map([...seen].filter(([, answer]) => answer));
}

export function chooseAnswer(entry, region = '', table = '') {
  const direct = shortAnswer(entry.writtenAnswer?.answer);
  if (direct) return { answer: direct, source: 'saved', conflict: false };
  const written = answerFromBlocks(entry.writtenAnswer?.blocks);
  if (written) return { answer: written, source: 'written', conflict: false };
  region = shortAnswer(region); table = shortAnswer(table);
  if (region && table && region.replace(/\s/g, '') !== table.replace(/\s/g, '')) return { answer: '', source: '', conflict: true };
  return { answer: region || table, source: region ? 'region' : table ? 'table' : '', conflict: false };
}

export function answerTablePages(doc) {
  return Object.entries(doc?.pageInfo || {}).filter(([, info]) =>
    !info.exclusion?.restored && (info.exclusion?.role === 'answer_table' || info.flags?.includes('빠른 정답표 같아서 건너뜀'))
  ).map(([index]) => Number(index));
}

/** 이번 내보내기에서만 쓸 글자층 캐시. 영역 밖 글자는 읽지 않는다. */
export function createAnswerReader() {
  const caches = new Map();
  const cacheFor = src => {
    if (!caches.has(src)) caches.set(src, { pages: new Map(), tables: new Map() });
    return caches.get(src);
  };
  const tokensFor = async (src, index) => {
    if (!src || src.pages[index]?.kind !== 'pdf') return [];
    const pages = cacheFor(src).pages;
    if (!pages.has(index)) pages.set(index, src.getTextTokens(index).catch(() => []));
    return pages.get(index);
  };
  return {
    async readRegion(src, item) {
      const lines = [];
      if (!src || !item?.rects?.length) return { answer: '', scanned: false };
      for (const rect of item.rects) {
        if (await src.hasOnlyHiddenText?.(rect.page)) continue;
        const tokens = (await tokensFor(src, rect.page)).filter(t => {
          const x = (t.x0 + t.x1) / 2, y = (t.y0 + t.y1) / 2;
          return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
        });
        lines.push(...tokenLines(tokens).map(lineText));
      }
      return { answer: answerFromBlocks(lines.map(text => ({ type: 'para', text }))), scanned: !lines.length };
    },
    async region(src, item) {
      return (await this.readRegion(src, item)).answer;
    },
    async table(src, doc) {
      if (!src) return new Map();
      const tables = cacheFor(src).tables;
      const pages = answerTablePages(doc), key = pages.join(',');
      if (!tables.has(key)) {
        const pairs = [];
        for (const index of pages) pairs.push(...tablePairs(await tokensFor(src, index)));
        tables.set(key, uniqueTable(pairs));
      }
      return tables.get(key);
    },
  };
}

/** 답 자체는 저장하지 않고 내보낼 항목에 붙임. 새 AI 옮김만 기존 저장소에 남긴다. */
export async function resolveExportAnswers(entries, { convert, aiReady = false, transcriber, signal, onProgress = () => {} } = {}) {
  const reader = createAnswerReader();
  let missing = 0, conflicts = 0, scannedMissing = 0;
  const resolved = [];
  const work = [], stores = new Map();
  for (const entry of entries) {
    let result = chooseAnswer(entry);
    let scanned = false, block, store, table = '';
    if (!result.answer) {
      const region = await reader.readRegion(entry.src?.answer, entry.answer);
      scanned = region.scanned;
      table = (await reader.table(entry.src?.answer, entry.bookObj?.docs?.answer)).get(numberKey(entry.problem.number)) || '';
      if (scanned && aiReady && transcriber && entry.bookId) {
        if (!stores.has(entry.bookId)) {
          try { stores.set(entry.bookId, await transcriber.load(entry.bookId)); }
          catch (err) {
            console.warn('저장된 해설을 읽지 못함', err);
            stores.set(entry.bookId, null);
          }
        }
        store = stores.get(entry.bookId);
        if (store) block = { kind: 'answer', role: 'answer', item: entry.answer, src: entry.src.answer };
      }
      result = chooseAnswer(entry, region.answer, table);
    }
    work.push({ entry, result, scanned, block, store, table });
  }
  const pending = work.filter(w => w.block && !w.store.items[`${transcriptKey(w.block)}|edit`]?.blocks?.length &&
    !w.store.items[transcriptKey(w.block)]?.blocks?.length);
  if (pending.length && convert !== 'ocr' && !signal?.aborted) {
    const storeOf = new Map(work.filter(w => w.block).map(w => [w.block, w.store]));
    let done = 0;
    const progress = () => onProgress(`AI 로 해설을 읽는 중… (${done}/${pending.length})`);
    progress();
    try {
      await transcriber.run(pending.map(w => w.block), {
        storeOf: b => storeOf.get(b), signal, stopOnError: true,
        onResult: () => { done++; progress(); },
        onError: () => { done++; progress(); },
      });
    } catch (err) {
      // 이미 저장한 결과는 살리고, 취소·오류 뒤 남은 항목은 비운다.
      if (err?.name !== 'AbortError') console.warn('AI 로 해설을 읽지 못함', err);
    } finally { await transcriber.save(); }
  }
  for (const { entry, scanned, block, store, table, result: initial } of work) {
    let result = initial;
    if (block) {
      const key = transcriptKey(block);
      const edited = store.items[`${key}|edit`];
      const saved = edited?.blocks?.length ? edited : store.items[key];
      result = chooseAnswer(entry, answerFromBlocks(saved?.blocks), table);
    }
    if (!result.answer) missing++;
    if (!result.answer && scanned) scannedMissing++;
    if (result.conflict) conflicts++;
    resolved.push({ ...entry, exportAnswer: result.answer });
  }
  return { entries: resolved, missing, conflicts, scannedMissing };
}

export function missingAnswerMessage(missing, scannedMissing = 0) {
  return `답을 찾지 못한 문항 ${missing}개${scannedMissing ? '. 스캔한 해설은 AI 연동을 켜면 답을 읽을 수 있어요.' : ''}`;
}

/** 글자층을 읽어야 알 수 있는 책은 미리 막지 않는다. */
export function mayHaveAnswers(book, aiReady = false) {
  return book.docs?.problem?.items?.some(item => chooseAnswer({ writtenAnswer: book.$answers?.items?.[item.id] }).answer) ||
    !!book.docs?.answer?.files?.some(file => file.kind === 'pdf' || aiReady);
}
