import { createNetworkProfile } from '../cross-tile-mode-choice.js';
import {
  CANONICAL_NATIVE_NETWORK_MODE,
  mergeSharedTransitNetworkState,
  SHARED_TRANSIT_STATE_KEYS,
} from '../shared-transit-network.js';
import { stabilizeMapLayerMoves } from '../map-layer-stability.js';
import {
  backfillHourlyFinancialHistory,
  backfillHourlyRouteFinancials,
  calculateGlobalExpenseProfile,
  calculateNativeRevenueProfile,
} from '../native-finance-model.js';
import { repairStationTrackGroupIntegrity } from '../network-projection.js';
import {
  projectRouteTimings,
  removeRouteNodes,
  repairRouteTimingIntegrity,
} from '../route-timing-integrity.js';
import {
  OPEN_WORLD_RUNTIME_SAVE_NAME,
  openWorldRuntimeSnapshotProvenance,
  stampOpenWorldRuntimeSnapshot,
} from '../autosave-hook-guard.js';
import { installNativeSharedTransitObserver } from './native-shared-transit-observer.js';
import {
  installSimulationPerformanceDiagnostics,
  prepareSimulationPerformanceDiagnostics,
} from '../simulation-performance-diagnostics.js';

/**
 * Subway Builder 1.7.0 integration boundary.
 *
 * The public mod API is versioned independently from the game: the inspected
 * 1.7.0 renderer exposes API version 1.0.0.  The unsupported callback global
 * contains only setMoney, setTicketCost, and getState; private Zustand actions
 * must be obtained from getState().  Keep every use of that seam in this file.
 */
const REQUIRED_STATE_ACTION_GROUPS = Object.freeze({
  snapshotAndCity: Object.freeze([
    'generateSave',
    'loadSave',
    'loadInitialData',
    'setCityCode',
    'setTimeConfig',
    'setGameMode',
  ]),
  network: Object.freeze([
    'setRoutes',
    'setTracks',
    'recalculateAllRouteGeojsons',
  ]),
  routeEditing: Object.freeze([
    'setPreviewRoute',
    'batchPreviewRouteUpdates',
    'confirmRouteChange',
  ]),
  simulation: Object.freeze([
    'handleIncrementGameState',
    'simulateCommutes',
    'calculatePaths',
  ]),
  finance: Object.freeze([
    'addRevenue',
    'addExpense',
    'recordRouteFinancials',
    'setRouteFinancials',
    'setFinancialHistory',
    'setCompletedCommutes',
  ]),
});
const REQUIRED_STATE_ACTIONS = Object.freeze([
  ...new Set(Object.values(REQUIRED_STATE_ACTION_GROUPS).flat()),
]);
const REQUIRED_PORTOLAN_STATE_KEYS = Object.freeze([
  'portolanDiagram',
  'portolanProgress',
]);
const SUBWAY_BUILDER_1_6_MIN_TRANSIT_CHOICE = 10;
const NATIVE_COMMUTE_DIRECTIONS = Object.freeze(['homeToWork', 'workToHome']);
const DIRECTIONAL_COMMUTE_RESTORE_POLICY = 'recalculate-both-directions-v1';
const CITY_SETTLE_ATTEMPTS = 8;
const PAUSE_SETTLE_ATTEMPTS = 20;
const PAUSE_SETTLE_DELAY_MS = 10;
const CLIPPED_ROUTE_TICK_GUARD = Symbol.for('open-world.clipped-route-tick-guard');
const CLIPPED_ROUTE_TICK_GUARD_VERSION = Symbol.for('open-world.clipped-route-tick-guard-version');
const CLIPPED_ROUTE_TICK_GUARD_BINDING = Symbol.for('open-world.clipped-route-tick-guard-binding');
const NATIVE_FINANCE_METHOD_ORIGINAL = Symbol.for('open-world.native-finance-method-original');
const CURRENT_CLIPPED_ROUTE_TICK_GUARD_VERSION = 7;
const TRACK_GROUP_LOAD_GUARD = Symbol.for('open-world.track-group-load-guard');
const TRACK_GROUP_LOAD_GUARD_VERSION = Symbol.for('open-world.track-group-load-guard-version');
const TRACK_GROUP_LOAD_GUARD_ORIGINAL = Symbol.for('open-world.track-group-load-guard-original');
const CURRENT_TRACK_GROUP_LOAD_GUARD_VERSION = 2;
const CLIPPED_ROUTE_COMMUTE_GUARD = Symbol.for('open-world.clipped-route-commute-guard');
const CLIPPED_ROUTE_COMMUTE_GUARD_VERSION = Symbol.for('open-world.clipped-route-commute-guard-version');
const CURRENT_CLIPPED_ROUTE_COMMUTE_GUARD_VERSION = 3;
const CLIPPED_ROUTE_TRACK_EDIT_GUARD = Symbol.for('open-world.clipped-route-track-edit-guard');
const CLIPPED_ROUTE_TRACK_EDIT_ORIGINAL = Symbol.for('open-world.clipped-route-track-edit-original');
const CLIPPED_ROUTE_PREVIEW_EDIT_GUARD = Symbol.for('open-world.clipped-route-preview-edit-guard');
const CLIPPED_ROUTE_PREVIEW_EDIT_GUARD_VERSION = Symbol.for('open-world.clipped-route-preview-edit-guard-version');
const CLIPPED_ROUTE_PREVIEW_EDIT_LISTENERS = Symbol.for('open-world.clipped-route-preview-edit-listeners');
const CLIPPED_ROUTE_PREVIEW_EDIT_ORIGINAL_BATCH = Symbol.for('open-world.clipped-route-preview-edit-original-batch');
const CLIPPED_ROUTE_PREVIEW_EDIT_ORIGINAL_CONFIRM = Symbol.for('open-world.clipped-route-preview-edit-original-confirm');
const CLIPPED_ROUTE_PREVIEW_EDIT_ORIGINAL_SET_PREVIEW = Symbol.for('open-world.clipped-route-preview-edit-original-set-preview');
const CURRENT_CLIPPED_ROUTE_PREVIEW_EDIT_GUARD_VERSION = 18;
const CANONICAL_NATIVE_MODE_BINDING = Symbol.for('open-world.canonical-native-network-mode');
const CANONICAL_NATIVE_INTERLINING_CACHE = Symbol.for('open-world.canonical-native-interlining-cache');
const CANONICAL_NATIVE_INTERLINING_CACHE_VERSION = Symbol.for('open-world.canonical-native-interlining-cache-version');
const CANONICAL_NATIVE_INTERLINING_CACHE_BINDING = Symbol.for('open-world.canonical-native-interlining-cache-binding');
const CANONICAL_NATIVE_INTERLINING_CACHE_ORIGINAL = Symbol.for('open-world.canonical-native-interlining-cache-original');
const CURRENT_CANONICAL_NATIVE_INTERLINING_CACHE_VERSION = 5;
const NATIVE_PASS_THROUGH_PLATFORM_PENALTY = 10.1;
const NATIVE_TURNBACK_WRONG_WAY_PENALTY = 25;
const NATIVE_FINANCIAL_STATE_KEYS = Object.freeze([
  // Sandbox's unlimited balance is a mode invariant, not just a large number.
  // Restoring a destination tile as "easy" would immediately make the native
  // expense tick consume its Number.MAX_SAFE_INTEGER money sentinel.
  'gameMode',
  'money',
  'transitCost',
  'fareGroups',
  'financialHistory',
  'routeFinancials',
  'bonds',
  'hasGoneBankrupt',
  'rockefellerPaidOut',
  'buildingDemolitionSpendAllTime',
]);

export const SUBWAY_BUILDER_CITY_AUTHORITY_VERSION = 'zustand-city-authority-v6';

/**
 * Read the current city from the live Zustand snapshot.
 *
 * Subway Builder 1.7 can retain an old value in the public getCityCode()
 * closure across router-driven city changes. The callback seam returns a new
 * immutable snapshot after each store update. The adapter synchronizes the
 * authoritative onCityLoad destination through setCityCode(), then reads
 * state.cityCode as the durable source between lifecycle events.
 */
export function readLiveSubwayBuilderCityCode({
  api = globalThis.SubwayBuilderAPI,
  callbacks = globalThis.__subwayBuilder_storeCallbacks__,
} = {}) {
  try {
    const cityCode = callbacks?.getState?.()?.cityCode;
    if (typeof cityCode === 'string' && cityCode) return cityCode;
  } catch {}
  try {
    const cityCode = api?.utils?.getCityCode?.();
    return typeof cityCode === 'string' && cityCode ? cityCode : null;
  } catch {
    return null;
  }
}

function normalizeNativeRouteFinancialsEnvelope(value, financialHistory = null) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? structuredClone(value)
    : {};
  const isRouteMap = (candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate);
  const legacyByRoute = Object.fromEntries(Object.entries(source)
    .filter(([key]) => !['byRoute', 'currentHour', 'lastHourTimestamp'].includes(key)));
  const historyTimestamp = Number(financialHistory?.lastHourTimestamp);
  const routeTimestamp = Number(source.lastHourTimestamp);
  return {
    ...source,
    byRoute: isRouteMap(source.byRoute) ? source.byRoute : legacyByRoute,
    lastHourTimestamp: Number.isFinite(routeTimestamp)
      ? routeTimestamp
      : Number.isFinite(historyTimestamp) ? historyTimestamp : 0,
    currentHour: isRouteMap(source.currentHour) ? source.currentHour : {},
  };
}

function preserveNativeFinancialStateInSnapshot(snapshot, preferredState, fallbackState = preferredState) {
  const result = structuredClone(snapshot);
  result.data = { ...(result.data ?? {}) };
  for (const key of NATIVE_FINANCIAL_STATE_KEYS) {
    const value = preferredState?.[key] !== undefined
      ? preferredState[key]
      : fallbackState?.[key];
    if (value === undefined) delete result.data[key];
    else result.data[key] = structuredClone(value);
  }
  if (result.data.routeFinancials !== undefined) {
    result.data.routeFinancials = normalizeNativeRouteFinancialsEnvelope(
      result.data.routeFinancials,
      result.data.financialHistory,
    );
  }
  if (result.metadata && typeof result.metadata === 'object') {
    result.metadata = { ...result.metadata, money: result.data.money };
  }
  return result;
}

function usableNativeLineCoordinates(value) {
  const coordinates = Array.isArray(value)
    ? value
    : value?.geometry?.type === 'LineString'
      ? value.geometry.coordinates
      : value?.coordinates;
  return Array.isArray(coordinates)
    && coordinates.length >= 2
    && coordinates.every((point) => (
      Array.isArray(point)
      && point.length >= 2
      && Number.isFinite(Number(point[0]))
      && Number.isFinite(Number(point[1]))
    ));
}

/**
 * Subway Builder's interlining worker assumes every route submitted by
 * getSimplifiedRoutesOld produces at least one LineString. During construction
 * and restore, routes can temporarily reference a missing track/group or a
 * group whose centerLine has not been rebuilt yet. The native simplifier emits
 * an empty-coordinate feature for that route when any other route is valid,
 * and Turf then throws `coordinates is required`.
 *
 * Build a calculation-only facade containing the coherent route fragments.
 * The canonical state is untouched; a later topology callback includes the
 * route automatically once all of its geometry is available.
 */
function nativeInterliningRouteInputs(state, routes) {
  if (!Array.isArray(routes)) return routes;
  const tracksById = new Map((state?.tracks ?? [])
    .filter((track) => track?.id != null && usableNativeLineCoordinates(track?.coords))
    .map((track) => [String(track.id), track]));
  const usableGroupTrackIds = new Set();
  for (const group of state?.trackGroups ?? []) {
    if (!usableNativeLineCoordinates(group?.centerLine)) continue;
    for (const trackId of group?.trackIds ?? []) usableGroupTrackIds.add(String(trackId));
  }
  const stationNodeIds = new Set((state?.stations ?? [])
    .flatMap((station) => station?.stNodeIds ?? [])
    .map(String));

  return routes.flatMap((route) => {
    if (!route || typeof route !== 'object' || route.tempParentId != null) return [];
    const stCombos = (route.stCombos ?? []).flatMap((combo) => {
      if (!stationNodeIds.has(String(combo?.startStNodeId))
        || !stationNodeIds.has(String(combo?.endStNodeId))) return [];
      const path = (combo?.path ?? []).filter((segment) => {
        const trackId = segment?.trackId == null ? null : String(segment.trackId);
        return trackId != null && tracksById.has(trackId) && usableGroupTrackIds.has(trackId);
      });
      return path.length ? [{ ...combo, path }] : [];
    });
    return stCombos.length ? [{ ...route, tempParentId: null, stCombos }] : [];
  });
}

/**
 * A newly-created native route exists before the player has drawn any track.
 * It is a real route definition (name, bullet, color, service settings), but it
 * cannot participate in native topology or interlining until at least one
 * station combination owns a path segment.
 */
function routeHasNativeTopology(route) {
  return Array.isArray(route?.stCombos) && route.stCombos.some((combo) => (
    Array.isArray(combo?.path) && combo.path.some((segment) => segment?.trackId != null)
  ));
}

function canonicalNativeRestorePlan(snapshot, nativeNetworkMode, canRestoreDefinitions) {
  const routes = snapshot?.data?.routes;
  if (nativeNetworkMode !== CANONICAL_NATIVE_NETWORK_MODE
    || !canRestoreDefinitions
    || !Array.isArray(routes)) {
    return { nativeSnapshot: snapshot, deferredRouteDefinitions: [] };
  }
  const deferredRouteDefinitions = routes.filter((route) => !routeHasNativeTopology(route));
  if (!deferredRouteDefinitions.length) {
    return { nativeSnapshot: snapshot, deferredRouteDefinitions };
  }
  return {
    nativeSnapshot: {
      ...snapshot,
      data: {
        ...snapshot.data,
        routes: routes.filter(routeHasNativeTopology),
      },
    },
    deferredRouteDefinitions,
  };
}

function restoreDeferredRouteDefinitions(state, savedRoutes, deferredRouteDefinitions) {
  if (!deferredRouteDefinitions.length) return;
  if (typeof state?.setRoutes !== 'function') {
    throw new Error('Native setRoutes is required to restore non-topological route definitions');
  }

  const deferredIds = new Set(deferredRouteDefinitions.map((route) => String(route.id)));
  const loadedById = new Map((state.routes ?? []).map((route) => [String(route.id), route]));
  const restoredRoutes = [];
  const restoredIds = new Set();
  for (const savedRoute of savedRoutes) {
    const id = String(savedRoute.id);
    const route = deferredIds.has(id) ? savedRoute : loadedById.get(id);
    if (!route || restoredIds.has(id)) continue;
    restoredRoutes.push(structuredClone(route));
    restoredIds.add(id);
  }
  for (const route of state.routes ?? []) {
    const id = String(route.id);
    if (restoredIds.has(id)) continue;
    restoredRoutes.push(route);
    restoredIds.add(id);
  }

  // false is essential: publishing the definitions must update the route UI
  // and station membership without asking native interlining to geometrize an
  // intentionally empty route.
  state.setRoutes(restoredRoutes, false);
}

function nativeInterliningFingerprint(state, routes) {
  try {
    const tracks = (state?.tracks ?? []).map((track) => ({
      id: track?.id ?? null,
      trackType: track?.trackType ?? null,
      buildType: track?.buildType ?? null,
      curveType: track?.curveType ?? null,
      curveGeometry: track?.curveGeometry ?? null,
      nodes: track?.nodes ?? null,
      direction: track?.direction ?? null,
      laneDirection: track?.laneDirection ?? null,
      reversable: track?.reversable ?? null,
      coords: track?.coords ?? null,
    }));
    const trackGroups = (state?.trackGroups ?? []).map((group) => ({
      id: group?.id ?? null,
      trackIds: group?.trackIds ?? null,
      trackType: group?.trackType ?? null,
      trackLanesType: group?.trackLanesType ?? null,
      laneDirections: group?.laneDirections ?? group?.directions ?? null,
      centerLine: group?.centerLine ?? null,
    }));
    const stations = (state?.stations ?? []).map((station) => ({
      id: station?.id ?? null,
      stNodeIds: station?.stNodeIds ?? null,
    }));
    const routeGeometry = (routes ?? []).map((route) => ({
      id: route?.id ?? null,
      color: route?.color ?? null,
      shape: route?.shape ?? null,
      bordered: route?.bordered ?? null,
      textColor: route?.textColor ?? null,
      font: route?.font ?? null,
      bullet: route?.bullet ?? null,
      fullName: route?.fullName ?? null,
      trainType: route?.trainType ?? null,
      stCombos: route?.stCombos ?? null,
    }));
    return JSON.stringify({
      cityCode: state?.cityCode ?? null,
      tracks,
      trackGroups,
      stations,
      routes: routeGeometry,
    });
  } catch {
    return null;
  }
}

function hasPortolanState(state) {
  return Boolean(state)
    && Object.prototype.hasOwnProperty.call(state, 'portolanDiagram')
    && Object.prototype.hasOwnProperty.call(state, 'portolanProgress');
}

function hasInterliningResult(state) {
  if (hasPortolanState(state)) {
    return state.portolanProgress == null && state.portolanDiagram != null;
  }
  return Array.isArray(state?.interlinedFeatureCollection?.features);
}

function advanceNativeInterliningRevision(binding, signature) {
  if (binding.cache.revisionSignature !== signature) {
    binding.cache.revision = Number.isSafeInteger(binding.cache.revision)
      ? binding.cache.revision + 1
      : 1;
    binding.cache.revisionSignature = signature;
  }
}

function commitNativeInterliningSignature(binding, signature) {
  binding.cache.signature = signature;
}

function promoteCompletedPortolanSignature(binding, state) {
  const signature = binding.cache.awaitingSignature;
  if (!signature || !hasPortolanState(state) || state.portolanProgress != null) return false;
  if (state.portolanDiagram === binding.cache.awaitingDiagram) return false;
  commitNativeInterliningSignature(binding, signature);
  binding.cache.awaitingSignature = null;
  binding.cache.awaitingDiagram = null;
  return true;
}

function stageNativeInterliningSignature(binding, signature, state, routes, diagramBefore) {
  if (!hasPortolanState(state)) {
    commitNativeInterliningSignature(binding, signature);
    return;
  }
  const hasTopology = (routes ?? []).some(routeHasNativeTopology);
  if (!hasTopology) {
    commitNativeInterliningSignature(binding, signature);
    binding.cache.awaitingSignature = null;
    binding.cache.awaitingDiagram = null;
    return;
  }
  binding.cache.awaitingSignature = signature;
  binding.cache.awaitingDiagram = diagramBefore;
  promoteCompletedPortolanSignature(binding, state);
}

function installCanonicalNativeInterliningCache(adapter, state) {
  const current = state?.recalculateAllRouteGeojsons;
  if (typeof current !== 'function') return { installed: false, reason: 'unavailable' };

  const existingBinding = current[CANONICAL_NATIVE_INTERLINING_CACHE_BINDING];
  if (current[CANONICAL_NATIVE_INTERLINING_CACHE]
    && current[CANONICAL_NATIVE_INTERLINING_CACHE_VERSION]
      === CURRENT_CANONICAL_NATIVE_INTERLINING_CACHE_VERSION
    && existingBinding) {
    existingBinding.adapter = adapter;
    existingBinding.mode = CANONICAL_NATIVE_NETWORK_MODE;
    adapter[CANONICAL_NATIVE_INTERLINING_CACHE_BINDING] = existingBinding;
    return { installed: true, reused: true };
  }

  const original = current[CANONICAL_NATIVE_INTERLINING_CACHE_ORIGINAL] ?? current;
  const previousBinding = adapter[CANONICAL_NATIVE_INTERLINING_CACHE_BINDING];
  const previousRevision = previousBinding?.cache?.revision;
  const binding = {
    adapter,
    mode: CANONICAL_NATIVE_NETWORK_MODE,
    cache: {
      signature: null,
      revision: Number.isSafeInteger(previousRevision) ? previousRevision + 1 : 0,
      revisionSignature: null,
      pending: null,
      pendingSignature: null,
      awaitingSignature: null,
      awaitingDiagram: null,
    },
  };
  const guarded = function canonicalNativeRecalculateAllRouteGeojsons(...args) {
    if (binding.mode !== CANONICAL_NATIVE_NETWORK_MODE) return original.apply(this, args);

    const live = binding.adapter?.callbacks?.getState?.();
    const routes = args[0];
    const signature = nativeInterliningFingerprint(live, routes);
    if (!signature) return original.apply(this, args);

    promoteCompletedPortolanSignature(binding, live);

    if (binding.cache.signature === signature && hasInterliningResult(live)) {
      return Promise.resolve({ status: 'cached', signature });
    }
    if (binding.cache.pending && binding.cache.pendingSignature === signature) {
      return binding.cache.pending;
    }

    const nativeArgs = [...args];
    nativeArgs[0] = nativeInterliningRouteInputs(live, routes);
    const portolanDiagramBefore = hasPortolanState(live) ? live.portolanDiagram : null;
    advanceNativeInterliningRevision(binding, signature);
    let result;
    try {
      result = original.apply(this, nativeArgs);
    } catch (error) {
      if (binding.cache.revisionSignature === signature) binding.cache.revisionSignature = null;
      throw error;
    }
    if (!result || typeof result.then !== 'function') {
      stageNativeInterliningSignature(binding, signature, live, routes, portolanDiagramBefore);
      return result;
    }

    const pending = Promise.resolve(result).then(
      (value) => {
        if (binding.cache.pendingSignature === signature) {
          const resolvedState = binding.adapter?.callbacks?.getState?.() ?? live;
          stageNativeInterliningSignature(
            binding,
            signature,
            resolvedState,
            routes,
            portolanDiagramBefore,
          );
          binding.cache.pending = null;
          binding.cache.pendingSignature = null;
        }
        return value;
      },
      (error) => {
        if (binding.cache.pendingSignature === signature) {
          if (binding.cache.revisionSignature === signature) binding.cache.revisionSignature = null;
          binding.cache.pending = null;
          binding.cache.pendingSignature = null;
        }
        throw error;
      },
    );
    binding.cache.pending = pending;
    binding.cache.pendingSignature = signature;
    return pending;
  };
  Object.defineProperty(guarded, CANONICAL_NATIVE_INTERLINING_CACHE, { value: true });
  Object.defineProperty(guarded, CANONICAL_NATIVE_INTERLINING_CACHE_VERSION, {
    value: CURRENT_CANONICAL_NATIVE_INTERLINING_CACHE_VERSION,
  });
  Object.defineProperty(guarded, CANONICAL_NATIVE_INTERLINING_CACHE_BINDING, { value: binding });
  Object.defineProperty(guarded, CANONICAL_NATIVE_INTERLINING_CACHE_ORIGINAL, { value: original });
  adapter[CANONICAL_NATIVE_INTERLINING_CACHE_BINDING] = binding;
  state.recalculateAllRouteGeojsons = guarded;
  return { installed: true, reused: false };
}

