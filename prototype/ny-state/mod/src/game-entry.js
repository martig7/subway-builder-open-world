import { WorldTileRuntime } from '../../../kc-two-tile/mod/src/world-tile-runtime.js';
import { SubwayBuilderGameAdapter } from '../../../kc-two-tile/mod/src/adapters/subway-builder-game-adapter.js';
import { ModStorageWorldStateAdapter } from '../../../kc-two-tile/mod/src/adapters/mod-storage-world-state-adapter.js';
import { HashCityNavigationAdapter } from '../../../kc-two-tile/mod/src/adapters/hash-city-navigation-adapter.js';
import { registerPrototypePanel } from '../../../kc-two-tile/mod/src/ui/prototype-panel.js';
import { registerCrossDemandViewer } from '../../../kc-two-tile/mod/src/ui/cross-demand-viewer.js';
import { registerNetworkProjectionOverlay } from '../../../kc-two-tile/mod/src/ui/network-projection-overlay.js';
import { createNetworkProjectionReconciler, createRouteScheduleReconciler, registerNetworkProjectionHooks } from '../../../kc-two-tile/mod/src/network-projection-hooks.js';
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
import { embeddedNetworkRecoveryGzipBase64 } from './embedded-network-recovery.js';
import {
  NETWORK_RECOVERY_ID,
  NETWORK_RECOVERY_REPLACE_ROUTE_IDS,
  NETWORK_RECOVERY_WORLD_IDS,
} from './network-recovery-config.js';

