import { runNativeDemandWorkerJob } from '../src/runtime/native-demand-worker-job.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitCapacityLedger, beginCapacityEvaluation } from '../src/runtime/transit-capacity.js';
import { serviceHeadway } from '../src/runtime/scheduled-transit-service.js';
import { calculateCrossTileModeShares, prepareCrossTileModeShares, finishCrossTileModeShares, createNetworkProfile } from '../src/runtime/cross-tile-mode-choice.js';
import { evaluateOffTileNativeDemand } from '../src/runtime/off-tile-native-demand.js';

export function fixture({ cars = 1, departure = 28800, schedule = null, count = 160, batchSize = 128,
  trainTypes = [{ id: 'fixture', stats: { capacityPerCar: 50, carsPerCarSet: 1 } }] } = {}) {
  const networkProfile = createNetworkProfile({ tileId: 'T',
    stations: [{ id: 'A', coords: [0, 0], buildType: 'constructed', stNodeIds: ['a'] },
      { id: 'B', coords: [0.1, 0], buildType: 'constructed', stNodeIds: ['b'] }],
    routes: [{ id: 'R', idealTrainCount: 1, trainType: 'fixture', carsPerTrain: cars,
      ...(schedule ? { trainSchedule: schedule } : {}),
      stNodes: [{ id: 'a' }, { id: 'b' }, { id: 'a' }],
      stComboTimings: [{ stNodeIndex: 0, arrivalTime: 0, departureTime: 20 },
        { stNodeIndex: 1, arrivalTime: 580, departureTime: 600 },
        { stNodeIndex: 2, arrivalTime: 1180, departureTime: 1200 }] }],
    trainTypes, trains: [] });
  const demand = { points: [{ id: 'home', location: [0, 0] }, { id: 'work', location: [0.1, 0] }],
    pops: Array.from({ length: count }, (_, i) => ({ id: `P${String(i).padStart(4, '0')}`, size: 25,
      residenceId: 'home', jobId: 'work', drivingSeconds: 2400, drivingDistance: 15000,
      homeDepartureTime: departure, workDepartureTime: 61200 })) };
  return { tileId: 'T', worldId: 'capacity-test', includeAssignments: true, networkProfile,
    farePolicy: { fare: 2 }, demand, batchSize };
}
const outward = r => r.assignments.reduce((n, p) => n + p.commutes.homeToWork.modeChoice.transit, 0);
for (const [shape, trainTypes] of [
  ['native dictionary', { fixture: { stats: { capacityPerCar: 50, carsPerCarSet: 1 } } }],
  ['Map', new Map([['fixture', { stats: { capacityPerCar: 50, carsPerCarSet: 1 } }]])],
]) test(`${shape} train catalogs preserve capacity and carried journeys without live trains`, () => {
  const expected = evaluateOffTileNativeDemand(fixture({ cars: 3, count: 12 }));
  const input = fixture({ cars: 3, count: 12, trainTypes });
  assert.equal(input.networkProfile.routes[0].capacityPerTrain, 150);
  const actual = evaluateOffTileNativeDemand(input);
  assert.deepEqual(actual.profile.capacityReservations, expected.profile.capacityReservations);
  assert.deepEqual(actual.assignments, expected.assignments);
});

test('capacity constrains carried riders and larger consists carry more', () => {
  const small = evaluateOffTileNativeDemand(fixture());
  const large = evaluateOffTileNativeDemand(fixture({ cars: 10 }));
  assert.ok(outward(small) < 1000, `small train carried ${outward(small)}`);
  assert.ok(outward(large) > outward(small));
  for (const p of small.assignments) for (const c of Object.values(p.commutes)) {
    assert.equal(Object.values(c.modeChoice).reduce((a,b) => a+b,0), 25);
  }
});
test('zero overnight service is not replaced by the peak train count', () => {
  const r = evaluateOffTileNativeDemand(fixture({ departure: 7200,
    schedule: { highDemand: 1, mediumDemand: 0, lowDemand: 0, veryLowDemand: 0 } }));
  assert.equal(outward(r), 0);
});
test('seats are shared across native demand batches', () => {
  const a = evaluateOffTileNativeDemand(fixture({ batchSize: 1 }));
  const b = evaluateOffTileNativeDemand(fixture({ batchSize: 128 }));
  assert.equal(outward(a), outward(b));
  assert.deepEqual(a.profile.modeChoicePopulation, b.profile.modeChoicePopulation);
});

const segment = (routeId, index, offset, departure, duration = 100) => ({ routeId,
  capacitySegmentIndex: index, serviceOffsetSeconds: offset, departureTime: departure,
  arrivalTime: departure + duration, isWalking: false, isDriving: false });
const ledgerProfile = { routes: [{ id: 'L', stNodeIds: ['a','b','c'], capacityPerTrain: 10,
  configuredServiceCount: 1, serviceCount: 1, stComboTimings: [{ departureTime: 600 }] },
  { id: 'X', stNodeIds: ['c','d'], capacityPerTrain: 5,
    configuredServiceCount: 1, serviceCount: 1, stComboTimings: [{ departureTime: 900 }] }] };

