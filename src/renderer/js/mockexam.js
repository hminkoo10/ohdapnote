import { normalizeHancomText } from './hancom.js';

const subjects = [['korean', /국어|언어(?!와\s*매체)/], ['math', /수학|수리/], ['english', /영어|외국어/]];
export const selections = ['화법과작문', '언어와매체', '확률과통계', '미적분', '기하', '가형', '나형', 'A형', 'B형', '인문계', '자연계', '예체능'];
const compact = (s) => normalizeHancomText(s).replace(/[\s_]/g, '')
  .replace(/화작/g, '화법과작문').replace(/언매/g, '언어와매체')
  .replace(/확통/g, '확률과통계').replace(/미적(?!분)/g, '미적분');

export const examForm = (text) => /(홀|짝)수?\)?형/.exec(compact(text))?.[1] || null;

/** 파일명/ZIP 경로와 제목 글자. 제목에 있는 필드는 파일명보다 우선한다. */
export function identifyExam({ filename = '', path = '', text = '' } = {}) {
  // 본문 속 고2·풀이·평가원은 제목 정보가 아니다.
  const title = compact(/20\d{2}(?:학년도|년)[^\n]{0,160}/.exec(text)?.[0] || '');
  const file = compact(`${path}/${filename}`);
  const reasons = [];
  // 연기된 학평도 같은 자료 묶음에서는 시행 날짜 디렉터리를 공유한다.
  const dated = /[\\/](20\d{2})[\\/](0?[1-9]|1[012])[\\/]/.exec(path);

  const pick = (re) => re.exec(title) || re.exec(file);
  const classify = (s) => /전국연합|학력평가|학평/.test(s) ? 'edu' : /모의평가|모평/.test(s) ? 'kice' : /대학수학능력시험|수능/.test(s) ? 'csat' : null;
  const exam = classify(title) || classify(file);
  const sy = pick(/(20\d{2})학년도/);
  const yr = pick(/(20\d{2})년(?!도)/);
  const bare = pick(/(?:^|[^\d])(20\d{2})(?:[^\d]|$)/);
  const schoolYear = exam === 'csat' || exam === 'kice' ? (sy ? +sy[1] : null) : null;
  const year = schoolYear ? schoolYear - 1 : yr ? +yr[1] : sy && exam === 'edu' ? +sy[1] : bare ? +bare[1] : null;
  const month = (exam === 'edu' && dated ? +dated[2] : 0) || +(pick(/(1[012]|[1-9])월/)?.[1] || 0) || (exam === 'csat' ? 11 : null);
  const grade = exam === 'csat' || exam === 'kice' ? 3 : +(pick(/고(?:등학교)?([123])(?:학년)?/)?.[1] || 0) || null;
  const foundSubjects = (s) => subjects.filter(([id, re]) => re.test(s.replace(/대학수학능력시험/g, '').replace(id === 'korean' ? /외국어/g : /$^/g, ''))).map(([id]) => id);
  const ss = foundSubjects(title).length ? foundSubjects(title) : foundSubjects(file);
  const folderSelections = selections.filter(v => file.includes(v));
  const inferred = folderSelections.length === 1 ? (selections.slice(0, 2).includes(folderSelections[0]) ? 'korean' : selections.slice(2, 5).includes(folderSelections[0]) ? 'math' : null) : null;
  const subject = ss.length === 1 ? ss[0] : !ss.length ? inferred : null;
  const allowed = selections.filter((v) => !schoolYear || (/[가나]형/.test(v) ? subject === 'math' && schoolYear <= 2021 : /[AB]형/.test(v) ? schoolYear <= 2016 : true));
  const sel = allowed.filter((v) => (title || file).includes(v));
  if (!sel.length) sel.push(...allowed.filter((v) => file.includes(v)));
  // 옛 파일은 '수학A'처럼 형을 생략한다. 과목 바로 뒤의 표기만 인정.
  const legacyType = subject && exam === 'edu' && year <= 2016
    ? /(?:수학|수리|국어|언어|영어|외국어)([AB])(?:형|[_)./\\-]|$)/.exec(title || file) : null;
  if (legacyType) sel.splice(0, sel.length, `${legacyType[1]}형`);
  const oldYear = schoolYear || year;
  const legacyMath = subject === 'math' && oldYear && oldYear <= 2021
    ? /(?:수학|수리)([가나])형/.exec(title) || /(?:수학|수리)([가나])형/.exec(file) : null;
  // 옛 가형의 '미적분과 통계'는 최신 선택 과목 이름이 아니다.
  if (legacyMath && !sel.some(v=>/^[가나]형$/.test(v) && v !== `${legacyMath[1]}형`)) sel.splice(0, sel.length, `${legacyMath[1]}형`);
  const selection = sel.length === 1 ? sel[0] : null;
  const form = examForm(title) || examForm(file);
  const partOf = (s) => /듣기.*(?:대본|스크립트)|listening.*script/i.test(s) ? 'listeningScript' : /해설|풀이|explanation|solution/i.test(s) ? 'solution' : /정답|정답표|answer/i.test(s) ? 'answerKey' : /문제|question/i.test(s) ? 'question' : null;
  const part = /\.(?:mp3|wav|m4a)$/i.test(filename) ? 'audio' : partOf(compact(filename)) || partOf(file) || partOf(title) || 'other';
  for (const [name, value] of Object.entries({ exam, year, month, grade, subject })) if (value === null) reasons.push(`${name} 미확인 또는 합본`);
  if (part === 'other') reasons.push('파일 역할 미확인');
  if (sel.length > 1) reasons.push('선택 합권');
  if (title && classify(file) && classify(title) && classify(file) !== classify(title)) reasons.push('파일명과 제목 시험 종류 불일치: 제목 우선');
  const fm = /(1[012]|[1-9])월/.exec(file)?.[1];
  const tm = /(1[012]|[1-9])월/.exec(title)?.[1];
  if (fm && tm && fm !== tm) reasons.push('파일명과 제목 월 불일치: 제목 우선');
  if (!sy && (exam === 'csat' || exam === 'kice')) reasons.push('학년도 미확인');
  let listening = null;
  // 검증된 수능/모평 체제만. 학평·옛 초기 회차는 추정하지 않는다.
  if (schoolYear >= 2003 && schoolYear <= 2027) {
    if (subject === 'english') listening = { start: 1, end: schoolYear === 2014 ? 22 : 17 };
    if (subject === 'korean' && schoolYear >= 2008 && schoolYear <= 2013) listening = { start: 1, end: 5 };
  }
  return { exam, year, schoolYear, month, grade, subject, part, selection, form, listening, confidence: Math.max(0.1, 1 - reasons.length * 0.16), reasons };
}

/** 불명 필드는 다른 파일에 자동 병합하지 않는다. 홀짝/선택은 답 충돌 방지를 위해 분리. */
export function groupExamFiles(files) {
  const groups = new Map();
  files.forEach((file, index) => {
    const meta = file.metadata || identifyExam(file);
    const key = [meta.exam, meta.year, meta.month, meta.grade, meta.subject, meta.selection || '', meta.form || ''].join(':');
    const uncertain = !meta.exam || !meta.year || !meta.month || !meta.grade || !meta.subject;
    const id = uncertain ? `${key}:unresolved:${index}` : key;
    if (!groups.has(id)) groups.set(id, { key: id, metadata: meta, files: [], confidence: meta.confidence, reasons: [...meta.reasons] });
    const group = groups.get(id);
    group.files.push(file);
    group.confidence = Math.min(group.confidence, meta.confidence);
  });
  return [...groups.values()];
}
