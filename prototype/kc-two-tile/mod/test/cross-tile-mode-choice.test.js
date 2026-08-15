import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCrossTileModeShares, chooseModes, createNetworkProfile, inspectCrossTileModeChoice, inspectCrossTileTransitPath } from '../src/cross-tile-mode-choice.js';
import { WorldTileRuntime } from '../src/world-tile-runtime.js';
import { FakeGameAdapter } from '../src/adapters/fake-game-adapter.js';
import { MemoryTilePackageAdapter } from '../src/adapters/memory-tile-package-adapter.js';
import { ModStorageWorldStateAdapter } from '../src/adapters/mod-storage-world-state-adapter.js';

function profile(tileId, stationRows) {
  const stations = stationRows.map(([id, coords, node]) => ({ id, name: `${id} station`, coords, stNodeIds: [node], nearbyStations: [], buildType: 'constructed' }));
  return createNetworkProfile({
    tileId,
    stations,
    routes: [{ id: `${tileId}-route`, bullet: tileId, fullName: `${tileId} Line`, tempParentId: null, stNodes: stationRows.map(([, , node]) => ({ id: node })) }],
    trains: [{ id: `${tileId}-train`, routeId: `${tileId}-route` }],
  });
}

const west = profile('KCW', [
  ['west-home', [-94.66, 39.1000], 'west-home-node'],
  ['west-gate', [-94.604, 39.1000], 'west-gate-node'],
]);
const east = profile('KCE', [
  ['east-gate', [-94.603, 39.1000], 'east-gate-node'],
  ['east-work', [-94.54, 39.1000], 'east-work-node'],
]);
const crossDemand = {
  schemaVersion: 1,
  tileId: 'KCW',
  gateways: ['central'],
  points: [
    ['home', -94.66, 39.1000, 'KCW', 100, 0],
    ['work', -94.54, 39.1000, 'KCE', 0, 100],
  ],
  pops: [['pop', 100, 0, 1, 0]],
};
const gatewayCatalog = { central: { id: 'central', location: [-94.6035, 39.1000], capacityPerHour: 100 } };

test('uses the native income model and applies the minimum transit cohort floor', () => {
  const modes = chooseModes({ population: 100, drivingTime: 3_600, drivingDistance: 30_000, transitTime: 1_200, walkTime: 20_000, transitCost: 0 });
  assert.equal(Object.values(modes).reduce((sum, value) => sum + value, 0), 100);
  assert.ok(modes.transit >= 10);
});

test('deterministic income distributions remain isolated by income rules', () => {
  const trip = {
    population: 100,
    drivingTime: 600,
    drivingDistance: 10_000,
    transitTime: 1_800,
    walkTime: 20_000,
    transitCost: 0,
    drivingTimeMultiplier: 1,
  };
  const lowIncome = chooseModes({
    ...trip,
    pathfindingRules: { INCOME_MEAN: 15_000, INCOME_STD_DEV: 0, MINIMUM_INCOME: 15_000, MAXIMUM_INCOME: 15_000 },
  });
  const highIncome = chooseModes({
    ...trip,
    pathfindingRules: { INCOME_MEAN: 200_000, INCOME_STD_DEV: 0, MINIMUM_INCOME: 200_000, MAXIMUM_INCOME: 200_000 },
  });

  assert.notDeepEqual(lowIncome, highIncome);
  assert.deepEqual(chooseModes({
    ...trip,
    pathfindingRules: { INCOME_MEAN: 15_000, INCOME_STD_DEV: 0, MINIMUM_INCOME: 15_000, MAXIMUM_INCOME: 15_000 },
  }), lowIncome);
});

test('combines both persisted tile graphs through the selected gateway', () => {
  const calculated = calculateCrossTileModeShares({
    crossDemand,
    networkProfiles: { KCW: west, KCE: east },
    gatewayCatalog,
    fare: 0,
  });
  const modes = calculated.totals.get('KCW|KCE|central');
  assert.equal(Object.values(modes).reduce((sum, value) => sum + value, 0), 100);
  assert.equal(calculated.transitViablePops, 1);
  assert.ok(modes.transit > 0);
});

