import { calculateCrossTileModeShares, createCrossTileRoutingCache, CROSS_ROUTING_CACHE_VERSION } from './cross-tile-mode-choice.js';
import { fareSegmentsFromStationRoutes, quoteJourneyFare } from './journey-fare.js';
import {
  calculateNativeRevenueProfile,
  createNativeTopologyFinancePolicy,
  deterministicNativeDepartureTimes,
} from './native-finance-model.js';

const EVALUATOR_SCHEMA_VERSION = 5;
const POP_FIELDS = Object.freeze([
  'id', 'mass', 'homeIndex', 'workIndex', 'gatewayIndex',
  'drivingSeconds', 'drivingDistance', 'homeDepartureTime', 'workDepartureTime',
]);

/**
 * Project evaluator input to the smallest structured-clone payload that keeps
 * fare calculation behavior identical. Native Ledger and topology fields are
 * deliberately excluded from this off-tile estimation seam.
 */
export function projectOffTileNativeDemandTransferInput(input) {
  const nativeState = input?.globalNativeState;
  if (!nativeState) return input;
  return {
    ...input,
    globalNativeState: {
      routes: (nativeState.routes ?? []).map((route) => ({
        id: route.id,
        tempParentId: route.tempParentId ?? null,
      })),
      fareGroups: (nativeState.fareGroups ?? []).map((group) => ({
        id: group.id,
        fareSystem: group.fareSystem,
        flatFare: group.flatFare,
        routeFares: group.routeFares,
        routeIds: group.routeIds,
        transferPolicy: group.transferPolicy,
        chargeOnInterGroupTransfer: group.chargeOnInterGroupTransfer,
        boardingCharge: group.boardingCharge,
        perKmRate: group.perKmRate,
        fareCap: group.fareCap,
      })),
    },
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function hashText(value) {
  let hash = 2_166_136_261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function demandFingerprint(demand) {
  let value = `${demand?.points?.length ?? 0}|${demand?.pops?.length ?? 0}`;
  for (const point of demand?.points ?? []) {
    value += `|${point?.id}:${point?.location?.[0]},${point?.location?.[1]}:${point?.residents ?? 0}:${point?.jobs ?? 0}`;
  }
  for (const pop of demand?.pops ?? []) {
    value += `|${pop?.id}:${pop?.size}:${pop?.residenceId}:${pop?.jobId}:${pop?.drivingSeconds}:${pop?.drivingDistance}`;
  }
  return hashText(value);
}

function scopedFarePolicy(farePolicy, network) {
  const routeIds = new Set((network?.routes ?? []).map((route) => String(route?.id)));
  const groups = (farePolicy?.fareGroups ?? []).filter((group) => {
    const groupRoutes = group?.routeIds ?? Object.keys(group?.routeFares ?? {});
    // A global/default group applies to every local route.  Otherwise a fare
    // edit only invalidates tiles carrying one of the group's routes.
    return !groupRoutes.length || groupRoutes.some((id) => routeIds.has(String(id)));
  });
  return {
    fare: farePolicy?.fare ?? 0,
    fareGroups: groups,
  };
}

function deterministicNetworkProfile(profile) {
  return {
    ...profile,
    routes: (profile?.routes ?? []).map((route) => ({
      ...route,
      serviceCount: route.configuredServiceCount ?? route.serviceCount ?? 0,
      departureAnchorsByNode: {},
    })),
  };
}

export function offTileNativeDemandContextKey({
  tileId,
  networkProfile,
  farePolicy = {},
  financeOwnedRouteIds = [],
}) {
  const network = deterministicNetworkProfile(networkProfile ?? {
    schemaVersion: 1, tileId, stations: [], routes: [], activeRouteIds: [], pathfindingRules: {},
    structuralSignature: `${tileId}:empty`,
  });
  const localRouteIds = new Set((network.routes ?? []).map((route) => String(route?.id)));
  return hashText(JSON.stringify(stableValue({
    routingVersion: CROSS_ROUTING_CACHE_VERSION,
    evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION,
    tileId,
    network: network.structuralSignature ?? network.signature ?? null,
    pathfindingRules: network.pathfindingRules ?? {},
    farePolicy: scopedFarePolicy(farePolicy, network),
    financeOwnedRouteIds: [...financeOwnedRouteIds]
      .map(String).filter((routeId) => localRouteIds.has(routeId)).sort(),
  })));
}

function normalizeDemand(tileId, demand, preserveDepartures = false) {
  const pointIndex = new Map();
  const points = [];
  for (const point of demand?.points ?? []) {
    if (!point?.id || !Array.isArray(point.location) || point.location.length < 2) continue;
    pointIndex.set(String(point.id), points.length);
    points.push([
      String(point.id), Number(point.location[0]), Number(point.location[1]), tileId,
      Number(point.residents) || 0, Number(point.jobs) || 0,
    ]);
  }
  const pops = [];
  const sourceById = new Map();
  let skippedPops = 0;
  for (const pop of demand?.pops ?? []) {
    const homeIndex = pointIndex.get(String(pop?.residenceId));
    const workIndex = pointIndex.get(String(pop?.jobId));
    const mass = Number(pop?.size);
    if (!pop?.id || homeIndex == null || workIndex == null || !(mass > 0)) {
      skippedPops++;
      continue;
    }
    const departures = deterministicNativeDepartureTimes(pop.id);
    if (preserveDepartures) {
      for (const key of ['homeDepartureTime', 'workDepartureTime']) {
        if (Number.isFinite(pop[key])) departures[key] = pop[key];
      }
    }
    pops.push([
      String(pop.id), mass, homeIndex, workIndex, 0,
      Number(pop.drivingSeconds), Number(pop.drivingDistance),
      departures.homeDepartureTime, departures.workDepartureTime,
    ]);
    sourceById.set(String(pop.id), { ...pop, ...departures });
  }
  return {
    demand: {
      schemaVersion: 1,
      tileId,
      gateways: ['local'],
      points,
      pops,
      popFields: POP_FIELDS,
      drivingModel: { provider: 'packaged-native-demand', label: 'build-time road router' },
    },
    sourceById,
    skippedPops,
  };
}

function modeTotals(popModeChoices) {
  const totals = { driving: 0, walking: 0, transit: 0, unknown: 0 };
  for (const modes of Object.values(popModeChoices ?? {})) {
    for (const mode of Object.keys(totals)) totals[mode] += Number(modes?.[mode]) || 0;
  }
  return totals;
}

function fareQuoteFor({ stationRoutes, stationById, farePolicy, globalNativeState }) {
  const segments = fareSegmentsFromStationRoutes(stationRoutes, stationById);
  return quoteJourneyFare({
    segments,
    fareGroups: globalNativeState?.fareGroups?.length
      ? globalNativeState.fareGroups
      : farePolicy?.fareGroups ?? [],
    routes: globalNativeState?.routes ?? [],
    legacyFare: Number(farePolicy?.fare) || 0,
  });
}

function syntheticNativePops(calculated, sourceById, returnCalculated) {
  if (returnCalculated) {
    const outward = new Map(syntheticNativePops(calculated, sourceById).map(pop => [pop.id, pop]));
    const homeward = new Map(syntheticNativePops(returnCalculated, sourceById).map(pop => [pop.id, pop]));
    return [...new Set([...outward.keys(), ...homeward.keys()])].map(id => ({
      id,
      homeDepartureTime: sourceById.get(id)?.homeDepartureTime,
      workDepartureTime: sourceById.get(id)?.workDepartureTime,
      commutes: {
        homeToWork: outward.get(id)?.commutes.homeToWork ?? {modeChoice:{transit:0}},
        workToHome: homeward.get(id)?.commutes.workToHome ?? {modeChoice:{transit:0}},
      },
    }));
  }
  const journeys = [...calculated.transitJourneys.values()].flat();
  return journeys.map((journey) => {
    const source = sourceById.get(String(journey.popId)) ?? {};
    const commute = {
      modeChoice: calculated.popModeChoices[journey.popId] ?? { transit: journey.transitMass },
      transitCost: journey.fare,
      transitTime: journey.totalClockSeconds,
      transitPaths: [{
        fareCost: journey.fare,
        segments: journey.stationRoutes.map(({ routeId, stationIds }) => ({ routeId, stationIds })),
      }],
    };
    return {
      id: journey.popId,
      homeDepartureTime: source.homeDepartureTime,
      workDepartureTime: source.workDepartureTime,
      commutes: {
        homeToWork: structuredClone(commute),
        workToHome: structuredClone(commute),
      },
      lastCommute: { ...structuredClone(commute), direction: 'workToHome', origin: 'work' },
    };
  });
}

function ridershipByRoute(calculated) {
  const result = {};
  for (const journey of [...calculated.transitJourneys.values()].flat()) {
    for (const routeId of new Set(journey.stationRoutes.map((entry) => entry.routeId).filter(Boolean))) {
      result[routeId] = (result[routeId] ?? 0) + journey.transitMass;
    }
  }
  return result;
}

/**
 * Evaluate one installed tile's native demand without adopting that tile into
 * Subway Builder's singleton store. The result is compact and cacheable.
 */
export function evaluateOffTileNativeDemand({
  worldId,
  routingCache = createCrossTileRoutingCache(),
  tileId,
  demand,
  networkProfile,
  farePolicy = {},
  globalNativeState = null,
  financeOwnedRouteIds = [],
  existingProfile = null,
  includeAssignments = false,
}) {
  if (!tileId) throw new Error('Off-tile native demand requires a tile id');
  if (!Array.isArray(demand?.points) || !Array.isArray(demand?.pops)) {
    throw new Error(`Invalid native demand package: ${tileId}`);
  }
  const network = deterministicNetworkProfile(networkProfile ?? {
    schemaVersion: 1, tileId, stations: [], routes: [], activeRouteIds: [], pathfindingRules: {},
    structuralSignature: `${tileId}:empty`,
  });
  const contextKey = offTileNativeDemandContextKey({
    tileId, networkProfile: network, farePolicy, financeOwnedRouteIds,
  });
  const evaluationKey = hashText(JSON.stringify(stableValue({
    contextKey,
    demand: demandFingerprint(demand),
  })));
  if (!includeAssignments && existingProfile?.source === 'off-tile-estimator'
    && existingProfile?.evaluationKey === evaluationKey) {
    return { status: 'cached', profile: structuredClone(existingProfile) };
  }

  const normalized = normalizeDemand(tileId, demand, includeAssignments);
  const evaluateDirection = crossDemand => calculateCrossTileModeShares({
    worldId, routingCache,
    includeJourneyDetails: includeAssignments,
    crossDemand,
    networkProfiles: { [tileId]: network },
    gatewayCatalog: {},
    fare: Number(farePolicy?.fare) || 0,
    journeyFare: (stationRoutes, stationById) => fareQuoteFor({
      stationRoutes, stationById, farePolicy, globalNativeState,
    }),
  });
  const calculated = evaluateDirection(normalized.demand);
  // Native 1.7 permits driving to the first station in either direction but
  // never driving from the final station. Reusing the outward choice for the
  // return journey invents riders when the home is beyond walking catchment.
  const returnCalculated = evaluateDirection({ ...normalized.demand,
    pops: normalized.demand.pops.map(([id,mass,home,work,gateway,seconds,distance,hd,wd]) =>
      [id,mass,work,home,gateway,seconds,distance,wd,hd]),
  });
  const revenue = calculateNativeRevenueProfile(
    syntheticNativePops(calculated, normalized.sourceById, returnCalculated),
    {
      financeOwnedRouteIds,
      fareGroups: globalNativeState?.fareGroups ?? farePolicy?.fareGroups ?? [],
      routes: globalNativeState?.routes ?? [],
      legacyFare: Number(farePolicy?.fare) || 0,
    },
  );
  const profile = {
    ...revenue,
    tileId,
    source: 'off-tile-estimator',
    evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION,
    contextKey,
    evaluationKey,
    networkSignature: network.structuralSignature ?? network.signature ?? null,
    evaluatedPops: calculated.evaluatedPops,
    skippedPops: normalized.skippedPops,
    transitViablePops: calculated.transitViablePops,
    modeChoicePopulation: modeTotals(calculated.popModeChoices),
    ridershipByRoute: ridershipByRoute(calculated),
    routingStats: calculated.routingStats,
    accountingOwnership: createNativeTopologyFinancePolicy(),
  };
  return { status: 'evaluated', profile,
    ...(includeAssignments ? { assignments: nativeDemandAssignments(demand, normalized.sourceById, calculated, returnCalculated) } : {}),
  };
}

// Native demand cards and map highlights consume these fields directly. Keep
// both directions, including walking/driving-only pops and access/transfer legs.
function nativeDemandAssignments(demand, sources, outward, homeward) {
  const points = new Map(demand.points.map(point => [String(point.id), point.location]));
  return demand.pops.map(pop => {
    const source = sources.get(String(pop.id)) ?? pop;
    const commutes = {};
    for (const [direction, result] of [['homeToWork', outward], ['workToHome', homeward]]) {
      const home = direction === 'homeToWork';
      const origin = points.get(String(home ? pop.residenceId : pop.jobId));
      const destination = points.get(String(home ? pop.jobId : pop.residenceId));
      const leg = result.journeyDetails?.[pop.id];
      const choiceInputs = result.choiceInputs?.[pop.id];
      const departure = source[home ? 'homeDepartureTime' : 'workDepartureTime'] ?? 0;
      const segments = [];
      for (const segment of leg?.segments ?? []) {
        const previous = segments.at(-1);
        if (previous && !segment.isWalking && !segment.isDriving && previous.routeId === segment.routeId
          && previous.toStopId === segment.fromStopId) {
          previous.toStopId = segment.toStopId;
          previous.toStopCoords = segment.toStopCoords;
          previous.arrivalTime = segment.arrivalTime;
          previous.stationIds.push(segment.toStopId);
        } else segments.push({ ...segment, stationIds: [segment.fromStopId, segment.toStopId] });
      }
      if (segments.length) {
        const first = segments[0], last = segments.at(-1);
        const access = leg.accessDriveSeconds || leg.accessWalkSeconds;
        segments.unshift({ routeId: leg.accessDriveSeconds ? 'driving' : 'walking',
          fromStopId: 'origin', toStopId: first.fromStopId,
          fromStopCoords: origin, toStopCoords: first.fromStopCoords,
          departureTime: departure, arrivalTime: departure + access,
          isWalking: !leg.accessDriveSeconds, isDriving: Boolean(leg.accessDriveSeconds) });
        segments.push({ routeId: 'walking', fromStopId: last.toStopId, toStopId: 'destination',
          fromStopCoords: last.toStopCoords, toStopCoords: destination,
          departureTime: last.arrivalTime, arrivalTime: last.arrivalTime + leg.egressWalkSeconds,
          isWalking: true, isDriving: false });
      }
      commutes[direction] = {
        modeChoice: result.popModeChoices[pop.id] ?? { walking: 0, driving: 0, transit: 0, unknown: pop.size },
        walking: { time: choiceInputs?.walkingTime ?? 0, distance: choiceInputs?.walkingDistance ?? 0 },
        transitTime: leg?.totalSeconds ?? null, transitCost: leg?.fare ?? null,
        drivingTimeMultiplier: choiceInputs?.drivingTimeMultiplier ?? 1,
        transitPaths: segments.length ? [{ segments, totalTime: leg.totalClockSeconds,
          perceivedTime: leg.totalSeconds, fareCost: leg.fare,
          transfers: Math.max(0, leg.stationRoutes.length - 1),
          timeBreakdown: { inVehicle: leg.networkSeconds, walk: leg.accessWalkSeconds + leg.transferWalkSeconds + leg.egressWalkSeconds,
            drive: leg.accessDriveSeconds, wait: leg.waitSeconds, departureShift: leg.departureShiftSeconds },
        }] : [],
      };
    }
    return { id: pop.id, homeDepartureTime: source.homeDepartureTime, workDepartureTime: source.workDepartureTime, commutes };
  });
}

export function isCurrentOffTileNativeDemandProfile(profile) {
  return profile?.source === 'off-tile-estimator'
    && profile?.evaluatorSchemaVersion === EVALUATOR_SCHEMA_VERSION
    && typeof profile?.contextKey === 'string'
    && profile.contextKey.length > 0
    && typeof profile?.evaluationKey === 'string'
    && profile.evaluationKey.length > 0;
}
