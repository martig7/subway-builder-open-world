import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCrossTileModeShares, createCrossTileRoutingCache, createNetworkProfile } from '../src/runtime/cross-tile-mode-choice.js';

test('branching off-tile searches allocate labels only for improved states and preserve repeated outcomes', () => {
  const network = createNetworkProfile({ tileId: 'A',
    stations: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, coords: [i * 0.03, 0], buildType: 'constructed',
      stNodeIds: [`n${i}`], nearbyStations: [] })),
    routes: Array.from({ length: 4 }, (_, r) => ({ id: `r${r}`, idealTrainCount: 3,
      stNodes: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` })) })),
  });
  const input = { worldId: 'allocation-regression', networkProfiles: { A: network },
    crossDemand: { schemaVersion: 1, tileId: 'A', gateways: ['local'],
      points: [['home', 0, 0, 'A'], ['work', 0.33, 0, 'A']],
      pops: [['population', 200, 0, 1, 0]] }, gatewayCatalog: {}, fare: 0 };
  const cache = createCrossTileRoutingCache();
  const result = calculateCrossTileModeShares({ ...input, routingCache: cache });
  assert.equal(result.transitViablePops, 1);
  assert.ok(result.routingStats.relaxedEdges > 100, 'fixture exercises many losing relaxations');
  assert.ok(result.routingStats.createdLabels < result.routingStats.relaxedEdges / 2,
    'losing relaxations must not allocate search labels');
  const { routingStats, ...outcome } = result;
  const { routingStats: repeatedStats, ...repeated } = calculateCrossTileModeShares({ ...structuredClone(input), routingCache: cache });
  assert.deepEqual(repeated, outcome);
  assert.equal(repeatedStats.createdLabels, 0);
});
