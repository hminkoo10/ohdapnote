// Pix2Text(MFR) 가 내는 LaTeX → hwpeq.js(latexToHwpEq) 가 잘 읽는 보통 LaTeX (DOM 없는 순수 함수)
//  - 띄어 쓴 글자·숫자 붙이기: \operatorname{l o g} → \log, 1 0 0 0 → 1000, 0 . 2 5 → 0.25
//  - 모양만 다른 표기 맞추기: \underset{k=1}{\overset{10}{\sum}} → \sum_{k=1}^{10}, \root 5 \of{x} → \sqrt[5]{x},
//    {=} → =, {x_{i}}^{2} → x_{i}^{2}, \tan{(x)} → \tan(x), 한 칸짜리 \begin{array}{l}…\end{array} 풀기
//  - 띄움·글씨 크기 명령 지우기: \! \, \: \; \ , \scriptstyle 등 (한글 수식이 알아서 띄움)
//  - 괄호: 안에 분수·합 같은 큰 것이 있으면 \left( … \right) (한글 LEFT/RIGHT), 아니면 그냥 ( … )
//  - 크롭 가장자리에 걸린 찌꺼기 지우기: 끝의 \circ…(한글 '이/의'), ②, 짝 없는 ), 마침표, 앞의 문제 번호(0125)

const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힯]/;

// 띄움·글씨 크기 명령: 지움
const DROP_CMDS = new Set(['!', ',', ':', ';', ' ', 'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle']);

// LaTeX 에 있는 함수 이름 (\operatorname{l o g} → \log)
const FUNCS = new Set([
  'arccos', 'arcsin', 'arctan', 'arg', 'cos', 'cosh', 'cot', 'coth', 'csc', 'deg', 'det', 'dim', 'exp', 'gcd', 'hom', 'inf', 'ker', 'lg', 'lim',
  'liminf', 'limsup', 'ln', 'log', 'max', 'min', 'Pr', 'sec', 'sin', 'sinh', 'sup', 'tan', 'tanh',
]);

// 아래위 한계가 붙는 연산자 (\underset{A}{\overset{B}{\sum}} → \sum_{A}^{B})
const LIMIT_OPS = new Set(['sum', 'prod', 'coprod', 'int', 'iint', 'iiint', 'oint', 'bigcup', 'bigcap', 'bigoplus', 'bigotimes', 'bigvee', 'bigwedge', 'lim', 'max', 'min', 'sup', 'inf', 'limsup', 'liminf']);

// 안의 { } 를 글자 그대로 두는 명령 (hwpeq 의 TEXT_CMDS 와 같음)
const TEXT_CMDS = new Set(['text', 'textrm', 'textup', 'textnormal', 'textbf', 'textit', 'textsf', 'texttt', 'mbox', 'hbox', 'mathrm', 'operatorname']);

// 인자 수
const ARITY = {
  frac: 2, dfrac: 2, tfrac: 2, cfrac: 2, binom: 2, dbinom: 2, tbinom: 2, overset: 2, underset: 2, stackrel: 2, textcolor: 2, sqrt: 1,
  overline: 1, underline: 1, bar: 1, vec: 1, hat: 1, widehat: 1, tilde: 1, widetilde: 1, dot: 1, ddot: 1, check: 1, acute: 1, grave: 1, breve: 1,
  overrightarrow: 1, overleftarrow: 1, overleftrightarrow: 1, overarc: 1, wideparen: 1, overgroup: 1, overbrace: 1, underbrace: 1, cancel: 1,
  mathbf: 1, boldsymbol: 1, bm: 1, mathit: 1, mathsf: 1, mathbb: 1, mathcal: 1, mathscr: 1, mathfrak: 1, mathtt: 1, boxed: 1, pmb: 1,
  label: 1, tag: 1, color: 1, phantom: 1, hphantom: 1, vphantom: 1, hspace: 1, vspace: 1, pmod: 1, textcircled: 1, end: 1,
};

