// 국어·영어 시험 자료용 글 (make-passages.mjs). 모두 이 저장소를 위해 새로 쓴 글이라 저작권 걱정 없음.

/** 국어 독서 지문 (화제마다 문단 재료) */
export const KO_TOPICS = {
  classify: [
    '도서관은 많은 책을 정해진 기준에 따라 나누어 배열함으로써 이용자가 원하는 자료를 쉽게 찾을 수 있도록 한다.',
    '이처럼 자료를 주제에 따라 나누는 일을 분류라고 하며, 분류의 기준을 체계적으로 정리한 것을 분류표라고 한다.',
    '십진분류법은 모든 지식을 열 개의 큰 갈래로 나누고, 각 갈래를 다시 열 개씩 나누어 숫자로 표시한다.',
    '이 방식은 숫자만 보고도 자료의 주제와 서가의 위치를 짐작할 수 있다는 장점이 있다.',
    '그러나 새로운 학문이 생겨날 때마다 기존의 번호 체계 안에 억지로 끼워 넣어야 한다는 한계가 지적되기도 한다.',
    '1970년대 이후 여러 도서관은 이러한 한계를 보완하기 위해 주제어를 함께 붙이는 방식을 도입하였다.',
    '주제어는 자료의 핵심 내용을 몇 개의 낱말로 나타낸 것으로, 하나의 자료에 여러 개를 붙일 수 있다.',
    '따라서 이용자는 분류 번호를 몰라도 주제어를 통해 관련 자료를 한꺼번에 찾을 수 있게 되었다.',
  ],
  light: [
    '식물은 빛에너지를 이용하여 이산화 탄소와 물로부터 포도당을 만드는데, 이 과정을 광합성이라고 한다.',
    '광합성은 엽록체에서 일어나며, 엽록체 안의 엽록소는 주로 붉은빛과 푸른빛을 흡수한다.',
    '초록빛은 상대적으로 적게 흡수되고 반사되기 때문에 대부분의 잎은 초록색으로 보인다.',
    '빛의 세기가 강해지면 광합성 속도는 빨라지지만, 일정한 세기를 넘으면 더 이상 빨라지지 않는다.',
    '이때의 빛의 세기를 광포화점이라고 하며, 그 값은 식물의 종류에 따라 다르다.',
    '그늘에서 잘 자라는 식물은 광포화점이 낮아 약한 빛에서도 효율적으로 양분을 만든다.',
    '반면 햇빛이 강한 곳에 사는 식물은 광포화점이 높아 강한 빛을 충분히 활용할 수 있다.',
    '여러 요인이 함께 작용할 때에는 가장 부족한 요인이 광합성 속도를 결정한다는 점도 알려져 있다.',
  ],
  money: [
    '화폐는 물건을 사고팔 때 교환의 매개 역할을 하며, 물건의 가치를 재는 척도가 되기도 한다.',
    '물물 교환에서는 서로 원하는 물건을 가진 상대를 찾아야 했기 때문에 거래가 쉽게 이루어지지 않았다.',
    '화폐가 등장하면서 사람들은 원하는 시기에 원하는 물건을 살 수 있게 되었다.',
    '초기의 화폐는 조개껍데기나 곡식처럼 그 자체로 가치를 지닌 물건이었다.',
    '이후 금속 화폐를 거쳐 종이 화폐가 널리 쓰이게 되었는데, 종이 화폐의 가치는 발행 기관에 대한 신뢰에서 나온다.',
    '오늘날에는 실물 없이 전자적 기록만으로 거래가 이루어지는 경우가 점점 늘고 있다.',
    '이러한 변화는 거래의 편리성을 높였지만, 기록을 안전하게 관리해야 하는 새로운 과제를 남겼다.',
    '결국 화폐의 형태는 달라져도 사회 구성원의 믿음이 화폐를 지탱한다는 점은 변하지 않았다.',
  ],
  memory: [
    '사람의 기억은 정보를 받아들이는 부호화, 정보를 유지하는 저장, 필요할 때 꺼내는 인출의 단계로 설명된다.',
    '감각 기관을 통해 들어온 정보 가운데 주의를 기울인 일부만이 단기 기억으로 넘어간다.',
    '단기 기억은 용량이 작고 유지 시간이 짧아서 되뇌지 않으면 곧 사라진다.',
    '반복과 정교화를 거친 정보는 장기 기억으로 옮겨져 오랫동안 남게 된다.',
    '장기 기억으로 옮기는 과정에서 해마가 중요한 역할을 한다는 사실이 여러 연구를 통해 밝혀졌다.',
    '해마가 손상된 사람은 오래전 일은 기억하면서도 새로운 일을 기억하는 데 어려움을 겪는다.',
    '한편 인출에 실패하는 것은 정보가 사라져서가 아니라 알맞은 단서를 찾지 못해서인 경우가 많다.',
    '그래서 정보를 익힐 때의 상황과 비슷한 상황에서 떠올리면 기억이 더 잘 난다.',
  ],
  law: [
    '법조문은 일반적인 언어로 쓰여 있어서 구체적인 사건에 적용하려면 해석이 필요하다.',
    '문리 해석은 법조문에 쓰인 낱말과 문장의 뜻에 충실하게 의미를 밝히는 방법이다.',
    '체계 해석은 해당 조문을 다른 조문과의 관계 속에서 이해하여 법 전체가 모순 없이 작동하도록 한다.',
    '목적 해석은 법이 만들어진 목적을 고려하여 조문의 의미를 정하는 방법이다.',
    '이들 방법은 서로 배타적인 것이 아니라 함께 쓰이면서 해석의 타당성을 높인다.',
    '다만 해석이라는 이름으로 법조문의 문언을 벗어나는 결론을 내리는 것은 경계해야 한다.',
    '법관은 해석의 결과가 법적 안정성과 구체적 타당성을 함께 갖추도록 신중히 판단해야 한다.',
    '1990년대 이후 판결문을 공개하는 범위가 넓어지면서 해석의 근거를 살펴보기도 쉬워졌다.',
  ],
  stars: [
    '밤하늘의 별은 밝기가 서로 다르게 보이는데, 이는 별이 내는 빛의 양과 별까지의 거리가 다르기 때문이다.',
    '맨눈으로 보이는 밝기를 겉보기 등급이라고 하며, 숫자가 작을수록 더 밝은 별이다.',
    '등급이 한 단계 작아지면 밝기는 약 2.5배 밝아진다.',
    '모든 별을 같은 거리에 놓았다고 가정하고 정한 밝기를 절대 등급이라고 한다.',
    '절대 등급을 비교하면 별이 실제로 내는 빛의 양을 알 수 있다.',
    '겉보기 등급과 절대 등급의 차이를 이용하면 별까지의 거리를 계산할 수 있다.',
    '이 방법은 직접 거리를 재기 어려운 먼 별을 연구할 때 특히 유용하다.',
    '다만 별빛이 우주 먼지에 가려 어두워지는 효과를 함께 고려해야 정확한 값을 얻는다.',
  ],
};