test('explains the station path used for a cross-city pop', () => {
  const path = inspectCrossTileTransitPath({
    crossDemand,
    popIndex: 0,
    networkProfiles: { KCW: west, KCE: east },
    gatewayCatalog,
  });

  assert.equal(path.available, true);
  assert.equal(path.homeLeg.originStationId, 'west-home');
  assert.equal(path.homeLeg.originStationName, 'west-home station');
  assert.equal(path.homeLeg.destinationStationId, 'west-gate');
  assert.equal(path.homeLeg.destinationStationName, 'west-gate station');
  assert.equal(path.workLeg.originStationId, 'east-gate');
  assert.equal(path.workLeg.destinationStationId, 'east-work');
  assert.deepEqual(path.homeLeg.stationRoutes, [
    { routeId: 'KCW-route', stationIds: ['west-home', 'west-gate'] },
  ]);
  assert.deepEqual(path.workLeg.stationRoutes, [
    { routeId: 'KCE-route', stationIds: ['east-gate', 'east-work'] },
  ]);
  assert.deepEqual(path.homeLeg.routes, [{
    routeId: 'KCW-route', bullet: 'KCW', name: 'KCW Line', label: 'KCW — KCW Line',
  }]);
  assert.deepEqual(path.workLeg.routes, [{
    routeId: 'KCE-route', bullet: 'KCE', name: 'KCE Line', label: 'KCE — KCE Line',
  }]);
  assert.ok(path.totalSeconds > path.gatewaySeconds);
});

test('explains the driving, transit, and representative-person costs used for mode choice', () => {
  const comparison = inspectCrossTileModeChoice({
    crossDemand,
    popIndex: 0,
    networkProfiles: { KCW: west, KCE: east },
    gatewayCatalog,
    fare: 2.5,
  });

  assert.ok(comparison.driving.clockSeconds > 0);
  assert.ok(comparison.driving.perceivedSeconds > comparison.driving.clockSeconds);
  assert.match(comparison.driving.estimator, /straight-line/);
  assert.equal(comparison.transit.perceivedSeconds, comparison.transitPath.totalSeconds);
  assert.equal(comparison.transit.moneyCost, 2.5);
  assert.equal(Object.values(comparison.modes).reduce((sum, value) => sum + value, 0), 100);
  assert.ok(Number.isFinite(comparison.representativePerson.generalizedCost.driving));
  assert.ok(Number.isFinite(comparison.representativePerson.generalizedCost.transit));
});

test('uses the routed journey fare instead of the global flat fare for mode choice', () => {
  const comparison = inspectCrossTileModeChoice({
    crossDemand,
    popIndex: 0,
    networkProfiles: { KCW: west, KCE: east },
    gatewayCatalog,
    fare: 3,
    journeyFare: (stationRoutes) => ({
      total: 17.25,
      revenueByRoute: Object.fromEntries(stationRoutes.map(({ routeId }) => [routeId, routeId === 'KCW-route' ? 8 : 9.25])),
    }),
  });

  assert.equal(comparison.transit.moneyCost, 17.25);
  assert.equal(comparison.fareQuote.total, 17.25);
  assert.deepEqual(comparison.stationRoutes.map(({ routeId }) => routeId), ['KCW-route', 'KCE-route']);
});