// 인자가 없는 명령: 바로 뒤의 { } 는 그냥 묶음 (\cos{\frac{n\pi}{4}} → \cos\frac{n\pi}{4})
const ZERO = new Set([
  ...FUNCS, ...LIMIT_OPS, 'mod', 'bmod',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi',
  'omicron', 'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta',
  'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
  'times', 'div', 'cdot', 'circ', 'ast', 'star', 'bullet', 'pm', 'mp', 'le', 'leq', 'leqq', 'leqslant', 'ge', 'geq', 'geqq', 'geqslant', 'ne', 'neq',
  'lt', 'gt', 'approx', 'sim', 'simeq', 'equiv', 'cong', 'propto', 'doteq', 'll', 'gg', 'to', 'rightarrow', 'longrightarrow', 'mapsto', 'leftarrow',
  'gets', 'longleftarrow', 'leftrightarrow', 'longleftrightarrow', 'Rightarrow', 'Longrightarrow', 'implies', 'Leftarrow', 'Longleftarrow',
  'impliedby', 'Leftrightarrow', 'Longleftrightarrow', 'iff', 'uparrow', 'downarrow', 'cdots', 'ldots', 'dots', 'dotsc', 'dotsb', 'vdots', 'ddots',
  'infty', 'angle', 'measuredangle', 'triangle', 'therefore', 'because', 'in', 'notin', 'ni', 'owns', 'subset', 'supset', 'subseteq', 'supseteq',
  'subsetneq', 'supsetneq', 'nsubseteq', 'nsupseteq', 'cup', 'cap', 'setminus', 'emptyset', 'varnothing', 'forall', 'exists', 'nexists', 'neg',
  'lnot', 'land', 'wedge', 'lor', 'vee', 'perp', 'parallel', 'nparallel', 'mid', 'nmid', 'vert', 'lvert', 'rvert', 'Vert', 'lVert', 'rVert',
  'partial', 'nabla', 'hbar', 'ell', 'aleph', 'square', 'Box', 'blacksquare', 'diamond', 'checkmark', 'oplus', 'otimes', 'odot', 'ominus',
  'dagger', 'lbrace', 'rbrace', 'langle', 'rangle', 'lfloor', 'rfloor', 'lceil', 'rceil', 'colon', 'prime', 'degree', 'backslash',
  'quad', 'qquad', 'enspace', 'thinspace', 'limits', 'nolimits', 'cr', 'newline', 'hline',
  '{', '}', '|', '%', '$', '#', '&', '_', '\\',
]);

// 다음 낱말 하나를 괄호로 받는 명령
const BIG = new Set(['big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr', 'bigm', 'Bigm']);
const DELIM_CMDS = new Set(['left', 'right', 'middle', ...BIG]);
const OPEN_DELIMS = new Set(['(', '[', '\\{', '\\langle', '\\lfloor', '\\lceil', '\\lbrace']);
const CLOSE_DELIMS = new Set([')', ']', '\\}', '\\rangle', '\\rfloor', '\\rceil', '\\rbrace']);

// 이것이 들어 있으면 괄호를 \left … \right (한글 LEFT … RIGHT) 로 키움
const TALL = new Set(['frac', 'dfrac', 'tfrac', 'cfrac', 'binom', 'dbinom', 'tbinom', 'sum', 'prod', 'coprod', 'int', 'iint', 'iiint', 'oint', 'bigcup', 'bigcap', 'begin', 'over', 'atop', 'choose']);
const INFIX = new Set(['over', 'atop', 'choose']);

// 열 지정 { } 를 하나 더 받는 환경
const SPEC_ENVS = new Set(['array', 'subarray', 'alignat', 'alignat*', 'alignedat']);

const CIRCLED = (ch) => {
  if (/^[1-9]$|^1[0-9]$|^20$/.test(ch)) return String.fromCodePoint(0x2460 + Number(ch) - 1);
  if (/^[a-z]$/.test(ch)) return String.fromCodePoint(0x24d0 + ch.charCodeAt(0) - 97);
  if (/^[A-Z]$/.test(ch)) return String.fromCodePoint(0x24b6 + ch.charCodeAt(0) - 65);
  return null;
};

// ---------------------------------------------------------------------------
// 크롭 가장자리 찌꺼기
// ---------------------------------------------------------------------------
const CIRCLED_CH = '[\\u2460-\\u2473\\u24b6-\\u24e9]';
const JUNK_START = `(?:\\\\circ|\\\\textcircled\\{[^{}]*\\}|${CIRCLED_CH}|\\{\\\\bmod(?:\\{\\})?\\}|\\\\bmod(?:\\{\\})?)`;
const JUNK_MORE = `(?:${JUNK_START}|\\\\parallel|\\\\\\||\\]|\\||1|\\s)`;
// 끝의 \circ 로 시작하는 찌꺼기 (x^\circ, x^{\circ} 같은 각도는 빼고)
const TRAIL_JUNK_RE = new RegExp(`(?<![\\^_]\\s*\\{?\\s*)${JUNK_START}${JUNK_MORE}*$`);
// 앞의 문제 번호: 0 으로 시작하는 네 자리(0125), 또는 네 자리 뒤에 ⋯② 같은 표시
const NUM_SEP = '(?:\\\\textrm\\{\\\\\\}|\\\\cdots?|\\\\textcircled\\{[^{}]*\\}|\\.|\\s)';
const LEAD_NUM_RE = new RegExp(`^\\s*(?:0\\s*(?:\\d\\s*){3}|(?:\\d\\s*){4}(?=(?:\\\\cdots?\\s*)?(?:\\\\textrm\\{\\\\\\}|\\\\textcircled|\\\\cdots)))${NUM_SEP}*`);

