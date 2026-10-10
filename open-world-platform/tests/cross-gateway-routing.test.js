import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCrossTileModeShares, createCrossTileRoutingCache, createNetworkProfile,
  inspectCrossTileModeChoice, inspectCrossTileTransitPath,
} from '../src/runtime/cross-tile-mode-choice.js';

function fixture() {
  // Overlapping geographic bounds put the ownership waypoint far from both
  // endpoints, as in the Chiba/Tokyo report. Both rail options are reachable.
  const stations = [
    ['home', [139.9070224, 35.7286697]],
    ['work', [139.774345, 35.670655]],
    ['gateway', [140.3130607, 35.39874465]],
  ].map(([id, coords]) => ({ id, coords, stNodeIds: [`${id}-node`], buildType: 'constructed', nearbyStations: [] }));
  const network = createNetworkProfile({ tileId: 'A', stations, routes: [
    { id: 'direct', idealTrainCount: 10, trainType: 'test', carsPerTrain: 1,
      stNodes: [{ id: 'home-node' }, { id: 'work-node' }],
      stComboTimings: [
        { stNodeIndex: 0, arrivalTime: 0, departureTime: 0 },
        { stNodeIndex: 1, arrivalTime: 900, departureTime: 1800 },
      ] },
    { id: 'detour', idealTrainCount: 40, trainType: 'test', carsPerTrain: 1,
      stNodes: [{ id: 'home-node' }, { id: 'gateway-node' }, { id: 'work-node' }],
      stComboTimings: [
        { stNodeIndex: 0, arrivalTime: 0, departureTime: 0 },
        { stNodeIndex: 1, arrivalTime: 5400, departureTime: 5420 },
        { stNodeIndex: 2, arrivalTime: 10820, departureTime: 12000 },
      ] },
  ], trainTypes: { test: { stats: { capacityPerCar: 1000 } } } });
  return {
    networkProfiles: { A: network }, gatewayCatalog: {}, fare: 2,
    crossDemand: { schemaVersion: 1, gateways: ['pair'],
      popFields: ['id', 'mass', 'homePoint', 'workPoint', 'gateway', 'homeDepartureTime'],
      points: [['home', ...stations[0].coords, 'A'], ['work', ...stations[1].coords, 'B']],
      pops: [['first', 200, 0, 1, 0, '07:30'], ['second', 200, 0, 1, 0, '07:30']] },
    tileCatalog: { tiles: [
      { id: 'A', bounds: [139.7530879, 34.8991219, 140.8730335, 36.1041241], neighbors: [{ tileId: 'B' }] },
      { id: 'B', bounds: [136.0698356, 20.425009, 153.9828044, 35.8983674], neighbors: [{ tileId: 'A' }] },
    ] },
  };
}

const withoutWaypoints = input => ({ ...input, tileCatalog: null });

test('a reachable geographic gateway cannot force a detour over a continuous rail journey', () => {
  const input = fixture();
  const path = inspectCrossTileTransitPath({ ...input, popIndex: 0 });
  const expected = inspectCrossTileTransitPath({ ...withoutWaypoints(input), popIndex: 0 });
  assert.equal(path.available, true);
  assert.ok(path.totalClockSeconds < 20 * 60, 'the direct service takes under 20 minutes, rather than three hours via the waypoint');
  assert.equal(path.totalClockSeconds, expected.totalClockSeconds);
  assert.equal(path.continuous, true);
  assert.deepEqual(path.continuousLeg.stationRoutes, [{ routeId: 'direct', stationIds: ['home', 'work'] }]);
});

test('mode-choice details and fare quote use the continuous journey despite the tile gateway', () => {
  const input = fixture();
  input.journeyFare = routes => ({ total: routes.some(r => r.routeId === 'detour') ? 11 : 2 });
  const actual = inspectCrossTileModeChoice({ ...input, popIndex: 0 });
  const expected = inspectCrossTileModeChoice({ ...withoutWaypoints(input), popIndex: 0 });
  assert.deepEqual(actual, expected);
  assert.equal(actual.transit.moneyCost, 2);
});

test('capacity allocation and cached batches use the same continuous path as the trip inspector', () => {
  const input = fixture(), routingCache = createCrossTileRoutingCache();
  const actual = calculateCrossTileModeShares({ ...input, routingCache });
  const warm = calculateCrossTileModeShares({ ...structuredClone(input), routingCache });
  const expected = calculateCrossTileModeShares(withoutWaypoints(input));
  assert.deepEqual(actual.popModeChoices, expected.popModeChoices);
  assert.deepEqual(actual.transitJourneys, expected.transitJourneys);
  assert.deepEqual(warm.transitJourneys, actual.transitJourneys);
  const journeys = [...actual.transitJourneys.values()].flat();
  assert.ok(journeys.length > 0, 'the direct service carries riders');
  for (const journey of journeys) {
    assert.deepEqual(journey.stationRoutes, [{ routeId: 'direct', stationIds: ['home', 'work'] }]);
    assert.ok(journey.totalClockSeconds < 20 * 60);
  }
  assert.equal(warm.routingStats.searches, 0, 'warm routing still reuses exact searches');
});
