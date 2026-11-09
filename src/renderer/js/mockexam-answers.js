import { normalizeHancomText, isPrivateChar } from './hancom.js';
import { selections } from './mockexam.js';

/** pdf.js TextContent.items를 내용 순서대로 넘기거나 문자열을 넘긴다.
 * 좌표 순으로 전역 정렬하면 다단 표의 과목이 섞이므로 내용 순서를 보존한다.
 * 반환 warnings는 누락/충돌 확인용이며 answers.json에는 저장하지 않는다.
 */
export function parseAnswerKey(input, { subject = null, selection = null } = {}) {
  const source = typeof input === 'string' ? input : input.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('');
  // 정답 PUA 숫자 바로 뒤에 다음 문항번호가 붙는 PDF도 경계를 잃지 않는다.
  const text = normalizeHancomText(source.replace(/([\uE034-\uE03D])(?=\d)/g, '$1 '));
  const answers = {};
  const warnings = [];
  const conflicts = new Set();
  const headers = /국\s*어(?:\s*영역)?|언\s*어\s*영역|수\s*학(?:\s*영역)?|수\s*리\s*영역|영\s*어(?:\s*영역)?|외국어(?:\s*\(영어\))?(?:\s*영역)?|한국사(?:\s*영역)?|사회탐구(?:\s*영역)?|과학탐구(?:\s*영역)?|직업탐구(?:\s*영역)?|제2외국어[^\n]*|화법\s*과\s*작문|언어\s*와\s*매체|확률\s*과\s*통계|미적분|기하|[가나AB]\s*형/g;
  let current = subject;
  let selected = selection;
  let last = 0;
  const read = (chunk) => {
    if (!current) return;
    const key = selected ? `${current}|${selected}` : current;
    const pointsColumn = /문항\s*(?:번호)?\s*정답\s*배점|번호\s*정답\s*배점/.test(chunk);
    const pattern = pointsColumn ? /(\d{1,2})\s+([①-⑤]|\d{1,3})\s+([1-9](?:\.\d+)?)\b/g : /(\d{1,2})\s+([①-⑤]|\d{1,3})(?!\d)/g;
    for (const m of chunk.matchAll(pattern)) {
      const number = +m[1];
      if (!number || number > (current === 'math' ? 30 : 60)) { warnings.push(`문항번호 범위: ${m[1]}`); continue; }
      const answer = /^[①-⑤]$/.test(m[2]) ? String('①②③④⑤'.indexOf(m[2]) + 1) : String(+m[2]);
      if (current !== 'math' && (+answer < 1 || +answer > 5)) { warnings.push(`${key} ${number}: 답 범위`); continue; }
      answers[key] ||= {};
      if (conflicts.has(`${key}:${number}`)) continue;
      const entry = { answer, points: pointsColumn ? +m[3] : null };
      if (answers[key][number] && JSON.stringify(answers[key][number]) !== JSON.stringify(entry)) {
        warnings.push(`${key} ${number}: 정답 충돌`);
        delete answers[key][number];
        conflicts.add(`${key}:${number}`);
      } else answers[key][number] = entry;
    }
    if (isPrivateChar(chunk)) warnings.push(`${key}: 미확인 PUA`);
  };
  for (const m of text.matchAll(headers)) {
    read(text.slice(last, m.index));
    const label = m[0].replace(/\s/g, '');
    if (selections.includes(label)) selected = label;
    else {
      current = /^(국어|언어)/.test(label) ? 'korean' : /^(수학|수리)/.test(label) ? 'math' : /^(영어|외국어)/.test(label) ? 'english' : null;
      selected = null;
    }
    last = m.index + m[0].length;
  }
  read(text.slice(last));
  if (!Object.keys(answers).length) warnings.push('읽은 정답 없음');
  return { answers, warnings };
}

/** 한 과목/선택 정답 → answers.json. 번호→실제 문항 ID 매핑 필수, 다른 과목 혼입 방지. */
export function answerKeyToAnswers(parsed, section, itemIds, { common = true } = {}) {
  const answers = parsed.answers || parsed;
  const base = section.split('|')[0];
  const entries = { ...(common && section.includes('|') ? answers[base] : {}), ...answers[section] };
  const items = {};
  for (const [number, entry] of Object.entries(entries)) {
    const id = itemIds[number];
    if (typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(id)) items[id] = { answer: String(entry.answer), blocks: [] };
  }
  return { version: 1, items };
}
