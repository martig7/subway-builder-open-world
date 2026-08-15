import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRuntimeModel, createRuntimeModel, reduceRuntimeModel } from '../runtime/world-runtime-model.js';
import { WorldTileRuntime } from '../../kc-two-tile/mod/src/world-tile-runtime.js';
import { FakeGameAdapter } from '../../kc-two-tile/mod/src/adapters/fake-game-adapter.js';
import { MemoryTilePackageAdapter } from '../../kc-two-tile/mod/src/adapters/memory-tile-package-adapter.js';
import { ModStorageWorldStateAdapter } from '../../kc-two-tile/mod/src/adapters/mod-storage-world-state-adapter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'generated/fixtures/runtime-fixtures.json'), 'utf8'));
let state = createRuntimeModel(fixture.catalog);

const dispatch = (action) => { state = reduceRuntimeModel(state, action); return state; };

dispatch({ type: 'BUILD_NETWORK_OBJECT', objectKind: 'track' });
dispatch({ type: 'SWITCH_TILE', tileId: fixture.normalTileIds[7] });
assert.equal(state.globalNetwork.objects.length, 1, 'network disappeared during a tile switch');
dispatch({ type: 'ADVANCE_DAY', days: 2 });
dispatch({ type: 'CHANGE_WALLET', delta: -12_345 });
dispatch({ type: 'SAVE_CHECKPOINT', saveName: 'Exact older save' });
const older = { day: state.worldDay, wallet: state.wallet, tileId: state.activeTileId };
dispatch({ type: 'ADVANCE_DAY', days: 5 });
dispatch({ type: 'CHANGE_WALLET', delta: 54_321 });
dispatch({ type: 'SWITCH_TILE', tileId: fixture.normalTileIds[19] });
dispatch({ type: 'SAVE_CHECKPOINT', saveName: 'Exact newer save' });
dispatch({ type: 'LOAD_CHECKPOINT', saveName: 'Exact older save' });
assert.deepEqual(
  { day: state.worldDay, wallet: state.wallet, tileId: state.activeTileId },
  older,
  'exact save load selected newer mod state',
);

for (let number = 1; number <= 12; number += 1) {
  dispatch({ type: 'ADVANCE_DAY', days: 1 });
  dispatch({ type: 'SAVE_CHECKPOINT', saveName: `Retention autosave ${number}` });
}
assert.equal(state.checkpoints.entries.length, 10, 'checkpoint retention did not stop at ten');
assert.equal(state.checkpoints.entries[0].saveName, 'Retention autosave 3');
const beforeMissingLoad = { day: state.worldDay, wallet: state.wallet, tileId: state.activeTileId };
dispatch({ type: 'LOAD_CHECKPOINT', saveName: 'Retention autosave 2' });
assert.deepEqual({ day: state.worldDay, wallet: state.wallet, tileId: state.activeTileId }, beforeMissingLoad);

dispatch({ type: 'RUN_SOAK', count: 1_000, seed: 0x5eed1234 });
assertRuntimeModel(state);
assert.equal(state.soakReport.passed, true);
assert.equal(state.soakReport.completedTransitions, 1_000);
assert.equal(state.soakReport.maxTransitionTouchedTiles, 2);
assert.equal(state.soakReport.maxDeserializedTiles, 1);
assert.equal(state.checkpoints.entries.length, 10);

