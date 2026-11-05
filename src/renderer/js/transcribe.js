import { h, toast } from './ui.js';
import { itemName, CONVERT_MODES } from './exporter.js';
import { buildHwpx, renderStack, cropImage, blockSegs } from './hwpx.js';
import { geminiTranscribeBatch, canvasToBase64Jpeg } from './gemini.js';
import { scanTranscribe } from './scanocr.js';
import { transcribeParts } from './pdfmath.js';
import { transcriptKey, pickTranscript, trimTranscripts } from './transcript-store.js';
import { subjectOf } from './subjects.js';
import { countLow } from './lowconf.js';
import { api, state, nav, geminiReady, aiOff, aiOptions, aiLabel, aiModelText, jobDialog, holdSource, restartSaveHooks, restartPendingChecks } from './shared.js';

export { transcriptKey } from './transcript-store.js';

// ===========================================================================
// 한글 문서(HWPX): 문항을 글자·수식으로 옮겨 넣음 — 디지털 PDF 는 PDF 글자로, 스캔본은 OCR·AI 로 (못 옮긴 문항은 그림으로)
// ===========================================================================
export const TRANSCRIBE_WIDTH = 1500; // AI·OCR 에 넘기는 그림 폭(px)
const MAX_TRANSCRIPTS = 3000; // 책 하나에 저장해 두는 개수
const transcripts = new Map(); // 책 id → {items: {열쇠: {blocks, model, at}}, dirty}  (책 폴더의 transcripts.json)
restartPendingChecks.add(() => [...transcripts.values()].some((t) => t.dirty));
restartSaveHooks.add(saveTranscripts);

const loading = new Map();
let saving = Promise.resolve(true);

export async function loadTranscripts(bookId, { reload = false } = {}) {
  if (loading.has(bookId)) return loading.get(bookId);
  if (transcripts.has(bookId) && (!reload || transcripts.get(bookId).dirty)) return transcripts.get(bookId);
  const read = (async () => {
    const before = transcripts.get(bookId)?.items;
    const data = await api.getTranscripts(bookId);
    let store = transcripts.get(bookId);
    if (!store) {
      store = { items: data?.items || {}, dirty: false };
      transcripts.set(bookId, store);
    } else if (!store.dirty && store.items === before) store.items = data?.items || {};
    return store;
  })();
  loading.set(bookId, read);
  try {
    return await read;
  } finally {
    loading.delete(bookId);
  }
}

export function saveTranscripts() {
  saving = saving.then(flushTranscripts, flushTranscripts);
  return saving;
}

async function flushTranscripts() {
  let ok = true;
  for (const [bookId, t] of transcripts) {
    if (!t.dirty) continue;
    t.items = trimTranscripts(t.items, MAX_TRANSCRIPTS);
    const sent = JSON.stringify(t.items);
    try {
      const saved = await api.saveTranscripts(bookId, { version: 1, items: JSON.parse(sent) });
      if (saved === false) throw new Error('책이 없어졌거나 보기만 하는 과목이에요.');
      // 저장 중 다른 화면·작업에서 더한 결과를 저장된 것으로 처리하지 않음
      if (JSON.stringify(t.items) === sent) t.dirty = false;
    } catch (err) {
      ok = false;
      console.warn('옮긴 결과를 저장하지 못함', err);
    }
  }
  return ok;
}

/** loadTranscripts 뒤에 사용. 검색·목록은 동기적으로 읽음 */
export function bestTranscript(bookId, block) {
  return pickTranscript(transcripts.get(bookId)?.items, transcriptKey(block));
}

export async function setEditedTranscript(bookId, block, blocks) {
  const store = await loadTranscripts(bookId);
  const { id = '', name = '' } = state.appInfo.user || {};
  store.items[`${transcriptKey(block)}|edit`] = { blocks, model: 'edit', at: Date.now(), by: { id, name } };
  store.dirty = true;
  if (!(await saveTranscripts())) throw new Error('고친 글을 저장하지 못했어요. 다시 저장하세요.');
}

export async function clearEditedTranscript(bookId, block) {
  const store = await loadTranscripts(bookId);
  delete store.items[`${transcriptKey(block)}|edit`];
  store.dirty = true;
  if (!(await saveTranscripts())) throw new Error('원래대로 저장하지 못했어요. 다시 시도하세요.');
}

