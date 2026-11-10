// 한글 수식 스크립트 → 위치를 보존한 구문 트리 / MathML Core / 검색용 평문.
// 공식 문법, 호환 확장과 확인하지 못한 부분은 docs/hwp-equation.md에 기록합니다.

const GREEK_NAMES = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(' ');
const GREEK = Object.fromEntries(GREEK_NAMES.map((name, i) => [name, [...'αβγδεζηθικλμνξοπρστυφχψω'][i]]));
const SYMBOLS = {
  times: '×', div: '÷', divide: '÷', cdot: '⋅', circ: '∘', bullet: '∙', ast: '∗', star: '⋆', bigcirc: '○',
  plusminus: '±', minusplus: '∓', pm: '±', mp: '∓', '+-': '±', '-+': '∓',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', '<=': '≤', '>=': '≥', '!=': '≠',
  lt: '<', gt: '>', ll: '≪', gg: '≫', '<<': '≪', '>>': '≫', lll: '⋘', '<<<': '⋘', '>>>': '⋙',
  equiv: '≡', '==': '≡', doteq: '≐', sim: '∼', approx: '≈', simeq: '≃', cong: '≅', asymp: '≍', propto: '∝',
  prec: '≺', succ: '≻', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  sqsubset: '⊏', sqsupset: '⊐', sqsubseteq: '⊑', sqsupseteq: '⊒', in: '∈', owns: '∋', notin: '∉',
  cup: '∪', cap: '∩', sqcap: '⊓', sqcup: '⊔', uplus: '⊎', emptyset: '∅',
  oplus: '⊕', ominus: '⊖', otimes: '⊗', odot: '⊙', oslash: '⊘', vee: '∨', wedge: '∧',
  forall: '∀', exist: '∃', exists: '∃', lnot: '¬', therefore: '∴', because: '∵',
  inf: '∞', partial: '∂', nabla: '∇', prime: '′', dagger: '†', ddagger: '‡',
  triangle: '△', triangled: '▽', angle: '∠', msangle: '∡', sangle: '∢', rtangle: '∟',
  vdash: '⊢', bot: '⊥', perp: '⊥', top: '⊤', models: '⊨', parallel: '∥',
  cdots: '⋯', ldots: '…', vdots: '⋮', ddots: '⋱', diamond: '◇', box: '□',
  aleph: 'ℵ', hbar: 'ℏ', imath: 'ı', jmath: 'ȷ', ell: 'ℓ', liter: 'ℓ', wp: '℘', imag: 'ℑ',
  angstrom: 'Å', mho: '℧', centigrade: '℃', fahrenheit: '℉',
  vartheta: 'ϑ', varpi: 'ϖ', varsigma: 'ς', varupsilon: 'ϒ', varphi: 'ϕ', varepsilon: 'ϵ',
  larrow: '←', rarrow: '→', uparrow: '↑', downarrow: '↓', udarrow: '↕', lrarrow: '↔',
  nwarrow: '↖', searrow: '↘', nearrow: '↗', swarrow: '↙', hookleft: '↩', hookright: '↪', mapsto: '↦',
  '->': '→', '<-': '←', '<->': '↔', '=>': '⇒', '<=>': '⇔',
  lbrace: '{', rbrace: '}', langle: '〈', rangle: '〉', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', vert: '|',
  smallunion: '∪', smallinter: '∩', smallprod: '∏', smallsum: '∑',
};
const EXACT_SYMBOLS = {
  LARROW: '⇐', RARROW: '⇒', UPARROW: '⇑', DOWNARROW: '⇓', UDARROW: '⇕', LRARROW: '⇔', VERT: '‖', DEG: '°',
};
const BIG = { sum: '∑', prod: '∏', coprod: '∐', union: '⋃', inter: '⋂', int: '∫', oint: '∮', dint: '∬', tint: '∭', odint: '∯', otint: '∰' };
const FUNCTIONS = new Set('sin cos tan cot sec cosec csc arcsin arccos arctan arc sinh cosh tanh coth log ln lg exp Exp lim Lim max min det gcd mod if for and hom ker deg arg dim Pr or'.split(' '));
const ACCENTS = { hat: '^', check: 'ˇ', tilde: '~', acute: '´', grave: '`', dot: '˙', ddot: '¨', bar: '¯', vec: '→', dyad: '↔', under: '_', arch: '⏜' };
const TABLES = new Set(['matrix', 'pmatrix', 'bmatrix', 'dmatrix', 'pile', 'lpile', 'rpile', 'cases', 'eqalign']);
const FONTS = new Set(['rm', 'it', 'bold', 'rmbold', 'bf']);
const UNSUPPORTED = new Set('longdiv ladder sladder phantom identical image reimage iso dsum xor hleft laplace lslant rslant att hund thou well base benzene ohm'.split(' '));
const SCRIPT_KEYS = { '^': 'sup', sup: 'sup', to: 'sup', '_': 'sub', sub: 'sub', from: 'sub', lsup: 'lsup', lsub: 'lsub' };
const INFIX = new Set(['over', 'atop', 'choose']);
const CLOSE = new Set(['}', ')', ']']);
const MAX_DEPTH = 96;
const has = (obj, key) => Object.hasOwn(obj, key);
const make = (type, start, end, extra = {}) => ({ type, start, end, error: false, ...extra });
const sequence = (children, start, end) => make('sequence', start, end, { children });