const PENDING_NAVIGATION_KEY = 'ny-state-pilot:pending-navigation';
const PENDING_PERFORMANCE_KEY = 'ny-state-pilot:pending-performance';
const DIAGNOSTICS_KEY = 'diagnostics:tile-transitions';
const RECOVERED_WORLD_ID = '220a5a58-5c33-41e0-8680-d80862153908';
const CURRENT_CANONICAL_WORLD_ID = '969e5d4d-62d2-463f-99b2-235ca101f372';
const RECOVERY_SESSION_ALIASES = Object.freeze({
  // This native tile save was created after the old projection code seeded a
  // fresh empty world. Bind it once through the authoritative storage API to
  // the validated repaired lineage. The resolver persists the alias on load.
  '8f24c509-e07d-40dc-a5bb-5db7dffd2c19': RECOVERED_WORLD_ID,
  '27134722-1b63-4732-9c7a-3a958f546123': RECOVERED_WORLD_ID,
  // A mod-reload race briefly forked this canonical lineage into a self-world.
  // Bind both the source autosave and its Albany destination save back to the
  // last complete nine-route world (including 101/102/103 and R).
  'dd490e80-79e0-4a86-852d-ef0c9c63187f': CURRENT_CANONICAL_WORLD_ID,
  '5f366b06-3165-46f1-b7e2-93318d6a80de': CURRENT_CANONICAL_WORLD_ID,
  // The authoritative-load trace captured this newly named autosave carrying
  // 5f366b06 as its embedded parent session. Keep the explicit migration so
  // the already-created stale fork recovers even before its first marker-stamped save.
  '2373ed13-57de-41ff-87d8-bbcf501592f1': CURRENT_CANONICAL_WORLD_ID,
});
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
  if (!api) throw new Error('[NY pilot] SubwayBuilderAPI is unavailable');
  stabilizeMapLayerMoves(api.utils?.getMap?.());
  relaxMapZoomLimits(api.utils?.getMap?.(), { sourceMinZoom: tileCatalog.basemapMinZoom });
  const generationKey = '__nyStateSixTileCanaryGeneration__';
  const generation = (Number(globalThis[generationKey]) || 0) + 1;
  globalThis[generationKey] = generation;
  const isCurrent = () => globalThis[generationKey] === generation;
  const storage = api.storage?.scoped?.();
  const identities = new WorldIdentityResolver({
    storage,
    fallbackWorldId: 'ny-state-six-tile',
    recoveryAliases: RECOVERY_SESSION_ALIASES,
  });
  const tileBase = globalThis.NY_STATE_PILOT_TILE_BASE ?? 'http://127.0.0.1:8798';
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
  const diagnostics = globalThis.__nyStatePilotDiagnostics__ = {
    generation,
    registeredAt: Date.now(),
    transitions: [],
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
    console.error('[NY pilot] Unsupported game/API seam; no mutations performed', capability);
    api.ui?.showNotification?.('New York pilot disabled: incompatible game seam', 'error');
    return;
  }
  diagnostics.trackGroupLoadGuard = game.installTrackGroupLoadGuard();
  const tickGuardInstallation = game.installClippedRouteTickGuard();
  diagnostics.tickGuard = tickGuardInstallation;
  if (tickGuardInstallation?.reason === 'stale-version-restart-required') {
    api.ui?.showNotification?.(
      'Open World updated its simulation guard. Restart Subway Builder once before continuing this audit.',
      'warning',
      'Open World',
    );
  }
  game.installClippedRouteTrackEditGuard();

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
    initialWorld: { activeTileId: 'NY_CP00_RP00', wallet: 1_000_000, cohorts: [] },
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
      console.debug('[NY pilot]', event);
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
  let startPromise = null;
  let loadedSaveName = null;
  let requestedSessionReload = null;
  let sessionReloadPromise = null;

  async function recalculateCrossModeShare(reason, day = null, force = false) {
    if (!ready || !isCurrent()) return null;
    const loadedCity = api.utils.getCityCode?.();
    if (!registration.cities.includes(loadedCity) || runtime.view().activeTileId !== loadedCity) return null;
    const startedAt = performance.now();
    try {
      const result = await runtime.recalculateCrossTileModeShare({ reason, day, force });
      diagnostics.latestCrossModeShare = { reason, milliseconds: performance.now() - startedAt, ...result };
      console.info('[NY pilot] cross-mode-share performance', diagnostics.latestCrossModeShare);
      return result;
    } catch (error) {
      console.warn(`[NY pilot] cross-city mode-share recalculation failed (${reason})`, error);
      return null;
    }
  }

  async function settleCrossTileCommutes(reason = 'hourly') {
    if (!ready || !settlementReady || !isCurrent()) return null;
    const loadedCity = api.utils.getCityCode?.();
    if (!registration.cities.includes(loadedCity) || runtime.view().activeTileId !== loadedCity) return null;
    try { return await runtime.settleCrossTileCommutes(reason); }
    catch (error) { console.warn(`[NY pilot] cross-city settlement failed (${reason})`, error); return null; }
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

  async function persistPerformance(sample) {
    diagnostics.latest = sample;
    diagnostics.transitions.push(sample);
    if (diagnostics.transitions.length > 50) diagnostics.transitions.splice(0, diagnostics.transitions.length - 50);
    try { await storage?.set?.(DIAGNOSTICS_KEY, diagnostics.transitions); } catch (error) {
      console.warn('[NY pilot] could not persist transition diagnostics', error);
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
    return identities.resolve(nativeSessionId, pendingWorldId, identityHints);
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
          console.error('[NY pilot] save checkpoint load failed', error);
          api.ui?.showNotification?.(`New York pilot save load failed: ${error.message}`, 'error');
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
        settlementReady = (await recalculateCrossModeShare('startup', api.gameState.getCurrentDay?.() ?? null)) != null;
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
        console.info('[NY pilot] ready', diagnostics.startup);
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
        console.error('[NY pilot] startup failed', error);
        api.ui?.showNotification?.(`New York pilot startup failed: ${error.message}`, 'error');
      }
    })();
    return startPromise;
  }

  async function handleGameLoaded(saveName) {
    if (!isCurrent()) return;
    loadedSaveName = typeof saveName === 'string' && saveName ? saveName : null;
    const loadedCityCode = api.utils.getCityCode?.();
    if (!registration.cities.includes(loadedCityCode)) return;
    const pending = navigation.pending();
    if (!started) return start(loadedCityCode, loadedSaveName);
    if (!ready || pending) return;
    return reloadLoadedSession(loadedCityCode, 'save-load', loadedSaveName, true);
  }

  async function handleGameSaved(saveName) {
    if (!ready || !settlementReady || !isCurrent() || typeof saveName !== 'string' || !saveName) return;
    try {
      const nativeSessionId = api.gameState.getGameSessionId();
      const nativeTileId = api.utils.getCityCode?.() ?? runtime.view().activeTileId;
      const identityBound = await identities.bind(nativeSessionId, runtime.view().worldId);
      if (!identityBound) {
        throw new Error('Native save identity moved to another authoritative open-world lineage');
      }
      await runtime.checkpoint('game-save', { saveName, nativeSessionId, nativeTileId });
      loadedSaveName = saveName;
    } catch (error) {
      console.warn(`[NY pilot] could not checkpoint native save ${saveName}`, error);
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
      console.info('[NY pilot] tile transition performance', sample);
      const tileName = tileById.get(loadedCityCode)?.name ?? loadedCityCode;
      const seconds = sample.totalMilliseconds == null ? null : (sample.totalMilliseconds / 1000).toFixed(2);
      api.ui?.showNotification?.(
        seconds ? `${tileName} loaded in ${seconds} s` : `Now viewing ${tileName}`,
        'success',
        'New York Performance Canary',
      );
    } catch (error) {
      recordAuthoritativeLoad({
        phase: 'authoritative-load',
        loadTraceId,
        segment: 'lifecycle-transition-failed',
        error: error?.stack ?? error?.message ?? String(error),
      });
      console.error('[NY pilot] transition completion failed', error);
      api.ui?.showNotification?.(`Tile switch failed: ${error.message}`, 'error', 'New York Performance Canary');
    }
  }

  async function ensureLifecyclePanel() {
    if (!isCurrent()) return;
    const loadedCityCode = api.utils.getCityCode?.();
    if (!registration.cities.includes(loadedCityCode)) return;
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
      console.warn('[NY pilot] repaired stale native tile source', diagnostics.tileSource);
    }
    if (diagnostics.mapCameraRepair.status === 'recentered') {
      console.warn('[NY pilot] recentered stale native tile camera', diagnostics.mapCameraRepair);
    }
  }

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
  console.info('[NY pilot] registered', registration);
})();
