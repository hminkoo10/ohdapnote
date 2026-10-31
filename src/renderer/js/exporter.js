// 선택한 문항(문제/해설)을 모아 새 PDF 를 만듭니다.
//  - 원본이 PDF 면 벡터 그대로 잘라 붙임(선명하고 용량 작음)
//  - 암호화/회전된 PDF·이미지는 고해상도 이미지로 잘라 붙임

import { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState } from '../vendor/pdf-lib.esm.min.js';
import { createCanvas } from './docsource.js';

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = { top: 46, bottom: 42, left: 38, right: 38 };
const COL_GAP = 22;
const BLOCK_GAP = 16;
const SEG_GAP = 4;
const RASTER_DPI = 200;
const FONT_STACK = `'Pretendard Variable', Pretendard, 'Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Noto Sans CJK KR', 'WenQuanYi Zen Hei', sans-serif`;

export const SPACE_OPTIONS = {
  none: { label: '없음', short: '없음', pt: 0 },
  small: { label: '조금 (약 3cm)', short: '3cm', pt: 85 },
  large: { label: '많이 (약 8cm)', short: '8cm', pt: 227 },
  page: { label: '한 쪽에 한 문제', short: '한 쪽에 하나', pt: 0, pageBreak: true },
};

export const DEFAULT_EXPORT_OPTIONS = {
  columns: 1,
  space: 'small',
  labels: true,
  bothOrder: 'append', // append: 문제 모두 → 해설 모두, interleave: 문제·해설 번갈아
  renumber: true,
};

/** 원본 쪽 단위(pt)를 정규화: 비정상적으로 큰/작은 페이지(스캔 PDF 등)는 A4 폭으로 */
function unitScale(page) {
  return page.w > 1000 || page.w < 300 ? A4.w / page.w : 1;
}

// ---------------------------------------------------------------------------
// 글자(한글) → PNG. pdf-lib 기본 글꼴은 한글이 없으므로 캔버스로 그려 이미지로 넣습니다.
// ---------------------------------------------------------------------------
const SS = 4; // 해상도 배율
function textImage(text, { size = 9, bold = false, color = '#333', maxWidthPt = 0 } = {}) {
  const font = `${bold ? '700 ' : ''}${size * SS}px ${FONT_STACK}`;
  const probe = createCanvas(10, 10).getContext('2d');
  probe.font = font;
  let str = text;
  if (maxWidthPt > 0) {
    while (str.length > 1 && probe.measureText(str).width / SS > maxWidthPt) str = str.slice(0, -2) + '…';
  }
  const width = Math.ceil(probe.measureText(str).width) + 2 * SS;
  const height = Math.ceil(size * 1.45 * SS);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(str, SS, height / 2);
  return { canvas, wPt: width / SS, hPt: height / SS };
}

async function canvasToBytes(canvas, type = 'image/png', quality) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

/** 굵은 번호 + 회색 출처를 한 줄로 그린 PNG (예: "3.  쎈 p.12 · 0153번") */
function labelImage(numText, srcText, { color = '#111', srcColor = '#8a8f98', maxWidthPt = 0 } = {}) {
  const numFont = `800 ${11 * SS}px ${FONT_STACK}`;
  const srcFont = `500 ${7.6 * SS}px ${FONT_STACK}`;
  const probe = createCanvas(10, 10).getContext('2d');
  probe.font = numFont;
  const numW = numText ? probe.measureText(numText).width : 0;
  const gap = numText && srcText ? 5 * SS : 0;
  probe.font = srcFont;
  let src = srcText || '';
  if (maxWidthPt > 0) {
    while (src.length > 1 && (numW + gap + probe.measureText(src).width) / SS > maxWidthPt) src = src.slice(0, -2) + '…';
  }
  const srcW = src ? probe.measureText(src).width : 0;
  const width = Math.ceil(numW + gap + srcW) + 2 * SS;
  const height = Math.ceil(16 * SS);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';
  const base = height * 0.74;
  if (numText) {
    ctx.font = numFont;
    ctx.fillStyle = color;
    ctx.fillText(numText, SS, base);
  }
  if (src) {
    ctx.font = srcFont;
    ctx.fillStyle = srcColor;
    ctx.fillText(src, SS + numW + gap, base - 0.5 * SS);
  }
  return { canvas, wPt: width / SS, hPt: height / SS };
}