function symbol(word) {
  if (has(EXACT_SYMBOLS, word)) return EXACT_SYMBOLS[word];
  const lower = word.toLowerCase();
  if (has(GREEK, lower)) return word[0] === word[0].toUpperCase() ? GREEK[lower].toUpperCase() : GREEK[lower];
  return has(SYMBOLS, lower) ? SYMBOLS[lower] : undefined;
}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/u.test(source[i])) { i++; continue; }
    const start = i;
    let value;
    let kind = 'char';
    let closed = true;
    if (source[i] === '"') {
      kind = 'text';
      const end = source.indexOf('"', i + 1);
      closed = end !== -1;
      i = closed ? end + 1 : source.length;
      value = source.slice(start + 1, closed ? i - 1 : i);
    } else {
      const rest = source.slice(i);
      value = /^(?:<->|<=>|<<<|>>>|<=|>=|!=|==|->|<-|=>|\+-|-\+|<<|>>)/.exec(rest)?.[0];
      if (!value && /^[A-Za-z]/.test(rest)) {
        kind = 'word';
        value = /^[A-Za-z]+/.exec(rest)[0];
      }
      if (!value && /^(?:\d|\.\d)/.test(rest)) {
        kind = 'number';
        value = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(rest)[0];
      }
      if (!value && /^[ᄀ-ᇿ㄰-㆏가-힯\p{Script=Han}]/u.test(rest)) {
        kind = 'text';
        value = /^[ᄀ-ᇿ㄰-㆏가-힯\p{Script=Han}]+/u.exec(rest)[0];
      }
      value ||= String.fromCodePoint(source.codePointAt(i));
      i += value.length;
    }
    tokens.push({ kind, value, key: value.toLowerCase(), start, end: i, closed });
  }
  return tokens;
}

class Parser {
  constructor(source) {
    this.source = source;
    this.tokens = tokenize(source);
    this.i = 0;
    this.depth = 0;
    this.errors = [];
  }

  peek() { return this.tokens[this.i]; }
  pos() { return this.peek()?.start ?? this.source.length; }
  end() { return this.tokens[this.i - 1]?.end ?? 0; }
  at(key) { return this.peek()?.key === key; }
  stopped(stops) { return !this.peek() || stops.has(this.peek().key); }

  issue(code, start, end, severity = 'error') {
    this.errors.push({ code, start, end, severity });
  }

  raw(start, end, code) {
    this.issue(code, start, end);
    return make('raw', start, end, { value: this.source.slice(start, end), error: true });
  }

  guarded(read, stops) {
    if (this.depth >= MAX_DEPTH) {
      const start = this.pos();
      while (!this.stopped(stops)) this.i++;
      return this.raw(start, Math.max(start, this.end()), 'depth-limit');
    }
    this.depth++;
    try { return read(); } finally { this.depth--; }
  }

