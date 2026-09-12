export const RENDERER_TILE_CACHE_BUDGET_VERSION = 'renderer-dormant-tile-budget-v1';
const OWNER = '__openWorldRendererTileCacheBudget';

function positiveLimit(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * Limit only MapLibre's dormant-tile LRU. Its native onRemove callback unloads
 * evicted CPU/GPU buffers; currently displayed tiles remain in _tiles untouched.
 * The pinned game SourceCache.updateCacheSize honors _maxTileCacheSize, so native
 * camera/resize updates keep this cap without wrapping a per-frame method.
 */
export function createRendererTileCacheBudget({ getMap, onReport = () => {}, normalLimit = 64,
  pressureLimit = 16, recoveryMs = 10_000, now = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
  normalLimit = positiveLimit(normalLimit) ?? 64;
  pressureLimit = Math.min(normalLimit, positiveLimit(pressureLimit) ?? 16);
  recoveryMs = positiveLimit(recoveryMs) ?? 10_000;
  let map = null, pressured = false, normalSince = null, disposed = false;
  let evictedTiles = 0, unsupportedSources = 0;
  const sources = new Map();

  function restore(source, entry) {
    // A later user/third-party setting wins over restoration of our old value.
    if (source._maxTileCacheSize !== entry.applied) return;
    try {
      source._maxTileCacheSize = entry.original;
      entry.cache.setMaxSize(entry.originalCacheMax);
    } catch {}
  }

  function release() {
    for (const [source, entry] of sources) restore(source, entry);
    sources.clear();
    if (map?.[OWNER] === api) delete map[OWNER];
    map = null;
  }

  function synchronize() {
    if (map?._removed) release();
    if (!map) return;
    const current = new Set();
    const desired = pressured ? pressureLimit : normalLimit;
    let changed = false;
    unsupportedSources = 0;
    for (const [id, source] of Object.entries(map.style?.sourceCaches ?? {})) {
      const cache = source?._cache;
      if (typeof cache?.setMaxSize !== 'function' || !Array.isArray(cache.order)
        || positiveLimit(cache.max) == null || typeof source.updateCacheSize !== 'function'
        || !Object.getOwnPropertyDescriptor(source, '_maxTileCacheSize')?.writable) {
        unsupportedSources++;
        continue;
      }
      current.add(source);
      let entry = sources.get(source);
      if (entry && entry.cache !== cache) {
        restore(source, entry);
        sources.delete(source);
        entry = null;
      }
      if (!entry) {
        entry = { id, cache, original: source._maxTileCacheSize, originalCacheMax: cache.max,
          applied: source._maxTileCacheSize };
        sources.set(source, entry);
      } else if (source._maxTileCacheSize !== entry.applied) {
        // Adopt an external change as the new setting to preserve on disposal.
        entry.original = source._maxTileCacheSize;
        entry.originalCacheMax = cache.max;
      }
      const nativeLimit = positiveLimit(entry.original);
      const limit = Math.min(desired, nativeLimit ?? Infinity);
      if (entry.applied === limit && source._maxTileCacheSize === limit && cache.max <= limit) continue;
      const before = cache.order.length;
      try {
        source._maxTileCacheSize = limit;
        entry.applied = limit;
        // Never increase a viewport-derived capacity ourselves. On recovery,
        // the next native camera update recomputes the appropriate capacity
        // under the restored cap; no tiles are prefetched while stationary.
        cache.setMaxSize(Math.min(limit, cache.max));
        evictedTiles += Math.max(0, before - cache.order.length);
        changed = true;
      } catch {
        restore(source, entry);
        sources.delete(source);
        unsupportedSources++;
      }
    }
    for (const [source, entry] of sources) {
      if (current.has(source)) continue;
      restore(source, entry);
      sources.delete(source);
      changed = true;
    }
    if (changed) onReport({ version: RENDERER_TILE_CACHE_BUDGET_VERSION,
      pressure: pressured ? 'elevated' : 'normal', limit: desired, sources: sources.size, evictedTiles });
  }

  function attach(nextMap) {
    if (disposed) return;
    if (map !== nextMap || nextMap?._removed) release();
    if (!nextMap || nextMap._removed) return;
    if (nextMap[OWNER] && nextMap[OWNER] !== api) nextMap[OWNER].dispose();
    map = nextMap;
    Object.defineProperty(map, OWNER, { configurable: true, value: api });
    synchronize();
  }

  function updatePressure(level) {
    if (disposed) return;
    if (level === 'high' || level === 'elevated') {
      pressured = true;
      normalSince = null;
    } else if (level === 'normal' && pressured) {
      // Activity-boundary samples can arrive many times within one frame.
      // Recover by elapsed time rather than letting a save/movement burst
      // immediately reopen caches following a momentary heap drop.
      normalSince ??= now();
      if (now() - normalSince >= recoveryMs) { pressured = false; normalSince = null; }
    } else if (level !== 'normal') normalSince = null;
    if (getMap) attach(getMap());
    else synchronize();
  }

  function snapshot() {
    return { version: RENDERER_TILE_CACHE_BUDGET_VERSION, pressured, normalLimit, pressureLimit, recoveryMs,
      evictedTiles, unsupportedSources, sources: [...sources.values()].map(entry => ({
        id: entry.id, capacity: entry.cache.max, dormantTiles: entry.cache.order.length,
      })) };
  }

  const api = { attach, updatePressure, snapshot, release, dispose() { disposed = true; release(); } };
  return api;
}
