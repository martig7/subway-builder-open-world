import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../../../../open-world-platform/src/runtime/world-model.js';
import { advanceCommutesTo, applyModeShares, assertCommuteLedger, migrateCommuteLedger, projectCommutesForTile, registerCommuteCatalog } from '../../../../open-world-platform/src/runtime/cross-tile-commute-engine.js';

const catalog = {
  buildHash: 'commute-test-v1',
  gateways: [{ id: 'central', capacityPerHour: 5 }],
  buckets: [
    { id: 'a-west-east', homeTileId: 'KCW', workTileId: 'KCE', gatewayId: 'central', mass: 6, defaultTravelSeconds: 3600 },
    { id: 'b-west-east', homeTileId: 'KCW', workTileId: 'KCE', gatewayId: 'central', mass: 6, defaultTravelSeconds: 3600 },
  ],
};

test('ledger validation does not compile or clone unchanged journey templates', () => {
  const world = createWorld({ worldId:'validation', tileIds:['KCW','KCE'] });
  registerCommuteCatalog(world, catalog);
  const entry = world.gatewayLedger['a-west-east'];
  let reads = 0;
  entry.transitJourneys = [{ transitMass:1, fare:2, get stationRoutes() { reads++; return [{routeId:'r',stationIds:['a','b']}]; } }];
  assertCommuteLedger(world);
  assert.equal(reads, 0, 'validation only needs balances and mode conservation');
  entry.atHome = -1;
  assert.throws(() => assertCommuteLedger(world), /commute balance/);
});

test('dispatches gateway-aggregated commutes with shared capacity and exact conservation', () => {
  const world = createWorld({ worldId: 'commute-test', tileIds: ['KCW', 'KCE'] });
  registerCommuteCatalog(world, catalog);

  advanceCommutesTo(world, 7);
  let west = projectCommutesForTile(world, 'KCW');
  assert.equal(west.waitingToLeave, 7);
  assert.equal(west.outboundInTransit, 5);

  advanceCommutesTo(world, 10);
  west = projectCommutesForTile(world, 'KCW');
  const east = projectCommutesForTile(world, 'KCE');
  assert.equal(west.present, 0);
  assert.equal(east.present, 12);
  assert.equal(east.inboundInTransit, 0);

  advanceCommutesTo(world, 20);
  west = projectCommutesForTile(world, 'KCW');
  assert.equal(west.present, 12);
  assert.equal(west.globalBacklog, 0);
  assert.equal(west.globalInTransit, 0);
  assertCommuteLedger(world);
});

test('loading the same logical catalog from the other tile preserves positions', () => {
  const world = createWorld({ worldId: 'commute-test', tileIds: ['KCW', 'KCE'] });
  registerCommuteCatalog(world, catalog);
  advanceCommutesTo(world, 8);
  const before = structuredClone(world.gatewayLedger);
  registerCommuteCatalog(world, { ...catalog, tileId: 'KCE' });
  assert.deepEqual(world.gatewayLedger, before);
});

test('cross-tile demand starts with a driving baseline instead of an uncomputed gray mode', () => {
  const world = createWorld({ worldId: 'commute-mode-baseline', tileIds: ['KCW', 'KCE'] });
  registerCommuteCatalog(world, catalog);

  for (const entry of Object.values(world.gatewayLedger)) {
    assert.deepEqual(entry.modeChoice, {
      driving: entry.flow.mass,
      walking: 0,
      transit: 0,
      unknown: 0,
    });
  }
});

test('dispatch attributes fare and riders to every native route used by the cross-tile journey', () => {
  const world = createWorld({ worldId: 'commute-attribution', tileIds: ['KCW', 'KCE'] });
  registerCommuteCatalog(world, {
    buildHash: 'attribution-v1', gateways: [{ id: 'central', capacityPerHour: 100 }],
    buckets: [{ id: 'flow', homeTileId: 'KCW', workTileId: 'KCE', gatewayId: 'central', mass: 10, defaultTravelSeconds: 3600 }],
  });
  world.farePolicy.fare = 3;
  applyModeShares(world, new Map([['KCW|KCE|central', { driving: 6, walking: 0, transit: 4, unknown: 0 }]]), {
    transitJourneys: new Map([['KCW|KCE|central', [{
      popId: 'cross-pop', transitMass: 4, totalClockSeconds: 900,
      fare: 10,
      revenueByRoute: { 'route-west': 4, 'route-east': 6 },
      stationRoutes: [
        { routeId: 'route-west', stationIds: ['west-home', 'gateway'] },
        { routeId: 'route-east', stationIds: ['gateway', 'east-work'] },
      ],
    }]]]),
  });

  assert.deepEqual(world.gatewayLedger.flow.settlementTemplate.routeRevenueWeightByRoute, {
    'route-west': 1.6, 'route-east': 2.4,
  });
  assert.equal(world.gatewayLedger.flow.settlementTemplate.transitShare, 0.4);

  advanceCommutesTo(world, 7);

  assert.equal(world.crossTileFinancials.pendingNativeRevenue, 14_600);
  assert.deepEqual(world.pendingCrossTileAttribution.revenueByRoute, {
    'route-west': 5_840, 'route-east': 8_760,
  });
  assert.deepEqual(world.pendingCrossTileAttribution.completedCommutes[0], {
    popId: 'cross-pop:toWork:7', size: 4,
    fareRevenue: 14_600,
    revenueByRoute: { 'route-west': 5_840, 'route-east': 8_760 },
    stationRoutes: [
      { routeId: 'route-west', stationIds: ['west-home', 'gateway'] },
      { routeId: 'route-east', stationIds: ['gateway', 'east-work'] },
    ],
    journeyStart: 25_200, journeyEnd: 26_100, origin: 'home',
  });
});