  layout(stops = new Set()) {
    const start = this.pos();
    const rows = [];
    let cells = [];
    let rowStart = start;
    let separated = false;
    const bounds = new Set([...stops, '#', '&']);
    for (;;) {
      const cellStart = this.pos();
      const body = this.expression(bounds);
      cells.push(make('cell', cellStart, body.end, { body }));
      if (!this.at('&') && !this.at('#')) break;
      separated = true;
      const sep = this.tokens[this.i++];
      if (sep.key === '#') {
        rows.push(make('row', rowStart, sep.start, { cells }));
        cells = [];
        rowStart = sep.end;
      }
    }
    const end = cells[cells.length - 1].end;
    rows.push(make('row', rowStart, end, { cells }));
    return separated ? make('table', start, end, { kind: 'eqalign', rows }) : cells[0].body;
  }

  expression(stops) {
    return this.guarded(() => {
      const start = this.pos();
      const children = [];
      while (!this.stopped(stops)) {
        const token = this.peek();
        if (['bigg', 'big'].includes(token.key) && children.length) {
          const operator = this.atom(stops);
          const right = this.expression(stops);
          return sequence([...children, operator, right], start, right.end);
        }
        if (INFIX.has(token.key)) {
          this.i++;
          const numerator = sequence([...children], start, token.start);
          const denominator = this.expression(new Set([...stops, 'bigg', 'big']));
          const result = make('fraction', start, denominator.end, { numerator, denominator, kind: token.key });
          if (!children.length || denominator.start === denominator.end) {
            this.issue('missing-argument', token.start, token.end);
            result.error = true;
          }
          children.splice(0, children.length, result);
          if (['bigg', 'big'].includes(this.peek()?.key) && !this.stopped(stops)) continue;
          return sequence(children, start, result.end);
        }
        const before = this.i;
        children.push(this.scripts(this.atom(stops), stops));
        if (this.i === before) children.push(this.raw(token.start, this.tokens[this.i++].end, 'unexpected-token'));
      }
      return sequence(children, start, children.length ? children[children.length - 1].end : start);
    }, stops);
  }

  argument(stops) {
    return this.guarded(() => {
      if (this.stopped(stops) || ['#', '&', '}', 'right', 'of'].includes(this.peek()?.key) || INFIX.has(this.peek()?.key) || has(SCRIPT_KEYS, this.peek()?.key)) {
        const pos = this.pos();
        this.issue('missing-argument', pos, pos);
        return make('empty', pos, pos, { error: true });
      }
      const first = this.atom(stops);
      if (first.type === 'style' || (first.type === 'operator' && ['+', '-'].includes(first.value))) {
        const body = this.argument(stops);
        return sequence([first, body], first.start, body.end);
      }
      return first;
    }, stops);
  }

  scripts(base, stops) {
    let count = 0;
    while (!this.stopped(stops) && has(SCRIPT_KEYS, this.peek()?.key)) {
      const token = this.tokens[this.i++];
      if (++count > MAX_DEPTH) {
        while (!this.stopped(stops)) this.i++;
        return this.raw(base.start, this.end(), 'depth-limit');
      }
      const key = SCRIPT_KEYS[token.key];
      const arg = this.argument(stops);
      if (base.type !== 'script') base = make('script', base.start, arg.end, { base });
      if (base[key]) {
        // 중괄호 없는 반복 첨자는 오른쪽부터 묶고, 반대쪽 첨자는 원래 밑에 붙입니다.
        let tail = base;
        while (tail[key]?.type === 'script') {
          tail = tail[key];
          tail.end = arg.end;
        }
        const previous = tail[key];
        tail[key] = make('script', previous.start, arg.end, { base: previous, [key]: arg });
      } else base[key] = arg;
      base.end = Math.max(token.end, arg.end);
      if (token.key === 'from' || token.key === 'to') base.legacy = true;
    }
    return base;
  }

  atom(stops) {
    return this.guarded(() => this.readAtom(stops), stops);
  }

