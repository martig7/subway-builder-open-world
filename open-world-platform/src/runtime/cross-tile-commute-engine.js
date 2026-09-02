const DEFAULT_GATEWAY_CAPACITY_PER_HOUR = 10_000;
const MORNING_DEPARTURE_HOUR = 7;
const EVENING_DEPARTURE_HOUR = 17;
// Subway Builder 1.6 annualizes each representative daily fare before posting
// it to the wallet and route ledger (RULES.FARE_MULTIPLIER.default).
const NATIVE_FARE_MULTIPLIER = 365;
const COMMUTE_LEDGER_SCHEMA_VERSION = 2;

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`);
  return value;
}
function roundedMoney(value) { return Math.round(value * 100) / 100; }

function eventMass(events) {
  return events.reduce((total, event) => total + event.mass, 0);
}

function baselineModeChoice(mass) {
  return { driving: mass, walking: 0, transit: 0, unknown: 0 };
}

function compileSettlementTemplate(entry) {
  const flowMass = entry.flow.mass;
  const transitShare = flowMass > 0 ? (entry.modeChoice?.transit ?? 0) / flowMass : 0;
  const routeRevenueWeightByRoute = {};
  const journeys = [];
  let quotedTransitShare = 0;
  let farePerDispatchedMass = 0;
  for (const journey of entry.transitJourneys ?? []) {
    const sizePerDispatchedMass = flowMass > 0 ? (journey.transitMass ?? 0) / flowMass : 0;
    if (!(sizePerDispatchedMass > 0)) continue;
    const stationRoutes = structuredClone(journey.stationRoutes ?? []);
    const routeIds = [...new Set(stationRoutes.map(({ routeId }) => routeId).filter(Boolean))];
    if (routeIds.length === 0) continue;
    const fare = Number.isFinite(journey.fare) && journey.fare >= 0 ? journey.fare : null;
    const quotedRevenue = journey.revenueByRoute && typeof journey.revenueByRoute === 'object'
      ? structuredClone(journey.revenueByRoute)
      : null;
    const revenueByRoute = quotedRevenue ?? Object.fromEntries(routeIds.map((routeId) => [
      routeId, fare == null ? 0 : fare / routeIds.length,
    ]));
    if (fare != null) {
      quotedTransitShare += sizePerDispatchedMass;
      farePerDispatchedMass += sizePerDispatchedMass * fare;
    }
    for (const [routeId, routeFare] of Object.entries(revenueByRoute)) {
      if (!Number.isFinite(routeFare) || routeFare < 0) throw new Error(`Invalid journey route fare: ${routeId}`);
      routeRevenueWeightByRoute[routeId] = roundedMoney((routeRevenueWeightByRoute[routeId] ?? 0)
        + sizePerDispatchedMass * routeFare);
    }
    journeys.push({
      popId: journey.popId,
      totalClockSeconds: journey.totalClockSeconds,
      stationRoutes,
      sizePerDispatchedMass,
      fare,
      revenueByRoute,
    });
  }
  return {
    sourceTransitMass: entry.modeChoice?.transit ?? 0,
    sourceJourneyCount: entry.transitJourneys?.length ?? 0,
    transitShare,
    quotedTransitShare,
    farePerDispatchedMass,
    routeRevenueWeightByRoute,
    journeys,
  };
}

function settlementTemplateFor(entry) {
  const template = entry.settlementTemplate;
  if (!template
    || template.sourceTransitMass !== (entry.modeChoice?.transit ?? 0)
    || template.sourceJourneyCount !== (entry.transitJourneys?.length ?? 0)) {
    entry.settlementTemplate = compileSettlementTemplate(entry);
  }
  return entry.settlementTemplate;
}

function migrateModeChoice(modeChoice, mass) {
  if (!modeChoice) return baselineModeChoice(mass);
  const known = (modeChoice.driving ?? 0) + (modeChoice.walking ?? 0) + (modeChoice.transit ?? 0);
  // Schema-v1 worlds initially marked every cross-tile trip unknown forever.
  // Until a real cross-tile transit path is observed, driving is the only
  // complete door-to-door mode implemented by the aggregate simulator.
  if (!(known > 0) && (modeChoice.unknown ?? 0) > 0) return baselineModeChoice(mass);
  return modeChoice;
}

function normalizeFlow(raw) {
  const homeTileId = raw.homeTileId ?? raw.home_tile ?? raw.originTileId;
  const workTileId = raw.workTileId ?? raw.work_tile ?? raw.destinationTileId;
  const gatewayId = raw.gatewayId ?? raw.gateway_id;
  const mass = finiteNonNegative(Number(raw.mass), `flow mass: ${raw.id}`);
  const travelValue = raw.travelHours ?? raw.travel_hours ?? ((raw.travelSeconds ?? raw.defaultTravelSeconds) != null
    ? Number(raw.travelSeconds ?? raw.defaultTravelSeconds) / 3600
    : 1);
  const travelHours = Math.max(1, Math.ceil(Number(travelValue)));
  if (!raw.id || !homeTileId || !workTileId || !gatewayId || !Number.isFinite(travelHours)) {
    throw new Error(`Invalid cross-tile commute flow: ${raw.id ?? '<unnamed>'}`);
  }
  return { id: raw.id, homeTileId, workTileId, gatewayId, mass, travelHours };
}

export function createCommuteEntry(rawFlow) {
  const flow = normalizeFlow(rawFlow);
  const entry = {
    flow,
    atHome: flow.mass,
    queuedToWork: 0,
    toWork: [],
    atWork: 0,
    queuedToHome: 0,
    toHome: [],
    // Counts matching Subway Builder's modeChoice shape. The aggregate model
    // currently has a complete driving path but no cross-tile subway path.
    modeChoice: baselineModeChoice(flow.mass),
    transitJourneys: [],
    transitTrips: 0,
    fareRevenue: 0,
  };
  entry.settlementTemplate = compileSettlementTemplate(entry);
  return entry;
}

function migrateEntry(entry) {
  if (entry?.flow) {
    const migrated = {
    ...entry,
    modeChoice: migrateModeChoice(entry.modeChoice, entry.flow.mass),
    transitJourneys: Array.isArray(entry.transitJourneys) ? entry.transitJourneys : [],
    transitTrips: finiteNonNegative(entry.transitTrips ?? 0, `transit trips: ${entry.flow.id}`),
    fareRevenue: finiteNonNegative(entry.fareRevenue ?? 0, `fare revenue: ${entry.flow.id}`),
    };
    migrated.settlementTemplate = compileSettlementTemplate(migrated);
    return migrated;
  }
  if (!entry?.cohort) throw new Error('Invalid legacy commute ledger entry');
  const flow = normalizeFlow(entry.cohort);
  const migrated = {
    flow,
    atHome: entry.originPending ?? 0,
    queuedToWork: 0,
    toWork: (entry.inTransit ?? []).map((event) => ({
      mass: event.mass,
      departureHour: event.departureHour ?? event.departureTime,
      arrivalHour: event.arrivalHour ?? event.arrivalTime,
    })),
    atWork: entry.destinationPending ?? 0,
    queuedToHome: 0,
    toHome: [],
    modeChoice: migrateModeChoice(entry.modeChoice, flow.mass),
    transitJourneys: [],
    transitTrips: 0,
    fareRevenue: 0,
  };
  migrated.settlementTemplate = compileSettlementTemplate(migrated);
  return migrated;
}

function normalizeCatalog(rawCatalog) {
  if (!rawCatalog) return null;
  const flows = rawCatalog.flows ?? rawCatalog.buckets ?? rawCatalog.crossCommutes ?? rawCatalog.cross_commutes ?? [];
  if (!Array.isArray(flows)) throw new Error('Invalid cross-tile commute catalog');
  const gateways = Object.fromEntries((rawCatalog.gateways ?? []).map((gateway) => [gateway.id, { ...gateway }]));
  for (const flow of flows) {
    const gateway = gateways[flow.gatewayId] ??= { id: flow.gatewayId };
    gateway.capacityPerHour ??= finiteNonNegative(Number(flow.capacityPerHour ?? flow.defaultCapacityPerHour ?? DEFAULT_GATEWAY_CAPACITY_PER_HOUR), `gateway capacity: ${flow.gatewayId}`);
  }
  for (const gateway of Object.values(gateways)) {
    gateway.capacityPerHour = finiteNonNegative(Number(gateway.capacityPerHour ?? gateway.capacity_per_hour ?? DEFAULT_GATEWAY_CAPACITY_PER_HOUR), `gateway capacity: ${gateway.id}`);
  }
  const normalizedFlows = flows.map(normalizeFlow).sort((a, b) => a.id.localeCompare(b.id));
  return {
    buildHash: rawCatalog.buildHash ?? rawCatalog.build_hash ?? `commute-v1:${normalizedFlows.map((flow) => `${flow.id}:${flow.mass}`).join('|')}`,
    flows: normalizedFlows,
    gateways,
  };
}

/**
 * Installs a compact package catalog. A changed build hash intentionally resets
 * only aggregate commute positions; native tile saves remain untouched.
 */
export function registerCommuteCatalog(world, rawCatalog) {
  const catalog = normalizeCatalog(rawCatalog);
  if (!catalog || catalog.flows.length === 0) return false;
  if (world.commuteCatalogBuildHash !== catalog.buildHash) {
    world.gatewayLedger = Object.fromEntries(catalog.flows.map((flow) => [flow.id, createCommuteEntry(flow)]));
    world.crossPopModeChoices = {};
    world.commuteLastProcessedHour = 0;
    world.commuteNextActivityHour = null;
    world.commuteCatalogBuildHash = catalog.buildHash;
  } else {
    const known = new Set(catalog.flows.map((flow) => flow.id));
    for (const id of Object.keys(world.gatewayLedger)) if (!known.has(id)) delete world.gatewayLedger[id];
    for (const flow of catalog.flows) {
      const entry = world.gatewayLedger[flow.id];
      world.gatewayLedger[flow.id] = entry ? { ...migrateEntry(entry), flow } : createCommuteEntry(flow);
    }
  }
  world.gatewayCatalog = catalog.gateways;
  world.commuteNextActivityHour = nextActivityHour(world, world.commuteLastProcessedHour);
  return true;
}

export function migrateCommuteLedger(world) {
  world.gatewayLedger ??= {};
  if (world.commuteLedgerSchemaVersion !== COMMUTE_LEDGER_SCHEMA_VERSION) {
    for (const [id, entry] of Object.entries(world.gatewayLedger)) world.gatewayLedger[id] = migrateEntry(entry);
    world.commuteLedgerSchemaVersion = COMMUTE_LEDGER_SCHEMA_VERSION;
  }
  world.commuteLastProcessedHour ??= world.worldTime ?? 0;
  world.gatewayCatalog ??= {};
  world.crossPopModeChoices ??= {};
  world.crossTileFinancials ??= { transitTrips: 0, fareRevenue: 0, pendingNativeRevenue: 0 };
  world.crossTileFinancials.transitTrips = finiteNonNegative(world.crossTileFinancials.transitTrips ?? 0, 'cross-tile transit trips');
  world.crossTileFinancials.fareRevenue = finiteNonNegative(world.crossTileFinancials.fareRevenue ?? 0, 'cross-tile fare revenue');
  world.crossTileFinancials.pendingNativeRevenue = finiteNonNegative(world.crossTileFinancials.pendingNativeRevenue ?? 0, 'pending native fare revenue');
  world.pendingCrossTileAttribution ??= { revenueByRoute: {}, completedCommutes: [] };
  world.pendingCrossTileAttribution.revenueByRoute ??= {};
  world.pendingCrossTileAttribution.completedCommutes ??= [];
  if (!Number.isSafeInteger(world.commuteNextActivityHour)
    || world.commuteNextActivityHour <= world.commuteLastProcessedHour) {
    world.commuteNextActivityHour = nextActivityHour(world, world.commuteLastProcessedHour);
  }
  return world;
}

export function assertCommuteLedger(world) {
  for (const [id, rawEntry] of Object.entries(world.gatewayLedger ?? {})) {
    const entry = migrateEntry(rawEntry);
    const positions = [entry.atHome, entry.queuedToWork, entry.atWork, entry.queuedToHome];
    const events = [...entry.toWork, ...entry.toHome];
    positions.forEach((value) => finiteNonNegative(value, `commute balance: ${id}`));
    events.forEach((event) => finiteNonNegative(event.mass, `commute event mass: ${id}`));
    const total = positions.reduce((sum, value) => sum + value, 0) + eventMass(events);
    if (Math.abs(total - entry.flow.mass) > 1e-9) throw new Error(`Gateway mass is not conserved for flow ${id}`);
    const modeTotal = Object.values(entry.modeChoice ?? {}).reduce((sum, value) => sum + finiteNonNegative(value, `mode share: ${id}`), 0);
    if (Math.abs(modeTotal - entry.flow.mass) > 1e-9) throw new Error(`Mode-share mass is not conserved for flow ${id}`);
    finiteNonNegative(entry.transitTrips ?? 0, `transit trips: ${id}`);
    finiteNonNegative(entry.fareRevenue ?? 0, `fare revenue: ${id}`);
  }
  finiteNonNegative(world.crossTileFinancials?.transitTrips ?? 0, 'cross-tile transit trips');
  finiteNonNegative(world.crossTileFinancials?.fareRevenue ?? 0, 'cross-tile fare revenue');
  finiteNonNegative(world.crossTileFinancials?.pendingNativeRevenue ?? 0, 'pending native fare revenue');
  for (const [popId, modes] of Object.entries(world.crossPopModeChoices ?? {})) {
    const total = ['driving', 'walking', 'transit', 'unknown']
      .reduce((sum, mode) => sum + finiteNonNegative(modes?.[mode] ?? 0, `pop mode share: ${popId}`), 0);
    if (!(total > 0)) throw new Error(`Empty pop mode share: ${popId}`);
  }
  return world;
}

export function applyModeShares(world, totals, {
  day = null,
  reason = 'manual',
  evaluatedPops = 0,
  transitViablePops = 0,
  popModeChoices = {},
  transitJourneys = new Map(),
  contextKey = null,
} = {}) {
  migrateCommuteLedger(world);
  let changedFlows = 0;
  for (const entry of Object.values(world.gatewayLedger)) {
    const key = `${entry.flow.homeTileId}|${entry.flow.workTileId}|${entry.flow.gatewayId}`;
    const next = totals.get(key);
    if (!next) continue;
    const modeTotal = Object.values(next).reduce((sum, value) => sum + value, 0);
    // Demand masses and mode shares are decimal estimates. Requiring bit-for-bit
    // equality rejects valid totals after ordinary IEEE-754 arithmetic (for
    // example, a 13,125-person flow can differ by ~1e-12 after splitting).
    if (Math.abs(modeTotal - entry.flow.mass) > 1e-9) {
      throw new Error(`Calculated mode share does not conserve flow ${entry.flow.id}`);
    }
    if (JSON.stringify(entry.modeChoice) !== JSON.stringify(next)) changedFlows++;
    entry.modeChoice = { ...next };
    entry.transitJourneys = structuredClone(transitJourneys.get(key) ?? []);
    entry.settlementTemplate = compileSettlementTemplate(entry);
  }
  world.crossPopModeChoices = Object.fromEntries(
    Object.entries(popModeChoices).map(([popId, modes]) => [popId, { ...modes }]),
  );
  world.crossModeShare = {
    schemaVersion: 2,
    contextKey,
    day,
    reason,
    calculatedAtHour: world.worldTime,
    evaluatedPops,
    transitViablePops,
    changedFlows,
    revision: (world.crossModeShare?.revision ?? 0) + 1,
  };
  assertCommuteLedger(world);
  return world.crossModeShare;
}

function processArrivals(entries, hour) {
  for (const entry of entries) {
    const workRemaining = [];
    for (const event of entry.toWork) {
      if (event.arrivalHour <= hour) entry.atWork += event.mass;
      else workRemaining.push(event);
    }
    entry.toWork = workRemaining;
    const homeRemaining = [];
    for (const event of entry.toHome) {
      if (event.arrivalHour <= hour) entry.atHome += event.mass;
      else homeRemaining.push(event);
    }
    entry.toHome = homeRemaining;
  }
}

function gatewayCapacity(world, gatewayId) {
  return world.gatewayCatalog?.[gatewayId]?.capacityPerHour ?? DEFAULT_GATEWAY_CAPACITY_PER_HOUR;
}

function reversedStationRoutes(stationRoutes) {
  return [...stationRoutes].reverse().map((segment) => ({
    routeId: segment.routeId,
    stationIds: [...segment.stationIds].reverse(),
  }));
}

function creditFareRevenue(world, entry, dispatchedMass, direction, hour) {
  const legacyFare = finiteNonNegative(Number(world.farePolicy?.fare ?? 0), 'cross-tile fare');
  const template = settlementTemplateFor(entry);
  const transitMass = dispatchedMass * template.transitShare;
  const unquotedTransitShare = Math.max(0, template.transitShare - template.quotedTransitShare);
  const fareRevenue = roundedMoney(dispatchedMass
    * (template.farePerDispatchedMass + unquotedTransitShare * legacyFare)
    * NATIVE_FARE_MULTIPLIER);
  if (!Number.isFinite(world.wallet)) throw new Error('Invalid world wallet');
  entry.transitTrips += transitMass;
  entry.fareRevenue += fareRevenue;
  world.crossTileFinancials.transitTrips += transitMass;
  world.crossTileFinancials.fareRevenue += fareRevenue;
  world.crossTileFinancials.pendingNativeRevenue += fareRevenue;
  const pending = world.pendingCrossTileAttribution;
  for (const [routeId, weight] of Object.entries(template.routeRevenueWeightByRoute)) {
    pending.revenueByRoute[routeId] = (pending.revenueByRoute[routeId] ?? 0)
      + roundedMoney(dispatchedMass * weight * NATIVE_FARE_MULTIPLIER);
  }
  for (const journey of template.journeys) {
    const size = dispatchedMass * journey.sizePerDispatchedMass;
    if (!(size > 0)) continue;
    const stationRoutes = direction === 'toHome'
      ? reversedStationRoutes(journey.stationRoutes)
      : structuredClone(journey.stationRoutes);
    const journeyStart = hour * 3_600;
    const journeyFareRevenue = roundedMoney(size * (journey.fare ?? legacyFare) * NATIVE_FARE_MULTIPLIER);
    const journeyRevenueByRoute = Object.fromEntries(Object.entries(journey.revenueByRoute ?? {}).map(
      ([routeId, routeFare]) => [routeId, roundedMoney(size * routeFare * NATIVE_FARE_MULTIPLIER)],
    ));
    pending.completedCommutes.push({
      popId: `${journey.popId}:${direction}:${hour}`,
      size,
      fareRevenue: journeyFareRevenue,
      revenueByRoute: journeyRevenueByRoute,
      stationRoutes,
      journeyStart,
      journeyEnd: journeyStart + Math.max(0, journey.totalClockSeconds ?? entry.flow.travelHours * 3_600),
      origin: direction === 'toWork' ? 'home' : 'work',
    });
  }
  return { transitMass, fareRevenue };
}

function dispatch(world, entries, hour, direction) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.flow.gatewayId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  let transitTrips = 0;
  let fareRevenue = 0;
  for (const [gatewayId, gatewayEntries] of groups) {
    let remainingCapacity = gatewayCapacity(world, gatewayId);
    for (const entry of gatewayEntries.sort((a, b) => a.flow.id.localeCompare(b.flow.id))) {
      const queueField = direction === 'toWork' ? 'queuedToWork' : 'queuedToHome';
      if (remainingCapacity <= 0 || entry[queueField] <= 0) continue;
      const mass = Math.min(entry[queueField], remainingCapacity);
      entry[queueField] -= mass;
      remainingCapacity -= mass;
      const financials = creditFareRevenue(world, entry, mass, direction, hour);
      transitTrips += financials.transitMass;
      fareRevenue += financials.fareRevenue;
      entry[direction].push({ mass, departureHour: hour, arrivalHour: hour + entry.flow.travelHours, ...financials });
    }
  }
  return { transitTrips, fareRevenue };
}

function nextScheduledHour(currentHour, hourOfDay) {
  const currentDayHour = ((currentHour % 24) + 24) % 24;
  const delta = (hourOfDay - currentDayHour + 24) % 24;
  return currentHour + (delta === 0 ? 24 : delta);
}

function nextActivityHour(world, currentHour) {
  let next = Infinity;
  for (const entry of Object.values(world.gatewayLedger ?? {})) {
    for (const event of [...entry.toWork, ...entry.toHome]) {
      if (event.arrivalHour > currentHour) next = Math.min(next, event.arrivalHour);
    }
    if (entry.queuedToWork > 0 || entry.queuedToHome > 0) next = Math.min(next, currentHour + 1);
    if (entry.atHome > 0) next = Math.min(next, nextScheduledHour(currentHour, MORNING_DEPARTURE_HOUR));
    if (entry.atWork > 0) next = Math.min(next, nextScheduledHour(currentHour, EVENING_DEPARTURE_HOUR));
  }
  return Number.isFinite(next) ? next : null;
}

/** Advances only scheduled departures, backlog dispatches, and arrivals. */
export function advanceCommutesTo(world, targetHour) {
  migrateCommuteLedger(world);
  if (!Number.isSafeInteger(targetHour) || targetHour < world.commuteLastProcessedHour) throw new Error('Commute time cannot move backwards');
  const entries = Object.values(world.gatewayLedger);
  const summary = {
    processedHours: targetHour - world.commuteLastProcessedHour,
    activeHours: 0,
    transitTrips: 0,
    fareRevenue: 0,
  };
  let hour = world.commuteNextActivityHour;
  while (hour != null && hour <= targetHour) {
    processArrivals(entries, hour);
    const hourOfDay = ((hour % 24) + 24) % 24;
    if (hourOfDay === MORNING_DEPARTURE_HOUR) {
      for (const entry of entries) {
        entry.queuedToWork += entry.atHome;
        entry.atHome = 0;
      }
    }
    if (hourOfDay === EVENING_DEPARTURE_HOUR) {
      for (const entry of entries) {
        entry.queuedToHome += entry.atWork;
        entry.atWork = 0;
      }
    }
    const toWork = dispatch(world, entries, hour, 'toWork');
    const toHome = dispatch(world, entries, hour, 'toHome');
    summary.transitTrips += toWork.transitTrips + toHome.transitTrips;
    summary.fareRevenue += toWork.fareRevenue + toHome.fareRevenue;
    summary.activeHours++;
    world.commuteLastProcessedHour = hour;
    world.commuteNextActivityHour = nextActivityHour(world, hour);
    hour = world.commuteNextActivityHour;
  }
  world.commuteLastProcessedHour = targetHour;
  if (summary.activeHours > 0) assertCommuteLedger(world);
  return summary;
}

/**
 * Reconstruct aggregate commute positions at an older native-save clock.
 * Used only when an explicitly aliased tile save has no matching sidecar
 * checkpoint. Network/mode-share inputs survive, while future settlement
 * counters are discarded because the native save's wallet/history is the
 * authoritative timeline.
 */
export function rebaseCommutesTo(world, targetHour) {
  migrateCommuteLedger(world);
  if (!Number.isSafeInteger(targetHour) || targetHour < 0) throw new Error('Invalid commute rebase time');
  const entries = Object.values(world.gatewayLedger ?? {});
  for (const entry of entries) {
    entry.atHome = entry.flow.mass;
    entry.queuedToWork = 0;
    entry.toWork = [];
    entry.atWork = 0;
    entry.queuedToHome = 0;
    entry.toHome = [];
  }
  const hourOfDay = ((targetHour % 24) + 24) % 24;
  const replayStart = Math.max(0, targetHour - hourOfDay - 24);
  const wallet = world.wallet;
  const financialSchemaVersion = world.crossTileFinancials?.schemaVersion;
  const fare = world.farePolicy?.fare;
  if (world.farePolicy) world.farePolicy.fare = 0;
  world.commuteLastProcessedHour = replayStart;
  world.commuteNextActivityHour = nextActivityHour(world, replayStart);
  advanceCommutesTo(world, targetHour);
  if (world.farePolicy) world.farePolicy.fare = fare;
  world.wallet = wallet;
  world.crossTileFinancials = {
    transitTrips: 0,
    fareRevenue: 0,
    pendingNativeRevenue: 0,
    ...(financialSchemaVersion == null ? {} : { schemaVersion: financialSchemaVersion }),
  };
  world.pendingCrossTileAttribution = { revenueByRoute: {}, completedCommutes: [] };
  for (const entry of entries) {
    // The replay establishes positions only; future-derived cumulative totals
    // do not belong to the older native save timeline.
    entry.transitTrips = 0;
    entry.fareRevenue = 0;
  }
  world.crossModeShare = null;
  world.commuteLastProcessedHour = targetHour;
  world.commuteNextActivityHour = nextActivityHour(world, targetHour);
  assertCommuteLedger(world);
  return world;
}

/** Compatibility seam for observed active-tile departures in fixture tests. */
export function recordObservedDeparture(world, { cohortId, mass, time }) {
  migrateCommuteLedger(world);
  const entry = world.gatewayLedger[cohortId];
  if (!entry) throw new Error(`Unknown gateway flow: ${cohortId}`);
  if (!(mass > 0) || mass > entry.atHome) throw new Error(`Invalid departure mass for ${cohortId}`);
  entry.atHome -= mass;
  const financials = creditFareRevenue(world, entry, mass, 'toWork', time);
  entry.toWork.push({ mass, departureHour: time, arrivalHour: time + entry.flow.travelHours, ...financials });
  const next = nextActivityHour(world, world.commuteLastProcessedHour);
  if (next != null) {
    world.commuteNextActivityHour = world.commuteNextActivityHour == null
      ? next
      : Math.min(world.commuteNextActivityHour, next);
  }
}

export function projectCommutesForTile(world, tileId) {
  migrateCommuteLedger(world);
  const projection = {
    totalCrossTileWorkers: 0,
    present: 0,
    waitingToLeave: 0,
    inboundInTransit: 0,
    outboundInTransit: 0,
    globalInTransit: 0,
    globalBacklog: 0,
    gateways: {},
  };
  for (const entry of Object.values(world.gatewayLedger)) {
    const toWork = eventMass(entry.toWork);
    const toHome = eventMass(entry.toHome);
    projection.totalCrossTileWorkers += entry.flow.mass;
    projection.globalInTransit += toWork + toHome;
    projection.globalBacklog += entry.queuedToWork + entry.queuedToHome;
    if (entry.flow.homeTileId === tileId) {
      projection.present += entry.atHome + entry.queuedToWork;
      projection.waitingToLeave += entry.queuedToWork;
      projection.outboundInTransit += toWork;
      projection.inboundInTransit += toHome;
    }
    if (entry.flow.workTileId === tileId) {
      projection.present += entry.atWork + entry.queuedToHome;
      projection.waitingToLeave += entry.queuedToHome;
      projection.inboundInTransit += toWork;
      projection.outboundInTransit += toHome;
    }
    const gateway = projection.gateways[entry.flow.gatewayId] ??= { backlog: 0, inTransit: 0 };
    gateway.backlog += entry.queuedToWork + entry.queuedToHome;
    gateway.inTransit += toWork + toHome;
  }
  return projection;
}

export const COMMUTE_SCHEDULE = Object.freeze({
  morningDepartureHour: MORNING_DEPARTURE_HOUR,
  eveningDepartureHour: EVENING_DEPARTURE_HOUR,
  defaultGatewayCapacityPerHour: DEFAULT_GATEWAY_CAPACITY_PER_HOUR,
});
