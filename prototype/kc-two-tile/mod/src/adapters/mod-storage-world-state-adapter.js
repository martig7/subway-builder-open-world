import { deepCopy } from '../world-model.js';

export const SAVE_CHECKPOINT_LIMIT = 10;
const POINTER_SCHEMA_VERSION = 3;
const REVISION_SCHEMA_VERSION = 1;
const POINTER_KIND = 'world-revision-pointer';
const REVISION_KIND = 'world-revision';

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

function stableHash(value) {
  const text = JSON.stringify(value ?? null);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isRevisionPointer(value) {
  return value?.schemaVersion === POINTER_SCHEMA_VERSION
    && value?.kind === POINTER_KIND
    && typeof value?.revisionId === 'string';
}

function assetKeys(refs) {
  if (!refs) return [];
  return [
    refs.globalNetwork?.key,
    ...Object.values(refs.tileSnapshots ?? {}).map((ref) => ref?.key),
    refs.projectionBaseline?.key,
    refs.projectionOverlay?.key,
  ].filter(Boolean);
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

/** CAS-shaped adapter that accepts either a Map or API `storage.scoped()`. */
export class ModStorageWorldStateAdapter {
  constructor({
    storage = new Map(),
    now = () => Date.now(),
    diagnostics = () => {},
    createRevisionId = defaultRevisionId,
    scheduleMaintenance = scheduleWhenIdle,
  } = {}) {
    this.storage = storage; this.now = now; this.diagnostics = diagnostics; this.leases = new Map();
    this.createRevisionId = createRevisionId;
    this.scheduleMaintenance = scheduleMaintenance;
    this.checkpointIndexes = new Map();
    this.livePointers = new Map();
    this.knownAssetKeys = new Set();
  }
  #worldKey(worldId) { return `world:${worldId}`; }
  #settlementKey(worldId) { return `world:${worldId}:settlement`; }
  #checkpointIndexKey(worldId) { return `world:${worldId}:save-checkpoints`; }
  #checkpointKey(worldId, checkpointId) { return `world:${worldId}:save-checkpoint:${checkpointId}`; }
  #revisionKey(worldId, revisionId) { return `world:${worldId}:revision:${revisionId}`; }
  #assetKey(worldId, kind, id) { return `world:${worldId}:asset:${kind}:${encodeURIComponent(id)}`; }
  async #get(key, fallback = null) {
    const value = await this.storage.get(key, fallback);
    return value == null ? fallback : value;
  }
  async #delete(key) { await this.storage.delete?.(key); }
  #copyFromStorage(value) { return this.storage instanceof Map ? deepCopy(value) : value; }
  #copyToStorage(value) { return this.storage instanceof Map ? deepCopy(value) : value; }

  #settlementFromWorld(world) {
    if (!world) return null;
    const gatewayPositions = Object.fromEntries(Object.entries(world.gatewayLedger ?? {}).map(([id, entry]) => [id, {
      atHome: entry.atHome,
      queuedToWork: entry.queuedToWork,
      toWork: entry.toWork,
      atWork: entry.atWork,
      queuedToHome: entry.queuedToHome,
      toHome: entry.toHome,
      transitTrips: entry.transitTrips,
      fareRevenue: entry.fareRevenue,
    }]));
    const tileClocks = Object.fromEntries(Object.entries(world.tiles ?? {}).map(([id, tile]) => [id, {
      lastSimulatedTime: tile.lastSimulatedTime,
      aggregate: tile.aggregate,
    }]));
    return {
      schemaVersion: 2,
      baseRevisionId: this.livePointers.get(world.worldId)?.revisionId ?? null,
      worldRevision: world.revision,
      commuteCatalogBuildHash: world.commuteCatalogBuildHash,
      worldTime: world.worldTime,
      elapsedSeconds: world.elapsedSeconds,
      wallet: world.wallet,
      financialHistory: world.financialHistory,
      commuteLastProcessedHour: world.commuteLastProcessedHour,
      commuteNextActivityHour: world.commuteNextActivityHour,
      crossTileFinancials: world.crossTileFinancials,
      pendingCrossTileAttribution: world.pendingCrossTileAttribution,
      backgroundNativeFinance: world.backgroundNativeFinance,
      gatewayPositions,
      tileClocks,
    };
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
    world.wallet = settlement.wallet;
    world.financialHistory = settlement.financialHistory;
    world.commuteLastProcessedHour = settlement.commuteLastProcessedHour;
    world.commuteNextActivityHour = settlement.commuteNextActivityHour;
    world.crossTileFinancials = settlement.crossTileFinancials;
    world.pendingCrossTileAttribution = settlement.pendingCrossTileAttribution;
    if (settlement.backgroundNativeFinance) world.backgroundNativeFinance = settlement.backgroundNativeFinance;
    for (const [flowId, position] of Object.entries(settlement.gatewayPositions ?? {})) {
      const entry = world.gatewayLedger?.[flowId];
      if (entry) Object.assign(entry, position);
    }
    for (const [tileId, clock] of Object.entries(settlement.tileClocks ?? {})) {
      const tile = world.tiles?.[tileId];
      if (tile) {
        tile.lastSimulatedTime = clock.lastSimulatedTime;
        tile.aggregate = clock.aggregate;
      }
    }
    return world;
  }

  async #readCheckpointIndex(worldId, fallback = null) {
    if (this.checkpointIndexes.has(worldId)) return this.checkpointIndexes.get(worldId);
    const index = await this.#get(this.#checkpointIndexKey(worldId), fallback);
    if (index) this.checkpointIndexes.set(worldId, index);
    return index;
  }

  #assetRef(worldId, kind, id) {
    const normalized = String(id);
    return { kind, id: normalized, key: this.#assetKey(worldId, kind, normalized) };
  }

  #prepareRevision(world) {
    const revisionId = this.createRevisionId(world);
    if (typeof revisionId !== 'string' || !revisionId) throw new Error('World revision IDs must be non-empty strings');
    const refs = { globalNetwork: null, tileSnapshots: {}, projectionBaseline: null, projectionOverlay: null };
    const assets = [];
    const core = {
      ...world,
      globalNetwork: world.globalNetwork ? { ...world.globalNetwork, nativeState: undefined } : world.globalNetwork,
      tiles: Object.fromEntries(Object.entries(world.tiles ?? {}).map(([tileId, tile]) => {
        const snapshot = tile?.snapshot;
        if (snapshot != null) {
          const snapshotId = snapshot.id ?? stableHash(snapshot);
          const ref = this.#assetRef(world.worldId, `tile-${tileId}`, snapshotId);
          refs.tileSnapshots[tileId] = ref;
          assets.push({ ref, value: snapshot });
        }
        return [tileId, { ...tile, snapshot: undefined }];
      })),
      activeProjection: world.activeProjection
        ? { ...world.activeProjection, baselineState: undefined }
        : world.activeProjection,
      projectionOverlay: undefined,
    };
    if (world.globalNetwork?.nativeState != null) {
      const ref = this.#assetRef(
        world.worldId,
        'global-network',
        world.globalNetwork.hash ?? stableHash(world.globalNetwork.nativeState),
      );
      refs.globalNetwork = ref;
      assets.push({ ref, value: world.globalNetwork.nativeState });
    }
    if (world.activeProjection?.baselineState != null) {
      const ref = this.#assetRef(
        world.worldId,
        'projection-baseline',
        world.activeProjection.projectionHash ?? stableHash(world.activeProjection.baselineState),
      );
      refs.projectionBaseline = ref;
      assets.push({ ref, value: world.activeProjection.baselineState });
    }
    if (world.projectionOverlay != null) {
      const ref = this.#assetRef(
        world.worldId,
        'projection-overlay',
        world.activeProjection?.projectionHash ?? stableHash(world.projectionOverlay),
      );
      refs.projectionOverlay = ref;
      assets.push({ ref, value: world.projectionOverlay });
    }
    const pointer = {
      schemaVersion: POINTER_SCHEMA_VERSION,
      kind: POINTER_KIND,
      worldId: world.worldId,
      revisionId,
      worldRevision: world.revision,
      elapsedSeconds: world.elapsedSeconds,
      activeTileId: world.activeTileId,
      ...lineageMetadata(world, this.now()),
      assetRefs: refs,
    };
    return {
      pointer,
      revision: {
        schemaVersion: REVISION_SCHEMA_VERSION,
        kind: REVISION_KIND,
        worldId: world.worldId,
        revisionId,
        world: core,
        assetRefs: refs,
      },
      assets,
    };
  }

  async #writeRevisionAssets(assets) {
    const pending = assets.filter(({ ref }) => !this.knownAssetKeys.has(ref.key));
    // API scoped storage persists one shared JSON document per mutation. Two
    // concurrent sets can both read the same prior document and leave only the
    // last writer's key. Preserve immutable-asset reuse, but commit new assets
    // serially so every mutation starts from the preceding durable result.
    for (const { ref, value } of pending) {
      await this.storage.set(ref.key, this.#copyToStorage(value));
      this.knownAssetKeys.add(ref.key);
    }
  }

  async #hydrateRevision(worldId, revisionId) {
    const revision = this.#copyFromStorage(await this.#get(this.#revisionKey(worldId, revisionId), null));
    if (revision?.schemaVersion !== REVISION_SCHEMA_VERSION || revision?.kind !== REVISION_KIND
      || revision.worldId !== worldId || revision.revisionId !== revisionId || !revision.world) return null;
    const refs = revision.assetRefs ?? {};
    const requested = assetKeys(refs);
    const loaded = await Promise.all(requested.map((key) => this.#get(key, null)));
    if (loaded.some((value) => value == null)) return null;
    const assets = new Map(requested.map((key, index) => [key, this.#copyFromStorage(loaded[index])]));
    for (const key of requested) this.knownAssetKeys.add(key);
    const world = this.#copyFromStorage(revision.world);
    if (refs.globalNetwork) {
      world.globalNetwork = { ...(world.globalNetwork ?? {}), nativeState: assets.get(refs.globalNetwork.key) };
    }
    for (const [tileId, ref] of Object.entries(refs.tileSnapshots ?? {})) {
      if (world.tiles?.[tileId]) world.tiles[tileId].snapshot = assets.get(ref.key);
    }
    if (refs.projectionBaseline && world.activeProjection) {
      world.activeProjection.baselineState = assets.get(refs.projectionBaseline.key);
    }
    if (refs.projectionOverlay) world.projectionOverlay = assets.get(refs.projectionOverlay.key);
    return world;
  }

  async #loadLiveWorld(worldId) {
    const value = this.#copyFromStorage(await this.#get(this.#worldKey(worldId), null));
    if (!isRevisionPointer(value)) return { world: value, pointer: null };
    const world = await this.#hydrateRevision(worldId, value.revisionId);
    if (world) this.livePointers.set(worldId, value);
    return { world, pointer: value };
  }

  #scheduleGarbageCollection(worldId, candidates, retainedIndex, livePointer) {
    const retainedRevisionIds = new Set([
      livePointer?.revisionId,
      ...(retainedIndex?.entries ?? []).map((entry) => entry?.revisionId),
    ].filter(Boolean));
    const retainedAssets = new Set([
      ...assetKeys(livePointer?.assetRefs),
      ...(retainedIndex?.entries ?? []).flatMap((entry) => assetKeys(entry?.assetRefs)),
    ]);
    const obsolete = candidates.filter((candidate) => (
      candidate?.revisionId && !retainedRevisionIds.has(candidate.revisionId)
    ));
    const legacyCheckpointKeys = candidates
      .filter((candidate) => !candidate?.revisionId && candidate?.checkpointId)
      .map((candidate) => this.#checkpointKey(worldId, candidate.checkpointId));
    const keys = [...new Set([
      ...obsolete.flatMap((candidate) => [
        this.#revisionKey(worldId, candidate.revisionId),
        ...assetKeys(candidate.assetRefs).filter((key) => !retainedAssets.has(key)),
      ]),
      ...legacyCheckpointKeys,
    ])];
    if (!keys.length) return;
    const work = async () => {
      // Maintenance is deliberately deferred. Re-read the authoritative
      // pointers at execution time because an A -> B -> A save sequence can
      // make a formerly obsolete immutable asset current again while this
      // cleanup is waiting in the idle queue.
      const currentPointer = this.#copyFromStorage(
        await this.#get(this.#worldKey(worldId), null),
      );
      const currentIndex = this.#copyFromStorage(
        await this.#get(this.#checkpointIndexKey(worldId), null),
      );
      const protectedKeys = new Set([
        ...(isRevisionPointer(currentPointer) ? [
          this.#revisionKey(worldId, currentPointer.revisionId),
          ...assetKeys(currentPointer.assetRefs),
        ] : []),
        ...(currentIndex?.entries ?? []).flatMap((entry) => entry?.revisionId
          ? [this.#revisionKey(worldId, entry.revisionId), ...assetKeys(entry.assetRefs)]
          : entry?.checkpointId
            ? [this.#checkpointKey(worldId, entry.checkpointId)]
            : []),
      ]);
      for (const key of keys) {
        if (protectedKeys.has(key)) continue;
        await this.#delete(key);
        this.knownAssetKeys.delete(key);
      }
    };
    if (this.storage instanceof Map) {
      for (const key of keys) {
        this.storage.delete(key);
        this.knownAssetKeys.delete(key);
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
          const checkpoint = match.revisionId
            ? await this.#hydrateRevision(worldId, match.revisionId)
            : this.#copyFromStorage(
              await this.#get(this.#checkpointKey(worldId, match.checkpointId), null),
            );
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
            const fallback = this.#applySettlement(liveWorld, settlement, livePointer?.revisionId ?? null);
            diagnose('checkpoint-fallback-live-selected', {
              revision: fallback?.revision ?? null,
              activeTileId: fallback?.activeTileId ?? null,
            });
            return fallback;
          }
          const selected = this.#applyFinanceConfiguration(
            this.#applyFinanceConfiguration(checkpoint, this.#settlementFromWorld(liveWorld)),
            settlement,
          );
          diagnose('checkpoint-load-complete', {
            revision: selected?.revision ?? null,
            activeTileId: selected?.activeTileId ?? null,
          });
          return selected;
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
    const selected = this.#applySettlement(world, settlement, pointer?.revisionId ?? null);
    diagnose('live-world-load-complete', {
      found: Boolean(selected),
      revision: selected?.revision ?? null,
      activeTileId: selected?.activeTileId ?? null,
      settlementFound: Boolean(settlement),
    });
    return selected;
  }
  /** Read the compact lineage metadata without hydrating its native assets. */
  async readLineageMetadata(worldId) {
    if (typeof worldId !== 'string' || !worldId) return null;
    const value = this.#copyFromStorage(await this.#get(this.#worldKey(worldId), null));
    if (!value) return null;
    if (isRevisionPointer(value)) {
      const metadata = {
        worldId,
        day: Number.isFinite(Number(value.day)) ? Number(value.day) : null,
        worldTime: Number.isFinite(Number(value.worldTime)) ? Number(value.worldTime) : null,
        routeCount: Number.isFinite(Number(value.routeCount)) ? Number(value.routeCount) : null,
        stationCount: Number.isFinite(Number(value.stationCount)) ? Number(value.stationCount) : null,
        trainCount: Number.isFinite(Number(value.trainCount)) ? Number(value.trainCount) : null,
        elapsedSeconds: Number.isFinite(Number(value.elapsedSeconds)) ? Number(value.elapsedSeconds) : null,
        wallet: Number.isFinite(Number(value.wallet)) ? Number(value.wallet) : null,
        money: Number.isFinite(Number(value.money)) ? Number(value.money) : null,
        fare: Number.isFinite(Number(value.fare)) ? Number(value.fare) : null,
        savedAt: Number.isFinite(Number(value.savedAt)) ? Number(value.savedAt) : null,
      };
      if (metadata.routeCount != null && metadata.stationCount != null && metadata.trainCount != null) return metadata;
      const revision = await this.#get(this.#revisionKey(worldId, value.revisionId), null);
      const networkRef = value.assetRefs?.globalNetwork ?? revision?.assetRefs?.globalNetwork;
      const networkAsset = networkRef?.key ? await this.#get(networkRef.key, null) : null;
      const network = networkAsset?.data ?? networkAsset;
      return {
        ...metadata,
        routeCount: metadata.routeCount ?? (Array.isArray(network?.routes) ? network.routes.length : null),
        stationCount: metadata.stationCount ?? (Array.isArray(network?.stations) ? network.stations.length : null),
        trainCount: metadata.trainCount ?? (Array.isArray(network?.trains) ? network.trains.length : null),
      };
    }
    return { worldId, ...lineageMetadata(value, value.savedAt) };
  }
  async save(world) {
    const prepared = this.#prepareRevision(world);
    const previous = this.#copyFromStorage(await this.#get(this.#worldKey(world.worldId), null));
    await this.#writeRevisionAssets(prepared.assets);
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
  /** Persist only hourly state; opaque native tile snapshots stay in the base world. */
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
      assetRefs: prepared.pointer.assetRefs,
    };
    const replaced = (current.entries ?? []).filter((item) => (
      sameNativeSave(item, saveName, nativeIdentity)
    ));
    const retained = (current.entries ?? []).filter((item) => (
      !sameNativeSave(item, saveName, nativeIdentity)
    ));
    retained.push(entry);
    const pruned = retained.splice(0, Math.max(0, retained.length - SAVE_CHECKPOINT_LIMIT));

    await this.#writeRevisionAssets(prepared.assets);
    finishStage('revisionAssetsWrite');
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
