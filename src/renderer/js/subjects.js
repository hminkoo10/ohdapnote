// 과목: 수학 · 영어 · 국어 (이 순서). 학원이 계약한 과목은 app:info 의 subjects (src/main/subjects.js)

export const SUBJECTS = [
  { code: 'math', name: '수학' },
  { code: 'english', name: '영어' },
  { code: 'korean', name: '국어' },
];

/** 교재(또는 책장 목록의 요약)의 과목 — 없거나 모르는 값이면 수학 */
export const subjectOf = (book) => (SUBJECTS.some((s) => s.code === book?.subject) ? book.subject : 'math');

export const subjectName = (code) => SUBJECTS.find((s) => s.code === code)?.name || '수학';

/** 학원이 계약한 과목 코드들 (appInfo.subjects, 없으면 수학만) */
export const contractedSubjects = (appInfo) => (Array.isArray(appInfo?.subjects) ? SUBJECTS.map((s) => s.code).filter((c) => appInfo.subjects.includes(c)) : ['math']);

/** 이 교재의 과목을 학원이 계약했는지 (안 했으면 보기만) */
export const subjectOpen = (book, appInfo) => contractedSubjects(appInfo).includes(subjectOf(book));
