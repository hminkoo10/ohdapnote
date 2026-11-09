import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeExamPages } from '../../src/renderer/js/exam-sections.js';
import { itemName } from '../../src/renderer/js/exporter.js';
import { matchItems } from '../../src/renderer/js/match.js';
import { filterBank } from '../../src/renderer/js/bank.js';

const token = (str, y0 = .05) => ({ str, x0: .1, x1: .13, y0, y1: y0 + .01 });
const page = (index, title, nums) => ({ index, tokens: [token(title), ...nums.map((n, i) => token(`${n}.`, .3 + i * .04))], layout: { columns: [{ x0: .08, x1: .48 }] } });
test('선택별 번호·본문 숫자 배제·홀짝·반복 결과', () => {
  const pages = [page(0, '2024학년도 대학수학능력시험 홀수형 (화법과작문)', [35,36]), page(1, '(언어와매체)', [35,36,1,2]), page(2, '짝수형 (화법과작문)', [35,36])];
  const run = () => { const anchors = new Map(); const s = stabilizeExamPages(structuredClone(pages), anchors, 'korean'); return { anchors, s }; };
  const r = run();
  assert.deepEqual(run(), r);
  assert.deepEqual(r.anchors.get(1).map((x) => x.num), [35,36]);
  assert.equal(r.s.get(2).form, '짝');
  assert.equal(r.s.get(1).selection, '언어와매체');
});
test('영어 안내 범위는 지문 아님, 일반 교재는 변경 없음', () => {
  const p = page(0, '2024학년도 6월 모의평가 영어', [1]);
  p.ranges = [{ a: 25,b:34 },{ a:16,b:17 },{ a:41,b:42 }];
  stabilizeExamPages([p], new Map(), 'english');
  assert.deepEqual(p.ranges.map((x) => x.a), [16,41]);
  const anchors = new Map([[0,[{num:99}]]]);
  assert.equal(stabilizeExamPages([page(0,'일반 교재',[1])], anchors,'math'), null);
  assert.equal(anchors.get(0)[0].num,99);
});
test('선택 표시·검색·다른 선택 정답 자동 연결 금지', () => {
  const item = { id:'p', num:23, number:'23', page:0, examSection:{subject:'math',selection:'미적분',form:null} };
  assert.equal(itemName(item), '미적분 23번');
  const entries=[{item,bookObj:{docs:{problem:{}}}}];
  assert.equal(filterBank(entries,{text:'미적분 23번'}).length,1);
  assert.equal(matchItems([item],[{...item,id:'a',examSection:{...item.examSection,selection:'기하'}}]).size,0);
  assert.equal(matchItems([item],[{id:'legacy',num:23}]).size,0);
});
