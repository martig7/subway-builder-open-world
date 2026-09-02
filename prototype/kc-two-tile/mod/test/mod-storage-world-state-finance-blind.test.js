import test from 'node:test';
import assert from 'node:assert/strict';
import { ModStorageWorldStateAdapter } from '../../../../open-world-platform/src/runtime/adapters/mod-storage-world-state-adapter.js';
import { createWorld } from '../../../../open-world-platform/src/runtime/world-model.js';

function addFinanceState(world) {
  world.wallet = 12_345;
  world.financialHistory = { currentHourRevenue: 700, currentHourExpenses: 300 };
  world.backgroundNativeFinance = {
    schemaVersion: 2,
    lastSettledHour: 8,
    lastRevenueSettledHour: 8,
    lastExpenseSettledHour: 8,
    tileRevenueProfiles: { KCE: { dailyRevenue: 16_800 } },
    totalRevenue: 700,
    totalExpenses: 300,
  };
  world.crossTileFinancials = { transitTrips: 10, fareRevenue: 500, pendingNativeRevenue: 500 };
  world.pendingCrossTileAttribution = { revenueByRoute: { R1: 500 }, completedCommutes: ['flow-1'] };
  world.settlementAccountingSchemaVersion = 2;
  world.settlementFinanceQuarantine = { message: 'legacy recovery state' };
  world.tiles.KCW.aggregate = { ridership: 44, revenue: 900, operatingCost: 400, backlog: 3 };
  world.tiles.KCW.lastRevenueSettledHour = 8;
  world.tiles.KCW.lastExpenseSettledHour = 8;
  return world;
}

function assertFinanceAbsent(world) {
  for (const field of [
    'wallet',
    'financialHistory',
    'backgroundNativeFinance',
    'crossTileFinancials',
    'pendingCrossTileAttribution',
    'settlementAccountingSchemaVersion',
    'settlementFinanceQuarantine',
  ]) assert.equal(field in world, false, `${field} must be absent`);
  assert.deepEqual(world.tiles.KCW.aggregate, { ridership: 44, backlog: 3 });
  assert.equal('lastRevenueSettledHour' in world.tiles.KCW, false);
  assert.equal('lastExpenseSettledHour' in world.tiles.KCW, false);
  if (world.gatewayLedger.flow) {
    assert.equal('fareRevenue' in world.gatewayLedger.flow, false);
    assert.equal(world.gatewayLedger.flow.transitTrips, 4);
  }
}

test('finance mode rejects unknown values while legacy remains the default', async () => {
  assert.throws(
    () => new ModStorageWorldStateAdapter({ financeMode: 'sometimes' }),
    /finance mode/i,
  );

  const storage = new Map();
  const adapter = new ModStorageWorldStateAdapter({ storage });
  const world = addFinanceState(createWorld({ worldId: 'legacy-default', tileIds: ['KCW', 'KCE'] }));
  await adapter.save(world);

  assert.equal((await adapter.load(world.worldId)).wallet, 12_345);
  assert.equal((await adapter.load(world.worldId)).backgroundNativeFinance.totalRevenue, 700);
});

test('blind mode excludes finance from live revisions and returns only nonfinancial world state', async () => {
  const storage = new Map();
  const adapter = new ModStorageWorldStateAdapter({
    storage,
    financeMode: 'blind',
    createRevisionId: () => 'blind-live-revision',
  });
  const world = addFinanceState(createWorld({ worldId: 'blind-live', tileIds: ['KCW', 'KCE'] }));
  world.globalNetwork = {
    hash: 'network-1',
    nativeState: { tracks: [{ id: 'track-1' }], routes: [{ id: 'route-1' }] },
  };
  world.tiles.KCW.snapshot = {
    id: 'tile-snapshot-with-stale-finance',
    cityCode: 'KCW',
    data: {
      tracks: [{ id: 'track-1' }], routes: [{ id: 'route-1' }], stations: [], trains: [],
      money: 403_000_000,
      financialHistory: { currentHourExpenses: 100_000_000 },
      routeFinancials: { currentHour: { 'route-1': { expenses: 100_000_000 } } },
      bonds: [{ id: 'stale-bond' }],
    },
  };
  world.pendingTransition = { id: 'transition-1', toTileId: 'KCE' };

  await adapter.save(world);

  const pointer = storage.get('world:blind-live');
  const revision = storage.get('world:blind-live:revision:blind-live-revision');
  assert.equal('wallet' in pointer, false);
  assert.equal('money' in pointer, false);
  assertFinanceAbsent(revision.world);

  const loaded = await adapter.load(world.worldId);
  assertFinanceAbsent(loaded);
  assert.equal(loaded.globalNetwork, undefined);
  assert.deepEqual(loaded.pendingTransition, { id: 'transition-1', toTileId: 'KCE' });
  assert.equal(loaded.tiles.KCW.snapshot, undefined);
});