test('uses build-time road-route time and distance when the package provides them', () => {
  const routedDemand = {
    ...crossDemand,
    popFields: ['id', 'mass', 'homePoint', 'workPoint', 'gateway', 'drivingSeconds', 'drivingDistance'],
    drivingModel: { provider: 'osrm', label: 'OSRM driving / kc-osm-2026-08-11' },
    pops: [['pop', 100, 0, 1, 0, 777, 12_345]],
  };

  const comparison = inspectCrossTileModeChoice({
    crossDemand: routedDemand,
    popIndex: 0,
    networkProfiles: { KCW: west, KCE: east },
    gatewayCatalog,
    fare: 2.5,
  });

  assert.equal(comparison.driving.clockSeconds, 777);
  assert.equal(comparison.driving.distanceMetres, 12_345);
  assert.equal(comparison.driving.estimator, 'OSRM driving / kc-osm-2026-08-11');
});

test('prices each pop at its packaged departure time and native traffic level', () => {
  const routedDemand = {
    ...crossDemand,
    popFields: [
      'id', 'mass', 'homePoint', 'workPoint', 'gateway',
      'homeDepartureTime', 'workDepartureTime', 'drivingSeconds', 'drivingDistance',
    ],
    pops: [['pop', 100, 0, 1, 0, 4 * 3_600, 17 * 3_600, 600, 8_000]],
  };
  const comparison = inspectCrossTileModeChoice({
    crossDemand: routedDemand,
    popIndex: 0,
    networkProfiles: { KCW: west, KCE: east },
    gatewayCatalog,
    fare: 2.5,
    requestedDepartureSeconds: 10 * 86_400 + 12 * 3_600,
  });

  assert.equal(comparison.requestedDepartureSeconds, 10 * 86_400 + 4 * 3_600);
  assert.equal(comparison.driving.timeMultiplier, 0.9);
  assert.equal(comparison.driving.congestedClockSeconds, 540);
});

test('identifies when no saved network reaches the destination', () => {
  const path = inspectCrossTileTransitPath({
    crossDemand,
    popIndex: 0,
    networkProfiles: { KCW: west },
    gatewayCatalog,
  });

  assert.equal(path.available, false);
  assert.equal(path.homeLeg.available, true);
  assert.equal(path.workLeg.available, false);
  assert.equal(path.workLeg.reason, 'destination-outside-walk-range');
});

test('uses a cross-boundary route saved in the opposite tile for either leg', () => {
  const crossBoundary = profile('KCE', [
    ['west-home', [-94.66, 39.1000], 'west-home-node'],
    ['west-gate', [-94.604, 39.1000], 'west-gate-node'],
    ['east-gate', [-94.603, 39.1000], 'east-gate-node'],
    ['east-work', [-94.54, 39.1000], 'east-work-node'],
  ]);
  const path = inspectCrossTileTransitPath({
    crossDemand,
    popIndex: 0,
    networkProfiles: { KCE: crossBoundary },
    gatewayCatalog,
  });

  assert.equal(path.available, true);
  assert.equal(path.continuous, true);
  assert.equal(path.gatewaySeconds, 0);
  assert.equal(path.totalSeconds, path.continuousLeg.totalSeconds);
  assert.equal(path.continuousLeg.networkTileId, 'KCE');
});

test('combines complementary saved profiles into one continuous transit graph', () => {
  const firstHalf = profile('KCW', [
    ['home-station', [-94.66, 39.10], 'home-node'],
    ['shared-station', [-94.60, 39.10], 'shared-node-a'],
  ]);
  const secondHalf = profile('KCE', [
    ['shared-station', [-94.60, 39.10], 'shared-node-b'],
    ['work-station', [-94.54, 39.10], 'work-node'],
  ]);
  const demand = {
    schemaVersion: 1, gateways: ['central'],
    points: [
      ['home', -94.66, 39.10, 'KCW', 50, 0],
      ['work', -94.54, 39.10, 'KCE', 0, 50],
    ],
    pops: [['pop', 50, 0, 1, 0]],
  };

  const path = inspectCrossTileTransitPath({
    crossDemand: demand,
    popIndex: 0,
    networkProfiles: { KCW: firstHalf, KCE: secondHalf },
    gatewayCatalog,
  });

  assert.equal(path.available, true);
  assert.equal(path.continuous, true);
  assert.deepEqual(path.continuousLeg.stationRoutes.map(({ routeId }) => routeId), ['KCW-route', 'KCE-route']);
});

