import { greatCircleRoute } from './generated-road-routing.js';

export const STORED_ROUTE_VERSION = 'stored-driving-routes-v1';
const MAX_VERTICES = 200_000;

export function decodePolyline6(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 4_000_000) throw new Error('Invalid route polyline');
  let cursor = 0, latitude = 0, longitude = 0;
  const read = () => {
    let value = 0, shift = 0, part;
    do {
      if (cursor >= encoded.length || shift > 30) throw new Error('Truncated or invalid route polyline');
      part = encoded.charCodeAt(cursor++) - 63;
      if (part < 0 || part > 63) throw new Error('Invalid route polyline character');
      value += (part & 31) * 2 ** shift; shift += 5;
    } while (part & 32);
    return value % 2 ? -(value + 1) / 2 : value / 2;
  };
  const coordinates = [];
  while (cursor < encoded.length) {
    latitude += read(); longitude += read();
    if (Math.abs(latitude) > 90e6 || Math.abs(longitude) > 180e6 || coordinates.length >= MAX_VERTICES) throw new Error('Invalid route polyline extent');
    coordinates.push([longitude / 1e6, latitude / 1e6]);
  }
  return coordinates;
}

function routeFromRecord(record) {
  const valid = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
    && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
  if (!valid(record?.origin) || !valid(record?.destination)) throw new Error('Invalid stored route endpoints');
  let coordinates;
  if (record.polyline === null && record.source === 'geometric-no-road-route') {
    coordinates = greatCircleRoute(record.origin, record.destination);
  } else {
    coordinates = decodePolyline6(record.polyline);
    if (!coordinates.length) throw new Error('Empty stored route');
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    if (!same(coordinates[0], record.origin)) coordinates.unshift([...record.origin]);
    if (!same(coordinates.at(-1), record.destination)) coordinates.push([...record.destination]);
    if (coordinates.length === 1) coordinates.push([...coordinates[0]]);
  }
  return { coordinates, source: record.source, distanceMetres: record.metres, seconds: record.seconds };
}

/** Cache compact strings only. Decoded geometry belongs to the current view. */
export function createStoredRoutePaths({ owns, kind, loadRecord, cacheLimitBytes = 8 * 1024 * 1024 }) {
  const cache = new Map(), pending = new Map(), controllers = new Set();
  let cacheBytes = 0, disposed = false;
  const stats = { version: STORED_ROUTE_VERSION, requests: 0, cacheHits: 0, storedRoutes: 0, fallbacks: 0, errors: 0, latest: null };
  async function resolve(city, popId) {
    if (disposed || !owns(city, popId)) return null;
    stats.requests++;
    const scope = kind(popId);
    const key = `${scope}/${scope === 'native' ? city : ''}/${popId}`;
    const started = performance.now();
    try {
      let entry = cache.get(key);
      if (entry) { cache.delete(key); cache.set(key, entry); stats.cacheHits++; }
      else {
        if (!pending.has(key)) {
          if (pending.size >= 32) throw new Error('Too many concurrent route requests');
          const controller = new AbortController(); controllers.add(controller);
          const request = Promise.resolve().then(() => loadRecord({ city, popId, kind: scope, signal: controller.signal })).then(record => {
            if (!record) return null;
            // Validation must happen before a corrupt record can enter the cache.
            routeFromRecord(record);
            const text = JSON.stringify(record);
            const value = { text, bytes: text.length * 2 + key.length * 2 + 128 };
            if (!disposed && value.bytes <= cacheLimitBytes) {
              cache.set(key, value); cacheBytes += value.bytes;
              while (cacheBytes > cacheLimitBytes || cache.size > 256) {
                const oldest = cache.keys().next().value;
                cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest);
              }
            }
            return value;
          }).finally(() => { pending.delete(key); controllers.delete(controller); });
          pending.set(key, request);
        }
        entry = await pending.get(key);
      }
      if (!entry || disposed) return null;
      const route = routeFromRecord(JSON.parse(entry.text));
      if (route.source === 'stored-osrm') stats.storedRoutes++; else stats.fallbacks++;
      stats.latest = { city, popId, source: route.source, milliseconds: performance.now() - started, vertices: route.coordinates.length };
      return route;
    } catch (error) {
      stats.errors++; stats.latestError = error?.message ?? String(error); return null;
    }
  }
  return { owns, resolve,
    diagnostics: () => ({ ...structuredClone(stats), cacheBytes, cacheLimitBytes, cacheEntries: cache.size, pending: pending.size }),
    dispose: () => { disposed = true; for (const controller of controllers) controller.abort(); cache.clear(); cacheBytes = 0; },
  };
}

export function storedRouteLoader({ baseUrl, crossTileId, revision, fetchData = globalThis.fetch.bind(globalThis) }) {
  return async ({ city, popId, kind, signal }) => {
    const tile = kind === 'cross' ? crossTileId : city;
    const url = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(tile)}/driving-routes/${kind}/${encodeURIComponent(popId)}?v=${encodeURIComponent(revision)}`;
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetchData(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`Stored route lookup failed (${response.status})`);
    if (response.headers.get('X-OpenWorld-Route-Archive') !== STORED_ROUTE_VERSION) throw new Error('Stored route server needs an update');
    return response.json();
  };
}
