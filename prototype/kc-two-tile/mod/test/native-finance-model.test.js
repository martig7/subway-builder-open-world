import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backgroundFinanceForHour,
  calculateGlobalExpenseProfile,
  calculateNativeRevenueProfile,
  createNativeTopologyFinancePolicy,
  invalidateAffectedRevenueProfiles,
  migrateCachedNativeRevenueProfile,
  migrateNativeFinanceSidecar,
  nativeComparableFinanceForHour,
  projectNativeBackgroundFinance,
  summarizeNativeFinanceAudit,
} from '../../../../open-world-platform/src/runtime/native-finance-model.js';

test('native revenue profile reuses calculated native transit shares and fares', () => {
  const profile = calculateNativeRevenueProfile([{
    homeDepartureTime: 8 * 3_600 + 900,
    workDepartureTime: 18 * 3_600 + 1_800,
    lastCommute: {
      modeChoice: { transit: 2 },
      transitPaths: [{
        fareCost: 3,
        segments: [{ routeId: 'A' }, { routeId: 'B' }, { routeId: 'A' }],
      }],
    },
  }]);

  assert.equal(profile.schemaVersion, 5);
  assert.equal(profile.ridershipRecording, 'whole-person-ridership-v1');
  assert.equal(profile.hourly[8].revenue, 2 * 3 * 365);
  assert.equal(profile.hourly[18].revenue, 2 * 3 * 365);
  assert.equal(profile.hourly[8].revenueByRoute.A, 1 * 3 * 365);
  assert.equal(profile.hourly[8].revenueByRoute.B, 1 * 3 * 365);
  assert.deepEqual(profile.hourly.map((hour, index) => hour.revenue > 0 ? index : null).filter((hour) => hour != null), [8, 18]);
  assert.equal(profile.dailyRevenue, 2 * 2 * 3 * 365);
});

test('native revenue profile uses the bundled all-day commute distribution when departure times are absent', () => {
  const profile = calculateNativeRevenueProfile([{
    lastCommute: {
      modeChoice: { transit: 2 },
      transitPaths: [{ fareCost: 3, segments: [{ routeId: 'A', stationIds: ['a', 'b'] }] }],
    },
  }]);
  const total = profile.hourly.reduce((sum, hour) => sum + hour.revenue, 0);

  assert.equal(profile.hourly.filter(({ revenue }) => revenue > 0).length, 24);
  assert.ok(Math.abs(total - profile.dailyRevenue) < 1e-6);
  assert.ok(profile.hourly[8].revenue > profile.hourly[6].revenue);
  assert.ok(profile.hourly[17].revenue > profile.hourly[19].revenue);
  assert.ok(profile.hourly[8].revenue < profile.dailyRevenue / 2);
  assert.ok(Math.abs(profile.hourly[8].revenueByRoute.A - profile.hourly[8].revenue) < 1e-6);
  const riders = profile.hourly.flatMap((hour) => hour.completedCommutes ?? []).map((commute) => commute.size);
  assert.ok(riders.every(Number.isSafeInteger));
  assert.equal(riders.reduce((sum, count) => sum + count, 0), 4);
});

test('cached two-spike revenue profiles migrate without loading remote native demand', () => {
  const oldHourly = Array.from({ length: 24 }, () => ({ revenue: 0, revenueByRoute: {} }));
  oldHourly[7] = {
    revenue: 100,
    revenueByRoute: { A: 100 },
    financeOwnedRevenue: 40,
    financeOwnedRevenueByRoute: { A: 40 },
  };
  oldHourly[17] = structuredClone(oldHourly[7]);

  const migrated = migrateCachedNativeRevenueProfile({
    schemaVersion: 2,
    tileId: 'T0',
    dailyRevenue: 200,
    hourly: oldHourly,
  });

  assert.equal(migrated.schemaVersion, 5);
  assert.equal(migrated.hourly.filter(({ revenue }) => revenue > 0).length, 24);
  assert.ok(Math.abs(migrated.hourly.reduce((sum, hour) => sum + hour.revenue, 0) - 200) < 1e-9);
  assert.ok(Math.abs(migrated.hourly.reduce((sum, hour) => sum + (hour.financeOwnedRevenue ?? 0), 0) - 80) < 1e-9);
  assert.ok(migrated.hourly[8].revenue > migrated.hourly[6].revenue);
  assert.ok(migrated.hourly[17].revenue > migrated.hourly[19].revenue);
});