function unwrapNativeFinanceMethod(method) {
  let current = method;
  const seen = new Set();
  while (typeof current === 'function' && typeof current[NATIVE_FINANCE_METHOD_ORIGINAL] === 'function'
    && !seen.has(current)) {
    seen.add(current);
    current = current[NATIVE_FINANCE_METHOD_ORIGINAL];
  }
  return current;
}

function markNativeFinanceWrapper(wrapper, original) {
  Object.defineProperty(wrapper, NATIVE_FINANCE_METHOD_ORIGINAL, { value: original });
  return wrapper;
}

const NATIVE_FINANCE_REBASE_SESSION_KEY = 'openWorldNativeFinanceSessionId';
const NATIVE_FINANCE_REBASE_TOPOLOGY_KEY = 'openWorldNativeFinanceTopologyKey';

function nativeFinanceTopologyKey(state) {
  const routeIds = (state?.routes ?? [])
    .map((route) => route?.id)
    .filter((id) => id != null)
    .map(String)
    .sort();
  const trainIds = (state?.trains ?? [])
    .map((train) => train?.id)
    .filter((id) => id != null)
    .map(String)
    .sort();
  return JSON.stringify({ routeIds, trainIds });
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function sumCurrentRouteExpenses(currentHour) {
  return Object.values(currentHour ?? {}).reduce(
    (sum, entry) => sum + Math.max(0, finiteNumber(entry?.expenses, 0)),
    0,
  );
}

/**
 * Keep native route accounting aligned with the live canonical session.
 *
 * Native 1.6 keeps routeFinancials separate from the route array. A stale
 * save can therefore retain a deleted route, or retain a current-hour bucket
 * from an earlier session/network. The latter is especially dangerous: the
 * next native settlement treats it as newly accumulated trainOperational
 * expense. Historical rows remain useful for the dashboard; only the
 * inconsistent current bucket is discarded.
 */
function rebaseNativeFinanceState(state) {
  const financialHistory = structuredClone(state?.financialHistory ?? {});
  const routeFinancials = structuredClone(state?.routeFinancials ?? {});
  const routeIds = new Set((state?.routes ?? [])
    .map((route) => route?.id)
    .filter((id) => id != null)
    .map(String));
  const topologyKey = nativeFinanceTopologyKey(state);
  const sessionId = typeof state?.gameSessionId === 'string' && state.gameSessionId
    ? state.gameSessionId
    : null;
  const priorSessionId = financialHistory[NATIVE_FINANCE_REBASE_SESSION_KEY] ?? null;
  const priorTopologyKey = financialHistory[NATIVE_FINANCE_REBASE_TOPOLOGY_KEY] ?? null;
  const historyTimestamp = Math.max(
    0,
    finiteNumber(
      financialHistory.lastHourTimestamp,
      Math.floor(Math.max(0, finiteNumber(state?.timeConfig?.elapsedSeconds, 0)) / 3_600) * 3_600,
    ),
  );
  const routeTimestamp = finiteNumber(routeFinancials.lastHourTimestamp, historyTimestamp);
  const historyExpenses = Math.max(0, finiteNumber(financialHistory.currentHourExpenses, 0));
  const routeCurrentExpenses = sumCurrentRouteExpenses(routeFinancials.currentHour);
  const sessionChanged = Boolean(sessionId && priorSessionId && sessionId !== priorSessionId);
  const firstCanonicalObservation = Boolean(sessionId && priorSessionId == null);
  const topologyChanged = Boolean(priorTopologyKey && priorTopologyKey !== topologyKey);
  const routeClockMismatch = routeTimestamp !== historyTimestamp;
  const routeExpenseMismatch = routeCurrentExpenses > historyExpenses + Math.max(1_000, historyExpenses * 2);
  const resetCurrentHour = Boolean(
    sessionChanged
    || firstCanonicalObservation
    || topologyChanged
    || routeClockMismatch
    || routeExpenseMismatch,
  );

  const rawByRoute = routeFinancials.byRoute && typeof routeFinancials.byRoute === 'object'
    ? routeFinancials.byRoute
    : {};
  const byRoute = Object.fromEntries(Object.entries(rawByRoute)
    .filter(([routeId]) => routeIds.has(String(routeId)))
    .map(([routeId, entries]) => [
      routeId,
      Array.isArray(entries)
        ? entries.filter((entry) => finiteNumber(entry?.timestamp, 0) <= historyTimestamp)
        : structuredClone(entries),
    ]));
  const rawCurrentHour = routeFinancials.currentHour && typeof routeFinancials.currentHour === 'object'
    ? routeFinancials.currentHour
    : {};
  const currentHour = resetCurrentHour
    ? {}
    : Object.fromEntries(Object.entries(rawCurrentHour)
      .filter(([routeId]) => routeIds.has(String(routeId)))
      .map(([routeId, entry]) => [routeId, structuredClone(entry)]));
  const nextRouteFinancials = {
    ...routeFinancials,
    byRoute,
    currentHour,
    lastHourTimestamp: resetCurrentHour ? historyTimestamp : routeFinancials.lastHourTimestamp,
  };
  const nextFinancialHistory = {
    ...financialHistory,
    [NATIVE_FINANCE_REBASE_SESSION_KEY]: sessionId ?? priorSessionId,
    [NATIVE_FINANCE_REBASE_TOPOLOGY_KEY]: topologyKey,
  };
  const routeFinancialsChanged = JSON.stringify(nextRouteFinancials) !== JSON.stringify(state?.routeFinancials ?? {});
  const financialHistoryChanged = JSON.stringify(nextFinancialHistory) !== JSON.stringify(state?.financialHistory ?? {});
  return {
    changed: routeFinancialsChanged || financialHistoryChanged,
    routeFinancialsChanged,
    financialHistoryChanged,
    resetCurrentHour,
    sessionId,
    topologyKey,
    historyTimestamp,
    routeTimestamp,
    routeCurrentExpenses,
    historyExpenses,
    routeFinancials: nextRouteFinancials,
    financialHistory: nextFinancialHistory,
  };
}
const DEMAND_SCHEDULE_KEY_BY_HOUR = Object.freeze([
  'veryLowDemand', 'veryLowDemand', 'veryLowDemand', 'lowDemand', 'lowDemand', 'lowDemand',
  'mediumDemand', 'highDemand', 'highDemand', 'highDemand', 'mediumDemand', 'mediumDemand',
  'mediumDemand', 'mediumDemand', 'mediumDemand', 'mediumDemand', 'highDemand', 'highDemand',
  'highDemand', 'mediumDemand', 'lowDemand', 'lowDemand', 'lowDemand', 'veryLowDemand',
]);

function routeCycleSeconds(route, trains) {
  const routeCycle = Number(route?.stComboTimings?.at?.(-1)?.departureTime);
  if (Number.isFinite(routeCycle) && routeCycle > 0) return routeCycle;
  for (const train of trains ?? []) {
    for (const timing of train?.timings ?? []) {
      const departures = timing?.futureCycleDepartureTimes ?? [];
      if (departures.length > 1) {
        const cycle = Number(departures[1]) - Number(departures[0]);
        if (Number.isFinite(cycle) && cycle > 0) return cycle;
      }
    }
  }
  return null;
}

function rebaseDeferredTrainsForPathfinding(route, trains, elapsedSeconds) {
  const cycleSeconds = routeCycleSeconds(route, trains);
  if (!cycleSeconds || !Number.isFinite(elapsedSeconds)) return structuredClone(trains ?? []);
  const hour = Math.floor(((elapsedSeconds % 86400) + 86400) % 86400 / 3600);
  const scheduleKey = DEMAND_SCHEDULE_KEY_BY_HOUR[hour];
  const scheduledCount = Number(route?.trainSchedule?.[scheduleKey]);
  const activeTrains = (trains ?? [])
    .filter((train) => train?.operatingSchedule?.[scheduleKey] !== false);
  const desiredCount = Number.isFinite(scheduledCount)
    ? Math.max(0, Math.round(scheduledCount))
    : activeTrains.length;
  const routeTimings = route?.stComboTimings ?? [];

  // Physical trains on a clipped route are intentionally frozen and may be
  // fewer than the preserved scheduler calls for. Native RAPTOR must consume
  // the route's service plan, otherwise those stale phases create hour-long
  // holes even when the player selected a short headway.
  if (desiredCount > 0 && routeTimings.length > 1) {
    const cycleStart = Math.floor(elapsedSeconds / cycleSeconds) * cycleSeconds;
    return Array.from({ length: desiredCount }, (_, index) => {
      const template = structuredClone(activeTrains[index % Math.max(1, activeTrains.length)] ?? {});
      const phase = index * cycleSeconds / desiredCount;
      template.id ??= `open-world-service-${route.id}`;
      if (index >= activeTrains.length) template.id = `${template.id}::scheduled:${index}`;
      template.routeId = route.id;
      template.operatingSchedule = {
        highDemand: true,
        mediumDemand: true,
        lowDemand: true,
        veryLowDemand: true,
        ...(template.operatingSchedule ?? {}),
      };
      template.timings = routeTimings.map((timing, timingIndex) => {
        const baseArrival = cycleStart + phase + Number(timing.arrivalTime ?? timing.expectedArrivalTime ?? 0);
        const baseDeparture = cycleStart + phase + Number(timing.departureTime ?? timing.expectedDepartureTime ?? 0);
        return {
          ...(template.timings?.[timingIndex] ?? {}),
          stNodeId: timing.stNodeId ?? route.stNodes?.[timing.stNodeIndex ?? timingIndex]?.id,
          stNodeIndex: timing.stNodeIndex ?? timingIndex,
          arrivalTime: baseArrival,
          departureTime: baseDeparture,
          expectedArrivalTime: baseArrival,
          expectedDepartureTime: baseDeparture,
          adjustedExpectedArrivalTime: baseArrival,
          adjustedExpectedDepartureTime: baseDeparture,
          futureCycleArrivalTimes: [1, 2, 3].map((offset) => baseArrival + offset * cycleSeconds),
          futureCycleDepartureTimes: [1, 2, 3].map((offset) => baseDeparture + offset * cycleSeconds),
        };
      });
      return template;
    });
  }

  return activeTrains.map((train) => {
      const result = structuredClone(train);
      const anchors = (result.timings ?? []).flatMap((timing) => [
        timing.adjustedExpectedDepartureTime,
        timing.expectedDepartureTime,
        timing.adjustedExpectedArrivalTime,
        timing.expectedArrivalTime,
      ]).map(Number).filter(Number.isFinite);
      if (!anchors.length) return result;
      const anchor = Math.min(...anchors);
      const cycles = Math.max(0, Math.floor((elapsedSeconds - anchor) / cycleSeconds));
      const shift = cycles * cycleSeconds;
      const scalarFields = [
        'arrivalTime', 'departureTime',
        'expectedArrivalTime', 'expectedDepartureTime',
        'adjustedExpectedArrivalTime', 'adjustedExpectedDepartureTime',
      ];
      for (const timing of result.timings ?? []) {
        for (const field of scalarFields) {
          if (Number.isFinite(timing[field])) timing[field] += shift;
        }
        const baseArrival = timing.adjustedExpectedArrivalTime ?? timing.expectedArrivalTime;
        const baseDeparture = timing.adjustedExpectedDepartureTime ?? timing.expectedDepartureTime;
        if (Number.isFinite(baseArrival)) {
          timing.futureCycleArrivalTimes = [1, 2, 3].map((offset) => baseArrival + offset * cycleSeconds);
        }
        if (Number.isFinite(baseDeparture)) {
          timing.futureCycleDepartureTimes = [1, 2, 3].map((offset) => baseDeparture + offset * cycleSeconds);
        }
      }
      return result;
    });
}

function publishClippedRouteDiagnostic(stage, details) {
  const entry = {
    capturedAt: Date.now(),
    guardVersion: CURRENT_CLIPPED_ROUTE_PREVIEW_EDIT_GUARD_VERSION,
    stage,
    ...structuredClone(details),
  };
  const hosts = [globalThis];
  if (typeof window !== 'undefined' && window !== globalThis) hosts.push(window);
  for (const host of hosts) {
    const history = Array.isArray(host.__openWorldClippedRouteDiagnostics)
      ? host.__openWorldClippedRouteDiagnostics.slice(-19)
      : [];
    history.push(entry);
    host.__openWorldClippedRouteDiagnostics = history;
    host.__openWorldLastClippedRouteDiagnostic = entry;
  }
  if (typeof window !== 'undefined') {
    console.warn(`[OpenWorld][clipped-route-preview:${stage}]`, JSON.stringify(entry));
  }
  return entry;
}

function entityId(value) {
  return value?.id == null ? null : String(value.id);
}

function routeNodeId(value) {
  return value?.id == null ? null : String(value.id);
}

function replaceLocalSequence(globalValues, oldLocalValues, newLocalValues) {
  const localIds = new Set((oldLocalValues ?? []).map(routeNodeId).filter(Boolean));
  const firstLocalIndex = (globalValues ?? []).findIndex((value) => localIds.has(routeNodeId(value)));
  if (firstLocalIndex < 0) return [...(globalValues ?? []), ...(newLocalValues ?? [])].map((value) => structuredClone(value));
  const retained = (globalValues ?? []).filter((value) => !localIds.has(routeNodeId(value)));
  const insertionIndex = (globalValues ?? []).slice(0, firstLocalIndex)
    .filter((value) => !localIds.has(routeNodeId(value))).length;
  retained.splice(insertionIndex, 0, ...(newLocalValues ?? []).map((value) => structuredClone(value)));
  return retained;
}

function comboConnectsNodes(combo, leftId, rightId) {
  const startId = String(combo?.startStNodeId ?? '');
  const endId = String(combo?.endStNodeId ?? '');
  return (startId === leftId && endId === rightId)
    || (startId === rightId && endId === leftId);
}

function routeEdgeCombo(combos, edgeIndex, leftId, rightId) {
  const indexed = combos?.[edgeIndex];
  if (comboConnectsNodes(indexed, leftId, rightId)) return indexed;
  return (combos ?? []).find((combo) => comboConnectsNodes(combo, leftId, rightId)) ?? null;
}

function trackPathEndpoints(track, reversed) {
  const coords = track?.coords;
  if (!Array.isArray(coords) || coords.length < 2
    || !Array.isArray(coords[0]) || !Array.isArray(coords.at(-1))) return null;
  return reversed
    ? {
      start: { coords: coords.at(-1), elevation: track?.endElevation },
      end: { coords: coords[0], elevation: track?.startElevation },
    }
    : {
      start: { coords: coords[0], elevation: track?.startElevation },
      end: { coords: coords.at(-1), elevation: track?.endElevation },
    };
}

function coordinatesMeet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return true;
  // Projection clipping retains exact endpoints in normal cases. Keep a small
  // tolerance for serialized geographic coordinates (~1 metre).
  return Math.abs(Number(left[0]) - Number(right[0])) <= 1e-5
    && Math.abs(Number(left[1]) - Number(right[1])) <= 1e-5;
}

function elevationsMeet(left, right) {
  if (left == null || right == null) return true;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return true;
  return Math.abs(leftNumber - rightNumber) <= 1e-6;
}

function trackEndpointsMeet(left, right) {
  if (!left || !right) return true;
  return coordinatesMeet(left.coords, right.coords)
    && elevationsMeet(left.elevation, right.elevation);
}

function comboPathIsDelivered(combo, availableTracksById) {
  let previousEnd = null;
  for (const segment of combo?.path ?? []) {
    const track = availableTracksById.get(String(segment?.trackId));
    if (!track) return false;
    const endpoints = trackPathEndpoints(track, Boolean(segment?.reversed));
    if (endpoints && previousEnd && !trackEndpointsMeet(previousEnd, endpoints.start)) return false;
    previousEnd = endpoints?.end ?? null;
  }
  return true;
}

function routeEdgeIsDelivered(nodes, combos, edgeIndex, availableTracksById) {
  const leftId = routeNodeId(nodes?.[edgeIndex]);
  const rightId = routeNodeId(nodes?.[edgeIndex + 1]);
  if (!leftId || !rightId) return false;
  const combo = routeEdgeCombo(combos, edgeIndex, leftId, rightId);
  // A missing combo is left for native preview pathfinding to construct. An
  // existing combo whose path leaves the projection is a known hard boundary.
  if (!combo) return true;
  return comboPathIsDelivered(combo, availableTracksById);
}

function contiguousAvailableNodeRuns(nodes, availableNodeIds, combos = [], availableTracksById = new Map()) {
  const runs = [];
  let current = null;
  for (let index = 0; index < (nodes ?? []).length; index++) {
    const node = nodes[index];
    if (!availableNodeIds.has(routeNodeId(node))) {
      current = null;
      continue;
    }
    const separatedByUndeliveredEdge = current
      && !routeEdgeIsDelivered(nodes, combos, index - 1, availableTracksById);
    if (!current || separatedByUndeliveredEdge) {
      current = { start: index, end: index, nodes: [] };
      runs.push(current);
    }
    current.end = index;
    current.nodes.push(node);
  }
  return runs;
}