/** 문학: 시 (연은 빈 줄로) */
export const KO_POEMS = [
  {
    lines: ['산 너머 저 멀리', '바람이 분다', '', '낮은 지붕 위로', '저녁이 내려앉고', '아이들은 하나둘', '골목을 떠난다', '', '나는 오래 서서', '불 켜지는 창을 센다', '하나, 또 하나', '누군가의 하루가 저문다'],
    src: '- 한별, 「저녁 들판」 -',
  },
  {
    lines: ['물은 낮은 곳으로 흘러', '돌을 둥글게 만든다', '', '서두르지 않아도', '끝내 바다에 닿는', '그 고요한 걸음을', '', '나는 오늘에야', '배우려 한다'],
    src: '- 윤서하, 「강가에서」 -',
  },
  {
    lines: ['눈 덮인 길 위에', '발자국 하나 남기고', '', '돌아보면 어느새', '하얗게 지워진 자리', '', '그래도 나는 걷는다', '지워질 줄 알면서도', '새로 찍는 걸음으로'],
    src: '- 김도윤, 「눈길」 -',
  },
];

/** 문학: 산문 문단 */
export const KO_PROSE = [
  '그날 아침, 나는 오래된 우체국 앞에서 걸음을 멈추었다. 유리문 너머로 낡은 저울과 빛바랜 안내문이 보였다.',
  '어린 시절 아버지는 이곳에서 먼 곳에 사는 친척에게 편지를 부치곤 하였다. 나는 그 곁에서 우표에 침을 바르는 일을 맡았다.',
  '편지가 도착하기까지는 보름이 넘게 걸렸지만, 아버지는 한 번도 서두르는 기색을 보이지 않았다.',
  '"기다리는 동안에도 마음은 벌써 가 있는 거란다." 아버지는 그렇게 말하며 봉투의 모서리를 손끝으로 눌렀다.',
  '이제 나는 손바닥만 한 기계로 몇 초 만에 소식을 주고받는다. 그런데도 마음이 닿았다는 느낌은 그때보다 옅다.',
  '나는 문을 밀고 들어가 오래 쓰지 않던 편지 봉투 한 장을 샀다. 무엇을 쓸지는 아직 정하지 못한 채였다.',
  '창구의 직원은 우표를 건네며 요즘은 이런 손님이 드물다고 웃었다. 나도 따라 웃었지만 목이 조금 메었다.',
  '밖으로 나오니 해가 높이 떠 있었다. 나는 봉투를 가슴께에 품고 천천히 집으로 걸었다.',
];

