import { quoteJourneyFare } from './journey-fare.js';

const HOURS_PER_DAY = 24;
const NATIVE_ANNUALIZATION = 365;
const NATIVE_REVENUE_PROFILE_SCHEMA_VERSION = 3;

// Subway Builder 1.6 assigns each ordinary pop one departure in each
// direction from these hourly weights. Keep the fallback aligned with the
// bundle so an older cached pop without timing fields does not become a pair
// of artificial instantaneous rush-hour spikes.
const NATIVE_HOME_DEPARTURE_WEIGHTS = Object.freeze([
  0.15, 0.15, 0.15, 0.3, 0.3, 0.3, 1, 2.5, 2.5, 2.5, 1, 0.8,
  0.8, 0.8, 0.8, 0.8, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.15,
]);
const NATIVE_WORK_DEPARTURE_WEIGHTS = Object.freeze([
  0.15, 0.15, 0.15, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.8, 0.8,
  0.8, 0.8, 0.8, 1, 2.5, 2.5, 2.5, 1, 0.3, 0.3, 0.3, 0.15,
]);

const SCHEDULE_KEY_BY_HOUR = Object.freeze([
  'veryLowDemand', 'veryLowDemand', 'veryLowDemand',
  'lowDemand', 'lowDemand', 'lowDemand',
  'mediumDemand', 'highDemand', 'highDemand', 'highDemand',
  'mediumDemand', 'mediumDemand', 'mediumDemand', 'mediumDemand', 'mediumDemand', 'mediumDemand',
  'highDemand', 'highDemand', 'highDemand',
  'mediumDemand', 'lowDemand', 'lowDemand', 'lowDemand',
  'veryLowDemand',
]);

