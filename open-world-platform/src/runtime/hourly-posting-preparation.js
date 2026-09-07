import { cachedSimulationPostingSteps } from './cached-simulation-posting.js';
import { runFrameBudgeted } from './frame-budget.js';

/** One disposable look-ahead posting. Only take() can hand it to accounting. */
export function createHourlyPostingPreparation({ workerSource, createWorker, prepareNative = async () => {},
  timeoutMs = 3000, budget = {} } = {}) {
  let worker = null, url = null, input = null, revision = 0, request = 0, job = null, disposed = false;
  const stats = { workerRequests: 0, prepared: 0, hits: 0, misses: 0, fallbacks: 0, slices: 0, maxSliceMs: 0 };
  const cancelJob = () => { job?.release?.(null); job = null; };
  const releaseWorker = () => { worker?.terminate?.(); worker = null; if (url) URL.revokeObjectURL(url); url = null; };
  const ensureWorker = () => {
    if (worker) return worker;
    try {
      if (createWorker) worker = createWorker();
      else if (workerSource && typeof Worker === 'function') {
        url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })); worker = new Worker(url);
      }
      if (!worker) return null;
      const attached = worker;
      worker.onmessage = ({ data }) => {
        if (worker === attached && data?.id === job?.id && data?.revision === job?.revision) job?.release?.(data.error ? null : data.posting);
      };
      worker.onerror = () => { if (worker === attached) { job?.release?.(null); releaseWorker(); } };
      worker.postMessage({ type: 'profile', revision, input });
      return worker;
    } catch { releaseWorker(); return null; }
  };
  return {
    setProfile(value) { cancelJob(); input = value; revision++; releaseWorker(); },
    invalidate() { cancelJob(); input = null; revision++; releaseWorker(); },
    prepare(from, to) {
      if (disposed || !input || !(to > from)) return Promise.resolve(null);
      if (job?.from === from && job.to === to) return job.promise;
      cancelJob();
      const current = { id: ++request, revision, from, to, posting: null, promise: null };
      job = current;
      const captured = input;
      const cancelled = () => disposed || job !== current || revision !== current.revision;
      const sliceBudget = { ...budget, cancelled,
        onSlice(ms) { stats.slices++; stats.maxSliceMs = Math.max(stats.maxSliceMs, ms); } };
      current.promise = (async () => {
        let posting = null;
        const candidate = ensureWorker();
        if (candidate) {
          stats.workerRequests++;
          posting = await new Promise(resolve => {
            const timer = setTimeout(() => { current.release(null); releaseWorker(); }, timeoutMs);
            current.release = value => { clearTimeout(timer); resolve(value); };
            try { candidate.postMessage({ type: 'prepare', id: current.id, revision, from, to }); }
            catch { current.release(null); releaseWorker(); }
          });
        }
        if (cancelled()) return null;
        if (!posting) {
          stats.fallbacks++;
          posting = await runFrameBudgeted(cachedSimulationPostingSteps({ ...captured, from, to }), sliceBudget);
        }
        if (cancelled() || !posting) return null;
        posting.retainCommutesSince = to - 86400;
        await prepareNative(posting, sliceBudget);
        if (cancelled()) return null;
        current.posting = posting; stats.prepared++;
        return posting;
      })().catch(() => null); // Failed speculation always leaves the synchronous path available.
      return current.promise;
    },
    take(from, to) {
      if (job?.from === from && job.to === to && job.posting) { stats.hits++; return job.posting; }
      stats.misses++; return null;
    },
    snapshot() { return { ...stats, pending: Boolean(job && !job.posting) }; },
    dispose() { disposed = true; this.invalidate(); },
  };
}
