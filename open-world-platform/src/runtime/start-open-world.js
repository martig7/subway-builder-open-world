import { LOAD_DIAGNOSTICS_VERSION, WorldTileRuntime } from './world-tile-runtime.js';
import {
  readLiveSubwayBuilderCityCode,
  SUBWAY_BUILDER_CITY_AUTHORITY_VERSION,
  NATIVE_TILE_SNAPSHOT_COPY_VERSION,
  SubwayBuilderGameAdapter,
} from './adapters/subway-builder-game-adapter.js';
import { ModStorageWorldStateAdapter } from './adapters/mod-storage-world-state-adapter.js';
import { SerializedStorageAdapter } from './adapters/serialized-storage-adapter.js';
import {
  DurableStorageAdapter,
  IndexedDbRecordStore,
} from './adapters/durable-storage-adapter.js';
import { HashCityNavigationAdapter } from './adapters/hash-city-navigation-adapter.js';
import { registerCrossDemandViewer } from './ui/cross-demand-viewer.js';
import { registerNetworkProjectionOverlay } from './ui/network-projection-overlay.js';
import { EmbeddedTilePackageAdapter, resolveRendererDataUrl } from './embedded-tile-package-adapter.js';
import { createOpenWorldCatalog } from './open-world-catalog.js';
import { createOpenWorldCityRegistration } from './open-world-city-registration.js';
import { createDailyModeShareInvalidation, registerCrossTileClockHooks, registerModeShareInvalidationHooks } from './mode-share-hook-policy.js';
import {
  installTransientLayerOrderConsoleFilter,
  stabilizeMapLayerMoves,
} from './map-layer-stability.js';
import { relaxMapZoomLimits } from './map-zoom-limits.js';
import { registerGeographicContextOverlay } from './ui/geographic-context-overlay.js';
import { createWorldVegetationLoader } from './ui/world-vegetation.js';
import { registerRenderDistanceToolbar } from './ui/render-distance-panel.js';
import {
  refreshCityScopedMapArtifacts,
  syncCityScopedMapControllers,
} from './ui/city-scoped-map-controllers.js';
import {
  WorldIdentityResolver,
  WORLD_IDENTITY_BINDING_VERSION,
  worldIdentityLoadOptions,
} from './world-identity.js';
import { createNativeSaveLifecycle } from './autosave-hook-guard.js';
import { installDrivingRoutePathFetch } from './driving-route-path-server.js';
import { NativeRevenueAccrual } from './native-revenue-accrual.js';
import { stageNativeRecovery } from './native-reload-recovery.js';
import { installNativeSavedReloadGuard } from './native-saved-reload-guard.js';
import { findNativeAutosaveRef, installNativeAutosaveIdleGuard } from './native-autosave-idle-guard.js';
import { createOpenWorldRoutePaths } from './route-path-controller.js';
import { storedRouteLoader } from './stored-route-paths.js';
import { createCrossModeShareEvaluator } from './cross-mode-share-evaluator.js';
import { monitorSharedTileServerHealth } from './tile-server-health.js';
import { createCachedSimulation } from './cached-simulation.js';
import { createNativeRoadLabelSourceGuard } from './native-road-label-source.js';

export const RUNTIME_AUDIT_VERSION = 'runtime-audit-2026-09-v1';

export const OPEN_WORLD_PLATFORM_RELEASE = 'open-world-platform-v1';
export const STARTUP_MAP_RECOVERY_VERSION = 'startup-map-recovery-v1';

