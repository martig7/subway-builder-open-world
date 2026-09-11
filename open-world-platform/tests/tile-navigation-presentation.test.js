import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldTileRuntime } from '../src/runtime/world-tile-runtime.js';
import { NetworkProjection } from '../src/runtime/network-projection.js';
import { FakeGameAdapter } from '../src/runtime/adapters/fake-game-adapter.js';
import { MemoryTilePackageAdapter } from '../src/runtime/adapters/memory-tile-package-adapter.js';
import { ModStorageWorldStateAdapter } from '../src/runtime/adapters/mod-storage-world-state-adapter.js';
import { packages } from '../../prototype/kc-two-tile/mod/fixtures/two-tile-fixture.js';

test('tile navigation builds presentation without copying native history into the rendering projection', async t => {
  const game = new FakeGameAdapter();
  const runtime = new WorldTileRuntime({ game, worldState: new ModStorageWorldStateAdapter(),
    tilePackages: new MemoryTilePackageAdapter(packages),
    tileCatalog: { tiles: [{ id: 'KCW' }, { id: 'KCE' }] },
    initialWorld: { wallet: 100, cohorts: [] } });
  await runtime.boot('presentation-only', 'KCW');
  game.native.completedCommutes = [{ popId: 'p', size: 42, stationRoutes: [] }];
  const history = structuredClone(game.native.completedCommutes);
  const build = NetworkProjection.prototype.build;
  let builds = 0;
  t.mock.method(NetworkProjection.prototype, 'build', function (options) {
    const base = options.baseSnapshot?.data ?? options.baseSnapshot;
    assert.equal(base?.completedCommutes, undefined, 'rendering must not traverse native journey history');
    assert.equal(base?.financialHistory, undefined, 'rendering must not copy native financial history');
    builds++;
    return build.call(this, options);
  });
  await runtime.stageNavigationTransition('KCE');
  assert.deepEqual(runtime.world.pendingTransition.nativeSnapshot.completedCommutes, history);
  await runtime.completeStagedTransition('KCE');
  assert.ok(builds >= 2, 'both departing and arriving presentation paths were exercised');
  assert.deepEqual(game.native.completedCommutes, history, 'the native restore still carries journey history');
});
