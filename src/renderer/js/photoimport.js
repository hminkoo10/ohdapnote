import { preparePhoto } from './photoprep.js';
import { bookFileUrl } from './docsource.js';
import { newDoc, addFiles } from './store.js';
import { api, holdBook, jobDialog } from './shared.js';
import { h } from './ui.js';

// 한 장씩 보정·압축하고 캔버스는 바로 놓는다.
export async function encodePhoto(url) {
  let bitmap, prepared;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('사진을 읽지 못했어요.');
    bitmap = await createImageBitmap(await response.blob());
    prepared = await preparePhoto(bitmap);
    const result = { width: bitmap.width, height: bitmap.height, reason: prepared.reason,
      status: prepared.changed ? 'prepared' : 'unchanged', pages: [] };
    if (prepared.changed) for (const canvas of prepared.pages) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) throw new Error('사진을 저장하지 못했어요.');
      result.pages.push({ width: canvas.width, height: canvas.height, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    return result;
  } catch {
    return { status: 'failed', reason: 'processing-failed', width: bitmap?.width, height: bitmap?.height };
  } finally {
    for (const canvas of prepared?.pages || []) if (canvas !== bitmap) canvas.width = canvas.height = 1;
    bitmap?.close();
  }
}

export async function importBookFiles(book, role, paths, add = false) {
  const release = holdBook(book);
  const label = h('p', '파일을 가져오고 있어요…');
  const dialog = jobDialog({ key: `import:${book.id}`, bookId: book.id, role,
    title: '사진과 파일 넣기', body: label });
  let imported;
  const checkCancelled = () => { if (dialog.job.cancelled) throw new Error('파일 넣기를 취소했어요.'); };
  try {
    imported = await api.importFiles(book.id, role, paths, add);
    const files = [], total = imported.files.filter((f) => f.kind === 'image').length;
    let done = 0;
    for (const f of imported.files) {
      checkCancelled();
      if (f.kind === 'pdf') { files.push(f); continue; }
      label.textContent = `사진 정리 중… ${done+1} / ${total}장`;
      dialog.job.progress({ done, total, label: label.textContent });
      await new Promise((r) => setTimeout(r, 0));
      const photo = await encodePhoto(bookFileUrl(book.id, f.name));
      checkCancelled();
      files.push(...await api.savePhotoPages({ token: imported.token, name: f.name, ...photo }));
      done++;
    }
    checkCancelled();
    const result = { ...imported, files };
    const doc = add && book.docs[role] ? addFiles(structuredClone(book.docs[role]), result) : newDoc(role, result);
    const draft = { ...book, docs: { ...book.docs, [role]: doc }, updatedAt: Date.now() };
    if (!add) draft.answerOverrides = {};
    label.textContent = '교재에 저장하고 있어요…';
    await api.commitFileImport(imported.token, draft);
    Object.assign(book, draft);
    dialog.finish({ message: '교재에 파일을 넣었어요.' });
    return result;
  } finally {
    if (imported) await api.discardFileImport(imported.token).catch(() => {});
    dialog.finish();
    dialog.close();
    release();
  }
}