test('replays a cached gateway-to-gateway topology across populations', () => {
  const corridor = profile('A', [
    ['home-station', [-94.66, 39.10], 'home-node'],
    ['first-gateway-station', [-94.63, 39.10], 'first-node'],
    ['last-gateway-station', [-94.57, 39.10], 'last-node'],
    ['work-station', [-94.54, 39.10], 'work-node'],
  ]);
  const demand = {
    schemaVersion: 1, gateways: ['pair'],
    points: [
      ['home', -94.66, 39.10, 'A', 100, 0],
      ['work', -94.54, 39.10, 'C', 0, 100],
    ],
    pops: [['one', 50, 0, 1, 0], ['two', 50, 0, 1, 0]],
  };
  const catalog = {
    tiles: [
      { id: 'A', bounds: [-94.69, 39.05, -94.63, 39.15], neighbors: [{ tileId: 'B' }] },
      { id: 'B', bounds: [-94.63, 39.05, -94.57, 39.15], neighbors: [{ tileId: 'A' }, { tileId: 'C' }] },
      { id: 'C', bounds: [-94.57, 39.05, -94.51, 39.15], neighbors: [{ tileId: 'B' }] },
    ],
  };
  const demandBefore = structuredClone(demand);

  const calculated = calculateCrossTileModeShares({
    crossDemand: demand,
    networkProfiles: { A: corridor },
    gatewayCatalog: { pair: { id: 'pair', location: [-94.60, 39.10] } },
    tileCatalog: catalog,
    fare: 0,
  });

  assert.deepEqual(calculated.routingStats, {
    gatewayPathHits: 1, gatewayPathMisses: 1,
    endpointPathHits: 2, endpointPathMisses: 2,
    catchmentHits: 6, catchmentMisses: 4,
  });
  assert.ok(calculated.transitViablePops > 0);
  assert.deepEqual(demand, demandBefore);
});

test('reuses station-catchment endpoint paths for an adjacent tile crossing', () => {
  const corridor = profile('A', [
    ['home-station', [-94.66, 39.10], 'home-node'],
    ['gateway-station', [-94.60, 39.10], 'gateway-node'],
    ['work-station', [-94.54, 39.10], 'work-node'],
  ]);
  const demand = {
    schemaVersion: 1, gateways: ['pair'],
    points: [
      ['home', -94.66, 39.10, 'A', 100, 0],
      ['work', -94.54, 39.10, 'B', 0, 100],
      ['home-neighbor', -94.659, 39.10, 'A', 100, 0],
      ['work-neighbor', -94.541, 39.10, 'B', 0, 100],
    ],
    pops: [['one', 50, 0, 1, 0], ['two', 50, 2, 3, 0]],
  };
  const inputs = {
    crossDemand: demand,
    networkProfiles: { A: corridor },
    gatewayCatalog: { pair: { id: 'pair', location: [-94.60, 39.10] } },
    tileCatalog: { tiles: [
      { id: 'A', bounds: [-94.69, 39.05, -94.60, 39.15], neighbors: [{ tileId: 'B' }] },
      { id: 'B', bounds: [-94.60, 39.05, -94.51, 39.15], neighbors: [{ tileId: 'A' }] },
    ] },
    fare: 0,
  };
  const calculated = calculateCrossTileModeShares(inputs);
  const uncachedSecond = calculateCrossTileModeShares({
    ...inputs, crossDemand: { ...demand, pops: [demand.pops[1]] },
  });

  assert.equal(calculated.routingStats.gatewayPathHits, 0);
  assert.equal(calculated.routingStats.gatewayPathMisses, 0);
  assert.equal(calculated.routingStats.endpointPathHits, 2);
  assert.equal(calculated.routingStats.endpointPathMisses, 2);
  assert.ok(calculated.transitViablePops > 0);
  assert.deepEqual(calculated.popModeChoices.two, uncachedSecond.popModeChoices.two);
  const cachedJourney = [...calculated.transitJourneys.values()].flat().find(({ popId }) => popId === 'two');
  const uncachedJourney = [...uncachedSecond.transitJourneys.values()].flat().find(({ popId }) => popId === 'two');
  assert.equal(cachedJourney?.totalClockSeconds, uncachedJourney?.totalClockSeconds);
});

