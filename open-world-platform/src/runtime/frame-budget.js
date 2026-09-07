// Native scheduler continuations avoid the nested-timer delay in Chromium.
export const yieldBrowserTask = () => typeof globalThis.scheduler?.yield === 'function'
  ? globalThis.scheduler.yield() : new Promise(resolve => setTimeout(resolve, 0));

/** Checkpoints separate existing synchronous stages without splitting commits. */
export function createFrameBudget({ budgetMs = 4, now = () => performance.now(), yieldTask = yieldBrowserTask } = {}) {
  let started = now();
  return async () => {
    if (now() - started < budgetMs) return;
    await yieldTask(); started = now();
  };
}

/** Generators yield between units of preparation, never during ledger commit. */
export async function runFrameBudgeted(steps, { budgetMs = 4, now = () => performance.now(),
  yieldTask = yieldBrowserTask, cancelled = () => false, onSlice = () => {} } = {}) {
  let started = now();
  try {
    for (;;) {
      if (cancelled()) return null;
      const next = steps.next();
      const elapsed = now() - started;
      if (next.done) { onSlice(elapsed); return next.value; }
      if (elapsed >= budgetMs) {
        onSlice(elapsed); await yieldTask(); started = now();
      }
    }
  } finally { steps.return?.(); }
}
