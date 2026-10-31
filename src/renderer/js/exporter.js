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

// ---------------------------------------------------------------------------

/**
 * @param {object} args
 *   blocks: {kind:'problem'|'answer'|'note'|'section', role?:'problem'|'answer', item?, label?, text?}[]
 *   sources: {problem?: DocSource, answer?: DocSource}
 *   options: DEFAULT_EXPORT_OPTIONS 형태
 *   title: string  (각 쪽 위에 표시)
 *   onProgress(done, total)
 * @returns {Promise<Uint8Array>}
 */
export async function buildPdf({ blocks, sources, options, title, onProgress }) {
  try {
    return await buildPdfInner({ blocks, sources, options, title, onProgress, forceRaster: false });
  } catch (err) {
    console.warn('벡터 내보내기 실패 → 이미지 방식으로 다시 시도', err);
    return buildPdfInner({ blocks, sources, options, title, onProgress, forceRaster: true });
  }
}

async function buildPdfInner({ blocks, sources, options, title, onProgress, forceRaster }) {
  const opts = { ...DEFAULT_EXPORT_OPTIONS, ...(options || {}) };
  const out = await PDFDocument.create();
  out.setTitle(title || '오답노트');
  out.setCreator('오답노트');
  out.setProducer('오답노트 (pdf-lib)');
  const helv = await out.embedFont(StandardFonts.Helvetica);

  // ---- 1) 각 영역(segment)의 그릴 거리 준비 ----
  const segs = []; // {block, role, rect, page(meta), wPt, hPt}
  for (const block of blocks) {
    block.segs = [];
    if ((block.kind !== 'problem' && block.kind !== 'answer') || !block.item) continue;
    const src = sources[block.role];
    if (!src) continue;
    for (const rect of block.item.rects) {
      const meta = src.pages[rect.page];
      if (!meta) continue;
      const k = unitScale(meta);
      const seg = { block, role: block.role, rect, meta, wPt: rect.w * meta.w * k, hPt: rect.h * meta.h * k };
      block.segs.push(seg);
      segs.push(seg);
    }
  }

  // ---- 2) 벡터로 넣을 수 있는 영역은 원본 PDF 에서 잘라 embed ----
  const groups = new Map(); // key role:fileIndex → segs
  for (const seg of segs) {
    if (seg.meta.kind !== 'pdf' || forceRaster) continue;
    const key = `${seg.role}:${seg.meta.fileIndex}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(seg);
  }
  for (const [key, list] of groups) {
    const [role, fileIndexStr] = key.split(':');
    const src = sources[role];
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
      const src = sources[seg.role];
      const widthPx =
        seg.meta.kind === 'image' && seg.meta.pxW ? seg.meta.pxW : Math.round(((seg.meta.w * unitScale(seg.meta)) / 72) * RASTER_DPI);
      const canvas = await src.renderRegion(seg.rect.page, seg.rect, widthPx);
      seg.image = await out.embedJpg(await canvasToBytes(canvas, 'image/jpeg', 0.9));
    }
    done++;
    onProgress?.(done, total);
  }

  // ---- 4) 배치 ----
  const cols = Math.max(1, Math.min(2, opts.columns | 0));
  const contentW = A4.w - MARGIN.left - MARGIN.right;
  const colW = (contentW - COL_GAP * (cols - 1)) / cols;
  const colH = A4.h - MARGIN.top - MARGIN.bottom;
  const space = SPACE_OPTIONS[opts.space] || SPACE_OPTIONS.none;

  const header = title ? textImage(title, { size: 8, color: '#777', maxWidthPt: contentW }) : null;
  const headerImg = header ? await out.embedPng(await canvasToBytes(header.canvas)) : null;

  let page = null;
  let col = 0;
  let y = 0; // 현재 단에서 위에서부터 사용한 높이
  const newPage = () => {
    page = out.addPage([A4.w, A4.h]);
    col = 0;
    y = 0;
    if (headerImg) {
      page.drawImage(headerImg, { x: MARGIN.left, y: A4.h - 30 - header.hPt / 2, width: header.wPt, height: header.hPt });
      page.drawLine({
        start: { x: MARGIN.left, y: A4.h - 36 },
        end: { x: A4.w - MARGIN.right, y: A4.h - 36 },
        thickness: 0.4,
        color: rgb(0.8, 0.8, 0.8),
      });
    }
    if (cols === 2) {
      const xm = MARGIN.left + colW + COL_GAP / 2;
      page.drawLine({ start: { x: xm, y: A4.h - MARGIN.top }, end: { x: xm, y: MARGIN.bottom }, thickness: 0.4, color: rgb(0.85, 0.85, 0.85) });
    }
  };
  const nextColumn = () => {
    if (col + 1 < cols) {
      col++;
      y = 0;
    } else newPage();
  };
  newPage();

  for (const block of blocks) {
    if (block.kind === 'pagebreak') {
      if (y > 0 || col > 0) newPage();
      continue;
    }
    if (block.kind === 'section') {
      if (y > 0 || col > 0) newPage();
      const t = textImage(block.text, { size: 15, bold: true, color: '#c2410c' });
      const img = await out.embedPng(await canvasToBytes(t.canvas));
      const yTop = A4.h - MARGIN.top - y;
      page.drawImage(img, { x: MARGIN.left, y: yTop - t.hPt, width: t.wPt, height: t.hPt });
      y += t.hPt + 14;
      continue;
    }

    // 라벨
    let label = null;
    if (block.label) {
      const t = textImage(block.label, {
        size: 9,
        bold: true,
        color: block.kind === 'answer' ? '#0f766e' : '#c2410c',
        maxWidthPt: colW,
      });
      label = { ...t, img: await out.embedPng(await canvasToBytes(t.canvas)) };
    }
    let note = null;
    if (block.kind === 'note' || (block.segs && block.segs.length === 0 && block.text)) {
      const t = textImage(block.text || '', { size: 9, color: '#888', maxWidthPt: colW });
      note = { ...t, img: await out.embedPng(await canvasToBytes(t.canvas)) };
    }

    const segList = block.segs || [];
    const maxW = Math.max(1, ...segList.map((s) => s.wPt));
    let scale = Math.min(1, colW / maxW);
    const labelH = label ? label.hPt + 3 : 0;
    const noteH = note ? note.hPt : 0;
    const segsH = () => segList.reduce((sum, s) => sum + s.hPt * scale, 0) + SEG_GAP * Math.max(0, segList.length - 1);
    let blockH = labelH + noteH + segsH();
    if (blockH > colH) {
      // 한 단보다 크면 줄여서 맞춤
      const avail = colH - labelH - noteH - SEG_GAP * Math.max(0, segList.length - 1);
      const raw = segList.reduce((sum, s) => sum + s.hPt, 0);
      scale = Math.min(scale, Math.max(0.2, avail / Math.max(1, raw)));
      blockH = labelH + noteH + segsH();
    }
    if (y > 0 && y + blockH > colH) nextColumn();

    const x0 = MARGIN.left + col * (colW + COL_GAP);
    let cursor = A4.h - MARGIN.top - y;
    if (label) {
      page.drawImage(label.img, { x: x0, y: cursor - label.hPt, width: label.wPt, height: label.hPt });
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
      cursor -= h + (i < segList.length - 1 ? SEG_GAP : 0);
    });
    y += blockH + BLOCK_GAP;

    if (block.kind === 'problem' && block.addSpace) {
      if (space.pageBreak) {
        newPage();
      } else if (space.pt > 0) {
        y += space.pt;
        if (y >= colH) nextColumn();
      }
    }
  }

  // ---- 5) 쪽 번호 ----
  const pagesOut = out.getPages();
  pagesOut.forEach((p, i) => {
    const text = `${i + 1} / ${pagesOut.length}`;
    const w = helv.widthOfTextAtSize(text, 8);
    p.drawText(text, { x: (A4.w - w) / 2, y: 22, size: 8, font: helv, color: rgb(0.55, 0.55, 0.55) });
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
 * @param {{problem:object, answer:object|null}[]} entries 읽는 순서로 정렬된 선택 항목
 * @param {(role:string, item:object)=>string} pageLabel  쪽 표시 (예: "p.12")
 */
export function makeBlocks(mode, entries, options, pageLabel) {
  const opts = { ...DEFAULT_EXPORT_OPTIONS, ...(options || {}) };
  if (mode === 'both') mode = opts.bothOrder === 'interleave' ? 'both-inline' : 'both-end'; // 예전 설정 호환
  const blocks = [];
  const num = (i) => (opts.renumber ? `${i + 1}. ` : '');
  const problemBlock = (e, i) => ({
    kind: 'problem',
    role: 'problem',
    item: e.problem,
    addSpace: mode === 'problems' || mode === 'both-end',
    label: opts.labels ? `${num(i)}${pageLabel('problem', e.problem)} ${itemName(e.problem)}` : '',
  });
  const answerLabel = (e, i) => (opts.labels ? `${num(i)}해설 · 문제 ${pageLabel('problem', e.problem)} ${itemName(e.problem)}` : '');
  const answerBlock = (e, i) =>
    e.answer
      ? { kind: 'answer', role: 'answer', item: e.answer, label: answerLabel(e, i) }
      : { kind: 'note', label: answerLabel(e, i), text: '(답지에서 짝이 되는 해설을 찾지 못했어요)', segs: [] };

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
