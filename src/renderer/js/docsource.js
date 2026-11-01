// 문서(문제집/답지) 소스: PDF 와 이미지 파일을 하나의 "페이지 목록"으로 다룹니다.
// 모든 좌표는 페이지 크기에 대한 비율(0~1, y 는 위→아래)로 다룹니다.

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const PDF_OPTIONS = {
  cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
  wasmUrl: new URL('../vendor/pdfjs/wasm/', import.meta.url).href,
  iccUrl: new URL('../vendor/pdfjs/iccs/', import.meta.url).href,
  isEvalSupported: false,
  enableXfa: false,
};

/** 이미지 페이지의 가상 폭(pt). A4 폭에 맞춰 크기를 정규화합니다. */
const IMAGE_VIRTUAL_WIDTH = 595.28;

export function bookFileUrl(bookId, name) {
  return `app://book/${encodeURIComponent(bookId)}/${encodeURIComponent(name)}`;
}

export async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`파일을 읽을 수 없습니다 (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * @param {{name:string, kind:'pdf'|'image'}[]} files
 * @param {(name:string)=>string} urlFor  저장된 파일 이름 → URL
 */
export async function openDocSource(files, urlFor) {
  const src = new DocSource(files, urlFor);
  await src.init();
  return src;
}

export class DocSource {
  constructor(files, urlFor) {
    this.files = files.map((f) => ({ ...f }));
    this.urlFor = urlFor;
    /** @type {{fileIndex:number, pageIndex:number, kind:'pdf'|'image', w:number, h:number, rotate:number}[]} */
    this.pages = [];
    this._pdfDocs = new Map();
    this._images = new Map();
    this._pageCache = new Map();
    this._tasks = [];
    this._hiddenStreak = new Map(); // 파일별: 연달아 "숨은 OCR 글자뿐"이었던 쪽 수
  }

  get numPages() {
    return this.pages.length;
  }

  async init() {
    for (let fi = 0; fi < this.files.length; fi++) {
      const f = this.files[fi];
      if (f.kind === 'pdf') {
        const data = await fetchBytes(this.urlFor(f.name));
        const task = pdfjsLib.getDocument({ ...PDF_OPTIONS, data });
        const doc = await task.promise;
        this._pdfDocs.set(fi, doc);
        this._tasks.push(task);
        f.pageCount = doc.numPages;
        for (let p = 0; p < doc.numPages; p++) {
          const page = await doc.getPage(p + 1);
          const vp = page.getViewport({ scale: 1 });
          this.pages.push({ fileIndex: fi, pageIndex: p, kind: 'pdf', w: vp.width, h: vp.height, rotate: page.rotate || 0 });
          page.cleanup();
        }
      } else {
        const bitmap = await this._loadImage(fi);
        f.pageCount = 1;
        const w = IMAGE_VIRTUAL_WIDTH;
        const h = (IMAGE_VIRTUAL_WIDTH * bitmap.height) / bitmap.width;
        this.pages.push({ fileIndex: fi, pageIndex: 0, kind: 'image', w, h, rotate: 0, pxW: bitmap.width, pxH: bitmap.height });
      }
    }
  }

  async _loadImage(fileIndex) {
    if (this._images.has(fileIndex)) return this._images.get(fileIndex);
    const f = this.files[fileIndex];
    const res = await fetch(this.urlFor(f.name));
    if (!res.ok) throw new Error('이미지를 읽을 수 없습니다.');
    const bitmap = await createImageBitmap(await res.blob());
    this._images.set(fileIndex, bitmap);
    return bitmap;
  }

  async getPdfPage(i) {
    const p = this.pages[i];
    if (!p || p.kind !== 'pdf') return null;
    const key = i;
    if (this._pageCache.has(key)) return this._pageCache.get(key);
    const page = await this._pdfDocs.get(p.fileIndex).getPage(p.pageIndex + 1);
    this._pageCache.set(key, page);
    // 메모리를 위해 최근 페이지 몇 개만 유지
    if (this._pageCache.size > 12) {
      const [oldKey, oldPage] = this._pageCache.entries().next().value;
      this._pageCache.delete(oldKey);
      oldPage.cleanup();
    }
    return page;
  }

  /** 페이지 전체를 지정한 픽셀 폭으로 렌더링 */
  async renderPage(i, widthPx) {
    return this.renderRegion(i, { x: 0, y: 0, w: 1, h: 1 }, widthPx);
  }

  /**
   * 페이지의 일부 영역(rect: 비율 좌표)을 렌더링합니다.
   * @param {number} pageWidthPx  "페이지 전체 폭"을 몇 픽셀로 볼지(해상도)
   */
  async renderRegion(i, rect, pageWidthPx) {
    const p = this.pages[i];
    const scalePx = pageWidthPx / p.w; // pt → px
    const fullW = p.w * scalePx;
    const fullH = p.h * scalePx;
    const canvas = createCanvas(rect.w * fullW, rect.h * fullH);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const offX = rect.x * fullW;
    const offY = rect.y * fullH;
    if (p.kind === 'pdf') {
      const page = await this.getPdfPage(i);
      const viewport = page.getViewport({ scale: scalePx });
      await page.render({
        canvas,
        viewport,
        transform: [1, 0, 0, 1, -offX, -offY],
        background: 'rgb(255,255,255)',
        annotationMode: pdfjsLib.AnnotationMode.ENABLE,
      }).promise;
    } else {
      const bitmap = await this._loadImage(p.fileIndex);
      const k = bitmap.width / fullW; // 화면 px → 이미지 px
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, offX * k, offY * k, canvas.width * k, canvas.height * k, 0, 0, canvas.width, canvas.height);
    }
    return canvas;
  }

  /**
   * PDF 텍스트 레이어에서 단어 단위 토큰을 뽑습니다(좌표는 비율).
   * 이미지 페이지이거나 텍스트가 없으면 빈 배열.
   * @returns {Promise<{str:string,x0:number,y0:number,x1:number,y1:number}[]>}
   */
  async getTextTokens(i) {
    const p = this.pages[i];
    if (p.kind !== 'pdf') return [];
    const page = await this.getPdfPage(i);
    const vp = page.getViewport({ scale: 1 });
    let content;
    try {
      content = await page.getTextContent();
    } catch {
      return [];
    }
    // 글꼴 구분 열쇠: PDF 안의 글꼴 조각 이름(g_d0_f3 …)은 쪽마다 달라질 수 있으므로
    // 글꼴 종류·높이 정보·굵기로 정규화 (같은 글꼴이면 쪽이 달라도 같은 열쇠)
    const fontKeys = new Map();
    const fontKey = (name) => {
      if (!name) return '';
      if (fontKeys.has(name)) return fontKeys.get(name);
      const st = content.styles?.[name] || {};
      let flags = '';
      try {
        if (page.commonObjs.has(name)) {
          const f = page.commonObjs.get(name);
          flags = `${f.bold ? 'B' : ''}${f.black ? 'K' : ''}${f.italic ? 'I' : ''}`;
        }
      } catch {
        /* 아직 불러오지 않은 글꼴 */
      }
      const key = `${st.fontFamily || ''}|${Math.round((st.ascent || 0) * 100)}|${Math.round((st.descent || 0) * 100)}|${flags}`;
      fontKeys.set(name, key);
      return key;
    };
    const tokens = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
      const angle = Math.atan2(tx[1], tx[0]);
      if (Math.abs(angle) > 0.08) continue; // 세로/회전 텍스트는 무시
      const fontH = Math.hypot(tx[2], tx[3]);
      if (!(fontH > 0.5)) continue;
      const width = Math.abs(item.width) * vp.scale;
      const x = tx[4];
      const baseline = tx[5];
      const top = baseline - fontH * 0.82;
      const bottom = baseline + fontH * 0.2;
      const str = item.str;
      const len = str.length;
      // 한 항목 안의 단어들을 글자 수 비율로 나눔
      const re = /\S+/g;
      let m;
      while ((m = re.exec(str))) {
        const a = len > 0 ? m.index / len : 0;
        const b = len > 0 ? (m.index + m[0].length) / len : 1;
        tokens.push({
          str: m[0],
          x0: (x + width * a) / vp.width,
          x1: (x + width * Math.max(b, a + 0.01)) / vp.width,
          y0: top / vp.height,
          y1: bottom / vp.height,
          font: fontKey(item.fontName),
        });
      }
    }
    return tokens;
  }

  /**
   * 글자가 모두 보이지 않게(렌더 모드 3·7) 깔려 있는지.
   * 스캔본 위에 휴대폰·스캐너가 OCR 글자를 숨겨 넣은 PDF 로, 한글이 엉터리로 읽혀 있는 경우가 많아 믿지 않습니다.
   */
  async hasOnlyHiddenText(i) {
    const p = this.pages[i];
    if (p.kind !== 'pdf') return false;
    // 같은 파일에서 3쪽 연달아 그랬다면 스캔 앱으로 만든 PDF 로 보고 더 검사하지 않음(쪽 이미지를 다시 읽느라 느림)
    const streak = this._hiddenStreak.get(p.fileIndex) || 0;
    if (streak >= 3) return true;
    const hidden = await this._checkHiddenText(i);
    this._hiddenStreak.set(p.fileIndex, hidden ? streak + 1 : 0);
    return hidden;
  }

  async _checkHiddenText(i) {
    const page = await this.getPdfPage(i);
    // 방금 그린 쪽이면 pdf.js 가 그릴 때 받아 둔 명령 목록을 그대로 씀 (다시 받으면 도형이 많은 쪽은 0.3초쯤 걸림)
    let ops = [...(page._intentStates?.values() || [])].find((s) => s.operatorList?.lastChunk)?.operatorList;
    try {
      ops ||= await page.getOperatorList();
    } catch {
      return false;
    }
    const OPS = pdfjsLib.OPS;
    const SHOW = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
    const stack = [];
    let mode = 0;
    let shown = 0;
    let hidden = 0;
    for (let k = 0; k < ops.fnArray.length; k++) {
      const fn = ops.fnArray[k];
      if (fn === OPS.save) stack.push(mode);
      else if (fn === OPS.restore) mode = stack.length ? stack.pop() : 0;
      else if (fn === OPS.setTextRenderingMode) mode = ops.argsArray[k][0];
      else if (SHOW.has(fn)) {
        if ((mode & 3) === 3) hidden++;
        else shown++;
      }
    }
    return hidden > 0 && shown === 0;
  }

  /** 내보내기용: 원본 파일 바이트 */
  async getFileBytes(fileIndex) {
    return fetchBytes(this.urlFor(this.files[fileIndex].name));
  }

  async destroy() {
    for (const page of this._pageCache.values()) page.cleanup();
    this._pageCache.clear();
    for (const task of this._tasks) await task.destroy?.();
    this._tasks = [];
    this._pdfDocs.clear();
    for (const bmp of this._images.values()) bmp.close?.();
    this._images.clear();
  }
}
