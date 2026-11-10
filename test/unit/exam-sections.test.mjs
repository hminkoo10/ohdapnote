import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeExamPages, stabilizeLegacyExamPages } from '../../src/renderer/js/exam-sections.js';
import { itemName } from '../../src/renderer/js/exporter.js';
import { matchItems } from '../../src/renderer/js/match.js';
import { filterBank } from '../../src/renderer/js/bank.js';

const token = (str, y0 = .05) => ({ str, x0: .1, x1: .13, y0, y1: y0 + .01 });
const page = (index, title, nums) => ({ index, tokens: [token(title), ...nums.map((n, i) => token(`${n}.`, .3 + i * .04))], layout: { columns: [{ x0: .08, x1: .48 }] } });

test('옛 학평의 괄호·점 번호 회복, 본문 숫자와 중복 제외, 일반 교재 불변', () => {
  const p = page(0, '가짜 학력평가', [1,2,3,4,5]);
  p.tokens[2].str = '(2)';
  p.tokens.push({...token('1.', .7), x0:.3}, token('3', .8));
  const anchors = new Map([[0,[{num:99}]]]);
  const exam = {exam:'edu',year:2006};
  assert.equal(stabilizeLegacyExamPages([p],anchors,'math',null),null);
  assert.equal(anchors.get(0)[0].num,99);
  stabilizeLegacyExamPages([p],anchors,'math',exam);
  assert.deepEqual(anchors.get(0).map(c=>c.num),[1,2,3,4,5]);
});

test('스캔 학평은 OCR 후보 보존, 과목 범위와 중복만 제한', () => {
  const p = page(0,'',[]); p.tokens=[];
  const anchors=new Map([[0,[{num:1,col:0,y0:.2},{num:1,col:0,y0:.3},{num:31,col:0,y0:.4}]]]);
  stabilizeLegacyExamPages([p],anchors,'math',{exam:'edu',year:2006});
  assert.deepEqual(anchors.get(0).map(c=>c.num),[1]);
});

test('점 번호가 없는 문항의 기존 확정 번호를 잃지 않음', () => {
  const p=page(0,'가짜 학평',[1,2,3,4,5]);
  const anchors=new Map([[0,[{num:6,col:0,x0:.17,y0:.7}]]]);
  stabilizeLegacyExamPages([p],anchors,'math',{exam:'edu',year:2005});
  assert.deepEqual(anchors.get(0).map(c=>c.num),[1,2,3,4,5,6]);
});
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

 test('최근 학평의 단답형 구간 중복·쪽 번호는 실제 번호 축으로 제한', () => {
  const p=page(0,'가짜 학평',[1,2,3,4,5]);
  const anchors=new Map([[0,[{num:1,col:0,y0:.2},{num:31,col:0,y0:.5}]]]);
  stabilizeLegacyExamPages([p],anchors,'math',{exam:'edu',year:2025});
  assert.deepEqual(anchors.get(0).map(c=>c.num),[1,2,3,4,5]);
});