test('blind mode ignores legacy finance during checkpoint and settlement hydration', async () => {
  const storage = new Map();
  let revisionSequence = 0;
  const adapter = new ModStorageWorldStateAdapter({
    storage,
    financeMode: 'blind',
    createRevisionId: () => `blind-checkpoint-${++revisionSequence}`,
  });
  const world = addFinanceState(createWorld({
    worldId: 'blind-checkpoint',
    tileIds: ['KCW', 'KCE'],
    worldTime: 4,
  }));
  world.commuteCatalogBuildHash = 'commute-v1';
  world.gatewayLedger.flow = {
    atHome: 90,
    queuedToWork: 10,
    toWork: [],
    atWork: 0,
    queuedToHome: 0,
    toHome: [],
    transitTrips: 4,
    fareRevenue: 200,
  };
  await adapter.saveCheckpoint(world, 'Autosave');

  const index = storage.get('world:blind-checkpoint:save-checkpoints');
  const revisionKey = `world:blind-checkpoint:revision:${index.entries[0].revisionId}`;
  const legacyRevision = storage.get(revisionKey);
  Object.assign(legacyRevision.world, {
    wallet: 999_999,
    financialHistory: { currentHourRevenue: 999_999 },
    backgroundNativeFinance: { lastSettledHour: 99, totalRevenue: 999_999 },
    crossTileFinancials: { fareRevenue: 999_999 },
    pendingCrossTileAttribution: { revenueByRoute: { R1: 999_999 } },
    settlementAccountingSchemaVersion: 1,
    settlementFinanceQuarantine: { recovered: true },
  });
  legacyRevision.world.tiles.KCW.aggregate = {
    ridership: 44,
    backlog: 3,
    revenue: 999_999,
    operatingCost: 888_888,
  };
  legacyRevision.world.tiles.KCW.lastRevenueSettledHour = 99;
  storage.set(revisionKey, legacyRevision);

  storage.set('world:blind-checkpoint:settlement', {
    schemaVersion: 2,
    baseRevisionId: index.entries[0].revisionId,
    worldRevision: world.revision,
    commuteCatalogBuildHash: world.commuteCatalogBuildHash,
    worldTime: 6,
    elapsedSeconds: 6 * 3_600,
    wallet: 777_777,
    financialHistory: { currentHourExpenses: 777_777 },
    backgroundNativeFinance: { lastSettledHour: 77, totalExpenses: 777_777 },
    crossTileFinancials: { fareRevenue: 777_777 },
    pendingCrossTileAttribution: { revenueByRoute: { R2: 777_777 } },
    commuteLastProcessedHour: 6,
    commuteNextActivityHour: 7,
    gatewayPositions: {
      flow: { atHome: 80, queuedToWork: 20, transitTrips: 9, fareRevenue: 777_777 },
    },
    tileClocks: {
      KCW: {
        lastSimulatedTime: 6,
        aggregate: { ridership: 44, backlog: 3, revenue: 777_777, operatingCost: 666_666 },
      },
    },
  });

  const reloadedAdapter = new ModStorageWorldStateAdapter({ storage, financeMode: 'blind' });
  const loaded = await reloadedAdapter.load(world.worldId, { saveName: 'Autosave' });

  assertFinanceAbsent(loaded);
  assert.equal(loaded.worldTime, 4, 'named checkpoint clock remains authoritative');
  assert.equal(loaded.gatewayLedger.flow.atHome, 90);
  assert.equal(loaded.gatewayLedger.flow.queuedToWork, 10);
  assert.equal(loaded.commuteCatalogBuildHash, 'commute-v1');
});

test('blind settlement persistence keeps clocks and commute positions but no finance', async () => {
  const storage = new Map();
  const adapter = new ModStorageWorldStateAdapter({ storage, financeMode: 'blind' });
  const world = addFinanceState(createWorld({ worldId: 'blind-settlement', tileIds: ['KCW', 'KCE'] }));
  world.commuteCatalogBuildHash = 'commute-v1';
  world.gatewayLedger.flow = {
    atHome: 80,
    queuedToWork: 20,
    toWork: [],
    atWork: 0,
    queuedToHome: 0,
    toHome: [],
    transitTrips: 9,
    fareRevenue: 450,
  };
  await adapter.save(world);
  world.worldTime = 2;
  world.elapsedSeconds = 7_200;
  world.commuteLastProcessedHour = 2;
  world.tiles.KCW.lastSimulatedTime = 2;

  await adapter.saveSettlement(world);

  const settlement = storage.get('world:blind-settlement:settlement');
  for (const field of [
    'wallet', 'financialHistory', 'backgroundNativeFinance',
    'crossTileFinancials', 'pendingCrossTileAttribution',
  ]) assert.equal(field in settlement, false);
  assert.deepEqual(settlement.tileClocks.KCW.aggregate, { ridership: 44, backlog: 3 });
  assert.equal('fareRevenue' in settlement.gatewayPositions.flow, false);
  assert.equal(settlement.gatewayPositions.flow.atHome, 80);
  assert.equal(settlement.tileClocks.KCW.lastSimulatedTime, 2);
});