  readAtom(stops) {
    const token = this.tokens[this.i++];
    if (!token) return make('empty', this.source.length, this.source.length);
    const { start, end, value, key, kind } = token;
    if (kind === 'text') return token.closed ? make('text', start, end, { value }) : this.raw(start, end, 'unclosed-quote');
    if (kind === 'number') return make('number', start, end, { value });
    if (value === '{' || value === '(' || value === '[') {
      const close = { '{': '}', '(': ')', '[': ']' }[value];
      const body = this.layout(new Set([...stops, ...CLOSE, 'right']));
      if (!this.at(close)) return this.raw(start, Math.max(end, this.end()), 'unclosed-group');
      this.i++;
      return make(value === '{' ? 'group' : 'fence', start, this.end(), { body, left: value, right: close, stretchy: false });
    }
    if (key === 'left') {
      const left = this.delimiter();
      const body = this.layout(new Set([...stops, 'right']));
      if (!this.at('right')) return this.raw(start, Math.max(end, this.end()), 'missing-right');
      this.i++;
      const right = this.delimiter();
      if (left === null || right === null) return this.raw(start, this.end(), 'invalid-delimiter');
      return make('fence', start, this.end(), { left, right, body, stretchy: true });
    }
    if (CLOSE.has(key) || ['right', 'of', 'col', 'lcol', 'rcol'].includes(key)) return this.raw(start, end, 'unexpected-token');
    if (has(SCRIPT_KEYS, key)) {
      // 왼쪽 첨자용 빈 밑도 커서 위치를 가진 노드로 남깁니다.
      this.i--;
      return make('empty', start, start);
    }
    if (key === 'sqrt' || key === 'root') {
      let index;
      if (key === 'root') {
        index = this.argument(stops);
        if (!this.at('of')) return this.raw(start, this.end(), 'missing-of');
        this.i++;
      }
      const body = this.argument(stops);
      return make('root', start, body.end, { body, ...(index ? { index } : {}) });
    }
    if (key === 'binom') {
      const numerator = this.argument(stops);
      const denominator = this.argument(stops);
      return make('fraction', start, denominator.end, { numerator, denominator, kind: 'choose' });
    }
    if (has(ACCENTS, key) || key === 'not') {
      const body = this.argument(stops);
      return make(key === 'not' ? 'negation' : 'accent', start, body.end, { body, kind: key });
    }
    if (key === 'rel' || key === 'buildrel') {
      const base = this.argument(stops);
      const sup = this.argument(stops);
      const sub = key === 'rel' ? this.argument(stops) : null;
      return make('relation', start, sub?.end ?? sup.end, { base, sup, sub });
    }
    if (TABLES.has(key)) return this.table(token, stops);
    if (FONTS.has(key) || value === '\\' || value === '＼') return make('style', start, end, { font: FONTS.has(key) ? key : 'rm' });
    if (key === 'color') {
      const spec = this.argument(stops);
      const raw = this.source.slice(spec.start, spec.end);
      const match = /^\{\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\}$/.exec(raw);
      if (!match || match.slice(1).some(v => Number(v) > 255)) return this.raw(start, spec.end, 'invalid-color');
      const body = this.argument(stops);
      return make('color', start, body.end, { spec, body, color: `rgb(${match.slice(1).map(Number).join(',')})` });
    }
    if (key === 'size' || key === 'scale') {
      const spec = this.argument(stops);
      const number = Number(this.source.slice(spec.start, spec.end).replace(/[{}]/g, ''));
      if (!Number.isFinite(number) || number <= 0 || number > 512) return this.raw(start, spec.end, 'invalid-size');
      const body = this.argument(stops);
      return make('size', start, body.end, { spec, body, size: number, unit: key === 'size' ? 'pt' : '%', extension: true });
    }
    if (key === 'bigg' || key === 'big') {
      const delimiter = this.delimiter();
      return delimiter === null ? this.raw(start, end, 'invalid-delimiter') : make('operator', start, this.end(), { value: delimiter, enlarged: true });
    }
    if (value === '~' || value === '`') return make('space', start, end, { width: value === '~' ? 0.5 : 0.125 });
    if (FUNCTIONS.has(value)) return make('function', start, end, { value, limits: ['lim', 'Lim', 'max', 'min'].includes(value) });
    if (has(BIG, key)) return make('operator', start, end, { value: BIG[key], large: true, limits: !key.endsWith('int') });
    if (UNSUPPORTED.has(key)) return this.raw(start, end, 'unsupported-command');
    const glyph = symbol(value);
    if (glyph !== undefined) return make(has(GREEK, key) || key.startsWith('var') ? 'identifier' : 'operator', start, end, { value: glyph });
    if (kind === 'word') {
      // 대문자 점 이름(프라임은 별도 토큰)과 overline 표기는 허용하고, 소문자 명령 오타는 경고합니다.
      const unknown = value.length > 1;
      if (unknown && !/^[A-Z]+$/.test(value) && key !== 'overline') this.issue('unknown-word', start, end, 'warning');
      return make('identifier', start, end, { value, unknown });
    }
    return make(/[\p{L}]/u.test(value) ? 'identifier' : 'operator', start, end, { value: value === "'" ? '′' : value });
  }

