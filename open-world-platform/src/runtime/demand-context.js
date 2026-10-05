import { DemandExtensionStore, DEMAND_CHECKPOINT_FIELD, normalizeDemandExtension, remapDemandExtension,
  sameDemandExtensionScalars } from './demand-extension-state.js';

export const DEMAND_CONTEXT_VERSION = 1;
export const DEMAND_CONTEXT_EVENT = 'subway-builder-open-world-demand-context';
const CONTEXT_KEYS = ['providerId', 'resolvedWorldId', 'nativeSessionId', 'tileId', 'epoch'];

export function demandContextRegistry(root = globalThis) {
  if (root.SubwayBuilderOpenWorldDemand?.version === 1) return root.SubwayBuilderOpenWorldDemand;
  const providers = new Map(), listeners = new Set(), handoffs = new Map();
  let generation = 0;
  const notify = () => {
    for (const listener of [...listeners]) { try { listener(); } catch (error) { console.warn('[OpenWorld] demand context listener failed', error); } }
    if (root.dispatchEvent && root.Event) root.dispatchEvent(new root.Event(DEMAND_CONTEXT_EVENT));
  };
  const current = expected => {
    const provider = providers.get(expected?.providerId);
    if (!provider || provider.generation !== expected.providerGeneration) throw new Error('Demand provider was replaced');
    return provider;
  };
  const registry = Object.freeze({
    version: 1,
    getContext() {
      for (const id of [...providers.keys()].sort()) {
        const provider = providers.get(id), context = provider.getContext();
        if (context) return Object.freeze({ ...context, providerGeneration: provider.generation });
      }
      return null;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    readState(extensionId, expected) { return current(expected).readState(extensionId, expected); },
    runMutation(extensionId, expected, mutation) {
      const provider = current(expected);
      return Promise.resolve(provider.runMutation(extensionId, expected, mutation))
        .then(context => Object.freeze({ ...context, providerGeneration: provider.generation }));
    },
    commitState(extensionId, expected, payload) {
      return registry.runMutation(extensionId, expected, {
        mutationId: payload.mutationId ?? root.crypto.randomUUID(), apply: () => payload,
      });
    },
    register(providerId, provider) {
      const previous = providers.get(providerId);
      if (previous && previous.source !== provider) {
        provider.acceptHandoff?.(previous.exportHandoff?.());
        previous.dispose?.();
      } else if (!previous) provider.acceptHandoff?.(handoffs.get(providerId));
      handoffs.delete(providerId);
      const token = { ...provider, source: provider, generation: ++generation };
      providers.set(providerId, token); notify();
      return {
        refresh() { if (providers.get(providerId) === token) notify(); },
        dispose() {
          if (providers.get(providerId) === token) {
            const handoff = token.exportHandoff?.();
            if (handoff) handoffs.set(providerId, handoff);
            providers.delete(providerId); token.dispose?.(); notify();
          }
        },
      };
    },
  });
  root.SubwayBuilderOpenWorldDemand = registry;
  return registry;
}

/** Owns sparse durable demand state; native saves reference immutable manifests. */
export function createDemandExtensionRuntime({ api, game, storage, readContext,
  onChanged = () => {}, onError = error => console.error('[OpenWorld] demand persistence failed', error),
  createId = () => globalThis.crypto.randomUUID() }) {
  const store = new DemandExtensionStore({ storage, createId });
  let checkpoint = null, hydratedTile = null, busy = false, failure = null, pending = null;
  let serial = Promise.resolve(), activationGeneration = 0, disposed = false, handoff = null;
  const records = new Map(), saveHolds = new Set();
  const state = () => game.callbacks.getState();
  const getContext = () => {
    if (disposed) return null;
    const context = readContext();
    if (!context) return null;
    return Object.freeze({ ...context, version: 1,
      demandRevision: checkpoint?.worldId === context.resolvedWorldId ? checkpoint.tiles[context.tileId]?.revision ?? 0 : 0,
      demandReady: Boolean(context.demandReady && checkpoint?.worldId === context.resolvedWorldId
        && hydratedTile === context.tileId && !busy && !failure
        && ![...saveHolds].some(identity => CONTEXT_KEYS.every(key => identity[key] === context[key]))),
    });
  };
  const matches = (expected, revision = true) => {
    const context = getContext();
    if (!context || CONTEXT_KEYS.some(key => expected?.[key] !== context[key])
      || (revision && expected?.demandRevision !== context.demandRevision)) throw new Error('Demand context changed; discard the stale mutation');
    return context;
  };
  const keyFor = (tileId, extensionId) => `${tileId}\u0000${extensionId}`;
  const readRecord = async (tileId, extensionId) => {
    const key = keyFor(tileId, extensionId);
    if (!records.has(key)) {
      const owner = checkpoint, generation = activationGeneration;
      const reference = checkpoint?.tiles[tileId]?.extensions[extensionId];
      const record = reference ? await store.readRecord(reference) : null;
      if (owner !== checkpoint || generation !== activationGeneration) throw new Error('Demand extension checkpoint changed during read');
      records.set(key, record);
    }
    return records.get(key);
  };
  const stamp = marker => {
    const current = state();
    if (typeof current.setFinancialHistory !== 'function') throw new Error('Native demand checkpoint marker cannot be saved');
    current.setFinancialHistory({ ...(current.financialHistory ?? {}), [DEMAND_CHECKPOINT_FIELD]: marker });
  };
  const publish = () => onChanged(getContext());
  const fail = error => {
    failure = error; busy = false;
    const context = readContext();
    if (!disposed && (!pending || (context && CONTEXT_KEYS.every(key => context[key] === pending.expected[key])))) state().setTimeConfig?.({ paused: true });
    publish(); onError(error);
  };
  const persist = async operation => {
    const result = await store.commit(checkpoint, operation.tileId, operation.extensionId,
      operation.payload, operation.mutationId, operation.receipts, { demandChanged: operation.demandChanged });
    // Persisting an obsolete World must never stamp the newly loaded native save.
    matches(operation.expected, false);
    checkpoint = result.checkpoint;
    records.set(keyFor(operation.tileId, operation.extensionId), { ...operation.payload, receipts: result.receipts });
    stamp(result.marker);
    pending = null; busy = false; failure = null;
    publish();
    return getContext();
  };
  const capture = operation => {
    // Capture the result before validation: retrying malformed output must never
    // execute a successful native edit twice. A throwing editor may be retried
    // after its caller has rolled back the supported API mutation.
    if (!Object.hasOwn(operation, 'rawPayload')) {
      operation.rawPayload = operation.apply();
      operation.nativeDemand = api.gameState.getDemandData();
    }
    operation.payload = normalizeDemandExtension(operation.rawPayload);
    operation.demandChanged = !sameDemandExtensionScalars(operation.payload, operation.previousDemand);
    operation.apply = null;
  };
  const execute = operation => {
    busy = true; failure = null; publish();
    try { if (!operation.payload) capture(operation); }
    catch (error) { fail(error); return Promise.reject(error); }
    serial = persist(operation).catch(error => { fail(error); throw error; });
    return serial;
  };
  const runtime = {
    getContext,
    async readState(extensionId, expected) {
      const context = matches(expected);
      if (!context.demandReady) throw new Error('Native demand is not ready');
      const record = await readRecord(context.tileId, extensionId);
      matches(expected);
      return record?.ledger ?? null;
    },
    runMutation(extensionId, expected, { mutationId, apply }) {
      if (typeof extensionId !== 'string' || !extensionId || typeof mutationId !== 'string' || !mutationId
        || typeof apply !== 'function') return Promise.reject(new Error('Invalid demand mutation'));
      try { matches(expected, false); } catch (error) { return Promise.reject(error); }
      if (pending?.mutationId === mutationId && pending.extensionId === extensionId) {
        if (busy) return serial;
        return execute(pending);
      }
      const record = records.get(keyFor(expected.tileId, extensionId));
      if (record?.receipts?.includes(mutationId)) return Promise.resolve(getContext());
      let context;
      try {
        context = matches(expected);
        if (!context.demandReady || busy || failure) throw new Error('Native demand is not ready for mutations');
        pending = { expected, tileId: context.tileId, extensionId, mutationId, apply, receipts: record?.receipts ?? [],
          previousDemand: record,
          nativeDemand: api.gameState.getDemandData(),
          nativeMarker: structuredClone(state().financialHistory?.[DEMAND_CHECKPOINT_FIELD] ?? null) };
      } catch (error) {
        return Promise.reject(error);
      }
      return execute(pending);
    },
    async activate({ worldId, tileId }) {
      const generation = ++activationGeneration;
      saveHolds.clear();
      const context = readContext();
      const identity = context && Object.fromEntries(CONTEXT_KEYS.map(key => [key, context[key]]));
      const marker = state().financialHistory?.[DEMAND_CHECKPOINT_FIELD];
      const assertCurrent = () => {
        if (generation !== activationGeneration) throw new Error('Demand activation was superseded');
        if (!identity || identity.resolvedWorldId !== worldId || identity.tileId !== tileId) throw new Error('Demand activation does not match the native World');
        matches(identity, false);
      };
      busy = true; hydratedTile = null; failure = null; publish();
      await serial.catch(() => {});
      try {
        assertCurrent();
        const takeover = handoff; handoff = null;
        if (takeover) {
          await takeover.settled;
          assertCurrent();
        }
        // A hot reload keeps the live native object. A real save load replaces
        // it, even when World/session/tile IDs happen to be identical.
        const takeoverMatches = takeover?.operation && takeover.operation.nativeDemand === api.gameState.getDemandData()
          && ['resolvedWorldId', 'nativeSessionId', 'tileId'].every(key => identity[key] === takeover.operation.expected[key])
          && JSON.stringify(marker ?? null) === JSON.stringify(takeover.operation.nativeMarker ?? null);
        let restoredCheckpoint;
        if (takeoverMatches) {
          const operation = takeover.operation;
          if (!Object.hasOwn(operation, 'rawPayload')) throw new Error('Uncaptured native demand mutation cannot survive a hot reload');
          const result = await store.commit(takeover.checkpoint, tileId, operation.extensionId,
            normalizeDemandExtension(operation.rawPayload), operation.mutationId, operation.receipts,
            { demandChanged: operation.demandChanged });
          assertCurrent(); stamp(result.marker); restoredCheckpoint = result.checkpoint;
        } else restoredCheckpoint = await store.readCheckpoint(marker, worldId);
        assertCurrent();
        const restoredRecords = new Map();
        const ids = Object.keys(restoredCheckpoint.tiles[tileId]?.extensions ?? {});
        for (const extensionId of ids) {
          const record = await store.readRecord(restoredCheckpoint.tiles[tileId].extensions[extensionId]);
          assertCurrent();
          const remaps = new Map();
          let demand = api.gameState.getDemandData();
          if (!demand || !api.demand) throw new Error('The supported demand editor is unavailable during restoration');
          for (const point of record.points) if (!demand.points.has(point.id)) {
            assertCurrent();
            const added = api.demand.addDemandPoint(point);
            if (!added.success) throw new Error(added.error);
          }
          demand = api.gameState.getDemandData();
          const missing = record.pops.filter(pop => !demand.popsMap.has(pop.id));
          if (missing.length) {
            assertCurrent();
            const added = api.demand.addPops(missing.map(({ residenceId, jobId, size, drivingSeconds, drivingDistance }) =>
              ({ residenceId, jobId, size, drivingSeconds, drivingDistance })));
            if (!added.success || added.popIds.length !== missing.length) throw new Error(added.error ?? 'Demand restoration returned incomplete IDs');
            missing.forEach((pop, index) => remaps.set(pop.id, added.popIds[index]));
          }
          if (remaps.size) {
            const payload = remapDemandExtension(record, remaps);
            demand = api.gameState.getDemandData();
            // The supported editor regenerates departure times. Persist its
            // actual scalar pop records so inactive routing matches live demand.
            payload.pops = payload.pops.map(pop => ({ ...pop, ...demand.popsMap.get(pop.id), id: pop.id }));
            const result = await store.commit(restoredCheckpoint, tileId, extensionId, normalizeDemandExtension(payload), `restore:${createId()}`, record.receipts);
            assertCurrent();
            restoredCheckpoint = result.checkpoint; stamp(result.marker);
            restoredRecords.set(keyFor(tileId, extensionId), { ...normalizeDemandExtension(payload), receipts: result.receipts });
          } else restoredRecords.set(keyFor(tileId, extensionId), record);
        }
        assertCurrent();
        checkpoint = restoredCheckpoint;
        records.clear(); for (const [key, record] of restoredRecords) records.set(key, record);
        pending = null; failure = null;
        serial = Promise.resolve();
        hydratedTile = tileId; busy = false; publish();
      } catch (error) {
        // Obsolete activation must neither pause nor clobber the new session.
        if (generation === activationGeneration && identity
          && CONTEXT_KEYS.every(key => readContext()?.[key] === identity[key])) fail(error);
        throw error;
      }
    },
    async extensionsFor(tileId) {
      const owner = checkpoint, generation = activationGeneration;
      const ids = Object.keys(checkpoint?.tiles[tileId]?.extensions ?? {});
      // Retain only the active roster. Inactive payloads live for one worker
      // request rather than accumulating with every visited World tile.
      const result = await Promise.all(ids.map(id => tileId === hydratedTile
        ? readRecord(tileId, id) : store.readRecord(owner.tiles[tileId].extensions[id])));
      if (owner !== checkpoint || generation !== activationGeneration) throw new Error('Demand extension checkpoint changed during read');
      return result;
    },
    revisionFor(tileId) { return checkpoint?.tiles[tileId]?.revision ?? 0; },
    cacheKeyFor(tileId) {
      const tile = checkpoint?.tiles[tileId];
      if (tile && Object.hasOwn(tile, 'routingKey')) return tile.routingKey;
      const references = tile?.extensions;
      return references && Object.keys(references).length ? JSON.stringify(references) : null;
    },
    assertSaveReady() {
      if (disposed) return;
      const context = readContext();
      if (context && (busy || failure || hydratedTile !== context.tileId
        || checkpoint?.worldId !== context.resolvedWorldId)) throw new Error('Save deferred until the demand mutation is durable');
    },
    beginNativeSave() {
      const context = disposed ? null : readContext();
      if (!context) return () => {};
      runtime.assertSaveReady();
      const identity = Object.fromEntries(CONTEXT_KEYS.map(key => [key, context[key]]));
      saveHolds.add(identity); publish();
      return () => { if (saveHolds.delete(identity) && !disposed) publish(); };
    },
    refresh: publish,
    flush() { return serial; },
    exportHandoff() {
      return pending ? { operation: pending, checkpoint, settled: serial.catch(() => {}) } : handoff;
    },
    acceptHandoff(value) { handoff = value ?? null; },
    dispose() { disposed = true; activationGeneration++; saveHolds.clear(); },
    snapshot() { return { hydratedTile, busy, error: failure?.message ?? null, worldId: checkpoint?.worldId ?? null }; },
  };
  return runtime;
}
