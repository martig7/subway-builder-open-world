import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareNativeTileRestoreSnapshot } from '../src/runtime/adapters/subway-builder-game-adapter.js';
import { stageNativeRecovery } from '../src/runtime/native-reload-recovery.js';

test('tile snapshots and recovery handoffs share repeated historical routes without changing values or source data', async () => {
  const path = [{ routeId: 'R', stationIds: ['a', 'b'] }];
  const snapshot = { cityCode: 'old', data: { tracks: [], routes: [], trains: [],
    completedCommutes: [{ popId: 'one', stationRoutes: structuredClone(path) },
      { popId: 'two', stationRoutes: structuredClone(path) }] } };
  const before = structuredClone(snapshot);
  const captured = prepareNativeTileRestoreSnapshot(snapshot, { cityCode: 'old' });
  let handoff;
  await stageNativeRecovery({ snapshot, destinationCityCode: 'next',
    electron: { setPendingSave: async value => { handoff = value; return { success: true }; } } });
  for (const result of [captured, handoff]) {
    assert.equal(JSON.stringify(result.data), JSON.stringify(before.data));
    assert.equal(result.data.completedCommutes[0].stationRoutes, result.data.completedCommutes[1].stationRoutes);
    assert.notEqual(result.data.completedCommutes[0].stationRoutes, snapshot.data.completedCommutes[0].stationRoutes);
  }
  captured.data.completedCommutes[0].stationRoutes[0].stationIds.push('c');
  assert.deepEqual(snapshot, before);
  assert.deepEqual(handoff.data, before.data);
});

test('restoring finance skips overwritten history and traverses retained history once', () => {
  let oldReads = 0, newReads = 0;
  const oldEntry = { get revenue() { oldReads++; return 1; } };
  const newEntry = { get revenue() { newReads++; return 2; } };
  const snapshot = { cityCode: 'old', data: { financialHistory: { entries: [oldEntry] }, tracks: [{ id: 'track' }] } };
  const current = { money: 50, financialHistory: { entries: [newEntry], lastHourTimestamp: 12 },
    routeFinancials: { route: { revenue: 2 } } };
  const result = prepareNativeTileRestoreSnapshot(snapshot, {
    cityCode: 'next', preserveNativeFinance: true, authoritativeFinanceState: current,
  });
  assert.equal(oldReads, 0);
  assert.equal(newReads, 1);
  assert.equal(result.data.financialHistory.entries[0].revenue, 2);
  assert.equal(result.data.routeFinancials.byRoute.route.revenue, 2);
  assert.equal(result.data.routeFinancials.lastHourTimestamp, 12);
  result.data.tracks[0].id = 'changed';
  result.data.routeFinancials.byRoute.route.revenue = 99;
  assert.equal(snapshot.data.tracks[0].id, 'track');
  assert.equal(current.routeFinancials.route.revenue, 2);
});

test('binds destination metadata, takes preferred finance with native fallback, and isolates every payload', () => {
  const snapshot = { cityCode: 'old', cityUid: 'old-uid', metadata: { cityCode: 'old', cityUid: 'old-uid', money: 1 },
    data: { cityCode: 'old', cityUid: 'old-uid', routes: [{ id: 'R', nodes: [1] }], money: 1,
      bonds: [{ balance: 1 }], hasGoneBankrupt: true } };
  const preferred = { money: 100, bonds: [{ balance: 25 }], routeFinancials: { byRoute: { R: { revenue: 4 } } },
    financialHistory: { entries: [{ revenue: 4 }], lastHourTimestamp: 30 },
    compressedDemandData: { c: [{ p: 'pop', s: 10, sr: ['R'], js: 1, je: 2, o: 'home' }] } };
  const fallback = { gameMode: 'sandbox', fareGroups: [{ fare: 2.5 }] };
  const result = prepareNativeTileRestoreSnapshot(snapshot, { cityCode: 'next', cityUid: 'next-uid',
    preserveNativeFinance: true, authoritativeFinanceState: preferred, fallbackState: fallback,
    preserveCompletedCommutes: true });
  assert.equal(result.cityCode, 'next'); assert.equal(result.cityUid, 'next-uid');
  assert.equal(result.data.cityCode, 'next'); assert.equal(result.metadata.cityUid, 'next-uid');
  assert.equal(result.data.money, 100); assert.equal(result.metadata.money, 100);
  assert.equal(result.data.gameMode, 'sandbox'); assert.equal(result.data.hasGoneBankrupt, undefined);
  assert.deepEqual(result.data.completedCommutes, [{ popId: 'pop', size: 10, stationRoutes: ['R'], journeyStart: 1, journeyEnd: 2, origin: 'home' }]);
  result.data.routes[0].nodes.push(2); result.data.bonds[0].balance = 0;
  result.data.fareGroups[0].fare = 0; result.data.completedCommutes[0].stationRoutes.push('X');
  assert.deepEqual(snapshot.data.routes[0].nodes, [1]); assert.equal(snapshot.cityCode, 'old');
  assert.equal(preferred.bonds[0].balance, 25); assert.equal(fallback.fareGroups[0].fare, 2.5);
  assert.deepEqual(preferred.compressedDemandData.c[0].sr, ['R']);
});

test('ordinary snapshot capture preserves finance values and absence of optional city fields', () => {
  const snapshot = { cityCode: 'old', metadata: { money: 10 }, data: { money: 10, routes: [{ id: 'R' }], routeFinancials: { legacy: 1 } } };
  const result = prepareNativeTileRestoreSnapshot(snapshot, { cityCode: 'next' });
  assert.deepEqual(result.data, snapshot.data);
  assert.equal(result.data.cityCode, undefined); assert.equal(result.metadata.cityCode, undefined);
  result.data.routes[0].id = 'other';
  assert.equal(snapshot.data.routes[0].id, 'R');
});
