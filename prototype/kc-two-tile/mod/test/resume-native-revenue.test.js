import assert from 'node:assert/strict';
import test from 'node:test';
import { WorldTileRuntime } from '../../../../open-world-platform/src/runtime/world-tile-runtime.js';
import { FakeGameAdapter } from '../../../../open-world-platform/src/runtime/adapters/fake-game-adapter.js';
import { MemoryTilePackageAdapter } from '../../../../open-world-platform/src/runtime/adapters/memory-tile-package-adapter.js';
import { ModStorageWorldStateAdapter } from '../../../../open-world-platform/src/runtime/adapters/mod-storage-world-state-adapter.js';
import { NativeRevenueAccrual } from '../../../../open-world-platform/src/runtime/native-revenue-accrual.js';

async function resumedWorld({ failDemand = false } = {}) {
  const storage = new ModStorageWorldStateAdapter({ financeMode: 'blind' });
  const demand = {
    points: [
      { id: 'home', location: [-71.08, 42.35], residents: 100, jobs: 0 },
      { id: 'work', location: [-71.02, 42.35], residents: 0, jobs: 100 },
    ],
    pops: [{ id: 'boston-commute', size: 100, residenceId: 'home', jobId: 'work', drivingSeconds: 3600, drivingDistance: 25000 }],
  };
  const packages = new MemoryTilePackageAdapter(Object.fromEntries(['BOSTON', 'SOUTH'].map(id => [id, {
    manifest: { tileId: id, cityCode: id, schemaVersion: 1, dataFiles: {} },
    demand: [], nativeDemand: id === 'BOSTON' ? demand : { points: [], pops: [] },
    commuteCatalog: { buildHash: 'resume-revenue', buckets: [], gateways: [] },
  }])));
  const game = new FakeGameAdapter();
  Object.assign(game.native, {
    wallet: 1000000,
    stations: ['home', 'work'].map((id, i) => ({ id, coords: demand.points[i].location, stNodeIds: [`${id}-node`], buildType: 'constructed' })),
    stNodes: ['home', 'work'].map((id, i) => ({ id: `${id}-node`, stationId: id, coords: demand.points[i].location })),
    routes: [{ id: 'R', idealTrainCount: 2, stNodes: [{ id: 'home-node' }, { id: 'work-node' }],
      stComboTimings: [{ stNodeIndex: 0, arrivalTime: 0, departureTime: 20 }, { stNodeIndex: 1, arrivalTime: 600, departureTime: 620 }] }],
    trains: [], tracks: [], trackGroups: [],
  });
  const create = currentGame => new WorldTileRuntime({
    game: currentGame, worldState: storage, tilePackages: packages,
    tileCatalog: { tiles: [
      { id: 'BOSTON', column: 0, row: 0, bounds: [-71.2, 42.3, -70.9, 42.5] },
      { id: 'SOUTH', column: 0, row: 1, bounds: [-71.2, 42.1, -70.9, 42.3] },
    ] },
    revenueAccrual: new NativeRevenueAccrual({ adapter: currentGame }), backgroundNativeExpenses: false,
    initialWorld: { activeTileId: 'SOUTH', cohorts: [] },
  });
  const original = create(game);
  await original.boot('resume-revenue', 'SOUTH');
  const originalCalculation = await original.recalculateCrossTileModeShare({ reason: 'startup' });
  assert.deepEqual(originalCalculation.nativeFinanceProfile?.failed, []);
  const expected = original.world.backgroundNativeFinance.tileRevenueProfiles.BOSTON.dailyRevenue;
  assert.ok(expected > 0, 'unchanged saved Boston service must earn revenue');
  await storage.save(original.world);
  const resumedGame = new FakeGameAdapter();
  resumedGame.native = structuredClone(game.native);
  const runtime = create(resumedGame);
  let unavailable = failDemand;
  const attempts = [];
  const load = packages.loadNativeDemand.bind(packages);
  packages.loadNativeDemand = async id => {
    attempts.push(id);
    if (id === 'BOSTON' && unavailable) throw new Error('Transient demand fetch failure during resume');
    return load(id);
  };
  await runtime.boot('resume-revenue', 'SOUTH', { nativeAuthoritativeLoad: true });
  return { runtime, game: resumedGame, expected, attempts, recover: () => { unavailable = false; } };
}

test('cold resume rebuilds the same off-tile revenue from the newest native save', async () => {
  const { runtime, expected } = await resumedWorld();
  await runtime.recalculateCrossTileModeShare({ reason: 'startup' });
  assert.equal(runtime.world.backgroundNativeFinance.tileRevenueProfiles.BOSTON.dailyRevenue, expected);
});

