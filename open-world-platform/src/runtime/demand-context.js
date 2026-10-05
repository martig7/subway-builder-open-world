import { DemandExtensionStore, DEMAND_CHECKPOINT_FIELD, normalizeDemandExtension, remapDemandExtension,
  sameDemandExtensionScalars } from './demand-extension-state.js';

export const DEMAND_CONTEXT_VERSION = 1;
export const DEMAND_CONTEXT_EVENT = 'subway-builder-open-world-demand-context';
export const DEMAND_DEFERRED_CODE = 'OPEN_WORLD_DEMAND_DEFERRED';
export const DEMAND_DAY_EVENTS_VERSION = 1;
const CONTEXT_KEYS = ['providerId', 'resolvedWorldId', 'nativeSessionId', 'tileId', 'epoch'];
const DAY_CONTEXT_KEYS = [...CONTEXT_KEYS, 'definitionId', 'cityCode', 'providerGeneration'];
const DAY_PROVIDER_OWNER = Symbol('open-world.demand-day-provider');
const samePop = (a, b) => Boolean(a && b && ['id', 'residenceId', 'jobId', 'size', 'drivingSeconds',
  'drivingDistance', 'homeDepartureTime', 'workDepartureTime'].every(key => a[key] === b[key]));
const samePoint = (a, b) => Boolean(a && b && a.id === b.id && a.location?.[0] === b.location?.[0] && a.location?.[1] === b.location?.[1]);

export function demandContextRegistry(root = globalThis) {
  const existing = root.SubwayBuilderOpenWorldDemand;
  if (existing?.version === 1 && existing.dayEventsVersion === DEMAND_DAY_EVENTS_VERSION
    && typeof existing.subscribeDayChange === 'function') return existing;
  // An older frozen v1 registry may own an in-flight checkpoint or handoff.
  // Delegate its methods so upgrade preserves those closures and generations.
  const base = existing?.version === 1 ? existing : createDemandContextRegistry(root);
  const listeners = new Set(), wrappedProviders = new WeakMap();
  const getContext = () => {
    const context = base.getContext();
    if (!context) return null;
    const publicContext = { ...context };
    delete publicContext[DAY_PROVIDER_OWNER];
    return Object.freeze(publicContext);
  };
  const registry = Object.freeze({
    ...base, getContext, dayEventsVersion: DEMAND_DAY_EVENTS_VERSION,
    subscribeDayChange(listener) {
      if (typeof listener !== 'function') throw new TypeError('Expected a demand day listener');
      listeners.add(listener); return () => listeners.delete(listener);
    },
    register(providerId, provider) {
      let wrapped = wrappedProviders.get(provider);
      if (!wrapped) {
        wrapped = { owner: null, provider: { ...provider, getContext() {
          const context = provider.getContext();
          return context ? { ...context, [DAY_PROVIDER_OWNER]: wrapped.owner } : null;
        } } };
        wrappedProviders.set(provider, wrapped);
      }
      const owner = wrapped.owner = {};
      const handle = base.register(providerId, wrapped.provider);
      const owns = expected => {
        const current = base.getContext();
        return current?.[DAY_PROVIDER_OWNER] === owner && expected
          && DAY_CONTEXT_KEYS.every(key => expected[key] === current[key]);
      };
      return Object.freeze({ ...handle,
        async publishDayChange(day, expected = getContext()) {
          const result = { day, status: 'published', delivered: 0, failed: 0 };
          if (!Number.isSafeInteger(day) || day < 0) return { ...result, status: 'invalid' };
          for (const listener of [...listeners]) {
            if (!owns(expected)) return { ...result, status: 'superseded' };
            if (!listeners.has(listener)) continue;
            try {
              // Readiness/revision may change while finance or an earlier
              // subscriber commits. The operation identity alone fences days.
              await listener(Object.freeze({ day, context: getContext() }));
              result.delivered++;
            } catch (error) {
              if (!owns(expected)) return { ...result, status: 'superseded' };
              result.failed++;
              console.warn('[OpenWorld] demand day listener failed', error);
            }
          }
          return owns(expected) ? result : { ...result, status: 'superseded' };
        },
      });
    },
  });
  root.SubwayBuilderOpenWorldDemand = registry;
  return registry;
}

function createDemandContextRegistry(root) {
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
  return registry;
}