function squaredNodeDistance(left, right) {
  const a = left?.center ?? left?.coords;
  const b = right?.center ?? right?.coords;
  if (!Array.isArray(a) || !Array.isArray(b)) return Infinity;
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

function endpointGraphKey(endpoint) {
  const coords = endpoint?.coords;
  const elevation = Number(endpoint?.elevation);
  if (!Array.isArray(coords) || coords.length < 2
    || !Number.isFinite(Number(coords[0])) || !Number.isFinite(Number(coords[1]))
    || !Number.isFinite(elevation)) return null;
  return `${Number(coords[0]).toFixed(5)},${Number(coords[1]).toFixed(5)}@${elevation.toFixed(6)}`;
}

function nodeTrackEndpointKeys(node, tracksById) {
  const center = node?.center ?? node?.coords;
  const keys = new Set();
  for (const trackId of node?.trackIds ?? []) {
    const endpoints = trackPathEndpoints(tracksById.get(String(trackId)), false);
    for (const endpoint of [endpoints?.start, endpoints?.end]) {
      if (coordinatesMeet(center, endpoint?.coords)) {
        const key = endpointGraphKey(endpoint);
        if (key) keys.add(key);
      }
    }
  }
  return keys;
}

function addGraphEdge(adjacency, from, to, weight) {
  const edges = adjacency.get(from) ?? [];
  edges.push({ to, weight });
  adjacency.set(from, edges);
}

function nativeCoordinateKey(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const longitude = Number(Number(coords[0]).toFixed(6));
  const latitude = Number(Number(coords[1]).toFixed(6));
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return `${latitude < 0 ? 'S' : ''}${longitude}-${Math.abs(latitude)}`;
}

/**
 * Mirrors Subway Builder's getPathBetweenStNodes cost model closely enough to
 * select the same delivered side of a clipped route. Most importantly, this
 * reads the game's directed trackGraph instead of inventing reverse edges from
 * track geometry. The latter made a physically-near but wrong-way platform
 * look reachable even though native route generation rejected it.
 */
function nativeTrackGraphDistance(state, startNode, endNode) {
  const trackGraph = state?.trackGraph;
  if (!(trackGraph instanceof Map) || trackGraph.size === 0) return null;
  const startKey = nativeCoordinateKey(startNode?.center ?? startNode?.coords);
  const endKey = nativeCoordinateKey(endNode?.center ?? endNode?.coords);
  if (!startKey || !endKey) return Infinity;
  if (startKey === endKey) return 0;

  const platformTrackIds = new Set((state?.stNodes ?? [])
    .flatMap((node) => node?.trackIds ?? [])
    .map(String));
  const distances = new Map([[startKey, 0]]);
  const queue = [{ key: startKey, distance: 0 }];
  while (queue.length > 0) {
    queue.sort((left, right) => left.distance - right.distance);
    const current = queue.shift();
    if (current.distance !== distances.get(current.key)) continue;
    if (current.key === endKey) return current.distance;
    for (const edge of trackGraph.get(current.key) ?? []) {
      const nextKey = String(edge?.coordsString ?? '');
      if (!nextKey) continue;
      const weight = 1
        + (platformTrackIds.has(String(edge?.trackId)) ? NATIVE_PASS_THROUGH_PLATFORM_PENALTY : 0)
        + ((edge?.trackIsReversed ?? edge?.reversed) ? NATIVE_TURNBACK_WRONG_WAY_PENALTY : 0);
      const nextDistance = current.distance + weight;
      if (nextDistance >= (distances.get(nextKey) ?? Infinity)) continue;
      distances.set(nextKey, nextDistance);
      queue.push({ key: nextKey, distance: nextDistance });
    }
  }
  return Infinity;
}

function nativeDirectedTrackPath(state, startNode, endNode) {
  const trackGraph = state?.trackGraph;
  if (!(trackGraph instanceof Map) || trackGraph.size === 0) return null;
  const startKey = nativeCoordinateKey(startNode?.center ?? startNode?.coords);
  const endKey = nativeCoordinateKey(endNode?.center ?? endNode?.coords);
  if (!startKey || !endKey || startKey === endKey) return null;
  const platformTrackIds = new Set((state?.stNodes ?? [])
    .flatMap((node) => node?.trackIds ?? [])
    .map(String));
  const distances = new Map([[startKey, 0]]);
  const previous = new Map();
  const queue = [{ key: startKey, distance: 0 }];
  while (queue.length > 0) {
    queue.sort((left, right) => left.distance - right.distance);
    const current = queue.shift();
    if (current.distance !== distances.get(current.key)) continue;
    if (current.key === endKey) {
      const path = [];
      let cursor = endKey;
      while (cursor !== startKey) {
        const step = previous.get(cursor);
        if (!step) return null;
        path.push({
          trackId: String(step.edge.trackId),
          reversed: Boolean(step.edge.trackIsReversed ?? step.edge.reversed),
          length: Number(step.edge.trackLength ?? step.edge.length) || 0,
          signals: [],
        });
        cursor = step.from;
      }
      return path.reverse();
    }
    for (const edge of trackGraph.get(current.key) ?? []) {
      const nextKey = String(edge?.coordsString ?? '');
      if (!nextKey) continue;
      const weight = 1
        + (platformTrackIds.has(String(edge?.trackId)) ? NATIVE_PASS_THROUGH_PLATFORM_PENALTY : 0)
        + ((edge?.trackIsReversed ?? edge?.reversed) ? NATIVE_TURNBACK_WRONG_WAY_PENALTY : 0);
      const nextDistance = current.distance + weight;
      if (nextDistance >= (distances.get(nextKey) ?? Infinity)) continue;
      distances.set(nextKey, nextDistance);
      previous.set(nextKey, { from: current.key, edge });
      queue.push({ key: nextKey, distance: nextDistance });
    }
  }
  return null;
}

function attachSignalsToPath(path, signals) {
  return path.map((segment) => ({
    ...segment,
    signals: (signals ?? []).flatMap((signal) => {
      const signalTrack = (signal?.signalTracks ?? [])
        .find(({ trackId }) => String(trackId) === String(segment.trackId));
      return signalTrack ? [{ signalId: signal.id, areaCovered: signalTrack.areaCovered }] : [];
    }),
  }));
}

function buildNativeDirectedCombo(state, startNode, endNode) {
  let path = nativeDirectedTrackPath(state, startNode, endNode);
  if (!path?.length) return null;
  const tracksById = new Map((state?.tracks ?? [])
    .filter((track) => entityId(track))
    .map((track) => [entityId(track), track]));
  const outerEndpoint = (node, trackId) => {
    const endpoints = trackPathEndpoints(tracksById.get(String(trackId)), false);
    return [endpoints?.start, endpoints?.end]
      .find((endpoint) => !coordinatesMeet(endpoint?.coords, node?.center ?? node?.coords))?.coords ?? null;
  };
  const startMissing = (startNode?.trackIds ?? [])
    .map(String).filter((trackId) => trackId !== String(path[0]?.trackId));
  if (startMissing.length === 1) {
    const coords = outerEndpoint(startNode, startMissing[0]);
    const prefix = coords && nativeDirectedTrackPath(state, { center: coords }, startNode);
    if (prefix?.length) path = [...prefix, ...path];
  }
  const endMissing = (endNode?.trackIds ?? [])
    .map(String).filter((trackId) => trackId !== String(path.at(-1)?.trackId));
  if (endMissing.length === 1) {
    const coords = outerEndpoint(endNode, endMissing[0]);
    const suffix = coords && nativeDirectedTrackPath(state, endNode, { center: coords });
    if (suffix?.length) path = [...path, ...suffix];
  }
  const signaledPath = attachSignalsToPath(path, state?.signals);
  return {
    startStNodeId: routeNodeId(startNode),
    endStNodeId: routeNodeId(endNode),
    path: signaledPath,
    distance: signaledPath.reduce((total, segment) => total + (Number(segment.length) || 0), 0),
  };
}

function buildDirectedLocalRoute(localizedRoute, state, addedNode) {
  const insertion = insertAddedNodeByDirectedReachability(localizedRoute, state, addedNode);
  if (insertion.insertionIndex === null) return { ...insertion, route: null, failedEdge: null };
  const existingCombos = localizedRoute?.stCombos ?? [];
  const combos = [];
  for (let index = 0; index < insertion.route.stNodes.length - 1; index++) {
    const startNode = insertion.route.stNodes[index];
    const endNode = insertion.route.stNodes[index + 1];
    const existing = existingCombos.find((combo) => (
      String(combo?.startStNodeId) === routeNodeId(startNode)
      && String(combo?.endStNodeId) === routeNodeId(endNode)
    ));
    const combo = existing ?? buildNativeDirectedCombo(state, startNode, endNode);
    if (!combo) {
      return {
        ...insertion,
        route: null,
        failedEdge: `${routeNodeId(startNode)}->${routeNodeId(endNode)}`,
      };
    }
    combos.push(combo);
  }
  const trackIds = [...new Set([
    ...(localizedRoute?.trackIds ?? []).map(String),
    ...combos.flatMap((combo) => (combo?.path ?? []).map(({ trackId }) => String(trackId))),
  ])];
  return {
    ...insertion,
    route: { ...insertion.route, stCombos: combos, trackIds },
    failedEdge: null,
  };
}

function shortestDeliveredTrackDistance(state, startNode, endNode) {
  const tracksById = new Map((state?.tracks ?? [])
    .filter((track) => entityId(track))
    .map((track) => [entityId(track), track]));
  const startKeys = nodeTrackEndpointKeys(startNode, tracksById);
  const endKeys = nodeTrackEndpointKeys(endNode, tracksById);
  if (startKeys.size === 0 || endKeys.size === 0) return Infinity;

  const platformTrackIds = new Set((state?.stNodes ?? [])
    .flatMap((node) => node?.trackIds ?? [])
    .map(String));
  const permittedPlatformTrackIds = new Set([
    ...(startNode?.trackIds ?? []),
    ...(endNode?.trackIds ?? []),
  ].map(String));
  const adjacency = new Map();
  for (const [trackId, track] of tracksById) {
    if (platformTrackIds.has(trackId) && !permittedPlatformTrackIds.has(trackId)) continue;
    const endpoints = trackPathEndpoints(track, false);
    const startKey = endpointGraphKey(endpoints?.start);
    const endKey = endpointGraphKey(endpoints?.end);
    if (!startKey || !endKey) continue;
    const weight = Number.isFinite(Number(track?.length)) ? Math.max(Number(track.length), 0) : 1;
    addGraphEdge(adjacency, startKey, endKey, weight);
    addGraphEdge(adjacency, endKey, startKey, weight);
  }

  const distances = new Map([...startKeys].map((key) => [key, 0]));
  const queue = [...startKeys].map((key) => ({ key, distance: 0 }));
  while (queue.length > 0) {
    queue.sort((left, right) => left.distance - right.distance);
    const current = queue.shift();
    if (current.distance !== distances.get(current.key)) continue;
    if (endKeys.has(current.key)) return current.distance;
    for (const edge of adjacency.get(current.key) ?? []) {
      const nextDistance = current.distance + edge.weight;
      if (nextDistance >= (distances.get(edge.to) ?? Infinity)) continue;
      distances.set(edge.to, nextDistance);
      queue.push({ key: edge.to, distance: nextDistance });
    }
  }
  return Infinity;
}

function selectEditableNodeRun(runs, state) {
  if (runs.length <= 1) return runs[0] ?? { start: 0, end: -1, nodes: [] };
  const changes = state?.pendingStNodeChanges ?? [];
  const removedIds = new Set(changes.filter(({ action }) => action === 'remove').map(({ stNodeId }) => String(stNodeId)));
  const removalRun = runs.find((run) => run.nodes.some((node) => removedIds.has(routeNodeId(node))));
  if (removalRun) return removalRun;
  const addedNodes = changes.filter(({ action }) => action === 'add')
    .map(({ stNodeId }) => (state?.stNodes ?? []).find((node) => entityId(node) === String(stNodeId)))
    .filter(Boolean);
  const nativeScoreCache = new Map();
  const runNativeScore = (run) => {
    if (nativeScoreCache.has(run)) return nativeScoreCache.get(run);
    const pairs = run.nodes.flatMap((node) => addedNodes.map((added) => ({
      forward: nativeTrackGraphDistance(state, added, node),
      reverse: nativeTrackGraphDistance(state, node, added),
    })));
    const graphAvailable = pairs.some(({ forward, reverse }) => forward !== null || reverse !== null);
    const bidirectional = pairs.filter(({ forward, reverse }) => (
      Number.isFinite(forward) && Number.isFinite(reverse)
    ));
    const unidirectional = pairs.filter(({ forward, reverse }) => (
      Number.isFinite(forward) || Number.isFinite(reverse)
    ));
    const score = {
      graphAvailable,
      reachability: bidirectional.length > 0 ? 0 : (unidirectional.length > 0 ? 1 : 2),
      distance: bidirectional.length > 0
        ? Math.min(...bidirectional.map(({ forward, reverse }) => forward + reverse))
        : Math.min(...unidirectional.map(({ forward, reverse }) => Math.min(forward, reverse)), Infinity),
    };
    nativeScoreCache.set(run, score);
    return score;
  };
  const trackDistanceCache = new Map();
  const runTrackDistance = (run) => {
    if (trackDistanceCache.has(run)) return trackDistanceCache.get(run);
    const distance = Math.min(...run.nodes.flatMap((node) => (
      addedNodes.map((added) => shortestDeliveredTrackDistance(state, node, added))
    )));
    trackDistanceCache.set(run, distance);
    return distance;
  };
  return [...runs].sort((left, right) => {
    if (addedNodes.length > 0) {
      const leftNativeScore = runNativeScore(left);
      const rightNativeScore = runNativeScore(right);
      if (leftNativeScore.graphAvailable || rightNativeScore.graphAvailable) {
        if (leftNativeScore.reachability !== rightNativeScore.reachability) {
          return leftNativeScore.reachability - rightNativeScore.reachability;
        }
        if (leftNativeScore.distance !== rightNativeScore.distance) {
          return leftNativeScore.distance - rightNativeScore.distance;
        }
      }
      const leftTrackDistance = runTrackDistance(left);
      const rightTrackDistance = runTrackDistance(right);
      if (Number.isFinite(leftTrackDistance) || Number.isFinite(rightTrackDistance)) {
        if (!Number.isFinite(leftTrackDistance)) return 1;
        if (!Number.isFinite(rightTrackDistance)) return -1;
        if (leftTrackDistance !== rightTrackDistance) return leftTrackDistance - rightTrackDistance;
      }
      const leftDistance = Math.min(...left.nodes.flatMap((node) => addedNodes.map((added) => squaredNodeDistance(node, added))));
      const rightDistance = Math.min(...right.nodes.flatMap((node) => addedNodes.map((added) => squaredNodeDistance(node, added))));
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    }
    return right.nodes.length - left.nodes.length || left.start - right.start;
  })[0];
}

function clippedRouteRunDiagnostics(route, state) {
  const globalRoute = route?.openWorldGlobalRoute ?? route;
  const availableNodeIds = new Set((state?.stNodes ?? []).map(entityId).filter(Boolean));
  const availableTracksById = new Map((state?.tracks ?? [])
    .filter((track) => entityId(track))
    .map((track) => [entityId(track), track]));
  const runs = contiguousAvailableNodeRuns(
    globalRoute?.stNodes ?? [],
    availableNodeIds,
    globalRoute?.stCombos ?? [],
    availableTracksById,
  );
  const addedNodes = (state?.pendingStNodeChanges ?? [])
    .filter(({ action }) => action === 'add')
    .map(({ stNodeId }) => (state?.stNodes ?? []).find((node) => entityId(node) === String(stNodeId)))
    .filter(Boolean);
  const printableDistance = (distance) => (Number.isFinite(distance) ? distance : null);
  return {
    trackGraphSize: state?.trackGraph instanceof Map ? state.trackGraph.size : null,
    runs: runs.map((run) => ({
      start: run.start,
      end: run.end,
      nodes: run.nodes.map(routeNodeId),
      addedNodePaths: addedNodes.map((added) => ({
        addedNodeId: entityId(added),
        candidates: run.nodes.map((node) => {
          const forward = nativeTrackGraphDistance(state, added, node);
          const reverse = nativeTrackGraphDistance(state, node, added);
          return {
            nodeId: routeNodeId(node),
            addedToCandidate: printableDistance(forward),
            candidateToAdded: printableDistance(reverse),
            addedToCandidateReachable: Number.isFinite(forward),
            candidateToAddedReachable: Number.isFinite(reverse),
          };
        }),
      })),
    })),
  };
}

function insertAddedNodeByDirectedReachability(localizedRoute, state, addedNode) {
  const nodes = localizedRoute?.stNodes ?? [];
  if (!addedNode || nodes.some((node) => routeNodeId(node) === entityId(addedNode))) {
    return { route: localizedRoute, insertionIndex: null, cost: null };
  }
  const candidates = [];
  for (let index = 0; index <= nodes.length; index++) {
    const leftDistance = index > 0
      ? nativeTrackGraphDistance(state, nodes[index - 1], addedNode)
      : 0;
    const rightDistance = index < nodes.length
      ? nativeTrackGraphDistance(state, addedNode, nodes[index])
      : 0;
    if (!Number.isFinite(leftDistance) || !Number.isFinite(rightDistance)) continue;
    candidates.push({ index, cost: leftDistance + rightDistance });
  }
  const selected = candidates.sort((left, right) => left.cost - right.cost || left.index - right.index)[0];
  if (!selected) return { route: localizedRoute, insertionIndex: null, cost: null };
  const orderedNodes = structuredClone(nodes);
  orderedNodes.splice(selected.index, 0, structuredClone(addedNode));
  return {
    route: { ...structuredClone(localizedRoute), stNodes: orderedNodes },
    insertionIndex: selected.index,
    cost: selected.cost,
  };
}

function replaceIndexedLocalRun(globalValues, localizedRoute, newLocalValues) {
  const range = localizedRoute?.openWorldLocalNodeRange;
  if (!Number.isSafeInteger(range?.start) || !Number.isSafeInteger(range?.end)
    || range.start < 0 || range.end < range.start || range.end >= (globalValues ?? []).length) {
    return replaceLocalSequence(globalValues, localizedRoute?.stNodes, newLocalValues);
  }
  return [
    ...(globalValues ?? []).slice(0, range.start).map((value) => structuredClone(value)),
    ...(newLocalValues ?? []).map((value) => structuredClone(value)),
    ...(globalValues ?? []).slice(range.end + 1).map((value) => structuredClone(value)),
  ];
}

function comboKey(combo) {
  return `${String(combo?.startStNodeId ?? '')}->${String(combo?.endStNodeId ?? '')}`;
}

function replaceLocalCombos(globalCombos, oldLocalNodes, newLocalCombos) {
  const localIds = new Set((oldLocalNodes ?? []).map(routeNodeId).filter(Boolean));
  const replaceable = (combo) => localIds.has(String(combo?.startStNodeId)) && localIds.has(String(combo?.endStNodeId));
  const firstLocalIndex = (globalCombos ?? []).findIndex(replaceable);
  if (firstLocalIndex < 0) return [...(globalCombos ?? []), ...(newLocalCombos ?? [])].map((value) => structuredClone(value));
  const retained = (globalCombos ?? []).filter((combo) => !replaceable(combo));
  const insertionIndex = (globalCombos ?? []).slice(0, firstLocalIndex).filter((combo) => !replaceable(combo)).length;
  const additions = (newLocalCombos ?? []).filter((combo, index, all) => (
    all.findIndex((candidate) => comboKey(candidate) === comboKey(combo)) === index
  ));
  retained.splice(insertionIndex, 0, ...additions.map((value) => structuredClone(value)));
  return retained;
}

function localizeDormantRoute(route, state, preferredRange = null) {
  const globalRoute = route?.openWorldGlobalRoute ?? route;
  const availableNodeIds = new Set((state?.stNodes ?? []).map(entityId).filter(Boolean));
  const availableTracksById = new Map((state?.tracks ?? [])
    .filter((track) => entityId(track))
    .map((track) => [entityId(track), track]));
  const availableTrackIds = new Set(availableTracksById.keys());
  const availableStationIds = new Set((state?.stations ?? []).map(entityId).filter(Boolean));
  const globalNodes = globalRoute?.stNodes ?? [];
  const preferredNodes = Number.isSafeInteger(preferredRange?.start)
    && Number.isSafeInteger(preferredRange?.end)
    && preferredRange.start >= 0
    && preferredRange.end >= preferredRange.start
    && preferredRange.end < globalNodes.length
    ? globalNodes.slice(preferredRange.start, preferredRange.end + 1)
    : [];
  const editableRun = preferredNodes.length > 0
    && preferredNodes.every((node) => availableNodeIds.has(routeNodeId(node)))
    ? { start: preferredRange.start, end: preferredRange.end, nodes: preferredNodes }
    : selectEditableNodeRun(
      contiguousAvailableNodeRuns(
        globalNodes,
        availableNodeIds,
        globalRoute?.stCombos ?? [],
        availableTracksById,
      ),
      state,
    );
  const localNodes = editableRun.nodes;
  const localNodeIds = new Set(localNodes.map(routeNodeId));
  const localCombos = (globalRoute?.stCombos ?? []).filter((combo) => (
    localNodeIds.has(String(combo?.startStNodeId))
    && localNodeIds.has(String(combo?.endStNodeId))
    && (combo?.path ?? []).every((segment) => availableTrackIds.has(String(segment?.trackId)))
  ));
  return {
    ...structuredClone(route),
    stNodes: structuredClone(localNodes),
    stCombos: structuredClone(localCombos),
    openWorldLocalNodeRange: { start: editableRun.start, end: editableRun.end },
    ...(Array.isArray(globalRoute?.trackIds) ? {
      trackIds: globalRoute.trackIds.filter((trackId) => availableTrackIds.has(String(trackId))),
    } : {}),
    ...(Array.isArray(globalRoute?.stationIds) ? {
      stationIds: globalRoute.stationIds.filter((stationId) => availableStationIds.has(String(stationId))),
    } : {}),
  };
}

function makeEditableLocalizedRoute(route, state) {
  const globalRoute = structuredClone(route?.openWorldGlobalRoute ?? route);
  const localized = localizeDormantRoute(route, state);
  localized.openWorldProjectionDormant = true;
  localized.openWorldProjectionLocalEdit = true;
  localized.openWorldGlobalRoute = globalRoute;
  return localized;
}

function routePanelFacadeTimings(globalRoute, visibleNodes) {
  const projected = projectRouteTimings(globalRoute, visibleNodes);
  if (projected.length > 0) return projected;

  // RouteStationsView selects previewRoute only when this array is nonempty.
  // Native removal clears timings before our guarded batch runs; leaving it
  // empty makes React fall back to the stale full-route prop and reintroduces
  // clipped-away terminal nodes into convertRouteToRaptorRoutes.
  if (visibleNodes.length === 0) {
    return [{
      stNodeId: null,
      stNodeIndex: 0,
      arrivalTime: 0,
      departureTime: 0,
      openWorldFacadeSentinel: true,
    }];
  }

  const canonicalNodes = globalRoute?.stNodes ?? [];
  const timingByNodeId = new Map();
  for (const timing of globalRoute?.stComboTimings ?? []) {
    const id = timing?.stNodeId ?? canonicalNodes[Number(timing?.stNodeIndex)]?.id;
    if (id != null && !timingByNodeId.has(String(id))) timingByNodeId.set(String(id), timing);
  }
  let previousTime = 0;
  const timings = visibleNodes.map((node, index) => {
    const source = timingByNodeId.get(routeNodeId(node));
    const arrivalTime = Number.isFinite(Number(source?.arrivalTime))
      ? Number(source.arrivalTime)
      : previousTime;
    const departureTime = Number.isFinite(Number(source?.departureTime))
      ? Math.max(arrivalTime, Number(source.departureTime))
      : arrivalTime;
    previousTime = departureTime;
    return {
      ...structuredClone(source ?? {}),
      stNodeId: routeNodeId(node),
      stNodeIndex: index,
      arrivalTime,
      departureTime,
      openWorldFacadeFallback: source == null,
    };
  });
  const offset = Number(timings[0]?.arrivalTime) || 0;
  return timings.map((timing) => ({
    ...timing,
    arrivalTime: timing.arrivalTime - offset,
    departureTime: timing.departureTime - offset,
  }));
}

/**
 * Mirrors Subway Builder 1.6.0's findRouteSplitIndices. The native RAPTOR
 * converter starts a new split when a station is visited twice and closes a
 * split only when the route's final node resolves through stations[].stNodeIds.
 * An unresolved final node therefore leaves stNodeEndIndex null and the route
 * panel throws before its error boundary can recover.
 */
function inspectNativeRouteOrder(route, stations) {
  const nodes = route?.stNodes ?? [];
  if (nodes.length < 2) return {
    valid: true,
    reason: null,
    splits: [],
    missingStationNodeIds: [],
  };

  const stationByNodeId = new Map();
  for (const station of stations ?? []) {
    for (const stNodeId of station?.stNodeIds ?? []) {
      stationByNodeId.set(String(stNodeId), station);
    }
  }

  const seenStationIds = new Set();
  const missingStationNodeIds = [];
  const splits = [{ stNodeStartIndex: 0, stNodeEndIndex: null }];
  for (let index = 0; index < nodes.length; index++) {
    const nodeId = routeNodeId(nodes[index]);
    const station = stationByNodeId.get(nodeId);
    if (!station) {
      missingStationNodeIds.push(nodeId);
      continue;
    }

    const currentSplit = splits.find(({ stNodeEndIndex }) => stNodeEndIndex === null);
    if (!currentSplit) return {
      valid: false,
      reason: 'missing-current-route-split',
      splits,
      missingStationNodeIds,
    };

    if (index === nodes.length - 1) {
      currentSplit.stNodeEndIndex = index;
      continue;
    }

    const stationId = String(station.id);
    if (seenStationIds.has(stationId)) {
      currentSplit.stNodeEndIndex = index - 1;
      splits.push({ stNodeStartIndex: index - 1, stNodeEndIndex: null });
      seenStationIds.clear();
      seenStationIds.add(stationId);
      continue;
    }
    seenStationIds.add(stationId);
  }

  const valid = splits.every(({ stNodeEndIndex }) => stNodeEndIndex !== null);
  return {
    valid,
    reason: valid ? null : 'open-final-route-split',
    splits,
    missingStationNodeIds: [...new Set(missingStationNodeIds)],
  };
}

function makeDeliveredMultiRunPresentation(route, state) {
  const globalRoute = structuredClone(route?.openWorldGlobalRoute ?? route);
  const availableNodeIds = new Set((state?.stations ?? [])
    .flatMap((station) => station?.stNodeIds ?? [])
    .map(String));
  const availableTrackIds = new Set((state?.tracks ?? []).map(entityId).filter(Boolean));
  const availableStationIds = new Set((state?.stations ?? []).map(entityId).filter(Boolean));
  const visibleNodes = (globalRoute.stNodes ?? [])
    .filter((node) => availableNodeIds.has(routeNodeId(node)))
    .map((node) => structuredClone(node));
  return {
    ...structuredClone(route),
    stNodes: visibleNodes,
    stCombos: (globalRoute.stCombos ?? [])
      .filter((combo) => (combo?.path ?? [])
        .every(({ trackId }) => availableTrackIds.has(String(trackId))))
      .map((combo) => structuredClone(combo)),
    stComboTimings: routePanelFacadeTimings(globalRoute, visibleNodes),
    ...(Array.isArray(globalRoute.trackIds) ? {
      trackIds: globalRoute.trackIds.filter((trackId) => availableTrackIds.has(String(trackId))),
    } : {}),
    ...(Array.isArray(globalRoute.stationIds) ? {
      stationIds: globalRoute.stationIds
        .filter((stationId) => availableStationIds.has(String(stationId))),
    } : {}),
    openWorldProjectionDormant: true,
    openWorldProjectionLocalEdit: true,
    openWorldMultiRunPresentation: true,
    openWorldGlobalRoute: globalRoute,
  };
}

function normalizeDeliveredCanonicalRoute(route, state) {
  const source = structuredClone(route);
  const repaired = repairRouteTimingIntegrity(source).route;
  const sourceComboKeys = new Set((source.stCombos ?? []).map(comboKey));
  const availableNodeIds = new Set((state?.stNodes ?? []).map(entityId).filter(Boolean));
  const availableTrackIds = new Set((state?.tracks ?? []).map(entityId).filter(Boolean));
  let rebuiltEdges = 0;
  repaired.stCombos = (repaired.stCombos ?? []).map((combo, index) => {
    const startNode = repaired.stNodes?.[index];
    const endNode = repaired.stNodes?.[index + 1];
    if (!startNode || !endNode
      || !availableNodeIds.has(routeNodeId(startNode))
      || !availableNodeIds.has(routeNodeId(endNode))) return combo;
    const pathIsDelivered = (combo?.path ?? []).length > 0
      && combo.path.every(({ trackId }) => availableTrackIds.has(String(trackId)));
    const wasConsecutive = sourceComboKeys.has(`${routeNodeId(startNode)}->${routeNodeId(endNode)}`);
    if (wasConsecutive && pathIsDelivered) return combo;
    const rebuilt = buildNativeDirectedCombo(state, startNode, endNode);
    if (!rebuilt) return combo;
    rebuiltEdges++;
    return rebuilt;
  });
  return {
    route: repaired,
    rebuiltEdges,
    changed: rebuiltEdges > 0
      || JSON.stringify([source.stCombos, source.stComboTimings])
        !== JSON.stringify([repaired.stCombos, repaired.stComboTimings]),
  };
}

function mergeLocalizedRoute(originalRoute, localizedRoute, updatedLocalRoute, state) {
  const globalRoute = structuredClone(originalRoute?.openWorldGlobalRoute ?? originalRoute);
  const updated = structuredClone(updatedLocalRoute);
  const merged = { ...globalRoute };
  for (const [key, value] of Object.entries(updated)) {
    if (key.startsWith('openWorld') || ['stNodes', 'stCombos', 'trackIds', 'stationIds'].includes(key)) continue;
    merged[key] = structuredClone(value);
  }
  merged.stNodes = replaceIndexedLocalRun(globalRoute.stNodes, localizedRoute, updated.stNodes);
  merged.stCombos = replaceLocalCombos(globalRoute.stCombos, localizedRoute.stNodes, updated.stCombos);
  if (Array.isArray(globalRoute.trackIds) && Array.isArray(updated.trackIds)) {
    merged.trackIds = replaceLocalSequence(
      globalRoute.trackIds.map((id) => ({ id })),
      (localizedRoute.trackIds ?? []).map((id) => ({ id })),
      updated.trackIds.map((id) => ({ id })),
    ).map(({ id }) => id);
  }
  if (Array.isArray(globalRoute.stationIds) && Array.isArray(updated.stationIds)) {
    merged.stationIds = replaceLocalSequence(
      globalRoute.stationIds.map((id) => ({ id })),
      (localizedRoute.stationIds ?? []).map((id) => ({ id })),
      updated.stationIds.map((id) => ({ id })),
    ).map(({ id }) => id);
  }
  const integrity = repairRouteTimingIntegrity(merged);
  merged.stCombos = integrity.route.stCombos;
  merged.stComboTimings = integrity.route.stComboTimings;

  const editedRange = {
    start: localizedRoute.openWorldLocalNodeRange.start,
    end: localizedRoute.openWorldLocalNodeRange.start + (updated.stNodes?.length ?? 0) - 1,
  };
  const facade = localizeDormantRoute({
    ...merged,
    openWorldProjectionDormant: true,
    openWorldProjectionLocalEdit: true,
    openWorldGlobalRoute: structuredClone(merged),
  }, state, editedRange);
  facade.openWorldProjectionDormant = true;
  facade.openWorldProjectionLocalEdit = true;
  facade.openWorldGlobalRoute = structuredClone(merged);
  return facade;
}

function methodsOf(object) {
  return Object.keys(object ?? {}).filter((name) => typeof object[name] === 'function').sort();
}

function validSave(snapshot) {
  const data = snapshot?.data;
  return Boolean(
    snapshot && typeof snapshot === 'object' && data && typeof data === 'object'
    && Array.isArray(data.routes) && Array.isArray(data.tracks)
    && Array.isArray(data.stations) && Array.isArray(data.trains),
  );
}

function bindSnapshotToCity(snapshot, cityCode, cityUid = cityCode) {
  if (!cityCode) return snapshot;
  const boundCityUid = cityUid || cityCode;
  if (snapshot?.cityCode === cityCode && snapshot?.cityUid === boundCityUid) return snapshot;
  const rebound = structuredClone(snapshot);
  rebound.cityCode = cityCode;
  rebound.cityUid = boundCityUid;
  if (rebound.data && Object.hasOwn(rebound.data, 'cityCode')) rebound.data.cityCode = cityCode;
  if (rebound.data && Object.hasOwn(rebound.data, 'cityUid')) rebound.data.cityUid = boundCityUid;
  if (rebound.metadata && Object.hasOwn(rebound.metadata, 'cityCode')) rebound.metadata.cityCode = cityCode;
  if (rebound.metadata && Object.hasOwn(rebound.metadata, 'cityUid')) rebound.metadata.cityUid = boundCityUid;
  return rebound;
}

const DEMAND_STATE_KEYS = Object.freeze([
  'compressedDemandData',
  'savedDemandData',
  'popMovementsMap',
  'completedCommutes',
]);

/**
 * Keep only state that belongs to the player's tile-local network.
 *
 * Subway Builder's native save embeds a compressed copy of the entire demand
 * model. For a generated tile that payload is hundreds of megabytes even when
 * the player has built nothing. Demand is static tile-package data in this
 * prototype, so it is reloaded by StoreInitializer instead of duplicated in
 * every tile snapshot.
 */
export function compactNativeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const data = { ...(snapshot.data ?? {}) };
  for (const key of DEMAND_STATE_KEYS) delete data[key];
  return {
    ...snapshot,
    data,
    routeThumbnail: undefined,
    timelapse: snapshot.timelapse
      ? { ...snapshot.timelapse, frames: [] }
      : snapshot.timelapse,
  };
}

