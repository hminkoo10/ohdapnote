// 교재의 문제·지문을 문제은행에 넣기. 기본은 이 컴퓨터의 PDF 글자·OCR만 사용
import { h, modal, toast } from './ui.js';
import { api, nav, state, getSources, holdSource, findJob, jobDialog, geminiReady, aiOptions, restartGuard } from './shared.js';
import { bankTargets } from './bank.js';
import { itemName } from './exporter.js';
import { blockSegs, renderStack } from './hwpx.js';
import { scanTranscribe } from './scanocr.js';
import { geminiTranscribeBatch, canvasToBase64Jpeg } from './gemini.js';
import { loadTranscripts, saveTranscripts, bestTranscript, transcriptKey, pdfTranscribe, TRANSCRIBE_WIDTH } from './transcribe.js';
import { subjectOf, subjectOpen } from './subjects.js';

export async function putBank(book, { item = null, onChange = () => {} } = {}) {
  const old = findJob(`bank:${book.id}`);
  if (old) return old.open();
  if (book.$subjectOpen === false || !subjectOpen(book, state.appInfo)) return;
  let useAi = false;
  if (!item) {
    const ai = h('input', { type: 'checkbox', disabled: !geminiReady() });
    const count = book.docs.problem?.items?.length || 0;
    const ok = await modal({
      title: '문제은행에 넣기',
      body: h('div.bank-start',
        h('p', `이 교재의 문항 ${count}개를 글자·수식으로 옮겨 문제은행에 넣어요. 이 컴퓨터에서 글자 인식(OCR)으로 옮겨서 인터넷·AI 를 쓰지 않아요. 한 문항에 몇 초쯤 걸리고, 옮기는 동안 다른 일을 해도 돼요.`),
        h('label.bank-ai', { title: geminiReady() ? '' : '설정에서 AI를 켜고 API 키·모델을 먼저 정해 주세요.' }, ai, h('span', 'AI 도 쓰기 — 글자 인식 결과가 미덥지 않은 문항만 AI 에게 보내요')),
        !geminiReady() ? h('p.small.muted', 'AI를 쓰려면 설정에서 AI를 먼저 준비해 주세요. 기본 옮기기는 AI 없이 할 수 있어요.') : null,
        book.$canEdit === false ? h('p.readonly-banner', `${book.createdBy?.name || '다른'} 선생님이 만든 책이라 옮긴 글은 나에게만 저장돼요. 만든 선생님이 넣으면 학원 모두가 함께 써요.`) : null),
      buttons: [{ label: '취소', value: false }, { label: '넣기 시작', value: true, primary: true }],
    });
    if (!ok) return;
    useAi = ai.checked && geminiReady();
  }
  if (findJob(`bank:${book.id}`)) return findJob(`bank:${book.id}`).open();
  return restartGuard.track('bank', () => runBank(book, { item, useAi, onChange }));
}

