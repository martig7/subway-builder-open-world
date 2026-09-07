import { assertWorld, createWorld, deepCopy, migrateWorldTileSet } from './world-model.js';
import { advanceCommutesTo, applyModeShares, projectCommutesByTile, projectCommutesForTile, rebaseCommutesTo, recordObservedDeparture, registerCommuteCatalog } from './cross-tile-commute-engine.js';
import { calculateCrossTileModeShares, createNetworkProfile, inspectCrossTileModeChoice, inspectCrossTileTransitPath, CROSS_ROUTING_CACHE_VERSION } from './cross-tile-mode-choice.js';
import {
  NetworkProjection,
  createNativeNetworkSnapshot,
  createGlobalNetwork,
  repairStationTrackGroupIntegrity,
  routeTileIdsById,
  stripNetworkFromSnapshot,
} from './network-projection.js';
import { CANONICAL_NATIVE_NETWORK_MODE } from './shared-transit-network.js';
import { fareSegmentsFromStationRoutes, quoteJourneyFare } from './journey-fare.js';
import { repairNativeStateRouteTimings } from './route-timing-integrity.js';
import {
  backgroundFinanceForHour,
  migrateNativeFinanceSidecar,
  nativeComparableFinanceForHour,
  summarizeNativeFinanceAudit,
} from './native-finance-model.js';
import {
  evaluateOffTileNativeDemand,
  isCurrentOffTileNativeDemandProfile,
  offTileNativeDemandContextKey,
} from './off-tile-native-demand.js';

const PHASES = Object.freeze(['lease', 'pause', 'snapshot', 'reconcile', 'catchup', 'prepare', 'load', 'globals', 'restore', 'verify', 'commit', 'resume']);
const NATIVE_FINANCE_AUDIT_SCHEMA_VERSION = 3;
const PASSIVE_RECALCULATION_REASONS = new Set(['startup', 'save-load', 'city-load', 'tile-transition']);
export const NATIVE_REVENUE_RECOVERY_VERSION = 'native-revenue-profile-retry-v1';
const NATIVE_DEMAND_TILE_GUARD_METERS = 3_000;
const CROSS_MODE_SHARE_SCHEMA_VERSION = 2;

function localizedNativeNetworkState(globalState, tileId, tileIdsByRoute) {
  const routes = (globalState?.routes ?? []).filter((route) => (
    tileIdsByRoute[String(route?.id)]?.includes(tileId)
  ));
  const routeIds = new Set(routes.map((route) => String(route.id)));
  const stationIds = new Set();
  const stationNodeIds = new Set();
  for (const route of routes) {
    for (const node of route?.stNodes ?? []) {
      if (node?.id != null) stationNodeIds.add(String(node.id));
      if (node?.stationId != null) stationIds.add(String(node.stationId));
    }
  }
  const stations = (globalState?.stations ?? []).filter((station) => {
    if (stationIds.has(String(station?.id))) return true;
    return (station?.stNodeIds ?? []).some((nodeId) => stationNodeIds.has(String(nodeId)));
  });
  const trains = (globalState?.trains ?? []).filter((train) => routeIds.has(String(train?.routeId)));
  return { routes, stations, trains, routeIds };
}

function localizedFarePolicy(farePolicy, globalState, routeIds) {
  const groups = globalState?.fareGroups?.length
    ? globalState.fareGroups
    : farePolicy?.fareGroups ?? [];
  const groupedRouteIds = new Set(groups.flatMap((group) => group?.routeIds ?? []).map(String));
  const localGroups = groups.flatMap((group) => {
    const localRouteIds = (group?.routeIds ?? []).map(String).filter((routeId) => routeIds.has(routeId));
    if (!localRouteIds.length) return [];
    const routeFares = group?.routeFares && typeof group.routeFares === 'object'
      ? Object.fromEntries(Object.entries(group.routeFares).filter(([routeId]) => routeIds.has(String(routeId))))
      : group?.routeFares;
    return [{ ...deepCopy(group), routeIds: localRouteIds, ...(routeFares ? { routeFares } : {}) }];
  });
  const usesLegacyFare = [...routeIds].some((routeId) => !groupedRouteIds.has(routeId));
  return {
    fare: usesLegacyFare ? Number(farePolicy?.fare) || 0 : 0,
    fareGroups: localGroups,
  };
}

function stableAuditValue(value) {
  if (Array.isArray(value)) return value.map(stableAuditValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableAuditValue(value[key])]));
  }
  return value;
}

function nativeFinanceAuditSignature(world) {
  const tileId = world.activeTileId;
  const networkProfile = world.tiles?.[tileId]?.networkProfile;
  const ownershipProjection = world.backgroundNativeFinance?.ownershipProjection
    ?? world.activeProjection;
  return JSON.stringify(stableAuditValue({
    tileId,
    networkSignature: networkProfile?.structuralSignature ?? networkProfile?.signature ?? null,
    farePolicy: world.farePolicy ?? null,
    comparableRouteIds: [...(ownershipProjection?.financeOwnedRouteIds ?? [])].map(String).sort(),
    partialRouteIds: [...(ownershipProjection?.partialRouteIds ?? [])].map(String).sort(),
  }));
}