function nativeCityDataFiles(cityCode, dataFiles) {
  if (!/^[A-Za-z0-9_-]+$/.test(cityCode)) throw new Error(`Invalid tile city code: ${cityCode}`);
  return Object.fromEntries(Object.entries(dataFiles).map(([key, rawValue]) => {
    if (typeof rawValue !== 'string' || !rawValue.length) throw new Error(`Invalid tile data file: ${key}`);
    const value = rawValue.replaceAll('\\', '/').replace(/^\.\//, '');
    if (value.startsWith('/data/')) return [key, value];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|[A-Za-z]:)/i.test(value) || value.split('/').includes('..')) {
      throw new Error(`Tile data file must be relative or use /data/: ${key}`);
    }
    return [key, `/data/${cityCode}/${value}`];
  }));
}

export class SubwayBuilderGameAdapter {
  constructor({
    api = globalThis.SubwayBuilderAPI,
    callbacks = globalThis.__subwayBuilder_storeCallbacks__,
    expectedApiVersion = '1.0.0',
    inspectedGameVersion = '1.7.0',
    nativeSaveLifecycle = null,
  } = {}) {
    this.api = api;
    this.callbacks = callbacks;
    this.expectedApiVersion = expectedApiVersion;
    this.inspectedGameVersion = inspectedGameVersion;
    this.nativeSaveLifecycle = nativeSaveLifecycle;
    this.capability = null;
    this.currentPackage = null;
    this.loadedCityCode = null;
    this.nativeMinTransitChoice = null;
    this.lodesTransitFloorActive = false;
    this.nativeNetworkMode = null;
    this.financeOwnedRouteIds = new Set();
    this.financeOwnedTrackIds = new Set();
    this.financeOwnedInfrastructureHourlyByCategory = new Map();
    this.nativeFinanceAccountingRouteIds = new Set();
    this.nativeFinanceAuditRouteIds = new Set();
    this.nativeFinanceAuditByHour = new Map();
    // Hot reload retains Zustand action functions. Remove the previous
    // profiler generation before mode/finance guards inspect or wrap them.
    prepareSimulationPerformanceDiagnostics(this.callbacks);
  }

  installSimulationPerformanceDiagnostics() {
    return installSimulationPerformanceDiagnostics(this.callbacks);
  }

  /**
   * Make the native game the sole owner of the complete transit topology.
   *
   * This is deliberately an activation seam instead of a constructor default:
   * the KC prototype still exercises the legacy clipped adapter, while the NY
   * entrypoint is the shipped canonical-native integration. The binding lives
   * on the shared callback object so a hot reload can make an existing wrapper
   * inert or rebind it without stacking another wrapper around native actions.
   */
  activateCanonicalNativeNetworkMode() {
    this.nativeNetworkMode = CANONICAL_NATIVE_NETWORK_MODE;
    const callbacks = this.callbacks;
    if (callbacks && (typeof callbacks === 'object' || typeof callbacks === 'function')) {
      callbacks[CANONICAL_NATIVE_MODE_BINDING] = CANONICAL_NATIVE_NETWORK_MODE;
    }

    // A previous generation may have left the tick wrapper in Zustand. Rebind
    // its mutable binding to this adapter; the wrapper itself checks the mode
    // and immediately delegates to the native action in canonical mode.
    const state = this.#state();
    const tick = state.handleIncrementGameState;
    const tickBinding = tick?.[CLIPPED_ROUTE_TICK_GUARD_BINDING];
    let reboundTickGuard = false;
    if (tick?.[CLIPPED_ROUTE_TICK_GUARD] && tickBinding) {
      tickBinding.adapter = this;
      tickBinding.callbacks = callbacks;
      reboundTickGuard = true;
    }

    // Preview wrappers retain their native implementations. Restore those
    // implementations if a prior hot reload installed the projection editor;
    // this removes the edit facade entirely instead of relying on a route
    // marker to make it harmless.
    let unwrappedPreviewGuards = false;
    const batch = state.batchPreviewRouteUpdates;
    const confirm = state.confirmRouteChange;
    const setPreview = state.setPreviewRoute;
    const nativeBatch = batch?.[CLIPPED_ROUTE_PREVIEW_EDIT_ORIGINAL_BATCH];
    const nativeConfirm = confirm?.[CLIPPED_ROUTE_PREVIEW_EDIT_ORIGINAL_CONFIRM];
    const nativeSetPreview = setPreview?.[CLIPPED_ROUTE_PREVIEW_EDIT_ORIGINAL_SET_PREVIEW];
    if (typeof nativeBatch === 'function') {
      state.batchPreviewRouteUpdates = nativeBatch;
      unwrappedPreviewGuards = true;
    }
    if (typeof nativeConfirm === 'function') {
      state.confirmRouteChange = nativeConfirm;
      unwrappedPreviewGuards = true;
    }
    if (typeof nativeSetPreview === 'function') {
      state.setPreviewRoute = nativeSetPreview;
      unwrappedPreviewGuards = true;
    }

    // The track-edit guard now retains its native implementation too. Older
    // unversioned wrappers have no recoverable original, but their new mode
    // binding and the canonical route payload make them inert on subsequent
    // calls.
    const tracks = state.setTracks;
    const nativeTracks = tracks?.[CLIPPED_ROUTE_TRACK_EDIT_ORIGINAL];
    let unwrappedTrackGuard = false;
    if (typeof nativeTracks === 'function') {
      state.setTracks = nativeTracks;
      unwrappedTrackGuard = true;
    }

    const interliningCache = installCanonicalNativeInterliningCache(this, state);
    state.setTimeConfig?.({});
    this.financeOwnedRouteIds.clear();
    this.financeOwnedTrackIds.clear();
    this.financeOwnedInfrastructureHourlyByCategory.clear();
    this.nativeFinanceAuditByHour.clear();
    return {
      mode: this.nativeNetworkMode,
      reboundTickGuard,
      unwrappedPreviewGuards,
      unwrappedTrackGuard,
      interliningCache,
      financeOwnership: 'native-observed',
    };
  }

  getInterliningRevision() {
    if (this.nativeNetworkMode !== CANONICAL_NATIVE_NETWORK_MODE) return null;
    try {
      const state = this.callbacks?.getState?.();
      let binding = state?.recalculateAllRouteGeojsons?.[CANONICAL_NATIVE_INTERLINING_CACHE_BINDING];
      if (!binding
        || state?.recalculateAllRouteGeojsons?.[CANONICAL_NATIVE_INTERLINING_CACHE_VERSION]
          !== CURRENT_CANONICAL_NATIVE_INTERLINING_CACHE_VERSION) {
        const repair = installCanonicalNativeInterliningCache(this, state);
        if (!repair.installed) return null;
        binding = state.recalculateAllRouteGeojsons?.[CANONICAL_NATIVE_INTERLINING_CACHE_BINDING];
        queueMicrotask(() => {
          try {
            const live = this.callbacks?.getState?.();
            if (live?.recalculateAllRouteGeojsons?.[CANONICAL_NATIVE_INTERLINING_CACHE_BINDING]
              === binding) {
              live.setTimeConfig?.({});
            }
          } catch {}
        });
      }
      const revision = binding?.cache?.revision;
      return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
    } catch {
      return null;
    }
  }

  /**
   * Rebase native route accounting at the canonical save boundary. This is
   * idempotent for a stable session/topology and intentionally leaves the
   * historical financial chart untouched.
   */
  rebaseNativeFinanceForCanonicalMode() {
    if (this.nativeNetworkMode !== CANONICAL_NATIVE_NETWORK_MODE) {
      return { changed: false, reason: 'non-canonical-mode' };
    }
    const state = this.#state();
    const result = rebaseNativeFinanceState(state);
    if (result.routeFinancialsChanged && typeof state.setRouteFinancials === 'function') {
      state.setRouteFinancials(result.routeFinancials);
    }
    if (result.financialHistoryChanged && typeof state.setFinancialHistory === 'function') {
      state.setFinancialHistory(result.financialHistory);
    }
    return result;
  }

  configureGlobalFinanceOwnership(manifest = {}) {
    const configuredRouteIds = new Set((manifest.financeOwnedRouteIds ?? []).map(String));
    const configuredTrackIds = new Set((manifest.financeOwnedTrackIds ?? []).map(String));
    const canonicalNative = this.nativeNetworkMode === CANONICAL_NATIVE_NETWORK_MODE;
    this.nativeFinanceAccountingRouteIds = configuredRouteIds;
    // In canonical mode these fields are diagnostics/accounting inputs only;
    // the native simulation must never be filtered by them.
    this.financeOwnedRouteIds = canonicalNative ? new Set() : configuredRouteIds;
    this.financeOwnedTrackIds = canonicalNative ? new Set() : configuredTrackIds;
    let trainTypes = [];
    try { trainTypes = this.api?.trains?.getTrainTypes?.() ?? []; } catch {}
    const projectedExpenseProfile = calculateGlobalExpenseProfile(
      manifest.baselineState ?? {},
      trainTypes,
      {
        financeOwnedRouteIds: [...configuredRouteIds],
        financeOwnedTrackIds: [...configuredTrackIds],
      },
    );
    this.financeOwnedInfrastructureHourlyByCategory = projectedExpenseProfile.infrastructureItems
      .filter((item) => item.financeOwned)
      .filter(() => !canonicalNative)
      .reduce((totals, item) => {
        totals.set(item.category, (totals.get(item.category) ?? 0) + Math.max(0, Number(item.hourlyCost) || 0));
        return totals;
      }, new Map());
    const partialRouteIds = new Set((manifest.partialRouteIds ?? []).map(String));
    this.nativeFinanceAuditRouteIds = new Set(
      [...configuredRouteIds].filter((routeId) => !partialRouteIds.has(routeId)),
    );
    return {
      routes: this.financeOwnedRouteIds.size,
      tracks: this.financeOwnedTrackIds.size,
      accountingRoutes: this.nativeFinanceAccountingRouteIds.size,
      comparableRoutes: this.nativeFinanceAuditRouteIds.size,
    };
  }

  recordNativeFinanceAudit(hour, revenueByRoute = {}, expensesByRoute = {}) {
    if (!Number.isSafeInteger(hour) || hour < 0) return;
    const entry = this.nativeFinanceAuditByHour.get(hour) ?? {
      hour,
      revenueByRoute: {},
      expensesByRoute: {},
    };
    for (const [routeId, amount] of Object.entries(revenueByRoute ?? {})) {
      const value = Math.max(0, Number(amount) || 0);
      if (value > 0) entry.revenueByRoute[routeId] = (entry.revenueByRoute[routeId] ?? 0) + value;
    }
    for (const [routeId, amount] of Object.entries(expensesByRoute ?? {})) {
      const value = Math.max(0, Number(amount) || 0);
      if (value > 0) entry.expensesByRoute[routeId] = (entry.expensesByRoute[routeId] ?? 0) + value;
    }
    // Preserve zero observations too: a projected fare with no corresponding
    // native fare is exactly the discrepancy this diagnostic must reveal.
    this.nativeFinanceAuditByHour.set(hour, entry);
  }

  consumeNativeFinanceAudit() {
    const samples = [...this.nativeFinanceAuditByHour.values()]
      .sort((left, right) => left.hour - right.hour)
      .map((sample) => structuredClone(sample));
    this.nativeFinanceAuditByHour.clear();
    return samples;
  }

  nativeFinanceAuditStatus() {
    const comparableRouteIds = [...this.nativeFinanceAuditRouteIds].sort();
    return {
      status: comparableRouteIds.length > 0 ? 'enabled' : 'unavailable',
      reason: comparableRouteIds.length > 0 ? null : 'no-comparable-native-routes',
      comparableRoutes: comparableRouteIds.length,
      comparableRouteIds,
      pendingHours: this.nativeFinanceAuditByHour.size,
    };
  }

