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
// 4) 대략적인 크기 (글자 크기 = 1)
// ---------------------------------------------------------------------------
const AXIS = 0.27; // 분수 선 높이
const BOX = (w, a = 0.78, d = 0.22) => ({ w, a, d });

function charWidth(ch) {
  if (HANGUL_RE.test(ch) || /[　-鿿]/.test(ch)) return 0.92;
  if (/[ijlft]/.test(ch)) return 0.3;
  if (/[mw]/.test(ch)) return 0.72;
  if (/[MW]/.test(ch)) return 0.85;
  if (/[A-Z]/.test(ch)) return 0.64;
  if (/[a-z0-9]/.test(ch)) return 0.5;
  if (ch === ' ') return 0.3;
  if (/[.,:;'`!|]/.test(ch)) return 0.28;
  if (/[()[\]]/.test(ch)) return 0.36;
  return 0.6;
}

const textWidth = (s) => [...s].reduce((w, ch) => w + charWidth(ch), 0);

function measureSym(n) {
  const v = n.v;
  if (n.big) return v === 'int' || v === 'oint' || v === 'int int' ? BOX(v === 'int int' ? 1.1 : 0.62, 1.0, 0.42) : BOX(1.1, 0.95, 0.35);
  if (n.k === 'open' || n.k === 'close') return BOX(0.38, 0.8, 0.25);
  if (n.k === 'punct') return BOX(v === ',' || v === ';' ? 0.45 : 0.28);
  if (n.k === 'text') return BOX(textWidth(v.replace(/"/g, '')));
  if (/^(->|<-|<->|⇒|⇐|⇔)$/.test(v)) return BOX(1.15, 0.7, 0.1);
  if (/^(cdots|ldots)$/.test(v)) return BOX(1.05, 0.5, 0.05);
  if (/^(vdots|ddots)$/.test(v)) return BOX(0.6, 0.85, 0.1);
  if (v === 'prime' || v === 'DEG') return BOX(0.3, 0.8, 0);
  if (v === 'lbrace' || v === 'rbrace') return BOX(0.45, 0.8, 0.25);
  if (n.k === 'kw' && FN.has(v)) return BOX(textWidth(v) * 0.92 + 0.18);
  if (n.k === 'kw' && Object.values(GREEK).includes(v)) return BOX(/^[A-Z]/.test(v) ? 0.66 : 0.56);
  if (n.k === 'kw' && v === 'inf') return BOX(0.85, 0.55, 0.05);
  if (n.k === 'kw' || n.k === 'op') return v.length === 1 && /[A-Za-z0-9]/.test(v) ? BOX(0.55) : v === '|' ? BOX(0.3, 0.8, 0.25) : BOX(0.82, 0.62, 0.12);
  return BOX(textWidth(v));
}

function hstack(boxes) {
  if (!boxes.length) return BOX(0, 0.7, 0.2);
  return { w: boxes.reduce((s, b) => s + b.w, 0), a: Math.max(...boxes.map((b) => b.a)), d: Math.max(...boxes.map((b) => b.d)) };
}

const measureSeq = (seq) => hstack(seq.items.map(measure));

function measure(n) {
  switch (n.t) {
    case 'seq':
    case 'inline':
      return measureSeq(n.t === 'seq' ? n : seqOf(n.items));
    case 'letter':
      return BOX(charWidth(n.v) + 0.04);
    case 'num':
      return BOX(textWidth(n.v), 0.72, 0.02);
    case 'text':
      return BOX(textWidth(n.v) + 0.1);
    case 'sym':
      return measureSym(n);
    case 'space':
      return BOX([...n.v].reduce((w, c) => w + (c === '~' ? 0.32 : 0.14), 0), 0, 0);
    case 'group':
      return measureSeq(n.body);
    case 'frac': {
      const nu = measureSeq(n.num);
      const de = measureSeq(n.den);
      return { w: Math.max(nu.w, de.w) + 0.3, a: AXIS + 0.12 + nu.a + nu.d, d: de.a + de.d + 0.12 - AXIS };
    }
    case 'binom': {
      const nu = measureSeq(n.n);
      const de = measureSeq(n.k);
      return { w: Math.max(nu.w, de.w) + 1.0, a: AXIS + 0.1 + nu.a + nu.d, d: de.a + de.d + 0.1 - AXIS };
    }
    case 'sqrt': {
      const b = measureSeq(n.body);
      const idx = n.index ? measureSeq(n.index).w * 0.62 : 0;
      return { w: b.w + 0.78 + Math.max(0, idx - 0.25), a: Math.max(b.a, 0.72) + 0.2, d: b.d + 0.06 };
    }
    case 'accent': {
      const b = measureSeq(n.body);
      return { w: b.w + 0.08, a: b.a + 0.28, d: b.d };
    }
    case 'lr': {
      const b = measureSeq(n.body);
      if (!useLR(n)) return hstack([n.l, n.r].map((d) => (d === '.' ? BOX(0) : BOX(0.4, 0.8, 0.25))).concat(b));
      return { w: b.w + 0.8, a: Math.max(b.a, 0.8) + 0.08, d: Math.max(b.d, 0.25) + 0.08 };
    }
    case 'env':
      return measureEnv(n);
    case 'script':
      return measureScript(n);
    default:
      return BOX(0, 0, 0);
  }
}

function measureScript(n) {
  const b = measure(n.base);
  if (!n.sub && (onlySym(n.sup, 'circ') || onlySym(n.sup, 'prime'))) return { ...b, w: b.w + 0.32 };
  const S = 0.7;
  const sup = n.sup ? measureSeq(n.sup) : null;
  const sub = n.sub ? measureSeq(n.sub) : null;
  // 합·곱·극한은 한계를 아래위에
  if (n.base.t === 'sym' && n.base.limits) {
    return {
      w: Math.max(b.w, (sup?.w || 0) * S, (sub?.w || 0) * S) + 0.1,
      a: b.a + (sup ? (sup.a + sup.d) * S + 0.06 : 0),
      d: b.d + (sub ? (sub.a + sub.d) * S + 0.06 : 0),
    };
  }
  const supTop = sup ? Math.max(0.42, b.a - 0.32) + (sup.a + sup.d) * S : 0;
  const subBottom = sub ? 0.22 + (sub.a * 0.35 + sub.d) * S : 0;
  return {
    w: b.w + Math.max(sup?.w || 0, sub?.w || 0) * S + 0.06,
    a: Math.max(b.a, supTop),
    d: Math.max(b.d, subBottom),
  };
}

function measureEnv(n) {
  const cells = n.rows.map((row) => row.map(measureSeq));
  const cols = Math.max(...cells.map((r) => r.length));
  const colW = Array.from({ length: cols }, (_, j) => Math.max(0, ...cells.map((r) => r[j]?.w || 0)));
  const rowH = cells.map((r) => Math.max(0.78, ...r.map((c) => c.a)) + Math.max(0.22, ...r.map((c) => c.d)) + 0.28);
  const H = rowH.reduce((s, x) => s + x, 0);
  const pile = PILES.has(n.kw);
  const w = (pile ? Math.max(...cells.map((r) => r.reduce((s, c) => s + c.w, 0))) : colW.reduce((s, x) => s + x, 0) + 1.0 * (cols - 1)) + (n.kw === 'matrix' || pile ? 0.2 : 0.9);
  return { w, a: H / 2 + AXIS, d: H / 2 - AXIS };
}

// ---------------------------------------------------------------------------

/** LaTeX → 한글 수식 스크립트 */
export function latexToHwpEq(latex) {
  return emitStr(parse(latex)).trim();
}

/**
 * LaTeX → 한글 수식 스크립트 + 한글 문서에 넣을 크기
 * @param {string} latex
 * @param {{baseUnit?:number}} opts  글자 크기(HWPUNIT, 1000 = 10pt)
 * @returns {{script:string, width:number, height:number, baseLine:number}} width/height: HWPUNIT, baseLine: 위에서 기준선까지 %
 */
export function convertLatex(latex, { baseUnit = 1000 } = {}) {
  const tree = parse(latex);
  const script = emitStr(tree).trim();
  const m = measureSeq(tree);
  const a = Math.max(m.a, 0.7);
  const d = Math.max(m.d, 0.18);
  return {
    script,
    width: Math.max(Math.round(baseUnit * 0.3), Math.round((m.w + 0.12) * baseUnit)),
    height: Math.round((a + d + 0.08) * baseUnit),
    baseLine: Math.round(((a + 0.04) / (a + d + 0.08)) * 100),
  };
}
