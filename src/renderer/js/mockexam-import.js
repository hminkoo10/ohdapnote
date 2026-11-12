import { api, state, getSources, dropSources, restartGuard } from './shared.js';
import { identifyExam, examForm, selections } from './mockexam.js';
import { planExamImport, examImportItems, examAnswerFiles } from './mockexam-plan.js';
import { newDoc } from './store.js';
import { analyzeDocument } from './analyze.js';
import { parseAnswerKey, answerKeyToAnswers, numberRunAnswers } from './mockexam-answers.js';
import { recognizeWords } from './ocr.js';
import { recognizeAnswerGrid, preferGridAnswerKey, answerGridScope } from './mockexam-image.js';
import { transcribeExam } from './bank-transcribe.js';
import { subjectOpen } from './subjects.js';
import { openDocSource } from './docsource.js';
const queueKey = 'ohdap.examImport';
export const pendingExamImport = () => { try { return JSON.parse(localStorage.getItem(queueKey)); } catch { return null; } };
const save = (q) => localStorage.setItem(queueKey, JSON.stringify(q));
let running = false;
export async function inspectExamFolder(paths) {
  const scanned = await api.scanExamPaths(paths);
  const files = [];
  for (const f of scanned.files) {
    let metadata = identifyExam(f);
    if (/\.pdf$/i.test(f.filename) && (!metadata.exam || !metadata.subject || !metadata.year || metadata.part === 'other' || (metadata.exam === 'edu' && metadata.subject === 'math' && metadata.year <= 2016 && /^[AB]형$/.test(metadata.selection || '')) || (['csat', 'kice'].includes(metadata.exam) && !metadata.schoolYear))) {
      let src, url;
      try {
        url = URL.createObjectURL(new Blob([await api.scanExamRead(f.localPath)]));
        src = await openDocSource([{ name: f.filename, kind: 'pdf' }], () => url);
        const text = (await src.getTextTokens(0)).filter((t) => t.y0 < 0.2).map((t) => t.str).join(' ');
        metadata = identifyExam({ ...f, text });
      } catch { /* 열 수 없는 파일은 미확인 목록에 남긴다. */ }
      finally { await src?.destroy(); if (url) URL.revokeObjectURL(url); }
    }
    files.push({ ...f, metadata });
  }
  const plan = planExamImport(files, await api.listBooks(), state.appInfo.subjects);
  plan.skipped.push(...scanned.skipped);
  return plan;
}
async function attach(book, role, files) {
  if (!files.length || book.docs[role]) return;
  const imported = await api.importFiles(book.id, role, files.map((f) => f.localPath));
  try {
    const prepared = [];
    for (const f of imported.files) prepared.push(...(f.kind === 'image'
      ? await api.savePhotoPages({ token: imported.token, name: f.name, status: 'unchanged', reason: '시험지 원본' }) : [f]));
    imported.files = prepared;
    book.docs[role] = newDoc(role, imported);
    await api.commitFileImport(imported.token, book);
  } catch (e) { await api.discardFileImport(imported.token); throw e; }
}
async function readAnswers(book, row, signal) {
  const candidates = row.files.filter((f) => f.metadata.part === 'answerKey');
  candidates.push(...row.files.filter((f) => f.metadata.part === 'solution'));
  let best = { entries: [], scanned: false };
  const selectedBook = selections.slice(0, 5).includes(row.metadata.selection);
  const complementary = new Map(), conflicts = new Set();
  for (const file of candidates) {
    // 정답표는 책 문서와 별개로 읽는다. 해설을 answer로 유지한다.
    let src, url;
    try {
      const bytes = await api.scanExamRead(file.localPath);
      url = URL.createObjectURL(new Blob([bytes]));
      src = await openDocSource([{ name: file.filename, kind: /\.pdf$/i.test(file.filename) ? 'pdf' : 'image' }], () => url);
      const parsed = { answers: {} };
      let scanned = false;
      for (let i = 0; i < src.numPages; i++) {
        signal?.throwIfAborted();
        let gridParsed = null;
        let content = src.pages[i].kind === 'pdf' ? (await (await src.getPdfPage(i)).getTextContent()).items : [];
        if (!content.some((t) => t.str.trim())) {
          scanned = true;
          const canvas = await src.renderPage(i, 1700);
          try {
            const words = await recognizeWords(canvas, { lang: 'kor+eng', psm: '6' });
            content = words.map((w, k) => ({ str: w.str, hasEOL: !words[k + 1] || Math.abs(words[k + 1].y0 - w.y0) > 12 }));
            if (/\.(png|jpe?g)$/i.test(file.filename)) {
              try {
                const scope = answerGridScope(book, row.metadata, file.metadata, examForm(content.map(t => t.str).join(' ')));
                if (scope) gridParsed = await recognizeAnswerGrid(canvas, recognizeWords, { ...scope, signal });
              }
              catch (err) { if (signal?.aborted || err.name === 'AbortError') throw err; }
            }
          } finally { canvas.width = canvas.height = 1; }
        }
        const form = book.docs.problem.items.find((i) => i.examSection?.form)?.examSection.form || row.metadata.form;
        const pageForm = examForm(content.map((t) => t.str).join(' '));
        if (form && pageForm && form !== pageForm) continue;
        let p = parseAnswerKey(content, { subject: file.metadata.subject ? book.subject : null, selection: row.metadata.selection, tablesOnly: file.metadata.part === 'solution' });
        if (gridParsed) p = preferGridAnswerKey(p, gridParsed);
        for (const [k, v] of Object.entries(p.answers)) Object.assign(parsed.answers[k] ||= {}, v);
      }
      const entries = [], pairs = [];
      for (const item of book.docs.problem.items) {
        const selection = item.examSection?.selection || row.metadata.selection;
        const section = [book.subject, selection].filter(Boolean).join('|');
        const entry = answerKeyToAnswers(parsed, section, { [item.number]: item.id }).items[item.id];
        if (entry) {
          if (scanned) entry.blocks = [{ type: 'para', text: '정답을 확인하세요.', low: [{ start: 0, end: 10, reason: 'ocr' }] }];
          entries.push({ id: item.id, entry, scanned });
          pairs.push([item.number, entry.answer]);
        }
      }
      // 번호 나열을 정답으로 읽은 후보는 통째로 버린다(틀린 답보다 빠진 답이 낫다).
      if (numberRunAnswers(pairs)) entries.length = 0;
      // 선택 폴더가 명확한 책에서만 공통 표와 별도 선택 해설을 보완한다.
      if (selectedBook && file.metadata.selection === row.metadata.selection) for (const found of entries) {
        if (conflicts.has(found.id)) continue;
        const old = complementary.get(found.id);
        if (old && old.entry.answer !== found.entry.answer) { complementary.delete(found.id); conflicts.add(found.id); }
        else if (!old || old.scanned && !found.scanned) complementary.set(found.id, found);
      }
      if (entries.length > best.entries.length || (entries.length === best.entries.length && best.scanned && !scanned)) best = { entries, scanned };
      // 글자로 전부 연결했으면 더 볼 것 없음. OCR 로 전부 연결했으면 확인 표시가 없는 글자 후보가 있는지 마저 본다.
      if (entries.length === book.docs.problem.items.length && !scanned) break;
    } catch (err) {
      if (signal?.aborted || err.name === 'AbortError') throw err;
      // 못 여는 정답표는 다음 정답표·해설을 시도하고, 문제지는 계속 넣는다.
    } finally { await src?.destroy(); URL.revokeObjectURL(url); }
  }
  signal?.throwIfAborted();
  if (conflicts.size) best = { ...best, entries: best.entries.filter(e => !conflicts.has(e.id)) };
  if (complementary.size > best.entries.length) best = { entries: [...complementary.values()], scanned: [...complementary.values()].some(e => e.scanned) };
  for (const { id, entry } of best.entries) {
    signal?.throwIfAborted();
    await api.saveAnswer(book.id, id, entry);
  }
  return { connected: best.entries.length, low: best.entries.filter(e => e.scanned).length };
}
// 자동 받기 뒤에도 동일하게 호출: paths가 null이면 마지막 작업을 이어간다.
export async function importExamFolder(paths, { onProgress = () => {}, signal, plan } = {}) {
  if (running) throw Error('이미 모의고사를 넣고 있어요.');
  running = true;
  try { return await restartGuard.track('mockexam', async () => {
    let q = paths ? { ...(plan || await inspectExamFolder(paths)), createdAt: Date.now() } : pendingExamImport();
    if (!q) return null;
    save(q);
    for (const row of q.rows) {
      if (row.reason || row.done) continue;
      signal?.throwIfAborted();
      const started = Date.now();
      if (!subjectOpen({ subject: row.metadata.subject }, state.appInfo)) { row.reason = '계약 밖'; save(q); continue; }
      onProgress({ phase: 'exam', name: row.name, queue: q });
      let book;
      try {
        if (!row.bookId) {
          book = await api.createBook(row.name, true, row.metadata.subject);
          row.bookId = book.id; save(q);
        } else book = await api.getBook(row.bookId);
        const question = row.files.filter((f) => f.metadata.part === 'question');
        book.exam = { ...row.metadata, source: { kind: 'file', name: question[0].filename, sha256: question[0].sha256 } };
        await api.saveBook(book);
        await attach(book, 'problem', question);
        await attach(book, 'answer', examAnswerFiles(row.files, book.subject));
        const sources = await getSources(book);
        for (const role of ['problem', 'answer']) {
          const doc = book.docs[role], src = sources[role];
          if (!doc || doc.analyzedAt) continue;
          if (!src) throw Error('시험지 파일을 열지 못했어요.');
          const res = await analyzeDocument(src, { previousDoc: doc, pages: Array.from({ length: src.numPages }, (_, i) => i), role, subject: book.subject, ...doc.options, exam: row.metadata, ocrLang: 'kor+eng', signal, onProgress: (p) => onProgress({ ...p, name: row.name, queue: q }) });
          Object.assign(doc, { items: examImportItems(res.items), pageInfo: res.pageInfo, signature: res.signature, analyzedAt: Date.now() });
          await api.saveBook(book);
        }
        const answers = await readAnswers(book, row, signal);
        const low = await transcribeExam(book, { signal, onProgress: (p) => onProgress({ ...p, name: row.name, queue: q }) });
        row.result = { items: book.docs.problem.items.length, answers: answers.connected, low: low + answers.low, seconds: (Date.now() - started) / 1000 };
        row.done = true; delete row.error; save(q);
      } catch (err) {
        if (signal?.aborted || err.name === 'AbortError') throw err;
        row.error = String(err?.message || err); row.seconds = (Date.now() - started) / 1000; save(q);
      } finally { if (book) dropSources(book.id); }
      await onProgress({ phase: 'exam-end', name: row.name, row, queue: q });
    }
    onProgress({ phase: 'finished', queue: q });
    return q;
  }); } finally { running = false; }
}