/** 국어 발문 */
export const KO_ASK = [
  '윗글의 내용과 일치하지 않는 것은?',
  '윗글을 이해한 내용으로 가장 적절한 것은?',
  '윗글에 대한 설명으로 가장 적절한 것은?',
  '㉠과 ㉡에 대한 설명으로 적절하지 않은 것은?',
  '문맥상 ⓐ～ⓔ와 바꾸어 쓰기에 가장 적절한 것은?',
  '윗글의 서술상 특징으로 가장 적절한 것은?',
];
export const KO_ASK_BOGI = '윗글을 바탕으로 <보기>를 이해한 반응으로 가장 적절한 것은? [3점]';
export const KO_ASK_LIT = ['(가)와 (나)에 대한 설명으로 가장 적절한 것은?', '[A]에 대한 이해로 가장 적절한 것은?', '윗글의 서술상 특징으로 가장 적절한 것은?', '(가)～(다)를 감상한 내용으로 적절하지 않은 것은?'];
export const KO_ASK_GRAMMAR = ['<보기>의 ㉠～㉤에 대한 설명으로 적절한 것은?', '<보기>를 바탕으로 탐구한 내용으로 가장 적절한 것은?'];

/** 국어 선지 */
export const KO_CHOICES = [
  '분류표는 자료를 주제에 따라 나누는 기준을 정리한 것이다.',
  '새로운 학문이 생기면 기존 체계를 고칠 필요가 없다.',
  '주제어는 하나의 자료에 한 개만 붙일 수 있다.',
  '엽록소는 초록빛을 가장 많이 흡수한다.',
  '광포화점은 모든 식물에서 같은 값을 지닌다.',
  '그늘에서 자라는 식물은 약한 빛에서도 양분을 만든다.',
  '종이 화폐의 가치는 발행 기관에 대한 신뢰에서 나온다.',
  '물물 교환은 화폐를 쓰는 거래보다 늘 편리하였다.',
  '단기 기억은 용량이 크고 오래 유지된다.',
  '인출 실패는 단서를 찾지 못해 생기는 경우가 많다.',
  '문리 해석은 조문의 목적만을 고려하는 방법이다.',
  '여러 해석 방법은 서로 함께 쓰일 수 있다.',
  '겉보기 등급은 숫자가 클수록 밝은 별이다.',
  '절대 등급으로 별이 실제로 내는 빛의 양을 비교한다.',
  '대상의 변화를 시간의 흐름에 따라 서술하고 있다.',
  '구체적인 사례를 들어 개념을 설명하고 있다.',
  '대립하는 두 견해를 절충하여 결론을 내리고 있다.',
  '화자는 지나간 시간을 떠올리며 그리움을 드러낸다.',
  '자연물에 빗대어 삶의 태도를 성찰하고 있다.',
  '서술자가 인물의 내면을 직접 드러내고 있다.',
];
export const KO_SHORT_CHOICES = ['㉠, ㉡', '㉠, ㉢', '㉡, ㉣', '㉢, ㉤', '㉣, ㉤'];
export const KO_BOGI = [
  '어떤 도서관은 새로 들어온 자료에 분류 번호와 함께 주제어를 세 개씩 붙인다. 이용자는 주제어 검색만으로도 서로 다른 서가에 꽂힌 관련 자료를 한 번에 확인할 수 있다.',
  '같은 화분에 심은 두 식물 가운데 하나는 창가에, 다른 하나는 방 안쪽에 두었다. 한 달 뒤 창가의 식물은 잎이 크게 자랐지만, 방 안쪽의 식물은 잎의 크기가 거의 변하지 않았다.',
  '㉠ 하늘이 맑다. ㉡ 동생이 책을 읽었다. ㉢ 꽃이 예쁘게 피었다. ㉣ 나는 친구에게 선물을 주었다. ㉤ 바람이 시원하게 분다.',
  '한 시인은 자연 속에서 발견한 작은 변화를 통해 삶의 태도를 되돌아보았다. 그는 서두르지 않는 자연의 움직임에서 기다림의 가치를 읽어 내었다.',
];

