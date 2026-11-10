import { identifyExam, groupExamFiles } from './mockexam.js';
export const examKey = (m) => [m.exam, m.year, m.month, m.grade, m.subject, m.selection || ''].join(':');
export function examBookName(m) {
  const subject = { math: '수학', english: '영어', korean: '국어' }[m.subject];
  return `${m.exam === 'edu' ? `${m.year}년 ${m.month}월 고${m.grade} 학평` : `${m.schoolYear || m.year + 1}학년도 ${m.exam === 'csat' ? '수능' : `${m.month}월 모평`}`} ${subject}`;
}
export function planExamImport(files, books = [], subjects = ['math']) {
  const groups = groupExamFiles(files.map((f) => ({ ...f, metadata: f.metadata || identifyExam(f) })));
  const rows = [], skipped = [];
  for (const g of groups) {
    const m = g.metadata;
    if (!g.files.some((f) => f.metadata.part === 'question')) {
      const attached = groups.some((o) => examKey(o.metadata) === examKey(m) && o.files.some((f) => f.metadata.part === 'question'));
      if (!attached) skipped.push(...g.files.map((f) => f.path));
      continue;
    }
    if (!m.exam || !m.year || !m.month || !m.grade || !m.subject) { skipped.push(...g.files.map((f) => f.path)); continue; }
    const extras = groups.filter((o) => o !== g && examKey(o.metadata) === examKey(m) && (!o.metadata.form || o.metadata.form === m.form)).flatMap((o) => o.files.filter((f) => ['answerKey', 'solution'].includes(f.metadata.part)));
    const common = files.filter(f => !f.metadata?.subject && /공통|전과목|전영역|통합|모의고사[_ -]*(?:정답|해설)/.test(f.filename || '') && ['answerKey', 'solution'].includes(f.metadata?.part) && ['exam','year','month','grade'].every(k => f.metadata[k] === m[k]));
    g.files = [...new Map([...g.files, ...extras, ...common].map(f=>[f.localPath || f.path || f.filename,f])).values()];
    const odd = groups.some((o) => examKey(o.metadata) === examKey(m) && o.metadata.form === '홀');
    const hashDuplicate = g.files.some((f) => f.metadata?.part === 'question' && books.some((b) => b.exam?.source?.sha256 === f.sha256));
    const reason = !subjects.includes(m.subject) ? '계약 밖' : m.form === '짝' && odd ? '짝수형' : books.some((b) => b.exam && examKey({ ...b.exam, subject: b.subject }) === examKey(m)) || hashDuplicate ? '이미 있음' : '';
    rows.push({ ...g, name: examBookName(m), reason });
  }
  return { rows, skipped };
}

// 한 PDF 안에 홀짝이 함께 실렸어도 문제은행에는 홀수형만 남긴다.
export function examImportItems(items) {
  return items.some((i) => i.examSection?.form === '홀')
    ? items.filter((i) => i.examSection?.form !== '짝') : items;
}
