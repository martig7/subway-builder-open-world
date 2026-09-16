/** Bounded completed-commute ledger.
 *
 * High-speed simulation can produce one commute record per pop per direction
 * per hour (tens of thousands of rows with unique temporal identities). The
 * native save then carries ~100 MB of nearly duplicate route lists, and the
 * synchronous save path clones, hashes and stringifies every row. Only summed
 * sizes and summed fares affect finance and ridership; per-pop traceability
 * is worker detail, not save authority.
 *
 * Aggregation groups records by (origin, departure-hour bucket, route set)
 * and sums sizes and fares exactly. Pop IDs are deterministic derivations of
 * the group key so retried postings deduplicate in NativeCommuteIndex instead
 * of doubling the ledger.
 */
export const COMPLETED_COMMUTE_AGGREGATION_VERSION = 'completed-commute-aggregation-v1';
export const MAX_COMPLETED_COMMUTE_RECORDS = 2048;

function hashText(value) {
  let hash = 2_166_136_261;
  const text = String(value);
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function routeSignature(stationRoutes) {
  if (!Array.isArray(stationRoutes) || stationRoutes.length === 0) return 'direct';
  let key = '';
  for (const segment of stationRoutes) {
    const ids = Array.isArray(segment?.stationIds) ? segment.stationIds : [];
    key += `|${segment?.routeId ?? '?'}:${ids.join('>')}`;
  }
  return key;
}

const hourBucketOf = value => Number.isFinite(value) ? Math.floor(value / 3600) : -1;
const finiteOr = (value, fallback) => Number.isFinite(value) ? value : fallback;
const roundedMoney = value => Math.round(finiteOr(value, 0) * 100) / 100;

function mergeRevenue(target, source) {
  if (source == null) return;
  for (const [routeId, amount] of Object.entries(source)) {
    target[routeId] = roundedMoney((target[routeId] ?? 0) + finiteOr(amount, 0));
  }
}

/** Aggregate one hourly bucket (or one posting payload) in place-safe form.
 * Returns the input array untouched when it is already small; otherwise
 * returns a new array with at most maxRecords summary records. Values are
 * preserved: sizes, fareRevenue and revenueByRoute are summed, never
 * re-rounded except to cents like the producers. */
export function aggregateCompletedCommutes(records, { maxRecords = MAX_COMPLETED_COMMUTE_RECORDS } = {}) {
  if (!Array.isArray(records) || records.length <= 1) return records;
  const cap = Math.max(1, Math.floor(maxRecords) || MAX_COMPLETED_COMMUTE_RECORDS);
  const groups = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const origin = record.origin ?? 'home';
    const bucket = hourBucketOf(record.journeyStart);
    const signature = routeSignature(record.stationRoutes);
    const key = `${origin}|${bucket}|${hashText(signature)}`;
    let group = groups.get(key);
    if (!group) {
      groups.set(key, group = { key, origin, bucket, signature,
        base: record, stationRoutes: record.stationRoutes,
        journeyStart: record.journeyStart, journeyEnd: record.journeyEnd,
        size: 0, fareRevenue: 0, hasFare: false, revenueByRoute: null, count: 0 });
    }
    group.count++;
    group.size += Math.max(0, finiteOr(record.size, 0));
    if (record.fareRevenue != null || record.revenueByRoute != null) group.hasFare = true;
    group.fareRevenue = roundedMoney(group.fareRevenue + finiteOr(record.fareRevenue, 0));
    if (record.revenueByRoute) {
      group.revenueByRoute ??= {};
      mergeRevenue(group.revenueByRoute, record.revenueByRoute);
    }
    if (Number.isFinite(record.journeyStart)
      && (!Number.isFinite(group.journeyStart) || record.journeyStart < group.journeyStart)) {
      group.journeyStart = record.journeyStart;
    }
    if (Number.isFinite(record.journeyEnd)
      && (!Number.isFinite(group.journeyEnd) || record.journeyEnd > group.journeyEnd)) {
      group.journeyEnd = record.journeyEnd;
    }
  }
  if (groups.size === 0) return records;
  let finals = [...groups.values()];
  if (finals.length > cap) {
    finals.sort((left, right) => right.size - left.size || right.count - left.count);
    const kept = finals.slice(0, cap);
    const overflow = finals.slice(cap);
    const byOrigin = new Map();
    for (const group of overflow) {
      let slot = byOrigin.get(`${group.origin}|${group.bucket}`);
      if (!slot) {
        byOrigin.set(`${group.origin}|${group.bucket}`, slot = { ...group, overflow: true,
          journeyStart: group.journeyStart, journeyEnd: group.journeyEnd,
          revenueByRoute: group.revenueByRoute ? { ...group.revenueByRoute } : null });
      } else {
        slot.count += group.count;
        slot.size += group.size;
        slot.fareRevenue = roundedMoney(slot.fareRevenue + group.fareRevenue);
        slot.hasFare ||= group.hasFare;
        if (group.revenueByRoute) {
          slot.revenueByRoute ??= {};
          mergeRevenue(slot.revenueByRoute, group.revenueByRoute);
        }
        if (Number.isFinite(group.journeyStart)
          && (!Number.isFinite(slot.journeyStart) || group.journeyStart < slot.journeyStart)) {
          slot.journeyStart = group.journeyStart;
        }
        if (Number.isFinite(group.journeyEnd)
          && (!Number.isFinite(slot.journeyEnd) || group.journeyEnd > slot.journeyEnd)) {
          slot.journeyEnd = group.journeyEnd;
        }
        // Keep the largest swallowed route set so attribution stays plausible.
        if (group.size > (slot.largest ?? -1)) {
          slot.largest = group.size;
          slot.stationRoutes = group.stationRoutes;
          slot.base = group.base;
          slot.signature = group.signature;
          slot.key = group.key;
        }
      }
    }
    finals = [...kept, ...byOrigin.values()];
  }
  return finals.map(group => {
    const record = { ...group.base,
      popId: group.overflow
        ? `agg-v1:overflow:${group.origin}:${group.bucket}:${hashText(group.signature)}`
        : `agg-v1:${group.origin}:${group.bucket}:${hashText(group.signature)}`,
      size: group.size,
      stationRoutes: group.stationRoutes,
      journeyStart: group.journeyStart,
      journeyEnd: group.journeyEnd,
      origin: group.origin,
    };
    if (group.hasFare) {
      record.fareRevenue = group.fareRevenue;
      if (group.revenueByRoute) record.revenueByRoute = group.revenueByRoute;
    } else {
      delete record.fareRevenue;
      delete record.revenueByRoute;
    }
    return record;
  });
}

/** Append one commute to a pending attribution ledger, compacting in place
 * once the ledger exceeds twice the cap. Amortized bounded; callers keep
 * pushing during dispatch without an O(n^2) re-aggregation per record. */
export function appendCompletedCommute(pending, record, { maxRecords = MAX_COMPLETED_COMMUTE_RECORDS } = {}) {
  const list = pending.completedCommutes ??= [];
  list.push(record);
  if (list.length > Math.max(8, Math.floor(maxRecords) * 2 || MAX_COMPLETED_COMMUTE_RECORDS * 2)) {
    pending.completedCommutes = aggregateCompletedCommutes(list, { maxRecords });
  }
  return pending;
}
