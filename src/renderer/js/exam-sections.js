// 시험지에서 명시한 머리글만 사용한다. 쪽 수로 선택/홀짝을 추정하지 않는다.
export function stabilizeExamPages(pages, anchors, subject) {
  const header = (p) => (p.tokens || []).filter((t) => t.y0 < 0.2).map((t) => t.str).join('').replace(/\s/g, '');
  if (!/20\d{2}학년도/.test(header(pages[0] || {})) || !/수학능력시험|모의평가/.test(header(pages[0] || {}))) return null;
  let selection = null, form = null;
  const sections = new Map(), seen = new Set();
  for (const page of pages) {
    const title = header(page);
    const nextForm = /(홀|짝)수형/.exec(title)?.[1];
    if (nextForm && nextForm !== form) { form = nextForm; selection = null; }
    const allowed = subject === 'korean' ? ['화법과작문', '언어와매체'] : subject === 'math' ? ['확률과통계', '미적분', '기하'] : [];
    const sel = allowed.find((s) => title.includes(`(${s})`) || title.includes(`[${s}]`));
    if (sel) selection = sel;
    const dotted = (page.tokens || []).filter((t) => /^\d{1,2}\.$/.test(t.str)).map((t) => {
      const col = (page.layout.columns || []).findIndex((c) => t.x0 >= c.x0 - 0.01 && t.x0 <= c.x1);
      const c = page.layout.columns[col];
      return { ...t, num: parseInt(t.str), digits: String(parseInt(t.str)), col, relX: c ? t.x0 - c.x0 : 1, h: t.y1 - t.y0, conf: 100, prefix: '', padded: false };
    }).filter((t) => t.relX >= -0.02 && t.relX <= 0.045 && t.y0 > 0.13 && t.y1 < 0.94);
    if (selection && !sel && dotted.some((t) => t.num === 1)) selection = null;
    const lo = selection ? subject === 'korean' ? 35 : 23 : 1;
    const hi = subject === 'english' ? 45 : subject === 'korean' ? selection ? 45 : 34 : selection ? 30 : 22;
    const key = JSON.stringify([subject, selection, form]);
    const list = [...dotted, ...(anchors.get(page.index) || [])].filter((t) => t.num >= lo && t.num <= hi && !t.prefix)
      .sort((a, b) => a.col - b.col || a.y0 - b.y0 || a.x0 - b.x0);
    const chosen = [];
    for (const c of list) {
      const id = `${key}:${c.num}`;
      if (seen.has(id)) continue;
      seen.add(id); chosen.push(c);
    }
    anchors.set(page.index, chosen);
    sections.set(page.index, { subject, selection, form });
    if (subject === 'english') page.ranges = (page.ranges || []).filter((r) => [[16,17],[41,42],[43,45]].some(([a,b]) => r.a === a && r.b === b));
  }
  return sections;
}
