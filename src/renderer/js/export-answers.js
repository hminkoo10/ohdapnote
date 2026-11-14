import { recognizedAnswer, runsText } from './answer-model.js';

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
  const written = headAnswer(entry.writtenAnswer?.blocks);
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

/** 이번 내보내기에서만 쓸 읽기 캐시. 스캔본은 OCR 하지 않는다. */
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
    async region(src, item) {
      if (!src || !item) return '';
      // 이어지는 쪽의 본문을 머리로 읽지 않게 첫 영역만 본다.
      const rect = item.rects?.[0];
      if (!rect) return '';
      const tokens = (await tokensFor(src, rect.page)).filter(t => {
        const x = (t.x0 + t.x1) / 2, y = (t.y0 + t.y1) / 2;
        return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
      });
      return headAnswer([{ text: tokenLines(tokens).map(lineText).join('\n') }]);
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

/** 저장 기록은 건드리지 않고 내보낼 항목에만 답을 붙인다. */
export async function resolveExportAnswers(entries) {
  const reader = createAnswerReader();
  let missing = 0, conflicts = 0;
  const resolved = [];
  for (const entry of entries) {
    let result = chooseAnswer(entry);
    if (!result.answer) {
      const region = await reader.region(entry.src?.answer, entry.answer);
      const table = await reader.table(entry.src?.answer, entry.bookObj?.docs?.answer);
      result = chooseAnswer(entry, region, table.get(numberKey(entry.problem.number)) || '');
    }
    if (!result.answer) missing++;
    if (result.conflict) conflicts++;
    resolved.push({ ...entry, exportAnswer: result.answer });
  }
  return { entries: resolved, missing, conflicts };
}

/** 글자층을 읽어야 알 수 있는 책은 미리 막지 않는다. */
export function mayHaveAnswers(book) {
  return book.docs?.problem?.items?.some(item => chooseAnswer({ writtenAnswer: book.$answers?.items?.[item.id] }).answer) ||
    !!book.docs?.answer?.files?.some(file => file.kind === 'pdf');
}
