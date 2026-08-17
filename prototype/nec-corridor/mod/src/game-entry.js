import { WorldTileRuntime } from '../../../kc-two-tile/mod/src/world-tile-runtime.js';
import { SubwayBuilderGameAdapter } from '../../../kc-two-tile/mod/src/adapters/subway-builder-game-adapter.js';
import { ModStorageWorldStateAdapter } from '../../../kc-two-tile/mod/src/adapters/mod-storage-world-state-adapter.js';
import { SerializedStorageAdapter } from '../../../kc-two-tile/mod/src/adapters/serialized-storage-adapter.js';
import { HashCityNavigationAdapter } from '../../../kc-two-tile/mod/src/adapters/hash-city-navigation-adapter.js';
import { registerPrototypePanel } from '../../../kc-two-tile/mod/src/ui/prototype-panel.js';
import { registerCrossDemandViewer } from '../../../kc-two-tile/mod/src/ui/cross-demand-viewer.js';
import { registerNetworkProjectionOverlay } from '../../../kc-two-tile/mod/src/ui/network-projection-overlay.js';
import { registerNetworkProjectionHooks } from '../../../kc-two-tile/mod/src/network-projection-hooks.js';
import {
  refreshPilotCityBindings,
  registerPilotCities,
  repairPilotMapCamera,
  repairPilotMapTileSource,
} from './city-registration.js';
import { embeddedCrossData } from './embedded-cross-data.js';
import { EmbeddedTilePackageAdapter, resolveRendererDataUrl } from './embedded-tile-package-adapter.js';
import { tileById, tileCatalog } from './tile-catalog.js';
import { createDailyModeShareInvalidation, registerCrossTileClockHooks, registerModeShareInvalidationHooks } from './mode-share-hook-policy.js';
import { stabilizeMapLayerMoves } from '../../../kc-two-tile/mod/src/map-layer-stability.js';
import { relaxMapZoomLimits } from '../../../kc-two-tile/mod/src/map-zoom-limits.js';
import { registerGeographicContextOverlay } from '../../../kc-two-tile/mod/src/ui/geographic-context-overlay.js';
import {
  WorldIdentityResolver,
  worldIdentityLoadOptions,
} from '../../../kc-two-tile/mod/src/world-identity.js';
import { applyNetworkRecovery, decodeGzipBase64Json } from '../../../kc-two-tile/mod/src/network-recovery.js';
import { createAutosaveHookGuard } from '../../../kc-two-tile/mod/src/autosave-hook-guard.js';
import { embeddedNetworkRecoveryGzipBase64 } from './embedded-network-recovery.js';
import {
  NETWORK_RECOVERY_ID,
  NETWORK_RECOVERY_REPLACE_ROUTE_IDS,
  NETWORK_RECOVERY_WORLD_IDS,
} from './network-recovery-config.js';

const PENDING_NAVIGATION_KEY = 'nec-corridor:pending-navigation';
const PENDING_PERFORMANCE_KEY = 'nec-corridor:pending-performance';
const DIAGNOSTICS_KEY = 'diagnostics:tile-transitions';
const CURRENT_CANONICAL_WORLD_ID = 'nec-corridor-world';
const RECOVERY_SESSION_ALIASES = Object.freeze({});
const recoveryNetworkPromise = decodeGzipBase64Json(embeddedNetworkRecoveryGzipBase64);

function heapBytes() {
  return Number(globalThis.performance?.memory?.usedJSHeapSize) || null;
}

function readPendingPerformance() {
  try { return JSON.parse(globalThis.sessionStorage?.getItem(PENDING_PERFORMANCE_KEY) ?? 'null'); } catch { return null; }
}

function writePendingPerformance(value) {
  globalThis.sessionStorage?.setItem(PENDING_PERFORMANCE_KEY, JSON.stringify(value));
}

