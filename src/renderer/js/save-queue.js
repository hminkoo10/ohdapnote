// 저장을 겹치지 않게 하고, 저장 중 생긴 수정·실패한 수정도 다음 저장까지 붙잡는다.
export function createSaveQueue(saveFn, { changed = () => {}, failed = () => {}, delay = 600 } = {}) {
  const dirty = new Map();
  let target = null;
  let timer = null;
  let inFlight = null;
  let sequence = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  const mark = () => {
    if (target) dirty.set(target, ++sequence);
    changed();
  };
  const drain = () => {
    if (inFlight) return inFlight;
    if (!dirty.size) return Promise.resolve(true);
    inFlight = Promise.resolve().then(async () => {
      while (dirty.size) {
        const [object, version] = dirty.entries().next().value;
        try {
          await saveFn(object);
        } catch (err) {
          failed(err);
          return false;
        }
        if (dirty.get(object) === version) dirty.delete(object);
      }
      return true;
    }).finally(() => {
      inFlight = null;
      changed();
    });
    changed();
    return inFlight;
  };
  return {
    set(object) { target = object; },
    dirty() {
      mark();
      cancel();
      timer = setTimeout(drain, delay);
    },
    flush() {
      // 분석 결과처럼 dirty() 없이 바꾼 뒤 flush() 하는 호출도 저장한다.
      mark();
      cancel();
      return drain();
    },
    flushPending() { cancel(); return drain(); },
    cancel,
    get target() { return target; },
    get pending() { return dirty.size > 0; },
    get saving() { return !!inFlight; },
  };
}
