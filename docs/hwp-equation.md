# 한글 수식 스크립트와 편집기 조사표

확인일: 2026-11-04. 대상: Windows 한/글의 **한컴 수식 입력** 모드. LaTeX 입력 모드나 한셀 함수의 단축키와 섞지 않는다. 공식 도움말 HTML을 직접 열어 본문과 표를 확인했다. 아이콘·그림은 복사하지 않았다.

이 문서는 공개 도움말의 수식 전용 목록을 빠짐없이 정리한 구현·시험 기준이다. **한컴 프로그램을 직접 조작한 전수 검증은 아니다.** 도움말에 없는 키나 인수 문법은 ‘확인 필요’로 남겼다. 공식 표의 명령 이름 확인과 이 모듈의 유니코드·MathML 표현 선택도 구분한다.

## 출처와 열람 상태

아래 링크는 모두 본문 열람 성공. 행별 출처도 이 링크를 참조한다.

| 약호 | 공식 자료 | 확인 범위 |
| --- | --- | --- |
| E | [현재 도움말: 수식][E] | 열기·넣기·개체 속성·색·root 예제 |
| S | [현재 도움말: 단축키 일람][S] | 수식 편집 대화 상자 16행 전체, 본문 편집·서식 키 |
| X | [현재 도움말: 수식 명령어 설명][X] | 구조·장식·입력 기호·폐기 명령·대소문자 |
| T | [현재 도움말: 수식 도구 상자][T] | 틀·기호·서식 도구 전체 |
| L | [hoffice130 도움말: 수식 명령어 목록][L] | 적분 6종·구조·함수 목록 |
| R | [hoffice130 도움말: 수식 편집 시 유의 사항][R] | 항목 이동·명령 입력·문자·그룹 |
| F | [hoffice130 도움말: 수식 글꼴과 기본 함수][F] | rm/it/bold/rmbold·함수·대소문자 |
| G | [hoffice130 도움말: 수식 기호 입력][G] | 7개 기호 묶음의 명령 이름 전체 |
| T24 | [hoffice130 도움말: 수식 도구 상자][T24] | LONGDIV/LADDER/SLADDER 등 버전 차이 |
| S22 | [hoffice120 도움말: 단축키 일람][S22] | 현재판 수식 전용 16행과 교차 확인 |

웹 검색 연결은 한 차례 실패했지만 재시도와 공식 서버 직접 요청으로 위 원문은 모두 열었다. 기호 표는 글리프가 그림으로 실린 항목이 많다. 그중 표준 유니코드 대응을 확정하지 않은 항목은 아래에서 별도로 표시했다.

## A. 단축키

### A1. 수식 관련 동작을 공식 자료에서 확인한 고유 키 22개

S의 ‘수식 편집 대화 상자에서’ 16행 전부는 아래 2~17번이다. 1, 18~22번은 연결된 공식 본문에서 추가 확인했다. 같은 키의 여러 문맥은 한 행에 적었으며, 22번은 수식 **개체 선택 상태** 전용이다. 문서 본문에서 `Ctrl+N`을 누르고 놓은 뒤 `M`을 누르는 겹글쇠 표기를 `Ctrl+N,M`으로 쓴다. [출처][S]

