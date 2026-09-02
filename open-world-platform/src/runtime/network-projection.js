import {
  CANONICAL_NATIVE_NETWORK_MODE,
  SHARED_TRANSIT_STATE_KEYS,
  hasCompleteNativeTopology,
} from './shared-transit-network.js';
import { projectRouteTimings } from './route-timing-integrity.js';

const SCHEMA_VERSION = 1;
const ENTITY_KEYS = Object.freeze(['tracks', 'trains', 'routes', 'trackGroups', 'signals', 'stNodes', 'stations', 'stationGroups']);
const STRUCTURAL_STATE_KEYS = Object.freeze([
  'tracks',
  'routes',
  'trackGroups',
  'stNodes',
  'stations',
  'stationGroups',
  'fareGroups',
  'ownedTrainCount',
  'ownedCarsByType',
]);
const EPSILON = 1e-9;

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const array = (value) => Array.isArray(value) ? value : [];
const idOf = (value) => value?.id == null ? null : String(value.id);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableHash(value) {
  const stable = stableValue(value);
  // JSON.stringify intentionally returns `undefined` for an undefined root.
  // Optional native fields are routinely added/removed between projection
  // snapshots, so hashing must be total over that value as well.
  const text = stable === undefined ? '<undefined>' : JSON.stringify(stable);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function snapshotState(snapshot) { return snapshot?.data ?? snapshot ?? {}; }

function withSnapshotState(snapshot, state) {
  if (snapshot?.data) return { ...clone(snapshot), data: state };
  return state;
}

function metersToDegrees(meters, latitude) {
  const latitudeDegrees = meters / 111_320;
  const longitudeDegrees = meters / (111_320 * Math.max(0.2, Math.cos(latitude * Math.PI / 180)));
  return [longitudeDegrees, latitudeDegrees];
}

function expandBounds(bounds, meters) {
  const latitude = (bounds[1] + bounds[3]) / 2;
  const [longitudeDegrees, latitudeDegrees] = metersToDegrees(meters, latitude);
  return [bounds[0] - longitudeDegrees, bounds[1] - latitudeDegrees, bounds[2] + longitudeDegrees, bounds[3] + latitudeDegrees];
}

function pointInBounds(point, bounds) {
  return Array.isArray(point) && point.length >= 2
    && point[0] >= bounds[0] - EPSILON && point[0] <= bounds[2] + EPSILON
    && point[1] >= bounds[1] - EPSILON && point[1] <= bounds[3] + EPSILON;
}

function pointInAny(point, boundsList) { return boundsList.some((bounds) => pointInBounds(point, bounds)); }

function coordinateOf(value) {
  if (Array.isArray(value?.coords) && typeof value.coords[0] === 'number') return value.coords;
  if (value?.geometry?.type === 'Point') return value.geometry.coordinates;
  if (Array.isArray(value?.coordinates) && typeof value.coordinates[0] === 'number') return value.coordinates;
  return null;
}

function lineCoordinates(value) {
  if (Array.isArray(value?.coords) && Array.isArray(value.coords[0])) return value.coords;
  if (value?.geometry?.type === 'LineString') return value.geometry.coordinates;
  if (Array.isArray(value?.coordinates) && Array.isArray(value.coordinates[0])) return value.coordinates;
  return null;
}

function withLineCoordinates(value, coordinates) {
  const result = clone(value);
  if (Array.isArray(result?.coords) && Array.isArray(result.coords[0])) result.coords = coordinates;
  else if (result?.geometry?.type === 'LineString') result.geometry.coordinates = coordinates;
  else result.coordinates = coordinates;
  return result;
}

function segmentIntervalForBounds(start, end, bounds) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  let low = 0;
  let high = 1;
  const tests = [
    [-dx, start[0] - bounds[0]],
    [dx, bounds[2] - start[0]],
    [-dy, start[1] - bounds[1]],
    [dy, bounds[3] - start[1]],
  ];
  for (const [p, q] of tests) {
    if (Math.abs(p) <= EPSILON) {
      if (q < 0) return null;
      continue;
    }
    const ratio = q / p;
    if (p < 0) low = Math.max(low, ratio);
    else high = Math.min(high, ratio);
    if (low > high + EPSILON) return null;
  }
  return [Math.max(0, low), Math.min(1, high)];
}

function mergeIntervals(intervals) {
  const sorted = intervals.filter(Boolean).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (!last || interval[0] > last[1] + EPSILON) merged.push([...interval]);
    else last[1] = Math.max(last[1], interval[1]);
  }
  return merged;
}

function interpolate(start, end, ratio) {
  return [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
}

function samePoint(left, right) {
  return Math.abs(left[0] - right[0]) <= EPSILON && Math.abs(left[1] - right[1]) <= EPSILON;
}

function clipLineToBoundsUnion(coordinates, boundsList) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
  const fragments = [];
  let current = null;
  for (let index = 1; index < coordinates.length; index++) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    const intervals = mergeIntervals(boundsList.map((bounds) => segmentIntervalForBounds(start, end, bounds)));
    if (!intervals.length) {
      current = null;
      continue;
    }
    for (const [low, high] of intervals) {
      const clippedStart = interpolate(start, end, low);
      const clippedEnd = interpolate(start, end, high);
      if (!current || !samePoint(current.at(-1), clippedStart)) {
        current = [clippedStart];
        fragments.push(current);
      }
      if (!samePoint(current.at(-1), clippedEnd)) current.push(clippedEnd);
      if (high < 1 - EPSILON) current = null;
    }
  }
  return fragments.filter((fragment) => fragment.length >= 2);
}

function unchangedLine(original, fragments) {
  if (fragments.length !== 1 || fragments[0].length !== original.length) return false;
  return original.every((point, index) => samePoint(point, fragments[0][index]));
}

function idsFrom(value, keys) {
  const result = new Set();
  const visit = (candidate, parentKey = '') => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, parentKey);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, item] of Object.entries(candidate)) {
      if (keys.has(key) && (typeof item === 'string' || typeof item === 'number')) result.add(String(item));
      else if (keys.has(key) && Array.isArray(item)) {
        for (const id of item) if (id != null) result.add(String(id));
      }
      else if (typeof item === 'object' && (key === 'path' || key === 'stCombos' || key === 'stNodes' || key === 'legs')) visit(item, key);
    }
  };
  visit(value);
  return result;
}

function routeTrackIds(route) { return idsFrom(route, new Set(['trackId', 'trackIds'])); }
function routeNodeIds(route) {
  const result = idsFrom(route, new Set(['stNodeId', 'stNodeIds']));
  // Native routes also store their ordered station nodes as `{ id }` records.
  // Do not teach the generic walker that every `id` is a station-node ID:
  // doing so would accidentally collect route/leg/track IDs elsewhere.
  for (const node of array(route?.stNodes)) if (node?.id != null) result.add(String(node.id));
  return result;
}
function trackNodeIds(track) { return idsFrom(track, new Set(['stNodeId', 'stNodeIds', 'startNodeId', 'endNodeId'])); }

function signalTrackIds(signal) {
  const ids = idsFrom(signal, new Set(['trackId', 'trackIds']));
  for (const signalTrack of array(signal?.signalTracks)) {
    if (signalTrack?.trackId != null) ids.add(String(signalTrack.trackId));
  }
  return ids;
}

