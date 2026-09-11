import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldTileRuntime } from '../src/runtime/world-tile-runtime.js';
import { FakeGameAdapter } from '../src/runtime/adapters/fake-game-adapter.js';
import { MemoryTilePackageAdapter } from '../src/runtime/adapters/memory-tile-package-adapter.js';
import { ModStorageWorldStateAdapter } from '../src/runtime/adapters/mod-storage-world-state-adapter.js';
import { NativeRevenueAccrual } from '../src/runtime/native-revenue-accrual.js';
import { packages } from '../../prototype/kc-two-tile/mod/fixtures/two-tile-fixture.js';

function fixture({ storage = new ModStorageWorldStateAdapter(), clock, nativeRevenue = true } = {}) {
  const game = new FakeGameAdapter();
  game.native.clock = clock;
  game.native.wallet = 123456;
  game.paused = true;
  const events = [];
  const runtime = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { wallet: 0, cohorts: [] },
    revenueAccrual: nativeRevenue ? new NativeRevenueAccrual({ adapter: game }) : null,
    telemetry: event => events.push(event),
  });
  let capacityReads = 0;
  const adoptStaticPackage = game.adoptStaticPackage.bind(game);
  game.adoptStaticPackage = async (...args) => {
    await adoptStaticPackage(...args);
    // Count actual scheduler work instead of asserting machine-dependent timings.
    const gateway = runtime.world.gatewayCatalog.central;
    const capacity = gateway.capacityPerHour;
    Object.defineProperty(gateway, 'capacityPerHour', {
      enumerable: true, configurable: true,
      get() { capacityReads++; return capacity; },
    });
  };
  return { game, runtime, storage, events, work: () => capacityReads };
}

for (const nativeRevenue of [true, false]) {
  test(`fresh World Record bounds startup replay at an old native clock (native revenue ${nativeRevenue})`, async () => {
    const recent = fixture({ clock: 58 * 3600 + 573, nativeRevenue });
    const old = fixture({ clock: 211200573, nativeRevenue });
    for (const subject of [old, recent]) {
      const nativeBefore = structuredClone(subject.game.native);
      await subject.runtime.boot('fresh-native-clock', 'KCW', { nativeAuthoritativeLoad: true });
      const world = subject.runtime.world;
      assert.ok(subject.work() < 40, `startup dispatched ${subject.work()} gateway batches`);
      assert.equal(world.worldTime, Math.floor(nativeBefore.clock / 3600));
      assert.equal(world.commuteLastProcessedHour, world.worldTime);
      assert.equal(world.elapsedSeconds, nativeBefore.clock);
      assert.equal(world.backgroundNativeFinance.lastSettledHour, world.worldTime);
      assert.equal(world.backgroundNativeFinance.lastRevenueSettledHour, world.worldTime);
      assert.equal(world.backgroundNativeFinance.lastExpenseSettledHour, world.worldTime);
      assert.equal(world.gatewayLedger['cohort-west-east-1'].atWork, 10);
      assert.equal(world.crossTileFinancials.transitTrips, 0);
      assert.equal(world.crossTileFinancials.fareRevenue, 0);
      assert.equal(world.crossTileFinancials.pendingNativeRevenue, 0);
      assert.deepEqual(world.pendingCrossTileAttribution, { revenueByRoute: {}, completedCommutes: [] });
      for (const tile of Object.values(world.tiles)) {
        assert.equal(tile.lastSimulatedTime, world.worldTime);
        assert.equal(tile.aggregate.operatingCost, 0);
      }
      assert.equal(subject.game.native.clock, nativeBefore.clock);
      assert.equal(subject.game.native.wallet, nativeBefore.wallet);
      assert.deepEqual(subject.game.native.financialHistory, nativeBefore.financialHistory);
      assert.deepEqual(subject.game.native.completedCommutes, nativeBefore.completedCommutes);
      assert.equal(subject.game.paused, true);
      const initialization = subject.events.find(event => event.segment === 'commute-clock-initialized');
      assert.equal(initialization.version, 'startup-native-clock-baseline-v1');
      assert.equal(initialization.authoritativeHour, world.worldTime);
    }
    assert.equal(old.work(), recent.work(), 'work depends on recent positions, not save age');
  });
}

test('persisted World Record keeps scheduled catch-up and prior settlement counters', async () => {
  const first = fixture({ clock: 6 * 3600 });
  await first.runtime.boot('persisted-native-clock', 'KCW');
  const entry = first.runtime.world.gatewayLedger['cohort-west-east-1'];
  entry.modeChoice = { transit: 10, driving: 0, walking: 0, unknown: 0 };
  entry.transitTrips = 99;
  first.runtime.world.crossTileFinancials.transitTrips = 99;
  await first.storage.save(first.runtime.world);
  const reopened = fixture({ storage: first.storage, clock: 10 * 3600 + 573 });

  await reopened.runtime.boot('persisted-native-clock', 'KCW', { nativeAuthoritativeLoad: true });

  const world = reopened.runtime.world;
  assert.equal(world.gatewayLedger['cohort-west-east-1'].atWork, 10);
  assert.equal(world.crossTileFinancials.transitTrips, 109);
  assert.equal(world.gatewayLedger['cohort-west-east-1'].transitTrips, 109);
  assert.equal(world.commuteLastProcessedHour, 10);
  assert.equal(reopened.game.native.wallet, 123456);
});

test('brand-new game initializes at hour zero and schedules its first departure', async () => {
  const { runtime, game } = fixture({ clock: 0 });
  await runtime.boot('new-game-clock', 'KCW');
  assert.equal(runtime.world.worldTime, 0);
  assert.equal(runtime.world.commuteLastProcessedHour, 0);
  assert.equal(runtime.world.commuteNextActivityHour, 7);
  assert.equal(runtime.world.gatewayLedger['cohort-west-east-1'].atHome, 10);
  assert.equal(game.native.clock, 0);
});
