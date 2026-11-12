import { normalizeHancomText, isPrivateChar } from './hancom.js';
import { identifyExam, selections } from './mockexam.js';

// 반복된 머리글이 같은 높이에 있는 단일 과목 표만 좌표로 분리한다.
function tableColumns(items, subject) {
  const cells = items.filter((i) => i.str?.trim() && i.transform?.length === 6)
    .map((i) => ({ text: i.str.trim(), x: i.transform[4], y: i.transform[5] }));
  const heads = cells.filter((i) => i.text === '문항').sort((a, b) => a.x - b.x);
  if (!subject || heads.length < 2 || !cells.some((i) => i.text.replace(/\s/g, '') === '배점')) return null;
  if (Math.max(...heads.map((i) => i.y)) - Math.min(...heads.map((i) => i.y)) > 3) return null;
  const labels = cells.filter((i) => selections.includes(i.text.replace(/\s/g, '')) && i.y > heads[0].y);
  return heads.map((h, k) => {
    const right = heads[k + 1]?.x - 3 || Infinity;
    const label = labels.find((i) => i.x >= h.x - 3 && i.x < right);
    const rows = [];
    for (const c of cells.filter((i) => i.x >= h.x - 3 && i.x < right && i.y < h.y - 16)) {
      let row = rows.find((r) => Math.abs(r.y - c.y) < 2);
      if (!row) rows.push(row = { y: c.y, cells: [] });
      row.cells.push(c);
    }
    return { selection: label?.text.replace(/\s/g, '') || null,
      text: '번호 정답 배점\n' + rows.sort((a, b) => b.y - a.y).map((r) => r.cells.sort((a, b) => a.x - b.x).map((c) => c.text).join(' ')).join('\n') };
  });
}

/** pdf.js TextContent.items를 내용 순서대로 넘기거나 문자열을 넘긴다.
 * 좌표 순으로 전역 정렬하면 다단 표의 과목이 섞이므로 내용 순서를 보존한다.
 * 반환 warnings는 누락/충돌 확인용이며 answers.json에는 저장하지 않는다.
 */
export function parseAnswerKey(input, { subject = null, selection = null, tablesOnly = false } = {}) {
  if (Array.isArray(input)) {
    const detected = identifyExam({ text: input.map((i) => i.str).join(' ') }).subject;
    const columns = tableColumns(input, subject || detected);
    if (columns) {
      const answers = {}, warnings = [], conflicts = new Set();
      for (const col of columns) {
        const result = parseAnswerKey(col.text, { subject: subject || detected, selection: col.selection, tablesOnly });
        warnings.push(...result.warnings);
        for (const [key, entries] of Object.entries(result.answers)) {
          answers[key] ||= {};
          for (const [number, entry] of Object.entries(entries)) {
            const id = `${key}:${number}`;
            if (conflicts.has(id)) continue;
            if (answers[key][number] && JSON.stringify(answers[key][number]) !== JSON.stringify(entry)) {
              delete answers[key][number]; conflicts.add(id); warnings.push(`${key} ${number}: 정답 충돌`);
            } else answers[key][number] = entry;
          }
        }
      }
      return { answers, warnings };
    }
  }
  const source = typeof input === 'string' ? input : input.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('');
  // 정답 PUA 숫자 바로 뒤에 다음 문항번호가 붙는 PDF도 경계를 잃지 않는다.
  const normalized = source.replace(/([가나AB])[’'”"]\s*형/g, '$1형').replace(/(\d{1,2}[.)])(?=[①-⑤➀-➄❶-❺])/g, '$1 ').replace(/[➀-➄❶-❺]/g, c => '①②③④⑤'[(c.codePointAt(0) >= 0x2780 ? c.codePointAt(0) - 0x2780 : c.codePointAt(0) - 0x2776)]);
  const text = normalizeHancomText(normalized.replace(/([\uE034-\uE03D])(?=\d)/g, '$1 ')).replace(/예[․·ㆍ.]체능(?:계)?/g, '예체능');
  const answers = {};
  const warnings = [];
  const conflicts = new Set();
  const headers = /국\s*어(?:\s*영역)?|언\s*어\s*영역|수\s*학(?:\s*영역)?|수\s*리\s*영역|영\s*어(?:\s*영역)?|외국어(?:\s*\(영어\))?(?:\s*영역)?|한국사(?:\s*영역)?|사회탐구(?:\s*영역)?|과학탐구(?:\s*영역)?|직업탐구(?:\s*영역)?|제2외국어[^\n]*|화법\s*과\s*작문|언어\s*와\s*매체|확률\s*과\s*통계|미적분|기하|인문계|자연계|예체능|[가나AB]\s*형/g;
  let current = subject;
  let selected = selection;
  let last = 0;
  const read = (chunk) => {
    if (!current) return;
    // 정답표 뒤의 해설 숫자는 답이 아니다. 제목의 '정답 및 해설'은 건너뛴다.
    const optionTail = current === 'math' && ['가형','나형','A형','B형'].includes(selected) && /정\s*답\s+26[.)]?\s+[①-⑤]\s+27[.)]?\s+[①-⑤]\s+28[.)]?\s+[①-⑤]/.test(chunk);
    const selectionStart = current === 'korean' && ['화법과작문', '언어와매체'].includes(selected) ? 35
      : current === 'math' && ['확률과통계', '미적분', '기하'].includes(selected) ? 23 : null;
    // 선택 해설은 공통 1번 대신 선택의 첫 세 문항이 연속하는 표만 인정한다.
    const selectionTail = selectionStart && new RegExp(`\\b${selectionStart}[.)]?\\s+[①-⑤]\\s+${selectionStart + 1}[.)]?\\s+[①-⑤]\\s+${selectionStart + 2}[.)]?\\s+[①-⑤]`).test(chunk);
    const firstNumber = optionTail ? 26 : selectionTail ? selectionStart : 1;
    const firstAnswer = new RegExp(`\\b${firstNumber}[.)]?\\s+[①-⑤]`).exec(chunk);
    if (firstAnswer) {
      const tail = chunk.slice(firstAnswer.index);
      const end = /해\s*설|풀\s*이|출제|정답률/.exec(tail);
      if (end) chunk = chunk.slice(0, firstAnswer.index + end.index);
    }

    const key = selected ? `${current}|${selected}` : current;
    const pointsColumn = /문항\s*(?:번호)?\s*정\s*답\s*배\s*점|번호\s*정\s*답\s*배\s*점/.test(chunk);
    // 해설 쪽의 계산 숫자를 정답으로 만들지 않는다. 명시적 표 또는 1·2·3 답 연속 확인.
    if (tablesOnly && !pointsColumn && !optionTail && !selectionTail && !/\b1[.)]?\s+[①-⑤]\s+2[.)]?\s+[①-⑤]\s+3[.)]?\s+[①-⑤]/.test(chunk)) return;
    const pattern = pointsColumn ? /(\d{1,2})[.)]?\s+([①-⑤]|\d{1,3})\s+([1-9](?:\.\d+)?)\b/g : /(\d{1,2})[.)]?\s+([①-⑤]|\d{1,3})(?!\d)/g;
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
    const label = m[0].replace(/\s/g, '');
    // 옛 가나형 내부의 '미적분과 통계' 등은 새 선택 답안 묶음이 아니다.
    if (current === 'math' && ['가형','나형','A형','B형','인문계','자연계','예체능'].includes(selected || selection) && ['미적분','기하','확률과통계'].includes(label)) continue;
    read(text.slice(last, m.index));
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
