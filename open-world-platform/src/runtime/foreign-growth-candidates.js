import { haversineMetres } from './generated-road-routing.js';

const RADIUS_M = 6371000; // Same spherical distance convention as packaged cross-tile simulation.
const LIMIT = 2048;
const RAD = Math.PI / 180;
const validCoordinate = value => Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])
  && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
const vector = ([longitude, latitude]) => {
  const cosine = Math.cos(latitude * RAD);
  return [cosine * Math.cos(longitude * RAD), cosine * Math.sin(longitude * RAD), Math.sin(latitude * RAD)];
};
const stationCoordinate = station => Array.isArray(station) ? station : station?.location ?? station?.coords;
const compareId = (a, b) => a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function* selectMedian(points, left, right, median, axis) {
  let work = 0;
  while (left < right) {
    const pivot = points[(left + right) >> 1].vector[axis];
    let low = left, high = right;
    while (low <= high) {
      while (points[low].vector[axis] < pivot) { low++; if ((++work & 255) === 0) yield; }
      while (points[high].vector[axis] > pivot) { high--; if ((++work & 255) === 0) yield; }
      if (low <= high) {
        [points[low], points[high]] = [points[high], points[low]];
        low++; high--;
        if ((++work & 255) === 0) yield;
      }
    }
    if (median <= high) right = high;
    else if (median >= low) left = low;
    else return;
  }
}

function* buildTree(points, start = 0, end = points.length) {
  if (start >= end) return null;
  // Bounds scan is also sliced; the national catalog is not sorted in one blocking call.
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let index = start; index < end; index++) {
    for (let axis = 0; axis < 3; axis++) {
      bounds[axis] = Math.min(bounds[axis], points[index].vector[axis]);
      bounds[axis + 3] = Math.max(bounds[axis + 3], points[index].vector[axis]);
    }
    if ((index & 255) === 0) yield;
  }
  if (end - start <= 16) return { bounds, start, end };
  let axis = 0;
  for (let candidate = 1; candidate < 3; candidate++) if (bounds[candidate + 3] - bounds[candidate] > bounds[axis + 3] - bounds[axis]) axis = candidate;
  const median = (start + end) >> 1;
  yield* selectMedian(points, start, end - 1, median, axis);
  return { bounds, left: yield* buildTree(points, start, median), right: yield* buildTree(points, median, end) };
}

function sphereBoundsDistanceSquared(bounds, centre) {
  let distance = 0;
  for (let axis = 0; axis < 3; axis++) {
    const delta = centre[axis] < bounds[axis] ? bounds[axis] - centre[axis]
      : centre[axis] > bounds[axis + 3] ? centre[axis] - bounds[axis + 3] : 0;
    distance += delta * delta;
  }
  return distance;
}

function queryTree(node, points, centre, chordSquared, visit) {
  if (!node || sphereBoundsDistanceSquared(node.bounds, centre) > chordSquared + 1e-14) return;
  if (node.start != null) { for (let index = node.start; index < node.end; index++) visit(points[index]); return; }
  queryTree(node.left, points, centre, chordSquared, visit); queryTree(node.right, points, centre, chordSquared, visit);
}

