// docs/hwp-equation.md A1의 번호·키·하는 일을 그대로 유지합니다.
export const EQUATION_SHORTCUTS = [
  [1, 'Ctrl+N,M', '본문에서 수식 편집기 열기'],
  [2, 'Shift+6', '위 첨자'],
  [3, 'Shift+-', '아래 첨자'],
  [4, 'Ctrl+D', '장식 기호 틀'],
  [5, 'Ctrl+O', '분수 틀'],
  [6, 'Ctrl+R', '근호 틀'],
  [7, 'Ctrl+S', '합 기호 틀'],
  [8, 'Ctrl+I', '적분 틀'],
  [9, 'Ctrl+L', '극한 틀'],
  [10, 'Ctrl+E', '상호 관계 틀'],
  [11, 'Ctrl+9', '괄호 틀'],
  [12, 'Ctrl+0', '경우 틀'],
  [13, 'Ctrl+P', '세로 쌓기 틀'],
  [14, 'Ctrl+M', '행렬 틀'],
  [15, 'Enter', '수식 편집 창: 줄 바꿈. 명령어 입력 상자: 명령 반영·입력 종료'],
  [16, 'F1', '수식 도움말'],
  [17, 'Shift+Esc', '수식을 본문에 넣고 편집 종료'],
  [18, 'Tab', '다음 항목으로 이동. 첨자·진하게 상태 해제에도 사용'],
  [19, 'Shift+Tab', '이전 항목으로 이동'],
  [20, '\\', '비주얼 수식 창에서 명령어 입력 상자로 이동. 아래 스크립트 창에서 쓰면 로만체 전환'],
  [21, 'Esc', '명령어 입력 상태 종료. 편집기 전체 취소/닫기로 확대 해석하지 않음'],
  [22, 'P', '본문에서 수식 개체를 선택한 상태: 개체 속성 열기(크기·색 등)'],
];

export const TEMPLATE_KEYS = {
  KeyD: 'accent', KeyO: 'fraction', KeyR: 'root', KeyS: 'sum', KeyI: 'integral', KeyL: 'limit',
  KeyE: 'relation', Digit9: 'fence', Digit0: 'cases', KeyP: 'pile', KeyM: 'matrix',
};
