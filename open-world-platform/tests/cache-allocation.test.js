import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { sameInterlinedSnapshotValue } from '../src/runtime/ui/geographic-context-overlay.js';
import { createWorld } from '../src/runtime/world-model.js';
import { registerCommuteCatalog, advanceCommutesTo, projectCommutesByTile, projectCommuteBacklogs } from '../src/runtime/cross-tile-commute-engine.js';

test('snapshot matching detects in-place edits, key replacement and deletion while ignoring inherited properties', () => {
  const source = [{ geometry: { coordinates: [[1,2],[3,4]] }, properties: { color: 'red', optional: undefined } }];
  const snapshot = structuredClone(source);
  assert.ok(sameInterlinedSnapshotValue(source, snapshot));
  source[0].geometry.coordinates[0][0] = 9;
  assert.equal(sameInterlinedSnapshotValue(source, snapshot), false);
  source[0].geometry.coordinates[0][0] = 1;
  delete source[0].properties.optional;
  source[0].properties.replacement = undefined;
  assert.equal(sameInterlinedSnapshotValue(source, snapshot), false);
  delete source[0].properties.replacement;
  assert.equal(sameInterlinedSnapshotValue(source, snapshot), false);
  source[0].properties.optional = undefined;
  Object.setPrototypeOf(source[0].properties, { inherited: 'ignored' });
  assert.ok(sameInterlinedSnapshotValue(source, snapshot));
  assert.ok(sameInterlinedSnapshotValue(new Float64Array([1,2]), [1,2]));
  assert.equal(sameInterlinedSnapshotValue(new Float64Array([1,3]), [1,2]), false);
});

test('unchanged snapshot comparisons stay within a small temporary-allocation budget', async () => {
  const source = Array.from({ length: 500 }, (_, id) => ({ id, type: 'Feature', properties: { color: 'red' },
    geometry: { type: 'LineString', coordinates: [[1,2],[3,4]] } }));
  const snapshot = structuredClone(source);
  for (let i = 0; i < 20; i++) sameInterlinedSnapshotValue(source, snapshot);
  const session = new Session(); session.connect();
  try {
    await session.post('HeapProfiler.startSampling', { samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let i = 0; i < 250; i++) assert.ok(sameInterlinedSnapshotValue(source, snapshot));
    const { profile } = await session.post('HeapProfiler.stopSampling');
    function allocated(node, matching = false) {
      matching ||= node.callFrame.functionName === 'sameInterlinedSnapshotValue';
      return (matching ? node.selfSize : 0) + node.children.reduce((sum, child) => sum + allocated(child, matching), 0);
    }
    assert.ok(allocated(profile.head) < 1_048_576, `comparison allocated ${allocated(profile.head)} bytes`);
  } finally { session.disconnect(); }
});

test('backlog-only projection matches full projections across departures, arrivals and unserved tiles', () => {
  const ids = ['A','B','empty'];
  const world = createWorld({ worldId: 'backlog-only', tileIds: ids });
  registerCommuteCatalog(world, { buildHash: 'backlog', gateways: [{ id: 'g', capacityPerHour: 5 }], buckets: [
    { id: 'ab', homeTileId: 'A', workTileId: 'B', gatewayId: 'g', mass: 12, defaultTravelSeconds: 3600 },
    { id: 'ba', homeTileId: 'B', workTileId: 'A', gatewayId: 'g', mass: 7, defaultTravelSeconds: 3600 },
  ] });
  for (const hour of [0,7,8,10,17,18,23,31]) {
    advanceCommutesTo(world, hour);
    const expected = projectCommutesByTile(world, ids);
    const actual = projectCommuteBacklogs(world, ids);
    for (const id of ids) assert.equal(actual[id], expected[id].waitingToLeave, `${hour}: ${id}`);
    assert.equal(projectCommuteBacklogs(world, ['B']).B, expected.B.waitingToLeave);
  }
});