test('small transit shares retain route fare attribution until final settlement rounding', () => {
  const world = createWorld({ worldId: 'small-share-attribution', tileIds: ['KCW', 'KCE'] });
  registerCommuteCatalog(world, {
    buildHash: 'small-share-attribution-v1', gateways: [{ id: 'central', capacityPerHour: 10_000 }],
    buckets: [{ id: 'flow', homeTileId: 'KCW', workTileId: 'KCE', gatewayId: 'central', mass: 10_000, defaultTravelSeconds: 3600 }],
  });
  world.farePolicy.fare = 3;
  applyModeShares(world, new Map([['KCW|KCE|central', {
    driving: 9_999, walking: 0, transit: 1, unknown: 0,
  }]]), {
    transitJourneys: new Map([['KCW|KCE|central', [{
      popId: 'small-share-pop', transitMass: 1, totalClockSeconds: 900,
      fare: 3, revenueByRoute: { route: 3 },
      stationRoutes: [{ routeId: 'route', stationIds: ['west-home', 'east-work'] }],
    }]]]),
  });

  advanceCommutesTo(world, 7);

  const completed = world.pendingCrossTileAttribution.completedCommutes[0];
  assert.equal(world.crossTileFinancials.pendingNativeRevenue, 1_095);
  assert.equal(completed.revenueByRoute.route, 1_095);
  assert.equal(world.pendingCrossTileAttribution.revenueByRoute.route, 1_095);
});

test('fractional cross-tile mode shares record conserved whole riders across capacity batches', () => {
  const world = createWorld({ worldId: 'whole-rider-attribution', tileIds: ['KCW', 'KCE'] });
  registerCommuteCatalog(world, {
    buildHash: 'whole-rider-attribution-v1', gateways: [{ id: 'central', capacityPerHour: 5 }],
    buckets: [{ id: 'flow', homeTileId: 'KCW', workTileId: 'KCE', gatewayId: 'central', mass: 10, defaultTravelSeconds: 3600 }],
  });
  applyModeShares(world, new Map([['KCW|KCE|central', {
    driving: 7.5, walking: 0, transit: 2.5, unknown: 0,
  }]]), {
    transitJourneys: new Map([['KCW|KCE|central', [{
      popId: 'fractional-pop', transitMass: 2.5, totalClockSeconds: 900,
      fare: 3, stationRoutes: [{ routeId: 'route', stationIds: ['west-home', 'east-work'] }],
    }]]]),
  });

  advanceCommutesTo(world, 7);
  assert.equal(world.crossTileFinancials.transitTrips, 1);
  advanceCommutesTo(world, 8);

  const recorded = world.pendingCrossTileAttribution.completedCommutes;
  assert.equal(world.crossTileFinancials.transitTrips, 3);
  assert.equal(world.gatewayLedger.flow.transitTrips, 3);
  assert.ok(recorded.every((commute) => Number.isSafeInteger(commute.size)));
  assert.equal(recorded.reduce((sum, commute) => sum + commute.size, 0), 3);
});

test('legacy fractional cross-tile ridership migrates to whole-person records', () => {
  const world = createWorld({ worldId: 'whole-rider-migration', tileIds: ['KCW', 'KCE'] });
  registerCommuteCatalog(world, {
    buildHash: 'whole-rider-migration-v1', gateways: [{ id: 'central', capacityPerHour: 5 }],
    buckets: [{ id: 'flow', homeTileId: 'KCW', workTileId: 'KCE', gatewayId: 'central', mass: 10, defaultTravelSeconds: 3600 }],
  });
  world.commuteLedgerSchemaVersion = 2;
  world.gatewayLedger.flow.transitTrips = 2.5;
  world.crossTileFinancials.transitTrips = 2.5;
  world.pendingCrossTileAttribution.completedCommutes = [{ popId: 'legacy', size: 2.5 }];

  migrateCommuteLedger(world);

  assert.equal(world.commuteLedgerSchemaVersion, 3);
  assert.equal(world.gatewayLedger.flow.transitTrips, 3);
  assert.equal(world.gatewayLedger.flow.transitTripRemainder, -0.5);
  assert.equal(world.crossTileFinancials.transitTrips, 3);
  assert.equal(world.pendingCrossTileAttribution.completedCommutes[0].size, 3);
});

test('skips inert hours and processes only scheduled commute events', () => {
  const world = createWorld({ worldId: 'event-plan', tileIds: ['KCW', 'KCE'] });
  registerCommuteCatalog(world, catalog);

  const overnight = advanceCommutesTo(world, 6);
  const morning = advanceCommutesTo(world, 7);
  const lateMorning = advanceCommutesTo(world, 16);

  assert.deepEqual(overnight, { processedHours: 6, activeHours: 0, transitTrips: 0, fareRevenue: 0 });
  assert.equal(morning.activeHours, 1);
  assert.ok(lateMorning.activeHours < lateMorning.processedHours);
});
