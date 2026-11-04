import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 화면 의존성만 대체하고 실제 topbar 버튼·클릭 시점의 화면 선택을 실행.
test('도움말 버튼: 설정 바로 앞, 탭 전환·책·오답노트·다른 화면 연결', async () => {
  const source = readFileSync(new URL('../../src/renderer/js/chrome.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const state = { view: 'home' };
  let activeTab = 'notes';
  const document = { querySelector: (selector) => selector === '.home .seg-tabs .seg-tab.active' && activeTab ? { dataset: { tab: activeTab } } : null };
  const opened = [];
  const h = (tag, ...children) => {
    const first = children[0];
    const attrs = first && typeof first === 'object' && !first.tag && !Array.isArray(first) ? children.shift() : {};
    return { tag, attrs, children: children.flat().filter((c) => c != null) };
  };
  const topbar = new Function('h', 'icon', 'api', 'state', 'jobs', 'jobListeners', 'document', `${source}\nreturn topbar;`)(
    h, (name) => h('svg', { name }), { openHelp: async (section) => opened.push(section) }, state, new Map(), new Set(), document,
  );
  const right = topbar('오답노트').children.find((el) => el.tag === 'div.topbar-right');
  const helpIndex = right.children.findIndex((el) => el.tag.endsWith('#help-btn'));
  assert.notEqual(helpIndex, -1);
  assert.ok(right.children[helpIndex + 1].tag.endsWith('#settings-btn'));
  const button = right.children[helpIndex];
  assert.equal(button.attrs.title, '사용 설명서를 브라우저에서 열어요');
  assert.ok(button.children.some((el) => el.tag === 'span' && el.children.includes('도움말')));
  for (const [view, tab, section] of [
    ['home', 'notes', 'note'], ['home', 'books', 'book'], ['home', 'students', 'students'],
    ['home', 'bank', ''], ['home', null, ''], ['book', 'students', 'book'], ['note', 'books', 'note'], [null, 'notes', ''],
  ]) {
    state.view = view;
    activeTab = tab;
    await button.attrs.onclick();
    assert.equal(opened.at(-1), section);
  }
});

test('preload: openHelp 는 전용 IPC 에 앵커만 전달', async () => {
  let api;
  const calls = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'ohdap'); api = value; } },
    ipcRenderer: { invoke: async (...args) => calls.push(args) },
  };
  const source = readFileSync(new URL('../../src/main/preload.js', import.meta.url), 'utf8');
  new Function('require', source)((name) => { assert.equal(name, 'electron'); return electron; });
  await api.openHelp('settings');
  await api.openHelp();
  assert.deepEqual(calls, [['app:openHelp', 'settings'], ['app:openHelp', undefined]]);
});
