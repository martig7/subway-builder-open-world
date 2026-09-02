import {
  greatCircleRoute,
  haversineMetres,
} from './generated-road-routing.js';

const WORKER_NAME = 'open-world-generated-road-route-worker';
const MAX_ROUTED_DIRECT_METRES = 250_000;

function tileNeighbors(tile) {
  return (tile?.neighbors ?? []).map((neighbor) => (
    typeof neighbor === 'string' ? neighbor : neighbor?.tileId
  )).filter(Boolean);
}

export function shortestTilePath(tileCatalog, fromTileId, toTileId) {
  if (fromTileId === toTileId) return [fromTileId];
  const tileById = new Map((tileCatalog?.tiles ?? []).map((tile) => [tile.id, tile]));
  if (!tileById.has(fromTileId) || !tileById.has(toTileId)) return [];
  const queue = [fromTileId];
  const parent = new Map([[fromTileId, null]]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const tileId = queue[cursor];
    for (const neighbor of tileNeighbors(tileById.get(tileId))) {
      if (!tileById.has(neighbor) || parent.has(neighbor)) continue;
      parent.set(neighbor, tileId);
      if (neighbor === toTileId) {
        const path = [];
        for (let current = toTileId; current != null; current = parent.get(current)) path.push(current);
        return path.reverse();
      }
      queue.push(neighbor);
    }
  }
  return [];
}

function expandedCorridor(tileCatalog, tileIds) {
  const tileById = new Map((tileCatalog?.tiles ?? []).map((tile) => [tile.id, tile]));
  const expanded = new Set(tileIds);
  for (const tileId of tileIds) {
    for (const neighbor of tileNeighbors(tileById.get(tileId))) expanded.add(neighbor);
  }
  return [...expanded].filter((tileId) => tileById.has(tileId)).sort();
}

function routeCandidates(tileCatalog, fromTileId, toTileId) {
  const path = shortestTilePath(tileCatalog, fromTileId, toTileId);
  if (!path.length) return [];
  const candidates = [path];
  const expanded = expandedCorridor(tileCatalog, path);
  if (expanded.length > path.length) candidates.push(expanded);
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = [...candidate].sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function copyBuffer(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function createRoadRouteWorkerClient({
  workerSource,
  loadRoadBytes,
  WorkerClass = globalThis.Worker,
  BlobClass = globalThis.Blob,
  createObjectURL = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
  revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
} = {}) {
  if (!workerSource || typeof WorkerClass !== 'function' || typeof BlobClass !== 'function' || !createObjectURL) return null;
  const objectUrl = createObjectURL(new BlobClass([workerSource], { type: 'text/javascript' }));
  const worker = new WorkerClass(objectUrl, { name: WORKER_NAME });
  const pending = new Map();
  let sequence = 0;
  let disposed = false;
  worker.onmessage = ({ data }) => {
    if (data?.type === 'ready') return;
    const request = pending.get(data?.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.ok) request.resolve(data);
    else request.reject(new Error(data?.error?.message ?? 'Road route worker failed'));
  };
  worker.onerror = (event) => {
    for (const request of pending.values()) request.reject(new Error(event?.message ?? 'Road route worker failed'));
    pending.clear();
  };

  const send = (message, transfer = []) => new Promise((resolve, reject) => {
    if (disposed) return reject(new Error('Road route worker is disposed'));
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id }, transfer);
  });

  return {
    async route({ tileIds, origin, destination }) {
      const key = [...tileIds].sort().join('|');
      let response = await send({ key, origin, destination });
      if (response.status !== 'roads-required') return response;
      const bundles = await Promise.all(tileIds.map(async (tileId) => {
        const bytes = await loadRoadBytes(tileId);
        const buffer = copyBuffer(bytes);
        return { tileId, bytes: buffer, gzip: bytes[0] === 0x1f && bytes[1] === 0x8b };
      }));
      response = await send(
        { key, origin, destination, roads: bundles },
        bundles.map((bundle) => bundle.bytes),
      );
      return response;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      worker.terminate?.();
      if (revokeObjectURL) revokeObjectURL(objectUrl);
      for (const request of pending.values()) request.reject(new Error('Road route worker is disposed'));
      pending.clear();
    },
  };
}

function nativeEndpoints(demand, popId, tileId) {
  const pop = demand?.popsMap?.get?.(popId);
  if (!pop || !(pop.size > 0)) return null;
  const home = demand?.points?.get?.(pop.residenceId);
  const work = demand?.points?.get?.(pop.jobId);
  if (!home?.location || !work?.location) return null;
  return { origin: home.location, destination: work.location, fromTileId: tileId, toTileId: tileId };
}

