import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeNativeDemandProfiles } from '../src/runtime/off-tile-native-demand.js';
import { aggregateCompletedCommutes, MAX_COMPLETED_COMMUTE_RECORDS } from '../src/runtime/completed-commute-aggregation.js';
import { createIncrementalNativeDemandProfileMerger } from '../src/runtime/incremental-commute-aggregation.js';

function profile(rows = []) {
  const hourly = Array.from({ length: 24 }, () => ({ revenue: 0, revenueByRoute: {}, completedCommutes: [] }));
  for (const { hour = 7, ...row } of rows) {
    const bucket = hourly[hour];
    bucket.completedCommutes.push(row);
    bucket.revenue += row.fareRevenue ?? 0;
    for (const [id, value] of Object.entries(row.revenueByRoute ?? {})) {
      bucket.revenueByRoute[id] = (bucket.revenueByRoute[id] ?? 0) + value;
    }
  }
  for (const bucket of hourly) bucket.completedCommutes = aggregateCompletedCommutes(bucket.completedCommutes);
  return { transitPopulation: rows.reduce((sum, row) => sum + row.size, 0),
    dailyRevenue: hourly.reduce((sum, bucket) => sum + bucket.revenue, 0),
    customCrossTileRevenue: 0, nativeRevenue: 0, evaluatedPops: rows.length, skippedPops: 0,
    transitViablePops: rows.length, modeChoicePopulation: { transit: rows.length, walking: 3, driving: 4 },
    ridershipByRoute: { r: rows.length }, routingStats: { searches: rows.length, retainedSearchLabels: rows.length }, hourly };
}

function record(index, overrides = {}) {
  return { popId: `p${index}`, size: 3 + index % 9, fareRevenue: (100 + index % 401) / 100,
    revenueByRoute: { r: (20 + index % 67) / 100 }, origin: 'home',
    journeyStart: 25200 + index % 3000, journeyEnd: 25800 + index % 7000,
    stationRoutes: [{ routeId: `r${index % 100}`, stationIds: ['a', `s${index % 100}`, 'b'] }],
    ...overrides };
}

const plain = value => structuredClone(value);

test('incremental merger preserves every batch, exact money, original fields, and output snapshots', () => {
  const merge = createIncrementalNativeDemandProfileMerger();
  let expected = null, actual = null;
  let snapshot, snapshotCopy;
  for (let batch = 0; batch < 45; batch++) {
    const input = profile(Array.from({ length: 31 }, (_, i) => {
      const index = batch * 31 + i;
      return record(index, { origin: index % 3 ? 'home' : 'work', customField: `first-${index}`,
        fareRevenue: index % 7 ? (index % 39) / 100 : 1.005,
        revenueByRoute: index % 4 ? { r: (index % 33) / 100, s: 0.005 } : null,
        size: (index % 8) / 3, hour: index % 6 + 4 });
    }));
    expected = mergeNativeDemandProfiles(expected, plain(input));
    actual = merge(actual, plain(input));
    assert.deepEqual(plain(actual), expected, `batch ${batch}`);
    if (batch === 12) {
      snapshot = actual.hourly[7].completedCommutes;
      snapshotCopy = plain(snapshot);
    }
    if (batch > 12) assert.deepEqual(snapshot, snapshotCopy, 'later batches must not mutate earlier materialized rows');
  }
  assert.ok(merge.stats.initializedRecords < merge.stats.incomingRecords);
});

test('lazy merger does not rebuild old groups or materialize untouched output after every batch', () => {
  const merge = createIncrementalNativeDemandProfileMerger();
  let expected = null, actual = null;
  for (let batch = 0; batch < 70; batch++) {
    const input = profile(Array.from({ length: 128 }, (_, i) => record(batch * 128 + i,
      { hour: i % 12, journeyStart: (i % 12) * 3600 + i })));
    expected = mergeNativeDemandProfiles(expected, plain(input));
    actual = merge(actual, plain(input));
  }
  assert.equal(merge.stats.materializations, 0);
  assert.ok(merge.stats.initializedRecords <= 128);
  assert.deepEqual(plain(actual), expected);
  assert.equal(merge.stats.materializations, 12);
});

test('cap overflow remains bounded and exactly matches sequential native merges, including stable tie order', () => {
  const merge = createIncrementalNativeDemandProfileMerger();
  let expected = null, actual = null;
  for (let batch = 0; batch < 34; batch++) {
    const input = profile(Array.from({ length: 128 }, (_, i) => {
      const index = batch * 128 + i;
      const route = index % 3100;
      return record(index, { size: 1 + index % 3, origin: index % 2 ? 'work' : 'home',
        stationRoutes: [{ routeId: `r${route}`, stationIds: [`a${route}`, `b${route}`] }] });
    }));
    expected = mergeNativeDemandProfiles(expected, plain(input));
    actual = merge(actual, plain(input));
    assert.deepEqual(plain(actual), expected, `overflow batch ${batch}`);
    assert.ok(actual.hourly[7].completedCommutes.length <= MAX_COMPLETED_COMMUTE_RECORDS + 2);
  }
  // Empty later batches still re-normalize previous overflow records exactly.
  for (let batch = 0; batch < 3; batch++) {
    expected = mergeNativeDemandProfiles(expected, profile());
    actual = merge(actual, profile());
    assert.deepEqual(plain(actual), expected, `empty batch ${batch}`);
  }
  assert.ok(merge.stats.overflowPasses > 0);
  assert.ok(merge.stats.maximumGroupsPerHour <= MAX_COMPLETED_COMMUTE_RECORDS + 2);
});

