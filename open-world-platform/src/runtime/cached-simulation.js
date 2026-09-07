import { createOffMainThreadNativeDemandEvaluator } from './embedded-tile-package-adapter.js';
import { evaluateOffTileNativeDemand } from './off-tile-native-demand.js';
import { createCrossTileRoutingCache } from './cross-tile-mode-choice.js';

export const CACHED_SIMULATION_VERSION = 'open-world-cached-simulation-v2';
const OWNER = Symbol.for('open-world.cached-simulation');
const modes = () => ({ walking: 0, driving: 0, transit: 0, unknown: 0 });
const values = collection => collection instanceof Map ? [...collection.values()] : Array.isArray(collection) ? collection : [];

export function rebaseCachedTrain(train, delta, elapsedSeconds) {
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
    ...(train.operationalTime ? { operationalTime: { ...train.operationalTime, lastChargedAt: shift(train.operationalTime.lastChargedAt) } } : {}),
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

/** Integrate cached hourly rates over exactly the interval owned by this mode. */
export function cachedSimulationPosting({ profile, expenses, from, to, sessionId }) {
  const result = { revenue: 0, expenseCategories: {}, revenueByRoute: {}, expensesByRoute: {},
    completedCommutes: [], hourlyPostings: [], targetElapsedSeconds: to,
    postingId: `cached-simulation:${sessionId}:${from}:${to}` };
  const add = (target, source, scale) => {
    for (const [id, amount] of Object.entries(source ?? {})) target[id] = (target[id] ?? 0) + amount * scale;
  };
  for (let start = from; start < to;) {
    const hour = Math.floor(start / 3600), end = Math.min(to, (hour + 1) * 3600);
    const fraction = (end - start) / 3600, value = profile.hourly[hour % 24];
    const row = { hour, revenue: (value?.revenue ?? 0) * fraction,
      revenueByRoute: {}, expensesByRoute: {}, expenseCategories: {} };
    add(row.revenueByRoute, value?.revenueByRoute, fraction);
    for (const [id, rates] of Object.entries(expenses?.routeHourly ?? {})) {
      row.expensesByRoute[id] = (rates[hour % 24] ?? 0) * fraction;
    }
    row.expenseCategories.trainOperational = Object.values(row.expensesByRoute).reduce((a, b) => a + b, 0);
    for (const item of expenses?.infrastructureItems ?? []) {
      row.expenseCategories[item.category] = (row.expenseCategories[item.category] ?? 0) + item.hourlyCost * fraction;
    }
    row.expenses = Object.values(row.expenseCategories).reduce((a, b) => a + b, 0);
    result.hourlyPostings.push(row);
    result.revenue += row.revenue;
    add(result.revenueByRoute, row.revenueByRoute, 1);
    add(result.expensesByRoute, row.expensesByRoute, 1);
    add(result.expenseCategories, row.expenseCategories, 1);
    for (const commute of value?.completedCommutes ?? []) {
      result.completedCommutes.push({ ...commute, size: commute.size * fraction,
        popId: `cached-native:${sessionId}:${commute.popId}:${commute.origin}:${start}:${end}`,
        journeyStart: start, journeyEnd: end,
      });
    }
    start = end;
  }
  return result;
}

/** Own the native tick only while enabled. Caches are disposable session data. */
export function createCachedSimulation({ game, api, getState, isReady = () => true,
  onHour = async () => {}, onDay = async () => {}, workerSource = null,
  evaluate = null } = {}) {
  const worker = createOffMainThreadNativeDemandEvaluator({ workerSource });
  const routingCache = createCrossTileRoutingCache();
  const listeners = new Set(), wrappers = new Map(), frozenTrains = new Map();
  let enabled = false, disposed = false, busy = null, refreshPromise = null, stopping = null;
  let modeRequest = 0;
  let revision = 0, cache = null, dependencies = null, settledAt = null, startedAt = null;
  let sessionId = null, status = 'off', error = null;
  const counters = { calculations: 0, ticks: 0, suppressedCommutes: 0, suppressedPathSearches: 0, milliseconds: 0 };
  const snapshot = () => ({ version: CACHED_SIMULATION_VERSION, enabled, status, error,
    ...counters, assignedPops: cache?.assignments.length ?? 0, dailyRevenue: cache?.profile.dailyRevenue ?? 0,
    dailyRidership: cache?.profile.hourly.reduce((sum, hour) => sum + (hour.completedCommutes ?? []).reduce((n, c) => n + c.size, 0), 0) ?? 0 });
  const notify = () => { for (const listener of listeners) listener(snapshot()); };
  const dependencyList = state => [state.gameSessionId, state.cityCode, state.routes, state.stations, state.tracks,
    state.trackGroups, state.trains, state.gradeCrossings, state.fareGroups, state.transitCost, state.demandData?.popsMap,
    JSON.stringify(api.utils?.getPathfindingRules?.()), state.ownedTrainCount];
  const unchanged = state => { const next = dependencyList(state); return dependencies?.every((value, i) => value === next[i]); };
  const clearMovements = state => {
    state.setPopMovementsMap?.(new Map());
    state.setAllStationTrainPopMovements?.({ stations: new Map(), trains: new Map() });
    state.setPopMovementGeojson?.({ type: 'FeatureCollection', features: [] });
  };
  const flush = () => {
    const state = getState(), to = state.timeConfig.elapsedSeconds;
    if (!cache || sessionId !== state.gameSessionId || settledAt == null || to <= settledAt) return;
    const posting = cachedSimulationPosting({ ...cache, from: settledAt, to, sessionId });
    const posted = game.postBackgroundNativeFinanceNow(posting);
    settledAt = to;
    // Native population simulation normally prunes these records. Retain one day.
    const latest = getState();
    if (posted.applied !== false) latest.totalLifetimeRidership = (latest.totalLifetimeRidership ?? 0)
      + posting.completedCommutes.reduce((sum, commute) => sum + commute.size, 0);
    latest.setCompletedCommutes?.((latest.completedCommutes ?? []).filter(c => c.journeyEnd >= to - 86400));
  };
  const refresh = async () => {
    if (refreshPromise) return refreshPromise;
    const run = async () => {
      const state = getState(), token = revision;
      if (!isReady() || !state.demandData?.popsMap) throw new Error('Wait for the World to finish loading.');
      await flush();
      for (const train of state.trains ?? []) {
        if (frozenTrains.get(train.id)?.train !== train) frozenTrains.set(train.id, { train, at: state.timeConfig.elapsedSeconds });
      }
      status = 'calculating'; notify();
      const initial = dependencyList(state), begin = performance.now();
      const demand = { points: values(state.demandData.points), pops: values(state.demandData.popsMap)
        .map(({ id, size, residenceId, jobId, drivingSeconds, drivingDistance, homeDepartureTime, workDepartureTime }) =>
          ({ id, size, residenceId, jobId, drivingSeconds, drivingDistance, homeDepartureTime, workDepartureTime })) };
      const input = { worldId: state.gameSessionId, tileId: state.cityCode, includeAssignments: true,
        networkProfile: game.captureCrossTileNetworkProfile(state.cityCode),
        farePolicy: { fare: state.transitCost, fareGroups: state.fareGroups }, globalNativeState: state };
      const result = evaluate ? await evaluate({ ...input, demand })
        : await worker.evaluate(new TextEncoder().encode(JSON.stringify(demand)), input)
          ?? evaluateOffTileNativeDemand({ ...input, demand, routingCache });
      const live = getState();
      const current = dependencyList(live);
      if (disposed || !enabled || revision !== token || initial.some((value, i) => value !== current[i])) return false;
      if (result.assignments?.length !== demand.pops.length) throw new Error('Incomplete cached demand calculation.');
      publishCachedDemand(live, result.assignments);
      cache = { ...result, expenses: game.calculateNativeFinanceProfile(state.cityCode, live,
        { includeRevenue: false }).expenseProfile };
      cache.pathsByCoordinates = new Map();
      for (const assigned of result.assignments) for (const commute of Object.values(assigned.commutes)) {
        const path = commute.transitPaths?.[0];
        if (path) cache.pathsByCoordinates.set(JSON.stringify([path.segments[0].fromStopCoords, path.segments.at(-1).toStopCoords]), commute.transitPaths);
      }
      clearMovements(getState());
      dependencies = dependencyList(getState());
      sessionId = state.gameSessionId;
      settledAt = getState().timeConfig.elapsedSeconds;
      counters.calculations++; counters.milliseconds = performance.now() - begin;
      status = 'ready'; error = null; notify();
      return true;
    };
    refreshPromise = run().finally(() => { refreshPromise = null; });
    return refreshPromise;
  };
  const fail = failure => {
    error = String(failure?.message ?? failure); status = 'error';
    getState().setTimeConfig({ paused: true }); notify();
  };
  const tick = async () => {
    if (!enabled || disposed || !isReady() || getState().timeConfig.paused) return;
    if (busy) return busy;
    busy = (async () => {
      if (!unchanged(getState())) {
        if (!await refresh()) return;
      }
      const state = getState();
      if (!enabled || disposed || state.timeConfig.paused) return;
      const from = state.timeConfig.elapsedSeconds, speed = state.timeConfig.timeSpeed;
      const rules = api.utils?.getConstants?.() ?? {};
      const count = rules.TICKS_PER_UPDATE?.[speed]?.gameState ?? ({ fast: 16, ultrafast: 48 }[speed] ?? 1);
      const step = 0.5 * Math.min(1000, Math.max(1, Math.floor(count))) * (speed === 'ultrafast' ? 10 : 1);
      const to = from + step;
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
    })().catch(fail).finally(() => { busy = null; });
    return busy;
  };
  const controller = {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    invalidate() {
      revision++; dependencies = null;
      if (enabled && !disposed && isReady()) {
        void (async () => {
          while (enabled && !disposed && isReady() && !unchanged(getState())) {
            if (await refresh()) break;
          }
        })().catch(fail);
      }
    },
    async setEnabled(value) {
      const request = ++modeRequest;
      if (disposed) return;
      if (stopping) { await stopping; if (request !== modeRequest || disposed) return snapshot(); }
      if (Boolean(value) === enabled) return snapshot();
      if (value) {
        enabled = true; revision++; status = 'calculating';
        startedAt = getState().timeConfig.elapsedSeconds; sessionId = getState().gameSessionId;
        settledAt = startedAt; cache = null; dependencies = null; frozenTrains.clear(); notify();
        try { await refresh(); } catch (failure) { fail(failure); }
      } else {
        enabled = false; revision++;
        stopping = (async () => {
        await busy; await refreshPromise; await flush();
        const state = getState();
        if (state.gameSessionId === sessionId) {
          clearMovements(state);
          // Preserve the fleet and its physical positions; move absolute timing
          // anchors forward by the time spent using estimates.
          state.setTrains?.((state.trains ?? []).map(train => rebaseCachedTrain(train,
            state.timeConfig.elapsedSeconds - (frozenTrains.get(train.id)?.at ?? state.timeConfig.elapsedSeconds), state.timeConfig.elapsedSeconds)));
          if (Number.isFinite(state.lastInfrastructureChargeTime)) getState().lastInfrastructureChargeTime
            = state.lastInfrastructureChargeTime + state.timeConfig.elapsedSeconds - startedAt;
          getState().setTimeConfig({});
        }
        cache = null; dependencies = null; status = 'off'; error = null; notify();
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
          if (!enabled || disposed || !isReady()) return original.apply(this, args);
          if (name === 'handleIncrementGameState') return tick();
          if (name === 'generateSave') {
            flush();
            const rebaseSave = save => {
              if (!enabled || !save?.data || getState().gameSessionId !== sessionId) return save;
              const elapsed = save.data.elapsedSeconds;
              return { ...save, data: { ...save.data,
                ...(Number.isFinite(save.data.lastInfrastructureChargeTime) ? {
                  lastInfrastructureChargeTime: save.data.lastInfrastructureChargeTime + elapsed - startedAt,
                } : {}),
                trains: (save.data.trains ?? []).map(train => rebaseCachedTrain(train,
                  elapsed - (frozenTrains.get(train.id)?.at ?? elapsed), elapsed)),
              } };
            };
            const save = original.apply(this, args);
            return typeof save?.then === 'function' ? save.then(rebaseSave) : rebaseSave(save);
          }
          if (name === 'simulateCommutes') { counters.suppressedCommutes++; return Promise.resolve(); }
          counters.suppressedPathSearches++;
          const query = args[0]?.query;
          return Promise.resolve({ paths: cache?.pathsByCoordinates.get(JSON.stringify([query?.origin?.coords, query?.destination?.coords])) ?? [],
            query, searchTime: 0, timings: { total: 0 }, cached: true });
        };
        Object.defineProperty(wrapper, OWNER, { value: { version: CACHED_SIMULATION_VERSION, original, controller } });
        state[name] = wrapper; wrappers.set(name, { original, wrapper });
      }
      state.setTimeConfig?.({});
    },
    async dispose() {
      await controller.setEnabled(false);
      disposed = true; revision++;
      const state = getState();
      for (const [name, { original, wrapper }] of wrappers) if (state[name] === wrapper) state[name] = original;
      worker.dispose(); routingCache.clear(); listeners.clear(); state.setTimeConfig?.({});
    },
  };
  controller.attach();
  return controller;
}
