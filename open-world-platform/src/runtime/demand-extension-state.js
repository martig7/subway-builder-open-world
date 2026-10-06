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
  const endpoints = (payload.endpoints ?? []).map(endpoint => {
    if (!identifier(endpoint?.id) || !identifier(endpoint.tileId) || !Array.isArray(endpoint.location)
      || endpoint.location.length !== 2 || !endpoint.location.every(number)
      || Math.abs(endpoint.location[0]) > 180 || Math.abs(endpoint.location[1]) > 90) throw new Error('Invalid cross-demand endpoint');
    const result = { id: endpoint.id, location: [...endpoint.location], tileId: endpoint.tileId };
    for (const key of ['residents', 'jobs']) if (endpoint[key] != null) {
      if (!number(endpoint[key]) || endpoint[key] < 0) throw new Error('Invalid cross-demand endpoint mass');
      result[key] = endpoint[key];
    }
    return result;
  });
  if (new Set(endpoints.map(point => point.id)).size !== endpoints.length) throw new Error('Duplicate cross-demand endpoint IDs');
  const crossPops = (payload.crossPops ?? []).map(pop => normalizeDemandExtension({ ledger: '{}', pops: [pop] }).pops[0]);
  const byId = new Map(endpoints.map(point => [point.id, point]));
  const popIds = new Set(pops.map(pop => pop.id));
  for (const pop of crossPops) {
    if (popIds.has(pop.id)) throw new Error('Duplicate extension demand IDs');
    popIds.add(pop.id);
    const home = byId.get(pop.residenceId), work = byId.get(pop.jobId);
    if (!home || !work) throw new Error('Cross-demand pop has an undescribed endpoint');
  }
  return { ledger: payload.ledger, points, pops,
    ...(payload.endpoints != null || payload.crossPops != null ? { endpoints, crossPops } : {}) };
}


/** Split proven extension cohorts by authoritative ownership, never by native halo bounds. */
export function partitionDemandExtension(payload, { tileId, ownerAt, pointById = () => null }) {
  if (!identifier(tileId) || typeof ownerAt !== 'function') throw new Error('Demand ownership is unavailable');
  const normalized = normalizeDemandExtension(payload);
  const points = new Map(normalized.points.map(point => [point.id, point]));
  const endpoints = new Map((normalized.endpoints ?? []).map(endpoint => [endpoint.id, endpoint]));
  const resolve = id => {
    const point = points.get(id), described = endpoints.get(id), live = pointById(id);
    const source = point ?? described ?? live;
    if (!source?.location) throw new Error('Demand endpoint ownership is unavailable: ' + id);
    if (point && described && (point.location[0] !== described.location[0] || point.location[1] !== described.location[1])) {
      throw new Error('Demand endpoint ownership geometry mismatch: ' + id);
    }
    const owner = ownerAt(source.location);
    if (!identifier(owner)) throw new Error('Demand endpoint owner is unknown: ' + id);
    if (described && described.tileId !== owner) throw new Error('Demand endpoint ownership mismatch: ' + id);
    const endpoint = { id, location: [...source.location], tileId: owner };
    for (const key of ['residents', 'jobs']) {
      const mass = described?.[key] ?? live?.[key];
      if (number(mass) && mass >= 0) endpoint[key] = mass;
    }
    return endpoint;
  };
  for (const endpoint of endpoints.values()) resolve(endpoint.id);
  const nativePoints = [];
  for (const point of normalized.points) {
    const endpoint = resolve(point.id);
    if (endpoint.tileId === tileId) nativePoints.push(point);
    else endpoints.set(point.id, endpoint);
  }
  const nativePops = [], crossPops = [...(normalized.crossPops ?? [])];
  for (const pop of crossPops) {
    if (resolve(pop.residenceId).tileId === tileId && resolve(pop.jobId).tileId === tileId) {
      throw new Error('Active-owned demand belongs in the native lane');
    }
  }
  for (const pop of normalized.pops) {
    const home = resolve(pop.residenceId), work = resolve(pop.jobId);
    if (home.tileId === tileId && work.tileId === tileId) nativePops.push(pop);
    else {
      endpoints.set(home.id, home); endpoints.set(work.id, work);
      crossPops.push(pop);
    }
  }
  return normalizeDemandExtension({ ledger: normalized.ledger, points: nativePoints, pops: nativePops,
    endpoints: [...endpoints.values()], crossPops });
}