function stripJunk(s) {
  for (let i = 0; i < 10; i++) {
    let t = s.replace(LEAD_NUM_RE, '').replace(TRAIL_JUNK_RE, '').trim();
    t = t.replace(/(?<!\\|\\(?:right|middle|[bB]igg?r?)\s*)\s*\.\s*$/, ''); // 끝의 마침표 (\right. 은 둠)
    const open = (t.match(/\(/g) || []).length;
    const close = (t.match(/\)/g) || []).length;
    if (close > open && t.endsWith(')') && !t.endsWith('\\)')) t = t.slice(0, -1); // 짝 없는 끝 )
    t = t.trim();
    if (t === s) break;
    s = t;
  }
  return s;
}

// ---------------------------------------------------------------------------
// 1) 글자 단계: 띄움 명령 지우기, \operatorname · \mathrm · \root
// ---------------------------------------------------------------------------

/** s[from] 이 '{' 일 때 짝이 되는 '}' 까지 [내용, 다음 위치] (짝이 없으면 끝까지) */
function readBraced(s, from) {
  let depth = 0;
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') {
      j++;
      continue;
    }
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return [s.slice(from + 1, j), j + 1];
  }
  return [s.slice(from + 1), s.length];
}

const skipSpaces = (s, j) => {
  while (j < s.length && /\s/.test(s[j])) j++;
  return j;
};

function prePass(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '\\') {
      out += s[i++];
      continue;
    }
    const m = /^\\(operatorname\*|[A-Za-z]+|[\s\S]?)/.exec(s.slice(i, i + 40));
    const name = m[1];
    let j = i + m[0].length;
    if (DROP_CMDS.has(name)) {
      out += ' ';
      i = j;
      continue;
    }
    if (name === 'operatorname' || name === 'operatorname*' || name === 'mathrm') {
      const k = skipSpaces(s, j);
      if (s[k] === '{') {
        const [raw, end] = readBraced(s, k);
        const inner = raw.replace(/^[\s~]+|[\s~]+$/g, '');
        const word = inner.replace(/\s+/g, '');
        if (/^[A-Za-z]+$/.test(word)) {
          out += FUNCS.has(word) ? `\\${word} ` : `\\${name.replace('*', '')}{${word}}`;
        } else if (/[\\^_]/.test(inner)) {
          out += `{${prePass(inner)}}`; // \mathrm{~ \sum … ~} 처럼 안에 수식이 있으면 묶음으로
        } else {
          out += s.slice(i, end);
        }
        i = end;
        continue;
      }
    }
    if (name === 'root') {
      // \root 5 \of{x} → \sqrt[5]{x}
      const rest = s.slice(j);
      const of = /\\of(?![A-Za-z])/.exec(rest);
      if (of) {
        out += `\\sqrt[${rest.slice(0, of.index).trim().replace(/^\{([^{}]*)\}$/, '$1')}]`;
        i = j + of.index + of[0].length;
        continue;
      }
    }
    out += m[0];
    i = j;
  }
  return out;
}

/** \textcircled{2} → ② (찌꺼기를 지운 뒤에: 문제 번호 뒤 ⋯② 를 알아보는 데 씀) */
const circledPass = (s) =>
  s.replace(/\\textcircled\s*\{\s*([^{}]*?)\s*\}/g, (_m, inner) => CIRCLED(inner) ?? inner);

// ---------------------------------------------------------------------------
// 2) 나무 단계
//    낱말: {t:'cmd', v} (\name, \x) · {t:'ch', v} · {t:'sp'} · {t:'grp', items} · {t:'raw', v} (\text{…} 통째)
// ---------------------------------------------------------------------------

