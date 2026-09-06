const EARTH_RADIUS_METRES = 6_371_000;
const GRID_DEGREES = 0.005;
const CLASS_ID = Object.freeze({ highway: 0, major: 1, minor: 2 });

export const GENERATED_ROAD_SPEEDS_MPS = Object.freeze({
  highway: 85 / 3.6,
  major: 50 / 3.6,
  minor: 30 / 3.6,
});

export function haversineMetres(left, right) {
  const lon1 = left[0] * Math.PI / 180;
  const lat1 = left[1] * Math.PI / 180;
  const lon2 = right[0] * Math.PI / 180;
  const lat2 = right[1] * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_METRES * 2 * Math.asin(Math.sqrt(a));
}

export function greatCircleRoute(left, right, segments = 12) {
  if (segments <= 1) return [left, right];
  const lon1 = left[0] * Math.PI / 180;
  const lat1 = left[1] * Math.PI / 180;
  const lon2 = right[0] * Math.PI / 180;
  const lat2 = right[1] * Math.PI / 180;
  const angular = haversineMetres(left, right) / EARTH_RADIUS_METRES;
  if (!(angular > 1e-12)) return [left, right];
  const sinAngular = Math.sin(angular);
  const coordinates = [];
  for (let step = 0; step <= segments; step++) {
    const fraction = step / segments;
    const a = Math.sin((1 - fraction) * angular) / sinAngular;
    const b = Math.sin(fraction * angular) / sinAngular;
    const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
    const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
    const z = a * Math.sin(lat1) + b * Math.sin(lat2);
    coordinates.push([Math.atan2(y, x) * 180 / Math.PI, Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI]);
  }
  return coordinates;
}

const coordinateKey = (coordinate) => `${coordinate[0].toFixed(6)},${coordinate[1].toFixed(6)}`;
const gridKey = (longitude, latitude) => (
  `${Math.floor(longitude / GRID_DEGREES)},${Math.floor(latitude / GRID_DEGREES)}`
);

function linesOf(feature) {
  if (feature?.geometry?.type === 'LineString') return [feature.geometry.coordinates];
  if (feature?.geometry?.type === 'MultiLineString') return feature.geometry.coordinates;
  return [];
}

/** Build a compact, deduplicated segment graph from one or more generated road tiles. */
export function buildGeneratedRoadGraph(collections) {
  const nodeByCoordinate = new Map();
  const longitude = [];
  const latitude = [];
  const node = (coordinate) => {
    const key = coordinateKey(coordinate);
    let id = nodeByCoordinate.get(key);
    if (id == null) {
      id = longitude.length;
      nodeByCoordinate.set(key, id);
      longitude.push(Number(coordinate[0]));
      latitude.push(Number(coordinate[1]));
    }
    return id;
  };

  // Halo overlap repeats many OSM segments. Deduplicate by endpoint pair and
  // retain the fastest class when two source ways disagree.
  const segmentByPair = new Map();
  for (const collection of collections ?? []) {
    for (const feature of collection?.features ?? []) {
      const roadClass = CLASS_ID[feature?.properties?.roadClass] ?? CLASS_ID.minor;
      for (const line of linesOf(feature)) {
        for (let index = 1; index < line.length; index++) {
          const from = node(line[index - 1]);
          const to = node(line[index]);
          if (from === to) continue;
          const key = from < to ? `${from}:${to}` : `${to}:${from}`;
          const metres = haversineMetres(line[index - 1], line[index]);
          if (!(metres > 0)) continue;
          const previous = segmentByPair.get(key);
          if (!previous || roadClass < previous.roadClass) {
            segmentByPair.set(key, { from, to, metres, roadClass });
          }
        }
      }
    }
  }

  const edgeCount = segmentByPair.size * 2;
  const head = new Int32Array(longitude.length).fill(-1);
  const to = new Int32Array(edgeCount);
  const next = new Int32Array(edgeCount);
  const metres = new Float64Array(edgeCount);
  const roadClass = new Uint8Array(edgeCount);
  let edge = 0;
  const link = (from, target, segment) => {
    to[edge] = target;
    metres[edge] = segment.metres;
    roadClass[edge] = segment.roadClass;
    next[edge] = head[from];
    head[from] = edge;
    edge++;
  };
  for (const segment of segmentByPair.values()) {
    link(segment.from, segment.to, segment);
    link(segment.to, segment.from, segment);
  }

  const grid = new Map();
  for (let id = 0; id < longitude.length; id++) {
    const key = gridKey(longitude[id], latitude[id]);
    const bucket = grid.get(key) ?? [];
    bucket.push(id);
    grid.set(key, bucket);
  }
  return {
    longitude: Float64Array.from(longitude),
    latitude: Float64Array.from(latitude),
    nodeCount: longitude.length,
    head, to, next, metres, roadClass, edgeCount, grid,
  };
}