/**
 * Project a legacy overlay before transferring it to a geometry-free worker.
 * Unknown endpoint IDs must exist in the pristine package, whose producer
 * guarantees final-owner native demand. Keep the immutable source record for
 * complete cross-endpoint migration when its source tile becomes active.
 */
export function nativeDemandExtensionForTile(payload, { tileId, ownerAt }) {
  if (!identifier(tileId) || typeof ownerAt !== 'function') throw new Error('Demand ownership is unavailable');
  const normalized = normalizeDemandExtension(payload), owners = new Map(), locations = new Map();
  for (const point of [...normalized.points, ...(normalized.endpoints ?? [])]) {
    const owner = ownerAt(point.location), previous = locations.get(point.id);
    if (!identifier(owner)) throw new Error('Demand endpoint owner is unknown: ' + point.id);
    if (point.tileId != null && point.tileId !== owner) throw new Error('Demand endpoint ownership mismatch: ' + point.id);
    if (previous && (previous[0] !== point.location[0] || previous[1] !== point.location[1])) {
      throw new Error('Demand endpoint ownership geometry mismatch: ' + point.id);
    }
    locations.set(point.id, point.location); owners.set(point.id, owner);
  }
  const isNativeEndpoint = id => !owners.has(id) || owners.get(id) === tileId;
  return { ...normalized,
    points: normalized.points.filter(point => owners.get(point.id) === tileId),
    pops: normalized.pops.filter(pop => isNativeEndpoint(pop.residenceId) && isNativeEndpoint(pop.jobId)) };
}

/** Merge a sparse overlay once into a pristine packaged demand snapshot. */
export function mergeDemandExtensions(base, extensions = [], ownership = null) {
  if (!Array.isArray(base?.points) || !Array.isArray(base?.pops)) throw new Error('Invalid base demand package');
  if (!extensions.length) return base;
  const points = new Map(base.points.map(point => [String(point.id), point]));
  if (ownership) extensions = extensions.map(extension => partitionDemandExtension(extension, { ...ownership,
    pointById: id => points.get(id) }));
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
  for (const [kind, keys] of [['points', ['location']], ['endpoints', ['location', 'tileId', 'residents', 'jobs']],
    ['crossPops', ['residenceId', 'jobId', 'size', 'drivingSeconds', 'drivingDistance', 'homeDepartureTime', 'workDepartureTime']],
    ['pops', ['residenceId', 'jobId', 'size',
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

export function sameCrossDemandExtensionScalars(left, right) {
  const routingInput = value => {
    const crossPops = value?.crossPops ?? [];
    const ids = new Set(crossPops.flatMap(pop => [pop.residenceId, pop.jobId]));
    return { crossPops, endpoints: (value?.endpoints ?? []).filter(endpoint => ids.has(endpoint.id)) };
  };
  return sameDemandExtensionScalars(routingInput(left), routingInput(right));
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
  async commit(checkpoint, tileId, extensionId, payload, mutationId, previousReceipts = [], { demandChanged = true, crossChanged = Boolean(payload.crossPops?.length) } = {}) {
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
    if (crossChanged) tile.crossRoutingKey = recordKey;
    else if (!Object.hasOwn(tile, 'crossRoutingKey')) tile.crossRoutingKey = null;
    const receipts = [...previousReceipts.filter(id => id !== mutationId), mutationId].slice(-128);
    await this.storage.set(recordKey, { schemaVersion: 1, extensionId, ...copy(payload), receipts });
    tile.extensions[extensionId] = recordKey;
    const key = `demand-checkpoint:${next.worldId}:${this.createId()}`;
    await this.storage.set(key, next);
    return { checkpoint: next, marker: { schemaVersion: 1, worldId: next.worldId, key }, recordKey, receipts };
  }
}
