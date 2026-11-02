// LaTeX(고등학교 수학에서 쓰는 만큼) → 한글 수식 스크립트
//  - 한글 수식 편집기에서 그대로 고칠 수 있는 명령어로 바꿉니다:
//    {a} over {b}, sqrt {x}, root {n} of {x}, x^{2}, LEFT ( … RIGHT ), log _{a} b, lim _{x -> 0} …
//  - 모르는 명령어는 역슬래시만 떼고 두고, 괄호 짝이 틀려도 멈추지 않습니다.
//  - 한글 문서에 넣을 때 쓰는 대략적인 크기(글자 크기 단위)도 함께 셈합니다.

const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힯]/;

// 글자로 들어가는 명령: 안의 내용을 따옴표 글자("…")로
const TEXT_CMDS = new Set(['text', 'textrm', 'textup', 'textnormal', 'textbf', 'textit', 'textsf', 'texttt', 'mbox', 'hbox', 'mathrm', 'operatorname']);

// 띄어쓰기: 한글 수식에서 그냥 빈칸은 안 보이므로 ~(보통) `(좁게)
const SPACES = { ',': '`', ':': '~', ';': '~', '>': '~', ' ': '~', quad: '~~', qquad: '~~~~', enspace: '~', thinspace: '`', medspace: '~', thickspace: '~' };

// 보이지 않는 명령 / 인자 하나를 버리는 명령
const DROP = new Set(['!', 'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle', 'limits', 'nolimits', 'nonumber', 'notag', 'hline', 'strut', 'centering', 'small', 'normalsize', 'large']);
const DROP_ARG = new Set(['label', 'tag', 'color', 'phantom', 'hphantom', 'vphantom', 'hspace', 'vspace']);

// 글꼴만 바꾸는 명령: 내용만 남김
const FONT_CMDS = new Set(['mathbf', 'boldsymbol', 'bm', 'mathit', 'mathsf', 'mathbb', 'mathcal', 'mathscr', 'mathfrak', 'mathtt', 'boxed', 'pmb']);

const FRAC = new Set(['frac', 'dfrac', 'tfrac', 'cfrac']);
const BINOM = new Set(['binom', 'dbinom', 'tbinom']);
const BIG = new Set(['big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr', 'bigm', 'Bigm']);

// 위에 붙는 기호
const ACCENT = {
  overline: 'bar', bar: 'bar', vec: 'vec', overrightarrow: 'vec', overleftrightarrow: 'dyad', hat: 'hat', widehat: 'hat',
  tilde: 'tilde', widetilde: 'tilde', dot: 'dot', ddot: 'ddot', underline: 'under', check: 'check', acute: 'acute', grave: 'grave',
  overarc: 'arch', wideparen: 'arch', overgroup: 'arch',
};

// 한글 수식이 똑바른 글씨로 알아보는 함수 이름
const FN = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'det', 'gcd', 'mod', 'arg', 'dim', 'ker', 'hom']);
// 한글 수식에서 다른 뜻이 있는 함수 이름(sup = 위 첨자, inf = ∞ 등)은 따옴표 글자로
const FN_TEXT = new Set(['sup', 'inf', 'lcm', 'deg', 'Pr', 'liminf', 'limsup', 'sgn', 'arccot']);
// 아래위 한계가 붙는 큰 연산자
const BIGOP = { sum: 'sum', prod: 'prod', int: 'int', oint: 'oint', iint: 'int int', coprod: '∐', bigcup: 'cup', bigcap: 'cap' };
const LIMIT_OPS = new Set(['sum', 'prod', 'lim', 'cup', 'cap', 'max', 'min']);

const GREEK = {
  alpha: 'alpha', beta: 'beta', gamma: 'gamma', delta: 'delta', epsilon: 'epsilon', varepsilon: 'epsilon', zeta: 'zeta', eta: 'eta',
  theta: 'theta', vartheta: 'theta', iota: 'iota', kappa: 'kappa', lambda: 'lambda', mu: 'mu', nu: 'nu', xi: 'xi', omicron: 'omicron',
  pi: 'pi', varpi: 'pi', rho: 'rho', varrho: 'rho', sigma: 'sigma', varsigma: 'sigma', tau: 'tau', upsilon: 'upsilon', phi: 'phi',
  varphi: 'phi', chi: 'chi', psi: 'psi', omega: 'omega',
  Gamma: 'GAMMA', Delta: 'DELTA', Theta: 'THETA', Lambda: 'LAMBDA', Xi: 'XI', Pi: 'PI', Sigma: 'SIGMA', Upsilon: 'UPSILON',
  Phi: 'PHI', Psi: 'PSI', Omega: 'OMEGA',
};