test('duplicate saved profiles do not alter a global route result', () => {
  const path = inspectCrossTileTransitPath({
    crossDemand,
    popIndex: 0,
    networkProfiles: { KCE: profile('KCE', [
      ['west-home', [-94.66, 39.1000], 'west-home-node'],
      ['east-work', [-94.54, 39.1000], 'east-work-node'],
    ]) },
    gatewayCatalog,
  });
  const duplicate = inspectCrossTileTransitPath({
    crossDemand,
    popIndex: 0,
    networkProfiles: {
      KCE: profile('KCE', [
        ['west-home', [-94.66, 39.1000], 'west-home-node'],
        ['east-work', [-94.54, 39.1000], 'east-work-node'],
      ]),
      COPY: { ...profile('KCE', [
        ['west-home', [-94.66, 39.1000], 'west-home-node'],
        ['east-work', [-94.54, 39.1000], 'east-work-node'],
      ]), tileId: 'COPY' },
    },
    gatewayCatalog,
  });

  assert.equal(duplicate.totalSeconds, path.totalSeconds);
  assert.deepEqual(duplicate.continuousLeg.stationRoutes, path.continuousLeg.stationRoutes);
});

test('a legacy duplicate route cannot erase current route display metadata', () => {
  const current = profile('KCE', [
    ['west-home', [-94.66, 39.1000], 'west-home-node'],
    ['east-work', [-94.54, 39.1000], 'east-work-node'],
  ]);
  const legacy = structuredClone(current);
  legacy.tileId = 'AA_LEGACY';
  legacy.routes[0].bullet = null;
  legacy.routes[0].name = null;
  legacy.routes[0].fullName = null;
  legacy.routes[0].stNodeIds.push('legacy-remote-node');

  const path = inspectCrossTileTransitPath({
    crossDemand,
    popIndex: 0,
    networkProfiles: { AA_LEGACY: legacy, KCE: current },
    gatewayCatalog,
  });

  assert.equal(path.available, true);
  assert.deepEqual(path.continuousLeg.routes, [{
    routeId: 'KCE-route', bullet: 'KCE', name: 'KCE Line', label: 'KCE — KCE Line',
  }]);
});

test('stitching tile-local route halves adds no gateway walk or second wait', () => {
  const path = inspectCrossTileTransitPath({
    crossDemand,
    popIndex: 0,
    networkProfiles: { KCW: west, KCE: east },
    gatewayCatalog,
  });

  assert.equal(path.continuous, false);
  assert.equal(path.gatewaySeconds, 0);
  assert.equal(path.homeSegmentSeconds, path.homeLeg.totalSeconds - path.homeLeg.egressPerceivedSeconds);
  assert.equal(path.workSegmentSeconds, path.workLeg.totalSeconds - path.workLeg.accessPerceivedSeconds - path.workLeg.waitPerceivedSeconds - path.workLeg.departureShiftPerceivedSeconds);
  assert.equal(path.totalSeconds, path.homeSegmentSeconds + path.workSegmentSeconds);
});