async function embedText(out, text, opts) {
  const t = textImage(text, opts);
  return { ...t, img: await out.embedPng(await canvasToBytes(t.canvas)) };
}

const GRAY = (v) => rgb(v, v, v);

/**
 * 시험지 머리(첫 쪽): 학원 · 날짜 / 큰 제목 / 부제 / 두 줄 선 / 학원·선생님·학생·점수 칸
 * @returns {Promise<number>} 머리가 차지한 높이(pt)
 */
async function drawExamHeader(out, page, info, contentW) {
  const left = MARGIN.left;
  const right = A4.w - MARGIN.right;
  let top = A4.h - 34;
  if (info.academy || info.date) {
    if (info.academy) {
      const t = await embedText(out, info.academy, { size: 9, bold: true, color: '#555', maxWidthPt: contentW * 0.6 });
      page.drawImage(t.img, { x: left, y: top - t.hPt, width: t.wPt, height: t.hPt });
    }
    if (info.date) {
      const t = await embedText(out, info.date, { size: 9, color: '#777' });
      page.drawImage(t.img, { x: right - t.wPt, y: top - t.hPt, width: t.wPt, height: t.hPt });
    }
    top -= 16;
  }
  const title = await embedText(out, info.title || '오답노트', { size: 21, bold: true, color: '#111', maxWidthPt: contentW });
  page.drawImage(title.img, { x: (A4.w - title.wPt) / 2, y: top - title.hPt, width: title.wPt, height: title.hPt });
  top -= title.hPt + 1;
  if (info.subtitle) {
    const sub = await embedText(out, info.subtitle, { size: 9.5, color: '#666', maxWidthPt: contentW });
    page.drawImage(sub.img, { x: (A4.w - sub.wPt) / 2, y: top - sub.hPt, width: sub.wPt, height: sub.hPt });
    top -= sub.hPt + 2;
  }
  top -= 6;
  page.drawLine({ start: { x: left, y: top }, end: { x: right, y: top }, thickness: 1.8, color: GRAY(0.1) });
  page.drawLine({ start: { x: left, y: top - 3 }, end: { x: right, y: top - 3 }, thickness: 0.5, color: GRAY(0.1) });
  top -= 11;

  // 정보 칸
  const cells = [
    ['학원', info.academy],
    ['선생님', info.teacher],
    ['학생', info.student],
    ['점수', ''],
  ];
  const rowH = 21;
  const headW = 42;
  const cellW = contentW / cells.length;
  for (let i = 0; i < cells.length; i++) {
    const x = left + i * cellW;
    page.drawRectangle({ x, y: top - rowH, width: headW, height: rowH, color: GRAY(0.95) });
    page.drawRectangle({ x, y: top - rowH, width: cellW, height: rowH, borderColor: GRAY(0.55), borderWidth: 0.6 });
    page.drawLine({ start: { x: x + headW, y: top }, end: { x: x + headW, y: top - rowH }, thickness: 0.6, color: GRAY(0.55) });
    const head = await embedText(out, cells[i][0], { size: 8.5, bold: true, color: '#333' });
    page.drawImage(head.img, { x: x + (headW - head.wPt) / 2, y: top - rowH / 2 - head.hPt / 2, width: head.wPt, height: head.hPt });
    if (cells[i][1]) {
      const val = await embedText(out, cells[i][1], { size: 9, color: '#111', maxWidthPt: cellW - headW - 8 });
      page.drawImage(val.img, { x: x + headW + 6, y: top - rowH / 2 - val.hPt / 2, width: val.wPt, height: val.hPt });
    }
  }
  top -= rowH + 14;
  return A4.h - top - MARGIN.top;
}

