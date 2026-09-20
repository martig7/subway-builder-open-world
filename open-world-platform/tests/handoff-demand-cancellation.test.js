import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldTileRuntime } from '../src/runtime/world-tile-runtime.js';
import { FakeGameAdapter } from '../src/runtime/adapters/fake-game-adapter.js';
import { MemoryTilePackageAdapter } from '../src/runtime/adapters/memory-tile-package-adapter.js';
import { ModStorageWorldStateAdapter } from '../src/runtime/adapters/mod-storage-world-state-adapter.js';
import { NativeRevenueAccrual } from '../src/runtime/native-revenue-accrual.js';
import { evaluateOffTileNativeDemand } from '../src/runtime/off-tile-native-demand.js';
import { calculateCrossTileModeShares } from '../src/runtime/cross-tile-mode-choice.js';

function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
}

async function fixture() {
  const game = new FakeGameAdapter();
  const tilePackages = new MemoryTilePackageAdapter({ T0: {
    manifest: { tileId: 'T0', cityCode: 'T0', schemaVersion: 1, dataFiles: {} }, demand: [],
    nativeDemand: { points: [], pops: [] },
    commuteCatalog: { buildHash: 'handoff-cancellation', buckets: [], gateways: [] },
  } });
  const revenueAccrual = new NativeRevenueAccrual({ adapter: game });
  const runtime = new WorldTileRuntime({ game, tilePackages, revenueAccrual,
    worldState: new ModStorageWorldStateAdapter(),
    tileCatalog: { tiles: [{ id: 'T0', bounds: [0, 0, 1, 1] }] },
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] } });
  await runtime.boot('handoff-owner', 'T0');
  return { game, runtime, revenueAccrual, tilePackages };
}

test('cancelled queued handoff demand does not capture or publish a replacement save', async () => {
  const { runtime, game } = await fixture();
  const queue = deferred(); runtime.serial = queue.promise;
  let current = true;
  const job = runtime.recalculateCrossTileModeShare({ force: true, isCurrent: () => current });
  current = false;
  game.log.length = 0;
  queue.resolve();
  assert.equal((await job).status, 'cancelled');
  assert.deepEqual(game.log, []);
});

test('cancelled handoff native preparation cannot replace live finance profiles', async () => {
  const { runtime, tilePackages, revenueAccrual } = await fixture();
  const entered = deferred(), finish = deferred();
  const profileBefore = runtime.world.backgroundNativeFinance;
  let current = true, published = 0;
  revenueAccrual.replaceProfiles = () => { published++; };
  tilePackages.prepareActiveNativeDemand = async () => {
    entered.resolve(); await finish.promise;
    const result = evaluateOffTileNativeDemand({ tileId: 'T0', demand: { points: [], pops: [] } });
    return { ...result, profile: { ...result.profile, source: 'active-tile-prepared' } };
  };
  const job = runtime.recalculateCrossTileModeShare({ force: true, isCurrent: () => current });
  await entered.promise;
  current = false; finish.resolve();
  assert.equal((await job).status, 'cancelled');
  assert.equal(published, 0);
  assert.equal(runtime.world.backgroundNativeFinance, profileBefore);
});

test('late cross-demand result cannot overwrite a cancelled handoff', async () => {
  const { runtime, tilePackages } = await fixture();
  tilePackages.packages.get('T0').crossDemand = { schemaVersion: 1, points: [], pops: [], popFields: [], gateways: [] };
  const entered = deferred(), finish = deferred();
  const before = runtime.world.crossModeShare;
  let current = true;
  const job = runtime.recalculateCrossTileModeShare({ force: true, isCurrent: () => current,
    evaluateCrossModeShares: async input => {
      entered.resolve(); await finish.promise; return calculateCrossTileModeShares(input);
    } });
  await entered.promise;
  current = false; finish.resolve();
  assert.equal((await job).status, 'cancelled');
  assert.equal(runtime.world.crossModeShare, before);
});
