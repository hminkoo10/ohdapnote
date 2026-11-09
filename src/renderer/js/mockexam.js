import { normalizeHancomText } from './hancom.js';

const subjects = [['korean', /국어|언어(?!와\s*매체)/], ['math', /수학|수리/], ['english', /영어|외국어/]];
export const selections = ['화법과작문', '언어와매체', '확률과통계', '미적분', '기하', '가형', '나형', 'A형', 'B형'];
const compact = (s) => normalizeHancomText(s).replace(/\s/g, '')
  .replace(/화작/g, '화법과작문').replace(/언매/g, '언어와매체')
  .replace(/확통/g, '확률과통계').replace(/미적(?!분)/g, '미적분');

/** 파일명/ZIP 경로와 제목 글자. 제목에 있는 필드는 파일명보다 우선한다. */
export function identifyExam({ filename = '', path = '', text = '' } = {}) {
  const title = compact(text.slice(0, 2500));
  const file = compact(`${path}/${filename}`);
  const reasons = [];
  const pick = (re) => re.exec(title) || re.exec(file);
  const classify = (s) => /전국연합|학력평가/.test(s) ? 'edu' : /모의평가|평가원/.test(s) ? 'kice' : /대학수학능력시험|수능/.test(s) ? 'csat' : null;
  const exam = classify(title) || classify(file);
  const sy = pick(/(20\d{2})학년도/);
  const yr = pick(/(20\d{2})년(?!도)/);
  const bare = pick(/(?:^|[^\d])(20\d{2})(?:[^\d]|$)/);
  const schoolYear = exam === 'csat' || exam === 'kice' ? (sy ? +sy[1] : null) : null;
  const year = schoolYear ? schoolYear - 1 : yr ? +yr[1] : sy && exam === 'edu' ? +sy[1] : bare ? +bare[1] : null;
  const month = +(pick(/(1[012]|[1-9])월/)?.[1] || 0) || (exam === 'csat' ? 11 : null);
  const grade = +(pick(/고(?:등학교)?([123])(?:학년)?/)?.[1] || 0) || (exam === 'csat' || exam === 'kice' ? 3 : null);
  const foundSubjects = (s) => subjects.filter(([id, re]) => re.test(s.replace(/대학수학능력시험/g, '').replace(id === 'korean' ? /외국어/g : /$^/g, ''))).map(([id]) => id);
  const ss = foundSubjects(title).length ? foundSubjects(title) : foundSubjects(file);
  const subject = ss.length === 1 ? ss[0] : null;
  const sel = selections.filter((v) => (title || file).includes(v));
  if (!sel.length) sel.push(...selections.filter((v) => file.includes(v)));
  const selection = sel.length === 1 ? sel[0] : null;
  const form = pick(/(홀|짝)수?형/)?.[1] || null;
  const partOf = (s) => /듣기.*(?:대본|스크립트)|listening.*script/i.test(s) ? 'listeningScript' : /해설|풀이/.test(s) ? 'solution' : /정답|정답표|answer/i.test(s) ? 'answerKey' : /문제|question/i.test(s) ? 'question' : null;
  const part = /\.(?:mp3|wav|m4a)$/i.test(filename) ? 'audio' : partOf(title) || partOf(file) || 'other';
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
