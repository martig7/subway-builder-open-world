import { cachedSimulationPosting } from './cached-simulation-posting.js';
export { cachedSimulationPosting } from './cached-simulation-posting.js';
import { createOffMainThreadNativeDemandEvaluator } from './embedded-tile-package-adapter.js';
import { evaluateOffTileNativeDemand } from './off-tile-native-demand.js';
import { createBoundedCrossTileRoutingCache } from './cross-tile-mode-choice.js';
import { createHourlyPostingPreparation } from './hourly-posting-preparation.js';
import { shareNativeSaveReferences, NATIVE_SAVE_REFERENCE_SHARING_VERSION } from './native-save-reference-sharing.js';

export const CACHED_SIMULATION_VERSION = 'open-world-cached-simulation-v17';
const OWNER = Symbol.for('open-world.cached-simulation');
const NATIVE_ACTIONS = ['handleIncrementGameState', 'simulateCommutes', 'calculatePaths'];
const modes = () => ({ walking: 0, driving: 0, transit: 0, unknown: 0 });
const values = collection => collection instanceof Map ? [...collection.values()] : Array.isArray(collection) ? collection : [];

export function rebaseCachedTrain(train, delta, elapsedSeconds, billingDelta = delta) {
  // Paused saves advance no clock. Returning the identical object avoids
  // cloning every timing array per save and preserves reference identity for
  // the outgoing sharing pass. Only exact zero is safe: NaN deltas still
  // change arithmetic downstream.
  if (delta === 0 && billingDelta === 0) return train;
  const shift = value => Number.isFinite(value) ? value + delta : value;
  return { ...train,
    ...(train.timings ? { timings: train.timings.map(timing => ({ ...timing,
      ...Object.fromEntries(['arrivalTime', 'departureTime', 'expectedArrivalTime', 'expectedDepartureTime',
        'adjustedExpectedArrivalTime', 'adjustedExpectedDepartureTime'].filter(key => key in timing).map(key => [key, shift(timing[key])])),
      ...Object.fromEntries(['futureCycleArrivalTimes', 'futureCycleDepartureTimes'].filter(key => Array.isArray(timing[key])).map(key => [key, timing[key].map(shift)])),
    })) } : {}),
    ...(train.currentStComboInfo ? { currentStComboInfo: { ...train.currentStComboInfo,
      timeAtStop: shift(train.currentStComboInfo.timeAtStop), timeAtStopEnd: shift(train.currentStComboInfo.timeAtStopEnd) } } : {}),
    ...(train.stuckDetection ? { stuckDetection: { ...train.stuckDetection, lastMovementTime: shift(train.stuckDetection.lastMovementTime) } } : {}),
    ...(train.operationalTime ? { operationalTime: { ...train.operationalTime,
      lastChargedAt: Number.isFinite(train.operationalTime.lastChargedAt)
        ? train.operationalTime.lastChargedAt + billingDelta : train.operationalTime.lastChargedAt } } : {}),
  };
}

export function publishCachedDemand(state, assignments) {
  const byId = new Map(assignments.map(pop => [String(pop.id), pop]));
  const popsMap = new Map();
  const points = new Map(values(state.demandData.points).map(point => [point.id, {
    ...point, residentModeShare: modes(), workerModeShare: modes(),
  }]));
  for (const [id, pop] of state.demandData.popsMap) {
    const assigned = byId.get(String(id));
    const next = assigned ? { ...pop, ...assigned,
      lastCommute: { ...assigned.commutes.homeToWork, direction: 'homeToWork', origin: 'home' },
    } : pop;
    popsMap.set(id, next);
    for (const [pointId, field, direction] of [
      [pop.residenceId, 'residentModeShare', 'homeToWork'], [pop.jobId, 'workerModeShare', 'workToHome'],
    ]) {
      const point = points.get(pointId);
      if (point) for (const mode of Object.keys(point[field])) {
        point[field][mode] += Number(next.commutes?.[direction]?.modeChoice?.[mode]) || 0;
      }
    }
  }
  state.setDemandData({ ...state.demandData, popsMap, points });
}

