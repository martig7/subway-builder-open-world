export const TILE_SIMULATION_HANDOFF_VERSION = 'tile-simulation-handoff-v1';

// A Tile View change keeps the same player's mode intent, but has two readiness
// boundaries. The map can be used before assignment/finance preparation finishes;
// the clock cannot. This lease owns only compact lifecycle state, never results.
export function createTileSimulationHandoff({ simulation, schedule, now = Date.now, onChange = () => {} }) {
  let active = null;
  let last = null;
  const listeners = new Set();
  const current = token => active === token && !token.cancelled && token.isCurrent();
  const snapshot = () => active ? {
    version: TILE_SIMULATION_HANDOFF_VERSION,
    status: active.status, fromTileId: active.fromTileId, toTileId: active.toTileId,
    transitionId: active.transitionId, requested: active.requested,
    nativeSessionId: active.nativeSessionId,
    sourcePaused: active.sourcePaused,
    startedAt: active.startedAt, mapReadyAt: active.mapReadyAt,
    simulationReadyAt: null, error: active.error,
  } : last;
  const modeSnapshot = () => {
    const value = simulation.snapshot();
    return active ? { ...value, enabled: active.requested,
      status: active.status === 'error' ? 'error' : 'calculating', error: active.error } : value;
  };
  const notify = () => {
    onChange(snapshot());
    for (const listener of listeners) listener(modeSnapshot());
  };
  const hold = token => simulation.setSuspended(true, {
    suppressCommutes: token.requested, isCurrent: () => active === token && token.isCurrent(),
  });
  function matches(transition) {
    return Boolean(active && transition?.tileId === active.toTileId
      && (!active.transitionId || transition.transitionId === active.transitionId)
      && (!active.worldId || transition.worldId === active.worldId)
      && (!transition.from || transition.from === active.fromTileId));
  }
  const accepts = transition => Boolean(active && current(active) && matches(transition));
  async function cancel({ restore = false } = {}) {
    const token = active;
    if (!token) return;
    const mayRestore = restore && current(token) && token.requested;
    token.cancelled = true;
    token.cancelScheduled?.();
    try {
      if (mayRestore) await simulation.setEnabled(true);
      else await simulation.setEnabled(false);
    } finally {
      if (active === token) {
        last = { ...snapshot(), status: 'cancelled' };
        active = null;
        simulation.setSuspended(false);
        notify();
      }
    }
  }
  async function begin({ fromTileId, toTileId, nativeSessionId, sourcePaused, isCurrent }) {
    if (active) throw new Error('The previous Tile View is still preparing simulation.');
    const token = { fromTileId, toTileId, nativeSessionId, sourcePaused, isCurrent, requested: simulation.snapshot().enabled,
      transitionId: null, startedAt: now(), mapReadyAt: null, error: null, status: 'staging', job: null };
    active = token;
    hold(token);
    notify();
    try {
      // Rebasing cached time and draining observed native work precede snapshot
      // capture; the suspension is already installed while either await runs.
      await simulation.setEnabled(false);
      await simulation.drainNativeWork();
      if (!current(token)) return false;
      return true;
    } catch (error) {
      await cancel({ restore: true });
      throw error;
    }
  }
  function bind(transition) {
    if (!active) return;
    active.transitionId = transition?.transitionId ?? null;
    active.worldId = transition?.worldId ?? null;
    notify();
  }
  function prepare() {
    const token = active;
    if (!token || !token.prepareFinance || !current(token)) return Promise.resolve(null);
    if (token.job) return token.job;
    token.status = 'queued'; token.error = null;
    notify();
    const job = new Promise(resolve => {
      token.cancelScheduled = () => resolve(null);
      schedule(() => {
        token.cancelScheduled = null;
        if (!current(token)) { resolve(null); return; }
        void (async () => {
          token.status = 'preparing'; notify();
          try {
            if (token.requested) {
              const prepared = await simulation.setEnabled(true);
              if (!current(token)) return null;
              if (token.requested && prepared.status !== 'ready') {
                throw new Error(prepared.error || 'Destination assignments are not ready.');
              }
            }
            const finance = await token.prepareFinance();
            if (!current(token)) return null;
            if (!finance || finance.nativeFinanceProfile?.status === 'pending'
              || finance.nativeFinanceProfile?.failed?.length || finance.nativeFinanceProfile?.unavailable?.length
              || ['pending', 'error', 'cancelled'].includes(finance.status)) {
              throw new Error('Destination finance preparation is incomplete.');
            }
            // A player may request the mode while normal finance preparation is
            // running. The disk preparation just completed, so this loads its
            // assignments without another routing calculation.
            if (token.requested && simulation.snapshot().status !== 'ready') {
              const prepared = await simulation.setEnabled(true);
              if (!current(token)) return null;
              if (prepared.status !== 'ready') throw new Error(prepared.error || 'Destination assignments are not ready.');
            }
            last = { ...snapshot(), status: 'ready', simulationReadyAt: now() };
            active = null;
            simulation.setSuspended(false);
            notify();
            return last;
          } catch (error) {
            if (current(token)) {
              token.status = 'error';
              token.error = `${error?.message ?? error} Toggle Ultra-high-speed mode to retry.`;
              notify();
            }
            return null;
          }
        })().then(resolve, () => resolve(null));
      });
    });
    token.job = job;
    void job.then(() => { if (token.job === job) token.job = null; });
    return job;
  }
  function mapReady({ transition, isCurrent, prepareFinance }) {
    if (!accepts(transition)) return null;
    active.isCurrent = isCurrent;
    if (!current(active)) { void cancel(); return null; }
    active.mapReadyAt = now();
    active.prepareFinance = prepareFinance;
    active.retryMap = null;
    hold(active);
    return prepare();
  }
  function fail(error, retryMap) {
    if (!active || !current(active)) return;
    active.status = 'error';
    active.error = `${error?.message ?? error} Toggle Ultra-high-speed mode to retry.`;
    active.retryMap = retryMap;
    notify();
  }
  function retry() {
    const token = active;
    if (!token || !current(token)) return Promise.resolve(null);
    if (token.prepareFinance || !token.retryMap) return prepare();
    if (token.restoring) return token.restoring;
    token.status = 'restoring'; token.error = null; notify();
    const job = Promise.resolve().then(() => current(token) ? token.retryMap() : null)
      .then(() => token.job ?? null).catch(error => { fail(error, token.retryMap); return null; });
    token.restoring = job;
    void job.then(() => { if (token.restoring === job) token.restoring = null; });
    return job;
  }
  const mode = {
    snapshot: modeSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      const unsubscribe = simulation.subscribe(() => listener(modeSnapshot()));
      return () => { listeners.delete(listener); unsubscribe?.(); };
    },
    async setEnabled(value) {
      const token = active;
      if (!token) return simulation.setEnabled(value);
      token.requested = Boolean(value);
      hold(token); notify();
      if (!value) await simulation.setEnabled(false);
      if (current(token)) await retry();
      return modeSnapshot();
    },
  };
  return { begin, bind, accepts, matches, mapReady, fail, cancel, retry, snapshot, mode,
    isPending: () => Boolean(active), requested: () => Boolean(active?.requested) };
}
