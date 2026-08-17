import { WorldTileRuntime } from './world-tile-runtime.js';
import { SubwayBuilderGameAdapter } from './adapters/subway-builder-game-adapter.js';
import { HttpTilePackageAdapter } from './adapters/http-tile-package-adapter.js';
import { ModStorageWorldStateAdapter } from './adapters/mod-storage-world-state-adapter.js';
import { HashCityNavigationAdapter } from './adapters/hash-city-navigation-adapter.js';
import { registerPrototypePanel } from './ui/prototype-panel.js';
import { registerCrossDemandViewer } from './ui/cross-demand-viewer.js';
import { registerNetworkProjectionOverlay } from './ui/network-projection-overlay.js';
import { createDailyModeShareInvalidation, registerCrossTileClockHooks, registerModeShareInvalidationHooks } from './mode-share-hook-policy.js';
import { createNetworkProjectionReconciler, createRouteScheduleReconciler, registerNetworkProjectionHooks } from './network-projection-hooks.js';
import { registerPrototypeCities } from './city-registration.js';
import { tileCatalog } from './tile-catalog.js';
import { stabilizeMapLayerMoves } from './map-layer-stability.js';
import { relaxMapZoomLimits } from './map-zoom-limits.js';
import { registerGeographicContextOverlay } from './ui/geographic-context-overlay.js';
import { WorldIdentityResolver } from './world-identity.js';
import { createAutosaveHookGuard } from './autosave-hook-guard.js';

