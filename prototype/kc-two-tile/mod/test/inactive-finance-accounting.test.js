import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldTileRuntime } from '../../../../open-world-platform/src/runtime/world-tile-runtime.js';
import { FakeGameAdapter } from '../../../../open-world-platform/src/runtime/adapters/fake-game-adapter.js';
import { MemoryTilePackageAdapter } from '../../../../open-world-platform/src/runtime/adapters/memory-tile-package-adapter.js';
import { ModStorageWorldStateAdapter } from '../../../../open-world-platform/src/runtime/adapters/mod-storage-world-state-adapter.js';
import { applyModeShares, registerCommuteCatalog } from '../../../../open-world-platform/src/runtime/cross-tile-commute-engine.js';
import { createWorld } from '../../../../open-world-platform/src/runtime/world-model.js';

test('mode-share conservation accepts harmless floating-point residue', () => {
  const mass = 13_125.5123;
  const world = createWorld({ worldId: 'nec-mode-share-float-regression', tileIds: ['T0', 'T1'] });
  registerCommuteCatalog(world, {
    buildHash: 'nec-mode-share-float-regression',
    gateways: [{ id: 'gateway', capacityPerHour: mass }],
    buckets: [{
      id: 'nec-cross-flow', homeTileId: 'T0', workTileId: 'T1', gatewayId: 'gateway',
      mass, defaultTravelSeconds: 3_600,
    }],
  });

  const driving = mass * 0.1;
  const walking = mass * 0.2;
  const transit = mass * 0.7;
  assert.notEqual(driving + walking + transit, mass, 'fixture must include IEEE-754 residue');

  assert.doesNotThrow(() => applyModeShares(world, new Map([
    ['T0|T1|gateway', { driving, walking, transit, unknown: 0 }],
  ])));
});

test('tile-switch finance keeps the wallet equal to revenue minus expenses', async () => {
  const packages = Object.fromEntries(['T0', 'T1'].map((tileId) => [tileId, {
    manifest: { tileId, cityCode: tileId, schemaVersion: 1, dataFiles: {} },
    demand: [],
    commuteCatalog: { buildHash: 'tile-switch-finance-regression', buckets: [], gateways: [] },
  }]));
  const game = new FakeGameAdapter();
  const runtime = new WorldTileRuntime({
    game,
    worldState: new ModStorageWorldStateAdapter(),
    tilePackages: new MemoryTilePackageAdapter(packages),
    tileCatalog: {
      tiles: [
        { id: 'T0', column: 0, row: 0, bounds: [0, 0, 1, 1] },
        { id: 'T1', column: 1, row: 0, bounds: [1, 0, 2, 1] },
      ],
    },
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
  });
  await runtime.boot('nec-tile-switch-finance-regression', 'T0');

  const hourly = (revenue, routeId) => Array.from({ length: 24 }, () => ({
    revenue,
    revenueByRoute: { [routeId]: revenue },
  }));
  const networkHash = runtime.world.globalNetwork.hash;
  runtime.world.backgroundNativeFinance = {
    schemaVersion: 2,
    networkHash,
    lastSettledHour: 0,
    lastRevenueSettledHour: 0,
    lastExpenseSettledHour: 0,
    tileRevenueProfiles: {
      T0: { hourly: hourly(20, 'route-T0'), dailyRevenue: 480 },
      T1: { hourly: hourly(30, 'route-T1'), dailyRevenue: 720 },
    },
    expenseProfile: {
      networkHash,
      routeHourly: { 'route-T0': Array(24).fill(7), 'route-T1': Array(24).fill(11) },
      financeOwnedRouteIds: ['route-T0', 'route-T1'],
      infrastructureItems: [],
    },
    ownershipProjection: structuredClone(runtime.world.activeProjection),
    totalRevenue: 0,
    totalExpenses: 0,
  };

  await runtime.stageNavigationTransition('T1');
  game.native = { ...game.native, objects: [], activity: { departures: [], walletDelta: 0 } };
  await runtime.completeStagedTransition('T1');
  game.native.clock = 3_600;
  const openingWallet = game.native.wallet;

  const result = await runtime.settleCrossTileCommutes('hourly');

  assert.equal(runtime.world.backgroundNativeFinance.ownershipProjection.activeTileId, 'T1');
  assert.equal(result.backgroundRevenue, 20, 'inactive T0 revenue should accrue after switching to T1');
  assert.equal(result.backgroundExpenses, 18, 'both finance-owned route expenses should continue');
  assert.equal(result.wallet, openingWallet + result.backgroundRevenue - result.backgroundExpenses);
  assert.equal(game.native.financialHistory.currentHourRevenue, result.backgroundRevenue);
  assert.equal(game.native.financialHistory.currentHourExpenses, result.backgroundExpenses);
});