// 기호: LaTeX 명령 → [한글 수식, 종류]  (확실하지 않은 기호는 유니코드 글자 그대로)
const SYM = {
  times: ['times', 'kw'], div: ['div', 'kw'], cdot: ['cdot', 'kw'], circ: ['circ', 'kw'], ast: ['*', 'op'], star: ['⋆', 'op'], bullet: ['∙', 'op'],
  pm: ['+-', 'op'], mp: ['-+', 'op'],
  le: ['<=', 'op'], leq: ['<=', 'op'], leqq: ['<=', 'op'], leqslant: ['<=', 'op'], ge: ['>=', 'op'], geq: ['>=', 'op'], geqq: ['>=', 'op'], geqslant: ['>=', 'op'],
  ne: ['!=', 'op'], neq: ['!=', 'op'], lt: ['<', 'op'], gt: ['>', 'op'],
  approx: ['≈', 'op'], sim: ['∼', 'op'], simeq: ['≃', 'op'], equiv: ['≡', 'op'], cong: ['≅', 'op'], propto: ['∝', 'op'], doteq: ['≐', 'op'], ll: ['≪', 'op'], gg: ['≫', 'op'],
  to: ['->', 'kw'], rightarrow: ['->', 'kw'], longrightarrow: ['->', 'kw'], mapsto: ['->', 'kw'], leftarrow: ['<-', 'kw'], gets: ['<-', 'kw'], longleftarrow: ['<-', 'kw'],
  leftrightarrow: ['<->', 'kw'], longleftrightarrow: ['<->', 'kw'],
  Rightarrow: ['⇒', 'op'], Longrightarrow: ['⇒', 'op'], implies: ['⇒', 'op'], Leftarrow: ['⇐', 'op'], Longleftarrow: ['⇐', 'op'], impliedby: ['⇐', 'op'],
  Leftrightarrow: ['⇔', 'op'], Longleftrightarrow: ['⇔', 'op'], iff: ['⇔', 'op'], uparrow: ['↑', 'op'], downarrow: ['↓', 'op'],
  cdots: ['cdots', 'kw'], ldots: ['ldots', 'kw'], dots: ['ldots', 'kw'], dotsc: ['ldots', 'kw'], dotsb: ['cdots', 'kw'], vdots: ['vdots', 'kw'], ddots: ['ddots', 'kw'],
  infty: ['inf', 'kw'],
  angle: ['angle', 'kw'], measuredangle: ['angle', 'kw'], triangle: ['triangle', 'kw'], therefore: ['therefore', 'kw'], because: ['because', 'kw'],
  in: ['in', 'kw'], notin: ['∉', 'op'], ni: ['∋', 'op'], owns: ['∋', 'op'],
  subset: ['subset', 'kw'], supset: ['supset', 'kw'], subseteq: ['subseteq', 'kw'], supseteq: ['supseteq', 'kw'],
  subsetneq: ['⊊', 'op'], supsetneq: ['⊋', 'op'], nsubseteq: ['⊈', 'op'], nsupseteq: ['⊉', 'op'],
  cup: ['cup', 'kw'], cap: ['cap', 'kw'], setminus: ['-', 'op'], emptyset: ['emptyset', 'kw'], varnothing: ['emptyset', 'kw'],
  forall: ['∀', 'op'], exists: ['∃', 'op'], nexists: ['∄', 'op'], neg: ['¬', 'op'], lnot: ['¬', 'op'], land: ['∧', 'op'], wedge: ['∧', 'op'], lor: ['∨', 'op'], vee: ['∨', 'op'],
  perp: ['⊥', 'op'], parallel: ['∥', 'op'], nparallel: ['∦', 'op'], mid: ['|', 'op'], nmid: ['∤', 'op'],
  vert: ['|', 'op'], lvert: ['|', 'op'], rvert: ['|', 'op'], Vert: ['‖', 'op'], lVert: ['‖', 'op'], rVert: ['‖', 'op'], '|': ['‖', 'op'],
  partial: ['∂', 'op'], nabla: ['∇', 'op'], hbar: ['ℏ', 'op'], ell: ['ℓ', 'op'], aleph: ['ℵ', 'op'],
  square: ['□', 'op'], Box: ['□', 'op'], blacksquare: ['■', 'op'], diamond: ['◇', 'op'], checkmark: ['✓', 'op'],
  oplus: ['⊕', 'op'], otimes: ['⊗', 'op'], odot: ['⊙', 'op'], ominus: ['⊖', 'op'], dagger: ['†', 'op'],
  lbrace: ['lbrace', 'kw'], rbrace: ['rbrace', 'kw'], '{': ['lbrace', 'kw'], '}': ['rbrace', 'kw'],
  langle: ['〈', 'open'], rangle: ['〉', 'close'], lfloor: ['⌊', 'open'], rfloor: ['⌋', 'close'], lceil: ['⌈', 'open'], rceil: ['⌉', 'close'],
  colon: [':', 'punct'], prime: ['prime', 'kw'], degree: ['DEG', 'kw'],
  '%': ['%', 'op'], $: ['$', 'op'], '#': ['"#"', 'text'], '&': ['"&"', 'text'], _: ['"_"', 'text'], backslash: ['∖', 'op'],
};

// 환경 → 한글 수식 명령
const ENVS = {
  cases: 'cases', dcases: 'cases', rcases: 'cases', matrix: 'matrix', smallmatrix: 'matrix', array: 'matrix', pmatrix: 'pmatrix',
  bmatrix: 'bmatrix', Bmatrix: 'matrix', vmatrix: 'dmatrix', Vmatrix: 'dmatrix', aligned: 'lpile', align: 'lpile', 'align*': 'lpile',
  alignat: 'lpile', 'alignat*': 'lpile', alignedat: 'lpile', split: 'lpile', eqnarray: 'lpile', 'eqnarray*': 'lpile',
  gathered: 'pile', gather: 'pile', 'gather*': 'pile', multline: 'pile', subarray: 'pile',
};
// & 가 정렬 표시라서 버리는 환경
const PILES = new Set(['pile', 'lpile', 'rpile']);

// 괄호 크기를 맞출 때 LEFT / RIGHT 를 쓸 수 있는 괄호
const LR_DELIMS = new Set(['(', ')', '[', ']', '|']);

/**
 * 한글 수식 명령어와 같은 글자 묶음. LaTeX 의 "PI"(점 P, I) 같은 글자가 한글에서 Π 로 바뀌지 않게
 * 이런 묶음은 글자를 띄어서 씁니다(한글 수식에서 빈칸은 보이지 않으니 모양은 같음).
 */
const HWP_WORDS = new Set(
  [
    'over', 'atop', 'sqrt', 'root', 'of', 'sum', 'prod', 'int', 'oint', 'dint', 'tint', 'lim', 'from', 'to', 'times', 'div', 'cdot', 'cdots', 'ldots',
    'vdots', 'ddots', 'inf', 'in', 'notin', 'owns', 'subset', 'supset', 'subseteq', 'supseteq', 'cup', 'cap', 'union', 'inter', 'emptyset', 'angle',
    'triangle', 'therefore', 'because', 'bar', 'vec', 'dyad', 'hat', 'dot', 'ddot', 'tilde', 'under', 'arch', 'check', 'acute', 'grave', 'left',
    'right', 'rm', 'it', 'bold', 'bf', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'dmatrix', 'pile', 'lpile', 'rpile', 'eqalign', 'deg', 'prime',
    'partial', 'nabla', 'forall', 'exist', 'approx', 'sim', 'simeq', 'equiv', 'cong', 'propto', 'circ', 'box', 'color', 'not', 'and', 'or', 'mod',
    'sub', 'sup', 'lsub', 'lsup', 'leq', 'geq', 'neq', 'le', 'ge', 'ne', 'lt', 'gt', 'll', 'gg', 'pm', 'mp', 'larrow', 'rarrow', 'lrarrow',
    'uparrow', 'downarrow', 'lbrace', 'rbrace', 'langle', 'rangle', 'vert', 'hbar', 'liter', 'oplus', 'otimes', 'odot', 'star', 'bullet', 'top',
    'bot', 'perp', 'vee', 'wedge', 'smallsum', 'smallprod', 'size', 'scale', 'big', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos',
    'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'max', 'min', 'det', 'gcd', 'arg', 'dim', 'ker', 'hom',
    ...Object.values(GREEK),
  ].map((w) => w.toLowerCase()),
);

