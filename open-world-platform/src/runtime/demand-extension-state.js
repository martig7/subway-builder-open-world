export const DEMAND_EXTENSION_SCHEMA_VERSION = 1;
export const DEMAND_CHECKPOINT_FIELD = 'openWorldDemandCheckpoint';

const copy = value => structuredClone(value);
const number = value => typeof value === 'number' && Number.isFinite(value);
const identifier = value => typeof value === 'string' && value.length > 0;

/** Persist only extension-owned scalar records, never a native demand model. */
export function normalizeDemandExtension(payload) {
  if (typeof payload?.ledger !== 'string') throw new Error('Demand extension ledger must be serialized text');
  JSON.parse(payload.ledger);
  const points = (payload.points ?? []).map(point => {
    if (!identifier(point?.id) || !Array.isArray(point.location) || point.location.length !== 2
      || !point.location.every(number)) throw new Error('Invalid extension demand point');
    return { id: point.id, location: [...point.location] };
  });
  const pops = (payload.pops ?? []).map(pop => {
    if (!identifier(pop?.id) || !identifier(pop.residenceId) || !identifier(pop.jobId)
      || !number(pop.size) || pop.size <= 0) throw new Error('Invalid extension demand pop');
    const result = { id: pop.id, residenceId: pop.residenceId, jobId: pop.jobId, size: pop.size };
    for (const key of ['drivingSeconds', 'drivingDistance', 'homeDepartureTime', 'workDepartureTime']) {
      if (pop[key] != null) {
        if (!number(pop[key]) || pop[key] < 0) throw new Error(`Invalid extension pop ${key}`);
        result[key] = pop[key];
      }
    }
    return result;
  });
  if (new Set(points.map(point => point.id)).size !== points.length
    || new Set(pops.map(pop => pop.id)).size !== pops.length) throw new Error('Duplicate extension demand IDs');
  return { ledger: payload.ledger, points, pops };
}

/** Merge a sparse overlay once into a pristine packaged demand snapshot. */
export function mergeDemandExtensions(base, extensions = []) {
  if (!Array.isArray(base?.points) || !Array.isArray(base?.pops)) throw new Error('Invalid base demand package');
  if (!extensions.length) return base;
  const points = new Map(base.points.map(point => [String(point.id), point]));
  const copiedPoints = new Set(), popIds = new Set(base.pops.map(pop => String(pop.id)));
  const pops = [...base.pops];
  const editablePoint = id => {
    if (!points.has(id)) return null;
    if (!copiedPoints.has(id)) { points.set(id, { ...points.get(id) }); copiedPoints.add(id); }
    return points.get(id);
  };
  for (const extension of extensions) {
    for (const point of extension.points ?? []) {
      if (points.has(point.id)) throw new Error(`Extension point collides with base demand: ${point.id}`);
      points.set(point.id, { ...point, residents: 0, jobs: 0 });
      copiedPoints.add(point.id);
    }
    for (const pop of extension.pops ?? []) {
      if (popIds.has(pop.id)) throw new Error(`Extension pop collides with base demand: ${pop.id}`);
      const home = editablePoint(pop.residenceId), work = editablePoint(pop.jobId);
      if (!home || !work) throw new Error(`Extension pop has an unloaded endpoint: ${pop.id}`);
      home.residents = (Number(home.residents) || 0) + pop.size;
      work.jobs = (Number(work.jobs) || 0) + pop.size;
      popIds.add(pop.id); pops.push({ ...pop });
    }
  }
  return { ...base, points: [...points.values()], pops };
}

export function remapDemandExtension(payload, ids) {
  if (!ids.size) return payload;
  const ledger = JSON.parse(payload.ledger);
  for (const [from, to] of ids) {
    if (ledger.pops?.[from]) { ledger.pops[to] = ledger.pops[from]; delete ledger.pops[from]; }
    if (ledger.tombstones?.[from]) { ledger.tombstones[to] = ledger.tombstones[from]; delete ledger.tombstones[from]; }
    if (ledger.pendingRemovals) ledger.pendingRemovals = ledger.pendingRemovals.map(id => ids.get(id) ?? id);
  }
  return { ...payload, ledger: JSON.stringify(ledger), pops: payload.pops.map(pop => ({ ...pop, id: ids.get(pop.id) ?? pop.id })) };
}

/** Ledger pressure changes do not invalidate unchanged native routing input. */
export function sameDemandExtensionScalars(left, right) {
  for (const [kind, keys] of [['points', ['location']], ['pops', ['residenceId', 'jobId', 'size',
    'drivingSeconds', 'drivingDistance', 'homeDepartureTime', 'workDepartureTime']]]) {
    const a = left?.[kind] ?? [], b = right?.[kind] ?? [];
    if (a.length !== b.length) return false;
    const byId = new Map(b.map(item => [item.id, item]));
    for (const item of a) {
      const previous = byId.get(item.id);
      if (!previous || keys.some(key => key === 'location'
        ? item.location[0] !== previous.location[0] || item.location[1] !== previous.location[1]
        : item[key] !== previous[key])) return false;
    }
  }
  return true;
}

/** Immutable checkpoint manifests reference reusable per-tile extension records. */
export class DemandExtensionStore {
  constructor({ storage, createId = () => globalThis.crypto.randomUUID() }) {
    this.storage = storage; this.createId = createId;
  }
  async readCheckpoint(marker, worldId) {
    if (marker == null) return { schemaVersion: 1, worldId, tiles: {} };
    if (marker.schemaVersion !== 1 || marker.worldId !== worldId || !identifier(marker.key)) {
      throw new Error('Demand checkpoint does not belong to this player World');
    }
    const checkpoint = await this.storage?.get(marker.key, null);
    if (checkpoint?.schemaVersion !== 1 || checkpoint.worldId !== worldId) throw new Error('Saved demand checkpoint is unavailable');
    return copy(checkpoint);
  }
  async readRecord(key) {
    const record = await this.storage?.get(key, null);
    if (record?.schemaVersion !== 1) throw new Error('Demand extension record is unavailable');
    return copy(record);
  }
  async commit(checkpoint, tileId, extensionId, payload, mutationId, previousReceipts = [], { demandChanged = true } = {}) {
    if (typeof this.storage?.set !== 'function') throw new Error('Durable demand storage is unavailable');
    const next = copy(checkpoint);
    const tile = next.tiles[tileId] ??= { revision: 0, extensions: {} };
    tile.revision++;
    const recordKey = `demand-extension:${next.worldId}:${tileId}:${extensionId}:${this.createId()}`;
    // A unique routing key also distinguishes two edited branches of one old
    // native checkpoint. Ledger-only commits retain its exact routing identity.
    if (demandChanged) {
      tile.routingRevision = (tile.routingRevision ?? 0) + 1;
      tile.routingKey = recordKey;
    } else if (!Object.hasOwn(tile, 'routingKey')) {
      tile.routingRevision = 0;
      tile.routingKey = Object.keys(tile.extensions).length ? JSON.stringify(tile.extensions) : null;
    }
    const receipts = [...previousReceipts.filter(id => id !== mutationId), mutationId].slice(-128);
    await this.storage.set(recordKey, { schemaVersion: 1, extensionId, ...copy(payload), receipts });
    tile.extensions[extensionId] = recordKey;
    const key = `demand-checkpoint:${next.worldId}:${this.createId()}`;
    await this.storage.set(key, next);
    return { checkpoint: next, marker: { schemaVersion: 1, worldId: next.worldId, key }, recordKey, receipts };
  }
}
