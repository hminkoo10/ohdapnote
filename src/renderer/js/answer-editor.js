import { h, modal, toast, confirmDialog } from './ui.js';
import { api, getSources, itemImage, restartSaveHooks, restartPendingChecks, leaveHooks } from './shared.js';
import { loadTranscripts, bestTranscript, pdfTranscribe, TRANSCRIBE_WIDTH } from './transcribe.js';
import { blockSegs, renderStack, cropImage } from './hwpx.js';
import { computeMatches, findItem } from './store.js';
import { eqToMathML } from './hwpeqview.js';
import { openEquationEditor } from './eq-editor.js';
import { blocksToModel, modelToBlocks, createAnswerHistory, importAnswerBlocks, recognizedAnswer, answerContent } from './answer-model.js';
import { createSaveQueue } from './save-queue.js';
import { answerReview, withoutAnswerReview } from './answer-review.js';

const fail = (err) => toast(err.message || String(err), { type: 'error', timeout: 9000 });
const writable = (book) => book.$canEdit !== false && book.$subjectOpen !== false;

export function answerEditorButton(options) {
  const { book, item } = options;
  const button = h('button.btn.btn-small.answer-open', { onclick: () => openAnswerEditor(options).catch(fail) }, writable(book) ? '정답·해설 쓰기' : '정답·해설 보기');
  api.getAnswers(book.id).then((data) => {
    if (writable(book) && answerContent(data.items[item.id])) button.textContent = '정답·해설 고치기';
  }).catch(fail);
  return button;
}

function mathNode(eq, display = false) {
  const node = h(display ? 'div.answer-math.answer-display' : 'span.answer-math', { contenteditable: 'false', draggable: true, tabindex: '0', dataset: { eq, ...(display ? { block: 'math' } : {}) }, title: '누르면 수식을 고쳐요' });
  node.innerHTML = eqToMathML(eq, { display });
  return node;
}

export function renderAnswerDocument(root, blocks, images = new Map()) {
  root.replaceChildren();
  for (const b of blocksToModel(blocks)) {
    if (b.type === 'math') {
      const node = mathNode(b.eq, true);
      if (b.reviewLow?.length) node.dataset.reviewLow = JSON.stringify(b.reviewLow);
      root.append(node);
    }
    else if (b.type === 'figure') {
      root.append(h('div.answer-figure', { contenteditable: 'false', draggable: true, tabindex: '0', dataset: { block: 'figure', file: b.file, w: b.w, h: b.h } }, h('img', { src: images.get(b.file) || '', alt: '해설 그림' })));
    } else {
      const p = h('p', { dataset: { original: JSON.stringify(b.original) } });
      for (const run of b.runs) if (run.eq !== undefined || run.text) p.append(run.eq !== undefined ? mathNode(run.eq) : document.createTextNode(run.text));
      if (!p.textContent && !p.querySelector('[data-eq]')) p.append(h('br'));
      root.append(p);
    }
  }
  if (!root.childNodes.length) root.append(h('p', h('br')));
}

export function readAnswerDocument(root) {
  const model = [];
  let runs = [];
  let original;
  const flush = (empty = false) => {
    if (runs.length || empty) model.push({ type: 'para', runs, original });
    runs = []; original = undefined;
  };
  const addText = (text) => {
    if (!text) return;
    if (runs.at(-1)?.text !== undefined) runs.at(-1).text += text;
    else runs.push({ text });
  };
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { addText(node.nodeValue); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.dataset.block === 'figure') {
      flush(); model.push({ type: 'figure', file: node.dataset.file, w: +node.dataset.w, h: +node.dataset.h }); return;
    }
    if (node.dataset.eq !== undefined) {
      if (node.dataset.block === 'math') {
        flush();
        let low;
        try { low = JSON.parse(node.dataset.reviewLow || '[]'); } catch { low = []; }
        model.push({ type: 'math', eq: node.dataset.eq, ...(low.length ? { reviewLow: low } : {}) });
      }
      else runs.push({ eq: node.dataset.eq });
      return;
    }
    const para = /^(P|DIV)$/.test(node.tagName);
    if (para) { flush(); try { original = JSON.parse(node.dataset.original); } catch { /* 새 문단 */ } }
    if (node.tagName === 'BR' && node.parentNode.childNodes.length > 1) addText('\n');
    else for (const child of node.childNodes) walk(child);
    if (para) flush(true);
  };
  for (const child of root.childNodes) walk(child);
  flush();
  return modelToBlocks(model);
}

async function loadImages(bookId, blocks, images) {
  for (const b of blocks) if (b.type === 'figure' && !images.has(b.file)) images.set(b.file, await api.getAnswerImage(bookId, b.file));
}

