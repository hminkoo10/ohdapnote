// E2E 용 통합 클라우드 흉내: 학원 명단·학원 AI 파일(academy-info.json)을 쓰고, 프로그램이 requests/ 에 남긴 부탁에 답함
//   학생 추가·고치기(rev 가 다르면 conflict)·지우기·되살리기, 열 때만 받는 파일(이미 있으면 그대로 · 없으면 missing)
//   통합 클라우드 docs/INTEGRATION.md 4-1 · 4-2 와 같은 모양
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;

/**
 * @param {{ dir: string, academyDir: string, members: {id,name,role}[], purgeDays?: number }} opts
 *   subjects: 학원이 계약한 과목 (없으면 academy.subjects 를 싣지 않음 — 옛 통합 클라우드처럼)
 * → { env: 앱에 넘길 환경 변수, as(user): 누구로 켜는지, students(), student(id), edit(id, patch): 다른 곳에서 고친 것처럼, setAi(ai), setSubjects(list), stop() }
 */
export function fakeCloud({ dir, academyDir, members, purgeDays = 30, subjects = null, libraryDir = '', librarySourceDir = '' }) {
  const requestDir = join(dir, 'requests');
  const infoFile = join(dir, 'academy-info.json');
  mkdirSync(requestDir, { recursive: true });
  const requests = [];
  const students = new Map();
  let me = members[0];
  let ai = null;
  const who = (u) => (u ? { id: u.id, name: u.name } : null);
  const teacherOf = (id) => (id ? who(members.find((m) => m.id === id) || { id, name: '알 수 없음' }) : null);

  function writeInfo() {
    const info = {
      format: 1,
      academy: { id: 1, name: '테스트학원', ...(subjects ? { subjects } : {}) },
      me: { id: me.id, name: me.name, role: me.role },
      members: members.map((m) => ({ ...m, roleLabel: { director: '원장', teacher: '선생님' }[m.role] || m.role })),
      students: [...students.values()],
      purged: [],
      purgeDays,
      ai,
      updatedAt: Date.now() + Math.random(), // 같은 ms 에 두 번 써도 바뀐 것으로 보이게
    };
    writeFileSync(`${infoFile}.tmp`, JSON.stringify(info));
    renameSync(`${infoFile}.tmp`, infoFile);
  }

  function save(s) {
    const now = Date.now();
    if (s.rev) {
      const cur = students.get(s.id);
      if (!cur) return { ok: false, error: '학생을 찾을 수 없어요.', errorCode: 'no_student' };
      if (cur.deletedAt) return { ok: false, error: '지운 학생이에요.', errorCode: 'student_deleted' };
      if (cur.rev !== s.rev) return { ok: false, error: '그사이 다른 사람이 고쳤어요.', errorCode: 'conflict', student: cur };
      const next = { ...cur, ...pick(s), rev: cur.rev + 1, updatedBy: who(me), updatedAt: now };
      if (s.teacherId !== undefined) next.teacher = teacherOf(s.teacherId);
      students.set(s.id, next);
      return { ok: true, student: next };
    }
    const id = s.id || randomUUID();
    if (students.has(id)) return { ok: true, student: students.get(id) };
    if (!String(s.name || '').trim()) return { ok: false, error: '학생 이름을 입력해 주세요.', errorCode: 'invalid_name' };
    const st = { id, school: '', grade: '', memo: '', ...pick(s), teacher: teacherOf(s.teacherId), rev: 1, createdBy: who(me), updatedBy: who(me), createdAt: now, updatedAt: now, deletedAt: null, deletedBy: null, purgeAt: null };
    students.set(id, st);
    return { ok: true, student: st };
  }
  const pick = (s) => Object.fromEntries(['name', 'school', 'grade', 'memo'].filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));

  function setDeleted(id, del) {
    const cur = students.get(id);
    if (!cur) return { ok: false, error: '학생을 찾을 수 없어요.', errorCode: 'no_student' };
    const now = Date.now();
    const next = del ? { ...cur, deletedAt: now, deletedBy: who(me), purgeAt: now + purgeDays * DAY, rev: cur.rev + 1 } : { ...cur, deletedAt: null, deletedBy: null, purgeAt: null, rev: cur.rev + 1 };
    students.set(id, next);
    return { ok: true, student: next };
  }

  function answer(body) {
    if (body.op === 'students.save') return save(body.student || {});
    if (body.op === 'students.delete') return setDeleted(body.id, true);
    if (body.op === 'students.restore') return setDeleted(body.id, false);
    if (body.op) return { ok: false, error: '모르는 부탁', errorCode: 'unknown_op' };
    requests.push(body);
    const root = body.library ? libraryDir : academyDir;
    if (body.library && librarySourceDir) for (const p of body.paths || []) {
      const to = join(root, ...p.split('/'));
      const from = join(librarySourceDir, ...p.split('/'));
      if (!existsSync(to) && existsSync(from)) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
    }
    const missing = (body.paths || []).filter((p) => !root || !existsSync(join(root, ...p.split('/'))));
    return { ok: !missing.length, missing };
  }

  const timer = setInterval(() => {
    let names = [];
    try {
      names = readdirSync(requestDir).filter((n) => n.endsWith('.json') && !n.endsWith('.done.json'));
    } catch {
      return;
    }
    for (const name of names) {
      const file = join(requestDir, name);
      let body;
      try {
        body = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      rmSync(file, { force: true });
      const r = answer(body);
      if (body.op?.startsWith('students.') && r.ok) writeInfo(); // 통합 클라우드처럼 답하기 전에 명단 파일부터
      const done = join(requestDir, name.replace(/\.json$/, '.done.json'));
      writeFileSync(`${done}.tmp`, JSON.stringify({ missing: [], ...r }));
      renameSync(`${done}.tmp`, done);
    }
  }, 50);

  writeInfo();
  return {
    requests,
    env: { MAGOEDU_LIBRARY_DIR: libraryDir, MAGOEDU_REQUEST_DIR: requestDir, MAGOEDU_ACADEMY_INFO: infoFile },
    as(user) {
      me = members.find((m) => m.id === user) || me;
      writeInfo();
    },
    students: () => [...students.values()],
    student: (id) => students.get(id) || null,
    add(s) {
      const { student } = save(s);
      writeInfo();
      return student;
    },
    /** 다른 컴퓨터에서 고친 것처럼 (명단 파일만 새로 씀) */
    edit(id, patch) {
      students.set(id, { ...students.get(id), ...patch, rev: students.get(id).rev + 1, updatedAt: Date.now() });
      writeInfo();
    },
    setAi(next) {
      ai = next;
      writeInfo();
    },
    /** 운영자가 학원의 계약 과목을 바꾼 것처럼 */
    setSubjects(list) {
      subjects = list;
      writeInfo();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