function routeStationIds(route, stationByNode) {
  const result = idsFrom(route, new Set(['stationId', 'stationIds']));
  for (const nodeId of routeNodeIds(route)) {
    const stationId = stationByNode.get(nodeId);
    if (stationId) result.add(stationId);
  }
  for (const node of array(route?.stNodes)) {
    const stationId = node?.stationId ?? stationByNode.get(String(node?.id));
    if (stationId) result.add(String(stationId));
  }
  return result;
}

function indexById(values) { return new Map(array(values).map((value) => [idOf(value), value]).filter(([id]) => id)); }

function routeDescriptor(route, stationByNode) {
  const orderedStationIds = [];
  for (const node of array(route?.stNodes)) {
    const stationId = node?.stationId ?? stationByNode.get(String(node?.id));
    if (stationId != null && orderedStationIds.at(-1) !== String(stationId)) orderedStationIds.push(String(stationId));
  }
  const stationIds = orderedStationIds.length ? orderedStationIds : [...routeStationIds(route, stationByNode)];
  const trackIds = [...routeTrackIds(route)];
  const timingCycleSeconds = array(route.stComboTimings).reduce((maximum, timing) => Math.max(
    maximum,
    Number(timing?.arrivalTime) || 0,
    Number(timing?.departureTime) || 0,
  ), 0);
  return {
    id: String(route.id),
    name: route.name ?? route.bullet ?? route.fullName ?? String(route.id),
    fullName: route.fullName ?? null,
    color: route.color ?? '#ffffff',
    fareGroupId: route.fareGroupId ?? null,
    trainType: route.trainType ?? route.trainTypeId ?? null,
    carsPerTrain: route.carsPerTrain ?? null,
    orderedStationIds: stationIds,
    orderedSegmentIds: trackIds,
    timetableSchedule: clone(route.timetableSchedule ?? null),
    trainSchedule: clone(route.trainSchedule ?? null),
    fullCycleTimeSeconds: Number(route.cycleTimeSeconds ?? route.totalCycleTime ?? route.cycleTime ?? timingCycleSeconds) || 0,
  };
}

function descriptorsFor(state) {
  const stationByNode = new Map();
  for (const station of array(state.stations)) {
    for (const nodeId of array(station.stNodeIds)) stationByNode.set(String(nodeId), String(station.id));
  }
  return Object.fromEntries(array(state.routes).filter((route) => idOf(route)).map((route) => [String(route.id), routeDescriptor(route, stationByNode)]));
}

const ROUTE_SERVICE_KEYS = Object.freeze([
  'name',
  'fullName',
  'bullet',
  'color',
  'textColor',
  'fareGroupId',
  'fareSystem',
  'trainType',
  'carsPerTrain',
  'trainSchedule',
  'timetableSchedule',
  'idealTrainCount',
]);

function canonicalRouteFromProjection(route) {
  if (!route || typeof route !== 'object') return clone(route);
  let canonical = route;
  const seen = new Set();
  // Projection facades can be promoted by recovery from an old native save.
  // Repeated hot reloads historically nested those facades, so unwrap until
  // the last complete route rather than assuming a single wrapper level.
  while (canonical && typeof canonical === 'object' && !seen.has(canonical)) {
    seen.add(canonical);
    const next = canonical.openWorldGlobalRoute ?? canonical.openWorldNativeCommuteRoute;
    if (!next || typeof next !== 'object') break;
    canonical = next;
  }
  const result = clone(canonical);
  for (const key of Object.keys(result ?? {})) if (key.startsWith('openWorld')) delete result[key];

  // The facade is the user's current service editor. Topology comes from the
  // complete embedded route, but schedule/fare/presentation edits made since
  // that embedding must survive recovery.
  for (const key of ROUTE_SERVICE_KEYS) {
    let value = route[key];
    if (value == null && key === 'trainSchedule' && route.openWorldGlobalTrainSchedule != null) {
      value = route.openWorldGlobalTrainSchedule;
    }
    if (value === undefined) continue;
    result[key] = clone(value);
  }
  return result;
}

function deferredTrainsFromProjectionRoute(route, output, visited = new Set()) {
  if (!route || typeof route !== 'object' || visited.has(route)) return;
  visited.add(route);
  for (const train of array(route.openWorldNativeCommuteTrains)) {
    const id = idOf(train);
    if (id && !output.has(id)) output.set(id, clone(train));
  }
  deferredTrainsFromProjectionRoute(route.openWorldGlobalRoute, output, visited);
  deferredTrainsFromProjectionRoute(route.openWorldNativeCommuteRoute, output, visited);
}

function networkStateFrom(source) {
  const state = snapshotState(source);
  return Object.fromEntries(SHARED_TRANSIT_STATE_KEYS.map((key) => [
    key,
    clone(state[key] ?? (ENTITY_KEYS.includes(key) ? [] : null)),
  ]));
}

function authoritativeNetworkStateFrom(source) {
  const state = snapshotState(source);
  const result = networkStateFrom(state);
  const trainsById = new Map(array(result.trains)
    .filter((train) => idOf(train))
    .map((train) => [String(train.id), train]));
  for (const route of array(state.routes)) deferredTrainsFromProjectionRoute(route, trainsById);
  result.routes = array(state.routes).map(canonicalRouteFromProjection);
  result.trains = [...trainsById.values()];
  return result;
}

function structuralHashFrom(source) {
  const state = snapshotState(source);
  return stableHash(Object.fromEntries(STRUCTURAL_STATE_KEYS.map((key) => [
    key,
    clone(state[key] ?? (ENTITY_KEYS.includes(key) ? [] : null)),
  ])));
}

export function createGlobalNetwork(source, revision = 0) {
  const nativeState = authoritativeNetworkStateFrom(source);
  return {
    schemaVersion: SCHEMA_VERSION,
    revision,
    nativeState,
    routeDescriptors: descriptorsFor(nativeState),
    hash: stableHash(nativeState),
  };
}

/**
 * Compose the complete native save payload from a tile-local base snapshot
 * and the canonical world network.  This is the native lifecycle seam: the
 * result is suitable for loadSave/restoreSnapshot and is never clipped to
 * the active geographic window.
 */
export function createNativeNetworkSnapshot(baseSnapshot, network) {
  const source = network?.nativeState ?? network ?? {};
  const state = {
    ...clone(snapshotState(baseSnapshot)),
    ...authoritativeNetworkStateFrom(source),
  };
  return withSnapshotState(baseSnapshot, state);
}

/**
 * Public contract used by runtime/entry seams.  It intentionally reports
 * completeness independently from the presentation manifest.
 */
export function inspectNativeNetworkSnapshot(snapshot) {
  const state = snapshotState(snapshot);
  return {
    mode: CANONICAL_NATIVE_NETWORK_MODE,
    complete: hasCompleteNativeTopology(state),
    state: authoritativeNetworkStateFrom(state),
  };
}

export function stripNetworkFromSnapshot(snapshot) {
  const state = clone(snapshotState(snapshot));
  for (const key of SHARED_TRANSIT_STATE_KEYS) {
    if (Array.isArray(state[key])) state[key] = [];
    else if (state[key] && typeof state[key] === 'object') state[key] = {};
    else delete state[key];
  }
  return withSnapshotState(snapshot, state);
}

function catalogWindow(catalog, activeTileId, guardBandMeters) {
  const active = array(catalog?.tiles).find((tile) => tile.id === activeTileId);
  if (!active || !Number.isFinite(active.column) || !Number.isFinite(active.row) || !Array.isArray(active.bounds)) return null;
  const tiles = array(catalog?.spatialTiles ?? catalog?.tiles).filter((tile) => tile.status !== 'sliver'
    && Array.isArray(tile.bounds)
    && Math.max(Math.abs(tile.column - active.column), Math.abs(tile.row - active.row)) <= 1);
  const editableBounds = tiles.map((tile) => tile.bounds.map(Number));
  return {
    active,
    tileIds: tiles.map((tile) => tile.id),
    editableBounds,
    renderBounds: editableBounds.map((bounds) => expandBounds(bounds, guardBandMeters)),
  };
}