/** Own the native tick only while enabled. Caches are disposable session data. */
export function createCachedSimulation({ game, api, getState, isReady = () => true,
  onHour = async () => {}, onDay = async () => {}, workerSource = null,
  postingWorkerSource = null, evaluate = null, prepareActiveDemand = null, onSavePhase = null } = {}) {
  const worker = createOffMainThreadNativeDemandEvaluator({ workerSource });
  const routingCache = createBoundedCrossTileRoutingCache();
  const listeners = new Set(), wrappers = new Map(), frozenTrains = new Map();
  // Track whole native actions, including async network preparation before a
  // worker exists and state publication after its response. Reuse this set on
  // hot reload so replacing wrappers cannot hide work already in flight.
  const nativeWork = NATIVE_ACTIONS.map(name => getState()[name]?.[OWNER]?.nativeWork)
    .find(value => value instanceof Set) ?? new Set();
  const invokeNative = (original, receiver, args) => {
    const result = original.apply(receiver, args);
    if (typeof result?.then === 'function') {
      nativeWork.add(result);
      Promise.resolve(result).then(() => nativeWork.delete(result), () => nativeWork.delete(result));
    }
    return result;
  };
  let enabled = false, disposed = false, busy = null, refreshPromise = null, stopping = null;
  let suspension = null;
  const isSuspended = () => {
    if (disposed || !suspension) return false;
    try { return suspension.isCurrent(); } catch { return false; }
  };
  let modeRequest = 0;
  let revision = 0, cache = null, dependencies = null, settledAt = null, startedAt = null;
  let cacheContext = null, pendingMidnightRefresh = false;
  let sessionId = null, status = 'off', error = null;
  const counters = { calculations: 0, ticks: 0, suppressedCommutes: 0, suppressedPathSearches: 0, milliseconds: 0 };
  const savePhase = (stage, started) => {
    try { onSavePhase?.(stage, { durationMs: performance.now() - started }); } catch {
      // Diagnostics never change the native save result or error.
    }
  };
  const preparation = createHourlyPostingPreparation({ workerSource: postingWorkerSource,
    prepareNative: (posting, budget) => game.prepareBackgroundNativeFinance?.(posting, { includeFinancialHistory: false }, budget) });
  const snapshot = () => ({ version: CACHED_SIMULATION_VERSION, enabled, status, error,
    suspended: isSuspended(),
    pendingMidnightRefresh,
    saveWork: { observed: !disposed && NATIVE_ACTIONS.every(name => getState()[name]?.[OWNER]?.controller === controller),
      native: nativeWork.size, cached: Boolean(busy || refreshPromise || stopping || isSuspended()) },
    saveReferenceSharing: NATIVE_SAVE_REFERENCE_SHARING_VERSION,
    ...counters, preparation: { ...preparation.snapshot(), native: game.nativeFinancePreparationStats },
    assignedPops: cache?.assignedPops ?? 0, dailyRevenue: cache?.profile.dailyRevenue ?? 0,
    dailyRidership: cache?.profile.hourly.reduce((sum, hour) => sum + (hour.completedCommutes ?? []).reduce((n, c) => n + c.size, 0), 0) ?? 0 });
  const notify = () => { for (const listener of listeners) listener(snapshot()); };
  const dependencyList = state => [state.gameSessionId, state.cityCode, state.routes, state.stations, state.tracks,
    state.trackGroups, state.trains, state.gradeCrossings, state.fareGroups, state.transitCost, state.demandData?.popsMap,
    JSON.stringify(api.utils?.getPathfindingRules?.()), state.ownedTrainCount, state.demandData?.points];
  const contextOf = state => [state.gameSessionId, state.cityCode, state.demandData?.popsMap, state.demandData?.points];
  const canReuseAssignments = state => {
    const next = contextOf(state);
    return cache != null && cacheContext?.every((value, i) => value === next[i]);
  };
  const unchanged = state => { const next = dependencyList(state); return dependencies?.every((value, i) => value === next[i]); };
  // Route regeneration replaces train objects while retaining their billing
  // cursor. Object replacement must not make already estimated time unpaid.
  const billingStart = (train, elapsed) => {
    const frozen = frozenTrains.get(train.id);
    return frozen && frozen.chargedAt === train.operationalTime?.lastChargedAt ? frozen.billingAt : elapsed;
  };
  const rebaseFrozenTrain = (train, elapsed) => rebaseCachedTrain(train,
    elapsed - (frozenTrains.get(train.id)?.at ?? elapsed), elapsed,
    elapsed - billingStart(train, elapsed));
  const observeFrozenTrains = state => {
    for (const train of state.trains ?? []) {
      const frozen = frozenTrains.get(train.id);
      if (frozen?.train !== train || frozen.chargedAt !== train.operationalTime?.lastChargedAt) {
        frozenTrains.set(train.id, { train, at: state.timeConfig.elapsedSeconds,
          chargedAt: train.operationalTime?.lastChargedAt, billingAt: billingStart(train, state.timeConfig.elapsedSeconds) });
      }
    }
  };
  const clearMovements = state => {
    state.setPopMovementsMap?.(new Map());
    state.setAllStationTrainPopMovements?.({ stations: new Map(), trains: new Map() });
    state.setPopMovementGeojson?.({ type: 'FeatureCollection', features: [] });
  };
  const tickStep = state => {
    const speed = state.timeConfig.timeSpeed, rules = api.utils?.getConstants?.() ?? {};
    const count = rules.TICKS_PER_UPDATE?.[speed]?.gameState ?? ({ fast: 16, ultrafast: 48 }[speed] ?? 1);
    return 0.5 * Math.min(1000, Math.max(1, Math.floor(count))) * (speed === 'ultrafast' ? 10 : 1);
  };
  const prefetch = () => {
    if (!enabled || disposed || !cache || settledAt == null) return;
    const state = getState(), from = state.timeConfig.elapsedSeconds, step = tickStep(state);
    if (sessionId !== state.gameSessionId) return;
    const boundary = (Math.floor(from / 3600) + 1) * 3600;
    void preparation.prepare(settledAt, Math.min(from + Math.ceil((boundary - from) / step) * step,
      (Math.floor(from / 86400) + 1) * 86400));
  };
  const flush = () => {
    const state = getState(), to = state.timeConfig.elapsedSeconds;
    if (!cache || sessionId !== state.gameSessionId || settledAt == null || to <= settledAt) return;
    const posting = preparation.take(settledAt, to) ?? cachedSimulationPosting({ ...cache, from: settledAt, to, sessionId });
    posting.retainCommutesSince = to - 86400;
    const posted = game.postBackgroundNativeFinanceNow(posting, { includeFinancialHistory: false });
    settledAt = to;
    // Native population simulation normally prunes these records. Retain one day.
    const latest = getState();
    if (posted.applied !== false) latest.totalLifetimeRidership = (latest.totalLifetimeRidership ?? 0)
      + posting.completedCommutes.reduce((sum, commute) => sum + commute.size, 0);
  };
  const updateExpenses = state => {
    flush(); observeFrozenTrains(state);
    cache.expenses = game.calculateNativeFinanceProfile(state.cityCode, state, { includeRevenue: false }).expenseProfile;
    dependencies = dependencyList(getState());
    preparation.setProfile({ profile: cache.profile, expenses: cache.expenses, sessionId });
    prefetch();
  };
  const refresh = async () => {
    if (refreshPromise) return refreshPromise;
    const run = async () => {
      const state = getState(), token = revision;
      if (!isReady() || !state.demandData?.popsMap) throw new Error('Wait for the World to finish loading.');
      await flush();
      observeFrozenTrains(state);
      status = 'calculating'; notify();
      const initial = contextOf(state), begin = performance.now();
      const demand = prepareActiveDemand ? null : { points: values(state.demandData.points), pops: values(state.demandData.popsMap)
        .map(({ id, size, residenceId, jobId, drivingSeconds, drivingDistance, homeDepartureTime, workDepartureTime }) =>
          ({ id, size, residenceId, jobId, drivingSeconds, drivingDistance, homeDepartureTime, workDepartureTime })) };
      const input = { worldId: state.gameSessionId, tileId: state.cityCode, includeAssignments: true,
        networkProfile: game.captureCrossTileNetworkProfile(state.cityCode),
        farePolicy: { fare: state.transitCost, fareGroups: state.fareGroups }, globalNativeState: state };
      let result;
      try {
        result = prepareActiveDemand ? await prepareActiveDemand({ assignments: true, tileId: state.cityCode })
          : evaluate ? await evaluate({ ...input, demand })
          : await worker.evaluate(new TextEncoder().encode(JSON.stringify(demand)), input)
            ?? evaluateOffTileNativeDemand({ ...input, demand, routingCache });
      } catch (failure) {
        const current = contextOf(getState());
        if (disposed || !enabled || revision !== token || initial.some((value, i) => value !== current[i])) return false;
        throw failure;
      }
      const live = getState();
      // Shared service/fare notifications advance revision. Cosmetic/reference
      // replacements neither invalidate a journey nor queue another midnight.
      const current = contextOf(live);
      if (disposed || !enabled || revision !== token || initial.some((value, i) => value !== current[i])) return false;
      if (result.assignments?.length !== state.demandData.popsMap.size) throw new Error('Incomplete cached demand calculation.');
      observeFrozenTrains(live);
      publishCachedDemand(live, result.assignments);
      cache = { profile: result.profile, assignedPops: result.assignments.length,
        expenses: game.calculateNativeFinanceProfile(state.cityCode, live,
        { includeRevenue: false }).expenseProfile };
      cache.pathsByCoordinates = new Map();
      for (const assigned of result.assignments) for (const commute of Object.values(assigned.commutes)) {
        const path = commute.transitPaths?.[0];
        if (path) cache.pathsByCoordinates.set(JSON.stringify([path.segments[0].fromStopCoords, path.segments.at(-1).toStopCoords]), commute.transitPaths);
      }
      clearMovements(getState());
      dependencies = dependencyList(getState());
      cacheContext = contextOf(getState()); pendingMidnightRefresh = false;
      sessionId = state.gameSessionId;
      settledAt = getState().timeConfig.elapsedSeconds;
      preparation.setProfile({ profile: cache.profile, expenses: cache.expenses, sessionId });
      prefetch();
      counters.calculations++; counters.milliseconds = performance.now() - begin;
      status = 'ready'; error = null; notify();
      return true;
    };
    refreshPromise = run().finally(() => { refreshPromise = null; });
    return refreshPromise;
  };
  const fail = failure => {
    error = String(failure?.message ?? failure); status = 'error';
    if (!isSuspended()) getState().setTimeConfig({ paused: true });
    notify();
  };
  const prepareEnabled = async request => {
    const target = getState();
    const targetSession = target.gameSessionId, targetTile = target.cityCode;
    // A map-ready player can edit service during the first destination job.
    // Invalidation coalesces another refresh; join that work before reporting
    // enabled readiness, while never following it into another save or tile.
    while (enabled && !disposed && request === modeRequest) {
      if (await refresh()) return;
      const state = getState();
      if (!isReady() || state.gameSessionId !== targetSession || state.cityCode !== targetTile) return;
    }
  };
  const tick = async () => {
    if (!enabled || disposed || isSuspended() || !isReady() || getState().timeConfig.paused) return;
    if (busy) return busy;
    busy = (async () => {
      if (!unchanged(getState())) {
        // Raw collection changes update costs and billing anchors only. The
        // shared committed-service/fare handlers alone queue commute refreshes.
        if (canReuseAssignments(getState())) updateExpenses(getState());
        else if (!await refresh()) return;
      }
      const state = getState();
      if (!enabled || disposed || isSuspended() || state.timeConfig.paused) return;
      const from = state.timeConfig.elapsedSeconds;
      const step = tickStep(state);
      // Settle the old rates exactly to midnight before either worker replaces
      // them. The next tick uses the new day's profiles with no overshoot.
      const to = Math.min(from + step, (Math.floor(from / 86400) + 1) * 86400);
      state.setTimeConfig({ elapsedSeconds: to });
      state.processBondInterest?.();
      counters.ticks++;
      // Publish once per game hour. Saving, disabling and recalculating also
      // flush the exact partial interval; clock ticks need no ledger copies.
      if (Math.floor(from / 3600) !== Math.floor(to / 3600)) await flush();
      for (let hour = Math.floor(from / 3600) + 1; hour <= Math.floor(to / 3600); hour++) {
        await onHour(hour % 24, Math.floor(hour / 24) + 1);
        if (hour % 24 === 0) await onDay(Math.floor(hour / 24));
      }
      prefetch();
    })().catch(fail).finally(() => { busy = null; });
    return busy;
  };
  const controller = {
    snapshot,
    preparedNativeProfile(tileId) {
      const state = getState();
      return enabled && !disposed && status === 'ready' && !pendingMidnightRefresh
        && state.cityCode === tileId && canReuseAssignments(state) && unchanged(state)
        ? cache.profile : null;
    },
    // Navigation owns the lease predicate and lifetime. This gate is separate
    // from enabled/readiness so an unfinished destination cannot run a native
    // tick, and cached-mode handoffs need not build native journeys first.
    setSuspended(value, { suppressCommutes = false, isCurrent = () => true } = {}) {
      if (disposed) return snapshot();
      suspension = value ? { suppressCommutes, isCurrent } : null;
      notify();
      return snapshot();
    },
    async drainNativeWork() {
      while (nativeWork.size) await Promise.allSettled([...nativeWork]);
    },
    isTickSuppressionActive() {
      return isSuspended() || stopping != null || (enabled && !disposed && isReady());
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    invalidate() {
      revision++;
      const state = getState();
      if (enabled && !disposed && canReuseAssignments(state)) {
        // Keep routing off the edit/tick path. Expense rates and train billing
        // anchors are cheap to update and must still take effect at edit time.
        pendingMidnightRefresh = true; updateExpenses(state); notify();
        return;
      }
      dependencies = null; preparation.invalidate();
      if (enabled && !disposed && isReady()) {
        void (async () => {
          while (enabled && !disposed && isReady() && !unchanged(getState())) {
            if (await refresh()) break;
          }
        })().catch(fail);
      }
    },
    async refreshAtMidnight(day) {
      if (!enabled || disposed || !isReady()) return { status: 'disabled', day };
      if (!pendingMidnightRefresh && canReuseAssignments(getState())) return { status: 'not-dirty', day };
      try {
        const applied = await refresh();
        if (!applied && enabled && !disposed) {
          pendingMidnightRefresh = true; status = cache ? 'ready' : 'calculating'; notify();
        }
        return { status: applied ? 'refreshed' : 'stale', day };
      } catch (failure) { fail(failure); throw failure; }
    },
    async setEnabled(value) {
      const request = ++modeRequest;
      if (disposed) return;
      if (stopping) { await stopping; if (request !== modeRequest || disposed) return snapshot(); }
      if (Boolean(value) === enabled) {
        // Memory admission may defer a destination. Retrying its enable must
        // finish preparation without toggling/rebasing the same interval twice.
        if (value && status !== 'ready') {
          try { await prepareEnabled(request); } catch (failure) { fail(failure); }
        }
        return snapshot();
      }
      if (value) {
        enabled = true; revision++; status = 'calculating';
        startedAt = getState().timeConfig.elapsedSeconds; sessionId = getState().gameSessionId;
        settledAt = startedAt; cache = null; dependencies = null; cacheContext = null; pendingMidnightRefresh = false;
        frozenTrains.clear(); notify();
        try { await prepareEnabled(request); } catch (failure) { fail(failure); }
      } else {
        enabled = false; revision++;
        stopping = (async () => {
        await busy; await refreshPromise; await flush();
        const state = getState();
        if (state.gameSessionId === sessionId) {
          observeFrozenTrains(state);
          clearMovements(state);
          // Preserve the fleet and its physical positions; move absolute timing
          // anchors forward by the time spent using estimates.
          state.setTrains?.((state.trains ?? []).map(train => rebaseFrozenTrain(train, state.timeConfig.elapsedSeconds)));
          if (Number.isFinite(state.lastInfrastructureChargeTime)) getState().lastInfrastructureChargeTime
            = state.lastInfrastructureChargeTime + state.timeConfig.elapsedSeconds - startedAt;
          getState().setTimeConfig({});
        }
        preparation.invalidate();
        cache = null; dependencies = null; cacheContext = null; pendingMidnightRefresh = false;
        frozenTrains.clear();
        status = 'off'; error = null; notify();
        })();
        try { await stopping; } finally { stopping = null; }
      }
      return snapshot();
    },
    attach() {
      const state = getState();
      for (const name of ['handleIncrementGameState', 'simulateCommutes', 'calculatePaths', 'generateSave']) {
        const current = state[name];
        if (current?.[OWNER]?.controller === controller || typeof current !== 'function') continue;
        const original = current[OWNER]?.original ?? current;
        const wrapper = function (...args) {
          if (stopping && name === 'handleIncrementGameState') return stopping;
          if (disposed) return original.apply(this, args);
          if (isSuspended()) {
            if (name === 'handleIncrementGameState') return Promise.resolve();
            if (suspension.suppressCommutes && name === 'simulateCommutes') {
              counters.suppressedCommutes++; return Promise.resolve();
            }
            if (suspension.suppressCommutes && name === 'calculatePaths') {
              counters.suppressedPathSearches++;
              return Promise.resolve({ paths: [], query: args[0]?.query, searchTime: 0,
                timings: { total: 0 }, cached: true });
            }
          }
          const cachedActive = enabled && isReady();
          if (name === 'generateSave') {
            const started = performance.now();
            savePhase('generate.start', started);
            if (cachedActive) { observeFrozenTrains(getState()); flush(); }
            const rebaseSave = save => {
              if (!cachedActive || !enabled || disposed || !save?.data || getState().gameSessionId !== sessionId) return save;
              const elapsed = save.data.elapsedSeconds;
              // No clock movement since the cached interval started: rebasing
              // would only clone the fleet. Skip it so paused saves keep
              // identical train references for the sharing pass.
              if (Number.isFinite(elapsed) && elapsed === startedAt) return save;
              return { ...save, data: { ...save.data,
                ...(Number.isFinite(save.data.lastInfrastructureChargeTime) ? {
                  lastInfrastructureChargeTime: save.data.lastInfrastructureChargeTime + elapsed - startedAt,
                } : {}),
                trains: (save.data.trains ?? []).map(train => rebaseFrozenTrain(train, elapsed)),
              } };
            };
            let save;
            try { save = original.apply(this, args); }
            catch (error) { savePhase('generate.error', started); throw error; }
            if (cachedActive) prefetch();
            // Sharing repeated route lists reduces Electron's synchronous data
            // handoff in native mode too, without changing serialized save values.
            const prepareSave = value => {
              savePhase('generate.end', started);
              if (args[0]?.[Symbol.for('open-world.stream-native-save')]) return rebaseSave(value);
              const sharingStarted = performance.now();
              const result = shareNativeSaveReferences(rebaseSave(value));
              savePhase('sharing.end', sharingStarted);
              return result;
            };
            return typeof save?.then === 'function' ? save.then(prepareSave, error => {
              savePhase('generate.error', started); throw error;
            }) : prepareSave(save);
          }
          if (!cachedActive) return invokeNative(original, this, args);
          if (name === 'handleIncrementGameState') return tick();
          if (name === 'simulateCommutes') { counters.suppressedCommutes++; return Promise.resolve(); }
          counters.suppressedPathSearches++;
          const query = args[0]?.query;
          return Promise.resolve({ paths: cache?.pathsByCoordinates.get(JSON.stringify([query?.origin?.coords, query?.destination?.coords])) ?? [],
            query, searchTime: 0, timings: { total: 0 }, cached: true });
        };
        Object.defineProperty(wrapper, OWNER, { value: { version: CACHED_SIMULATION_VERSION, original, controller, nativeWork } });
        state[name] = wrapper; wrappers.set(name, { original, wrapper });
      }
      state.setTimeConfig?.({});
    },
    async dispose() {
      await controller.setEnabled(false);
      disposed = true; suspension = null; revision++;
      const state = getState();
      for (const [name, { original, wrapper }] of wrappers) if (state[name] === wrapper) state[name] = original;
      preparation.dispose(); worker.dispose(); routingCache.clear(); listeners.clear(); state.setTimeConfig?.({});
    },
  };
  controller.attach();
  return controller;
}
