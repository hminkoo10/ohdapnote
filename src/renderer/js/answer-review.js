import { h, clear } from './ui.js';
import { moveLow } from './lowconf.js';
import { eqToText } from './hwpeqview.js';
import { REVIEW_HELP, reviewSource, reviewHelpButton } from './review-ui.js';

// 사람의 해설에는 저장하지 않는 편집 중 표시. 글을 감싸지 않아 입력 위치를 건드리지 않는다.
export function answerReview(editor, readDocument, changed, getStack) {
  const controls = h('div.answer-review');
  const source = reviewSource(getStack, () => editor.clientWidth || 540);
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
    editor.querySelectorAll('.answer-review-math').forEach((node) => node.classList.remove('answer-review-math', 'answer-review-current'));
    const ranges = [];
    for (const node of editor.children) {
      let low;
      try { low = node.dataset.eq !== undefined ? JSON.parse(node.dataset.reviewLow || '[]') : original(node).reviewLow || []; } catch { low = []; }
      const parts = logicalParts(node);
      for (const [index, mark] of low.entries()) {
        const entry = { node, index, mark };
        entries.push(entry);
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
        entry.range = range;
        for (const p of covered) if (p.math) p.node.classList.add('answer-review-math');
      }
    }
    CSS.highlights.set('answer-review', new Highlight(...ranges));
    selected = Math.min(selected, Math.max(0, entries.length - 1));
    const active = entries[selected];
    CSS.highlights.set('answer-review-current', new Highlight(...(active?.range ? [active.range] : [])));
    if (active?.node.classList.contains('answer-review-math')) active.node.classList.add('answer-review-current');
    clear(controls);
    source.element.hidden = !entries.length;
    if (!entries.length) return;
    controls.append(h('p.small.muted.review-help', REVIEW_HELP),
      h('strong.small', `확인 필요 ${entries.length}군데`),
      h('div.review-toolbar',
        h('button.btn.btn-small', { onclick: () => select(selected + 1), title: 'F8' }, '다음 확인할 곳'),
        h('button.btn.btn-small', { onclick: () => select(selected - 1), title: 'Shift+F8' }, '이전'),
        h('span', `${selected + 1}/${entries.length}`),
        h('button.btn.btn-small', { onclick: () => source.show(entries[selected].mark) }, '원본 보기'),
        h('button.btn.btn-small.btn-primary', { onclick: () => {
          const { node, index } = entries[selected];
          if (node.dataset.eq !== undefined) node.dataset.reviewLow = JSON.stringify(JSON.parse(node.dataset.reviewLow).filter((_, i) => i !== index));
          else { const b = original(node); b.reviewLow = b.reviewLow.filter((_, i) => i !== index); node.dataset.original = JSON.stringify(b); }
          changed(); update();
        } }, '맞아요'), reviewHelpButton()),
      h('div.review-mark-buttons', entries.map(({ node, mark }, index) => h('button.btn.btn-small.review-mark-button', { onclick: () => select(index) }, `확인: ${node.dataset.eq !== undefined ? '수식' : node.textContent.slice(mark.start, mark.end).slice(0, 22) || '수식'}`))));
    source.show(entries[selected].mark);
  };
  const select = (index) => {
    if (!entries.length) return;
    selected = (index + entries.length) % entries.length;
    update();
    entries[selected].node.scrollIntoView({ block: 'nearest' });
  };
  const point = (event) => {
    const index = entries.findIndex(({ node, range }) => [...(range ? range.getClientRects() : node.getClientRects())].some((r) => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom));
    if (index >= 0) select(index);
  };
  editor.addEventListener('click', point);
  return { element: controls, reference: source.element, update,
    keydown(event) { if (event.key !== 'F8' || !entries.length) return false; select(selected + (event.shiftKey ? -1 : 1)); return true; },
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
    close() { source.close(); editor.removeEventListener('click', point); CSS.highlights.delete('answer-review'); CSS.highlights.delete('answer-review-current'); },
  };
}

export function withoutAnswerReview(draft) {
  return { ...draft, blocks: draft.blocks.map(({ reviewLow, low, ...block }) => block) };
}