function lineIntersectsBounds(coordinates, bounds) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return false;
  for (let index = 1; index < coordinates.length; index++) {
    const interval = segmentIntervalForBounds(coordinates[index - 1], coordinates[index], bounds);
    if (interval && interval[1] - interval[0] > EPSILON) return true;
  }
  return false;
}

/**
 * Routes are finance-owned when their canonical route family touches more
 * than one logical map tile. This remains stable as the 3x3 render window
 * moves, unlike the projection's contained/partial classification.
 */
export function classifyCrossTileRouteIds(nativeState, catalog) {
  const tileIdsByRoute = routeTileIdsById(nativeState, catalog);
  return Object.entries(tileIdsByRoute)
    .filter(([, tileIds]) => tileIds.length > 1)
    .map(([routeId]) => routeId)
    .sort();
}

/**
 * Resolve each route family to the logical tiles its built geometry serves.
 * The optional guard band includes stations just beyond a tile boundary whose
 * walking catchment can still serve native demand inside that tile.
 */
export function routeTileIdsById(nativeState, catalog, { guardBandMeters = 0 } = {}) {
  const tiles = array(catalog?.tiles).filter((tile) => Array.isArray(tile.bounds));
  if (!tiles.length) return {};
  const spatialTiles = tiles.map((tile) => ({
    ...tile,
    demandBounds: guardBandMeters > 0 ? expandBounds(tile.bounds, guardBandMeters) : tile.bounds,
  }));
  const trackById = indexById(nativeState?.tracks);
  const stationById = indexById(nativeState?.stations);
  const stationByNode = new Map();
  for (const station of stationById.values()) {
    for (const nodeId of array(station.stNodeIds)) stationByNode.set(String(nodeId), String(station.id));
  }
  const routeFamily = new Map(array(nativeState?.routes).filter((route) => idOf(route)).map((route) => [
    String(route.id),
    String(route.tempParentId ?? route.id),
  ]));
  const tilesByFamily = new Map();
  for (const route of array(nativeState?.routes)) {
    const routeId = idOf(route);
    if (!routeId) continue;
    const familyId = routeFamily.get(routeId) ?? routeId;
    const touched = tilesByFamily.get(familyId) ?? new Set();
    for (const trackId of routeTrackIds(route)) {
      const coords = lineCoordinates(trackById.get(trackId));
      if (!coords) continue;
      for (const tile of spatialTiles) if (lineIntersectsBounds(coords, tile.demandBounds)) touched.add(String(tile.id));
    }
    for (const stationId of routeStationIds(route, stationByNode)) {
      const coords = coordinateOf(stationById.get(stationId));
      if (!coords) continue;
      if (guardBandMeters > 0) {
        for (const tile of spatialTiles) if (pointInBounds(coords, tile.demandBounds)) touched.add(String(tile.id));
      } else {
        // A boundary station belongs to one deterministic tile. Geometry—not
        // a shared boundary point—is what promotes a route to global ownership.
        const tile = spatialTiles.find((candidate) => pointInBounds(coords, candidate.bounds));
        if (tile) touched.add(String(tile.id));
      }
    }
    tilesByFamily.set(familyId, touched);
  }
  return Object.fromEntries([...routeFamily.entries()].map(([routeId, familyId]) => [
    routeId,
    [...(tilesByFamily.get(familyId) ?? [])].sort(),
  ]));
}

function featureForLine(coordinates, properties) {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties };
}

function filterGroup(group, retainedStationIds, retainedTrackIds) {
  const result = clone(group);
  if (Array.isArray(result.stationIds)) result.stationIds = result.stationIds.filter((id) => retainedStationIds.has(String(id)));
  if (Array.isArray(result.trackIds)) result.trackIds = result.trackIds.filter((id) => retainedTrackIds.has(String(id)));
  return result;
}

function centerLineForStationTracks(tracks, fallbackPoint) {
  const endpoints = tracks.flatMap((track) => {
    const coordinates = lineCoordinates(track);
    return coordinates?.length >= 2 ? [coordinates[0], coordinates.at(-1)] : [];
  }).filter((point) => Array.isArray(point) && point.length >= 2 && point.every(Number.isFinite));
  if (endpoints.length < 2) return fallbackPoint ? [clone(fallbackPoint), clone(fallbackPoint)] : [];

  let farthest = [endpoints[0], endpoints[1]];
  let farthestSquared = -1;
  for (let left = 0; left < endpoints.length; left++) {
    for (let right = left + 1; right < endpoints.length; right++) {
      const dx = endpoints[right][0] - endpoints[left][0];
      const dy = endpoints[right][1] - endpoints[left][1];
      const squared = dx * dx + dy * dy;
      if (squared > farthestSquared) {
        farthest = [endpoints[left], endpoints[right]];
        farthestSquared = squared;
      }
    }
  }
  if (farthestSquared <= EPSILON * EPSILON) return [clone(farthest[0]), clone(farthest[1])];

  const axis = [farthest[1][0] - farthest[0][0], farthest[1][1] - farthest[0][1]];
  const projections = endpoints.map((point) => ({
    point,
    value: (point[0] - farthest[0][0]) * axis[0] + (point[1] - farthest[0][1]) * axis[1],
  }));
  const minimum = Math.min(...projections.map(({ value }) => value));
  const maximum = Math.max(...projections.map(({ value }) => value));
  const endTolerance = (maximum - minimum) * 0.1 + EPSILON;
  const average = (points) => points.reduce(
    (sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length],
    [0, 0],
  );
  const centerLine = [
    average(projections.filter(({ value }) => value <= minimum + endTolerance).map(({ point }) => point)),
    average(projections.filter(({ value }) => value >= maximum - endTolerance).map(({ point }) => point)),
  ];
  const firstTrackCoordinates = lineCoordinates(tracks[0]);
  if (firstTrackCoordinates?.length >= 2) {
    const firstDirection = [
      firstTrackCoordinates.at(-1)[0] - firstTrackCoordinates[0][0],
      firstTrackCoordinates.at(-1)[1] - firstTrackCoordinates[0][1],
    ];
    const centerDirection = [centerLine[1][0] - centerLine[0][0], centerLine[1][1] - centerLine[0][1]];
    if (firstDirection[0] * centerDirection[0] + firstDirection[1] * centerDirection[1] < 0) centerLine.reverse();
  }
  return centerLine;
}

function recoveredTrackCenterLine(tracks) {
  const candidates = tracks.map((track) => lineCoordinates(track)).filter((line) => line?.length >= 2);
  const lengthSquared = (line) => line.slice(1).reduce((total, point, index) => {
    const previous = line[index];
    return total + (point[0] - previous[0]) ** 2 + (point[1] - previous[1]) ** 2;
  }, 0);
  const longest = candidates.sort((left, right) => lengthSquared(right) - lengthSquared(left))[0];
  return clone(longest ?? []);
}