test('uses the bundled 30-minute maximum station walk catchment', () => {
  const distantHome = {
    ...crossDemand,
    points: [
      ['home', -94.6035, 39.1270, 'KCW', 100, 0],
      crossDemand.points[1],
    ],
  };
  const path = inspectCrossTileTransitPath({
    crossDemand: distantHome,
    popIndex: 0,
    networkProfiles: { KCW: west, KCE: east },
    gatewayCatalog,
  });

  assert.equal(path.homeLeg.available, false);
  assert.equal(path.homeLeg.reason, 'origin-outside-walk-range');
});

test('schedule changes alter the persisted network signature and service frequency', () => {
  const input = {
    tileId: 'KCW',
    stations: [{ id: 'a', coords: [-94.66, 39.1], stNodeIds: ['a'], buildType: 'constructed' }, { id: 'b', coords: [-94.60, 39.1], stNodeIds: ['b'], buildType: 'constructed' }],
    trains: [],
  };
  const sparse = createNetworkProfile({ ...input, routes: [{ id: 'r', tempParentId: null, idealTrainCount: 1, stNodes: [{ id: 'a' }, { id: 'b' }] }] });
  const frequent = createNetworkProfile({ ...input, routes: [{ id: 'r', tempParentId: null, idealTrainCount: 6, stNodes: [{ id: 'a' }, { id: 'b' }] }] });
  assert.notEqual(sparse.signature, frequent.signature);
  assert.equal(sparse.routes[0].serviceCount, 1);
  assert.equal(frequent.routes[0].serviceCount, 6);
});

test('partial-route dormant presentation retains global service frequency', () => {
  const profile = createNetworkProfile({
    tileId: 'KCW',
    stations: [
      { id: 'a-station', coords: [-94.66, 39.1], stNodeIds: ['a'], buildType: 'constructed' },
      { id: 'b-station', coords: [-94.60, 39.1], stNodeIds: ['b'], buildType: 'constructed' },
    ],
    trains: [],
    routes: [{
      id: 'partial-route', tempParentId: null,
      stNodes: [{ id: 'a' }, { id: 'b' }],
      trainSchedule: { highDemand: 0, mediumDemand: 0, lowDemand: 0, veryLowDemand: 0 },
      openWorldGlobalTrainSchedule: { highDemand: 11, mediumDemand: 6, lowDemand: 4, veryLowDemand: 3 },
    }],
  });

  assert.equal(profile.routes[0].configuredServiceCount, 11);
  assert.equal(profile.routes[0].serviceCount, 11);
});

test('automatic live train cycling does not look like a structural network change', () => {
  const route = {
    id: 'r', tempParentId: null, idealTrainCount: 2,
    stNodes: [{ id: 'a' }, { id: 'b' }],
  };
  const input = {
    tileId: 'KCW', routes: [route],
    stations: [
      { id: 'a-station', coords: [-94.66, 39.1], stNodeIds: ['a'], buildType: 'constructed' },
      { id: 'b-station', coords: [-94.60, 39.1], stNodeIds: ['b'], buildType: 'constructed' },
    ],
  };
  const twoLive = createNetworkProfile({ ...input, trains: [
    { id: 'one', routeId: 'r' }, { id: 'two', routeId: 'r' },
  ] });
  const threeLive = createNetworkProfile({ ...input, trains: [
    { id: 'one', routeId: 'r' }, { id: 'two', routeId: 'r' }, { id: 'cycle-extra', routeId: 'r' },
  ] });

  assert.equal(typeof twoLive.structuralSignature, 'string');
  assert.equal(twoLive.structuralSignature, threeLive.structuralSignature);
  assert.notEqual(twoLive.signature, threeLive.signature);
});

