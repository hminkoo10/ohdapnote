import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifyExam } from '../../src/renderer/js/mockexam.js';
import { planExamImport } from '../../src/renderer/js/mockexam-plan.js';
const file = (folder, part, text = '') => ({ filename: `${part}-synthetic.pdf`, path: `input/2028/05/${folder}/${part}-synthetic.pdf`, text });
test('선택 폴더는 과목·선택·시행월을 모든 역할에서 공유', () => {
  const files = ['기하','미적분','확률과_통계','화법과_작문','언어와_매체'].flatMap(sel =>
    ['question','answer','explanation'].map(part => file(`고3_4월_학평(교육청)_${sel}`, part,
      part === 'question' ? `2028년 5월 고3 전국연합학력평가 ${/기하|미적분|확률/.test(sel) ? '수학' : '국어'}` : '')));
  const p = planExamImport(files, [], ['math','korean']);
  assert.equal(p.rows.length, 5);
  assert.ok(p.rows.every(r => r.files.length === 3 && r.metadata.month === 5));
  assert.equal(new Set(p.rows.map(r => r.name)).size, 5);
  assert.ok(p.rows.some(r => r.name.endsWith('수학(미적분)')));
  assert.equal(p.skipped.length, 0);
});