test('native revenue profile isolates the owned share of mixed local/global journeys', () => {
  const profile = calculateNativeRevenueProfile([{
    homeDepartureTime: 7 * 3_600,
    workDepartureTime: 17 * 3_600,
    lastCommute: {
      modeChoice: { transit: 2 },
      transitPaths: [{ fareCost: 4, segments: [{ routeId: 'local' }, { routeId: 'global' }] }],
    },
  }], { financeOwnedRouteIds: ['global'] });

  assert.equal(profile.hourly[7].revenue, 2 * 4 * 365);
  assert.equal(profile.hourly[7].financeOwnedRevenue, 1 * 4 * 365);
  assert.deepEqual(profile.hourly[7].financeOwnedRevenueByRoute, { global: 1 * 4 * 365 });
});

test('native revenue profile prices 1.7 commute directions independently', () => {
  const profile = calculateNativeRevenueProfile([{
    homeDepartureTime: 8 * 3_600,
    workDepartureTime: 17 * 3_600,
    commutes: {
      homeToWork: {
        modeChoice: { transit: 3 },
        transitCost: 2,
        transitPaths: [{ fareCost: 2, segments: [{ routeId: 'outbound' }] }],
      },
      workToHome: {
        modeChoice: { transit: 1 },
        transitCost: 5,
        transitPaths: [{ fareCost: 5, segments: [{ routeId: 'return' }] }],
      },
    },
    lastCommute: {
      direction: 'workToHome',
      transitPaths: [{ fareCost: 5, segments: [{ routeId: 'return' }] }],
    },
  }]);

  assert.equal(profile.schemaVersion, 5);
  assert.equal(profile.commuteModel, 'directional-v1');
  assert.equal(profile.hourly[8].revenue, 3 * 2 * 365);
  assert.deepEqual(profile.hourly[8].revenueByRoute, { outbound: 3 * 2 * 365 });
  assert.equal(profile.hourly[17].revenue, 1 * 5 * 365);
  assert.deepEqual(profile.hourly[17].revenueByRoute, { return: 1 * 5 * 365 });
  assert.equal(profile.dailyRevenue, (3 * 2 + 1 * 5) * 365);
  assert.equal(profile.transitPopulation, 3);
});

test('global expense profile compiles route schedules and constructed infrastructure', () => {
  const profile = calculateGlobalExpenseProfile({
    routes: [{ id: 'R', trainType: 'commuter-rail', trainSchedule: { veryLowDemand: 1, highDemand: 3 } }],
    trains: [{ id: 'T', routeId: 'R', trainType: 'commuter-rail', cars: 6 }],
    tracks: [
      { id: 'station-track', buildType: 'constructed', trackType: 'commuter-rail' },
      { id: 'line-track', buildType: 'constructed', trackType: 'commuter-rail', length: 100 },
    ],
    trackGroups: [
      { id: 'S', type: 'station', trackType: 'commuter-rail', trackIds: ['station-track'] },
      { id: 'L', type: 'track', trackType: 'commuter-rail', trackIds: ['line-track'] },
    ],
  });

  assert.equal(profile.routeHourly.R[1], (500 + 6 * 35) * 365);
  assert.equal(profile.routeHourly.R[7], 3 * (500 + 6 * 35) * 365);
  assert.equal(profile.infrastructureItems.find(({ id }) => id === 'station:S').hourlyCost, 320_000 / 24);
  assert.equal(profile.infrastructureItems.find(({ id }) => id === 'track:line-track').hourlyCost, 100 * 300 / 24);
});

test('global expense profile prefers live public train-type prices', () => {
  const profile = calculateGlobalExpenseProfile({
    routes: [{ id: 'R', trainType: 'custom', trainSchedule: { highDemand: 2 } }],
    trains: [{ id: 'T', routeId: 'R', trainType: 'custom', cars: 3 }],
    tracks: [], trackGroups: [],
  }, [{
    id: 'custom', trainOperationalCostPerHour: 10, carOperationalCostPerHour: 2,
    carsPerCarSet: 4, trackMaintenanceCostPerMeter: 5, stationMaintenanceCostPerYear: 6,
  }]);

  assert.equal(profile.routeHourly.R[7], 2 * (10 + 3 * 2) * 365);
});

