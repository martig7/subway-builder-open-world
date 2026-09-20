// Conservative destination-cell lower bounds only: queue ordering remains the
// original cost-first order. Large tables disable pruning without changing paths.
export function createBoundedPartitionIndex({ cellSize = 32, maxStations = 2048,
  maxBytes = 8 * 1024 * 1024, maxCachedBounds = 128, maxBuildWork = 400_000_000 } = {}) {
  for (const [name, value] of Object.entries({ cellSize, maxStations, maxBytes, maxCachedBounds, maxBuildWork })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  let graph = null;
  const stats = { builds: 0, disabledBuilds: 0, boundHits: 0, prunedStates: 0,
    tableBytes: 0, cachedBytes: 0, cells: 0, reason: null };
  function compile(router, walkWeight) {
    const n = router.stations.length;
    const disabled = reason => {
      stats.disabledBuilds++; stats.reason = reason;
      return { router, walkWeight, disabled: true };
    };
    if (n > maxStations) return disabled('station-limit');
    const ordinals = new Map(router.stations.map((station, i) => [station.id, i]));
    const neighbors = Array.from({ length: n }, () => new Set());
    const reverse = Array.from({ length: n }, () => []);
    for (const [id, edges] of router.adjacency) {
      const from = ordinals.get(id);
      for (const edge of edges) {
        const to = ordinals.get(edge.to);
        const cost = edge.type === 'ride' ? edge.inVehicleSeconds : edge.seconds * walkWeight;
        if (from == null || to == null || !(cost >= 0) || !Number.isFinite(cost)) return disabled('unsupported-cost');
        neighbors[from].add(to); neighbors[to].add(from); reverse[to].push([from, cost]);
      }
    }
    const cellOf = new Int32Array(n).fill(-1), cells = [];
    const seeds = Array.from({ length: n }, (_, i) => i).sort((a, b) => neighbors[a].size - neighbors[b].size || a - b);
    for (const seed of seeds) {
      if (cellOf[seed] >= 0) continue;
      const cell = [], pending = [seed], seen = new Set(pending);
      for (let cursor = 0; cursor < pending.length && cell.length < cellSize; cursor++) {
        const at = pending[cursor];
        if (cellOf[at] >= 0) continue;
        cellOf[at] = cells.length; cell.push(at);
        for (const next of neighbors[at]) if (cellOf[next] < 0 && !seen.has(next)) { seen.add(next); pending.push(next); }
      }
      cells.push(cell);
    }
    const tableBytes = n * cells.length * 8;
    if (tableBytes + n * 8 > maxBytes) return disabled('table-limit');
    if (n * n * cells.length > maxBuildWork) return disabled('preprocessing-limit');
    const distances = cells.map(cell => {
      const distance = new Float64Array(n).fill(Infinity), visited = new Uint8Array(n);
      for (const station of cell) distance[station] = 0;
      for (let step = 0; step < n; step++) {
        let at = -1, best = Infinity;
        for (let i = 0; i < n; i++) if (!visited[i] && distance[i] < best) { at = i; best = distance[i]; }
        if (at < 0) break;
        visited[at] = 1;
        for (const [from, cost] of reverse[at]) if (best + cost < distance[from]) distance[from] = best + cost;
      }
      for (let i = 0; i < n; i++) if (Number.isFinite(distance[i])) distance[i] = Math.max(0, distance[i] * (1 - 1e-12) - 1e-8);
      return distance;
    });
    Object.assign(stats, { tableBytes, cells: cells.length, reason: null }); stats.builds++;
    return { router, walkWeight, ordinals, cellOf, distances, cache: new Map(),
      cacheLimit: Math.max(1, Math.min(maxCachedBounds, Math.floor((maxBytes - tableBytes) / (n * 8 || 1)))) };
  }
  function clear() { graph = null; stats.tableBytes = stats.cachedBytes = stats.cells = 0; stats.reason = null; }
  return {
    stats, clear,
    bounds(router, ends, rules) {
      const walkWeight = rules.PERCEIVED_TIME.WALK_MULTIPLIER;
      if (graph?.router !== router || graph.walkWeight !== walkWeight) { clear(); graph = compile(router, walkWeight); }
      if (graph.disabled) return null;
      const targetCells = [...new Set([...ends.keys()].map(id => graph.cellOf[graph.ordinals.get(id)]))].sort((a, b) => a - b);
      const key = targetCells.join(',');
      if (graph.cache.has(key)) { stats.boundHits++; return graph.cache.get(key); }
      if (graph.cache.size >= graph.cacheLimit) graph.cache.delete(graph.cache.keys().next().value);
      const bounds = new Float64Array(router.stations.length).fill(Infinity);
      for (const cell of targetCells) for (let i = 0; i < bounds.length; i++) bounds[i] = Math.min(bounds[i], graph.distances[cell][i]);
      graph.cache.set(key, bounds); stats.cachedBytes = graph.cache.size * bounds.byteLength;
      return bounds;
    },
    record(count) { stats.prunedStates += count; },
  };
}