// ---------------------------------------------------------------------------
// 1) 낱말로 나누기
// ---------------------------------------------------------------------------
function tokenize(src) {
  const s = String(src || '');
  const toks = [];
  const skipSpaces = (j) => {
    while (j < s.length && /\s/.test(s[j])) j++;
    return j;
  };
  /** s[from] 이 '{' 일 때 짝이 되는 '}' 까지의 내용 */
  const readBraced = (from) => {
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
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const name = /^[A-Za-z]+/.exec(s.slice(i + 1))?.[0];
      if (!name) {
        if (i + 1 < s.length) toks.push({ t: 'cmd', v: s[i + 1] });
        i += 2;
        continue;
      }
      i += 1 + name.length;
      if (TEXT_CMDS.has(name) || name === 'begin' || name === 'end') {
        const j = skipSpaces(i);
        if (s[j] === '{') {
          const [raw, end] = readBraced(j);
          i = end;
          if (name === 'begin' || name === 'end') {
            toks.push({ t: name, v: raw.trim() });
            // array 의 열 지정({cc})과 alignat 의 열 수는 건너뜀
            const k = skipSpaces(i);
            if (name === 'begin' && /^(array|subarray|alignat\*?|alignedat)$/.test(raw.trim()) && s[k] === '{') i = readBraced(k)[1];
          } else toks.push({ t: 'textcmd', name, v: raw });
          continue;
        }
      }
      toks.push({ t: 'cmd', v: name });
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const num = /^[0-9]+(?:\.[0-9]+)?/.exec(s.slice(i))[0];
      toks.push({ t: 'num', v: num });
      i += num.length;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      toks.push({ t: 'letter', v: c });
      i++;
      continue;
    }
    if (HANGUL_RE.test(c)) {
      let j = i;
      while (j < s.length && (HANGUL_RE.test(s[j]) || (s[j] === ' ' && HANGUL_RE.test(s[j + 1] || '')))) j++;
      toks.push({ t: 'kor', v: s.slice(i, j) });
      i = j;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i));
    toks.push({ t: 'ch', v: ch });
    i += ch.length;
  }
  return toks;
}

// ---------------------------------------------------------------------------
// 2) 나무 구조로 읽기
// ---------------------------------------------------------------------------
const seqOf = (items) => ({ t: 'seq', items });
const isCh = (tok, v) => tok?.t === 'ch' && tok.v === v;
const isCmd = (tok, v) => tok?.t === 'cmd' && tok.v === v;
const isRowSep = (tok) => tok?.t === 'cmd' && (tok.v === '\\' || tok.v === 'cr' || tok.v === 'newline');

function parse(src) {
  const p = { toks: tokenize(src), i: 0 };
  const items = [];
  while (p.i < p.toks.length) {
    items.push(...parseSeq(p, null).items);
    if (p.i < p.toks.length) p.i++; // 짝 없는 } 는 건너뜀
  }
  // 맨 바깥에서 \\ 로 줄을 나눴으면 여러 줄 수식(lpile)
  if (!items.some((n) => n.t === 'rowsep')) return seqOf(items.filter((n) => n.t !== 'amp'));
  const rows = [[]];
  for (const n of items) {
    if (n.t === 'rowsep') rows.push([]);
    else if (n.t !== 'amp') rows[rows.length - 1].push(n);
  }
  return seqOf([{ t: 'env', kw: 'lpile', rows: rows.filter((r) => r.length).map((r) => [seqOf(r)]) }]);
}

/** stop(tok) 이 참이거나 } 를 만나면 멈춤(그 낱말은 먹지 않음) */
function parseSeq(p, stop) {
  const items = [];
  while (p.i < p.toks.length) {
    const tok = p.toks[p.i];
    if (isCh(tok, '}') || (stop && stop(tok))) break;
    if (isCh(tok, '^') || isCh(tok, '_')) {
      p.i++;
      const arg = parseArg(p);
      let node = items.pop() || { t: 'group', body: seqOf([]) };
      const key = tok.v === '^' ? 'sup' : 'sub';
      if (node.t !== 'script' || node[key]) node = { t: 'script', base: node, sup: null, sub: null };
      node[key] = arg;
      items.push(node);
      continue;
    }
    const node = parseAtom(p);
    if (node) items.push(node);
  }
  return seqOf(items);
}

/** { … } 묶음 하나 또는 낱말 하나 */
function parseArg(p) {
  const tok = p.toks[p.i];
  if (!tok || isCh(tok, '}')) return seqOf([]);
  if (isCh(tok, '{')) {
    p.i++;
    const body = parseSeq(p, null);
    if (isCh(p.toks[p.i], '}')) p.i++;
    return body;
  }
  // \frac12 처럼 숫자가 붙어 있으면 한 자리만
  if (tok.t === 'num' && tok.v.length > 1) {
    const first = tok.v[0];
    tok.v = tok.v.slice(1);
    return seqOf([{ t: 'num', v: first }]);
  }
  const node = parseAtom(p);
  return seqOf(node ? [node] : []);
}

/** \sqrt[3] 같은 [ … ] 인자 (없으면 null) */
function parseOpt(p) {
  if (!isCh(p.toks[p.i], '[')) return null;
  p.i++;
  const body = parseSeq(p, (tok) => isCh(tok, ']'));
  if (isCh(p.toks[p.i], ']')) p.i++;
  return body;
}

