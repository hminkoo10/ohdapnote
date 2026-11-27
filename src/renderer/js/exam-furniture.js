/** Explicit subject mastheads are not question-number anchors. */
export function filterExamHeaderCandidates(candidates, tokens) {
  return candidates.filter((c) => {
    if (c.y0 >= 0.16) return true;
    const cy = (c.y0 + c.y1) / 2;
    const row = tokens.filter((t) => Math.abs((t.y0 + t.y1) / 2 - cy) < 0.012).sort((a, b) => a.x0 - b.x0);
    const text = row.map((t) => t.str).join('').replace(/\s/g, '');
    return !/^(?:\d+)?(?:수학영역(?:\((?:확률과통계|미적분|기하)\))?|\((?:확률과통계|미적분|기하)\))(?:\d+)?$/.test(text);
  });
}