test('upstream riders occupy downstream segments; seats are reused after alighting', () => {
  const ledger = createTransitCapacityLedger({ networkProfiles: { T: ledgerProfile } });
  const ab = segment('L',0,0,0), bc = segment('L',1,120,120);
  ledger.commit(ledger.nextOffer([ab,bc]), 7);
  assert.equal(ledger.nextOffer([bc]).seats, 3);
  ledger.commit(ledger.nextOffer([ab]), 3);
  assert.equal(ledger.nextOffer([bc]).seats, 3, 'three riders alight at B');
  ledger.commit(ledger.nextOffer([bc]), 3);
  const queued = ledger.nextOffer([bc]);
  assert.equal(queued.queueSeconds, 600);
  assert.equal(queued.seats, 10);
  for (const [id,,,people] of ledger.reservations()) assert.ok(people <= ledgerProfile.routes.find(r=>r.id===id).capacityPerTrain);
});

test('denied boarding propagates missed transfers and offers are atomic', () => {
  const ledger = createTransitCapacityLedger({ networkProfiles: { T: ledgerProfile } });
  const first = segment('L',0,0,0), second = segment('X',0,150,150);
  ledger.commit(ledger.nextOffer([first]), 10);
  const before = ledger.reservations();
  const offer = ledger.nextOffer([first,second]);
  assert.deepEqual(ledger.reservations(), before, 'checking a transfer must not reserve it');
  assert.deepEqual(offer.departureTimes, [600,1050]);
  assert.equal(offer.queueSeconds, 900);
  assert.equal(offer.seats, 5);
  ledger.commit(offer, 5);
  assert.equal(ledger.nextOffer([second]).seats, 5, 'missed original connection stays free');
});

test('native, cross, and cached profiles share one budget without double reservation', () => {
  const input = { worldId: 'shared-capacity-budget', tileId: 'T', networkProfile: ledgerProfile };
  const native = beginCapacityEvaluation(input);
  const ledger = createTransitCapacityLedger({ networkProfiles: { T: ledgerProfile }, reservations: native.input.capacityBudget.reservations });
  const ride = segment('L',0,0,0);
  ledger.commit(ledger.nextOffer([ride]), 10);
  const cachedProfile = { capacityReservations: ledger.reservations() };
  native.commit({ profile: cachedProfile });
  beginCapacityEvaluation(input).commit({ profile: cachedProfile });
  const cross = beginCapacityEvaluation({ ...input, networkProfiles: { T: ledgerProfile } }, 'cross');
  assert.equal(cross.input.capacityBudget.reservations.length, 1);
  const shared = createTransitCapacityLedger({ networkProfiles: { T: ledgerProfile }, reservations: cross.input.capacityBudget.reservations });
  assert.equal(shared.nextOffer([ride]).queueSeconds, 600);
  assert.equal(shared.nextOffer([segment('L',0,0,86400)]).queueSeconds, 600, 'recurring daily forecasts share capacity');
  assert.equal(beginCapacityEvaluation(input).input.capacityBudget.reservations.length, 0, 'recalculation replaces its own allocation');
  const changed = structuredClone(ledgerProfile); changed.routes[0].capacityPerTrain = 20;
  assert.equal(beginCapacityEvaluation({ ...input, networkProfile: changed }, 'cross').input.capacityBudget.reservations.length, 0);
});

test('all native service periods and capacity changes participate in routing signatures', () => {
  const p = fixture({ schedule: { highDemand: 4, mediumDemand: 2, lowDemand: 1, veryLowDemand: 0 } }).networkProfile;
  const r = p.routes[0];
  assert.deepEqual([2,4,6,8,12,17,19,21,23].map(h=>serviceHeadway(r,h*3600)), [0,1200,600,300,600,300,600,1200,0]);
  assert.equal(r.capacityPerTrain, 50);
  assert.notEqual(p.structuralSignature, fixture({ cars: 2, schedule: { highDemand: 4, mediumDemand: 2, lowDemand: 1, veryLowDemand: 0 } }).networkProfile.structuralSignature);
});

function crossFixture(input) {
  return { networkProfiles: { T: input.networkProfile }, fare: 2, gatewayCatalog: {},
    crossDemand: { schemaVersion: 1, gateways: ['local'],
      points: [['h',0,0,'T'],['w',0.1,0,'T']],
      popFields: ['id','mass','homeIndex','workIndex','gatewayIndex','drivingSeconds','drivingDistance','homeDepartureTime'],
      pops: input.demand.pops.map(p => [p.id,p.size,0,1,0,p.drivingSeconds,p.drivingDistance,p.homeDepartureTime]) } };
}

