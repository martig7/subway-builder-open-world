import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCrossTileModeShares, createNetworkProfile, inspectCrossTileModeChoice,
  prepareCrossTileModeShares, finishCrossTileModeShares,
} from '../src/runtime/cross-tile-mode-choice.js';
import { createWorld } from '../src/runtime/world-model.js';
import { createCommuteEntry, projectCommutesForTile, projectCommutesByTile } from '../src/runtime/cross-tile-commute-engine.js';
import { WorldTileRuntime } from '../src/runtime/world-tile-runtime.js';
import { buildGeneratedRoadGraph, routeGeneratedRoadGraph } from '../src/runtime/generated-road-routing.js';

export function demandFixture() {
  const profile = createNetworkProfile({ tileId: 'T0',
    stations: [0, 1, 2].map(i => ({ id: `s${i}`, coords: [i * 0.05, 0], stNodeIds: [`n${i}`], nearbyStations: [], buildType: 'constructed' })),
    routes: [{ id: 'r0', stNodes: [0, 1, 2].map(i => ({ id: `n${i}` })) }],
    trains: [{ id: 'train', routeId: 'r0' }],
  });
  return { crossDemand: { schemaVersion: 1, tileId: 'T0',
    points: [['h', 0, 0, 'T0'], ['w', 0.1, 0, 'T0']], gateways: ['local'],
    popFields: ['id', 'mass', 'homePoint', 'workPoint', 'gateway', 'drivingSeconds', 'drivingDistance'],
    pops: Array.from({ length: 8 }, (_, i) => [`p${i}`, 100 + i, i % 2, 1 - i % 2, 0, 3600, 15000]),
  }, networkProfiles: { T0: profile }, gatewayCatalog: {}, fare: 2 };
}

test('bulk and staged demand preserve the detailed inspector modes and native fare attribution', () => {
  const input = demandFixture();
  const journeyFare = (stationRoutes) => ({ total: 7.35, revenueByRoute: { [stationRoutes[0].routeId]: 7.35 } });
  const expected = input.crossDemand.pops.map((_, popIndex) => inspectCrossTileModeChoice({ ...input, journeyFare, popIndex }));
  const bulk = calculateCrossTileModeShares({ ...input, journeyFare });
  for (const row of expected) assert.deepEqual(bulk.popModeChoices[row.popId], row.modes);
  const staged = prepareCrossTileModeShares(input);
  assert.ok(staged.fareRequests.length > 0);
  const quotes = new Map(staged.fareRequests.map(({ key, stationRoutes }) => [key, journeyFare(stationRoutes)]));
  assert.deepEqual(finishCrossTileModeShares(staged, quotes), bulk);
});

test('bulk prepares the demand field lookup once for the entire batch', () => {
  const input = demandFixture();
  const fields = input.crossDemand.popFields;
  let reads = 0;
  Object.defineProperty(input.crossDemand, 'popFields', { get() { reads++; return fields; } });
  calculateCrossTileModeShares(input);
  assert.equal(reads, 1);
});

test('driving access rejects unreachable destinations before scanning station candidates', () => {
  const input = demandFixture();
  input.crossDemand.points[1][1] = 50;
  input.networkProfiles.T0.pathfindingRules.DRIVE_TO_STATION_ACCESS = true;
  input.crossDemand.pops = [input.crossDemand.pops[0]];
  const result = calculateCrossTileModeShares(input);
  assert.equal(result.transitViablePops, 0);
  assert.equal(result.routingStats.driveAccessCandidates, 0);
});

test('driving access examines local spatial candidates and preserves a drive-only station approach', () => {
  const input = demandFixture();
  input.crossDemand.points[0][1] = -0.03;
  input.crossDemand.pops = [['p0', 100, 0, 1, 0, 3600, 36000]];
  const profile = input.networkProfiles.T0;
  profile.pathfindingRules.DRIVE_TO_STATION_ACCESS = true;
  for (let i = 0; i < 1000; i++) profile.stations.push({ id: `far${i}`, coords: [100, i * 0.0001], stNodeIds: [], nearbyStations: [] });
  const result = calculateCrossTileModeShares(input);
  assert.equal(result.transitViablePops, 1);
  assert.ok(result.routingStats.driveAccessCandidates < 10, 'far stations must not enter the distance loop');
});

test('one-pass tile projections preserve totals and do not alias tile gateway maps', () => {
  const world = createWorld({ worldId: 'projection-audit', tileIds: ['T0', 'T1', 'T2'], initialTileId: 'T0', initialWallet: 0 });
  world.gatewayLedger.flow = createCommuteEntry({ id: 'flow', homeTileId: 'T0', workTileId: 'T1', gatewayId: 'g0', mass: 100, travelHours: 2 });
  const projected = projectCommutesByTile(world, ['T0', 'T1', 'T2']);
  for (const tileId of ['T0', 'T1', 'T2']) assert.deepEqual(projected[tileId], projectCommutesForTile(world, tileId));
  projected.T0.gateways.g0.backlog = 999;
  assert.equal(projected.T1.gateways.g0.backlog, 0);
});

test('summary views do not traverse individual population mode choices', () => {
  const runtime = new WorldTileRuntime({ tileIds: ['T0'] });
  runtime.world = createWorld({ worldId: 'summary-audit', tileIds: ['T0'], initialTileId: 'T0', initialWallet: 0 });
  Object.defineProperty(runtime.world.crossPopModeChoices, 'p0', { enumerable: true, get() { throw new Error('read detailed population'); } });
  assert.equal(runtime.view({ includeDemandDetails: false }).activeTileId, 'T0');
});

test('road searches reuse graph-sized storage without retaining visited state between requests', () => {
  const graph = buildGeneratedRoadGraph([{ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { roadClass: 'minor' }, geometry: { type: 'LineString', coordinates: [[0, 0], [0.01, 0], [0.02, 0]] } },
    { type: 'Feature', properties: { roadClass: 'minor' }, geometry: { type: 'LineString', coordinates: [[1, 0], [1.01, 0]] } },
  ] }]);
  const Original = globalThis.Int32Array;
  let allocations = 0;
  globalThis.Int32Array = class extends Original { constructor(...args) { super(...args); allocations++; } };
  try {
    const forward = routeGeneratedRoadGraph(graph, [0, 0], [0.02, 0]);
    const reverse = routeGeneratedRoadGraph(graph, [0.02, 0], [0, 0]);
    assert.ok(forward && reverse);
    assert.equal(routeGeneratedRoadGraph(graph, [0, 0], [1, 0]), null);
    assert.deepEqual(routeGeneratedRoadGraph(graph, [0, 0], [0.02, 0]), forward);
    assert.equal(allocations, 1);
  } finally { globalThis.Int32Array = Original; }
});
