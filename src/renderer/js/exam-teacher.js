// 시험지 선생님 기본값: 저장한 이름(빈칸 포함) → 학원 명단 학생의 담당 → 설정의 기본 이름(비면 내 계정 이름) → 로그인 이름
// 기본값 조회로 노트를 바꾸지는 않아요.
export function examTeacher(note, { roster, students = [], user, settings } = {}) {
  if (note.teacher != null) return note.teacher;
  const student = roster === 'cloud' && note.studentId ? students.find((st) => st.id === note.studentId) : null;
  return student?.teacher?.name || settings?.teacher || user?.name || '';
}