(function installNyStatePilot() {
  const api = globalThis.SubwayBuilderAPI;
  if (!api) throw new Error('[NEC] SubwayBuilderAPI is unavailable');
  stabilizeMapLayerMoves(api.utils?.getMap?.());
  relaxMapZoomLimits(api.utils?.getMap?.(), { sourceMinZoom: tileCatalog.basemapMinZoom });
  const generationKey = '__necCorridorGeneration__';
  const generation = (Number(globalThis[generationKey]) || 0) + 1;
  globalThis[generationKey] = generation;
  const isCurrent = () => globalThis[generationKey] === generation;
  const rawStorage = api.storage?.scoped?.();
  const storageCoordinatorKey = '__nyStateScopedStorageCoordinator__';
  const storageCoordinator = globalThis[storageCoordinatorKey] ??= { tail: Promise.resolve() };
  const storage = rawStorage
    ? new SerializedStorageAdapter({ storage: rawStorage, coordinator: storageCoordinator })
    : rawStorage;
  const identities = new WorldIdentityResolver({
    storage,
    fallbackWorldId: 'nec-corridor',
    recoveryAliases: RECOVERY_SESSION_ALIASES,
    canonicalWorldId: CURRENT_CANONICAL_WORLD_ID,
  });
  const tileBase = globalThis.NEC_CORRIDOR_TILE_BASE ?? 'http://127.0.0.1:8799';
  const registration = registerPilotCities(api, { tileBase });
  const game = new SubwayBuilderGameAdapter({ api });
  const navigation = new HashCityNavigationAdapter({
    tileIds: registration.tileIds,
    pendingKey: PENDING_NAVIGATION_KEY,
  });
  const tilePackages = new EmbeddedTilePackageAdapter(registration.tileIds, embeddedCrossData, {
    loadCityData: api.utils?.loadCityData?.bind(api.utils),
    fetchData: globalThis.fetch?.bind(globalThis),
    resolveDataUrl: (path) => resolveRendererDataUrl(path),
  });
  let latestMap = null;
  let crossDemandController = null;
  let projectionOverlayController = null;
  let geographicContextController = null;
  let tileSourceStyleHandler = null;
  const diagnostics = globalThis.__necCorridorDiagnostics__ = {
    generation,
    registeredAt: Date.now(),
    transitions: [],
    autosaves: [],
    latestAutosave: null,
    latestAutosaveRuntime: null,
    authoritativeLoads: [],
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
  if (!capability.supported) {
    console.error('[NEC] Unsupported game/API seam; no mutations performed', capability);
    api.ui?.showNotification?.('NEC Corridor disabled: incompatible game seam', 'error');
    return;
  }
  diagnostics.nativeNetworkMode = game.activateCanonicalNativeNetworkMode();
  diagnostics.trackGroupLoadGuard = game.installTrackGroupLoadGuard();

  const worldState = new ModStorageWorldStateAdapter({
    storage,
    diagnostics: recordAuthoritativeLoad,
  });
  const runtime = new WorldTileRuntime({
    game,
    tilePackages,
    tileIds: registration.tileIds,
    tileCatalog,
    networkRecovery: async (world) => {
      if (!NETWORK_RECOVERY_WORLD_IDS.has(world.worldId)) return { changed: false, imported: {} };
      return applyNetworkRecovery(world, {
        recoveryId: NETWORK_RECOVERY_ID,
        nativeState: await recoveryNetworkPromise,
        replaceRouteIds: NETWORK_RECOVERY_REPLACE_ROUTE_IDS,
      });
    },
    worldState,
    initialWorld: { activeTileId: 'NEC_CP00_RP00', wallet: 1_000_000, cohorts: [] },
    telemetry: (event) => {
      if (event?.phase === 'authoritative-load') {
        recordAuthoritativeLoad(event);
        return;
      }
      if (event?.phase === 'native-finance-projection-audit') {
        diagnostics.nativeFinance = {
          ...event,
          configuration: game.nativeFinanceAuditStatus?.() ?? null,
        };
      }
      if (event?.phase === 'native-finance-profile-recovery') {
        diagnostics.nativeFinanceProfileRecovery = event;
      }
      if (event?.phase === 'native-finance-handoff'
        || event?.phase === 'native-finance-handoff-pending') {
        diagnostics.nativeFinanceHandoff = event;
      }
      if (event?.phase === 'startup-performance') diagnostics.startupRuntime = event;
      if (event?.phase === 'autosave-performance') {
        diagnostics.latestAutosaveRuntime = event;
        return;
      }
      console.debug('[NEC]', event);
    },
  });

  function hydratePersistedDiagnostics() {
    let view;
    try { view = runtime.view(); } catch { return; }
    const audit = view.backgroundNativeFinance?.audit;
    if (audit) {
      diagnostics.nativeFinance = {
        phase: 'native-finance-projection-audit',
        latest: audit.latest ?? null,
        rolling24Hours: audit.rolling24Hours ?? null,
        updatedAtHour: audit.updatedAtHour ?? null,
        configuration: game.nativeFinanceAuditStatus?.() ?? null,
      };
    }
  }

  const stageTransition = runtime.stageNavigationTransition.bind(runtime);
  runtime.stageNavigationTransition = async (tileId) => {
    const sample = {
      fromTileId: runtime.view().activeTileId,
      toTileId: tileId,
      startedAt: Date.now(),
      startHeapBytes: heapBytes(),
    };
    writePendingPerformance(sample);
    try {
      const result = await stageTransition(tileId);
      writePendingPerformance({ ...sample, stagedAt: Date.now(), transitionId: result.transitionId });
      return result;
    } catch (error) {
      globalThis.sessionStorage?.removeItem(PENDING_PERFORMANCE_KEY);
      throw error;
    }
  };

  let started = false;
  let ready = false;
  let settlementReady = false;
  let startupModeSharePromise = null;
  let startPromise = null;
  let gameLoadObserved = false;
  let loadedSaveName = null;
  let requestedSessionReload = null;
  let sessionReloadPromise = null;
  const autosaveHookGuard = createAutosaveHookGuard();

  async function recalculateCrossModeShare(reason, day = null, force = false) {
    if (!ready || !isCurrent()) return null;
    const loadedCity = api.utils.getCityCode?.();
    if (!registration.cities.includes(loadedCity) || runtime.view().activeTileId !== loadedCity) return null;
    const startedAt = performance.now();
    try {
      const result = await runtime.recalculateCrossTileModeShare({ reason, day, force });
      diagnostics.latestCrossModeShare = { reason, milliseconds: performance.now() - startedAt, ...result };
      console.info('[NEC] cross-mode-share performance', diagnostics.latestCrossModeShare);
      return result;
    } catch (error) {
      console.warn(`[NEC] cross-city mode-share recalculation failed (${reason})`, error);
      return null;
    }
  }

  function deferStartupModeShare(reason, day) {
    let resolveScheduled;
    const scheduled = new Promise((resolve) => { resolveScheduled = resolve; });
    const run = () => {
      void recalculateCrossModeShare(reason, day).then((result) => {
        if (isCurrent()) settlementReady = result != null;
        resolveScheduled(result);
      }).catch((error) => {
        console.warn('[NEC] deferred startup mode-share failed', error);
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
    if (!ready || !settlementReady || !isCurrent()) return null;
    const loadedCity = api.utils.getCityCode?.();
    if (!registration.cities.includes(loadedCity) || runtime.view().activeTileId !== loadedCity) return null;
    try { return await runtime.settleCrossTileCommutes(reason); }
    catch (error) { console.warn(`[NEC] cross-city settlement failed (${reason})`, error); return null; }
  }

  const modeShareInvalidation = createDailyModeShareInvalidation({
    recalculate: (reason, day) => recalculateCrossModeShare(reason, day),
  });
  const routeChanged = () => { if (ready && isCurrent()) modeShareInvalidation.markDirty('route-change'); };
  const scheduleChanged = () => { if (ready && isCurrent()) modeShareInvalidation.markDirty('schedule-change'); };
  const fareChanged = () => { if (ready && isCurrent()) modeShareInvalidation.markDirty('fare-change'); };
  // Native topology edits are authoritative in canonical-native mode. These
  // hooks only invalidate cross-tile mode share; they never roll a route back
  // to a geographic projection or rewrite native schedules.
  const projectionChanged = (reason) => routeChanged(reason);

  async function persistPerformance(sample) {
    diagnostics.latest = sample;
    diagnostics.transitions.push(sample);
    if (diagnostics.transitions.length > 50) diagnostics.transitions.splice(0, diagnostics.transitions.length - 50);
    try { await storage?.set?.(DIAGNOSTICS_KEY, diagnostics.transitions); } catch (error) {
      console.warn('[NEC] could not persist transition diagnostics', error);
    }
  }

  function ensurePanel() {
    if (!started || !isCurrent()) return;
    registerPrototypePanel({
      api,
      runtime,
      navigation,
      catalog: tileCatalog,
      panelId: 'ny-state-seven-tile-switcher',
    });
    crossDemandController?.ensurePanel?.();
  }

  function runtimeTileId() {
    try { return runtime.view().activeTileId; } catch { return null; }
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
    requestedSessionReload = { tileId, reason, saveName, force };
    if (sessionReloadPromise) return sessionReloadPromise;
    sessionReloadPromise = (async () => {
      while (requestedSessionReload) {
        const request = requestedSessionReload;
        requestedSessionReload = null;
        // The lifecycle event/request is authoritative. The public city
        // accessor can still report the source tile during route navigation.
        const loadedTileId = request.tileId;
        const currentSaveName = api.gameState.getSaveName?.() ?? request.saveName ?? null;
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
            allowLiveFallback: identity.aliased,
            nativeSessionId: identity.nativeSessionId,
            nativeTileId: loadedTileId,
            loadTraceId,
          });
          await stampWorldIdentity(identity.worldId, loadTraceId);
          if (!isCurrent()) return;
          recordAuthoritativeLoad({
            phase: 'authoritative-load',
            loadTraceId,
            segment: 'lifecycle-reload-complete',
            identity,
            runtimeView: runtime.view(),
          });
          loadedSaveName = currentSaveName;
          ready = true;
          settlementReady = (await recalculateCrossModeShare(request.reason, api.gameState.getCurrentDay?.() ?? null)) != null;
          ensurePanel();
        } catch (error) {
          ready = false;
          settlementReady = false;
          recordAuthoritativeLoad({
            phase: 'authoritative-load',
            loadTraceId,
            segment: 'lifecycle-reload-failed',
            error: error?.stack ?? error?.message ?? String(error),
          });
          console.error('[NEC] save checkpoint load failed', error);
          api.ui?.showNotification?.(`NEC Corridor save load failed: ${error.message}`, 'error');
        }
      }
    })().finally(() => { sessionReloadPromise = null; });
    return sessionReloadPromise;
  }

  async function start(loadedCityCode, saveName = loadedSaveName) {
    if (!isCurrent() || !registration.cities.includes(loadedCityCode)) return;
    if (startPromise) return startPromise;
    const startedAt = Date.now();
    let loadTraceId = null;
    let stageStartedAt = startedAt;
    const stages = {};
    const finishStage = (name) => {
      const finishedAt = Date.now();
      stages[name] = Math.max(0, finishedAt - stageStartedAt);
      stageStartedAt = finishedAt;
    };
    startPromise = (async () => {
      started = true;
      settlementReady = false;
      try {
        const pending = navigation.pendingFor(loadedCityCode);
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
        });
        let identity = await resolveWorldIdentity(nativeSessionId, pending?.worldId, loadTraceId);
        recordAuthoritativeLoad({
          phase: 'authoritative-load',
          loadTraceId,
          segment: 'identity-resolved',
          requestedNativeSessionId: nativeSessionId,
          pendingWorldId: pending?.worldId ?? null,
          identity,
        });
        finishStage('identityResolution');
        await runtime.boot(
          identity.worldId,
          loadedCityCode,
          {
            loadTraceId,
            ...worldIdentityLoadOptions(identity, {
              pending: Boolean(pending),
              saveName,
              nativeTileId: loadedCityCode,
            }),
          },
        );
        const confirmedIdentity = await resolveWorldIdentity(
          nativeSessionId,
          pending?.worldId,
          loadTraceId,
        );
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
            allowLiveFallback: identity.aliased,
            nativeSessionId: identity.nativeSessionId,
            nativeTileId: loadedCityCode,
            loadTraceId,
          });
        }
        await stampWorldIdentity(identity.worldId, loadTraceId);
        recordAuthoritativeLoad({
          phase: 'authoritative-load',
          loadTraceId,
          segment: 'runtime-ready-for-ui',
          identity,
          runtimeView: runtime.view(),
        });
        finishStage('runtimeBoot');
        hydratePersistedDiagnostics();
        if (!isCurrent()) return;
        ready = true;
        settlementReady = false;
        startupModeSharePromise = deferStartupModeShare('startup', api.gameState.getCurrentDay?.() ?? null);
        finishStage('crossModeShare');
        if (!isCurrent()) return;
        if (pending) navigation.complete(pending);
        crossDemandController = registerCrossDemandViewer({ api, runtime, tilePackages });
        projectionOverlayController = registerNetworkProjectionOverlay({ api, runtime });
        geographicContextController = registerGeographicContextOverlay({ runtime, tileCatalog });
        if (latestMap) crossDemandController.attachMap(latestMap);
        if (latestMap) projectionOverlayController.attachMap(latestMap);
        if (latestMap) geographicContextController.attachMap(latestMap);
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
        console.info('[NEC] ready', diagnostics.startup);
      } catch (error) {
        started = false;
        ready = false;
        settlementReady = false;
        startPromise = null;
        if (!isCurrent()) return;
        recordAuthoritativeLoad({
          phase: 'authoritative-load',
          loadTraceId,
          segment: 'lifecycle-start-failed',
          error: error?.stack ?? error?.message ?? String(error),
        });
        console.error('[NEC] startup failed', error);
        api.ui?.showNotification?.(`NEC Corridor startup failed: ${error.message}`, 'error');
      }
    })();
    return startPromise;
  }

  async function handleGameLoaded(saveName) {
    if (!isCurrent()) return;
    if (autosaveHookGuard.isNestedLoad(saveName)) return;
    // Do not let onMapReady boot against the previous native Zustand state.
    // New-game creation resets gameSessionId during the native load; this hook
    // is the first lifecycle point at which that new identity is authoritative.
    gameLoadObserved = true;
    loadedSaveName = typeof saveName === 'string' && saveName ? saveName : null;
    const loadedCityCode = api.utils.getCityCode?.();
    if (!registration.cities.includes(loadedCityCode)) return;
    const pending = navigation.pending();
    if (!started) return start(loadedCityCode, loadedSaveName);
    if (!ready || pending) return;
    return reloadLoadedSession(loadedCityCode, 'save-load', loadedSaveName, true);
  }

  async function handleGameInitialized() {
    if (!isCurrent()) return;
    // New games call loadInitialData(), which creates a new native
    // gameSessionId, then emit onGameInit rather than onGameLoaded.
    gameLoadObserved = true;
    loadedSaveName = null;
    const loadedCityCode = api.utils.getCityCode?.();
    if (!registration.cities.includes(loadedCityCode)) return;
    if (!started) return start(loadedCityCode, null);
    if (!ready) return;
    ensurePanel();
  }

  async function handleGameSaved(saveName) {
    if (!ready || !isCurrent() || typeof saveName !== 'string' || !saveName) return;
    if (startupModeSharePromise && !settlementReady) await startupModeSharePromise;
    if (!ready || !settlementReady || !isCurrent()) return;
    if (!autosaveHookGuard.begin(saveName)) return;
    const startedAt = performance.now();
    let identityMilliseconds = 0;
    let checkpointResult = null;
    let status = 'failed';
    let failure = null;
    try {
      const identityStartedAt = performance.now();
      const nativeSessionId = api.gameState.getGameSessionId();
      const nativeTileId = api.utils.getCityCode?.() ?? runtime.view().activeTileId;
      const identityBound = await identities.bind(nativeSessionId, runtime.view().worldId);
      identityMilliseconds = performance.now() - identityStartedAt;
      if (!identityBound) {
        throw new Error('Native save identity moved to another authoritative open-world lineage');
      }
      checkpointResult = await runtime.checkpoint('game-save', {
        saveName,
        nativeSessionId,
        nativeTileId,
        captureNativeSnapshot: false,
      });
      loadedSaveName = saveName;
      status = checkpointResult?.status === 'projection-quarantined' ? 'skipped' : 'saved';
    } catch (error) {
      failure = String(error?.message ?? error);
      console.warn(`[NEC] could not checkpoint native save ${saveName}`, error);
    } finally {
      autosaveHookGuard.end();
      const runtimePerformance = checkpointResult?.performance
        ?? (diagnostics.latestAutosaveRuntime?.saveName === saveName
          ? diagnostics.latestAutosaveRuntime
          : null);
      const elapsed = performance.now() - startedAt;
      const runtimeStages = runtimePerformance?.stages ?? {};
      const accounted = identityMilliseconds
        + Object.values(runtimeStages).reduce((sum, value) => sum + (Number(value) || 0), 0);
      const sample = {
        capturedAt: Date.now(),
        saveName,
        status,
        error: failure,
        tileId: runtime.view().activeTileId,
        revision: checkpointResult?.revision ?? runtime.view().revision,
        milliseconds: elapsed,
        stages: {
          identityBinding: identityMilliseconds,
          ...runtimeStages,
          unattributed: Math.max(0, elapsed - accounted),
        },
      };
      diagnostics.latestAutosave = sample;
      diagnostics.autosaves.push(sample);
      if (diagnostics.autosaves.length > 50) diagnostics.autosaves.splice(0, diagnostics.autosaves.length - 50);
      console.info('[NEC] autosave performance', sample);
    }
  }

  async function handleCityLoad(loadedCityCode) {
    if (!isCurrent()) return;
    if (registration.cities.includes(loadedCityCode)) {
      // The native API can swallow an individual override registration error.
      // Rebind synchronously before React recomputes the city map style.
      refreshPilotCityBindings(api, { tileBase, cityCodes: [loadedCityCode] });
    }
    if (!registration.cities.includes(loadedCityCode)) {
      game.restoreNativeCommuteRules();
      return;
    }
    if (!gameLoadObserved) return;
    if (!started) return start(loadedCityCode, api.gameState.getSaveName?.() ?? loadedSaveName);
    // onMapReady/onGameLoaded can start boot before onCityLoad arrives. Do not
    // race a second transition completion against that same boot: boot owns the
    // persisted handoff and clears the navigation token when it succeeds.
    if (!ready && startPromise) await startPromise;
    if (!isCurrent() || !ready) return;
    const pending = navigation.pendingFor(loadedCityCode);
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
      settlementReady = false;
      const identityBound = await identities.bind(nativeSessionId, pending.worldId, { force: true });
      recordAuthoritativeLoad({
        phase: 'authoritative-load',
        loadTraceId,
        segment: 'transition-identity-bound',
        nativeSessionId,
        pendingWorldId: pending.worldId,
        identityBound,
      });
      await runtime.completeStagedTransition(loadedCityCode, { loadTraceId });
      await stampWorldIdentity(pending.worldId, loadTraceId);
      recordAuthoritativeLoad({
        phase: 'authoritative-load',
        loadTraceId,
        segment: 'lifecycle-transition-restored',
        runtimeView: runtime.view(),
      });
      ready = true;
      settlementReady = (await recalculateCrossModeShare('tile-transition', api.gameState.getCurrentDay?.() ?? null)) != null;
      navigation.complete(pending);
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
      console.info('[NEC] tile transition performance', sample);
      const tileName = tileById.get(loadedCityCode)?.name ?? loadedCityCode;
      const seconds = sample.totalMilliseconds == null ? null : (sample.totalMilliseconds / 1000).toFixed(2);
      api.ui?.showNotification?.(
        seconds ? `${tileName} loaded in ${seconds} s` : `Now viewing ${tileName}`,
        'success',
        'NEC Corridor',
      );
    } catch (error) {
      recordAuthoritativeLoad({
        phase: 'authoritative-load',
        loadTraceId,
        segment: 'lifecycle-transition-failed',
        error: error?.stack ?? error?.message ?? String(error),
      });
      console.error('[NEC] transition completion failed', error);
      api.ui?.showNotification?.(`Tile switch failed: ${error.message}`, 'error', 'NEC Corridor');
    }
  }

  async function ensureLifecyclePanel() {
    if (!isCurrent()) return;
    const loadedCityCode = api.utils.getCityCode?.();
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
    if (!isCurrent() || latestMap !== map) return;
    const loadedCityCode = api.utils.getCityCode?.();
    if (!registration.cities.includes(loadedCityCode)) return;
    refreshPilotCityBindings(api, { tileBase, cityCodes: [loadedCityCode] });
    diagnostics.tileSource = {
      reason,
      ...repairPilotMapTileSource(map, loadedCityCode, { tileBase }),
    };
    diagnostics.mapCameraRepair = {
      reason,
      ...repairPilotMapCamera(map, loadedCityCode),
    };
    if (diagnostics.tileSource.status === 'repaired') {
      console.warn('[NEC] repaired stale native tile source', diagnostics.tileSource);
    }
    if (diagnostics.mapCameraRepair.status === 'recentered') {
      console.warn('[NEC] recentered stale native tile camera', diagnostics.mapCameraRepair);
    }
  }

  api.hooks.onGameInit?.(() => { void handleGameInitialized(); });
  api.hooks.onGameLoaded?.((saveName) => { void handleGameLoaded(saveName); });
  api.hooks.onGameSaved?.((saveName) => { void handleGameSaved(saveName); });
  api.hooks.onMapReady((map) => {
    if (!isCurrent()) return;
    if (latestMap && tileSourceStyleHandler) {
      try { latestMap.off?.('style.load', tileSourceStyleHandler); } catch {}
    }
    stabilizeMapLayerMoves(map);
    diagnostics.mapZoom = relaxMapZoomLimits(map, { sourceMinZoom: tileCatalog.basemapMinZoom });
    latestMap = map;
    tileSourceStyleHandler = () => {
      const refresh = () => repairLoadedMap(map, 'style-load');
      globalThis.requestAnimationFrame?.(refresh) ?? refresh();
    };
    map.on?.('style.load', tileSourceStyleHandler);
    repairLoadedMap(map, 'map-ready');
    crossDemandController?.attachMap(map);
    projectionOverlayController?.attachMap(map);
    geographicContextController?.attachMap(map);
    void ensureLifecyclePanel();
  });
  api.hooks.onCityLoad(handleCityLoad);
  registerCrossTileClockHooks(api.hooks, {
    hourChanged: () => { if (isCurrent()) void settleCrossTileCommutes('hourly'); },
    dayChanged: (day) => { if (isCurrent()) void modeShareInvalidation.flushAtMidnight(day); },
  });
  registerModeShareInvalidationHooks(api.hooks, { routeChanged, scheduleChanged, fareChanged });
  registerNetworkProjectionHooks(
    api.hooks,
    projectionChanged,
    scheduleChanged,
    { readTrackInventory: () => game.getTrackInventory() },
  );
  api.hooks.onGameEnd?.(() => {
    if (!isCurrent()) return;
    modeShareInvalidation.cancel();
    projectionOverlayController?.dispose?.();
    geographicContextController?.dispose?.();
    ready = false;
    settlementReady = false;
    loadedSaveName = null;
    if (latestMap && tileSourceStyleHandler) {
      try { latestMap.off?.('style.load', tileSourceStyleHandler); } catch {}
    }
    tileSourceStyleHandler = null;
    latestMap = null;
    game.restoreNativeCommuteRules();
  });
  console.info('[NEC] registered', registration);
})();