function parse(s) {
  let i = 0;
  const seq = (inGroup) => {
    const items = [];
    while (i < s.length) {
      const c = s[i];
      if (c === '}') {
        i++;
        if (inGroup) return items;
        items.push({ t: 'ch', v: '}' }); // 짝 없는 } 는 글자로
        continue;
      }
      if (c === '{') {
        i++;
        items.push({ t: 'grp', items: seq(true) });
        continue;
      }
      if (/\s/.test(c)) {
        while (i < s.length && /\s/.test(s[i])) i++;
        items.push({ t: 'sp' });
        continue;
      }
      if (c === '\\') {
        const m = /^\\([A-Za-z]+|[\s\S]?)/.exec(s.slice(i, i + 40));
        i += m[0].length;
        if (TEXT_CMDS.has(m[1])) {
          const k = skipSpaces(s, i);
          if (s[k] === '{') {
            const [, end] = readBraced(s, k);
            items.push({ t: 'raw', v: `\\${m[1]}${s.slice(k, end)}` });
            i = end;
            continue;
          }
        }
        if (m[1]) items.push({ t: 'cmd', v: m[1] });
        continue;
      }
      const ch = String.fromCodePoint(s.codePointAt(i));
      items.push({ t: 'ch', v: ch });
      i += ch.length;
    }
    return items;
  };
  return seq(false);
}

const isCh = (it, v) => it?.t === 'ch' && (v === undefined || it.v === v);
const isCmd = (it, v) => it?.t === 'cmd' && (v === undefined || it.v === v);
const isScript = (it) => isCh(it, '^') || isCh(it, '_');
const solid = (items) => items.filter((it) => it.t !== 'sp');
const grpText = (it) => (it?.t === 'grp' ? solid(it.items).map((x) => (x.t === 'ch' ? x.v : x.t === 'cmd' ? `\\${x.v}` : '?')).join('') : null);
const delimStr = (it) => (it?.t === 'ch' ? it.v : it?.t === 'cmd' ? `\\${it.v}` : '');

function containsTall(items) {
  return items.some((it) => (it.t === 'cmd' && TALL.has(it.v)) || (it.t === 'grp' && containsTall(it.items)));
}

/**
 * 어떤 낱말이 명령·첨자의 인자(또는 \left 뒤 괄호)인지 표시
 * @returns {{keep:Set<number>, incomplete:boolean}} keep: 인자인 낱말 위치, incomplete: 인자가 모자람
 */
function argInfo(items) {
  const idx = [];
  items.forEach((it, k) => it.t !== 'sp' && idx.push(k));
  const keep = new Set();
  let incomplete = false;
  let n = 0;
  const at = (q) => items[idx[q]];
  const atom = (mark) => {
    const it = at(n);
    if (mark) keep.add(idx[n]);
    n++;
    if (isScript(it)) {
      if (n < idx.length) atom(true);
      else incomplete = true;
      return;
    }
    if (it.t !== 'cmd') return;
    const v = it.v;
    if (DELIM_CMDS.has(v)) {
      if (n < idx.length) keep.add(idx[n++]);
      return;
    }
    if (v === 'sqrt' && isCh(at(n), '[')) {
      while (n < idx.length && !isCh(at(n), ']')) keep.add(idx[n++]);
      if (n < idx.length) keep.add(idx[n++]);
    }
    let need;
    if (v === 'begin') need = SPEC_ENVS.has(grpText(at(n))) ? 2 : 1;
    else if (v in ARITY) need = ARITY[v];
    else if (ZERO.has(v) || /^[^A-Za-z]$/.test(v)) need = 0;
    else need = at(n)?.t === 'grp' ? 1 : 0; // 모르는 명령: 바로 뒤 { } 는 인자로 봄
    for (; need > 0; need--) {
      if (n >= idx.length) {
        incomplete = true;
        return;
      }
      atom(true);
    }
  };
  while (n < idx.length) atom(false);
  return { keep, incomplete };
}

/** 첨자 앞 묶음을 풀어도 되는지: 밑 하나 + 겹치지 않는 첨자 (예: {x_{i}}^{2} → x_{i}^{2}) */
function singleScriptable(inner, outerScript) {
  const first = inner[0];
  if (!first || isScript(first) || isCh(first, '&')) return false;
  if (first.t === 'cmd' && !(ZERO.has(first.v) || /^[^A-Za-z]$/.test(first.v))) return false;
  const seen = new Set([outerScript]);
  for (let k = 1; k < inner.length; k += 2) {
    const op = inner[k];
    if (!isScript(op) || seen.has(op.v) || k + 1 >= inner.length) return false;
    seen.add(op.v);
  }
  return true;
}