function parseAtom(p) {
  const tok = p.toks[p.i++];
  switch (tok.t) {
    case 'num':
      return { t: 'num', v: tok.v };
    case 'letter':
      return { t: 'letter', v: tok.v };
    case 'kor':
      return { t: 'text', v: tok.v };
    case 'textcmd':
      return textCommand(tok);
    case 'begin':
      return parseEnv(tok.v, p);
    case 'end':
      return null;
    case 'cmd':
      return parseCommand(tok.v, p);
    default:
      return parseChar(tok.v, p);
  }
}

function textCommand(tok) {
  // \mathrm{m^2} 처럼 안에 수식이 있으면 수식으로 읽음
  if ((tok.name === 'mathrm' || tok.name === 'operatorname') && /[\\^_{}]/.test(tok.v)) return { t: 'group', body: parse(tok.v) };
  const text = tok.v.replace(/\$/g, '');
  return text ? { t: 'text', v: text } : null;
}

const sym = (v, k) => ({ t: 'sym', v, k });

function parseChar(c, p) {
  if (c === '{') {
    const body = parseSeq(p, null);
    if (isCh(p.toks[p.i], '}')) p.i++;
    return { t: 'group', body };
  }
  if (c === '&') return { t: 'amp' };
  if (c === '~') return { t: 'space', v: '~' };
  if (c === "'") return sym('prime', 'kw');
  if (c === '"') return sym("''", 'op');
  if (c === '#') return { t: 'text', v: '#' };
  if (c === '(' || c === '[') return sym(c, 'open');
  if (c === ')' || c === ']') return sym(c, 'close');
  if (/^[,;:.?]$/.test(c)) return sym(c, 'punct');
  if (c === '−' || c === '–') return sym('-', 'op');
  return sym(c, 'op');
}

function parseCommand(name, p) {
  if (name in SPACES) return { t: 'space', v: SPACES[name] };
  if (DROP.has(name)) return null;
  if (DROP_ARG.has(name)) {
    parseArg(p);
    return null;
  }
  if (name === 'textcolor') {
    parseArg(p);
    return { t: 'group', body: parseArg(p) };
  }
  if (FRAC.has(name)) return { t: 'frac', num: parseArg(p), den: parseArg(p) };
  if (BINOM.has(name)) return { t: 'binom', n: parseArg(p), k: parseArg(p) };
  if (name === 'sqrt') {
    const index = parseOpt(p);
    return { t: 'sqrt', index, body: parseArg(p) };
  }
  if (name === 'left') return parseLeftRight(p);
  if (name === 'right' || name === 'middle' || BIG.has(name)) return delimNode(readDelim(p));
  if (ACCENT[name]) return { t: 'accent', kw: ACCENT[name], body: parseArg(p) };
  if (name === 'overset' || name === 'stackrel') {
    const top = parseArg(p);
    const body = parseArg(p);
    if (top.items.length === 1 && top.items[0].t === 'sym' && top.items[0].v === 'frown') return { t: 'accent', kw: 'arch', body };
    return { t: 'script', base: { t: 'group', body }, sup: top, sub: null };
  }
  if (name === 'underset') {
    const bottom = parseArg(p);
    return { t: 'script', base: { t: 'group', body: parseArg(p) }, sup: null, sub: bottom };
  }
  if (name === 'not') {
    const next = p.toks[p.i];
    if (isCh(next, '=')) {
      p.i++;
      return sym('!=', 'op');
    }
    const neg = { in: '∉', subset: '⊄', supset: '⊅', subseteq: '⊈', supseteq: '⊉', parallel: '∦', equiv: '≢' };
    if (next?.t === 'cmd' && neg[next.v]) {
      p.i++;
      return sym(neg[next.v], 'op');
    }
    return null;
  }
  // 글꼴 명령, 그리고 { } 없이 쓴 \text x 같은 것: 내용만
  if (FONT_CMDS.has(name) || TEXT_CMDS.has(name)) return { t: 'group', body: parseArg(p) };
  if (name === 'pmod') return seqNode([sym('(', 'open'), sym('mod', 'kw'), { t: 'group', body: parseArg(p) }, sym(')', 'close')]);
  if (name === 'bmod') return sym('mod', 'kw');
  if (FN.has(name)) return { ...sym(name, 'kw'), limits: LIMIT_OPS.has(name) };
  if (FN_TEXT.has(name)) return { t: 'text', v: name };
  if (BIGOP[name]) return { ...sym(BIGOP[name], 'kw'), big: true, limits: LIMIT_OPS.has(BIGOP[name]) };
  if (GREEK[name]) return sym(GREEK[name], 'kw');
  if (SYM[name]) return sym(...SYM[name]);
  if (name === '\\' || name === 'cr' || name === 'newline') {
    if (isCh(p.toks[p.i], '[')) parseOpt(p); // \\[2pt]
    return { t: 'rowsep' };
  }
  // 모르는 명령: 역슬래시만 떼고 그대로
  return sym(name, /^[A-Za-z]+$/.test(name) ? 'kw' : 'op');
}

/** 여러 낱말을 한 덩어리로 (괄호 없이 그대로 이어 씀) */
const seqNode = (items) => ({ t: 'inline', items });

function readDelim(p) {
  const tok = p.toks[p.i];
  if (tok?.t === 'ch' && /^[()[\]|./<>]$/.test(tok.v)) {
    p.i++;
    return { '<': '〈', '>': '〉' }[tok.v] || tok.v;
  }
  const map = {
    '{': '{', '}': '}', lbrace: '{', rbrace: '}', langle: '〈', rangle: '〉', '|': '‖', Vert: '‖', vert: '|', lvert: '|', rvert: '|',
    lVert: '‖', rVert: '‖', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  };
  if (tok?.t === 'cmd' && map[tok.v]) {
    p.i++;
    return map[tok.v];
  }
  return '.';
}

function delimNode(d) {
  if (d === '.') return null;
  if (d === '{') return sym('lbrace', 'kw');
  if (d === '}') return sym('rbrace', 'kw');
  if (d === '(' || d === '[' || d === '〈' || d === '⌊' || d === '⌈') return sym(d, 'open');
  if (d === ')' || d === ']' || d === '〉' || d === '⌋' || d === '⌉') return sym(d, 'close');
  return sym(d, 'op');
}