  delimiter() {
    const token = this.peek();
    if (!token) return null;
    const glyph = symbol(token.value) ?? token.value;
    if (!['.', '(', ')', '[', ']', '{', '}', '|', '‖', '/', '\\', '<', '>', '〈', '〉', '⌊', '⌋', '⌈', '⌉', '↑', '↓', '↕', '⇑', '⇓', '⇕'].includes(glyph)) return null;
    this.i++;
    return glyph === '.' ? '' : { '<': '〈', '>': '〉' }[glyph] ?? glyph;
  }

  table(token, stops) {
    if (!this.at('{')) return this.raw(token.start, token.end, 'missing-table-body');
    this.i++;
    const bounds = new Set([...stops, '}']);
    let rows;
    let columns;
    if (['col', 'lcol', 'rcol'].includes(this.peek()?.key)) {
      columns = [];
      while (['col', 'lcol', 'rcol'].includes(this.peek()?.key)) {
        const col = this.tokens[this.i++];
        const body = this.argument(bounds);
        const layout = body.body ?? body;
        const cells = layout.type === 'table' ? layout.rows.map(row => row.cells[0]) : [make('cell', body.start, body.end, { body: layout })];
        columns.push({ align: { col: 'center', lcol: 'left', rcol: 'right' }[col.key], cells });
      }
      const count = Math.max(...columns.map(col => col.cells.length));
      rows = Array.from({ length: count }, (_, i) => {
        const cells = columns.map(col => col.cells[i] ?? make('cell', this.pos(), this.pos(), { body: make('empty', this.pos(), this.pos()) }));
        return make('row', Math.min(...cells.map(cell => cell.start)), Math.max(...cells.map(cell => cell.end)), { cells });
      });
    } else {
      const body = this.layout(bounds);
      rows = body.type === 'table' ? body.rows : [make('row', body.start, body.end, { cells: [make('cell', body.start, body.end, { body })] })];
    }
    if (!this.at('}')) return this.raw(token.start, this.end(), 'unclosed-table');
    this.i++;
    return make('table', token.start, this.end(), { kind: token.key, rows, ...(columns ? { align: columns.map(col => col.align) } : {}) });
  }
}

/** 원문 위치는 자바스크립트 문자열의 UTF-16 인덱스이며 end는 포함하지 않습니다. */
export function parseEq(script) {
  const source = String(script ?? '');
  const parser = new Parser(source);
  const tree = parser.layout();
  tree.start = 0;
  tree.end = source.length;
  // 오류를 부모에도 전파하되, 경고(일반 변수일 수도 있는 낱말)는 오류로 승격하지 않습니다.
  const visit = node => {
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === 'object' && child.type) {
          visit(child);
          node.error ||= child.error;
        }
      }
    }
  };
  visit(tree);
  tree.errors = parser.errors;
  return tree;
}

function escapeXML(value) {
  return String(value).toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '�')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const tag = (name, body, attributes = '') => `<${name}${attributes}>${body}</${name}>`;
const fence = (value, stretchy = true) => value ? tag('mo', escapeXML(value), ` stretchy="${stretchy}" fence="true"`) : '';
const weight = style => ['bold', 'rmbold', 'bf'].includes(style.font) ? ' style="font-weight:bold"' : '';

