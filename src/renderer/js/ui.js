import { ICONS } from './icons.js';

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
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, String(val));
        else el.style[prop] = val;
      }
    }
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
    h('button.toast-close', { onclick: () => close(), title: '닫기' }, icon('x')),
  );
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  toastRoot.append(el);
  // 너무 많이 쌓이지 않게 오래된 것부터 정리
  const all = toastRoot.querySelectorAll('.toast:not(.leaving)');
  for (let i = 0; i < all.length - 4; i++) all[i].remove();
  if (timeout) setTimeout(close, timeout);
  return close;
}

// ---------------------------------------------------------------------------
// 모달
// ---------------------------------------------------------------------------
export function modal({ title, body, buttons = [], width = 460, onClose, className = '' }) {
  return new Promise((resolve) => {
    let closed = false;
    const close = (value) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.add('closing');
      const done = () => overlay.remove();
      overlay.addEventListener('animationend', done, { once: true });
      setTimeout(done, 300);
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
    const dialog = h(`div.modal${className ? `.${className}` : ''}`, { style: { width: `${width}px` } }, h('div.modal-header', h('h3', title), h('button.modal-x', { onclick: () => close(null), title: '닫기' }, icon('x'))), h('div.modal-body', body), buttons.length ? footer : null);
    const overlay = h('div.modal-overlay', { onmousedown: (e) => e.target === overlay && close(null) }, dialog);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    const first = dialog.querySelector('input, select, textarea');
    (first || footer.querySelector('.btn-primary'))?.focus();
    dialog.close = close;
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
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/** 앱 로고 (build/icon.svg 와 같은 모양) */
export function logo(cls = 'brand-logo') {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg class="${cls}" viewBox="0 0 1024 1024" aria-hidden="true"><defs><linearGradient id="lg-bg" x1=".1" y1="0" x2=".9" y2="1"><stop offset="0" stop-color="#FFB443"/><stop offset=".5" stop-color="#FF7A1A"/><stop offset="1" stop-color="#EE4B1C"/></linearGradient><linearGradient id="lg-ink" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF8A2A"/><stop offset="1" stop-color="#E8431A"/></linearGradient></defs><path d="M512 56c214 0 300 0 378 78s78 164 78 378 0 300-78 378-164 78-378 78-300 0-378-78S56 726 56 512s0-300 78-378S298 56 512 56z" fill="url(#lg-bg)"/><g transform="rotate(-7 512 540)"><path d="M330 232h262l150 150v378a48 48 0 0 1-48 48H330a48 48 0 0 1-48-48V280a48 48 0 0 1 48-48z" fill="#fff"/><path d="M592 232v102a48 48 0 0 0 48 48h102z" fill="#FFD6B3"/><rect x="350" y="330" width="170" height="30" rx="15" fill="#FFD0A8"/><rect x="350" y="404" width="128" height="30" rx="15" fill="#FFE1C7"/><path d="M384 604l84 84 176-206" fill="none" stroke="url(#lg-ink)" stroke-width="64" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
  return wrap.firstChild;
}

/** 설정에서 "애니메이션 줄이기"를 고른 경우만 (윈도우의 애니메이션 끄기 설정과는 상관없이 기본은 켬) */
export const reduceMotion = () => document.documentElement.dataset.motion === 'reduce';

/** 숫자가 0 에서 목표까지 부드럽게 올라가는 효과 */
export function countUp(el, to, { ms = 650, suffix = '' } = {}) {
  const target = Number(to) || 0;
  if (reduceMotion() || target <= 0) {
    el.textContent = `${target}${suffix}`;
    return el;
  }
  const t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = `${Math.round(target * eased)}${suffix}`;
    if (k < 1 && el.isConnected) requestAnimationFrame(tick);
  };
  el.textContent = `0${suffix}`;
  requestAnimationFrame(tick);
  return el;
}

/** 버튼 같은 곳을 누른 자리에서 퍼지는 물결 */
export function ripple(e) {
  const el = e.currentTarget;
  if (!el || reduceMotion() || el.disabled) return;
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 1.6;
  const dot = document.createElement('span');
  dot.className = 'ripple';
  dot.style.width = dot.style.height = `${size}px`;
  dot.style.left = `${e.clientX - r.left - size / 2}px`;
  dot.style.top = `${e.clientY - r.top - size / 2}px`;
  el.append(dot);
  setTimeout(() => dot.remove(), 600);
}

/**
 * 화면이 바뀌기 전에 나가는 애니메이션을 재생하고 끝나면 resolve.
 * (브라우저 View Transitions 대신 CSS 클래스로 직접 구현 — 어떤 그래픽 환경에서도 안정적)
 */
export function animateOut(el, cls, maxMs = 320) {
  if (!el || reduceMotion()) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    el.addEventListener('animationend', (e) => e.target === el && finish());
    setTimeout(finish, maxMs);
    el.classList.add(cls);
  });
}