function crossEndpointIndex(crossDemand) {
  const fields = new Map((crossDemand?.popFields ?? []).map((field, index) => [field, index]));
  const homeField = fields.get('homePoint');
  const workField = fields.get('workPoint');
  const idField = fields.get('id');
  if (![homeField, workField, idField].every(Number.isInteger)) return new Map();
  const endpoints = new Map();
  for (const pop of crossDemand?.pops ?? []) {
    const home = crossDemand.points?.[pop[homeField]];
    const work = crossDemand.points?.[pop[workField]];
    if (!home || !work) continue;
    endpoints.set(pop[idField], {
      origin: [home[1], home[2]], destination: [work[1], work[2]],
      fromTileId: home[3], toTileId: work[3],
    });
  }
  return endpoints;
}

/**
 * Deep route-path module shared by the native `map://paths` adapter and the
 * cross-demand viewer. Callers know only `owns` and asynchronous `resolve`.
 */
export function createOpenWorldRoutePaths({
  tilePackages,
  tileCatalog,
  getNativeDemand,
  nativePopPrefixes = [],
  crossPopPrefixes = [],
  workerSource = null,
  routeTiles = null,
  workerOptions = {},
} = {}) {
  const tileIds = new Set((tileCatalog?.tiles ?? []).map((tile) => tile.id));
  const workerClient = routeTiles ? null : createRoadRouteWorkerClient({
    workerSource,
    loadRoadBytes: (tileId) => tilePackages.loadRoadBytes(tileId),
    ...workerOptions,
  });
  const route = routeTiles ?? ((request) => workerClient?.route(request));
  const cache = new Map();
  let crossIndex = null;
  let crossIndexPromise = null;
  const diagnostics = { requests: 0, cacheHits: 0, roadRoutes: 0, fallbacks: 0, errors: 0, latest: null };

  const hasPrefix = (popId, prefixes) => prefixes.some((prefix) => String(popId).startsWith(prefix));
  const owns = (city, popId) => tileIds.has(city)
    && (hasPrefix(popId, nativePopPrefixes) || hasPrefix(popId, crossPopPrefixes));

  async function endpoints(city, popId) {
    if (hasPrefix(popId, nativePopPrefixes)) return nativeEndpoints(getNativeDemand?.(), popId, city);
    if (!crossIndex) {
      crossIndexPromise ??= tilePackages.loadCrossDemand(city).then(crossEndpointIndex);
      crossIndex = await crossIndexPromise;
    }
    return crossIndex.get(popId) ?? null;
  }

  async function calculate(city, popId) {
    const target = await endpoints(city, popId);
    if (!target) return null;
    const directMetres = haversineMetres(target.origin, target.destination);
    if (directMetres > MAX_ROUTED_DIRECT_METRES) {
      diagnostics.fallbacks++;
      return { coordinates: greatCircleRoute(target.origin, target.destination), source: 'geometric-long-distance' };
    }
    for (const corridor of routeCandidates(tileCatalog, target.fromTileId, target.toTileId)) {
      try {
        const response = await route?.({ tileIds: corridor, origin: target.origin, destination: target.destination });
        if (response?.status === 'routed' && response.route?.coordinates?.length >= 2) {
          diagnostics.roadRoutes++;
          return { ...response.route, source: 'generated-road-graph', tileIds: corridor, graph: response.graph ?? null };
        }
      } catch (error) {
        diagnostics.errors++;
        diagnostics.latestError = error?.message ?? String(error);
      }
    }
    diagnostics.fallbacks++;
    return { coordinates: greatCircleRoute(target.origin, target.destination), source: 'geometric-route-fallback' };
  }

  async function resolve(city, popId) {
    if (!owns(city, popId)) return null;
    diagnostics.requests++;
    const key = `${city}/${popId}`;
    if (cache.has(key)) {
      diagnostics.cacheHits++;
      const value = cache.get(key);
      cache.delete(key); cache.set(key, value);
      return value;
    }
    const pending = calculate(city, popId).then((result) => {
      diagnostics.latest = { city, popId, source: result?.source ?? 'unavailable' };
      return result;
    }).catch((error) => {
      cache.delete(key);
      diagnostics.errors++;
      diagnostics.latestError = error?.message ?? String(error);
      return null;
    });
    cache.set(key, pending);
    while (cache.size > 256) cache.delete(cache.keys().next().value);
    return pending;
  }

  return {
    owns,
    resolve,
    diagnostics: () => structuredClone(diagnostics),
    dispose: () => { cache.clear(); workerClient?.dispose(); },
  };
}
