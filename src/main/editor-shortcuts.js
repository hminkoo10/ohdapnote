'use strict';

/** 메뉴 accelerator만 비켜서게 하고 DOM 키 입력은 계속 전달합니다. */
function editorShortcut(scope, input) {
  if (input.isComposing || input.alt || input.meta) return false;
  const key = input.key.toLowerCase();
  if (scope === 'answer') return input.control && !input.shift && ['n', 'm'].includes(key) || !input.control && key === 'p';
  if (scope !== 'equation') return false;
  if (input.control) return !input.shift && ['d', 'o', 'r', 's', 'i', 'l', 'e', '9', '0', 'p', 'm', 'n'].includes(key);
  return ['f1', 'escape', 'tab', 'enter', '\\', '^', '_'].includes(key);
}

module.exports = { editorShortcut };