async function runBank(book, { item, useAi, onChange }) {
  const abort = new AbortController();
  const check = () => {
    if (abort.signal.aborted) throw new DOMException('멈춤', 'AbortError');
    if (!subjectOpen(book, state.appInfo)) throw new Error('학원 계약에서 빠진 과목이라 넣기를 멈췄어요.');
  };
  const targets = item ? bankTargets({ ...book, docs: { problem: { items: [item] } } }) : bankTargets(book);
  const status = h('p.small', '교재 파일을 준비하는 중…');
  const bar = h('div.progress-bar');
  const current = h('p.small.muted');
  const ui = jobDialog({ key: `bank:${book.id}`, bookId: book.id, abort, total: targets.length,
    title: '문제은행에 넣는 중', jobTitle: `${book.name} · 문제은행`,
    body: h('div', h('div.progress', bar), status, current, h('p.small.muted', '취소를 누르면 멈춰요. 옮긴 글은 남아 있어서 다음에 이어서 넣을 수 있어요. 지문도 따로 함께 옮겨요.')) });
  const releases = ['problem', 'answer'].map((role) => holdSource(book, role));
  let done = 0;
  let failure = null;
  let stored = true;
  const update = () => {
    const good = targets.filter((b) => bestTranscript(book.id, b)).length;
    const label = `지금 ${done} / ${targets.length} · 옮김 ${good} · 못 옮김 ${Math.max(0, done - good)}`;
    status.textContent = label;
    bar.style.width = `${100 * done / Math.max(1, targets.length)}%`;
    ui.job.progress({ done, label });
  };
  try {
    const ready = await api.ensureBookFiles(book.id);
    if (!ready?.ok) throw new Error(ready?.error || '교재 원본을 받지 못했어요. 책장에서 파일을 확인해 주세요.');
    check();
    const src = await getSources(book);
    if (!src.problem) throw new Error('문제집 파일을 열지 못했어요.');
    targets.forEach((b) => { b.src = src.problem; });
    const store = await loadTranscripts(book.id);
    const put = (b, suffix, entry) => {
      store.items[transcriptKey(b) + suffix] = { ...entry, at: Date.now() };
      store.dirty = true;
    };
    const pendingAi = [];
    let model = null;
    let warned = false;
    for (const b of targets) {
      check();
      current.textContent = `${itemName(b.item)} · 글자를 읽는 중…`;
      if (!bestTranscript(book.id, b)) {
        try {
          const segs = blockSegs(b);
          const pdf = await pdfTranscribe(segs, { plain: subjectOf(book) !== 'math' });
          check();
          if (pdf?.length) put(b, '|pdf', { blocks: pdf, model: 'pdf' });
          else {
            if (model === null) model = !!(await api.mathocrStatus())?.installed;
            if (!model && !warned) {
              warned = true;
              const next = await modal({ title: '수식 인식 모델이 필요해요',
                body: h('p', '스캔본이나 일반 글꼴 수학 PDF는 설정에서 수식 인식 모델을 먼저 받아 주세요. 이미 옮긴 글은 남아요. 글자를 안전하게 읽을 수 있는 PDF는 모델 없이도 옮길 수 있어요.'),
                buttons: [{ label: '설정 열기', value: 'settings' }, { label: useAi ? 'PDF·AI로 계속' : 'PDF만 계속', value: 'continue', primary: true }] });
              if (next !== 'continue') {
                if (next === 'settings') nav.settings();
                throw new DOMException('멈춤', 'AbortError');
              }
            }
            check();
            const r = model ? await scanTranscribe(await renderStack(segs, TRANSCRIBE_WIDTH), { number: b.item.passage ? '' : b.item.number, signal: abort.signal, api }) : null;
            check();
            if (r?.blocks.length) put(b, '|local', { blocks: r.blocks, model: 'ocr', reliable: r.reliable, reasons: r.reasons });
            if (useAi && (!r?.blocks.length || !r.reliable)) pendingAi.push(b);
          }
        } catch (err) {
          if (err.name === 'AbortError' || abort.signal.aborted) throw err;
          current.textContent = `${itemName(b.item)} · ${err.message}`;
          if (useAi && !pendingAi.includes(b)) pendingAi.push(b);
        }
      }
      done++;
      update();
      if (done % 20 === 0) await saveTranscripts();
    }
    const { batch, ...ai } = aiOptions();
    let next = 0;
    let converted = 0;
    const worker = async () => {
      while (next < pendingAi.length) {
        check();
        const group = pendingAi.slice(next, next += batch);
        current.textContent = '확인이 필요한 문항만 AI로 옮기는 중…';
        try {
          const images = [];
          for (const b of group) {
            check();
            images.push(canvasToBase64Jpeg(await renderStack(blockSegs(b), TRANSCRIBE_WIDTH), 0.85));
          }
          const results = await geminiTranscribeBatch(images, { role: 'problem', ...ai, signal: abort.signal });
          check();
          results.forEach((r, i) => {
            if (!(r instanceof Error) && r?.length) put(group[i], '', { blocks: [...r], model: r.model });
          });
        } catch (err) {
          if (err.name === 'AbortError' || abort.signal.aborted) throw err;
          current.textContent = `AI로 옮기지 못했어요: ${err.message}. 읽어 둔 OCR 결과는 남아요.`;
        }
        converted += group.length;
        update();
        if (converted >= 20) { converted = 0; await saveTranscripts(); }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(ai.concurrency, Math.ceil(pendingAi.length / batch)) }, worker));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  } catch (err) {
    failure = err;
  } finally {
    stored = await saveTranscripts();
    const stopped = failure?.name === 'AbortError' || abort.signal.aborted;
    const message = !stored ? '옮긴 글을 저장하지 못했어요. 앱을 끄지 말고 다시 넣기를 눌러 주세요.' : stopped ? '넣기를 멈췄어요. 옮긴 글은 남아 있어요.' : failure ? `넣지 못했어요: ${failure.message}` : `${book.name} · 문제은행에 넣기를 마쳤어요.`;
    status.textContent = message;
    const bad = !stored || (failure && !stopped);
    if (!ui.finish({ message, type: bad ? 'error' : 'success' })) toast(message, { type: bad ? 'error' : 'info' });
    releases.forEach((release) => release());
    onChange();
  }
}
