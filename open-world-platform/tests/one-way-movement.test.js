import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld } from '../src/runtime/world-model.js';
import {
  advanceCommutesTo, assertCommuteLedger, projectCommutesForTile,
  rebaseCommutesTo, registerCommuteCatalog,
} from '../src/runtime/cross-tile-commute-engine.js';

function worldWithOneWay(capacity = 100) {
  const world = createWorld({ worldId: 'one-way-test', tileIds: ['A', 'B'] });
  registerCommuteCatalog(world, {
    buildHash: 'one-way-test-v1',
    gateways: [{ id: 'one-way-gateway', capacityPerHour: capacity }],
    buckets: [{ id: 'one-way-flow', homeTileId: 'A', workTileId: 'B', gatewayId: 'one-way-gateway',
      tripType: 'oneWay', departureHour: 12, mass: 12, defaultTravelSeconds: 3600 }],
  });
  return world;
}

test('one-way daily movement dispatches once, arrives, and never queues an automatic return', () => {
  const world = worldWithOneWay();
  assert.equal(projectCommutesForTile(world, 'A').totalCrossTileWorkers, 0);
  advanceCommutesTo(world, 12);
  assert.equal(projectCommutesForTile(world, 'A').outboundInTransit, 12);
  advanceCommutesTo(world, 13);
  assert.equal(projectCommutesForTile(world, 'B').present, 0);
  advanceCommutesTo(world, 23);
  assert.equal(world.gatewayLedger['one-way-flow'].toHome.length, 0);
  assert.equal(world.gatewayLedger['one-way-flow'].queuedToHome, 0);
  assert.equal(world.gatewayLedger['one-way-flow'].atWork, 0);
  assert.equal(world.crossTileFinancials.transitTrips, 0);
  advanceCommutesTo(world, 36);
  assert.equal(projectCommutesForTile(world, 'A').outboundInTransit, 12);
  assertCommuteLedger(world);
});

test('one-way backlog carries forward without minting a return or losing daily controls', () => {
  const world = worldWithOneWay(5);
  advanceCommutesTo(world, 12);
  assert.equal(world.gatewayLedger['one-way-flow'].queuedToWork, 7);
  advanceCommutesTo(world, 13);
  assert.equal(world.gatewayLedger['one-way-flow'].queuedToWork, 2);
  advanceCommutesTo(world, 36);
  assert.equal(world.gatewayLedger['one-way-flow'].queuedToWork, 7);
  assert.equal(world.gatewayLedger['one-way-flow'].toHome.length, 0);
  assertCommuteLedger(world);
});

test('one-way rebase reconstructs a day without inventing a home-work population', () => {
  const world = worldWithOneWay();
  advanceCommutesTo(world, 36);
  rebaseCommutesTo(world, 37);
  assert.equal(world.gatewayLedger['one-way-flow'].atHome, 0);
  assert.equal(world.gatewayLedger['one-way-flow'].atWork, 0);
  assert.equal(projectCommutesForTile(world, 'A').totalCrossTileWorkers, 0);
  assertCommuteLedger(world);
});

test('one-way rebase retains earlier departures still in flight on long journeys', () => {
  const world = createWorld({ worldId: 'long-trip', tileIds: ['A', 'B'] });
  registerCommuteCatalog(world, { buildHash: 'long-one-way',
    gateways: [{ id: 'g', capacityPerHour: 100 }],
    buckets: [{ id: 'long', homeTileId: 'A', workTileId: 'B', gatewayId: 'g',
      tripType: 'oneWay', departureHour: 12, mass: 10, travelHours: 60 }],
  });
  rebaseCommutesTo(world, 65);
  assert.equal(world.gatewayLedger.long.toWork.length, 3);
  assert.equal(projectCommutesForTile(world, 'A').outboundInTransit, 30);
});

test('unknown cross-tile trip type is rejected', () => {
  const world = createWorld({ worldId: 'invalid-trip', tileIds: ['A', 'B'] });
  assert.throws(() => registerCommuteCatalog(world, { buildHash: 'invalid',
    gateways: [{ id: 'g', capacityPerHour: 10 }],
    buckets: [{ id: 'bad', homeTileId: 'A', workTileId: 'B', gatewayId: 'g', mass: 1,
      tripType: 'roundTripTour' }],
  }), /Invalid cross-tile trip type/);
});