  /** Read-only diagnostic; it does not invoke any mutating game action. */
  probe() {
    const apiVersion = this.api?.version ?? null;
    let state = null;
    let getStateError = null;
    try {
      state = typeof this.callbacks?.getState === 'function' ? this.callbacks.getState() : null;
    } catch (error) {
      getStateError = String(error.message ?? error);
    }

    const hasStateKey = (name) => Boolean(
      state && Object.prototype.hasOwnProperty.call(state, name),
    );
    const missingStateActionsByGroup = Object.freeze(Object.fromEntries(
      Object.entries(REQUIRED_STATE_ACTION_GROUPS).map(([group, names]) => [
        group,
        Object.freeze(names.filter((name) => typeof state?.[name] !== 'function')),
      ]),
    ));
    const stateFields = Object.freeze({
      cityCode: hasStateKey('cityCode'),
      portolanDiagram: hasStateKey('portolanDiagram'),
      portolanProgress: hasStateKey('portolanProgress'),
      interlinedFeatureCollection: hasStateKey('interlinedFeatureCollection'),
      trackEditSession: hasStateKey('trackEditSession'),
    });
    const interliningModel = stateFields.portolanDiagram && stateFields.portolanProgress
      ? 'portolan-v1'
      : (stateFields.interlinedFeatureCollection ? 'legacy-feature-collection' : 'unavailable');
    const required = {
      callbackGetState: typeof this.callbacks?.getState === 'function',
      callbackSetMoney: typeof this.callbacks?.setMoney === 'function',
      callbackSetTicketCost: typeof this.callbacks?.setTicketCost === 'function',
      cityDataFiles: typeof this.api?.cities?.setCityDataFiles === 'function',
      'state.cityCode': hasStateKey('cityCode'),
      ...Object.fromEntries(REQUIRED_STATE_ACTIONS.map((name) => [name, typeof state?.[name] === 'function'])),
      ...Object.fromEntries(REQUIRED_PORTOLAN_STATE_KEYS.map((name) => [`state.${name}`, hasStateKey(name)])),
    };
    const missing = Object.entries(required).filter(([, present]) => !present).map(([name]) => name);
    return this.capability = Object.freeze({
      supported: apiVersion === this.expectedApiVersion && !getStateError && !missing.length,
      apiVersion,
      expectedApiVersion: this.expectedApiVersion,
      inspectedGameVersion: this.inspectedGameVersion,
      missing,
      missingStateActionsByGroup,
      getStateError,
      interliningModel,
      stateFields,
      callbackMethods: methodsOf(this.callbacks),
      stateMethods: methodsOf(state),
      publicApiMethods: methodsOf(this.api),
      publicCityMethods: methodsOf(this.api?.cities),
      publicGameStateMethods: methodsOf(this.api?.gameState),
      publicUtilsMethods: methodsOf(this.api?.utils),
      selectedActions: Object.freeze({
        pause: 'setTimeConfig({ paused: true })',
        resume: 'setTimeConfig({ paused: false })',
        staticData: 'loadInitialData',
        cityIdentity: 'onCityLoad(cityCode) -> setCityCode -> bind save cityCode/cityUid -> getState().cityCode',
        clock: 'setTimeConfig({ elapsedSeconds })',
        save: 'generateSave',
        load: 'loadSave',
        interlining: 'recalculateAllRouteGeojsons -> portolanDiagram',
        directionalCommutes: DIRECTIONAL_COMMUTE_RESTORE_POLICY,
      }),
    });
  }

