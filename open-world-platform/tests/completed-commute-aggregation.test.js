import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCompletedCommutes, appendCompletedCommute,
  COMPLETED_COMMUTE_AGGREGATION_VERSION, MAX_COMPLETED_COMMUTE_RECORDS } from '../src/runtime/completed-commute-aggregation.js';

const routesA = [{ routeId: 'r', stationIds: ['a', 'b'] }];
const routesB = [{ routeId: 's', stationIds: ['b', 'c'] }];
const commute = (overrides = {}) => ({ popId: 'p', size: 10, stationRoutes: routesA,
  journeyStart: 25200, journeyEnd: 25800, origin: 'home', ...overrides });

test('aggregation preserves versioned finance totals while collapsing per-pop rows', () => {
  assert.equal(COMPLETED_COMMUTE_AGGREGATION_VERSION, 'completed-commute-aggregation-v1');
  const records = [
    commute({ popId: 'p1', size: 60, fareRevenue: 120, revenueByRoute: { r: 120 } }),
    commute({ popId: 'p2', size: 40, fareRevenue: 80, revenueByRoute: { r: 80 } }),
    commute({ popId: 'p3', size: 7, stationRoutes: routesB, fareRevenue: 14, revenueByRoute: { s: 14 } }),
    commute({ popId: 'p4', size: 5, stationRoutes: routesB, origin: 'work',
      journeyStart: 61200, journeyEnd: 61800, fareRevenue: 10, revenueByRoute: { s: 10 } }),
  ];
  const aggregated = aggregateCompletedCommutes(records);
  assert.equal(aggregated.length, 3);
  const home = aggregated.filter(record => record.origin === 'home');
  assert.equal(home.reduce((sum, record) => sum + record.size, 0), 107);
  assert.equal(home.reduce((sum, record) => sum + (record.fareRevenue ?? 0), 0), 214);
  assert.deepEqual(home.find(record => record.stationRoutes === routesA || record.stationRoutes?.[0]?.routeId === 'r').revenueByRoute, { r: 200 });
  assert.equal(aggregated.reduce((sum, record) => sum + record.size, 0), 112);
  // Deterministic group IDs let retried postings deduplicate instead of doubling.
  assert.ok(aggregated.every(record => record.popId.startsWith('agg-v1:')));
  assert.equal(new Set(aggregated.map(record => record.popId)).size, 3);
  assert.deepEqual(aggregateCompletedCommutes(aggregated).map(record => record.popId),
    aggregated.map(record => record.popId), 're-aggregation must be idempotent');
});

test('records without fares keep their shape and journey bounds span the group', () => {
  const aggregated = aggregateCompletedCommutes([
    commute({ popId: 'a', size: 3, journeyStart: 25200, journeyEnd: 25500 }),
    commute({ popId: 'b', size: 4, journeyStart: 25300, journeyEnd: 25900 }),
  ]);
  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].size, 7);
  assert.equal(aggregated[0].journeyStart, 25200);
  assert.equal(aggregated[0].journeyEnd, 25900);
  assert.equal(aggregated[0].origin, 'home');
  assert.equal('fareRevenue' in aggregated[0], false);
});

test('tiny ledgers pass through untouched and order does not change identities', () => {
  const single = [commute()];
  assert.equal(aggregateCompletedCommutes(single), single);
  assert.equal(aggregateCompletedCommutes([]).length, 0);
  const forward = aggregateCompletedCommutes([commute({ popId: 'a', size: 1 }), commute({ popId: 'b', size: 2, stationRoutes: routesB })]);
  const backward = aggregateCompletedCommutes([commute({ popId: 'b', size: 2, stationRoutes: routesB }), commute({ popId: 'a', size: 1 })]);
  assert.deepEqual(new Set(forward.map(record => record.popId)), new Set(backward.map(record => record.popId)));
  assert.equal(forward.reduce((sum, record) => sum + record.size, 0), 3);
});

test('the cap bounds groups and folds the tail into per-origin overflow summaries', () => {
  const records = Array.from({ length: 10 }, (_, i) => commute({ popId: `p${i}`, size: i + 1,
    stationRoutes: [{ routeId: `r${i}`, stationIds: [`s${i}`] }] }));
  const aggregated = aggregateCompletedCommutes(records, { maxRecords: 3 });
  assert.ok(aggregated.length <= 4, `cap 3 plus one overflow bucket, got ${aggregated.length}`);
  assert.equal(aggregated.reduce((sum, record) => sum + record.size, 0), 55);
  const overflow = aggregated.find(record => record.popId.includes('overflow'));
  assert.ok(overflow, 'tail must be summarized, not dropped');
  assert.equal(overflow.origin, 'home');
});

test('append bounds a dispatch ledger without losing rides or fares', () => {
  const pending = { completedCommutes: [] };
  for (let i = 0; i < MAX_COMPLETED_COMMUTE_RECORDS * 2 + 10; i++) {
    appendCompletedCommute(pending, commute({ popId: `p${i}`, size: 1, fareRevenue: 2,
      revenueByRoute: { r: 2 }, stationRoutes: [{ routeId: `r${i % 5}`, stationIds: ['a', 'b'] }] }));
  }
  assert.ok(pending.completedCommutes.length <= MAX_COMPLETED_COMMUTE_RECORDS);
  assert.equal(pending.completedCommutes.reduce((sum, record) => sum + record.size, 0),
    MAX_COMPLETED_COMMUTE_RECORDS * 2 + 10);
  assert.equal(pending.completedCommutes.reduce((sum, record) => sum + (record.fareRevenue ?? 0), 0),
    (MAX_COMPLETED_COMMUTE_RECORDS * 2 + 10) * 2);
});
