// Windows의 짧은 파일 잠금은 기다려 다시 저장한다. 영구 실패는 호출자에게 남긴다.
export async function saveExamTranscripts(save, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await save()) return true;
    if (attempt < 5) await wait(250 * 2 ** attempt);
  }
  return false;
}
