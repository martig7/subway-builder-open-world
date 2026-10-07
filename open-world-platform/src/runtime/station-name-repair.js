import { yieldBrowserTask } from './frame-budget.js';

export const STATION_NAME_REPAIR_VERSION = 'native-station-name-repair-v1';

export function isBlankStationName(name) {
  return name == null || (typeof name === 'string' && ['', 'Station'].includes(name.trim()));
}

/** Manual work only: no station scans, road loads, or timers until run(). */
export function createStationNameRepair({ game, isReady = () => true, getContextKey = () => null,
  now = () => performance.now(), yieldTask = yieldBrowserTask, budgetMs = 8, batchSize = 8 } = {}) {
  let state = { version: STATION_NAME_REPAIR_VERSION, status: 'idle', total: 0, processed: 0,
    renamed: 0, unresolved: 0, skipped: 0, failed: 0, error: null, elapsedMs: 0 };
  let active = null;
  let disposed = false;
  const listeners = new Set();
  const snapshot = () => ({ ...state, available: !disposed && isReady() });
  function publish(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(snapshot());
  }
  async function work() {
    const started = now();
    const contextKey = getContextKey();
    try {
      // Paint the disabled button before the first native rename/group rebuild.
      await yieldTask();
      if (disposed || !isReady() || getContextKey() !== contextKey) {
        publish({ status: 'cancelled' });
        return snapshot();
      }
      const session = game.beginStationNameRepair();
      publish({ total: session.stationIds.length });
      let sliceStarted = now();
      let inBatch = 0;
      for (const id of session.stationIds) {
        if (disposed || !isReady() || getContextKey() !== contextKey || !session.isCurrent()) {
          publish({ status: 'cancelled' });
          return snapshot();
        }
        try {
          const result = session.refresh(id);
          state = { ...state, [result]: state[result] + 1, processed: state.processed + 1 };
        } catch (error) {
          state = { ...state, failed: state.failed + 1, processed: state.processed + 1,
            error: state.error ?? String(error.message ?? error) };
        }
        if (++inBatch >= batchSize || now() - sliceStarted >= budgetMs) {
          publish({ elapsedMs: now() - started });
          await yieldTask();
          sliceStarted = now();
          inBatch = 0;
        }
      }
      publish({ status: 'completed', elapsedMs: now() - started });
    } catch (error) {
      publish({ status: 'failed', error: String(error.message ?? error), elapsedMs: now() - started });
    }
    return snapshot();
  }
  return {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    run() {
      if (active) return active;
      if (disposed || !isReady()) return Promise.resolve(snapshot());
      publish({ status: 'running', total: 0, processed: 0, renamed: 0, unresolved: 0,
        skipped: 0, failed: 0, error: null, elapsedMs: 0 });
      active = work().finally(() => { active = null; });
      return active;
    },
    dispose() { disposed = true; listeners.clear(); },
  };
}

export function stationNameRepairText(state) {
  if (state?.status === 'running') return `Naming stations… ${state.processed} of ${state.total}`;
  if (state?.status === 'failed') return state.error;
  if (!state || state.status === 'idle') return 'Uses the game’s automatic station naming setting. Existing names are kept.';
  const parts = [`${state.renamed} named`, `${state.unresolved} still unnamed`];
  if (state.failed) parts.push(`${state.failed} failed: ${state.error}`);
  if (state.status === 'cancelled') parts.push('Stopped because the tile or network changed. Run again when loading finishes.');
  return parts.join(' · ');
}
