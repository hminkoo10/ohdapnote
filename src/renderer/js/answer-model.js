import { eqToText } from './hwpeqview.js';
import { latexToHwpEq } from './hwpeq.js';

const copy = (v) => JSON.parse(JSON.stringify(v));
export const runsText = (runs) => runs.map((r) => r.eq !== undefined ? eqToText(r.eq) : r.text).join('');
const mergedRuns = (runs) => runs.reduce((out, r) => {
  if (r.text !== undefined && out.at(-1)?.text !== undefined) out.at(-1).text += r.text;
  else if (r.eq !== undefined || r.text) out.push({ ...r });
  return out;
}, []);

// 화면 모델에도 원래 문단 모양을 보관해, 손대지 않은 문단은 그대로 돌려준다.
export function blocksToModel(blocks) {
  return blocks.map((b) => b.type === 'para' ? { ...copy(b), runs: copy(b.runs || [{ text: b.text }]), original: copy(b) } : copy(b));
}

export function modelToBlocks(model) {
  return model.map((b) => {
    if (b.type !== 'para') return copy(b);
    if (b.original && JSON.stringify(mergedRuns(b.runs)) === JSON.stringify(mergedRuns(b.original.runs || [{ text: b.original.text }]))) return copy(b.original);
    return { type: 'para', text: runsText(b.runs), runs: copy(b.runs) };
  });
}

export function createAnswerHistory(initial, { delay = 800, limit = 100 } = {}) {
  let states = [copy(initial)];
  let index = 0;
  let group = '';
  let at = 0;
  const current = () => copy(states[index]);
  return {
    current,
    push(value, kind = '', now = Date.now()) {
      if (JSON.stringify(value) === JSON.stringify(states[index])) return false;
      const merge = kind && kind === group && now - at < delay && index === states.length - 1 && index > 0;
      states = states.slice(0, index + 1);
      if (merge) states[index] = copy(value);
      else { states.push(copy(value)); index++; }
      if (states.length > limit) { states.shift(); index--; }
      group = kind; at = now;
      return true;
    },
    boundary() { group = ''; },
    undo() { group = ''; if (index > 0) index--; return current(); },
    redo() { group = ''; if (index < states.length - 1) index++; return current(); },
    get canUndo() { return index > 0; },
    get canRedo() { return index < states.length - 1; },
  };
}

function inlineRuns(text, spans = []) {
  const runs = [];
  const re = /\$([^$\n]+)\$|\\\(([^]*?)\\\)/g;
  let start = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > start) runs.push({ text: text.slice(start, m.index) });
    const eq = latexToHwpEq(m[1] ?? m[2]);
    spans.push({ start: m.index, end: m.index + m[0].length, length: eqToText(eq).length });
    runs.push({ eq });
    start = m.index + m[0].length;
  }
  if (start < text.length || !runs.length) runs.push({ text: text.slice(start) });
  return runs;
}

/** 그림 자르기는 호출자가 처리하고, 여기서는 글·수식 변환만 한다. */
export function importAnswerBlocks(blocks, { review = false } = {}) {
  return blocks.flatMap((b) => {
    if (b.type === 'math') return [{ type: 'math', eq: b.eq ?? latexToHwpEq(b.latex || ''), ...(review && b.low?.length ? { reviewLow: copy(b.low) } : {}) }];
    if (b.type === 'figure') return [{ ...b }];
    const texts = b.type === 'choices' ? b.items.map((s, i) => `${'①②③④⑤'[i] || i + 1} ${s}`) : [b.text || ''];
    return texts.map((text, item) => {
      const spans = [];
      const runs = b.runs ? copy(b.runs) : inlineRuns(text, spans);
      const prefix = b.type === 'choices' ? text.length - b.items[item].length : 0;
      const offset = (at, end) => {
        let delta = 0;
        for (const span of spans) {
          if (at <= span.start) break;
          if (at < span.end) return span.start + delta + (end ? span.length : 0);
          delta += span.length - (span.end - span.start);
        }
        return at + delta;
      };
      const low = review ? (b.low || []).filter((mark) => b.type !== 'choices' || mark.item === item).map((mark) => {
        const { item: ignored, ...rest } = mark;
        return { ...rest, start: offset((mark.start ?? 0) + prefix, false), end: offset((mark.end ?? text.length - prefix) + prefix, true) };
      }) : [];
      return { type: 'para', text: runsText(runs), runs, ...(low.length ? { reviewLow: low } : {}) };
    });
  });
}

export function recognizedAnswer(blocks) {
  const head = blocks.slice(0, 3).map((b) => b.text || '').join(' ').slice(0, 200);
  return /(?:정답|답)\s*[:：]?\s*([①-⑤]|[-+]?\d+(?:\.\d+)?(?:\/\d+)?|[a-zA-Z]\s*=\s*[-+]?\d+(?:\.\d+)?)/.exec(head)?.[1] || '';
}

export function answerContent(entry) {
  if (!entry) return null;
  const answer = entry.answer?.trim() || '';
  const head = answer ? [{ type: 'para', text: `정답 ${answer}` }] : [];
  const useful = entry.blocks?.some((b) => b.type !== 'para' || b.text?.trim() || b.runs?.some((r) => r.eq || r.text?.trim()));
  if (!useful) return head.length ? head : null;
  // 해설지에는 정답을 맨 앞에. 불러온 해설이 이미 같은 정답으로 시작하면 다시 쓰지 않음
  const first = entry.blocks.find((b) => b.type === 'para' && b.text?.trim())?.text.trim() || '';
  const already = answer && recognizedAnswer([{ type: 'para', text: first }]) === answer && /^(?:정답|답)/.test(first);
  return already ? entry.blocks : [...head, ...entry.blocks];
}
