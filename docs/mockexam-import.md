# 모의고사 파일 가져오기: 논리 API

화면·다운로드·ZIP 일괄 처리는 포함하지 않는다. 호출자가 로컬 파일을 읽고 PDF.js 문서를 `fontExtraProperties: true`로 연다. 정답표는 `getTextContent().items`를 내용 순서로 넘긴다. 쪽별 결과를 과목/선택 키로 병합할 때 충돌을 확인해야 한다.

| 함수 | 입력 → 출력 |
|---|---|
| `identifyExam` (mockexam.js) | `{filename, path, text}` → 시험 종류·시행연도·학년도·월·학년·과목·파일 역할·선택·홀짝·듣기 범위·확신도·이유 |
| `groupExamFiles` | 파일 배열(`metadata` 선택) → 동일 시험/과목/선택/홀짝별 그룹. 미확인 파일은 자동 병합하지 않음 |
| `normalizeHancomText` (hancom.js) | 글자, 선택 글꼴명 → 확인한 PUA 문자 치환. 모르는 코드는 보존 |
| `readPageLayer` (pdfmath.js) | PDF.js 쪽, 라이브러리 → 글자·선·도형 좌표 |
| `transcribeParts` | `{layer,rect,place}[]` → 기존 블록. 한컴 math는 `eq`, 문단은 기존 `$…$` 표기와 `low` |
| `importAnswerBlocks` (answer-model.js) | 블록 → 한글 수식 `eq` 런. `review:true`로 확인 표시 전달 |
| `parseAnswerKey` (mockexam-answers.js) | 문자열 또는 PDF.js items, 선택 기본 과목/선택 → `{answers, warnings}` |
| `answerKeyToAnswers` | 파싱 결과, `과목\|선택`, 번호→문항 ID → `{version:1,items:{id:{answer,blocks:[]}}}` |

## 확인 규칙과 제한

- PUA 대응 175개는 설치 글꼴 cmap·코드별 렌더 대조. `scripts/inspect-hancom.py`는 글꼴을 읽기만 하며 코드·이름을 출력한다. `--build`는 검토한 대응과 두 글꼴의 cmap을 확인한 뒤 `hancom-map.js`를 재생성한다. 조사용 fontTools는 프로젝트 의존성에 추가하지 않는다. 저장소에 원본 글꼴·윤곽·시험 내용 없음.
- 한컴도 EH와 같은 분수선·첨자·극한 등 위치 복원 경로를 사용한다. 미해독 루트/시그마/행렬/연립 조각 등은 추측하지 않고 원본 영역 그림+`low`로 돌려준다. 현재 한컴 전사 결과는 모두 확인 대상이다. EH 반환 형식은 변경하지 않는다.
- 일반 문자열 정규화에서 글꼴명을 생략하면 한컴 대응으로 간주한다. 다른 글꼴 PUA일 수 있으면 실제 글꼴명을 전달한다. 미확인 PUA는 삭제하지 않는다.
- 공통 답은 `korean`, `math`, 선택 답은 `korean|화법과작문`, `math|미적분`처럼 분리한다. 변환 시 선택 답과 공통 답을 합칠 수 있다. 배점 없는 자료는 `points:null`.
- 정답 파서는 내용 순서의 번호/정답 쌍 또는 번호/정답/배점 열을 지원한다. 좌표만으로 다단 표를 재배열하거나 이미지 정답표를 읽지는 않는다. 정답 충돌·미확인 코드는 `warnings`로 반드시 확인한다.
- 합권·불명 과목은 자동 세트 결합하지 않는다. 일반 숫자만 있는 훼손 표는 복구 보장하지 않는다. 호출자는 예상 문항 수·번호 누락도 확인해야 한다.
- 듣기 범위는 확인된 2003~2027학년도 수능/모평 체제에만 제시한다. 학평이나 체제 미확인 시험은 `null`.
- 해설 문항 분할·화면·일괄 처리는 다음 단계. 문제지 실물 표본 필요.

`node scripts/check-mockexam.mjs <로컬 정답표.pdf>`로 쪽 1의 과목별 개수·PUA 코드·블록 통계만 점검할 수 있다. 파일 내용이나 글꼴을 저장하지 않는다.