/** \underset{A}{\overset{B}{\sum}} → \sum_{A}^{B} (이 단계의 낱말 목록) */
function stackLimits(items) {
  const out = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (isCmd(it, 'underset') || isCmd(it, 'overset')) {
      const rest = [];
      let q = k + 1;
      while (q < items.length && rest.length < 2) {
        if (items[q].t !== 'sp') rest.push(items[q]);
        q++;
      }
      const [limit, body] = rest;
      const inner = body?.t === 'grp' ? solid(body.items) : body ? [body] : [];
      const op = inner[0];
      const under = it.v === 'underset';
      const mine = under ? '_' : '^';
      if (limit?.t === 'grp' && isCmd(op) && LIMIT_OPS.has(op.v) && singleScriptable(inner, mine) && inner.length <= 3) {
        const scripts = inner.slice(1);
        const add = [{ t: 'ch', v: mine }, limit];
        out.push(op, ...(under ? [...add, ...scripts] : [...scripts, ...add]));
        k = q - 1;
        continue;
      }
    }
    out.push(it);
  }
  return out;
}

/** \left·\right·\big 괄호: 안에 큰 것이 있으면 \left … \right, 아니면 그냥 괄호 */
function fixDelims(items) {
  const marks = []; // {cmd, delim, kind}
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (!isCmd(it) || !DELIM_CMDS.has(it.v)) continue;
    let d = k + 1;
    while (d < items.length && items[d].t === 'sp') d++;
    if (d >= items.length) {
      marks.push({ cmd: k, delim: -1, kind: 'mid' }); // 괄호 없이 끝난 \right: 지움
      continue;
    }
    const ds = delimStr(items[d]);
    let kind;
    if (it.v === 'left') kind = 'open';
    else if (it.v === 'right') kind = 'close';
    else if (it.v === 'middle') kind = 'mid';
    else if (/l$/.test(it.v) || (/^[bB]igg?$/.test(it.v) && OPEN_DELIMS.has(ds))) kind = 'bigopen';
    else if (/r$/.test(it.v) || (/^[bB]igg?$/.test(it.v) && CLOSE_DELIMS.has(ds))) kind = 'bigclose';
    else kind = 'mid';
    marks.push({ cmd: k, delim: d, kind });
    k = d;
  }
  if (!marks.length) return items;
  const drop = new Set();
  const stacks = { open: [], bigopen: [] };
  const pairs = [];
  for (const mk of marks) {
    if (mk.kind === 'open' || mk.kind === 'bigopen') stacks[mk.kind].push(mk);
    else if (mk.kind === 'close' || mk.kind === 'bigclose') {
      const open = stacks[mk.kind === 'close' ? 'open' : 'bigopen'].pop();
      if (open) pairs.push([open, mk]);
      else mk.lone = true;
    } else mk.lone = true;
  }
  for (const st of Object.values(stacks)) for (const mk of st) mk.lone = true;
  const replace = new Map(); // 위치 → 새 낱말
  for (const [a, b] of pairs) {
    if (containsTall(items.slice(a.delim + 1, b.cmd))) {
      replace.set(a.cmd, { t: 'cmd', v: 'left' });
      replace.set(b.cmd, { t: 'cmd', v: 'right' });
    } else {
      a.lone = true;
      b.lone = true;
    }
  }
  for (const mk of marks) {
    if (!mk.lone) continue;
    drop.add(mk.cmd);
    if (isCh(items[mk.delim], '.')) drop.add(mk.delim);
  }
  const out = [];
  items.forEach((it, k) => {
    if (drop.has(k)) return;
    out.push(replace.get(k) || it);
  });
  return out;
}