  #capability() { return this.capability ?? this.probe(); }
  #state() {
    // Zustand snapshots are immutable and replaced by each state update. Never
    // retain the object observed by probe(); hot reloads commonly begin while
    // the game is running, making a cached timeConfig and balance immediately
    // stale even though its action functions still mutate the live store.
    const state = this.callbacks.getState();
    if (!state) throw new Error('Subway Builder store state is unavailable');
    return state;
  }

  readLoadedCityCode() {
    return readLiveSubwayBuilderCityCode({ api: this.api, callbacks: this.callbacks });
  }

  reassertLoadedCityCode(cityCode) {
    const stateBefore = this.#state();
    const previousCityCode = stateBefore.cityCode ?? null;
    if (!cityCode || previousCityCode === cityCode) {
      return { status: 'already-current', cityCode: previousCityCode };
    }
    stateBefore.setCityCode(cityCode);
    return {
      status: 'reasserted',
      cityCode: this.#state().cityCode ?? null,
      previousCityCode,
    };
  }

  async assertSupported() {
    const capability = this.#capability();
    if (!capability.supported) {
      throw new Error(
        `Subway Builder capability probe refused mutation: api=${capability.apiVersion}; `
        + `expectedApi=${capability.expectedApiVersion}; missing=${capability.missing.join(',') || capability.getStateError}`,
      );
    }
  }

  getConstructedTrackIds() {
    return this.getTrackInventory().constructedTrackIds;
  }

  getTrackInventory() {
    const inventory = { constructedTrackIds: [], blueprintTrackIds: [] };
    for (const track of this.#state().tracks ?? []) {
      if (track?.id == null) continue;
      inventory[track?.buildType === 'blueprint' ? 'blueprintTrackIds' : 'constructedTrackIds']
        .push(String(track.id));
    }
    return inventory;
  }

  /** Observe confirmed player changes omitted by Subway Builder's public hooks. */
  observeSharedTransitChanges(changed) {
    return installNativeSharedTransitObserver(this.callbacks, changed);
  }

  /**
   * Upgrade a clipped route that was already loaded when the mod reloaded.
   * Projection-only commute data is deliberately derived from one global
   * network revision so route stop indices and deferred train timings cannot
   * drift independently. Mutate the opaque route objects in place: publishing
   * setRoutes here would look like a player topology edit to the native game.
   */
  hydrateClippedRouteCommuteData(nativeState) {
    const live = this.#state();
    const authoritativeRoutes = new Map((nativeState?.routes ?? [])
      .filter((route) => route?.id != null)
      .map((route) => [String(route.id), route]));
    const trainsByRoute = new Map();
    for (const train of nativeState?.trains ?? []) {
      if (train?.routeId == null) continue;
      const routeId = String(train.routeId);
      const trains = trainsByRoute.get(routeId) ?? [];
      trains.push(train);
      trainsByRoute.set(routeId, trains);
    }
    const stationById = new Map();
    const stationByNodeId = new Map();
    for (const station of nativeState?.stations ?? []) {
      if (station?.id == null) continue;
      stationById.set(String(station.id), station);
      for (const nodeId of station.stNodeIds ?? []) stationByNodeId.set(String(nodeId), station);
    }
    const deliveredStationIds = new Set((live?.stations ?? []).map(entityId).filter(Boolean));
    const deliveredStationNodeIds = new Set((live?.stations ?? [])
      .flatMap((station) => station?.stNodeIds ?? [])
      .map(String));

    let hydratedRoutes = 0;
    let trainCount = 0;
    let stationCount = 0;
    for (const route of live?.routes ?? []) {
      if (!route?.openWorldProjectionDormant || route?.id == null) continue;
      const routeId = String(route.id);
      const authoritativeRoute = authoritativeRoutes.get(routeId);
      if (!authoritativeRoute) continue;
      const repairedRoute = repairRouteTimingIntegrity(authoritativeRoute).route;
      // A hot mod reload adopts the live Zustand objects that were delivered
      // by the previous generation. Those older clipped facades can still
      // contain world-wide terminal nodes even though their stations are not
      // in the bounded native station array. Subway Builder's route converter
      // leaves its final split open in that state and crashes RouteStationsView.
      // Localize the live facade in place before React can consume it; keep the
      // editor/global route and commute route complete below.
      const visibleNodes = (route.stNodes ?? [])
        .filter((node) => deliveredStationNodeIds.has(String(node?.id)))
        .map((node) => structuredClone(node));
      const visibleNodeIds = new Set(visibleNodes.map(routeNodeId));
      route.stNodes = visibleNodes;
      if (Array.isArray(route.stCombos)) {
        route.stCombos = route.stCombos.filter((combo) => (
          visibleNodeIds.has(String(combo?.startStNodeId))
          && visibleNodeIds.has(String(combo?.endStNodeId))
        ));
      }
      if (Array.isArray(route.stationIds)) {
        route.stationIds = route.stationIds.filter((stationId) => deliveredStationIds.has(String(stationId)));
      }
      const routeStations = new Map();
      for (const stationId of repairedRoute.stationIds ?? []) {
        const station = stationById.get(String(stationId));
        if (station?.id != null) routeStations.set(String(station.id), station);
      }
      for (const node of repairedRoute.stNodes ?? []) {
        const station = stationByNodeId.get(String(node?.id));
        if (station?.id != null) routeStations.set(String(station.id), station);
      }
      route.openWorldNativeCommuteRoute = structuredClone(repairedRoute);
      route.openWorldNativeCommuteTrains = structuredClone(trainsByRoute.get(routeId) ?? []);
      route.openWorldNativeCommuteStations = structuredClone([...routeStations.values()]);
      const facadeTimings = projectRouteTimings(repairedRoute, visibleNodes);
      if (facadeTimings.length === (route.stNodes?.length ?? 0)) route.stComboTimings = facadeTimings;
      hydratedRoutes++;
      trainCount += route.openWorldNativeCommuteTrains.length;
      stationCount += route.openWorldNativeCommuteStations.length;
    }
    if (hydratedRoutes > 0) this.clippedRouteCommuteRefreshPending = true;
    return { hydratedRoutes, trains: trainCount, stations: stationCount };
  }

  /**
   * Subway Builder 1.6 treats every route with a trainSchedule as operational
   * and auto-generates its fleet during handleIncrementGameState. A clipped
   * route must retain that schedule for the native frequency editor, but its
   * omitted tracks make native trains unsafe. Hide only those schedules from
   * the synchronous 1.6 simulation tick, then restore them before control
   * returns to React. The authoritative/global schedule is never changed.
   */
  installClippedRouteTickGuard() {
    const state = this.#state();
    const installCommuteGuard = (actionName) => {
      const currentAction = state[actionName];
      if (typeof currentAction !== 'function'
        || (currentAction[CLIPPED_ROUTE_COMMUTE_GUARD]
          && currentAction[CLIPPED_ROUTE_COMMUTE_GUARD_VERSION]
            === CURRENT_CLIPPED_ROUTE_COMMUTE_GUARD_VERSION)) return;
      const callbacks = this.callbacks;
      const guardedAction = function guardedNativePathfinding(...args) {
        if (callbacks[CANONICAL_NATIVE_MODE_BINDING] === CANONICAL_NATIVE_NETWORK_MODE) {
          return currentAction.apply(this, args);
        }
        const live = callbacks.getState();
        const originalTrains = live?.trains;
        const originalStations = live?.stations;
        const originalRoutes = live?.routes;
        if (!Array.isArray(originalTrains) || !Array.isArray(originalStations)
          || !Array.isArray(originalRoutes)) {
          return currentAction.apply(this, args);
        }
        const knownTrainIds = new Set(originalTrains
          .map((train) => train?.id)
          .filter((id) => id != null)
          .map(String));
        const commuteOnlyTrains = [];
        const knownStationIds = new Set(originalStations
          .map((station) => station?.id)
          .filter((id) => id != null)
          .map(String));
        const commuteOnlyStations = [];
        for (const route of live.routes ?? []) {
          if (!route?.openWorldProjectionDormant) continue;
          const commuteRoute = route.openWorldNativeCommuteRoute ?? route.openWorldGlobalRoute ?? route;
          const rebasedTrains = rebaseDeferredTrainsForPathfinding(
            commuteRoute,
            route.openWorldNativeCommuteTrains ?? [],
            Number(live.timeConfig?.elapsedSeconds),
          );
          for (const train of rebasedTrains) {
            if (train?.id == null || knownTrainIds.has(String(train.id))) continue;
            knownTrainIds.add(String(train.id));
            commuteOnlyTrains.push(train);
          }
          for (const station of route.openWorldNativeCommuteStations ?? []) {
            if (station?.id == null || knownStationIds.has(String(station.id))) continue;
            knownStationIds.add(String(station.id));
            commuteOnlyStations.push(station);
          }
        }
        if (commuteOnlyTrains.length === 0 && commuteOnlyStations.length === 0) {
          return currentAction.apply(this, args);
        }
        // Both native pathfinding actions synchronously snapshot routes,
        // stations, and trains before their first await. Expose the deferred
        // timing records only for that snapshot; never publish or simulate
        // these globally-positioned trains in the clipped native world.
        live.trains = [...originalTrains, ...commuteOnlyTrains];
        live.stations = [...originalStations, ...commuteOnlyStations];
        live.routes = originalRoutes.map((route) => {
          if (!route?.openWorldProjectionDormant
            || (!route.openWorldNativeCommuteRoute && !route.openWorldGlobalRoute)) return route;
          const commuteRoute = route.openWorldNativeCommuteRoute ?? route.openWorldGlobalRoute;
          return {
            ...commuteRoute,
            // Frequency/fare edits may have been made through the local route
            // facade since this projection was built. Preserve those service
            // fields while restoring the authoritative stop indices used by
            // the deferred train timing arrays.
            ...(Object.hasOwn(route, 'trainSchedule') ? { trainSchedule: route.trainSchedule } : {}),
            ...(Object.hasOwn(route, 'timetableSchedule') ? { timetableSchedule: route.timetableSchedule } : {}),
            ...(Object.hasOwn(route, 'idealTrainCount') ? { idealTrainCount: route.idealTrainCount } : {}),
          };
        });
        try {
          return currentAction.apply(this, args);
        } finally {
          live.trains = originalTrains;
          live.stations = originalStations;
          live.routes = originalRoutes;
        }
      };
      Object.defineProperty(guardedAction, CLIPPED_ROUTE_COMMUTE_GUARD, { value: true });
      Object.defineProperty(guardedAction, CLIPPED_ROUTE_COMMUTE_GUARD_VERSION, {
        value: CURRENT_CLIPPED_ROUTE_COMMUTE_GUARD_VERSION,
      });
      state[actionName] = guardedAction;
    };
    installCommuteGuard('simulateCommutes');
    installCommuteGuard('calculatePaths');
    const current = state.handleIncrementGameState;
    if (typeof current !== 'function') return { installed: false, reason: 'unavailable' };
    if (current[CLIPPED_ROUTE_TICK_GUARD]
      && current[CLIPPED_ROUTE_TICK_GUARD_VERSION] === CURRENT_CLIPPED_ROUTE_TICK_GUARD_VERSION) {
      const binding = current[CLIPPED_ROUTE_TICK_GUARD_BINDING];
      const rebound = binding?.adapter !== this || binding?.callbacks !== this.callbacks;
      if (binding) {
        binding.adapter = this;
        binding.callbacks = this.callbacks;
      }
      return rebound
        ? { installed: true, reused: true, rebound: true }
        : { installed: true, reused: true };
    }
    if (current[CLIPPED_ROUTE_TICK_GUARD]) {
      // The old wrapper closes over the previous adapter instance and cannot
      // be safely nested: its filtered payload would hide the native A/B data
      // from this version. A game restart restores the unwrapped native action.
      return { installed: false, reason: 'stale-version-restart-required' };
    }

    const binding = { callbacks: this.callbacks, adapter: this };
    const guarded = function guardedHandleIncrementGameState(...args) {
      const { callbacks, adapter } = binding;
      if (callbacks[CANONICAL_NATIVE_MODE_BINDING] === CANONICAL_NATIVE_NETWORK_MODE) {
        return current.apply(this, args);
      }
      const live = callbacks.getState();
      const restores = [];
      for (const route of live?.routes ?? []) {
        if (!route?.openWorldProjectionDormant) continue;
        restores.push({
          route,
          trainSchedule: route.trainSchedule,
          timetableSchedule: route.timetableSchedule,
          idealTrainCount: route.idealTrainCount,
        });
        route.trainSchedule = null;
        route.timetableSchedule = null;
        route.idealTrainCount = 0;
      }
      const financeOwnedRouteIds = new Set(adapter.financeOwnedRouteIds);
      for (const routeId of (live?.routes ?? [])
        .filter((route) => route?.openWorldFinanceOwned && route?.id != null)
        .map((route) => String(route.tempParentId ?? route.id))) financeOwnedRouteIds.add(routeId);
      const nativeFinanceAuditRouteIds = new Set(adapter.nativeFinanceAuditRouteIds);
      if (nativeFinanceAuditRouteIds.size) {
        const hour = Math.floor(Math.max(0, Number(live?.timeConfig?.elapsedSeconds) || 0) / 3600);
        adapter.recordNativeFinanceAudit(hour);
      }
      const originalAddRevenue = unwrapNativeFinanceMethod(live?.addRevenue);
      const originalAddExpense = unwrapNativeFinanceMethod(live?.addExpense);
      const originalRecordRouteFinancials = unwrapNativeFinanceMethod(live?.recordRouteFinancials);
      let guardedFinanceRevenue = null;
      let guardedFinanceExpense = null;
      let guardedRouteFinancials = null;
      let pendingRevenue = null;
      let pendingTrainExpense = null;
      const ownedInfrastructureRemaining = new Map(adapter.financeOwnedInfrastructureHourlyByCategory);
      const positiveTotal = (values, ownedOnly) => Object.entries(values ?? {}).reduce((sum, [routeId, amount]) => (
        financeOwnedRouteIds.has(String(routeId)) === ownedOnly ? sum + Math.max(0, Number(amount) || 0) : sum
      ), 0);
      const filtered = (values) => Object.fromEntries(Object.entries(values ?? {})
        .filter(([routeId]) => !financeOwnedRouteIds.has(String(routeId))));
      if (financeOwnedRouteIds.size && typeof originalAddRevenue === 'function'
        && typeof originalAddExpense === 'function' && typeof originalRecordRouteFinancials === 'function') {
        guardedFinanceRevenue = markNativeFinanceWrapper(function guardedFinanceRevenue(amount, isFareRevenue, ...rest) {
          if (isFareRevenue && Number(amount) > 0) {
            pendingRevenue = { amount: Number(amount), args: [isFareRevenue, ...rest] };
            return;
          }
          return originalAddRevenue.call(this, amount, isFareRevenue, ...rest);
        }, originalAddRevenue);
        guardedFinanceExpense = markNativeFinanceWrapper(function guardedFinanceExpense(amount, category, ...rest) {
          if (category === 'trainOperational' && Number(amount) > 0) {
            pendingTrainExpense = { amount: Number(amount), args: [category, ...rest] };
            return;
          }
          const ownedInfrastructure = ownedInfrastructureRemaining.get(category) ?? 0;
          if (ownedInfrastructure > 0 && Number(amount) > 0) {
            const suppressed = Math.min(Number(amount), ownedInfrastructure);
            ownedInfrastructureRemaining.set(category, Math.max(0, ownedInfrastructure - suppressed));
            const remainder = Number(amount) - suppressed;
            if (remainder > 0) return originalAddExpense.call(this, remainder, category, ...rest);
            return;
          }
          return originalAddExpense.call(this, amount, category, ...rest);
        }, originalAddExpense);
        guardedRouteFinancials = markNativeFinanceWrapper(function guardedRouteFinancials(payload = {}) {
          const auditState = callbacks.getState?.() ?? live;
          const hour = Math.floor(Math.max(0, Number(auditState?.timeConfig?.elapsedSeconds) || 0) / 3600);
          const ownedValues = (values) => Object.fromEntries(Object.entries(values ?? {})
            .filter(([routeId]) => nativeFinanceAuditRouteIds.has(String(routeId)))
            .map(([routeId, amount]) => [routeId, Math.max(0, Number(amount) || 0)]));
          adapter.recordNativeFinanceAudit(
            hour,
            ownedValues(payload.revenueByRoute),
            ownedValues(payload.expensesByRoute),
          );
          if (pendingRevenue) {
            const owned = positiveTotal(payload.revenueByRoute, true);
            const remainder = Math.max(0, pendingRevenue.amount - owned);
            if (remainder > 0) originalAddRevenue.call(this, remainder, ...pendingRevenue.args);
            pendingRevenue = null;
          }
          if (pendingTrainExpense) {
            const owned = positiveTotal(payload.expensesByRoute, true);
            const remainder = Math.max(0, pendingTrainExpense.amount - owned);
            if (remainder > 0) originalAddExpense.call(this, remainder, ...pendingTrainExpense.args);
            pendingTrainExpense = null;
          }
          const revenueByRoute = filtered(payload.revenueByRoute);
          const expensesByRoute = filtered(payload.expensesByRoute);
          if (Object.keys(revenueByRoute).length || Object.keys(expensesByRoute).length) {
            return originalRecordRouteFinancials.call(this, { ...payload, revenueByRoute, expensesByRoute });
          }
        }, originalRecordRouteFinancials);
        live.addRevenue = guardedFinanceRevenue;
        live.addExpense = guardedFinanceExpense;
        live.recordRouteFinancials = guardedRouteFinancials;
      }
      try {
        // In the inspected 1.6.0 bundle the worker branch is compile-time off,
        // so the complete simulation reads routes synchronously before this
        // async action returns its Promise.
        return current.apply(this, args);
      } finally {
        if (pendingRevenue) originalAddRevenue?.call(live, pendingRevenue.amount, ...pendingRevenue.args);
        if (pendingTrainExpense) originalAddExpense?.call(live, pendingTrainExpense.amount, ...pendingTrainExpense.args);
        const restoreTemporaryState = (target) => {
          if (!target) return;
          if (target.addRevenue === guardedFinanceRevenue) target.addRevenue = originalAddRevenue;
          if (target.addExpense === guardedFinanceExpense) target.addExpense = originalAddExpense;
          if (target.recordRouteFinancials === guardedRouteFinancials) {
            target.recordRouteFinancials = originalRecordRouteFinancials;
          }
        };
        restoreTemporaryState(live);
        const latest = callbacks.getState?.();
        if (latest !== live) restoreTemporaryState(latest);
        for (const restore of restores) {
          restore.route.trainSchedule = restore.trainSchedule;
          restore.route.timetableSchedule = restore.timetableSchedule;
          restore.route.idealTrainCount = restore.idealTrainCount;
        }
      }
    };
    Object.defineProperty(guarded, CLIPPED_ROUTE_TICK_GUARD, { value: true });
    Object.defineProperty(guarded, CLIPPED_ROUTE_TICK_GUARD_VERSION, {
      value: CURRENT_CLIPPED_ROUTE_TICK_GUARD_VERSION,
    });
    Object.defineProperty(guarded, CLIPPED_ROUTE_TICK_GUARD_BINDING, { value: binding });
    state.handleIncrementGameState = guarded;
    // Publish the replaced action to existing Zustand selectors without
    // changing game time or pause state.
    state.setTimeConfig?.({});
    return { installed: true, reused: false };
  }

  /**
   * Repair the recoverable topology failure before Subway Builder's native
   * loader validates it. A finance-tick/autosave race in older prototypes
   * could persist tracks while omitting their group envelopes; the native
   * loader otherwise removes the orphan rail and then aborts while backfilling
   * station maxCars.
   */
  installTrackGroupLoadGuard() {
    const state = this.#state();
    const current = state.loadSave;
    if (typeof current !== 'function') return { installed: false, reason: 'unavailable' };
    if (current[TRACK_GROUP_LOAD_GUARD]
      && current[TRACK_GROUP_LOAD_GUARD_VERSION] === CURRENT_TRACK_GROUP_LOAD_GUARD_VERSION) {
      return { installed: true, reused: true };
    }
    const original = current[TRACK_GROUP_LOAD_GUARD_ORIGINAL] ?? current;
    const guarded = function guardedLoadSave(snapshot, ...args) {
      const data = snapshot?.data;
      if (!data || typeof data !== 'object') return original.call(this, snapshot, ...args);
      const repair = repairStationTrackGroupIntegrity(data);
      if (repair.unresolvedStationIds.length) {
        console.warn('[OpenWorld] save has station track groups that cannot be reconstructed', {
          stationIds: repair.unresolvedStationIds,
        });
      }
      if (!repair.changed) return original.call(this, snapshot, ...args);
      console.warn('[OpenWorld] repaired missing track groups before native save load', {
        trackGroupIds: repair.repairedGroupIds,
      });
      return original.call(this, { ...snapshot, data: repair.state }, ...args);
    };
    Object.defineProperty(guarded, TRACK_GROUP_LOAD_GUARD, { value: true });
    Object.defineProperty(guarded, TRACK_GROUP_LOAD_GUARD_VERSION, {
      value: CURRENT_TRACK_GROUP_LOAD_GUARD_VERSION,
    });
    Object.defineProperty(guarded, TRACK_GROUP_LOAD_GUARD_ORIGINAL, { value: original });
    state.loadSave = guarded;
    return { installed: true, reused: false };
  }

  /**
   * Route regeneration inside setTracks cannot resolve intentionally omitted
   * portions of a clipped route. Remove dormant routes only for that
   * synchronous regeneration, then restore them without regenerating route
   * geometry. Local/contained routes still receive the native update.
   */
  installClippedRouteTrackEditGuard() {
    const state = this.#state();
    const current = state.setTracks;
    if (typeof current !== 'function' || typeof state.setRoutes !== 'function') {
      return { installed: false, reason: 'unavailable' };
    }
    if (current[CLIPPED_ROUTE_TRACK_EDIT_GUARD]) return { installed: true, reused: true };

    const callbacks = this.callbacks;
    const guarded = function guardedSetTracks(...args) {
      if (callbacks[CANONICAL_NATIVE_MODE_BINDING] === CANONICAL_NATIVE_NETWORK_MODE) {
        return current.apply(this, args);
      }
      const before = callbacks.getState();
      const originalRoutes = [...(before?.routes ?? [])];
      const dormantById = new Map(originalRoutes
        .filter((route) => route?.openWorldProjectionDormant && route?.id != null)
        .map((route) => [String(route.id), route]));
      if (dormantById.size === 0) return current.apply(this, args);

      before.setRoutes(originalRoutes.filter((route) => !dormantById.has(String(route?.id))), false);
      try {
        return current.apply(this, args);
      } finally {
        const after = callbacks.getState();
        const updatedById = new Map((after?.routes ?? [])
          .filter((route) => route?.id != null)
          .map((route) => [String(route.id), route]));
        const restored = originalRoutes.map((route) => (
          dormantById.get(String(route?.id)) ?? updatedById.get(String(route?.id)) ?? route
        ));
        const originalIds = new Set(originalRoutes.map((route) => String(route?.id)));
        for (const route of after?.routes ?? []) {
          if (!originalIds.has(String(route?.id))) restored.push(route);
        }
        after.setRoutes(restored, false);
      }
    };
    Object.defineProperty(guarded, CLIPPED_ROUTE_TRACK_EDIT_GUARD, { value: true });
    Object.defineProperty(guarded, CLIPPED_ROUTE_TRACK_EDIT_ORIGINAL, { value: current });
    state.setTracks = guarded;
    state.setTimeConfig?.({});
    return { installed: true, reused: false };
  }

  /**
   * Subway Builder's route preview recomputes every stop against the current
   * native graph. A partial route intentionally contains remote stops whose
   * graph is not delivered. Present only the local run during preview, then
   * merge the native result back into the complete route on confirmation.
   */
  installClippedRoutePreviewEditGuard({ onConfirmed = null } = {}) {
    const state = this.#state();
    const currentBatch = state.batchPreviewRouteUpdates;
    const currentConfirm = state.confirmRouteChange;
    const currentSetPreview = state.setPreviewRoute;
    if (typeof currentBatch !== 'function' || typeof currentConfirm !== 'function'
      || typeof currentSetPreview !== 'function' || typeof state.setRoutes !== 'function') {
      return { installed: false, reason: 'unavailable' };
    }
    if (currentBatch[CLIPPED_ROUTE_PREVIEW_EDIT_GUARD]
      && currentBatch[CLIPPED_ROUTE_PREVIEW_EDIT_GUARD_VERSION]
        === CURRENT_CLIPPED_ROUTE_PREVIEW_EDIT_GUARD_VERSION
      && currentSetPreview[CLIPPED_ROUTE_PREVIEW_EDIT_GUARD]
      && currentSetPreview[CLIPPED_ROUTE_PREVIEW_EDIT_GUARD_VERSION]
        === CURRENT_CLIPPED_ROUTE_PREVIEW_EDIT_GUARD_VERSION) {
      if (currentBatch[CLIPPED_ROUTE_PREVIEW_EDIT_LISTENERS]) {
        currentBatch[CLIPPED_ROUTE_PREVIEW_EDIT_LISTENERS].onConfirmed = onConfirmed;
      }
      return { installed: true, reused: true };
    }

    // Old mod reloads left their wrapper installed in the Zustand store. New
    // versioned wrappers retain the raw native functions so future reloads can
    // replace them directly; the first upgrade from an unversioned wrapper is
    // safely layered once over that legacy closure.
    const batchImplementation = currentBatch[CLIPPED_ROUTE_PREVIEW_EDIT_ORIGINAL_BATCH] ?? currentBatch;
    const confirmImplementation = currentConfirm[CLIPPED_ROUTE_PREVIEW_EDIT_ORIGINAL_CONFIRM] ?? currentConfirm;
    const setPreviewImplementation = currentSetPreview[CLIPPED_ROUTE_PREVIEW_EDIT_ORIGINAL_SET_PREVIEW]
      ?? currentSetPreview;
    const listeners = { onConfirmed };

    const callbacks = this.callbacks;
    const guardedSetPreview = function guardedSetPreviewRoute(candidate, ...args) {
      if (callbacks[CANONICAL_NATIVE_MODE_BINDING] === CANONICAL_NATIVE_NETWORK_MODE) {
        return setPreviewImplementation.call(this, candidate, ...args);
      }
      const current = callbacks.getState();
      const prior = current?.previewRoute;
      const dormantRoute = (current?.routes ?? []).find((route) => (
        route?.openWorldProjectionDormant
        && route?.id != null
        && String(route.id) === String(candidate?.id)
      ));
      const isEditOfCurrentDormantRoute = candidate != null
        && prior != null
        // A missing station collection means the native city is still loading;
        // do not treat that transient capability gap as a route-order verdict.
        && (current?.stations?.length ?? 0) > 0
        && String(candidate?.id) === String(prior?.id)
        && Boolean(
          candidate?.openWorldProjectionDormant
          || prior?.openWorldProjectionDormant
          || dormantRoute,
        );
      if (isEditOfCurrentDormantRoute) {
        const inspection = inspectNativeRouteOrder(candidate, current.stations);
        if (!inspection.valid) {
          current.clearPendingStNodeChanges?.();
          publishClippedRouteDiagnostic('invalid-native-route-order-rejected', {
            routeId: String(candidate.id),
            reason: inspection.reason,
            candidateNodes: (candidate.stNodes ?? []).map(routeNodeId),
            restoredPreviewNodes: (prior.stNodes ?? []).map(routeNodeId),
            splits: structuredClone(inspection.splits),
            missingStationNodeIds: inspection.missingStationNodeIds,
          });
          console.warn(
            `[OpenWorld] Undid invalid route order for ${String(candidate.id)}: ${inspection.reason}`,
          );
          return undefined;
        }

        // Native StationsList.handleRemoveStation deliberately clears both
        // stCombos and stComboTimings. RouteStationsView interprets the empty
        // timing array as “ignore previewRoute” and immediately converts its
        // stale route prop instead. For a clipped route that prop can end on a
        // remote/unmapped node, throwing before the debounced batch guard runs.
        // Keep the accepted candidate selected for that intermediate render.
        if ((candidate.stComboTimings?.length ?? 0) === 0) {
          const timingSource = candidate.openWorldGlobalRoute
            ?? dormantRoute?.openWorldGlobalRoute
            ?? prior?.openWorldGlobalRoute
            ?? candidate;
          const repairedCandidate = {
            ...candidate,
            stComboTimings: routePanelFacadeTimings(timingSource, candidate.stNodes ?? []),
          };
          publishClippedRouteDiagnostic('empty-preview-timings-repaired', {
            routeId: String(candidate.id),
            previewNodes: (candidate.stNodes ?? []).map(routeNodeId),
            timingCount: repairedCandidate.stComboTimings.length,
          });
          return setPreviewImplementation.call(this, repairedCandidate, ...args);
        }
      }
      return setPreviewImplementation.call(this, candidate, ...args);
    };

    const guardedBatch = async function guardedBatchPreviewRouteUpdates(...args) {
      if (callbacks[CANONICAL_NATIVE_MODE_BINDING] === CANONICAL_NATIVE_NETWORK_MODE) {
        return batchImplementation.apply(this, args);
      }
      const before = callbacks.getState();
      const nativePreview = before?.previewRoute;
      const canonicalDormantRoute = (before?.routes ?? []).find((route) => (
        route?.openWorldProjectionDormant
        && route?.id != null
        && String(route.id) === String(nativePreview?.id)
      ));
      if (!nativePreview?.openWorldProjectionDormant && !canonicalDormantRoute) {
        return batchImplementation.apply(this, args);
      }
      const original = nativePreview?.openWorldProjectionDormant
        ? nativePreview
        : {
          ...structuredClone(canonicalDormantRoute),
          ...structuredClone(nativePreview),
          openWorldProjectionDormant: true,
          openWorldGlobalRoute: structuredClone(
            canonicalDormantRoute.openWorldGlobalRoute ?? canonicalDormantRoute,
          ),
        };
      const pendingChanges = structuredClone(before.pendingStNodeChanges ?? []);
      const canonicalNodeIds = new Set(((original?.openWorldGlobalRoute ?? original)?.stNodes ?? [])
        .map(routeNodeId).filter(Boolean));
      const duplicateAdditions = pendingChanges.filter(({ stNodeId, action }) => (
        action === 'add' && canonicalNodeIds.has(String(stNodeId))
      ));
      const effectivePendingChanges = pendingChanges.filter(({ stNodeId, action }) => (
        action !== 'add' || !canonicalNodeIds.has(String(stNodeId))
      ));
      const diagnosticFor = (route, localizedRoute, snapshot, changes, extra = {}) => ({
        routeId: String(original?.id ?? ''),
        canonicalMetadataRecovered: !nativePreview?.openWorldProjectionDormant && Boolean(canonicalDormantRoute),
        nativePreviewDormant: Boolean(nativePreview?.openWorldProjectionDormant),
        canonicalDormant: Boolean(canonicalDormantRoute?.openWorldProjectionDormant),
        manualRouteOrdering: Boolean(snapshot.manualRouteOrdering),
        pendingChanges: changes.map(({ stNodeId, action }) => {
          const node = (snapshot.stNodes ?? []).find((candidate) => entityId(candidate) === String(stNodeId));
          return {
            stNodeId: String(stNodeId),
            action,
            center: structuredClone(node?.center ?? node?.coords ?? null),
            trackIds: [...(node?.trackIds ?? [])].map(String),
          };
        }),
        nativePreviewNodes: (nativePreview?.stNodes ?? []).map(routeNodeId),
        canonicalNodes: ((canonicalDormantRoute?.openWorldGlobalRoute
          ?? canonicalDormantRoute)?.stNodes ?? []).map(routeNodeId),
        localizedNodes: (localizedRoute.stNodes ?? []).map(routeNodeId),
        localizedRange: structuredClone(localizedRoute.openWorldLocalNodeRange ?? null),
        deliveredNodeCount: snapshot.stNodes?.length ?? 0,
        deliveredTrackCount: snapshot.tracks?.length ?? 0,
        directedRunSelection: clippedRouteRunDiagnostics(route, snapshot),
        ...extra,
      });

      // A normal two-track station adds one platform node per direction. A
      // clipped loop can expose those directions as separate local runs, so a
      // native batch has no connected facade capable of accepting both nodes;
      // the UI may also flush either node alone. Build only the real, directed
      // local combinations from native's
      // trackGraph and merge each side into the same canonical route. Native's
      // updateRoute cannot be used here: it unconditionally closes a manually
      // ordered route through the clipped-away portion of the loop.
      if (pendingChanges.length > 0 && effectivePendingChanges.length === 0
        && pendingChanges.every(({ action }) => action === 'add')) {
        before.clearPendingStNodeChanges?.();
        publishClippedRouteDiagnostic('duplicate-add-noop', {
          routeId: String(original?.id ?? ''),
          duplicateNodeIds: duplicateAdditions.map(({ stNodeId }) => String(stNodeId)),
          previewNodesPreserved: (nativePreview?.stNodes ?? []).map(routeNodeId),
          canonicalNodes: [...canonicalNodeIds],
        });
        return undefined;
      }

      // Removing a stop does not alter rail geometry. Native normally
      // regenerates the path between the surviving neighbours, but that graph
      // search cannot see the clipped portion of a long route. Collapse the
      // route's already-known directed combo paths instead. This also drops
      // stale pre-split envelope combos that otherwise make the route editor
      // dereference parent tracks removed by station construction.
      const canonicalRemovals = pendingChanges.length > 0
        && pendingChanges.every(({ action }) => action === 'remove');
      if (canonicalRemovals) {
        const canonicalNormalization = normalizeDeliveredCanonicalRoute(
          original.openWorldGlobalRoute ?? original,
          before,
        );
        const canonicalBeforeRemoval = canonicalNormalization.route;
        const removal = removeRouteNodes(
          canonicalBeforeRemoval,
          pendingChanges.map(({ stNodeId }) => stNodeId),
        );
        if (removal.changed) {
          const after = callbacks.getState();
          // Prefer the live directed graph for each newly collapsed gap. A
          // station construction can replace one old parent rail with several
          // children while a legacy sidecar still remembers the parent path.
          // Searching only between the two delivered surviving neighbours is
          // bounded and avoids both the stale track and the remote clipped
          // portion that made native whole-route regeneration fail.
          const sourceNodes = canonicalBeforeRemoval.stNodes ?? [];
          let sourceSearchFrom = 0;
          const retainedSourceIndexes = (removal.route.stNodes ?? []).map((node) => {
            const index = sourceNodes.findIndex((candidate, candidateIndex) => (
              candidateIndex >= sourceSearchFrom && routeNodeId(candidate) === routeNodeId(node)
            ));
            sourceSearchFrom = index + 1;
            return index;
          });
          let rebuiltRemovedGaps = 0;
          removal.route.stCombos = (removal.route.stCombos ?? []).map((combo, index) => {
            const sourceStart = retainedSourceIndexes[index];
            const sourceEnd = retainedSourceIndexes[index + 1];
            if (!(sourceStart >= 0 && sourceEnd > sourceStart + 1)) return combo;
            const rebuilt = buildNativeDirectedCombo(
              after,
              removal.route.stNodes[index],
              removal.route.stNodes[index + 1],
            );
            if (!rebuilt) return combo;
            rebuiltRemovedGaps++;
            return rebuilt;
          });
          const retainedNodeIds = new Set((removal.route.stNodes ?? []).map(routeNodeId));
          if (Array.isArray(removal.route.stationIds)) {
            const stationsById = new Map((after.stations ?? [])
              .filter((station) => entityId(station))
              .map((station) => [entityId(station), station]));
            removal.route.stationIds = removal.route.stationIds.filter((stationId) => {
              const station = stationsById.get(String(stationId));
              return !station?.stNodeIds?.length
                || station.stNodeIds.some((stNodeId) => retainedNodeIds.has(String(stNodeId)));
            });
          }
          const completed = {
            ...removal.route,
            openWorldProjectionDormant: true,
            openWorldProjectionLocalEdit: true,
            openWorldGlobalRoute: structuredClone(removal.route),
          };
          after.clearPendingStNodeChanges?.();
          const presentation = makeDeliveredMultiRunPresentation(completed, after);
          // RouteStationsView receives both previewRoute and the matching
          // routes[] entry. It normally prefers previewRoute while timings
          // are available, but React can render once with the route prop
          // after a native station removal. Publishing only the safe preview
          // therefore leaves a stale, unsplittable route prop that crashes
          // convertRouteToRaptorRoutes. Keep the complete route in
          // openWorldGlobalRoute and publish the same validated local facade
          // through both native store paths before yielding control.
          const routes = (after.routes ?? []).map((route) => (
            String(route?.id) === String(completed.id)
              ? structuredClone(presentation)
              : route
          ));
          after.setRoutes(routes, false);
          callbacks.getState().setPreviewRoute(structuredClone(presentation));
          const published = callbacks.getState();
          const publishedPreview = published?.previewRoute;
          const publishedRoute = (published?.routes ?? []).find((route) => (
            String(route?.id) === String(completed.id)
          ));
          publishClippedRouteDiagnostic('after-canonical-remove', {
            ...diagnosticFor(completed, completed, after, pendingChanges),
            applied: true,
            removedStops: removal.removedStops,
            repairedBeforeRemoval: canonicalNormalization.changed,
            rebuiltBeforeRemoval: canonicalNormalization.rebuiltEdges,
            rebuiltRemovedGaps,
            canonicalResultNodes: removal.route.stNodes.map(routeNodeId),
            canonicalResultCombos: removal.route.stCombos.map(comboKey),
            facadeResultNodes: presentation.stNodes.map(routeNodeId),
            facadeTimingCount: presentation.stComboTimings?.length ?? 0,
            publishedPreviewNodes: (publishedPreview?.stNodes ?? []).map(routeNodeId),
            publishedPreviewTimingCount: publishedPreview?.stComboTimings?.length ?? 0,
            routePanelUsesPreview: (publishedPreview?.stComboTimings?.length ?? 0) > 0,
            publishedRouteNodes: (publishedRoute?.stNodes ?? []).map(routeNodeId),
            remainingPendingChanges: structuredClone(published?.pendingStNodeChanges ?? []),
          });
          return undefined;
        }
      }

      const directedAdds = effectivePendingChanges.length > 0
        && pendingChanges.every(({ action }) => action === 'add')
        && before.trackGraph instanceof Map
        && before.trackGraph.size > 0
        && typeof before.clearPendingStNodeChanges === 'function'
        && typeof before.changePreviewRoute === 'function';
      if (directedAdds) {
        let workingRoute = original;
        let fallbackToNative = false;
        before.clearPendingStNodeChanges();
        for (let index = 0; index < effectivePendingChanges.length; index++) {
          const change = effectivePendingChanges[index];
          const preparing = callbacks.getState();
          preparing.clearPendingStNodeChanges();
          preparing.changePreviewRoute(change);
          const prepared = callbacks.getState();
          const localizedPart = makeEditableLocalizedRoute(workingRoute, prepared);
          const addedNode = (prepared.stNodes ?? [])
            .find((node) => entityId(node) === String(change.stNodeId));
          const directedBuild = buildDirectedLocalRoute(
            localizedPart,
            prepared,
            addedNode,
          );
          const partDiagnostic = diagnosticFor(workingRoute, localizedPart, prepared, [change], {
            directedAdds: true,
            splitPart: index + 1,
            splitPartCount: effectivePendingChanges.length,
            pathBuilder: 'native-directed-track-graph',
            directedInputNodes: (directedBuild.route?.stNodes ?? []).map(routeNodeId),
            directedInsertionIndex: directedBuild.insertionIndex,
            directedInsertionCost: directedBuild.cost,
            directedCombos: (directedBuild.route?.stCombos ?? []).map((combo) => ({
              startStNodeId: String(combo.startStNodeId),
              endStNodeId: String(combo.endStNodeId),
              trackCount: combo.path?.length ?? 0,
              distance: combo.distance ?? null,
            })),
            failedDirectedEdge: directedBuild.failedEdge,
            batchPendingChanges: pendingChanges.map(({ stNodeId, action }) => ({
              stNodeId: String(stNodeId), action,
            })),
            duplicateNodeIds: duplicateAdditions.map(({ stNodeId }) => String(stNodeId)),
          });
          publishClippedRouteDiagnostic('before-directed-part', partDiagnostic);
          const applied = Boolean(directedBuild.route);
          publishClippedRouteDiagnostic('after-directed-part', {
            ...partDiagnostic,
            applied,
            directedResultNodes: (directedBuild.route?.stNodes ?? []).map(routeNodeId),
          });
          if (!applied) {
            prepared.clearPendingStNodeChanges();
            prepared.setPreviewRoute(makeEditableLocalizedRoute(original, prepared));
            publishClippedRouteDiagnostic('after-native', {
              ...partDiagnostic,
              applied: false,
              failedSplitPart: index + 1,
            });
            if (effectivePendingChanges.length === 1) {
              prepared.setPreviewRoute(original);
              prepared.changePreviewRoute(change);
              fallbackToNative = true;
              break;
            }
            return undefined;
          }
          workingRoute = mergeLocalizedRoute(
            workingRoute,
            localizedPart,
            directedBuild.route,
            prepared,
          );
          prepared.clearPendingStNodeChanges();
          prepared.setPreviewRoute(makeDeliveredMultiRunPresentation(workingRoute, prepared));
        }
        if (fallbackToNative) {
          publishClippedRouteDiagnostic('directed-fallback-native', {
            routeId: String(original?.id ?? ''),
            pendingChanges: pendingChanges.map(({ stNodeId, action }) => ({
              stNodeId: String(stNodeId), action,
            })),
          });
        } else {
          const after = callbacks.getState();
          const presentation = makeDeliveredMultiRunPresentation(workingRoute, after);
          after.setPreviewRoute(presentation);
          publishClippedRouteDiagnostic('after-native', {
            ...diagnosticFor(workingRoute, workingRoute, after, pendingChanges, {
              directedAdds: true,
            }),
            applied: true,
            nativeResultNodes: (presentation.stNodes ?? []).map(routeNodeId),
            canonicalResultNodes: (workingRoute.openWorldGlobalRoute?.stNodes ?? []).map(routeNodeId),
            remainingPendingChanges: structuredClone(after.pendingStNodeChanges ?? []),
          });
          return undefined;
        }
      }

      const localized = makeEditableLocalizedRoute(original, before);
      const baseDiagnostic = diagnosticFor(original, localized, before, pendingChanges);
      publishClippedRouteDiagnostic('before-native', baseDiagnostic);
      before.setPreviewRoute(localized);
      try {
        const result = await batchImplementation.apply(this, args);
        const after = callbacks.getState();
        if (after?.previewRoute) {
          const updatedIds = new Set((after.previewRoute.stNodes ?? []).map(routeNodeId));
          const applied = pendingChanges.every(({ stNodeId, action }) => (
            action === 'add' ? updatedIds.has(String(stNodeId)) : !updatedIds.has(String(stNodeId))
          ));
          publishClippedRouteDiagnostic('after-native', {
            ...baseDiagnostic,
            applied,
            nativeResultNodes: (after.previewRoute.stNodes ?? []).map(routeNodeId),
            remainingPendingChanges: structuredClone(after.pendingStNodeChanges ?? []),
          });
          after.setPreviewRoute(applied
            ? mergeLocalizedRoute(original, localized, after.previewRoute, after)
            : structuredClone(localized));
        }
        return result;
      } catch (error) {
        const after = callbacks.getState();
        publishClippedRouteDiagnostic('native-rejection', {
          ...baseDiagnostic,
          error: String(error?.message ?? error),
          nativeResultNodes: (after?.previewRoute?.stNodes ?? []).map(routeNodeId),
          remainingPendingChanges: structuredClone(after?.pendingStNodeChanges ?? []),
        });
        after?.setPreviewRoute?.(structuredClone(localized));
        throw error;
      }
    };

    const guardedConfirm = function guardedConfirmRouteChange(...args) {
      if (callbacks[CANONICAL_NATIVE_MODE_BINDING] === CANONICAL_NATIVE_NETWORK_MODE) {
        return confirmImplementation.apply(this, args);
      }
      const before = callbacks.getState();
      const preview = before?.previewRoute;
      if (!preview?.openWorldProjectionLocalEdit) return confirmImplementation.apply(this, args);
      const completedRoute = {
        ...structuredClone(preview.openWorldGlobalRoute ?? preview),
        openWorldProjectionDormant: true,
        // Reconciliation consumes this marker to distinguish a deliberate
        // edit of the localized facade from destructive native normalization.
        openWorldProjectionLocalEdit: true,
        openWorldGlobalRoute: structuredClone(preview.openWorldGlobalRoute ?? preview),
      };
      const presentation = makeDeliveredMultiRunPresentation(completedRoute, before);
      const routes = (before.routes ?? []).map((route) => (
        String(route?.id) === String(preview.id) ? structuredClone(presentation) : route
      ));
      before.setRoutes(routes, false);
      before.setPreviewRoute(null);
      before.clearPendingStNodeChanges?.();
      try {
        listeners.onConfirmed?.({ routeId: String(preview.id), route: structuredClone(completedRoute) });
      } catch (error) {
        console.warn('[OpenWorld] clipped-route confirmation listener failed', error);
      }
      return { success: true };
    };

    Object.defineProperties(guardedBatch, {
      [CLIPPED_ROUTE_PREVIEW_EDIT_GUARD]: { value: true },
      [CLIPPED_ROUTE_PREVIEW_EDIT_GUARD_VERSION]: { value: CURRENT_CLIPPED_ROUTE_PREVIEW_EDIT_GUARD_VERSION },
      [CLIPPED_ROUTE_PREVIEW_EDIT_LISTENERS]: { value: listeners },
      [CLIPPED_ROUTE_PREVIEW_EDIT_ORIGINAL_BATCH]: { value: batchImplementation },
    });
    Object.defineProperty(guardedConfirm, CLIPPED_ROUTE_PREVIEW_EDIT_ORIGINAL_CONFIRM, {
      value: confirmImplementation,
    });
    Object.defineProperties(guardedSetPreview, {
      [CLIPPED_ROUTE_PREVIEW_EDIT_GUARD]: { value: true },
      [CLIPPED_ROUTE_PREVIEW_EDIT_GUARD_VERSION]: {
        value: CURRENT_CLIPPED_ROUTE_PREVIEW_EDIT_GUARD_VERSION,
      },
      [CLIPPED_ROUTE_PREVIEW_EDIT_ORIGINAL_SET_PREVIEW]: { value: setPreviewImplementation },
    });
    Object.defineProperty(guardedConfirm, CLIPPED_ROUTE_PREVIEW_EDIT_GUARD, { value: true });
    state.batchPreviewRouteUpdates = guardedBatch;
    state.confirmRouteChange = guardedConfirm;
    state.setPreviewRoute = guardedSetPreview;
    state.setTimeConfig?.({});
    return { installed: true, reused: false };
  }

  async pause() {
    await this.assertSupported();
    this.#state().setTimeConfig({ paused: true });
  }

  async resume() {
    await this.assertSupported();
    this.#state().setTimeConfig({ paused: false });
  }

  async isPaused() {
    await this.assertSupported();
    return this.#state().timeConfig?.paused === true;
  }

  async captureSnapshot(template = null) {
    await this.assertSupported();
    const state = this.#state();
    if (!validSave(template)) {
      const generate = () => state.generateSave({ name: OPEN_WORLD_RUNTIME_SAVE_NAME });
      const generated = typeof this.nativeSaveLifecycle?.runInternalOperation === 'function'
        ? await this.nativeSaveLifecycle.runInternalOperation({
          kind: 'runtime-snapshot-generate',
          saveName: OPEN_WORLD_RUNTIME_SAVE_NAME,
          nativeSessionId: state.gameSessionId ?? null,
          metadataMarked: false,
        }, generate)
        : generate();
      return bindSnapshotToCity(
        stampOpenWorldRuntimeSnapshot(compactNativeSnapshot(generated)),
        this.loadedCityCode,
        state.cityCode === this.loadedCityCode ? state.cityUid : this.loadedCityCode,
      );
    }

    // Once one valid native save has supplied the game's schema/version, make
    // later checkpoints directly from the store. This avoids generateSave's
    // eager compression of the full demand model on every tile switch.
    const data = { ...template.data };
    for (const key of DEMAND_STATE_KEYS) delete data[key];
    const liveKeys = [
      'tracks', 'trains', 'routes', 'timeConfig', 'trackGroups', 'signals',
      'stNodes', 'stations', 'money', 'transitCost', 'fareGroups',
      'financialHistory', 'routeFinancials', 'bonds', 'gameMode',
      'ownedTrainCount', 'ownedCarsByType', 'playTimeSeconds',
      'totalLifetimeRidership', 'dailyStats', 'stationsDemolishedAllTime',
      'buildingDemolitionSpendAllTime', 'everDemolishedBuilding',
      'demolishedOsmIds', 'routesDeletedAllTime', 'firstTransferMadeAt',
      'hasGoneBankrupt', 'rockefellerPaidOut', 'stationGroups',
    ];
    for (const key of liveKeys) {
      if (state[key] !== undefined) data[key] = state[key];
    }
    data.elapsedSeconds = state.timeConfig?.elapsedSeconds ?? data.elapsedSeconds ?? 0;

    const timestamp = Date.now();
    return bindSnapshotToCity(structuredClone(stampOpenWorldRuntimeSnapshot(compactNativeSnapshot({
      ...template,
      id: globalThis.crypto?.randomUUID?.() ?? `${state.cityCode ?? 'tile'}-${timestamp}`,
      timestamp,
      cityCode: this.loadedCityCode ?? state.cityCode ?? template.cityCode,
      gameSessionId: state.gameSessionId ?? template.gameSessionId,
      metadata: {
        stations: data.stations?.length ?? 0,
        routes: data.routes?.length ?? 0,
        trains: data.trains?.length ?? 0,
        money: data.money ?? 0,
        elapsedSeconds: data.elapsedSeconds,
      },
      viewport: state.mapViewport ?? template.viewport,
      data,
    }))), this.loadedCityCode, state.cityCode === this.loadedCityCode ? state.cityUid : this.loadedCityCode);
  }

  /** Read live network slices without entering the native generateSave path. */
  async captureNativeNetworkState() {
    await this.assertSupported();
    return this.captureNativeNetworkDraft();
  }

  /** Synchronously snapshot native network slices before a module generation can change. */
  captureNativeNetworkDraft() {
    const capability = this.#capability();
    if (!capability.supported) {
      throw new Error(
        `Subway Builder capability probe refused mutation: api=${capability.apiVersion}; `
        + `missing=${capability.missing.join(',')}`,
      );
    }
    const state = this.#state();
    const entityKeys = new Set(['tracks', 'trains', 'routes', 'trackGroups', 'signals', 'stNodes', 'stations', 'stationGroups']);
    return Object.fromEntries(SHARED_TRANSIT_STATE_KEYS.map((key) => [
      key,
      structuredClone(state[key] ?? (entityKeys.has(key) ? [] : null)),
    ]));
  }

  inspectNativeNetworkForDiagnostics() {
    const state = this.#state();
    const routes = Array.isArray(state.routes) ? state.routes : [];
    return {
      cityCode: state.cityCode ?? this.loadedCityCode ?? null,
      gameSessionId: state.gameSessionId ?? null,
      tracks: Array.isArray(state.tracks) ? state.tracks.length : 0,
      trackGroups: Array.isArray(state.trackGroups) ? state.trackGroups.length : 0,
      stations: Array.isArray(state.stations) ? state.stations.length : 0,
      routes: routes.length,
      trains: Array.isArray(state.trains) ? state.trains.length : 0,
      routeInventory: routes.map((route) => ({
        id: route?.id ?? null,
        bullet: route?.bullet ?? null,
        name: route?.fullName ?? route?.name ?? null,
        projectionDormant: route?.openWorldProjectionDormant === true,
      })),
    };
  }

  readWorldIdentityHints() {
    const state = this.#state();
    const authoritativeWorldId = state.financialHistory?.openWorldAuthoritativeWorldId;
    return {
      authoritativeWorldId: typeof authoritativeWorldId === 'string' && authoritativeWorldId
        ? authoritativeWorldId
        : null,
      ancestorSessionIds: typeof state.gameSessionId === 'string' && state.gameSessionId
        ? [state.gameSessionId]
        : [],
    };
  }

  async stampAuthoritativeWorldIdentity(worldId) {
    await this.assertSupported();
    if (typeof worldId !== 'string' || !worldId) {
      throw new Error('Authoritative world identity must be a non-empty string');
    }
    const state = this.#state();
    const current = state.financialHistory ?? {};
    if (current.openWorldAuthoritativeWorldId === worldId) return false;
    if (typeof state.setFinancialHistory !== 'function') {
      throw new Error('Native setFinancialHistory action is unavailable');
    }
    state.setFinancialHistory({
      ...structuredClone(current),
      openWorldAuthoritativeWorldId: worldId,
    });
    return true;
  }

  compactSnapshot(snapshot) { return compactNativeSnapshot(snapshot); }

  mergeSharedTransitNetwork(destinationSnapshot, sourceSnapshot) {
    if (!validSave(destinationSnapshot) || !validSave(sourceSnapshot)) {
      throw new Error('Cannot merge transit network from an invalid native snapshot');
    }
    const data = mergeSharedTransitNetworkState(destinationSnapshot.data, sourceSnapshot.data);
    return compactNativeSnapshot({
      ...structuredClone(destinationSnapshot),
      data,
      metadata: {
        ...(destinationSnapshot.metadata ?? {}),
        stations: data.stations.length,
        routes: data.routes.length,
        trains: data.trains.length,
      },
    });
  }

  async captureAuthoritativeGlobals() {
    await this.assertSupported();
    const state = this.#state();
    const wallet = state.money;
    const elapsedSeconds = state.timeConfig?.elapsedSeconds;
    if (!Number.isFinite(wallet)) throw new Error('Game returned an invalid current balance');
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new Error('Game returned an invalid current time');
    return {
      wallet,
      elapsedSeconds,
      ...(['easy', 'sandbox'].includes(state.gameMode) ? { gameMode: state.gameMode } : {}),
      ...(Number.isFinite(state.transitCost) && state.transitCost >= 0 ? { farePolicy: { fare: state.transitCost, fareGroups: structuredClone(state.fareGroups ?? []) } } : {}),
      ...(state.financialHistory ? { financialHistory: structuredClone(state.financialHistory) } : {}),
    };
  }

  getJourneyFare(segments) {
    const getter = this.api?.gameState?.getJourneyFare;
    if (typeof getter !== 'function') return null;
    const fare = getter(segments);
    return Number.isFinite(fare) && fare >= 0 ? fare : null;
  }

  async creditCrossTileFareRevenue(amount, attribution = {}) {
    await this.assertSupported();
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid cross-tile fare revenue');
    const state = this.#state();
    if (amount > 0 && typeof state.addRevenue !== 'function') throw new Error('Native addRevenue action is unavailable');
    const rawRevenueByRoute = attribution.revenueByRoute ?? {};
    const rawCompletedCommutes = attribution.completedCommutes ?? [];
    const hasRouteAttribution = Object.keys(rawRevenueByRoute).length > 0 || rawCompletedCommutes.length > 0;
    if (hasRouteAttribution && typeof state.recordRouteFinancials !== 'function') {
      throw new Error('Native recordRouteFinancials action is unavailable');
    }
    if (rawCompletedCommutes.length > 0 && typeof state.setCompletedCommutes !== 'function') {
      throw new Error('Native setCompletedCommutes action is unavailable');
    }
    const parentByRoute = new Map((state.routes ?? [])
      .filter((route) => route?.id)
      .map((route) => [route.id, route.tempParentId ?? route.id]));
    const canonicalRouteId = (routeId) => parentByRoute.get(routeId) ?? routeId;
    const revenueByRoute = {};
    for (const [routeId, revenue] of Object.entries(rawRevenueByRoute)) {
      if (!Number.isFinite(revenue) || revenue < 0) throw new Error(`Invalid cross-tile route revenue: ${routeId}`);
      const canonicalId = canonicalRouteId(routeId);
      revenueByRoute[canonicalId] = (revenueByRoute[canonicalId] ?? 0) + revenue;
    }
    const completedCommutes = rawCompletedCommutes.map((commute) => ({
      ...structuredClone(commute),
      stationRoutes: (commute.stationRoutes ?? []).map((segment) => ({
        ...structuredClone(segment), routeId: canonicalRouteId(segment.routeId),
      })),
    }));
    const existing = Array.isArray(state.completedCommutes) ? state.completedCommutes : [];
    const known = new Set(existing.map((commute) => commute?.popId));
    const freshCommutes = completedCommutes.filter((commute) => !known.has(commute.popId));
    const isRetry = completedCommutes.length > 0 && freshCommutes.length !== completedCommutes.length;
    const effectiveAmount = isRetry
      ? freshCommutes.reduce((total, commute) => total + (Number(commute.fareRevenue) || 0), 0)
      : amount;
    const effectiveRevenueByRoute = isRetry
      ? freshCommutes.reduce((totals, commute) => {
        for (const [routeId, revenue] of Object.entries(commute.revenueByRoute ?? {})) {
          const canonicalId = canonicalRouteId(routeId);
          totals[canonicalId] = (totals[canonicalId] ?? 0) + revenue;
        }
        return totals;
      }, {})
      : revenueByRoute;
    // The true flag is the same path used by native passenger fares: it adds
    // the amount to both money and currentHourRevenue (the profit dashboard).
    if (effectiveAmount > 0) state.addRevenue(effectiveAmount, true);
    if (Object.keys(effectiveRevenueByRoute).length > 0) {
      state.recordRouteFinancials({ revenueByRoute: effectiveRevenueByRoute, expensesByRoute: {} });
    }
    if (freshCommutes.length > 0) {
      state.setCompletedCommutes([
        ...existing,
        ...freshCommutes,
      ]);
    }
    const updated = this.#state();
    return { wallet: updated.money, financialHistory: structuredClone(updated.financialHistory) };
  }

  calculateNativeFinanceProfile(tileId = this.loadedCityCode, globalNativeState = null, options = {}) {
    const state = this.#state();
    const pops = [...(state.demandData?.popsMap?.values?.() ?? [])];
    const financeOptions = {
      ...options,
      fareGroups: globalNativeState?.fareGroups ?? state.fareGroups ?? [],
      routes: globalNativeState?.routes ?? state.routes ?? [],
      legacyFare: Number(state.transitCost) || 0,
    };
    let trainTypes = [];
    try { trainTypes = this.api?.trains?.getTrainTypes?.() ?? []; } catch {}
    return {
      tileRevenueProfile: {
        schemaVersion: 3,
        tileId,
        calculatedAtSeconds: state.timeConfig?.elapsedSeconds ?? 0,
        ...calculateNativeRevenueProfile(pops, financeOptions),
      },
      expenseProfile: {
        schemaVersion: 2,
        calculatedAtSeconds: state.timeConfig?.elapsedSeconds ?? 0,
        ...calculateGlobalExpenseProfile(globalNativeState ?? state, trainTypes, options),
      },
    };
  }

  async postBackgroundNativeFinance(posting) {
    await this.assertSupported();
    const state = this.#state();
    const parentByRoute = new Map((state.routes ?? [])
      .filter((route) => route?.id != null)
      .map((route) => [String(route.id), String(route.tempParentId ?? route.id)]));
    const canonicalizeRouteAmounts = (values) => Object.entries(values ?? {}).reduce((result, [routeId, amount]) => {
      const canonicalId = parentByRoute.get(String(routeId)) ?? String(routeId);
      result[canonicalId] = (result[canonicalId] ?? 0) + (Number(amount) || 0);
      return result;
    }, {});
    const revenueByRoute = canonicalizeRouteAmounts(posting.revenueByRoute);
    const expensesByRoute = canonicalizeRouteAmounts(posting.expensesByRoute);
    const postingId = String(posting?.postingId ?? '');
    if (!postingId) throw new Error('Background native finance posting requires an id');
    const revenue = Number(posting.revenue) || 0;
    const expenseCategories = Object.fromEntries(Object.entries(posting.expenseCategories ?? {})
      .filter(([, amount]) => Number(amount) > 0)
      .map(([category, amount]) => [category, Number(amount)]));
    for (const capitalCategory of ['trainPurchase', 'construction']) {
      if ((expenseCategories[capitalCategory] ?? 0) > 0) {
        throw new Error(`Background native finance cannot post capital expense category: ${capitalCategory}`);
      }
    }
    const expenses = Object.values(expenseCategories).reduce((sum, amount) => sum + amount, 0);
    if (revenue < 0 || !Number.isFinite(revenue) || !Number.isFinite(expenses)) {
      throw new Error('Invalid background native finance posting');
    }
    const receipts = Array.isArray(state.financialHistory?.openWorldBackgroundFinanceReceipts)
      ? state.financialHistory.openWorldBackgroundFinanceReceipts
      : [];
    if (receipts.includes(postingId)) {
      return {
        applied: false,
        wallet: state.money,
        financialHistory: structuredClone(state.financialHistory),
      };
    }
    if (revenue > 0 && typeof state.addRevenue !== 'function') throw new Error('Native addRevenue action is unavailable');
    if (expenses > 0 && typeof state.addExpense !== 'function') throw new Error('Native addExpense action is unavailable');
    const hasRouteAccounting = Object.keys(revenueByRoute).length || Object.keys(expensesByRoute).length;
    if (hasRouteAccounting && typeof state.setRouteFinancials !== 'function') {
      throw new Error('Native setRouteFinancials action is unavailable');
    }
    if (typeof state.setFinancialHistory !== 'function') throw new Error('Native setFinancialHistory action is unavailable');

    const targetElapsedSeconds = Number(posting.targetElapsedSeconds) || 0;
    const targetHour = Math.floor(Math.max(0, targetElapsedSeconds) / 3_600);
    const hourlyPostings = Array.isArray(posting.hourlyPostings) && posting.hourlyPostings.length
      ? posting.hourlyPostings.map((row) => ({
        ...structuredClone(row),
        hour: Number(row.hour),
        revenueByRoute: canonicalizeRouteAmounts(row.revenueByRoute),
        expensesByRoute: canonicalizeRouteAmounts(row.expensesByRoute),
      }))
      : [{
        hour: targetHour,
        revenue,
        expenses,
        expenseCategories,
        revenueByRoute,
        expensesByRoute,
      }];
    const openingWallet = Number(state.money) || 0;
    const openingFinancialHistory = structuredClone(state.financialHistory);
    const openingRouteFinancials = structuredClone(state.routeFinancials ?? {
      byRoute: {}, lastHourTimestamp: 0, currentHour: {},
    });
    const expensesAffectWallet = state.gameMode !== 'sandbox';

    if (revenue > 0) state.addRevenue(revenue, true);
    for (const [category, amount] of Object.entries(expenseCategories)) state.addExpense(amount, category);
    const expectedWallet = openingWallet + revenue - (expensesAffectWallet ? expenses : 0);
    const postedWallet = Number(this.#state().money);
    if (!Number.isFinite(postedWallet) || Math.abs(postedWallet - expectedWallet) > 1e-9) {
      // The dashboard backfill and balance are one accounting transaction. If
      // a native action updates only one side, repair the balance before the
      // history is published rather than displaying profit that was not paid.
      this.callbacks.setMoney(expectedWallet);
    }
    if (hasRouteAccounting) {
      state.setRouteFinancials(backfillHourlyRouteFinancials(
        openingRouteFinancials,
        hourlyPostings,
        targetElapsedSeconds,
      ));
    }
    const updated = this.#state();
    updated.setFinancialHistory(backfillHourlyFinancialHistory(
      openingFinancialHistory,
      hourlyPostings,
      {
        targetElapsedSeconds,
        openingWallet,
        expensesAffectWallet,
        receiptId: postingId,
      },
    ));
    const finalState = this.#state();
    if (Math.abs(Number(finalState.money) - expectedWallet) > 1e-9) {
      throw new Error('Background native finance violated the wallet accounting invariant');
    }
    return {
      applied: true,
      revenue,
      expenses,
      wallet: finalState.money,
      financialHistory: structuredClone(finalState.financialHistory),
    };
  }

  captureCrossTileNetworkProfile(tileId = this.loadedCityCode) {
    const gameState = this.api?.gameState;
    if (!gameState || typeof gameState.getStations !== 'function' || typeof gameState.getRoutes !== 'function' || typeof gameState.getTrains !== 'function') {
      throw new Error('Cross-tile network profile requires public station, route, and train getters');
    }
    return createNetworkProfile({
      tileId,
      stations: gameState.getStations(),
      routes: gameState.getRoutes(),
      trains: gameState.getTrains(),
      pathfindingRules: this.api?.utils?.getPathfindingRules?.() ?? {},
    });
  }

  async validateSnapshot(snapshot) {
    if (!validSave(snapshot)) throw new Error('Game returned an invalid save snapshot');
  }

  async reconcileActiveResults() {
    await this.assertSupported();
    return this.#state().getPrototypeActivity?.() ?? { departures: [], walletDelta: 0 };
  }

  async adoptStaticPackage(pkg, loadedCityCode) {
    await this.assertSupported();
    const expectedCity = pkg?.manifest?.cityCode ?? pkg?.manifest?.tileId;
    if (!expectedCity || loadedCityCode !== expectedCity) {
      throw new Error(`Loaded city/package mismatch: expected ${expectedCity}, got ${loadedCityCode}`);
    }
    const state = this.#state();
    if (state.cityCode !== loadedCityCode) state.setCityCode(loadedCityCode);
    this.currentPackage = pkg;
    this.loadedCityCode = loadedCityCode;
  }

  async loadStaticPackage(pkg) {
    await this.assertSupported();
    const manifest = pkg?.manifest;
    const cityCode = manifest?.cityCode ?? manifest?.tileId;
    if (!cityCode || !manifest?.dataFiles) throw new Error('Tile package requires manifest.cityCode/tileId and manifest.dataFiles');
    this.api.cities.setCityDataFiles(cityCode, nativeCityDataFiles(cityCode, manifest.dataFiles));
    if (manifest.city && typeof this.api.registerCity === 'function') this.api.registerCity(manifest.city);
    stabilizeMapLayerMoves(this.api?.utils?.getMap?.());
    await this.#state().loadInitialData(cityCode);
    stabilizeMapLayerMoves(this.api?.utils?.getMap?.());
    const state = this.#state();
    if (state.cityCode !== cityCode) state.setCityCode(cityCode);
    state.setTimeConfig({ paused: true });
    this.currentPackage = pkg;
    this.loadedCityCode = cityCode;
  }

  async restoreSnapshot(snapshot, {
    preserveNativeFinance = false,
    authoritativeFinanceSnapshot = null,
  } = {}) {
    await this.assertSupported();
    await this.validateSnapshot(snapshot);
    const expectedCity = this.currentPackage?.manifest?.cityCode ?? this.currentPackage?.manifest?.tileId ?? this.loadedCityCode;
    const stateBefore = this.#state();
    const expectedCityUid = stateBefore.cityCode === expectedCity
      ? stateBefore.cityUid ?? expectedCity
      : expectedCity;
    const authoritativeFinanceState = authoritativeFinanceSnapshot?.data
      ?? authoritativeFinanceSnapshot
      ?? stateBefore;
    const destinationSnapshot = bindSnapshotToCity(
      preserveNativeFinance
        ? preserveNativeFinancialStateInSnapshot(snapshot, authoritativeFinanceState, stateBefore)
        : snapshot,
      expectedCity,
      expectedCityUid,
    );
    const {
      nativeSnapshot,
      deferredRouteDefinitions,
    } = canonicalNativeRestorePlan(
      destinationSnapshot,
      this.nativeNetworkMode,
      typeof stateBefore.setRoutes === 'function',
    );
    const demandBefore = stateBefore.demandData;
    const popCountBefore = demandBefore?.popsMap?.size ?? 0;
    // loadSave synchronously rebuilds MapboxOverlay props. Install the guard
    // before that rebuild; onMapReady is too late for transient preview and
    // elevation layer anchors created during the restore itself.
    stabilizeMapLayerMoves(this.api?.utils?.getMap?.());
    const provenance = openWorldRuntimeSnapshotProvenance(destinationSnapshot);
    const restore = async () => {
      await this.#state().loadSave(nativeSnapshot);
      restoreDeferredRouteDefinitions(
        this.#state(),
        destinationSnapshot.data.routes,
        deferredRouteDefinitions,
      );
    };
    if (typeof this.nativeSaveLifecycle?.runInternalOperation === 'function') {
      await this.nativeSaveLifecycle.runInternalOperation({
        kind: 'runtime-snapshot-load',
        saveName: provenance.saveName,
        nativeSessionId: destinationSnapshot.gameSessionId ?? this.#state().gameSessionId ?? null,
        metadataMarked: provenance.marker != null,
      }, restore);
    } else await restore();
    stabilizeMapLayerMoves(this.api?.utils?.getMap?.());
    const stateAfter = this.#state();
    const popCountAfter = stateAfter.demandData?.popsMap?.size ?? 0;
    if (popCountBefore > 0 && popCountAfter === 0) {
      if (typeof stateAfter.setDemandData !== 'function') {
        throw new Error('Compact tile restore cleared native demand and setDemandData is unavailable');
      }
      stateAfter.setDemandData(demandBefore);
    }
    // A saved tile may have been running. The transition owns the only resume.
    this.#state().setTimeConfig({ paused: true });
  }

  nativeCommuteHealth() {
    const state = this.#state();
    const points = state.demandData?.points;
    const pops = state.demandData?.popsMap;
    let population = 0;
    let calculatedPops = 0;
    let calculatedPopulation = 0;
    let transitPopulation = 0;
    let danglingPops = 0;
    let popsWithTransitPaths = 0;
    let populationWithTransitPaths = 0;
    let totalTransitPaths = 0;
    let directionalPops = 0;
    let directionalCompletePops = 0;
    let directionalLegs = 0;
    const modeChoicePopulation = { driving: 0, walking: 0, transit: 0, unknown: 0 };
    const modeChoicePopulationByDirection = Object.fromEntries(
      NATIVE_COMMUTE_DIRECTIONS.map((direction) => [
        direction,
        { driving: 0, walking: 0, transit: 0, unknown: 0 },
      ]),
    );
    const samples = { withTransitPath: [], withoutTransitPath: [] };
    const summarizePop = (pop, paths) => ({
      id: pop.id,
      size: pop.size ?? 0,
      residenceId: pop.residenceId,
      jobId: pop.jobId,
      drivingSeconds: pop.drivingSeconds,
      drivingDistance: pop.drivingDistance,
      walkingTime: pop.lastCommute?.walking?.time,
      modeChoice: pop.lastCommute?.modeChoice,
      transitPathCount: paths.length,
      firstTransitPath: paths[0] ? {
        keys: Object.keys(paths[0]),
        fareCost: paths[0].fareCost,
        departureTime: paths[0].departureTime,
        arrivalTime: paths[0].arrivalTime,
        totalTime: paths[0].totalTime,
        perceivedTime: paths[0].perceivedTime,
        timeBreakdown: paths[0].timeBreakdown,
        segmentCount: paths[0].segments?.length,
        segments: paths[0].segments?.slice?.(0, 4)?.map?.((segment) => ({
          type: segment.type,
          fromStationId: segment.fromStationId,
          toStationId: segment.toStationId,
          departureTime: segment.departureTime,
          arrivalTime: segment.arrivalTime,
          trainId: segment.trainId,
          routeId: segment.routeId,
        })),
      } : null,
    });
    for (const pop of pops?.values?.() ?? []) {
      population += pop.size ?? 0;
      if (!points?.has?.(pop.residenceId) || !points?.has?.(pop.jobId)) danglingPops++;
      const directionalSummaries = NATIVE_COMMUTE_DIRECTIONS
        .map((direction) => [direction, pop?.commutes?.[direction]])
        .filter(([, summary]) => summary?.modeChoice);
      if (directionalSummaries.length > 0) directionalPops++;
      if (directionalSummaries.length === NATIVE_COMMUTE_DIRECTIONS.length) directionalCompletePops++;
      directionalLegs += directionalSummaries.length;
      for (const [direction, summary] of directionalSummaries) {
        for (const key of Object.keys(modeChoicePopulation)) {
          modeChoicePopulationByDirection[direction][key] += summary.modeChoice[key] ?? 0;
        }
      }
      const mode = pop?.commutes?.homeToWork?.modeChoice ?? pop.lastCommute?.modeChoice;
      if (mode) {
        calculatedPops++;
        calculatedPopulation += (mode.driving ?? 0) + (mode.walking ?? 0) + (mode.transit ?? 0);
        transitPopulation += mode.transit ?? 0;
        for (const key of Object.keys(modeChoicePopulation)) modeChoicePopulation[key] += mode[key] ?? 0;
        const paths = Array.isArray(pop.lastCommute?.transitPaths) ? pop.lastCommute.transitPaths : [];
        if (paths.length > 0) {
          popsWithTransitPaths++;
          populationWithTransitPaths += pop.size ?? 0;
          totalTransitPaths += paths.length;
          if (samples.withTransitPath.length < 3) samples.withTransitPath.push(summarizePop(pop, paths));
        } else if (samples.withoutTransitPath.length < 3) {
          samples.withoutTransitPath.push(summarizePop(pop, paths));
        }
      }
    }
    let modeChoiceStatisticsSource = 'private-store-fallback';
    if (typeof this.api?.gameState?.getModeChoiceStats === 'function') {
      try {
        for (const direction of NATIVE_COMMUTE_DIRECTIONS) {
          const publicStats = this.api.gameState.getModeChoiceStats(direction);
          if (!publicStats || typeof publicStats !== 'object') throw new Error(`Invalid ${direction} mode-choice statistics`);
          modeChoicePopulationByDirection[direction] = Object.fromEntries(
            Object.keys(modeChoicePopulation).map((key) => [key, Number(publicStats[key]) || 0]),
          );
        }
        modeChoiceStatisticsSource = 'public-game-state';
      } catch {
        // Keep the private aggregate as a compatibility fallback. Mutation and
        // per-pop completeness still require the store until the public API
        // exposes equivalent lifecycle controls.
      }
    }
    return {
      cityCode: state.cityCode,
      elapsedSeconds: state.timeConfig?.elapsedSeconds,
      points: points?.size ?? 0,
      pops: pops?.size ?? 0,
      population,
      danglingPops,
      calculatedPops,
      calculatedPopulation,
      transitPopulation,
      popsWithTransitPaths,
      populationWithTransitPaths,
      totalTransitPaths,
      directionalPops,
      directionalCompletePops,
      directionalLegs,
      modeChoicePopulation,
      modeChoicePopulationByDirection,
      modeChoiceStatisticsSource,
      directionalRestorePolicy: DIRECTIONAL_COMMUTE_RESTORE_POLICY,
      samples,
      activeMovements: state.popMovementsMap?.size ?? 0,
      completedCommutes: state.completedCommutes?.length ?? 0,
      stations: state.stations?.filter?.((station) => station.buildType === 'constructed').length ?? 0,
      routes: state.routes?.length ?? 0,
      trains: state.trains?.length ?? 0,
    };
  }

  /**
   * Repair commute results calculated by StoreInitializer before a compact
   * tile snapshot restores that tile's stations, routes, and trains.
   */
  async refreshNativeCommutes() {
    await this.assertSupported();
    const state = this.#state();
    const pops = Array.from(state.demandData?.popsMap?.values?.() ?? []);
    if (pops.length === 0) return { status: 'no-demand', popCount: 0 };
    const hasClippedService = (state.routes ?? []).some((route) => (
      route?.openWorldProjectionDormant
      && (route.openWorldNativeCommuteRoute?.stNodes?.length ?? 0) > 1
      && (route.openWorldNativeCommuteTrains?.length ?? 0) > 0
      && (route.openWorldNativeCommuteStations?.length ?? 0) > 0
    ));
    if (!(state.stations?.length > 0 && state.routes?.length > 0
      && (state.trains?.length > 0 || hasClippedService))) {
      return { status: 'no-network', popCount: pops.length };
    }
    if (typeof state.simulateCommutes !== 'function') {
      return { status: 'unavailable', popCount: pops.length };
    }

    const before = this.nativeCommuteHealth();
    const smallCohortCount = pops.reduce((count, pop) => count + ((pop.size ?? 0) < 10 ? 1 : 0), 0);
    const lodesSizedDemand = smallCohortCount / pops.length >= 0.5;
    const rules = this.api?.utils?.getPathfindingRules?.();
    const currentFloor = rules?.MIN_TRANSIT_CHOICE;
    if (lodesSizedDemand && Number.isFinite(currentFloor) && typeof this.api?.modifyPathfindingRules === 'function') {
      this.nativeMinTransitChoice ??= currentFloor === 1 ? SUBWAY_BUILDER_1_6_MIN_TRANSIT_CHOICE : currentFloor;
      if (currentFloor !== 1) this.api.modifyPathfindingRules({ MIN_TRANSIT_CHOICE: 1 });
      this.lodesTransitFloorActive = true;
    } else if (!lodesSizedDemand && currentFloor === 1 && typeof this.api?.modifyPathfindingRules === 'function') {
      // Recover from a hot reload of an earlier prototype build that lowered
      // the process-global rule before native cohorts were aggregated.
      this.api.modifyPathfindingRules({ MIN_TRANSIT_CHOICE: SUBWAY_BUILDER_1_6_MIN_TRANSIT_CHOICE });
      this.lodesTransitFloorActive = false;
    }
    const forceClippedRouteRefresh = this.clippedRouteCommuteRefreshPending === true;
    if (!forceClippedRouteRefresh
      && (before.popsWithTransitPaths > 0 || before.transitPopulation > 0)
      && before.directionalCompletePops === pops.length
      && !(this.lodesTransitFloorActive && before.transitPopulation === 0)) {
      return { status: 'already-current', popCount: pops.length, before };
    }

    // updateStats reads the population's current lastCommute when an existing
    // movement completes, rather than the journey captured by that movement.
    // Replacing lastCommute mid-journey (especially with a no-path result)
    // therefore makes native completion dereference transitPaths[0].segments.
    const originalMovements = state.popMovementsMap instanceof Map ? state.popMovementsMap : new Map();
    const validMovements = new Map();
    let droppedInvalidMovements = 0;
    for (const [key, movement] of originalMovements) {
      const popId = String(movement?.popId ?? key);
      const pop = state.demandData?.popsMap?.get?.(popId);
      const hasJourney = (pop?.lastCommute?.transitPaths ?? []).some((path) => (
        Array.isArray(path?.segments) && path.segments.length > 0
      ));
      if (hasJourney) validMovements.set(key, movement);
      else droppedInvalidMovements++;
    }
    if (droppedInvalidMovements > 0) {
      if (typeof state.setPopMovementsMap === 'function') state.setPopMovementsMap(validMovements);
      else state.popMovementsMap = validMovements;
      const emptyStationTrainMovements = { stations: new Map(), trains: new Map() };
      if (typeof state.setAllStationTrainPopMovements === 'function') {
        state.setAllStationTrainPopMovements(emptyStationTrainMovements);
      } else state.allStationTrainPopMovements = emptyStationTrainMovements;
      const emptyGeojson = { type: 'FeatureCollection', features: [] };
      if (typeof state.setPopMovementGeojson === 'function') state.setPopMovementGeojson(emptyGeojson);
      else state.popMovementGeojson = emptyGeojson;
    }
    const activePopIds = new Set();
    for (const [key, movement] of validMovements) {
      if (key != null) activePopIds.add(String(key));
      if (movement?.popId != null) activePopIds.add(String(movement.popId));
    }
    const popCommutes = pops
      .filter((pop) => typeof pop?.id === 'string'
        && pop.id.length > 0
        && !activePopIds.has(pop.id))
      .flatMap((pop) => NATIVE_COMMUTE_DIRECTIONS.map((direction) => ({ popId: pop.id, direction })));
    if (popCommutes.length === 0) {
      return {
        status: 'active-journeys-only', popCount: pops.length, skippedActivePops: activePopIds.size,
        droppedInvalidMovements, before,
      };
    }
    try {
      await state.simulateCommutes({ popCommutes, startMovements: false });
      this.clippedRouteCommuteRefreshPending = false;
      return {
        status: 'recalculated',
        reason: forceClippedRouteRefresh ? 'clipped-route-hydration' : 'stale-native-commutes',
        popCount: popCommutes.length,
        skippedActivePops: activePopIds.size,
        droppedInvalidMovements,
        before,
        after: this.nativeCommuteHealth(),
      };
    } catch (error) {
      return { status: 'failed', popCount: popCommutes.length, before, error: String(error?.message ?? error) };
    }
  }

  restoreNativeCommuteRules() {
    if (!this.lodesTransitFloorActive || !Number.isFinite(this.nativeMinTransitChoice)) return false;
    if (typeof this.api?.modifyPathfindingRules !== 'function') return false;
    this.api.modifyPathfindingRules({ MIN_TRANSIT_CHOICE: this.nativeMinTransitChoice });
    this.lodesTransitFloorActive = false;
    return true;
  }

  async setAuthoritativeGameMode(gameMode) {
    if (gameMode == null) return false;
    if (!['easy', 'sandbox'].includes(gameMode)) throw new Error('Invalid authoritative game mode');
    const state = this.#state();
    if (typeof state.setGameMode !== 'function') throw new Error('Native setGameMode action is unavailable');
    state.setGameMode(gameMode);
    if (gameMode === 'sandbox' && state.money !== Number.MAX_SAFE_INTEGER) {
      this.callbacks.setMoney(Number.MAX_SAFE_INTEGER);
    }
    return true;
  }

  async setAuthoritativeClock(elapsedSeconds) {
    await this.assertSupported();
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
      throw new Error('Invalid authoritative game time');
    }
    this.#state().setTimeConfig({ elapsedSeconds: Math.round(elapsedSeconds), paused: true });
  }

  async setAuthoritativeGlobals({ worldTime, elapsedSeconds = worldTime * 3600, wallet, gameMode = null, farePolicy, financialHistory }) {
    await this.assertSupported();
    if (!Number.isFinite(worldTime) || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || !Number.isFinite(wallet)) throw new Error('Invalid authoritative world globals');
    await this.setAuthoritativeGameMode(gameMode);
    this.callbacks.setMoney(wallet);
    this.callbacks.setTicketCost(farePolicy?.fare ?? 0);
    if (financialHistory) {
      const state = this.#state();
      if (typeof state.setFinancialHistory !== 'function') throw new Error('Native setFinancialHistory action is unavailable');
      state.setFinancialHistory(structuredClone(financialHistory));
    }
    // Exact game time is separate from the integral-hour inactive simulation clock.
    this.#state().setTimeConfig({ elapsedSeconds: Math.round(elapsedSeconds), paused: true });
  }

  async restoreCamera(camera) {
    await this.assertSupported();
    if (!camera) return;
    const map = this.api?.utils?.getMap?.();
    if (typeof map?.jumpTo === 'function') map.jumpTo(camera);
  }

  async verifyLoaded() {
    await this.assertSupported();
    const expectedCity = this.currentPackage?.manifest?.cityCode ?? this.currentPackage?.manifest?.tileId;
    let actualCity = this.readLoadedCityCode();
    for (let attempt = 1; expectedCity && actualCity !== expectedCity && attempt < CITY_SETTLE_ATTEMPTS; attempt++) {
      // onCityLoad is dispatched during the router/store handoff. Yield while
      // the live Zustand snapshot catches up, without adding visible delay.
      await new Promise((resolve) => setTimeout(resolve, 0));
      actualCity = this.readLoadedCityCode();
    }
    if (expectedCity && actualCity !== expectedCity) throw new Error(`Loaded city mismatch: expected ${expectedCity}, got ${actualCity}`);
    let stablePausedReads = 0;
    for (let attempt = 0; attempt < PAUSE_SETTLE_ATTEMPTS; attempt++) {
      // The load transaction owns the pause until commit. A user can click
      // play while the map is already visible, and late native load writes can
      // also restore an older running timeConfig. Reclaim the pause whenever
      // either happens, then require it to survive a second observation.
      // Always read a fresh immutable Zustand snapshot.
      if (this.#state().timeConfig?.paused === true) {
        stablePausedReads++;
        if (stablePausedReads >= 2) return;
      } else {
        stablePausedReads = 0;
        this.#state().setTimeConfig({ paused: true });
      }
      await new Promise((resolve) => setTimeout(resolve, PAUSE_SETTLE_DELAY_MS));
    }
    throw new Error('Game is not paused after tile load');
  }

  async captureRuntime() {
    return { native: await this.captureSnapshot(), package: this.currentPackage, paused: await this.isPaused() };
  }

  async restoreRuntime(runtime) {
    // The runtime owns resumption in its finally block. Leaving this paused avoids a double resume.
    await this.pause();
    if (runtime.package) await this.loadStaticPackage(runtime.package);
    await this.restoreSnapshot(runtime.native);
  }
}
