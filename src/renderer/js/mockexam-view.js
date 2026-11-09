import { h, modal, toast } from './ui.js';
import { api, nav, jobDialog, findJob } from './shared.js';
import { inspectExamFolder, importExamFolder, pendingExamImport } from './mockexam-import.js';
export function examImportButton() {
  return h('button.btn', { onclick: () => openExamImport().catch((e) => toast(e.message, { type: 'error' })) }, '모의고사 넣기');
}
const summary = (q) => {
  const done = q.rows.filter((r) => r.done);
  return `넣은 시험 ${done.length} · 문항 ${done.reduce((s,r) => s + r.result.items,0)} · 확인 표시 ${done.reduce((s,r) => s + r.result.low,0)} · 정답 못 읽은 시험 ${done.filter((r) => !r.result.answers).length} · 건너뜀 ${q.skipped.length + q.rows.filter((r) => r.reason).length}`;
};
export async function openExamImport() {
  if (findJob('mockexam')) return findJob('mockexam').open();
  const pending = pendingExamImport();
  const body = h('div', h('p.small.muted', '폴더나 파일을 고르면 시험별로 정리해요.'));
  let plan, paths;
  const table = h('div.mockexam-table');
  const choose = async (folder) => {
    const picked = await api.pickExamFiles(folder);
    if (!picked.length) return;
    table.replaceChildren(h('p.small', '파일을 살펴보는 중이에요.'));
    try {
      paths = picked; plan = await inspectExamFolder(paths);
      table.replaceChildren();
      const t = h('table', h('thead', h('tr', ['시험', '문제지', '정답', '해설', '상태'].map((s) => h('th', s)))));
      const tb = h('tbody'); t.append(tb);
      for (const row of plan.rows) tb.append(h(`tr${row.reason ? '.muted' : ''}`, h('td', `${row.name} · 고${row.metadata.grade}${row.metadata.form ? ` · ${row.metadata.form}수형` : ''}`), ...['question', 'answerKey', 'solution'].map((part) => h('td', row.files.some((f) => f.metadata.part === part) ? '✓' : '—')), h('td', row.reason || '넣을 수 있어요')));
      table.append(t);
      if (plan.skipped.length) table.append(h('details', h('summary', `${plan.skipped.length}개는 건너뜀`), h('ul', plan.skipped.map((s) => h('li.small', s)))));
    } catch (e) { plan = null; table.replaceChildren(h('p.small', e.message)); }
  };
  body.append(h('div.toolbar', h('button.btn', { onclick: () => choose(true) }, '폴더 고르기'), h('button.btn', { onclick: () => choose(false) }, '파일 여러 개 고르기')), table);
  const resume = pending?.rows.some((r) => !r.done && !r.reason);
  if (resume) body.append(h('p.small', '멈춘 작업이 있어요. 이어서 넣으세요.'));
  const action = await modal({ title: '모의고사 넣기', width: 760, body, buttons: [{ label: '닫기', value: false }, ...(resume ? [{ label: '이어서 넣기', value: 'resume' }] : []), { label: '넣기 시작', value: 'start', primary: true }] });
  if (!action || action === 'start' && !plan) return;
  const abort = new AbortController();
  const status = h('p.small', '시험지를 준비해요.');
  const bar = h('div.progress-bar');
  const ui = jobDialog({ key: 'mockexam', abort, title: '모의고사를 넣는 중', body: h('div', h('div.progress', bar), status, h('p.small.muted', '멈춰도 넣은 내용은 남아요. 모의고사 넣기에서 이어서 넣으세요.')) });
  let q;
  try {
    q = await importExamFolder(action === 'resume' ? null : paths, { plan, signal: abort.signal, onProgress: (p) => {
      q = p.queue;
      const done = q.rows.filter((r) => r.done || r.reason).length;
      status.textContent = `${p.name || ''} · ${p.message || (p.phase === 'transcribe' ? '글자를 옮겨요.' : '시험지를 정리해요.')}`;
      bar.style.width = `${done * 100 / Math.max(1, q.rows.length)}%`;
      ui.job.progress({ done, total: q.rows.length, label: status.textContent });
    } });
    status.textContent = summary(q);
    for (const row of q.rows.filter((r) => r.error)) status.append(h('p.small', `${row.name}: ${row.error}`));
  } catch (e) { status.textContent = abort.signal.aborted ? '멈췄어요. 모의고사 넣기에서 이어서 넣으세요.' : e.message; }
  ui.finish({ message: status.textContent });
  nav.home({ tab: 'bank' });
}