function recoveredTrackComponents(tracks, endpointToleranceDegrees = 0.0005) {
  const endpoints = (track) => {
    const line = lineCoordinates(track);
    return line?.length >= 2 ? [line[0], line.at(-1)] : null;
  };
  const squaredDistance = (left, right) => (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2;
  const toleranceSquared = endpointToleranceDegrees ** 2;
  const sameExtent = (left, right) => {
    const a = endpoints(left);
    const b = endpoints(right);
    if (!a || !b) return false;
    const sameDirection = Math.max(squaredDistance(a[0], b[0]), squaredDistance(a[1], b[1]));
    const oppositeDirection = Math.max(squaredDistance(a[0], b[1]), squaredDistance(a[1], b[0]));
    return Math.min(sameDirection, oppositeDirection) <= toleranceSquared;
  };
  const remaining = [...tracks];
  const components = [];
  while (remaining.length) {
    const component = [remaining.shift()];
    for (let index = 0; index < component.length; index++) {
      for (let candidate = remaining.length - 1; candidate >= 0; candidate--) {
        if (!sameExtent(component[index], remaining[candidate])) continue;
        component.push(remaining[candidate]);
        remaining.splice(candidate, 1);
      }
    }
    components.push(component);
  }
  return components;
}

/**
 * Older bounded projections could retain a station while omitting its native
 * station track group. Subway Builder's save loader resolves trackGroupId
 * while backfilling maxCars and aborts the whole load when it is absent. The
 * group is completely derivable from the station's platform tracks, so repair
 * that envelope before any projected save reaches the native loader.
 */
export function repairStationTrackGroupIntegrity(source) {
  const state = clone(source);
  const trackById = indexById(state.tracks);
  // Recovery schema v1 used a straight endpoint chord and could render giant
  // polygons on curved rail. Treat only our marked synthetic groups as
  // replaceable input; native groups are never rewritten.
  const nativeTrackGroups = array(state.trackGroups)
    .filter((group) => !group?.openWorldRecoveredTrackGroup);
  const replacedRecoveredGroupIds = array(state.trackGroups)
    .filter((group) => group?.openWorldRecoveredTrackGroup && group?.id != null)
    .map((group) => String(group.id));
  const groupById = indexById(nativeTrackGroups);
  const groupedTrackIds = new Set(nativeTrackGroups
    .flatMap((group) => array(group?.trackIds))
    .map(String));
  const repairedGroupIds = [];
  const unresolvedStationIds = [];
  for (const station of array(state.stations)) {
    const groupId = station?.trackGroupId == null ? null : String(station.trackGroupId);
    if (!groupId || groupById.has(groupId)) continue;
    const tracks = array(station.trackIds).map((id) => trackById.get(String(id))).filter(Boolean);
    if (!tracks.length) {
      if (station?.id != null) unresolvedStationIds.push(String(station.id));
      continue;
    }
    const trackIds = tracks.map((track) => String(track.id));
    const group = {
      id: groupId,
      trackIds,
      trackLanesType: 'parallel',
      centerLine: centerLineForStationTracks(tracks, coordinateOf(station)),
      type: 'station',
      trackType: tracks.find((track) => track.trackType)?.trackType ?? station.trackType ?? 'heavy-metro',
      platformLayout: station.platformLayout ?? 'side-platforms',
      platformWidthScale: Number.isFinite(station.platformWidthScale) ? station.platformWidthScale : 1,
    };
    groupById.set(groupId, group);
    for (const trackId of trackIds) groupedTrackIds.add(trackId);
    repairedGroupIds.push(groupId);
  }

  // The finance/autosave race also omitted ordinary and crossover group
  // envelopes. Native load deletes every such orphan track before rebuilding
  // routes. Tracks produced by one native construction action share createdAt,
  // type, and technology, providing a stable conservative recovery bucket.
  const orphanBuckets = new Map();
  for (const track of array(state.tracks)) {
    const trackId = idOf(track);
    if (!trackId || groupedTrackIds.has(trackId)) continue;
    const createdAt = Number(track.createdAt);
    const bucketKey = JSON.stringify([
      Number.isFinite(createdAt) && createdAt > 0 ? createdAt : trackId,
      track.type ?? null,
      track.trackType ?? null,
    ]);
    const bucket = orphanBuckets.get(bucketKey) ?? [];
    bucket.push(track);
    orphanBuckets.set(bucketKey, bucket);
  }
  for (const bucket of orphanBuckets.values()) {
    for (const tracks of recoveredTrackComponents(bucket)) {
      const trackIds = tracks.map((track) => String(track.id)).sort();
      const groupId = `open-world-recovered-${stableHash(trackIds)}`;
      const group = {
        id: groupId,
        trackIds,
        trackLanesType: 'parallel',
        // Never use a straight farthest-endpoint chord here. Native rendering
        // triangulates between centerLine and member rails, so a chord across
        // a curve becomes a giant filled polygon. A member path is guaranteed
        // to remain on the recovered topology.
        centerLine: recoveredTrackCenterLine(tracks),
        type: tracks.every((track) => track.type === 'scissors-crossover')
          ? 'scissors-crossover'
          : null,
        trackType: tracks.find((track) => track.trackType)?.trackType ?? 'heavy-metro',
        openWorldRecoveredTrackGroup: true,
      };
      groupById.set(groupId, group);
      for (const trackId of trackIds) groupedTrackIds.add(trackId);
      repairedGroupIds.push(groupId);
    }
  }
  state.trackGroups = [...groupById.values()];
  return {
    state,
    changed: repairedGroupIds.length > 0 || replacedRecoveredGroupIds.length > 0,
    repairedGroupIds,
    replacedRecoveredGroupIds,
    unresolvedStationIds,
  };
}

function repairStationTrackGroups(source) {
  return repairStationTrackGroupIntegrity(source).state;
}

function rewriteFareGroups(fareGroups, retainedRouteIds) {
  return array(fareGroups).map((group) => {
    const result = clone(group);
    if (Array.isArray(result.routeIds)) result.routeIds = result.routeIds.filter((id) => retainedRouteIds.has(String(id)));
    return result;
  });
}

function rewriteRouteFinancials(routeFinancials, retainedRouteIds) {
  if (!routeFinancials || typeof routeFinancials !== 'object' || Array.isArray(routeFinancials)) return clone(routeFinancials ?? {});
  // Subway Builder 1.6 stores route accounting in a ledger envelope rather
  // than as a flat route-id map.  Preserve the clock fields while exposing
  // only the routes delivered to the native projection.  Treat older flat
  // saves as a compatibility fallback.
  if (routeFinancials.byRoute && typeof routeFinancials.byRoute === 'object') {
    const filterRouteMap = (value) => Object.fromEntries(Object.entries(value ?? {})
      .filter(([routeId]) => retainedRouteIds.has(String(routeId)))
      .map(([routeId, entry]) => [routeId, clone(entry)]));
    return {
      ...clone(routeFinancials),
      byRoute: filterRouteMap(routeFinancials.byRoute),
      currentHour: filterRouteMap(routeFinancials.currentHour),
    };
  }
  return Object.fromEntries(Object.entries(routeFinancials)
    .filter(([routeId]) => retainedRouteIds.has(String(routeId)))
    .map(([routeId, value]) => [routeId, clone(value)]));
}

function mergeRouteFinancials(globalFinancials, projectedFinancials) {
  if (!projectedFinancials || typeof projectedFinancials !== 'object' || Array.isArray(projectedFinancials)) {
    return clone(globalFinancials ?? {});
  }
  const globalValue = globalFinancials && typeof globalFinancials === 'object' && !Array.isArray(globalFinancials)
    ? globalFinancials
    : {};
  if (!projectedFinancials.byRoute || typeof projectedFinancials.byRoute !== 'object') {
    return { ...clone(globalValue), ...clone(projectedFinancials) };
  }

  const globalTimestamp = Number(globalValue.lastHourTimestamp) || 0;
  const projectedTimestamp = Number(projectedFinancials.lastHourTimestamp) || 0;
  let currentHour;
  if (projectedTimestamp > globalTimestamp) {
    // The native store rolled into a newer hour. Remote routes did not run in
    // that projection, so carrying their previous-hour bucket forward would
    // mislabel old activity as current activity.
    currentHour = clone(projectedFinancials.currentHour ?? {});
  } else if (projectedTimestamp < globalTimestamp) {
    currentHour = clone(globalValue.currentHour ?? {});
  } else {
    currentHour = {
      ...clone(globalValue.currentHour ?? {}),
      ...clone(projectedFinancials.currentHour ?? {}),
    };
  }
  return {
    ...clone(globalValue),
    ...clone(projectedFinancials),
    byRoute: {
      ...clone(globalValue.byRoute ?? {}),
      ...clone(projectedFinancials.byRoute ?? {}),
    },
    lastHourTimestamp: Math.max(globalTimestamp, projectedTimestamp),
    currentHour,
  };
}

function routeForNativeProjection(route, retainedTrackIds, retainedStationIds, retainedStationNodeIds) {
  const result = clone(route);
  const filterPath = (path) => array(path)
    .filter((segment) => retainedTrackIds.has(String(segment?.trackId)));
  // Keep the real schedule on the projected route so the native route panel
  // remains an honest editor. The game adapter hides this route from the
  // simulation tick only while updateMultipleGameState is running; otherwise
  // Subway Builder would generate trains against the intentionally clipped
  // path. These fields also make older projected saves self-describing.
  result.openWorldProjectionDormant = true;
  // The native route editor needs a local facade, but a successful edit must
  // be merged back into the complete world route without losing remote stops
  // or paths. Keep one authoritative copy on the projected route for the
  // adapter's clipped-route preview guard.
  result.openWorldGlobalRoute = clone(route);
  if (result.trainSchedule && typeof result.trainSchedule === 'object') {
    result.openWorldGlobalTrainSchedule = clone(result.trainSchedule);
  }
  if (Number.isFinite(result.idealTrainCount)) {
    result.openWorldGlobalIdealTrainCount = result.idealTrainCount;
  }
  // Subway Builder 1.6 validates every stCombo path against the delivered
  // track map during loadSave and drops the entire route (plus its trains) if
  // even one referenced track is absent. Keep the full route/station metadata
  // for the route list and scheduler, but remove path references whose
  // geometry is intentionally represented by our bounded overlay instead.
  if (Array.isArray(result.stNodes)) {
    result.stNodes = result.stNodes.filter((node) => retainedStationNodeIds.has(String(node?.id)));
  }
  if (Array.isArray(route.stComboTimings)) {
    result.stComboTimings = projectRouteTimings(route, result.stNodes ?? []);
  }
  if (Array.isArray(result.stCombos)) {
    const facadeNodeIds = new Set(array(result.stNodes).map((node) => String(node?.id)));
    result.stCombos = result.stCombos.map((combo) => ({
      ...combo,
      path: filterPath(combo.path),
    })).filter((combo) => (
      facadeNodeIds.has(String(combo?.startStNodeId))
      && facadeNodeIds.has(String(combo?.endStNodeId))
    ));
  }
  if (Array.isArray(result.trackIds)) {
    result.trackIds = result.trackIds.filter((trackId) => retainedTrackIds.has(String(trackId)));
  }
  return sanitizeNativeRouteTrackReferences(result, retainedTrackIds);
}

function sanitizeNativeRouteTrackReferences(route, retainedTrackIds) {
  const result = clone(route);
  const pathIsDelivered = (path) => array(path)
    .every((segment) => retainedTrackIds.has(String(segment?.trackId)));
  if (Array.isArray(result.stNodes)) {
    result.stNodes = result.stNodes.map((node) => ({
      ...node,
      ...(Array.isArray(node?.trackIds) ? {
        trackIds: node.trackIds.filter((trackId) => retainedTrackIds.has(String(trackId))),
      } : {}),
    }));
  }
  if (Array.isArray(result.terminusPlatformAlternates)) {
    result.terminusPlatformAlternates = result.terminusPlatformAlternates
      .map((group) => ({
        ...group,
        // Subway Builder concatenates these paths directly in
        // getRoutesGeojson. Keeping only the surviving segments would join
        // unrelated coordinates into a giant triangle, so retain a platform
        // only when both complete paths are backed by delivered tracks.
        platforms: array(group.platforms).filter((platform) => (
          pathIsDelivered(platform?.arrival?.path)
          && pathIsDelivered(platform?.departure?.path)
        )),
      }))
      .filter((group) => group.platforms.length > 0);
  }
  if (Array.isArray(result.trackIds)) {
    result.trackIds = result.trackIds.filter((trackId) => retainedTrackIds.has(String(trackId)));
  }
  return result;
}

function warning(code, message, ids, suggestedTileIds = []) {
  return { code, message, affectedObjectIds: [...new Set(ids)], suggestedTileIds: [...new Set(suggestedTileIds)] };
}

function tilesForPoints(points, catalog) {
  const result = new Set();
  for (const point of points) {
    for (const tile of array(catalog?.tiles)) if (Array.isArray(tile.bounds) && pointInBounds(point, tile.bounds)) result.add(tile.id);
  }
  return [...result];
}

function topologyValue(route) {
  const copy = clone(route);
  for (const key of ['name', 'fullName', 'color', 'fareGroupId', 'trainType', 'carsPerTrain', 'timetableSchedule', 'trainSchedule', 'idealTrainCount']) delete copy[key];
  // Native route editors rebuild route objects from the game's schema and do
  // not preserve mod-private presentation metadata. Losing those fields is
  // not a topology edit and must not reject an otherwise valid schedule
  // change on a clipped route.
  for (const key of Object.keys(copy)) if (key.startsWith('openWorld')) delete copy[key];
  return copy;
}

function mergeProjectedEntity(globalValue, beforeValue, afterValue) {
  if (!beforeValue) return clone(afterValue);
  const result = clone(globalValue ?? beforeValue);
  const keys = new Set([...Object.keys(beforeValue), ...Object.keys(afterValue)]);
  for (const key of keys) {
    const before = beforeValue[key];
    const after = afterValue[key];
    if (stableHash(before) === stableHash(after)) continue;
    if (Array.isArray(before) && Array.isArray(after) && Array.isArray(result[key]) && /Ids$/.test(key)) {
      const removed = new Set(before.filter((id) => !after.some((candidate) => String(candidate) === String(id))).map(String));
      const merged = result[key].filter((id) => !removed.has(String(id)));
      const present = new Set(merged.map(String));
      for (const id of after) if (!present.has(String(id))) { merged.push(clone(id)); present.add(String(id)); }
      result[key] = merged;
    } else if (after === undefined) delete result[key];
    else result[key] = clone(after);
  }
  return result;
}

function mergePartialRouteProjection(globalValue, beforeValue, afterValue) {
  if (afterValue?.openWorldProjectionLocalEdit) {
    // The live route is only an editable facade of the visible runs. The
    // preview guard reconstructs the complete route in this sidecar; saving
    // the facade would silently discard every station node outside the 3x3.
    const result = clone(afterValue.openWorldGlobalRoute ?? afterValue);
    for (const key of Object.keys(result)) if (key.startsWith('openWorld')) delete result[key];
    return result;
  }
  const result = mergeProjectedEntity(globalValue, beforeValue, afterValue);
  const dormantSchedule = beforeValue?.openWorldGlobalTrainSchedule;
  if (dormantSchedule && typeof dormantSchedule === 'object') {
    const mergedSchedule = clone(globalValue?.trainSchedule ?? dormantSchedule);
    const beforeSchedule = beforeValue.trainSchedule ?? {};
    const afterSchedule = afterValue.trainSchedule ?? {};
    for (const key of new Set([...Object.keys(beforeSchedule), ...Object.keys(afterSchedule)])) {
      if (stableHash(beforeSchedule[key]) === stableHash(afterSchedule[key])) continue;
      if (afterSchedule[key] === undefined) delete mergedSchedule[key];
      else mergedSchedule[key] = clone(afterSchedule[key]);
    }
    result.trainSchedule = mergedSchedule;
  }
  if (beforeValue?.openWorldGlobalIdealTrainCount !== undefined
    && beforeValue.idealTrainCount !== afterValue.idealTrainCount) {
    result.idealTrainCount = clone(afterValue.idealTrainCount);
  }
  delete result.openWorldGlobalTrainSchedule;
  delete result.openWorldGlobalIdealTrainCount;
  delete result.openWorldGlobalRoute;
  delete result.openWorldNativeCommuteRoute;
  delete result.openWorldNativeCommuteTrains;
  delete result.openWorldNativeCommuteStations;
  delete result.openWorldProjectionDormant;
  delete result.openWorldProjectionLocalEdit;
  return result;
}

export class NetworkProjection {
  constructor({ guardBandMeters = 250 } = {}) {
    if (!Number.isFinite(guardBandMeters) || guardBandMeters < 0) throw new Error('Invalid projection guard band');
    this.guardBandMeters = guardBandMeters;
  }

  /** Explicit canonical-native lifecycle entry point for callers that need a
   * full restore payload while still using this class for presentation. */
  createNativeSnapshot(baseSnapshot, network) {
    return createNativeNetworkSnapshot(baseSnapshot, network);
  }

  applyRouteScheduleChanges(network, changes) {
    if (network?.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported global network schema');
    const nextState = clone(network.nativeState);
    const routes = indexById(nextState.routes);
    let changed = false;
    const missingRouteIds = [];
    for (const change of array(changes)) {
      const routeId = String(change?.routeId ?? '');
      const route = routes.get(routeId);
      if (!route) {
        if (routeId) missingRouteIds.push(routeId);
        continue;
      }
      const schedule = change?.schedule ?? {};
      for (const key of ['idealTrainCount', 'trainSchedule', 'timetableSchedule']) {
        if (!Object.hasOwn(schedule, key)) continue;
        if (stableHash(route[key]) === stableHash(schedule[key])) continue;
        if (schedule[key] === undefined) delete route[key];
        else route[key] = clone(schedule[key]);
        changed = true;
      }
    }
    if (missingRouteIds.length) {
      return {
        accepted: false,
        changed: false,
        network,
        warning: warning(
          'schedule-route-missing',
          'The route schedule could not be saved because the world-wide route was not found.',
          missingRouteIds,
        ),
      };
    }
    return {
      accepted: true,
      changed,
      network: changed ? createGlobalNetwork(nextState, (Number(network.revision) || 0) + 1) : network,
      warning: null,
    };
  }

  isSnapshotStructurallyCurrent({ network, baseline, nativeSnapshot }) {
    return Boolean(
      network?.schemaVersion === SCHEMA_VERSION
      && baseline?.schemaVersion === SCHEMA_VERSION
      && baseline.networkRevision === network.revision
      && baseline.networkHash === network.hash
      && typeof baseline.structuralHash === 'string'
      && baseline.structuralHash === structuralHashFrom(nativeSnapshot),
    );
  }

  build({ network, activeTileId, catalog, baseSnapshot = null }) {
    if (network?.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported global network schema');
    const window = catalogWindow(catalog, activeTileId, this.guardBandMeters);
    const baseState = clone(snapshotState(baseSnapshot));
    const repairedGlobal = repairStationTrackGroups(network.nativeState);
    if (!window) {
      const state = { ...baseState, ...repairedGlobal };
      const manifest = {
        schemaVersion: SCHEMA_VERSION, activeTileId, networkRevision: network.revision,
        networkHash: network.hash, projectionHash: stableHash(state), unbounded: true,
        visibleTileIds: array(catalog?.tiles).map((tile) => tile.id), partialRouteIds: [], protectedStationIds: [],
        baselineState: networkStateFrom(state), sourceIds: {},
      };
      return { snapshot: withSnapshotState(baseSnapshot, state), state, manifest, overlay: { type: 'FeatureCollection', features: [] }, diagnostics: { unbounded: true } };
    }

    const global = repairedGlobal;
    const financeOwnedRouteIds = new Set(classifyCrossTileRouteIds(global, catalog));
    const financeOwnedTrackIds = new Set(array(global.routes)
      .filter((route) => financeOwnedRouteIds.has(String(route?.id)))
      .flatMap((route) => [...routeTrackIds(route)]));
    const stationById = indexById(global.stations);
    const stationByNode = new Map();
    for (const station of stationById.values()) for (const nodeId of array(station.stNodeIds)) stationByNode.set(String(nodeId), String(station.id));

    const stations = [];
    const protectedStationIds = new Set();
    for (const station of stationById.values()) {
      const coords = coordinateOf(station);
      if (!coords || !pointInAny(coords, window.renderBounds)) continue;
      stations.push(clone(station));
      if (!pointInAny(coords, window.editableBounds)) protectedStationIds.add(String(station.id));
    }
    const retainedStationIds = new Set(stations.map((station) => String(station.id)));
    const retainedStationNodeIds = new Set(stations.flatMap((station) => array(station.stNodeIds).map(String)));
    const retainedStationTrackIds = new Set(stations.flatMap((station) => array(station.trackIds).map(String)));

    const nativeTracks = [];
    const trackProjection = new Map();
    const overlayFeatures = [];
    for (const track of array(global.tracks)) {
      const trackId = idOf(track);
      const coords = lineCoordinates(track);
      if (!trackId || !coords) continue;
      const fragments = clipLineToBoundsUnion(coords, window.renderBounds);
      if (!fragments.length) continue;
      const unchanged = unchangedLine(coords, fragments);
      const nativeEligible = unchanged || retainedStationTrackIds.has(trackId);
      trackProjection.set(trackId, { unchanged: nativeEligible, fragments });
      // A retained boundary station must remain a complete native object.
      // Its short platform tracks may straddle the render edge even though
      // the station point is inside; preserve those tracks whole so the
      // station group and max-car calculation remain valid.
      if (nativeEligible) nativeTracks.push(clone(track));
      else fragments.forEach((fragment, index) => overlayFeatures.push(featureForLine(fragment, {
        kind: 'track-fragment', sourceTrackId: trackId, fragmentIndex: index,
        color: '#747b85', width: 3,
      })));
    }
    const retainedTrackIds = new Set(nativeTracks.map((track) => String(track.id)));

    const nativeRoutes = [];
    const partialRouteIds = new Set();
    const routeClassification = {};
    for (const route of array(global.routes)) {
      const routeId = idOf(route);
      if (!routeId) continue;
      const trackIds = routeTrackIds(route);
      const stationIds = routeStationIds(route, stationByNode);
      const visibleTracks = [...trackIds].filter((id) => trackProjection.has(id));
      const visibleStations = [...stationIds].filter((id) => retainedStationIds.has(id));
      const hasReferences = trackIds.size > 0 || stationIds.size > 0;
      const fullyContained = (!trackIds.size || [...trackIds].every((id) => trackProjection.get(id)?.unchanged))
        && (!stationIds.size || [...stationIds].every((id) => retainedStationIds.has(id) && !protectedStationIds.has(id)));
      const visible = hasReferences ? visibleTracks.length > 0 || visibleStations.length > 0 : true;
      if (!visible) {
        routeClassification[routeId] = 'outside';
        continue;
      }
      if (fullyContained) {
        // A route can remain spatially contained while carrying stale
        // terminus-alternate paths from a previously split/rebuilt station.
        // Native loadSave resolves those optional paths eagerly and throws if
        // even one track is absent, so contained routes need the same track
        // closure guarantee as clipped route facades.
        const nativeRoute = sanitizeNativeRouteTrackReferences(route, retainedTrackIds);
        if (financeOwnedRouteIds.has(routeId)) {
          nativeRoute.openWorldFinanceOwned = true;
          nativeRoute.openWorldNativeCommuteRoute = clone(route);
          nativeRoute.openWorldNativeCommuteStations = [...stationIds]
            .map((stationId) => stationById.get(stationId))
            .filter(Boolean)
            .map(clone);
        }
        nativeRoutes.push(nativeRoute);
        routeClassification[routeId] = 'contained';
        continue;
      }
      partialRouteIds.add(routeId);
      routeClassification[routeId] = 'partial';
      // Keep the authoritative route object in native state so Subway
      // Builder's route list, scheduler, station sequence, and headway controls
      // continue to describe the world-wide service. Geometry is still bounded:
      // crossing tracks remain clipped overlay features and out-of-window
      // stations/tracks are not admitted to the native renderer.
      const nativeRoute = routeForNativeProjection(
        route,
        retainedTrackIds,
        retainedStationIds,
        retainedStationNodeIds,
      );
      if (financeOwnedRouteIds.has(routeId)) nativeRoute.openWorldFinanceOwned = true;
      // RAPTOR needs every station referenced by the authoritative stop list,
      // including the remote end of a clipped run. The adapter exposes these
      // records only while native pathfinding snapshots its inputs, so they do
      // not leak into the bounded native renderer or station simulation.
      nativeRoute.openWorldNativeCommuteStations = [...stationIds]
        .map((stationId) => stationById.get(stationId))
        .filter(Boolean)
        .map(clone);
      nativeRoute.openWorldNativeCommuteRoute = clone(route);
      nativeRoutes.push(nativeRoute);
      for (const trackId of visibleTracks) {
        const projection = trackProjection.get(trackId);
        projection.fragments.forEach((fragment, index) => overlayFeatures.push(featureForLine(fragment, {
          kind: 'route-fragment', routeId, sourceTrackId: trackId, fragmentIndex: index,
          color: route.color ?? '#ffffff', width: 5,
        })));
      }
    }
    const retainedRouteIds = new Set(nativeRoutes.map((route) => String(route.id)));
    const globalRouteById = indexById(global.routes);
    const isPartialTrainRoute = (routeId) => {
      const id = String(routeId);
      const parentId = globalRouteById.get(id)?.tempParentId;
      return partialRouteIds.has(id) || (parentId != null && partialRouteIds.has(String(parentId)));
    };
    // A partial route's presentation path is shorter than its authoritative
    // path, while persisted train progress/windows are measured against the
    // authoritative geometry. Feeding those trains to the native simulation
    // makes getTrainWindow walk past the projected path and delete them as
    // stuck. Keep them in global state and deliver them again whenever their
    // route becomes fully contained in the active 3x3.
    const deferredTrainIds = [];
    const deferredTrainsByRoute = new Map();
    const trains = array(global.trains).filter((train) => {
      if (!retainedRouteIds.has(String(train.routeId))) return false;
      if (!isPartialTrainRoute(train.routeId)) return true;
      if (idOf(train)) deferredTrainIds.push(String(train.id));
      const routeId = String(train.routeId);
      const routeTrains = deferredTrainsByRoute.get(routeId) ?? [];
      routeTrains.push(clone(train));
      deferredTrainsByRoute.set(routeId, routeTrains);
      return false;
    }).map(clone);
    for (const route of nativeRoutes) {
      const commuteTrains = deferredTrainsByRoute.get(String(route.id));
      if (commuteTrains?.length) route.openWorldNativeCommuteTrains = commuteTrains;
    }

    const projectedStations = stations.map((station) => {
      const result = clone(station);
      if (Array.isArray(result.routeIds)) result.routeIds = result.routeIds.filter((id) => retainedRouteIds.has(String(id)));
      if (Array.isArray(result.trackIds)) result.trackIds = result.trackIds.filter((id) => retainedTrackIds.has(String(id)));
      return result;
    });

    const retainedNodeIds = new Set();
    for (const station of stations) for (const id of array(station.stNodeIds)) retainedNodeIds.add(String(id));
    for (const track of nativeTracks) for (const id of trackNodeIds(track)) retainedNodeIds.add(String(id));
    const stNodes = array(global.stNodes).filter((node) => retainedNodeIds.has(String(node.id)) || pointInAny(coordinateOf(node), window.renderBounds)).map(clone);
    const stationGroups = array(global.stationGroups)
      .filter((group) => array(group.stationIds).some((id) => retainedStationIds.has(String(id))))
      .map((group) => filterGroup(group, retainedStationIds, retainedTrackIds));
    const trackGroups = array(global.trackGroups)
      .filter((group) => array(group.trackIds).some((id) => retainedTrackIds.has(String(id))))
      .map((group) => {
        const projectedGroup = filterGroup(group, retainedStationIds, retainedTrackIds);
        if (array(group.trackIds).some((id) => financeOwnedTrackIds.has(String(id)))) {
          projectedGroup.openWorldFinanceOwned = true;
        }
        return projectedGroup;
      });
    const projectedTrackGroupIds = new Set(trackGroups.map((group) => String(group.id)));
    const unresolvedStationGroupIds = projectedStations
      .map((station) => station?.trackGroupId == null ? null : String(station.trackGroupId))
      .filter((groupId) => groupId && !projectedTrackGroupIds.has(groupId));
    if (unresolvedStationGroupIds.length) {
      throw new Error(`Projected station track groups are unresolved: ${[...new Set(unresolvedStationGroupIds)].join(', ')}`);
    }
    const signals = array(global.signals).filter((signal) => (
      [...signalTrackIds(signal)].some((trackId) => retainedTrackIds.has(trackId))
      || pointInAny(coordinateOf(signal), window.renderBounds)
    )).map(clone);

    const projected = {
      ...baseState,
      ...clone(global),
      tracks: nativeTracks,
      trains,
      routes: nativeRoutes,
      trackGroups,
      signals,
      stNodes,
      stations: projectedStations,
      stationGroups,
      fareGroups: rewriteFareGroups(global.fareGroups, retainedRouteIds),
      routeFinancials: rewriteRouteFinancials(global.routeFinancials, retainedRouteIds),
    };
    const baselineState = networkStateFrom(projected);
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      activeTileId,
      networkRevision: network.revision,
      networkHash: network.hash,
      visibleTileIds: window.tileIds,
      editableBounds: clone(window.editableBounds),
      renderBounds: clone(window.renderBounds),
      partialRouteIds: [...partialRouteIds].sort(),
      financeOwnedRouteIds: [...financeOwnedRouteIds].sort(),
      financeOwnedTrackIds: [...financeOwnedTrackIds].sort(),
      deferredTrainIds: deferredTrainIds.sort(),
      protectedStationIds: [...protectedStationIds].sort(),
      routeClassification,
      sourceIds: Object.fromEntries([...trackProjection].map(([id, projection]) => [id, projection.unchanged ? [id] : projection.fragments.map((_, index) => `${id}:projection:${index}`)])),
      baselineState,
      projectionHash: stableHash(baselineState),
      structuralHash: structuralHashFrom(baselineState),
    };
    return {
      snapshot: withSnapshotState(baseSnapshot, projected),
      state: projected,
      manifest,
      overlay: { type: 'FeatureCollection', features: overlayFeatures },
      diagnostics: {
        globalStations: array(global.stations).length,
        projectedStations: stations.length,
        globalTracks: array(global.tracks).length,
        nativeTracks: nativeTracks.length,
        clippedTrackFragments: overlayFeatures.filter((feature) => feature.properties.kind === 'track-fragment').length,
        globalRoutes: array(global.routes).length,
        nativeRoutes: nativeRoutes.length,
        partialRoutes: partialRouteIds.size,
        deferredTrains: deferredTrainIds.length,
      },
    };
  }

  reconcile({ network, baseline, nativeSnapshot, catalog }) {
    if (network?.schemaVersion !== SCHEMA_VERSION || baseline?.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported projection reconciliation schema');
    if (baseline.networkRevision !== network.revision || baseline.networkHash !== network.hash) {
      return {
        accepted: false,
        network,
        rollbackState: clone(baseline.baselineState),
        warning: warning('stale-projection', 'The visible network was stale and has been restored from the current world state.', []),
      };
    }
    const nativeState = snapshotState(nativeSnapshot);
    const protectedStations = new Set(baseline.protectedStationIds ?? []);
    const partialRoutes = new Set(baseline.partialRouteIds ?? []);
    const failures = [];
    const boundaryFailures = new Set();
    const failurePoints = [];
    const baselineStations = indexById(baseline.baselineState.stations);
    const currentStations = indexById(nativeState.stations);
    for (const [stationId, station] of currentStations) {
      const before = baselineStations.get(stationId);
      const changed = !before || stableHash(station) !== stableHash(before);
      const coords = coordinateOf(station);
      if (changed && coords && !pointInAny(coords, baseline.editableBounds ?? [])) {
        failures.push(stationId); failurePoints.push(coords);
      }
      if (protectedStations.has(stationId) && changed) {
        failures.push(stationId);
        boundaryFailures.add(stationId);
      }
    }
    for (const stationId of protectedStations) if (!currentStations.has(stationId)) {
      failures.push(stationId);
      boundaryFailures.add(stationId);
    }

    const baselineTracks = indexById(baseline.baselineState.tracks);
    const currentTracks = indexById(nativeState.tracks);
    for (const [trackId, track] of currentTracks) {
      const before = baselineTracks.get(trackId);
      const changed = !before || stableHash(track) !== stableHash(before);
      const coords = lineCoordinates(track);
      if (changed && coords && coords.some((point) => !pointInAny(point, baseline.editableBounds ?? []))) {
        failures.push(trackId); failurePoints.push(...coords.filter((point) => !pointInAny(point, baseline.editableBounds ?? [])));
      }
      if (trackId.includes(':projection:')) failures.push(trackId);
    }

    const baselineRoutes = indexById(baseline.baselineState.routes);
    const currentRoutes = indexById(nativeState.routes);
    for (const routeId of partialRoutes) {
      if (baselineRoutes.has(routeId) && !currentRoutes.has(routeId)) {
        // Subway Builder can normalize a route out of a clipped native graph
        // because some of its remote track references are intentionally not
        // delivered to the renderer. That is not a user deletion. Reject the
        // lossy snapshot so the authoritative world-wide route survives.
        failures.push(routeId);
        boundaryFailures.add(routeId);
      }
    }
    for (const route of array(nativeState.routes)) {
      const routeId = idOf(route);
      if (!routeId) continue;
      const before = baselineRoutes.get(routeId);
      if (before && baseline.routeClassification?.[routeId] === 'partial'
        && stableHash(topologyValue(before)) !== stableHash(topologyValue(route))
        && route.openWorldProjectionLocalEdit !== true) failures.push(routeId);
    }

    if (failures.length) {
      return {
        accepted: false,
        network,
        rollbackState: clone(baseline.baselineState),
        warning: warning(
          boundaryFailures.has(failures[0]) ? 'boundary-dependency' : 'outside-window',
          'The change left the editable 3×3 tile window and was restored. Switch to the highlighted tile to continue.',
          failures,
          tilesForPoints(failurePoints, catalog),
        ),
      };
    }

    const nextState = clone(network.nativeState);
    const referencedTrackIds = new Set(array(nativeState.routes).flatMap((route) => (
      [...routeTrackIds(route?.openWorldGlobalRoute ?? route)]
    )));
    for (const key of ENTITY_KEYS) {
      const globalById = indexById(nextState[key]);
      const beforeById = indexById(baseline.baselineState[key]);
      const afterById = indexById(nativeState[key]);
      for (const [id, before] of beforeById) {
        if (afterById.has(id)) continue;
        const protectedPartialEntity = key === 'routes' && partialRoutes.has(id)
          || key === 'trains' && partialRoutes.has(String(before?.routeId))
          || key === 'tracks' && referencedTrackIds.has(String(id));
        if (!protectedPartialEntity) globalById.delete(id);
      }
      for (const [id, value] of afterById) {
        const before = beforeById.get(id);
        // A repaired projection entity can be identical to its baseline while
        // still being absent from the malformed canonical network. Promote it
        // instead of treating the equality as proof that it already exists.
        if (globalById.has(id) && before && stableHash(before) === stableHash(value)) continue;
        globalById.set(id, key === 'routes' && partialRoutes.has(id)
          ? mergePartialRouteProjection(globalById.get(id), before, value)
          : mergeProjectedEntity(globalById.get(id), before, value));
      }
      nextState[key] = [...globalById.values()];
    }
    if (Array.isArray(nativeState.fareGroups)) {
      const globalById = indexById(nextState.fareGroups);
      const beforeById = indexById(baseline.baselineState.fareGroups);
      const afterById = indexById(nativeState.fareGroups);
      for (const [id, value] of afterById) {
        const before = beforeById.get(id);
        if (before && stableHash(before) === stableHash(value)) continue;
        globalById.set(id, mergeProjectedEntity(globalById.get(id), before, value));
      }
      nextState.fareGroups = [...globalById.values()];
    }
    if (nativeState.routeFinancials && typeof nativeState.routeFinancials === 'object') {
      nextState.routeFinancials = mergeRouteFinancials(nextState.routeFinancials, nativeState.routeFinancials);
    }
    for (const key of ['ownedTrainCount', 'ownedCarsByType']) if (nativeState[key] !== undefined) nextState[key] = clone(nativeState[key]);
    const nextHash = stableHash(nextState);
    const changed = nextHash !== network.hash;
    const nextNetwork = {
      schemaVersion: SCHEMA_VERSION,
      revision: network.revision + (changed ? 1 : 0),
      nativeState: nextState,
      routeDescriptors: descriptorsFor(nextState),
      hash: nextHash,
    };
    return { accepted: true, changed, network: nextNetwork, warning: null };
  }
}

export const NETWORK_PROJECTION_SCHEMA_VERSION = SCHEMA_VERSION;