function hashAuditValue(value) {
  const text = JSON.stringify(stableAuditValue(value));
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function crossModeShareContextKey(world) {
  const networkSignatures = Object.fromEntries(Object.entries(world.tiles ?? {})
    .map(([tileId, tile]) => [
      tileId,
      tile?.networkProfile?.structuralSignature ?? tile?.networkProfile?.signature ?? null,
    ])
    .sort(([left], [right]) => left.localeCompare(right)));
  const elapsedSeconds = Number.isFinite(world.elapsedSeconds) ? world.elapsedSeconds : 0;
  const contextHash = hashAuditValue({
    routingVersion: CROSS_ROUTING_CACHE_VERSION,
    schemaVersion: CROSS_MODE_SHARE_SCHEMA_VERSION,
    commuteCatalogBuildHash: world.commuteCatalogBuildHash ?? null,
    globalNetworkHash: world.globalNetwork?.hash ?? null,
    networkSignatures,
    farePolicy: world.farePolicy ?? null,
    // Timetables are time-of-day specific in 1.7. Keep lifecycle cache hits
    // within a service hour without forcing a full recalculation on every
    // tile transition or save-load.
    requestedDepartureHour: Math.floor(elapsedSeconds / 3_600) % 24,
  });
  return `cross-mode-share-v${CROSS_MODE_SHARE_SCHEMA_VERSION}:${contextHash}`;
}

function summarizeNetworkForLoad(state) {
  const network = state?.data && typeof state.data === 'object' ? state.data : state;
  const routes = Array.isArray(network?.routes) ? network.routes : [];
  return {
    tracks: Array.isArray(network?.tracks) ? network.tracks.length : 0,
    trackGroups: Array.isArray(network?.trackGroups) ? network.trackGroups.length : 0,
    stations: Array.isArray(network?.stations) ? network.stations.length : 0,
    routes: routes.length,
    trains: Array.isArray(network?.trains) ? network.trains.length : 0,
    routeInventory: routes.map((route) => ({
      id: route?.id ?? null,
      bullet: route?.bullet ?? null,
      name: route?.fullName ?? route?.name ?? null,
    })),
  };
}

function summarizeWorldForLoad(world) {
  return world ? {
    worldId: world.worldId,
    revision: world.revision,
    activeTileId: world.activeTileId,
    worldTime: world.worldTime,
    elapsedSeconds: world.elapsedSeconds,
    pendingTransition: world.pendingTransition ?? null,
    globalNetworkHash: world.globalNetwork?.hash ?? null,
    globalNetworkRevision: world.globalNetwork?.revision ?? null,
    activeProjection: world.activeProjection ? {
      activeTileId: world.activeProjection.activeTileId,
      networkRevision: world.activeProjection.networkRevision,
      projectionHash: world.activeProjection.projectionHash,
      partialRouteIds: world.activeProjection.partialRouteIds ?? [],
      visibleTileIds: world.activeProjection.visibleTileIds ?? [],
    } : null,
    network: summarizeNetworkForLoad(world.globalNetwork?.nativeState),
  } : null;
}

function summarizeLineage(world) {
  const network = summarizeNetworkForLoad(world?.globalNetwork?.nativeState);
  const elapsedSeconds = Number.isFinite(world?.elapsedSeconds) ? world.elapsedSeconds : 0;
  return {
    day: Math.floor(Math.max(0, elapsedSeconds) / 86_400) + 1,
    worldTime: Number.isFinite(world?.worldTime) ? world.worldTime : Math.floor(elapsedSeconds / 3_600),
    routeCount: network.routes,
    stationCount: network.stations,
    trainCount: network.trains,
    wallet: Number.isFinite(world?.wallet) ? world.wallet : null,
    fare: Number.isFinite(world?.farePolicy?.fare) ? world.farePolicy.fare : null,
    elapsedSeconds,
  };
}

function createCanonicalNetwork(source, revision = 0) {
  const groupRepair = repairStationTrackGroupIntegrity(source?.data ?? source);
  const routeRepair = repairNativeStateRouteTimings(groupRepair.state);
  return createGlobalNetwork(routeRepair.state, revision);
}

export class WorldTileRuntime {
  constructor({ game, tilePackages, worldState, initialWorld, tileIds = initialWorld?.tileIds ?? tilePackages?.tileIds?.(), tileCatalog = null, revenueAccrual = null, backgroundNativeExpenses = true, evaluateCrossModeShares = calculateCrossTileModeShares, now = () => Date.now(), telemetry = () => {} }) {
    this.game = game; this.tilePackages = tilePackages; this.worldState = worldState; this.initialWorld = initialWorld;
    this.evaluateCrossModeShares = evaluateCrossModeShares;
    this.tileIds = Object.freeze([...tileIds]);
    if (!this.tileIds.length || new Set(this.tileIds).size !== this.tileIds.length) throw new Error('Runtime tile IDs must be a non-empty unique list');
    this.tileCatalog = tileCatalog; this.revenueAccrual = revenueAccrual; this.backgroundNativeExpenses = backgroundNativeExpenses !== false; this.now = now; this.telemetry = telemetry; this.world = null; this.viewWorldFallback = null; this.inFlight = new Map(); this.serial = Promise.resolve(); this.listeners = new Set();
    this.nativeNetworkMode = CANONICAL_NATIVE_NETWORK_MODE;
    this.fullNativeNetworkEnabled = true;
    this.networkProjection = tileCatalog ? new NetworkProjection({ guardBandMeters: 250 }) : null;
    this.derivedNetworkInvalidations = new Set();
    this.nativeRevenueCompilation = null;
    this.lastNativeRevenuePosting = null;
  }
  async boot(worldId, loadedTileId = null, {
    saveName = null,
    allowLiveFallback = false,
    nativeSessionId = null,
    nativeTileId = null,
    nativeAuthoritativeLoad = false,
    loadTraceId = null,
  } = {}) {
    if (this.world) return this.view();
    this.nativeRevenueCompilation = null;
    this.lastNativeRevenuePosting = null;
    this.revenueAccrual?.invalidate?.();
    const startupStartedAt = this.now();
    const traceId = loadTraceId
      ?? `boot:${worldId}:${nativeSessionId ?? 'unbound'}:${startupStartedAt}`;
    const trace = (segment, details = {}) => this.telemetry({
      phase: 'authoritative-load',
      loadTraceId: traceId,
      segment,
      worldId,
      loadedTileId,
      saveName,
      nativeSessionId,
      nativeTileId,
      allowLiveFallback,
      nativeAuthoritativeLoad,
      elapsedMilliseconds: Math.max(0, this.now() - startupStartedAt),
      ...details,
    });
    trace('boot-start');
    let stageStartedAt = startupStartedAt;
    const startupStages = {};
    const finishStartupStage = (name) => {
      const finishedAt = this.now();
      startupStages[name] = Math.max(0, finishedAt - stageStartedAt);
      stageStartedAt = finishedAt;
    };
    await this.game.assertSupported();
    trace('capability-supported');
    finishStartupStage('capability');
    trace('storage-load-start');
    const persistedWorld = await this.worldState.load(
      worldId,
      saveName == null ? { loadTraceId: traceId } : {
        saveName,
        allowLiveFallback,
        nativeSessionId,
        nativeTileId,
        loadTraceId: traceId,
      },
    );
    let startupRequiresFullWorldSave = !persistedWorld
      || saveName != null
      || allowLiveFallback
      || nativeAuthoritativeLoad;
    trace('storage-load-complete', {
      source: persistedWorld ? 'persisted' : 'new-world',
      persistedWorld: summarizeWorldForLoad(persistedWorld),
    });
    finishStartupStage('storageLoad');
    this.world = persistedWorld ?? createWorld({
      worldId,
      ...this.initialWorld,
      tileIds: this.tileIds,
      ...(loadedTileId ? { activeTileId: loadedTileId } : {}),
    });
    const bootInitialActiveTileId = this.world.activeTileId;
    migrateWorldTileSet(this.world, this.tileIds);
    // Older sidecars contain useful recovery estimates for the complete
    // network, but predate the explicit rule that the loaded native save owns
    // every operational and infrastructure expense. Migrate that ownership
    // before startup catch-up; migrating only the revenue rows lets the legacy
    // expense estimate charge the same native hour a second time.
    this.world.backgroundNativeFinance = migrateNativeFinanceSidecar(
      this.world.backgroundNativeFinance,
    );
    this.#migrateBackgroundFinanceOwnership(this.world);
    // Schema-v1 prototype worlds created before exact clock preservation only
    // have the coarse hourly simulation clock.
    if (!Number.isFinite(this.world.elapsedSeconds)) this.world.elapsedSeconds = this.world.worldTime * 3600;
    // Migrate legacy prototype saves in-place before any view/deep-copy. Those
    // saves embedded each city's complete demand model and could exceed 400 MB.
    if (typeof this.game.compactSnapshot === 'function') {
      for (const tile of Object.values(this.world.tiles ?? {})) {
        if (tile.snapshot) tile.snapshot = this.game.compactSnapshot(tile.snapshot);
      }
    }
    for (const [tileId, tile] of Object.entries(this.world.tiles ?? {})) {
      const data = tile.snapshot?.data;
      const profileNeedsNativeTimings = tile.networkProfile?.routes?.some?.(
        (route) => route.stNodeIds?.length > 1 && !route.stComboTimings?.length,
      );
      if ((!tile.networkProfile || profileNeedsNativeTimings)
        && Array.isArray(data?.stations) && Array.isArray(data?.routes) && Array.isArray(data?.trains)) {
        tile.networkProfile = createNetworkProfile({ tileId, stations: data.stations, routes: data.routes, trains: data.trains });
      }
    }
    assertWorld(this.world, this.tileIds);
    if (loadedTileId && loadedTileId !== this.world.activeTileId) {
      const checkpointTileId = this.world.activeTileId;
      // Native save loading is authoritative. A checkpoint may lag behind when
      // the player exits one tile and opens a save belonging to another tile.
      this.world.activeTileId = loadedTileId;
      this.world.pendingTransition = null;
      this.world.revision++;
      startupRequiresFullWorldSave = true;
      this.telemetry({
        phase: 'loaded-tile-reconciliation',
        checkpointTileId,
        loadedTileId,
        saveName,
      });
      assertWorld(this.world, this.tileIds);
    }
    this.#configureCommittedFinanceOwnership(this.world);
    trace('world-prepared', { world: summarizeWorldForLoad(this.world) });
    finishStartupStage('worldPreparation');
    const pkg = await this.tilePackages.prepare(this.world.activeTileId); // package failures occur before mutation
    await this.#registerCommuteCatalog(this.world, this.world.activeTileId);
    trace('package-prepared', {
      packageTileId: pkg?.manifest?.tileId ?? null,
      packageCityCode: pkg?.manifest?.cityCode ?? null,
    });
    finishStartupStage('packagePreparation');
    // The lifecycle hook fires after Subway Builder has loaded the selected
    // city. Associate that native state with its package; reloading it here
    // races Deck.gl's active layers and causes a second loading-screen cycle.
    await this.game.adoptStaticPackage(pkg, loadedTileId ?? this.world.activeTileId);
    trace('package-adopted');
    finishStartupStage('packageAdoption');
    const wasPaused = await this.#pausePreservingUserState();
    trace('pause-acquired', { userWasPaused: wasPaused });
    finishStartupStage('pause');
    try {
      const activeTile = this.world.tiles[this.world.activeTileId];
      // Unless a cross-tile handoff is pending, the native state that fired
      // onCityLoad is authoritative: it contains the difficulty's starting
      // balance for a new game, the loaded save, or the live hot-reload state.
      trace('state-adoption-path-selected', {
        adoptLoadedRuntime: true,
        pendingTransition: this.world.pendingTransition ?? null,
        topologyAuthority: 'native-save',
      });
      const capturedGlobalsChanged = await this.#captureAuthoritativeGlobals(this.world, {
          // An explicitly aliased fallback is a true user save-load. Its
          // native clock is authoritative even when the retained live sidecar
          // belongs to a later autosave.
          allowClockRegression: allowLiveFallback || nativeAuthoritativeLoad,
        });
        startupRequiresFullWorldSave ||= capturedGlobalsChanged;
        trace('authoritative-globals-captured', {
          worldTime: this.world.worldTime,
          elapsedSeconds: this.world.elapsedSeconds,
          wallet: this.world.wallet,
        });
        const authoritativeHour = Math.floor(this.world.elapsedSeconds / 3600);
        this.#ensureBackgroundFinanceClock(this.world, authoritativeHour);
        if (!this.revenueAccrual) this.#recoverLegacySettlementBaseline(this.world, authoritativeHour);
        if ((allowLiveFallback || nativeAuthoritativeLoad) && authoritativeHour < this.world.worldTime) {
          rebaseCommutesTo(this.world, authoritativeHour);
          this.world.worldTime = authoritativeHour;
          for (const tile of Object.values(this.world.tiles)) {
            tile.lastSimulatedTime = authoritativeHour;
            tile.aggregate = { ridership: 0, revenue: 0, operatingCost: 0, backlog: 0 };
          }
          for (const [tileId, tile] of Object.entries(this.world.tiles)) {
            tile.aggregate.backlog = projectCommutesForTile(this.world, tileId).waitingToLeave;
          }
          this.telemetry({
            phase: 'aliased-save-clock-rebase',
            authoritativeHour,
            elapsedSeconds: this.world.elapsedSeconds,
            saveName,
          });
        }
        this.#advanceDraft(this.world, authoritativeHour);
        try {
          // A native load only supplies the current native state. Revenue is
          // eligible for posting on the next hourly tick, never during boot.
          if (!this.revenueAccrual) {
            await this.#syncCrossTileFinance(this.world);
            await this.#syncBackgroundNativeFinance(this.world, authoritativeHour);
          }
        } catch (error) {
          // A fare-posting failure must never make the player's native save
          // unloadable. Retain the pending batch for an idempotent later retry.
          this.world.settlementFinanceQuarantine = {
            message: error?.message ?? String(error),
            atHour: authoritativeHour,
            pendingRevenue: this.world.crossTileFinancials?.pendingNativeRevenue ?? 0,
          };
          this.telemetry({ phase: 'settlement-finance-quarantined', ...this.world.settlementFinanceQuarantine });
        }
        const liveSnapshot = await this.game.captureSnapshot(activeTile.snapshot);
        await this.game.validateSnapshot(liveSnapshot);
        trace('live-snapshot-captured', {
          snapshot: summarizeNetworkForLoad(liveSnapshot),
        });
        if (this.networkProjection) {
          const adoption = await this.#adoptProjectionSnapshot(this.world, this.world.activeTileId, liveSnapshot, {
            restore: false,
            trace,
          });
          startupRequiresFullWorldSave ||= adoption.changed;
        } else activeTile.snapshot = liveSnapshot;
      finishStartupStage('stateAdoption');
      if (!this.revenueAccrual) {
        await this.game.setAuthoritativeGlobals(this.world);
        trace('authoritative-globals-applied');
      } else {
        await this.game.setAuthoritativeGameMode?.(this.world.gameMode);
        await this.game.setAuthoritativeClock?.(this.world.elapsedSeconds);
        trace('authoritative-globals-retained-native');
      }
      finishStartupStage('authoritativeGlobals');
      const commuteRefresh = await this.game.refreshNativeCommutes?.();
      if (commuteRefresh) this.telemetry({ phase: 'commute-refresh', ...commuteRefresh });
      trace('native-commutes-refreshed', { result: commuteRefresh ?? null });
      finishStartupStage('nativeCommuteRefresh');
      await this.game.verifyLoaded();
      trace('native-verified', {
        observedNativeNetwork: await this.game.inspectNativeNetworkForDiagnostics?.() ?? null,
      });
      finishStartupStage('verification');
      // A route may cross the logical tile boundary while remaining owned by
      // the native save that created it. Capture the freshly loaded save on
      // first boot so global cross-tile routing can search that profile too.
      const loadedProfile = await this.#captureNetworkProfile(this.world, this.world.activeTileId);
      if (loadedProfile) activeTile.networkProfile = loadedProfile;
      trace('network-profile-captured', {
        signature: loadedProfile?.structuralSignature ?? loadedProfile?.signature ?? null,
        routes: loadedProfile?.routes?.length ?? 0,
        stations: loadedProfile?.stations?.length ?? 0,
      });
      finishStartupStage('networkProfile');
      const startupFinance = this.#ensureBackgroundFinanceClock(
        this.world,
        Math.floor(this.world.elapsedSeconds / 3600),
      );
      const startupFinanceConfigured = Boolean(
        startupFinance.networkHash
        || startupFinance.expenseProfile
        || Object.keys(startupFinance.tileRevenueProfiles ?? {}).length,
      );
      const startupFinanceReady = this.#financeProfileReadiness(
        startupFinance,
        this.world.globalNetwork?.hash ?? null,
      ).ready;
      if (!this.revenueAccrual && startupFinanceConfigured && !startupFinanceReady) {
        await this.#recoverStaleNativeFinanceProfile(
          this.world,
          Math.floor(this.world.elapsedSeconds / 3600),
          saveName == null ? 'startup' : 'save-load',
          { force: true },
        );
      }
      if (!activeTile.snapshot) {
        const template = Object.values(this.world.tiles).find((tile) => tile.snapshot)?.snapshot ?? null;
        activeTile.snapshot = await this.game.captureSnapshot(template);
        startupRequiresFullWorldSave = true;
      }
      finishStartupStage('snapshotFallback');
      if (this.world.pendingTransition?.to === this.world.activeTileId) {
        this.world.committedTransitionId = this.world.pendingTransition.transitionId;
        this.world.pendingTransition = null;
        startupRequiresFullWorldSave = true;
      }
      if (startupRequiresFullWorldSave || typeof this.worldState.saveSettlement !== 'function') {
        await this.worldState.save(this.world);
      } else {
        await this.worldState.saveSettlement(this.world);
      }
      trace('storage-saved', {
        mode: startupRequiresFullWorldSave ? 'full-world' : 'settlement-journal',
        initialActiveTileId: bootInitialActiveTileId,
        world: summarizeWorldForLoad(this.world),
      });
      finishStartupStage('storageSave');
    } finally {
      await this.#restoreUserPauseState(wasPaused);
      trace('pause-restored', { userWasPaused: wasPaused });
      finishStartupStage('pauseRestore');
    }
    this.telemetry({
      phase: 'startup-performance',
      status: 'ready',
      tileId: this.world.activeTileId,
      milliseconds: Math.max(0, this.now() - startupStartedAt),
      stages: startupStages,
    });
    trace('boot-complete', { world: summarizeWorldForLoad(this.world) });
    return this.view();
  }
  async reloadFromSave(worldId, loadedTileId, saveName, {
    allowLiveFallback = false,
    nativeSessionId = null,
    nativeTileId = null,
    nativeAuthoritativeLoad = false,
    loadTraceId = null,
  } = {}) {
    return this.#enqueue(async () => {
      const staged = this.world?.pendingTransition;
      if (staged) {
        this.telemetry({
          phase: 'save-load-deferred-for-transition',
          loadedTileId,
          stagedTileId: staged.to,
          transitionId: staged.transitionId,
          saveName,
        });
        return this.view();
      }
      const previousWorld = this.world;
      this.viewWorldFallback = previousWorld;
      this.world = null;
      this.inFlight.clear();
      try {
        const view = await this.boot(worldId, loadedTileId, {
          saveName,
          allowLiveFallback,
          nativeSessionId,
          nativeTileId,
          nativeAuthoritativeLoad,
          loadTraceId,
        });
        this.#notify({ type: 'save-loaded', saveName });
        return view;
      } catch (error) {
        this.world = previousWorld;
        throw error;
      } finally {
        this.viewWorldFallback = null;
      }
    });
  }
  getActiveTileId() {
    const world = this.world ?? this.viewWorldFallback;
    if (!world) throw new Error('WorldTileRuntime.boot must complete first');
    return world.activeTileId;
  }
  markDerivedNetworkDirty(reason = 'route-service-change') {
    this.derivedNetworkInvalidations.add(String(reason));
    return this.derivedNetworkDirtyReasons();
  }
  derivedNetworkDirtyReasons() {
    return [...this.derivedNetworkInvalidations].sort();
  }
  getInterliningRevision() {
    const revision = this.game?.getInterliningRevision?.();
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
  }
  view({ includeDemandDetails = true } = {}) {
    const world = this.world ?? this.viewWorldFallback;
    if (!world) throw new Error('WorldTileRuntime.boot must complete first');
    // UI callers need tile status, never the opaque native save bodies.
    const tiles = Object.fromEntries(Object.entries(world.tiles).map(([id, tile]) => [id, {
      revision: tile.revision,
      lastSimulatedTime: tile.lastSimulatedTime,
      aggregate: tile.aggregate,
      hasSnapshot: Boolean(tile.snapshot),
    }]));
    const commutesByTile = projectCommutesByTile(world, this.tileIds);
    const partialRouteIds = world.activeProjection?.partialRouteIds ?? [];
    const partialRouteServices = partialRouteIds
      .map((routeId) => world.globalNetwork?.routeDescriptors?.[routeId])
      .filter(Boolean);
    const lineage = summarizeLineage(world);
    return deepCopy({ nativeNetworkMode: this.nativeNetworkMode, fullNativeNetworkEnabled: this.fullNativeNetworkEnabled, worldId: world.worldId, activeTileId: world.activeTileId, worldTime: world.worldTime, day: lineage.day, elapsedSeconds: world.elapsedSeconds, wallet: world.wallet, fare: lineage.fare, revision: world.revision, routeCount: lineage.routeCount, stationCount: lineage.stationCount, trainCount: lineage.trainCount, settlementAccountingSchemaVersion: world.settlementAccountingSchemaVersion, settlementFinanceQuarantine: world.settlementFinanceQuarantine ?? null, backgroundNativeFinance: world.backgroundNativeFinance, tiles, gatewayLedger: includeDemandDetails ? world.gatewayLedger : {}, crossPopModeChoices: includeDemandDetails ? world.crossPopModeChoices ?? {} : {}, crossModeShare: world.crossModeShare ?? null, crossTileFinancials: world.crossTileFinancials, projectionWarning: world.projectionWarning ?? null, projection: world.activeProjection ? { activeTileId: world.activeProjection.activeTileId, networkRevision: world.activeProjection.networkRevision, visibleTileIds: world.activeProjection.visibleTileIds ?? [], partialRouteIds, projectionHash: world.activeProjection.projectionHash } : null, partialRouteServices, commutes: commutesByTile[world.activeTileId], commutesByTile });
  }
  projectionOverlay() { return deepCopy((this.world ?? this.viewWorldFallback)?.projectionOverlay ?? { type: 'FeatureCollection', features: [] }); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  inspectCrossTileTransitPath(crossDemand, popIndex) {
    this.#requireBooted();
    const networkProfiles = Object.fromEntries(Object.entries(this.world.tiles).map(([id, tile]) => [id, tile.networkProfile]).filter(([, profile]) => profile));
    return inspectCrossTileTransitPath({
      crossDemand,
      popIndex,
      networkProfiles,
      gatewayCatalog: this.world.gatewayCatalog,
      tileCatalog: this.tileCatalog,
      requestedDepartureSeconds: this.world.elapsedSeconds,
    });
  }
  inspectCrossTileModeChoice(crossDemand, popIndex) {
    this.#requireBooted();
    const networkProfiles = Object.fromEntries(Object.entries(this.world.tiles).map(([id, tile]) => [id, tile.networkProfile]).filter(([, profile]) => profile));
    return inspectCrossTileModeChoice({
      crossDemand,
      popIndex,
      networkProfiles,
      gatewayCatalog: this.world.gatewayCatalog,
      tileCatalog: this.tileCatalog,
      fare: this.world.farePolicy?.fare ?? 0,
      journeyFare: (stationRoutes, stationById) => this.#quoteJourneyFare(stationRoutes, stationById),
      requestedDepartureSeconds: this.world.elapsedSeconds,
    });
  }
  #notify(event) {
    if (this.listeners.size === 0) return;
    const view = this.view({ includeDemandDetails: false });
    for (const listener of this.listeners) listener(event, view);
  }

  async #compileNativeFinanceProfile(world, tileId, networkProfile = world.tiles?.[tileId]?.networkProfile) {
    const hasPackagedDemand = typeof this.tilePackages.loadNativeDemand === 'function'
      || typeof this.tilePackages.evaluateNativeDemand === 'function';
    let nativeFinanceProfile = this.backgroundNativeExpenses || !hasPackagedDemand
      ? this.game.calculateNativeFinanceProfile?.(
      tileId,
      world.globalNetwork?.nativeState ?? null,
      { financeOwnedRouteIds: world.activeProjection?.financeOwnedRouteIds ?? [],
        includeExpenses: this.backgroundNativeExpenses, includeRevenue: !hasPackagedDemand },
      ) : null;
    const finance = this.#ensureBackgroundFinanceClock(world, Math.floor(world.elapsedSeconds / 3600));
    const hadNativeFinanceProfile = Object.keys(finance.tileRevenueProfiles ?? {}).length > 0
      || Boolean(finance.expenseProfile);
    if (this.backgroundNativeExpenses && nativeFinanceProfile?.expenseProfile) {
      finance.expenseProfile = {
        ...deepCopy(nativeFinanceProfile.expenseProfile),
        networkHash: world.globalNetwork?.hash ?? null,
      };
    }
    const results = { evaluated: 0, cached: 0, unavailable: [], failed: [] };
    const pathfindingRules = this.game.capturePathfindingRules?.() ?? networkProfile?.pathfindingRules ?? {};
    finance.routingRulesKey = JSON.stringify(pathfindingRules);
    const globalState = world.globalNetwork?.nativeState ?? null;
    const financeOwnedRouteIds = world.activeProjection?.financeOwnedRouteIds ?? [];
    const hasSpatialTileCatalog = this.tileCatalog?.tiles?.some?.((tile) => Array.isArray(tile?.bounds));
    const tileIdsByRoute = globalState && hasSpatialTileCatalog
      ? routeTileIdsById(globalState, this.tileCatalog, { guardBandMeters: NATIVE_DEMAND_TILE_GUARD_METERS })
      : null;
    if (hasPackagedDemand) {
      for (const candidateTileId of this.tileIds) {
        try {
          const localized = globalState && tileIdsByRoute
            ? localizedNativeNetworkState(globalState, candidateTileId, tileIdsByRoute)
            : null;
          const candidateProfile = localized
            ? createNetworkProfile({
              tileId: candidateTileId,
              stations: localized.stations,
              routes: localized.routes,
              trains: localized.trains,
              pathfindingRules,
            })
            : globalState
              ? createNetworkProfile({
                tileId: candidateTileId,
                stations: globalState.stations ?? [],
                routes: globalState.routes ?? [],
                trains: globalState.trains ?? [],
                pathfindingRules,
              })
            : (candidateTileId === tileId ? networkProfile : world.tiles?.[candidateTileId]?.networkProfile);
          if (!candidateProfile) { results.unavailable.push(candidateTileId); continue; }
          const candidateRouteIds = localized?.routeIds
            ?? new Set((candidateProfile.routes ?? []).map((route) => String(route.id)));
          const localFinanceOwnedRouteIds = financeOwnedRouteIds.filter((routeId) => (
            candidateRouteIds.has(String(routeId))
          ));
          const localFarePolicy = localizedFarePolicy(world.farePolicy, globalState, candidateRouteIds);
          const contextKey = offTileNativeDemandContextKey({
            tileId: candidateTileId,
            networkProfile: candidateProfile,
            farePolicy: localFarePolicy,
            financeOwnedRouteIds: localFinanceOwnedRouteIds,
          });
          const existingProfile = finance.tileRevenueProfiles[candidateTileId];
          if (isCurrentOffTileNativeDemandProfile(existingProfile)
            && existingProfile.contextKey === contextKey) {
            results.cached++;
            this.telemetry({
              phase: 'off-tile-native-demand',
              tileId: candidateTileId,
              status: 'cached',
              evaluatedPops: existingProfile.evaluatedPops,
              transitPopulation: existingProfile.transitPopulation,
              dailyRevenue: existingProfile.dailyRevenue,
            });
            continue;
          }
          // An unserved tile has exactly zero transit revenue for this network.
          // Avoid inflating and parsing its full native demand package merely
          // to prove that no journey can enter a route. If service is added to
          // the tile later, the changed network context invalidates this zero
          // profile and the real demand package is evaluated normally.
          const hasLocalRouteService = (candidateProfile.routes ?? []).length > 0;
          const canSeedUnservedProfile = !hasLocalRouteService
            && existingProfile == null
            && this.tilePackages.canSkipNativeDemandForUnservedTile?.(candidateTileId) === true;
          const evaluationInput = {
            worldId: world.worldId,
            tileId: candidateTileId,
            networkProfile: candidateProfile,
            farePolicy: localFarePolicy,
            globalNativeState: globalState,
            financeOwnedRouteIds: localFinanceOwnedRouteIds,
            existingProfile,
          };
          let result = null;
          let packageEvaluationError = null;
          if (!canSeedUnservedProfile
            && typeof this.tilePackages.evaluateNativeDemand === 'function') {
            try {
              result = await this.tilePackages.evaluateNativeDemand(evaluationInput);
            } catch (error) {
              packageEvaluationError = error;
            }
          }
          if (!result) {
            const demand = canSeedUnservedProfile
              ? { points: [], pops: [] }
              : await this.tilePackages.loadNativeDemand?.(candidateTileId);
            if (!demand) {
              if (packageEvaluationError) throw packageEvaluationError;
              results.unavailable.push(candidateTileId);
              continue;
            }
            result = evaluateOffTileNativeDemand({ ...evaluationInput, demand });
          }
          finance.tileRevenueProfiles[candidateTileId] = deepCopy(result.profile);
          results[result.status]++;
          this.telemetry({
            phase: 'off-tile-native-demand',
            tileId: candidateTileId,
            status: result.status,
            evaluatedPops: result.profile.evaluatedPops,
            transitPopulation: result.profile.transitPopulation,
            dailyRevenue: result.profile.dailyRevenue,
          });
        } catch (error) {
          results.failed.push({ tileId: candidateTileId, error: String(error?.message ?? error) });
          this.telemetry({
            phase: 'off-tile-native-demand', tileId: candidateTileId, status: 'failed',
            error: String(error?.message ?? error),
          });
        }
      }
    }
    // A package adapter without native-demand access retains the old active
    // store result as a compatibility fallback. Production adapters use the
    // off-tile evaluator for every tile, including the one being viewed.
    if (!finance.tileRevenueProfiles[tileId]?.source) {
      if (!nativeFinanceProfile?.tileRevenueProfile) nativeFinanceProfile = this.game.calculateNativeFinanceProfile?.(
        tileId, world.globalNetwork?.nativeState ?? null,
        { financeOwnedRouteIds: world.activeProjection?.financeOwnedRouteIds ?? [], includeRevenue: true, includeExpenses: false },
      );
      if (nativeFinanceProfile?.tileRevenueProfile) {
        finance.tileRevenueProfiles[tileId] = {
          ...deepCopy(nativeFinanceProfile.tileRevenueProfile),
          networkSignature: networkProfile?.structuralSignature ?? networkProfile?.signature ?? null,
        };
      }
    }
    if (!hadNativeFinanceProfile) finance.lastSettledHour = Math.floor(world.elapsedSeconds / 3600);
    if (results.failed.length === 0 && results.unavailable.length === 0) {
      finance.networkHash = world.globalNetwork?.hash ?? null;
    }
    const projected = finance.tileRevenueProfiles[tileId];
    return {
      compiled: Boolean(projected || (this.backgroundNativeExpenses && finance.expenseProfile)),
      ...results,
      activeSource: projected?.source ?? 'native-store-fallback',
    };
  }

  async inspectNativeRevenue() {
    this.#requireBooted();
    const world = this.world;
    const finance = world.backgroundNativeFinance;
    const native = this.game.calculateNativeFinanceProfile?.(world.activeTileId,
      world.globalNetwork?.nativeState ?? null, { includeRevenue: true, includeExpenses: false })?.tileRevenueProfile;
    const globals = await this.game.captureAuthoritativeGlobals?.();
    const tiles = this.tileIds.map(tileId => {
      const profile = finance?.tileRevenueProfiles?.[tileId];
      return { tileId, active: tileId === world.activeTileId, available: Boolean(profile),
        source: profile?.source ?? null, dailyRevenue: profile?.dailyRevenue ?? null,
        transitPopulation: profile?.transitPopulation ?? null,
        nativeStatsJourneyCount: (profile?.hourly ?? []).reduce((sum, bucket) => sum + (bucket.completedCommutes?.length ?? 0), 0),
        evaluatedPops: profile?.evaluatedPops ?? null,
        skippedPops: profile?.skippedPops ?? null, contextKey: profile?.contextKey ?? null };
    });
    return {
      version: NATIVE_REVENUE_RECOVERY_VERSION, worldId: world.worldId,
      nativeRouteRidershipVersion: 'native-route-ridership-v1',
      routingRules: this.game.capturePathfindingRules?.() ?? null,
      activeTileId: world.activeTileId, elapsedSeconds: globals?.elapsedSeconds ?? world.elapsedSeconds,
      networkHash: world.globalNetwork?.hash ?? null, profileNetworkHash: finance?.networkHash ?? null,
      // Both are representative-day forecasts. The native value uses live
      // native commute choices; the off-tile value uses our independent router.
      activeNativeDailyRevenue: native?.dailyRevenue ?? null,
      activeEstimatedDailyRevenue: finance?.tileRevenueProfiles?.[world.activeTileId]?.dailyRevenue ?? null,
      inactiveEstimatedDailyRevenue: tiles.filter(tile => !tile.active).reduce((sum, tile) => sum + (tile.dailyRevenue ?? 0), 0),
      missingTileIds: tiles.filter(tile => !tile.available).map(tile => tile.tileId),
      pending: this.nativeRevenueCompilation ? {
        attemptedHour: this.nativeRevenueCompilation.attemptedHour,
        failed: deepCopy(this.nativeRevenueCompilation.failed),
        unavailable: [...this.nativeRevenueCompilation.unavailable],
      } : null,
      lastPosting: deepCopy(this.lastNativeRevenuePosting),
      completedNativeHours: deepCopy((globals?.financialHistory?.entries ?? []).slice(-24)),
      tiles,
    };
  }

  async #compileNativeRevenueProfiles(world, tileId, networkProfile) {
    const networkHash = world.globalNetwork?.hash ?? null;
    const pending = this.nativeRevenueCompilation;
    // Retain successful evaluations for a retry, but publish only a complete
    // set: mixing old and new profiles can permanently underpay a receipted hour.
    const staged = { ...world, backgroundNativeFinance: deepCopy(
      pending?.worldId === world.worldId && pending.networkHash === networkHash
        ? pending.finance : world.backgroundNativeFinance,
    ) };
    let compilation;
    try {
      compilation = await this.#compileNativeFinanceProfile(staged, tileId, networkProfile);
    } catch (error) {
      compilation = { evaluated: 0, cached: 0, unavailable: [],
        failed: [{ tileId, error: String(error?.message ?? error) }] };
    }
    const ready = compilation.failed.length === 0 && compilation.unavailable.length === 0
      && staged.backgroundNativeFinance.networkHash === networkHash
      && this.tileIds.every(id => staged.backgroundNativeFinance.tileRevenueProfiles[id]);
    const status = ready ? 'ready' : 'pending';
    this.nativeRevenueCompilation = ready ? null : {
      worldId: world.worldId, networkHash, attemptedHour: Math.floor(world.elapsedSeconds / 3600),
      finance: staged.backgroundNativeFinance,
      failed: compilation.failed, unavailable: compilation.unavailable,
    };
    if (ready) world.backgroundNativeFinance = staged.backgroundNativeFinance;
    const result = { ...compilation, status, compiled: ready, networkHash };
    this.telemetry({ phase: 'native-revenue-profile-recovery',
      version: NATIVE_REVENUE_RECOVERY_VERSION, hour: Math.floor(world.elapsedSeconds / 3600),
      ...result });
    return result;
  }

  async #recoverNativeRevenueProfiles(world, targetHour) {
    const pending = this.nativeRevenueCompilation;
    const finance = world.backgroundNativeFinance;
    const rules = this.game.capturePathfindingRules?.();
    const rulesCurrent = rules == null || finance?.routingRulesKey === JSON.stringify(rules);
    if (!pending && rulesCurrent && finance?.networkHash && this.tileIds.every(id => finance.tileRevenueProfiles?.[id])) {
      return { status: 'derived-cache', networkHash: finance.networkHash };
    }
    if (pending?.worldId === world.worldId && pending.attemptedHour >= targetHour) {
      return { status: 'pending', failed: pending.failed, unavailable: pending.unavailable };
    }
    return this.#compileNativeRevenueProfiles(world, world.activeTileId, world.tiles[world.activeTileId]?.networkProfile);
  }

  async recalculateCrossTileModeShare({ reason = 'manual', day = null, force = false, evaluateCrossModeShares = this.evaluateCrossModeShares } = {}) {
    this.#requireBooted();
    return this.#enqueue(async () => {
      const rules = this.game.capturePathfindingRules?.();
      if (rules != null && this.world.backgroundNativeFinance?.routingRulesKey !== JSON.stringify(rules)) force = true;
      const currentContextKey = crossModeShareContextKey(this.world);
      const passiveCacheReady = this.world.crossModeShare?.schemaVersion === CROSS_MODE_SHARE_SCHEMA_VERSION
        && !this.nativeRevenueCompilation
        && this.world.crossModeShare?.contextKey === currentContextKey
        && this.derivedNetworkInvalidations.size === 0
        && this.world.backgroundNativeFinance?.networkHash === (this.world.globalNetwork?.hash ?? null)
        && this.tileIds.every((tileId) => isCurrentOffTileNativeDemandProfile(
          this.world.backgroundNativeFinance?.tileRevenueProfiles?.[tileId],
      ));
      if (!force && PASSIVE_RECALCULATION_REASONS.has(reason) && passiveCacheReady) {
        const result = { ...this.world.crossModeShare, status: 'cached', reason, day };
        this.telemetry({ phase: 'cross-mode-share', ...result });
        return result;
      }
      if (!force && !this.nativeRevenueCompilation && reason === 'daily' && day != null && this.world.crossModeShare?.day === day) {
        return { status: 'already-current', ...this.world.crossModeShare };
      }
      await this.#captureAuthoritativeGlobals(this.world);
      await this.#refreshDerivedNetworkIfDirty(this.world, this.world.activeTileId);
      this.#advanceDraft(this.world, Math.floor(this.world.elapsedSeconds / 3600));
      if (!this.revenueAccrual) {
        await this.#syncCrossTileFinance(this.world);
        await this.#syncBackgroundNativeFinance(this.world, Math.floor(this.world.elapsedSeconds / 3600));
      }
      const tileId = this.world.activeTileId;
      const previousProfile = this.world.tiles[tileId].networkProfile;
      const previousSignature = previousProfile?.signature;
      const profile = await this.#captureNetworkProfile(this.world, tileId);
      const previousStructuralSignature = previousProfile?.structuralSignature ?? previousSignature;
      const nextStructuralSignature = profile?.structuralSignature ?? profile?.signature;
      if (!force && !this.nativeRevenueCompilation && reason === 'network-change' && previousStructuralSignature
        && previousStructuralSignature === nextStructuralSignature) {
        const result = { status: 'network-unchanged', tileId, networkChanged: false, reason, day };
        this.telemetry({ phase: 'cross-mode-share', ...result });
        return result;
      }
      if (profile) this.world.tiles[tileId].networkProfile = profile;
      if (reason === 'midnight-change') {
        const commuteRefresh = await this.game.refreshNativeCommutes?.();
        if (commuteRefresh) this.telemetry({ phase: 'commute-refresh', reason: 'native-finance-profile', tileId, ...commuteRefresh });
      }
      const nativeFinanceProfile = this.revenueAccrual
        ? await this.#compileNativeRevenueProfiles(this.world, tileId, profile)
        : await this.#compileAndCommitFinanceHandoff(
          this.world,
          tileId,
          profile,
          reason,
        );
      // Compilation can restore only one side of finance (most commonly the
      // global expense profile while a remote demand package is unavailable).
      // Drain whichever stream is now current immediately so a tile switch
      // does not wait for another hour boundary or display active-tile-only
      // costs in the meantime.
      let backgroundFinance;
      if (this.revenueAccrual) {
        const finance = this.#ensureBackgroundFinanceClock(
          this.world,
          Math.floor(this.world.elapsedSeconds / 3600),
        );
        if (finance.networkHash && Object.keys(finance.tileRevenueProfiles ?? {}).length) {
          this.revenueAccrual.replaceProfiles({
            networkHash: finance.networkHash,
            profiles: finance.tileRevenueProfiles,
          });
        } else this.revenueAccrual.invalidate();
        backgroundFinance = {
          persisted: false,
          status: nativeFinanceProfile.status === 'pending' ? 'profiles-pending' : 'profiles-replaced',
          revenue: 0,
          expenses: 0,
          profileCount: Object.keys(finance.tileRevenueProfiles ?? {}).length,
        };
      } else {
        backgroundFinance = await this.#syncBackgroundNativeFinance(
          this.world,
          Math.floor(this.world.elapsedSeconds / 3600),
        );
      }
      if (backgroundFinance.persisted) {
        if (typeof this.worldState.saveSettlement === 'function') {
          await this.worldState.saveSettlement(this.world);
        } else await this.worldState.save(this.world);
      }
      const crossDemand = await this.tilePackages.loadCrossDemand?.(tileId);
      if (!crossDemand) {
        return { status: 'no-cross-demand', reason, day, nativeFinanceProfile, backgroundFinance };
      }
      const networkProfiles = Object.fromEntries(Object.entries(this.world.tiles).map(([id, tile]) => [id, tile.networkProfile]).filter(([, value]) => value));
      const calculated = await evaluateCrossModeShares({
        worldId: this.world.worldId,
        crossDemand,
        networkProfiles,
        gatewayCatalog: this.world.gatewayCatalog,
        tileCatalog: this.tileCatalog,
        fare: this.world.farePolicy?.fare ?? 0,
        journeyFare: (stationRoutes, stationById) => this.#quoteJourneyFare(stationRoutes, stationById),
        requestedDepartureSeconds: this.world.elapsedSeconds,
      });
      const metadata = applyModeShares(this.world, calculated.totals, {
        reason,
        day,
        evaluatedPops: calculated.evaluatedPops,
        transitViablePops: calculated.transitViablePops,
        popModeChoices: calculated.popModeChoices,
        transitJourneys: calculated.transitJourneys,
        contextKey: crossModeShareContextKey(this.world),
      });
      // Mode share is deterministic from packaged demand plus the saved
      // network profile. Keep the result live for settlement, but do not
      // synchronously rewrite the multi-megabyte world during startup or a
      // network refresh. Save checkpoints and tile-transition commits persist
      // it naturally; after an abnormal exit startup recalculates it anyway.
      const result = {
        status: 'recalculated', tileId,
        networkChanged: previousSignature !== profile?.signature,
        nativeFinanceProfile,
        backgroundFinance,
        ...metadata,
      };
      this.telemetry({ phase: 'cross-mode-share', ...result });
      this.#notify({ type: 'cross-mode-share', ...result });
      return result;
    });
  }
  async settleCrossTileCommutes(reason = 'hourly') {
    this.#requireBooted();
    return this.#enqueue(async () => {
      const previousRevenue = this.world.crossTileFinancials?.fareRevenue ?? 0;
      const nativeAuditChanged = await this.#captureAuthoritativeGlobals(this.world);
      const targetHour = Math.floor(this.world.elapsedSeconds / 3600);
      const nativeFinanceProfile = this.revenueAccrual
        ? await this.#recoverNativeRevenueProfiles(this.world, targetHour)
        : await this.#recoverStaleNativeFinanceProfile(
          this.world,
          targetHour,
          reason,
        );
      const advancement = this.#advanceDraft(this.world, targetHour);
      const crossFinancialsPosted = await this.#syncCrossTileFinance(this.world);
      const background = this.revenueAccrual
        ? await this.#postNativeRevenueHour(this.world, targetHour)
        : await this.#syncBackgroundNativeFinance(this.world, targetHour);
      const profileStatusChanged = ['recovered', 'partial', 'failed'].includes(nativeFinanceProfile.status);
      // NativeRevenueAccrual persists its deterministic receipt inside the
      // native financial history. It is intentionally not a sidecar write.
      const financialsPosted = crossFinancialsPosted
        || (!this.revenueAccrual && background.persisted)
        || nativeAuditChanged
        || profileStatusChanged;
      if (financialsPosted) {
        assertWorld(this.world, this.tileIds);
        if (typeof this.worldState.saveSettlement === 'function') await this.worldState.saveSettlement(this.world);
        else await this.worldState.save(this.world);
      }
      const fareRevenue = (this.world.crossTileFinancials?.fareRevenue ?? 0) - previousRevenue;
      const result = {
        status: 'settled', reason, worldTime: this.world.worldTime, fareRevenue, wallet: this.world.wallet,
        activeHours: advancement.activeHours,
        transitTrips: advancement.transitTrips,
        backgroundRevenue: background.revenue,
        backgroundExpenses: background.expenses,
        nativeFinanceProfile,
        persisted: financialsPosted,
        persistence: financialsPosted
          ? (typeof this.worldState.saveSettlement === 'function' ? 'settlement-journal' : 'full-world')
          : 'none',
      };
      this.telemetry({ phase: 'cross-commute-settlement', ...result });
      return result;
    });
  }
  async checkpoint(reason = 'manual', {
    saveName = null,
    nativeSessionId = null,
    nativeTileId = null,
    captureNativeSnapshot = true,
  } = {}) {
    this.#requireBooted();
    const requestedAt = this.now();
    return this.#enqueue(async () => {
      const operationStartedAt = this.now();
      const stages = {
        queueWait: Math.max(0, operationStartedAt - requestedAt),
        pause: 0,
        authoritativeGlobals: 0,
        simulationAdvance: 0,
        crossTileFinance: 0,
        backgroundNativeFinance: 0,
        snapshotCapture: 0,
        snapshotValidation: 0,
        networkCapture: 0,
        projectionAdoption: 0,
        liveWorldSave: 0,
        checkpointIndexRead: 0,
        revisionPayloadWrite: 0,
        checkpointIndexWrite: 0,
        livePointerWrite: 0,
        checkpointCleanup: 0,
        pauseRestore: 0,
      };
      const timeStage = async (name, action) => {
        const startedAt = this.now();
        try { return await action(); }
        finally { stages[name] = Math.max(0, this.now() - startedAt); }
      };
      let wasPaused = null;
      let result = null;
      let status = 'failed';
      let failure = null;
      let projectionStatus = this.networkProjection ? 'reconciled' : 'disabled';
      try {
        wasPaused = await timeStage('pause', () => this.#pausePreservingUserState());
        await timeStage('authoritativeGlobals', () => this.#captureAuthoritativeGlobals(this.world));
        await timeStage('simulationAdvance', () => this.#advanceDraft(this.world, Math.floor(this.world.elapsedSeconds / 3600)));
        await timeStage('crossTileFinance', () => this.#syncCrossTileFinance(this.world));
        await timeStage('backgroundNativeFinance', () => this.#syncBackgroundNativeFinance(this.world, Math.floor(this.world.elapsedSeconds / 3600)));
        const current = this.world.tiles[this.world.activeTileId];
        if (captureNativeSnapshot) {
          const snapshot = await timeStage('snapshotCapture', () => this.game.captureSnapshot(current.snapshot));
          await timeStage('snapshotValidation', () => this.game.validateSnapshot(snapshot));
          await timeStage('projectionAdoption', async () => {
            if (this.networkProjection) {
              const adoption = await this.#adoptProjectionSnapshot(
                this.world,
                this.world.activeTileId,
                snapshot,
                { restore: false, fastPath: true },
              );
              projectionStatus = adoption.fastPath ? 'structurally-current' : 'reconciled';
            } else this.world.tiles[this.world.activeTileId].snapshot = snapshot;
          });
        } else {
          const nativeNetwork = await timeStage(
            'networkCapture',
            () => this.game.captureNativeNetworkState?.(),
          );
          if (nativeNetwork) {
            const networkSnapshot = createNativeNetworkSnapshot(current.snapshot, {
              nativeState: nativeNetwork,
            });
          const adoption = await timeStage('projectionAdoption', () => (
            this.#adoptProjectionSnapshot(
              this.world,
              this.world.activeTileId,
              networkSnapshot,
              {
                restore: false,
                fastPath: true,
              },
            )
          ));
            projectionStatus = adoption.fastPath
              ? 'native-network-captured'
              : 'native-network-reconciled';
          } else {
            projectionStatus = 'deferred-native-save';
          }
        }
        this.derivedNetworkInvalidations.clear();
        this.world.tiles[this.world.activeTileId].revision++; this.world.revision++;
        if (saveName != null && typeof this.worldState.saveCheckpoint === 'function') {
          const checkpointStartedAt = this.now();
          const checkpoint = await this.worldState.saveCheckpoint(this.world, saveName, {
            nativeSessionId,
            nativeTileId,
          });
          const checkpointElapsed = Math.max(0, this.now() - checkpointStartedAt);
          const checkpointStages = checkpoint?.performance?.stages;
          if (checkpointStages) {
            for (const name of [
              'checkpointIndexRead',
              'revisionPayloadWrite',
              'checkpointIndexWrite',
              'livePointerWrite',
              'checkpointCleanup',
            ]) {
              stages[name] = Math.max(0, Number(checkpointStages[name]) || 0);
            }
          } else {
            stages.revisionPayloadWrite = checkpointElapsed;
          }
        } else await timeStage('liveWorldSave', () => this.worldState.save(this.world));
        status = 'saved';
        result = {
          reason,
          tileId: this.world.activeTileId,
          revision: this.world.revision,
          projectionStatus,
        };
        return result;
      } catch (error) {
        failure = String(error?.message ?? error);
        throw error;
      } finally {
        if (wasPaused != null) {
          await timeStage('pauseRestore', () => this.#restoreUserPauseState(wasPaused));
        }
        const performance = {
          milliseconds: Math.max(0, this.now() - requestedAt),
          stages,
        };
        if (result) result.performance = performance;
        this.telemetry({
          phase: reason === 'game-save' ? 'autosave-performance' : 'checkpoint-performance',
          status,
          reason,
          saveName,
          tileId: this.world.activeTileId,
          revision: this.world.revision,
          error: failure,
          projectionStatus,
          ...performance,
        });
      }
    });
  }
  async reconcileActiveProjection(reason = 'network-change') {
    this.#requireBooted();
    if (!this.networkProjection) return { status: 'projection-disabled', reason };
    return this.#enqueue(async () => {
      const tileId = this.world.activeTileId;
      const snapshot = await this.#captureLiveNetworkSnapshot(this.world, tileId);
      const result = await this.#adoptProjectionSnapshot(this.world, tileId, snapshot, {
        restore: false,
      });
      this.derivedNetworkInvalidations.clear();
      if (result.changed) {
        this.world.revision++;
        this.world.tiles[tileId].revision++;
      }
      await this.worldState.save(this.world);
      const status = result.accepted ? (result.changed ? 'accepted' : 'unchanged') : 'rejected';
      if (result.accepted && result.changed) {
        const commuteRefresh = await this.game.refreshNativeCommutes?.();
        if (commuteRefresh) {
          this.telemetry({ phase: 'commute-refresh', reason, tileId, ...commuteRefresh });
        }
      }
      this.telemetry({
        phase: 'network-projection-reconcile',
        status,
        reason,
        tileId,
        captureMode: 'live-native-network-v1',
        warning: result.warning ?? null,
      });
      this.#notify({ type: 'projection-changed', status, reason, warning: result.warning ?? null });
      return { status, reason, tileId, warning: result.warning ?? null };
    });
  }
  async reconcileActiveScheduleChanges(changes) {
    this.#requireBooted();
    if (!this.networkProjection) return { status: 'projection-disabled', reason: 'schedule-change' };
    return this.#enqueue(async () => {
      const tileId = this.world.activeTileId;
      const result = this.networkProjection.applyRouteScheduleChanges(this.world.globalNetwork, changes);
      this.world.projectionWarning = result.warning ?? null;
      if (!result.accepted) {
        this.telemetry({ phase: 'network-projection-schedule', status: 'rejected', tileId, warning: result.warning });
        this.#notify({ type: 'projection-changed', status: 'rejected', reason: 'schedule-change', warning: result.warning });
        return { status: 'rejected', reason: 'schedule-change', tileId, warning: result.warning };
      }
      if (result.changed) this.world.globalNetwork = result.network;
      // The native scheduler has already committed this state. Reconcile the
      // direct network slices without generating a save or stopping the clock.
      const snapshot = await this.#captureLiveNetworkSnapshot(this.world, tileId);
      await this.#adoptProjectionSnapshot(this.world, tileId, snapshot, {
        restore: false,
      });
      this.derivedNetworkInvalidations.clear();
      if (result.changed) {
        this.world.revision++;
        this.world.tiles[tileId].revision++;
      }
      await this.worldState.save(this.world);
      const status = result.changed ? 'accepted' : 'unchanged';
      this.telemetry({
        phase: 'network-projection-schedule',
        status,
        tileId,
        routeIds: changes.map(({ routeId }) => routeId),
        captureMode: 'live-native-network-v1',
      });
      this.#notify({ type: 'projection-changed', status, reason: 'schedule-change', warning: null });
      return { status, reason: 'schedule-change', tileId, warning: null };
    });
  }
  async advanceTo(worldTime) {
    this.#requireBooted();
    if (worldTime < this.world.worldTime) throw new Error('World time cannot move backwards');
    return this.#enqueue(async () => {
      // Preserve any native fares/costs earned since the last sidecar write
      // before moving the native clock to the requested settlement hour.
      await this.#captureAuthoritativeGlobals(this.world);
      this.#advanceDraft(this.world, worldTime);
      this.world.elapsedSeconds = worldTime * 3600;
      await this.game.setAuthoritativeGlobals(this.world);
      await this.#syncCrossTileFinance(this.world);
      await this.#syncBackgroundNativeFinance(this.world, worldTime);
      assertWorld(this.world, this.tileIds);
      await this.game.setAuthoritativeGlobals(this.world);
      await this.worldState.save(this.world);
      return this.view();
    });
  }
  async stageNavigationTransition(tileId, { stageNativeRecovery = null } = {}) {
    this.#requireBooted();
    if (!this.tileIds.includes(tileId)) throw new Error(`Unknown tile: ${tileId}`);
    if (tileId === this.world.activeTileId) return { status: 'already-active', worldId: this.world.worldId, tileId };
    return this.#enqueue(async () => {
      const sourceId = this.world.activeTileId;
      const transitionId = `${this.world.worldId}:${this.world.revision}:${sourceId}->${tileId}`;
      await this.tilePackages.prepare(tileId); // fail before pausing or persisting
      const draft = deepCopy(this.world);
      await this.#registerCommuteCatalog(draft, tileId);
      let lease = false;
      let recoveryStage = null;
      const wasPaused = await this.#pausePreservingUserState();
      try {
        lease = await this.worldState.acquireLease(draft.worldId, transitionId);
        if (!lease) throw new Error('Another transition currently holds the world lease');
        await this.#captureAuthoritativeGlobals(draft);
        const sourceSnapshot = await this.game.captureSnapshot(draft.tiles[sourceId].snapshot);
        await this.game.validateSnapshot(sourceSnapshot);
        if (this.networkProjection) {
          await this.#adoptProjectionSnapshot(draft, sourceId, sourceSnapshot, { restore: false });
        }
        else draft.tiles[sourceId].snapshot = sourceSnapshot;
        const sourceProfile = await this.#captureNetworkProfile(draft, sourceId);
        if (sourceProfile) draft.tiles[sourceId].networkProfile = sourceProfile;
        this.#applyActivity(draft, await this.game.reconcileActiveResults());
        this.#advanceDraft(draft, Math.floor(draft.elapsedSeconds / 3600));
        await this.#syncCrossTileFinance(draft);
        await this.#syncBackgroundNativeFinance(draft, Math.floor(draft.elapsedSeconds / 3600));
        draft.activeTileId = tileId;
        draft.revision++;
        draft.tiles[sourceId].revision++;
        draft.tiles[tileId].revision++;
        draft.pendingTransition = {
          transitionId,
          from: sourceId,
          to: tileId,
          mode: 'route-navigation',
          // This handoff exists only in the live renderer. The storage adapter
          // strips it so the native save remains the only durable topology.
          nativeSnapshot: deepCopy(sourceSnapshot),
        };
        assertWorld(draft, this.tileIds);
        if (stageNativeRecovery != null) {
          if (typeof stageNativeRecovery !== 'function') {
            throw new TypeError('stageNativeRecovery must be a function');
          }
          recoveryStage = await stageNativeRecovery(sourceSnapshot, {
            transitionId,
            worldId: draft.worldId,
            from: sourceId,
            to: tileId,
          });
        }
        await this.worldState.commit(draft, transitionId);
        this.world = draft;
        this.derivedNetworkInvalidations.clear();
        return { status: 'reload-required', transitionId, worldId: draft.worldId, tileId, from: sourceId };
      } catch (error) {
        try { await recoveryStage?.rollback?.(); } catch (rollbackError) {
          error.recoveryRollbackError = rollbackError;
        }
        throw error;
      } finally {
        await this.#restoreUserPauseState(wasPaused);
        if (lease) await this.worldState.releaseLease(draft.worldId, transitionId);
      }
    });
  }
  async completeStagedTransition(loadedTileId, {
    loadTraceId = null,
    navigationTransition = null,
  } = {}) {
    this.#requireBooted();
    return this.#enqueue(async () => {
      const startedAt = this.now();
      const traceId = loadTraceId
        ?? `transition:${this.world.worldId}:${loadedTileId}:${startedAt}`;
      const trace = (segment, details = {}) => this.telemetry({
        phase: 'authoritative-load',
        loadTraceId: traceId,
        segment,
        worldId: this.world.worldId,
        loadedTileId,
        elapsedMilliseconds: Math.max(0, this.now() - startedAt),
        ...details,
      });
      trace('transition-completion-start', { world: summarizeWorldForLoad(this.world) });
      let pending = this.world.pendingTransition;
      let repairedFromNavigation = false;
      const tokenTargetsLoadedTile = typeof navigationTransition?.worldId === 'string'
        && navigationTransition.worldId
        && navigationTransition.worldId !== this.world.worldId
        && navigationTransition.tileId === loadedTileId
        && this.tileIds.includes(loadedTileId)
        && this.tileIds.includes(navigationTransition.from);
      if (tokenTargetsLoadedTile) {
        // The callback can belong to an older runtime generation whose World
        // was replaced while the browser navigation remained in flight. The
        // token is not sufficient by itself: recover only a durable World that
        // independently confirms either the staged destination or its exact
        // source tile. Fabricated and stale cross-World tokens still fail shut.
        const tokenWorld = await this.worldState.load(navigationTransition.worldId, {
          loadTraceId: traceId,
        });
        if (tokenWorld) migrateWorldTileSet(tokenWorld, this.tileIds);
        const tokenPending = tokenWorld?.pendingTransition;
        const tokenPendingMatches = tokenWorld?.activeTileId === loadedTileId
          && tokenPending?.to === loadedTileId
          && tokenPending.from === navigationTransition.from;
        const tokenSourceMatches = tokenPending == null
          && tokenWorld?.activeTileId === navigationTransition.from;
        const tokenDestinationMatches = tokenPending == null
          && tokenWorld?.activeTileId === loadedTileId;
        if (tokenWorld?.worldId === navigationTransition.worldId
          && (tokenPendingMatches || tokenSourceMatches || tokenDestinationMatches)) {
          const staleWorldId = this.world.worldId;
          this.world = tokenWorld;
          pending = tokenPending;
          assertWorld(this.world, this.tileIds);
          this.telemetry({
            phase: 'navigation-token-world-rehydrated',
            staleWorldId,
            recoveredWorldId: this.world.worldId,
            loadedTileId,
            sourceTileId: navigationTransition.from,
            transitionId: navigationTransition.transitionId ?? tokenPending?.transitionId ?? null,
          });
          trace('navigation-token-world-rehydrated', { world: summarizeWorldForLoad(this.world) });
        }
      }
      if (this.world.activeTileId !== loadedTileId || (pending && pending.to !== loadedTileId)) {
        // onCityLoad may be delivered to a runtime whose in-memory world was
        // captured before another lifecycle path staged and persisted the
        // navigation. Rehydrate only when storage explicitly identifies the
        // loaded tile as authoritative; unrelated city loads still fail closed.
        const persisted = await this.worldState.load(this.world.worldId, { loadTraceId: traceId });
        if (persisted) migrateWorldTileSet(persisted, this.tileIds);
        const persistedPending = persisted?.pendingTransition;
        const persistedTargetsLoadedTile = persisted?.activeTileId === loadedTileId
          && (!persistedPending || persistedPending.to === loadedTileId);
        if (persistedTargetsLoadedTile) {
          const staleActiveTileId = this.world.activeTileId;
          this.world = persisted;
          pending = persistedPending;
          assertWorld(this.world, this.tileIds);
          this.telemetry({
            phase: 'staged-transition-rehydrated',
            staleActiveTileId,
            loadedTileId,
            transitionId: pending?.transitionId ?? this.world.committedTransitionId ?? null,
          });
          trace('transition-world-rehydrated', { world: summarizeWorldForLoad(this.world) });
        }
      }
      const navigationMatches = !pending
        && navigationTransition?.worldId === this.world.worldId
        && navigationTransition?.tileId === loadedTileId
        && this.tileIds.includes(loadedTileId)
        && (navigationTransition?.from == null
          || navigationTransition.from === this.world.activeTileId);
      if (this.world.activeTileId !== loadedTileId && navigationMatches) {
        // The browser navigation token is written only after an explicit user
        // tile selection. If a stale lifecycle/cache write lost the matching
        // World Record marker, reconstruct that marker before loading cached
        // topology. Tokens for another World or source tile still fail closed.
        const sourceTileId = this.world.activeTileId;
        const transitionId = typeof navigationTransition.transitionId === 'string'
          && navigationTransition.transitionId
          ? navigationTransition.transitionId
          : `${this.world.worldId}:${this.world.revision}:navigation-repair:${sourceTileId}->${loadedTileId}`;
        const repaired = deepCopy(this.world);
        repaired.activeTileId = loadedTileId;
        repaired.revision++;
        repaired.tiles[sourceTileId].revision++;
        repaired.tiles[loadedTileId].revision++;
        repaired.pendingTransition = {
          transitionId,
          from: sourceTileId,
          to: loadedTileId,
          mode: 'route-navigation-repair',
        };
        assertWorld(repaired, this.tileIds);
        await this.worldState.save(repaired);
        this.world = repaired;
        pending = repaired.pendingTransition;
        repairedFromNavigation = true;
        this.telemetry({
          phase: 'staged-transition-repaired',
          sourceTileId,
          loadedTileId,
          transitionId,
          evidence: 'matching-user-navigation-token',
        });
        trace('transition-world-repaired', { world: summarizeWorldForLoad(this.world) });
      }
      if (this.world.activeTileId !== loadedTileId || (pending && pending.to !== loadedTileId)) {
        throw new Error(
          `No staged transition targets loaded tile: ${loadedTileId} `
          + `(active=${this.world.activeTileId}, pending=${pending?.to ?? 'none'})`,
        );
      }
      // Browser navigation and persisted transition markers have independent
      // lifetimes. onCityLoad can therefore arrive after boot/checkpoint code
      // consumed the marker. Rebuilding the active projection is both
      // idempotent and necessary because the native city loader may have reset
      // its transit slices in the meantime.
      const completionStatus = repairedFromNavigation
        ? 'repaired-navigation'
        : pending
          ? 'committed'
        : (this.world.committedTransitionId ? 'already-committed' : 'repaired-active');
      const pkg = await this.tilePackages.prepare(loadedTileId);
      await this.#registerCommuteCatalog(this.world, loadedTileId);
      trace('transition-package-prepared', { packageTileId: pkg?.manifest?.tileId ?? null });
      await this.game.adoptStaticPackage(pkg, loadedTileId);
      trace('transition-package-adopted');
      const wasPaused = await this.#pausePreservingUserState();
      trace('pause-acquired', { userWasPaused: wasPaused });
      try {
        const destination = this.world.tiles[loadedTileId];
        await this.#restoreDestinationNetwork(this.world, loadedTileId, pending?.from ?? null, trace);
        if (!this.revenueAccrual) {
          await this.game.setAuthoritativeGlobals(this.world);
          trace('authoritative-globals-applied');
        } else {
          await this.game.setAuthoritativeGameMode?.(this.world.gameMode);
          await this.game.setAuthoritativeClock?.(this.world.elapsedSeconds);
          trace('authoritative-globals-retained-native');
        }
        const destinationProfile = await this.#captureNetworkProfile(this.world, loadedTileId);
        if (destinationProfile) destination.networkProfile = destinationProfile;
        const commuteRefresh = await this.game.refreshNativeCommutes?.();
        if (commuteRefresh) this.telemetry({ phase: 'commute-refresh', ...commuteRefresh });
        this.telemetry({
          phase: 'native-finance-profile',
          reason: 'tile-transition',
          tileId: loadedTileId,
          compiled: false,
          status: 'deferred-until-route-change',
        });
        await this.game.verifyLoaded();
        trace('native-verified', {
          observedNativeNetwork: await this.game.inspectNativeNetworkForDiagnostics?.() ?? null,
        });
        if (pending) this.world.committedTransitionId = pending.transitionId;
        this.world.pendingTransition = null;
        await this.worldState.save(this.world);
        trace('storage-saved', { world: summarizeWorldForLoad(this.world) });
      } finally {
        await this.#restoreUserPauseState(wasPaused);
        trace('pause-restored', { userWasPaused: wasPaused });
      }
      this.#notify({ type: 'projection-changed', status: 'tile-transition', tileId: loadedTileId });
      trace('transition-completion-finished', { world: summarizeWorldForLoad(this.world) });
      return {
        status: completionStatus,
        transitionId: pending?.transitionId ?? this.world.committedTransitionId ?? null,
        worldId: this.world.worldId,
        tileId: loadedTileId,
      };
    });
  }
  async transitionTo(tileId) {
    this.#requireBooted();
    if (!this.tileIds.includes(tileId)) throw new Error(`Unknown tile: ${tileId}`);
    if (tileId === this.world.activeTileId) return { status: 'already-active', tileId, transitionId: this.world.committedTransitionId };
    if (this.inFlight.has(tileId)) return this.inFlight.get(tileId);
    const transitionId = `${this.world.worldId}:${this.world.revision}:${this.world.activeTileId}->${tileId}`;
    const job = this.#enqueue(() => this.#transition(tileId, transitionId));
    this.inFlight.set(tileId, job); try { return await job; } finally { this.inFlight.delete(tileId); }
  }
  #enqueue(work) { const next = this.serial.then(work, work); this.serial = next.catch(() => {}); return next; }
  #requireBooted() { if (!this.world) throw new Error('WorldTileRuntime.boot must complete first'); }
  #emit(id, phase, start) { this.telemetry({ transitionId: id, phase, elapsedMs: this.now() - start }); }
  #advanceDraft(world, target) {
    if (!Number.isSafeInteger(target) || target < world.worldTime) throw new Error('World time cannot move backwards');
    world.worldTime = target;
    for (const tile of Object.values(world.tiles)) {
      const elapsedHours = Math.max(0, target - tile.lastSimulatedTime);
      tile.aggregate.operatingCost += elapsedHours;
      tile.lastSimulatedTime = target;
    }
    const advancement = advanceCommutesTo(world, target);
    if (advancement.activeHours > 0) {
      const projections = projectCommutesByTile(world, Object.keys(world.tiles));
      for (const [tileId, tile] of Object.entries(world.tiles)) tile.aggregate.backlog = projections[tileId].waitingToLeave;
    }
    return advancement;
  }
  #applyActivity(world, activity) {
    for (const departure of activity.departures ?? []) recordObservedDeparture(world, { ...departure, time: world.worldTime });
    const delta = activity.walletDelta ?? 0;
    if (!Number.isFinite(delta)) throw new Error('Invalid game wallet delta');
    world.wallet += delta;
  }
  #recoverLegacySettlementBaseline(world, authoritativeHour) {
    if (world.settlementAccountingSchemaVersion === 2) return false;
    const discardedPendingRevenue = world.crossTileFinancials?.pendingNativeRevenue ?? 0;
    const discardedPendingCommutes = world.pendingCrossTileAttribution?.completedCommutes?.length ?? 0;
    rebaseCommutesTo(world, authoritativeHour);
    world.worldTime = authoritativeHour;
    for (const [tileId, tile] of Object.entries(world.tiles ?? {})) {
      tile.lastSimulatedTime = authoritativeHour;
      tile.aggregate = { ridership: 0, revenue: 0, operatingCost: 0, backlog: 0 };
      tile.aggregate.backlog = projectCommutesForTile(world, tileId).waitingToLeave;
    }
    world.settlementAccountingSchemaVersion = 2;
    world.revision++;
    this.telemetry({
      phase: 'settlement-accounting-recovery',
      authoritativeHour,
      discardedPendingRevenue,
      discardedPendingCommutes,
    });
    return true;
  }
  #quoteJourneyFare(stationRoutes, stationById) {
    const segments = fareSegmentsFromStationRoutes(stationRoutes, stationById);
    const globalState = this.world.globalNetwork?.nativeState;
    const fareGroups = globalState?.fareGroups?.length
      ? globalState.fareGroups
      : this.world.farePolicy?.fareGroups ?? [];
    const routes = globalState?.routes ?? [];
    const currentRouteIds = new Set((this.world.farePolicy?.fareGroups ?? [])
      .flatMap((group) => group.routeIds ?? []));
    const canUseNative = typeof this.game.getJourneyFare === 'function'
      && segments.length > 0
      && segments.every((segment) => currentRouteIds.has(segment.routeId));
    return quoteJourneyFare({
      segments,
      fareGroups,
      routes,
      legacyFare: this.world.farePolicy?.fare ?? 0,
      nativeFare: canUseNative ? (nativeSegments) => this.game.getJourneyFare(nativeSegments) : null,
    });
  }
  async #syncCrossTileFinance(world) {
    const amount = world.crossTileFinancials?.pendingNativeRevenue ?? 0;
    const attribution = deepCopy(world.pendingCrossTileAttribution ?? { revenueByRoute: {}, completedCommutes: [] });
    const hasAttribution = Object.keys(attribution.revenueByRoute ?? {}).length > 0
      || (attribution.completedCommutes?.length ?? 0) > 0;
    if (!(amount > 0) && !hasAttribution) return false;
    if (typeof this.game.creditCrossTileFareRevenue !== 'function') throw new Error('Native cross-tile revenue action is unavailable');
    const applied = await this.game.creditCrossTileFareRevenue(amount, attribution);
    if (!Number.isFinite(applied?.wallet)) throw new Error('Native cross-tile revenue action returned an invalid wallet');
    // Native money is authoritative. In-tile fares and expenses can change it
    // between capture and posting, so a sidecar-derived equality check is both
    // racy and, near Number.MAX_SAFE_INTEGER, numerically meaningless.
    world.wallet = applied.wallet;
    if (applied.financialHistory) world.financialHistory = deepCopy(applied.financialHistory);
    world.crossTileFinancials.pendingNativeRevenue = 0;
    world.pendingCrossTileAttribution = { revenueByRoute: {}, completedCommutes: [] };
    world.settlementFinanceQuarantine = null;
    return true;
  }
  #migrateBackgroundFinanceOwnership(world) {
    const finance = world.backgroundNativeFinance;
    if (!finance || finance.ownershipProjection || !finance.networkHash || !world.activeProjection) return false;
    const ownershipProjection = deepCopy(world.activeProjection);
    ownershipProjection.networkHash = finance.networkHash;
    const expenseOwnedRouteIds = finance.expenseProfile?.financeOwnedRouteIds;
    if (Array.isArray(expenseOwnedRouteIds)) {
      ownershipProjection.financeOwnedRouteIds = [...new Set(expenseOwnedRouteIds.map(String))].sort();
    }
    const expenseOwnedTrackIds = (finance.expenseProfile?.infrastructureItems ?? [])
      .filter((item) => item?.financeOwned)
      .flatMap((item) => item?.trackIds ?? [])
      .map(String);
    if (expenseOwnedTrackIds.length) {
      ownershipProjection.financeOwnedTrackIds = [...new Set(expenseOwnedTrackIds)].sort();
    }
    finance.ownershipProjection = ownershipProjection;
    return true;
  }
  #committedFinanceOwnership(world) {
    return world.backgroundNativeFinance?.ownershipProjection ?? world.activeProjection ?? null;
  }
  #configureCommittedFinanceOwnership(world) {
    const ownership = this.#committedFinanceOwnership(world);
    if (ownership) this.game.configureGlobalFinanceOwnership?.(ownership);
    return ownership;
  }
  #financeProfileReadiness(finance, networkHash) {
    const revenueCurrent = Object.keys(finance?.tileRevenueProfiles ?? {}).length > 0
      && finance?.networkHash === networkHash;
    const expenseCurrent = !this.backgroundNativeExpenses || (Boolean(finance?.expenseProfile)
      && (finance.expenseProfile.networkHash ?? finance.networkHash) === networkHash);
    return { revenueCurrent, expenseCurrent, ready: revenueCurrent && expenseCurrent };
  }
  #markFinanceHandoffPending(world, networkHash, reason, details = {}) {
    const finance = this.#ensureBackgroundFinanceClock(
      world,
      Math.floor(world.elapsedSeconds / 3600),
    );
    finance.pendingHandoff = {
      networkHash,
      previousNetworkHash: finance.ownershipProjection?.networkHash ?? finance.networkHash ?? null,
      reason,
      status: 'pending',
      ...deepCopy(details),
    };
    this.#configureCommittedFinanceOwnership(world);
    this.telemetry({ phase: 'native-finance-handoff', ...finance.pendingHandoff });
    return finance.pendingHandoff;
  }
  #publishFinanceOwnershipIfCurrent(world, projection = world.activeProjection, reason = 'projection-change') {
    if (!projection) return { status: 'unconfigured', reason };
    const finance = this.#ensureBackgroundFinanceClock(
      world,
      Math.floor(world.elapsedSeconds / 3600),
    );
    const networkHash = world.globalNetwork?.hash ?? projection.networkHash ?? null;
    const hasCompiledFinance = Boolean(finance.networkHash || finance.expenseProfile
      || Object.keys(finance.tileRevenueProfiles ?? {}).length);
    if (!hasCompiledFinance) {
      finance.ownershipProjection = deepCopy(projection);
      finance.pendingHandoff = null;
      this.game.configureGlobalFinanceOwnership?.(projection);
      return { status: 'unprofiled', reason, networkHash };
    }
    const readiness = this.#financeProfileReadiness(finance, networkHash);
    if (!readiness.ready) {
      this.#markFinanceHandoffPending(world, networkHash, reason, readiness);
      return { status: 'pending', reason, networkHash, ...readiness };
    }
    finance.ownershipProjection = deepCopy(projection);
    finance.pendingHandoff = null;
    this.game.configureGlobalFinanceOwnership?.(projection);
    this.telemetry({ phase: 'native-finance-handoff', status: 'committed', reason, networkHash, reused: true });
    return { status: 'committed', reason, networkHash, reused: true, ...readiness };
  }
  async #compileAndCommitFinanceHandoff(world, tileId, networkProfile, reason) {
    const networkHash = world.globalNetwork?.hash ?? null;

    // Compile into an isolated copy. No revenue profile, expense profile,
    // cursor, or ownership rule becomes visible until every tile succeeds.
    const staged = deepCopy(world);
    let compilation;
    try {
      compilation = await this.#compileNativeFinanceProfile(staged, tileId, networkProfile);
    } catch (error) {
      const pending = this.#markFinanceHandoffPending(world, networkHash, reason, {
        error: error?.message ?? String(error),
      });
      return { ...deepCopy(pending), compiled: false };
    }
    const stagedFinance = this.#ensureBackgroundFinanceClock(
      staged,
      Math.floor(staged.elapsedSeconds / 3600),
    );
    const readiness = this.#financeProfileReadiness(stagedFinance, networkHash);
    if (!readiness.ready || compilation.failed?.length || compilation.unavailable?.length) {
      const pending = this.#markFinanceHandoffPending(world, networkHash, reason, {
        revenueCurrent: readiness.revenueCurrent,
        expenseCurrent: readiness.expenseCurrent,
        unavailableTiles: [...(compilation.unavailable ?? [])],
        failedTiles: deepCopy(compilation.failed ?? []),
      });
      return { ...compilation, ...deepCopy(pending), compiled: false };
    }

    const handoffHour = Math.floor(staged.elapsedSeconds / 3600);
    const previousNetworkHash = stagedFinance.ownershipProjection?.networkHash
      ?? stagedFinance.networkHash
      ?? null;
    if (previousNetworkHash !== networkHash) {
      // A replacement profile describes the network from this boundary
      // forward. Carrying an unresolved cursor across the boundary would
      // charge a newly built route for hours in which it did not exist. The
      // prior committed profile was given its chance to settle before this
      // compile; any unavailable historic interval remains unavailable rather
      // than being invented with the replacement topology.
      stagedFinance.lastRevenueSettledHour = handoffHour;
      stagedFinance.lastExpenseSettledHour = handoffHour;
      stagedFinance.lastSettledHour = handoffHour;
    }
    stagedFinance.ownershipProjection = deepCopy(world.activeProjection);
    stagedFinance.pendingHandoff = null;
    stagedFinance.profileRecovery = null;
    const previousFinance = world.backgroundNativeFinance;
    world.backgroundNativeFinance = stagedFinance;
    try {
      if (typeof this.worldState.saveSettlement === 'function') {
        await this.worldState.saveSettlement(world);
      } else {
        await this.worldState.save(world);
      }
    } catch (error) {
      world.backgroundNativeFinance = previousFinance;
      const pending = this.#markFinanceHandoffPending(world, networkHash, reason, {
        error: `Could not persist candidate finance: ${error?.message ?? String(error)}`,
      });
      return { ...compilation, ...deepCopy(pending), compiled: false };
    }
    this.game.configureGlobalFinanceOwnership?.(stagedFinance.ownershipProjection);
    const committed = {
      status: 'committed', reason, networkHash, compiled: true,
      ...compilation,
    };
    this.telemetry({ phase: 'native-finance-handoff', ...committed });
    return committed;
  }
  #ensureBackgroundFinanceClock(world, targetHour) {
    world.backgroundNativeFinance ??= {
      schemaVersion: 2,
      lastSettledHour: null,
      tileRevenueProfiles: {},
      expenseProfile: null,
      ownershipProjection: null,
      pendingHandoff: null,
      totalRevenue: 0,
      totalExpenses: 0,
      audit: { schemaVersion: NATIVE_FINANCE_AUDIT_SCHEMA_VERSION, samples: [], rolling24Hours: null, updatedAtHour: null },
    };
    const finance = world.backgroundNativeFinance;
    finance.tileRevenueProfiles ??= {};
    finance.ownershipProjection ??= null;
    finance.pendingHandoff ??= null;
    finance.totalRevenue = Number.isFinite(finance.totalRevenue) ? finance.totalRevenue : 0;
    finance.totalExpenses = Number.isFinite(finance.totalExpenses) ? finance.totalExpenses : 0;
    if (!this.backgroundNativeExpenses) {
      // Canonical-native integrations let the game charge the complete rail
      // network. Retained legacy projections must never become a second
      // expense authority after a mod reload or sidecar migration.
      finance.expenseProfile = null;
      finance.totalExpenses = 0;
      finance.lastExpenseSettledHour = targetHour;
    }
    finance.audit ??= { schemaVersion: NATIVE_FINANCE_AUDIT_SCHEMA_VERSION, samples: [], rolling24Hours: null, updatedAtHour: null };
    if (!Number.isSafeInteger(finance.lastSettledHour) || finance.lastSettledHour > targetHour) {
      // Old sidecars have no inactive-finance cursor. Starting at the live
      // native hour avoids retroactively inventing income or costs.
      finance.lastSettledHour = targetHour;
    }
    if (!Number.isSafeInteger(finance.lastRevenueSettledHour)
      || finance.lastRevenueSettledHour > targetHour) {
      finance.lastRevenueSettledHour = finance.lastSettledHour;
    }
    if (!Number.isSafeInteger(finance.lastExpenseSettledHour)
      || finance.lastExpenseSettledHour > targetHour) {
      finance.lastExpenseSettledHour = finance.lastSettledHour;
    }
    finance.lastSettledHour = Math.min(
      finance.lastRevenueSettledHour,
      finance.lastExpenseSettledHour,
    );
    return finance;
  }
  async #recoverStaleNativeFinanceProfile(world, targetHour, reason, { force = false } = {}) {
    const finance = this.#ensureBackgroundFinanceClock(world, targetHour);
    const networkHash = world.globalNetwork?.hash ?? null;
    if (!finance.expenseProfile && !finance.networkHash) {
      return { status: 'unconfigured', networkHash, revenueCurrent: false, expenseCurrent: false };
    }
    const ownershipNetworkHash = finance.ownershipProjection?.networkHash ?? networkHash;
    const committedReadiness = this.#financeProfileReadiness(finance, ownershipNetworkHash);
    if (!force && finance.ownershipProjection && committedReadiness.ready && ownershipNetworkHash !== networkHash) {
      return {
        status: 'pending-handoff', networkHash, ownershipNetworkHash,
        revenueCurrent: true, expenseCurrent: true,
      };
    }
    const { revenueCurrent, expenseCurrent } = this.#financeProfileReadiness(finance, networkHash);
    if (revenueCurrent && expenseCurrent) {
      return { status: 'current', networkHash, revenueCurrent, expenseCurrent };
    }
    const revenueDue = targetHour > finance.lastRevenueSettledHour;
    const expenseDue = targetHour > finance.lastExpenseSettledHour;
    if (!force && !revenueDue && !expenseDue) {
      return { status: 'not-due', networkHash, revenueCurrent, expenseCurrent };
    }
    // Revenue may legitimately be unavailable for one tile while the global
    // expense profile remains usable. Do not replace a current expense model
    // merely to retry an independent demand cache on every hourly tick.
    if (!force && expenseCurrent) {
      return { status: 'revenue-stale', networkHash, revenueCurrent, expenseCurrent };
    }
    if (!force && finance.profileRecovery?.networkHash === networkHash) {
      return {
        status: 'already-attempted', networkHash, revenueCurrent, expenseCurrent,
        attemptedAtHour: finance.profileRecovery.attemptedAtHour,
      };
    }
    let compilation;
    try {
      compilation = await this.#compileAndCommitFinanceHandoff(
        world,
        world.activeTileId,
        world.tiles?.[world.activeTileId]?.networkProfile,
        reason,
      );
    } catch (error) {
      finance.profileRecovery = {
        networkHash,
        attemptedAtHour: targetHour,
        reason,
        status: 'failed',
        message: error?.message ?? String(error),
      };
      this.telemetry({ phase: 'native-finance-profile-recovery', ...finance.profileRecovery });
      return deepCopy(finance.profileRecovery);
    }
    const recoveredFinance = world.backgroundNativeFinance;
    const recoveredRevenue = Object.keys(recoveredFinance.tileRevenueProfiles ?? {}).length > 0
      && recoveredFinance.networkHash === networkHash;
    const recoveredExpenses = !this.backgroundNativeExpenses || (Boolean(recoveredFinance.expenseProfile)
      && (recoveredFinance.expenseProfile.networkHash ?? recoveredFinance.networkHash) === networkHash);
    recoveredFinance.profileRecovery = {
      networkHash,
      attemptedAtHour: targetHour,
      reason,
      status: recoveredRevenue && recoveredExpenses ? 'recovered' : 'partial',
      revenueCurrent: recoveredRevenue,
      expenseCurrent: recoveredExpenses,
      unavailableTiles: [...(compilation.unavailable ?? [])],
      failedTiles: deepCopy(compilation.failed ?? []),
    };
    this.telemetry({ phase: 'native-finance-profile-recovery', ...recoveredFinance.profileRecovery });
    return deepCopy(recoveredFinance.profileRecovery);
  }
  async #postNativeRevenueHour(world, targetHour) {
    const finance = this.#ensureBackgroundFinanceClock(world, targetHour);
    if (finance.networkHash && Object.keys(finance.tileRevenueProfiles ?? {}).length) {
      this.revenueAccrual.replaceProfiles({
        networkHash: finance.networkHash,
        profiles: finance.tileRevenueProfiles,
        reuseUnchanged: true,
      });
    }
    const posting = await this.revenueAccrual.postHour({
      worldId: world.worldId,
      hour: targetHour,
      activeTileId: world.activeTileId,
      projection: this.#committedFinanceOwnership(world) ?? { activeTileId: world.activeTileId },
    });
    this.lastNativeRevenuePosting = { activeTileId: world.activeTileId, ...posting };
    if (Number.isFinite(posting.wallet)) world.wallet = posting.wallet;
    return {
      persisted: false,
      status: posting.status,
      revenue: posting.postedRevenue,
      calculatedRevenue: posting.calculatedRevenue,
      expenses: 0,
      postingId: posting.postingId,
      wallet: posting.wallet,
    };
  }
  async #syncBackgroundNativeFinance(world, targetHour = Math.floor(world.elapsedSeconds / 3600)) {
    if (!Number.isSafeInteger(targetHour) || targetHour < 0) throw new Error('Invalid background finance hour');
    const finance = this.#ensureBackgroundFinanceClock(world, targetHour);
    const ownershipProjection = this.#committedFinanceOwnership(world);
    const currentNetworkHash = finance.ownershipProjection?.networkHash
      ?? world.globalNetwork?.hash
      ?? null;
    const revenueProfileCurrent = Object.keys(finance.tileRevenueProfiles).length > 0
      && finance.networkHash === currentNetworkHash;
    const expenseProfileCurrent = this.backgroundNativeExpenses && Boolean(finance.expenseProfile)
      && (finance.expenseProfile.networkHash ?? finance.networkHash) === currentNetworkHash;
    const revenueStartHour = finance.lastRevenueSettledHour;
    const expenseStartHour = finance.lastExpenseSettledHour;
    const revenuePending = revenueProfileCurrent && targetHour > revenueStartHour;
    const expensePending = expenseProfileCurrent && targetHour > expenseStartHour;
    const profileStatus = {
      targetHour,
      loadedRevenueProfileCount: Object.keys(finance.tileRevenueProfiles).length,
      loadedRevenueProfileTiles: Object.keys(finance.tileRevenueProfiles).sort(),
      loadedDailyRevenueByTile: Object.fromEntries(
        Object.entries(finance.tileRevenueProfiles)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([tileId, profile]) => [tileId, Number(profile?.dailyRevenue) || 0]),
      ),
      loadedExpenseProfile: Boolean(finance.expenseProfile),
      revenueProfileCurrent,
      expenseProfileCurrent,
      lastRevenueSettledHour: revenueStartHour,
      lastExpenseSettledHour: expenseStartHour,
      networkHash: finance.networkHash ?? null,
      currentNetworkHash,
    };
    if (!revenuePending && !expensePending) {
      return {
        persisted: false,
        revenue: 0,
        expenses: 0,
        hours: 0,
        revenueHours: 0,
        expenseHours: 0,
        ...profileStatus,
      };
    }

    // Revenue harvesting and expense compilation are independent. A missing
    // demand package must not suppress a current global expense profile (and
    // vice versa), so each stream owns its own retry cursor. The active
    // projection remains required because it defines the native/background
    // ownership split for both streams.
    if (!ownershipProjection
      || typeof this.game.postBackgroundNativeFinance !== 'function') {
      return {
        persisted: false,
        revenue: 0,
        expenses: 0,
        hours: 0,
        revenueHours: 0,
        expenseHours: 0,
        ...profileStatus,
      };
    }

    const aggregate = {
      revenue: 0,
      expenses: 0,
      revenueByTile: {},
      revenueByRoute: {},
      expensesByRoute: {},
      expenseCategories: {},
      hourlyPostings: [],
      completedCommutes: [],
    };
    const firstPendingHour = Math.min(
      revenuePending ? revenueStartHour + 1 : Number.POSITIVE_INFINITY,
      expensePending ? expenseStartHour + 1 : Number.POSITIVE_INFINITY,
    );
    for (let hour = firstPendingHour; hour <= targetHour; hour++) {
      const includeRevenue = revenuePending && hour > revenueStartHour;
      const includeExpenses = expensePending && hour > expenseStartHour;
      const posting = backgroundFinanceForHour({
        finance: {
          ...finance,
          tileRevenueProfiles: includeRevenue ? finance.tileRevenueProfiles : {},
          expenseProfile: includeExpenses ? finance.expenseProfile : null,
        },
        activeTileId: ownershipProjection.activeTileId ?? world.activeTileId,
        activeProjection: ownershipProjection,
        hour,
      });
      aggregate.hourlyPostings.push({ hour, ...posting });
      aggregate.completedCommutes.push(...(posting.completedCommutes ?? []));
      aggregate.revenue += posting.revenue;
      aggregate.expenses += posting.expenses;
      for (const field of ['revenueByTile', 'revenueByRoute', 'expensesByRoute', 'expenseCategories']) {
        for (const [id, amount] of Object.entries(posting[field])) {
          aggregate[field][id] = (aggregate[field][id] ?? 0) + amount;
        }
      }
    }
    const hasPosting = aggregate.completedCommutes.length > 0 || aggregate.revenue > 0 || aggregate.expenses > 0
      || Object.keys(aggregate.revenueByRoute).length > 0
      || Object.keys(aggregate.expensesByRoute).length > 0;
    let applied = false;
    if (hasPosting) {
      const result = await this.game.postBackgroundNativeFinance({
        postingId: `${world.worldId}:background-native:`
          + `r${revenuePending ? `${revenueStartHour + 1}-${targetHour}` : 'none'}:`
          + `e${expensePending ? `${expenseStartHour + 1}-${targetHour}` : 'none'}`,
        targetElapsedSeconds: targetHour * 3600,
        ...aggregate,
      });
      if (!Number.isFinite(result?.wallet)) throw new Error('Background native finance action returned an invalid wallet');
      world.wallet = result.wallet;
      if (result.financialHistory) world.financialHistory = deepCopy(result.financialHistory);
      applied = result.applied !== false;
      if (applied) {
        finance.totalRevenue += aggregate.revenue;
        finance.totalExpenses += aggregate.expenses;
        for (const [tileId, amount] of Object.entries(aggregate.revenueByTile)) {
          if (world.tiles[tileId]) world.tiles[tileId].aggregate.revenue += amount;
        }
      }
    }
    // One range receipt and one wallet mutation keep catch-up O(1), while the
    // hourly rows let the adapter reconstruct the financial chart faithfully.
    // A thrown post leaves this cursor untouched and retries the same range ID.
    if (revenuePending) finance.lastRevenueSettledHour = targetHour;
    if (expensePending) finance.lastExpenseSettledHour = targetHour;
    finance.lastSettledHour = Math.min(
      finance.lastRevenueSettledHour,
      finance.lastExpenseSettledHour,
    );
    const revenueHours = revenuePending ? targetHour - revenueStartHour : 0;
    const expenseHours = expensePending ? targetHour - expenseStartHour : 0;
    return {
      persisted: true,
      revenue: applied ? aggregate.revenue : 0,
      expenses: applied ? aggregate.expenses : 0,
      hours: Math.max(revenueHours, expenseHours),
      revenueHours,
      expenseHours,
      appliedHours: applied ? Math.max(revenueHours, expenseHours) : 0,
      ...profileStatus,
    };
  }
  #ingestNativeFinanceAudit(world) {
    const finance = this.#ensureBackgroundFinanceClock(world, Math.floor(world.elapsedSeconds / 3600));
    const audit = finance.audit;
    if (audit.schemaVersion !== NATIVE_FINANCE_AUDIT_SCHEMA_VERSION) {
      finance.audit = { schemaVersion: NATIVE_FINANCE_AUDIT_SCHEMA_VERSION, samples: [], rolling24Hours: null, updatedAtHour: null };
      return this.#ingestNativeFinanceAudit(world);
    }
    const currentHour = Math.floor(world.elapsedSeconds / 3600);
    const observations = this.game.consumeNativeFinanceAudit?.() ?? [];
    const auditSignature = nativeFinanceAuditSignature(world);
    let changed = false;
    const mergeAmounts = (target = {}, source = {}) => {
      for (const [routeId, amount] of Object.entries(source ?? {})) {
        const value = Math.max(0, Number(amount) || 0);
        if (value > 0) target[routeId] = (target[routeId] ?? 0) + value;
      }
      return target;
    };
    const total = (values) => Object.values(values ?? {}).reduce((sum, amount) => sum + (Number(amount) || 0), 0);
    const comparison = (projected, native) => {
      const difference = projected - native;
      return {
        native,
        projected,
        projectedMinusNative: difference,
        percentOfNative: Math.abs(native) > 1e-9 ? projected / native * 100 : (Math.abs(projected) > 1e-9 ? null : 100),
        percentError: Math.abs(native) > 1e-9 ? difference / Math.abs(native) * 100 : (Math.abs(projected) > 1e-9 ? null : 0),
      };
    };

    audit.samples ??= [];
    for (const observation of observations) {
      if (!Number.isSafeInteger(observation?.hour) || observation.hour < 0) continue;
      const ownershipProjection = this.#committedFinanceOwnership(world);
      const prediction = nativeComparableFinanceForHour({
        finance,
        activeTileId: ownershipProjection?.activeTileId ?? world.activeTileId,
        activeProjection: ownershipProjection,
        hour: observation.hour,
      });
      const projectionHash = ownershipProjection?.projectionHash ?? 'none';
      const key = `${world.activeTileId}:${observation.hour}`;
      let sample = audit.samples.find((candidate) => candidate.key === key);
      if (!sample) {
        sample = {
          key,
          tileId: world.activeTileId,
          hour: observation.hour,
          projectionHash,
          networkRevision: ownershipProjection?.networkRevision ?? null,
          auditSignature,
          auditSignatureStable: true,
          observedRevenueByRoute: {},
          observedExpensesByRoute: {},
        };
        audit.samples.push(sample);
      }
      if (sample.auditSignature !== auditSignature) sample.auditSignatureStable = false;
      mergeAmounts(sample.observedRevenueByRoute, observation.revenueByRoute);
      mergeAmounts(sample.observedExpensesByRoute, observation.expensesByRoute);
      sample.projectedRevenueByRoute = prediction.revenueByRoute;
      sample.projectedExpensesByRoute = prediction.expensesByRoute;
      sample.comparableRouteIds = [...new Set([
        ...prediction.routeIds,
        ...Object.keys(sample.observedRevenueByRoute),
        ...Object.keys(sample.observedExpensesByRoute),
      ])].sort();
      sample.complete = observation.hour < currentHour;
      sample.revenue = comparison(total(sample.projectedRevenueByRoute), total(sample.observedRevenueByRoute));
      sample.expenses = comparison(total(sample.projectedExpensesByRoute), total(sample.observedExpensesByRoute));
      sample.routes = Object.fromEntries(sample.comparableRouteIds.map((routeId) => [routeId, {
        revenue: comparison(sample.projectedRevenueByRoute[routeId] ?? 0, sample.observedRevenueByRoute[routeId] ?? 0),
        expenses: comparison(sample.projectedExpensesByRoute[routeId] ?? 0, sample.observedExpensesByRoute[routeId] ?? 0),
      }]));
      changed = true;
    }

    for (const sample of audit.samples) {
      const complete = sample.hour < currentHour;
      if (sample.complete !== complete) {
        sample.complete = complete;
        changed = true;
      }
    }
    audit.samples.sort((left, right) => left.hour - right.hour || left.key.localeCompare(right.key));
    audit.samples = audit.samples.slice(-168);
    audit.rolling24Hours = summarizeNativeFinanceAudit(audit.samples);
    audit.latest = audit.samples.at(-1) ?? null;
    audit.updatedAtHour = currentHour;
    if (changed) this.telemetry({
      phase: 'native-finance-projection-audit',
      latest: deepCopy(audit.latest),
      rolling24Hours: deepCopy(audit.rolling24Hours),
    });
    return changed;
  }
  async #captureAuthoritativeGlobals(world, { allowClockRegression = false } = {}) {
    if (typeof this.game.captureAuthoritativeGlobals !== 'function') return false;
    const globals = await this.game.captureAuthoritativeGlobals();
    if (!Number.isFinite(globals?.wallet)) throw new Error('Invalid captured world balance');
    world.wallet = globals.wallet;
    if (globals.gameMode != null) {
      if (!['easy', 'sandbox'].includes(globals.gameMode)) throw new Error('Invalid captured game mode');
      world.gameMode = globals.gameMode;
    }
    if (!Number.isFinite(globals?.elapsedSeconds) || globals.elapsedSeconds < 0) throw new Error('Invalid captured game time');
    if (!allowClockRegression && globals.elapsedSeconds < world.elapsedSeconds) {
      // Ordinary ticks and native saves are observations of the live session,
      // not authority to rewind the sidecar. Native save-load flows replace or
      // explicitly rebase the world before reaching this seam. Keeping the
      // monotonic clock here prevents autosave races from trapping settlement
      // and leaves inactive-tile revenue profiles/cursors intact.
      this.telemetry({
        phase: 'native-clock-regression-ignored',
        capturedElapsedSeconds: globals.elapsedSeconds,
        retainedElapsedSeconds: world.elapsedSeconds,
        retainedWorldTime: world.worldTime,
      });
    } else world.elapsedSeconds = globals.elapsedSeconds;
    if (Number.isFinite(globals?.farePolicy?.fare)) {
      world.farePolicy = deepCopy(globals.farePolicy);
      this.#mergeCapturedFareGroups(world, globals.farePolicy.fareGroups);
    }
    if (globals?.financialHistory) world.financialHistory = deepCopy(globals.financialHistory);
    // Revenue-only mode treats the native ledger as immutable input here.
    // Legacy rebasing/auditing exists only for the old sidecar-owned model.
    const financeRebase = this.revenueAccrual
      ? null
      : this.game.rebaseNativeFinanceForCanonicalMode?.();
    if (financeRebase?.financialHistory) world.financialHistory = deepCopy(financeRebase.financialHistory);
    if (financeRebase?.changed) {
      this.telemetry({
        phase: 'native-finance-rebased',
        resetCurrentHour: financeRebase.resetCurrentHour === true,
        routeFinancialsChanged: financeRebase.routeFinancialsChanged === true,
        financialHistoryChanged: financeRebase.financialHistoryChanged === true,
        sessionId: financeRebase.sessionId ?? null,
        topologyKey: financeRebase.topologyKey ?? null,
        historyTimestamp: financeRebase.historyTimestamp ?? null,
        routeTimestamp: financeRebase.routeTimestamp ?? null,
        routeCurrentExpenses: financeRebase.routeCurrentExpenses ?? 0,
        historyExpenses: financeRebase.historyExpenses ?? 0,
      });
    }
    return Boolean((!this.revenueAccrual && this.#ingestNativeFinanceAudit(world)) || financeRebase?.changed);
  }
  #mergeCapturedFareGroups(world, capturedGroups) {
    if (!Array.isArray(capturedGroups) || !world.globalNetwork?.nativeState) return;
    const prior = new Map((world.globalNetwork.nativeState.fareGroups ?? []).map((group) => [group.id, group]));
    const capturedIds = new Set(capturedGroups.map((group) => group?.id));
    const currentlyVisibleRouteIds = new Set(capturedGroups.flatMap((group) => group.routeIds ?? []));
    const projectedRouteIds = new Set((world.activeProjection?.baselineState?.routes ?? [])
      .map((route) => String(route?.id)));
    const merged = capturedGroups.map((group) => {
      const remoteRouteIds = (prior.get(group.id)?.routeIds ?? [])
        .filter((routeId) => !currentlyVisibleRouteIds.has(routeId));
      return { ...deepCopy(group), routeIds: [...new Set([...remoteRouteIds, ...(group.routeIds ?? [])])] };
    });
    for (const [groupId, group] of prior) {
      if (capturedIds.has(groupId)) continue;
      const wasRendered = (group.routeIds ?? []).some((routeId) => projectedRouteIds.has(String(routeId)));
      if (!wasRendered) merged.push(deepCopy(group));
    }
    world.globalNetwork.nativeState.fareGroups = merged;
  }
  async #registerCommuteCatalog(world, tileId) {
    if (typeof this.tilePackages.loadCommuteCatalog !== 'function') return false;
    const catalog = await this.tilePackages.loadCommuteCatalog(tileId);
    return registerCommuteCatalog(world, catalog);
  }
  async #captureLiveNetworkSnapshot(world, tileId) {
    const nativeNetwork = await this.game.captureNativeNetworkState?.();
    if (!nativeNetwork) throw new Error('Live native network capture is unavailable');
    return createNativeNetworkSnapshot(world.tiles[tileId]?.snapshot, {
      nativeState: nativeNetwork,
    });
  }
  async #refreshDerivedNetworkIfDirty(world, tileId) {
    if (this.derivedNetworkInvalidations.size === 0) {
      return { status: 'current', reasons: [] };
    }
    const reasons = this.derivedNetworkDirtyReasons();
    const snapshot = await this.#captureLiveNetworkSnapshot(world, tileId);
    const result = await this.#adoptProjectionSnapshot(world, tileId, snapshot, {
      restore: false,
    });
    for (const reason of reasons) this.derivedNetworkInvalidations.delete(reason);
    this.telemetry({
      phase: 'derived-network-refresh',
      status: result.changed ? 'refreshed' : 'unchanged',
      tileId,
      reasons,
      marker: 'native-derived-state-lazy-v1',
    });
    return {
      status: result.changed ? 'refreshed' : 'unchanged',
      reasons,
      result,
    };
  }
  async #captureNetworkProfile(world, tileId) {
    if (world.globalNetwork?.nativeState) {
      const state = world.globalNetwork.nativeState;
      return createNetworkProfile({
        tileId,
        stations: state.stations ?? [],
        routes: state.routes ?? [],
        trains: state.trains ?? [],
        pathfindingRules: this.game.capturePathfindingRules?.() ?? {},
      });
    }
    return this.game.captureCrossTileNetworkProfile?.(tileId) ?? null;
  }
  async #adoptProjectionSnapshot(world, tileId, snapshot, {
    restore = false,
    fastPath = false,
    trace = null,
  } = {}) {
    const nextNetwork = createCanonicalNetwork(
      snapshot,
      (Number(world.globalNetwork?.revision) || 0) + 1,
    );
    const canonicalSnapshot = createNativeNetworkSnapshot(snapshot, nextNetwork);
    const reconciliation = {
      accepted: true,
      changed: !world.globalNetwork || nextNetwork.hash !== world.globalNetwork.hash,
      network: nextNetwork,
      warning: null,
    };
    const previousNetwork = world.globalNetwork;
    const previousProjection = world.activeProjection;
    const previousOverlay = world.projectionOverlay;
    const previousWarning = world.projectionWarning;
    const previousTileSnapshot = world.tiles[tileId]?.snapshot;
    world.globalNetwork = nextNetwork;
    world.projectionWarning = null;
    if (!this.networkProjection) {
      world.tiles[tileId].snapshot = stripNetworkFromSnapshot(canonicalSnapshot);
      try {
        if (restore === true) {
          await this.game.validateSnapshot(canonicalSnapshot);
          await this.#restoreNativeSnapshot(canonicalSnapshot);
        }
      } catch (error) {
        world.globalNetwork = previousNetwork;
        world.activeProjection = previousProjection;
        world.projectionOverlay = previousOverlay;
        world.projectionWarning = previousWarning;
        world.tiles[tileId].snapshot = previousTileSnapshot;
        throw error;
      }
      return reconciliation;
    }
    if (fastPath
      && world.activeProjection?.activeTileId === tileId
      && this.networkProjection.isSnapshotStructurallyCurrent?.({
        network: world.globalNetwork,
        baseline: world.activeProjection,
        nativeSnapshot: canonicalSnapshot,
      })) {
      world.tiles[tileId].snapshot = stripNetworkFromSnapshot(canonicalSnapshot);
      trace?.('projection-structurally-current', {
        activeTileId: tileId,
        networkRevision: world.globalNetwork.revision,
        projectionHash: world.activeProjection.projectionHash,
        mode: this.nativeNetworkMode,
      });
      return {
        ...reconciliation,
        projection: world.activeProjection,
        diagnostics: { structurallyCurrent: true, mode: this.nativeNetworkMode },
        fastPath: true,
      };
    }
    trace?.('projection-reconciled', {
      accepted: reconciliation.accepted,
      changed: reconciliation.changed,
      warning: reconciliation.warning ?? null,
      authoritativeNetwork: summarizeNetworkForLoad(world.globalNetwork?.nativeState),
      mode: this.nativeNetworkMode,
    });
    const built = this.networkProjection.build({
      network: world.globalNetwork,
      activeTileId: tileId,
      catalog: this.tileCatalog,
      baseSnapshot: canonicalSnapshot,
    });
    trace?.('projection-built', {
      restorePolicy: restore,
      diagnostics: built.diagnostics,
      manifest: {
        activeTileId: built.manifest?.activeTileId ?? null,
        networkRevision: built.manifest?.networkRevision ?? null,
        projectionHash: built.manifest?.projectionHash ?? null,
        partialRouteIds: built.manifest?.partialRouteIds ?? [],
        visibleTileIds: built.manifest?.visibleTileIds ?? [],
      },
      projectedSnapshot: summarizeNetworkForLoad(built.snapshot),
      nativeSnapshot: summarizeNetworkForLoad(canonicalSnapshot),
      mode: this.nativeNetworkMode,
    });
    world.activeProjection = built.manifest;
    this.#publishFinanceOwnershipIfCurrent(world, built.manifest, 'projection-change');
    world.projectionOverlay = built.overlay;
    world.tiles[tileId].snapshot = stripNetworkFromSnapshot(canonicalSnapshot);
    try {
      if (restore === true) {
        trace?.('native-restore-start', {
          reason: 'authoritative',
          snapshot: summarizeNetworkForLoad(canonicalSnapshot),
          mode: this.nativeNetworkMode,
        });
        await this.game.validateSnapshot(canonicalSnapshot);
        await this.#restoreNativeSnapshot(canonicalSnapshot);
        trace?.('native-restore-complete', {
          reason: 'authoritative',
          snapshot: summarizeNetworkForLoad(canonicalSnapshot),
          observedNativeNetwork: await this.game.inspectNativeNetworkForDiagnostics?.() ?? null,
          mode: this.nativeNetworkMode,
        });
      } else {
        trace?.('native-restore-skipped', {
          restorePolicy: restore,
          reconciliationAccepted: reconciliation.accepted,
        });
      }
    } catch (error) {
      world.globalNetwork = previousNetwork;
      world.activeProjection = previousProjection;
      world.projectionOverlay = previousOverlay;
      world.projectionWarning = previousWarning;
      world.tiles[tileId].snapshot = previousTileSnapshot;
      throw error;
    }
    const commuteHydration = this.game.hydrateClippedRouteCommuteData?.(world.globalNetwork.nativeState);
    if (commuteHydration?.hydratedRoutes) {
      this.telemetry({ phase: 'native-commute-projection-hydrated', tileId, ...commuteHydration });
    }
    this.telemetry({ phase: 'network-projection-build', tileId, ...built.diagnostics, warning: world.projectionWarning });
    return { ...reconciliation, projection: built.manifest, diagnostics: built.diagnostics, mode: this.nativeNetworkMode };
  }
  async #restoreNativeSnapshot(snapshot, authoritativeFinanceSnapshot = null) {
    // Route navigation initializes the destination city before this restore.
    // Prefer the source snapshot captured while the source ledger was still
    // live; the destination store is only a fallback for older snapshots that
    // do not contain a newly introduced native financial field.
    return this.game.restoreSnapshot(snapshot, {
      preserveNativeFinance: Boolean(this.revenueAccrual),
      authoritativeFinanceSnapshot,
    });
  }
  async #restoreDestinationNetwork(world, destinationId, sourceId, trace = null) {
    const sourceSnapshot = world.pendingTransition?.nativeSnapshot
      ?? (sourceId ? world.tiles[sourceId]?.snapshot : null);
    if (this.networkProjection) {
      const destination = world.tiles[destinationId];
      const destinationBase = destination.snapshot ?? await this.game.captureSnapshot(sourceSnapshot);
      if (!world.globalNetwork) world.globalNetwork = createGlobalNetwork(sourceSnapshot ?? destinationBase);
      // The projection is now presentation-only.  Restore the complete
      // canonical topology while deriving the visible 3x3 manifest/overlay
      // from the same network for map rendering and finance footprints.
      const canonicalSnapshot = createNativeNetworkSnapshot(destinationBase, world.globalNetwork);
      const built = this.networkProjection.build({
        network: world.globalNetwork,
        activeTileId: destinationId,
        catalog: this.tileCatalog,
        baseSnapshot: canonicalSnapshot,
      });
      trace?.('destination-projection-built', {
        destinationId,
        sourceId,
        diagnostics: built.diagnostics,
        projectedSnapshot: summarizeNetworkForLoad(built.snapshot),
        nativeSnapshot: summarizeNetworkForLoad(canonicalSnapshot),
        mode: this.nativeNetworkMode,
      });
      trace?.('native-restore-start', {
        reason: 'destination-network',
        destinationId,
        snapshot: summarizeNetworkForLoad(canonicalSnapshot),
        mode: this.nativeNetworkMode,
      });
      await this.game.validateSnapshot(canonicalSnapshot);
      await this.#restoreNativeSnapshot(canonicalSnapshot, sourceSnapshot);
      trace?.('native-restore-complete', {
        reason: 'destination-network',
        destinationId,
        snapshot: summarizeNetworkForLoad(canonicalSnapshot),
        observedNativeNetwork: await this.game.inspectNativeNetworkForDiagnostics?.() ?? null,
        mode: this.nativeNetworkMode,
      });
      const commuteHydration = this.game.hydrateClippedRouteCommuteData?.(world.globalNetwork.nativeState);
      if (commuteHydration?.hydratedRoutes) {
        this.telemetry({ phase: 'native-commute-projection-hydrated', tileId: destinationId, ...commuteHydration });
      }
      destination.snapshot = stripNetworkFromSnapshot(canonicalSnapshot);
      world.activeProjection = built.manifest;
      this.#publishFinanceOwnershipIfCurrent(world, built.manifest, 'tile-transition');
      world.projectionOverlay = built.overlay;
      world.projectionWarning = null;
      this.telemetry({ phase: 'network-projection-build', tileId: destinationId, ...built.diagnostics });
      return canonicalSnapshot;
    }
    const destination = world.tiles[destinationId];
    if (!sourceSnapshot || typeof this.game.mergeSharedTransitNetwork !== 'function') {
      if (destination.snapshot) await this.#restoreNativeSnapshot(destination.snapshot, sourceSnapshot);
      return destination.snapshot;
    }
    const destinationBase = destination.snapshot ?? await this.game.captureSnapshot(sourceSnapshot);
    const merged = this.game.mergeSharedTransitNetwork(destinationBase, sourceSnapshot);
    await this.game.validateSnapshot(merged);
    await this.#restoreNativeSnapshot(merged, sourceSnapshot);
    destination.snapshot = merged;
    return merged;
  }
  async #transition(tileId, transitionId) {
    const started = this.now(); const sourceId = this.world.activeTileId;
    // Keep both old static data and the opaque save so rollback is a whole-runtime restore.
    const oldRuntime = await this.game.captureRuntime(); oldRuntime.package ??= await this.tilePackages.prepare(sourceId);
    const draft = deepCopy(this.world); let paused = false; let wasPaused = false; let lease = false; let committed = false; let phase = 'prepare';
    try {
      // Important: validate all remote/static data before pausing or saving native state.
      const destinationPackage = await this.tilePackages.prepare(tileId);
      await this.#registerCommuteCatalog(draft, tileId);
      phase = 'lease'; lease = await this.worldState.acquireLease(draft.worldId, transitionId); if (!lease) throw new Error('Another transition currently holds the world lease'); this.#emit(transitionId, phase, started);
      phase = 'pause'; wasPaused = await this.#pausePreservingUserState(); paused = true; this.#emit(transitionId, phase, started);
      await this.#captureAuthoritativeGlobals(draft);
      phase = 'snapshot'; const sourceSnapshot = await this.game.captureSnapshot(); await this.game.validateSnapshot(sourceSnapshot); if (this.networkProjection) await this.#adoptProjectionSnapshot(draft, sourceId, sourceSnapshot, { restore: false }); else draft.tiles[sourceId].snapshot = sourceSnapshot; this.#emit(transitionId, phase, started);
      const sourceProfile = await this.#captureNetworkProfile(draft, sourceId); if (sourceProfile) draft.tiles[sourceId].networkProfile = sourceProfile;
      phase = 'reconcile'; this.#applyActivity(draft, await this.game.reconcileActiveResults()); this.#emit(transitionId, phase, started);
      phase = 'catchup'; this.#advanceDraft(draft, Math.floor(draft.elapsedSeconds / 3600)); await this.#syncCrossTileFinance(draft); await this.#syncBackgroundNativeFinance(draft, Math.floor(draft.elapsedSeconds / 3600)); this.#emit(transitionId, phase, started);
      phase = 'load'; await this.game.loadStaticPackage(destinationPackage); const destination = draft.tiles[tileId]; await this.#restoreDestinationNetwork(draft, tileId, sourceId); this.#emit(transitionId, phase, started);
      phase = 'globals';
      if (!this.revenueAccrual) await this.game.setAuthoritativeGlobals(draft);
      else {
        await this.game.setAuthoritativeGameMode?.(draft.gameMode);
        await this.game.setAuthoritativeClock?.(draft.elapsedSeconds);
      }
      this.#emit(transitionId, phase, started);
      const destinationProfile = await this.#captureNetworkProfile(draft, tileId); if (destinationProfile) destination.networkProfile = destinationProfile;
      phase = 'commute-refresh'; const commuteRefresh = await this.game.refreshNativeCommutes?.(); if (commuteRefresh) this.telemetry({ transitionId, phase, ...commuteRefresh }); this.#emit(transitionId, phase, started);
      phase = 'restore'; await this.game.restoreCamera(destinationPackage.manifest?.viewport ?? destination.snapshot?.viewport ?? sourceSnapshot.viewport ?? sourceSnapshot.camera); this.#emit(transitionId, phase, started);
      phase = 'verify'; await this.game.verifyLoaded(); this.#emit(transitionId, phase, started);
      phase = 'commit'; draft.activeTileId = tileId; draft.revision++; draft.tiles[sourceId].revision++; draft.tiles[tileId].revision++; draft.committedTransitionId = transitionId; draft.pendingTransition = null; assertWorld(draft, this.tileIds); await this.worldState.commit(draft, transitionId); this.world = draft; committed = true; this.#emit(transitionId, phase, started);
      phase = 'resume'; await this.#restoreUserPauseState(wasPaused); paused = false; this.#emit(transitionId, phase, started);
      this.#notify({ type: 'projection-changed', status: 'tile-transition', tileId });
      return { status: 'committed', transitionId, from: sourceId, to: tileId, revision: draft.revision };
    } catch (error) {
      this.telemetry({ transitionId, phase, error: String(error.message ?? error), rollback: true });
      // Once commit succeeds, preserve the new runtime; retry resume in finally rather than rolling back to an old world.
      if (!committed && paused) {
        try { await this.game.restoreRuntime(oldRuntime); } catch (rollbackError) { error.rollbackError = rollbackError; }
      }
      throw error;
    } finally {
      if (paused) { try { await this.#restoreUserPauseState(wasPaused); } catch {} }
      if (lease) await this.worldState.releaseLease(draft.worldId, transitionId);
    }
  }

  async #pausePreservingUserState() {
    const wasPaused = typeof this.game.isPaused === 'function' ? await this.game.isPaused() : false;
    await this.game.pause();
    return wasPaused;
  }

  async #restoreUserPauseState(wasPaused) {
    if (wasPaused) await this.game.pause();
    else await this.game.resume();
  }

}

export { PHASES };
