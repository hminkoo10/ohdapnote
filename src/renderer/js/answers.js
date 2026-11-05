/** 내보낼 때마다 최신 정답을 읽음. 문항 id가 달라진 고아 기록은 사용하지 않는다. */
export async function attachAnswers(entries, api = window.ohdap) {
  const books = new Map();
  for (const e of entries) {
    if (!books.has(e.bookId)) books.set(e.bookId, await api.getAnswers(e.bookId));
    e.writtenAnswer = books.get(e.bookId).items[(e.problem || e.item).id];
  }
}

export async function readAnswerFigure(bookId, block) {
  const url = await window.ohdap.getAnswerImage(bookId, block.file);
  return { bytes: new Uint8Array(await (await fetch(url)).arrayBuffer()), ext: 'png', pxW: block.w, pxH: block.h };
}
