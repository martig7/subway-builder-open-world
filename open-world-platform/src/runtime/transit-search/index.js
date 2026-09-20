import { transitSearchBytes, TRANSIT_SEARCH_WASM_SHA256 } from './kernel-bytes.js';
import { createBoundedPartitionIndex } from './partition-index.js';

export const BOUNDED_TRANSIT_SEARCH_VERSION = 'bounded-commute-routing-v1';
export { TRANSIT_SEARCH_WASM_SHA256 };
const PAGE_BYTES = 65_536;
const unsupported = reason => { const error = new Error(reason); error.fallbackReason = reason; throw error; };

/** Optional exact search acceleration. A null result asks the caller to use its
 * existing JavaScript search. The constructor allocates no graph or Wasm memory.
 * Linear memory, graph dimensions, partition tables and caches have separate
 * limits; these limits do not claim to cap total renderer/worker memory.
 */
export function createBoundedTransitSearch({ maxMemoryBytes = 32 * 1024 * 1024,
  maxStations = 4096, maxEdges = 32768, maxStates = 32768, labelCapacity = null,
  partition = true, partitionOptions = {}, webAssembly = globalThis.WebAssembly,
} = {}) {
  for (const [name, value] of Object.entries({ maxMemoryBytes, maxStations, maxEdges, maxStates })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  if (labelCapacity != null && (!Number.isSafeInteger(labelCapacity) || labelCapacity < 1)) throw new RangeError('labelCapacity must be a positive integer');
  const partitionIndex = partition ? createBoundedPartitionIndex(partitionOptions) : null;
  let instance = null, api = null, graph = null, rejected = new WeakSet();
  const stats = { version: BOUNDED_TRANSIT_SEARCH_VERSION, wasmSha256: TRANSIT_SEARCH_WASM_SHA256,
    searches: 0, builds: 0, instances: 0, fallbacks: 0, memoryFallbacks: 0,
    linearMemoryBytes: 0, peakLinearMemoryBytes: 0, retainedEdges: 0, retainedStates: 0,
    labelCapacity: 0, clears: 0, lastFallback: null, partition: partitionIndex?.stats ?? null };
  function release() {
    graph = null; api = null; instance = null; partitionIndex?.clear();
    stats.linearMemoryBytes = stats.retainedEdges = stats.retainedStates = stats.labelCapacity = 0;
  }
  function clear() { release(); rejected = new WeakSet(); stats.clears++; }
  function fallback(reason) {
    stats.fallbacks++; stats.lastFallback = reason;
    if (/memory|limit|capacity/.test(reason)) stats.memoryFallbacks++;
    return null;
  }
  function initialize() {
    if (api) return;
    if (!webAssembly?.Module || !webAssembly?.Instance) unsupported('webassembly-unavailable');
    if (maxMemoryBytes < PAGE_BYTES * 2) unsupported('linear-memory-limit');
    instance = new webAssembly.Instance(new webAssembly.Module(transitSearchBytes()));
    api = instance.exports; stats.instances++;
    stats.linearMemoryBytes = api.memory.buffer.byteLength;
    stats.peakLinearMemoryBytes = Math.max(stats.peakLinearMemoryBytes, stats.linearMemoryBytes);
  }
  function compile(router) {
    const n = router.stations.length;
    if (n > maxStations) unsupported('station-limit');
    if (n > maxStates) unsupported('state-limit');
    let edgeCount = 0;
    for (const station of router.stations) {
      edgeCount += router.adjacency.get(station.id)?.length ?? 0;
      if (edgeCount > maxEdges) unsupported('edge-limit');
    }
    const stationOrdinals = new Map(router.stations.map((station, index) => [station.id, index]));
    const states = new Map(router.stations.map((station, index) => [`${station.id}\0`, index]));
    const routes = new Map(), originalEdges = [];
    const offsets = new Int32Array(n + 1);
    let periodCount = 0, phaseCount = 0, chainCount = 0;
    for (let index = 0; index < n; index++) {
      const id = router.stations[index].id;
      for (const edge of router.adjacency.get(id) ?? []) {
        if (!stationOrdinals.has(edge.to)) unsupported('unknown-edge-station');
        const ride = edge.type === 'ride', route = edge.route;
        const seconds = ride ? edge.inVehicleSeconds : edge.seconds;
        if (!Number.isFinite(seconds) || seconds < 0) unsupported('unsupported-edge-cost');
        if (ride && (!Number.isFinite(edge.dwellSeconds) || edge.dwellSeconds < 0
          || !Number.isFinite(edge.departureOffsetSeconds))) unsupported('unsupported-schedule');
        if (ride && !routes.has(edge.routeStateId)) routes.set(edge.routeStateId, routes.size + 1);
        if (!states.has(edge.toStateKey)) states.set(edge.toStateKey, states.size);
        if (states.size > maxStates) unsupported('state-limit');
        originalEdges.push(edge);
        periodCount += route?.timetableSchedule?.mode === 'timetable' ? (route.timetableSchedule.periods?.length ?? 0) : 0;
        phaseCount += route?.departureAnchorsByNode?.[edge.departureNodeId]?.length ?? 0;
        chainCount += router.cacheEnabled ? (router.graphIndex.corridors.get(edge)?.length ?? 1) : 1;
        // Reject unreasonable packed schedules/corridor expansion before making
        // any proportional arrays or requesting Wasm linear-memory growth.
        if ((edgeCount * 12 + periodCount * 3 + phaseCount) * 8 + chainCount * 4 > maxMemoryBytes) unsupported('packed-graph-memory-limit');
      }
      offsets[index + 1] = originalEdges.length;
    }
    initialize();
    const labelBytes = api.label_size(), heapBytes = api.heap_entry_size();
    const edgeOrdinals = new Map(originalEdges.map((edge, index) => [edge, index]));
    let offset = Number(api.__heap_base.value);
    const allocate = (Type, length) => {
      offset = Math.ceil(offset / 8) * 8;
      const block = { pointer: offset, Type, length };
      offset += length * Type.BYTES_PER_ELEMENT;
      return block;
    };
    const p = {
      offsets: allocate(Int32Array, n + 1), edges: allocate(Float64Array, edgeCount * 12),
      chainOffsets: allocate(Int32Array, edgeCount + 1), chains: allocate(Int32Array, chainCount),
      periods: allocate(Float64Array, periodCount * 3), phases: allocate(Float64Array, phaseCount),
      starts: allocate(Float64Array, n * 3), ends: allocate(Float64Array, n),
      best: allocate(Int32Array, states.size), result: allocate(Float64Array, 8),
      lowerBounds: allocate(Float64Array, n),
    };
    const usableMemoryBytes = Math.floor(maxMemoryBytes / PAGE_BYTES) * PAGE_BYTES;
    const maximumCapacity = Math.floor((usableMemoryBytes - offset - 24) / (labelBytes + heapBytes + 4));
    const capacity = Math.min(labelCapacity ?? Math.max(65536, states.size * 64), maximumCapacity);
    if (capacity < 1) unsupported('linear-memory-limit');
    p.labels = allocate(Uint8Array, capacity * labelBytes);
    p.heap = allocate(Uint8Array, capacity * heapBytes);
    p.path = allocate(Int32Array, capacity);
    const targetBytes = Math.ceil(offset / PAGE_BYTES) * PAGE_BYTES;
    if (targetBytes > usableMemoryBytes) unsupported('linear-memory-limit');
    const additionalPages = (targetBytes - api.memory.buffer.byteLength) / PAGE_BYTES;
    if (additionalPages > 0) api.memory.grow(additionalPages);
    for (const block of Object.values(p)) block.view = new block.Type(api.memory.buffer, block.pointer, block.length);
    p.offsets.view.set(offsets);
    let periodOffset = 0, phaseOffset = 0, chainOffset = 0;
    for (let index = 0; index < edgeCount; index++) {
      const edge = originalEdges[index], ride = edge.type === 'ride', route = edge.route;
      const timetable = route?.timetableSchedule?.mode === 'timetable';
      const periods = timetable ? route.timetableSchedule.periods ?? [] : [];
      const phases = route?.departureAnchorsByNode?.[edge.departureNodeId] ?? [];
      p.edges.view.set([stationOrdinals.get(edge.to), states.get(edge.toStateKey), ride ? routes.get(edge.routeStateId) : 0,
        ride ? edge.inVehicleSeconds : edge.seconds, edge.dwellSeconds ?? 0, edge.departureOffsetSeconds ?? 0,
        route?.cycleTimeSeconds ?? 0, route?.serviceCount ?? 0, periodOffset, timetable ? periods.length : -1,
        phaseOffset, phases.length], index * 12);
      for (const period of periods) {
        p.periods.view.set([Number.isFinite(period.startHour) ? period.startHour : 0,
          Number.isFinite(period.endHour) ? period.endHour : 24,
          Math.max(0, Number.isFinite(period.headwaySeconds) ? period.headwaySeconds : 0)], periodOffset++ * 3);
      }
      p.phases.view.set(phases, phaseOffset); phaseOffset += phases.length;
      p.chainOffsets.view[index] = chainOffset;
      const chain = router.cacheEnabled ? router.graphIndex.corridors.get(edge) : null;
      if (chain) for (const item of chain) {
        const ordinal = edgeOrdinals.get(item);
        if (ordinal == null) unsupported('unknown-corridor-edge');
        p.chains.view[chainOffset++] = ordinal;
      }
      else p.chains.view[chainOffset++] = index;
    }
    p.chainOffsets.view[edgeCount] = chainOffset;
    Object.assign(stats, { linearMemoryBytes: api.memory.buffer.byteLength, retainedEdges: edgeCount,
      retainedStates: states.size, labelCapacity: capacity });
    stats.peakLinearMemoryBytes = Math.max(stats.peakLinearMemoryBytes, stats.linearMemoryBytes); stats.builds++;
    return { router, p, stationOrdinals, originalEdges, stateCount: states.size, capacity };
  }
  return {
    stats, clear, dispose: clear,
    search(router, query) {
      if (rejected.has(router)) return fallback('previous-build-failed');
      const { starts, ends, rules, requestedDepartureSeconds, bound = Infinity } = query;
      const weights = rules.PERCEIVED_TIME;
      if (![requestedDepartureSeconds, weights.WALK_MULTIPLIER, weights.WAIT_MULTIPLIER,
        weights.DEPARTURE_SHIFT_MULTIPLIER, rules.ARRIVAL_GAP].every(Number.isFinite)
        || [weights.WALK_MULTIPLIER, weights.WAIT_MULTIPLIER, weights.DEPARTURE_SHIFT_MULTIPLIER, rules.ARRIVAL_GAP].some(value => value < 0)
        || Number.isNaN(bound)) return fallback('unsupported-query-cost');
      try {
        if (graph?.router !== router) {
          // Drop the old linear memory before compiling a replacement graph.
          release(); graph = compile(router);
        }
        const { p, stationOrdinals, originalEdges, stateCount, capacity } = graph;
        if (starts.length > router.stations.length) return fallback('start-capacity');
        for (let index = 0; index < starts.length; index++) {
          const [id, access] = starts[index], ordinal = stationOrdinals.get(id);
          if (ordinal == null || !Number.isFinite(access.seconds) || access.seconds < 0) return fallback('unsupported-access');
          p.starts.view.set([ordinal, access.seconds, access.mode === 'drive' ? 1 : 0], index * 3);
        }
        p.ends.view.fill(Infinity);
        for (const [id, seconds] of ends) {
          const ordinal = stationOrdinals.get(id);
          if (ordinal == null || !Number.isFinite(seconds) || seconds < 0) return fallback('unsupported-egress');
          p.ends.view[ordinal] = seconds;
        }
        const lowerBounds = partitionIndex?.bounds(router, ends, rules);
        if (lowerBounds) p.lowerBounds.view.set(lowerBounds);
        api.set_partition_bounds(p.lowerBounds.pointer, lowerBounds ? 1 : 0);
        const status = api.search(stateCount, capacity, p.offsets.pointer, p.edges.pointer, p.chainOffsets.pointer, p.chains.pointer,
          p.periods.pointer, p.phases.pointer, p.starts.pointer, starts.length, p.ends.pointer,
          requestedDepartureSeconds, weights.WALK_MULTIPLIER, weights.WAIT_MULTIPLIER,
          weights.DEPARTURE_SHIFT_MULTIPLIER, rules.ARRIVAL_GAP, bound,
          p.labels.pointer, p.best.pointer, p.heap.pointer, p.path.pointer, p.result.pointer);
        stats.searches++; partitionIndex?.record(api.partition_pruned());
        if (status < 0) return fallback('label-capacity');
        const result = p.result.view;
        return { available: status === 1, source: starts[result[1]], egressWalkSeconds: result[2],
          edges: status === 1 ? Array.from(p.path.view.subarray(0, result[3]), id => originalEdges[id]).reverse() : [],
          stats: { relaxedEdges: result[4], settledStates: result[5], createdLabels: result[6], corridorEdges: result[7] } };
      } catch (error) {
        release(); rejected.add(router);
        return fallback(error.fallbackReason ?? (error instanceof RangeError ? 'allocation-memory-limit' : 'webassembly-failed'));
      }
    },
  };
}
