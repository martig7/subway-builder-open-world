// Experimental packed C++ search. The production router owns catchments,
// exact-path caching, fare rules and journey materialization.
export function createWasmTransitSearch(bytes, { labelCapacity = null, partition = null, partitionMode = 1 } = {}) {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  const api = instance.exports;
  let graph = null;
  function compile(router) {
    const stationIds = router.stations.map(station => station.id);
    const stationOrdinals = new Map(stationIds.map((id, index) => [id, index]));
    const routeOrdinals = new Map();
    const states = new Map(stationIds.map((id, index) => [`${id}\0`, index]));
    const originalEdges = [], offsets = [0];
    for (const id of stationIds) {
      originalEdges.push(...(router.adjacency.get(id) ?? []));
      offsets.push(originalEdges.length);
    }
    const edgeOrdinals = new Map(originalEdges.map((edge, i) => [edge, i]));
    const edges = [], periods = [], phases = [], chains = [], chainOffsets = [0];
    for (const edge of originalEdges) {
      const ride = edge.type === 'ride', route = edge.route;
      if (ride && !routeOrdinals.has(edge.routeStateId)) routeOrdinals.set(edge.routeStateId, routeOrdinals.size + 1);
      if (!states.has(edge.toStateKey)) states.set(edge.toStateKey, states.size);
      const periodOffset = periods.length / 3;
      const timetable = route?.timetableSchedule?.mode === 'timetable';
      const timetablePeriods = timetable ? route.timetableSchedule.periods ?? [] : [];
      for (const period of timetablePeriods) periods.push(
        Number.isFinite(period.startHour) ? period.startHour : 0,
        Number.isFinite(period.endHour) ? period.endHour : 24,
        Math.max(0, Number.isFinite(period.headwaySeconds) ? period.headwaySeconds : 0));
      const phaseOffset = phases.length;
      phases.push(...(route?.departureAnchorsByNode?.[edge.departureNodeId] ?? []));
      edges.push(stationOrdinals.get(edge.to), states.get(edge.toStateKey), ride ? routeOrdinals.get(edge.routeStateId) : 0,
        ride ? edge.inVehicleSeconds : edge.seconds, edge.dwellSeconds ?? 0, edge.departureOffsetSeconds ?? 0,
        route?.cycleTimeSeconds ?? 0, route?.serviceCount ?? 0, periodOffset, timetable ? timetablePeriods.length : -1,
        phaseOffset, phases.length - phaseOffset);
      const chain = router.cacheEnabled ? router.graphIndex.corridors.get(edge) ?? [edge] : [edge];
      chains.push(...chain.map(item => edgeOrdinals.get(item)));
      chainOffsets.push(chains.length);
    }
    const capacity = labelCapacity ?? Math.max(65536, states.size * 64);
    let offset = Number(api.__heap_base.value);
    const allocations = [];
    const allocate = (Type, length, values = null) => {
      offset = Math.ceil(offset / 8) * 8;
      const block = { pointer: offset, Type, length, values };
      allocations.push(block); offset += length * Type.BYTES_PER_ELEMENT; return block;
    };
    const layout = {
      offsets: allocate(Int32Array, offsets.length, offsets), edges: allocate(Float64Array, edges.length, edges),
      chainOffsets: allocate(Int32Array, chainOffsets.length, chainOffsets), chains: allocate(Int32Array, chains.length, chains),
      periods: allocate(Float64Array, periods.length, periods), phases: allocate(Float64Array, phases.length, phases),
      starts: allocate(Float64Array, stationIds.length * 3), ends: allocate(Float64Array, stationIds.length),
      labels: allocate(Uint8Array, capacity * api.label_size()), best: allocate(Int32Array, states.size),
      heap: allocate(Uint8Array, capacity * api.heap_entry_size()), path: allocate(Int32Array, capacity), result: allocate(Float64Array, 8),
      ...(partition ? { lowerBounds: allocate(Float64Array, stationIds.length) } : {}),
    };
    const additionalPages = Math.ceil((offset - api.memory.buffer.byteLength) / 65536);
    if (additionalPages > 0) api.memory.grow(additionalPages);
    for (const block of allocations) {
      block.view = new block.Type(api.memory.buffer, block.pointer, block.length);
      if (block.values) block.view.set(block.values);
      delete block.values;
    }
    return { router, stationOrdinals, originalEdges, stateCount: states.size, capacity, layout };
  }
  return {
    search(router, { starts, ends, rules, requestedDepartureSeconds, bound }) {
      if (graph?.router !== router) graph = compile(router);
      const { layout: p, stationOrdinals, stateCount, capacity, originalEdges } = graph;
      starts.forEach(([id, { seconds, mode }], index) => p.starts.view.set([stationOrdinals.get(id), seconds, mode === 'drive' ? 1 : 0], index * 3));
      p.ends.view.fill(Infinity);
      for (const [id, seconds] of ends) p.ends.view[stationOrdinals.get(id)] = seconds;
      if (partition) {
        p.lowerBounds.view.set(partition.bounds(router, ends, rules));
        api.set_partition_bounds(p.lowerBounds.pointer, partitionMode);
      }
      const status = api.search(stateCount, capacity, p.offsets.pointer, p.edges.pointer, p.chainOffsets.pointer, p.chains.pointer,
        p.periods.pointer, p.phases.pointer, p.starts.pointer, starts.length, p.ends.pointer,
        requestedDepartureSeconds, rules.PERCEIVED_TIME.WALK_MULTIPLIER, rules.PERCEIVED_TIME.WAIT_MULTIPLIER,
        rules.PERCEIVED_TIME.DEPARTURE_SHIFT_MULTIPLIER, rules.ARRIVAL_GAP, bound,
        p.labels.pointer, p.best.pointer, p.heap.pointer, p.path.pointer, p.result.pointer);
      if (status < 0) return null; // A bounded scratch overflow uses the JS search.
      const result = p.result.view;
      if (partition) partition.record(api.partition_pruned());
      return { available: status === 1, source: starts[result[1]], egressWalkSeconds: result[2],
        edges: status === 1 ? Array.from(p.path.view.subarray(0, result[3]), id => originalEdges[id]).reverse() : [],
        stats: { relaxedEdges: result[4], settledStates: result[5], createdLabels: result[6], corridorEdges: result[7] } };
    },
  };
}
