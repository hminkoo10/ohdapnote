// 과목 (마고에듀 공동 약속 1·2·3): 수학 math · 영어 english · 국어 korean
//  - 학원이 계약한 과목은 통합 클라우드가 academy-info.json 의 academy.subjects 로 넘겨 줌 (없으면 수학만)
//  - 교재(book.json)의 subject 가 없거나 모르는 값이면 수학
//  - 계약에서 빠진 과목의 교재는 보기만 (고치기·분석·문제은행·내보내기 막음)

const SUBJECTS = ['math', 'english', 'korean'];

/** 학원 계약 과목 → 약속 1 순서·중복 없이. 배열이 아니면(옛 통합 클라우드·학원 정보 없음) 수학만 */
function contractSubjects(list) {
  if (!Array.isArray(list)) return ['math'];
  return SUBJECTS.filter((s) => list.includes(s));
}

/** 교재의 과목 */
const bookSubject = (book) => (SUBJECTS.includes(book?.subject) ? book.subject : 'math');

module.exports = { SUBJECTS, contractSubjects, bookSubject };