function parseLeftRight(p) {
  const l = readDelim(p);
  const body = parseSeq(p, (tok) => isCmd(tok, 'right'));
  let r = '.';
  if (isCmd(p.toks[p.i], 'right')) {
    p.i++;
    r = readDelim(p);
  }
  // \left\{ \begin{array} … \end{array} \right. → 연립(cases)
  const only = body.items.length === 1 ? body.items[0] : null;
  if (l === '{' && r === '.' && only?.t === 'env') return { ...only, kw: 'cases' };
  return { t: 'lr', l, r, body };
}

function parseEnv(name, p) {
  const rows = [[]];
  for (;;) {
    const cell = parseSeq(p, (tok) => isCh(tok, '&') || isRowSep(tok) || tok.t === 'end');
    rows[rows.length - 1].push(cell);
    const tok = p.toks[p.i];
    if (!tok) break;
    p.i++;
    if (tok.t === 'end') break;
    if (isRowSep(tok)) {
      if (isCh(p.toks[p.i], '[')) parseOpt(p);
      rows.push([]);
    }
    // } 가 짝 없이 나오면 그냥 다음 칸으로
  }
  const kept = rows.filter((r) => r.some((c) => c.items.length));
  return { t: 'env', kw: ENVS[name] || 'pile', rows: kept.length ? kept : [[seqOf([])]] };
}

// ---------------------------------------------------------------------------
// 3) 한글 수식 스크립트로 쓰기
// ---------------------------------------------------------------------------
// 낱말 종류: id(영문자 묶음) num op open close punct space group / kw struct text(앞뒤를 꼭 띄움)
const FORCE = new Set(['kw', 'struct', 'text']);

function needSpace(a, b) {
  if (a.k === 'space' || b.k === 'space') return false;
  if (FORCE.has(a.k) && b.k !== 'close' && b.k !== 'punct') return true;
  if (FORCE.has(b.k) && a.k !== 'open') return true;
  const x = a.s[a.s.length - 1];
  const y = b.s[0];
  if (/[A-Za-z]/.test(x) && /[A-Za-z]/.test(y)) return true;
  if (/[0-9]/.test(x) && /[0-9.]/.test(y)) return true;
  // <= -> != +- 처럼 뜻이 바뀌지 않게 기호끼리는 띄움
  if (/[<>=!+\-]/.test(x) && /[<>=!+\-]/.test(y)) return true;
  return false;
}

function join(tokens) {
  let out = '';
  tokens.forEach((tok, i) => {
    if (!tok.s) return;
    if (i > 0 && out && needSpace(tokens[i - 1], tok)) out += ' ';
    out += tok.s;
  });
  return out;
}

const emitStr = (seq) => join(emitSeq(seq));

function emitSeq(seq) {
  const out = [];
  const items = seq.items;
  const multi = items.length > 1;
  let run = '';
  const flush = () => {
    if (!run) return;
    if (HWP_WORDS.has(run.toLowerCase())) for (const ch of run) out.push({ s: ch, k: 'id' });
    else out.push({ s: run, k: 'id' });
    run = '';
  };
  for (const n of items) {
    if (n.t === 'letter') {
      run += n.v;
      continue;
    }
    flush();
    out.push(...emitNode(n, { multi }));
  }
  flush();
  return out.filter((t) => t.s);
}

function emitNode(n, { multi = false } = {}) {
  switch (n.t) {
    case 'seq':
      return emitSeq(n);
    case 'inline':
      return emitSeq(seqOf(n.items));
    case 'letter':
      return [{ s: n.v, k: 'id' }];
    case 'num':
      return [{ s: n.v, k: 'num' }];
    case 'text':
      return [{ s: `"${n.v.replace(/"/g, "''")}"`, k: 'text' }];
    case 'sym':
      return [{ s: n.v, k: n.k }];
    case 'space':
      return [{ s: n.v, k: 'space' }];
    case 'group':
      return [{ s: `{${emitStr(n.body)}}`, k: 'group' }];
    case 'frac': {
      const s = `{${emitStr(n.num)}} over {${emitStr(n.den)}}`;
      // 다른 것과 이어지면 분수 전체를 묶어야 over 가 옆 글자를 가져가지 않음
      return [multi ? { s: `{${s}}`, k: 'group' } : { s, k: 'struct' }];
    }
    case 'sqrt':
      return [{ s: n.index ? `root {${emitStr(n.index)}} of {${emitStr(n.body)}}` : `sqrt {${emitStr(n.body)}}`, k: 'struct' }];
    case 'accent':
      return [{ s: `${n.kw} {${emitStr(n.body)}}`, k: 'struct' }];
    case 'binom':
      return [{ s: `LEFT ( {${emitStr(n.n)}} atop {${emitStr(n.k)}} RIGHT )`, k: 'struct' }];
    case 'lr':
      return emitLeftRight(n);
    case 'env':
      return [{ s: emitEnv(n), k: 'struct' }];
    case 'script':
      return [emitScript(n)];
    default:
      return []; // amp, rowsep
  }
}

const useLR = (n) => LR_DELIMS.has(n.l) && LR_DELIMS.has(n.r);

function emitLeftRight(n) {
  if (useLR(n)) return [{ s: `LEFT ${n.l} ${emitStr(n.body)} RIGHT ${n.r}`.replace(/ {2,}/g, ' '), k: 'struct' }];
  // 중괄호·한쪽만 있는 괄호는 크기 조절 없이 그대로
  return emitSeq(seqOf([delimNode(n.l), ...n.body.items, delimNode(n.r)].filter(Boolean)));
}

function emitEnv(n) {
  const pile = PILES.has(n.kw);
  const rows = n.rows.map((cells) => (pile ? cells.map(emitStr).filter(Boolean).join(' ') : cells.map(emitStr).join(' & ')));
  return `${n.kw}{${rows.join(' # ')}}`;
}

const onlySym = (seq, v) => seq?.items.length === 1 && seq.items[0].t === 'sym' && seq.items[0].v === v;

