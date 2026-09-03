import { calculateCrossTileModeShares } from './cross-tile-mode-choice.js';
import { fareSegmentsFromStationRoutes, quoteJourneyFare } from './journey-fare.js';
import {
  calculateNativeRevenueProfile,
  createNativeTopologyFinancePolicy,
  deterministicNativeDepartureTimes,
} from './native-finance-model.js';

const EVALUATOR_SCHEMA_VERSION = 3;
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
    evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION,
    tileId,
    network: network.structuralSignature ?? network.signature ?? null,
    farePolicy: scopedFarePolicy(farePolicy, network),
    financeOwnedRouteIds: [...financeOwnedRouteIds]
      .map(String).filter((routeId) => localRouteIds.has(routeId)).sort(),
  })));
}

function normalizeDemand(tileId, demand) {
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

function syntheticNativePops(calculated, sourceById) {
  const journeys = [...calculated.transitJourneys.values()].flat();
  return journeys.map((journey) => {
    const source = sourceById.get(String(journey.popId)) ?? {};
    const commute = {
      modeChoice: calculated.popModeChoices[journey.popId] ?? { transit: journey.transitMass },
      transitCost: journey.fare,
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
  tileId,
  demand,
  networkProfile,
  farePolicy = {},
  globalNativeState = null,
  financeOwnedRouteIds = [],
  existingProfile = null,
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
  if (existingProfile?.source === 'off-tile-estimator'
    && existingProfile?.evaluationKey === evaluationKey) {
    return { status: 'cached', profile: structuredClone(existingProfile) };
  }

  const normalized = normalizeDemand(tileId, demand);
  const calculated = calculateCrossTileModeShares({
    crossDemand: normalized.demand,
    networkProfiles: { [tileId]: network },
    gatewayCatalog: {},
    fare: Number(farePolicy?.fare) || 0,
    journeyFare: (stationRoutes, stationById) => fareQuoteFor({
      stationRoutes, stationById, farePolicy, globalNativeState,
    }),
  });
  const revenue = calculateNativeRevenueProfile(
    syntheticNativePops(calculated, normalized.sourceById),
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
  return { status: 'evaluated', profile };
}

export function isCurrentOffTileNativeDemandProfile(profile) {
  return profile?.source === 'off-tile-estimator'
    && profile?.evaluatorSchemaVersion === EVALUATOR_SCHEMA_VERSION
    && typeof profile?.contextKey === 'string'
    && profile.contextKey.length > 0
    && typeof profile?.evaluationKey === 'string'
    && profile.evaluationKey.length > 0;
}
