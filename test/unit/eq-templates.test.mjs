import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATE_GROUPS, SYMBOL_GROUPS, matrixTemplate, findSlots, moveSlot, insertTemplate, cleanScript } from '../../src/renderer/js/eq-templates.js';
import { parseEq, eqToMathML } from '../../src/renderer/js/hwpeqview.js';

test('모든 틀과 확인된 기호를 파서가 해석하며 임시 글자가 없음', () => {
  for (const group of TEMPLATE_GROUPS) for (const item of group.items) {
    const script = group.id === 'matrix' ? matrixTemplate(item.script) : item.script;
    assert.deepEqual(parseEq(script).errors, [], script);
    assert.ok(findSlots(script).length, script);
    assert.equal(cleanScript(script), script);
    assert.ok(!script.includes('□'));
  }
  for (const group of SYMBOL_GROUPS) for (const command of group.commands) assert.deepEqual(parseEq(command).errors, [], command);
});

test('직접 쓴 빈 그룹·채운 그룹·따옴표·중첩 틀의 칸 위치', () => {
  const source = '"{}" + {a} over {sqrt {} + {b}}';
  const slots = findSlots(source);
  assert.deepEqual(slots.map((s) => source.slice(s.start, s.end)), ['a', '', 'b']);
  assert.equal(source[slots[1].start - 1], '{');
  assert.deepEqual(findSlots(' {} '), [{ start: 2, end: 2 }]);
  assert.deepEqual(findSlots('x^2').map((s) => 'x^2'.slice(s.start, s.end)), ['x', '2']);
  assert.doesNotThrow(() => findSlots('sqrt {'));
});

test('행렬 칸은 원문 순서, 빈 행·칸도 유지', () => {
  const text = 'matrix {a & # c & d}';
  assert.deepEqual(findSlots(text).map((s) => text.slice(s.start, s.end)), ['a', '', 'c', 'd']);
  const columns = 'matrix {col {a#b} lcol {c#d}}';
  assert.deepEqual(findSlots(columns).map((s) => columns.slice(s.start, s.end)), ['a', 'b', 'c', 'd']);
  assert.equal(findSlots(matrixTemplate('bmatrix', 3, 4)).length, 12);
  assert.throws(() => matrixTemplate('other'), /종류/);
  for (const n of [0, 11, 1.5, NaN]) assert.throws(() => matrixTemplate('matrix', n), /1~10/);
});

test('Tab·역방향 이동은 채운 칸과 중첩 칸, 마지막 탈출을 지원', () => {
  const text = '{a} over {sqrt {} + {b}}';
  const slots = findSlots(text);
  assert.deepEqual(moveSlot(text, 1, 2), slots[1]);
  assert.deepEqual(moveSlot(text, slots[1].start, slots[1].end, true), slots[0]);
  assert.deepEqual(moveSlot(text, slots[2].start, slots[2].end), { start: text.length, end: text.length });
  assert.deepEqual(moveSlot(text, text.length, text.length, true), slots[2]);
  assert.deepEqual(moveSlot('bold {x}', 6, 7), { script: 'bold {x} rm ', start: 12, end: 12 });
  assert.deepEqual(moveSlot('x^a', 3), { script: 'x^a ', start: 4, end: 4 });
  assert.deepEqual(moveSlot('', 0), { start: 0, end: 0 });
});

test('선택 감싸기·첫 칸 선택·명령 경계·분수 범위 보존', () => {
  let result = insertTemplate('a+b', 0, 3, '{} over {}');
  assert.equal(result.script, '{a+b} over {}');
  assert.equal(result.script.slice(result.start, result.end), 'a+b');
  result = insertTemplate('x+', 2, 2, '{} over {}');
  assert.equal(result.script, 'x+{{} over {}}');
  assert.deepEqual([result.start, result.end], [4, 4]);
  assert.equal(insertTemplate('x', 1, 1, 'alpha').script, 'x alpha');
  assert.equal(insertTemplate('y', 0, 0, 'alpha').script, 'alpha y');
  assert.equal(cleanScript('"□" + {}'), '"□" + {}', '직접 쓴 기호는 보존');
  result = insertTemplate('x', 0, 1, 'COLOR {1,2,3}{}');
  assert.equal(result.script, 'COLOR {1,2,3}{x}');
});

test('미리보기 위치는 원문 UTF-16 범위이며 일반 출력에는 편집 표식 없음', () => {
  const source = ' {가} over {} ';
  const html = eqToMathML(source, { sourceMap: true });
  assert.match(html, /data-eq-start="2" data-eq-end="3"/);
  assert.match(html, /data-eq-empty="true"/);
  for (const m of html.matchAll(/data-eq-start="(\d+)" data-eq-end="(\d+)"/g)) assert.ok(+m[1] <= +m[2] && +m[2] <= source.length);
  assert.doesNotMatch(eqToMathML(source), /data-eq-|mspace/);
});
