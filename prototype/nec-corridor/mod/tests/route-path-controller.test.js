import test from 'node:test';
import assert from 'node:assert/strict';
import { createNecRoutePaths, shortestTilePath } from '../src/route-path-controller.js';

const catalog = {
  tiles: [
    { id: 'A', neighbors: [{ tileId: 'B' }] },
    { id: 'B', neighbors: [{ tileId: 'A' }, { tileId: 'C' }] },
    { id: 'C', neighbors: [{ tileId: 'B' }] },
  ],
};

test('shortest tile path partitions cross routes through catalog neighbors', () => {
  assert.deepEqual(shortestTilePath(catalog, 'A', 'C'), ['A', 'B', 'C']);
  assert.deepEqual(shortestTilePath(catalog, 'A', 'A'), ['A']);
  assert.deepEqual(shortestTilePath(catalog, 'A', 'missing'), []);
});

test('native and cross pop requests share one generated-road resolver and cache results', async () => {
  const native = {
    points: new Map([
      ['home', { location: [0, 0] }],
      ['work', { location: [0.01, 0] }],
    ]),
    popsMap: new Map([['nec-native-pop-1', { size: 1, residenceId: 'home', jobId: 'work' }]]),
  };
  const cross = {
    popFields: ['id', 'homePoint', 'workPoint'],
    points: [['h', 0, 0, 'A'], ['w', 0.02, 0, 'C']],
    pops: [['nec-cross-pop-1', 0, 1]],
  };
  const calls = [];
  const routePaths = createNecRoutePaths({
    tileCatalog: catalog,
    tilePackages: { loadCrossDemand: async () => cross },
    getNativeDemand: () => native,
    routeTiles: async (request) => {
      calls.push(request);
      return { status: 'routed', route: { coordinates: [request.origin, [0.005, 0.001], request.destination] } };
    },
  });
  assert.equal((await routePaths.resolve('A', 'nec-native-pop-1')).source, 'generated-road-graph');
  assert.equal((await routePaths.resolve('A', 'nec-cross-pop-1')).source, 'generated-road-graph');
  await routePaths.resolve('A', 'nec-cross-pop-1');
  assert.equal(calls.length, 2, 'repeated pop request must reuse its cached path');
  assert.deepEqual(calls[1].tileIds, ['A', 'B', 'C']);
});

test('long-distance cross routes use geometric rendering without loading a road graph', async () => {
  let routes = 0;
  const routePaths = createNecRoutePaths({
    tileCatalog: catalog,
    tilePackages: { loadCrossDemand: async () => ({
      popFields: ['id', 'homePoint', 'workPoint'],
      points: [['h', -75, 40, 'A'], ['w', -71, 42, 'C']],
      pops: [['nec-cross-pop-long', 0, 1]],
    }) },
    getNativeDemand: () => null,
    routeTiles: async () => { routes++; return null; },
  });
  const result = await routePaths.resolve('A', 'nec-cross-pop-long');
  assert.equal(result.source, 'geometric-long-distance');
  assert.equal(routes, 0);
  assert.ok(result.coordinates.length > 2);
});