/**
 * 수식 글꼴로 만든 디지털 PDF 는 AI 없이 쪽의 글자·선을 그대로 읽어 옮김. 못 하면 null
 * 그림 상자(box)는 renderStack 으로 쌓은 그림 기준 (같은 폭·같은 틈)
 */
export async function pdfTranscribe(segs, { plain = false } = {}) {
  if (!segs.length) return null;
  const scale = TRANSCRIBE_WIDTH / Math.max(...segs.map((s) => s.wPt));
  const W = Math.max(...segs.map((s) => s.wPt * scale));
  const H = segs.reduce((sum, s) => sum + s.hPt * scale, 0) + 12 * (segs.length - 1);
  const parts = [];
  let y = 0;
  for (const s of segs) {
    // 스캔 위에 숨겨진 OCR 글자는 검색 결과로도 믿지 않음
    if (plain && await s.src.hasOnlyHiddenText?.(s.rect.page)) return null;
    const layer = await s.src.getMathLayer?.(s.rect.page);
    if (!layer) return null;
    parts.push({ layer, rect: s.rect, place: { x: 0, y: y / H, w: (s.wPt * scale) / W, h: (s.hPt * scale) / H } });
    y += s.hPt * scale + 12;
  }
  try {
    return transcribeParts(parts, { plain });
  } catch (err) {
    console.warn('PDF 글자로 옮기지 못함', err);
    return null;
  }
}

/**
 * 0) 디지털 PDF 문항은 PDF 글자로 바로 옮김 (어느 방식이든)
 * 1) 스캔본 문항은 내보내기 설정 convert 에 따라
 *    - 'ai'  : AI 로 (문항 여러 개를 한 요청에 묶고(설정 aiBatch), 요청 여러 개를 동시에(aiConcurrency))
 *    - 'ocr' : 이 컴퓨터의 OCR + 수식 인식으로만 (AI 는 부르지 않음)
 *    - 'mix' : 먼저 OCR 로, 결과가 미덥지 않은 문항만 AI 로 (AI 가 실패하면 OCR 결과를 씀)
 *    옮긴 결과는 책마다 저장 (AI 는 transcriptKey, OCR 은 transcriptKey + '|local')
 * 2) buildHwpx 는 문항마다 transcribe 를 부르는데, 미리 옮겨 둔 결과를 그대로 씀
 */
