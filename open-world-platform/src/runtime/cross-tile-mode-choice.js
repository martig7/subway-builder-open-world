const EARTH_RADIUS_M = 6_371_000;
// Subway Builder's straight-line station catchment uses RULES.WALKING_SPEED
// (1 m/s), not WALKING_SPEED_ACCURATE_PATH (1.5 m/s).
const WALK_SPEED_MPS = 1;
const TRAIN_SPEED_MPS = 12.5;
const ROAD_CIRCUITY = 1.3;
const DRIVE_SPEED_MPS = 40 / 3.6;
const DEFAULT_WAIT_SECONDS = 5 * 60;

const DEFAULT_RULES = Object.freeze({
  MAX_WALK_TO_FROM_STATION: 30 * 60,
  DRIVING_COST_PER_KM: 0.65,
  MIN_SENSIBLE_DRIVING_DISTANCE: 1_000,
  PARKING_TIME: 180,
  PARKING_COST: 5,
  INCOME_MEAN: 60_000,
  INCOME_STD_DEV: 25_000,
  MINIMUM_INCOME: 15_000,
  MAXIMUM_INCOME: 200_000,
  HOURS_WORKED_PER_YEAR: 1_860,
  MIN_TRANSIT_CHOICE: 10,
  ARRIVAL_GAP: 50,
  DRIVING_TIMES: {
    VERY_LOW_DEMAND: 0.8,
    LOW_DEMAND: 0.9,
    LOW_MEDIUM_DEMAND: 1,
    MEDIUM_DEMAND: 1.25,
    HIGH_DEMAND: 1.5,
  },
  PERCEIVED_TIME: {
    WALK_MULTIPLIER: 1.39,
    WAIT_MULTIPLIER: 1.37,
    DEPARTURE_SHIFT_MULTIPLIER: 0.4,
    CONGESTED_DRIVING_MULTIPLIER: 1.33,
    CONGESTION_FULL_AT_MULTIPLIER: 2,
    PARKING_SEARCH_MULTIPLIER: 1.6,
  },
});

function finite(value, fallback) { return Number.isFinite(value) ? value : fallback; }

function rulesWithDefaults(raw = {}) {
  return {
    ...DEFAULT_RULES,
    ...raw,
    DRIVING_TIMES: { ...DEFAULT_RULES.DRIVING_TIMES, ...(raw.DRIVING_TIMES ?? {}) },
    PERCEIVED_TIME: { ...DEFAULT_RULES.PERCEIVED_TIME, ...(raw.PERCEIVED_TIME ?? {}) },
  };
}

const DAY_SECONDS = 86_400;

function popFields(raw) {
  return new Map((raw ?? []).map((name, index) => [name, index]));
}