test('queued trips and fare records conserve the carried population', () => {
  const result = evaluateOffTileNativeDemand(fixture());
  const assigned = result.assignments.reduce((n,p) => n + Object.values(p.commutes).reduce((a,c)=>a+c.modeChoice.transit,0),0);
  const completed = result.profile.hourly.flatMap(h=>h.completedCommutes ?? []).reduce((n,c)=>n+c.size,0);
  assert.equal(completed, assigned);
  assert.equal(result.profile.capacityStats.carriedPeople, assigned);
  assert.ok(result.profile.capacityStats.unservedPeople > 0);
  assert.ok(result.profile.capacityStats.queuedPeople > 0);
  for (const row of result.profile.capacityReservations) assert.ok(row[3] <= 50);
  const paths = result.assignments.flatMap(p => Object.values(p.commutes).flatMap(c=>c.transitPaths));
  assert.ok(paths.some(p=>p.timeBreakdown.wait > 50));
  assert.equal(paths.reduce((n,p)=>n+p.population,0), assigned);
  const unconstrained = fixture(); unconstrained.networkProfile.routes[0].capacityPerTrain = 100000;
  assert.ok(result.profile.dailyRevenue < evaluateOffTileNativeDemand(unconstrained).profile.dailyRevenue);
});

test('congested passengers can use an alternative route; quoted worker path matches direct', () => {
  const input = crossFixture(fixture({ count: 12 }));
  const r = structuredClone(input.networkProfiles.T.routes[0]);
  r.id = 'alternate'; r.capacityPerTrain = 100; r.stComboTimings[1].arrivalTime += 120;
  input.networkProfiles.T.routes.push(r); input.networkProfiles.T.activeRouteIds.push(r.id);
  input.journeyFare = stationRoutes => ({ total: 2, revenueByRoute: { [stationRoutes[0].routeId]: 2 } });
  const direct = calculateCrossTileModeShares(input);
  assert.ok([...direct.transitJourneys.values()].flat().some(j=>j.stationRoutes.some(r=>r.routeId==='alternate')));
  const prepared = prepareCrossTileModeShares(input);
  const quotes = new Map(prepared.fareRequests.map(r=>[r.key,input.journeyFare(r.stationRoutes)]));
  const staged = finishCrossTileModeShares(prepared,quotes);
  assert.deepEqual(staged.popModeChoices,direct.popModeChoices);
  assert.deepEqual(staged.transitJourneys,direct.transitJourneys);
  assert.deepEqual(staged.capacityReservations,direct.capacityReservations);
});

test('capacity allocation is invariant to pop input order and batch size', () => {
  const a = fixture({ count: 30, batchSize: 7 });
  for (const [i,p] of a.demand.pops.entries()) {
    p.homeDepartureTime += (i % 3)*180;
    p.workDepartureTime = p.homeDepartureTime + 200;
  }
  const b = structuredClone(a); b.demand.pops.reverse(); b.batchSize = 1;
  const x = evaluateOffTileNativeDemand(a), y = evaluateOffTileNativeDemand(b);
  const choices = r => Object.fromEntries(r.assignments.map(p=>[p.id,Object.values(p.commutes).map(c=>c.modeChoice)]));
  assert.deepEqual(choices(x),choices(y));
  assert.deepEqual(x.profile.capacityReservations,y.profile.capacityReservations);
});


test('worker disk hits preserve reservations and carried assignments', async () => {
  const input = fixture({ count: 40, batchSize: 7 });
  const demand = input.demand; delete input.demand;
  const bytes = new TextEncoder().encode(JSON.stringify(demand));
  const records = new Map(), assignments = [];
  const store = { read: async k=>records.get(k), write: async (k,v)=>records.set(k,v), clear: async()=>records.clear() };
  const run = () => runNativeDemandWorkerJob({bytes,input,cacheMode:'assignments'}, {store,emitAssignments: rows=>assignments.push(...rows)});
  const first = await run();
  assert.equal(first.diskCache,'written');
  const carried = assignments.reduce((n,p)=>n+Object.values(p.commutes).reduce((a,c)=>a+c.modeChoice.transit,0),0);
  assignments.length = 0;
  const second = await run();
  assert.equal(second.diskCache,'hit');
  assert.deepEqual(second.profile.capacityReservations,first.profile.capacityReservations);
  assert.equal(second.profile.capacityStats.carriedPeople,carried);
  assert.equal(assignments.reduce((n,p)=>n+Object.values(p.commutes).reduce((a,c)=>a+c.modeChoice.transit,0),0),carried);
});


test('fractional headways share native and cross seats on later service days', () => {
  const input = fixture({ count: 12 });
  input.networkProfile.routes[0].stComboTimings[2].departureTime = 1201;
  const native = evaluateOffTileNativeDemand(input);
  const crossInput = crossFixture(input);
  crossInput.worldId = input.worldId;
  crossInput.requestedDepartureSeconds = 99 * 86400 + 28800;
  const transaction = beginCapacityEvaluation(crossInput,'cross');
  const cross = calculateCrossTileModeShares(transaction.input);
  const loads = new Map();
  for (const [id,origin,index,people] of [...native.profile.capacityReservations,...cross.capacityReservations]) {
    const key = JSON.stringify([id,origin,index]); loads.set(key,(loads.get(key) ?? 0)+people);
  }
  for (const people of loads.values()) assert.ok(people <= 50);
  assert.ok(cross.capacityStats.carriedPeople < 300);
});