// ---------------------------------------------------------------------------

/**
 * @param {object} args
 *   blocks: {kind:'problem'|'answer'|'note'|'section'|'pagebreak', role?, item?, src?, stem?, num?, source?, text?}[]
 *   sources: {problem?: DocSource, answer?: DocSource}  (block.src 가 없을 때 씀)
 *   options: DEFAULT_EXPORT_OPTIONS 형태
 *   title: string  (PDF 제목)
 *   info: {title, subtitle, academy, teacher, student, date}  (시험지 머리)
 *   onProgress(done, total)
 * @returns {Promise<Uint8Array>}
 */
export async function buildPdf(args) {
  try {
    return await buildPdfInner({ ...args, forceRaster: false });
  } catch (err) {
    console.warn('벡터 내보내기 실패 → 이미지 방식으로 다시 시도', err);
    return buildPdfInner({ ...args, forceRaster: true });
  }
}

async function buildPdfInner({ blocks, sources = {}, options, title, info, onProgress, forceRaster }) {
  const opts = { ...DEFAULT_EXPORT_OPTIONS, ...(options || {}) };
  const exam = { title: title || '오답노트', ...(info || {}) };
  const out = await PDFDocument.create();
  out.setTitle(exam.title);
  out.setCreator('오답노트');
  out.setProducer('오답노트 (pdf-lib)');
  if (exam.teacher || exam.academy) out.setAuthor([exam.academy, exam.teacher].filter(Boolean).join(' '));
  const helv = await out.embedFont(StandardFonts.Helvetica);

  // ---- 1) 각 영역(segment)의 그릴 거리 준비 ----
  const srcIds = new Map(); // DocSource → 번호
  const srcList = [];
  const segs = []; // {block, src, rect, meta, wPt, hPt}
  for (const block of blocks) {
    block.segs = [];
    if ((block.kind !== 'problem' && block.kind !== 'answer') || !block.item) continue;
    const src = block.src || sources[block.role];
    if (!src) continue;
    if (!srcIds.has(src)) {
      srcIds.set(src, srcList.length);
      srcList.push(src);
    }
    const rects = [...(block.stem || []).map((r) => ({ ...r, stem: true })), ...block.item.rects];
    for (const rect of rects) {
      const meta = src.pages[rect.page];
      if (!meta) continue;
      const k = unitScale(meta);
      const seg = { block, src, rect, meta, wPt: rect.w * meta.w * k, hPt: rect.h * meta.h * k };
      block.segs.push(seg);
      segs.push(seg);
    }
  }

  // ---- 2) 벡터로 넣을 수 있는 영역은 원본 PDF 에서 잘라 embed ----
  const groups = new Map(); // key 소스번호:파일번호 → segs
  for (const seg of segs) {
    if (seg.meta.kind !== 'pdf' || forceRaster) continue;
    const key = `${srcIds.get(seg.src)}:${seg.meta.fileIndex}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(seg);
  }
  for (const [key, list] of groups) {
    const [srcIndex, fileIndexStr] = key.split(':');
    const src = srcList[Number(srcIndex)];
    let srcDoc;
    try {
      srcDoc = await PDFDocument.load(await src.getFileBytes(Number(fileIndexStr)), { updateMetadata: false });
    } catch (err) {
      console.warn('원본 PDF 를 벡터로 열 수 없음(이미지로 대체):', err?.message);
      continue;
    }
    const usable = [];
    const pages = [];
    const boxes = [];
    for (const seg of list) {
      const page = srcDoc.getPage(seg.meta.pageIndex);
      const angle = ((page.getRotation().angle % 360) + 360) % 360;
      if (angle !== 0) continue;
      const crop = page.getCropBox();
      const left = crop.x + seg.rect.x * crop.width;
      const right = crop.x + (seg.rect.x + seg.rect.w) * crop.width;
      const top = crop.y + crop.height - seg.rect.y * crop.height;
      const bottom = crop.y + crop.height - (seg.rect.y + seg.rect.h) * crop.height;
      pages.push(page);
      boxes.push({ left, bottom, right, top });
      usable.push(seg);
    }
    if (!pages.length) continue;
    const embedded = await out.embedPages(pages, boxes);
    usable.forEach((seg, i) => {
      seg.embedded = embedded[i];
    });
  }

  // ---- 3) 나머지는 이미지로 ----
  let done = 0;
  const total = segs.length;
  for (const seg of segs) {
    if (!seg.embedded) {
      const widthPx =
        seg.meta.kind === 'image' && seg.meta.pxW ? seg.meta.pxW : Math.round(((seg.meta.w * unitScale(seg.meta)) / 72) * RASTER_DPI);
      const canvas = await seg.src.renderRegion(seg.rect.page, seg.rect, widthPx);
      seg.image = await out.embedJpg(await canvasToBytes(canvas, 'image/jpeg', 0.9));
    }
    done++;
    onProgress?.(done, total);
  }

  // ---- 4) 배치 ----
  const cols = Math.max(1, Math.min(2, opts.columns | 0));
  const contentW = A4.w - MARGIN.left - MARGIN.right;
  const colW = (contentW - COL_GAP * (cols - 1)) / cols;
  const space = SPACE_OPTIONS[opts.space] || SPACE_OPTIONS.none;

  // 둘째 쪽부터 쓰는 작은 머리
  const runLeft = [exam.academy, exam.title].filter(Boolean).join('  ·  ');
  const runRight = exam.student ? `${exam.student}` : '';
  const runL = runLeft ? await embedText(out, runLeft, { size: 7.8, color: '#777', maxWidthPt: contentW * 0.7 }) : null;
  const runR = runRight ? await embedText(out, runRight, { size: 7.8, bold: true, color: '#555', maxWidthPt: contentW * 0.28 }) : null;

  let page = null;
  let col = 0;
  let y = 0; // 현재 단에서 위에서부터 사용한 높이
  let headH = 0; // 이 쪽 머리 높이(첫 쪽만 큼)
  let colH = 0;
  const drawDivider = () => {
    if (cols !== 2) return;
    const xm = MARGIN.left + colW + COL_GAP / 2;
    page.drawLine({ start: { x: xm, y: A4.h - MARGIN.top - headH }, end: { x: xm, y: MARGIN.bottom }, thickness: 0.5, color: GRAY(0.72) });
  };
  const newPage = async () => {
    const first = !page;
    page = out.addPage([A4.w, A4.h]);
    col = 0;
    y = 0;
    if (first) {
      headH = await drawExamHeader(out, page, exam, contentW);
    } else {
      headH = 0;
      if (runL) page.drawImage(runL.img, { x: MARGIN.left, y: A4.h - 30 - runL.hPt / 2, width: runL.wPt, height: runL.hPt });
      if (runR) page.drawImage(runR.img, { x: A4.w - MARGIN.right - runR.wPt, y: A4.h - 30 - runR.hPt / 2, width: runR.wPt, height: runR.hPt });
      page.drawLine({ start: { x: MARGIN.left, y: A4.h - 37 }, end: { x: A4.w - MARGIN.right, y: A4.h - 37 }, thickness: 0.6, color: GRAY(0.25) });
    }
    colH = A4.h - MARGIN.top - MARGIN.bottom - headH;
    drawDivider();
  };
  const nextColumn = async () => {
    if (col + 1 < cols) {
      col++;
      y = 0;
    } else await newPage();
  };
  await newPage();
  const fullH = A4.h - MARGIN.top - MARGIN.bottom;

  for (const block of blocks) {
    if (block.kind === 'pagebreak') {
      if (y > 0 || col > 0) await newPage();
      continue;
    }
    if (block.kind === 'section') {
      if (y > 0 || col > 0) await newPage();
      const t = await embedText(out, block.text, { size: 14, bold: true, color: '#111' });
      const yTop = A4.h - MARGIN.top - headH - y;
      page.drawImage(t.img, { x: MARGIN.left, y: yTop - t.hPt, width: t.wPt, height: t.hPt });
      page.drawLine({ start: { x: MARGIN.left, y: yTop - t.hPt - 4 }, end: { x: MARGIN.left + colW, y: yTop - t.hPt - 4 }, thickness: 1.4, color: GRAY(0.1) });
      y += t.hPt + 16;
      continue;
    }

    // 라벨: 굵은 새 번호 + 회색 출처
    let label = null;
    if (block.num || block.source) {
      const t = labelImage(block.num || '', block.source || '', { color: block.kind === 'answer' ? '#0f5f58' : '#111', maxWidthPt: colW });
      label = { ...t, img: await out.embedPng(await canvasToBytes(t.canvas)) };
    }
    let note = null;
    if (block.kind === 'note' || (block.segs && block.segs.length === 0 && block.text)) {
      note = await embedText(out, block.text || '', { size: 9, color: '#888', maxWidthPt: colW });
    }

    const segList = block.segs || [];
    const maxW = Math.max(1, ...segList.map((s) => s.wPt));
    let scale = Math.min(1, colW / maxW);
    const labelH = label ? label.hPt + 2 : 0;
    const noteH = note ? note.hPt : 0;
    const segsH = () => segList.reduce((sum, s) => sum + s.hPt * scale, 0) + SEG_GAP * Math.max(0, segList.length - 1);
    let blockH = labelH + noteH + segsH();
    const limitH = y > 0 || col > 0 ? fullH : colH;
    if (blockH > limitH) {
      // 한 단보다 크면 줄여서 맞춤
      const avail = limitH - labelH - noteH - SEG_GAP * Math.max(0, segList.length - 1);
      const raw = segList.reduce((sum, s) => sum + s.hPt, 0);
      scale = Math.min(scale, Math.max(0.2, avail / Math.max(1, raw)));
      blockH = labelH + noteH + segsH();
    }
    if (y > 0 && y + blockH > colH) await nextColumn();

    const x0 = MARGIN.left + col * (colW + COL_GAP);
    let cursor = A4.h - MARGIN.top - headH - y;
    if (label) {
      page.drawImage(label.img, { x: x0 - 1, y: cursor - label.hPt, width: label.wPt, height: label.hPt });
      cursor -= labelH;
    }
    if (note) {
      page.drawImage(note.img, { x: x0 + 4, y: cursor - note.hPt, width: note.wPt, height: note.hPt });
      cursor -= noteH;
    }
    segList.forEach((s, i) => {
      const w = s.wPt * scale;
      const h = s.hPt * scale;
      if (s.embedded) {
        page.pushOperators(pushGraphicsState());
        page.drawPage(s.embedded, { x: x0, y: cursor - h, width: w, height: h });
        page.pushOperators(popGraphicsState());
      } else if (s.image) {
        page.drawImage(s.image, { x: x0, y: cursor - h, width: w, height: h });
      }
      // 공통 지문 아래에 옅은 점선
      if (s.rect.stem && i < segList.length - 1 && !segList[i + 1].rect.stem) {
        page.drawLine({ start: { x: x0, y: cursor - h - SEG_GAP / 2 }, end: { x: x0 + w, y: cursor - h - SEG_GAP / 2 }, thickness: 0.4, color: GRAY(0.75), dashArray: [2, 2] });
      }
      cursor -= h + (i < segList.length - 1 ? SEG_GAP : 0);
    });
    y += blockH + BLOCK_GAP;

    if (block.kind === 'problem' && block.addSpace) {
      if (space.pageBreak) {
        await newPage();
      } else if (space.pt > 0) {
        y += space.pt;
        if (y >= colH) await nextColumn();
      }
    }
  }

  // ---- 5) 쪽 번호 ----
  const pagesOut = out.getPages();
  pagesOut.forEach((p, i) => {
    const text = `- ${i + 1} -`;
    const w = helv.widthOfTextAtSize(text, 9);
    p.drawText(text, { x: (A4.w - w) / 2, y: 22, size: 9, font: helv, color: GRAY(0.35) });
    const tot = `${i + 1} / ${pagesOut.length}`;
    const tw = helv.widthOfTextAtSize(tot, 7);
    p.drawText(tot, { x: A4.w - MARGIN.right - tw, y: 22, size: 7, font: helv, color: GRAY(0.6) });
  });

  return out.save({ useObjectStreams: true });
}

/** 문항 표시 이름: "12번", "유제 3", "예제 1" */
export function itemName(item) {
  return item.prefix ? `${item.prefix} ${item.number}` : `${item.number}번`;
}

/**
 * 선택 항목 → 내보낼 블록 목록
 * @param {'problems'|'answers'|'both-inline'|'both-end'} mode
 *    problems: 문제만, answers: 해설만,
 *    both-inline: 문제마다 바로 뒤에 해설, both-end: 문제를 모두 싣고 해설은 맨 뒤에 모아서
 * @param {{problem:object, answer:object|null, src?:{problem,answer}, book?:string}[]} entries 읽는 순서로 정렬된 선택 항목
 * @param {(role:string, item:object, entry:object)=>string} pageLabel  쪽 표시 (예: "p.12")
 */
export function makeBlocks(mode, entries, options, pageLabel) {
  const opts = { ...DEFAULT_EXPORT_OPTIONS, ...(options || {}) };
  if (mode === 'both') mode = opts.bothOrder === 'interleave' ? 'both-inline' : 'both-end'; // 예전 설정 호환
  const blocks = [];
  const num = (i) => (opts.renumber ? `${i + 1}.` : '');
  const where = (e) => (opts.labels ? [e.book, `${pageLabel('problem', e.problem, e)} ${itemName(e.problem)}`].filter(Boolean).join(' ') : '');
  let lastStem = null;
  const problemBlock = (e, i) => {
    // 같은 공통 지문을 쓰는 문항이 이어지면 지문은 처음 한 번만
    const stemKey = e.problem.stem?.length ? `${e.book || ''}|${JSON.stringify(e.problem.stem)}` : null;
    const stem = stemKey && stemKey !== lastStem ? e.problem.stem : null;
    lastStem = stemKey;
    return {
      kind: 'problem',
      role: 'problem',
      item: e.problem,
      src: e.src?.problem,
      stem,
      addSpace: mode === 'problems' || mode === 'both-end',
      num: num(i),
      source: where(e),
    };
  };
  const answerBlock = (e, i) => {
    const base = { num: num(i), source: opts.labels ? `해설 · ${where(e)}` : '해설' };
    return e.answer
      ? { kind: 'answer', role: 'answer', item: e.answer, src: e.src?.answer, ...base }
      : { kind: 'note', ...base, text: '(답지에서 짝이 되는 해설을 찾지 못했어요)', segs: [] };
  };

  if (mode === 'problems') entries.forEach((e, i) => blocks.push(problemBlock(e, i)));
  else if (mode === 'answers') entries.forEach((e, i) => blocks.push(answerBlock(e, i)));
  else if (mode === 'both-inline') {
    entries.forEach((e, i) => {
      blocks.push(problemBlock(e, i));
      blocks.push(answerBlock(e, i));
      if (opts.space === 'page') blocks.push({ kind: 'pagebreak' });
    });
  } else {
    entries.forEach((e, i) => blocks.push(problemBlock(e, i)));
    blocks.push({ kind: 'section', text: '정답 및 해설' });
    entries.forEach((e, i) => blocks.push(answerBlock(e, i)));
  }
  return blocks;
}