/** 영어 지문 (화제마다 문장 재료) */
export const EN_TOPICS = {
  habit: [
    'Many people believe that changing a habit requires a strong will, but the environment often matters more.',
    'When a tempting snack is placed out of sight, people eat it far less often, even if they still like it.',
    'Small changes in our surroundings can quietly guide our choices without any conscious effort.',
    'For example, keeping running shoes by the door makes it easier to go for a run in the morning.',
    'On the other hand, a phone left on the desk invites us to check messages again and again.',
    'Designing the space around us, therefore, is a practical way to support the behavior we want.',
    'Rather than relying on willpower alone, we can make good actions easy and bad actions difficult.',
    'Over time, these simple adjustments can produce results that motivation alone rarely achieves.',
  ],
  science: [
    'Scientific progress is often described as the work of a lonely genius, but this picture is misleading.',
    'Most discoveries depend on the careful work of many researchers who share data and test each other\'s ideas.',
    'A single experiment rarely settles a question, because results must be repeated by different teams.',
    'When other scientists cannot reproduce a finding, the original claim is treated with caution.',
    'This process may seem slow, yet it protects the community from accepting errors too quickly.',
    'In 1953, the structure of a famous molecule was described by a small team that relied on images made by others.',
    'Such cases show that knowledge grows through cooperation rather than through isolated effort.',
    'Recognizing this helps young researchers value open discussion as much as individual brilliance.',
  ],
  attention: [
    'Digital devices allow us to reach information instantly, but they also compete for our limited attention.',
    'Every notification interrupts what we are doing and forces the brain to shift its focus.',
    'After such an interruption, it can take several minutes to return fully to the original task.',
    'People who switch tasks frequently often feel busy while accomplishing surprisingly little.',
    'Some workers now set aside blocks of time during which all alerts are turned off.',
    'They report that their work becomes deeper and that they feel less tired at the end of the day.',
    'The lesson is not that technology is harmful, but that it should be used with clear intention.',
    'By deciding when to connect, we can enjoy its benefits without losing control of our time.',
  ],
  wolves: [
    'Wolves were removed from many national parks in the early twentieth century to protect farm animals.',
    'Without these predators, the number of deer increased rapidly and young trees were eaten before they could grow.',
    'When wolves were brought back, deer began to avoid open valleys where they could easily be hunted.',
    'Trees and bushes recovered along the rivers, and birds returned to nest in them.',
    'The roots of the new plants held the soil in place, which changed the very shape of the riverbanks.',
    'This chain of effects shows how a single species can influence an entire ecosystem.',
    'Scientists call such a species a keystone, comparing it to the central stone that holds an arch together.',
    'Protecting keystone species, therefore, can be one of the most efficient ways to protect nature as a whole.',
  ],
  study: [
    'Students often reread their notes before an exam because it feels like an effective way to study.',
    'However, research suggests that trying to recall information without looking is far more powerful.',
    'The effort of retrieving an answer strengthens the memory and reveals what we have not yet learned.',
    'Rereading, by contrast, creates a sense of familiarity that can be mistaken for real understanding.',
    'Spacing study sessions over several days also helps, since forgetting a little makes the next review more useful.',
    'These methods feel harder in the moment, which is exactly why many learners avoid them.',
    'Teachers can help by giving short, low-stakes quizzes that encourage students to practice recall.',
    'In the long run, learning that feels difficult is often the learning that lasts.',
  ],
  music: [
    'Music from distant cultures may sound strange at first because it follows rules we have not yet learned.',
    'Our sense of what is pleasant in sound is shaped largely by what we have heard since childhood.',
    'When listeners are exposed to a new style repeatedly, their reactions tend to become more positive.',
    'This suggests that taste in music is not fixed but grows with experience.',
    'Museums and concert halls can play an important role by offering chances to meet unfamiliar works.',
    'A single visit may not change our preferences, but regular encounters slowly widen them.',
    'Openness to the unfamiliar, then, is less a talent than a habit that anyone can develop.',
    'In this way, art invites us to see the limits of our own expectations.',
  ],
};

