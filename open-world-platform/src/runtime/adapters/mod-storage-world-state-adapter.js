import { deepCopy } from '../world-model.js';

export const SAVE_CHECKPOINT_LIMIT = 10;
const POINTER_SCHEMA_VERSION = 4;
const REVISION_SCHEMA_VERSION = 1;
const POINTER_KIND = 'world-revision-pointer';
const REVISION_KIND = 'world-revision';
const FINANCE_MODES = new Set(['legacy', 'blind']);
const FINANCIAL_WORLD_FIELDS = [
  'wallet',
  'financialHistory',
  'backgroundNativeFinance',
  'crossTileFinancials',
  'pendingCrossTileAttribution',
  'settlementAccountingSchemaVersion',
  'settlementFinanceQuarantine',
];
const FINANCIAL_TILE_FIELDS = [
  'lastSettledHour',
  'lastRevenueSettledHour',
  'lastExpenseSettledHour',
  'financeCursor',
  'financialCursor',
  'revenueCursor',
  'expenseCursor',
];
const FINANCIAL_TILE_AGGREGATE_FIELDS = [
  'revenue',
  'operatingCost',
  'expense',
  'expenses',
  'cost',
  'fareRevenue',
  'pendingNativeRevenue',
];
function stripFinanceFromAggregate(aggregate) {
  if (!aggregate || typeof aggregate !== 'object') return aggregate;
  const result = { ...aggregate };
  for (const field of FINANCIAL_TILE_AGGREGATE_FIELDS) delete result[field];
  return result;
}

function stripFinanceFromGatewayPosition(position) {
  if (!position || typeof position !== 'object') return position;
  const result = { ...position };
  delete result.fareRevenue;
  return result;
}

function stripFinanceFromWorld(world) {
  if (!world || typeof world !== 'object') return world;
  for (const field of FINANCIAL_WORLD_FIELDS) delete world[field];
  for (const entry of Object.values(world.gatewayLedger ?? {})) {
    if (entry && typeof entry === 'object') delete entry.fareRevenue;
  }
  for (const tile of Object.values(world.tiles ?? {})) {
    if (!tile || typeof tile !== 'object') continue;
    for (const field of FINANCIAL_TILE_FIELDS) delete tile[field];
    if ('aggregate' in tile) tile.aggregate = stripFinanceFromAggregate(tile.aggregate);
  }
  return world;
}

/** Native Saves are the sole durable owner of rail topology. */
function stripNativeTopologyFromWorld(world) {
  if (!world || typeof world !== 'object') return world;
  delete world.globalNetwork;
  delete world.activeProjection;
  delete world.projectionOverlay;
  delete world.projectionWarning;
  if (world.pendingTransition && typeof world.pendingTransition === 'object') {
    delete world.pendingTransition.nativeSnapshot;
  }
  for (const tile of Object.values(world.tiles ?? {})) {
    if (!tile || typeof tile !== 'object') continue;
    delete tile.snapshot;
  }
  return world;
}