/** 한 칸짜리 \begin{array}{l} … \end{array}: 한 줄이면 풀고, 여러 줄이면 aligned(왼쪽 정렬)/gathered */
function unwrapArrays(items) {
  for (let k = 0; k < items.length; k++) {
    if (!isCmd(items[k], 'begin')) continue;
    const solidAfter = [];
    for (let q = k + 1; q < items.length && solidAfter.length < 2; q++) if (items[q].t !== 'sp') solidAfter.push(q);
    const [nameAt, specAt] = solidAfter;
    if (grpText(items[nameAt]) !== 'array' || items[specAt]?.t !== 'grp') continue;
    const spec = grpText(items[specAt]).replace(/[|\s]/g, '');
    if (!/^[lcr]$/.test(spec)) continue;
    // 짝이 되는 \end{array}
    let depth = 0;
    let endAt = -1;
    for (let q = specAt + 1; q < items.length; q++) {
      if (isCmd(items[q], 'begin')) depth++;
      else if (isCmd(items[q], 'end')) {
        if (depth === 0) {
          endAt = q;
          break;
        }
        depth--;
      }
    }
    if (endAt < 0) continue;
    let after = endAt + 1;
    while (after < items.length && items[after].t === 'sp') after++;
    if (grpText(items[after]) !== 'array') continue;
    const body = items.slice(specAt + 1, endAt);
    const rows = [[]];
    for (const it of body) {
      if (isCmd(it, '\\')) rows.push([]);
      else rows[rows.length - 1].push(it);
    }
    const kept = rows.filter((r) => solid(r).length);
    let replacement;
    if (kept.length <= 1) replacement = kept[0] || [];
    else {
      const env = spec === 'l' ? 'aligned' : 'gathered';
      const name = { t: 'grp', items: [...env].map((v) => ({ t: 'ch', v })) };
      replacement = [{ t: 'cmd', v: 'begin' }, name];
      kept.forEach((r, n) => replacement.push(...(n ? [{ t: 'cmd', v: '\\' }] : []), ...r));
      replacement.push({ t: 'cmd', v: 'end' }, { ...name });
    }
    items = [...items.slice(0, k), ...replacement, ...items.slice(after + 1)];
    k += replacement.length - 1;
  }
  return items;
}

/** 필요 없는 { } 풀기 + 첨자 인자가 낱말 하나면 { } 로 감싸기 (_2 32 → _{2}32) */
function cleanGroups(items) {
  const { keep } = argInfo(items);
  const out = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    let next = k + 1;
    while (next < items.length && items[next].t === 'sp') next++;
    const script = isScript(items[next]) ? items[next].v : null;

    if (isScript(it) && next < items.length && (items[next].t === 'ch' || (isCmd(items[next]) && (ZERO.has(items[next].v) || /^[^A-Za-z]$/.test(items[next].v)))) && !isScript(items[next])) {
      out.push(it, { t: 'grp', items: [items[next]] });
      k = next;
      continue;
    }
    if (it.t !== 'grp' || keep.has(k)) {
      out.push(it);
      continue;
    }
    const inner = solid(it.items);
    if (!inner.length) {
      // 빈 { }: 지움. 첨자 앞이면 a_{k} {}^{2} → a_{k}^{2} 일 때만 (ₙCᵣ 의 {}_{n} 같은 것은 둠)
      const prev = solid(out).slice(-2);
      if (script && !(isScript(prev[0]) && prev[0].v !== script)) out.push(it);
      continue;
    }
    const blocked =
      inner.some((x) => (isCmd(x) && (INFIX.has(x.v) || x.v === '\\')) || isCh(x, '&')) ||
      isScript(inner[0]) ||
      argInfo(it.items).incomplete ||
      (script && !singleScriptable(inner, script));
    if (blocked) out.push(it);
    else out.push(...it.items);
  }
  return out;
}

function transform(items) {
  items = items.map((it) => (it.t === 'grp' ? { t: 'grp', items: transform(it.items) } : it));
  items = stackLimits(items);
  items = fixDelims(items);
  items = unwrapArrays(items);
  return cleanGroups(items);
}

function serialize(items) {
  let out = '';
  let prevSpace = false;
  for (const it of items) {
    if (it.t === 'sp') {
      prevSpace = true;
      continue;
    }
    const s = it.t === 'cmd' ? `\\${it.v}` : it.t === 'grp' ? `{${serialize(it.items)}}` : it.v;
    if (!s) continue;
    // \log x 처럼 명령 이름 뒤 글자·숫자는 띄움, 한글 사이 빈칸은 남김
    if (/\\[A-Za-z]+$/.test(out) && /^[A-Za-z0-9]/.test(s)) out += ' ';
    else if (prevSpace && HANGUL_RE.test(out.slice(-1)) && HANGUL_RE.test(s[0])) out += ' ';
    out += s;
    prevSpace = false;
  }
  return out;
}

/**
 * Pix2Text LaTeX → latexToHwpEq 가 잘 읽는 LaTeX
 * @param {string} src
 * @returns {string} 찌꺼기만 있던 크롭이면 빈 글자
 */
export function normalizeLatex(src) {
  let s = String(src ?? '').trim();
  s = s.replace(/^\$+|\$+$/g, '').trim();
  s = prePass(s);
  s = circledPass(stripJunk(s));
  s = serialize(transform(parse(s)));
  return stripJunk(s);
}