/** 영어 이야기(43~45 형) 문단 */
export const EN_STORY = [
  'Mina had practiced the piano piece for weeks, but on the morning of the contest her hands would not stop shaking.',
  'Her teacher, Mr. Han, noticed her pale face and quietly asked her to take a walk with him around the school garden.',
  'He told her about his own first concert, when he had forgotten the opening notes and had to start again from the beginning.',
  'To his surprise, the audience had applauded more warmly at the end, because they had seen him refuse to give up.',
  'Mina laughed for the first time that day, and the tight feeling in her chest began to loosen.',
  'When her name was called, she walked onto the stage, took a deep breath, and placed her fingers on the keys.',
  'She did not play perfectly, yet every note carried the courage she had found that morning.',
  'Years later, as a teacher herself, she would tell the same story to a nervous student of her own.',
];

/** 영어 문항 발문 (18~40) */
export const EN_ASK = [
  '다음 글의 목적으로 가장 적절한 것은?',
  '다음 글에 드러난 \'I\'의 심경 변화로 가장 적절한 것은?',
  '다음 글에서 필자가 주장하는 바로 가장 적절한 것은?',
  '밑줄 친 부분이 다음 글에서 의미하는 바로 가장 적절한 것은? [3점]',
  '다음 글의 요지로 가장 적절한 것은?',
  '다음 글의 주제로 가장 적절한 것은?',
  '다음 글의 제목으로 가장 적절한 것은?',
  '다음 글의 내용과 일치하지 않는 것은?',
  '다음 글의 밑줄 친 부분 중, 어법상 틀린 것은?',
  '다음 글의 밑줄 친 부분 중, 문맥상 낱말의 쓰임이 적절하지 않은 것은?',
  '다음 빈칸에 들어갈 말로 가장 적절한 것을 고르시오.',
  '다음 글에서 전체 흐름과 관계 없는 문장은?',
];
export const EN_CHOICES = [
  'the hidden power of our surroundings',
  'why willpower is the key to success',
  'the importance of sharing results with others',
  'the dangers of relying on a single experiment',
  'ways to protect our limited attention',
  'how notifications improve our productivity',
  'the role of predators in shaping a landscape',
  'reasons for removing wild animals from parks',
  'effective strategies for long-term learning',
  'the value of rereading notes before exams',
  'how experience shapes our taste in music',
  'why unfamiliar art should be avoided',
  'Small Changes, Big Results',
  'Cooperation: The Engine of Discovery',
  'Take Back Control of Your Time',
];
export const KO_CHOICES_EN = [
  '환경을 바꾸면 습관을 더 쉽게 바꿀 수 있다.',
  '과학의 발전은 여러 연구자의 협력에 기반한다.',
  '알림을 끄는 시간을 정해 집중력을 지켜야 한다.',
  '핵심 종의 보호는 생태계 전체의 보호로 이어진다.',
  '떠올리기 연습이 다시 읽기보다 학습에 효과적이다.',
  '낯선 음악도 반복해서 들으면 친숙해진다.',
];
export const LISTEN_ASK = [
  '다음을 듣고, 여자가 하는 말의 목적으로 가장 적절한 것을 고르시오.',
  '대화를 듣고, 남자의 의견으로 가장 적절한 것을 고르시오.',
  '대화를 듣고, 두 사람의 관계를 가장 잘 나타낸 것을 고르시오.',
  '대화를 듣고, 그림에서 대화의 내용과 일치하지 않는 것을 고르시오.',
  '대화를 듣고, 여자가 할 일로 가장 적절한 것을 고르시오.',
  '대화를 듣고, 남자가 지불할 금액을 고르시오.',
  '대화를 듣고, 여자가 행사에 참석하지 못한 이유를 고르시오.',
];
export const LISTEN_CHOICES = [
  '도서관 이용 시간 변경을 안내하려고',
  '봉사 활동 참여를 독려하려고',
  '분실물 찾는 방법을 설명하려고',
  '체육 대회 일정을 공지하려고',
  '새 급식 메뉴를 소개하려고',
  '운동 전에 충분히 몸을 풀어야 한다.',
  '규칙적인 독서 습관이 중요하다.',
  '작가 ― 편집자',
  '손님 ― 점원',
  '감독 ― 배우',
  '포스터 붙이기',
  '간식 준비하기',
  '사진 찍기',
];
export const LISTEN_SHORT = ['$30', '$45', '$54', '$60', '$72', '공원', '박물관', '도서관', '체육관', '미술관'];
