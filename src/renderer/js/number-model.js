import { buildLines, extractCandidates, parseNumberWord, PREFIXES, byReadingOrder, columnOf, zoneOf } from './detect.js';

// Probe visual coverage, not number continuity: after 12 nonblank candidate
// pages, fewer than 8 boxes means this design is unknown. Skip the remainder.
export const NUMBER_MODEL_PROBE_PAGES = 12;
export const NUMBER_MODEL_PROBE_BOXES = 8;

export function boxIou(a, b) {
  const overlap = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - overlap;
  return union > 0 ? overlap / union : 0;
}

// Digit centre in a model box padded by 10% on each side, OR IoU >= .3.
// Padding is relative to the detected number, not the page or nearby prose.
export function supportsNumber(digit, box) {
  const px = (box.x1 - box.x0) * 0.1, py = (box.y1 - box.y0) * 0.1;
  const cx = (digit.x0 + digit.x1) / 2, cy = (digit.y0 + digit.y1) / 2;
  return (cx >= box.x0 - px && cx <= box.x1 + px && cy >= box.y0 - py && cy <= box.y1 + py) || boxIou(digit, box) >= 0.3;
}

function tokenNumbers(tokens) {
  const lines = buildLines(tokens || []);
  const words = lines.flatMap(line => line.words);
  const numbers = [];
  for (const word of words) {
    const glued = /^([가-힣]{2,4})(\d{1,3})([.)]?)$/.exec(word.str);
    const prefix = glued && PREFIXES.includes(glued[1]) ? glued[1] : '';
    const parsed = parseNumberWord(prefix ? glued[2] + glued[3] : word.str);
    if (!parsed) continue;
    // Keep the digit box separate from the candidate's prefix/punctuation box.
    const offset = word.str.indexOf(parsed.digits);
    const digit = { ...word, x0: word.x0 + (word.x1 - word.x0) * offset / word.str.length,
      x1: word.x0 + (word.x1 - word.x0) * (offset + parsed.digits.length) / word.str.length };
    numbers.push({ word, digit, parsed, prefix });
  }
  return { words, numbers, lines };
}

function candidateDigit(c, numbers) {
  const own = numbers.filter(n => n.parsed.num === c.num &&
    (n.digit.x0 + n.digit.x1) / 2 >= c.x0 - 0.002 && (n.digit.x0 + n.digit.x1) / 2 <= c.x1 + 0.002 &&
    (n.digit.y0 + n.digit.y1) / 2 >= c.y0 - 0.002 && (n.digit.y0 + n.digit.y1) / 2 <= c.y1 + 0.002);
  own.sort((a, b) => boxIou(b.digit, c) - boxIou(a.digit, c));
  // OCR candidates already have a number-local box. Never read hidden text.
  return own[0]?.digit || c;
}

/** Rescue only text-layer digits. Use the existing candidate constructor/parser. */
export function rescueNumberTokens(page, boxes = page.numberBoxes || []) {
  if (page.hiddenText || !page.tokens?.length) return [];
  const { words, numbers, lines } = tokenNumbers(page.tokens);
  const heights = lines.map(l => l.h).sort((a, b) => a - b);
  const bodyH = heights.length ? heights.length % 2 ? heights[heights.length >> 1] : (heights[heights.length / 2 - 1] + heights[heights.length / 2]) / 2 : 0.012;
  const rescued = [];
  for (const box of boxes) {
    const matches = numbers.filter(n => supportsNumber(n.digit, box));
    matches.sort((a, b) => boxIou(b.digit, box) - boxIou(a.digit, box));
    const n = matches[0];
    if (!n) continue;
    const h = n.word.y1 - n.word.y0;
    const prefixWord = n.prefix ? null : words.filter(w => PREFIXES.includes(w.str) &&
      w.x1 <= n.word.x0 + 0.001 && n.word.x0 - w.x1 <= 1.2 * h &&
      Math.min(w.y1, n.word.y1) - Math.max(w.y0, n.word.y0) > 0.35 * Math.min(h, w.y1 - w.y0))
      .sort((a, b) => b.x1 - a.x1)[0];
    const isolated = prefixWord ? [prefixWord, n.word] : [n.word];
    const local = { columns: page.layout.columns, bodyTop: 0, bodyBottom: 1, hasHeader: false, hasFooter: false };
    const candidate = extractCandidates(isolated, local).candidates.find(c => c.num === n.parsed.num);
    if (!candidate) continue;
    candidate.hRatio = candidate.h / bodyH;
    candidate.col = columnOf(page.layout, { x: candidate.x0, w: candidate.x1 - candidate.x0 });
    candidate.zone = zoneOf(page.layout, candidate.y0);
    rescued.push(candidate);
  }
  return rescued;
}

