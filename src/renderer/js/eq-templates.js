import { parseEq } from './hwpeqview.js';

// 문법과 목록은 docs/hwp-equation.md B·C의 확인된 항목만 사용합니다.
const choices = (items) => items.map(([name, script]) => ({ name, script }));
export const TEMPLATE_GROUPS = [
  { id: 'fraction', name: '분수', key: 'Ctrl+O', items: choices([['분수', '{} over {}'], ['분수선 없이', '{} atop {}']]) },
  { id: 'root', name: '근호', key: 'Ctrl+R', items: choices([['제곱근', 'sqrt {}'], ['n제곱근', 'root {} of {}']]) },
  { id: 'script', name: '첨자', items: choices([['위 첨자', '{}^{}'], ['아래 첨자', '{}_{}'], ['양쪽 첨자', '{}_{}^{}']]) },
  { id: 'accent', name: '장식', key: 'Ctrl+D', items: choices([
    ['모자', 'hat {}'], ['반대 모자', 'check {}'], ['물결', 'tilde {}'], ['악센트', 'acute {}'], ['역방향 악센트', 'grave {}'],
    ['점', 'dot {}'], ['두 점', 'ddot {}'], ['윗줄', 'bar {}'], ['벡터', 'vec {}'], ['양방향 화살표', 'dyad {}'], ['밑줄', 'under {}'], ['호', 'arch {}'],
  ]) },
  { id: 'sum', name: '합', key: 'Ctrl+S', items: choices([['합', 'sum _{}^{}'], ['곱', 'prod _{}^{}'], ['합집합', 'union _{}^{}'], ['교집합', 'inter _{}^{}']]) },
  { id: 'integral', name: '적분', key: 'Ctrl+I', items: choices([
    ['적분', 'int _{}^{}'], ['폐곡선 적분', 'oint _{}^{}'], ['이중 적분', 'dint _{}^{}'], ['삼중 적분', 'tint _{}^{}'], ['이중 폐적분', 'odint _{}^{}'], ['삼중 폐적분', 'otint _{}^{}'],
  ]) },
  { id: 'limit', name: '극한', key: 'Ctrl+L', items: choices([['극한 lim', 'lim _{}'], ['극한 Lim', 'Lim _{}']]) },
  { id: 'relation', name: '상호 관계', key: 'Ctrl+E', items: choices([['위아래 설명', 'rel -> {} {}'], ['위 설명', 'buildrel -> {}']]) },
  { id: 'fence', name: '괄호', key: 'Ctrl+9', items: choices([
    ['소괄호', 'LEFT ( {} RIGHT )'], ['대괄호', 'LEFT [ {} RIGHT ]'], ['중괄호', 'LEFT { {} RIGHT }'], ['세로줄', 'LEFT | {} RIGHT |'],
    ['겹세로줄', 'LEFT VERT {} RIGHT VERT'], ['꺾쇠', 'LEFT < {} RIGHT >'], ['바닥', 'LEFT ⌊ {} RIGHT ⌋'], ['천장', 'LEFT ⌈ {} RIGHT ⌉'],
  ]) },
  { id: 'cases', name: '경우', key: 'Ctrl+0', items: choices([['두 가지 경우', 'cases {{} & {} # {} & {}}']]) },
  { id: 'pile', name: '세로 쌓기', key: 'Ctrl+P', items: choices([['가운데 쌓기', 'pile {{} # {}}'], ['왼쪽 쌓기', 'lpile {{} # {}}'], ['오른쪽 쌓기', 'rpile {{} # {}}']]) },
  { id: 'matrix', name: '행렬', key: 'Ctrl+M', items: choices([['괄호 없음', 'matrix'], ['소괄호 행렬', 'pmatrix'], ['대괄호 행렬', 'bmatrix'], ['세로줄 행렬', 'dmatrix']]) },
  { id: 'other', name: '기타 틀', items: choices([['줄 맞춘 식', 'eqalign {{} & {} # {} & {}}'], ['조합', '{} choose {}'], ['부정', 'not {}']]) },
];

const greek = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(' ');
export const SYMBOL_GROUPS = [
  { name: '그리스 소문자', commands: greek },
  { name: '그리스 대문자', commands: greek.map((s) => s[0].toUpperCase() + s.slice(1)) },
  { name: '그리스 기호', commands: 'ALEPH HBAR IMATH JMATH ELL LITER WP IMAG ANGSTROM vartheta varpi varsigma varupsilon varphi varepsilon MHO'.split(' ') },
  { name: '합·집합', commands: 'Sigma PROD COPROD INTER CAP SQCAP SQCUP OPLUS OMINUS OTIMES ODOT OSLASH SUBSET SUPSET SUBSETEQ SUPSETEQ IN OWNS notin SQSUBSET SQSUPSET SQSUBSETEQ SQSUPSETEQ UPLUS EMPTYSET'.split(' ') },
  { name: '관계', commands: 'LE LEQ GE GEQ << >> LLL >>> PREC SUCC ne neq != DOTEQ SIM APPROX SIMEQ CONG == EQUIV ASYMP PROPTO'.split(' ') },
  { name: '연산·논리', commands: 'PLUSMINUS MINUSPLUS times DIV DIVIDE CIRC BULLET DEG AST STAR BIGCIRC THEREFORE BECAUSE EXIST FORALL VEE WEDGE DIAMOND prime PARTIAL inf LNOT TRIANGLED DAGGER DDAGGER'.split(' ') },
  { name: '화살표', commands: 'larrow rarrow uparrow downarrow LARROW RARROW UPARROW DOWNARROW udarrow lrarrow UDARROW LRARROW nwarrow searrow nearrow swarrow hookleft hookright mapsto vert VERT'.split(' ') },
  { name: '기타 기호', commands: 'cdots LDOTS VDOTS DDOTS TRIANGLE TRIANGLED ANGLE MSANGLE SANGLE RTANGLE VDASH BOT TOP MODELS CENTIGRADE FAHRENHEIT'.split(' ') },
  { name: '함수', commands: 'sin cos tan cot sec cosec csc arcsin arccos arctan arc sinh cosh tanh coth log ln lg lim Lim max min exp Exp det gcd mod if for and hom ker deg arg dim Pr or'.split(' ') },
];

