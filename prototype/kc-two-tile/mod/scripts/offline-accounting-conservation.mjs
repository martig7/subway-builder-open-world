import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { backgroundFinanceForHour } from "../../../../open-world-platform/src/runtime/native-finance-model.js";
import { quoteJourneyFare } from "../../../../open-world-platform/src/runtime/journey-fare.js";
import { decodeMetroSave } from "./inspect-metro-save.mjs";

const DEFAULT_SAVE_DIRECTORY = "D:\\SubwayBuilder";
const DEFAULT_MOD_STATE =
  "C:\\Users\\darkd\\AppData\\Roaming\\metro-maker4\\mod-data\\local.ny-state-six-tile-canary.json";
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE_DIRECTORY = path.resolve(
  SCRIPT_DIRECTORY,
  "../../../../.debug/bundle-1.6.0/app/dist/renderer/public",
);
const FARE_MULTIPLIER = 365;
const SECONDS_PER_HOUR = 3_600;

function parseArgs(argv) {
  const options = { hours: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      options[key] = value;
      index += 1;
    } else options[key] = true;
  }
  options.hours = Math.max(1 / 60, Number(options.hours) || 1);
  return options;
}

function latestSave(directory, cityCode) {
  const saves = fs.readdirSync(directory)
    .filter((name) => name.endsWith(".metro"))
    .map((name) => {
      const filePath = path.join(directory, name);
      return { filePath, modified: fs.statSync(filePath).mtimeMs };
    })
    .sort((left, right) => right.modified - left.modified);
  if (!cityCode) return saves[0]?.filePath;
  for (const candidate of saves) {
    try {
      if (decodeMetroSave(candidate.filePath).mainSave?.cityCode === cityCode) return candidate.filePath;
    } catch {
      // Ignore incomplete or legacy saves while locating the requested tile.
    }
  }
  return null;
}

function findBundle(directory, prefix) {
  const name = fs.readdirSync(directory).find((entry) => entry.startsWith(prefix) && entry.endsWith(".js"));
  if (!name) throw new Error(`Could not find ${prefix}*.js under ${directory}`);
  return path.join(directory, name);
}

function decompressDemandData(compressed) {
  const popsMap = new Map((compressed?.p ?? []).map(([key, pop]) => [key, {
    id: pop.i,
    residenceId: pop.ri,
    jobId: pop.ji,
    size: pop.s,
    homeDepartureTime: pop.hd,
    workDepartureTime: pop.wd,
    drivingSeconds: pop.ds,
    drivingDistance: pop.dd,
    ...(pop.lc ? {
      lastCommute: {
        transitPaths: pop.lc.tp ?? [],
        walking: pop.lc.w,
        modeChoice: pop.lc.mc,
      },
    } : {}),
  }]));
  const points = new Map((compressed?.d ?? []).map(([key, point]) => [key, {
    id: point.i,
    location: point.l,
    residents: point.r,
    jobs: point.j,
    popIds: point.p,
    ...(point.rm ? { residentModeShare: point.rm } : {}),
    ...(point.wm ? { workerModeShare: point.wm } : {}),
  }]));
  const popMovementsMap = new Map();
  for (const [popId, movement] of compressed?.m ?? []) {
    const pop = popsMap.get(popId);
    if (!pop?.lastCommute?.transitPaths?.length) continue;
    popMovementsMap.set(popId, {
      updateTrigger: movement.ut,
      lastUpdated: movement.lu,
      journeyIndex: movement.ji,
    });
  }
  return { popsMap, points, popMovementsMap };
}

