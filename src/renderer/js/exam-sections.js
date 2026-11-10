// 시험지에서 명시한 머리글만 사용한다. 쪽 수로 선택/홀짝을 추정하지 않는다.
export function stabilizeLegacyExamPages(pages, anchors, subject, exam) {
  if (exam?.exam !== 'edu' || exam.year < 2002 || exam.year > 2026) return null;
  const hi = subject === 'math' ? 30 : subject === 'english' ? 50 : 60;
  const candidates = new Map();
  const axisGroups = [];
  for (const t of pages.flatMap(p=>p.tokens || []).filter(t=>/^\d{1,2}[.)]$/.test(t.str) && t.y0>.08 && t.y1<.96)) {
    let g=axisGroups.find(g=>Math.abs(g.x-t.x0)<.02);
    if (!g) axisGroups.push(g={x:t.x0, nums:new Set()});
    g.nums.add(parseInt(t.str));
  }
  const axes = axisGroups.filter(g=>g.nums.size>=5).map(g=>g.x).sort((a,b)=>a-b);

  for (const page of pages) {
    const list = [];
    if (axes.length === 2 && page.layout.columns.length !== 2) {
      const cols = page.layout.columns, split = axes[1] - .015;
      page.layout.columns=[{x0:Math.min(cols[0].x0,axes[0]),x1:split-.01},{x0:split,x1:Math.max(cols.at(-1).x1,.95)}];
    }
    for (const t of page.tokens || []) {
      const m = /^(?:\((\d{1,2})\)|(\d{1,2})[.)])(?:\s|[^\d]|$)/.exec(t.str);
      const bare = /^\d{1,2}$/.test(t.str) && (page.tokens || []).some(d=>d.str==='.' && Math.abs(d.y0-t.y0)<.008 && d.x0>=t.x1-.005 && d.x0<t.x1+.02);
      if (!m && !bare) continue;
      const num = m ? +(m[1] || m[2]) : +t.str;
      const col = page.layout.columns.findIndex(c => t.x0 >= c.x0 - .015 && t.x0 < c.x1);
      const relX = col < 0 ? 1 : t.x0 - page.layout.columns[col].x0;
      if (num < 1 || num > hi || (axes.length ? !axes.some(x=>Math.abs(x-t.x0)<.025) : relX > .055) || t.y0 < .08 || t.y1 > .96) continue;
      list.push({ ...t, num, digits:String(num), col, relX, h:t.y1-t.y0, conf:100, prefix:'', padded:false });
    }
    candidates.set(page.index, list);
  }
  // 번호가 실제 글자층에 충분히 있을 때만 교체. 스캔은 기존 OCR 후보를 보존.
  const digital = [...candidates.values()].flat().length >= 5;
  const strongNumbers = new Set([...candidates.values()].flat().map(c=>c.num));
  const seen = new Set(), sections = new Map();
  for (const page of pages) {
    const original = anchors.get(page.index) || [];
    const recovered = original.filter(c=>!strongNumbers.has(c.num) && !c.prefix);
    const list = digital && page.tokens?.length ? [...candidates.get(page.index), ...recovered] : original;
    const chosen = list.filter(c => c.num >= 1 && c.num <= hi).sort((a,b) => a.col-b.col || a.y0-b.y0);
    anchors.set(page.index, chosen.filter(c => { if(seen.has(c.num)) return false; seen.add(c.num); return true; }));
    sections.set(page.index, { subject, selection:exam.selection || null, form:exam.form || null });
  }
  return sections;
}

export function stabilizeExamPages(pages, anchors, subject) {
  const header = (p) => (p.tokens || []).filter((t) => t.y0 < 0.2).map((t) => t.str).join('').replace(/\s/g, '');
  if (!/20\d{2}학년도/.test(header(pages[0] || {})) || !/수학능력시험|모의평가/.test(header(pages[0] || {}))) return null;
  const schoolYear = +(/(20\d{2})학년도/.exec(header(pages[0] || {}))?.[1] || 0);
  if (schoolYear < 2022 || schoolYear > 2027) return null; // 검증한 공통/선택 체제만
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