// This file is bundled to one import-free IIFE. It is intentionally a manual,
// fail-closed feasibility mod, not a production auto-streaming implementation.
(function installKcTwoTilePrototype() {
  const api = globalThis.SubwayBuilderAPI;
  if (!api) throw new Error('[KC two-tile] SubwayBuilderAPI is unavailable');
  stabilizeMapLayerMoves(api.utils?.getMap?.());
  relaxMapZoomLimits(api.utils?.getMap?.(), { sourceMinZoom: tileCatalog.basemapMinZoom });
  const generationKey = '__kcTwoTileOpenWorldGeneration__';
  const generation = (Number(globalThis[generationKey]) || 0) + 1;
  globalThis[generationKey] = generation;
  const isCurrent = () => globalThis[generationKey] === generation;

  // Capture mod identity synchronously; plain storage calls lose it after await.
  const storage = api.storage?.scoped?.();
  const identities = new WorldIdentityResolver({ storage });
  const artifactBase = globalThis.KC_TWO_TILE_ARTIFACT_BASE ?? 'http://127.0.0.1:8787';
  const tileBase = globalThis.KC_TWO_TILE_TILE_BASE ?? 'http://127.0.0.1:8788';
  const registration = registerPrototypeCities(api, { artifactBase, tileBase });

  const game = new SubwayBuilderGameAdapter({ api });
  const navigation = new HashCityNavigationAdapter({ tileIds: registration.tileIds });
  const tilePackages = new HttpTilePackageAdapter({ baseUrl: artifactBase, assetValidation: 'manifest', tileIds: registration.tileIds });
  let latestMap = null;
  let crossDemandController = null;
  let projectionOverlayController = null;
  let geographicContextController = null;
  const capability = game.probe();
  if (!capability.supported) {
    console.error('[KC two-tile] Unsupported game/API seam; no mutations performed', capability);
    api.ui?.showNotification?.('KC two-tile prototype disabled: incompatible game seam', 'error');
    return;
  }
  game.installTrackGroupLoadGuard();
  game.installClippedRouteTickGuard();
  game.installClippedRouteTrackEditGuard();

  async function recordNativeCommuteHealth(reason) {
    const health = { reason, capturedAt: Date.now(), ...game.nativeCommuteHealth() };
    console.info('[KC two-tile] native commute health', health);
    try {
      await storage?.set?.('diagnostics:native-commute-health', health);
    } catch (error) {
      console.warn('[KC two-tile] could not persist native commute diagnostics', error);
    }
    return health;
  }

  const runtime = new WorldTileRuntime({
    game,
    // Runtime switches validate the small manifest only. Full 95+ MB asset
    // verification remains available to pipeline/tests and is off the click path.
    tilePackages,
    tileIds: registration.tileIds,
    tileCatalog,
    worldState: new ModStorageWorldStateAdapter({ storage }),
    initialWorld: {
      activeTileId: 'KCW',
      wallet: 1_000_000,
      // Cross-tile flows are loaded from the compact package runtime contract.
      // Detailed trips/cohorts never enter the renderer process.
      cohorts: [],
    },
    telemetry: (event) => console.debug('[KC two-tile]', event),
  });

  let started = false;
  let ready = false;
  let startPromise = null;
  let loadedSaveName = null;
  const autosaveHookGuard = createAutosaveHookGuard();

  async function recalculateCrossModeShare(reason, day = null, force = false) {
    if (!ready || !isCurrent()) return null;
    const loadedCity = api.utils.getCityCode();
    if (!registration.cities.includes(loadedCity) || runtime.view().activeTileId !== loadedCity) return null;
    try {
      return await runtime.recalculateCrossTileModeShare({ reason, day, force });
    } catch (error) {
      console.warn(`[KC two-tile] cross-city mode-share recalculation failed (${reason})`, error);
      return null;
    }
  }

  async function settleCrossTileCommutes(reason = 'hourly') {
    if (!ready || !isCurrent()) return null;
    const loadedCity = api.utils.getCityCode();
    if (!registration.cities.includes(loadedCity) || runtime.view().activeTileId !== loadedCity) return null;
    try {
      return await runtime.settleCrossTileCommutes(reason);
    } catch (error) {
      console.warn(`[KC two-tile] cross-city fare settlement failed (${reason})`, error);
      return null;
    }
  }

  const modeShareInvalidation = createDailyModeShareInvalidation({
    recalculate: (reason, day) => recalculateCrossModeShare(reason, day),
  });
  const routeChanged = () => { if (ready && isCurrent()) modeShareInvalidation.markDirty('route-change'); };
  const scheduleChanged = () => { if (ready && isCurrent()) modeShareInvalidation.markDirty('schedule-change'); };
  const fareChanged = () => { if (ready && isCurrent()) modeShareInvalidation.markDirty('fare-change'); };
  const projectionReconciler = createNetworkProjectionReconciler({
    runtime,
    isReady: () => ready && isCurrent(),
    isActive: isCurrent,
    onRejected: (warning) => api.ui?.showNotification?.(
      warning?.message ?? 'That network edit is outside the editable tile window and was restored.',
      'warning',
      'Open World',
    ),
  });
  const scheduleReconciler = createRouteScheduleReconciler({
    runtime,
    isReady: () => ready && isCurrent(),
    isActive: isCurrent,
    onRejected: (warning) => api.ui?.showNotification?.(
      warning?.message ?? 'That route schedule could not be saved.',
      'warning',
      'Open World',
    ),
  });
  const projectionChanged = (reason) => {
    if (ready && isCurrent()) projectionReconciler.queue(reason);
  };
  game.installClippedRoutePreviewEditGuard({
    onConfirmed: () => {
      if (!ready || !isCurrent()) return;
      modeShareInvalidation.markDirty('route-change');
      projectionReconciler.queue('route-edited');
    },
  });

  function ensurePanels() {
    if (!started || !isCurrent()) return;
    registerPrototypePanel({ api, runtime, navigation });
    crossDemandController?.ensurePanel?.();
  }

  async function start(loadedCityCode, saveName = loadedSaveName) {
    if (!isCurrent() || !registration.cities.includes(loadedCityCode)) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      started = true;
      try {
        const pending = navigation.pendingFor(loadedCityCode);
        const nativeSessionId = api.gameState.getGameSessionId();
        let identity = await identities.resolve(nativeSessionId, pending?.worldId);
        await runtime.boot(
          identity.worldId,
          loadedCityCode,
          pending || saveName == null ? undefined : {
            saveName,
            allowLiveFallback: identity.aliased,
            nativeSessionId: identity.nativeSessionId,
            nativeTileId: loadedCityCode,
          },
        );
        const confirmedIdentity = await identities.resolve(nativeSessionId, pending?.worldId);
        if (confirmedIdentity.worldId !== identity.worldId) {
          identity = confirmedIdentity;
          await runtime.reloadFromSave(identity.worldId, loadedCityCode, saveName, {
            allowLiveFallback: identity.aliased,
            nativeSessionId: identity.nativeSessionId,
            nativeTileId: loadedCityCode,
          });
        }
        if (!isCurrent()) return;
        ready = true;
        await recalculateCrossModeShare('startup', api.gameState.getCurrentDay?.() ?? null);
        if (!isCurrent()) return;
        await recordNativeCommuteHealth('startup');
        if (!isCurrent()) return;
        if (pending) navigation.complete(pending);
        crossDemandController = registerCrossDemandViewer({ api, runtime, tilePackages });
        projectionOverlayController = registerNetworkProjectionOverlay({ api, runtime });
        geographicContextController = registerGeographicContextOverlay({ runtime, tileCatalog });
        if (latestMap) crossDemandController.attachMap(latestMap);
        if (latestMap) projectionOverlayController.attachMap(latestMap);
        if (latestMap) geographicContextController.attachMap(latestMap);
        ensurePanels();
      } catch (error) {
        started = false;
        ready = false;
        startPromise = null;
        if (!isCurrent()) return;
        console.error('[KC two-tile] startup failed', error);
        api.ui?.showNotification?.(`KC two-tile startup failed: ${error.message}`, 'error');
      }
    })();
    return startPromise;
  }

  async function handleGameLoaded(saveName) {
    if (!isCurrent()) return;
    if (autosaveHookGuard.isNestedLoad(saveName)) return;
    loadedSaveName = typeof saveName === 'string' && saveName ? saveName : null;
    const loadedCityCode = api.utils.getCityCode?.();
    if (!registration.cities.includes(loadedCityCode)) return;
    const pending = navigation.pending();
    if (!started) return start(loadedCityCode, loadedSaveName);
    if (!ready || pending) return;
    ready = false;
    try {
      const identity = await identities.resolve(api.gameState.getGameSessionId());
      await runtime.reloadFromSave(identity.worldId, loadedCityCode, loadedSaveName, {
        allowLiveFallback: identity.aliased,
        nativeSessionId: identity.nativeSessionId,
        nativeTileId: loadedCityCode,
      });
      if (!isCurrent()) return;
      ready = true;
      await recalculateCrossModeShare('save-load', api.gameState.getCurrentDay?.() ?? null);
      await recordNativeCommuteHealth('save-load');
      ensurePanels();
    } catch (error) {
      ready = false;
      console.error('[KC two-tile] save checkpoint load failed', error);
      api.ui?.showNotification?.(`KC two-tile save load failed: ${error.message}`, 'error');
    }
  }

  async function handleGameSaved(saveName) {
    if (!ready || !isCurrent() || typeof saveName !== 'string' || !saveName) return;
    if (!autosaveHookGuard.begin(saveName)) return;
    try {
      const nativeSessionId = api.gameState.getGameSessionId();
      const nativeTileId = api.utils.getCityCode?.() ?? runtime.view().activeTileId;
      const identityBound = await identities.bind(nativeSessionId, runtime.view().worldId);
      if (!identityBound) {
        throw new Error('Native save identity moved to another authoritative open-world lineage');
      }
      await runtime.checkpoint('game-save', {
        saveName,
        nativeSessionId,
        nativeTileId,
        captureNativeSnapshot: true,
      });
      loadedSaveName = saveName;
    } catch (error) {
      console.warn(`[KC two-tile] could not checkpoint native save ${saveName}`, error);
    } finally {
      autosaveHookGuard.end();
    }
  }

  async function ensureLifecyclePanels() {
    if (!isCurrent()) return;
    const loadedCityCode = api.utils.getCityCode?.();
    if (!registration.cities.includes(loadedCityCode)) return;
    await start(loadedCityCode);
    ensurePanels();
  }

  async function handleCityLoad(loadedCityCode) {
    if (!isCurrent()) return;
    if (!registration.cities.includes(loadedCityCode)) {
      game.restoreNativeCommuteRules();
      return;
    }
    if (!started) return start(loadedCityCode);
    if (!ready && startPromise) await startPromise;
    if (!isCurrent() || !ready) return;
    const pending = navigation.pendingFor(loadedCityCode);
    if (!pending) return;
    try {
      await identities.bind(api.gameState.getGameSessionId(), pending.worldId, { force: true });
      await runtime.completeStagedTransition(loadedCityCode);
      await recalculateCrossModeShare('tile-transition', api.gameState.getCurrentDay?.() ?? null);
      await recordNativeCommuteHealth('tile-transition');
      navigation.complete(pending);
      api.ui?.showNotification?.(`Now viewing Kansas City ${loadedCityCode === 'KCW' ? 'West' : 'East'}`, 'success', 'Open World Prototype');
    } catch (error) {
      console.error('[KC two-tile] transition completion failed', error);
      api.ui?.showNotification?.(`Tile switch failed: ${error.message}`, 'error', 'Open World Prototype');
    }
  }

  // Match Induced Demand's hot-reload-safe pattern: the loader clears UI and
  // then replays onMapReady/onGameLoaded, while onCityLoad is not late-fire.
  // onGameLoaded is late-fire. Register it first so the save identity is
  // available before onMapReady can start the runtime.
  api.hooks.onGameLoaded?.((saveName) => { void handleGameLoaded(saveName); });
  api.hooks.onGameSaved?.((saveName) => { void handleGameSaved(saveName); });
  api.hooks.onMapReady((map) => {
    if (!isCurrent()) return;
    stabilizeMapLayerMoves(map);
    relaxMapZoomLimits(map, { sourceMinZoom: tileCatalog.basemapMinZoom });
    latestMap = map;
    crossDemandController?.attachMap(map);
    projectionOverlayController?.attachMap(map);
    geographicContextController?.attachMap(map);
    void ensureLifecyclePanels();
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
    (routeId, schedule, previousSchedule) => scheduleReconciler.queue(routeId, schedule, previousSchedule),
    { readTrackInventory: () => game.getTrackInventory() },
  );
  api.hooks.onGameEnd?.(() => {
    if (!isCurrent()) return;
    modeShareInvalidation.cancel();
    projectionReconciler.cancel();
    scheduleReconciler.cancel();
    projectionOverlayController?.dispose?.();
    geographicContextController?.dispose?.();
    game.restoreNativeCommuteRules();
  });
  console.info('[KC two-tile] registered', registration);
})();
