/** Bounded LRU; weights count retained search labels rather than just queries. */
export class RoutingLRU extends Map {
  constructor(limit, weight = () => 1) { super(); this.limit = limit; this.weight = weight; this.used = 0; }
  get(key) {
    const value = super.get(key);
    if (value !== undefined) { super.delete(key); super.set(key, value); }
    return value;
  }
  delete(key) {
    if (!super.has(key)) return false;
    this.used -= this.weight(super.get(key));
    return super.delete(key);
  }
  set(key, value) {
    this.delete(key);
    const size = this.weight(value);
    if (size > this.limit) return this;
    super.set(key, value); this.used += size;
    while (this.used > this.limit) this.delete(this.keys().next().value);
    return this;
  }
  clear() { super.clear(); this.used = 0; }
}

/** Topological reachability ignores the clock: it can disprove, never promise, service. */
export function indexRoutingGraph(stations, adjacency) {
  const reverse = new Map(stations.map(s => [s.id, []]));
  for (const [from, edges] of adjacency) for (const edge of edges) reverse.get(edge.to)?.push(from);
  // Iterative Kosaraju avoids overflowing the JS stack on long regional corridors.
  const visited = new Set(), order = [];
  for (const { id } of stations) {
    if (visited.has(id)) continue;
    visited.add(id);
    const stack = [[id, 0]];
    while (stack.length) {
      const top = stack.at(-1), edges = adjacency.get(top[0]) ?? [];
      if (top[1] === edges.length) { order.push(top[0]); stack.pop(); continue; }
      const next = edges[top[1]++].to;
      if (!visited.has(next)) { visited.add(next); stack.push([next, 0]); }
    }
  }
  const component = new Map(), members = [];
  for (const id of order.reverse()) {
    if (component.has(id)) continue;
    const ordinal = members.length, group = [], pending = [id];
    component.set(id, ordinal);
    while (pending.length) {
      const at = pending.pop(); group.push(at);
      for (const from of reverse.get(at) ?? []) if (!component.has(from)) { component.set(from, ordinal); pending.push(from); }
    }
    members.push(group);
  }
  const incoming = members.map(() => new Set());
  for (const [from, edges] of adjacency) for (const edge of edges) {
    const a = component.get(from), b = component.get(edge.to);
    if (a !== b) incoming[b].add(a);
  }
  const reachable = new RoutingLRU(256);
  const canReach = (starts, ends) => {
    const targets = [...new Set([...ends].map(id => component.get(id)))].sort((a,b)=>a-b);
    const key = targets.join(',');
    let ancestors = reachable.get(key);
    if (!ancestors) {
      ancestors = new Set(targets); const pending = [...targets];
      while (pending.length) for (const from of incoming[pending.pop()] ?? []) {
        if (!ancestors.has(from)) { ancestors.add(from); pending.push(from); }
      }
      reachable.set(key, ancestors);
    }
    return starts.some(id => ancestors.has(component.get(id)));
  };
  // Weak components are conservative invalidation regions. An added bridge changes
  // both regions, including paths which did not previously use the new edge.
  const region = new Map(), regions = [];
  for (const { id } of stations) {
    if (region.has(id)) continue;
    const ordinal = regions.length, group = [], pending = [id]; region.set(id, ordinal);
    while (pending.length) {
      const at = pending.pop(); group.push(at);
      for (const next of [...(adjacency.get(at) ?? []).map(e => e.to), ...(reverse.get(at) ?? [])]) {
        if (!region.has(next)) { region.set(next, ordinal); pending.push(next); }
      }
    }
    regions.push(group.sort());
  }
  return { component, regions, region, canReach, corridors: compileRoutingCorridors(adjacency) };
}

export function compileRoutingCorridors(adjacency) {
  // Only contract unambiguous ride continuations. Branches, transfers and cycles
  // remain explicit; each shortcut retains every original edge for timing/egress.
  const corridors = new Map();
  for (const edges of adjacency.values()) for (const edge of edges) {
    if (edge.type !== 'ride') continue;
    const chain = [edge], seen = new Set([edge.to]);
    let last = edge;
    while (chain.length < 64) {
      const nextEdges = adjacency.get(last.to) ?? [];
      if (nextEdges.length !== 1) break;
      const next = nextEdges[0];
      if (next.type !== 'ride' || next.routeStateId !== edge.routeStateId || seen.has(next.to)) break;
      chain.push(next); seen.add(next.to); last = next;
    }
    if (chain.length > 1) corridors.set(edge, chain);
  }
  return corridors;
}