function popDepartureSeconds(pop, fields, worldSeconds) {
  if (!pop) return worldSeconds;
  const departure = pop[fields.get('homeDepartureTime')];
  if (!Number.isFinite(departure)) return worldSeconds;
  return Math.floor(worldSeconds / DAY_SECONDS) * DAY_SECONDS
    + ((departure % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
}

// Subway Builder selects the driving multiplier from the home-departure
// demand level. These are the bundled 1.6 default home-demand ranges.
function drivingMultiplierAt(departureSeconds, rules) {
  const hour = ((departureSeconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS / 3_600;
  if (hour < 3 || hour >= 23) return rules.DRIVING_TIMES.VERY_LOW_DEMAND;
  if (hour < 6) return rules.DRIVING_TIMES.LOW_DEMAND;
  if (hour < 7) return rules.DRIVING_TIMES.MEDIUM_DEMAND;
  if (hour < 10) return rules.DRIVING_TIMES.HIGH_DEMAND;
  if (hour < 11) return rules.DRIVING_TIMES.MEDIUM_DEMAND;
  if (hour < 16) return rules.DRIVING_TIMES.LOW_MEDIUM_DEMAND;
  return rules.DRIVING_TIMES.LOW_DEMAND;
}

export function distanceMetres(left, right) {
  const [lon1, lat1] = left.map((value) => value * Math.PI / 180);
  const [lon2, lat2] = right.map((value) => value * Math.PI / 180);
  const dLat = lat2 - lat1; const dLon = lon2 - lon1;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.asin(Math.sqrt(a));
}

function hashNetworkValue(value) {
  let hash = 2166136261;
  for (const character of JSON.stringify(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stableNetworkSignature(profile) {
  return hashNetworkValue({
    tileId: profile.tileId,
    stations: profile.stations.map((station) => [station.id, station.coords, station.stNodeIds, station.nearbyStations]),
    routes: profile.routes.map((route) => [route.id, route.stNodeIds, route.serviceCount, route.stComboTimings, route.timetableSchedule, route.departureAnchorsByNode]),
    activeRouteIds: profile.activeRouteIds,
  });
}

function structuralNetworkSignature(profile) {
  return hashNetworkValue({
    tileId: profile.tileId,
    stations: profile.stations.map((station) => [station.id, station.coords, station.stNodeIds, station.nearbyStations]),
    routes: profile.routes.map((route) => [
      route.id, route.stNodeIds, route.configuredServiceCount,
      route.stComboTimings, route.timetableSchedule,
    ]),
  });
}

/** Produce a small serializable graph snapshot for an active native tile. */
export function createNetworkProfile({ tileId, stations = [], routes = [], trains = [], pathfindingRules = {} }) {
  const parentByRoute = new Map(routes.map((route) => [route.id, route.tempParentId ?? route.id]));
  const liveTrainCounts = new Map();
  for (const train of trains) {
    const routeId = parentByRoute.get(train.routeId) ?? train.routeId;
    if (routeId) liveTrainCounts.set(routeId, (liveTrainCounts.get(routeId) ?? 0) + 1);
  }
  const normalizedRoutes = routes
    .filter((route) => !route.tempParentId)
    .map((route) => {
      const stNodeIds = (route.stNodes ?? []).map((node) => node.id).filter(Boolean);
      const stComboTimings = (route.stComboTimings ?? [])
        .map((timing) => ({
          stNodeIndex: finite(timing.stNodeIndex, -1),
          arrivalTime: finite(timing.arrivalTime, null),
          departureTime: finite(timing.departureTime, null),
        }))
        .filter((timing) => timing.stNodeIndex >= 0 && timing.arrivalTime != null && timing.departureTime != null)
        .sort((left, right) => left.stNodeIndex - right.stNodeIndex);
      const cycleTimeSeconds = finite(stComboTimings[stComboTimings.length - 1]?.departureTime, 0);
      const anchors = new Map();
      for (const train of trains) {
        if ((parentByRoute.get(train.routeId) ?? train.routeId) !== route.id) continue;
        for (const timing of train.timings ?? []) {
          const nodeId = timing.stNodeId ?? stNodeIds[timing.stNodeIndex];
          if (!nodeId) continue;
          const times = [
            timing.adjustedExpectedDepartureTime,
            timing.expectedDepartureTime,
            ...(timing.futureCycleDepartureTimes ?? []),
          ].filter(Number.isFinite);
          if (!anchors.has(nodeId)) anchors.set(nodeId, new Set());
          for (const time of times) {
            const phase = cycleTimeSeconds > 0 ? ((time % cycleTimeSeconds) + cycleTimeSeconds) % cycleTimeSeconds : time;
            anchors.get(nodeId).add(phase);
          }
        }
      }
      const configuredTrainSchedule = route.openWorldGlobalTrainSchedule ?? route.trainSchedule;
      const configuredIdealTrainCount = route.openWorldGlobalIdealTrainCount ?? route.idealTrainCount;
      const configuredServiceCount = Math.max(
        0,
        finite(configuredTrainSchedule?.highDemand, finite(configuredIdealTrainCount, 0)),
      );
      return {
        id: route.id,
        bullet: route.bullet ?? null,
        name: route.name ?? null,
        fullName: route.fullName ?? null,
        stNodeIds,
        stComboTimings,
        departureAnchorsByNode: Object.fromEntries([...anchors].map(([nodeId, values]) => [nodeId, [...values].sort((a, b) => a - b)])),
        timetableSchedule: route.timetableSchedule?.mode === 'timetable'
        ? {
          mode: 'timetable',
          periods: (route.timetableSchedule.periods ?? []).map((period) => ({
            startHour: finite(period.startHour, 0),
            endHour: finite(period.endHour, 24),
            headwaySeconds: Math.max(0, finite(period.headwaySeconds, 0)),
          })),
        }
        : null,
      configuredServiceCount,
      serviceCount: Math.max(
        0,
        liveTrainCounts.get(route.id) ?? 0,
        configuredServiceCount,
      ),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const activeRouteIds = normalizedRoutes.filter((route) => route.serviceCount > 0).map((route) => route.id);
  const normalizedStations = stations
    .filter((station) => station.buildType === 'constructed' && Array.isArray(station.coords))
    .map((station) => ({
      id: station.id,
      name: station.name ?? station.customName ?? null,
      coords: station.coords.slice(0, 2),
      stNodeIds: [...(station.stNodeIds ?? [])].sort(),
      nearbyStations: (station.nearbyStations ?? [])
        .map((nearby) => ({ stationId: nearby.stationId, walkingTime: finite(nearby.walkingTime, Infinity) }))
        .filter((nearby) => Number.isFinite(nearby.walkingTime))
        .sort((a, b) => a.stationId.localeCompare(b.stationId)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const profile = {
    schemaVersion: 1,
    tileId,
    stations: normalizedStations,
    routes: normalizedRoutes,
    activeRouteIds,
    pathfindingRules: rulesWithDefaults(pathfindingRules),
  };
  profile.signature = stableNetworkSignature(profile);
  profile.structuralSignature = structuralNetworkSignature(profile);
  return profile;
}

function addEdge(adjacency, from, edge) {
  if (!adjacency.has(from)) adjacency.set(from, []);
  adjacency.get(from).push(edge);
}

function periodContains(period, hour) {
  const start = finite(period.startHour, 0); const end = finite(period.endHour, 24);
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

function routeHeadwaySeconds(route, timeSeconds) {
  if (route.timetableSchedule?.mode === 'timetable') {
    const hour = ((timeSeconds % 86_400) + 86_400) % 86_400 / 3_600;
    const period = route.timetableSchedule.periods?.find((candidate) => periodContains(candidate, hour));
    return Math.max(0, finite(period?.headwaySeconds, 0));
  }
  return route.cycleTimeSeconds > 0 && route.serviceCount > 0
    ? route.cycleTimeSeconds / route.serviceCount
    : 0;
}

function nextScheduledDeparture(route, departureNodeId, departureOffsetSeconds, readySeconds) {
  const headwaySeconds = routeHeadwaySeconds(route, readySeconds);
  if (!(headwaySeconds > 0)) return null;
  const phases = route.departureAnchorsByNode?.[departureNodeId];
  if (phases?.length && route.cycleTimeSeconds > 0) {
    return phases.reduce((next, phase) => {
      const cycles = Math.max(0, Math.ceil((readySeconds - phase) / route.cycleTimeSeconds));
      return Math.min(next, phase + cycles * route.cycleTimeSeconds);
    }, Infinity);
  }
  const cycles = Math.max(0, Math.ceil((readySeconds - departureOffsetSeconds) / headwaySeconds));
  return departureOffsetSeconds + cycles * headwaySeconds;
}

const STATION_INDEX_CELL_DEGREES = 0.02;

function mergeRoute(existing, candidate) {
  if (!existing) return candidate;
  const score = (route) => (route.stComboTimings?.length ?? 0) * 10_000 + (route.stNodeIds?.length ?? 0);
  const preferred = score(candidate) > score(existing) ? candidate : existing;
  const alternate = preferred === candidate ? existing : candidate;
  const anchors = {};
  for (const route of [existing, candidate]) {
    for (const [nodeId, phases] of Object.entries(route.departureAnchorsByNode ?? {})) {
      anchors[nodeId] = [...new Set([...(anchors[nodeId] ?? []), ...phases])].sort((a, b) => a - b);
    }
  }
  return {
    ...preferred,
    bullet: preferred.bullet ?? alternate.bullet ?? null,
    name: preferred.name ?? alternate.name ?? null,
    fullName: preferred.fullName ?? alternate.fullName ?? null,
    serviceCount: Math.max(existing.serviceCount ?? 0, candidate.serviceCount ?? 0),
    configuredServiceCount: Math.max(existing.configuredServiceCount ?? 0, candidate.configuredServiceCount ?? 0),
    departureAnchorsByNode: anchors,
    ownerTileIds: [...new Set([...(existing.ownerTileIds ?? []), ...(candidate.ownerTileIds ?? [])])].sort(),
  };
}

/** Compile all saved tile profiles into one deduplicated route-state graph. */
function buildGlobalRouter(networkProfiles) {
  const profiles = Object.entries(networkProfiles ?? {}).filter(([, profile]) => profile).sort(([left], [right]) => left.localeCompare(right));
  const stationById = new Map();
  const routeById = new Map();
  const rulesByTile = {};
  for (const [tileId, profile] of profiles) {
    rulesByTile[tileId] = rulesWithDefaults(profile.pathfindingRules);
    for (const station of profile.stations ?? []) {
      const existing = stationById.get(station.id);
      if (!existing) {
        stationById.set(station.id, {
          ...station,
          coords: [...station.coords],
          stNodeIds: [...new Set(station.stNodeIds ?? [])],
          nearbyStations: [...(station.nearbyStations ?? [])],
        });
        continue;
      }
      existing.stNodeIds = [...new Set([...existing.stNodeIds, ...(station.stNodeIds ?? [])])];
      if (!existing.name && station.name) existing.name = station.name;
      const nearby = new Map(existing.nearbyStations.map((item) => [item.stationId, item]));
      for (const item of station.nearbyStations ?? []) {
        if (!nearby.has(item.stationId) || item.walkingTime < nearby.get(item.stationId).walkingTime) nearby.set(item.stationId, item);
      }
      existing.nearbyStations = [...nearby.values()];
    }
    const activeRoutes = new Set(profile.activeRouteIds ?? []);
    for (const route of profile.routes ?? []) {
      if (!activeRoutes.has(route.id)) continue;
      routeById.set(route.id, mergeRoute(routeById.get(route.id), { ...route, ownerTileIds: [tileId] }));
    }
  }

  const stations = [...stationById.values()];
  const stationByNode = new Map();
  for (const station of stations) for (const nodeId of station.stNodeIds) stationByNode.set(nodeId, station.id);
  const adjacency = new Map(stations.map((station) => [station.id, []]));
  for (const route of routeById.values()) {
    const stops = (route.stNodeIds ?? []).map((nodeId, routeIndex) => ({
      nodeId, routeIndex, stationId: stationByNode.get(nodeId),
    })).filter(({ stationId }) => stationId);
    const timings = new Map((route.stComboTimings ?? []).map((timing) => [timing.stNodeIndex, timing]));
    const lastTiming = route.stComboTimings?.at(-1);
    const cycleTimeSeconds = finite(lastTiming?.departureTime, 0);
    const compiledRoute = { ...route, cycleTimeSeconds };
    if (cycleTimeSeconds > 0 && timings.size > 1) {
      for (let index = 1; index < stops.length; index++) {
        const left = stops[index - 1]; const right = stops[index];
        const fromTiming = timings.get(left.routeIndex); const toTiming = timings.get(right.routeIndex);
        const inVehicleSeconds = finite(toTiming?.arrivalTime, NaN) - finite(fromTiming?.departureTime, NaN);
        if (left.stationId === right.stationId || !(inVehicleSeconds >= 0)) continue;
        addEdge(adjacency, left.stationId, {
          type: 'ride', to: right.stationId, route: compiledRoute,
          routeStateId: `${route.id}:forward`,
          departureNodeId: left.nodeId,
          departureOffsetSeconds: fromTiming.departureTime,
          dwellSeconds: Math.max(0, finite(fromTiming.departureTime, 0) - finite(fromTiming.arrivalTime, 0)),
          inVehicleSeconds,
        });
      }
      continue;
    }

    let fallbackCycleSeconds = 0;
    const fallbackEdges = [];
    for (let index = 1; index < stops.length; index++) {
      const left = stationById.get(stops[index - 1].stationId); const right = stationById.get(stops[index].stationId);
      if (!left || !right || left.id === right.id) continue;
      const seconds = distanceMetres(left.coords, right.coords) / TRAIN_SPEED_MPS + 60;
      fallbackEdges.push([left.id, right.id, seconds, fallbackCycleSeconds]);
      fallbackCycleSeconds += seconds;
    }
    const fallbackRoute = { ...compiledRoute, cycleTimeSeconds: fallbackCycleSeconds || DEFAULT_WAIT_SECONDS };
    for (const [left, right, seconds, offset] of fallbackEdges) {
      addEdge(adjacency, left, { type: 'ride', to: right, route: fallbackRoute, routeStateId: `${route.id}:forward`, departureNodeId: null, departureOffsetSeconds: offset, dwellSeconds: 0, inVehicleSeconds: seconds });
      addEdge(adjacency, right, { type: 'ride', to: left, route: fallbackRoute, routeStateId: `${route.id}:reverse`, departureNodeId: null, departureOffsetSeconds: offset, dwellSeconds: 0, inVehicleSeconds: seconds });
    }
  }
  for (const station of stations) {
    for (const nearby of station.nearbyStations) {
      if (stationById.has(nearby.stationId)) addEdge(adjacency, station.id, { type: 'walk', to: nearby.stationId, seconds: nearby.walkingTime });
    }
  }
  const spatialIndex = new Map();
  for (const station of stations) {
    const key = `${Math.floor(station.coords[0] / STATION_INDEX_CELL_DEGREES)}:${Math.floor(station.coords[1] / STATION_INDEX_CELL_DEGREES)}`;
    if (!spatialIndex.has(key)) spatialIndex.set(key, []);
    spatialIndex.get(key).push(station);
  }
  return {
    tileIds: profiles.map(([tileId]) => tileId), rulesByTile, stations, stationById, routeById, adjacency, spatialIndex,
    defaultRules: rulesByTile[profiles[0]?.[0]] ?? rulesWithDefaults(),
    networkSignature: hashNetworkValue(profiles.map(([tileId, profile]) => [tileId, profile.signature ?? stableNetworkSignature(profile)])),
    gatewayPathCache: new Map(),
    endpointPathCache: new Map(), catchmentCache: new Map(),
    routingStats: {
      gatewayPathHits: 0, gatewayPathMisses: 0,
      endpointPathHits: 0, endpointPathMisses: 0,
      catchmentHits: 0, catchmentMisses: 0,
    },
  };
}

function nearbyStationTimes(router, coords, maxWalkSeconds) {
  const maxMetres = maxWalkSeconds * WALK_SPEED_MPS;
  const latRadius = maxMetres / 111_320;
  const lonRadius = latRadius / Math.max(0.05, Math.cos(coords[1] * Math.PI / 180));
  const minX = Math.floor((coords[0] - lonRadius) / STATION_INDEX_CELL_DEGREES);
  const maxX = Math.floor((coords[0] + lonRadius) / STATION_INDEX_CELL_DEGREES);
  const minY = Math.floor((coords[1] - latRadius) / STATION_INDEX_CELL_DEGREES);
  const maxY = Math.floor((coords[1] + latRadius) / STATION_INDEX_CELL_DEGREES);
  const result = [];
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
    for (const station of router.spatialIndex.get(`${x}:${y}`) ?? []) {
      const seconds = distanceMetres(coords, station.coords) / WALK_SPEED_MPS;
      if (seconds <= maxWalkSeconds) result.push([station.id, seconds]);
    }
  }
  return result;
}

function stationCatchment(router, coords, maxWalkSeconds) {
  const key = `${coords[0]},${coords[1]}|${maxWalkSeconds}`;
  const cached = router.catchmentCache.get(key);
  if (cached) {
    router.routingStats.catchmentHits++;
    return cached;
  }
  const stations = nearbyStationTimes(router, coords, maxWalkSeconds)
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId));
  const catchment = { stations, signature: stations.map(([id]) => id).join('\u001f') };
  router.catchmentCache.set(key, catchment);
  router.routingStats.catchmentMisses++;
  return catchment;
}

class MinHeap {
  constructor() { this.items = []; }
  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent][0] <= item[0]) break;
      this.items[index] = this.items[parent]; index = parent;
    }
    this.items[index] = item;
  }
  pop() {
    if (this.items.length === 0) return null;
    const root = this.items[0]; const tail = this.items.pop();
    if (this.items.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1; const right = left + 1;
        if (left >= this.items.length) break;
        const child = right < this.items.length && this.items[right][0] < this.items[left][0] ? right : left;
        if (this.items[child][0] >= tail[0]) break;
        this.items[index] = this.items[child]; index = child;
      }
      this.items[index] = tail;
    }
    return root;
  }
  get size() { return this.items.length; }
}

function unavailableLeg(reason, networkTileId = null) { return { available: false, reason, networkTileId, totalSeconds: null }; }

function appendStationRoute(stationRoutes, routeId, fromStationId, toStationId) {
  const next = stationRoutes.map((segment) => ({ ...segment, stationIds: [...segment.stationIds] }));
  const last = next.at(-1);
  if (last?.routeId === routeId) {
    if (last.stationIds.at(-1) !== fromStationId) last.stationIds.push(fromStationId);
    if (last.stationIds.at(-1) !== toStationId) last.stationIds.push(toStationId);
  } else {
    next.push({ routeId, stationIds: [fromStationId, toStationId] });
  }
  return next;
}

function combineStationRoutes(...groups) {
  let combined = [];
  for (const segment of groups.flat()) {
    const stationIds = segment?.stationIds ?? [];
    if (!segment?.routeId || stationIds.length < 2) continue;
    combined = appendStationRoute(combined, segment.routeId, stationIds[0], stationIds.at(-1));
  }
  return combined;
}

function routeStateKey(stationId, routeId) { return `${stationId}\u0000${routeId ?? ''}`; }

function advanceRouteLabel(currentLabel, edge, rules) {
  if (edge.type === 'walk') {
    return {
      ...currentLabel,
      stationId: edge.to,
      currentRouteId: null,
      stationPath: [...currentLabel.stationPath, edge.to],
      actualTime: currentLabel.actualTime + edge.seconds,
      perceivedSeconds: currentLabel.perceivedSeconds + edge.seconds * rules.PERCEIVED_TIME.WALK_MULTIPLIER,
      transferWalkSeconds: currentLabel.transferWalkSeconds + edge.seconds,
    };
  }
  const continuing = currentLabel.currentRouteId === edge.routeStateId;
  let departure; let departureShiftSeconds; let waitSeconds; let vehicleSeconds;
  if (continuing) {
    departure = currentLabel.actualTime + edge.dwellSeconds;
    departureShiftSeconds = 0; waitSeconds = 0;
    vehicleSeconds = edge.dwellSeconds + edge.inVehicleSeconds;
  } else {
    const arrivalGap = currentLabel.boarded ? 0 : rules.ARRIVAL_GAP;
    departure = nextScheduledDeparture(edge.route, edge.departureNodeId, edge.departureOffsetSeconds, currentLabel.actualTime + arrivalGap);
    if (departure == null) return null;
    departureShiftSeconds = currentLabel.boarded ? 0 : Math.max(0, departure - arrivalGap - currentLabel.actualTime);
    waitSeconds = currentLabel.boarded ? Math.max(0, departure - currentLabel.actualTime) : arrivalGap;
    vehicleSeconds = edge.inVehicleSeconds;
  }
  const ownerTileId = edge.route.ownerTileIds?.[0];
  return {
    ...currentLabel,
    stationId: edge.to,
    currentRouteId: edge.routeStateId,
    stationPath: [...currentLabel.stationPath, edge.to],
    stationRoutes: appendStationRoute(currentLabel.stationRoutes, edge.route.id, currentLabel.stationId, edge.to),
    actualTime: departure + edge.inVehicleSeconds,
    perceivedSeconds: currentLabel.perceivedSeconds
      + departureShiftSeconds * rules.PERCEIVED_TIME.DEPARTURE_SHIFT_MULTIPLIER
      + waitSeconds * rules.PERCEIVED_TIME.WAIT_MULTIPLIER
      + vehicleSeconds,
    waitSeconds: currentLabel.waitSeconds + waitSeconds,
    departureShiftSeconds: currentLabel.departureShiftSeconds + departureShiftSeconds,
    inVehicleSeconds: currentLabel.inVehicleSeconds + vehicleSeconds,
    boarded: true,
    networkTileIds: ownerTileId && !currentLabel.networkTileIds.includes(ownerTileId)
      ? [...currentLabel.networkTileIds, ownerTileId]
      : currentLabel.networkTileIds,
  };
}

function finishRouteLeg(router, bestLabel, egressWalkSeconds, preferredTileId, requestedDepartureSeconds, rules) {
  const waitSeconds = bestLabel.waitSeconds;
  const departureShiftSeconds = bestLabel.departureShiftSeconds;
  const accessPerceivedSeconds = bestLabel.accessWalkSeconds * rules.PERCEIVED_TIME.WALK_MULTIPLIER;
  const egressPerceivedSeconds = egressWalkSeconds * rules.PERCEIVED_TIME.WALK_MULTIPLIER;
  const result = {
    available: true,
    reason: null,
    networkTileId: bestLabel.networkTileIds[0] ?? preferredTileId ?? router.tileIds[0],
    networkTileIds: bestLabel.networkTileIds,
    originStationId: bestLabel.sourceStationId,
    originStationName: router.stationById.get(bestLabel.sourceStationId)?.name ?? null,
    destinationStationId: bestLabel.stationId,
    destinationStationName: router.stationById.get(bestLabel.stationId)?.name ?? null,
    stationPath: bestLabel.stationPath,
    stationRoutes: bestLabel.stationRoutes,
    routes: bestLabel.stationRoutes.map(({ routeId }) => {
      const route = router.routeById.get(routeId);
      const bullet = route?.bullet ?? null;
      const name = route?.fullName ?? route?.name ?? null;
      return {
        routeId,
        bullet,
        name,
        label: bullet && name && bullet !== name ? `${bullet} — ${name}` : name ?? bullet ?? routeId,
      };
    }),
    usesNetworkConnection: bestLabel.boarded,
    accessWalkSeconds: bestLabel.accessWalkSeconds,
    egressWalkSeconds,
    transferWalkSeconds: bestLabel.transferWalkSeconds,
    waitSeconds,
    departureShiftSeconds,
    accessPerceivedSeconds,
    egressPerceivedSeconds,
    waitPerceivedSeconds: waitSeconds * rules.PERCEIVED_TIME.WAIT_MULTIPLIER,
    departureShiftPerceivedSeconds: departureShiftSeconds * rules.PERCEIVED_TIME.DEPARTURE_SHIFT_MULTIPLIER,
    networkSeconds: bestLabel.inVehicleSeconds,
    totalClockSeconds: bestLabel.actualTime - requestedDepartureSeconds + egressWalkSeconds,
    totalSeconds: bestLabel.perceivedSeconds + egressPerceivedSeconds,
  };
  Object.defineProperty(result, '_topology', {
    value: { sourceStationId: bestLabel.sourceStationId, destinationStationId: bestLabel.stationId, edges: bestLabel.edgePath },
  });
  return result;
}

function routeLeg(router, origin, destination, preferredTileId, requestedDepartureSeconds = 0, preparedCatchments = null) {
  if (!router || router.tileIds.length === 0) return unavailableLeg('network-profile-missing');
  if (router.stations.length === 0) return unavailableLeg('no-constructed-stations');
  const rules = router.rulesByTile[preferredTileId] ?? router.defaultRules;
  const maxWalk = rules.MAX_WALK_TO_FROM_STATION;
  const walkWeight = rules.PERCEIVED_TIME.WALK_MULTIPLIER;
  const starts = preparedCatchments?.origin?.stations ?? stationCatchment(router, origin, maxWalk).stations;
  const ends = new Map(preparedCatchments?.destination?.stations ?? stationCatchment(router, destination, maxWalk).stations);
  if (starts.length === 0) return unavailableLeg('origin-outside-walk-range');
  if (ends.size === 0) return unavailableLeg('destination-outside-walk-range');
  const labels = new Map(); const queue = new MinHeap();
  for (const [id, seconds] of starts) {
    const perceivedSeconds = seconds * walkWeight;
    const key = routeStateKey(id, null);
    if (perceivedSeconds >= (labels.get(key)?.perceivedSeconds ?? Infinity)) continue;
    labels.set(key, {
      stationId: id, currentRouteId: null, sourceStationId: id, stationPath: [id], stationRoutes: [],
      actualTime: requestedDepartureSeconds + seconds,
      perceivedSeconds, accessWalkSeconds: seconds, transferWalkSeconds: 0,
      waitSeconds: 0, departureShiftSeconds: 0, inVehicleSeconds: 0,
      boarded: false, networkTileIds: [], edgePath: [],
    });
    queue.push([perceivedSeconds, key]);
  }
  let destinationStationId = null; let egressWalkSeconds = null; let best = Infinity; let bestLabel = null;
  while (queue.size > 0) {
    const [distance, currentKey] = queue.pop();
    const currentLabel = labels.get(currentKey);
    if (!currentLabel || distance !== currentLabel.perceivedSeconds) continue;
    if (distance >= best) break;
    const endWalk = ends.get(currentLabel.stationId);
    if (endWalk != null) {
      const candidate = distance + endWalk * walkWeight;
      if (candidate < best) {
        best = candidate; destinationStationId = currentLabel.stationId;
        egressWalkSeconds = endWalk; bestLabel = currentLabel;
      }
    }
    for (const edge of router.adjacency.get(currentLabel.stationId) ?? []) {
      const candidate = advanceRouteLabel(currentLabel, edge, rules);
      if (!candidate) continue;
      candidate.edgePath = [...currentLabel.edgePath, edge];
      const candidateKey = routeStateKey(candidate.stationId, candidate.currentRouteId);
      if (candidate.perceivedSeconds < (labels.get(candidateKey)?.perceivedSeconds ?? Infinity)) {
        labels.set(candidateKey, candidate);
        queue.push([candidate.perceivedSeconds, candidateKey]);
      }
    }
  }
  if (!Number.isFinite(best) || destinationStationId == null) return unavailableLeg('stations-disconnected');
  return finishRouteLeg(router, bestLabel, egressWalkSeconds, preferredTileId, requestedDepartureSeconds, rules);
}

function replayRouteTopology(router, topology, origin, destination, preferredTileId, requestedDepartureSeconds) {
  const rules = router.rulesByTile[preferredTileId] ?? router.defaultRules;
  const source = router.stationById.get(topology.sourceStationId);
  const destinationStation = router.stationById.get(topology.destinationStationId);
  if (!source || !destinationStation) return unavailableLeg('cached-station-missing');
  const accessWalkSeconds = distanceMetres(origin, source.coords) / WALK_SPEED_MPS;
  const egressWalkSeconds = distanceMetres(destination, destinationStation.coords) / WALK_SPEED_MPS;
  if (accessWalkSeconds > rules.MAX_WALK_TO_FROM_STATION || egressWalkSeconds > rules.MAX_WALK_TO_FROM_STATION) {
    return unavailableLeg('cached-station-outside-walk-range');
  }
  let label = {
    stationId: source.id, currentRouteId: null, sourceStationId: source.id, stationPath: [source.id], stationRoutes: [],
    actualTime: requestedDepartureSeconds + accessWalkSeconds,
    perceivedSeconds: accessWalkSeconds * rules.PERCEIVED_TIME.WALK_MULTIPLIER,
    accessWalkSeconds, transferWalkSeconds: 0, waitSeconds: 0, departureShiftSeconds: 0, inVehicleSeconds: 0,
    boarded: false, networkTileIds: [], edgePath: topology.edges,
  };
  for (const edge of topology.edges) {
    label = advanceRouteLabel(label, edge, rules);
    if (!label) return unavailableLeg('cached-service-unavailable');
  }
  if (label.stationId !== destinationStation.id) return unavailableLeg('cached-path-invalid');
  return finishRouteLeg(router, label, egressWalkSeconds, preferredTileId, requestedDepartureSeconds, rules);
}

function cachedGatewayLeg(router, fromGateway, toGateway, preferredTileId, requestedDepartureSeconds) {
  const key = `${router.networkSignature}|${fromGateway.id}>${toGateway.id}|${preferredTileId ?? ''}`;
  const cached = router.gatewayPathCache.get(key);
  if (cached) {
    const replayed = replayRouteTopology(
      router, cached, fromGateway.location, toGateway.location, preferredTileId, requestedDepartureSeconds,
    );
    if (replayed.available) {
      router.routingStats.gatewayPathHits++;
      return { ...replayed, cacheHit: true, fromGatewayId: fromGateway.id, toGatewayId: toGateway.id };
    }
    router.gatewayPathCache.delete(key);
  }
  router.routingStats.gatewayPathMisses++;
  const calculated = routeLeg(router, fromGateway.location, toGateway.location, preferredTileId, requestedDepartureSeconds);
  if (calculated.available && calculated._topology) router.gatewayPathCache.set(key, calculated._topology);
  return { ...calculated, cacheHit: false, fromGatewayId: fromGateway.id, toGatewayId: toGateway.id };
}

function cachedEndpointLeg(router, origin, destination, preferredTileId, requestedDepartureSeconds, { direction, gatewayId }) {
  const rules = router.rulesByTile[preferredTileId] ?? router.defaultRules;
  const maxWalk = rules.MAX_WALK_TO_FROM_STATION;
  const originCatchment = stationCatchment(router, origin, maxWalk);
  const destinationCatchment = stationCatchment(router, destination, maxWalk);
  if (originCatchment.stations.length === 0) return unavailableLeg('origin-outside-walk-range');
  if (destinationCatchment.stations.length === 0) return unavailableLeg('destination-outside-walk-range');
  const key = [
    router.networkSignature, direction, gatewayId, preferredTileId ?? '',
    originCatchment.signature, destinationCatchment.signature,
  ].join('|');
  const cached = router.endpointPathCache.get(key);
  if (cached) {
    const replayed = replayRouteTopology(router, cached, origin, destination, preferredTileId, requestedDepartureSeconds);
    if (replayed.available) {
      router.routingStats.endpointPathHits++;
      return { ...replayed, cacheHit: true, endpointCacheDirection: direction, gatewayId, attemptedNetworkTiles: router.tileIds };
    }
    router.endpointPathCache.delete(key);
  }
  router.routingStats.endpointPathMisses++;
  const calculated = routeLeg(router, origin, destination, preferredTileId, requestedDepartureSeconds, {
    origin: originCatchment, destination: destinationCatchment,
  });
  if (calculated.available && calculated._topology) router.endpointPathCache.set(key, calculated._topology);
  return { ...calculated, cacheHit: false, endpointCacheDirection: direction, gatewayId, attemptedNetworkTiles: router.tileIds };
}

function routeLegAcrossNetworks(router, origin, destination, preferredTileId, { requireNetworkConnection = false, requestedDepartureSeconds = 0 } = {}) {
  const leg = routeLeg(router, origin, destination, preferredTileId, requestedDepartureSeconds);
  if (leg.available && (!requireNetworkConnection || leg.usesNetworkConnection)) {
    return { ...leg, attemptedNetworkTiles: router.tileIds };
  }
  if (requireNetworkConnection && leg.available) {
    return { ...unavailableLeg('no-through-service'), attemptedNetworkTiles: router.tileIds };
  }
  return { ...leg, networkTileId: null, attemptedNetworkTiles: router.tileIds };
}

function gatewayLocation(gateway) {
  return gateway?.location
    ?? (Number.isFinite(gateway?.longitude) && Number.isFinite(gateway?.latitude)
      ? [gateway.longitude, gateway.latitude]
      : null);
}

function overlappingMidpoint(leftMin, leftMax, rightMin, rightMax) {
  if (leftMax < rightMin) return (leftMax + rightMin) / 2;
  if (rightMax < leftMin) return (rightMax + leftMin) / 2;
  return (Math.max(leftMin, rightMin) + Math.min(leftMax, rightMax)) / 2;
}

function boundsAreAdjacent(left, right) {
  if (!Array.isArray(left?.bounds) || !Array.isArray(right?.bounds)) return false;
  const epsilon = 1e-6;
  const horizontalTouch = Math.abs(left.bounds[2] - right.bounds[0]) <= epsilon
    || Math.abs(right.bounds[2] - left.bounds[0]) <= epsilon;
  const verticalOverlap = Math.min(left.bounds[3], right.bounds[3]) > Math.max(left.bounds[1], right.bounds[1]);
  const verticalTouch = Math.abs(left.bounds[3] - right.bounds[1]) <= epsilon
    || Math.abs(right.bounds[3] - left.bounds[1]) <= epsilon;
  const horizontalOverlap = Math.min(left.bounds[2], right.bounds[2]) > Math.max(left.bounds[0], right.bounds[0]);
  return (horizontalTouch && verticalOverlap) || (verticalTouch && horizontalOverlap);
}

function runtimeGatewayChain(tileCatalog, homeTileId, workTileId) {
  const tiles = new Map((tileCatalog?.tiles ?? []).map((tile) => [tile.id, tile]));
  if (!tiles.has(homeTileId) || !tiles.has(workTileId) || homeTileId === workTileId) return [];
  const neighborsOf = (tile) => {
    const declared = (tile.neighbors ?? []).map((item) => item.tileId).filter((id) => tiles.has(id));
    if (declared.length > 0) return declared.sort();
    return [...tiles.values()].filter((candidate) => candidate.id !== tile.id && boundsAreAdjacent(tile, candidate))
      .map((candidate) => candidate.id).sort();
  };
  const pending = [[homeTileId, [homeTileId]]]; const visited = new Set([homeTileId]);
  let tilePath = null;
  while (pending.length > 0 && !tilePath) {
    const [tileId, path] = pending.shift();
    for (const neighborId of neighborsOf(tiles.get(tileId))) {
      if (visited.has(neighborId)) continue;
      const next = [...path, neighborId];
      if (neighborId === workTileId) { tilePath = next; break; }
      visited.add(neighborId); pending.push([neighborId, next]);
    }
  }
  if (!tilePath) return [];
  return tilePath.slice(1).map((rightId, index) => {
    const leftId = tilePath[index]; const left = tiles.get(leftId); const right = tiles.get(rightId);
    return {
      id: `${leftId}>${rightId}`,
      location: [
        overlappingMidpoint(left.bounds[0], left.bounds[2], right.bounds[0], right.bounds[2]),
        overlappingMidpoint(left.bounds[1], left.bounds[3], right.bounds[1], right.bounds[3]),
      ],
    };
  });
}

function inspectGatewayChain({ popId, gatewayId, home, work, router, tileCatalog, requestedDepartureSeconds }) {
  const path = runtimeGatewayChain(tileCatalog, home.tileId, work.tileId);
  if (path.length < 1) return null;
  const pathIds = path.map(({ id }) => id);
  const firstGateway = path[0]; const lastGateway = path.at(-1);
  const homeLeg = cachedEndpointLeg(
    router, home.coords, gatewayLocation(firstGateway), home.tileId, requestedDepartureSeconds,
    { direction: 'outbound', gatewayId: firstGateway.id },
  );
  const intermediateRequestedDeparture = homeLeg.available
    ? requestedDepartureSeconds + homeLeg.totalClockSeconds - homeLeg.egressWalkSeconds
    : requestedDepartureSeconds;
  const intermediateLeg = path.length > 1
    ? (homeLeg.available
      ? cachedGatewayLeg(router, firstGateway, lastGateway, home.tileId, intermediateRequestedDeparture)
      : unavailableLeg('home-leg-unavailable'))
    : null;
  const intermediateAvailable = intermediateLeg == null || intermediateLeg.available;
  const workRequestedDeparture = intermediateLeg?.available
    ? intermediateRequestedDeparture + intermediateLeg.totalClockSeconds - intermediateLeg.egressWalkSeconds
    : intermediateRequestedDeparture;
  const workLeg = homeLeg.available && intermediateAvailable
    ? cachedEndpointLeg(
      router, gatewayLocation(lastGateway), work.coords, work.tileId, workRequestedDeparture,
      { direction: 'inbound', gatewayId: lastGateway.id },
    )
    : unavailableLeg(intermediateLeg ? 'intermediate-leg-unavailable' : 'home-leg-unavailable');
  const available = homeLeg.available && intermediateAvailable && workLeg.available;
  const homeSegmentSeconds = homeLeg.available ? homeLeg.totalSeconds - homeLeg.egressPerceivedSeconds : null;
  const intermediateSegmentSeconds = intermediateLeg?.available
    ? intermediateLeg.totalSeconds - intermediateLeg.accessPerceivedSeconds - intermediateLeg.egressPerceivedSeconds
      - intermediateLeg.waitPerceivedSeconds - intermediateLeg.departureShiftPerceivedSeconds
    : (intermediateLeg ? null : 0);
  const workSegmentSeconds = workLeg.available
    ? workLeg.totalSeconds - workLeg.accessPerceivedSeconds - workLeg.waitPerceivedSeconds - workLeg.departureShiftPerceivedSeconds
    : null;
  return {
    popId, gatewayId, gatewayPathIds: pathIds, available, continuous: false,
    reason: available ? null : 'incomplete-gateway-chain', gatewaySeconds: intermediateSegmentSeconds,
    totalSeconds: available ? homeSegmentSeconds + intermediateSegmentSeconds + workSegmentSeconds : null,
    totalClockSeconds: available
      ? homeLeg.accessWalkSeconds + homeLeg.departureShiftSeconds + homeLeg.waitSeconds
        + homeLeg.transferWalkSeconds + homeLeg.networkSeconds
        + (intermediateLeg?.transferWalkSeconds ?? 0) + (intermediateLeg?.networkSeconds ?? 0)
        + workLeg.transferWalkSeconds + workLeg.networkSeconds + workLeg.egressWalkSeconds
      : null,
    homeSegmentSeconds, intermediateSegmentSeconds, workSegmentSeconds,
    continuousLeg: null, homeLeg, intermediateLeg, workLeg,
  };
}

function inspectPopTransitPath({ pop, popIndex, points, gateways, routers, gatewayCatalog, tileCatalog, requestedDepartureSeconds = 0 }) {
  if (!pop) throw new RangeError(`Unknown cross-demand pop index: ${popIndex}`);
  const [popId, , homeIndex, workIndex, gatewayIndex] = pop;
  const home = points[homeIndex]; const work = points[workIndex]; const gatewayId = gateways[gatewayIndex];
  const chained = inspectGatewayChain({
    popId, gatewayId, home, work, router: routers, tileCatalog, requestedDepartureSeconds,
  });
  if (chained?.available) return chained;
  const continuousLeg = routeLegAcrossNetworks(routers, home.coords, work.coords, home.tileId, { requireNetworkConnection: true, requestedDepartureSeconds });
  if (continuousLeg.available) {
    return {
      popId, gatewayId, available: true, continuous: true, reason: null,
      gatewaySeconds: 0, totalSeconds: continuousLeg.totalSeconds, totalClockSeconds: continuousLeg.totalClockSeconds,
      continuousLeg,
      // Retain split-leg diagnostics so the panel can still explain which
      // saved profile covers each side of the logical boundary.
      homeLeg: null, workLeg: null,
    };
  }
  if (chained) return chained;
  const gateway = gatewayCatalog?.[gatewayId];
  const gatewayCoords = gatewayLocation(gateway);
  if (!gatewayCoords) {
    return { popId, gatewayId, available: false, continuous: false, reason: 'gateway-location-missing', gatewaySeconds: 0, totalSeconds: null, continuousLeg, homeLeg: null, workLeg: null };
  }
  // A native save owns the route objects it captured, but a route can extend
  // beyond that tile's geographic boundary. Search every saved profile so a
  // cross-boundary line remains usable from either side of the handoff.
  const homeLeg = routeLegAcrossNetworks(routers, home.coords, gatewayCoords, home.tileId, { requestedDepartureSeconds });
  const workRequestedDeparture = homeLeg.available
    ? requestedDepartureSeconds + homeLeg.totalClockSeconds - homeLeg.egressWalkSeconds
    : requestedDepartureSeconds;
  const workLeg = routeLegAcrossNetworks(routers, gatewayCoords, work.coords, work.tileId, { requestedDepartureSeconds: workRequestedDeparture });
  const available = homeLeg.available && workLeg.available;
  // The gateway divides simulation ownership, not the passenger journey.
  // Exclude the first leg's artificial walk-out, the second leg's walk-in and
  // second wait, and add no fixed transfer penalty: the passenger stays aboard.
  const homeSegmentSeconds = homeLeg.available ? homeLeg.totalSeconds - homeLeg.egressPerceivedSeconds : null;
  const workSegmentSeconds = workLeg.available
    ? workLeg.totalSeconds - workLeg.accessPerceivedSeconds - workLeg.waitPerceivedSeconds - workLeg.departureShiftPerceivedSeconds
    : null;
  return {
    popId,
    gatewayId,
    available,
    continuous: false,
    reason: available ? null : 'incomplete-tile-leg',
    gatewaySeconds: 0,
    totalSeconds: available ? homeSegmentSeconds + workSegmentSeconds : null,
    totalClockSeconds: available
      ? homeLeg.accessWalkSeconds + homeLeg.departureShiftSeconds + homeLeg.waitSeconds
        + homeLeg.transferWalkSeconds + homeLeg.networkSeconds
        + workLeg.transferWalkSeconds + workLeg.networkSeconds + workLeg.egressWalkSeconds
      : null,
    homeSegmentSeconds,
    workSegmentSeconds,
    continuousLeg,
    homeLeg,
    workLeg,
  };
}

/** Explain the exact two-tile path inputs used by cross-city mode choice. */
export function inspectCrossTileTransitPath({ crossDemand, popIndex, networkProfiles, gatewayCatalog, tileCatalog, requestedDepartureSeconds = 0 }) {
  if (crossDemand?.schemaVersion !== 1) throw new Error('Unsupported cross-demand data');
  const points = crossDemand.points.map(([id, longitude, latitude, tileId]) => ({ id, coords: [longitude, latitude], tileId }));
  const routers = buildGlobalRouter(networkProfiles);
  const pop = crossDemand.pops[popIndex];
  if (!pop) throw new RangeError(`Unknown cross-demand pop index: ${popIndex}`);
  const departureSeconds = popDepartureSeconds(pop, popFields(crossDemand.popFields), requestedDepartureSeconds);
  return inspectPopTransitPath({ pop, popIndex, points, gateways: crossDemand.gateways, routers, gatewayCatalog, tileCatalog, requestedDepartureSeconds: departureSeconds });
}

function inverseNormalCDF(value) {
  const p = Math.max(1e-4, Math.min(0.9999, value));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 0.97575) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function incomeForPerson(index, population, rules) {
  const percentile = index / Math.max(population - 1, 1);
  let income = rules.INCOME_MEAN + inverseNormalCDF(percentile) * rules.INCOME_STD_DEV;
  income = Math.max(rules.MINIMUM_INCOME, Math.min(income, rules.MAXIMUM_INCOME));
  const noise = (index * 362436069 % 1e6) / 1e6;
  if (income <= rules.MINIMUM_INCOME + 5_000) income = rules.INCOME_MEAN + inverseNormalCDF(0.1 + noise * 0.85) * rules.INCOME_STD_DEV;
  else if (noise < 0.1) income += ((index * 123456789 % 1e6) / 1e6) * 100_000;
  return Math.max(rules.MINIMUM_INCOME, Math.min(income, rules.MAXIMUM_INCOME));
}

const incomeValueDistributionCache = new Map();

function incomeValueDistribution(population, rules) {
  const key = [
    population,
    rules.INCOME_MEAN,
    rules.INCOME_STD_DEV,
    rules.MINIMUM_INCOME,
    rules.MAXIMUM_INCOME,
    rules.HOURS_WORKED_PER_YEAR,
  ].join('|');
  let values = incomeValueDistributionCache.get(key);
  if (values) return values;
  values = new Float64Array(Math.max(0, Math.ceil(population)));
  for (let index = 0; index < values.length; index++) {
    values[index] = incomeForPerson(index, population, rules) / rules.HOURS_WORKED_PER_YEAR / 3_600;
  }
  incomeValueDistributionCache.set(key, values);
  return values;
}

/** Mirrors Subway Builder 1.6's deterministic income-based mode choice. */
export function chooseModes({ population, drivingTime, drivingDistance, transitTime, walkTime, transitCost, drivingTimeMultiplier, pathfindingRules = {} }) {
  const rules = rulesWithDefaults(pathfindingRules);
  const metrics = modeChoiceMetrics({ drivingTime, drivingDistance, transitTime, walkTime, transitCost, drivingTimeMultiplier, rules });
  const result = { driving: 0, walking: 0, transit: 0, unknown: 0 };
  const drivingTimeCost = metrics.driving.perceivedSeconds * metrics.driving.shortTripPenalty;
  const drivingMoneyCost = metrics.driving.moneyCost * metrics.driving.shortTripPenalty;
  const transitTimeCost = metrics.transit.perceivedSeconds;
  const transitMoneyCost = metrics.transit.moneyCost;
  const walkingTimeCost = metrics.walking.perceivedSeconds;
  for (const hourlyValue of incomeValueDistribution(population, rules)) {
    let bestCost = drivingTimeCost * hourlyValue + drivingMoneyCost;
    let mode = 'driving';
    const transitGeneralizedCost = transitTimeCost * hourlyValue + transitMoneyCost;
    if (transitGeneralizedCost < bestCost) { bestCost = transitGeneralizedCost; mode = 'transit'; }
    if (walkingTimeCost * hourlyValue < bestCost) mode = 'walking';
    result[mode] += 1;
  }
  if (result.transit < rules.MIN_TRANSIT_CHOICE) { result.driving += result.transit; result.transit = 0; }
  return result;
}

function modeChoiceMetrics({ drivingTime, drivingDistance, transitTime, walkTime, transitCost, drivingTimeMultiplier, rules }) {
  const multiplier = finite(drivingTimeMultiplier, rules.DRIVING_TIMES.HIGH_DEMAND);
  const congestedShare = Math.min(1, Math.max(0, (multiplier - 1) / (rules.PERCEIVED_TIME.CONGESTION_FULL_AT_MULTIPLIER - 1)));
  const perceivedDriving = drivingTime * multiplier * (1 + congestedShare * (rules.PERCEIVED_TIME.CONGESTED_DRIVING_MULTIPLIER - 1))
    + rules.PARKING_TIME * 2 * rules.PERCEIVED_TIME.PARKING_SEARCH_MULTIPLIER;
  return {
    driving: {
      clockSeconds: drivingTime,
      timeMultiplier: multiplier,
      congestedClockSeconds: drivingTime * multiplier,
      perceivedSeconds: perceivedDriving,
      distanceMetres: drivingDistance,
      moneyCost: drivingDistance / 1_000 * rules.DRIVING_COST_PER_KM + rules.PARKING_COST,
      shortTripPenalty: drivingDistance < rules.MIN_SENSIBLE_DRIVING_DISTANCE
        ? 1 + (rules.MIN_SENSIBLE_DRIVING_DISTANCE - drivingDistance) / rules.MIN_SENSIBLE_DRIVING_DISTANCE
        : 1,
      estimator: `straight-line ×${ROAD_CIRCUITY} at ${Math.round(DRIVE_SPEED_MPS * 3.6)} km/h`,
    },
    transit: { perceivedSeconds: transitTime, moneyCost: transitCost },
    walking: { clockSeconds: walkTime, perceivedSeconds: walkTime, moneyCost: 0 },
  };
}

function packagedDrivingInputs(pop, directDistance, popFields, drivingModel) {
  const fields = popFields instanceof Map ? popFields : new Map((popFields ?? []).map((name, index) => [name, index]));
  const drivingSeconds = pop[fields.get('drivingSeconds')];
  const drivingDistance = pop[fields.get('drivingDistance')];
  if (Number.isFinite(drivingSeconds) && drivingSeconds > 0 && Number.isFinite(drivingDistance) && drivingDistance > 0) {
    return {
      drivingTime: drivingSeconds,
      drivingDistance,
      estimator: drivingModel?.label ?? drivingModel?.provider ?? 'build-time road router',
    };
  }
  const fallbackDistance = Math.max(1, directDistance * ROAD_CIRCUITY);
  return {
    drivingTime: fallbackDistance / DRIVE_SPEED_MPS,
    drivingDistance: fallbackDistance,
    estimator: 'straight-line ×1.3 at 40 km/h',
  };
}

function stationRoutesForTransitPath(path) {
  if (!path?.available) return [];
  return path.continuous
    ? combineStationRoutes(path.continuousLeg?.stationRoutes ?? [])
    : combineStationRoutes(
      path.homeLeg?.stationRoutes ?? [],
      path.intermediateLeg?.stationRoutes ?? [],
      path.workLeg?.stationRoutes ?? [],
    );
}

function inspectPopModeChoice({ pop, popIndex, points, gateways, routers, gatewayCatalog, tileCatalog, fare, journeyFare, requestedDepartureSeconds, popFields, drivingModel }) {
  if (!pop) throw new RangeError(`Unknown cross-demand pop index: ${popIndex}`);
  const [popId, mass, homeIndex, workIndex, gatewayIndex] = pop;
  const home = points[homeIndex]; const work = points[workIndex]; const gatewayId = gateways[gatewayIndex];
  const direct = distanceMetres(home.coords, work.coords);
  const rules = routers.rulesByTile?.[home.tileId] ?? routers.rulesByTile?.[work.tileId] ?? routers.defaultRules ?? DEFAULT_RULES;
  const fields = popFields instanceof Map ? popFields : new Map((popFields ?? []).map((name, index) => [name, index]));
  const departureSeconds = popDepartureSeconds(pop, fields, requestedDepartureSeconds);
  const drivingTimeMultiplier = drivingMultiplierAt(departureSeconds, rules);
  const driving = packagedDrivingInputs(pop, direct, fields, drivingModel);
  const transitPath = inspectPopTransitPath({ pop, popIndex, points, gateways, routers, gatewayCatalog, tileCatalog, requestedDepartureSeconds: departureSeconds });
  const transitTime = transitPath.available ? transitPath.totalSeconds : Infinity;
  const stationRoutes = stationRoutesForTransitPath(transitPath);
  const fareQuote = transitPath.available && stationRoutes.length > 0 && typeof journeyFare === 'function'
    ? journeyFare(stationRoutes, routers.stationById)
    : { total: fare, revenueByRoute: {} };
  const transitFare = Number.isFinite(fareQuote?.total) && fareQuote.total >= 0 ? fareQuote.total : fare;
  const rawInputs = {
    population: mass,
    drivingTime: driving.drivingTime,
    drivingDistance: driving.drivingDistance,
    transitTime,
    walkTime: direct / WALK_SPEED_MPS,
    transitCost: transitFare,
    drivingTimeMultiplier,
    pathfindingRules: rules,
  };
  const metrics = modeChoiceMetrics({ ...rawInputs, rules });
  metrics.driving.estimator = driving.estimator;
  metrics.transit.clockSeconds = transitPath.available ? transitPath.totalClockSeconds ?? null : null;
  const medianIndex = Math.floor(Math.max(0, mass - 1) / 2);
  const medianIncome = incomeForPerson(medianIndex, mass, rules);
  const valuePerSecond = medianIncome / rules.HOURS_WORKED_PER_YEAR / 3_600;
  const generalizedCost = {
    driving: (metrics.driving.perceivedSeconds * valuePerSecond + metrics.driving.moneyCost) * metrics.driving.shortTripPenalty,
    transit: metrics.transit.perceivedSeconds * valuePerSecond + metrics.transit.moneyCost,
    walking: metrics.walking.perceivedSeconds * valuePerSecond,
  };
  return {
    popId, population: mass, homeTileId: home.tileId, workTileId: work.tileId, gatewayId,
    requestedDepartureSeconds: departureSeconds,
    modes: chooseModes(rawInputs), transitPath, stationRoutes, fareQuote: { ...fareQuote, total: transitFare },
    driving: metrics.driving, transit: metrics.transit, walking: metrics.walking,
    representativePerson: { personIndex: medianIndex, annualIncome: medianIncome, valuePerSecond, generalizedCost },
  };
}

/** Explain every input to the bundle-matched mode chooser for one cross-city pop. */
export function inspectCrossTileModeChoice({ crossDemand, popIndex, networkProfiles, gatewayCatalog, tileCatalog, fare = 0, journeyFare = null, requestedDepartureSeconds = 0 }) {
  if (crossDemand?.schemaVersion !== 1) throw new Error('Unsupported cross-demand data');
  const points = crossDemand.points.map(([id, longitude, latitude, tileId]) => ({ id, coords: [longitude, latitude], tileId }));
  const routers = buildGlobalRouter(networkProfiles);
  return inspectPopModeChoice({
    pop: crossDemand.pops[popIndex], popIndex, points, gateways: crossDemand.gateways, routers, gatewayCatalog, tileCatalog,
    fare, journeyFare, requestedDepartureSeconds, popFields: popFields(crossDemand.popFields), drivingModel: crossDemand.drivingModel,
  });
}

/** Recalculate every detailed cross-city pop and aggregate results into ledger buckets. */
export function calculateCrossTileModeShares({ crossDemand, networkProfiles, gatewayCatalog, tileCatalog, fare = 0, journeyFare = null, requestedDepartureSeconds = 0 }) {
  if (crossDemand?.schemaVersion !== 1) throw new Error('Unsupported cross-demand data');
  const points = crossDemand.points.map(([id, longitude, latitude, tileId]) => ({ id, coords: [longitude, latitude], tileId }));
  const routers = buildGlobalRouter(networkProfiles);
  const totals = new Map();
  const transitJourneys = new Map();
  const popModeChoices = {};
  let evaluatedPops = 0; let transitViablePops = 0;
  for (const [popIndex, pop] of crossDemand.pops.entries()) {
    const comparison = inspectPopModeChoice({
      pop, popIndex, points, gateways: crossDemand.gateways, routers, gatewayCatalog, tileCatalog,
      fare, journeyFare, requestedDepartureSeconds, popFields: crossDemand.popFields, drivingModel: crossDemand.drivingModel,
    });
    popModeChoices[comparison.popId] = { ...comparison.modes };
    const key = `${comparison.homeTileId}|${comparison.workTileId}|${comparison.gatewayId}`;
    const total = totals.get(key) ?? { driving: 0, walking: 0, transit: 0, unknown: 0 };
    for (const mode of Object.keys(total)) total[mode] += comparison.modes[mode];
    totals.set(key, total); evaluatedPops++;
    if (comparison.modes.transit > 0 && comparison.transitPath.available) {
      const path = comparison.transitPath;
      const stationRoutes = comparison.stationRoutes;
      if (stationRoutes.length > 0) {
        const journeys = transitJourneys.get(key) ?? [];
        journeys.push({
          popId: comparison.popId,
          transitMass: comparison.modes.transit,
          stationRoutes,
          totalClockSeconds: path.totalClockSeconds,
          fare: comparison.fareQuote.total,
          revenueByRoute: comparison.fareQuote.revenueByRoute,
        });
        transitJourneys.set(key, journeys);
      }
    }
    if (Number.isFinite(comparison.transit.perceivedSeconds)) transitViablePops++;
  }
  return {
    totals, transitJourneys, popModeChoices, evaluatedPops, transitViablePops,
    routingStats: { ...routers.routingStats },
  };
}
