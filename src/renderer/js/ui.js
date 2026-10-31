// 작은 DOM 도우미들 (프레임워크 없이)

/**
 * h('div.card#id', {onclick, title, ...}, children...)
 */
export function h(tag, attrs, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ---------------------------------------------------------------------------
// 토스트
// ---------------------------------------------------------------------------
let toastRoot = null;
export function toast(message, { type = 'info', timeout = 3500, actions = [] } = {}) {
  if (!toastRoot) {
    toastRoot = h('div.toasts');
    document.body.append(toastRoot);
  }
  const el = h(
    `div.toast.toast-${type}`,
    h('div.toast-msg', message),
    actions.length
      ? h(
          'div.toast-actions',
          actions.map((a) =>
            h('button.btn.btn-small', { onclick: () => { a.onClick(); close(); } }, a.label),
          ),
        )
      : null,
    h('button.toast-close', { onclick: () => close(), title: '닫기' }, '×'),
  );
  const close = () => el.remove();
  toastRoot.append(el);
  // 너무 많이 쌓이지 않게 오래된 것부터 정리
  const all = toastRoot.querySelectorAll('.toast');
  for (let i = 0; i < all.length - 4; i++) all[i].remove();
  if (timeout) setTimeout(close, timeout);
  return close;
}

// ---------------------------------------------------------------------------
// 모달
// ---------------------------------------------------------------------------
export function modal({ title, body, buttons = [], width = 460, onClose }) {
  return new Promise((resolve) => {
    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      onClose?.(value);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      }
    };
    const footer = h(
      'div.modal-footer',
      buttons.map((b) =>
        h(
          `button.btn${b.primary ? '.btn-primary' : ''}${b.danger ? '.btn-danger' : ''}`,
          {
            onclick: async () => {
              if (b.onClick) {
                const r = await b.onClick();
                if (r === false) return;
                close(r === undefined ? b.value : r);
              } else close(b.value);
            },
          },
          b.label,
        ),
      ),
    );
    const dialog = h('div.modal', { style: { width: `${width}px` } }, h('div.modal-header', h('h3', title), h('button.modal-x', { onclick: () => close(null) }, '×')), h('div.modal-body', body), buttons.length ? footer : null);
    const overlay = h('div.modal-overlay', { onmousedown: (e) => e.target === overlay && close(null) }, dialog);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    const first = dialog.querySelector('input, select, textarea');
    (first || footer.querySelector('.btn-primary'))?.focus();
  });
}

export async function confirmDialog(message, { title = '확인', ok = '확인', danger = false } = {}) {
  const r = await modal({
    title,
    body: h('p.modal-text', message),
    buttons: [
      { label: '취소', value: false },
      { label: ok, value: true, primary: !danger, danger },
    ],
  });
  return r === true;
}

export async function promptDialog(message, { title = '입력', value = '', placeholder = '', ok = '확인' } = {}) {
  const input = h('input.input', { value, placeholder });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.closest('.modal').querySelector('.btn-primary').click();
  });
  const r = await modal({
    title,
    body: h('div', h('p.modal-text', message), input),
    buttons: [
      { label: '취소', value: null },
      { label: ok, primary: true, onClick: () => input.value },
    ],
  });
  return r;
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function icon(name) {
  const paths = {
    back: 'M15 18l-6-6 6-6',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-2-1.2L14.5 2h-4l-.4 2.6a7.3 7.3 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.3 7.3 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
    plus: 'M12 5v14M5 12h14',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
    download: 'M12 3v12m0 0l-5-5m5 5l5-5M4 21h16',
    trash: 'M3 6h18M8 6V4h8v2m-9 0l1 14h8l1-14',
    left: 'M15 18l-6-6 6-6',
    right: 'M9 18l6-6-6-6',
    scan: 'M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 12h10',
    sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
    box: 'M4 4h16v16H4z',
    warn: 'M12 3l10 18H2zM12 10v5M12 18v.5',
    check: 'M5 12l5 5 9-11',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name] || '');
  svg.append(path);
  return svg;
}
