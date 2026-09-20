import { MAX_COMPLETED_COMMUTE_RECORDS } from './completed-commute-aggregation.js';

export const INCREMENTAL_AGGREGATION_VERSION = 'incremental-commute-aggregation-v1';
const finiteOr = (value, fallback) => Number.isFinite(value) ? value : fallback;
const roundedMoney = value => Math.round(finiteOr(value, 0) * 100) / 100;
const hourBucketOf = value => Number.isFinite(value) ? Math.floor(value / 3600) : -1;

function hashText(value) {
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function routeSignature(routes) {
  if (!Array.isArray(routes) || routes.length === 0) return 'direct';
  let key = '';
  for (const segment of routes) {
    const ids = Array.isArray(segment?.stationIds) ? segment.stationIds : [];
    key += `|${segment?.routeId ?? '?'}:${ids.join('>')}`;
  }
  return key;
}

function mergeRevenue(target, source) {
  for (const [id, value] of Object.entries(source ?? {})) {
    target[id] = roundedMoney((target[id] ?? 0) + finiteOr(value, 0));
  }
}

function mergeBounds(target, source) {
  if (Number.isFinite(source.journeyStart)
    && (!Number.isFinite(target.journeyStart) || source.journeyStart < target.journeyStart)) {
    target.journeyStart = source.journeyStart;
  }
  if (Number.isFinite(source.journeyEnd)
    && (!Number.isFinite(target.journeyEnd) || source.journeyEnd > target.journeyEnd)) {
    target.journeyEnd = source.journeyEnd;
  }
}

function ownInitialProfile(profile) {
  return { ...profile,
    modeChoicePopulation: { ...profile.modeChoicePopulation },
    ridershipByRoute: { ...profile.ridershipByRoute },
    routingStats: { ...profile.routingStats },
    hourly: profile.hourly.map(bucket => ({ ...bucket,
      revenueByRoute: { ...bucket.revenueByRoute },
      ...(bucket.financeOwnedRevenueByRoute
        ? { financeOwnedRevenueByRoute: { ...bucket.financeOwnedRevenueByRoute } } : {}),
      ...(Array.isArray(bucket.completedCommutes)
        ? { completedCommutes: bucket.completedCommutes.slice() } : {}),
    })),
  };
}

/** Create one merger per native-demand job and dispose it in a finally block.
 *
 * Retains one group per existing ledger record, rather than rebuilding every
 * old group after every input batch. Hourly arrays materialize only when read
 * (JSON.stringify and structuredClone read enumerable getters normally).
 * Every batch still applies the original cap, sort, overflow representative,
 * insertion order, and cent-rounding semantics. There is no delayed cap or
 * accumulation of historical batches. Overflow is deliberately still O(cap).
 *
 * The first profile's mutable containers are copied; incoming batches stay
 * untouched and can be serialized independently. Route arrays and other record
 * payloads are immutable inputs shared with the accumulator. The accumulator
 * belongs exclusively to this merger until finalize(profile) returns plain
 * arrays for publishing. Do not edit it or its source payloads while merging.
 * dispose() discards unpublished lazy ledgers without allocating final rows;
 * successful callers must finalize before disposal.
 */
export function createIncrementalNativeDemandProfileMerger({ maxRecords = MAX_COMPLETED_COMMUTE_RECORDS } = {}) {
  const cap = Math.max(1, Math.floor(maxRecords) || MAX_COMPLETED_COMMUTE_RECORDS);
  let states = new WeakMap();
  let routeKeys = new WeakMap();
  // Only buckets with active lazy state are retained. Finalize removes them;
  // dispose handles an interrupted or failed job that did not reach finalize.
  const activeBuckets = new Set();
  let disposed = false;
  const stats = { mergedProfiles: 0, incomingRecords: 0, initializedRecords: 0,
    materializations: 0, overflowPasses: 0, maximumGroupsPerHour: 0,
    activeHourBuckets: 0, disposed: false };

  function routeKey(routes) {
    if (routes && typeof routes === 'object') {
      let entry = routeKeys.get(routes);
      if (!entry) routeKeys.set(routes, entry = hashText(routeSignature(routes)));
      return entry;
    }
    return hashText(routeSignature(routes));
  }

  function addRecord(state, record) {
    if (!record || typeof record !== 'object') return;
    const origin = record.origin ?? 'home';
    const bucket = hourBucketOf(record.journeyStart);
    const signatureHash = routeKey(record.stationRoutes);
    const key = `${origin}|${bucket}|${signatureHash}`;
    let group = state.groups.get(key);
    if (!group) {
      state.groups.set(key, group = { key, origin, bucket, signatureHash,
        base: record, stationRoutes: record.stationRoutes,
        journeyStart: record.journeyStart, journeyEnd: record.journeyEnd,
        size: 0, fareRevenue: 0, hasFare: false, revenueByRoute: null,
        count: 0, countEpoch: state.epoch, overflowEpoch: -1 });
    }
    // The reference re-reads each prior aggregate as exactly one record.
    // Epochs reproduce that count without visiting untouched groups.
    if (group.countEpoch !== state.epoch) {
      group.count = 1;
      group.countEpoch = state.epoch;
    }
    group.count++;
    group.size += Math.max(0, finiteOr(record.size, 0));
    group.hasFare ||= record.fareRevenue != null || record.revenueByRoute != null;
    group.fareRevenue = roundedMoney(group.fareRevenue + finiteOr(record.fareRevenue, 0));
    if (record.revenueByRoute) mergeRevenue(group.revenueByRoute ??= {}, record.revenueByRoute);
    mergeBounds(group, record);
  }

  const groupCount = (state, group) => group.countEpoch === state.epoch ? group.count : 1;

  function applyCap(state) {
    if (state.groups.size <= cap) return;
    stats.overflowPasses++;
    const ordered = [...state.groups.values()].sort((a, b) => b.size - a.size
      || groupCount(state, b) - groupCount(state, a));
    const kept = ordered.slice(0, cap);
    const byOrigin = new Map();
    for (let i = cap; i < ordered.length; i++) {
      const group = ordered[i];
      const key = `${group.origin}|${group.bucket}`;
      let slot = byOrigin.get(key);
      if (!slot) {
        byOrigin.set(key, slot = { ...group, overflowEpoch: state.epoch,
          count: groupCount(state, group), countEpoch: state.epoch, largest: undefined,
          revenueByRoute: group.revenueByRoute ? { ...group.revenueByRoute } : null });
      } else {
        slot.count += groupCount(state, group);
        slot.size += group.size;
        slot.fareRevenue = roundedMoney(slot.fareRevenue + group.fareRevenue);
        slot.hasFare ||= group.hasFare;
        if (group.revenueByRoute) mergeRevenue(slot.revenueByRoute ??= {}, group.revenueByRoute);
        mergeBounds(slot, group);
        // Mirror the current reference exactly, including its first replacement
        // of the representative on the second swallowed route group.
        if (group.size > (slot.largest ?? -1)) {
          slot.largest = group.size;
          slot.stationRoutes = group.stationRoutes;
          slot.base = group.base;
          slot.signatureHash = group.signatureHash;
          slot.key = group.key;
        }
      }
    }
    state.groups = new Map([...kept, ...byOrigin.values()].map(group => [group.key, group]));
  }

  function materialize(state) {
    if (state.materialized) return state.materialized;
    stats.materializations++;
    state.materialized = [...state.groups.values()].map(group => {
      const prefix = group.overflowEpoch === state.epoch ? 'agg-v1:overflow' : 'agg-v1';
      const record = { ...group.base, popId: `${prefix}:${group.origin}:${group.bucket}:${group.signatureHash}`,
        size: group.size, stationRoutes: group.stationRoutes, journeyStart: group.journeyStart,
        journeyEnd: group.journeyEnd, origin: group.origin };
      if (group.hasFare) {
        record.fareRevenue = group.fareRevenue;
        if (group.revenueByRoute) record.revenueByRoute = { ...group.revenueByRoute };
      } else {
        delete record.fareRevenue;
        delete record.revenueByRoute;
      }
      return record;
    });
    return state.materialized;
  }

  function mergeRecords(bucket, incoming = []) {
    let state = states.get(bucket);
    if (!state) {
      const prior = bucket.completedCommutes ?? [];
      if (prior.length + incoming.length <= 1) {
        bucket.completedCommutes ??= [];
        for (const record of incoming) bucket.completedCommutes.push(record);
        return;
      }
      state = { groups: new Map(), epoch: 0, materialized: null };
      stats.initializedRecords += prior.length;
      for (const record of prior) addRecord(state, record);
      states.set(bucket, state);
      activeBuckets.add(bucket);
      stats.activeHourBuckets = activeBuckets.size;
      Object.defineProperty(bucket, 'completedCommutes', { enumerable: true, configurable: true,
        get: () => materialize(state),
        set: value => {
          states.delete(bucket);
          activeBuckets.delete(bucket);
          stats.activeHourBuckets = activeBuckets.size;
          Object.defineProperty(bucket, 'completedCommutes', { value, writable: true, enumerable: true, configurable: true });
        },
      });
    } else {
      if (state.groups.size + incoming.length <= 1) return;
      state.epoch++;
      state.materialized = null;
    }
    stats.incomingRecords += incoming.length;
    for (const record of incoming) addRecord(state, record);
    applyCap(state);
    stats.maximumGroupsPerHour = Math.max(stats.maximumGroupsPerHour, state.groups.size);
  }

  const add = (a, b) => { for (const [key, value] of Object.entries(b ?? {})) a[key] = (a[key] ?? 0) + value; };
  function merge(target, profile) {
    if (disposed) throw new Error('Cannot merge profiles after disposing the native-demand merger');
    stats.mergedProfiles++;
    if (!target) return ownInitialProfile(profile);
    for (const key of ['transitPopulation', 'dailyRevenue', 'customCrossTileRevenue', 'nativeRevenue',
      'evaluatedPops', 'skippedPops', 'transitViablePops']) target[key] += profile[key];
    add(target.modeChoicePopulation, profile.modeChoicePopulation);
    add(target.ridershipByRoute, profile.ridershipByRoute);
    const retained = Math.max(target.routingStats.retainedSearchLabels ?? 0, profile.routingStats.retainedSearchLabels ?? 0);
    add(target.routingStats, profile.routingStats);
    target.routingStats.retainedSearchLabels = retained;
    for (let i = 0; i < 24; i++) {
      const a = target.hourly[i], b = profile.hourly[i];
      a.revenue += b.revenue;
      add(a.revenueByRoute, b.revenueByRoute);
      if (b.financeOwnedRevenue != null) a.financeOwnedRevenue = (a.financeOwnedRevenue ?? 0) + b.financeOwnedRevenue;
      if (b.financeOwnedRevenueByRoute) add(a.financeOwnedRevenueByRoute ??= {}, b.financeOwnedRevenueByRoute);
      // Preserve the absence of the field when neither input has a ledger.
      if (states.has(a) || Array.isArray(a.completedCommutes) || b.completedCommutes) {
        mergeRecords(a, b.completedCommutes ?? []);
      }
    }
    return target;
  }
  merge.stats = stats;
  // Return ordinary arrays before publishing or allowing consumer mutations.
  merge.finalize = profile => {
    for (const bucket of profile?.hourly ?? []) {
      const state = states.get(bucket);
      if (state) bucket.completedCommutes = materialize(state);
    }
    return profile;
  };
  merge.dispose = () => {
    if (disposed) return;
    // Failed jobs have no published result. Release their getter closures and
    // groups without allocating all final rows while already under pressure.
    for (const bucket of activeBuckets) bucket.completedCommutes = [];
    activeBuckets.clear();
    states = new WeakMap();
    routeKeys = new WeakMap();
    disposed = true;
    stats.activeHourBuckets = 0;
    stats.disposed = true;
  };
  return merge;
}