test('global expense profile accepts explicit owned tracks without removing their groups', () => {
  const profile = calculateGlobalExpenseProfile({
    routes: [],
    trains: [],
    tracks: [{
      id: 'shared-platform', buildType: 'constructed', trackType: 'commuter-rail',
    }],
    trackGroups: [{
      id: 'shared-station', type: 'station', trackType: 'commuter-rail', trackIds: ['shared-platform'],
    }],
  }, [], { financeOwnedTrackIds: ['shared-platform'] });

  assert.equal(profile.infrastructureItems[0].financeOwned, true);
});

test('hourly background finance excludes active native work and includes clipped routes', () => {
  const posting = backgroundFinanceForHour({
    activeTileId: 'T0',
    hour: 7,
    activeProjection: {
      baselineState: { routes: [{ id: 'local' }, { id: 'clipped' }], tracks: [{ id: 'visible-track' }] },
      partialRouteIds: ['clipped'],
    },
    finance: {
      tileRevenueProfiles: {
        T0: { hourly: Array.from({ length: 24 }, () => ({ revenue: 10 })) },
        T1: { hourly: Array.from({ length: 24 }, () => ({ revenue: 20, revenueByRoute: { remote: 20 } })) },
      },
      expenseProfile: {
        routeHourly: {
          local: Array(24).fill(30),
          remote: Array(24).fill(40),
          clipped: Array(24).fill(50),
        },
        infrastructureItems: [
          { id: 'visible', category: 'trackMaintenance', hourlyCost: 60, trackIds: ['visible-track'] },
          { id: 'remote', category: 'trackMaintenance', hourlyCost: 70, trackIds: ['remote-track'] },
        ],
      },
    },
  });

  assert.equal(posting.revenue, 20);
  assert.deepEqual(posting.revenueByRoute, { remote: 20 });
  assert.equal(posting.expenseCategories.trainOperational, 90);
  assert.equal(posting.expenseCategories.trackMaintenance, 70);
  assert.deepEqual(posting.expensesByRoute, { remote: 40, clipped: 50 });
  assert.equal(posting.expenses, 160);
});

test('hourly background finance excludes all active native revenue and cost', () => {
  const hourly = Array.from({ length: 24 }, () => ({
    revenue: 100,
    revenueByRoute: { local: 60, global: 40 },
    financeOwnedRevenue: 40,
    financeOwnedRevenueByRoute: { global: 40 },
  }));
  const posting = backgroundFinanceForHour({
    activeTileId: 'T0', hour: 7,
    activeProjection: { baselineState: { routes: [{ id: 'local' }, { id: 'global' }], tracks: [] }, partialRouteIds: [] },
    finance: {
      tileRevenueProfiles: { T0: { hourly } },
      expenseProfile: {
        financeOwnedRouteIds: ['global'],
        routeHourly: { local: Array(24).fill(30), global: Array(24).fill(50) },
        infrastructureItems: [],
      },
    },
  });

  assert.equal(posting.revenue, 0);
  assert.deepEqual(posting.revenueByRoute, {});
  assert.equal(posting.expenses, 50);
  assert.deepEqual(posting.expensesByRoute, { global: 50 });
});

test('native finance audit prediction includes only visible non-clipped owned routes', () => {
  const hourly = Array.from({ length: 24 }, () => ({
    financeOwnedRevenueByRoute: { visible: 40, clipped: 20, remote: 10 },
  }));
  const comparable = nativeComparableFinanceForHour({
    activeTileId: 'T0',
    hour: 7,
    activeProjection: {
      baselineState: { routes: [{ id: 'visible' }, { id: 'clipped' }, { id: 'local' }] },
      partialRouteIds: ['clipped'],
    },
    finance: {
      tileRevenueProfiles: { T0: { hourly } },
      expenseProfile: {
        financeOwnedRouteIds: ['visible', 'clipped', 'remote'],
        routeHourly: {
          visible: Array(24).fill(50),
          clipped: Array(24).fill(60),
          remote: Array(24).fill(70),
        },
      },
    },
  });

  assert.deepEqual(comparable.routeIds, ['visible']);
  assert.deepEqual(comparable.revenueByRoute, { visible: 40 });
  assert.deepEqual(comparable.expensesByRoute, { visible: 50 });
  assert.equal(comparable.revenue, 40);
  assert.equal(comparable.expenses, 50);
});