test('hourly settlement recovers a failed startup demand fetch without revisiting Boston', async () => {
  const { runtime, game, recover, attempts } = await resumedWorld({ failDemand: true });
  await runtime.recalculateCrossTileModeShare({ reason: 'startup' });
  recover();
  let paid = 0;
  for (let hour = 1; hour <= 24; hour++) {
    game.native.clock = hour * 3600;
    paid += (await runtime.settleCrossTileCommutes('hourly')).backgroundRevenue;
  }
  assert.ok(paid > 0, 'off-tile Boston revenue must recover once its demand is available');
  assert.equal(runtime.getActiveTileId(), 'SOUTH');
  assert.equal(attempts.filter(id => id === 'BOSTON').length, 2, 'retry the failed package once, then reuse it');
});

test('live switching preserves Boston estimates and credits them while Boston is inactive', async () => {
  const { runtime, game, expected } = await resumedWorld();
  await runtime.recalculateCrossTileModeShare({ reason: 'startup' });
  for (const tileId of ['BOSTON', 'SOUTH']) {
    await runtime.stageNavigationTransition(tileId);
    await runtime.completeStagedTransition(tileId);
    await runtime.recalculateCrossTileModeShare({ reason: 'tile-transition' });
    assert.equal(runtime.world.backgroundNativeFinance.tileRevenueProfiles.BOSTON.dailyRevenue, expected);
  }
  let paid = 0;
  for (let hour = 1; hour <= 24; hour++) {
    game.native.clock = hour * 3600;
    const result = await runtime.settleCrossTileCommutes('hourly');
    paid += result.backgroundRevenue;
    assert.equal(result.backgroundExpenses, 0);
  }
  assert.ok(Math.abs(paid - expected) < 1e-7, 'the full off-tile daily estimate must reach the native ledger');
});

test('persistent failures retry once per hour and never publish incomplete profiles', async () => {
  const { runtime, game, attempts, recover } = await resumedWorld({ failDemand: true });
  const result = await runtime.recalculateCrossTileModeShare({ reason: 'startup' });
  assert.equal(result.nativeFinanceProfile.status, 'pending');
  assert.equal(result.backgroundFinance.status, 'profiles-pending');
  for (let i = 0; i < 3; i++) await runtime.settleCrossTileCommutes('hourly');
  assert.equal(attempts.filter(id => id === 'BOSTON').length, 1);
  game.native.clock = 3600;
  for (let i = 0; i < 3; i++) await runtime.settleCrossTileCommutes('hourly');
  assert.equal(attempts.filter(id => id === 'BOSTON').length, 2);
  assert.deepEqual(runtime.world.backgroundNativeFinance.tileRevenueProfiles, {});
  recover();
  game.native.clock = 8 * 3600;
  const recovered = await runtime.settleCrossTileCommutes('hourly');
  assert.equal(recovered.nativeFinanceProfile.status, 'ready');
  const departureHour = runtime.world.backgroundNativeFinance.tileRevenueProfiles.BOSTON.hourly.findIndex(row => row.revenue > 0);
  game.native.clock = (24 + departureHour) * 3600;
  const settled = await runtime.settleCrossTileCommutes('hourly');
  assert.ok(settled.backgroundRevenue > 0);
  const duplicate = await runtime.settleCrossTileCommutes('hourly');
  assert.equal(duplicate.backgroundRevenue, 0, 'recovery must preserve receipt deduplication');
});

test('revenue report distinguishes unavailable estimates from a completed payment without changing the ledger', async () => {
  const { runtime, game, recover } = await resumedWorld({ failDemand: true });
  await runtime.recalculateCrossTileModeShare({ reason: 'startup' });
  const before = structuredClone(game.native);
  const missing = await runtime.inspectNativeRevenue();
  assert.ok(missing.missingTileIds.includes('BOSTON'));
  assert.equal(missing.pending.failed[0].tileId, 'BOSTON');
  assert.deepEqual(game.native, before);
  recover();
  game.native.clock = 3600;
  await runtime.settleCrossTileCommutes('hourly');
  const available = await runtime.inspectNativeRevenue();
  assert.deepEqual(available.missingTileIds, []);
  assert.equal(available.pending, null);
  assert.ok(available.inactiveEstimatedDailyRevenue > 0);
  assert.equal(available.lastPosting.hour, 1);
  assert.equal(available.lastPosting.activeTileId, 'SOUTH');
});
