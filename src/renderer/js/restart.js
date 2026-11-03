/** 화면의 저장·작업 상태. 재시작이 취소돼도 화면 이동 훅은 건드리지 않는다. */
export function createRestartGuard({ api, hasWork, hasDraft, lock, now = Date.now }) {
  const savers = new Set();
  const saveHooks = new Set();
  const pendingChecks = new Set();
  const busy = new Map();
  let enabled = false;
  let preparing = false;
  let timer = null;
  let lastInputAt = now();
  const getState = () => ({
    lastInputAt,
    pendingSaves: [...savers].some((s) => s.pending || s.saving) || [...pendingChecks].some((check) => check()),
    busy: busy.size > 0 || hasWork() || hasDraft(),
  });
  const report = () => { if (enabled) api.reportRestartState(getState()); };
  const flush = async () => {
    for (const saver of savers) if (!(await saver.flushPending())) return false;
    for (const fn of [...saveHooks]) if ((await fn()) === false) return false;
    return !getState().pendingSaves;
  };
  return {
    savers, saveHooks, pendingChecks, getState, report,
    async start() {
      enabled = true;
      timer ||= setInterval(report, 30 * 1000);
      await api.updateRestartReady(getState());
    },
    stop() { clearInterval(timer); timer = null; enabled = false; },
    activity() { lastInputAt = now(); report(); },
    busy(key, active) {
      const count = (busy.get(key) || 0) + (active ? 1 : -1);
      if (count > 0) busy.set(key, count);
      else busy.delete(key);
      report();
    },
    async track(key, fn) {
      this.busy(key, true);
      try {
        return await fn();
      } finally {
        this.busy(key, false);
      }
    },
    async prepare({ id, manual }) {
      if (!enabled || preparing) return false;
      preparing = true;
      const inputAtStart = lastInputAt;
      let ok = false;
      try {
        const before = getState();
        if (!before.busy && (manual || !before.pendingSaves)) ok = await flush();
        const after = getState();
        ok = ok && !after.busy && !after.pendingSaves && inputAtStart === lastInputAt;
        // 저장 뒤 확인 응답이 오가는 짧은 동안 새 편집을 받지 않는다.
        if (ok) lock(true);
        return await api.finishUpdateRestart({ id, ok, state: after });
      } catch (err) {
        console.error(err);
        await api.finishUpdateRestart({ id, ok: false, state: getState() }).catch(() => {});
        return false;
      } finally {
        lock(false);
        preparing = false;
        report();
      }
    },
  };
}
