import { deepCopy } from '../world-model.js';

export const SAVE_CHECKPOINT_LIMIT = 10;

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

function sameNativeSave(entry, saveName, identity) {
  if (entry?.saveName !== String(saveName)) return false;
  if (!hasNativeSaveIdentity(identity)) return true;
  return entry.nativeSessionId === identity.nativeSessionId
    && entry.nativeTileId === identity.nativeTileId;
}

/** CAS-shaped adapter that accepts either a Map or API `storage.scoped()`. */
export class ModStorageWorldStateAdapter {
  constructor({ storage = new Map(), now = () => Date.now(), diagnostics = () => {} } = {}) {
    this.storage = storage; this.now = now; this.diagnostics = diagnostics; this.leases = new Map();
  }
  #worldKey(worldId) { return `world:${worldId}`; }
  #settlementKey(worldId) { return `world:${worldId}:settlement`; }
  #checkpointIndexKey(worldId) { return `world:${worldId}:save-checkpoints`; }
  #checkpointKey(worldId, checkpointId) { return `world:${worldId}:save-checkpoint:${checkpointId}`; }
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
      schemaVersion: 1,
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

  #applySettlement(world, settlement) {
    if (!world || settlement?.schemaVersion !== 1
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

  #applyFinanceConfiguration(world, candidate) {
    if (!world || candidate?.schemaVersion !== 1
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
      const index = await this.#get(this.#checkpointIndexKey(worldId), null);
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
          const checkpoint = this.#copyFromStorage(
            await this.#get(this.#checkpointKey(worldId, match.checkpointId), null),
          );
          const liveWorld = this.#copyFromStorage(await this.#get(this.#worldKey(worldId), null));
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
            const fallback = this.#applySettlement(liveWorld, settlement);
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
    const value = await this.#get(this.#worldKey(worldId), null);
    // The native mod-storage bridge has already deserialized a private value.
    // Copy Maps used by tests, but never clone a 400+ MB IPC result a second time.
    const world = this.#copyFromStorage(value);
    const settlement = this.#copyFromStorage(await this.#get(this.#settlementKey(worldId), null));
    const selected = this.#applySettlement(world, settlement);
    diagnose('live-world-load-complete', {
      found: Boolean(selected),
      revision: selected?.revision ?? null,
      activeTileId: selected?.activeTileId ?? null,
      settlementFound: Boolean(settlement),
    });
    return selected;
  }
  async save(world) {
    await this.storage.set(this.#worldKey(world.worldId), this.#copyToStorage(world));
    await this.#delete(this.#settlementKey(world.worldId));
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
    const worldId = world.worldId;
    const indexKey = this.#checkpointIndexKey(worldId);
    const current = await this.#get(indexKey, { schemaVersion: 1, nextSequence: 0, entries: [] });
    const nextSequence = (Number.isSafeInteger(current.nextSequence) ? current.nextSequence : 0) + 1;
    const checkpointId = String(nextSequence).padStart(10, '0');
    const nativeIdentity = normalizedNativeSaveIdentity({ nativeSessionId, nativeTileId });
    const entry = {
      checkpointId,
      saveName,
      worldId,
      ...nativeIdentity,
      elapsedSeconds: world.elapsedSeconds,
      worldRevision: world.revision,
      savedAt: this.now(),
    };
    const replaced = (current.entries ?? []).filter((item) => (
      sameNativeSave(item, saveName, nativeIdentity)
    ));
    const retained = (current.entries ?? []).filter((item) => (
      !sameNativeSave(item, saveName, nativeIdentity)
    ));
    retained.push(entry);
    const pruned = retained.splice(0, Math.max(0, retained.length - SAVE_CHECKPOINT_LIMIT));

    await this.storage.set(this.#checkpointKey(worldId, checkpointId), this.#copyToStorage(world));
    await this.storage.set(indexKey, { schemaVersion: 2, nextSequence, entries: retained });
    for (const old of [...replaced, ...pruned]) await this.#delete(this.#checkpointKey(worldId, old.checkpointId));
    return deepCopy(entry);
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