function render(node, style = {}) {
  const body = renderNode(node, style);
  if (!style.sourceMap || node.type === 'style') return body;
  const empty = node.type === 'empty' || node.type === 'sequence' && !node.children.length;
  return tag('mrow', empty ? '<mspace width="0.7em" height="0.8em" depth="0.2em"></mspace>' : body,
    ` data-eq-start="${node.start}" data-eq-end="${node.end}"${empty ? ' data-eq-empty="true"' : ''}`);
}

function renderNode(node, style = {}) {
  const draw = child => render(child, { ...style }) || '<mrow></mrow>';
  switch (node.type) {
    case 'sequence': {
      const local = { ...style };
      return tag('mrow', node.children.map(child => {
        if (child.type === 'style') { local.font = child.font; return ''; }
        return render(child, { ...local });
      }).join(''));
    }
    case 'empty': return '<mrow></mrow>';
    case 'style': return '';
    case 'raw':
    case 'text': {
      const properties = [/[\s]/u.test(node.value) ? 'white-space:pre' : '', weight(style) ? 'font-weight:bold' : ''].filter(Boolean);
      return tag('mtext', escapeXML(node.value), properties.length ? ` style="${properties.join(';')}"` : '');
    }
    case 'number': return tag('mn', escapeXML(node.value), weight(style));
    case 'identifier': {
      let attributes = '';
      if (style.font) {
        const roman = ['rm', 'rmbold'].includes(style.font);
        const bold = ['bold', 'rmbold', 'bf'].includes(style.font);
        attributes = ` mathvariant="normal" style="font-style:${roman ? 'normal' : 'italic'};font-weight:${bold ? 'bold' : 'normal'}"`;
      }
      const chars = [...node.value].map(ch => tag('mi', escapeXML(ch), attributes)).join('');
      return [...node.value].length > 1 ? tag('mrow', chars) : chars;
    }
    case 'function': return tag('mi', escapeXML(node.value), ' mathvariant="normal"' + weight(style));
    case 'operator': return tag('mo', escapeXML(node.value), weight(style) + (node.large ? ' largeop="true" movablelimits="false"' : node.enlarged ? ' stretchy="true" minsize="2em" maxsize="2em"' : ''));
    case 'space': return `<mspace width="${node.width}em"></mspace>`;
    case 'group': return draw(node.body);
    case 'fence': return tag('mrow', fence(node.left, node.stretchy) + draw(node.body) + fence(node.right, node.stretchy));
    case 'fraction': {
      const body = tag('mfrac', draw(node.numerator) + draw(node.denominator), node.kind === 'over' ? '' : ' linethickness="0"');
      return node.kind === 'choose' ? tag('mrow', fence('(') + body + fence(')')) : body;
    }
    case 'root': return tag(node.index ? 'mroot' : 'msqrt', draw(node.body) + (node.index ? draw(node.index) : ''));
    case 'script': {
      if (node.lsub || node.lsup) {
        const slot = child => child ? draw(child) : '<mrow></mrow>';
        return tag('mmultiscripts', draw(node.base) + slot(node.sub) + slot(node.sup) + '<mprescripts/>' + slot(node.lsub) + slot(node.lsup));
      }
      const under = node.base.limits;
      const name = node.sub && node.sup ? (under ? 'munderover' : 'msubsup') : node.sub ? (under ? 'munder' : 'msub') : (under ? 'mover' : 'msup');
      return tag(name, draw(node.base) + (node.sub ? draw(node.sub) : '') + (node.sup ? draw(node.sup) : ''));
    }
    case 'accent': {
      const under = node.kind === 'under';
      // Cambria Math의 선 굵기·간격에 맞추되 대체 글꼴의 장식 문자 폭에는 의존하지 않습니다.
      // em 단위라 분수·첨자에서도 본체와 함께 줄어듭니다.
      if (node.kind === 'bar' || under) {
        const edge = under ? 'bottom' : 'top';
        return tag('mrow', draw(node.body), ` style="border-${edge}:0.065em solid currentColor;padding-${edge}:0.17em"`);
      }
      return tag(under ? 'munder' : 'mover', draw(node.body) + tag('mo', escapeXML(ACCENTS[node.kind]), ' stretchy="true"'), ` ${under ? 'accentunder' : 'accent'}="true"`);
    }
    case 'negation': {
      const negatives = { '=': '≠', '∈': '∉', '∋': '∌', '⊂': '⊄', '⊃': '⊅', '⊆': '⊈', '⊇': '⊉', '≡': '≢', '∥': '∦', '<': '≮', '>': '≯' };
      const value = toText(node.body);
      const negated = has(negatives, value) ? negatives[value] : null;
      if (negated) return tag('mo', negated);
      // MathML Core에는 menclose가 없으므로 글자에는 결합 사선을 사용합니다.
      return tag('mtext', escapeXML(toText(node.body) + '\u0338'));
    }
    case 'relation': return tag(node.sub ? 'munderover' : 'mover', draw(node.base) + (node.sub ? draw(node.sub) : '') + draw(node.sup));
    case 'color': return tag('mstyle', draw(node.body), ` style="color:${node.color}"`);
    case 'size': return tag('mstyle', draw(node.body), ` style="font-size:${node.size}${node.unit}"`);
    case 'table': {
      const align = node.align ?? (node.kind === 'rpile' ? ['right'] : ['lpile', 'cases'].includes(node.kind) ? ['left'] : node.kind === 'eqalign' ? ['right', 'left'] : ['center']);
      const content = node.rows.map(row => tag('mtr', row.cells.map((cell, i) => tag('mtd', draw(cell.body), ` style="text-align:${align[i % align.length]}"`)).join(''))).join('');
      const body = tag('mtable', content);
      const pair = { pmatrix: ['(', ')'], bmatrix: ['[', ']'], dmatrix: ['|', '|'], cases: ['{', ''] }[node.kind];
      return pair ? tag('mrow', fence(pair[0]) + body + fence(pair[1])) : body;
    }
    default: return '<mrow></mrow>';
  }
}

