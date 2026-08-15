import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOffTileNativeDemand } from '../src/off-tile-native-demand.js';
import { createNetworkProfile } from '../src/cross-tile-mode-choice.js';

function fixtureNetwork(serviceCount = 2) {
  return createNetworkProfile({
    tileId: 'T1',
    stations: [
      { id: 'home-station', coords: [-73.8, 42.7], stNodeIds: ['home-node'], buildType: 'constructed' },
      { id: 'work-station', coords: [-73.7, 42.7], stNodeIds: ['work-node'], buildType: 'constructed' },
    ],
    routes: [{
      id: 'R',
      stNodes: [{ id: 'home-node' }, { id: 'work-node' }],
      stComboTimings: [
        { stNodeIndex: 0, arrivalTime: 0, departureTime: 20 },
        { stNodeIndex: 1, arrivalTime: 600, departureTime: 620 },
      ],
      idealTrainCount: serviceCount,
    }],
    trains: [],
  });
}

const demand = {
  points: [
    { id: 'home', location: [-73.8, 42.7], residents: 100, jobs: 0, popIds: ['native-pop'] },
    { id: 'work', location: [-73.7, 42.7], residents: 0, jobs: 100, popIds: ['native-pop'] },
  ],
  pops: [{
    id: 'native-pop', size: 100, residenceId: 'home', jobId: 'work',
    drivingSeconds: 3_600, drivingDistance: 25_000,
  }],
};

test('off-tile evaluator computes local mode share, ridership, and hourly revenue without a game store', () => {
  const result = evaluateOffTileNativeDemand({
    tileId: 'T1',
    demand,
    networkProfile: fixtureNetwork(),
    farePolicy: { fare: 2.5, fareGroups: [] },
    globalNativeState: { routes: [{ id: 'R' }], fareGroups: [] },
    financeOwnedRouteIds: ['R'],
  });

  assert.equal(result.status, 'evaluated');
  assert.equal(result.profile.source, 'off-tile-estimator');
  assert.equal(result.profile.tileId, 'T1');
  assert.equal(result.profile.hourly.length, 24);
  assert.ok(result.profile.transitPopulation > 0);
  assert.ok(result.profile.dailyRevenue > 0);
  assert.ok(result.profile.ridershipByRoute.R > 0);
  assert.equal(result.profile.modeChoicePopulation.transit, result.profile.transitPopulation);
  assert.ok(Math.abs(
    result.profile.hourly.reduce((total, hour) => total + hour.revenue, 0)
      - result.profile.dailyRevenue,
  ) < 1e-6);
});

test('off-tile evaluator reuses an identical cached profile and invalidates it on service changes', () => {
  const first = evaluateOffTileNativeDemand({
    tileId: 'T1', demand, networkProfile: fixtureNetwork(), farePolicy: { fare: 2.5 },
    globalNativeState: { routes: [{ id: 'R' }], fareGroups: [] },
  });
  const cached = evaluateOffTileNativeDemand({
    tileId: 'T1', demand, networkProfile: fixtureNetwork(), farePolicy: { fare: 2.5 },
    globalNativeState: { routes: [{ id: 'R' }], fareGroups: [] }, existingProfile: first.profile,
  });
  const changed = evaluateOffTileNativeDemand({
    tileId: 'T1', demand, networkProfile: fixtureNetwork(0), farePolicy: { fare: 2.5 },
    globalNativeState: { routes: [{ id: 'R' }], fareGroups: [] }, existingProfile: first.profile,
  });

  assert.equal(cached.status, 'cached');
  assert.deepEqual(cached.profile, first.profile);
  assert.equal(changed.status, 'evaluated');
  assert.notEqual(changed.profile.evaluationKey, first.profile.evaluationKey);
  assert.equal(changed.profile.transitPopulation, 0);
  assert.equal(changed.profile.dailyRevenue, 0);
});

test('off-tile evaluator assigns deterministic commute hours to packaged pops', () => {
  const input = {
    tileId: 'T1', demand, networkProfile: fixtureNetwork(), farePolicy: { fare: 2.5 },
    globalNativeState: { routes: [{ id: 'R' }], fareGroups: [] },
  };
  const left = evaluateOffTileNativeDemand(input);
  const right = evaluateOffTileNativeDemand(input);

  assert.deepEqual(left.profile.hourly, right.profile.hourly);
  assert.equal(left.profile.evaluationKey, right.profile.evaluationKey);
});