test('single records, absent ledgers, and separately evaluated jobs keep baseline shape', () => {
  const merge = createIncrementalNativeDemandProfileMerger();
  let actual = merge(null, profile([record(1)]));
  let expected = plain(actual);
  const empty = profile();
  for (const hour of empty.hourly) delete hour.completedCommutes;
  actual = merge(actual, plain(empty));
  expected = mergeNativeDemandProfiles(expected, plain(empty));
  assert.deepEqual(plain(actual), expected);
  assert.equal(actual.hourly[7].completedCommutes[0].popId, 'p1');
  const nextJob = merge(merge(null, profile([record(2), record(3)])), profile([record(4)]));
  const nextExpected = mergeNativeDemandProfiles(profile([record(2), record(3)]), profile([record(4)]));
  assert.deepEqual(plain(nextJob), nextExpected);
  const absent = profile();
  for (const hour of absent.hourly) delete hour.completedCommutes;
  assert.deepEqual(plain(merge(plain(absent), profile([record(2), record(3)]))),
    mergeNativeDemandProfiles(plain(absent), profile([record(2), record(3)])));
});

test('finalizing releases lazy state and allows plain arrays to be mutated or merged again', () => {
  const merge = createIncrementalNativeDemandProfileMerger();
  const first = profile([record(2), record(3)]), second = profile([record(4), record(5)]);
  const expected = mergeNativeDemandProfiles(plain(first), plain(second));
  const actual = merge(plain(first), plain(second));
  assert.equal(typeof Object.getOwnPropertyDescriptor(actual.hourly[7], 'completedCommutes').get, 'function');
  assert.equal(merge.finalize(actual), actual);
  assert.deepEqual(actual, expected);
  assert.equal(Object.getOwnPropertyDescriptor(actual.hourly[7], 'completedCommutes').get, undefined);
  assert.equal(merge.finalize(actual), actual, 'finalization must be idempotent');
  actual.hourly[7].completedCommutes.push(record(6));
  expected.hourly[7].completedCommutes.push(record(6));
  assert.deepEqual(plain(merge(actual, profile([record(7)]))),
    mergeNativeDemandProfiles(expected, profile([record(7)])));
});

test('batch serialization owns its containers independently of subsequent accumulation', () => {
  const merge = createIncrementalNativeDemandProfileMerger();
  const batches = [profile([record(2), record(3)]), profile([record(4), record(5)]), profile([record(6)])];
  for (const batch of batches) {
    for (const bucket of batch.hourly) {
      Object.freeze(bucket.revenueByRoute);
      Object.freeze(bucket.completedCommutes);
      Object.freeze(bucket);
    }
    Object.freeze(batch.hourly);
    Object.freeze(batch.modeChoicePopulation);
    Object.freeze(batch.ridershipByRoute);
    Object.freeze(batch.routingStats);
    Object.freeze(batch);
  }
  const serialized = batches.map(batch => JSON.stringify(batch));
  let result = null;
  for (const batch of batches) result = merge(result, batch);
  assert.notEqual(result, batches[0]);
  assert.deepEqual(batches.map(batch => JSON.stringify(batch)), serialized);
  const expected = batches.reduce((target, batch) => mergeNativeDemandProfiles(target, plain(batch)), null);
  merge.finalize(result);
  assert.equal(merge.stats.activeHourBuckets, 0);
  merge.dispose();
  assert.deepEqual(result, expected, 'disposing a finalized job must preserve its result');
});

test('disposal releases abandoned work without materializing rows and rejects reuse', () => {
  const merge = createIncrementalNativeDemandProfileMerger();
  const result = merge(merge(null, profile([record(2), record(3)])), profile([record(4)]));
  assert.ok(merge.stats.activeHourBuckets > 0);
  assert.equal(merge.stats.materializations, 0);
  merge.dispose();
  assert.equal(merge.stats.activeHourBuckets, 0);
  assert.equal(merge.stats.materializations, 0, 'failure cleanup must not allocate final ledger rows');
  assert.equal(merge.stats.disposed, true);
  assert.deepEqual(result.hourly[7].completedCommutes, [], 'unpublished accumulator is discarded');
  assert.equal(Object.getOwnPropertyDescriptor(result.hourly[7], 'completedCommutes').get, undefined);
  assert.doesNotThrow(() => merge.dispose());
  assert.throws(() => merge(null, profile()), /after disposing/);
});
