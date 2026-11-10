// Windows의 짧은 파일 잠금은 기다려 다시 저장한다. 영구 실패는 호출자에게 남긴다.
export async function saveExamTranscripts(save, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await save()) return true;
    if (attempt < 5) await wait(250 * 2 ** attempt);
  }
  return false;
}

// 빈 OCR·모델 실패에도 원본 문항을 잃지 않는다.
export function examScanEntry(result) {
  if (result?.blocks?.length) return { ...result, model: 'ocr' };
  return { ...result, model: 'ocr', reliable: false, blocks: [{ type: 'figure', box: { x: 0, y: 0, w: 1, h: 1 }, low: [{ reason: 'ocr', detail: '글로 옮기지 못한 문항 — 원본을 확인하세요' }] }] };
}
