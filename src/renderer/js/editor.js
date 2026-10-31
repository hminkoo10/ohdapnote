// "페이지 검토" 편집기: 인식된 문항 영역을 페이지 위에 표시하고 고칠 수 있게 합니다.
//  - 상자 클릭: 선택 / 드래그: 이동 / 모서리: 크기 조절
//  - [문항 추가] 모드에서 빈 곳을 드래그: 새 문항
//  - [영역 추가] 모드: 선택한 문항에 영역(다음 단/쪽으로 이어지는 부분) 추가
//  - Delete: 선택한 영역(또는 문항) 삭제

import { h, clear, icon, debounce, toast } from './ui.js';
import { ROLE_NAME, pageLabel, itemsByPage } from './store.js';
import { sortItems } from './detect.js';

export function createEditor(ctx) {
  const st = {
    role: 'problem',
    page: 0,
    zoom: 1,
    selected: null, // {id, rect}
    mode: 'select', // select | draw | addRect
    onlyFlagged: false,
    renderToken: 0,
  };

  const el = h('div.editor');
  const side = h('div.editor-side');
  const main = h('div.editor-main');
  const toolbar = h('div.editor-toolbar');
  const hint = h('div.editor-hint');
  const stage = h('div.editor-stage');
  const wrap = h('div.page-wrap');
  const canvas = h('canvas.page-canvas');
  const overlay = h('div.page-overlay');
  wrap.append(canvas, overlay);
  stage.append(wrap);
  main.append(toolbar, hint, stage);
  el.append(side, main);

  const doc = () => ctx.project()?.docs?.[st.role] || null;
  const src = () => ctx.source(st.role);

  // ------------------------------------------------------------------
  function renderSide() {
    clear(side);
    const p = ctx.project();
    side.append(
      h(
        'div.seg-toggle',
        ['problem', 'answer'].map((role) =>
          h(
            `button${st.role === role ? '.active' : ''}`,
            { disabled: !p?.docs?.[role], onclick: () => show(role, firstPage(role)) },
            ROLE_NAME[role],
          ),
        ),
      ),
    );
    const d = doc();
    const s = src();
    if (!d || !s) {
      side.append(h('p.muted.small', '파일이 없습니다.'));
      return;
    }
    const flaggedCount = Object.values(d.pageInfo || {}).filter((pi) => pi.flags?.length).length;
    side.append(
      h(
        'label.check.small',
        h('input', {
          type: 'checkbox',
          checked: st.onlyFlagged,
          onchange: (e) => {
            st.onlyFlagged = e.target.checked;
            renderSide();
          },
        }),
        ` 확인 필요한 쪽만 (${flaggedCount})`,
      ),
    );
    const byPage = itemsByPage(d);
    const list = h('div.page-list');
    for (let i = 0; i < s.numPages; i++) {
      const info = d.pageInfo?.[i];
      const flagged = info?.flags?.length > 0;
      if (st.onlyFlagged && !flagged) continue;
      const n = byPage.get(i)?.length || 0;
      const row = h(
        `button.page-row${i === st.page ? '.active' : ''}${flagged ? '.flagged' : ''}${info?.analyzed ? '' : '.unanalyzed'}`,
        { onclick: () => show(st.role, i), title: flagged ? info.flags.join(', ') : '' },
        h('span.pr-page', pageLabel(d, i)),
        h('span.pr-count', info?.analyzed ? `${n}개` : '–'),
        flagged ? icon('warn') : null,
      );
      list.append(row);
    }
    side.append(list);
    requestAnimationFrame(() => list.querySelector('.active')?.scrollIntoView({ block: 'nearest' }));
  }

  function firstPage(role) {
    const d = ctx.project()?.docs?.[role];
    if (!d) return 0;
    const flagged = Object.entries(d.pageInfo || {}).find(([, v]) => v.flags?.length);
    if (flagged) return Number(flagged[0]);
    const first = sortItems(d.items || [])[0];
    return first ? first.page : 0;
  }

  // ------------------------------------------------------------------
  function selectedItem() {
    if (!st.selected) return null;
    return (doc()?.items || []).find((it) => it.id === st.selected.id) || null;
  }

  function renderToolbar() {
    clear(toolbar);
    const s = src();
    const d = doc();
    if (!s || !d) return;
    const pageInput = h('input.input.input-page', {
      value: String(st.page + 1),
      onchange: (e) => {
        const v = parseInt(e.target.value, 10);
        if (v >= 1 && v <= s.numPages) show(st.role, v - 1);
        else e.target.value = String(st.page + 1);
      },
    });
    const it = selectedItem();
    const numInput = h('input.input.input-num', {
      value: it ? it.number : '',
      placeholder: '번호',
      disabled: !it,
      title: '선택한 문항의 번호',
      onchange: (e) => {
        const digits = e.target.value.replace(/\D/g, '');
        const cur = selectedItem();
        if (!cur || !digits) {
          e.target.value = cur?.number || '';
          return;
        }
        cur.number = digits;
        cur.num = parseInt(digits, 10);
        cur.source = 'manual';
        commit();
      },
    });
    numInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.target.blur();
    });
    toolbar.append(
      h('div.tb-group',
        h('button.btn.btn-icon', { title: '이전 쪽 (←)', onclick: () => go(-1), disabled: st.page <= 0 }, icon('left')),
        pageInput,
        h('span.muted', ` / ${s.numPages}`),
        h('button.btn.btn-icon', { title: '다음 쪽 (→)', onclick: () => go(1), disabled: st.page >= s.numPages - 1 }, icon('right')),
        h('span.tb-pagelabel', `${pageLabel(d, st.page)}`),
      ),
      h('div.tb-group',
        h(`button.btn.btn-small${st.mode === 'draw' ? '.btn-active' : ''}`, { onclick: () => setMode(st.mode === 'draw' ? 'select' : 'draw'), title: '빈 곳을 드래그해서 새 문항 영역을 그립니다' }, icon('plus'), ' 문항 추가'),
        h(`button.btn.btn-small${st.mode === 'addRect' ? '.btn-active' : ''}`, { onclick: () => setMode(st.mode === 'addRect' ? 'select' : 'addRect'), disabled: !it, title: '선택한 문항에 영역을 하나 더 그립니다 (다음 단·쪽으로 이어지는 부분)' }, icon('box'), ' 영역 추가'),
        h('button.btn.btn-small', { onclick: deleteSelected, disabled: !it, title: '선택한 영역 삭제 (Delete)' }, icon('trash'), ' 삭제'),
        h('label.tb-num', '번호 ', numInput),
      ),
      h('div.tb-group.tb-right',
        h('button.btn.btn-small', { onclick: () => ctx.reanalyzePage(st.role, st.page), title: '이 쪽만 다시 자동 인식합니다 (이 쪽에서 직접 고친 내용은 사라집니다)' }, icon('scan'), ' 다시 인식'),
        h('button.btn.btn-small', { onclick: () => ctx.geminiPage(st.role, st.page), title: 'Gemini AI 로 이 쪽을 인식합니다 (설정에서 API 키 필요)' }, icon('sparkle'), ' Gemini 인식'),
        h('button.btn.btn-icon', { title: '축소', onclick: () => setZoom(st.zoom / 1.2) }, '−'),
        h('span.muted.small', `${Math.round(st.zoom * 100)}%`),
        h('button.btn.btn-icon', { title: '확대', onclick: () => setZoom(st.zoom * 1.2) }, '+'),
      ),
    );
  }

  function renderHint() {
    clear(hint);
    const d = doc();
    if (!d) return;
    const info = d.pageInfo?.[st.page];
    const parts = [];
    if (!info?.analyzed) parts.push(h('span', '이 쪽은 아직 분석하지 않았습니다.'));
    else {
      const src = { text: 'PDF 글자', ocr: 'OCR(스캔 인식)', gemini: 'Gemini', manual: '직접 편집' }[info.source] || info.source;
      parts.push(h('span.muted', `인식 방법: ${src}`));
      if (info.flags?.length) parts.push(h('span.warn-text', icon('warn'), ` 확인 필요: ${info.flags.join(', ')}`));
    }
    const modeHint = {
      select: '상자를 클릭해 선택하고, 끌어서 옮기거나 모서리로 크기를 바꿀 수 있습니다.',
      draw: '빈 곳을 드래그해서 새 문항 영역을 그리세요. 그린 뒤 번호를 입력하세요.',
      addRect: '선택한 문항에 이어지는 영역을 드래그해서 그리세요. (다른 쪽으로 넘어가도 됩니다)',
    }[st.mode];
    parts.push(h('span.muted', modeHint));
    hint.append(...parts);
  }

  // ------------------------------------------------------------------
  async function renderCanvas() {
    const s = src();
    if (!s) return;
    const token = ++st.renderToken;
    const meta = s.pages[st.page];
    const availW = Math.max(300, stage.clientWidth - 32);
    const availH = Math.max(300, stage.clientHeight - 24);
    const fitW = Math.min(availW, (availH * meta.w) / meta.h * 1.0);
    const cssW = Math.round(Math.max(320, fitW) * st.zoom);
    const cssH = Math.round((cssW * meta.h) / meta.w);
    wrap.style.width = `${cssW}px`;
    wrap.style.height = `${cssH}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rendered = await s.renderPage(st.page, Math.min(2600, Math.round(cssW * dpr)));
    if (token !== st.renderToken) return;
    canvas.width = rendered.width;
    canvas.height = rendered.height;
    canvas.getContext('2d').drawImage(rendered, 0, 0);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }

  function renderOverlay() {
    clear(overlay);
    overlay.classList.toggle('mode-draw', st.mode !== 'select');
    const d = doc();
    if (!d) return;
    const sorted = sortItems(d.items || []);
    sorted.forEach((it, k) => {
      it.rects.forEach((r, ri) => {
        if (r.page !== st.page) return;
        const isSel = st.selected && st.selected.id === it.id;
        const cont = ri > 0;
        const box = h(
          `div.box${isSel ? '.selected' : ''}${cont ? '.cont' : ''}${it.source === 'manual' ? '.manual' : ''}`,
          {
            dataset: { id: it.id, ri: String(ri) },
            style: { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h), '--hue': String((k * 47) % 360) },
          },
          h('span.box-label', `${it.number}${cont ? ' (이어짐)' : ''}${it.page !== st.page ? ` · ${pageLabel(d, it.page)}` : ''}`),
        );
        if (isSel && st.selected.rect === ri) {
          for (const hd of ['nw', 'ne', 'sw', 'se']) box.append(h(`div.handle.h-${hd}`, { dataset: { handle: hd } }));
        }
        overlay.append(box);
      });
    });
  }

  const pct = (v) => `${(v * 100).toFixed(3)}%`;

  // ------------------------------------------------------------------
  // 마우스 조작
  let drag = null;
  const norm = (e) => {
    const b = overlay.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) };
  };

  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const d = doc();
    if (!d) return;
    const p = norm(e);
    const handleEl = e.target.closest('.handle');
    const boxEl = e.target.closest('.box');
    if (st.mode === 'select' && (handleEl || boxEl)) {
      const id = boxEl.dataset.id;
      const ri = Number(boxEl.dataset.ri);
      const it = d.items.find((x) => x.id === id);
      if (!it) return;
      const changedSel = !st.selected || st.selected.id !== id || st.selected.rect !== ri;
      st.selected = { id, rect: ri };
      drag = { kind: handleEl ? 'resize' : 'move', handle: handleEl?.dataset.handle, it, ri, start: p, orig: { ...it.rects[ri] }, moved: false };
      overlay.setPointerCapture(e.pointerId);
      if (changedSel) {
        renderOverlay();
        renderToolbar();
        ctx.onSelect?.(st.role, id);
      }
      e.preventDefault();
      return;
    }
    if (st.mode === 'draw' || (st.mode === 'addRect' && selectedItem())) {
      drag = { kind: 'draw', start: p, ghost: h('div.box.ghost') };
      overlay.append(drag.ghost);
      overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    // 빈 곳 클릭 → 선택 해제
    if (st.selected) {
      st.selected = null;
      renderOverlay();
      renderToolbar();
    }
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = norm(e);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.002) drag.moved = true;
    if (drag.kind === 'draw') {
      const r = rectFrom(drag.start, p);
      Object.assign(drag.ghost.style, { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });
      return;
    }
    const r = drag.it.rects[drag.ri];
    const o = drag.orig;
    if (drag.kind === 'move') {
      r.x = clamp(o.x + dx, 0, 1 - o.w);
      r.y = clamp(o.y + dy, 0, 1 - o.h);
    } else {
      let x0 = o.x;
      let y0 = o.y;
      let x1 = o.x + o.w;
      let y1 = o.y + o.h;
      if (drag.handle.includes('w')) x0 = clamp(o.x + dx, 0, x1 - 0.01);
      if (drag.handle.includes('e')) x1 = clamp(o.x + o.w + dx, x0 + 0.01, 1);
      if (drag.handle.includes('n')) y0 = clamp(o.y + dy, 0, y1 - 0.005);
      if (drag.handle.includes('s')) y1 = clamp(o.y + o.h + dy, y0 + 0.005, 1);
      Object.assign(r, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    const boxEl = overlay.querySelector(`.box[data-id="${CSS.escape(drag.it.id)}"][data-ri="${drag.ri}"]`);
    if (boxEl) Object.assign(boxEl.style, { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });
  });

  const endDrag = (e) => {
    if (!drag) return;
    const dg = drag;
    drag = null;
    try {
      overlay.releasePointerCapture(e.pointerId);
    } catch {
      /* 무시 */
    }
    if (dg.kind === 'draw') {
      dg.ghost.remove();
      const r = rectFrom(dg.start, norm(e));
      if (r.w < 0.015 || r.h < 0.008) return;
      const d = doc();
      if (st.mode === 'addRect' && selectedItem()) {
        const it = selectedItem();
        it.rects.push({ page: st.page, ...r });
        it.source = 'manual';
        st.selected = { id: it.id, rect: it.rects.length - 1 };
        setMode('select', false);
        commit();
        return;
      }
      const guess = guessNumber(d, st.page, r);
      const item = { page: st.page, col: r.x + r.w / 2 > 0.5 && r.w < 0.6 ? 1 : 0, number: String(guess), num: guess, rects: [{ page: st.page, ...r }], source: 'manual', conf: 100, id: `new-${Date.now()}` };
      d.items.push(item);
      st.pendingFocus = true;
      commit(item);
      return;
    }
    if (dg.moved) {
      dg.it.source = 'manual';
      commit();
    }
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  function rectFrom(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function guessNumber(d, page, rect) {
    const sorted = sortItems(d.items || []);
    let prev = null;
    for (const it of sorted) {
      const r0 = it.rects[0];
      if (it.page < page || (it.page === page && (r0.x < rect.x - 0.2 || (Math.abs(r0.x - rect.x) <= 0.2 && r0.y < rect.y)))) prev = it;
    }
    return prev ? prev.num + 1 : 1;
  }

  function deleteSelected() {
    const it = selectedItem();
    if (!it) return;
    const d = doc();
    const ri = st.selected.rect;
    if (it.rects.length > 1) {
      it.rects.splice(ri, 1);
      it.source = 'manual';
    } else {
      d.items = d.items.filter((x) => x !== it);
    }
    st.selected = null;
    commit();
  }

  function commit(newItem) {
    const d = doc();
    if (d) {
      d.edited = true;
      if (d.pageInfo?.[st.page]) {
        d.pageInfo[st.page].flags = [];
      }
    }
    const newId = ctx.onItemsChanged(st.role, newItem || selectedItem());
    if (newId) st.selected = { id: newId, rect: st.selected?.rect ?? 0 };
    if (newItem) {
      st.selected = { id: newItem.id, rect: 0 };
      setMode('select', false);
    }
    refresh();
    if (st.pendingFocus) {
      st.pendingFocus = false;
      const input = toolbar.querySelector('.input-num');
      input?.focus();
      input?.select();
    }
  }

  function setMode(mode, rerender = true) {
    st.mode = mode;
    if (rerender) {
      renderToolbar();
      renderHint();
      renderOverlay();
    }
  }

  function setZoom(z) {
    st.zoom = clamp(z, 0.4, 4);
    renderToolbar();
    renderCanvas();
  }

  function go(delta) {
    const s = src();
    if (!s) return;
    const next = clamp(st.page + delta, 0, s.numPages - 1);
    if (next !== st.page) show(st.role, next);
  }

  // 키보드
  document.addEventListener('keydown', (e) => {
    if (!el.isConnected || el.offsetParent === null) return;
    if (e.target.closest('input, textarea, select')) return;
    if (document.querySelector('.modal-overlay')) return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      go(-1);
      e.preventDefault();
    } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      go(1);
      e.preventDefault();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      deleteSelected();
      e.preventDefault();
    } else if (e.key === 'Escape') {
      if (st.mode !== 'select') setMode('select');
      else if (st.selected) {
        st.selected = null;
        refresh();
      }
    }
  });

  const onResize = debounce(() => {
    if (el.isConnected && el.offsetParent !== null) renderCanvas();
  }, 150);
  window.addEventListener('resize', onResize);

  // ------------------------------------------------------------------
  function refresh() {
    renderSide();
    renderToolbar();
    renderHint();
    renderOverlay();
  }

  function show(role, page, itemId) {
    const roleChanged = role && role !== st.role;
    if (role) st.role = role;
    const s = src();
    if (!s) {
      refresh();
      return;
    }
    const newPage = clamp(page ?? st.page, 0, s.numPages - 1);
    const pageChanged = newPage !== st.page || roleChanged;
    st.page = newPage;
    if (itemId) st.selected = { id: itemId, rect: 0 };
    else if (pageChanged && st.mode !== 'addRect') st.selected = null;
    refresh();
    if (pageChanged || !canvas.width) renderCanvas();
  }

  return {
    el,
    show,
    refresh,
    redraw: () => {
      refresh();
      renderCanvas();
    },
    get role() {
      return st.role;
    },
    get page() {
      return st.page;
    },
    reset() {
      st.selected = null;
      st.mode = 'select';
      st.page = 0;
      st.role = 'problem';
      canvas.width = 0;
    },
    notify: (msg) => toast(msg),
  };
}
