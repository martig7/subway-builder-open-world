// EXPERIMENT: graph cells supply optimistic remaining costs, never fixed
// timetable shortcuts. Every accepted ride still uses the production schedule.
export const PARTITION_EXPERIMENT_VERSION = 'transit-partition-lower-bounds-v1';

export function createPartitionIndex({ cellSize = 32 } = {}) {
  if (!Number.isInteger(cellSize) || cellSize < 1) throw new Error('cellSize must be a positive integer');
  let graph = null;
  const stats = { version: PARTITION_EXPERIMENT_VERSION, cellSize, builds: 0, preprocessingMs: 0,
    boundPreparationMs: 0, boundHits: 0, queries: 0, prunedStates: 0 };

  function compile(router, walkWeight) {
    const start = performance.now();
    const n = router.stations.length;
    const ordinals = new Map(router.stations.map((station, i) => [station.id, i]));
    const neighbors = Array.from({ length: n }, () => new Set());
    const reverse = Array.from({ length: n }, () => []);
    let edgeCount = 0;
    for (const [id, edges] of router.adjacency) {
      const from = ordinals.get(id);
      for (const edge of edges) {
        const to = ordinals.get(edge.to);
        const cost = edge.type === 'ride' ? edge.inVehicleSeconds : edge.seconds * walkWeight;
        if (!(cost >= 0) || !Number.isFinite(cost)) throw new Error('Partition bounds require finite nonnegative edge costs');
        neighbors[from].add(to); neighbors[to].add(from);
        reverse[to].push([from, cost]); edgeCount++;
      }
    }
    // Grow connected cells from low-degree seeds. Coordinates/Tile Views play
    // no role. The cell size is a tuning parameter, not a correctness premise.
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
    // Multi-source reverse Dijkstra gives cost from every station to ANY
    // station in a destination cell. Omitting waits/dwell/onboard restrictions
    // only lowers cost. An O(V^2) scan is deliberate for this small-network pilot.
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
      // Leave a small rounding margin when comparing independently summed costs.
      for (let i = 0; i < n; i++) if (Number.isFinite(distance[i])) distance[i] = Math.max(0, distance[i] * (1 - 1e-12) - 1e-8);
      return distance;
    });
    let cutEdges = 0;
    for (let to = 0; to < n; to++) for (const [from] of reverse[to]) if (cellOf[from] !== cellOf[to]) cutEdges++;
    Object.assign(stats, { stations: n, cells: cells.length, cellSizes: cells.map(cell => cell.length),
      edges: edgeCount, cutEdges, tableBytes: n * cells.length * 8 });
    stats.builds++; stats.preprocessingMs += performance.now() - start;
    return { router, walkWeight, ordinals, cellOf, distances, cache: new Map() };
  }
  return {
    stats,
    bounds(router, ends, rules) {
      const walkWeight = rules.PERCEIVED_TIME.WALK_MULTIPLIER;
      if (!(walkWeight >= 0) || !(rules.PERCEIVED_TIME.WAIT_MULTIPLIER >= 0)
        || !(rules.PERCEIVED_TIME.DEPARTURE_SHIFT_MULTIPLIER >= 0) || !(rules.ARRIVAL_GAP >= 0)) {
        throw new Error('Partition bounds require nonnegative routing weights');
      }
      if (graph?.router !== router || graph.walkWeight !== walkWeight) graph = compile(router, walkWeight);
      const targetCells = [...new Set([...ends.keys()].map(id => graph.cellOf[graph.ordinals.get(id)]))].sort((a, b) => a - b);
      const key = targetCells.join(','); stats.queries++;
      if (graph.cache.has(key)) { stats.boundHits++; return graph.cache.get(key); }
      const start = performance.now(), bounds = new Float64Array(router.stations.length).fill(Infinity);
      for (const cell of targetCells) for (let i = 0; i < bounds.length; i++) bounds[i] = Math.min(bounds[i], graph.distances[cell][i]);
      graph.cache.set(key, bounds);
      if (graph.cache.size > 128) graph.cache.delete(graph.cache.keys().next().value);
      stats.boundPreparationMs += performance.now() - start;
      return bounds;
    },
    record(count) { stats.prunedStates += count; },
  };
}