function defaultRevisionId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `revision-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function scheduleWhenIdle(work) {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(() => { void work(); }, { timeout: 30_000 });
    return;
  }
  setTimeout(() => { void work(); }, 0);
}

function isRevisionPointer(value) {
  return [3, POINTER_SCHEMA_VERSION].includes(value?.schemaVersion)
    && value?.kind === POINTER_KIND
    && typeof value?.revisionId === 'string';
}

function normalizedNativeSaveIdentity({ nativeSessionId = null, nativeTileId = null } = {}) {
  return {
    nativeSessionId: typeof nativeSessionId === 'string' && nativeSessionId
      ? nativeSessionId
      : null,
    nativeTileId: typeof nativeTileId === 'string' && nativeTileId
      ? nativeTileId
      : null,
  };
}

function hasNativeSaveIdentity(identity) {
  return Boolean(identity.nativeSessionId || identity.nativeTileId);
}

function lineageMetadata(world, savedAt = null) {
  const network = world?.globalNetwork?.nativeState?.data ?? world?.globalNetwork?.nativeState ?? {};
  const elapsedSeconds = Number.isFinite(Number(world?.elapsedSeconds))
    ? Number(world.elapsedSeconds)
    : 0;
  const wallet = Number.isFinite(Number(world?.wallet))
    ? Number(world.wallet)
    : Number.isFinite(Number(network?.money))
      ? Number(network.money)
      : null;
  return {
    day: Math.floor(Math.max(0, elapsedSeconds) / 86_400) + 1,
    worldTime: Number.isFinite(Number(world?.worldTime)) ? Number(world.worldTime) : Math.floor(elapsedSeconds / 3_600),
    routeCount: Array.isArray(network.routes) ? network.routes.length : null,
    stationCount: Array.isArray(network.stations) ? network.stations.length : null,
    trainCount: Array.isArray(network.trains) ? network.trains.length : null,
    elapsedSeconds,
    wallet,
    money: wallet,
    fare: Number.isFinite(Number(world?.farePolicy?.fare)) ? Number(world.farePolicy.fare) : null,
    savedAt: Number.isFinite(Number(savedAt)) ? Number(savedAt) : null,
  };
}

function sameNativeSave(entry, saveName, identity) {
  if (entry?.saveName !== String(saveName)) return false;
  if (!hasNativeSaveIdentity(identity)) return true;
  return entry.nativeSessionId === identity.nativeSessionId
    && entry.nativeTileId === identity.nativeTileId;
}

/**
 * CAS-shaped adapter that accepts either a Map or API `storage.scoped()`.
 * `financeMode: 'blind'` makes finance absent at this persistence seam;
 * omitted `financeMode` retains the legacy read/write behavior.
 */
export class ModStorageWorldStateAdapter {
  constructor({
    storage = new Map(),
    now = () => Date.now(),
    diagnostics = () => {},
    createRevisionId = defaultRevisionId,
    scheduleMaintenance = scheduleWhenIdle,
    financeMode = 'legacy',
  } = {}) {
    if (!FINANCE_MODES.has(financeMode)) {
      throw new Error(`Unsupported world storage finance mode: ${String(financeMode)}`);
    }
    this.storage = storage;
    this.now = now; this.diagnostics = diagnostics; this.leases = new Map();
    this.createRevisionId = createRevisionId;
    this.scheduleMaintenance = scheduleMaintenance;
    this.financeMode = financeMode;
    this.checkpointIndexes = new Map();
    this.livePointers = new Map();
  }
  #worldKey(worldId) { return `world:${worldId}`; }
  #settlementKey(worldId) { return `world:${worldId}:settlement`; }
  #checkpointIndexKey(worldId) { return `world:${worldId}:save-checkpoints`; }
  #checkpointKey(worldId, checkpointId) { return `world:${worldId}:save-checkpoint:${checkpointId}`; }
  #revisionKey(worldId, revisionId) { return `world:${worldId}:revision:${revisionId}`; }
  async #get(key, fallback = null) {
    const value = await this.storage.get(key, fallback);
    return value == null ? fallback : value;
  }
  async #delete(key) { await this.storage.delete?.(key); }
  #copyFromStorage(value) { return this.storage instanceof Map ? deepCopy(value) : value; }
  #copyToStorage(value) { return this.storage instanceof Map ? deepCopy(value) : value; }
  #financeBlind() { return this.financeMode === 'blind'; }
  #worldForStorage(world) {
    const topologyFree = stripNativeTopologyFromWorld(deepCopy(world));
    return this.#financeBlind() ? stripFinanceFromWorld(topologyFree) : topologyFree;
  }
  #worldFromStorage(world) {
    if (!world) return world;
    const topologyFree = stripNativeTopologyFromWorld(world);
    return this.#financeBlind() ? stripFinanceFromWorld(topologyFree) : topologyFree;
  }

  #applyLiveJournals(world, pointer, settlement) {
    const baseRevisionId = pointer?.revisionId ?? null;
    return this.#applySettlement(world, settlement, baseRevisionId);
  }

  #settlementFromWorld(world) {
    if (!world) return null;
    const sourceWorld = this.#worldForStorage(world);
    const gatewayPositions = Object.fromEntries(Object.entries(sourceWorld.gatewayLedger ?? {}).map(([id, entry]) => [id, {
      atHome: entry.atHome,
      queuedToWork: entry.queuedToWork,
      toWork: entry.toWork,
      atWork: entry.atWork,
      queuedToHome: entry.queuedToHome,
      toHome: entry.toHome,
      transitTrips: entry.transitTrips,
      ...(!this.#financeBlind() ? { fareRevenue: entry.fareRevenue } : {}),
    }]));
    const tileClocks = Object.fromEntries(Object.entries(sourceWorld.tiles ?? {}).map(([id, tile]) => [id, {
      lastSimulatedTime: tile.lastSimulatedTime,
      aggregate: tile.aggregate,
    }]));
    const settlement = {
      schemaVersion: 2,
      baseRevisionId: this.livePointers.get(sourceWorld.worldId)?.revisionId ?? null,
      worldRevision: sourceWorld.revision,
      commuteCatalogBuildHash: sourceWorld.commuteCatalogBuildHash,
      worldTime: sourceWorld.worldTime,
      elapsedSeconds: sourceWorld.elapsedSeconds,
      ...(!this.#financeBlind() ? {
        wallet: sourceWorld.wallet,
        financialHistory: sourceWorld.financialHistory,
        crossTileFinancials: sourceWorld.crossTileFinancials,
        pendingCrossTileAttribution: sourceWorld.pendingCrossTileAttribution,
        backgroundNativeFinance: sourceWorld.backgroundNativeFinance,
      } : {}),
      commuteLastProcessedHour: sourceWorld.commuteLastProcessedHour,
      commuteNextActivityHour: sourceWorld.commuteNextActivityHour,
      gatewayPositions,
      tileClocks,
    };
    return settlement;
  }

  #applySettlement(world, settlement, baseRevisionId = null) {
    const schemaCurrent = settlement?.schemaVersion === 2
      && settlement.baseRevisionId === baseRevisionId;
    const schemaLegacy = settlement?.schemaVersion === 1 && baseRevisionId == null;
    if (!world || (!schemaCurrent && !schemaLegacy)
      || settlement.worldRevision !== world.revision
      || settlement.commuteCatalogBuildHash !== world.commuteCatalogBuildHash
      || !Number.isSafeInteger(settlement.worldTime)
      || settlement.worldTime < world.worldTime) return world;
    world.worldTime = settlement.worldTime;
    world.elapsedSeconds = settlement.elapsedSeconds;
    world.commuteLastProcessedHour = settlement.commuteLastProcessedHour;
    world.commuteNextActivityHour = settlement.commuteNextActivityHour;
    if (!this.#financeBlind()) {
      world.wallet = settlement.wallet;
      world.financialHistory = settlement.financialHistory;
      world.crossTileFinancials = settlement.crossTileFinancials;
      world.pendingCrossTileAttribution = settlement.pendingCrossTileAttribution;
      if (settlement.backgroundNativeFinance) world.backgroundNativeFinance = settlement.backgroundNativeFinance;
    }
    for (const [flowId, position] of Object.entries(settlement.gatewayPositions ?? {})) {
      const entry = world.gatewayLedger?.[flowId];
      if (entry) Object.assign(entry, this.#financeBlind()
        ? stripFinanceFromGatewayPosition(position)
        : position);
    }
    for (const [tileId, clock] of Object.entries(settlement.tileClocks ?? {})) {
      const tile = world.tiles?.[tileId];
      if (tile) {
        tile.lastSimulatedTime = clock.lastSimulatedTime;
        tile.aggregate = this.#financeBlind()
          ? stripFinanceFromAggregate(clock.aggregate)
          : clock.aggregate;
      }
    }
    return this.#worldFromStorage(world);
  }

  async #readCheckpointIndex(worldId, fallback = null) {
    if (this.checkpointIndexes.has(worldId)) return this.checkpointIndexes.get(worldId);
    const index = await this.#get(this.#checkpointIndexKey(worldId), fallback);
    if (index) this.checkpointIndexes.set(worldId, index);
    return index;
  }

  #prepareRevision(world) {
    const sourceWorld = this.#worldForStorage(world);
    const revisionId = this.createRevisionId(world);
    if (typeof revisionId !== 'string' || !revisionId) throw new Error('World revision IDs must be non-empty strings');
    const metadata = lineageMetadata(world, this.now());
    if (this.#financeBlind()) {
      delete metadata.wallet;
      delete metadata.money;
    }
    const pointer = {
      schemaVersion: POINTER_SCHEMA_VERSION,
      kind: POINTER_KIND,
      worldId: sourceWorld.worldId,
      revisionId,
      worldRevision: sourceWorld.revision,
      elapsedSeconds: sourceWorld.elapsedSeconds,
      activeTileId: sourceWorld.activeTileId,
      ...metadata,
    };
    return {
      pointer,
      revision: {
        schemaVersion: REVISION_SCHEMA_VERSION,
        kind: REVISION_KIND,
        worldId: sourceWorld.worldId,
        revisionId,
        world: sourceWorld,
      },
    };
  }

  async #hydrateRevision(worldId, revisionId) {
    const revision = this.#copyFromStorage(await this.#get(this.#revisionKey(worldId, revisionId), null));
    if (revision?.schemaVersion !== REVISION_SCHEMA_VERSION || revision?.kind !== REVISION_KIND
      || revision.worldId !== worldId || revision.revisionId !== revisionId || !revision.world) return null;
    return this.#worldFromStorage(this.#copyFromStorage(revision.world));
  }

  async #loadLiveWorld(worldId) {
    const value = this.#copyFromStorage(await this.#get(this.#worldKey(worldId), null));
    if (!isRevisionPointer(value)) return { world: this.#worldFromStorage(value), pointer: null };
    const world = await this.#hydrateRevision(worldId, value.revisionId);
    if (world) this.livePointers.set(worldId, value);
    return { world, pointer: value };
  }

  #scheduleGarbageCollection(worldId, candidates, retainedIndex, livePointer) {
    const retainedRevisionIds = new Set([
      livePointer?.revisionId,
      ...(retainedIndex?.entries ?? []).map((entry) => entry?.revisionId),
    ].filter(Boolean));
    const obsolete = candidates.filter((candidate) => (
      candidate?.revisionId && !retainedRevisionIds.has(candidate.revisionId)
    ));
    const legacyCheckpointKeys = candidates
      .filter((candidate) => !candidate?.revisionId && candidate?.checkpointId)
      .map((candidate) => this.#checkpointKey(worldId, candidate.checkpointId));
    const keys = [...new Set([
      ...obsolete.map((candidate) => this.#revisionKey(worldId, candidate.revisionId)),
      ...legacyCheckpointKeys,
    ])];
    if (!keys.length) return;
    const work = async () => {
      // Maintenance is deliberately deferred. Re-read the authoritative
      // pointers at execution time because a formerly obsolete revision can
      // become current again while this cleanup is waiting in the idle queue.
      const currentPointer = this.#copyFromStorage(
        await this.#get(this.#worldKey(worldId), null),
      );
      const currentIndex = this.#copyFromStorage(
        await this.#get(this.#checkpointIndexKey(worldId), null),
      );
      const protectedKeys = new Set([
        ...(isRevisionPointer(currentPointer) ? [
          this.#revisionKey(worldId, currentPointer.revisionId),
        ] : []),
        ...(currentIndex?.entries ?? []).flatMap((entry) => entry?.revisionId
          ? [this.#revisionKey(worldId, entry.revisionId)]
          : entry?.checkpointId
            ? [this.#checkpointKey(worldId, entry.checkpointId)]
            : []),
      ]);
      for (const key of keys) {
        if (protectedKeys.has(key)) continue;
        await this.#delete(key);
      }
    };
    if (this.storage instanceof Map) {
      for (const key of keys) {
        this.storage.delete(key);
      }
      return;
    }
    this.scheduleMaintenance(async () => {
      try { await work(); }
      catch (error) {
        this.diagnostics({ phase: 'world-storage-maintenance', status: 'failed', worldId, error: String(error?.message ?? error) });
      }
    });
  }

  #applyFinanceConfiguration(world, candidate) {
    if (this.#financeBlind()) return this.#worldFromStorage(world);
    if (!world || ![1, 2].includes(candidate?.schemaVersion)
      || candidate.worldRevision !== world.revision
      || candidate.commuteCatalogBuildHash !== world.commuteCatalogBuildHash) return world;
    const source = candidate.backgroundNativeFinance;
    if (!source) return world;
    const current = world.backgroundNativeFinance ?? {};
    world.backgroundNativeFinance = {
      ...source,
      lastSettledHour: current.lastSettledHour,
      lastRevenueSettledHour: current.lastRevenueSettledHour,
      lastExpenseSettledHour: current.lastExpenseSettledHour,
      totalRevenue: current.totalRevenue,
      totalExpenses: current.totalExpenses,
      audit: current.audit,
    };
    return world;
  }

  /** Load the live world, or the checkpoint paired with a named native save. */
  async load(worldId, {
    saveName = null,
    allowLiveFallback = false,
    nativeSessionId = null,
    nativeTileId = null,
    loadTraceId = null,
  } = {}) {
    const diagnose = loadTraceId == null
      ? () => {}
      : (segment, details = {}) => this.diagnostics({
        phase: 'authoritative-load',
        loadTraceId,
        segment,
        worldId,
        saveName,
        nativeSessionId,
        nativeTileId,
        allowLiveFallback,
        ...details,
      });
    diagnose('storage-key-lookup-start');
    if (saveName != null) {
      const nativeIdentity = normalizedNativeSaveIdentity({ nativeSessionId, nativeTileId });
      const index = await this.#readCheckpointIndex(worldId, null);
      diagnose('checkpoint-index-read', {
        found: Boolean(index),
        schemaVersion: index?.schemaVersion ?? null,
        entryCount: index?.entries?.length ?? 0,
        nextSequence: index?.nextSequence ?? null,
      });
      if (index) {
        const match = [...(index.entries ?? [])].reverse().find((entry) => (
          sameNativeSave(entry, saveName, nativeIdentity)
        ));
        if (match) {
          diagnose('checkpoint-match-selected', { checkpoint: deepCopy(match) });
          const checkpoint = this.#worldFromStorage(match.revisionId
            ? await this.#hydrateRevision(worldId, match.revisionId)
            : this.#copyFromStorage(
              await this.#get(this.#checkpointKey(worldId, match.checkpointId), null),
            ));
          const { world: liveWorld, pointer: livePointer } = await this.#loadLiveWorld(worldId);
          const settlement = this.#copyFromStorage(
            await this.#get(this.#settlementKey(worldId), null),
          );
          diagnose('checkpoint-payload-read', {
            checkpointFound: Boolean(checkpoint),
            liveWorldFound: Boolean(liveWorld),
            settlementFound: Boolean(settlement),
            checkpointWorldId: checkpoint?.worldId ?? null,
            checkpointRevision: checkpoint?.revision ?? null,
            checkpointTileId: checkpoint?.activeTileId ?? null,
            revisionId: match.revisionId ?? null,
          });
          // Scoped storage writes are individually durable, not transactional.
          // A reload can therefore observe a newly-written index before its
          // checkpoint payload. An explicit lineage alias is sufficient proof
          // that the live world belongs to this native save, so retain the same
          // fallback that is allowed when no checkpoint index exists yet.
          if (!checkpoint) {
            if (!allowLiveFallback) {
              diagnose('checkpoint-payload-missing-rejected');
              return null;
            }
            const fallback = this.#applyLiveJournals(
              liveWorld,
              livePointer,
              settlement,
            );
            diagnose('checkpoint-fallback-live-selected', {
              revision: fallback?.revision ?? null,
              activeTileId: fallback?.activeTileId ?? null,
            });
            return this.#worldFromStorage(fallback);
          }
          const selected = this.#applyFinanceConfiguration(
            this.#applyFinanceConfiguration(checkpoint, this.#settlementFromWorld(liveWorld)),
            settlement,
          );
          diagnose('checkpoint-load-complete', {
            revision: selected?.revision ?? null,
            activeTileId: selected?.activeTileId ?? null,
          });
          return this.#worldFromStorage(selected);
        }
        diagnose('checkpoint-match-missing');
        if (!allowLiveFallback) {
          diagnose('checkpoint-match-missing-rejected');
          return null; // the native save outlived this module's retention window
        }
      }
      // Unversioned prototype state cannot safely be paired with an arbitrary
      // autosave. An explicit session alias is the exception: it proves this
      // tile save belongs to the shared world even before its first checkpoint.
      if (!index && !allowLiveFallback) {
        diagnose('unversioned-world-rejected');
        return null;
      }
    }
    const { world, pointer } = await this.#loadLiveWorld(worldId);
    const settlement = this.#copyFromStorage(await this.#get(this.#settlementKey(worldId), null));
    const selected = this.#applyLiveJournals(world, pointer, settlement);
    diagnose('live-world-load-complete', {
      found: Boolean(selected),
      revision: selected?.revision ?? null,
      activeTileId: selected?.activeTileId ?? null,
      settlementFound: Boolean(settlement),
    });
    return this.#worldFromStorage(selected);
  }
  async save(world) {
    const prepared = this.#prepareRevision(world);
    const previous = this.#copyFromStorage(await this.#get(this.#worldKey(world.worldId), null));
    await this.storage.set(
      this.#revisionKey(world.worldId, prepared.pointer.revisionId),
      this.#copyToStorage(prepared.revision),
    );
    await this.storage.set(this.#worldKey(world.worldId), this.#copyToStorage(prepared.pointer));
    this.livePointers.set(world.worldId, prepared.pointer);
    await this.#delete(this.#settlementKey(world.worldId));
    const index = await this.#readCheckpointIndex(world.worldId, {
      schemaVersion: POINTER_SCHEMA_VERSION, nextSequence: 0, entries: [],
    });
    this.#scheduleGarbageCollection(
      world.worldId,
      isRevisionPointer(previous) ? [previous] : [],
      index,
      prepared.pointer,
    );
  }
  /** Persist only hourly off-tile state. */
  async saveSettlement(world) {
    const settlement = this.#settlementFromWorld(world);
    await this.storage.set(this.#settlementKey(world.worldId), this.#copyToStorage(settlement));
  }
  /** Persist a save-correlated world and prune checkpoint payloads past ten. */
  async saveCheckpoint(world, saveName, {
    nativeSessionId = null,
    nativeTileId = null,
  } = {}) {
    if (typeof saveName !== 'string' || !saveName.trim()) throw new Error('A save name is required for a world checkpoint');
    const performanceStartedAt = this.now();
    let stageStartedAt = performanceStartedAt;
    const performanceStages = {};
    const finishStage = (name) => {
      const finishedAt = this.now();
      performanceStages[name] = Math.max(0, finishedAt - stageStartedAt);
      stageStartedAt = finishedAt;
    };
    const worldId = world.worldId;
    const indexKey = this.#checkpointIndexKey(worldId);
    const current = await this.#readCheckpointIndex(worldId, {
      schemaVersion: POINTER_SCHEMA_VERSION, nextSequence: 0, entries: [],
    });
    finishStage('checkpointIndexRead');
    const nextSequence = (Number.isSafeInteger(current.nextSequence) ? current.nextSequence : 0) + 1;
    const checkpointId = String(nextSequence).padStart(10, '0');
    const nativeIdentity = normalizedNativeSaveIdentity({ nativeSessionId, nativeTileId });
    const prepared = this.#prepareRevision(world);
    const entry = {
      checkpointId,
      saveName,
      worldId,
      ...nativeIdentity,
      elapsedSeconds: world.elapsedSeconds,
      worldRevision: world.revision,
      savedAt: this.now(),
      revisionId: prepared.pointer.revisionId,
    };
    const replaced = (current.entries ?? []).filter((item) => (
      sameNativeSave(item, saveName, nativeIdentity)
    ));
    const retained = (current.entries ?? []).filter((item) => (
      !sameNativeSave(item, saveName, nativeIdentity)
    ));
    retained.push(entry);
    const pruned = retained.splice(0, Math.max(0, retained.length - SAVE_CHECKPOINT_LIMIT));

    await this.storage.set(
      this.#revisionKey(worldId, prepared.pointer.revisionId),
      this.#copyToStorage(prepared.revision),
    );
    finishStage('revisionPayloadWrite');
    const nextIndex = {
      schemaVersion: POINTER_SCHEMA_VERSION,
      nextSequence,
      entries: retained,
    };
    await this.storage.set(indexKey, this.#copyToStorage(nextIndex));
    this.checkpointIndexes.set(worldId, nextIndex);
    finishStage('checkpointIndexWrite');
    const previousLive = this.#copyFromStorage(await this.#get(this.#worldKey(worldId), null));
    await this.storage.set(this.#worldKey(worldId), this.#copyToStorage(prepared.pointer));
    this.livePointers.set(worldId, prepared.pointer);
    finishStage('livePointerWrite');
    this.#scheduleGarbageCollection(
      worldId,
      [previousLive, ...replaced, ...pruned].filter(Boolean),
      nextIndex,
      prepared.pointer,
    );
    finishStage('checkpointCleanup');
    return {
      ...deepCopy(entry),
      performance: {
        milliseconds: Math.max(0, this.now() - performanceStartedAt),
        stages: performanceStages,
      },
    };
  }
  async acquireLease(worldId, transitionId) {
    if (this.leases.has(worldId)) return false;
    this.leases.set(worldId, transitionId); return true;
  }
  async releaseLease(worldId, transitionId) {
    if (this.leases.get(worldId) === transitionId) this.leases.delete(worldId);
  }
  async commit(world, transitionId) {
    if (this.leases.get(world.worldId) !== transitionId) throw new Error('Transition lease is not held');
    await this.save(world);
  }
}