function snapToNode(graph, coordinate, maxRings = 40) {
  if (!graph?.nodeCount) return null;
  const cellX = Math.floor(coordinate[0] / GRID_DEGREES);
  const cellY = Math.floor(coordinate[1] / GRID_DEGREES);
  for (let ring = 0; ring < maxRings; ring++) {
    let best = null;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        for (const candidate of graph.grid.get(`${cellX + dx},${cellY + dy}`) ?? []) {
          const distance = haversineMetres(coordinate, [graph.longitude[candidate], graph.latitude[candidate]]);
          if (!best || distance < best.distance) best = { node: candidate, distance };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

class MinHeap {
  constructor() { this.priorities = []; this.nodes = []; }
  get size() { return this.nodes.length; }
  push(priority, node) {
    let index = this.nodes.length;
    this.priorities.push(priority); this.nodes.push(node);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.priorities[parent] <= priority) break;
      this.priorities[index] = this.priorities[parent]; this.nodes[index] = this.nodes[parent];
      index = parent;
    }
    this.priorities[index] = priority; this.nodes[index] = node;
  }
  pop() {
    const result = { priority: this.priorities[0], node: this.nodes[0] };
    const priority = this.priorities.pop();
    const node = this.nodes.pop();
    if (this.nodes.length) {
      let index = 0;
      this.priorities[0] = priority; this.nodes[0] = node;
      for (;;) {
        const left = index * 2 + 1; const right = left + 1;
        let smallest = index;
        if (left < this.nodes.length && this.priorities[left] < this.priorities[smallest]) smallest = left;
        if (right < this.nodes.length && this.priorities[right] < this.priorities[smallest]) smallest = right;
        if (smallest === index) break;
        [this.priorities[index], this.priorities[smallest]] = [this.priorities[smallest], this.priorities[index]];
        [this.nodes[index], this.nodes[smallest]] = [this.nodes[smallest], this.nodes[index]];
        index = smallest;
      }
    }
    return result;
  }
}

// Worker queries are serialized. Weak ownership releases workspace with an evicted graph.
const searchWorkspaces = new WeakMap();

function searchWorkspace(graph) {
  let workspace = searchWorkspaces.get(graph);
  if (!workspace || workspace.time.length !== graph.nodeCount) {
    workspace = { time: new Float64Array(graph.nodeCount), seen: new Uint32Array(graph.nodeCount),
      parent: new Int32Array(graph.nodeCount), generation: 0 };
    searchWorkspaces.set(graph, workspace);
  }
  workspace.generation = (workspace.generation + 1) >>> 0;
  if (workspace.generation === 0) {
    workspace.seen.fill(0);
    workspace.generation = 1;
  }
  return workspace;
}

export function routeGeneratedRoadGraph(graph, origin, destination, {
  speeds = GENERATED_ROAD_SPEEDS_MPS,
  maxSnapMetres = 5_000,
  maxDetourRatio = 3,
} = {}) {
  const from = snapToNode(graph, origin);
  const to = snapToNode(graph, destination);
  if (!from || !to || from.distance > maxSnapMetres || to.distance > maxSnapMetres) return null;
  const directMetres = haversineMetres(origin, destination);
  if (from.node === to.node) {
    return { coordinates: [origin, destination], distanceMetres: directMetres, seconds: 60, snapMetres: from.distance + to.distance };
  }

  const speedByClass = [speeds.highway, speeds.major, speeds.minor];
  const maxSpeed = Math.max(...speedByClass);
  const { time, seen, parent, generation } = searchWorkspace(graph);
  const heap = new MinHeap();
  const heuristic = (node) => haversineMetres(
    [graph.longitude[node], graph.latitude[node]],
    [graph.longitude[to.node], graph.latitude[to.node]],
  ) / maxSpeed;
  time[from.node] = 0; seen[from.node] = generation; parent[from.node] = -1; heap.push(heuristic(from.node), from.node);

  while (heap.size) {
    const current = heap.pop();
    if (current.node === to.node) break;
    if (current.priority > time[current.node] + heuristic(current.node) + 1e-9) continue;
    for (let edge = graph.head[current.node]; edge !== -1; edge = graph.next[edge]) {
      const target = graph.to[edge];
      const candidate = time[current.node] + graph.metres[edge] / speedByClass[graph.roadClass[edge]];
      if (seen[target] !== generation || candidate < time[target]) {
        seen[target] = generation; time[target] = candidate; parent[target] = current.node;
        heap.push(candidate + heuristic(target), target);
      }
    }
  }
  if (seen[to.node] !== generation || parent[to.node] === -1) return null;
  const nodes = [];
  for (let node = to.node; node !== -1; node = parent[node]) {
    nodes.push(node);
    if (node === from.node) break;
  }
  if (nodes[nodes.length - 1] !== from.node) return null;
  nodes.reverse();
  const coordinates = [origin];
  let routeMetres = from.distance + to.distance;
  for (let index = 0; index < nodes.length; index++) {
    const coordinate = [graph.longitude[nodes[index]], graph.latitude[nodes[index]]];
    const previous = coordinates[coordinates.length - 1];
    if (coordinate[0] !== previous[0] || coordinate[1] !== previous[1]) coordinates.push(coordinate);
    if (index > 0) routeMetres += haversineMetres(
      [graph.longitude[nodes[index - 1]], graph.latitude[nodes[index - 1]]], coordinate,
    );
  }
  const last = coordinates[coordinates.length - 1];
  if (last[0] !== destination[0] || last[1] !== destination[1]) coordinates.push(destination);
  if (directMetres > 0 && routeMetres / directMetres > maxDetourRatio) return null;
  return {
    coordinates,
    distanceMetres: Math.round(routeMetres),
    seconds: Math.max(60, Math.round(time[to.node] + from.distance / speeds.minor + to.distance / speeds.minor)),
    snapMetres: Math.round(from.distance + to.distance),
  };
}
