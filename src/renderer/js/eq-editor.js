import { h, modal, confirmDialog, toast } from './ui.js';
import { api } from './shared.js';
import { eqToMathML, parseEq } from './hwpeqview.js';
import { TEMPLATE_GROUPS, SYMBOL_GROUPS, matrixTemplate, insertTemplate, moveSlot, cleanScript } from './eq-templates.js';
import { EQUATION_SHORTCUTS, TEMPLATE_KEYS } from './eq-shortcuts.js';

const MAX_LENGTH = 8000;
const macroKey = 'equation-macros';
const warn = (error) => toast(error.message || String(error), { type: 'error' });
const button = (name, key, onclick, attrs = {}) => h('button.btn.btn-small', { type: 'button', title: `${name}${key ? ` · ${key}` : ''}`, onclick, ...attrs }, name);

/** 본문은 확정할 때만 바꿉니다. 미리보기와 고르기 목록은 이 창의 초안만 다룹니다. */
export async function openEquationEditor({ eq = '', display = false, returnScope = '' } = {}) {
  const script = h('textarea.input.answer-equation-script', { rows: 4, maxlength: MAX_LENGTH, value: eq, spellcheck: false, 'aria-label': '한글 수식 스크립트' });
  const preview = h('div.answer-equation-preview', { tabindex: '0', 'aria-label': '바로 보이는 수식' });
  const warning = h('p.small.warn-text', { role: 'status' });
  const centered = h('input', { type: 'checkbox', checked: display });
  const panel = h('section.eq-picker', { hidden: true, 'aria-label': '틀과 기호 고르기' });
  let replacement = null;
  let composing = false;
  let dialog;
  const focus = (start = script.selectionStart, end = script.selectionEnd) => { script.focus(); script.setSelectionRange(start, end); };
  const closePanel = () => { panel.hidden = true; panel.replaceChildren(); replacement = null; };
  const paint = () => {
    preview.innerHTML = eqToMathML(script.value, { display: true, sourceMap: true });
    const errors = parseEq(script.value).errors;
    warning.textContent = errors.length ? '괄호나 명령을 확인해 주세요. 지금 모양으로도 넣을 수 있어요.' : '';
    preview.classList.toggle('eq-has-warning', errors.length > 0);
  };
  const apply = (result) => {
    if (result.script.length > MAX_LENGTH) { warn(new Error('수식은 8,000자까지 쓸 수 있어요.')); return false; }
    script.value = result.script; focus(result.start, result.end); paint(); return true;
  };
  const put = (template, replace = false) => {
    const base = replace && replacement ? replacement : { source: script.value, start: script.selectionStart, end: script.selectionEnd };
    return apply(insertTemplate(base.source, base.start, base.end, template));
  };
  const move = (backward) => { const slot = moveSlot(script.value, script.selectionStart, script.selectionEnd, backward); focus(slot.start, slot.end); };
  const showPanel = (name, content) => {
    panel.replaceChildren(h('div.eq-picker-heading', h('strong', name), button('목록 닫기', 'Esc', () => { closePanel(); focus(); })), content);
    panel.hidden = false;
  };
  const pickGroup = (group, insertDefault = false) => {
    closePanel();
    const base = { source: script.value, start: script.selectionStart, end: script.selectionEnd };
    if (insertDefault) {
      if (!put(group.id === 'matrix' ? matrixTemplate() : group.items[0].script)) return;
      replacement = base;
    }
    const rows = h('input.input', { type: 'number', min: 1, max: 10, value: 2, 'aria-label': '행렬 줄 수' });
    const columns = h('input.input', { type: 'number', min: 1, max: 10, value: 2, 'aria-label': '행렬 칸 수' });
    const grid = h('div.eq-template-grid', group.items.map((item) => {
      const key = group.id === 'script' ? ({ '위 첨자': 'Shift+6', '아래 첨자': 'Shift+-' })[item.name] : group.key;
      const b = button(item.name, key, () => {
        try {
          const template = group.id === 'matrix' ? matrixTemplate(item.script, +rows.value, +columns.value) : item.script;
          if (put(template, true)) closePanel();
        } catch (error) { warn(error); }
      }, { dataset: { template: item.script }, onmousedown: (e) => e.preventDefault() });
      const sample = h('span.eq-template-sample', { 'aria-hidden': 'true' });
      sample.innerHTML = eqToMathML(group.id === 'matrix' ? matrixTemplate(item.script) : item.script, { sourceMap: true });
      b.prepend(sample); return b;
    }));
    showPanel(group.name, h('div', group.id === 'matrix' ? h('div.eq-matrix-size', h('label', '줄 ', rows), h('label', '칸 ', columns), h('span.small.muted', '1~10개 · 모양을 누르면 넣어요')) : null, grid));
    if (insertDefault) focus();
  };
  const pickSymbols = () => {
    closePanel();
    const grid = h('div.eq-symbol-grid', { role: 'group', 'aria-label': '기호 표' });
    const draw = (group) => {
      grid.replaceChildren(...group.commands.map((command) => {
        const b = button(command, '', () => { put(command); closePanel(); }, { 'aria-label': command, onmousedown: (e) => e.preventDefault() });
        const glyph = h('span'); glyph.innerHTML = eqToMathML(command); b.replaceChildren(glyph, h('small', command)); return b;
      }));
    };
    draw(SYMBOL_GROUPS[0]);
    showPanel('기호·문자표', h('div', h('div.eq-symbol-tabs', SYMBOL_GROUPS.map((group) => button(group.name, '', () => draw(group)))), grid));
  };
  const commandPanel = () => {
    closePanel();
    const input = h('input.input', { placeholder: '예: alpha, sqrt {x}', 'aria-label': '넣을 명령' });
    const submit = () => { if (input.value && put(input.value)) closePanel(); };
    input.addEventListener('keydown', (event) => { if (!event.isComposing && event.key === 'Enter') { event.preventDefault(); submit(); } });
    showPanel('명령어 입력', h('div.eq-command', input, button('명령 넣기', '', submit)));
    input.focus();
  };
  const saveFile = async (name, content, extension) => {
    await api.saveFile({ defaultName: name, data: [...new TextEncoder().encode(content)], filters: [{ name: extension, extensions: [extension] }], title: '수식 파일 저장' });
  };
  const readFile = (accept, callback) => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', async () => {
      try {
        const file = input.files[0]; if (!file) return;
        if (file.size > 200000) throw new Error('200KB 이하 파일을 골라 주세요.');
        await callback(await file.text());
      } catch (error) { warn(error); }
    });
    input.click();
  };
  const macros = () => {
    closePanel();
    let list;
    try { list = JSON.parse(localStorage.getItem(macroKey) || '[]'); } catch { list = []; }
    const valid = (data) => Array.isArray(data) && data.length <= 50 && data.every((item) => typeof item?.name === 'string' && item.name.length <= 80 && typeof item?.script === 'string' && item.script.length <= MAX_LENGTH);
    if (!valid(list)) list = [];
    const name = h('input.input', { maxlength: 80, placeholder: '예: 이차방정식', 'aria-label': '자주 쓰는 수식 이름' });
    const items = h('div.eq-macro-list');
    const draw = () => items.replaceChildren(...list.map((item, i) => h('div', button(item.name, '', () => { put(item.script); closePanel(); }), button('지우기', '', () => { list.splice(i, 1); store(); }))));
    const store = () => { try { localStorage.setItem(macroKey, JSON.stringify(list)); draw(); } catch { warn(new Error('자주 쓰는 수식을 저장하지 못했어요.')); } };
    draw();
    showPanel('자주 쓰는 수식 · 이 컴퓨터에 저장', h('div', h('div.eq-command', name, button('현재 수식 등록', '', () => {
      if (!name.value.trim() || !script.value.trim()) return;
      if (list.length >= 50) { warn(new Error('50개까지 등록할 수 있어요.')); return; }
      list.push({ name: name.value.trim(), script: cleanScript(script.value) }); store();
    })), items, h('div.eq-extra-tools', button('JSON 저장', '', () => saveFile('자주 쓰는 수식.json', JSON.stringify(list, null, 2), 'json').catch(warn)),
      button('JSON 불러오기', '', () => readFile('.json', async (text) => {
        const imported = JSON.parse(text);
        if (!valid(imported) || list.length + imported.length > 50) throw new Error('이름과 수식이 있는 목록을 50개 이내로 골라 주세요.');
        list.push(...imported); store();
      })))));
  };
  const formatPanel = () => {
    closePanel();
    const color = h('input', { type: 'color', value: '#202b32', 'aria-label': '수식 글자 색' });
    const font = h('select.input', { 'aria-label': '미리보기 글꼴', onchange: () => { preview.style.fontFamily = font.value; } },
      ['Cambria Math', 'STIX Two Math', 'serif'].map((name) => h('option', { value: name }, name)));
    showPanel('글자·파일', h('div', h('div.eq-extra-tools', [['로만체', 'rm'], ['기울임', 'it'], ['굵은 기울임', 'bold'], ['굵은 로만체', 'rmbold']].map(([name, cmd]) => button(name, '', () => { put(`${cmd} {}`); closePanel(); }))),
      h('div.eq-extra-tools', h('label', '미리보기 글꼴 ', font), color, button('글자 색 넣기', '', () => {
        const rgb = color.value.slice(1).match(/../g).map((v) => parseInt(v, 16)).join(','); put(`COLOR {${rgb}}{}`); closePanel();
      })), h('p.small.muted', '글꼴·확대는 이 창의 보기만 바꿔요. 글자 크기·줄 맞춤 도구의 공식 동작은 확인 필요해요.'),
      h('div.eq-extra-tools', button('MathML 저장', '', async () => {
        try {
          const doc = new DOMParser().parseFromString(eqToMathML(cleanScript(script.value), { display: centered.checked }), 'application/xml');
          const math = doc.documentElement;
          const semantics = doc.createElementNS(math.namespaceURI, 'semantics');
          while (math.firstChild) semantics.append(math.firstChild);
          const annotation = doc.createElementNS(math.namespaceURI, 'annotation'); annotation.setAttribute('encoding', 'application/x-hwp-equation'); annotation.textContent = cleanScript(script.value);
          semantics.append(annotation); math.append(semantics);
          await saveFile('수식.mml', new XMLSerializer().serializeToString(doc), 'mml');
        } catch (error) { warn(error); }
      }), button('MathML 불러오기', '', () => readFile('.mml,.mathml,.xml', async (text) => {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        const source = doc.querySelector('annotation[encoding="application/x-hwp-equation"]');
        if (doc.querySelector('parsererror') || !source) throw new Error('이 편집기에서 저장한 스크립트 포함 MathML 파일만 불러올 수 있어요.');
        if (put(source.textContent)) closePanel();
      }))), h('p.small.muted', 'MathML 불러오기는 이 편집기에서 저장한 파일만 지원해요.')));
  };
  const help = async () => {
    closePanel();
    const table = (heads, rows) => h('table.eq-help-table', h('thead', h('tr', heads.map((text) => h('th', text)))), h('tbody', rows.map((row) => h('tr', row.map((text) => h('td', text))))));
    await modal({ title: '수식 단축키·문법', width: 800, className: 'eq-help-modal', body: h('div',
      h('p', '한글 공식 단축키 22개입니다. 본문 키는 해설 편집기에서, 나머지는 수식 창에서 써요.'),
      table(['번호', '키', '하는 일 · 공식 문맥'], EQUATION_SHORTCUTS),
      h('p.small', '우리 화면: Enter는 스크립트에 #를 넣어요. Esc는 열린 목록부터 닫고, 목록이 없으면 취소 확인을 해요. P는 선택한 수식을 고치는 창을 열어요. Tab은 다음 칸으로, 마지막 칸에서는 틀 밖으로 나가요.'),
      h('h4', '자주 쓰는 문법'), table(['입력', '하는 일'], [
        ['{a} over {b}', '분수'], ['sqrt {x} / root {n} of {x}', '제곱근 / n제곱근'], ['x^2 / x_1 / x_1^2', '위 / 아래 / 양쪽 첨자'],
        ['sum _{k=1}^{n} / int _{a}^{b}', '합 / 적분'], ['lim _{x -> a}', '극한'], ['matrix {a & b # c & d}', '행렬: &는 다음 칸, #는 다음 줄'],
        ['cases {식 & 조건 # 식 & 조건}', '경우 나누기'], ['hat {x} / bar {AB}', '모자 / 윗줄'], ['rm / it / bold / rmbold', '글자 모양 전환'],
        ['{여러 항} / "여러 글자"', '한 덩어리로 묶기 / 공백까지 그대로 쓰기'], ['~ / `', '보이는 공백 / 작은 공백'],
      ]), h('p.small.muted', '미확인 키와 명령은 싣지 않았어요. 괄호 도구는 조사표의 모듈용 틀이며, 한글의 실제 삽입 문자열까지 같다는 뜻은 아니에요.')),
    buttons: [{ label: '닫기', value: true }] });
    focus();
  };
  const toolbar = h('div.eq-toolbar', { role: 'toolbar', 'aria-label': '수식 도구' }, TEMPLATE_GROUPS.map((group) => button(group.name, group.key, () => pickGroup(group), { dataset: { group: group.id }, onmousedown: (e) => e.preventDefault() })),
    button('기호·문자표', '', pickSymbols), button('명령어', '\\', commandPanel), button('자주 쓰는 수식', '', macros), button('글자·파일', '', formatPanel), button('단축키', 'F1', help));
  const zoom = h('select.input', { 'aria-label': '수식 보기 확대', onchange: () => { preview.style.fontSize = `${32 * +zoom.value}px`; } },
    [['1', '100%'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%']].map(([value, name]) => h('option', { value }, name)));
  const extra = h('div.eq-extra-tools', button('이전 칸', 'Shift+Tab', () => move(true)), button('다음 칸', 'Tab', () => move(false)), button('줄 바꿈', 'Enter', () => { put('#'); closePanel(); }), h('label', '보기 확대 ', zoom));
  script.addEventListener('input', () => { closePanel(); if (!composing) paint(); });
  script.addEventListener('compositionstart', () => { composing = true; });
  script.addEventListener('compositionend', () => { composing = false; paint(); });
  preview.addEventListener('click', (event) => {
    const node = event.target.closest('[data-eq-start]');
    if (node) focus(+node.dataset.eqStart, +node.dataset.eqEnd);
  });
  paint();
  await api.setEditorShortcutScope('equation');
  const result = modal({ title: eq ? '수식 고치기' : '수식 넣기', width: 900, className: 'answer-equation-modal',
    body: h('div.eq-editor', h('p.eq-guide', '틀을 고르고 빈칸에 써 보세요. Tab으로 다음 칸, 위 수식을 누르면 그 부분을 고쳐요.'),
      h('strong', '바로 보이는 수식'), preview, warning, toolbar, panel, extra, h('label', '한글 수식 스크립트', script), h('label.check', centered, '가운데 수식으로 넣기')),
    onKeyDown: (event) => {
      if (composing || event.isComposing) return false;
      if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        const group = TEMPLATE_GROUPS.find((group) => group.id === TEMPLATE_KEYS[event.code]);
        if (group) { pickGroup(group, true); return true; }
        if (event.code === 'KeyN') return true;
      }
      if (event.key === 'F1') { help(); return true; }
      if (event.key === 'Escape' && event.shiftKey) { dialog.close({ eq: cleanScript(script.value), display: centered.checked }); return true; }
      if (event.key === 'Escape' && !panel.hidden) { closePanel(); focus(); return true; }
      if (event.key === 'Tab' && event.target === script) { move(event.shiftKey); return true; }
      if (event.key === 'Enter' && event.target === script) { put('#'); closePanel(); return true; }
      if (event.key === '\\' && event.target === preview) { commandPanel(); return true; }
      return false;
    },
    beforeClose: async (value) => {
      if (value !== null || script.value === eq && centered.checked === display) return true;
      const discard = await confirmDialog('고친 수식을 버릴까요? 원래 수식은 그대로 남아요.', { ok: '버리기' });
      if (!discard) focus();
      return discard;
    },
    buttons: [{ label: '취소', value: null }, { label: '넣기', primary: true, onClick: () => ({ eq: cleanScript(script.value), display: centered.checked }) }],
  });
  dialog = script.closest('.modal');
  dialog.querySelector('.btn-primary').title = '넣기 · Shift+Esc';
  dialog.querySelector('.modal-footer button').title = '취소 · Esc';
  focus();
  return result.finally(() => api.setEditorShortcutScope(returnScope));
}