test('uses native route timings and prices the first departure like the bundled pathfinder', () => {
  const timed = createNetworkProfile({
    tileId: 'KCW',
    stations: [
      { id: 'a-station', coords: [-94.60, 39.10], stNodeIds: ['a'], buildType: 'constructed' },
      { id: 'b-station', coords: [-94.50, 39.10], stNodeIds: ['b'], buildType: 'constructed' },
      { id: 'return-station', coords: [-94.40, 39.10], stNodeIds: ['return'], buildType: 'constructed' },
    ],
    routes: [{
      id: 'timed-route',
      tempParentId: null,
      stNodes: [{ id: 'a' }, { id: 'b' }, { id: 'return' }],
      stComboTimings: [
        { stNodeIndex: 0, arrivalTime: 0, departureTime: 20 },
        { stNodeIndex: 1, arrivalTime: 80, departureTime: 100 },
        { stNodeIndex: 2, arrivalTime: 160, departureTime: 180 },
      ],
      idealTrainCount: 2,
    }],
    trains: [],
  });
  const localDemand = {
    schemaVersion: 1,
    gateways: ['unused'],
    points: [
      ['home', -94.60, 39.10, 'KCW', 50, 0],
      ['work', -94.50, 39.10, 'KCW', 0, 50],
    ],
    pops: [['pop', 50, 0, 1, 0]],
  };

  const path = inspectCrossTileTransitPath({
    crossDemand: localDemand,
    popIndex: 0,
    networkProfiles: { KCW: timed },
    gatewayCatalog: {},
    requestedDepartureSeconds: 0,
  });

  // Native times: the train leaves A at 20s and reaches B at 80s. With a
  // 180s cycle and two trains, the next feasible departure is 110s. The pop
  // leaves 60s later, arrives 50s before the train, then rides for 60s.
  assert.equal(path.continuousLeg.networkSeconds, 60);
  assert.equal(path.continuousLeg.departureShiftSeconds, 60);
  assert.equal(path.continuousLeg.waitSeconds, 50);
  assert.equal(path.continuousLeg.departureShiftPerceivedSeconds, 24);
  assert.equal(path.continuousLeg.waitPerceivedSeconds, 68.5);
  assert.equal(path.continuousLeg.totalSeconds, 152.5);
});

test('staying aboard adjacent route states counts intermediate dwell as train time', () => {
  const timed = createNetworkProfile({
    tileId: 'KCW',
    stations: [
      { id: 'a-station', coords: [-94.60, 39.10], stNodeIds: ['a'], buildType: 'constructed' },
      { id: 'b-station', coords: [-94.55, 39.10], stNodeIds: ['b'], buildType: 'constructed' },
      { id: 'c-station', coords: [-94.50, 39.10], stNodeIds: ['c'], buildType: 'constructed' },
    ],
    routes: [{
      id: 'timed-route', tempParentId: null,
      stNodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      stComboTimings: [
        { stNodeIndex: 0, arrivalTime: 0, departureTime: 20 },
        { stNodeIndex: 1, arrivalTime: 80, departureTime: 100 },
        { stNodeIndex: 2, arrivalTime: 160, departureTime: 180 },
      ],
      idealTrainCount: 2,
    }],
    trains: [],
  });
  const demand = {
    schemaVersion: 1, gateways: ['unused'],
    points: [['home', -94.60, 39.10, 'KCW', 50, 0], ['work', -94.50, 39.10, 'KCW', 0, 50]],
    pops: [['pop', 50, 0, 1, 0]],
  };

  const path = inspectCrossTileTransitPath({
    crossDemand: demand, popIndex: 0, networkProfiles: { KCW: timed }, gatewayCatalog: {}, requestedDepartureSeconds: 0,
  });

  assert.equal(path.continuousLeg.networkSeconds, 140);
  assert.deepEqual(path.continuousLeg.stationRoutes, [{
    routeId: 'timed-route', stationIds: ['a-station', 'b-station', 'c-station'],
  }]);
});