test('native finance audit waits for 24 consecutive stable hours on one tile', () => {
  const sample = (hour, auditSignature = 'stable', projectionHash = 'stable', networkRevision = 1) => ({
    tileId: 'T0', hour, auditSignature, networkRevision, projectionHash, complete: true,
    revenue: { native: 35, projected: hour % 24 === 7 || hour % 24 === 17 ? 480 : 0 },
    expenses: { native: 55, projected: 50 },
  });
  const partial = summarizeNativeFinanceAudit(Array.from({ length: 23 }, (_, hour) => sample(hour)));

  assert.equal(partial.ready, false);
  assert.equal(partial.status, 'collecting');
  assert.equal(partial.sampleCount, 23);
  assert.equal(partial.revenue.native, null);
  assert.equal(partial.partial.revenue.native, 23 * 35);

  const complete = summarizeNativeFinanceAudit(Array.from({ length: 24 }, (_, hour) => sample(hour)));
  assert.equal(complete.ready, true);
  assert.equal(complete.sampleCount, 24);
  assert.equal(complete.revenue.native, 24 * 35);
  assert.equal(complete.revenue.projected, 2 * 480);

  const changed = summarizeNativeFinanceAudit([
    ...Array.from({ length: 23 }, (_, hour) => sample(hour)),
    sample(23, 'new-network', 'new-projection', 2),
  ]);
  assert.equal(changed.ready, false);
  assert.equal(changed.sampleCount, 1);
});

test('native finance audit ignores checkpoint projection and revision churn when the finance model is stable', () => {
  const samples = Array.from({ length: 24 }, (_, hour) => ({
    tileId: 'T0',
    hour,
    auditSignature: 'same-finance-model',
    networkRevision: 7 + Math.floor(hour / 3),
    projectionHash: `checkpoint-${Math.floor(hour / 3)}`,
    complete: true,
    networkStable: true,
    revenue: { native: 10, projected: 12 },
    expenses: { native: 5, projected: 6 },
  }));

  const audit = summarizeNativeFinanceAudit(samples);

  assert.equal(audit.ready, true);
  assert.equal(audit.sampleCount, 24);
  assert.equal(audit.firstHour, 0);
  assert.equal(audit.lastHour, 23);
});

test('native topology ownership makes background settlement revenue-only', () => {
  const policy = createNativeTopologyFinancePolicy();
  const posting = backgroundFinanceForHour({
    activeTileId: 'T0', hour: 7, ownershipPolicy: policy,
    activeProjection: { baselineState: { routes: [{ id: 'R' }], tracks: [] }, partialRouteIds: [] },
    finance: {
      accountingOwnership: policy,
      tileRevenueProfiles: { T1: { hourly: Array.from({ length: 24 }, () => ({ revenue: 12, revenueByRoute: { R: 12 } })) } },
      expenseProfile: { routeHourly: { R: Array(24).fill(100) }, infrastructureItems: [{ hourlyCost: 50, trackIds: [] }] },
    },
  });
  assert.equal(posting.revenue, 12);
  assert.equal(posting.expenses, 0);
  assert.deepEqual(posting.expensesByRoute, {});
  assert.equal(posting.nativeExpensesOmitted, true);
});

test('background projection is conserved and idempotent across reload, tile switch, and rollback', () => {
  const finance = {
    lastSettledHour: 0,
    tileRevenueProfiles: {
      T0: { hourly: Array.from({ length: 24 }, () => ({ revenue: 2 })) },
      T1: { hourly: Array.from({ length: 24 }, () => ({ revenue: 3 })) },
    },
  };
  const args = {
    finance, activeTileId: 'T0',
    activeProjection: { baselineState: { routes: [], tracks: [] }, partialRouteIds: [] },
    ownershipPolicy: createNativeTopologyFinancePolicy(),
  };
  const first = projectNativeBackgroundFinance({ ...args, targetHour: 2 });
  assert.equal(first.hours, 2);
  assert.equal(first.revenue, 3 * 2);
  const repeat = projectNativeBackgroundFinance({ ...args, targetHour: 2, lastSettledHour: first.lastSettledHour });
  assert.equal(repeat.status, 'already-settled');
  assert.equal(repeat.revenue, 0);
  const switched = projectNativeBackgroundFinance({ ...args, activeTileId: 'T1', targetHour: 1, lastSettledHour: 2 });
  assert.equal(switched.status, 'clock-rollback');
  assert.equal(switched.revenue, 0);
});