/** Owns sparse durable demand state; native saves reference immutable manifests. */
export function createDemandExtensionRuntime({ api, game, storage, readContext,
  onChanged = () => {}, onError = error => console.error('[OpenWorld] demand persistence failed', error),
  createId = () => globalThis.crypto.randomUUID() }) {
  const store = new DemandExtensionStore({ storage, createId });
  let checkpoint = null, hydratedTile = null, busy = false, failure = null, pending = null;
  let serial = Promise.resolve(), activationGeneration = 0, disposed = false, handoff = null;
  let ownedScope = null, activationHold = null;
  const records = new Map(), saveHolds = new Set(), admissionWaiters = new Set();
  const state = () => game.callbacks.getState();
  const getContext = () => {
    if (disposed) return null;
    const context = readContext();
    if (!context) return null;
    return Object.freeze({ ...context, version: 1,
      demandRevision: checkpoint?.worldId === context.resolvedWorldId ? checkpoint.tiles[context.tileId]?.revision ?? 0 : 0,
      demandReady: Boolean(context.demandReady && checkpoint?.worldId === context.resolvedWorldId
        && hydratedTile === context.tileId && !busy && activationHold == null && !failure
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
  const publish = () => {
    for (const wake of admissionWaiters) wake();
    admissionWaiters.clear();
    onChanged(getContext());
  };
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
    if (operation.activationGeneration !== activationGeneration) throw new Error('Demand context changed; discard the stale mutation');
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
    catch (error) { if (operation.activationGeneration === activationGeneration) fail(error); return Promise.reject(error); }
    serial = persist(operation).catch(error => { if (operation.activationGeneration === activationGeneration) fail(error); throw error; });
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
          activationGeneration,
          previousDemand: record,
          nativeDemand: api.gameState.getDemandData(),
          nativeMarker: structuredClone(state().financialHistory?.[DEMAND_CHECKPOINT_FIELD] ?? null) };
      } catch (error) {
        return Promise.reject(error);
      }
      return execute(pending);
    },
    async activate({ worldId, tileId, nativeAuthoritativeLoad = false }) {
      const generation = ++activationGeneration;
      activationHold = generation;
      saveHolds.clear();
      const context = readContext();
      const identity = context && Object.fromEntries(CONTEXT_KEYS.map(key => [key, context[key]]));
      const marker = state().financialHistory?.[DEMAND_CHECKPOINT_FIELD];
      const previousRecords = [...records.values()].filter(Boolean), previousScope = ownedScope, previousOperation = pending;
      const assertCurrent = () => {
        if (generation !== activationGeneration) throw new Error('Demand activation was superseded');
        if (!identity || identity.resolvedWorldId !== worldId || identity.tileId !== tileId) throw new Error('Demand activation does not match the native World');
        matches(identity, false);
      };
      busy = true; hydratedTile = null; failure = null; publish();
      await serial.catch(() => {});
      try {
        assertCurrent();
        busy = true; failure = null;
        const takeover = handoff; handoff = null;
        if (takeover) {
          await takeover.settled;
          assertCurrent();
        }
        // Native same-city loads may keep the live demand object. Explicit
        // native authority, not object identity alone, excludes pending takeover.
        const takeoverMatches = !nativeAuthoritativeLoad && takeover?.operation && takeover.operation.nativeDemand === api.gameState.getDemandData()
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
          restoredRecords.set(keyFor(tileId, extensionId), record);
        }
        // Reconcile only IDs proven owned by the preceding active extension
        // records. Same-city native loadSave can retain newer demand in memory.
        const prior = [];
        const addPrior = (scope, values) => { if (scope?.tileId === tileId) prior.push(...values); };
        addPrior(previousScope, previousRecords);
        addPrior(takeover?.ownedScope, takeover?.knownRecords ?? []);
        for (const operation of [previousOperation, takeover?.operation]) {
          if (operation?.rawPayload && operation.tileId === tileId) {
            prior.push(normalizeDemandExtension(operation.rawPayload));
          }
        }
        const previousPops = new Map(), previousPoints = new Map(), desiredPops = new Map(), desiredPoints = new Map();
        for (const record of prior) {
          for (const pop of record.pops) previousPops.set(pop.id, pop);
          for (const point of record.points) previousPoints.set(point.id, point);
        }
        for (const record of restoredRecords.values()) {
          for (const pop of record.pops) desiredPops.set(pop.id, pop);
          for (const point of record.points) desiredPoints.set(point.id, point);
        }
        let liveDemand = null;
        if (previousPops.size || previousPoints.size) {
          if (typeof api.gameState?.getDemandData !== 'function' || !api.demand) throw new Error('The supported demand editor is unavailable during reconciliation');
          liveDemand = api.gameState.getDemandData();
          if (!liveDemand?.points || !liveDemand?.popsMap) throw new Error('Native demand is unavailable during reconciliation');
        }
        const retiredPoints = [...previousPoints.values()].filter(point => samePoint(liveDemand?.points.get(point.id), point)
          && !samePoint(point, desiredPoints.get(point.id)));
        const retiredIds = new Set(retiredPoints.map(point => point.id));
        const retiredPops = [...previousPops.values()].filter(pop => samePop(liveDemand?.popsMap.get(pop.id), pop)
          && (!samePop(pop, desiredPops.get(pop.id)) || retiredIds.has(pop.residenceId) || retiredIds.has(pop.jobId))).map(pop => pop.id);
        const retiredPopIds = new Set(retiredPops);
        // Preflight before any editor call: retirement must never cascade into
        // another extension's or the native game's still-live population.
        if (retiredIds.size) for (const pop of liveDemand.popsMap.values()) {
          if (!retiredPopIds.has(pop.id) && (retiredIds.has(pop.residenceId) || retiredIds.has(pop.jobId))) {
            throw new Error('An unrelated live pop still references a retired extension point');
          }
        }
        if (retiredPops.length) {
          assertCurrent();
          const removed = api.demand.removePops(retiredPops);
          if (!removed.success) throw new Error(removed.error);
        }
        if (retiredPoints.length) {
          for (const point of retiredPoints) {
            assertCurrent();
            const removed = api.demand.removeDemandPoint(point.id);
            if (!removed.success) throw new Error(removed.error);
          }
        }
        for (const extensionId of ids) {
          const record = restoredRecords.get(keyFor(tileId, extensionId));
          if (!record.points.length && !record.pops.length) continue;
          const remaps = new Map();
          if (typeof api.gameState?.getDemandData !== 'function') throw new Error('The supported demand editor is unavailable during restoration');
          let demand = api.gameState.getDemandData();
          if (!demand || !api.demand) throw new Error('The supported demand editor is unavailable during restoration');
          const trackRestoration = payload => {
            assertCurrent();
            if (ownedScope?.worldId !== worldId || ownedScope.tileId !== tileId) records.clear();
            ownedScope = { worldId, tileId };
            records.set(keyFor(tileId, extensionId), { ...payload, receipts: record.receipts });
          };
          for (const point of record.points) if (!demand.points.has(point.id)) {
            assertCurrent();
            const added = api.demand.addDemandPoint(point);
            if (!added.success) throw new Error(added.error);
            trackRestoration({ ...record, pops: record.pops.filter(pop => samePop(api.gameState.getDemandData().popsMap.get(pop.id), pop)) });
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
            // Record newly generated native IDs before durability yields. A
            // later same-city activation must be able to retire these exact IDs.
            trackRestoration(normalizeDemandExtension(payload));
            const result = await store.commit(restoredCheckpoint, tileId, extensionId, normalizeDemandExtension(payload), `restore:${createId()}`, record.receipts);
            assertCurrent();
            restoredCheckpoint = result.checkpoint; stamp(result.marker);
            restoredRecords.set(keyFor(tileId, extensionId), { ...normalizeDemandExtension(payload), receipts: result.receipts });
          } else restoredRecords.set(keyFor(tileId, extensionId), record);
        }
        assertCurrent();
        checkpoint = restoredCheckpoint;
        ownedScope = { worldId, tileId };
        records.clear(); for (const [key, record] of restoredRecords) records.set(key, record);
        pending = null; failure = null;
        serial = Promise.resolve();
        activationHold = null;
        hydratedTile = tileId; busy = false; publish();
      } catch (error) {
        // Obsolete activation must neither pause nor clobber the new session.
        if (generation === activationGeneration && identity
          && CONTEXT_KEYS.every(key => readContext()?.[key] === identity[key])) { activationHold = null; fail(error); }
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
      if (context && (busy || activationHold != null || failure || hydratedTile !== context.tileId
        || checkpoint?.worldId !== context.resolvedWorldId)) {
        const error = new Error('Save deferred until the demand mutation is durable');
        if ((busy || activationHold != null) && !failure) error.code = DEMAND_DEFERRED_CODE;
        throw error;
      }
    },
    async admit() {
      const expected = getContext();
      if (!expected) throw new Error('Demand admission was superseded');
      while (true) {
        matches(expected, false);
        if (activationHold != null) { await new Promise(resolve => admissionWaiters.add(resolve)); continue; }
        if (failure) throw failure;
        if (!busy) { runtime.assertSaveReady(); return getContext(); }
        await new Promise(resolve => admissionWaiters.add(resolve));
      }
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
      if (pending || records.size) return { operation: pending, checkpoint, settled: serial.catch(() => {}),
        ownedScope, knownRecords: [...records.values()].filter(Boolean) };
      return handoff;
    },
    acceptHandoff(value) { handoff = value ?? null; },
    dispose() {
      disposed = true; activationGeneration++; activationHold = null; saveHolds.clear();
      for (const wake of admissionWaiters) wake();
      admissionWaiters.clear();
    },
    snapshot() { return { hydratedTile, busy: busy || activationHold != null, error: failure?.message ?? null, worldId: checkpoint?.worldId ?? null }; },
  };
  return runtime;
}
