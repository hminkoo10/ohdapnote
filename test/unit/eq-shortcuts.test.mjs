import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EQUATION_SHORTCUTS, TEMPLATE_KEYS } from '../../src/renderer/js/eq-shortcuts.js';
import { TEMPLATE_GROUPS } from '../../src/renderer/js/eq-templates.js';

const { editorShortcut } = createRequire(import.meta.url)('../../src/main/editor-shortcuts.js');

test('단축키 표 번호·키·설명은 조사표 A1의 22줄과 같음', () => {
  const doc = readFileSync(new URL('../../docs/hwp-equation.md', import.meta.url), 'utf8');
  const section = doc.split('### A1.')[1].split('### A2.')[0];
  const rows = [...section.matchAll(/^\| (\d+) \| `([^`]+)`[^|]*\| ([^|]+)\|/gm)].map((m) => [+m[1], m[2], m[3].trim().replace(/\*\*/g, '')]);
  assert.equal(rows.length, 22);
  assert.deepEqual(EQUATION_SHORTCUTS, rows);
  assert.deepEqual(Object.values(TEMPLATE_KEYS).sort(), TEMPLATE_GROUPS.filter((g) => g.key).map((g) => g.id).sort());
});

test('Electron 메뉴 보호는 편집기 범위·확인된 키에만 적용', () => {
  for (const [code, group] of Object.entries(TEMPLATE_KEYS)) {
    const key = code.replace(/^(Key|Digit)/, '').toLowerCase();
    const input = { key, control: true };
    assert.equal(editorShortcut('equation', input), true, group);
    assert.equal(editorShortcut('', input), false);
    assert.equal(editorShortcut('equation', { ...input, isComposing: true }), false);
    assert.equal(editorShortcut('equation', { ...input, alt: true }), false);
    assert.equal(editorShortcut('equation', { ...input, shift: true }), false);
  }
  assert.equal(editorShortcut('answer', { key: 'n', control: true }), true);
  assert.equal(editorShortcut('answer', { key: 'r', control: true }), false);
  assert.equal(editorShortcut('equation', { key: 'z', control: true }), false);
  assert.equal(editorShortcut('equation', { key: 'Escape', isComposing: true }), false);
});