function* compileCandidates(data, ownership) {
  if (!Array.isArray(data?.points) || !Array.isArray(data?.pops)) throw new Error('Packaged cross-demand candidates are unavailable');
  const pointFields = new Map((data.pointFields ?? ['id', 'longitude', 'latitude', 'tileId', 'residents', 'workers']).map((field, index) => [field, index]));
  const popFields = new Map((data.popFields ?? ['id', 'mass', 'homePoint', 'workPoint']).map((field, index) => [field, index]));
  const idIndex = pointFields.get('id'), longitudeIndex = pointFields.get('longitude'), latitudeIndex = pointFields.get('latitude');
  const workIndex = popFields.get('workPoint'), massIndex = popFields.get('mass');
  if ([idIndex, longitudeIndex, latitudeIndex, workIndex, massIndex].some(index => index == null)) throw new Error('Unsupported packaged cross-demand candidate schema');
  const jobs = new Float64Array(data.points.length);
  for (let index = 0; index < data.pops.length; index++) {
    const pop = data.pops[index], work = pop[workIndex], mass = pop[massIndex];
    if (!Number.isInteger(work) || work < 0 || work >= jobs.length || !Number.isFinite(mass) || mass < 0) throw new Error('Invalid packaged cross-demand work cohort');
    jobs[work] += mass;
    if ((index & 255) === 0) yield;
  }
  const points = [], ids = new Set();
  for (let index = 0; index < jobs.length; index++) {
    if (jobs[index] > 0) {
      const raw = data.points[index], location = [raw[longitudeIndex], raw[latitudeIndex]];
      if (!validCoordinate(location) || !Number.isFinite(jobs[index]) || raw[idIndex] == null) throw new Error('Invalid packaged cross-demand work endpoint');
      // The original owner is authoritative; packaged labels or native halos cannot decide this.
      const tileId = ownership.ownerAt(location);
      if (tileId != null) {
        const id = String(raw[idIndex]), key = JSON.stringify([tileId, id]);
        if (ids.has(key)) throw new Error('Duplicate packaged cross-demand work endpoint');
        ids.add(key);
        const descriptor = Object.freeze({ id, location: Object.freeze(location), tileId, residents: 0, jobs: jobs[index] });
        points.push({ descriptor, vector: vector(location) });
      }
    }
    if ((index & 255) === 0) yield;
  }
  const tree = yield* buildTree(points);
  return { points, tree };
}

function createHandle(key, points, tree, ownership) {
  return Object.freeze({ version: 1, key,
    query({ tileId, stations = [], radiusM, limit = LIMIT }, currentOwnership = ownership) {
      if (!currentOwnership || currentOwnership.key !== ownership.key) throw new Error('Foreign candidate ownership artifact changed');
      if (typeof tileId !== 'string' || !Number.isFinite(radiusM) || radiusM < 0 || !Number.isFinite(limit) || limit <= 0) return [];
      const maximum = Math.min(LIMIT, Math.floor(limit));
      if (!maximum) return [];
      const chord = 2 * Math.sin(Math.min(Math.PI, radiusM / RADIUS_M) / 2);
      const matches = new Map();
      for (const station of stations) {
        if (!Array.isArray(station) && (station?.served === false || station?.buildType === 'planned'
          || (Array.isArray(station?.routeIds) && station.routeIds.length === 0))) continue;
        const location = stationCoordinate(station);
        if (!validCoordinate(location)) continue;
        queryTree(tree, points, vector(location), chord * chord, point => {
          const descriptor = point.descriptor;
          if (descriptor.tileId === tileId) return;
          const distance = haversineMetres(location, descriptor.location);
          if (distance > radiusM) return;
          const previous = matches.get(descriptor);
          if (previous == null || distance < previous) matches.set(descriptor, distance);
        });
      }
      return [...matches].sort((a, b) => a[1] - b[1] || compareId(a[0], b[0])).slice(0, maximum).map(([descriptor]) => descriptor);
    },
  });
}

/** Build once from the already packaged cross catalog. Does not request any native Tile demand. */
export async function prepareForeignGrowthCandidates({ tilePackages, tileId, ownership }, scheduling = {}) {
  if (ownership?.version !== 1 || typeof ownership.key !== 'string' || typeof ownership.ownerAt !== 'function') throw new Error('Foreign candidates require authoritative tile ownership');
  const cancelled = scheduling.isCancelled ?? (() => false), now = scheduling.nowMs ?? (() => performance.now());
  const yieldFn = scheduling.yieldFn ?? (() => new Promise(resolve => setTimeout(resolve, 0)));
  const sliceMs = Math.max(0.1, scheduling.sliceMs ?? 5);
  if (cancelled()) return null;
  const data = await tilePackages.loadCrossDemand(tileId);
  if (cancelled()) return null;
  const iterator = compileCandidates(data, ownership);
  let sliceStart = now();
  try {
    while (true) {
      const step = iterator.next();
      if (step.done) {
        scheduling.onSlice?.(now() - sliceStart);
        return cancelled() ? null : createHandle(`foreign-growth-v1:${ownership.key}`, step.value.points, step.value.tree, ownership);
      }
      if (now() - sliceStart >= sliceMs) {
        scheduling.onSlice?.(now() - sliceStart);
        if (cancelled()) return null;
        await yieldFn();
        if (cancelled()) return null;
        sliceStart = now();
      }
    }
  } finally { iterator.return(); }
}