function emitScript(n) {
  const base = n.base;
  let b;
  if (['frac', 'sqrt', 'accent', 'binom', 'env', 'lr', 'script'].includes(base.t)) {
    b = { s: `{${join(emitNode(base))}}`, k: 'group' };
  } else {
    const toks = emitNode(base);
    b = toks.length === 1 ? toks[0] : { s: `{${join(toks)}}`, k: 'group' };
  }
  const kw = FORCE.has(b.k) && b.k !== 'text';
  // 90^{\circ} → 90 DEG,  f^{\prime} → f prime
  if (!n.sub && onlySym(n.sup, 'circ')) return { s: `${b.s} DEG`, k: 'kw' };
  if (!n.sub && onlySym(n.sup, 'prime')) return { s: `${b.s} prime`, k: 'kw' };
  let s = b.s;
  if (n.sub) s += `${kw ? ' ' : ''}_{${emitStr(n.sub)}}`;
  if (n.sup) s += `${kw ? ' ' : ''}^{${emitStr(n.sup)}}`;
  return { s, k: kw ? 'kw' : b.k === 'text' ? 'text' : 'group' };
}

// ---------------------------------------------------------------------------
// 4) 크기: 한글 수식 편집기가 실제로 그리는 크기
//    한글은 파일을 열 때 수식 크기(hp:sz)를 다시 셈하지 않고 적힌 대로 자리를 잡으므로, 폭이 모자라면
//    뒤 글자와 겹칩니다. 한글 2024 에서 수식 수백 개를 만들어 잰 값으로 맞춘 규칙입니다.
//    - 단위: 글자 크기의 1/1000 (10pt 에서 HWPUNIT 과 같음)
//    - 글자 폭은 화면 화소(10pt 에서 75)로 반올림, 첨자는 0.7배(첨자의 첨자·거듭제곱근 지수는 0.42배) 크기에서 다시 반올림
//    - 이항 연산자(+ - × …) 양쪽 140, 관계(= < ≤ …) 양쪽 210, 쉼표 뒤 70, 글자 바로 뒤 괄호 70, 영문자 뒤 함수 이름 125
//    - 분수·근호·꾸밈표·LEFT RIGHT 바로 뒤에서는 연산자 왼쪽 띄움이 없고, 첨자 바로 뒤에서는 1/0.7 배
//    - 대문자 바로 뒤 위첨자는 150 더 띄움
// ---------------------------------------------------------------------------
const PX = 75; // 10pt 에서 화소 하나
const SUB = 0.7; // 첨자 크기
const WIDE = 1050; // 한글·한자·대부분의 기호
const SPACE_W = { '~': 500, '`': 125 };
// 기울인 영문자 폭(화소)
const LOWER_PX = [7, 6, 6, 8, 6, 8, 6, 7, 5, 6, 7, 4, 11, 8, 6, 7, 6, 6, 6, 5, 8, 6, 10, 8, 7, 6];
const UPPER_PX = [11, 10, 9, 10, 9, 9, 10, 11, 5, 6, 11, 9, 13, 11, 10, 9, 10, 10, 8, 11, 10, 11, 14, 10, 10, 8];
// 기호: [폭, 종류]  bin: 이항 연산자, rel: 관계, open/close: 괄호, punct: 뒤를 띄우는 쉼표, ord: 띄움 없음
const GLYPH = {
  '+': [825, 'bin'], '-': [825, 'bin'], '+-': [825, 'bin'], '-+': [1050, 'bin'], times: [825, 'bin'], div: [825, 'bin'], circ: [1050, 'bin'], '!=': [1050, 'bin'],
  '=': [825, 'rel'], '<': [900, 'rel'], '>': [900, 'rel'], '<=': [1050, 'rel'], '>=': [1050, 'rel'], ':': [300, 'rel'],
  subset: [1050, 'rel'], supset: [1050, 'rel'], subseteq: [1050, 'rel'], supseteq: [1050, 'rel'], cdots: [1050, 'rel'], ldots: [1050, 'rel'], vdots: [1050, 'rel'], ddots: [1050, 'rel'],
  '(': [375, 'open'], '[': [300, 'open'], lbrace: [600, 'open'], ')': [375, 'close'], ']': [300, 'close'], rbrace: [600, 'close'],
  ',': [300, 'punct'], '*': [525, 'punct'],
  '.': [300], ';': [300], '!': [300], "'": [300], '|': [225], '/': [525], '?': [525], '%': [825], $: [525], "''": [450], '‖': [375], '†': [525], 'ℏ': [600], '¬': [825],
  prime: [300], DEG: [825], ' ': [125],
};
for (const c of '⋆∙≈∼≃≡≅≐∉') GLYPH[c] = [WIDE, 'bin'];
for (const c of '≪≫⊈⊉') GLYPH[c] = [WIDE, 'rel'];
// 그리스 문자 폭(화소)
const GREEK_PX = {
  alpha: 8, beta: 8, gamma: 7, delta: 6, epsilon: 6, zeta: 6, eta: 7, theta: 7, iota: 4, kappa: 8, lambda: 7, mu: 8, nu: 7, xi: 7, omicron: 6, pi: 8,
  rho: 7, sigma: 7, tau: 6, upsilon: 6, phi: 8, chi: 8, psi: 9, omega: 9, GAMMA: 9, DELTA: 10, THETA: 10, LAMBDA: 11, XI: 10, PI: 11, SIGMA: 11,
  UPSILON: 8, PHI: 9, PSI: 9, OMEGA: 10,
};
// 똑바른 글씨 함수 이름 폭 (앞에 글자가 있으면 125 띄움)
const FN_W = {
  sin: 1350, cos: 1500, tan: 1500, cot: 1425, sec: 1500, csc: 1500, arcsin: 2850, arccos: 3000, arctan: 3000, sinh: 1950, cosh: 2100, tanh: 2100,
  coth: 2025, log: 1425, ln: 900, lg: 900, exp: 1800, max: 2100, min: 1800, det: 1500, gcd: 1725, mod: 2025, arg: 1575, dim: 1800, ker: 1575, hom: 2025,
};
// 큰 연산자: [폭, 위, 아래, 한계를 옆에 붙임]
const BIG_OP = { sum: [1275, 1030, 330], prod: [1350, 1030, 330], lim: [1800, 960, 240], int: [1110, 1265, 650, true], oint: [1110, 1265, 650, true], 'int int': [2220, 1265, 650, true] };

