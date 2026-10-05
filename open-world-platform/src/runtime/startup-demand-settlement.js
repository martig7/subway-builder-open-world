export const STARTUP_DEMAND_SETTLEMENT_VERSION = 'startup-demand-memory-retry-v1';
const MEMORY_ERROR = 'NativeDemandMemoryPressureError';
const RETRY_DELAYS = [1000, 2000, 5000, 10_000, 30_000, 60_000];

export function nativeDemandMemoryDeferral(result) {
  if (result?.status === 'pending' && result.errorName === MEMORY_ERROR) return result.error;
  const profile = result?.nativeFinanceProfile;
  if (profile?.failed?.length && !profile.unavailable?.length
    && profile.failed.every(failure => failure.errorName === MEMORY_ERROR)) return profile.failed[0].error;
  return null;
}

function ready(result) {
  return result != null && !['pending', 'error', 'cancelled'].includes(result.status)
    && !['pending', 'error', 'cancelled'].includes(result.nativeFinanceProfile?.status)
    && !result.nativeFinanceProfile?.failed?.length && !result.nativeFinanceProfile?.unavailable?.length;
}

// Own only startup settlement: at most one attempt and one compact retry timer.
// The native routing admission budget and persistent checkpoint guards stay at
// their existing seams. Completed staged finance profiles survive each retry.
export function createStartupDemandSettlement({ run, isCurrent, schedule, admit = () => {},
  onReady = () => {}, onChange = () => {}, onError = () => {},
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = timer => globalThis.clearTimeout(timer), now = () => Date.now() }) {
  let timer = null, finished = false, attempts = 0, resolve;
  let state = { version: STARTUP_DEMAND_SETTLEMENT_VERSION, status: 'queued', attempts: 0, nextRetryAt: null, error: null };
  const promise = new Promise(done => { resolve = done; });
  const notify = update => { state = { ...state, ...update, attempts }; onChange({ ...state }); };
  const finish = result => { finished = true; resolve(result); };
  function cancel() {
    if (finished) return;
    if (timer != null) clearTimer(timer);
    timer = null;
    notify({ status: 'cancelled', nextRetryAt: null });
    finish(null);
  }
  const current = () => !finished && isCurrent();
  function wait(error) {
    const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)];
    notify({ status: 'waiting-for-memory', nextRetryAt: now() + delay, error });
    timer = setTimer(() => {
      timer = null;
      if (!current()) { cancel(); return; }
      schedule(() => { void attempt(); });
    }, delay);
  }
  async function attempt() {
    if (!current()) { cancel(); return; }
    attempts++;
    notify({ status: 'preparing', nextRetryAt: null, error: null });
    try {
      // Recheck before rebuilding profiles after a deferral; do not churn the
      // national network while the same allocation budget is still exhausted.
      if (attempts > 1) await admit();
      if (!current()) { cancel(); return; }
      const result = await run();
      if (!current()) { cancel(); return; }
      const deferred = nativeDemandMemoryDeferral(result);
      if (deferred) { wait(deferred); return; }
      if (!ready(result)) {
        notify({ status: 'failed', error: result?.error ?? result?.nativeFinanceProfile?.failed?.[0]?.error
          ?? 'Startup demand settlement is incomplete.' });
        finish(result); return;
      }
      await onReady(result);
      if (!current()) { cancel(); return; }
      notify({ status: 'ready', error: null });
      finish(result);
    } catch (error) {
      if (!current()) { cancel(); return; }
      if (error?.name === MEMORY_ERROR) { wait(error.message); return; }
      notify({ status: 'failed', error: error?.message ?? String(error) });
      onError(error);
      finish(null);
    }
  }
  notify({});
  schedule(() => { void attempt(); });
  return { promise, cancel, snapshot: () => ({ ...state }) };
}