| 번호 | 키 | 하는 일·문맥 | 출처 |
| --- | --- | --- | --- |
| 1 | `Ctrl+N,M` | 본문에서 수식 편집기 열기 | [E][E], [S][S] |
| 2 | `Shift+6` (`^`) | 위 첨자 | [S][S], [S22][S22] |
| 3 | `Shift+-` (`_`) | 아래 첨자 | [S][S], [S22][S22] |
| 4 | `Ctrl+D` | 장식 기호 틀 | [S][S], [T][T] |
| 5 | `Ctrl+O` | 분수 틀 | [S][S], [T][T] |
| 6 | `Ctrl+R` | 근호 틀 | [S][S], [T][T] |
| 7 | `Ctrl+S` | 합 기호 틀 | [S][S], [T][T] |
| 8 | `Ctrl+I` | 적분 틀 | [S][S], [T][T] |
| 9 | `Ctrl+L` | 극한 틀 | [S][S], [T][T] |
| 10 | `Ctrl+E` | 상호 관계 틀 | [S][S], [T][T] |
| 11 | `Ctrl+9` | 괄호 틀 | [S][S], [T][T] |
| 12 | `Ctrl+0` | 경우 틀 | [S][S], [T][T] |
| 13 | `Ctrl+P` | 세로 쌓기 틀 | [S][S], [T][T] |
| 14 | `Ctrl+M` | 행렬 틀 | [S][S], [T][T] |
| 15 | `Enter` | 수식 편집 창: 줄 바꿈. 명령어 입력 상자: 명령 반영·입력 종료 | [S][S], [T][T], [R][R] |
| 16 | `F1` | 수식 도움말 | [S][S], [S22][S22] |
| 17 | `Shift+Esc` | 수식을 본문에 넣고 편집 종료 | [S][S], [E][E] |
| 18 | `Tab` | 다음 항목으로 이동. 첨자·진하게 상태 해제에도 사용 | [R][R], [F][F], [E][E] |
| 19 | `Shift+Tab` | 이전 항목으로 이동 | [R][R] |
| 20 | `\` | 비주얼 수식 창에서 명령어 입력 상자로 이동. 아래 스크립트 창에서 쓰면 로만체 전환 | [T][T], [R][R] |
| 21 | `Esc` | **명령어 입력 상태** 종료. 편집기 전체 취소/닫기로 확대 해석하지 않음 | [R][R] |
| 22 | `P` | 본문에서 수식 개체를 선택한 상태: 개체 속성 열기(크기·색 등) | [E][E] |

**공식 문서 충돌:** T/T24는 ‘첨자 / Shift+- / ^’로 적었지만, S와 S22는 위 첨자 `Shift+6`, 아래 첨자 `Shift+-`를 각각 명시한다. 구현 기준은 구분이 명확한 S/S22로 삼는다. 틀 메뉴의 기본 선택 항목까지 같다는 뜻은 아니며 실제 프로그램 확인이 필요하다. [T][T], [T24][T24], [S][S], [S22][S22]

### A2. 수식 창 적용 여부 확인 필요

본문 단축키를 수식 전용 키로 잘못 확정하지 않는다. 특히 수식 창의 `Ctrl+S/O/P/M/E/L`은 본문 기능과 다르다. 아래는 사용자가 요구한 편집·글꼴·기호 범주의 미확인 항목이며 **확인한 22개에 포함하지 않는다.**

| 키 또는 항목 | 공식 자료에서 확인한 범위 | 수식 편집기 판단 | 출처 |
| --- | --- | --- | --- |
| `Ctrl+Z` | 본문 되돌리기 | 확인 필요 | [S][S] |
| `Ctrl+Shift+Z` | 본문 다시 실행 | 확인 필요. `Ctrl+Y`로 임의 대체하지 않음 | [S][S] |
| `Ctrl+X`, `Shift+Delete` | 본문 오려 두기 | 확인 필요 | [S][S] |
| `Ctrl+C`, `Ctrl+Insert` | 본문 복사 | 확인 필요 | [S][S] |
| `Ctrl+V`, `Shift+Insert` | 본문 붙이기 | 확인 필요 | [S][S] |
| `Ctrl+A` | 본문 모두 선택 | 확인 필요 | [S][S] |
| `Ctrl+F10` | 본문 문자표 | 수식 도구 상자의 문자표 키는 공란. 확인 필요 | [S][S], [T][T] |
| `Alt+L` | 본문 글자 모양 | 수식 글꼴 대화 상자의 키인지 확인 필요 | [S][S], [T][T] |
| `Alt+Shift+E`, `Ctrl+]` | 본문 선택 글씨 크게 | 확인 필요 | [S][S] |
| `Alt+Shift+R`, `Ctrl+[` | 본문 선택 글씨 작게 | 확인 필요 | [S][S] |
| `Alt+Shift+F`, `Alt+Shift+G` | 본문 다음/이전 글꼴 | 확인 필요 | [S][S] |
| `Alt+Shift+B`, `Ctrl+B` | 본문 진하게 | 수식 창의 bold 명령은 확인, 키는 확인 필요 | [S][S], [F][F] |
| `Alt+Shift+I`, `Ctrl+I` | 본문 기울임 | 수식 창 `Ctrl+I`는 적분. 기울임 키는 확인 필요 | [S][S] |
| `Esc`, `Alt+F4`로 전체 취소/닫기 | 수식 전용 전체 취소 설명 없음 | 확인 필요. `Esc`는 A1의 명령 입력 종료만 확정 | [R][R], [S][S] |
| 방향키·Home/End·선택 확장·삭제 | 본문 이동·편집 목록은 있음 | 수식 틀 내부 이동 순서와 키별 효과 확인 필요 | [S][S], [R][R] |
| 그리스 문자·관계/집합/화살표 메뉴 바로 열기 | T의 단축키 칸 공란 | 확인 필요. 임의 조합을 만들지 않음 | [T][T] |
| 세로 나눗셈·사다리·줄 맞춤·글자 색·확대 | T/T24의 단축키 칸 공란 | 확인 필요 | [T][T], [T24][T24] |

### A3. 후속 편집기 시험 기준

- A1의 키를 **본문 / 비주얼 수식 창 / 명령어 입력 상자 / 스크립트 창 / 개체 선택** 문맥별로 시험한다. 스크립트 창 `Enter`를 비주얼 줄 바꿈과 동일시하지 않는다. 스크립트 줄 바꿈은 `#`이다. [R][R]
- `Tab`은 분자→분모 이동, 첨자 종료, 굵게 종료를 각각 시험한다. `Shift+Tab`도 중첩 틀에서 역방향 시험한다. 실제 탐색 순서는 원제품에서 추가 확인해야 한다. [E][E], [R][R], [F][F]
- A2는 확정된 한컴 단축키로 배포하지 않는다. 설치된 대상 버전에서 확인한 뒤 출처·버전을 추가한다.

## B. 스크립트 문법

### B1. 해석 규칙·대소문자

| 항목 | 공식 설명과 모듈의 적용 | 출처 |
| --- | --- | --- |
| 대소문자 | 일반 명령은 대소문자를 가리지 않음. 첫 글자 대문자로 따로 적은 명령은 그 표기를 구분 | [X][X], [L][L] |
| 함수 | F가 대소문자 구별을 명시. `lim`/`Lim`, `exp`/`Exp`, `Pr` 구별. 모듈도 `sin`을 함수, `SIN`을 일반 글자로 처리 | [F][F], [L][L] |
| 그리스 문자 | G는 `alpha`와 `Alpha`를 별도 목록으로 제공. 모듈은 `Alpha`와 기존 변환기의 `ALPHA`를 Α로, `alpha`를 α로 처리. 임의 혼합 대소문자까지의 원제품 동작은 확인 필요 | [G][G], [기존 변환기](../src/renderer/js/hwpeq.js) |
| 화살표·세로줄 | `larrow`/`LARROW`, `rarrow`/`RARROW`, `uparrow`/`UPARROW`, `downarrow`/`DOWNARROW`, `udarrow`/`UDARROW`, `lrarrow`/`LRARROW`, `vert`/`VERT`는 별도 기호. 모듈도 구분 | [G][G] |
| `deg`와 `DEG` | F의 `deg`는 로만체 낱말, G의 `DEG`는 각도 기호. 모듈은 각각 `deg`, ° | [F][F], [G][G] |
| `{…}` | 여러 항을 하나로 묶음. 모듈은 괄호 자체를 표시하지 않고 위치 정보는 포함 | [X][X] |
| `"…"` | 한 낱말로 묶는 입력. 모듈은 안쪽 공백·기호를 그대로 `mtext`로 출력 | [X][X] |
| 일반 공백 | 모듈은 낱말 구분에만 사용. 보이는 공백은 `~`, 백틱으로 지정. 이는 기존 변환기와의 계약 | [기존 변환기](../src/renderer/js/hwpeq.js), [X][X] |
| 글자 수 | R은 9글자 초과를 `{…}`로 묶으라고 안내, X는 따옴표 묶음도 안내. 모듈은 9글자 제한을 재현하지 않음 | [R][R], [X][X] |
| 한글·한자 | 스크립트 창에서 입력 가능. 모듈은 `mtext`로 표시 | [R][R] |
| 모르는 낱말 | 일반 영문 변수와 미등록 명령을 문법상 확정 구별할 수 없음. 모듈은 다문자 미등록 낱말에 `unknown: true`와 경고를 주고 글자를 보존 | 모듈 정책 |

### B2. 구조·서식 명령 전체 목록

`지원`은 아래 모듈의 기능 지원이며, 한컴과 픽셀 단위 일치나 모든 암묵적 결합 규칙의 검증을 뜻하지 않는다. `확인 필요`는 공식 문법을 확정하지 못한 항목이다.

| 명령·입력 형태 | 뜻 / MathML 표현 | 상태·출처 |
| --- | --- | --- |
| `a over b` | 분수 / `mfrac` | 지원 [X][X], [L][L] |
| `a atop b` | 분수선 없이 위아래 / `mfrac linethickness="0"` | 지원 [X][X], [L][L] |
| `sqrt {x}` | 제곱근 / `msqrt` | 지원 [X][X], [L][L] |
| `root {n} of {x}` | n제곱근 / `mroot`(몸체, 지수 순서) | E의 색 예제에서 구문 확인·지원 [E][E] |
| `x^a`, `x sup a` | 위 첨자 / `msup` | 지원 [X][X] |
| `x_a`, `x sub a` | 아래 첨자 / `msub` | 지원 [X][X] |
| `x_a^b`, `x^b_a` | 양쪽 첨자 / `msubsup` | 지원. 순서·반복 결합 정책은 B6 [X][X] |
| `x lsub a lsup b` | 왼쪽 첨자 / `mmultiscripts` | **확인 필요**, 모듈 호환 확장. 열람한 공식 목록에 없음 [X][X], [L][L] |
| `sum`, `prod`, `coprod` | 합 ∑·곱 ∏·쌍대곱 ∐ | 지원 [X][X], [G][G] |
| `int`, `oint`, `dint`, `tint`, `odint`, `otint` | 적분·폐곡선 적분·이중/삼중 적분·이중/삼중 폐적분 | 지원 [L][L] |
| `union`, `inter` | 큰 합집합 ⋃·교집합 ⋂ | 지원 [X][X], [L][L] |
| `smallunion`, `smallinter`, `smallprod` | 작은 집합·곱 기호, 큰 연산자 속성 없음 | 지원. SMALL 접두 규칙 확인 [X][X] |
| `smallsum` | 작은 합 기호 | 호환 확장. SUM에 SMALL 접두 적용은 확인 필요 [X][X] |
| `sum _a ^b`, `lim _a` | 큰 연산자·극한의 범위 / `munder`·`mover`·`munderover`; 적분은 옆 첨자 | 지원 [X][X]; 배치 정책 B6 |
| `from`, `to` | 과거 아래/위 범위 | **폐기 명령**으로 명시. 요청한 호환성 때문에 `_`/`^`와 동일 지원 [X][X] |
| `lim`, `Lim` | 극한; 대소문자 구별 | 지원 [X][X], [F][F] |
| `LEFT … RIGHT …` | 내용 높이에 맞는 괄호 / `mo stretchy="true"`; `LEFT .`는 왼쪽 숨김 | 지원. **공식 인수 구문 확인 필요**: 열람한 목록에 설명 없음. 기존 변환기 출력과 사용자 요구에 맞춘 계약 [기존 변환기](../src/renderer/js/hwpeq.js), [X][X], [L][L] |
| `bigg 기호` | 큰 나눗셈 기호 등 | 지원. 모듈은 고정 2em; 원제품 정확한 배율 확인 필요 [X][X] |
| `big 기호` | BIGG와 같은 처리 | **확인 필요**, 호환 확장 [X][X], [L][L] |
| `matrix {a & b # c & d}` | 행 단위 행렬 / `mtable/mtr/mtd` | 지원 [X][X] |
| `pmatrix`, `bmatrix`, `dmatrix` | 행렬에 각각 `( )`, `[ ]`, 세로줄 추가 | 지원 [X][X], [L][L] |
| `matrix {col {a#b} lcol {c#d} rcol {e#f}}` | 열 단위 입력; 가운데·왼쪽·오른쪽 정렬 | 명령과 의미 지원. 중괄호 결합 예는 모듈 계약, 공식 예제에는 이 형식 전체가 없음 [X][X] |
| `pile`, `lpile`, `rpile` | 가운데·왼쪽·오른쪽 세로 쌓기 | 지원 [X][X], [L][L] |
| `cases {…#…}` | 여러 행을 왼쪽 중괄호로 묶기 | 지원 [X][X], [L][L] |
| `eqalign {a &= b # c &= d}` | `&` 위치를 맞춰 여러 줄 정렬 | 지원 [X][X] |
| `n choose r`, `binom n r` | 조합 / 선 없는 분수와 소괄호 | 지원 [X][X], [L][L] |
| `rel 기호 {위} {아래}` | 관계 기호 위아래에 주석 / `munderover` | 지원 [X][X] |
| `buildrel 기호 {위}` | 관계 기호 위에 주석 / `mover` | 지원 [X][X] |
| `not 기호` | 부정 사선 | 지원. 대응 유니코드가 있으면 대체, 없으면 결합 사선(복잡한 식 전체 사선과 같지는 않음) [X][X] |
| `rm`, `it`, `bold`, `rmbold` | 로만체·이탤릭체·굵은 이탤릭·굵은 로만체 | 지원 [F][F] |
| `bf` | 굵게 | **확인 필요**, `bold` 별칭 확장 [F][F], [기존 변환기](../src/renderer/js/hwpeq.js) |
| `\`, `＼` | 스크립트 안에서 로만체 전환 | 지원 [R][R] |
| `COLOR {r,g,b}{식}` | 식 일부에 RGB 색 | 지원. 정수 0~255만 허용 [E][E] |
| `SIZE n {식}` | 크기 지정 | **공식 구문·단위 확인 필요**. 모듈 확장으로 0 초과 512 이하 pt 지원 [T][T], [X][X], [L][L] |
| `SCALE n {식}` | 글자 크기 비율 | **폐기 명령**. 모듈 확장으로 0 초과 512 이하 % 지원; 과거 인수 결합 구문 확인 필요 [X][X] |
| `PHANTOM` | 과거 허깨비 명령 | 폐기 명령·미지원. 원문과 오류 플래그 유지 [X][X] |
| `LONGDIV` | 세로 나눗셈 | 이름·기능 확인, **인수 문법 확인 필요·미지원** [T][T], [T24][T24] |
| `LADDER`, `SLADDER` | 최소공배수/최대공약수, 2진수 변환 틀 | T24에서 확인. 현재 T에는 개별 행 없음. **인수 문법 확인 필요·미지원** [T24][T24], [T][T] |

### B3. 장식·공백·줄과 칸

| 명령 | 뜻 / 모듈 표시 | 출처 |
| --- | --- | --- |
| `hat {x}` | 위 모자 ^ | [X][X], [L][L] |
| `check {x}` | 위 반대 모자 ˇ | [X][X], [L][L] |
| `tilde {x}` | 위 물결 ~ | [X][X], [L][L] |
| `acute {x}`, `grave {x}` | 위 악센트 ´, 역방향 악센트 | [X][X], [L][L] |
| `dot {x}`, `ddot {x}` | 위 점·두 점 | [X][X], [L][L] |
| `bar {AB}` | 위 가로선 | [X][X], [L][L] |
| `vec {AB}`, `dyad {AB}` | 위 오른쪽·양방향 화살표 | [X][X], [L][L] |
| `arch {AB}` | 위 호 / ⏜ | [X][X] |
| `under {AB}` | 밑줄 | [X][X], [L][L] |
| `~` | 보이는 공백. 모듈 0.5em | [X][X], [기존 변환기](../src/renderer/js/hwpeq.js) |
| 백틱 U+0060 | 공백의 1/4. 모듈 0.125em | X 본문에는 백틱, 표에는 작은따옴표가 있어 **글쇠 표기 충돌**. 기존 변환기와 맞춰 백틱 채택 [X][X] |
| `'` | 모듈은 프라임 ′로 처리 | 공백으로 보는 X의 표와 충돌. **확인 필요**. 기존 출력 `prime`도 지원 [X][X], [G][G] |
| `#` | 새 행 | [X][X], [R][R] |
| `&` | 칸 구분·세로 위치 정렬 | [X][X] |

모든 장식은 `mover accent="true"`, 밑줄만 `munder accentunder="true"`를 쓴다. 모양·늘어남은 설치된 수학 글꼴과 Chromium이 결정한다. 한컴의 장식 그림을 자산으로 쓰지 않는다.

### B4. 기호 이름 전체 목록

공식 G의 7개 범주에 나온 이름을 전부 포함한다(중복은 한 행에 모음). 표시는 **모듈이 선택한 유니코드 대응**이다. 한컴 그림의 윤곽·글꼴 모양을 복제한 것이 아니다. 공식 이름만 확인하고 의미·대응을 확정하지 못한 이름은 B4-8로 분리한다.

#### B4-1. 그리스 대문자·소문자

| 소문자 이름 → 표시 | 대문자 이름 → 표시 | 출처 |
| --- | --- | --- |
| `alpha` α | `Alpha` Α | [G][G] |
| `beta` β | `Beta` Β | [G][G] |
| `gamma` γ | `Gamma` Γ | [G][G] |
| `delta` δ | `Delta` Δ | [G][G] |
| `epsilon` ε | `Epsilon` Ε | [G][G] |
| `zeta` ζ | `Zeta` Ζ | [G][G] |
| `eta` η | `Eta` Η | [G][G] |
| `theta` θ | `Theta` Θ | [G][G] |
| `iota` ι | `Iota` Ι | [G][G] |
| `kappa` κ | `Kappa` Κ | [G][G] |
| `lambda` λ | `Lambda` Λ | [G][G] |
| `mu` μ | `Mu` Μ | [G][G] |
| `nu` ν | `Nu` Ν | [G][G] |
| `xi` ξ | `Xi` Ξ | [G][G] |
| `omicron` ο | `Omicron` Ο | [G][G] |
| `pi` π | `Pi` Π | [G][G] |
| `rho` ρ | `Rho` Ρ | [G][G] |
| `sigma` σ | `Sigma` Σ | [G][G] |
| `tau` τ | `Tau` Τ | [G][G] |
| `upsilon` υ | `Upsilon` Υ | [G][G] |
| `phi` φ | `Phi` Φ | [G][G] |
| `chi` χ | `Chi` Χ | [G][G] |
| `psi` ψ | `Psi` Ψ | [G][G] |
| `omega` ω | `Omega` Ω | [G][G] |

#### B4-2. 그리스 기호·관련 문자

| 이름 | 모듈 표시·뜻 | 출처 |
| --- | --- | --- |
| `ALEPH`, `HBAR` | ℵ 알레프, ℏ 가로줄 h | [G][G] |
| `IMATH`, `JMATH` | ı, ȷ 점 없는 i/j | [G][G] |
| `ELL`, `LITER` | ℓ 필기체 l | [G][G] |
| `WP`, `IMAG` | ℘ 바이어슈트라스 p, ℑ 허수부 기호 | [G][G] |
| `ANGSTROM` | Å 옹스트롬 | [G][G] |
| `vartheta`, `varpi`, `varsigma` | ϑ, ϖ, ς 변형 문자 | [G][G] |
| `varupsilon`, `varphi`, `varepsilon` | ϒ, ϕ, ϵ 변형 문자 | [G][G] |
| `MHO` | ℧ 모 기호. G는 스크립트에서만 입력 가능하다고 설명 | [G][G] |
| `OHM` | Ω를 유니코드로 입력하라고 설명. 이름 목록에도 있어 명령 지원 여부 모순 | **확인 필요**. 모듈은 `OHM`을 원문 보존, 직접 입력한 Ω는 표시 [G][G] |

#### B4-3. 합·집합·관계

| 이름 | 모듈 표시·뜻 | 출처 |
| --- | --- | --- |
| `Sigma`, `PROD`, `COPROD` | Σ, ∏, ∐. `Sigma`는 그리스 문자이며 `sum`의 큰 연산자 동작과 구별 | [G][G] |
| `INTER`, `CAP` | ⋂ 큰 교집합, ∩ 교집합 | [G][G], [X][X] |
| `SQCAP`, `SQCUP` | ⊓, ⊔ 사각 교집합·합집합 | [G][G] |
| `OPLUS`, `OMINUS`, `OTIMES`, `ODOT`, `OSLASH` | ⊕, ⊖, ⊗, ⊙, ⊘ 원 안 연산 | [G][G] |
| `VEE`, `WEDGE` | ∨, ∧ 논리합·논리곱 | [G][G] |
| `SUBSET`, `SUPSET`, `SUBSETEQ`, `SUPSETEQ` | ⊂, ⊃, ⊆, ⊇ 포함 관계 | [G][G] |
| `IN`, `OWNS`, `notin` | ∈, ∋, ∉ 원소 관계 | [G][G] |
| `LE`, `LEQ`, `GE`, `GEQ` | ≤, ≥ 이하·이상 | [G][G] |
| `SQSUBSET`, `SQSUPSET`, `SQSUBSETEQ`, `SQSUPSETEQ` | ⊏, ⊐, ⊑, ⊒ 사각 포함 관계 | [G][G] |
| `<<`, `>>`, `LLL`, `>>>` | ≪, ≫, ⋘, ⋙ 훨씬 작음·큼 | [G][G] |
| `PREC`, `SUCC`, `UPLUS` | ≺, ≻ 선행·후행, ⊎ 분리 합집합 | [G][G] |

#### B4-4. 연산·논리

| 이름 | 모듈 표시·뜻 | 출처 |
| --- | --- | --- |
| `PLUSMINUS`, `MINUSPLUS` | ±, ∓ 복호 | [G][G] |
| `times`, `DIV`, `DIVIDE` | ×, ÷ 곱셈·나눗셈 | [G][G] |
| `CIRC`, `BULLET`, `DEG` | ∘ 합성 원, ∙ 점, ° 도 | [G][G] |
| `AST`, `STAR`, `BIGCIRC` | ∗ 별표, ⋆ 별, ○ 큰 원 | [G][G] |
| `EMPTYSET`, `THEREFORE`, `BECAUSE` | ∅ 공집합, ∴ 따라서, ∵ 왜냐하면 | [G][G] |
| `EXIST`, `FORALL` | ∃ 존재, ∀ 모든 | [G][G] |
| `ne`, `neq`, `!=`, `DOTEQ` | ≠ 같지 않음, ≐ 점 등호 | [G][G] |
| `SIM`, `APPROX`, `SIMEQ`, `CONG` | ∼ 닮음, ≈ 근사, ≃, ≅ 합동 계열 | [G][G] |
| `==`, `EQUIV`, `ASYMP` | ≡ 동치, ≍ 점근 관계 | [G][G] |
| `DIAMOND`, `prime`, `PARTIAL`, `inf` | ◇ 마름모, ′ 프라임, ∂ 편미분, ∞ 무한대 | [G][G] |
| `LNOT`, `PROPTO` | ¬ 부정, ∝ 비례 | [G][G] |
| `TRIANGLED`, `DAGGER`, `DDAGGER` | ▽ 역삼각형, †, ‡ 단검·겹단검 | [G][G] |
| `IDENTICAL`, `image`, `REIMAGE`, `ISO`, `DSUM`, `XOR` | 이름은 공식 목록에 있음. 정확한 의미·글리프 대응은 B4-8 | 확인 필요 [G][G] |

#### B4-5. 화살표

| 이름 | 모듈 표시·뜻 | 출처 |
| --- | --- | --- |
| `larrow`, `rarrow`, `uparrow`, `downarrow` | ←, →, ↑, ↓ 단선 방향 | [G][G] |
| `LARROW`, `RARROW`, `UPARROW`, `DOWNARROW` | ⇐, ⇒, ⇑, ⇓ 이중선 방향 | [G][G] |
| `udarrow`, `lrarrow`, `UDARROW`, `LRARROW` | ↕, ↔, ⇕, ⇔ 양방향 | [G][G] |
| `nwarrow`, `searrow`, `nearrow`, `swarrow` | ↖, ↘, ↗, ↙ 대각선 방향 | [G][G] |
| `hookleft`, `hookright`, `mapsto` | ↩, ↪ 갈고리 화살표, ↦ 대응 | [G][G] |
| `vert`, `VERT` | 단일 세로줄, ‖ 이중 세로줄 | [G][G] |

#### B4-6. 기타 기호

| 이름 | 모듈 표시·뜻 | 출처 |
| --- | --- | --- |
| `cdots`, `LDOTS`, `VDOTS`, `DDOTS` | ⋯ 가운데·… 아래·⋮ 세로·⋱ 대각 점줄 | [G][G] |
| `TRIANGLE`, `TRIANGLED` | △, ▽ 삼각형 | [G][G] |
| `ANGLE`, `MSANGLE`, `SANGLE`, `RTANGLE` | ∠ 각, ∡ 측정각, ∢ 구면각, ∟ 직각 | [G][G] |
| `VDASH`, `BOT`, `TOP`, `MODELS` | ⊢ 유도, ⊥ 수직/바닥, ⊤ 꼭대기, ⊨ 만족 관계 | [G][G] |
| `CENTIGRADE`, `FAHRENHEIT` | ℃, ℉ 온도 | [G][G] |
| `HLEFT`, `LAPLACE`, `LSLANT`, `RSLANT`, `att`, `hund`, `thou`, `well`, `base`, `benzene` | 이름은 공식 목록에 있음. 정확한 의미·글리프 대응은 B4-8 | 확인 필요 [G][G] |

#### B4-7. 기존 변환기와의 호환 별칭

공식 G에서 찾지 못한 이름을 공식 지원으로 주장하지 않는다. 다음은 기존 코드 또는 이 모듈의 명시적 호환 확장이다. 모두 뜻에 해당하는 유니코드로 출력한다. [기존 변환기](../src/renderer/js/hwpeq.js)

| 입력 | 뜻·표시 | 공식 확인 상태 |
| --- | --- | --- |
| `cdot`, `cup`, `nabla`, `perp`, `parallel`, `box` | ⋅, ∪, ∇, ⊥, ∥, □ | 해당 이름은 열람 목록에서 확인 필요 |
| `pm`, `mp`, `+-`, `-+` | ±, ∓ | 별칭 확인 필요 |
| `<=`, `>=`, `lt`, `gt`, `ll`, `gg`, `<<<` | ≤, ≥, <, >, ≪, ≫, ⋘ | 별칭 확인 필요 |
| `->`, `<-`, `<->` | →, ←, ↔ | X의 극한·REL 예제로 `->`, `<->` 확인, `<-` 별칭 확인 필요 [X][X] |
| `=>`, `<=>`, `exists` | ⇒, ⇔, ∃ | 모듈 별칭, 확인 필요 |
| `lbrace`, `rbrace`, `langle`, `rangle`, `lfloor`, `rfloor`, `lceil`, `rceil` | 중괄호·꺾쇠·바닥·천장 괄호 | 기존 변환기 호환, 공식 이름 확인 필요 |
| 임의 유니코드 기호 | 이미 들어온 기호는 그대로 XML 이스케이프하여 표시 | 명령 이름으로 재해석하지 않음 |

#### B4-8. 확인하지 못한 글리프

`IDENTICAL`, `image`, `REIMAGE`, `ISO`, `DSUM`, `XOR`, `HLEFT`, `LAPLACE`, `LSLANT`, `RSLANT`, `att`, `hund`, `thou`, `well`, `base`, `benzene`: 공식 G에 **이름은 확인**했지만, 텍스트에 의미 설명이 없고 그림의 정확한 유니코드 대응을 검증하지 못했다. **뜻·표시 확인 필요**. 추정 기호로 대체하지 않으며 현재 모듈은 `unsupported-command`와 원문을 남긴다. OHM의 별도 모순은 B4-2 참조. [G][G]

### B5. 함수 이름 전체

| 입력 이름 | 뜻·표시 | 출처 |
| --- | --- | --- |
| `sin`, `cos`, `tan`, `cot`, `sec`, `cosec`, `csc` | 삼각함수; 로만체 | [L][L], [F][F] |
| `arcsin`, `arccos`, `arctan`, `arc` | 역삼각함수 계열; 로만체 | [L][L], [F][F] |
| `sinh`, `cosh`, `tanh`, `coth` | 쌍곡선 함수; 로만체 | [L][L], [F][F] |
| `log`, `ln`, `lg` | 로그 계열; 로만체. `ln`은 L에 있음 | [L][L], [F][F] |
| `lim`, `Lim`, `max`, `min` | 극한·최대·최소; 모듈은 범위를 아래위 배치 | [L][L], [F][F] |
| `exp`, `Exp`, `det`, `gcd`, `mod` | 지수·행렬식·최대공약수·나머지; 로만체 | [L][L], [F][F] |
| `if`, `for`, `and`, `hom`, `ker`, `deg`, `arg`, `dim`, `Pr`, `or` | 조건·접속어·준동형·핵·차수·편각·차원·확률 등, 로만체 낱말 | [F][F] |

F는 명령어 입력 상자에 함수를 입력하면 기본 함수로 인식하지 않는다고 따로 경고한다. 위 모듈은 **스크립트 파서**이므로 목록의 정확한 철자를 로만체로 표시한다. UI를 만들 때 명령어 입력 상자와 스크립트 창의 동작을 합치지 않는다. [F][F]

### B6. 모듈 계약·확인되지 않은 세부 결합

- `over/atop/choose`는 현재 그룹·칸 안의 좌우 식 전체를 잡는다. 따라서 `x+{1 over 2}`처럼 분수를 묶는다. `BIGG`는 양쪽 분수 사이 경계로 취급한다. 기존 `latexToHwpEq`의 그룹 출력과 일치한다.
- 한 인수는 `{그룹}` 또는 숫자/낱말/명령 한 토큰이다. 예: `sqrt {x^2}`와 `sqrt {x}^2`는 다르다. 붙은 영문 낱말은 원문 그대로 보존하되 화면에는 글자별 `mi`로 표시한다.
- `_`와 `^` 순서는 무관하다. 반복된 같은 첨자는 오른쪽부터 묶는다(`x^a^b` → `x^(a^b)`). 한컴에서 이 암묵 결합은 **확인 필요**이므로 내보내는 코드에서는 중괄호를 권장한다.
- `sum/prod/coprod/union/inter/lim/Lim/max/min`은 위아래 한계, 적분은 옆 첨자. 인라인에서도 합 한계 위치를 유지한다. MathML 기본 축소·간격은 한컴의 자체 레이아웃과 다를 수 있다.
- `rm/it/bold/rmbold`는 현재 sequence 안에서 뒤 글자에 적용되고 중괄호를 벗어나면 바깥 상태로 돌아간다. 색·크기는 뒤의 인수 하나에만 적용. 이 상세 범위는 모듈 계약이며 한컴의 모든 비주얼 선택 범위와 같다고 보장하지 않는다.
- `eqalign`은 열별 오른쪽/왼쪽 맞춤을 교대로 사용한다. pile 정렬은 모든 칸에 적용. 행렬의 빈 칸도 위치를 가진 노드로 보존한다. `col/lcol/rcol`은 화면 행으로 전치하되 각 칸의 원문 범위를 유지한다.
- 쌍이 맞지 않는 괄호·닫히지 않은 따옴표·미지원 명령은 `raw`와 오류로 남겨 `mtext`로 표시한다. 인수가 빠졌으면 빈 노드와 `missing-argument`를 남긴다. 오류가 있어도 나머지 식은 가능한 만큼 표시한다.
- 재귀 깊이 96단계에서 해당 구간을 원문으로 폴백한다. 글꼴 전환만 반복한 입력에도 같은 한계를 적용한다. 아무 입력이나 무제한 깊이로 재귀하지 않는다.
- 원문은 HTML·CSS로 실행하지 않는다. 글자·속성은 XML 이스케이프하며 NUL 등 XML 불가 문자와 단독 서로게이트는 U+FFFD로 대체. 색과 크기는 숫자로 검증 후에만 CSS 값을 만든다.

## C. 도구 모음 목록

공식 T/T24의 이름을 전부 포함한다. 아래 예시는 **모듈에서 사용할 삽입 템플릿**이다. 공식 문서에 도구의 실제 클릭 결과 문자열까지 없는 경우 그 결과를 추정했다고 주장하지 않는다. 아이콘·메뉴의 세부 배열과 하위 템플릿 전부는 원제품 확인 필요.

### C1. 틀

| 묶음 | 넣을 스크립트·동작 | 출처 |
| --- | --- | --- |
| 첨자 | `{x}^{a}`, `{x}_{b}`, `{x}_{b}^{a}` | [T][T], [X][X] |
| 장식 기호 | B3의 `hat/check/tilde/acute/grave/dot/ddot/bar/vec/dyad/under/arch {x}` | [T][T], [X][X] |
| 분수 | `{a} over {b}`, `{a} atop {b}` | [T][T], [X][X] |
| 근호 | `sqrt {x}`, `root {n} of {x}` | [T][T], [E][E] |
| 합 기호 | `sum _{k=1}^{n}`, `prod`, `union`, `inter` | [T][T], [X][X] |
| 적분 | `int _a ^b`, `oint`, `dint`, `tint`, `odint`, `otint` | [T][T], [L][L] |
| 극한 | `lim _{x -> a}`, `Lim` | [T][T], [X][X] |
| 나눗셈 / 세로 나눗셈 | `LONGDIV`까지만 확인. 인수·삽입 문자열 확인 필요 | [T][T], [T24][T24] |
| 최소공배수/최대공약수 | `LADDER`까지만 확인. 인수 확인 필요 | [T24][T24] |
| 2진수로 변환 | `SLADDER`까지만 확인. 인수 확인 필요 | [T24][T24] |
| 상호 관계 | `rel -> {위} {아래}`, `buildrel -> {위}` | [T][T], [X][X] |
| 괄호 | 모듈 템플릿 `LEFT ( {x} RIGHT )` 등. 실제 삽입 문자열은 확인 필요 | [T][T], B2 |
| 경우 | `cases {식 & 조건 # 식 & 조건}` | [T][T], [X][X] |
| 세로 쌓기 | `pile {a#b}`, `lpile`, `rpile` | [T][T], [X][X] |
| 행렬 | `matrix {a&b#c&d}`, `pmatrix`, `bmatrix`, `dmatrix` | [T][T], [X][X] |

### C2. 기호 묶음

| 묶음 | 넣는 스크립트 | 출처 |
| --- | --- | --- |
| 그리스 대문자 | B4-1의 `Alpha`~`Omega` | [T][T], [G][G] |
| 그리스 소문자 | B4-1의 `alpha`~`omega` | [T][T], [G][G] |
| 그리스 기호 | B4-2 전체 | [T][T], [G][G] |
| 합, 집합 기호 | B4-3 전체 | [T][T], [G][G] |
| 연산, 논리 기호 | B4-4 전체 | [T][T], [G][G] |
| 화살표 | B4-5 전체; 대소문자 보존 | [T][T], [G][G] |
| 기타 기호 | B4-6 전체; 미검증 기호는 B4-8 참조 | [T][T], [G][G] |

### C3. 나머지 도구 전부

| 이름 | 스크립트 또는 기능·미확인 범위 | 출처 |
| --- | --- | --- |
| 문자표 | 유니코드 문자 선택; 직접 키 미확인 | [T][T] |
| 명령어 입력 | 선택한 명령을 입력; 비주얼 창의 `\`로 진입 | [T][T] |
| 수식 매크로 | 자주 쓰는 수식 등록·불러오기·저장(JSON). 고정 스크립트 아님 | [T][T], [T24][T24] |
| 수식 형식 변경 | MathML 파일 불러오기·저장 등. 고정 스크립트 아님 | [T][T] |
| 수식 글꼴 | 글꼴 선택. `rm/it/bold/rmbold`와 파일 글꼴 지정은 별개 | [T][T], [F][F] |
| 글자 크기 | 크기 선택. 실제 생성 스크립트는 확인 필요 | [T][T] |
| 글자 색 | 색 선택. 일부 영역의 `COLOR` 문법은 E에서 확인 | [T][T], [E][E] |
| 화면 확대 | 편집 보기 확대. 수식 스크립트 아님 | [T][T] |
| 줄 맞춤 | 정렬 조작. 도구가 내보내는 문자열은 확인 필요 | [T][T] |
| 줄 바꿈 | 비주얼 `Enter`, 스크립트 `#` | [T][T], [R][R] |
| 이전 항목 | `Shift+Tab`에 해당하는 이동 | [T][T], [R][R] |
| 다음 항목 | `Tab`에 해당하는 이동 | [T][T], [R][R] |
| 글자 단위 영역 | 편집 영역 선택 도구. 고정 스크립트 없음, 세부 동작 확인 필요 | [T][T] |
| 줄 단위 영역 | 편집 영역 선택 도구. 고정 스크립트 없음, 세부 동작 확인 필요 | [T][T] |
| 넣기 | `Shift+Esc`, 수식 확정·본문 삽입 | [T][T], [E][E] |

## 모듈 API와 검증

파일: [hwpeqview.js](../src/renderer/js/hwpeqview.js). DOM·네트워크·추가 npm 의존성 없음. 기존 [hwpeq.js](../src/renderer/js/hwpeq.js)는 수정하지 않는다.

```js
eqToMathML('{1} over {2}', { display: true }); // <math …>…</math>
parseEq('sqrt {x}'); // 위치·오류 정보를 포함한 트리
eqToText('{1} over {2}'); // 1/2
```

### 구문 트리 계약

- 모든 노드: `type`, `start`, `end`, `error`. 위치는 **원문 UTF-16 인덱스, 반열린 구간 [start,end)**. trim이나 정규화를 하기 전 원문 기준이다. 루트는 공백까지 포함한 전체 범위.
- 루트 `errors`: `{ code, start, end, severity }[]`. 자식의 오류를 부모 `error`에도 전파. `unknown-word`만 warning이며 일반 변수일 수 있으므로 `error`는 올리지 않는다.
- `sequence.children`, `group.body`, `fence.body/left/right`, `fraction.numerator/denominator/kind`, `root.body/index`, `script.base/sub/sup/lsub/lsup`, `accent.body/kind`, `relation.base/sub/sup`가 틀 칸 탐색에 쓰일 자식이다.
- `table.rows[]` → `row.cells[]` → `cell.body`. 빈 칸도 유지한다. 열 단위 입력의 표시 순서와 원문 순서는 다를 수 있으므로 단순 인접 노드 인덱스를 커서 위치로 쓰지 않는다.
- `color.spec/body`, `size.spec/body`: 설정값의 원문 범위도 별도 노드. `style.font`: 글꼴 전환. `raw.value`: 복구하지 못한 원문. `identifier.unknown`: 미등록 낱말 여부.
- 주요 오류 코드: `unclosed-group`, `unclosed-quote`, `unclosed-table`, `missing-right`, `invalid-delimiter`, `missing-of`, `missing-argument`, `missing-table-body`, `unexpected-token`, `invalid-color`, `invalid-size`, `unsupported-command`, `depth-limit`.
- 평문은 검색용이며 역변환용이 아니다. 분수 `1/2`, 근호 `√x`, 행 구분 LF·칸 구분 탭. 복합 분수 항에는 괄호를 붙이고 장식은 `bar(AB)`처럼 보존한다.

### 시험·샘플 재생성

```powershell
node --test test/unit/hwpeqview.test.mjs
npm test
node test/e2e/hwpeqview-sample.mjs
node test/e2e/hwpeqview-sample.mjs --screenshot
```

스크린숏 실행은 기존 `test/lib/playwright.mjs`를 사용한다. Playwright가 별도 경로에 설치되어 있으면 실행 환경에서 `NODE_PATH`를 지정한다(새 의존성 설치 없음). HTML은 `test/e2e/out/hwpeqview.html`, 그림은 `test/e2e/out/hwpeqview.png`. 결과 파일은 기존 `.gitignore`에 따라 커밋하지 않는다. 생성 스크립트는 커밋한다.

단위 시험은 태그 인수 수·전체 문법군·이스케이프·위치·평문·불완전 입력·깊이 제한·결정적 무작위 깨진 입력과 기존 `hwpeq.test.mjs`의 `cases`/`MEASURED` 배열 전체를 검사한다. 스크린숏 실행에서는 Electron의 MathML namespace, XML 파싱, 수식의 실제 크기, 분수 상하 배치·근호·행렬·주입 방지도 검사한다.

### 남은 차이

- LONGDIV/LADDER/SLADDER, PHANTOM, B4-8의 특수 기호와 OHM 명령은 원문 폴백. 공식 인수·글리프 추가 확인 전 구현하지 않음.
- A2 단축키와 세부 하위 틀, 공식 목록에 빠진 LEFT/RIGHT·SIZE 등의 세부 문법, 9글자 단위 제한, 반복 첨자의 암묵 결합은 원제품 검증이 필요.
- MathML은 네이티브 수학 글꼴을 사용하므로 한컴 수식 글꼴의 폭·간격·모든 장식 윤곽까지 동일하지 않음. 이번 범위는 표시 모듈이며 편집기 UI·내보내기·단축키 등록은 만들지 않음.

[E]: https://help.hancom.com/docs/ko-KR/mergedProjects/hoffice_hwp/topics/hancomoffice/hwp/insert/equation/equation.htm
[S]: https://help.hancom.com/docs/ko-KR/mergedProjects/hoffice_hwp/topics/hancomoffice/hwp/view/toolbar/shortcut%28table%29.htm
[X]: https://help.hancom.com/docs/ko-KR/mergedProjects/hoffice_hwp/topics/hancomoffice/hwp/insert/equation/equation%28explanation%29.htm
[T]: https://help.hancom.com/docs/ko-KR/mergedProjects/hoffice_hwp/topics/hancomoffice/hwp/insert/equation/equation%28toolbar%29.htm
[L]: https://help.hancom.com/hoffice130_assistant/ko-KR/Hwp/insert/equation/equation%28script%29.htm
[R]: https://help.hancom.com/hoffice130_assistant/ko-KR/Hwp/insert/equation/equation%28rule%29.htm
[F]: https://help.hancom.com/hoffice130_assistant/ko-KR/Hwp/insert/equation/equation%28font%29.htm
[G]: https://help.hancom.com/hoffice130_assistant/ko-KR/Hwp/insert/equation/equation%28symbol%29.htm
[T24]: https://help.hancom.com/hoffice130_assistant/ko-KR/Hwp/insert/equation/equation%28toolbar%29.htm
[S22]: https://help.hancom.com/hoffice120/ko-KR/Hwp/view/toolbar/shortcut%28table%29.htm