export function matrixTemplate(kind = 'matrix', rows = 2, columns = 2) {
  if (!['matrix', 'pmatrix', 'bmatrix', 'dmatrix'].includes(kind)) throw new Error('행렬 종류를 고르세요.');
  if (![rows, columns].every((n) => Number.isInteger(n) && n >= 1 && n <= 10)) throw new Error('줄과 칸은 1~10개로 고르세요.');
  return `${kind} {${Array.from({ length: rows }, () => Array(columns).fill('{}').join(' & ')).join(' # ')}}`;
}

/** 파서의 실제 칸 위치를 씁니다. 따옴표 안의 중괄호는 칸이 아닙니다. */
export function findSlots(script) {
  const slots = [];
  const visit = (node, argument = false) => {
    const before = slots.length;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'spec') continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (!child?.type) continue;
        const arg = node.type === 'cell' || ['fraction', 'root', 'accent', 'negation', 'script', 'relation'].includes(node.type) && !['operator', 'function'].includes(child.type);
        visit(child, arg && key !== 'base' || node.type === 'script' && key === 'base' && child.type === 'identifier');
      }
    }
    if (slots.length !== before) return;
    if (node.type === 'group') slots.push({ start: node.start + 1, end: node.end - 1 });
    else if (argument && !['style', 'raw'].includes(node.type)) slots.push({ start: node.start, end: node.end });
  };
  visit(parseEq(script));
  return slots.sort((a, b) => a.start - b.start || a.end - b.end).filter((slot, i, list) => !i || slot.start !== list[i - 1].start || slot.end !== list[i - 1].end);
}

export function moveSlot(script, start, end = start, backward = false) {
  const slots = findSlots(script);
  const current = slots.findIndex((slot) => start >= slot.start && end <= slot.end);
  const next = current < 0
    ? backward ? slots.findLast((slot) => slot.end < start) : slots.find((slot) => slot.start > end)
    : slots[current + (backward ? -1 : 1)];
  if (!backward && !next) {
    const tree = parseEq(script);
    const font = tree.type === 'sequence' ? tree.children.findLast((node) => node.type === 'style')?.font : null;
    const suffix = ['bold', 'rmbold'].includes(font) ? `${/\s$/.test(script) ? '' : ' '}rm `
      : current >= 0 && slots[current].end === script.length && !/\s$/.test(script) ? ' ' : '';
    if (suffix) return { script: script + suffix, start: script.length + suffix.length, end: script.length + suffix.length };
  }
  return next || { start: backward ? 0 : script.length, end: backward ? 0 : script.length };
}

/** 처음부터 빈 {}를 사용하므로 사용자가 쓴 □ 같은 진짜 기호는 지우지 않습니다. */
export function cleanScript(script) { return String(script ?? ''); }

export function insertTemplate(source, start, end, template) {
  let text = template;
  let slot = findSlots(text)[0];
  const selected = source.slice(start, end);
  if (slot && selected) text = text.slice(0, slot.start) + selected + text.slice(slot.end);
  slot = findSlots(text)[0];
  // 낱말이 명령과 붙지 않게 구분하고, 분수의 좌우 식 범위는 새 틀 안에 한정합니다.
  if (/\b(?:over|atop|choose)\b/.test(template) && (source.slice(0, start).trim() || source.slice(end).trim())) {
    text = `{${text}}`;
    if (slot) slot = { start: slot.start + 1, end: slot.end + 1 };
  }
  const left = /[\p{L}\p{N}]$/u.test(source.slice(0, start)) && /^[\p{L}\p{N}]/u.test(text) ? ' ' : '';
  const right = /[\p{L}\p{N}]$/u.test(text) && /^[\p{L}\p{N}]/u.test(source.slice(end)) ? ' ' : '';
  const inserted = left + text + right;
  const offset = start + left.length;
  return {
    script: source.slice(0, start) + inserted + source.slice(end),
    start: slot ? offset + slot.start : start + inserted.length,
    end: slot ? offset + slot.end : start + inserted.length,
    insertedEnd: start + inserted.length,
  };
}