export async function showAnswerPreview(root, bookId, itemId) {
  const entry = (await api.getAnswers(bookId)).items[itemId];
  const blocks = answerContent(entry);
  if (!blocks) return;
  const images = new Map();
  await loadImages(bookId, blocks, images);
  if (!root.isConnected) return;
  if (entry.answer) root.append(h('strong', `정답 ${entry.answer}`));
  const doc = h('div.answer-document.answer-readonly');
  renderAnswerDocument(doc, blocks, images);
  root.append(doc);
}

export async function openAnswerEditor({ book, item, sources, answerItem, onChange }) {
  const sourceBook = book;
  book = await api.getBook(book.id);
  item = book.docs?.problem?.items?.find((current) => current.id === item.id);
  if (!item) throw new Error('문항이 바뀌었어요. 책을 다시 여세요.');
  let editable = writable(book);
  let saved = (await api.getAnswers(book.id)).items[item.id] || { answer: '', blocks: [] };
  let draft = { answer: saved.answer, blocks: saved.blocks };
  let history = createAnswerHistory(draft);
  const images = new Map();
  await loadImages(book.id, draft.blocks, images);
  sources ||= await getSources(book);
  answerItem ||= findItem(book.docs.answer, computeMatches(book).get(item.id));
  const status = h('span.answer-status', { role: 'status' }, editable ? '저장됨' : '보기만');
  const answer = h('input.input.answer-input', { value: draft.answer, maxlength: 200, placeholder: '예: ③, 12, x=2', 'aria-label': '정답', readOnly: !editable });
  const editor = h('div.answer-document', { contenteditable: editable ? 'true' : 'false', role: 'textbox', 'aria-label': '해설', 'aria-multiline': 'true', spellcheck: false, dataset: { placeholder: '여기에 해설을 쓰세요. 그림도 붙여 넣을 수 있어요.' } });
  const undo = h('button.btn.btn-small', { onclick: () => travel(false) }, '되돌리기');
  const redo = h('button.btn.btn-small', { onclick: () => travel(true) }, '다시 하기');
  let selection = null;
  let closed = false;
  let failed = false;
  let composing = false;
  const uploads = new Set();
  const updateStatus = () => {
    status.textContent = !editable ? '보기만' : failed ? '저장 못함 · 다시 시도하세요' : saver.pending || saver.saving || uploads.size ? '저장 중…' : '저장됨';
    undo.disabled = !editable || !history.canUndo;
    redo.disabled = !editable || !history.canRedo;
  };
  const saver = createSaveQueue(async () => {
    const sent = structuredClone(withoutAnswerReview(draft));
    saved = await api.saveAnswer(book.id, item.id, sent);
    failed = false;
  }, { delay: 800, changed: updateStatus, failed: (err) => { failed = true; fail(err); } });
  saver.set({});
  let reviewStack;
  const review = answerReview(editor, readAnswerDocument, () => capture(), () => (reviewStack ||= renderStack(blockSegs({ kind: 'answer', role: 'answer', item: answerItem, src: sources.answer }), TRANSCRIBE_WIDTH)));
  const draw = () => { answer.value = draft.answer; renderAnswerDocument(editor, draft.blocks, images); updateStatus(); review.update(); };
  const capture = (kind = '') => {
    if (!editable || composing) return;
    review.sync();
    draft = { answer: answer.value, blocks: readAnswerDocument(editor) };
    if (history.push(draft, kind)) saver.dirty();
    updateStatus();
    review.update();
  };
  function travel(forward) {
    if (!editable) return;
    capture();
    draft = forward ? history.redo() : history.undo();
    draw(); saver.dirty(); selection = null;
  }
  const rememberSelection = () => {
    const sel = window.getSelection();
    if (sel.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) selection = sel.getRangeAt(0).cloneRange();
  };
  const restoreSelection = () => {
    editor.focus();
    const range = selection && editor.contains(selection.commonAncestorContainer) ? selection : document.createRange();
    if (range !== selection) { range.selectNodeContents(editor.lastElementChild || editor); range.collapse(false); }
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    return range;
  };
  const insert = (node, block = false) => {
    const range = restoreSelection();
    range.deleteContents();
    if (block) {
      let p = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      while (p.parentElement !== editor && p !== editor) p = p.parentElement;
      if (p !== editor && /^(P|DIV)$/.test(p.tagName) && !p.dataset.block) {
        const tail = range.cloneRange(); tail.setEnd(p, p.childNodes.length);
        const after = h('p', tail.extractContents());
        p.after(node, after);
        if (!after.childNodes.length) after.append(h('br'));
        range.selectNodeContents(after); range.collapse(true);
      } else { editor.append(node, h('p', h('br'))); range.selectNodeContents(editor.lastElementChild); range.collapse(true); }
    } else { range.insertNode(node); range.setStartAfter(node); range.collapse(true); }
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    selection = range.cloneRange(); capture();
  };
  async function equation(node) {
    if (!editable) return;
    rememberSelection(); history.boundary();
    const result = await openEquationEditor({ eq: node?.dataset.eq || '', display: node?.dataset.block === 'math', returnScope: 'answer' });
    if (!result || !editable) return;
    const next = mathNode(result.eq, result.display);
    if (node?.isConnected && (node.dataset.block === 'math') === result.display) { node.replaceWith(next); capture(); }
    else {
      if (node?.isConnected) { const r = document.createRange(); r.selectNode(node); selection = r; }
      insert(next, result.display);
    }
  }
  const putImage = async (file) => {
    if (file.size > 8 * 1024 * 1024) throw new Error('그림은 8MB 이하로 넣으세요.');
    const name = await api.putAnswerImage(book.id, new Uint8Array(await file.arrayBuffer()));
    const url = await api.getAnswerImage(book.id, name);
    images.set(name, url);
    const img = new Image(); img.src = url; await img.decode();
    return { type: 'figure', file: name, w: img.naturalWidth, h: img.naturalHeight };
  };
  const runUpload = (fn) => {
    const task = Promise.resolve().then(fn).catch(fail).finally(() => { uploads.delete(task); updateStatus(); });
    uploads.add(task); updateStatus(); return task;
  };
  const insertImages = (files) => runUpload(async () => {
    for (const file of files) {
      const block = await putImage(file);
      const temp = h('div'); renderAnswerDocument(temp, [block], images);
      insert(temp.firstElementChild, true);
    }
  });
  const recognized = async () => {
    if (!answerItem) return;
    if ((draft.answer || answerContent(draft)) && !await confirmDialog('지금 쓴 정답·해설을 답지 인식 결과로 바꿀까요?', { ok: '바꾸기' })) return;
    await runUpload(async () => {
      await loadTranscripts(book.id, { reload: true });
      const block = { kind: 'answer', role: 'answer', item: answerItem, src: sources.answer };
      const segs = blockSegs(block);
      const found = bestTranscript(book.id, block)?.entry.blocks || await pdfTranscribe(segs, { plain: book.subject !== 'math' });
      if (!found?.length) throw new Error('읽은 답지 글이 없어요. 답지 그림을 보며 직접 입력하세요.');
      const blocks = importAnswerBlocks(found, { review: true });
      let canvas;
      for (let i = 0; i < blocks.length; i++) if (blocks[i].type === 'figure' && !blocks[i].file) {
        canvas ||= await renderStack(segs, TRANSCRIBE_WIDTH);
        const crop = await cropImage(canvas, blocks[i].box);
        const blob = new Blob([crop.bytes], { type: 'image/png' });
        blocks[i] = await putImage(blob);
      }
      await loadImages(book.id, blocks, images);
      draft = { answer: recognizedAnswer(blocks), blocks };
      history.push(draft); draw(); saver.dirty();
    });
  };
  let chord = 0;
  const keys = (e) => {
    if (!editable || composing || e.isComposing) return;
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyN') { e.preventDefault(); chord = Date.now(); return; }
    if (!e.altKey && !e.metaKey && e.code === 'KeyM' && Date.now() - chord < 1500) { e.preventDefault(); chord = 0; equation().catch(fail); return; }
    if (e.key !== 'Control') chord = 0;
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'KeyP') {
      const range = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0) : null;
      const selected = e.target.closest?.('[data-eq]') || (range && range.startContainer === range.endContainer && range.endOffset === range.startOffset + 1 ? range.startContainer.childNodes[range.startOffset] : null);
      if (selected?.dataset?.eq !== undefined && editor.contains(selected)) { e.preventDefault(); equation(selected).catch(fail); return; }
    }
    if (e.ctrlKey && ['KeyZ', 'KeyY'].includes(e.code)) { e.preventDefault(); travel(e.code === 'KeyY' || e.shiftKey); }
    if (e.target.matches?.('[data-eq], [data-block="figure"]') && ['Backspace', 'Delete'].includes(e.key)) { e.preventDefault(); e.target.remove(); capture(); }
  };
  editor.addEventListener('keydown', keys); answer.addEventListener('keydown', keys);
  editor.addEventListener('input', () => capture('text'));
  editor.addEventListener('compositionstart', () => { composing = true; });
  editor.addEventListener('compositionend', () => { composing = false; capture('text'); });
  editor.addEventListener('beforeinput', (e) => { if (['historyUndo', 'historyRedo'].includes(e.inputType)) { e.preventDefault(); travel(e.inputType === 'historyRedo'); } });
  editor.addEventListener('click', (e) => { const node = e.target.closest('[data-eq]'); if (node) equation(node).catch(fail); });
  editor.addEventListener('paste', (e) => {
    if (!editable) return;
    e.preventDefault(); rememberSelection(); history.boundary();
    const files = [...e.clipboardData.files].filter((f) => /^image\/(png|jpeg)$/.test(f.type));
    if (files.length) insertImages(files);
    else { restoreSelection(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); capture(); }
  });
  let dragged;
  editor.addEventListener('dragstart', (e) => { dragged = e.target.closest('[data-eq], [data-block="figure"]'); if (dragged) { e.dataTransfer.setData('text/plain', ''); e.dataTransfer.effectAllowed = 'move'; } });
  editor.addEventListener('dragover', (e) => { if (editable) e.preventDefault(); });
  editor.addEventListener('drop', (e) => {
    if (!editable) return;
    e.preventDefault(); selection = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (dragged && editor.contains(dragged)) { const node = dragged; dragged = null; if (node.contains(selection?.startContainer)) return; node.remove(); insert(node, !!node.dataset.block); }
    else insertImages([...e.dataTransfer.files].filter((f) => /^image\/(png|jpeg)$/.test(f.type)));
  });
  answer.addEventListener('input', () => capture('answer'));
  document.addEventListener('selectionchange', rememberSelection);
  const flush = async () => { await Promise.all([...uploads]); capture(); return saver.flushPending(); };
  const pending = () => saver.pending || saver.saving || uploads.size > 0;
  const unload = (e) => {
    if (!editable) return;
    composing = false; capture();
    if (uploads.size || saver.pending && !api.saveAnswerSync(book.id, item.id, withoutAnswerReview(draft))) { e.preventDefault(); e.returnValue = ''; }
  };
  restartSaveHooks.add(flush); restartPendingChecks.add(pending); leaveHooks.add(flush);
  window.addEventListener('beforeunload', unload);
  const stop = api.onDataChanged(async (change) => {
    if (closed || !change.books?.some((id) => id === book.id || id === '*')) return;
    try {
      const freshBook = await api.getBook(book.id);
      editable = writable(freshBook); editor.contentEditable = String(editable); answer.readOnly = !editable;
      toolbar.querySelectorAll('button').forEach((b) => { b.disabled = !editable; });
      const remote = (await api.getAnswers(book.id)).items[item.id] || { answer: '', blocks: [] };
      if (!pending() && !composing && JSON.stringify(remote) !== JSON.stringify(saved)) {
        await loadImages(book.id, remote.blocks, images);
        saved = remote; draft = { answer: remote.answer, blocks: remote.blocks }; history = createAnswerHistory(draft); draw();
      }
      updateStatus();
    } catch (err) { fail(err); }
  });
  const toolbar = h('div.answer-toolbar', h('button.btn.btn-small', { disabled: !editable, onmousedown: (e) => { e.preventDefault(); rememberSelection(); }, onclick: () => equation().catch(fail) }, '수식'), undo, redo,
    answerItem ? h('button.btn.btn-small', { disabled: !editable, onclick: () => recognized().catch(fail) }, '답지 인식 결과 불러오기') : null);
  const reference = h('aside.answer-reference', review.reference, h('h4', '답지 그림'), !answerItem ? h('p.small.muted', '답지 없음 · 직접 작성 가능') : null);
  if (answerItem) itemImage(sources.answer, answerItem, 700).then((url) => { if (url) reference.append(h('img', { src: url, alt: '짝 해설 원본' })); }).catch(fail);
  draw();
  await api.setEditorShortcutScope('answer');
  await modal({ title: `정답·해설 · ${item.number || item.num || ''}번`, width: 980, className: 'answer-editor-modal',
    onKeyDown: review.keydown,
    body: h('div', h('p.small.muted', editable ? '자동 저장' : '만든 사람·원장만 수정 가능'),
      h('div.answer-heading', h('label', '정답', answer), editable ? h('div.answer-choices', [...'①②③④⑤'].map((v) => h('button.btn.btn-small', { onclick: () => { if (editable) { answer.value = v; capture(); } } }, v))) : null, status),
      h('div.answer-layout', h('section.answer-writing', toolbar, review.element, editor), reference)),
    beforeClose: flush,
    onClose: () => {
      closed = true; stop(); saver.cancel();
      review.close(); reviewStack = null;
      api.setEditorShortcutScope('');
      document.removeEventListener('selectionchange', rememberSelection); window.removeEventListener('beforeunload', unload);
      restartSaveHooks.delete(flush); restartPendingChecks.delete(pending); leaveHooks.delete(flush);
      api.getAnswers(book.id).then((data) => { sourceBook.$answers = data; onChange?.(); }).catch(fail);
    }, buttons: [{ label: '닫기', value: true }],
  });
}
