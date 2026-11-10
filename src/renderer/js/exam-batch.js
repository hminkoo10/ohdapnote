import { api, state } from './shared.js';
import { importExamFolder, pendingExamImport } from './mockexam-import.js';
const batch = window.examBatch;
window.addEventListener('error', (e) => batch.fatal(e.message));
window.addEventListener('unhandledrejection', (e) => batch.fatal(e.reason?.message || String(e.reason)));
try {
  const { input } = await batch.config();
  state.appInfo = await api.appInfo();
  state.settings = await api.getSettings();
  // 같은 입력의 대기열만 재개한다.
  const old = pendingExamImport();
  const resume = old?.batchInput === input;
  const plan = resume ? undefined : await (await import('./mockexam-import.js')).inspectExamFolder([input]);
  if (plan && !plan.rows.length) throw Error('처리할 시험이 없어요.');
  if (plan) plan.batchInput = input;
  const queue = await importExamFolder(resume ? null : [input], { plan, onProgress: (p) => {
    if (p.phase === 'exam') batch.event({ event: 'exam-start', name: p.name });
    if (p.phase === 'exam-end') batch.event({ event: 'exam-end', name: p.name,
      items: p.row.result?.items || 0, answers: p.row.result?.answers || 0,
      low: p.row.result?.low || 0, seconds: p.row.result?.seconds || p.row.seconds || 0, error: p.row.error || null });
  } });
  await batch.finish(queue);
} catch (err) { batch.fatal(err.message); }