/** One candidate per visual box. No sequence, expected-count or cross-document evidence. */
export function supportedNumberCandidates(page, blindPrefixes = []) {
  const boxes = page.numberBoxes || [];
  const { numbers } = tokenNumbers(page.hiddenText ? [] : page.tokens);
  const blind = new Set(blindPrefixes);
  const candidates = (page.numberCandidates || page.candidates || []).filter(c => !blind.has(c.prefix || ''));
  const rescues = rescueNumberTokens(page, boxes).filter(c => !blind.has(c.prefix || ''));
  const selected = [];
  for (const box of boxes) {
    const matches = candidates.filter(c => supportsNumber(candidateDigit(c, numbers), box));
    matches.sort((a, b) => boxIou(candidateDigit(b, numbers), box) - boxIou(candidateDigit(a, numbers), box));
    const candidate = matches[0] || rescues.find(c => supportsNumber(candidateDigit(c, numbers), box));
    if (candidate && !selected.some(c => c === candidate || boxIou(candidateDigit(c, numbers), candidateDigit(candidate, numbers)) >= 0.7)) {
      selected.push({ ...candidate, zone: zoneOf(page.layout, candidate.y0) });
    }
  }
  return selected.sort(byReadingOrder);
}

export function mergeNumberModelAnchors(page, today, blindPrefixes) {
  const blind = new Set(blindPrefixes);
  const { numbers } = tokenNumbers(page.hiddenText ? [] : page.tokens);
  const merged = [];
  // Preserve blind-group objects first; a visual duplicate must not replace one.
  for (const c of [...today.filter(c => blind.has(c.prefix || '')), ...supportedNumberCandidates(page, blindPrefixes)]) {
    if (!merged.some(d => c === d || boxIou(candidateDigit(c, numbers), candidateDigit(d, numbers)) >= 0.7)) merged.push(c);
  }
  return merged.sort(byReadingOrder);
}

export function numberModelTrust(pages, anchors, { minBoxes = NUMBER_MODEL_PROBE_BOXES, minAnchors = 4, blindPrefixes: savedBlind, earlyStopped = false, pagesRun, evidencePages = 0, probeBoxes = 0 } = {}) {
  let boxes = 0, explained = 0, finalAnchors = 0, supported = 0, failed = false;
  const perPage = [];
  const prefixGroups = new Map();
  for (const page of pages) {
    if (page.layout.blank) continue;
    if ((!Array.isArray(page.numberBoxes) && !earlyStopped) || page.numberModelFailed) failed = true;
    const modelBoxes = page.numberBoxes || [];
    const { numbers } = tokenNumbers(page.hiddenText ? [] : page.tokens);
    const candidates = page.numberCandidates || page.candidates || [];
    const explain = modelBoxes.filter(b => numbers.some(n => supportsNumber(n.digit, b)) || candidates.some(c => supportsNumber(candidateDigit(c, numbers), b))).length;
    const chain = anchors.get(page.index) || [];
    const support = chain.filter(c => modelBoxes.some(b => supportsNumber(candidateDigit(c, numbers), b))).length;
    for (const c of chain) {
      const prefix = c.prefix || '';
      if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, { prefix, anchors: 0, supported: 0 });
      const group = prefixGroups.get(prefix);
      group.anchors++;
      if (modelBoxes.some(b => supportsNumber(candidateDigit(c, numbers), b))) group.supported++;
    }
    boxes += modelBoxes.length; explained += explain; finalAnchors += chain.length; supported += support;
    perPage.push({ page: page.index, boxes: modelBoxes.length, explained: explain, anchors: chain.length, supported: support,
      ran: !!page.numberModelRan, ms: page.numberModelMs || 0, renderMs: page.numberRenderMs || 0, detectMs: page.numberDetectMs || 0 });
  }
  const explainedRatio = boxes ? explained / boxes : 0;
  const supportedRatio = finalAnchors ? supported / finalAnchors : 0;
  const saved = savedBlind === undefined ? null : new Set(savedBlind);
  const groups = [...prefixGroups.values()].map(g => ({ ...g, ratio: g.supported / g.anchors,
    covered: saved ? !saved.has(g.prefix) : g.anchors < minAnchors || g.supported / g.anchors >= 0.7 }));
  const blindPrefixes = saved ? [...saved] : groups.filter(g => !g.covered).map(g => g.prefix);
  const coveredAnchors = groups.filter(g => g.covered).reduce((n, g) => n + g.anchors, 0);
  const coveredSupported = groups.filter(g => g.covered).reduce((n, g) => n + g.supported, 0);
  const coveredSupportedRatio = coveredAnchors ? coveredSupported / coveredAnchors : 0;
  return { trusted: !failed && !earlyStopped && boxes >= minBoxes && explainedRatio >= 0.9 && coveredAnchors >= minAnchors,
    boxes, explained, finalAnchors, supported, explainedRatio, supportedRatio, coveredAnchors, coveredSupported, coveredSupportedRatio,
    blindPrefixes, groups, failed, earlyStopped, pagesRun: pagesRun ?? perPage.filter(p => p.ran).length, evidencePages, probeBoxes, perPage };
}

// A failed/unavailable optional detector leaves the rules-only path intact.
export async function installedNumberModel(api = window.ohdap) {
  try {
    if (!(await api?.numbersStatus?.())?.installed) return undefined;
    return { onResult(stats) { this.trust = stats; }, async detect(image) {
      const response = await api.numbersDetect({ image });
      if (!response.ok) throw new Error(response.error || 'Number detection failed');
      return response.boxes;
    } };
  } catch { return undefined; }
}