const TRAIN_COSTS = Object.freeze({
  'heavy-metro': { train: 250, car: 25, fallbackCars: 5, track: 360, station: 320_000 },
  'light-metro': { train: 180, car: 20, fallbackCars: 2, track: 280, station: 200_000 },
  'commuter-rail': { train: 500, car: 35, fallbackCars: 4, track: 300, station: 320_000 },
  tram: { train: 120, car: 15, fallbackCars: 1, track: 240, station: 40_000 },
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const emptyHour = () => ({ revenue: 0, revenueByRoute: {} });

function normalizedWeights(weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

const NATIVE_HOME_DEPARTURE_PROBABILITIES = Object.freeze(normalizedWeights(NATIVE_HOME_DEPARTURE_WEIGHTS));
const NATIVE_WORK_DEPARTURE_PROBABILITIES = Object.freeze(normalizedWeights(NATIVE_WORK_DEPARTURE_WEIGHTS));

function hashText(value) {
  let hash = 2_166_136_261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function deterministicWeightedHour(key, weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let target = hashText(key) / 0x1_0000_0000 * total;
  for (let hour = 0; hour < weights.length; hour++) {
    target -= weights[hour];
    if (target < 0) return hour;
  }
  return weights.length - 1;
}

/** Stable stand-in for the bundle's randomized per-pop departure assignment. */
export function deterministicNativeDepartureTimes(popId) {
  const homeHour = deterministicWeightedHour(`${popId}|home-hour`, NATIVE_HOME_DEPARTURE_WEIGHTS);
  const workHour = deterministicWeightedHour(`${popId}|work-hour`, NATIVE_WORK_DEPARTURE_WEIGHTS);
  return {
    homeDepartureTime: homeHour * 3_600 + hashText(`${popId}|home-second`) % 3_600,
    workDepartureTime: workHour * 3_600 + hashText(`${popId}|work-second`) % 3_600,
  };
}

function departureDistribution(seconds, fallbackProbabilities) {
  const value = Number(seconds);
  if (Number.isFinite(value) && value >= 0) {
    return [[Math.floor(value / 3_600) % HOURS_PER_DAY, 1]];
  }
  return fallbackProbabilities.map((probability, hour) => [hour, probability]);
}

function addRevenueToDistribution(hourly, distribution, oneWayRevenue, revenueByRoute, owned) {
  for (const [hour, probability] of distribution) {
    const bucket = hourly[hour];
    bucket.revenue += oneWayRevenue * probability;
    for (const [routeId, routeRevenue] of Object.entries(revenueByRoute)) {
      const share = routeRevenue * probability;
      bucket.revenueByRoute[routeId] = (bucket.revenueByRoute[routeId] ?? 0) + share;
      if (!owned.has(String(routeId))) continue;
      bucket.financeOwnedRevenue = (bucket.financeOwnedRevenue ?? 0) + share;
      bucket.financeOwnedRevenueByRoute ??= {};
      bucket.financeOwnedRevenueByRoute[routeId]
        = (bucket.financeOwnedRevenueByRoute[routeId] ?? 0) + share;
    }
  }
}

function financeHourHasValue(hour = {}) {
  return finite(hour.revenue, 0) > 0
    || finite(hour.financeOwnedRevenue, 0) > 0
    || Object.values(hour.revenueByRoute ?? {}).some((value) => finite(value, 0) > 0)
    || Object.values(hour.financeOwnedRevenueByRoute ?? {}).some((value) => finite(value, 0) > 0);
}

function redistributeLegacyHour(hourly, source, probabilities) {
  const revenueByRoute = Object.fromEntries(Object.entries(source?.revenueByRoute ?? {})
    .map(([routeId, amount]) => [routeId, Math.max(0, finite(amount, 0))]));
  const ownedRevenueByRoute = Object.fromEntries(Object.entries(source?.financeOwnedRevenueByRoute ?? {})
    .map(([routeId, amount]) => [routeId, Math.max(0, finite(amount, 0))]));
  for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
    const probability = probabilities[hour];
    hourly[hour].revenue += Math.max(0, finite(source?.revenue, 0)) * probability;
    for (const [routeId, amount] of Object.entries(revenueByRoute)) {
      hourly[hour].revenueByRoute[routeId] = (hourly[hour].revenueByRoute[routeId] ?? 0) + amount * probability;
    }
    const ownedRevenue = Math.max(0, finite(source?.financeOwnedRevenue, 0)) * probability;
    if (ownedRevenue > 0) hourly[hour].financeOwnedRevenue = (hourly[hour].financeOwnedRevenue ?? 0) + ownedRevenue;
    for (const [routeId, amount] of Object.entries(ownedRevenueByRoute)) {
      hourly[hour].financeOwnedRevenueByRoute ??= {};
      hourly[hour].financeOwnedRevenueByRoute[routeId]
        = (hourly[hour].financeOwnedRevenueByRoute[routeId] ?? 0) + amount * probability;
    }
  }
}

/** Upgrade the old 07:00/17:00 compression without reloading remote demand. */
export function migrateCachedNativeRevenueProfile(profile) {
  if (!profile || profile.schemaVersion !== 2 || !Array.isArray(profile.hourly)) return profile;
  const hasDistributedRevenue = profile.hourly.some((hour, index) => ![7, 17].includes(index) && financeHourHasValue(hour));
  if (hasDistributedRevenue) return { ...profile, schemaVersion: NATIVE_REVENUE_PROFILE_SCHEMA_VERSION };
  const hourly = Array.from({ length: HOURS_PER_DAY }, emptyHour);
  redistributeLegacyHour(hourly, profile.hourly[7], NATIVE_HOME_DEPARTURE_PROBABILITIES);
  redistributeLegacyHour(hourly, profile.hourly[17], NATIVE_WORK_DEPARTURE_PROBABILITIES);
  return {
    ...structuredClone(profile),
    schemaVersion: NATIVE_REVENUE_PROFILE_SCHEMA_VERSION,
    hourly,
  };
}

function trainTypeTable(trainTypes) {
  const entries = Array.isArray(trainTypes)
    ? trainTypes.map((type) => [type?.id ?? type?.trainType ?? type?.type, type])
    : Object.entries(trainTypes ?? {});
  return new Map(entries.filter(([id, type]) => id && type).map(([id, type]) => [String(id), {
    train: finite(type.trainOperationalCostPerHour, NaN),
    car: finite(type.carOperationalCostPerHour, NaN),
    fallbackCars: finite(type.carsPerCarSet, NaN),
    track: finite(type.trackMaintenanceCostPerMeter, NaN),
    station: finite(type.stationMaintenanceCostPerYear, NaN),
  }]));
}

function costsFor(typeId, liveTypes) {
  const fallback = TRAIN_COSTS[typeId] ?? TRAIN_COSTS['heavy-metro'];
  const live = liveTypes.get(String(typeId));
  if (!live) return fallback;
  return Object.fromEntries(Object.entries(fallback).map(([key, value]) => [
    key,
    Number.isFinite(live[key]) ? live[key] : value,
  ]));
}

function periodContains(period, hour) {
  const start = finite(period?.startHour, 0);
  const end = finite(period?.endHour, 24);
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

function routeServiceCount(route, hour, physicalCount) {
  const schedule = route?.openWorldGlobalTrainSchedule ?? route?.trainSchedule;
  const scheduled = finite(schedule?.[SCHEDULE_KEY_BY_HOUR[hour]], NaN);
  if (Number.isFinite(scheduled)) return Math.max(0, Math.round(scheduled));
  const timetable = route?.timetableSchedule;
  const period = timetable?.periods?.find((candidate) => periodContains(candidate, hour));
  const headway = finite(period?.headwaySeconds, 0);
  const cycle = finite(route?.stComboTimings?.at?.(-1)?.departureTime, 0);
  if (headway > 0 && cycle > 0) return Math.max(1, Math.ceil(cycle / headway));
  return Math.max(0, physicalCount);
}

function lineLengthMeters(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return 0;
  const earthRadius = 6_371_000;
  let total = 0;
  for (let index = 1; index < coords.length; index++) {
    const [lon1, lat1] = coords[index - 1].map((value) => value * Math.PI / 180);
    const [lon2, lat2] = coords[index].map((value) => value * Math.PI / 180);
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    total += earthRadius * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return total;
}

function canonicalRouteId(routeById, routeId) {
  return routeById.get(routeId)?.tempParentId ?? routeId;
}

function referencedTrackIds(route) {
  const result = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'trackId' && item != null) result.add(String(item));
      else if (key === 'trackIds' && Array.isArray(item)) {
        for (const id of item) if (id != null) result.add(String(id));
      } else if (typeof item === 'object') visit(item);
    }
  };
  visit(route);
  return [...result];
}

/**
 * Estimate one representative native day. Revenue is derived from the
 * already-computed native mode choices, so it follows the game's catchments,
 * paths, fares and income model without running inactive demand every hour.
 */
export function calculateNativeRevenueProfile(pops = [], {
  financeOwnedRouteIds = [], fareGroups = [], routes = [], legacyFare = 0,
} = {}) {
  const hourly = Array.from({ length: HOURS_PER_DAY }, emptyHour);
  const owned = new Set(financeOwnedRouteIds.map(String));
  let transitPopulation = 0;
  let dailyRevenue = 0;
  for (const pop of pops) {
    if (String(pop?.id ?? '').startsWith('cross-pop-')) continue;
    const transitMass = Math.max(0, finite(pop?.lastCommute?.modeChoice?.transit, 0));
    if (!(transitMass > 0)) continue;
    const paths = Array.isArray(pop?.lastCommute?.transitPaths) ? pop.lastCommute.transitPaths : [];
    const path = paths.find((candidate) => finite(candidate?.fareCost, -1) >= 0 && candidate?.segments?.length)
      ?? paths.find((candidate) => finite(candidate?.fareCost, -1) >= 0);
    const fare = finite(path?.fareCost, -1);
    if (!(fare >= 0)) continue;
    const oneWayRevenue = transitMass * fare * NATIVE_ANNUALIZATION;
    const routeIds = [...new Set((path?.segments ?? []).map((segment) => segment?.routeId).filter(Boolean))];
    const quoted = (fareGroups.length || routes.length) ? quoteJourneyFare({
      segments: path?.segments ?? [], fareGroups, routes, legacyFare,
      nativeFare: () => fare,
    }) : null;
    let fareByRoute = quoted?.revenueByRoute ?? {};
    if (!Object.keys(fareByRoute).length && routeIds.length) {
      fareByRoute = Object.fromEntries(routeIds.map((routeId) => [routeId, fare / routeIds.length]));
    }
    transitPopulation += transitMass;
    dailyRevenue += oneWayRevenue * 2;
    const routeRevenue = Object.fromEntries(Object.entries(fareByRoute)
      .map(([routeId, routeFare]) => [routeId, transitMass * routeFare * NATIVE_ANNUALIZATION]));
    addRevenueToDistribution(
      hourly,
      departureDistribution(pop.homeDepartureTime, NATIVE_HOME_DEPARTURE_PROBABILITIES),
      oneWayRevenue,
      routeRevenue,
      owned,
    );
    addRevenueToDistribution(
      hourly,
      departureDistribution(pop.workDepartureTime, NATIVE_WORK_DEPARTURE_PROBABILITIES),
      oneWayRevenue,
      routeRevenue,
      owned,
    );
  }
  return { schemaVersion: NATIVE_REVENUE_PROFILE_SCHEMA_VERSION, hourly, transitPopulation, dailyRevenue };
}

/** Build global operating and infrastructure costs once per network update. */
export function calculateGlobalExpenseProfile(
  nativeState = {},
  trainTypes = [],
  { financeOwnedRouteIds = [], financeOwnedTrackIds: explicitFinanceOwnedTrackIds = [] } = {},
) {
  const liveTypes = trainTypeTable(trainTypes);
  const financeOwned = new Set(financeOwnedRouteIds.map(String));
  const financeOwnedTrackIds = new Set(explicitFinanceOwnedTrackIds.map(String));
  for (const trackId of (nativeState.routes ?? [])
    .filter((route) => financeOwned.has(String(route?.id)))
    .flatMap(referencedTrackIds)) financeOwnedTrackIds.add(String(trackId));
  const routes = Array.isArray(nativeState.routes) ? nativeState.routes.filter((route) => !route?.tempParentId) : [];
  const routeById = new Map((nativeState.routes ?? []).map((route) => [route.id, route]));
  const trainsByRoute = new Map();
  for (const train of nativeState.trains ?? []) {
    const routeId = canonicalRouteId(routeById, train.routeId);
    if (!routeId) continue;
    const list = trainsByRoute.get(routeId) ?? [];
    list.push(train);
    trainsByRoute.set(routeId, list);
  }
  const routeHourly = {};
  for (const route of routes) {
    const trains = trainsByRoute.get(route.id) ?? [];
    const typeId = route.trainType ?? trains[0]?.trainType ?? 'heavy-metro';
    const costs = costsFor(typeId, liveTypes);
    const cars = trains.length
      ? trains.reduce((sum, train) => sum + Math.max(1, finite(train.cars, costs.fallbackCars)), 0) / trains.length
      : costs.fallbackCars;
    const costPerTrainHour = (costs.train + cars * costs.car) * NATIVE_ANNUALIZATION;
    routeHourly[route.id] = Array.from({ length: HOURS_PER_DAY }, (_, hour) => (
      routeServiceCount(route, hour, trains.length) * costPerTrainHour
    ));
  }

  const trackById = new Map((nativeState.tracks ?? []).map((track) => [track.id, track]));
  const infrastructureItems = [];
  for (const group of nativeState.trackGroups ?? []) {
    if (group?.type === 'scissors-crossover') continue;
    const tracks = (group?.trackIds ?? []).map((id) => trackById.get(id))
      .filter((track) => track?.buildType === 'constructed');
    if (!tracks.length) continue;
    const typeId = group.trackType ?? tracks[0]?.trackType ?? 'heavy-metro';
    const costs = costsFor(typeId, liveTypes);
    if (group.type === 'station') {
      infrastructureItems.push({
        id: `station:${group.id}`,
        category: 'stationMaintenance',
        hourlyCost: costs.station / HOURS_PER_DAY,
        trackIds: tracks.map((track) => track.id),
        financeOwned: tracks.some((track) => financeOwnedTrackIds.has(String(track.id))),
      });
      continue;
    }
    for (const track of tracks) {
      const length = Math.max(0, finite(track.length, lineLengthMeters(track.coords)));
      infrastructureItems.push({
        id: `track:${track.id}`,
        category: 'trackMaintenance',
        hourlyCost: length * costs.track / HOURS_PER_DAY,
        trackIds: [track.id],
        financeOwned: financeOwnedTrackIds.has(String(track.id)),
      });
    }
  }
  return { routeHourly, infrastructureItems, financeOwnedRouteIds: [...financeOwned].sort() };
}

export function backgroundFinanceForHour({ finance, activeTileId, activeProjection, hour }) {
  const revenueByRoute = {};
  let revenue = 0;
  const revenueByTile = {};
  for (const [tileId, profile] of Object.entries(finance?.tileRevenueProfiles ?? {})) {
    const value = profile?.hourly?.[hour % HOURS_PER_DAY];
    if (!value) continue;
    const active = tileId === activeTileId;
    revenueByTile[tileId] = Math.max(0, finite(active ? value.financeOwnedRevenue : value.revenue, 0));
    revenue += revenueByTile[tileId];
    const routeRevenue = active ? value.financeOwnedRevenueByRoute : value.revenueByRoute;
    for (const [routeId, amount] of Object.entries(routeRevenue ?? {})) {
      revenueByRoute[routeId] = (revenueByRoute[routeId] ?? 0) + Math.max(0, finite(amount, 0));
    }
  }

  const visibleRouteIds = new Set((activeProjection?.baselineState?.routes ?? []).map((route) => String(route.id)));
  const partialRouteIds = new Set((activeProjection?.partialRouteIds ?? []).map(String));
  const financeOwnedRouteIds = new Set((finance?.expenseProfile?.financeOwnedRouteIds ?? []).map(String));
  const expensesByRoute = {};
  let trainOperational = 0;
  for (const [routeId, costs] of Object.entries(finance?.expenseProfile?.routeHourly ?? {})) {
    if (!financeOwnedRouteIds.has(routeId) && visibleRouteIds.has(routeId) && !partialRouteIds.has(routeId)) continue;
    const amount = Math.max(0, finite(costs?.[hour % HOURS_PER_DAY], 0));
    if (!(amount > 0)) continue;
    expensesByRoute[routeId] = amount;
    trainOperational += amount;
  }

  const visibleTrackIds = new Set((activeProjection?.baselineState?.tracks ?? []).map((track) => String(track.id)));
  const expenseCategories = { trainOperational };
  for (const item of finance?.expenseProfile?.infrastructureItems ?? []) {
    const trackIds = item.trackIds ?? [];
    const visibleShare = trackIds.length
      ? trackIds.filter((id) => visibleTrackIds.has(String(id))).length / trackIds.length
      : 0;
    const amount = Math.max(0, finite(item.hourlyCost, 0)) * (item.financeOwned ? 1 : (1 - visibleShare));
    if (amount > 0) expenseCategories[item.category] = (expenseCategories[item.category] ?? 0) + amount;
  }
  const expenses = Object.values(expenseCategories).reduce((sum, amount) => sum + amount, 0);
  return { revenue, expenses, revenueByTile, revenueByRoute, expensesByRoute, expenseCategories };
}

const FINANCE_HOUR_SECONDS = 3_600;
const ROUTE_FINANCIAL_HISTORY_HOURS = 14 * 24;

function mergePositiveAmounts(target, source) {
  for (const [key, rawAmount] of Object.entries(source ?? {})) {
    const amount = finite(rawAmount, 0);
    if (!(amount > 0)) continue;
    target[key] = (finite(target[key], 0)) + amount;
  }
  return target;
}

function normalizedFinancePosting(posting) {
  const expenseCategories = mergePositiveAmounts({}, posting?.expenseCategories);
  return {
    hour: Math.floor(finite(posting?.hour, -1)),
    revenue: Math.max(0, finite(posting?.revenue, 0)),
    expenses: Object.values(expenseCategories).reduce((sum, amount) => sum + amount, 0),
    expenseCategories,
    revenueByRoute: mergePositiveAmounts({}, posting?.revenueByRoute),
    expensesByRoute: mergePositiveAmounts({}, posting?.expensesByRoute),
  };
}

/**
 * Apply inactive-tile estimates to their simulated hours without replaying one
 * native state mutation per hour. The wallet can still be changed once; this
 * function only reconstructs the dashboard history that those hourly native
 * mutations would have produced.
 */
export function backfillHourlyFinancialHistory(financialHistory, hourlyPostings, {
  targetElapsedSeconds,
  openingWallet = 0,
  expensesAffectWallet = true,
  receiptId = null,
} = {}) {
  const targetTimestamp = Math.floor(Math.max(0, finite(targetElapsedSeconds, 0)) / FINANCE_HOUR_SECONDS)
    * FINANCE_HOUR_SECONDS;
  const history = structuredClone(financialHistory ?? {});
  let entries = Array.isArray(history.entries) ? history.entries : [];
  let lastHourTimestamp = Math.max(0, finite(history.lastHourTimestamp, targetTimestamp));
  let currentHourRevenue = Math.max(0, finite(history.currentHourRevenue, 0));
  let currentHourExpenses = Math.max(0, finite(history.currentHourExpenses, 0));
  let currentHourExpenseCategories = mergePositiveAmounts({}, history.currentHourExpenseCategories);

  if (targetTimestamp > lastHourTimestamp && targetElapsedSeconds > 0) {
    if (entries.at(-1)?.timestamp !== lastHourTimestamp) {
      entries.push({
        timestamp: lastHourTimestamp,
        balance: finite(openingWallet, 0),
        hourlyRevenue: currentHourRevenue,
        hourlyExpenses: currentHourExpenses,
        expenseCategories: currentHourExpenseCategories,
      });
    }
    lastHourTimestamp = targetTimestamp;
    currentHourRevenue = 0;
    currentHourExpenses = 0;
    currentHourExpenseCategories = {};
  }

  const rows = (hourlyPostings ?? []).map(normalizedFinancePosting)
    .filter((row) => Number.isSafeInteger(row.hour) && row.hour >= 0 && row.hour * FINANCE_HOUR_SECONDS <= targetTimestamp)
    .sort((left, right) => left.hour - right.hour);
  const entryByTimestamp = new Map(entries.map((entry) => [finite(entry?.timestamp, -1), entry]));
  const netByTimestamp = new Map();
  for (const row of rows) {
    const timestamp = row.hour * FINANCE_HOUR_SECONDS;
    if (timestamp === lastHourTimestamp) {
      currentHourRevenue += row.revenue;
      currentHourExpenses += row.expenses;
      mergePositiveAmounts(currentHourExpenseCategories, row.expenseCategories);
      continue;
    }
    let entry = entryByTimestamp.get(timestamp);
    if (!entry) {
      const previous = [...entryByTimestamp.values()]
        .filter((candidate) => finite(candidate?.timestamp, -1) < timestamp)
        .sort((left, right) => right.timestamp - left.timestamp)[0];
      entry = {
        timestamp,
        balance: finite(previous?.balance, openingWallet),
        hourlyRevenue: 0,
        hourlyExpenses: 0,
        expenseCategories: {},
      };
      entries.push(entry);
      entryByTimestamp.set(timestamp, entry);
    }
    entry.hourlyRevenue = Math.max(0, finite(entry.hourlyRevenue, 0)) + row.revenue;
    entry.hourlyExpenses = Math.max(0, finite(entry.hourlyExpenses, 0)) + row.expenses;
    entry.expenseCategories = mergePositiveAmounts(
      mergePositiveAmounts({}, entry.expenseCategories),
      row.expenseCategories,
    );
    netByTimestamp.set(timestamp, (netByTimestamp.get(timestamp) ?? 0)
      + row.revenue - (expensesAffectWallet ? row.expenses : 0));
  }

  let cumulativeNet = 0;
  entries = entries.sort((left, right) => finite(left?.timestamp, 0) - finite(right?.timestamp, 0))
    .map((entry) => {
      cumulativeNet += netByTimestamp.get(finite(entry?.timestamp, -1)) ?? 0;
      return { ...entry, balance: finite(entry?.balance, openingWallet) + cumulativeNet };
    });
  const receipts = Array.isArray(history.openWorldBackgroundFinanceReceipts)
    ? history.openWorldBackgroundFinanceReceipts
    : [];
  return {
    ...history,
    entries,
    lastHourTimestamp,
    currentHourRevenue,
    currentHourExpenses,
    currentHourExpenseCategories,
    ...(receiptId ? { openWorldBackgroundFinanceReceipts: [...receipts, receiptId].slice(-240) } : {}),
  };
}

/** Backfill the route detail ledger using the same hourly rows as the dashboard. */
export function backfillHourlyRouteFinancials(routeFinancials, hourlyPostings, targetElapsedSeconds) {
  const targetTimestamp = Math.floor(Math.max(0, finite(targetElapsedSeconds, 0)) / FINANCE_HOUR_SECONDS)
    * FINANCE_HOUR_SECONDS;
  const result = structuredClone(routeFinancials ?? {});
  const byRoute = result.byRoute && typeof result.byRoute === 'object' ? result.byRoute : {};
  let lastHourTimestamp = Math.max(0, finite(result.lastHourTimestamp, targetTimestamp));
  let currentHour = result.currentHour && typeof result.currentHour === 'object' ? result.currentHour : {};
  if (targetTimestamp > lastHourTimestamp && targetElapsedSeconds > 0) {
    for (const [routeId, amounts] of Object.entries(currentHour)) {
      const revenue = Math.max(0, finite(amounts?.revenue, 0));
      const expenses = Math.max(0, finite(amounts?.expenses, 0));
      if (!(revenue > 0 || expenses > 0)) continue;
      const entries = byRoute[routeId] ?? [];
      if (entries.at(-1)?.timestamp !== lastHourTimestamp) {
        byRoute[routeId] = [...entries, { timestamp: lastHourTimestamp, revenue, expenses }]
          .slice(-ROUTE_FINANCIAL_HISTORY_HOURS);
      }
    }
    lastHourTimestamp = targetTimestamp;
    currentHour = {};
  }

  const rows = (hourlyPostings ?? []).map(normalizedFinancePosting)
    .filter((row) => Number.isSafeInteger(row.hour) && row.hour >= 0 && row.hour * FINANCE_HOUR_SECONDS <= targetTimestamp)
    .sort((left, right) => left.hour - right.hour);
  const mergeRouteAmounts = (row, timestamp, field) => {
    for (const [routeId, amount] of Object.entries(row[field])) {
      const valueKey = field === 'revenueByRoute' ? 'revenue' : 'expenses';
      if (timestamp === lastHourTimestamp) {
        const current = currentHour[routeId] ?? { revenue: 0, expenses: 0 };
        currentHour[routeId] = { ...current, [valueKey]: finite(current[valueKey], 0) + amount };
        continue;
      }
      const entries = byRoute[routeId] ?? [];
      let entry = entries.find((candidate) => candidate.timestamp === timestamp);
      if (!entry) {
        entry = { timestamp, revenue: 0, expenses: 0 };
        entries.push(entry);
      }
      entry[valueKey] = finite(entry[valueKey], 0) + amount;
      byRoute[routeId] = entries.sort((left, right) => left.timestamp - right.timestamp)
        .slice(-ROUTE_FINANCIAL_HISTORY_HOURS);
    }
  };
  for (const row of rows) {
    const timestamp = row.hour * FINANCE_HOUR_SECONDS;
    mergeRouteAmounts(row, timestamp, 'revenueByRoute');
    mergeRouteAmounts(row, timestamp, 'expensesByRoute');
  }
  return { ...result, byRoute, lastHourTimestamp, currentHour };
}

/** The subset for which the active native tick provides a true A/B sample. */
export function nativeComparableFinanceForHour({ finance, activeTileId, activeProjection, hour }) {
  const visible = new Set((activeProjection?.baselineState?.routes ?? []).map((route) => String(route.id)));
  const partial = new Set((activeProjection?.partialRouteIds ?? []).map(String));
  const owned = new Set((finance?.expenseProfile?.financeOwnedRouteIds ?? []).map(String));
  const comparable = new Set([...owned].filter((routeId) => visible.has(routeId) && !partial.has(routeId)));
  const activeHour = finance?.tileRevenueProfiles?.[activeTileId]?.hourly?.[hour % HOURS_PER_DAY] ?? {};
  const revenueByRoute = Object.fromEntries(Object.entries(activeHour.financeOwnedRevenueByRoute ?? {})
    .filter(([routeId]) => comparable.has(String(routeId)))
    .map(([routeId, amount]) => [routeId, Math.max(0, finite(amount, 0))]));
  const expensesByRoute = Object.fromEntries([...comparable].map((routeId) => [
    routeId,
    Math.max(0, finite(finance?.expenseProfile?.routeHourly?.[routeId]?.[hour % HOURS_PER_DAY], 0)),
  ]));
  return {
    routeIds: [...comparable].sort(),
    revenueByRoute,
    expensesByRoute,
    revenue: Object.values(revenueByRoute).reduce((sum, amount) => sum + amount, 0),
    expenses: Object.values(expensesByRoute).reduce((sum, amount) => sum + amount, 0),
  };
}

function auditComparison(projected, native) {
  const difference = projected - native;
  return {
    native,
    projected,
    projectedMinusNative: difference,
    percentOfNative: Math.abs(native) > 1e-9 ? projected / native * 100 : (Math.abs(projected) > 1e-9 ? null : 100),
    percentError: Math.abs(native) > 1e-9 ? difference / Math.abs(native) * 100 : (Math.abs(projected) > 1e-9 ? null : 0),
  };
}

/** Only a complete structurally stable native day is comparable because fare completion hours differ from forecast departure hours. */
export function summarizeNativeFinanceAudit(samples = [], windowHours = HOURS_PER_DAY) {
  const eligible = samples
    .filter((sample) => sample?.complete && sample.auditSignatureStable !== false && sample.tileId != null)
    .sort((left, right) => left.hour - right.hour || String(left.tileId).localeCompare(String(right.tileId)));
  const byTile = new Map();
  for (const sample of eligible) {
    const list = byTile.get(String(sample.tileId)) ?? [];
    list.push(sample);
    byTile.set(String(sample.tileId), list);
  }
  let latestRun = [];
  for (const list of byTile.values()) {
    let run = [];
    for (const sample of list) {
      const previous = run.at(-1);
      const networkVersion = sample.auditSignature ?? `legacy:${sample.projectionHash ?? 'none'}`;
      const previousNetworkVersion = previous?.auditSignature ?? `legacy:${previous?.projectionHash ?? 'none'}`;
      if (previous && (sample.hour !== previous.hour + 1 || networkVersion !== previousNetworkVersion)) run = [];
      run.push(sample);
      if (run.length > windowHours) run.shift();
    }
    if ((run.at(-1)?.hour ?? -1) > (latestRun.at(-1)?.hour ?? -1)) latestRun = run;
  }
  const sum = (field, side) => latestRun.reduce((total, sample) => total + (Number(sample?.[field]?.[side]) || 0), 0);
  const partialRevenue = auditComparison(sum('revenue', 'projected'), sum('revenue', 'native'));
  const partialExpenses = auditComparison(sum('expenses', 'projected'), sum('expenses', 'native'));
  const ready = latestRun.length === windowHours;
  const unavailable = { native: null, projected: null, projectedMinusNative: null, percentOfNative: null, percentError: null };
  return {
    ready,
    status: ready ? 'ready' : 'collecting',
    tileId: latestRun.at(-1)?.tileId ?? null,
    sampleCount: latestRun.length,
    hoursRequired: windowHours,
    firstHour: latestRun[0]?.hour ?? null,
    lastHour: latestRun.at(-1)?.hour ?? null,
    revenue: ready ? partialRevenue : unavailable,
    expenses: ready ? partialExpenses : unavailable,
    net: ready
      ? auditComparison(
        partialRevenue.projected - partialExpenses.projected,
        partialRevenue.native - partialExpenses.native,
      )
      : unavailable,
    partial: {
      revenue: partialRevenue,
      expenses: partialExpenses,
      net: auditComparison(
        partialRevenue.projected - partialExpenses.projected,
        partialRevenue.native - partialExpenses.native,
      ),
    },
  };
}

export const NATIVE_FINANCE_PROFILE_SCHEMA_VERSION = 2;
