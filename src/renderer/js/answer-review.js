import { h, clear } from './ui.js';
import { moveLow } from './lowconf.js';
import { eqToText } from './hwpeqview.js';

// 사람의 해설에는 저장하지 않는 편집 중 표시. 글을 감싸지 않아 입력 위치를 건드리지 않는다.
export function answerReview(editor, readDocument, changed) {
  const controls = h('div.answer-review');
  let selected = 0;
  let entries = [];
  const original = (node) => {
    try { return JSON.parse(node.dataset.original || '{}'); } catch { return {}; }
  };
  const logicalParts = (root) => {
    const parts = [];
    let at = 0;
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push({ node, start: at, end: at + node.length }); at += node.length;
      } else if (node.dataset?.eq !== undefined) {
        const length = eqToText(node.dataset.eq).length;
        parts.push({ node, start: at, end: at + length, math: true }); at += length;
      } else if (node.nodeName === 'BR' && node.parentNode.childNodes.length > 1) at++;
      else for (const child of node.childNodes) walk(child);
    };
    for (const node of root.childNodes) walk(node);
    return parts;
  };
  const update = () => {
    entries = [];
    editor.querySelectorAll('.answer-review-math').forEach((node) => node.classList.remove('answer-review-math'));
    const ranges = [];
    for (const node of editor.children) {
      let low;
      try { low = node.dataset.eq !== undefined ? JSON.parse(node.dataset.reviewLow || '[]') : original(node).reviewLow || []; } catch { low = []; }
      const parts = logicalParts(node);
      for (const [index, mark] of low.entries()) {
        entries.push({ node, index, mark });
        if (node.dataset.eq !== undefined) { node.classList.add('answer-review-math'); continue; }
        const covered = parts.filter((p) => p.end > mark.start && p.start < mark.end);
        if (!covered.length) continue;
        const first = covered[0];
        const last = covered.at(-1);
        const range = document.createRange();
        if (first.math) range.setStartBefore(first.node);
        else range.setStart(first.node, Math.max(0, mark.start - first.start));
        if (last.math) range.setEndAfter(last.node);
        else range.setEnd(last.node, Math.min(last.node.length, mark.end - last.start));
        ranges.push(range);
        for (const p of covered) if (p.math) p.node.classList.add('answer-review-math');
      }
    }
    CSS.highlights.set('answer-review', new Highlight(...ranges));
    selected = Math.min(selected, Math.max(0, entries.length - 1));
    clear(controls);
    if (!entries.length) return;
    controls.append(h('p.review-help', '노란 밑줄과 테두리는 원본과 비교해 주세요. 고치거나 [맞아요]를 누르면 표시가 사라져요.'),
      h('div.review-toolbar', h('strong', `확인할 곳 ${entries.length}개`),
        h('button.btn', { onclick: () => { selected = (selected + 1) % entries.length; update(); entries[selected].node.scrollIntoView({ block: 'nearest' }); } }, '다음 확인할 곳'),
        h('span', `${selected + 1}/${entries.length}`),
        h('button.btn.btn-primary', { onclick: () => {
          const { node, index } = entries[selected];
          if (node.dataset.eq !== undefined) node.dataset.reviewLow = JSON.stringify(JSON.parse(node.dataset.reviewLow).filter((_, i) => i !== index));
          else { const b = original(node); b.reviewLow = b.reviewLow.filter((_, i) => i !== index); node.dataset.original = JSON.stringify(b); }
          changed(); update();
        } }, '맞아요')));
  };
  return { element: controls, update,
    sync() {
      for (const node of editor.querySelectorAll('[data-original]')) {
        const before = original(node);
        if (!before.reviewLow?.length) continue;
        const blocks = readDocument(node);
        if (blocks.length !== 1 || blocks[0].type !== 'para') { delete before.reviewLow; node.dataset.original = JSON.stringify(before); continue; }
        const after = blocks[0];
        after.reviewLow = moveLow(before.reviewLow, before.text, after.text);
        node.dataset.original = JSON.stringify(after);
      }
    },
    close() { CSS.highlights.delete('answer-review'); },
  };
}

export function withoutAnswerReview(draft) {
  return { ...draft, blocks: draft.blocks.map(({ reviewLow, low, ...block }) => block) };
}