const ASC = 840; // 보통 글자 위·아래 (기준선에서)
const DESC = 140;
const AXIS = 360; // 분수 선 높이

/** 글자 하나 폭 (크기 s 에서 화소로 반올림) */
const px = (w, s) => (s === 1 ? w : Math.round((w / PX) * s) * PX);

function charW(ch) {
  const i = 'abcdefghijklmnopqrstuvwxyz'.indexOf(ch);
  if (i >= 0) return LOWER_PX[i] * PX;
  const j = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(ch);
  if (j >= 0) return UPPER_PX[j] * PX;
  if (/[0-9]/.test(ch)) return 7 * PX;
  return GLYPH[ch]?.[0] ?? WIDE;
}

const atom = (w, s, cls = 'ord', extra = {}) => ({ w, a: ASC * s, d: DESC * s, cls, k: 1, ...extra });
/** 영문자: 함수 이름 앞 띄움, 대문자 뒤 위첨자 띄움에 씀 */
const letterAtom = (ch, s) => atom(px(charW(ch), s), s, 'ord', { letter: true, upper: /[A-Z]/.test(ch) });
// 따옴표 글자 속 빈칸(125)도 글자처럼 폭을 차지함
const charAtoms = (str, s) => [...str].map((ch) => (/[A-Za-z]/.test(ch) ? letterAtom(ch, s) : atom(px(charW(ch), s), s, GLYPH[ch]?.[1] || 'ord')));
const lettersW = (str) => [...str].reduce((w, ch) => w + charW(ch), 0);

/** 낱말(기호) 하나 → 조각 목록 */
function symAtoms(n, s) {
  const v = n.v;
  if (n.big && BIG_OP[v]) return [atom(px(BIG_OP[v][0], s), s, 'ord', { a: BIG_OP[v][1] * s, d: BIG_OP[v][2] * s, big: BIG_OP[v] })];
  if (v === 'lim') return [atom(px(1800, s), s, 'ord', { a: 960 * s, d: 240 * s, big: BIG_OP.lim })];
  if (n.k === 'text') return charAtoms(v.replace(/^"|"$/g, ''), s);
  if (FN_W[v]) return [atom(px(FN_W[v], s), s, 'fn')];
  if (GREEK_PX[v]) return [atom(px(GREEK_PX[v] * PX, s), s, 'ord', { letter: true, upper: /^[A-Z]/.test(v) })];
  if (GLYPH[v]) return [atom(px(GLYPH[v][0], s), s, GLYPH[v][1] || 'ord')];
  if (/^[A-Za-z]{2,}$/.test(v) && !['inf', 'angle', 'triangle', 'therefore', 'because', 'in', 'cup', 'cap', 'emptyset', 'cdot'].includes(v)) {
    return [atom(px(lettersW(v), s), s)]; // 모르는 명령: 기울인 글자로 보임
  }
  return [atom(px(v.length === 1 ? charW(v) : WIDE, s), s)];
}

/**
 * 조각 사이 띄움. L: 왼쪽(빈칸 건너뜀), R: 이번 조각
 * 앞에 받을 것이 없는 이항 연산자(-x, x=-1 의 -)는 단항: 오른쪽만 띄움
 * 조각 k: 바로 뒤 연산자의 왼쪽 띄움 배율 (분수·근호 등 뒤 0, 첨자 뒤 1/0.7)
 * 첨자 안의 관계 띄움은 줄지 않는 경우가 있어 그대로 둠(넓게)
 */
function gapBefore(L, R, s) {
  if (!L) return 0;
  const operand = L.cls === 'ord' || L.cls === 'close' || L.cls === 'fn';
  const end = R.cls === 'close' || R.cls === 'punct';
  if (R.cls === 'bin') return operand ? 140 * L.k * s : 0;
  if (R.cls === 'rel') return operand ? 210 * L.k : 0;
  if (L.cls === 'bin') return end ? 0 : 140 * s;
  if (L.cls === 'rel') return end ? 0 : 210;
  if (L.cls === 'punct') return 70 * s;
  if (R.cls === 'open' || R.cls === 'close') return L.cls === 'ord' || L.cls === 'fn' ? 70 * L.k * s : 0;
  if (R.cls === 'fn') return L.letter ? 125 * s : 0;
  return 0;
}

/** 조각들을 옆으로 이어 붙임 */
function hstack(atoms, s) {
  let w = 0;
  let a = ASC * s;
  let d = DESC * s;
  let L = null;
  for (const R of atoms) {
    if (R.cls === 'space') {
      w += R.w;
      continue;
    }
    w += gapBefore(L, R, s) + R.w;
    a = Math.max(a, R.a);
    d = Math.max(d, R.d);
    L = R;
  }
  return { w, a, d };
}

const measureSeq = (seq, s) => hstack(seqAtoms(seq, s), s);
const seqAtoms = (seq, s) => seq.items.flatMap((n) => nodeAtoms(n, s));
/** 구조(분수·근호 등): 바로 뒤 연산자의 왼쪽 띄움이 없음 */
const struct = (box) => ({ ...box, cls: 'ord', k: 0 });