test('preserves live train departure phases instead of assuming a zero-clock headway', () => {
  const route = {
    id: 'phased-route', tempParentId: null,
    stNodes: [{ id: 'a' }, { id: 'b' }, { id: 'return' }],
    stComboTimings: [
      { stNodeIndex: 0, arrivalTime: 0, departureTime: 20 },
      { stNodeIndex: 1, arrivalTime: 80, departureTime: 100 },
      { stNodeIndex: 2, arrivalTime: 160, departureTime: 180 },
    ],
  };
  const timed = createNetworkProfile({
    tileId: 'KCW',
    stations: [
      { id: 'a-station', coords: [-94.60, 39.10], stNodeIds: ['a'], buildType: 'constructed' },
      { id: 'b-station', coords: [-94.50, 39.10], stNodeIds: ['b'], buildType: 'constructed' },
      { id: 'return-station', coords: [-94.40, 39.10], stNodeIds: ['return'], buildType: 'constructed' },
    ],
    routes: [route],
    trains: [
      { id: 'one', routeId: route.id, timings: [{ stNodeId: 'a', expectedDepartureTime: 40 }] },
      { id: 'two', routeId: route.id, timings: [{ stNodeId: 'a', expectedDepartureTime: 130 }] },
    ],
  });
  const localDemand = {
    schemaVersion: 1, gateways: ['unused'],
    points: [['home', -94.60, 39.10, 'KCW', 50, 0], ['work', -94.50, 39.10, 'KCW', 0, 50]],
    pops: [['pop', 50, 0, 1, 0]],
  };

  const path = inspectCrossTileTransitPath({
    crossDemand: localDemand, popIndex: 0, networkProfiles: { KCW: timed }, gatewayCatalog: {}, requestedDepartureSeconds: 0,
  });

  assert.deepEqual(timed.routes[0].departureAnchorsByNode.a, [40, 130]);
  assert.equal(path.continuousLeg.departureShiftSeconds, 80);
});

test('daily runtime recalculation is idempotent for the same game day while network changes force a refresh', async () => {
  const commuteCatalog = {
    buildHash: 'mode-choice-fixture',
    buckets: [{ id: 'flow', mass: 100, homeTileId: 'KCW', workTileId: 'KCE', gatewayId: 'central' }],
    gateways: [gatewayCatalog.central],
  };
  const packages = Object.fromEntries(['KCW', 'KCE'].map((tileId) => [tileId, {
    manifest: { tileId, cityCode: tileId, schemaVersion: 1, dataFiles: { demandData: 'demand.json' } },
    commuteCatalog,
    crossDemand: { ...crossDemand, tileId },
  }]));
  const game = new FakeGameAdapter();
  game.native.networkProfile = west;
  const storage = new ModStorageWorldStateAdapter();
  const runtime = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { activeTileId: 'KCW', wallet: 100, cohorts: [] },
  });
  await runtime.boot('mode-choice');
  let fullWorldSaves = 0;
  const save = storage.save.bind(storage);
  storage.save = async (...args) => { fullWorldSaves++; return save(...args); };

  const first = await runtime.recalculateCrossTileModeShare({ reason: 'daily', day: 2 });
  const duplicate = await runtime.recalculateCrossTileModeShare({ reason: 'daily', day: 2 });
  game.native.networkProfile = { ...west, signature: 'changed', structuralSignature: 'changed' };
  const network = await runtime.recalculateCrossTileModeShare({ reason: 'network-change', day: 2 });

  assert.equal(first.status, 'recalculated');
  assert.equal(duplicate.status, 'already-current');
  assert.equal(network.status, 'recalculated');
  assert.equal(fullWorldSaves, 0, 'recalculating deterministic mode share must not rewrite the full world');
  assert.equal(runtime.view().crossModeShare.revision, 2);
  assert.equal(Object.values(runtime.view().gatewayLedger.flow.modeChoice).reduce((sum, value) => sum + value, 0), 100);
  assert.deepEqual(runtime.view().crossPopModeChoices.pop,
    calculateCrossTileModeShares({
      crossDemand,
      networkProfiles: { KCW: west },
      gatewayCatalog,
      fare: 2.5,
      requestedDepartureSeconds: 0,
    }).popModeChoices.pop);
});