// Lift the same catalog into the real prototype runtime seam. This validates
// that the implementation no longer imports a two-tile world shape internally.
const game = new FakeGameAdapter();
game.native.tracks = [{ id: 'statewide-track', ownerTileId: fixture.normalTileIds[0] }];
game.native.stations = [{ id: 'statewide-station', ownerTileId: fixture.normalTileIds[0] }];
game.native.routes = [{ id: 'statewide-route' }];
game.native.trains = [{ id: 'statewide-train', routeId: 'statewide-route' }];
const runtimeStorage = new ModStorageWorldStateAdapter();
const runtime = new WorldTileRuntime({
  game,
  worldState: runtimeStorage,
  tilePackages: new MemoryTilePackageAdapter(Object.fromEntries(fixture.normalTileIds.map((tileId) => [tileId, fixture.packages[tileId]]))),
  tileIds: fixture.normalTileIds,
  initialWorld: { activeTileId: fixture.initialWorld.activeTileId, wallet: fixture.initialWorld.wallet, cohorts: [] },
});
await runtime.boot('ny-state-real-runtime-fixture');
let runtimeSeed = 0x35cafe;
for (let index = 0; index < 1_000; index += 1) {
  runtimeSeed = (Math.imul(runtimeSeed, 1664525) + 1013904223) >>> 0;
  const currentIndex = fixture.normalTileIds.indexOf(runtime.view().activeTileId);
  const offset = 1 + (runtimeSeed % (fixture.normalTileIds.length - 1));
  await runtime.transitionTo(fixture.normalTileIds[(currentIndex + offset) % fixture.normalTileIds.length]);
}
assert.equal(runtime.view().revision, 1_000);
assert.equal(Object.keys(runtime.view().tiles).length, 33);
assert.deepEqual(game.native.tracks, [{ id: 'statewide-track', ownerTileId: fixture.normalTileIds[0] }]);
assert.deepEqual(game.native.routes, [{ id: 'statewide-route' }]);

const report = {
  schemaVersion: '1.0.0',
  prototype: true,
  passed: true,
  fixtureTiles: fixture.packages ? Object.keys(fixture.packages).length : 0,
  playableTiles: state.tileIds.length,
  sliverTiles: state.sliverTileIds.length,
  exactCheckpointRestored: older,
  expiredCheckpointRejected: true,
  retainedCheckpoints: state.checkpoints.entries.length,
  currentBlobCount: Object.keys(state.blobs).length,
  garbageCollectedBlobs: state.metrics.garbageCollectedBlobs,
  currentNetworkObjects: state.globalNetwork.objects.length,
  adapterRuntime: {
    passed: true,
    transitions: runtime.view().revision,
    tileCount: Object.keys(runtime.view().tiles).length,
    activeTileId: runtime.view().activeTileId,
    globalTrackCount: game.native.tracks.length,
    globalRouteCount: game.native.routes.length,
  },
  soak: state.soakReport,
};

const output = path.join(root, 'generated/reports/runtime-soak.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const markdown = `# New York runtime fixture soak

PROTOTYPE — generated by \`npm run soak\`; do not edit by hand.

## Verdict

**PASS**

- Addressable fixture packages: **${report.fixtureTiles}** (${report.playableTiles} playable + ${report.sliverTiles} slivers)
- Pure-model randomized transitions: **${report.soak.completedTransitions.toLocaleString('en-US')}**
- Invariant checks: **${report.soak.assertions.toLocaleString('en-US')}**
- Real \`WorldTileRuntime\` transitions with injected catalog: **${report.adapterRuntime.transitions.toLocaleString('en-US')}**
- Maximum tile snapshots touched per transition: **${report.soak.maxTransitionTouchedTiles}**
- Maximum tile snapshots deserialized per operation: **${report.soak.maxDeserializedTiles}**
- Retained autosaves: **${report.retainedCheckpoints}**
- Expired autosave rejected without changing the world: **yes**
- Exact older checkpoint restored: day **${report.exactCheckpointRestored.day}**, tile \`${report.exactCheckpointRestored.tileId}\`, wallet **$${report.exactCheckpointRestored.wallet.toLocaleString('en-US')}**
- Content-addressed blobs retained: **${report.currentBlobCount}**
- Unreferenced blobs reclaimed: **${report.garbageCollectedBlobs}**
- Global track/route survived all real-runtime transitions: **yes**

The generic runtime core contains no \`KCW\`, \`KCE\`, or static tile-catalog import. Kansas City now supplies its catalog at the composition boundary.
`;
fs.writeFileSync(path.join(root, 'generated/reports/runtime-soak.md'), markdown, 'utf8');
console.log(JSON.stringify(report));