function allStationTrainMovements(popMovementsMap, popsMap) {
  const result = { stations: new Map(), trains: new Map() };
  for (const [popId, movement] of popMovementsMap) {
    const pop = popsMap.get(popId);
    if (!pop || !movement?.updateTrigger) continue;
    const size = pop.lastCommute?.modeChoice?.transit ?? pop.size;
    const trigger = movement.updateTrigger;
    const collection = trigger.type === "train-disembark" ? result.trains
      : trigger.type === "train-embark" ? result.stations
        : null;
    const key = trigger.type === "train-disembark" ? trigger.trainId : trigger.currentStationId;
    if (!collection || !key) continue;
    const existing = collection.get(key) ?? { popIds: [], size: 0 };
    existing.popIds.push(popId);
    existing.size += size;
    collection.set(key, existing);
  }
  return result;
}

function createVmWorker(filePath, appendedSource = "") {
  let posted;
  const quietConsole = {
    log() {},
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
  const self = {
    postMessage(message) { posted = message; },
  };
  const context = vm.createContext({
    console: quietConsole,
    performance,
    structuredClone,
    crypto: globalThis.crypto,
    self,
    Map,
    Set,
    WeakMap,
    URL,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
  });
  const source = `${fs.readFileSync(filePath, "utf8")}\n${appendedSource}`;
  vm.runInContext(source, context, { filename: filePath });
  return {
    context,
    async send(data) {
      posted = undefined;
      await self.onmessage({ data });
      return posted;
    },
  };
}

function buildFareIndex(fareGroups, routes, fallbackFare) {
  const index = {};
  const defaults = {
    transferPolicy: "free-within-group",
    boardingCharge: 1.5,
    perKmRate: 0.15,
    fareCap: 6,
  };
  const groups = fareGroups?.length ? fareGroups : [{
    id: "fare-group-default",
    fareSystem: "flat",
    flatFare: fallbackFare,
    routeFares: {},
    routeIds: routes.filter((route) => route.tempParentId == null).map((route) => route.id),
  }];
  for (const group of groups) {
    const normalized = { ...defaults, ...group };
    for (const routeId of normalized.routeIds ?? []) {
      index[routeId] = {
        groupId: normalized.id,
        fareSystem: normalized.fareSystem,
        fare: normalized.fareSystem === "per-route"
          ? (normalized.routeFares?.[routeId] ?? normalized.flatFare)
          : normalized.flatFare,
        transferPolicy: normalized.transferPolicy,
        boardingCharge: normalized.boardingCharge,
        perKmRate: normalized.perKmRate,
        fareCap: normalized.fareCap,
      };
    }
  }
  for (const route of routes) {
    if (route.tempParentId != null && index[route.tempParentId]) index[route.id] = index[route.tempParentId];
  }
  return index;
}

function stationByNode(stations) {
  const result = new Map();
  for (const station of stations) {
    for (const nodeId of station.stNodeIds ?? []) result.set(nodeId, station);
  }
  return result;
}

function findRouteSplits(route, byNode) {
  const seenStationIds = new Set();
  const splits = [{ stNodeStartIndex: 0, stNodeEndIndex: null }];
  for (let index = 0; index < (route.stNodes?.length ?? 0); index += 1) {
    const station = byNode.get(route.stNodes[index]?.id);
    if (!station) continue;
    const current = splits.find((split) => split.stNodeEndIndex == null);
    if (!current) throw new Error(`No current split for route ${route.id}`);
    if (index === route.stNodes.length - 1) {
      current.stNodeEndIndex = index;
    } else if (seenStationIds.has(station.id)) {
      current.stNodeEndIndex = index - 1;
      splits.push({ stNodeStartIndex: index - 1, stNodeEndIndex: null });
      seenStationIds.clear();
      seenStationIds.add(station.id);
    } else seenStationIds.add(station.id);
  }
  return splits.filter((split) => split.stNodeEndIndex != null && split.stNodeEndIndex > split.stNodeStartIndex);
}

function validTimingCycle(timings) {
  const candidates = [null];
  const futureCount = Math.max(0, ...timings.map((timing) => timing.futureCycleDepartureTimes?.length ?? 0));
  for (let index = 0; index < futureCount; index += 1) candidates.push(index);
  for (const cycle of candidates) {
    const departures = timings.map((timing) => cycle == null
      ? (timing.adjustedExpectedDepartureTime ?? timing.expectedDepartureTime)
      : (timing.futureCycleDepartureTimes?.[Math.min(cycle, (timing.futureCycleDepartureTimes?.length ?? 1) - 1)]
        ?? timing.expectedDepartureTime));
    const arrivals = timings.map((timing) => {
      if (cycle == null) return timing.adjustedExpectedArrivalTime ?? timing.expectedArrivalTime;
      const future = timing.futureCycleArrivalTimes ?? [];
      const base = future[Math.min(cycle, future.length - 1)] ?? timing.expectedArrivalTime;
      return base + ((timing.adjustedExpectedArrivalTime ?? timing.expectedArrivalTime) - timing.expectedArrivalTime);
    });
    if (departures.every(Number.isFinite) && arrivals.every(Number.isFinite)
      && departures.slice(0, -1).every((departure, index) => arrivals[index + 1] >= departure)) {
      return { departures, arrivals };
    }
  }
  return null;
}

function convertToRaptor({ routes, stations, trains }) {
  const byNode = stationByNode(stations);
  const trainsByRoute = new Map();
  for (const train of trains) {
    const list = trainsByRoute.get(train.routeId) ?? [];
    list.push(train);
    trainsByRoute.set(train.routeId, list);
  }
  const stops = stations.filter((station) => station.stNodeIds?.length).map((station) => ({
    stationId: station.id,
    stationCoords: station.coords,
    stationType: station.stationType,
    nearbyStops: station.nearbyStations ?? [],
  }));
  const raptorRoutes = [];
  for (const route of routes) {
    if ((route.stNodes?.length ?? 0) < 2) continue;
    for (const split of findRouteSplits(route, byNode)) {
      const stopRows = [];
      const validIndices = new Set();
      for (let index = split.stNodeStartIndex; index <= split.stNodeEndIndex; index += 1) {
        const station = byNode.get(route.stNodes[index]?.id);
        if (!station) continue;
        validIndices.add(index);
        stopRows.push({ stationId: station.id, stationCoords: station.coords, stationType: station.stationType });
      }
      const trips = [];
      for (const train of trainsByRoute.get(route.id) ?? []) {
        if (!train.timings?.length) continue;
        const relevant = train.timings.filter((timing) => (
          timing.stNodeIndex >= split.stNodeStartIndex && timing.stNodeIndex <= split.stNodeEndIndex
        ));
        const timing = validTimingCycle(relevant);
        if (!timing) continue;
        const keep = relevant.map((row) => validIndices.has(row.stNodeIndex));
        const routeStopIndices = relevant.map((row) => row.stNodeIndex).filter((_, index) => keep[index]);
        const departureTimes = timing.departures.filter((_, index) => keep[index]);
        const arrivalTimes = timing.arrivals.filter((_, index) => keep[index]);
        if (departureTimes.length === stopRows.length) {
          trips.push({ trainId: train.id, routeStopIndices, departureTimes, arrivalTimes });
        }
        const futureCount = Math.min(1_000, ...relevant.map((row) => row.futureCycleDepartureTimes?.length ?? 0));
        for (let cycle = 0; cycle < futureCount; cycle += 1) {
          const futureArrivals = relevant.map((row) => {
            const base = row.futureCycleArrivalTimes?.[cycle] ?? row.expectedArrivalTime;
            return base + ((row.adjustedExpectedArrivalTime ?? row.expectedArrivalTime) - row.expectedArrivalTime);
          }).filter((_, index) => keep[index]);
          const futureDepartures = relevant.map((row) => {
            const base = row.futureCycleDepartureTimes?.[cycle] ?? row.expectedDepartureTime;
            return base + ((row.adjustedExpectedDepartureTime ?? row.expectedDepartureTime) - row.expectedDepartureTime);
          }).filter((_, index) => keep[index]);
          if (futureDepartures.length === stopRows.length) {
            trips.push({ trainId: train.id, routeStopIndices, departureTimes: futureDepartures, arrivalTimes: futureArrivals });
          }
        }
      }
      if (trips.length) raptorRoutes.push({
        raptorId: `${route.id}-${split.stNodeStartIndex}-${split.stNodeEndIndex}`,
        routeId: route.id,
        stops: stopRows,
        trips,
      });
    }
  }
  return { stops, raptorRoutes };
}

function addAmounts(target, source) {
  const entries = source instanceof Map ? source.entries() : Object.entries(source ?? {});
  for (const [key, rawAmount] of entries) {
    const amount = Number(rawAmount) || 0;
    if (amount) target[key] = (target[key] ?? 0) + amount;
  }
  return target;
}

function revenueFromJourneys(journeys, data) {
  let revenue = 0;
  const revenueByRoute = {};
  for (const { pop } of journeys ?? []) {
    const path = pop?.lastCommute?.transitPaths?.[0];
    const riders = pop?.lastCommute?.modeChoice?.transit ?? 0;
    const fare = path?.fareCost ?? data.transitCost;
    revenue += riders * fare;
    const quote = quoteJourneyFare({
      segments: path?.segments ?? [],
      fareGroups: data.fareGroups,
      routes: data.routes,
      legacyFare: data.transitCost,
      nativeFare: () => fare,
    });
    for (const [routeId, amount] of Object.entries(quote.revenueByRoute)) {
      revenueByRoute[routeId] = (revenueByRoute[routeId] ?? 0) + riders * amount * FARE_MULTIPLIER;
    }
  }
  return { revenue: revenue * FARE_MULTIPLIER, revenueByRoute };
}

async function runNativeSimulation({ save, simWorkerPath, commuteWorkerPath, hours }) {
  const data = structuredClone(save.data);
  const demand = decompressDemandData(data.compressedDemandData);
  const sim = createVmWorker(simWorkerPath, `
    const __radians = (degrees) => degrees * Math.PI / 180;
    const __distance = (left, right) => {
      const lat1 = __radians(left[1]);
      const lat2 = __radians(right[1]);
      const dLat = lat2 - lat1;
      const dLon = __radians(right[0] - left[0]);
      const value = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
      return 6371000 * 2 * Math.asin(Math.sqrt(value));
    };
    const __bearing = (left, right) => {
      const lat1 = __radians(left[1]);
      const lat2 = __radians(right[1]);
      const dLon = __radians(right[0] - left[0]);
      const y = Math.sin(dLon) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2)
        - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    };
    const __turnRadius = (p1, p2, p3, curveType) => {
      if (__distance(p1, p2) < 2 || __distance(p2, p3) < 2) return null;
      let angle = Math.abs(__bearing(p2, p3) - __bearing(p1, p2));
      if (angle > 180) angle = 360 - angle;
      if (angle < (curveType === 'cubic' ? 2 : 1)) return null;
      let radius = __distance(p1, p3) / 2 / Math.sin(__radians(angle / 2));
      if (curveType === 'cubic') radius *= 3;
      return Math.abs(radius);
    };
    const __smoothedRadii = (track, minTurnRadius, ranges) => {
      const raw = [];
      const totalLength = ranges.at(-1)?.end ?? 0;
      const transition = track.offsetTransitionZones;
      const inTransition = transition ? (index) => {
        const progress = index <= 0 ? 0 : (ranges[index - 1]?.end ?? totalLength);
        return (transition.start != null && progress <= transition.start)
          || (transition.end != null && progress >= totalLength - transition.end);
      } : null;
      for (let index = 0; index < track.coords.length - 2; index += 1) {
        const radius = __turnRadius(track.coords[index], track.coords[index + 1], track.coords[index + 2], track.curveType);
        const offset = inTransition && (inTransition(index) || inTransition(index + 1) || inTransition(index + 2));
        raw.push(radius != null && offset
          ? radius * RULES.OFFSET_TRANSITION_RADIUS_MULTIPLIER
          : radius);
      }
      const result = raw.map((_, index) => {
        const values = raw.slice(Math.max(0, index - 2), Math.min(raw.length, index + 3))
          .filter((value) => value != null);
        return Math.max(values.length ? Math.min(...values) : Infinity, minTurnRadius);
      });
      while (result.length < track.coords.length - 1) result.push(result.at(-1) ?? Infinity);
      return result.slice(0, track.coords.length - 1);
    };
    const __maxSpeed = (radius, slopePercentage, type, isStation) => {
      const stats = type.stats;
      const constrainedRadius = Math.max(radius ?? Infinity, stats.minTurnRadius);
      const cars = (stats.minCars + stats.maxCars) / 2;
      let speed = Math.sqrt(stats.maxLateralAcceleration * constrainedRadius)
        * Math.max(0.5, 1 - (stats.carLength * cars) / 200);
      if (isStation) speed *= 0.5;
      if (slopePercentage >= stats.maxSlopePercentage * 0.95) speed = Math.min(speed, stats.maxSpeed * 0.6);
      else if (slopePercentage >= stats.maxSlopePercentage * 0.8) speed = Math.min(speed, stats.maxSpeed * 0.75);
      else if (slopePercentage >= stats.maxSlopePercentage * 0.6) speed = Math.min(speed, stats.maxSpeed * 0.9);
      return Math.floor(Math.min(speed, stats.maxSpeed));
    };
    globalThis.__offlineTrackSpeeds = (tracks) => new Map(tracks.map((track) => {
      const type = getTrainType(track.trackType);
      let cap = track.type === 'station' ? type.stats.maxSpeedLocalStation : type.stats.maxSpeed;
      const ranges = [];
      let progress = 0;
      for (let index = 0; index < (track.coords?.length ?? 0) - 1; index += 1) {
        const length = __distance(track.coords[index], track.coords[index + 1]);
        ranges.push({ start: progress, end: progress + length });
        progress += length;
      }
      if (track.type === 'scissors-crossover') {
        cap = Math.min(type.stats.crossoverSpeed, cap);
        return [track.id, ranges.map((trackProgress) => ({ radius: Infinity, speedLimit: cap, trackProgress }))];
      }
      const totalLength = ranges.at(-1)?.end ?? 0;
      const slope = totalLength > 0 ? Math.abs((track.endElevation - track.startElevation) / totalLength * 100) : 0;
      const radii = track.coords.length === 2
        ? [Infinity]
        : __smoothedRadii(track, type.stats.minTurnRadius, ranges);
      const values = ranges.map((trackProgress, index) => ({
        radius: radii[index] ?? Infinity,
        speedLimit: Math.min(__maxSpeed(radii[index] ?? Infinity, slope, type, track.type === 'station'), cap),
        trackProgress,
      }));
      if (track.streetRunning) {
        for (const value of values) value.speedLimit = Math.min(value.speedLimit, track.streetRunning.speedLimitMps);
      }
      return [track.id, values];
    }));
  `);
  const commute = createVmWorker(commuteWorkerPath);
  const trackSpeedsMap = sim.context.__offlineTrackSpeeds(data.tracks);
  const state = {
    tracks: data.tracks,
    routes: data.routes,
    trains: data.trains,
    signals: data.signals,
    timeConfig: { ...data.timeConfig, paused: false, timeSpeed: "ultrafast", elapsedSeconds: data.elapsedSeconds },
    trackOccupationsMap: new Map(),
    layersToShow: { ...(data.layersToShow ?? {}), popMovements: false, trainWarnings: false, trainWarningExtras: false },
    popsMap: demand.popsMap,
    popMovementsMap: demand.popMovementsMap,
    stations: data.stations,
    trackSpeedsMap,
    allStationTrainPopMovements: allStationTrainMovements(demand.popMovementsMap, demand.popsMap),
    ownedTrainCount: data.ownedTrainCount ?? Math.max(data.trains.length, 100),
  };
  const fareIndex = buildFareIndex(data.fareGroups, data.routes, data.transitCost);
  const startSeconds = data.elapsedSeconds;
  const endSeconds = startSeconds + hours * SECONDS_PER_HOUR;
  const hourly = new Map();
  let first = true;
  let tickId = 0;
  let currentRoutes = data.routes;
  let currentTrains = data.trains;
  while (state.timeConfig.elapsedSeconds < endSeconds) {
    const tickStartSeconds = state.timeConfig.elapsedSeconds;
    const response = await sim.send({
      type: "tick",
      tickId: tickId += 1,
      ...(first ? { syncState: state } : {}),
      overrides: {
        timeConfig: state.timeConfig,
        layersToShow: state.layersToShow,
        ownedTrainCount: state.ownedTrainCount,
      },
    });
    first = false;
    if (response?.type === "tick-error") throw new Error(`Native worker tick failed: ${response.message}`);
    const result = response?.result;
    if (!result) throw new Error("Native worker returned no tick result");
    state.timeConfig = { ...state.timeConfig, elapsedSeconds: result.newElapsedSeconds };
    currentRoutes = result.newRoutes;
    currentTrains = result.newTrains;
    const hour = Math.floor((result.newElapsedSeconds - 0.001) / SECONDS_PER_HOUR);
    const row = hourly.get(hour) ?? {
      revenue: 0,
      expenses: 0,
      completedJourneys: 0,
      pathfinds: 0,
      simulatedSeconds: 0,
      revenueByRoute: {},
      expensesByRoute: {},
    };
    row.simulatedSeconds += result.newElapsedSeconds - tickStartSeconds;
    const journeyRevenue = revenueFromJourneys(result.completedJourneys, data);
    row.revenue += journeyRevenue.revenue;
    addAmounts(row.revenueByRoute, journeyRevenue.revenueByRoute);
    row.expenses += result.totalOperationalCosts ?? 0;
    addAmounts(row.expensesByRoute, result.operationalCostsByRoute);
    row.completedJourneys += result.completedJourneys?.length ?? 0;
    if (result.popsToStartJourney?.length) {
      const { stops, raptorRoutes } = convertToRaptor({
        routes: currentRoutes,
        stations: data.stations,
        trains: currentTrains,
      });
      const requestedPops = result.popsToStartJourney
        .map(({ popId }) => demand.popsMap.get(popId))
        .filter(Boolean);
      const pointIds = new Set(requestedPops.flatMap((pop) => [pop.residenceId, pop.jobId]));
      const commuteResponse = await commute.send({
        popCommutes: result.popsToStartJourney,
        pops: requestedPops,
        demandPoints: [...pointIds].map((id) => demand.points.get(id)).filter(Boolean),
        stops,
        raptorRoutes,
        elapsedSeconds: result.newElapsedSeconds,
        transitCost: data.transitCost,
        fareIndex,
        featureFlags: { driveToStationAccess: false },
      });
      for (const processed of commuteResponse?.processedPops ?? []) {
        demand.popsMap.set(processed.popId, processed.updatedPop);
        if (processed.popMovement) demand.popMovementsMap.set(processed.popId, processed.popMovement);
        else demand.popMovementsMap.delete(processed.popId);
      }
      row.pathfinds += commuteResponse?.processedPops?.length ?? 0;
      await sim.send({ type: "patch", patch: {
        popsMap: demand.popsMap,
        popMovementsMap: demand.popMovementsMap,
        allStationTrainPopMovements: allStationTrainMovements(demand.popMovementsMap, demand.popsMap),
      } });
    }
    hourly.set(hour, row);
  }
  return { startSeconds, endSeconds: state.timeConfig.elapsedSeconds, hourly };
}

function percentError(actual, projected) {
  if (!(Math.abs(actual) > 1e-9)) return projected === 0 ? 0 : null;
  return 100 * (projected - actual) / actual;
}

function loadWorld(modStatePath, save) {
  const state = JSON.parse(fs.readFileSync(modStatePath, "utf8"));
  return state[`world:${save.gameSessionId}`]
    ?? Object.values(state).find((entry) => entry?.worldId && entry?.tiles?.[save.cityCode]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const savePath = args.save ?? latestSave(args.saveDirectory ?? DEFAULT_SAVE_DIRECTORY, args.city);
  if (!savePath) throw new Error(`No save found${args.city ? ` for ${args.city}` : ""}`);
  const save = decodeMetroSave(savePath).mainSave;
  const modStatePath = args.modState ?? DEFAULT_MOD_STATE;
  const world = loadWorld(modStatePath, save);
  if (!world) throw new Error(`No open-world sidecar matches ${save.gameSessionId}/${save.cityCode}`);
  const bundleDirectory = path.resolve(args.bundleDirectory ?? DEFAULT_BUNDLE_DIRECTORY);
  const simWorkerPath = findBundle(bundleDirectory, "simEngine.worker-");
  const commuteWorkerPath = findBundle(bundleDirectory, "popCommuteWorker.worker-");
  const started = performance.now();
  const native = await runNativeSimulation({
    save,
    simWorkerPath,
    commuteWorkerPath,
    hours: args.hours,
  });
  const finance = world.backgroundNativeFinance;
  const financeNetworkHash = finance?.networkHash ?? null;
  const globalNetworkHash = world.globalNetwork?.hash ?? null;
  const revenueCacheCurrent = financeNetworkHash === globalNetworkHash;
  const expenseCacheCurrent = (finance?.expenseProfile?.networkHash ?? financeNetworkHash) === globalNetworkHash;
  const activeProjectionMatchesSave = world.activeProjection?.activeTileId === save.cityCode;
  const rows = [...native.hourly].sort(([left], [right]) => left - right).map(([absoluteHour, actual]) => {
    const hourOfDay = absoluteHour % 24;
    const cached = finance?.tileRevenueProfiles?.[save.cityCode]?.hourly?.[hourOfDay] ?? {};
    const projectedWorld = activeProjectionMatchesSave
      ? backgroundFinanceForHour({
        finance,
        activeTileId: save.cityCode,
        activeProjection: world.activeProjection,
        hour: hourOfDay,
      })
      : null;
    return {
      absoluteHour,
      hourOfDay,
      simulatedSeconds: actual.simulatedSeconds,
      comparableFullHour: actual.simulatedSeconds >= SECONDS_PER_HOUR - 24,
      nativeRevenue: Math.round(actual.revenue),
      nativeRevenueByRoute: Object.fromEntries(Object.entries(actual.revenueByRoute)
        .map(([routeId, amount]) => [routeId, Math.round(amount)])),
      cachedTileRevenue: Math.round(cached.revenue ?? 0),
      cachedTileRevenueByRoute: Object.fromEntries(Object.entries(cached.revenueByRoute ?? {})
        .map(([routeId, amount]) => [routeId, Math.round(amount)])),
      revenueErrorPct: percentError(actual.revenue, cached.revenue ?? 0),
      nativeTrainExpense: Math.round(actual.expenses),
      nativeExpensesByRoute: Object.fromEntries(Object.entries(actual.expensesByRoute)
        .map(([routeId, amount]) => [routeId, Math.round(amount)])),
      cachedOwnedRevenue: Math.round(cached.financeOwnedRevenue ?? 0),
      projectedWorldRevenue: projectedWorld ? Math.round(projectedWorld.revenue) : null,
      projectedWorldExpenses: projectedWorld ? Math.round(projectedWorld.expenses) : null,
      runtimeBackgroundRevenue: revenueCacheCurrent && projectedWorld
        ? Math.round(projectedWorld.revenue)
        : 0,
      runtimeBackgroundExpenses: expenseCacheCurrent && projectedWorld
        ? Math.round(projectedWorld.expenses)
        : 0,
      completedJourneys: actual.completedJourneys,
      pathfinds: actual.pathfinds,
    };
  });
  const comparableRows = rows.filter((row) => row.comparableFullHour);
  const totals = comparableRows.reduce((result, row) => ({
    nativeRevenue: result.nativeRevenue + row.nativeRevenue,
    cachedTileRevenue: result.cachedTileRevenue + row.cachedTileRevenue,
    nativeTrainExpense: result.nativeTrainExpense + row.nativeTrainExpense,
    projectedWorldRevenue: result.projectedWorldRevenue + (row.projectedWorldRevenue ?? 0),
    projectedWorldExpenses: result.projectedWorldExpenses + (row.projectedWorldExpenses ?? 0),
    runtimeBackgroundRevenue: result.runtimeBackgroundRevenue + row.runtimeBackgroundRevenue,
    runtimeBackgroundExpenses: result.runtimeBackgroundExpenses + row.runtimeBackgroundExpenses,
    completedJourneys: result.completedJourneys + row.completedJourneys,
    pathfinds: result.pathfinds + row.pathfinds,
  }), {
    nativeRevenue: 0,
    cachedTileRevenue: 0,
    nativeTrainExpense: 0,
    projectedWorldRevenue: 0,
    projectedWorldExpenses: 0,
    runtimeBackgroundRevenue: 0,
    runtimeBackgroundExpenses: 0,
    completedJourneys: 0,
    pathfinds: 0,
  });
  totals.revenueErrorPct = percentError(totals.nativeRevenue, totals.cachedTileRevenue);
  totals.comparableHours = comparableRows.length;
  totals.nativeRevenueByRoute = {};
  totals.cachedTileRevenueByRoute = {};
  totals.nativeExpensesByRoute = {};
  for (const row of comparableRows) {
    addAmounts(totals.nativeRevenueByRoute, row.nativeRevenueByRoute);
    addAmounts(totals.cachedTileRevenueByRoute, row.cachedTileRevenueByRoute);
    addAmounts(totals.nativeExpensesByRoute, row.nativeExpensesByRoute);
  }
  const result = {
    inputs: {
      savePath,
      saveId: save.id,
      cityCode: save.cityCode,
      gameSessionId: save.gameSessionId,
      saveTimestamp: save.timestamp,
      startElapsedSeconds: native.startSeconds,
      requestedHours: args.hours,
      simulatedSeconds: native.endSeconds - native.startSeconds,
      networkHash: finance?.networkHash ?? null,
      globalNetworkHash: world.globalNetwork?.hash ?? null,
      revenueCacheCurrent,
      expenseCacheCurrent,
      handoffBlackoutRisk: !revenueCacheCurrent
        && (world.activeProjection?.financeOwnedRouteIds?.length ?? 0) > 0,
      activeTileId: world.activeTileId,
      activeProjectionTileId: world.activeProjection?.activeTileId ?? null,
      activeProjectionMatchesSave,
      workerBundle: path.basename(simWorkerPath),
    },
    limitations: [
      "Track speed limits are regenerated from saved geometry with the shipped 1.6.0 curve, slope, station, crossover, and street-running rules.",
      "Runtime-only feature/rule overrides are not serialized in .metro saves; the replay uses shipped defaults.",
      "The first partial hour begins at the save timestamp and should not be compared as a full-hour sample.",
      "World projection totals are omitted when the saved active projection belongs to a different tile.",
    ],
    totals,
    rows,
    wallMilliseconds: Math.round(performance.now() - started),
  };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(JSON.stringify(result.inputs, null, 2));
    console.table(rows);
    console.log("Totals", totals, `wall=${result.wallMilliseconds}ms`);
    console.log("Limitations", result.limitations);
  }
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  }
}

await main();
