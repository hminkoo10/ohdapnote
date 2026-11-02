// "페이지 검토" 편집기: 인식된 문항 영역을 페이지 위에 표시하고 고칠 수 있게 합니다.
//  - 상자 클릭: 선택 / 드래그: 이동 / 모서리: 크기 조절
//  - [문항 추가] 모드에서 빈 곳을 드래그: 새 문항
//  - [영역 추가] 모드: 선택한 문항에 영역(다음 단/쪽으로 이어지는 부분) 추가
//  - Delete: 선택한 영역(또는 문항) 삭제
//  - 점선 번호(인식은 했지만 고르지 않은 후보)를 누르면 그 자리에 문항 추가

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
            `button${st.role === role ? '.active' : ''}${role === 'answer' ? '.teal' : ''}`,
            { disabled: !p?.docs?.[role], onclick: () => show(role, firstPage(role)) },
            ROLE_NAME[role],
          ),
        ),
      ),
    );
    const d = doc();
    const s = src();
    if (!d || !s) {
      side.append(h('p.muted.small', '파일이 없어요.'));
      return;
    }
    const flaggedCount = Object.values(d.pageInfo || {}).filter((pi) => pi.flags?.length && !pi.ok).length;
    const missing = ctx.missing?.(st.role) || new Map();
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
      const miss = missing.get(i)?.length || 0;
      const flagged = (info?.flags?.length > 0 && !info.ok) || miss > 0;
      if (st.onlyFlagged && !flagged) continue;
      const n = byPage.get(i)?.length || 0;
      const why = [...(info?.ok ? [] : info?.flags || []), ...(miss ? [`빠진 번호 ${miss}개`] : [])];
      const row = h(
        `button.page-row${i === st.page ? '.active' : ''}${flagged ? '.flagged' : ''}${info?.analyzed ? '' : '.unanalyzed'}`,
        { onclick: () => show(st.role, i), title: why.join(', ') },
        h('span.pr-page', pageLabel(d, i)),
        h('span.pr-count', info?.analyzed ? `${n}개` : '–'),
        miss ? h('span.pr-miss', `?${miss}`) : null,
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
    const flagged = Object.entries(d.pageInfo || {}).find(([, v]) => v.flags?.length && !v.ok);
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
        h(`button.btn.btn-small${st.mode === 'draw' ? '.btn-active' : ''}`, { onclick: () => setMode(st.mode === 'draw' ? 'select' : 'draw'), title: '빈 곳을 드래그해서 새 문항 영역을 그립니다' }, icon('plus'), '문항 추가'),
        h(`button.btn.btn-small${st.mode === 'addRect' ? '.btn-active' : ''}`, { onclick: () => setMode(st.mode === 'addRect' ? 'select' : 'addRect'), disabled: !it, title: '선택한 문항에 영역을 하나 더 그립니다 (다음 단·쪽으로 이어지는 부분)' }, icon('box'), '영역 추가'),
        h('button.btn.btn-small', { onclick: deleteSelected, disabled: !it, title: '선택한 영역 삭제 (Delete)' }, icon('trash'), '삭제'),
        h('label.tb-num', '번호', numInput),
      ),
      h('div.tb-group.tb-right',
        h('button.btn.btn-small', { onclick: () => ctx.reanalyzePage(st.role, st.page), title: '이 쪽만 고해상도로 한 번 더, 앞뒤 쪽 번호에 맞춰 꼼꼼히 다시 찾아요 (이 쪽에서 직접 고친 내용은 바뀔 수 있어요)' }, icon('search'), '꼼꼼히 다시 찾기'),
        h('button.btn.btn-small', { onclick: () => ctx.geminiPage(st.role, st.page), title: 'AI 로 이 쪽을 인식합니다 (설정에서 AI 키 필요)' }, icon('sparkle'), 'AI'),
        h('button.btn.btn-icon.btn-ghost', { title: '축소', onclick: () => setZoom(st.zoom / 1.2) }, icon('zoomOut')),
        h('span.muted.small.tb-zoom', `${Math.round(st.zoom * 100)}%`),
        h('button.btn.btn-icon.btn-ghost', { title: '확대', onclick: () => setZoom(st.zoom * 1.2) }, icon('zoomIn')),
      ),
    );
  }

  function renderHint() {
    clear(hint);
    const d = doc();
    if (!d) return;
    const info = d.pageInfo?.[st.page];
    const parts = [];
    if (!info?.analyzed) parts.push(h('span', '이 쪽은 아직 분석 전이에요.'));
    else {
      const src = { text: 'PDF 글자', ocr: 'OCR(스캔 인식)', gemini: 'AI', manual: '직접 편집' }[info.source] || info.source;
      parts.push(h('span.muted', `인식 방법: ${src}`));
      const miss = ctx.missing?.(st.role)?.get(st.page) || [];
      const why = [...(info.ok ? [] : info.flags || []), ...(miss.length ? [`빠진 번호 ${miss.map((m) => m.num).join(', ')}`] : [])];
      if (why.length) {
        parts.push(h('span.warn-text', icon('warn'), `확인 필요: ${why.join(', ')}`));
        if (ctx.onDismiss) {
          parts.push(
            h('button.btn.btn-small.btn-ok', {
              onclick: () => {
                ctx.onDismiss(st.role, st.page);
                refresh();
              },
              title: '이 쪽은 이대로 괜찮아요 (확인 표시 지우기)',
            }, icon('check'), '문제없음'),
          );
        }
      } else if (info.ok && info.flags?.length) parts.push(h('span.ok-text', icon('circleCheck'), '확인함'));
      if (why.length && ghostCands().length) parts.push(h('span.muted', '점선 번호를 누르면 그 자리에 문항이 추가돼요.'));
    }
    const modeHint = {
      select: '상자를 눌러 고르고, 끌어서 옮기거나 모서리로 크기를 바꿀 수 있어요.',
      draw: '빈 곳을 드래그해서 새 문항 영역을 그리고, 번호를 입력해 주세요.',
      addRect: '선택한 문항에 이어지는 영역을 드래그해서 그리세요. (다른 쪽으로 넘어가도 됩니다)',
    }[st.mode];
    parts.push(h('span.muted', modeHint));
    hint.append(...parts);
  }

  // ------------------------------------------------------------------
  async function renderCanvas(dir = null) {
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
    if (dir) {
      wrap.classList.remove('enter-next', 'enter-prev');
      void wrap.offsetWidth; // 애니메이션 다시 시작
      wrap.classList.add(dir === 'prev' ? 'enter-prev' : 'enter-next');
      overlay.classList.add('fresh');
      clearTimeout(st.freshTimer);
      st.freshTimer = setTimeout(() => overlay.classList.remove('fresh'), 900);
    }
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
            style: { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h), '--hue': String(HUES[k % HUES.length]), '--i': String(Math.min(k, 20)) },
          },
          h('span.box-label', `${it.prefix ? `${it.prefix} ` : ''}${it.number}${cont ? ' (이어짐)' : ''}${it.page !== st.page ? ` · ${pageLabel(d, it.page)}` : ''}`),
        );
        if (isSel && st.selected.rect === ri) {
          for (const hd of ['nw', 'ne', 'sw', 'se']) box.append(h(`div.handle.h-${hd}`, { dataset: { handle: hd } }));
        }
        overlay.append(box);
      });
    });
    if (st.mode !== 'select') return;
    const missing = new Set((ctx.missing?.(st.role)?.get(st.page) || []).map((m) => `${m.prefix}|${m.num}`));
    // 확인이 필요한 쪽에서만 후보를 보여 줌 (빠진 번호와 같은 후보는 눈에 띄게)
    const info = d.pageInfo?.[st.page];
    const needsCheck = missing.size > 0 || (info?.flags?.length > 0 && !info.ok);
    if (!needsCheck) return;
    ghostCands().forEach((c, k) => {
      const want = missing.has(`${c.prefix || ''}|${c.num}`);
      overlay.append(
        h(
          `button.cand${want ? '.want' : ''}`,
          {
            title: `${c.prefix ? `${c.prefix} ` : ''}${c.digits}번으로 문항 추가`,
            style: { left: pct(c.x0 - 0.004), top: pct(c.y0 - 0.003), width: pct(c.x1 - c.x0 + 0.008), height: pct(c.y1 - c.y0 + 0.006), '--i': String(Math.min(k, 20)) },
            onpointerdown: (e) => e.stopPropagation(),
            onclick: (e) => {
              e.stopPropagation();
              addFromCandidate(c);
            },
          },
          h('span.cand-label', '+', c.digits),
        ),
      );
    });
  }

  /** 아직 문항이 아닌 번호 후보 (이미 그 자리에 문항이 있으면 뺌) */
  function ghostCands() {
    const d = doc();
    const info = d?.pageInfo?.[st.page];
    if (!info?.cands?.length) return [];
    const rects = (d.items || []).filter((it) => it.page === st.page).map((it) => it.rects[0]);
    return info.cands
      .filter((c) => !rects.some((r) => r.page === st.page && c.y0 >= r.y - 0.006 && c.y0 <= r.y + 0.025 && c.x0 < r.x + r.w && c.x1 > r.x))
      .slice(0, 40);
  }

  /** 후보 번호 자리에서 시작하는 문항 만들기: 위 문항이 그 자리를 덮고 있으면 거기서 끊음 */
  function addFromCandidate(c) {
    const d = doc();
    const info = d.pageInfo?.[st.page] || {};
    const cols = info.cols?.length ? info.cols : [{ x0: 0.05, x1: 0.95 }];
    const col = cols[Math.min(cols.length - 1, Math.max(0, c.col ?? 0))] || cols[0];
    const bodyBottom = info.body?.[1] ?? 0.95;
    const x0 = Math.max(0, Math.min(col.x0, c.x0 - 0.004));
    const x1 = Math.max(x0 + 0.05, col.x1);
    const y0 = Math.max(0, c.y0 - 0.006);
    let y1 = bodyBottom;
    for (const it of d.items || []) {
      for (const r of it.rects) {
        if (r.page !== st.page || !(r.x < x1 && r.x + r.w > x0)) continue;
        if (r.y < y0 && r.y + r.h > y0) {
          // 위 문항이 이 번호를 덮고 있음 → 그 문항을 여기서 끊고, 남은 아래는 새 문항으로
          y1 = Math.min(bodyBottom, r.y + r.h);
          r.h = Math.max(0.01, y0 - 0.004 - r.y);
          it.source = 'manual';
        } else if (r.y >= y0 + 0.004) {
          y1 = Math.min(y1, r.y - 0.004);
        }
      }
    }
    const num = parseInt(c.digits, 10);
    const item = {
      page: st.page,
      zone: 0,
      col: c.col ?? 0,
      number: String(c.digits),
      num,
      prefix: c.prefix || undefined,
      rects: [{ page: st.page, x: x0, y: y0, w: x1 - x0, h: Math.max(0.02, y1 - y0) }],
      source: 'manual',
      conf: 100,
      id: `new-${Date.now()}`,
    };
    const above = (d.items || []).filter((x) => x.page === st.page && x.rects[0].y <= y0);
    item.zone = above.length ? Math.max(...above.map((x) => x.zone ?? 0)) : 0;
    if (!item.prefix) delete item.prefix;
    d.items.push(item);
    commit(item);
    toast(`${c.prefix ? `${c.prefix} ` : ''}${c.digits}번을 추가했어요. 영역이 맞는지 확인해 주세요.`);
  }

  const pct = (v) => `${(v * 100).toFixed(3)}%`;
  // 따뜻한 계열 위주로 번갈아 쓰는 상자 색
  const HUES = [22, 196, 340, 38, 172, 8, 262];

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
      // 같은 쪽에서 이 상자보다 위에 있는 문항의 구역(전체 폭 제목으로 나뉜 영역)을 따름
      const above = (d.items || []).filter((x) => x.page === st.page && x.rects[0].y <= r.y);
      const zone = above.length ? Math.max(...above.map((x) => x.zone ?? 0)) : 0;
      const item = { page: st.page, zone, col: r.x + r.w / 2 > 0.5 && r.w < 0.6 ? 1 : 0, number: String(guess), num: guess, rects: [{ page: st.page, ...r }], source: 'manual', conf: 100, id: `new-${Date.now()}` };
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
      ctx.onItemDeleted?.(st.role, it);
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
    const dir = newPage < st.page ? 'prev' : 'next';
    st.page = newPage;
    if (itemId) st.selected = { id: itemId, rect: 0 };
    else if (pageChanged && st.mode !== 'addRect') st.selected = null;
    refresh();
    if (pageChanged || !canvas.width) renderCanvas(dir);
  }

  return {
    el,
    show,
    refresh,
    redraw: () => {
      refresh();
      renderCanvas('next');
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
