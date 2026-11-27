import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterExamHeaderCandidates } from '../../src/renderer/js/exam-furniture.js';

test('subject masthead folio is not a question anchor', () => {
  const head={x0:0.1,x1:0.12,y0:0.1,y1:0.12};
  const body={x0:0.1,x1:0.12,y0:0.2,y1:0.22};
  const tokens=[{...head,str:'4'}, {x0:0.3,x1:0.5,y0:0.1,y1:0.12,str:'수학 영역'}, {...body,str:'4. 수학 영역의 넓이는?'}];
  assert.deepEqual(filterExamHeaderCandidates([head,body],tokens),[body]);
  assert.deepEqual(filterExamHeaderCandidates([head],[{...head,str:'4. 넓이는?'}]),[head]);
});
