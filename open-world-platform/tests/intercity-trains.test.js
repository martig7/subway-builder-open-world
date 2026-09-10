import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntercityTrainTypes, registerIntercityTrains, INTERCITY_TRAINS_VERSION } from '../src/runtime/intercity-trains.js';
import { calculateGlobalExpenseProfile } from '../src/runtime/native-finance-model.js';

// The native API stores complete definitions without filling missing fields.
const requiredStats = `maxSpeed maxAcceleration maxDeceleration maxLateralAcceleration
  maxSlopePercentage maxSpeedLocalStation crossoverSpeed stopTimeSeconds minTurnRadius
  minStationTurnRadius parallelTrackSpacing trackClearance minCars maxCars carsPerCarSet
  capacityPerCar carLength trainWidth minStationLength maxStationLength carCost baseTrackCost
  baseStationCost trainOperationalCostPerHour carOperationalCostPerHour
  trackMaintenanceCostPerMeter stationMaintenanceCostPerYear tphLimit`.split(/\s+/);

test('complete native train definitions have finite physics/costs and fit their platforms', () => {
  for (const type of createIntercityTrainTypes()) {
    for (const key of requiredStats) assert.ok(Number.isFinite(type.stats[key]) && type.stats[key] > 0, `${type.id}.${key}`);
    const s = type.stats;
    assert.ok(s.minStationLength >= s.minCars * s.carLength + 4);
    assert.ok(s.maxStationLength >= s.maxCars * s.carLength + 4);
    assert.equal(s.minCars % s.carsPerCarSet, 0);
    assert.equal(s.maxCars % s.carsPerCarSet, 0);
    assert.deepEqual(type.compatibleTrackTypes, [type.id]);
    assert.equal(type.allowGradeCrossing, false);
    assert.equal(type.allowAtGradeRoadCrossing, false);
  }
  const [hsr, maglev] = createIntercityTrainTypes();
  assert.equal(hsr.stats.maxSpeed * 3.6, 320);
  assert.equal(maglev.stats.maxSpeed * 3.6, 430);
  assert.equal(hsr.stats.capacityPerCar * 8, 440);
  assert.equal(hsr.stats.carLength * 8, 201);
});

test('registration replaces stale definitions and survives native hot reload without changing inventory', () => {
  const registry = { 'heavy-metro': { id: 'heavy-metro' }, 'open-world-high-speed': { id: 'open-world-high-speed', stats: { maxSpeed: 1 } } };
  const inventory = { 'open-world-high-speed': 16, 'open-world-maglev': 5 };
  const originalInventory = structuredClone(inventory);
  const api = { trains: { registerTrainType(type) { registry[type.id] = type; inventory[type.id] ??= 0; } } };
  const old = registry['open-world-high-speed'];
  const first = registerIntercityTrains(api);
  assert.equal(first.version, INTERCITY_TRAINS_VERSION);
  assert.equal(first.status, 'registered');
  assert.notEqual(registry['open-world-high-speed'], old);
  const prior = registry['open-world-high-speed'];
  prior.stats.carCost = 1;
  delete registry['open-world-maglev'];
  registerIntercityTrains(api);
  assert.notEqual(registry['open-world-high-speed'], prior);
  assert.equal(registry['open-world-high-speed'].stats.carCost, 4_750_000);
  assert.ok(registry['open-world-maglev']);
  assert.equal(Object.keys(registry).length, 3);
  assert.deepEqual(inventory, originalInventory);
});

test('hosts without train registration report the missing capability', () => {
  assert.deepEqual(registerIntercityTrains({}).ids, []);
  assert.equal(registerIntercityTrains({}).status, 'unavailable');
});

test('global native finance uses each custom type for train and infrastructure expenses', () => {
  const types = createIntercityTrainTypes();
  const profile = calculateGlobalExpenseProfile({
    routes: types.map(t => ({ id: t.id, trainType: t.id })),
    trains: types.map(t => ({ routeId: t.id, cars: t.stats.minCars })),
    tracks: types.map(t => ({ id: t.id, trackType: t.id, length: 1000, buildType: 'constructed' })),
    trackGroups: types.map(t => ({ id: t.id, trackType: t.id, trackIds: [t.id], type: 'standard' })),
  }, Object.fromEntries(types.map(t => [t.id, t])));
  for (const type of types) {
    const s = type.stats;
    assert.equal(profile.routeHourly[type.id][0], (s.trainOperationalCostPerHour + s.minCars * s.carOperationalCostPerHour) * 365);
    assert.equal(profile.infrastructureItems.find(item => item.id === `track:${type.id}`).hourlyCost, 1000 * s.trackMaintenanceCostPerMeter / 24);
  }
});