test('revenue cache invalidation is tile/route scoped and migration preserves topology fields', () => {
  const sidecar = {
    ownershipProjection: { routeIds: ['legacy-route'], trackIds: ['legacy-track'] },
    tileRevenueProfiles: {
      T0: { ridershipByRoute: { local: 10 }, hourly: [] },
      T1: { ridershipByRoute: { remote: 10 }, hourly: [] },
    },
    expenseProfile: { routeHourly: {}, infrastructureItems: [] },
  };
  const migrated = migrateNativeFinanceSidecar(sidecar);
  assert.deepEqual(migrated.ownershipProjection, sidecar.ownershipProjection);
  assert.equal(migrated.accountingOwnership.topologyAuthority, 'native-save');
  const invalidated = invalidateAffectedRevenueProfiles(migrated, { affectedRouteIds: ['remote'] });
  assert.deepEqual(invalidated.invalidatedTileIds, ['T1']);
  assert.ok(invalidated.finance.tileRevenueProfiles.T0);
  assert.equal(invalidated.finance.tileRevenueProfiles.T1, undefined);
});

test('inactive native journeys retain counts, direction, transfers and absolute day', () => {
  const profile = calculateNativeRevenueProfile([{id:'p',homeDepartureTime:25200,workDepartureTime:61200,commutes:{
    homeToWork:{modeChoice:{transit:2.5},transitCost:0,transitPaths:[{fareCost:0,segments:[{routeId:'a',stationIds:['a1','a2']},{routeId:'b',stationIds:['b1','b2']}]}]},
    workToHome:{modeChoice:{transit:1},transitCost:0,transitPaths:[{fareCost:0,segments:[{routeId:'c',stationIds:['c2','c1']}]}]},
  }}]);
  const finance = {tileRevenueProfiles:{A:profile,B:profile}};
  const outward = backgroundFinanceForHour({finance,activeTileId:'A',hour:31,nativeTopologyComplete:true});
  assert.equal(outward.revenue,0);
  assert.equal(outward.completedCommutes.length,1);
  assert.equal(outward.completedCommutes[0].size,3);
  assert.ok(Number.isSafeInteger(outward.completedCommutes[0].size));
  assert.equal(outward.completedCommutes[0].origin,'home');
  assert.equal(outward.completedCommutes[0].journeyStart,111600);
  assert.equal(outward.completedCommutes[0].stationRoutes.length,2);
  const homeward = backgroundFinanceForHour({finance,activeTileId:'A',hour:41,nativeTopologyComplete:true});
  assert.equal(homeward.completedCommutes[0].size,1);
  assert.equal(homeward.completedCommutes[0].origin,'work');
  assert.notEqual(outward.completedCommutes[0].popId,homeward.completedCommutes[0].popId);
});

test('cached fractional ridership migrates to conserved whole-person records', () => {
  const hourly = Array.from({ length: 24 }, () => ({ revenue: 0, revenueByRoute: {} }));
  const commute = { popId: 'p', origin: 'home', stationRoutes: [{ routeId: 'r', stationIds: ['a','b'] }] };
  hourly[7].completedCommutes = [{ ...commute, size: 2.4 }];
  hourly[8].completedCommutes = [{ ...commute, size: 1.4 }];

  const migrated = migrateCachedNativeRevenueProfile({ schemaVersion: 4, hourly, ridershipByRoute: { r: 3.8 } });
  const riders = migrated.hourly.flatMap((hour) => hour.completedCommutes ?? []).map((record) => record.size);

  assert.equal(migrated.schemaVersion, 5);
  assert.equal(migrated.ridershipRecording, 'whole-person-ridership-v1');
  assert.ok(riders.every(Number.isSafeInteger));
  assert.equal(riders.reduce((sum, count) => sum + count, 0), 4);
  assert.equal(migrated.ridershipByRoute.r, 4);
});

test('native stop-based paths produce route stats without walking legs', () => {
  const profile=calculateNativeRevenueProfile([{id:'p',homeDepartureTime:0,commutes:{homeToWork:{modeChoice:{transit:4},transitCost:0,transitPaths:[{fareCost:0,totalTime:600,segments:[{routeId:'walking',isWalking:true,fromStopId:'origin',toStopId:'s'},{routeId:'r',fromStopId:'s',toStopId:'t'}]}]}}}]);
  assert.deepEqual(profile.hourly[0].completedCommutes[0].stationRoutes,[{routeId:'r',stationIds:['s','t']}]);
  assert.equal(profile.hourly[0].completedCommutes[0].journeyEnd,600);
});
