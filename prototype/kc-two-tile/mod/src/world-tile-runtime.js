import { assertWorld, createWorld, deepCopy, migrateWorldTileSet } from './world-model.js';
import { advanceCommutesTo, applyModeShares, projectCommutesForTile, rebaseCommutesTo, recordObservedDeparture, registerCommuteCatalog } from './cross-tile-commute-engine.js';
import { calculateCrossTileModeShares, createNetworkProfile, inspectCrossTileModeChoice, inspectCrossTileTransitPath } from './cross-tile-mode-choice.js';
import {
  NetworkProjection,
  createNativeNetworkSnapshot,
  createGlobalNetwork,
  isLegacyProjectedSnapshot,
  repairStationTrackGroupIntegrity,
  routeTileIdsById,
  stripNetworkFromSnapshot,
} from './network-projection.js';
import { CANONICAL_NATIVE_NETWORK_MODE } from './shared-transit-network.js';
import { fareSegmentsFromStationRoutes, quoteJourneyFare } from './journey-fare.js';
import { repairNativeStateRouteTimings } from './route-timing-integrity.js';
import {
  backgroundFinanceForHour,
  migrateCachedNativeRevenueProfile,
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
const NATIVE_DEMAND_TILE_GUARD_METERS = 3_000;

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
    projectionWriteQuarantine: world.projectionWriteQuarantine ?? null,
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
  constructor({ game, tilePackages, worldState, initialWorld, tileIds = initialWorld?.tileIds ?? tilePackages?.tileIds?.(), tileCatalog = null, networkRecovery = null, now = () => Date.now(), telemetry = () => {} }) {
    this.game = game; this.tilePackages = tilePackages; this.worldState = worldState; this.initialWorld = initialWorld;
    this.tileIds = Object.freeze([...tileIds]);
    if (!this.tileIds.length || new Set(this.tileIds).size !== this.tileIds.length) throw new Error('Runtime tile IDs must be a non-empty unique list');
    this.tileCatalog = tileCatalog; this.networkRecovery = networkRecovery; this.now = now; this.telemetry = telemetry; this.world = null; this.viewWorldFallback = null; this.inFlight = new Map(); this.serial = Promise.resolve(); this.listeners = new Set();
    this.nativeNetworkMode = CANONICAL_NATIVE_NETWORK_MODE;
    this.fullNativeNetworkEnabled = true;
    this.networkProjection = tileCatalog ? new NetworkProjection({ guardBandMeters: 250 }) : null;
  }
  async boot(worldId, loadedTileId = null, {
    saveName = null,
    allowLiveFallback = false,
    restoreCanonicalLineage = false,
    nativeSessionId = null,
    nativeTileId = null,
    loadTraceId = null,
  } = {}) {
    if (this.world) return this.view();
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
      restoreCanonicalLineage,
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
    // A canonical lineage is selected independently of the native save that
    // triggered this lifecycle callback. Checkpoint pairing belongs only to
    // ordinary native-save loads.
    const persistedWorld = await this.worldState.load(
      worldId,
      restoreCanonicalLineage || saveName == null ? { loadTraceId: traceId } : {
        saveName,
        allowLiveFallback,
        nativeSessionId,
        nativeTileId,
        loadTraceId: traceId,
      },
    );
    if (restoreCanonicalLineage && !persistedWorld) {
      throw new Error(`Canonical lineage is unavailable: ${worldId}`);
    }
    let startupRequiresFullWorldSave = !persistedWorld
      || (!restoreCanonicalLineage && saveName != null)
      || allowLiveFallback
      || restoreCanonicalLineage;
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
    for (const [tileId, profile] of Object.entries(this.world.backgroundNativeFinance?.tileRevenueProfiles ?? {})) {
      this.world.backgroundNativeFinance.tileRevenueProfiles[tileId] = migrateCachedNativeRevenueProfile(profile);
    }
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
    let networkRecoveryChanged = false;
    if (typeof this.networkRecovery === 'function') {
      const recovery = await this.networkRecovery(this.world);
      networkRecoveryChanged = recovery?.changed === true;
      if (networkRecoveryChanged) startupRequiresFullWorldSave = true;
      if (networkRecoveryChanged) this.telemetry({ phase: 'network-recovery', ...recovery.imported });
      trace('network-recovery-complete', {
        changed: networkRecoveryChanged,
        imported: recovery?.imported ?? null,
        world: summarizeWorldForLoad(this.world),
      });
    }
    if (this.world.globalNetwork?.nativeState) {
      const groupRepair = repairStationTrackGroupIntegrity(this.world.globalNetwork.nativeState);
      const routeRepair = repairNativeStateRouteTimings(groupRepair.state);
      const normalizedNetwork = createGlobalNetwork(
        routeRepair.state,
        (Number(this.world.globalNetwork.revision) || 0) + 1,
      );
      const projectionMetadataRepaired = normalizedNetwork.hash !== this.world.globalNetwork.hash;
      if (groupRepair.changed || routeRepair.changed || projectionMetadataRepaired) {
        this.world.globalNetwork = normalizedNetwork;
        this.world.activeProjection = null;
        this.world.projectionOverlay = { type: 'FeatureCollection', features: [] };
        this.world.revision = (Number(this.world.revision) || 0) + 1;
        // Force the repaired canonical network back through native loadSave.
        // Merely cleaning the sidecar would leave the already-loaded facade
        // trains paired with a speed map that omits their remote tracks.
        networkRecoveryChanged = true;
        startupRequiresFullWorldSave = true;
        this.telemetry({
          phase: 'route-timing-integrity-repaired',
          repairedRoutes: routeRepair.repairedRoutes,
          repairedStops: routeRepair.repairedStops,
          repairedTrackGroups: groupRepair.repairedGroupIds,
          projectionMetadataRepaired,
        });
      }
    }
    const financeNetworkHash = this.world.backgroundNativeFinance?.networkHash ?? null;
    const expenseNetworkHash = this.world.backgroundNativeFinance?.expenseProfile?.networkHash
      ?? financeNetworkHash;
    const authoritativeNetworkHash = this.world.globalNetwork?.hash ?? null;
    if (networkRecoveryChanged || financeNetworkHash !== authoritativeNetworkHash) {
      // Keep the last completely compiled ledger and its paired native
      // ownership rules live while the replacement is prepared. Invalidating
      // either half here creates an accounting blackout (or double-counting)
      // between startup and the next successful recalculation.
      this.world.crossModeShare = null;
      if (this.world.backgroundNativeFinance) {
        this.world.backgroundNativeFinance.pendingHandoff = {
          networkHash: authoritativeNetworkHash,
          previousNetworkHash: financeNetworkHash,
          reason: networkRecoveryChanged ? 'network-recovery' : 'network-hash-mismatch',
          status: 'pending',
        };
      }
      this.telemetry({
        phase: 'native-finance-handoff-pending',
        reason: networkRecoveryChanged ? 'network-recovery' : 'network-hash-mismatch',
        previousNetworkHash: financeNetworkHash,
        previousExpenseNetworkHash: expenseNetworkHash,
        networkHash: authoritativeNetworkHash,
      });
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
      // A pending handoff is the one case where the destination's freshly reset
      // store must be replaced by the already committed world state.
      const projectionQuarantined = this.world.projectionWriteQuarantine?.active === true;
      const restorePersistedWorld = restoreCanonicalLineage === true;
      const adoptLoadedRuntime = !restorePersistedWorld
        && !this.world.pendingTransition
        && !projectionQuarantined;
      trace('state-adoption-path-selected', {
        adoptLoadedRuntime,
        restorePersistedWorld,
        projectionQuarantined,
        pendingTransition: this.world.pendingTransition ?? null,
        authoritativeAliasRestore: allowLiveFallback,
      });
      if (adoptLoadedRuntime) {
        const capturedGlobalsChanged = await this.#captureAuthoritativeGlobals(this.world);
        startupRequiresFullWorldSave ||= capturedGlobalsChanged;
        trace('authoritative-globals-captured', {
          worldTime: this.world.worldTime,
          elapsedSeconds: this.world.elapsedSeconds,
          wallet: this.world.wallet,
        });
        const authoritativeHour = Math.floor(this.world.elapsedSeconds / 3600);
        this.#ensureBackgroundFinanceClock(this.world, authoritativeHour);
        this.#recoverLegacySettlementBaseline(this.world, authoritativeHour);
        if (allowLiveFallback && authoritativeHour < this.world.worldTime) {
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
          await this.#syncCrossTileFinance(this.world);
          await this.#syncBackgroundNativeFinance(this.world, authoritativeHour);
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
          // A one-time recovery changes the authoritative network before the
          // native store is captured. Publish that recovered projection now;
          // otherwise a later native callback can reconcile the still-stale
          // loaded save and delete every entity the recovery just restored.
          if (networkRecoveryChanged) {
            this.#armProjectionWriteQuarantine(this.world, {
              reason: 'network-recovery',
              tileId: this.world.activeTileId,
            });
            await this.worldState.save(this.world);
          }
          const adoption = await this.#adoptProjectionSnapshot(this.world, this.world.activeTileId, liveSnapshot, {
            // An explicit save alias means this native save is only a tile-local
            // projection of the sidecar checkpoint. Its loaded transit slices
            // may be older or incomplete, so always republish the authoritative
            // projection even when reconciliation has no reason to reject them.
            restore: networkRecoveryChanged || allowLiveFallback ? true : 'rejected',
            migrationFallback: allowLiveFallback,
            trace,
          });
          startupRequiresFullWorldSave ||= adoption.changed || adoption.migrated;
        } else activeTile.snapshot = liveSnapshot;
      } else {
        if (!projectionQuarantined) {
          this.#armProjectionWriteQuarantine(this.world, {
            reason: restorePersistedWorld ? 'canonical-lineage-restore' : 'tile-transition',
            tileId: this.world.activeTileId,
            transitionId: this.world.pendingTransition?.transitionId ?? null,
            fromTileId: this.world.pendingTransition?.from ?? null,
          });
          await this.worldState.save(this.world);
        }
        await this.#restoreDestinationNetwork(
          this.world,
          this.world.activeTileId,
          this.world.pendingTransition?.from,
          trace,
        );
      }
      finishStartupStage('stateAdoption');
      await this.game.setAuthoritativeGlobals(this.world);
      trace('authoritative-globals-applied');
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
      if (this.world.projectionWriteQuarantine?.active) this.#clearProjectionWriteQuarantine(this.world);
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
      if (startupFinanceConfigured && !startupFinanceReady) {
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
    restoreCanonicalLineage = false,
    nativeSessionId = null,
    nativeTileId = null,
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
          restoreCanonicalLineage,
          nativeSessionId,
          nativeTileId,
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
  view() {
    const world = this.world ?? this.viewWorldFallback;
    if (!world) throw new Error('WorldTileRuntime.boot must complete first');
    // UI callers need tile status, never the opaque native save bodies.
    const tiles = Object.fromEntries(Object.entries(world.tiles).map(([id, tile]) => [id, {
      revision: tile.revision,
      lastSimulatedTime: tile.lastSimulatedTime,
      aggregate: tile.aggregate,
      hasSnapshot: Boolean(tile.snapshot),
    }]));
    const commutesByTile = Object.fromEntries(this.tileIds.map((tileId) => [tileId, projectCommutesForTile(world, tileId)]));
    const partialRouteIds = world.activeProjection?.partialRouteIds ?? [];
    const partialRouteServices = partialRouteIds
      .map((routeId) => world.globalNetwork?.routeDescriptors?.[routeId])
      .filter(Boolean);
    const lineage = summarizeLineage(world);
    return deepCopy({ nativeNetworkMode: this.nativeNetworkMode, fullNativeNetworkEnabled: this.fullNativeNetworkEnabled, worldId: world.worldId, activeTileId: world.activeTileId, worldTime: world.worldTime, day: lineage.day, elapsedSeconds: world.elapsedSeconds, wallet: world.wallet, fare: lineage.fare, revision: world.revision, routeCount: lineage.routeCount, stationCount: lineage.stationCount, trainCount: lineage.trainCount, settlementAccountingSchemaVersion: world.settlementAccountingSchemaVersion, settlementFinanceQuarantine: world.settlementFinanceQuarantine ?? null, projectionWriteQuarantine: world.projectionWriteQuarantine ?? null, backgroundNativeFinance: world.backgroundNativeFinance, tiles, gatewayLedger: world.gatewayLedger, crossPopModeChoices: world.crossPopModeChoices ?? {}, crossModeShare: world.crossModeShare ?? null, crossTileFinancials: world.crossTileFinancials, projectionWarning: world.projectionWarning ?? null, projection: world.activeProjection ? { activeTileId: world.activeProjection.activeTileId, networkRevision: world.activeProjection.networkRevision, visibleTileIds: world.activeProjection.visibleTileIds ?? [], partialRouteIds, projectionHash: world.activeProjection.projectionHash } : null, partialRouteServices, commutes: commutesByTile[world.activeTileId], commutesByTile });
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
  #notify(event) { const view = this.view(); for (const listener of this.listeners) listener(event, view); }

  async #compileNativeFinanceProfile(world, tileId, networkProfile = world.tiles?.[tileId]?.networkProfile) {
    const nativeFinanceProfile = this.game.calculateNativeFinanceProfile?.(
      tileId,
      world.globalNetwork?.nativeState ?? null,
      { financeOwnedRouteIds: world.activeProjection?.financeOwnedRouteIds ?? [] },
    );
    const finance = this.#ensureBackgroundFinanceClock(world, Math.floor(world.elapsedSeconds / 3600));
    const hadNativeFinanceProfile = Object.keys(finance.tileRevenueProfiles ?? {}).length > 0
      || Boolean(finance.expenseProfile);
    if (nativeFinanceProfile?.expenseProfile) {
      finance.expenseProfile = {
        ...deepCopy(nativeFinanceProfile.expenseProfile),
        networkHash: world.globalNetwork?.hash ?? null,
      };
    }
    const results = { evaluated: 0, cached: 0, unavailable: [], failed: [] };
    const globalState = world.globalNetwork?.nativeState ?? null;
    const financeOwnedRouteIds = world.activeProjection?.financeOwnedRouteIds ?? [];
    const hasSpatialTileCatalog = this.tileCatalog?.tiles?.some?.((tile) => Array.isArray(tile?.bounds));
    const tileIdsByRoute = globalState && hasSpatialTileCatalog
      ? routeTileIdsById(globalState, this.tileCatalog, { guardBandMeters: NATIVE_DEMAND_TILE_GUARD_METERS })
      : null;
    if (typeof this.tilePackages.loadNativeDemand === 'function') {
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
            })
            : globalState
              ? createNetworkProfile({
                tileId: candidateTileId,
                stations: globalState.stations ?? [],
                routes: globalState.routes ?? [],
                trains: globalState.trains ?? [],
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
          const demand = await this.tilePackages.loadNativeDemand(candidateTileId);
          if (!demand) { results.unavailable.push(candidateTileId); continue; }
          const result = evaluateOffTileNativeDemand({
            tileId: candidateTileId,
            demand,
            networkProfile: candidateProfile,
            farePolicy: localFarePolicy,
            globalNativeState: globalState,
            financeOwnedRouteIds: localFinanceOwnedRouteIds,
            existingProfile,
          });
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
    if (!finance.tileRevenueProfiles[tileId]?.source && nativeFinanceProfile?.tileRevenueProfile) {
      finance.tileRevenueProfiles[tileId] = {
        ...deepCopy(nativeFinanceProfile.tileRevenueProfile),
        networkSignature: networkProfile?.structuralSignature ?? networkProfile?.signature ?? null,
      };
    }
    if (!hadNativeFinanceProfile) finance.lastSettledHour = Math.floor(world.elapsedSeconds / 3600);
    if (results.failed.length === 0 && results.unavailable.length === 0) {
      finance.networkHash = world.globalNetwork?.hash ?? null;
    }
    const projected = finance.tileRevenueProfiles[tileId];
    const nativeDailyRevenue = Number(nativeFinanceProfile?.tileRevenueProfile?.dailyRevenue);
    const projectedDailyRevenue = Number(projected?.dailyRevenue);
    if (Number.isFinite(nativeDailyRevenue) && Number.isFinite(projectedDailyRevenue)) {
      this.telemetry({
        phase: 'off-tile-native-demand-audit',
        tileId,
        nativeDailyRevenue,
        projectedDailyRevenue,
        difference: projectedDailyRevenue - nativeDailyRevenue,
        percentError: nativeDailyRevenue === 0
          ? (projectedDailyRevenue === 0 ? 0 : null)
          : (projectedDailyRevenue - nativeDailyRevenue) / nativeDailyRevenue * 100,
      });
    }
    return {
      compiled: Boolean(projected || finance.expenseProfile),
      ...results,
      activeSource: projected?.source ?? 'native-store-fallback',
    };
  }

  async recalculateCrossTileModeShare({ reason = 'manual', day = null, force = false } = {}) {
    this.#requireBooted();
    return this.#enqueue(async () => {
      const passiveCacheReady = this.world.crossModeShare?.schemaVersion === 1
        && this.world.backgroundNativeFinance?.networkHash === (this.world.globalNetwork?.hash ?? null)
        && this.tileIds.every((tileId) => isCurrentOffTileNativeDemandProfile(
          this.world.backgroundNativeFinance?.tileRevenueProfiles?.[tileId],
      ));
      if (!force && PASSIVE_RECALCULATION_REASONS.has(reason) && passiveCacheReady) {
        const result = { ...this.world.crossModeShare, status: 'cached', reason, day };
        this.telemetry({ phase: 'cross-mode-share', ...result });
        return result;
      }
      if (!force && reason === 'daily' && day != null && this.world.crossModeShare?.day === day) {
        return { status: 'already-current', ...this.world.crossModeShare };
      }
      await this.#captureAuthoritativeGlobals(this.world);
      this.#advanceDraft(this.world, Math.floor(this.world.elapsedSeconds / 3600));
      await this.#syncCrossTileFinance(this.world);
      await this.#syncBackgroundNativeFinance(this.world, Math.floor(this.world.elapsedSeconds / 3600));
      const tileId = this.world.activeTileId;
      const previousProfile = this.world.tiles[tileId].networkProfile;
      const previousSignature = previousProfile?.signature;
      const profile = await this.#captureNetworkProfile(this.world, tileId);
      const previousStructuralSignature = previousProfile?.structuralSignature ?? previousSignature;
      const nextStructuralSignature = profile?.structuralSignature ?? profile?.signature;
      if (!force && reason === 'network-change' && previousStructuralSignature
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
      const nativeFinanceProfile = await this.#compileAndCommitFinanceHandoff(
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
      const backgroundFinance = await this.#syncBackgroundNativeFinance(
        this.world,
        Math.floor(this.world.elapsedSeconds / 3600),
      );
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
      const calculated = calculateCrossTileModeShares({
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
      });
      // Mode share is deterministic from packaged demand plus the saved
      // network profile. Keep the result live for settlement, but do not
      // synchronously rewrite the multi-megabyte world during startup or a
      // network refresh. Save checkpoints and tile-transition commits persist
      // it naturally; after an abnormal exit startup recalculates it anyway.
      const result = {
        status: 'recalculated', tileId,
        networkChanged: previousSignature !== profile?.signature,
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
      const nativeFinanceProfile = await this.#recoverStaleNativeFinanceProfile(
        this.world,
        targetHour,
        reason,
      );
      const advancement = this.#advanceDraft(this.world, targetHour);
      const crossFinancialsPosted = await this.#syncCrossTileFinance(this.world);
      const background = await this.#syncBackgroundNativeFinance(this.world, targetHour);
      const profileStatusChanged = ['recovered', 'partial', 'failed'].includes(nativeFinanceProfile.status);
      const financialsPosted = crossFinancialsPosted || background.persisted || nativeAuditChanged || profileStatusChanged;
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
    if (this.world.projectionWriteQuarantine?.active) {
      const result = {
        status: 'projection-quarantined',
        reason,
        tileId: this.world.activeTileId,
        quarantine: deepCopy(this.world.projectionWriteQuarantine),
      };
      this.telemetry({ phase: 'projection-write-blocked', operation: 'checkpoint', ...result });
      return result;
    }
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
        revisionAssetsWrite: 0,
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
                { restore: false, fastPath: true },
              )
            ));
            projectionStatus = adoption.fastPath
              ? 'native-network-captured'
              : 'native-network-reconciled';
          } else {
            projectionStatus = 'deferred-native-save';
          }
        }
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
              'revisionAssetsWrite',
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
  async saveAsCanonicalLineage({ worldId } = {}) {
    this.#requireBooted();
    if (typeof worldId !== 'string' || !worldId.trim()) throw new Error('A canonical lineage requires a world id');
    if (worldId === this.world.worldId) throw new Error('The new canonical lineage must have a different world id');
    if (this.world.projectionWriteQuarantine?.active) {
      throw new Error('Cannot save a new canonical lineage while topology recovery is pending');
    }
    return this.#enqueue(async () => {
      const wasPaused = await this.#pausePreservingUserState();
      try {
        const draft = deepCopy(this.world);
        await this.#captureAuthoritativeGlobals(draft);
        // Capture first: the live native clock may have advanced beyond the
        // last sidecar write. The lineage must be stamped with that exact
        // metro-save time before hourly catch-up is calculated.
        const authoritativeHour = Math.floor(draft.elapsedSeconds / 3_600);
        this.#advanceDraft(draft, authoritativeHour);
        await this.#syncCrossTileFinance(draft);
        await this.#syncBackgroundNativeFinance(draft, authoritativeHour);
        const tile = draft.tiles[draft.activeTileId];
        const snapshot = await this.game.captureSnapshot(tile.snapshot);
        await this.game.validateSnapshot(snapshot);
        if (this.networkProjection) {
          await this.#adoptProjectionSnapshot(draft, draft.activeTileId, snapshot, {
            restore: false,
            fastPath: true,
          });
        } else tile.snapshot = snapshot;
        draft.worldId = worldId.trim();
        draft.revision++;
        tile.revision++;
        assertWorld(draft, this.tileIds);
        await this.worldState.save(draft);
        const lineage = summarizeLineage(draft);
        return {
          worldId: draft.worldId,
          ...lineage,
          revision: draft.revision,
        };
      } finally {
        await this.#restoreUserPauseState(wasPaused);
      }
    });
  }
  async reconcileActiveProjection(reason = 'network-change') {
    this.#requireBooted();
    if (!this.networkProjection) return { status: 'projection-disabled', reason };
    if (this.world.projectionWriteQuarantine?.active) {
      const result = {
        status: 'projection-quarantined',
        reason,
        tileId: this.world.activeTileId,
        warning: { code: 'projection-write-quarantined' },
      };
      this.telemetry({ phase: 'projection-write-blocked', operation: 'reconcile', ...result });
      return result;
    }
    return this.#enqueue(async () => {
      const wasPaused = await this.#pausePreservingUserState();
      try {
        const tileId = this.world.activeTileId;
        const snapshot = await this.game.captureSnapshot(this.world.tiles[tileId].snapshot);
        await this.game.validateSnapshot(snapshot);
        const result = await this.#adoptProjectionSnapshot(this.world, tileId, snapshot, { restore: 'rejected' });
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
        this.telemetry({ phase: 'network-projection-reconcile', status, reason, tileId, warning: result.warning ?? null });
        this.#notify({ type: 'projection-changed', status, reason, warning: result.warning ?? null });
        return { status, reason, tileId, warning: result.warning ?? null };
      } finally { await this.#restoreUserPauseState(wasPaused); }
    });
  }
  async reconcileActiveScheduleChanges(changes) {
    this.#requireBooted();
    if (!this.networkProjection) return { status: 'projection-disabled', reason: 'schedule-change' };
    return this.#enqueue(async () => {
      const wasPaused = await this.#pausePreservingUserState();
      try {
        const tileId = this.world.activeTileId;
        const result = this.networkProjection.applyRouteScheduleChanges(this.world.globalNetwork, changes);
        this.world.projectionWarning = result.warning ?? null;
        if (!result.accepted) {
          this.telemetry({ phase: 'network-projection-schedule', status: 'rejected', tileId, warning: result.warning });
          this.#notify({ type: 'projection-changed', status: 'rejected', reason: 'schedule-change', warning: result.warning });
          return { status: 'rejected', reason: 'schedule-change', tileId, warning: result.warning };
        }
        if (result.changed) this.world.globalNetwork = result.network;
        const snapshot = await this.game.captureSnapshot(this.world.tiles[tileId].snapshot);
        await this.game.validateSnapshot(snapshot);
        // The native scheduler has already applied this schedule with
        // setRoutes(..., false). Rebuild the persisted projection around that
        // state, but do not loadSave it back into the game: loadSave calls
        // setRoutes(..., true) and needlessly reruns the interlining worker.
        await this.#adoptProjectionSnapshot(this.world, tileId, snapshot, { restore: false, reconcile: false });
        if (result.changed) {
          this.world.revision++;
          this.world.tiles[tileId].revision++;
        }
        await this.worldState.save(this.world);
        const status = result.changed ? 'accepted' : 'unchanged';
        this.telemetry({ phase: 'network-projection-schedule', status, tileId, routeIds: changes.map(({ routeId }) => routeId) });
        this.#notify({ type: 'projection-changed', status, reason: 'schedule-change', warning: null });
        return { status, reason: 'schedule-change', tileId, warning: null };
      } finally { await this.#restoreUserPauseState(wasPaused); }
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
  async stageNavigationTransition(tileId) {
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
      const wasPaused = await this.#pausePreservingUserState();
      try {
        lease = await this.worldState.acquireLease(draft.worldId, transitionId);
        if (!lease) throw new Error('Another transition currently holds the world lease');
        await this.#captureAuthoritativeGlobals(draft);
        const sourceSnapshot = await this.game.captureSnapshot(draft.tiles[sourceId].snapshot);
        await this.game.validateSnapshot(sourceSnapshot);
        if (this.networkProjection) await this.#adoptProjectionSnapshot(draft, sourceId, sourceSnapshot, { restore: 'rejected' });
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
        draft.pendingTransition = { transitionId, from: sourceId, to: tileId, mode: 'route-navigation' };
        this.#armProjectionWriteQuarantine(draft, {
          reason: 'tile-transition', transitionId, tileId, fromTileId: sourceId,
        });
        assertWorld(draft, this.tileIds);
        await this.worldState.commit(draft, transitionId);
        this.world = draft;
        return { status: 'reload-required', transitionId, worldId: draft.worldId, tileId, from: sourceId };
      } finally {
        await this.#restoreUserPauseState(wasPaused);
        if (lease) await this.worldState.releaseLease(draft.worldId, transitionId);
      }
    });
  }
  async completeStagedTransition(loadedTileId, { loadTraceId = null } = {}) {
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
      const completionStatus = pending
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
        if (!this.world.projectionWriteQuarantine?.active) {
          this.#armProjectionWriteQuarantine(this.world, {
            reason: 'tile-transition',
            transitionId: pending?.transitionId ?? this.world.committedTransitionId ?? null,
            tileId: loadedTileId,
            fromTileId: pending?.from ?? null,
          });
          await this.worldState.save(this.world);
        }
        const destination = this.world.tiles[loadedTileId];
        await this.#restoreDestinationNetwork(this.world, loadedTileId, pending?.from ?? null, trace);
        await this.game.setAuthoritativeGlobals(this.world);
        trace('authoritative-globals-applied');
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
        this.#clearProjectionWriteQuarantine(this.world);
        if (!destination.snapshot) throw new Error(`Destination snapshot was not captured: ${loadedTileId}`);
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
      for (const [tileId, tile] of Object.entries(world.tiles)) tile.aggregate.backlog = projectCommutesForTile(world, tileId).waitingToLeave;
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
    const expenseCurrent = Boolean(finance?.expenseProfile)
      && (finance.expenseProfile.networkHash ?? finance.networkHash) === networkHash;
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
    const recoveredExpenses = Boolean(recoveredFinance.expenseProfile)
      && (recoveredFinance.expenseProfile.networkHash ?? recoveredFinance.networkHash) === networkHash;
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
  async #syncBackgroundNativeFinance(world, targetHour = Math.floor(world.elapsedSeconds / 3600)) {
    if (!Number.isSafeInteger(targetHour) || targetHour < 0) throw new Error('Invalid background finance hour');
    const finance = this.#ensureBackgroundFinanceClock(world, targetHour);
    const ownershipProjection = this.#committedFinanceOwnership(world);
    const currentNetworkHash = finance.ownershipProjection?.networkHash
      ?? world.globalNetwork?.hash
      ?? null;
    const revenueProfileCurrent = Object.keys(finance.tileRevenueProfiles).length > 0
      && finance.networkHash === currentNetworkHash;
    const expenseProfileCurrent = Boolean(finance.expenseProfile)
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
      aggregate.revenue += posting.revenue;
      aggregate.expenses += posting.expenses;
      for (const field of ['revenueByTile', 'revenueByRoute', 'expensesByRoute', 'expenseCategories']) {
        for (const [id, amount] of Object.entries(posting[field])) {
          aggregate[field][id] = (aggregate[field][id] ?? 0) + amount;
        }
      }
    }
    const hasPosting = aggregate.revenue > 0 || aggregate.expenses > 0
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
  async #captureAuthoritativeGlobals(world) {
    if (typeof this.game.captureAuthoritativeGlobals !== 'function') return false;
    const globals = await this.game.captureAuthoritativeGlobals();
    if (!Number.isFinite(globals?.wallet)) throw new Error('Invalid captured world balance');
    world.wallet = globals.wallet;
    if (!Number.isFinite(globals?.elapsedSeconds) || globals.elapsedSeconds < 0) throw new Error('Invalid captured game time');
    world.elapsedSeconds = globals.elapsedSeconds;
    if (Number.isFinite(globals?.farePolicy?.fare)) {
      world.farePolicy = deepCopy(globals.farePolicy);
      this.#mergeCapturedFareGroups(world, globals.farePolicy.fareGroups);
    }
    if (globals?.financialHistory) world.financialHistory = deepCopy(globals.financialHistory);
    const financeRebase = this.game.rebaseNativeFinanceForCanonicalMode?.();
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
    return Boolean(this.#ingestNativeFinanceAudit(world) || financeRebase?.changed);
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
  async #captureNetworkProfile(world, tileId) {
    if (world.globalNetwork?.nativeState) {
      const state = world.globalNetwork.nativeState;
      return createNetworkProfile({
        tileId,
        stations: state.stations ?? [],
        routes: state.routes ?? [],
        trains: state.trains ?? [],
      });
    }
    return this.game.captureCrossTileNetworkProfile?.(tileId) ?? null;
  }
  async #adoptProjectionSnapshot(world, tileId, snapshot, {
    restore = false,
    reconcile = true,
    fastPath = false,
    migrationFallback = false,
    trace = null,
  } = {}) {
    const legacyProjected = migrationFallback || isLegacyProjectedSnapshot(snapshot, {
      baseline: world.activeProjection,
      fallbackState: world.globalNetwork?.nativeState,
    });
    // A legacy projection is the one case where the sidecar may supply
    // missing topology.  Normal native snapshots are promoted wholesale,
    // including deletions and all supporting topology arrays.
    const nextNetwork = legacyProjected && world.globalNetwork
      ? createCanonicalNetwork(world.globalNetwork.nativeState, (Number(world.globalNetwork.revision) || 0) + 1)
      : createCanonicalNetwork(snapshot, (Number(world.globalNetwork?.revision) || 0) + 1);
    const canonicalSnapshot = createNativeNetworkSnapshot(snapshot, nextNetwork);
    const reconciliation = {
      accepted: true,
      changed: !world.globalNetwork || nextNetwork.hash !== world.globalNetwork.hash,
      network: nextNetwork,
      warning: null,
      migrated: legacyProjected,
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
        if (restore === true || legacyProjected) {
          await this.game.validateSnapshot(canonicalSnapshot);
          await this.game.restoreSnapshot(canonicalSnapshot);
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
    if (fastPath && !legacyProjected
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
      migrated: legacyProjected,
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
      if (restore === true || legacyProjected || (restore === 'rejected' && !reconciliation.accepted)) {
        trace?.('native-restore-start', {
          reason: legacyProjected ? 'legacy-projection-migration' : (restore === true ? 'authoritative' : 'reconciliation-rejected'),
          snapshot: summarizeNetworkForLoad(canonicalSnapshot),
          mode: this.nativeNetworkMode,
        });
        await this.game.validateSnapshot(canonicalSnapshot);
        await this.game.restoreSnapshot(canonicalSnapshot);
        trace?.('native-restore-complete', {
          reason: legacyProjected ? 'legacy-projection-migration' : (restore === true ? 'authoritative' : 'reconciliation-rejected'),
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
  async #restoreDestinationNetwork(world, destinationId, sourceId, trace = null) {
    if (this.networkProjection) {
      const destination = world.tiles[destinationId];
      const sourceSnapshot = sourceId ? world.tiles[sourceId]?.snapshot : null;
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
      await this.game.restoreSnapshot(canonicalSnapshot);
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
    const sourceSnapshot = sourceId ? world.tiles[sourceId]?.snapshot : null;
    if (!sourceSnapshot || typeof this.game.mergeSharedTransitNetwork !== 'function') {
      if (destination.snapshot) await this.game.restoreSnapshot(destination.snapshot);
      return destination.snapshot;
    }
    const destinationBase = destination.snapshot ?? await this.game.captureSnapshot(sourceSnapshot);
    const merged = this.game.mergeSharedTransitNetwork(destinationBase, sourceSnapshot);
    await this.game.validateSnapshot(merged);
    await this.game.restoreSnapshot(merged);
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
      phase = 'snapshot'; const sourceSnapshot = await this.game.captureSnapshot(); await this.game.validateSnapshot(sourceSnapshot); if (this.networkProjection) await this.#adoptProjectionSnapshot(draft, sourceId, sourceSnapshot, { restore: 'rejected' }); else draft.tiles[sourceId].snapshot = sourceSnapshot; this.#emit(transitionId, phase, started);
      const sourceProfile = await this.#captureNetworkProfile(draft, sourceId); if (sourceProfile) draft.tiles[sourceId].networkProfile = sourceProfile;
      phase = 'reconcile'; this.#applyActivity(draft, await this.game.reconcileActiveResults()); this.#emit(transitionId, phase, started);
      phase = 'catchup'; this.#advanceDraft(draft, Math.floor(draft.elapsedSeconds / 3600)); await this.#syncCrossTileFinance(draft); await this.#syncBackgroundNativeFinance(draft, Math.floor(draft.elapsedSeconds / 3600)); this.#emit(transitionId, phase, started);
      phase = 'load'; await this.game.loadStaticPackage(destinationPackage); const destination = draft.tiles[tileId]; await this.#restoreDestinationNetwork(draft, tileId, sourceId); this.#emit(transitionId, phase, started);
      phase = 'globals'; await this.game.setAuthoritativeGlobals(draft); this.#emit(transitionId, phase, started);
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

  #armProjectionWriteQuarantine(world, {
    reason, tileId, transitionId = null, fromTileId = null,
  }) {
    world.projectionWriteQuarantine = {
      active: true,
      reason,
      tileId,
      fromTileId,
      transitionId,
      armedAt: this.now(),
      authoritativeNetworkHash: world.globalNetwork?.hash ?? null,
    };
    this.telemetry({ phase: 'projection-write-quarantined', ...world.projectionWriteQuarantine });
  }

  #clearProjectionWriteQuarantine(world) {
    const cleared = world.projectionWriteQuarantine;
    world.projectionWriteQuarantine = null;
    this.telemetry({
      phase: 'projection-write-quarantine-cleared',
      tileId: world.activeTileId,
      transitionId: cleared?.transitionId ?? null,
    });
  }
}

export { PHASES };