export function startOpenWorld({
  definition,
  catalogSource,
  boundaryOverlay = null,
  artifacts,
  subwayBuilderHost = globalThis.SubwayBuilderAPI,
  workerSources = {},
  authoritativeCityCode: initialAuthoritativeCityCode = null,
} = {}) {
  const worldVegetationLoader = createWorldVegetationLoader(artifacts?.worldVegetationGzipBase64);
  if (!definition?.identity?.worldId || !definition?.runtime?.diagnosticNamespace) {
    throw new Error('startOpenWorld requires a validated World Definition');
  }
  if (!artifacts?.commuteCatalog || !artifacts?.crossDemandGzipBase64) {
    throw new Error('startOpenWorld requires embedded world demand artifacts');
  }
  const namespace = definition.runtime.diagnosticNamespace;
  const logLabel = `[${definition.identity.name}]`;
  const PENDING_NAVIGATION_KEY = `${namespace}:pending-navigation`;
  const PENDING_PERFORMANCE_KEY = `${namespace}:pending-performance`;
  const DIAGNOSTICS_KEY = 'diagnostics:tile-transitions';
  const CURRENT_CANONICAL_WORLD_ID = definition.identity.worldId;
  const DURABLE_STORAGE_VERSION = 'open-world-sidecar-indexeddb-v1';
  const DURABLE_STORAGE_DATABASE = definition.runtime.storageNamespace;
  const SAVE_AUTHORITY_VERSION = 'native-save-authority-v1';
  const globalStem = namespace.replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase());
  const { tileCatalog, tileById } = createOpenWorldCatalog({ definition, catalogSource, boundaryOverlay });
  const {
    refreshPilotCityBindings,
    registerPilotCities,
    repairPilotMapCamera,
    repairPilotMapTileSource,
    tileUrl,
  } = createOpenWorldCityRegistration({ definition, tileCatalog });
  const api = subwayBuilderHost;
  if (!api) throw new Error(`${logLabel} SubwayBuilderAPI is unavailable`);
  const tileBase = globalThis[definition.runtime.tileBaseGlobal]
    ?? `http://127.0.0.1:${definition.runtime.tileServerPort}`;
  const registration = registerPilotCities(api, { tileBase });
  const dormantRuntimeKey = `__${globalStem}DormantRuntimeV1__`;
  const activeRuntimeKey = `__${globalStem}ActiveRuntimeV1__`;
  globalThis[activeRuntimeKey]?.dispose?.();
  const startupCityCode = typeof initialAuthoritativeCityCode === 'string'
    && initialAuthoritativeCityCode
    ? initialAuthoritativeCityCode
    : readLiveSubwayBuilderCityCode({ api });

  if (!registration.cities.includes(startupCityCode)) {
    globalThis[dormantRuntimeKey]?.dispose?.();
    const subscriptions = [];
    let dormantController = null;
    let activeController = null;
    const dispose = () => {
      for (const unsubscribe of subscriptions.splice(0)) {
        try { unsubscribe?.(); } catch {}
      }
      if (globalThis[dormantRuntimeKey] === dormantController) delete globalThis[dormantRuntimeKey];
    };
    const activate = (event, payload, cityCode = readLiveSubwayBuilderCityCode({ api })) => {
      if (!registration.cities.includes(cityCode)) return null;
      if (!activeController) {
        dispose();
        activeController = startOpenWorld({
          definition,
          catalogSource,
          boundaryOverlay,
          artifacts,
          subwayBuilderHost: api,
          workerSources,
          authoritativeCityCode: cityCode,
        });
      }
      if (event === 'game-init') return activeController?.lifecycle?.gameInit?.();
      if (event === 'game-loaded') return activeController?.lifecycle?.gameLoaded?.(payload);
      if (event === 'city-load') {
        return activeController?.lifecycle?.cityLoad?.(cityCode, { authoritative: true });
      }
      return activeController;
    };
    subscriptions.push(
      api.hooks.onGameInit?.(() => activate('game-init')),
      api.hooks.onGameLoaded?.((saveName) => activate('game-loaded', saveName)),
      api.hooks.onCityLoad?.((cityCode) => activate('city-load', null, cityCode)),
    );
    dormantController = Object.freeze({
      platformRelease: OPEN_WORLD_PLATFORM_RELEASE,
      definition,
      registration,
      status: 'dormant',
      dispose,
    });
    globalThis[dormantRuntimeKey] = dormantController;
    console.info(`${logLabel} dormant until a registered city becomes active`, {
      activeCityCode: startupCityCode,
      cities: registration.cities,
    });
    return dormantController;
  }

  globalThis[dormantRuntimeKey]?.dispose?.();
  delete globalThis[dormantRuntimeKey];

  if (typeof globalThis.window !== 'undefined') {
    void monitorSharedTileServerHealth({
      tileBase,
      fetchImpl: globalThis.fetch?.bind(globalThis),
      notify: (...args) => api.ui?.showNotification?.(...args),
      documentObject: globalThis.document,
    });
  }

  function heapBytes() {
    return Number(globalThis.performance?.memory?.usedJSHeapSize) || null;
  }

  function readPendingPerformance() {
    try { return JSON.parse(globalThis.sessionStorage?.getItem(PENDING_PERFORMANCE_KEY) ?? 'null'); } catch { return null; }
  }

  function writePendingPerformance(value) {
    globalThis.sessionStorage?.setItem(PENDING_PERFORMANCE_KEY, JSON.stringify(value));
  }

  for (const staleNamespace of new Set(['nec-corridor', namespace])) {
    api.ui?.unregisterComponent?.('top-bar', `${staleNamespace}-world-saves`);
  }
  api.ui?.unregisterComponent?.('main-menu', `${namespace}-world-saves-home`);
  installTransientLayerOrderConsoleFilter();
  stabilizeMapLayerMoves(api.utils?.getMap?.());
  relaxMapZoomLimits(api.utils?.getMap?.(), { sourceMinZoom: tileCatalog.basemapMinZoom });
  const generationKey = `__${globalStem}Generation__`;
  const generation = (Number(globalThis[generationKey]) || 0) + 1;
  globalThis[generationKey] = generation;
  let moduleDisposed = false;
  const isCurrent = () => !moduleDisposed && globalThis[generationKey] === generation;
  const hookDisposers = [];
  const ownedHooks = Object.fromEntries([
    'onGameInit', 'onGameLoaded', 'onGameSaved', 'onMapReady', 'onCityLoad',
    'onHourChange', 'onDayChange', 'onScheduleChange', 'onTicketPriceChanged', 'onFareGroupsChanged', 'onGameEnd',
  ].map(name => [name, callback => {
    const unsubscribe = api.hooks[name]?.(callback);
    if (typeof unsubscribe === 'function') hookDisposers.push(unsubscribe);
    return unsubscribe;
  }]));
  let authoritativeCityCode = registration.cities.includes(initialAuthoritativeCityCode)
    ? initialAuthoritativeCityCode
    : null;
  let storeConfirmedAuthoritativeCity = authoritativeCityCode != null
    && readLiveSubwayBuilderCityCode({ api }) === authoritativeCityCode;
  let rejectUnsignaledStoreCityChanges = false;
  let navigation = null;
  const currentCityCode = (observedCityCode = null) => {
    const liveCityCode = readLiveSubwayBuilderCityCode({ api });
    if (typeof observedCityCode === 'string' && observedCityCode) {
      rejectUnsignaledStoreCityChanges = false;
      authoritativeCityCode = observedCityCode;
      storeConfirmedAuthoritativeCity = liveCityCode === observedCityCode;
      return observedCityCode;
    }
    const pendingCityCode = navigation?.pending?.()?.tileId;
    if (typeof pendingCityCode === 'string' && pendingCityCode) return pendingCityCode;
    if (typeof authoritativeCityCode === 'string' && authoritativeCityCode) {
      if (liveCityCode === authoritativeCityCode) storeConfirmedAuthoritativeCity = true;
      else if (storeConfirmedAuthoritativeCity && liveCityCode && !rejectUnsignaledStoreCityChanges) {
        // Once Zustand has confirmed an authoritative event, an unsuppressed
        // later store change is a new lifecycle state even if the public
        // getter is stale.
        authoritativeCityCode = liveCityCode;
      }
      return authoritativeCityCode;
    }
    return liveCityCode;
  };
  const loadTrace = (event, details = {}) => console.log(
    `[DEBUG-${namespace.toUpperCase()}-LOAD-CLASSIFY]`,
    event,
    { generation, capturedAt: Date.now(), ...details },
  );
  loadTrace('generation.installed', {
    currentGeneration: globalThis[generationKey],
    cityCode: currentCityCode(),
    saveName: api.gameState.getSaveName?.() ?? null,
    nativeSessionId: api.gameState.getGameSessionId?.() ?? null,
  });
  const nativeSaveLifecycle = createNativeSaveLifecycle({
    sessionStorage: globalThis.sessionStorage,
    storageKey: `${namespace}:pending-native-save-echo`,
    trace: loadTrace,
  });
  const rawStorage = api.storage?.scoped?.();
  const durableStorageKey = `__${globalStem}DurableStorageV1__`;
  let durableStorage = globalThis[durableStorageKey];
  if (!durableStorage && typeof globalThis.indexedDB?.open === 'function') {
    durableStorage = new DurableStorageAdapter({
      recordStore: new IndexedDbRecordStore({
        indexedDB: globalThis.indexedDB,
        databaseName: DURABLE_STORAGE_DATABASE,
      }),
      // The old 80+ MB scoped document is migration input only. New values,
      // updates, tombstones, and maintenance all go to individual IDB records.
      legacyStorage: rawStorage,
    });
    globalThis[durableStorageKey] = durableStorage;
  }
  if (!durableStorage && rawStorage) {
    console.warn(`${logLabel} IndexedDB is unavailable; using legacy shared-document storage`);
    durableStorage = rawStorage;
  }
  globalThis[`__${globalStem}StorageDiagnostics__`] = {
    version: DURABLE_STORAGE_VERSION,
    backend: durableStorage === rawStorage ? 'legacy-scoped-document' : 'indexeddb-per-record',
    legacyReadOnly: Boolean(rawStorage && durableStorage !== rawStorage),
  };
  const storageCoordinatorKey = '__nyStateScopedStorageCoordinator__';
  const storageCoordinator = globalThis[storageCoordinatorKey] ??= { tail: Promise.resolve() };
  const storage = durableStorage
    ? new SerializedStorageAdapter({ storage: durableStorage, coordinator: storageCoordinator })
    : durableStorage;
  const identities = new WorldIdentityResolver({
    storage,
    fallbackWorldId: namespace,
    canonicalWorldId: CURRENT_CANONICAL_WORLD_ID,
  });
  const game = new SubwayBuilderGameAdapter({ api, nativeSaveLifecycle });
  const electron = globalThis.window?.electron ?? globalThis.electron;
  const nativeReloadRecovery = installNativeSavedReloadGuard({
    globalObject: globalThis,
    electron,
    location: globalThis.location,
    getSessionId: () => api.gameState.getGameSessionId?.(),
    getCityCode: () => currentCityCode(),
    getLoadedSave: () => game.nativeSaveReference(),
  });
  const revenueAccrual = new NativeRevenueAccrual({ adapter: game });
  navigation = new HashCityNavigationAdapter({
    tileIds: registration.tileIds,
    pendingKey: PENDING_NAVIGATION_KEY,
  });
  const routePathRuntimeKey = `__${globalStem}RoutePathRuntimeV1__`;
  globalThis[routePathRuntimeKey]?.dispose?.();
  delete globalThis[routePathRuntimeKey];
  const tilePackages = new EmbeddedTilePackageAdapter(registration.tileIds, artifacts, {
    tileById,
    worldLabel: definition.identity.name,
    loadCityData: api.utils?.loadCityData?.bind(api.utils),
    fetchData: globalThis.fetch?.bind(globalThis),
    resolveDataUrl: (path) => resolveRendererDataUrl(path),
    nativeDemandWorkerSource: workerSources.nativeDemandEvaluator ?? null,
  });
  let latestMap = api.utils?.getMap?.() ?? null;
  let autosaveIdleGuard = null, autosaveIdleMap = null;
  const noteAutosaveMapMovement = () => autosaveIdleGuard?.noteMovement?.();
  function detachAutosaveIdleGuard() {
    autosaveIdleMap?.off?.('move', noteAutosaveMapMovement);
    autosaveIdleGuard?.dispose();
    autosaveIdleGuard = null;
    autosaveIdleMap = null;
  }
  function attachAutosaveIdleGuard() {
    if (!latestMap || !ownsCurrentCity()) return;
    if (autosaveIdleGuard?.installed && autosaveIdleMap === latestMap) return;
    detachAutosaveIdleGuard();
    autosaveIdleGuard = installNativeAutosaveIdleGuard({
      ref: findNativeAutosaveRef(),
      isMoving: () => Boolean(latestMap?.isMoving?.()),
      getIdentity: () => ownsCurrentCity() ? `${api.gameState.getGameSessionId?.()}:${currentCityCode()}` : null,
    });
    autosaveIdleMap = latestMap;
    autosaveIdleMap.on?.('move', noteAutosaveMapMovement);
  }
  let navigationCamera = null;
  function rememberNavigationCamera(pending) {
    if (!pending?.from || !pending.tileId) return;
    const key = pending.transitionId ?? `${pending.from}->${pending.tileId}`;
    if (navigationCamera?.key !== key) navigationCamera = { key, tileId: pending.tileId, maps: new WeakSet() };
  }
  rememberNavigationCamera(navigation.pending());
  let crossDemandController = null;
  let projectionOverlayController = null;
  let geographicContextController = null;
  let gridTileSwitchingId = null;
  let tileSourceStyleHandler = null;
  let renderDistanceToolbarRegistered = false;
  const diagnostics = globalThis[`__${globalStem}Diagnostics__`] = {
    runtimeAuditVersion: RUNTIME_AUDIT_VERSION,
    generation,
    platformRelease: OPEN_WORLD_PLATFORM_RELEASE,
    startupMapRecoveryVersion: STARTUP_MAP_RECOVERY_VERSION,
    cityAuthorityVersion: SUBWAY_BUILDER_CITY_AUTHORITY_VERSION,
    worldDefinitionHash: artifacts.worldDefinitionHash ?? null,
    saveAuthorityVersion: SAVE_AUTHORITY_VERSION,
    hotReloadDraftCacheVersion: 2,
    loadDiagnosticsVersion: LOAD_DIAGNOSTICS_VERSION,
    registeredAt: Date.now(),
    transitions: [],
    autosaves: [],
    latestAutosave: null,
    authoritativeLoads: [],
    identityBindingVersion: WORLD_IDENTITY_BINDING_VERSION,
    snapshotCopyVersion: NATIVE_TILE_SNAPSHOT_COPY_VERSION,
    latestAuthoritativeLoad: null,
    latest: null,
  };
  let authoritativeLoadSequence = 0;
  function createAuthoritativeLoadTraceId(kind, tileId, nativeSessionId) {
    authoritativeLoadSequence += 1;
    return `${generation}:${authoritativeLoadSequence}:${kind}:${tileId ?? 'unknown'}:${nativeSessionId ?? 'unknown'}`;
  }
  function recordAuthoritativeLoad(event) {
    const entry = {
      sequence: diagnostics.authoritativeLoads.length + 1,
      capturedAt: Date.now(),
      ...event,
    };
    diagnostics.latestAuthoritativeLoad = entry;
    diagnostics.authoritativeLoads.push(entry);
    if (diagnostics.authoritativeLoads.length > 250) diagnostics.authoritativeLoads.splice(0, 50);
    return entry;
  }
  const capability = game.probe();
  diagnostics.capability = capability;
  if (!capability.supported) {
    console.error(`${logLabel} Unsupported game/API seam; no mutations performed`, capability);
    api.ui?.showNotification?.(`${definition.identity.name} disabled: incompatible game seam`, 'error');
    return;
  }
  let session = null;
  diagnostics.nativeNetworkMode = game.activateCanonicalNativeNetworkMode();
  diagnostics.trackGroupLoadGuard = game.installTrackGroupLoadGuard();
  diagnostics.simulationPerformance = game.installSimulationPerformanceDiagnostics();

  const worldState = new ModStorageWorldStateAdapter({
    storage,
    diagnostics: recordAuthoritativeLoad,
    financeMode: 'blind',
  });
  const runtime = new WorldTileRuntime({
    game,
    tilePackages,
    tileIds: registration.tileIds,
    tileCatalog,
    worldState,
    revenueAccrual,
    // Subway Builder's canonical native topology remains loaded across Open World
    // tiles and is the sole authority for every operating/infrastructure cost.
    backgroundNativeExpenses: false,
    evaluateCrossModeShares: (input) => {
      if (!session) throw new Error('Open World session ended before demand evaluation');
      return session.crossModeShares.evaluate(input);
    },
    initialWorld: { activeTileId: definition.tileViews.initialTileId, wallet: 1_000_000, cohorts: [] },
    telemetry: (event) => {
      if (event?.phase === 'authoritative-load') {
        recordAuthoritativeLoad(event);
        return;
      }
      if (event?.phase === 'startup-performance') diagnostics.startupRuntime = event;
      console.debug(logLabel, event);
    },
  });
  diagnostics.revenueSnapshot = async () => ({
    ...await runtime.inspectNativeRevenue(),
    lifecycle: { ready, settlementReady, currentGeneration: isCurrent(), observedCityCode: currentCityCode() },
    latestSettlement: diagnostics.latestSettlement ?? null,
  });
  const stageTransition = runtime.stageNavigationTransition.bind(runtime);
  runtime.stageNavigationTransition = async (tileId, options = {}) => {
    const sample = {
      fromTileId: runtime.getActiveTileId(),
      toTileId: tileId,
      startedAt: Date.now(),
      startHeapBytes: heapBytes(),
    };
    writePendingPerformance(sample);
    const resumeRecoveryCheckpoint = await nativeReloadRecovery.suspendForTileNavigation?.();
    try {
      const requestedRecoveryStage = options.stageNativeRecovery;
      const result = await stageTransition(tileId, {
        ...options,
        stageNativeRecovery: async (snapshot, transition) => {
          const stages = [];
          try {
            stages.push(await stageNativeRecovery({
              electron,
              snapshot,
              sourceCityCode: transition.from,
              destinationCityCode: transition.to,
              reason: 'tile-navigation',
              transitionId: transition.transitionId,
            }));
            if (typeof requestedRecoveryStage === 'function') {
              stages.push(await requestedRecoveryStage(snapshot, transition));
            }
          } catch (error) {
            for (const stage of stages.reverse()) {
              try { await stage?.rollback?.(); } catch {}
            }
            throw error;
          }
          return {
            async rollback() {
              for (const stage of stages.reverse()) await stage?.rollback?.();
            },
          };
        },
      });
      if (result?.status === 'reload-required') {
        // Native city teardown begins after this promise resolves and emits
        // route/schedule hooks before onCityLoad. Treat that whole interval as
        // an internal view transition, not as a player network edit.
        ready = false;
        settlementReady = false;
      } else {
        resumeRecoveryCheckpoint?.();
      }
      writePendingPerformance({ ...sample, stagedAt: Date.now(), transitionId: result.transitionId });
      return result;
    } catch (error) {
      resumeRecoveryCheckpoint?.();
      globalThis.sessionStorage?.removeItem(PENDING_PERFORMANCE_KEY);
      throw error;
    }
  };

  let started = false;
  let ready = false;
  let settlementReady = false;
  let startupModeSharePromise = null;
  let startPromise = null;
  let startupTail = Promise.resolve();
  let gameLoadObserved = false;
  let loadedSaveName = null;
  let requestedSessionReload = null;
  let sessionReloadPromise = null;
  const ownsCurrentCity = (cityCode = currentCityCode()) => registration.cities.includes(cityCode);
  const roadLabelSourceGuard = createNativeRoadLabelSourceGuard({
    isEnabled: () => isCurrent() && ownsCurrentCity(),
    onReport: report => { diagnostics.nativeRoadLabelSource = report; },
  });
  const ownsSession = owner => owner != null && session === owner && isCurrent();
  async function recalculateCrossModeShare(reason, day = null, force = false, owner = session) {
    if (!ready || !ownsSession(owner)) return null;
    const loadedCity = currentCityCode();
    if (!registration.cities.includes(loadedCity) || runtime.getActiveTileId() !== loadedCity) return null;
    const startedAt = performance.now();
    try {
      const result = await runtime.recalculateCrossTileModeShare({ reason, day, force,
        evaluateCrossModeShares: input => {
          if (!ownsSession(owner)) throw new Error('Open World session ended before demand evaluation');
          return owner.crossModeShares.evaluate(input);
        },
      });
      if (!ownsSession(owner)) return null;
      diagnostics.latestCrossModeShare = { reason, milliseconds: performance.now() - startedAt, ...result };
      console.info(`${logLabel} cross-mode-share performance`, diagnostics.latestCrossModeShare);
      return result;
    } catch (error) {
      if (!ownsSession(owner)) return null;
      console.warn(`${logLabel} cross-city mode-share recalculation failed (${reason})`, error);
      return null;
    }
  }

  function deferStartupModeShare(reason, day, owner = session) {
    let resolveScheduled;
    const scheduled = new Promise((resolve) => { resolveScheduled = resolve; });
    const run = () => {
      if (!ownsSession(owner)) { resolveScheduled(null); return; }
      void recalculateCrossModeShare(reason, day, false, owner).then((result) => {
        if (ownsSession(owner)) settlementReady = result != null;
        resolveScheduled(result);
      }).catch((error) => {
        console.warn(`${logLabel} deferred startup mode-share failed`, error);
        resolveScheduled(null);
      });
    };
    if (typeof globalThis.requestIdleCallback === 'function') {
      globalThis.requestIdleCallback(run, { timeout: 1_000 });
    } else {
      if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(run, 0);
      else run();
    }
    return scheduled;
  }

  async function settleCrossTileCommutes(reason = 'hourly') {
    // Background native finance is independent of cross-city mode share. A
    // failed demand refresh must never stop inactive-tile revenue while the
    // canonical native topology continues charging its expenses.
    const owner = session;
    if (!ready || !ownsSession(owner)) return null;
    const loadedCity = currentCityCode();
    if (!registration.cities.includes(loadedCity) || runtime.getActiveTileId() !== loadedCity) return null;
    try {
      const result = await runtime.settleCrossTileCommutes(reason);
      if (!ownsSession(owner)) return null;
      diagnostics.latestSettlement = { capturedAt: Date.now(), ...result };
      return result;
    } catch (error) {
      if (!ownsSession(owner)) return null;
      diagnostics.latestSettlement = { capturedAt: Date.now(), status: 'failed', reason, error: String(error?.message ?? error) };
      console.warn(`${logLabel} cross-city settlement failed (${reason})`, error);
      return null;
    }
  }

  const serviceChanged = (reason = 'route-service-change') => {
    if (!ready || !isCurrent() || !ownsCurrentCity()) return;
    runtime.markDerivedNetworkDirty(reason);
    revenueAccrual.invalidate();
    session?.modeShareInvalidation.markDirty(reason);
    cachedSimulation.invalidate();
  };
  const scheduleChanged = () => serviceChanged('schedule-change');
  const fareChanged = () => {
    if (!ready || !isCurrent() || !ownsCurrentCity()) return;
    revenueAccrual.invalidate();
    session?.modeShareInvalidation.markDirty('fare-change');
    cachedSimulation.invalidate();
  };
  const cachedSimulation = createCachedSimulation({
    game, api, getState: () => game.callbacks.getState(),
    workerSource: workerSources.nativeDemandEvaluator,
    postingWorkerSource: workerSources.hourlyFinance,
    isReady: () => ready && isCurrent() && ownsCurrentCity(),
    onHour: () => settleCrossTileCommutes('cached-simulation'),
    onDay: day => session?.modeShareInvalidation.flushAtMidnight(day),
  });
  diagnostics.cachedSimulation = cachedSimulation.snapshot;
  function ensureSession() {
    if (session) return session;
    const routePaths = createOpenWorldRoutePaths({
      tilePackages, tileCatalog,
      nativePopPrefixes: definition.demand.nativePopPrefixes,
      crossPopPrefixes: definition.demand.crossPopPrefixes,
      getNativeDemand: () => api.gameState.getDemandData?.()
        ?? globalThis.__subwayBuilder_storeCallbacks__?.getState?.()?.demandData ?? null,
      workerSource: workerSources.roadRoute ?? null,
      storedRouteLoader: artifacts.routeGeometry ? storedRouteLoader({
        baseUrl: globalThis[definition.runtime.tileBaseGlobal] ?? `http://127.0.0.1:${definition.runtime.tileServerPort}`,
        crossTileId: artifacts.routeGeometry.crossTileId,
        revision: artifacts.routeGeometry.revision,
      }) : null,
    });
    const uninstallRoutePathFetch = installDrivingRoutePathFetch(globalThis, {
      owns: routePaths.owns,
      resolve: async (city, popId) => (await routePaths.resolve(city, popId))?.coordinates ?? null,
    });
    const modeShareInvalidation = createDailyModeShareInvalidation({
      recalculate: (reason, day) => recalculateCrossModeShare(reason, day, false, owner),
    });
    const crossModeShares = createCrossModeShareEvaluator({ workerSource: workerSources.crossModeShare ?? null });
    diagnostics.crossModeShareWorker = crossModeShares.diagnostics;
    const disposeObserver = game.observeSharedTransitChanges(({ reason }) => {
      if (reason === 'route-service-change') serviceChanged(reason);
      else if (reason === 'fare-policy-change') fareChanged();
    });
    let disposed = false;
    const owner = {
      generation, routePaths, modeShareInvalidation, crossModeShares,
      dispose() {
        if (disposed) return;
        disposed = true;
        modeShareInvalidation.cancel();
        crossModeShares.dispose();
        disposeObserver();
        crossDemandController?.dispose?.();
        projectionOverlayController?.dispose?.();
        geographicContextController?.dispose?.();
        crossDemandController = projectionOverlayController = geographicContextController = null;
        routePaths.dispose();
        uninstallRoutePathFetch();
        if (session === owner) session = null;
        if (globalThis[routePathRuntimeKey] === owner) delete globalThis[routePathRuntimeKey];
      },
    };
    session = owner;
    globalThis[routePathRuntimeKey] = owner;
    globalThis[`__${globalStem}RoutePathDiagnostics__`] = routePaths.diagnostics;
    return owner;
  }

  async function persistPerformance(sample) {
    diagnostics.latest = sample;
    diagnostics.transitions.push(sample);
    if (diagnostics.transitions.length > 50) diagnostics.transitions.splice(0, diagnostics.transitions.length - 50);
    try { await storage?.set?.(DIAGNOSTICS_KEY, diagnostics.transitions); } catch (error) {
      console.warn(`${logLabel} could not persist transition diagnostics`, error);
    }
  }

  function ensurePanel() {
    if (!started || !isCurrent()) return;
    // Tile selection now happens directly on the world grid. Explicitly
    // remove the legacy top-bar panel so hot reloads do not retain it.
    api.ui?.unregisterComponent?.('top-bar', 'ny-state-seven-tile-switcher');
    if (!renderDistanceToolbarRegistered && geographicContextController) {
      renderDistanceToolbarRegistered = Boolean(registerRenderDistanceToolbar({
        api,
        controller: geographicContextController,
        simulation: cachedSimulation,
        panelId: `${namespace}-render-distance`,
      }));
    }
    crossDemandController?.ensurePanel?.();
  }

  function recordWorldIdentity(identity, { saveName = null, cityCode = null } = {}) {
    if (!identity?.worldId) return null;
    const observed = {
      worldId: identity.worldId,
      nativeSessionId: identity.nativeSessionId ?? api.gameState.getGameSessionId?.() ?? null,
      saveName,
      cityCode: cityCode ?? currentCityCode(),
    };
    diagnostics.currentWorld = observed;
    return observed;
  }

  function runtimeTileId() {
    try { return runtime.getActiveTileId(); } catch { return null; }
  }

  async function switchFromWorldGrid(tileId, owner) {
    const tile = tileById.get(tileId);
    if (!tile) throw new Error(`Unknown ${definition.identity.name} Tile View: ${tileId}`);
    // UI readiness precedes deferred startup demand. Do not enqueue a save
    // transition behind that work or allow a retained grid to navigate while
    // its session is loading, ending, or completing another tile transition.
    if (!isCurrent() || !ready || !ownsSession(owner) || !ownsCurrentCity()
      || startupModeSharePromise || sessionReloadPromise || navigation.pending()) {
      diagnostics.latestGridNavigation = { status: 'initializing', tileId, guard: 'startup-navigation-v1' };
      api.ui?.showNotification?.('Open World is still initializing. Please try again when loading finishes.', 'info', 'Open World');
      return diagnostics.latestGridNavigation;
    }
    if (runtimeTileId() === tileId) return { status: 'already-active', tileId };
    if (gridTileSwitchingId) return { status: 'already-switching', tileId: gridTileSwitchingId };
    gridTileSwitchingId = tileId;
    try {
      api.ui?.showNotification?.(`Switching to ${tile.name}…`, 'info', 'Open World');
      // The lean navigation snapshot copies live trains without generateSave's
      // cached-time rebase. Finish settlement/rebasing before capturing it;
      // onGameEnd runs after capture and cannot repair the retained handoff.
      await cachedSimulation.setEnabled(false);
      const transition = await runtime.stageNavigationTransition(tileId);
      const retirement = game.prepareTileRenderingRetirement(tileId, {
        onReport: report => { diagnostics.tileRenderingRetirement = report; },
      });
      try {
        await navigation.navigateTo(transition, { beforeNavigate: () => retirement.retireBeforeNavigation() });
      } catch (error) {
        retirement.cancel();
        throw error;
      }
      return transition;
    } catch (error) {
      api.ui?.showNotification?.(`Tile switch failed: ${error.message}`, 'error', 'Open World');
      throw error;
    } finally {
      gridTileSwitchingId = null;
    }
  }

  async function resolveWorldIdentity(nativeSessionId, pendingWorldId, loadTraceId) {
    const identityHints = game.readWorldIdentityHints();
    recordAuthoritativeLoad({
      phase: 'authoritative-load',
      loadTraceId,
      segment: 'identity-hints-read',
      requestedNativeSessionId: nativeSessionId,
      pendingWorldId: pendingWorldId ?? null,
      identityHints,
    });
    return identities.resolve(nativeSessionId, pendingWorldId, {
      ...identityHints,
      // The durable canonical world is a recovery target, never the default
      // for an ordinary new-game/session lookup.
      allowCanonicalFallback: false,
    });
  }

  async function stampWorldIdentity(worldId, loadTraceId) {
    const changed = await game.stampAuthoritativeWorldIdentity(worldId);
    recordAuthoritativeLoad({
      phase: 'authoritative-load',
      loadTraceId,
      segment: 'authoritative-identity-stamped',
      worldId,
      changed,
      identityHints: game.readWorldIdentityHints(),
    });
  }

  function reloadLoadedSession(tileId, reason, saveName = loadedSaveName, force = false) {
    const owner = session;
    if (!ownsSession(owner)) return Promise.resolve(null);
    loadTrace('reload.requested', {
      tileId,
      reason,
      saveName,
      force,
      started,
      ready,
      runtimeTileId: runtimeTileId(),
    });
    requestedSessionReload = { tileId, reason, saveName, force };
    if (sessionReloadPromise) return sessionReloadPromise;
    const pendingReload = (async () => {
      while (ownsSession(owner) && requestedSessionReload) {
        const request = requestedSessionReload;
        requestedSessionReload = null;
        // The lifecycle event/request is authoritative. The public city
        // accessor can still report the source tile during route navigation.
        const loadedTileId = request.tileId;
        const currentSaveName = api.gameState.getSaveName?.() ?? request.saveName ?? null;
        loadTrace('reload.executing', {
          request,
          loadedTileId,
          currentSaveName,
          started,
          ready,
        });
        if (!request.force && ready && runtimeTileId() === loadedTileId) {
          ensurePanel();
          continue;
        }
        ready = false;
        settlementReady = false;
        const nativeSessionId = api.gameState.getGameSessionId();
        const loadTraceId = createAuthoritativeLoadTraceId(
          request.reason ?? 'session-reload',
          loadedTileId,
          nativeSessionId,
        );
        recordAuthoritativeLoad({
          phase: 'authoritative-load',
          loadTraceId,
          segment: 'lifecycle-reload-start',
          loadedTileId,
          saveName: currentSaveName,
          nativeSessionId,
          request,
        });
        try {
          const identity = await resolveWorldIdentity(nativeSessionId, null, loadTraceId);
          if (!ownsSession(owner)) return;
          recordAuthoritativeLoad({
            phase: 'authoritative-load',
            loadTraceId,
            segment: 'identity-resolved',
            loadedTileId,
            saveName: currentSaveName,
            requestedNativeSessionId: nativeSessionId,
            identity,
          });
          await runtime.reloadFromSave(identity.worldId, loadedTileId, currentSaveName, {
            nativeSessionId: identity.nativeSessionId,
            nativeTileId: loadedTileId,
            nativeAuthoritativeLoad: true,
            loadTraceId,
          });
          if (!ownsSession(owner)) return;
          await stampWorldIdentity(identity.worldId, loadTraceId);
          if (!ownsSession(owner)) return;
          recordWorldIdentity(identity, { saveName: currentSaveName, cityCode: loadedTileId });
          if (!ownsSession(owner)) return;
          recordAuthoritativeLoad({
            phase: 'authoritative-load',
            loadTraceId,
            segment: 'lifecycle-reload-complete',
            identity,
            runtimeView: runtime.diagnosticView(),
          });
          loadedSaveName = currentSaveName;
          ready = true;
          const modeShare = await recalculateCrossModeShare(request.reason, api.gameState.getCurrentDay?.() ?? null, false, owner);
          if (!ownsSession(owner)) return;
          settlementReady = modeShare != null;
          ensurePanel();
        } catch (error) {
          if (!ownsSession(owner)) return;
          ready = false;
          settlementReady = false;
          recordAuthoritativeLoad({
            phase: 'authoritative-load',
            loadTraceId,
            segment: 'lifecycle-reload-failed',
            error: error?.stack ?? error?.message ?? String(error),
          });
          console.error(`${logLabel} save checkpoint load failed`, error);
          api.ui?.showNotification?.(`${definition.identity.name} save load failed: ${error.message}`, 'error');
        }
      }
    })().finally(() => { if (sessionReloadPromise === pendingReload) sessionReloadPromise = null; });
    sessionReloadPromise = pendingReload;
    return pendingReload;
  }

  async function start(
    loadedCityCode,
    saveName = loadedSaveName,
    { replaceWorld = false, hotReload = false } = {},
  ) {
    loadTrace('startup.requested', {
      loadedCityCode,
      saveName,
      current: isCurrent(),
      started,
      ready,
      hasStartPromise: Boolean(startPromise),
      pendingNavigation: navigation.pending() ?? null,
      replaceWorld,
      hotReload,
    });
    if (!isCurrent() || !registration.cities.includes(loadedCityCode)) return;
    if (startPromise) return startPromise;
    const startingSession = ensureSession();
    const previousStartup = startupTail;
    const startedAt = Date.now();
    let loadTraceId = null;
    let stageStartedAt = startedAt;
    const stages = {};
    const finishStage = (name) => {
      const finishedAt = Date.now();
      stages[name] = Math.max(0, finishedAt - stageStartedAt);
      stageStartedAt = finishedAt;
    };
    const pendingStart = (async () => {
      started = true;
      settlementReady = false;
      try {
        // A previous boot cannot be interrupted midway through native adoption.
        // Let it leave its await before a replacement startup touches this runtime.
        await previousStartup;
        if (!ownsSession(startingSession)) return;
        await runtime.serial;
        if (!ownsSession(startingSession)) return;
        const pending = navigation.pendingFor(loadedCityCode);
        rememberNavigationCamera(pending);
        const nativeSessionId = api.gameState.getGameSessionId();
        loadTraceId = createAuthoritativeLoadTraceId('startup', loadedCityCode, nativeSessionId);
        recordAuthoritativeLoad({
          phase: 'authoritative-load',
          loadTraceId,
          segment: 'lifecycle-start',
          loadedCityCode,
          saveName,
          nativeSessionId,
          pending: pending ?? null,
          hotReload,
        });
        let identity = await resolveWorldIdentity(nativeSessionId, pending?.worldId, loadTraceId);
        if (!ownsSession(startingSession)) return;
        recordAuthoritativeLoad({
          phase: 'authoritative-load',
          loadTraceId,
          segment: 'identity-resolved',
          requestedNativeSessionId: nativeSessionId,
          pendingWorldId: pending?.worldId ?? null,
          identity,
        });
        finishStage('identityResolution');
        const loadOptions = {
          loadTraceId,
          ...worldIdentityLoadOptions(identity, {
            pending: Boolean(pending),
            saveName,
            nativeTileId: loadedCityCode,
          }),
          nativeAuthoritativeLoad: !pending && typeof saveName === 'string' && Boolean(saveName),
        };
        if (replaceWorld) {
          await runtime.reloadFromSave(
            identity.worldId,
            loadedCityCode,
            saveName,
            loadOptions,
          );
        } else {
          await runtime.boot(identity.worldId, loadedCityCode, loadOptions);
        }
        if (!ownsSession(startingSession)) return;
        const confirmedIdentity = await resolveWorldIdentity(
          nativeSessionId,
          pending?.worldId,
          loadTraceId,
        );
        if (!ownsSession(startingSession)) return;
        recordAuthoritativeLoad({
          phase: 'authoritative-load',
          loadTraceId,
          segment: 'identity-confirmed-after-boot',
          initialIdentity: identity,
          confirmedIdentity,
        });
        if (confirmedIdentity.worldId !== identity.worldId) {
          identity = confirmedIdentity;
          recordAuthoritativeLoad({
            phase: 'authoritative-load',
            loadTraceId,
            segment: 'identity-race-reload-start',
            identity,
          });
          await runtime.reloadFromSave(identity.worldId, loadedCityCode, saveName, {
            nativeSessionId: identity.nativeSessionId,
            nativeTileId: loadedCityCode,
            nativeAuthoritativeLoad: !pending && typeof saveName === 'string' && Boolean(saveName),
            loadTraceId,
          });
          if (!ownsSession(startingSession)) return;
        }
        await stampWorldIdentity(identity.worldId, loadTraceId);
        if (!ownsSession(startingSession)) return;
        recordWorldIdentity(identity, { saveName, cityCode: loadedCityCode });
        recordAuthoritativeLoad({
          phase: 'authoritative-load',
          loadTraceId,
          segment: 'runtime-ready-for-ui',
          identity,
          runtimeView: runtime.diagnosticView(),
        });
        finishStage('runtimeBoot');
        if (!ownsSession(startingSession)) return;
        ready = true;
        settlementReady = false;
        const initialDemand = deferStartupModeShare('startup', api.gameState.getCurrentDay?.() ?? null, startingSession);
        startupModeSharePromise = initialDemand;
        void initialDemand.finally(() => {
          if (startupModeSharePromise === initialDemand) startupModeSharePromise = null;
        });
        finishStage('crossModeShare');
        if (!ownsSession(startingSession)) return;
        if (pending) navigation.complete(pending);
        geographicContextController = registerGeographicContextOverlay({
          runtime,
          tileCatalog,
          onTileSelect: tileId => switchFromWorldGrid(tileId, startingSession),
          nativeParkSourceLayer: definition.map.nativeParkSourceLayer,
          worldVegetationLoader,
          worldContextTilesUrl: definition.map.worldContextTileId
            ? tileUrl({ tileId: definition.map.worldContextTileId }, tileBase)
            : null,
        });
        crossDemandController = registerCrossDemandViewer({
          api,
          runtime,
          tilePackages,
          tileCatalog,
          routePaths: startingSession.routePaths,
          rendererVirtualization: geographicContextController,
        });
        projectionOverlayController = runtime.fullNativeNetworkEnabled
          ? null : registerNetworkProjectionOverlay({ api, runtime });
        await reconcileLiveMap('startup');
        if (!ownsSession(startingSession)) return;
        diagnostics.startupMapRefresh = refreshCityScopedMapArtifacts({
          map: latestMap,
          controller: geographicContextController,
        });
        ensurePanel();
        finishStage('uiSetup');
        diagnostics.startup = {
          tileId: loadedCityCode,
          milliseconds: Date.now() - startedAt,
          heapBytes: heapBytes(),
          stages,
          runtimeMilliseconds: diagnostics.startupRuntime?.milliseconds ?? stages.runtimeBoot,
          runtimeStages: diagnostics.startupRuntime?.stages ?? null,
        };
        console.info(`${logLabel} ready`, diagnostics.startup);
      } catch (error) {
        if (!ownsSession(startingSession)) return;
        started = false;
        ready = false;
        settlementReady = false;
        if (startPromise === pendingStart) startPromise = null;
        recordAuthoritativeLoad({
          phase: 'authoritative-load',
          loadTraceId,
          segment: 'lifecycle-start-failed',
          error: error?.stack ?? error?.message ?? String(error),
        });
        console.error(`${logLabel} startup failed`, error);
        api.ui?.showNotification?.(`${definition.identity.name} startup failed: ${error.message}`, 'error');
      }
    })();
    startPromise = pendingStart;
    startupTail = pendingStart;
    return pendingStart;
  }

  async function handleGameLoaded(saveName) {
    const bootstrapLoad = !ready;
    await cachedSimulation.setEnabled(false);
    if (!ownsCurrentCity()) return;
    loadTrace('hook.game-loaded', {
      saveName,
      current: isCurrent(),
      started,
      ready,
      cityCode: currentCityCode(),
      nativeSessionId: api.gameState.getGameSessionId?.() ?? null,
      pendingNavigation: navigation.pending() ?? null,
    });
    if (!isCurrent()) {
      loadTrace('hook.game-loaded.ignored', { reason: 'stale-generation', saveName });
      return;
    }
    const loadedCityCode = currentCityCode();
    const pending = navigation.pending();
    const nativeSessionId = api.gameState.getGameSessionId();
    const loadKind = nativeSaveLifecycle.classifyLoad(saveName, {
      nativeSessionId,
      pendingNavigation: Boolean(pending),
    });
    loadTrace('hook.game-loaded.classified', {
      saveName,
      loadKind,
      loadedCityCode,
      nativeSessionId,
      pendingNavigation: pending ?? null,
      started,
      ready,
    });
    if (loadKind === 'save-echo' || loadKind === 'internal-runtime') {
      // During an in-game mod reload this is often the only late-fired native
      // lifecycle callback received by the new generation. It must not reload
      // the native save, but it does prove that the current Zustand state is
      // fully loaded and is therefore safe to adopt. Without this cold-start
      // route, gameLoadObserved remains false, onMapReady waits forever, and
      // inactive-tile demand/revenue profiles are never rebuilt.
      if (!started && registration.cities.includes(loadedCityCode)) {
        gameLoadObserved = true;
        loadedSaveName = null;
        loadTrace('hook.game-loaded.route', {
          route: 'hot-reload-startup',
          loadKind,
          loadedCityCode,
          loadedSaveName,
        });
        return start(loadedCityCode, null, { hotReload: true });
      }
      loadTrace('hook.game-loaded.ignored', {
        reason: loadKind === 'internal-runtime'
          ? 'tracked-internal-native-operation'
          : 'correlated-save-echo',
        saveName,
      });
      return;
    }
    // Do not let onMapReady boot against the previous native Zustand state.
    nativeReloadRecovery.resetForLoad?.({ bootstrap: bootstrapLoad });
    // New-game creation resets gameSessionId during the native load; this hook
    // is the first lifecycle point at which that new identity is authoritative.
    gameLoadObserved = true;
    loadedSaveName = typeof saveName === 'string' && saveName ? saveName : null;
    if (!registration.cities.includes(loadedCityCode)) return;
    if (!started) {
      loadTrace('hook.game-loaded.route', { route: 'startup', loadKind, loadedCityCode, loadedSaveName });
      return start(loadedCityCode, loadedSaveName);
    }
    if (!ready || loadKind === 'tile-navigation') {
      loadTrace('hook.game-loaded.ignored', {
        reason: !ready ? 'runtime-not-ready' : 'tile-navigation-owned-by-city-load',
        loadKind,
      });
      return;
    }
    loadTrace('hook.game-loaded.route', { route: 'save-load-reload', loadedCityCode, loadedSaveName });
    return reloadLoadedSession(loadedCityCode, 'save-load', loadedSaveName, true);
  }

  async function handleGameInitialized() {
    if (!isCurrent() || !ownsCurrentCity()) return;
    // New games call loadInitialData(), which creates a new native
    // gameSessionId, then emit onGameInit rather than onGameLoaded.
    gameLoadObserved = true;
    loadedSaveName = null;
    const loadedCityCode = currentCityCode();
    if (!registration.cities.includes(loadedCityCode)) return;
    const pending = navigation.pendingFor(loadedCityCode);
    if (pending) {
      // Subway Builder emits onGameInit while its router initializes a new
      // native city store for a Tile View change. The navigation token is the
      // authoritative distinction from a genuinely new World: keep the live
      // runtime (and its transient native handoff) for onCityLoad to restore.
      loadTrace('hook.game-init.route', {
        route: 'tile-navigation',
        loadedCityCode,
        pendingNavigation: pending,
      });
      return;
    }
    const nativeSessionId = api.gameState.getGameSessionId?.() ?? null;
    if (!nativeSessionId) throw new Error('The new game did not provide a native session ID');
    const initializingSession = ensureSession();
    // onGameInit is the one authoritative new-world signal. Claim the new
    // native UUID explicitly so a stale marker left in renderer memory can
    // never attach this game to the previous world.
    await identities.bind(nativeSessionId, nativeSessionId, { force: true });
    if (!ownsSession(initializingSession)) return;
    const identity = {
      nativeSessionId,
      worldId: nativeSessionId,
      aliased: false,
      source: 'new-game',
    };
    await stampWorldIdentity(
      identity.worldId,
      createAuthoritativeLoadTraceId('new-game', loadedCityCode, nativeSessionId),
    );
    if (!ownsSession(initializingSession)) return;
    recordWorldIdentity(identity, { cityCode: loadedCityCode });
    if (!started) return start(loadedCityCode, null, { replaceWorld: true });
    if (!ready) return;
    ensurePanel();
  }

  async function handleGameSaved(saveName) {
    if (!ownsCurrentCity()) return;
    loadTrace('hook.game-saved', {
      saveName,
      current: isCurrent(),
      started,
      ready,
      settlementReady,
      cityCode: currentCityCode(),
      nativeSessionId: api.gameState.getGameSessionId?.() ?? null,
    });
    if (!isCurrent() || typeof saveName !== 'string' || !saveName) {
      loadTrace('hook.game-saved.ignored', {
        saveName,
        reason: !isCurrent() ? 'stale-generation' : 'invalid-save-name',
      });
      return;
    }
    const nativeSessionId = api.gameState.getGameSessionId?.() ?? null;
    const saveKind = nativeSaveLifecycle.classifySave(saveName, { nativeSessionId });
    if (saveKind === 'internal-runtime') {
      loadTrace('hook.game-saved.ignored', {
        reason: saveKind,
        saveName,
        nativeSessionId,
      });
      return;
    }
    // Native saves own their complete topology and financial history. This
    // hook is diagnostic only; it performs no mod persistence or native load.
    const sample = {
      capturedAt: Date.now(),
      saveName,
      status: 'observed',
      tileId: currentCityCode(),
      nativeSessionId,
      ready,
    };
    diagnostics.latestAutosave = sample;
    diagnostics.autosaves.push(sample);
    if (diagnostics.autosaves.length > 50) diagnostics.autosaves.splice(0, diagnostics.autosaves.length - 50);
    loadTrace('hook.game-saved.observed', sample);
    let worldId = null;
    try { worldId = runtime.getWorldId(); } catch {}
    recordWorldIdentity({ nativeSessionId: sample.nativeSessionId, worldId }, {
      saveName,
      cityCode: sample.tileId,
    });
    loadTrace('hook.game-saved.native-authority-observed', {
      saveName,
      nativeSessionId: sample.nativeSessionId,
      worldId,
    });
  }

  async function handleCityLoad(loadedCityCode, { authoritative = false } = {}) {
    if (!isCurrent()) return;
    const liveCityCode = readLiveSubwayBuilderCityCode({ api });
    const currentRuntimeTileId = runtimeTileId();
    const pendingForLoadedCity = navigation.pendingFor(loadedCityCode);
    rememberNavigationCamera(pendingForLoadedCity);
    if (
      started && ready && !pendingForLoadedCity
      && liveCityCode && currentRuntimeTileId
      && liveCityCode === currentRuntimeTileId
      && loadedCityCode !== currentRuntimeTileId
    ) {
      const nativeSessionId = api.gameState.getGameSessionId?.() ?? null;
      const loadTraceId = createAuthoritativeLoadTraceId(
        'city-load-ignored',
        loadedCityCode,
        nativeSessionId,
      );
      const ignored = {
        phase: 'authoritative-load',
        loadTraceId,
        segment: 'lifecycle-city-load-ignored',
        reason: 'event-disagrees-with-live-store-and-runtime',
        loadedCityCode,
        liveCityCode,
        runtimeTileId: currentRuntimeTileId,
        nativeSessionId,
      };
      rejectUnsignaledStoreCityChanges = true;
      storeConfirmedAuthoritativeCity = false;
      diagnostics.cityStoreRepair = game.reassertLoadedCityCode(currentRuntimeTileId);
      recordAuthoritativeLoad(ignored);
      loadTrace('hook.city-load.ignored', ignored);
      ensurePanel();
      return;
    }
    currentCityCode(loadedCityCode);
    if (registration.cities.includes(loadedCityCode)) {
      // The native API can swallow an individual override registration error.
      // Rebind synchronously before React recomputes the city map style.
      refreshPilotCityBindings(api, { tileBase, cityCodes: [loadedCityCode] });
    }
    if (!registration.cities.includes(loadedCityCode)) {
      game.restoreNativeCommuteRules();
      return;
    }
    if (authoritative) gameLoadObserved = true;
    if (!gameLoadObserved) return;
    if (!started) return start(loadedCityCode, api.gameState.getSaveName?.() ?? loadedSaveName);
    const cityLoadSession = session;
    // onMapReady/onGameLoaded can start boot before onCityLoad arrives. Do not
    // race a second transition completion against that same boot: boot owns the
    // persisted handoff and clears the navigation token when it succeeds.
    if (!ready && startPromise) await startPromise;
    if (!ownsSession(cityLoadSession)) return;
    const pending = pendingForLoadedCity;
    if (!ready && !pending) return;
    if (!pending) {
      const needsReload = !ready || runtimeTileId() !== loadedCityCode;
      if (needsReload) {
        return reloadLoadedSession(
          loadedCityCode,
          'city-load',
          api.gameState.getSaveName?.() ?? loadedSaveName,
          true,
        );
      }
      ensurePanel();
      return;
    }
    const cityLoadStartedAt = Date.now();
    const nativeSessionId = api.gameState.getGameSessionId();
    const loadTraceId = createAuthoritativeLoadTraceId(
      'tile-transition',
      loadedCityCode,
      nativeSessionId,
    );
    recordAuthoritativeLoad({
      phase: 'authoritative-load',
      loadTraceId,
      segment: 'lifecycle-transition-start',
      loadedCityCode,
      nativeSessionId,
      pending,
    });
    try {
      // Restoring the canonical network emits native route/schedule hooks. It
      // is a view change, not a player service edit, so keep those hooks from
      // scheduling a spurious midnight mode-share rebuild.
      ready = false;
      settlementReady = false;
      const identityBound = await identities.bind(nativeSessionId, pending.worldId, { force: true });
      if (!ownsSession(cityLoadSession)) return;
      recordAuthoritativeLoad({
        phase: 'authoritative-load',
        loadTraceId,
        segment: 'transition-identity-bound',
        nativeSessionId,
        pendingWorldId: pending.worldId,
        identityBound,
      });
      await runtime.completeStagedTransition(loadedCityCode, {
        loadTraceId,
        navigationTransition: pending,
      });
      if (!ownsSession(cityLoadSession)) return;
      await stampWorldIdentity(pending.worldId, loadTraceId);
      if (!ownsSession(cityLoadSession)) return;
      recordWorldIdentity({ nativeSessionId, worldId: pending.worldId }, {
        saveName: api.gameState.getSaveName?.() ?? loadedSaveName,
        cityCode: loadedCityCode,
      });
      recordAuthoritativeLoad({
        phase: 'authoritative-load',
        loadTraceId,
        segment: 'lifecycle-transition-restored',
        runtimeView: runtime.diagnosticView(),
      });
      ready = true;
      const modeShare = await recalculateCrossModeShare('tile-transition', api.gameState.getCurrentDay?.() ?? null, false, cityLoadSession);
      if (!ownsSession(cityLoadSession)) return;
      settlementReady = modeShare != null;
      // A replacement native map can become available without another
      // onMapReady notification. Reacquire and attach before refreshing it.
      await reconcileLiveMap('tile-navigation-complete');
      if (!ownsSession(cityLoadSession)) return;
      navigation.complete(pending);
      diagnostics.transitionMapRefresh = refreshCityScopedMapArtifacts({
        map: latestMap,
        controller: geographicContextController,
      });
      diagnostics.latestGridNavigation = { status: 'completed', tileId: loadedCityCode };
      ensurePanel();
      const finishedAt = Date.now();
      const measured = readPendingPerformance();
      globalThis.sessionStorage?.removeItem(PENDING_PERFORMANCE_KEY);
      const sample = {
        transitionId: pending.transitionId ?? measured?.transitionId ?? null,
        fromTileId: measured?.fromTileId ?? null,
        toTileId: loadedCityCode,
        totalMilliseconds: measured?.startedAt ? finishedAt - measured.startedAt : null,
        stageMilliseconds: measured?.startedAt && measured?.stagedAt ? measured.stagedAt - measured.startedAt : null,
        completionMilliseconds: finishedAt - cityLoadStartedAt,
        navigationMilliseconds: measured?.stagedAt ? cityLoadStartedAt - measured.stagedAt : null,
        startHeapBytes: measured?.startHeapBytes ?? null,
        endHeapBytes: heapBytes(),
        completedAt: finishedAt,
      };
      if (sample.startHeapBytes && sample.endHeapBytes) sample.heapDeltaBytes = sample.endHeapBytes - sample.startHeapBytes;
      await persistPerformance(sample);
      if (!ownsSession(cityLoadSession)) return;
      console.info(`${logLabel} tile transition performance`, sample);
      const tileName = tileById.get(loadedCityCode)?.name ?? loadedCityCode;
      const seconds = sample.totalMilliseconds == null ? null : (sample.totalMilliseconds / 1000).toFixed(2);
      api.ui?.showNotification?.(
        seconds ? `${tileName} loaded in ${seconds} s` : `Now viewing ${tileName}`,
        'success',
        definition.identity.name,
      );
    } catch (error) {
      if (!ownsSession(cityLoadSession)) return;
      recordAuthoritativeLoad({
        phase: 'authoritative-load',
        loadTraceId,
        segment: 'lifecycle-transition-failed',
        error: error?.stack ?? error?.message ?? String(error),
      });
      console.error(`${logLabel} transition completion failed`, error);
      api.ui?.showNotification?.(`Tile switch failed: ${error.message}`, 'error', definition.identity.name);
    }
  }

  async function ensureLifecyclePanel() {
    if (!isCurrent()) return;
    attachAutosaveIdleGuard();
    const loadedCityCode = currentCityCode();
    if (!registration.cities.includes(loadedCityCode)) return;
    if (!gameLoadObserved) {
      diagnostics.lifecycle = {
        status: 'waiting-for-native-game-load',
        cityId: loadedCityCode,
        capturedAt: Date.now(),
      };
      return;
    }
    if (started && !ready) return;
    await start(loadedCityCode);
    ensurePanel();
  }

  function repairLoadedMap(map, reason) {
    if (!isCurrent() || latestMap !== map || map?._removed) return;
    const loadedCityCode = currentCityCode();
    if (!registration.cities.includes(loadedCityCode)) return;
    if (rejectUnsignaledStoreCityChanges && runtimeTileId() === loadedCityCode) {
      diagnostics.cityStoreRepair = {
        reason,
        ...game.reassertLoadedCityCode(loadedCityCode),
      };
    }
    refreshPilotCityBindings(api, { tileBase, cityCodes: [loadedCityCode] });
    diagnostics.tileSource = {
      reason,
      ...repairPilotMapTileSource(map, loadedCityCode, { tileBase }),
    };
    diagnostics.mapCameraRepair = {
      reason,
      ...repairPilotMapCamera(map, loadedCityCode, {
        force: navigationCamera?.tileId === loadedCityCode && !navigationCamera.maps.has(map),
      }),
    };
    if (navigationCamera?.tileId === loadedCityCode && diagnostics.mapCameraRepair.status === 'recentered') navigationCamera.maps.add(map);
    if (diagnostics.tileSource.status === 'repaired') {
      console.warn(`${logLabel} repaired stale native tile source`, diagnostics.tileSource);
    }
    if (diagnostics.mapCameraRepair.status === 'recentered') {
      console.warn(`${logLabel} recentered stale native tile camera`, diagnostics.mapCameraRepair);
    }
  }

  async function reconcileLiveMap(reason) {
    const owner = session;
    const cityCode = currentCityCode();
    // Native city loading can finish before React publishes its new map.
    // Keep the navigation pending until that map exists, without attaching an
    // ended session's controllers if another lifecycle takes over meanwhile.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!ownsSession(owner) || currentCityCode() !== cityCode) return;
      const liveMap = api.utils?.getMap?.();
      const map = liveMap ?? latestMap;
      if (map && !map._removed) {
        attachRuntimeMap(map, reason);
        return;
      }
      if (!map && reason === 'startup') return;
      diagnostics.mapAttachment = {
        version: 'live-map-reattachment-v2', reason, cityCode, status: 'waiting-for-live-map',
      };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The native map was not available after the tile loaded');
  }

  function attachRuntimeMap(map, reason) {
    if (!isCurrent() || !map || map._removed) return;
    rememberNavigationCamera(navigation.pending());
    if (latestMap && tileSourceStyleHandler) {
      try { latestMap.off?.('style.load', tileSourceStyleHandler); } catch {}
    }
    const loadedCityCode = currentCityCode();
    const ownsLoadedCity = syncCityScopedMapControllers({
      map,
      cityCode: loadedCityCode,
      cityCodes: registration.cities,
      controllers: [crossDemandController, projectionOverlayController, geographicContextController],
    });
    latestMap = map;
    diagnostics.mapAttachment = {
      version: 'live-map-reattachment-v2',
      reason,
      cityCode: loadedCityCode,
      status: ownsLoadedCity ? 'attached' : 'foreign-city',
      liveMapMatches: api.utils?.getMap?.() === map,
    };
    roadLabelSourceGuard.attach(map);
    if (!ownsLoadedCity) {
      detachAutosaveIdleGuard();
      tileSourceStyleHandler = null;
      return;
    }
    stabilizeMapLayerMoves(map);
    diagnostics.mapZoom = relaxMapZoomLimits(map, { sourceMinZoom: tileCatalog.basemapMinZoom });
    tileSourceStyleHandler = () => {
      const refresh = () => repairLoadedMap(map, 'style-load');
      globalThis.requestAnimationFrame?.(refresh) ?? refresh();
    };
    map.on?.('style.load', tileSourceStyleHandler);
    repairLoadedMap(map, reason);
    void ensureLifecyclePanel();
  }

  ownedHooks.onGameInit(() => { void handleGameInitialized(); });
  ownedHooks.onGameLoaded((saveName) => { void handleGameLoaded(saveName); });
  ownedHooks.onGameSaved((saveName) => { void handleGameSaved(saveName); });
  ownedHooks.onMapReady(map => attachRuntimeMap(map, 'map-ready'));
  ownedHooks.onCityLoad(handleCityLoad);
  registerCrossTileClockHooks(ownedHooks, {
    hourChanged: () => { if (isCurrent() && ownsCurrentCity()) void settleCrossTileCommutes('hourly'); },
    dayChanged: (day) => { if (isCurrent() && ownsCurrentCity()) void session?.modeShareInvalidation.flushAtMidnight(day); },
  });
  registerModeShareInvalidationHooks(ownedHooks, { scheduleChanged, fareChanged });
  ownedHooks.onGameEnd(() => {
    if (!isCurrent()) return;
    detachAutosaveIdleGuard();
    void cachedSimulation.setEnabled(false);
    const pending = navigation.pending();
    if (pending) {
      // Route navigation briefly presents as a native game end/init pair.
      // Tearing down `started` here makes onGameInit replace the World and
      // discards the in-memory rail/ledger handoff before onCityLoad can use it.
      ready = false;
      settlementReady = false;
      loadedSaveName = null;
      loadTrace('hook.game-end.ignored', {
        reason: 'tile-navigation',
        pendingNavigation: pending,
      });
      return;
    }
    session?.dispose();
    navigationCamera = null;
    renderDistanceToolbarRegistered = false;
    started = false;
    startPromise = null;
    requestedSessionReload = null;
    sessionReloadPromise = null;
    ready = false;
    settlementReady = false;
    loadedSaveName = null;
    authoritativeCityCode = null;
    storeConfirmedAuthoritativeCity = false;
    rejectUnsignaledStoreCityChanges = false;
    if (latestMap && tileSourceStyleHandler) {
      try { latestMap.off?.('style.load', tileSourceStyleHandler); } catch {}
    }
    tileSourceStyleHandler = null;
    latestMap = null;
    game.restoreNativeCommuteRules();
  });
  diagnostics.nativeReloadRecovery = {
    installed: nativeReloadRecovery.installed,
    version: nativeReloadRecovery.version ?? null,
    mode: nativeReloadRecovery.mode ?? null,
    snapshot: () => nativeReloadRecovery.snapshot?.() ?? null,
  };
  diagnostics.nativeAutosaveIdle = { snapshot: () => autosaveIdleGuard?.snapshot?.() ?? { installed: false } };
  console.info(`${logLabel} registered`, registration);
  const controller = Object.freeze({
    cachedSimulation,
    platformRelease: OPEN_WORLD_PLATFORM_RELEASE,
    definition,
    diagnostics,
    registration,
    status: 'active',
    lifecycle: Object.freeze({
      gameInit: handleGameInitialized,
      gameLoaded: handleGameLoaded,
      cityLoad: handleCityLoad,
    }),
    dispose() {
      if (moduleDisposed) return;
      moduleDisposed = true;
      void cachedSimulation.dispose();
      for (const unsubscribe of hookDisposers.splice(0)) {
        try { unsubscribe(); } catch {}
      }
      session?.dispose();
      nativeReloadRecovery.dispose();
      roadLabelSourceGuard.dispose();
      detachAutosaveIdleGuard();
      if (latestMap && tileSourceStyleHandler) {
        try { latestMap.off?.('style.load', tileSourceStyleHandler); } catch {}
      }
      tileSourceStyleHandler = null;
      latestMap = null;
      game.restoreNativeCommuteRules();
      if (globalThis[activeRuntimeKey] === controller) delete globalThis[activeRuntimeKey];
    },
  });
  globalThis[activeRuntimeKey] = controller;
  roadLabelSourceGuard.attach(latestMap);
  attachAutosaveIdleGuard();
  return controller;
}