function nodeAtoms(n, s) {
  switch (n.t) {
    case 'seq':
      return seqAtoms(n, s);
    case 'inline':
      return seqAtoms(seqOf(n.items), s);
    case 'letter':
      return [letterAtom(n.v, s)];
    case 'num':
      return charAtoms(n.v, s);
    case 'text':
      return charAtoms(n.v, s);
    case 'sym':
      return symAtoms(n, s);
    case 'space':
      return [{ w: [...n.v].reduce((w, c) => w + (SPACE_W[c] || 0), 0) * s, a: 0, d: 0, cls: 'space' }];
    case 'group': {
      // 묶음은 마지막 조각처럼 띄움 (분수를 묶은 것은 분수처럼)
      const atoms = seqAtoms(n.body, s);
      const last = atoms.filter((x) => x.cls !== 'space').pop();
      return [{ ...hstack(atoms, s), cls: last?.cls === 'fn' ? 'fn' : 'ord', k: last?.k ?? 1, upper: last?.upper }];
    }
    case 'frac': {
      const nu = measureSeq(n.num, s);
      const de = measureSeq(n.den, s);
      return [struct({ w: Math.max(nu.w, de.w) + 500 * s, a: nu.a + nu.d + 510 * s, d: de.a + de.d - 210 * s })];
    }
    case 'binom': {
      const nu = measureSeq(n.n, s);
      const de = measureSeq(n.k, s);
      return [struct({ w: Math.max(nu.w, de.w) + 1250 * s, a: nu.a + nu.d + 510 * s, d: de.a + de.d - 210 * s })];
    }
    case 'sqrt': {
      const b = measureSeq(n.body, s);
      const idx = n.index ? Math.max(0, measureSeq(n.index, s * 0.42).w - 337 * s) : 0;
      return [struct({ w: b.w + 845 * s + idx, a: b.a + 150 * s, d: Math.max(b.d, DESC * s) })];
    }
    case 'accent': {
      const b = measureSeq(n.body, s);
      return [struct({ w: b.w + 105 * s, a: b.a + 200 * s, d: b.d })];
    }
    case 'lr': {
      const b = measureSeq(n.body, s);
      if (!useLR(n)) return seqAtoms(seqOf([delimNode(n.l), ...n.body.items, delimNode(n.r)].filter(Boolean)), s);
      const dw = (c) => (c === '(' || c === ')' ? 375 : 525) * s;
      return [struct({ w: b.w + dw(n.l) + dw(n.r), a: Math.max(b.a, ASC * s), d: Math.max(b.d, DESC * s) })];
    }
    case 'env':
      return [struct(measureEnv(n, s))];
    case 'script':
      return scriptAtoms(n, s);
    default:
      return []; // amp, rowsep
  }
}

function scriptAtoms(n, s) {
  const baseAtoms = nodeAtoms(n.base, s);
  // 90^{\circ} → 90 DEG, f^{\prime} → f prime : 뒤에 기호 하나
  if (!n.sub && (onlySym(n.sup, 'circ') || onlySym(n.sup, 'prime'))) return [...baseAtoms, atom(px(onlySym(n.sup, 'circ') ? 825 : 300, s), s)];
  const base = baseAtoms.length === 1 ? baseAtoms[0] : { ...hstack(baseAtoms, s), cls: 'ord', upper: baseAtoms[baseAtoms.length - 1].upper };
  const t = s === 1 ? SUB : s * 0.6; // 첨자의 첨자는 더 작게(0.42)
  const sup = n.sup ? measureSeq(n.sup, t) : null;
  const sub = n.sub ? measureSeq(n.sub, t) : null;
  const out = { cls: base.cls === 'fn' ? 'fn' : 'ord', k: 1 / SUB };
  const big = base.big;
  if (big && !big[3]) {
    // 합·곱·극한: 한계를 아래위에
    return [{ ...out, w: Math.max(base.w, sup?.w || 0, sub?.w || 0), a: base.a + (sup ? sup.a + sup.d : 0), d: base.d + (sub ? sub.a + sub.d : 0) }];
  }
  if (big) {
    // 적분: 한계를 옆에
    return [{ ...out, w: base.w + Math.max(sup?.w || 0, sub?.w || 0), a: base.a + (sup ? (sup.a + sup.d) / 2 : 0), d: base.d + (sub ? (sub.a + sub.d) / 2 : 0) }];
  }
  const rise = sup ? Math.max(447 * s, base.a - 430 * s, 350 * s + sup.d) : 0;
  const drop = sub ? Math.max(235 * s, sub.a - 353 * s) : 0;
  const supW = sup ? sup.w + (base.upper ? 150 * s : 0) : 0;
  return [
    {
      ...out,
      w: base.w + Math.max(supW, sub?.w || 0),
      a: Math.max(base.a, sup ? rise + sup.a : 0),
      d: Math.max(base.d, sub ? drop + sub.d : 0),
    },
  ];
}

function measureEnv(n, s) {
  const pile = PILES.has(n.kw);
  const rows = n.rows.map((cells) => (pile ? [measureSeq(seqOf(cells.flatMap((c) => c.items)), s)] : cells.map((c) => measureSeq(c, s))));
  const cols = Math.max(...rows.map((r) => r.length));
  const colW = Array.from({ length: cols }, (_, j) => Math.max(0, ...rows.map((r) => r[j]?.w || 0)));
  const rowH = rows.map((r) => Math.max(ASC * s, ...r.map((c) => c.a)) + Math.max(DESC * s, ...r.map((c) => c.d)));
  const H = rowH.reduce((sum, x) => sum + x, 0) + 150 * s * (rows.length - 1);
  const fence = { cases: 525, pmatrix: 750, bmatrix: 1050, dmatrix: 1050 }[n.kw] || 0;
  const w = colW.reduce((sum, x) => sum + x, 0) + 200 * s * (cols - 1) + fence * s;
  return { w, a: H / 2 + AXIS * s, d: H / 2 - AXIS * s };
}

// ---------------------------------------------------------------------------

/** LaTeX → 한글 수식 스크립트 */
export function latexToHwpEq(latex) {
  return emitStr(parse(latex)).trim();
}

// 잰 값과 다를 수 있는 만큼의 여유: 넓은 쪽이 겹치는 것보다 낫습니다
const SLACK_W = 0.03;
const SLACK_W_MIN = 90;
const SLACK_D = 30;

/**
 * LaTeX → 한글 수식 스크립트 + 한글 문서에 넣을 크기
 * @param {string} latex
 * @param {{baseUnit?:number}} opts  글자 크기(HWPUNIT, 1000 = 10pt)
 * @returns {{script:string, width:number, height:number, baseLine:number}} width/height: HWPUNIT, baseLine: 위에서 기준선까지 %
 */
export function convertLatex(latex, { baseUnit = 1000 } = {}) {
  const tree = parse(latex);
  const script = emitStr(tree).trim();
  const m = measureSeq(tree, 1);
  const k = baseUnit / 1000;
  const a = m.a;
  const d = m.d + SLACK_D;
  return {
    script,
    width: Math.ceil((m.w + Math.max(SLACK_W_MIN, m.w * SLACK_W)) * k),
    height: Math.round((a + d) * k),
    baseLine: Math.round((a / (a + d)) * 100),
  };
}
