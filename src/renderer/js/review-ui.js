import { h, clear, modal } from './ui.js';
import { listLow, nextLow, moveLow, clearLow, setLow } from './lowconf.js';

export const REVIEW_HELP = '노란 밑줄·테두리: 잘못 읽었을 수 있는 곳';

export function reviewHelpButton(extra = []) {
  return h('button.btn.btn-small', { onclick: () => modal({ title: '확인 표시 도움말', width: 520,
    body: h('ul', [
      '표시 또는 [원본 보기]: 원본 확대',
      '[맞아요]: 선택한 표시 지우기',
      '[되돌리기]: 마지막 확인·수정 취소',
      'F8: 다음 표시, Shift+F8: 이전 표시',
      ...extra,
    ].map((text) => h('li', text))), buttons: [{ label: '닫기', value: true }],
  }) }, '도움말');
}

/** 입력은 기본 textarea에 맡기고, 같은 글의 배경 층에만 표시를 그린다. */
export function reviewInput(block, { item, label, onSelect, onChange } = {}) {
  const value = () => block.type === 'math' ? block.latex ?? block.eq ?? '' : item !== undefined ? block.items[item] : block.text || '';
  const marks = () => (block.low || []).flatMap((mark, index) => item === undefined || mark.item === item ? [{ mark, index }] : []);
  const input = h('textarea.input.review-text', { value: value(), 'aria-label': label, spellcheck: false, rows: block.type === 'para' ? 4 : 2 });
  input.value = value();
  const ink = h('div.review-ink', { 'aria-hidden': 'true' });
  const backdrop = h('div.review-backdrop', ink);
  const buttons = h('div.review-mark-buttons');
  const wrap = h('div.review-field', h('div.review-input', backdrop, input), buttons);
  let before = value();
  let composing = false;
  let history = [{ text: before, low: marks().map(({ mark }) => ({ ...mark })) }];
  const syncScroll = () => { ink.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`; };
  const paint = () => {
    clear(ink); clear(buttons);
    const text = input.value;
    const intervals = marks();
    const edges = [...new Set([0, text.length, ...intervals.flatMap(({ mark }) => [mark.start ?? 0, mark.end ?? text.length])])].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);
    for (let i = 0; i < edges.length - 1; i++) {
      const start = edges[i];
      const end = edges[i + 1];
      const hit = intervals.filter(({ mark }) => (mark.start ?? 0) <= start && (mark.end ?? text.length) >= end);
      ink.append(hit.length ? h(`span.review-mark${hit.some(({ mark }) => mark.reason === 'math' || block.type === 'math') ? '.review-math' : ''}`, { dataset: { lowIndex: hit[0].index } }, text.slice(start, end)) : document.createTextNode(text.slice(start, end)));
    }
    ink.append(document.createTextNode('\u200b'));
    for (const { mark, index } of intervals) {
      const snippet = text.slice(mark.start ?? 0, mark.end ?? text.length).slice(0, 22) || '수식';
      buttons.append(h('button.btn.btn-small.review-mark-button', { type: 'button', onclick: () => onSelect?.(index, true), onmouseenter: () => onSelect?.(index, false) }, mark.detail || `확인: ${snippet}`));
    }
    syncScroll();
  };
  const commit = (event) => {
    if (composing || event?.isComposing) return;
    const after = input.value;
    if (after === before) return;
    let low = moveLow(block.low, before, after, item);
    if (event?.inputType === 'historyUndo' || event?.inputType === 'historyRedo') {
      const saved = history.findLast((entry) => entry.text === after);
      if (saved) low = [...(item === undefined ? [] : (block.low || []).filter((mark) => mark.item !== item)), ...saved.low];
    }
    setLow(block, low);
    if (block.type === 'math') block[block.eq !== undefined ? 'eq' : 'latex'] = after;
    else if (item !== undefined) block.items[item] = after;
    else block.text = after;
    before = after;
    history.push({ text: after, low: marks().map(({ mark }) => ({ ...mark })) });
    if (history.length > 100) history.shift();
    paint(); onChange?.();
  };
  const point = (event, focus) => {
    for (const span of ink.querySelectorAll('[data-low-index]')) {
      if ([...span.getClientRects()].some((r) => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom)) {
        onSelect?.(Number(span.dataset.lowIndex), focus);
        break;
      }
    }
  };
  input.addEventListener('input', commit);
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; commit(); });
  input.addEventListener('scroll', syncScroll);
  input.addEventListener('mousemove', (event) => point(event, false));
  input.addEventListener('click', (event) => point(event, false));
  const resize = new ResizeObserver(() => { backdrop.style.width = `${input.clientWidth}px`; });
  resize.observe(input);
  paint();
  return { element: wrap, input, paint, commit,
    dispose() { resize.disconnect(); },
    confirmed() { history = [{ text: before, low: marks().map(({ mark }) => ({ ...mark })) }]; paint(); },
    focus(mark) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(mark.start ?? 0, mark.end ?? input.value.length);
      // 선택한 표시가 긴 문단의 화면 밖에 있으면 해당 줄까지 옮긴다.
      const span = [...ink.querySelectorAll('[data-low-index]')].find((el) => Number(el.dataset.lowIndex) === (block.low || []).indexOf(mark));
      if (span) {
        const rect = span.getBoundingClientRect();
        const field = input.getBoundingClientRect();
        if (rect.top < field.top || rect.bottom > field.bottom) input.scrollTop += rect.top - field.top - 24;
      }
      input.scrollIntoView({ block: 'nearest' }); syncScroll();
    },
  };
}

/** 원본은 옮길 때와 같은 이어 붙인 그림에서 자른다. */
export function reviewSource(getStack, getWidth = () => 540) {
  let serial = 0;
  let closed = false;
  const zoom = h('div.review-zoom');
  const show = async (mark) => {
    const run = ++serial;
    clear(zoom);
    zoom.append(h('p.small.muted', '원본을 여는 중…'));
    try {
      const source = await getStack();
      if (closed || run !== serial) return;
      const b = mark?.box || { x: 0, y: 0, w: 1, h: 1 };
      const pad = Math.max(12, source.width * 0.015);
      const x = Math.max(0, Math.floor(b.x * source.width - pad));
      const y = Math.max(0, Math.floor(b.y * source.height - pad));
      const w = Math.min(source.width - x, Math.ceil((b.x + b.w) * source.width + pad - x));
      const hh = Math.min(source.height - y, Math.ceil((b.y + b.h) * source.height + pad - y));
      const canvas = h('canvas', { width: w, height: hh, role: 'img', 'aria-label': '확인할 곳 원본 확대' });
      canvas.getContext('2d').drawImage(source, x, y, w, hh, 0, 0, w, hh);
      // 원본 전체를 편집 칸 폭에 맞춰 봤을 때보다 2.5배 크게 표시.
      const scale = getWidth() / source.width * (mark?.box ? 2.5 : 1);
      canvas.style.width = `${w * scale}px`;
      canvas.style.height = `${hh * scale}px`;
      clear(zoom).append(canvas);
    } catch { if (!closed && run === serial) clear(zoom).append(h('p.small.muted', '원본을 열지 못했습니다.')); }
  };
  return { element: h('div.review-source', h('h4', '원본 보기'), zoom), show, close() { closed = true; serial++; } };
}

/** 확인과 글 고치기는 창을 닫기 전까지 함께 되돌릴 수 있다. */
export function reviewPanel(blocks, getStack, redraw) {
  let current = null;
  const history = [JSON.stringify(blocks)];
  const fields = new Map();
  const count = h('strong.review-count', { role: 'status', 'aria-live': 'polite' });
  const source = reviewSource(getStack, () => fields.values().next().value?.input.clientWidth || 540);
  const update = (repaint = true) => {
    const snapshot = JSON.stringify(blocks);
    if (snapshot !== history.at(-1)) {
      history.push(snapshot);
      if (history.length > 100) history.shift();
    }
    undo.disabled = history.length < 2;
    const list = listLow(blocks);
    let at = list.findIndex((p) => p.block === current?.block && p.index === current?.index);
    if (at < 0) { current = list[0] || null; at = current ? 0 : -1; }
    else current = list[at];
    count.textContent = `${at + 1}/${list.length}`;
    count.setAttribute('aria-label', list.length ? `확인이 필요한 곳 ${list.length}군데 중 ${at + 1}번째` : '확인이 필요한 곳이 없습니다.');
    previous.disabled = next.disabled = okay.disabled = !list.length;
    if (repaint) fields.forEach((field) => field.paint());
    source.show(current?.mark);
  };
  const select = (block, index, focus = true) => {
    current = { block, index, mark: blocks[block].low[index] };
    update(false);
    if (focus) fields.get(`${block}:${current.mark.item ?? ''}`)?.focus(current.mark);
  };
  const jump = (direction) => {
    const found = nextLow(blocks, current, direction);
    if (found) select(found.block, found.index);
  };
  const previous = h('button.btn', { onclick: () => jump(-1), title: '이전 확인할 곳 (Shift+F8)' }, '이전');
  const next = h('button.btn', { onclick: () => jump(1), title: 'F8' }, '다음 확인할 곳');
  const okay = h('button.btn.btn-primary', { onclick: () => {
    if (!current) return;
    setLow(blocks[current.block], clearLow(blocks[current.block].low, current.index));
    fields.forEach((field) => field.confirmed());
    update();
  } }, '맞아요');
  const undo = h('button.btn', { onclick: () => {
    if (history.length < 2) return;
    history.pop();
    blocks.splice(0, blocks.length, ...JSON.parse(history.at(-1)));
    redraw();
  } }, '되돌리기');
  const original = h('button.btn', { onclick: () => source.show(current?.mark) }, '원본 보기');
  const toolbar = h('div.review-toolbar', next, previous, count, okay, original, undo, reviewHelpButton([
    '수식 입력: LaTeX (예: \\frac{1}{2})',
    'PDF는 원본 그림이에요. 고친 글은 한글 문서에만 들어가요.',
    '저장 뒤 [원래대로]: 처음 옮긴 글과 표시 복원',
  ]));
  const aside = h('aside.review-reference', source.element);
  return { toolbar, aside, update,
    resetFields() { fields.forEach((field) => field.dispose()); fields.clear(); current = null; },
    field(block, item) {
      const field = reviewInput(blocks[block], { item, label: `${block + 1}번째 ${item !== undefined ? `${item + 1}번 보기` : blocks[block].type === 'math' ? '수식' : '글'} 칸`, onSelect: (index, focus) => select(block, index, focus), onChange: update });
      fields.set(`${block}:${item ?? ''}`, field);
      return field.element;
    },
    keydown(event) { if (event.key !== 'F8') return false; jump(event.shiftKey ? -1 : 1); return true; },
    close() { source.close(); fields.forEach((field) => field.dispose()); },
  };
}