/** DOM·외부 글꼴·실행 코드 없이 Chromium MathML Core에서 표시할 문자열을 만듭니다. */
export function eqToMathML(script, { display = false, sourceMap = false } = {}) {
  return tag('math', render(parseEq(script), { sourceMap }), ` xmlns="http://www.w3.org/1998/Math/MathML" display="${display ? 'block' : 'inline'}"`);
}

function toText(node) {
  const text = toText;
  const operand = child => {
    const value = text(child);
    return /[+\-=/\s]/.test(value) && value.length > 1 ? `(${value})` : value;
  };
  switch (node.type) {
    case 'sequence': return node.children.map((child, i) => text(child) + (child.type === 'function' && i < node.children.length - 1 ? ' ' : '')).join('');
    case 'empty':
    case 'style': return '';
    case 'group': return text(node.body);
    case 'fence': return node.left + text(node.body) + node.right;
    case 'fraction': return node.kind === 'choose' ? `(${text(node.numerator)} choose ${text(node.denominator)})` : node.kind === 'atop' ? `(${text(node.numerator)} atop ${text(node.denominator)})` : `${operand(node.numerator)}/${operand(node.denominator)}`;
    case 'root': return `${node.index ? `root[${text(node.index)}]` : '√'}${operand(node.body)}`;
    case 'script': return `${node.lsub ? `_(${text(node.lsub)})` : ''}${node.lsup ? `^(${text(node.lsup)})` : ''}${text(node.base)}${node.sub ? `_${operand(node.sub)}` : ''}${node.sup ? `^${operand(node.sup)}` : ''}`;
    case 'accent': return `${node.kind}(${text(node.body)})`;
    case 'negation': return `not(${text(node.body)})`;
    case 'relation': return `${text(node.base)}[${text(node.sup)}${node.sub ? `;${text(node.sub)}` : ''}]`;
    case 'color':
    case 'size': return text(node.body);
    case 'space': return ' ';
    case 'table': {
      const body = node.rows.map(row => row.cells.map(cell => text(cell.body)).join('\t')).join('\n');
      const pair = { pmatrix: ['(', ')'], bmatrix: ['[', ']'], dmatrix: ['|', '|'], cases: ['{', ''] }[node.kind];
      return pair ? pair[0] + body + pair[1] : body;
    }
    default: return node.value ?? '';
  }
}

/** 찾기·목록용 표현이며 원문으로의 역변환을 보장하는 직렬화 형식은 아닙니다. */
export function eqToText(script) {
  return toText(parseEq(script));
}