export async function exportHwpx(blocks, entries, opts, info, job) {
  const bookOf = new Map(); // 원본(DocSource) → 책 id
  const plainSources = new Set();
  for (const e of entries) for (const src of [e.src?.problem, e.src?.answer]) if (src) {
    bookOf.set(src, e.bookId);
    if (opts.plainPdf && subjectOf(e.bookObj) !== 'math') plainSources.add(src);
  }
  // buildHwpx 가 글자로 옮기려는 문항 (그릴 영역이 있는 문제·해설)
  const work = blocks.filter((b) => (b.kind === 'problem' || b.kind === 'answer') && b.item && bookOf.has(b.src) && blockSegs(b).length);
  for (const bid of new Set(work.map((b) => bookOf.get(b.src)))) await loadTranscripts(bid);
  const edited = (b) => transcripts.get(bookOf.get(b.src))?.items[`${transcriptKey(b)}|edit`];
  const fromPdf = new Map(); // 문항 → PDF 글자로 옮긴 결과
  for (const b of work) {
    if (edited(b)?.blocks?.length) continue;
    const list = await pdfTranscribe(blockSegs(b), { plain: plainSources.has(b.src) });
    if (list?.length) {
      fromPdf.set(b, list);
      const store = transcripts.get(bookOf.get(b.src));
      store.items[`${transcriptKey(b)}|pdf`] = { blocks: list, model: 'pdf', at: Date.now() };
      store.dirty = true;
    }
  }
  const scanned = work.filter((b) => !fromPdf.has(b) && !edited(b)?.blocks?.length);
  const mode = CONVERT_MODES[opts.convert] ? opts.convert : 'mix';
  let ocrReady = false;
  if (scanned.length && mode !== 'ai') {
    try {
      ocrReady = !!(await api.mathocrStatus())?.installed;
    } catch (err) {
      console.warn('수식 인식 모델 상태를 알지 못함', err);
    }
  }
  const useAi = scanned.length > 0 && mode !== 'ocr' && geminiReady();
  const useOcr = scanned.length > 0 && mode !== 'ai' && ocrReady;
  const { batch: batchSize, ...ai } = aiOptions();
  const abort = new AbortController();
  const storeOf = (block) => transcripts.get(bookOf.get(block.src));
  const aiKey = (b) => transcriptKey(b);
  const ocrKey = (b) => `${transcriptKey(b)}|local`;
  const aiResult = (b) => (useAi ? storeOf(b)?.items[aiKey(b)] : null);
  const ocrResult = (b) => (useOcr ? storeOf(b)?.items[ocrKey(b)] : null);
  const has = (r) => !!r?.blocks?.length;
  /** 쓸 결과: AI 결과가 있으면 그것, 없으면 OCR 결과 */
  const resultOf = (b) => (has(aiResult(b)) ? aiResult(b) : has(ocrResult(b)) ? ocrResult(b) : null);
  /** AI 에게 보낼 문항인지 ('섞어서'는 OCR 결과가 없거나 미덥지 않을 때만) */
  const needsAi = (b) => useAi && !has(aiResult(b)) && !(has(ocrResult(b)) && ocrResult(b).reliable);
  const missing = scanned.filter((b) => !resultOf(b)).length;
  if (missing && !useAi && !useOcr) noConvertToast(mode, missing);
  let quota = false; // 한도가 차면 나머지는 묻지 않음 (OCR 결과가 있으면 그것, 없으면 그림)
  let ui = null;
  const releases = [];
  const settled = new Set();
  const settle = (b, stateName, msg, path) => {
    ui.row(b).set(stateName, msg, path);
    settled.add(b);
    ui.progress(settled.size, work.length);
  };
  /** AI 가 못 옮긴 문항: OCR 결과가 있으면 그것으로, 없으면 그림으로 */
  const aiFailed = (b, why) => {
    if (has(ocrResult(b))) settle(b, 'ok', `${why} → OCR 결과로`, 'OCR');
    else settle(b, why === '읽은 내용이 없음' || why === '한도 초과' ? 'empty' : 'err', `${why} → 그림으로`, 'AI');
  };

  /** 이 컴퓨터에서 옮기기 (문항 둘을 겹쳐서: 하나가 수식을 인식하는 동안 다음 문항의 글자를 읽음) */
  const runOcr = async (pending) => {
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        if (abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
        const b = pending[next++];
        const row = ui.row(b);
        row.set('run', '글자 읽는 중…', 'OCR');
        try {
          const canvas = await renderStack(blockSegs(b), TRANSCRIBE_WIDTH);
          const r = await scanTranscribe(canvas, { number: b.item.passage ? '' : b.item.number, signal: abort.signal, api, onStatus: (msg) => row.set('run', msg, 'OCR') });
          if (abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
          if (!r.blocks.length) {
            if (useAi) row.set('wait', '읽은 내용이 없음 → AI 에게', 'OCR');
            else settle(b, 'empty', '읽은 내용이 없음 → 그림으로', 'OCR');
            continue;
          }
          const store = storeOf(b);
          store.items[ocrKey(b)] = { blocks: r.blocks, model: 'ocr', reliable: r.reliable, reasons: r.reasons, at: Date.now() };
          store.dirty = true;
          const what = `글자·수식으로 옮김${r.formulas ? ` (수식 ${r.formulas}개)` : ''}`;
          if (r.reliable) settle(b, 'ok', what, 'OCR');
          else if (useAi) row.set('wait', `미덥지 않음 (${r.reasons[0]}) → AI 에게`, 'OCR');
          else settle(b, 'ok', `${what} · 확인 필요 (${r.reasons[0]})`, 'OCR');
        } catch (err) {
          if (err?.name === 'AbortError' || abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
          console.warn('OCR 로 옮기지 못함', err);
          if (useAi) row.set('wait', `${err.message} → AI 에게`, 'OCR');
          else settle(b, 'err', `${err.message} → 그림으로`, 'OCR');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, pending.length) }, worker));
  };

  /** AI 로 옮기기: 묶음으로 동시에 (같은 열쇠의 문항은 한 번만) */
  const runAi = async (pending) => {
    const groups = new Map(); // 열쇠 → 블록들
    for (const b of pending) {
      const key = aiKey(b);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    // 문제와 해설은 지시문이 달라서 따로 묶음
    const batches = [];
    for (const role of ['problem', 'answer']) {
      const keys = [...groups.keys()].filter((k) => groups.get(k)[0].role === role);
      for (let i = 0; i < keys.length; i += batchSize) batches.push({ role, keys: keys.slice(i, i + batchSize) });
    }
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        if (abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
        const { role, keys } = batches[next++];
        if (quota) {
          for (const k of keys) for (const b of groups.get(k)) aiFailed(b, '한도 초과');
          continue;
        }
        for (const k of keys) for (const b of groups.get(k)) ui.row(b).set('run', '옮기는 중…', 'AI');
        let results;
        try {
          // buildHwpx 가 transcribe 에 넘기는 것과 같은 영역(blockSegs)·같은 폭의 그림
          const images = [];
          for (const k of keys) images.push(canvasToBase64Jpeg(await renderStack(blockSegs(groups.get(k)[0]), TRANSCRIBE_WIDTH), 0.85));
          results = await geminiTranscribeBatch(images, { role, ...ai, signal: abort.signal, onStatus: (msg) => ui.status(msg) });
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          results = keys.map(() => err);
        }
        if (abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
        keys.forEach((k, i) => {
          const r = results[i];
          if (r instanceof Error) {
            if (/한도/.test(r.message)) {
              quota = true;
              ui.status(r.message);
            }
            for (const b of groups.get(k)) aiFailed(b, r.message);
          } else if (!r.length) {
            for (const b of groups.get(k)) aiFailed(b, '읽은 내용이 없음');
          } else {
            const store = storeOf(groups.get(k)[0]);
            store.items[k] = { blocks: [...r], model: r.model, at: Date.now() };
            store.dirty = true;
            for (const b of groups.get(k)) settle(b, 'ok', `글자·수식으로 옮김 · ${r.model || '기본 모델'}`, 'AI');
          }
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(ai.concurrency, batches.length) }, worker));
  };

  let reviewCount = 0;
  const transcribe = async (block, segs) => {
    if (abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
    let stack = null;
    const getStack = async () => (stack ||= await renderStack(segs, TRANSCRIBE_WIDTH));
    // 그림(그래프·도형)은 바로 잘라 두고 큰 canvas 는 버림
    const finish = async (list) => {
      reviewCount += countLow(list);
      const crops = new Map();
      for (const b of list) if (b.type === 'figure') crops.set(b.box, await cropImage(await getStack(), b.box));
      stack = null;
      return {
        blocks: list,
        crop: async (box) => {
          if (!crops.has(box)) throw new Error('잘라 둔 그림이 없음');
          return crops.get(box);
        },
      };
    };
    if (edited(block)?.blocks?.length) return finish(edited(block).blocks);
    if (fromPdf.has(block)) return finish(fromPdf.get(block));
    const r = (useAi || useOcr) && storeOf(block) ? resultOf(block) : null;
    return r ? finish(r.blocks) : null;
  };

  try {
    if (useAi || useOcr) {
      const pendingOcr = useOcr ? scanned.filter((b) => !has(aiResult(b)) && !has(ocrResult(b))) : [];
      const pendingAi = scanned.filter((b) => !pendingOcr.includes(b) && needsAi(b));
      if (pendingOcr.length || pendingAi.length) {
        ui = transcribeDialog(work, { ocr: pendingOcr.length, ai: pendingAi.length, useAi, useOcr }, abort, {
          ...job,
          jobTitle: `${info.student ? `${info.student} · ` : ''}한글 문서 (문항 ${work.length}개)`,
        });
        // 뒤에서 도는 동안 다른 책을 열어도 이 원본들은 닫히지 않게
        for (const e of entries) for (const role of ['problem', 'answer']) releases.push(holdSource(e.bookObj, role));
        for (const b of work) {
          if (edited(b)?.blocks?.length) settle(b, 'ok', '고친 글', '고침');
          else if (fromPdf.has(b)) settle(b, 'ok', 'PDF 글자로 옮김', 'PDF');
          else if (!pendingOcr.includes(b) && !pendingAi.includes(b)) {
            const r = resultOf(b);
            if (r) settle(b, 'ok', '저장해 둔 결과', r === aiResult(b) ? 'AI' : 'OCR');
            else settle(b, 'empty', '그림으로', '');
          }
        }
        ui.progress(settled.size, work.length);
        await runOcr(pendingOcr);
        // OCR 결과가 미덥지 않은 문항(과 OCR 이 못 읽은 문항)만 AI 로
        const toAi = scanned.filter((b) => !settled.has(b) && needsAi(b));
        if (toAi.length) await runAi(toAi);
        for (const b of scanned) if (!settled.has(b)) settle(b, 'empty', '그림으로', '');
        ui.status('한글 문서를 만드는 중…');
      }
    }
    const bytes = await buildHwpx({ blocks, options: opts, title: info.title, info, transcribe });
    bytes.reviewCount = reviewCount;
    bytes.job = ui; // 옮기기 창을 띄웠으면 부른 쪽이 finish() — 앞에 보이면 창을 닫고, 뒤로 보내 두었으면 [저장하기] 알림
    return bytes;
  } catch (err) {
    ui?.finish();
    throw err;
  } finally {
    releases.forEach((release) => release());
    await saveTranscripts();
  }
}

/** 스캔본 문항을 글자로 옮길 수 없어 그림으로 넣을 때 알림 (설정 열기) */
function noConvertToast(mode, n) {
  const why =
    mode === 'ocr'
      ? '수식 인식 모델을 받지 않아서'
      : mode === 'ai'
        ? aiOff()
          ? '설정에서 정밀 인식이 꺼져 있어서'
          : '정밀 인식을 설정하지 않아서'
        : '정밀 인식과 수식 인식 파일을 쓸 수 없어서';
  toast(`${why} 스캔본 문항 ${n}개는 그림으로 넣어요.`, { timeout: 8000, actions: [{ label: '설정 열기', onClick: () => nav.settings() }] });
}

/**
 * 옮기는 동안 보이는 창 (문항별 상태 · 어떤 방법으로 옮겼는지(PDF/OCR/AI), 진행 막대).
 * [취소]하면 바로 요청·인식을 끊고, [다른 일 하면서 기다리기]이면 창만 닫고 계속
 */
function transcribeDialog(work, { ocr, ai: aiCount, useAi, useOcr }, abort, { key, sig, jobTitle }) {
  const rows = new Map();
  const list = h(
    'div.gem-list',
    work.map((b) => {
      const row = h(
        'div.gem-row',
        { dataset: { state: 'wait' } },
        h('span.gem-dot'),
        h('strong', b.item.passage ? itemName(b.item) : `${b.kind === 'answer' ? '해설' : '문제'} ${itemName(b.item)}`),
        h('span.gem-path'),
        h('span.gem-msg.muted', '기다리는 중'),
      );
      rows.set(b, row);
      return row;
    }),
  );
  const how = useOcr && useAi ? `필요한 문항만 외부 서비스로 보내요.` : useOcr ? '이 컴퓨터에서 읽어요. 문항당 몇 초~수십 초 걸려요.' : `문항을 외부 서비스로 보내요.`;
  const status = h('div.small.muted.gem-status', useAi ? `모델: ${aiModelText()}` : '수식 인식: 이 컴퓨터 (Pix2Text)');
  const bar = h('div.progress-bar');
  const jd = jobDialog({
    key,
    sig,
    abort,
    jobTitle,
    total: work.length,
    title: `문항 ${work.length}개를 글자·수식으로`,
    body: h(
      'div.gem-run',
      h('p.small.muted', `${ocr + aiCount}문항 — ${how} 못 옮긴 문항은 그림으로 넣어요.`),
      h('div.progress', bar),
      status,
      list,
    ),
    width: 480,
    className: 'gem-modal',
  });
  return {
    /** path: 'PDF' | 'OCR' | 'AI' — 이 문항을 어떤 방법으로 옮겼는지 */
    row: (block) => ({
      set(stateName, msg, path) {
        const row = rows.get(block);
        if (!row) return;
        row.dataset.state = stateName;
        row.querySelector('.gem-msg').textContent = msg;
        if (path != null) {
          const tag = row.querySelector('.gem-path');
          tag.textContent = { AI: '정밀 인식', OCR: '스캔 인식' }[path] || path;
          tag.dataset.path = path;
        }
        if (stateName === 'run') row.scrollIntoView({ block: 'nearest' });
      },
    }),
    status: (msg) => {
      status.textContent = msg;
      jd.job.progress({ label: msg });
    },
    progress: (done, total) => {
      bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
      jd.job.progress({ done, total });
    },
    /** 끝: 창이 앞에 있으면 닫고 false, 뒤로 보내 두었고 r.message 가 있으면 알림(토스트·윈도우)을 띄우고 true */
    finish(r) {
      const bg = jd.finish(r);
      if (!bg) jd.close();
      return bg;
    },
  };
}
