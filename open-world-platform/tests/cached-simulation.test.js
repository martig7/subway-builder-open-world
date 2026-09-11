import test from 'node:test';
import assert from 'node:assert/strict';
import { createCachedSimulation, cachedSimulationPosting, publishCachedDemand, rebaseCachedTrain } from '../src/runtime/cached-simulation.js';
import { evaluateOffTileNativeDemand } from '../src/runtime/off-tile-native-demand.js';
import { createNetworkProfile } from '../src/runtime/cross-tile-mode-choice.js';
import { calculateGlobalExpenseProfile } from '../src/runtime/native-finance-model.js';

const demand = {
  points: [{ id: 'home', location: [0, 0] }, { id: 'work', location: [0.1, 0] }],
  pops: [{ id: 'p', size: 100, residenceId: 'home', jobId: 'work', drivingSeconds: 3600,
    drivingDistance: 25000, homeDepartureTime: 25000, workDepartureTime: 64000 }],
};
const network = () => createNetworkProfile({ tileId: 'A',
  stations: [0, 1].map(i => ({ id: `s${i}`, coords: [i * 0.1, 0], stNodeIds: [`n${i}`], buildType: 'constructed' })),
  routes: [{ id: 'r', idealTrainCount: 2, stNodes: [{ id: 'n0' }, { id: 'n1' }],
    stComboTimings: [{ stNodeIndex: 0, arrivalTime: 0, departureTime: 20 }, { stNodeIndex: 1, arrivalTime: 600, departureTime: 620 }] }],
});
const calculated = () => evaluateOffTileNativeDemand({ tileId: 'A', demand, networkProfile: network(),
  farePolicy: { fare: 2.5 }, includeAssignments: true });

test('assignments conserve every pop in both directions and carry native route geometry and timing', () => {
  const result = calculated();
  assert.equal(result.assignments.length, demand.pops.length);
  const pop = result.assignments[0];
  assert.equal(pop.homeDepartureTime, 25000);
  assert.equal(pop.workDepartureTime, 64000);
  for (const [direction, commute] of Object.entries(pop.commutes)) {
    assert.equal(Object.values(commute.modeChoice).reduce((a, b) => a + b), 100);
    if (!commute.modeChoice.transit) continue;
    const path = commute.transitPaths[0];
    assert.ok(path.segments.some(segment => segment.routeId === 'r'));
    assert.deepEqual(path.segments[0].fromStopCoords, direction === 'homeToWork' ? [0, 0] : [0.1, 0]);
    for (const segment of path.segments) {
      assert.equal(segment.fromStopCoords.length, 2);
      assert.equal(segment.toStopCoords.length, 2);
      assert.ok(segment.arrivalTime >= segment.departureTime);
    }
    assert.equal(path.segments.at(-1).arrivalTime - path.segments[0].departureTime, path.totalTime);
  }
  assert.ok(pop.commutes.homeToWork.modeChoice.transit > 0);
});

test('walking/driving-only populations replace stale transit and update native demand point shares', () => {
  const result = evaluateOffTileNativeDemand({ tileId: 'A', demand,
    networkProfile: createNetworkProfile({ tileId: 'A', stations: [], routes: [] }), includeAssignments: true });
  const state = { demandData: { points: new Map(demand.points.map(p => [p.id, p])),
    popsMap: new Map(demand.pops.map(p => [p.id, { ...p, lastCommute: { transitPaths: ['stale'] } }])) },
    setDemandData(value) { this.demandData = value; } };
  publishCachedDemand(state, result.assignments);
  assert.deepEqual(state.demandData.popsMap.get('p').lastCommute.transitPaths, []);
  assert.deepEqual(state.demandData.points.get('home').residentModeShare, result.assignments[0].commutes.homeToWork.modeChoice);
  assert.deepEqual(state.demandData.points.get('work').workerModeShare, result.assignments[0].commutes.workToHome.modeChoice);
});

test('partial-hour and midnight postings conserve fares, rides and full-network costs', () => {
  const profile = { hourly: Array.from({ length: 24 }, () => ({ revenue: 3600, revenueByRoute: { r: 3600 },
    completedCommutes: [{ popId: 'p', origin: 'home', size: 60, stationRoutes: [{ routeId: 'r', stationIds: ['a', 'b'] }] }] })) };
  const expenses = { routeHourly: { r: Array(24).fill(1800) }, infrastructureItems: [{ category: 'trackMaintenance', hourlyCost: 600 }] };
  const input = { profile, expenses, from: 86300, to: 86500, sessionId: 'one' };
  const whole = cachedSimulationPosting(input);
  const a = cachedSimulationPosting({ ...input, to: 86400 }), b = cachedSimulationPosting({ ...input, from: 86400 });
  assert.equal(whole.revenue, 200);
  assert.equal(whole.revenue, a.revenue + b.revenue);
  assert.equal(whole.expensesByRoute.r, 100);
  assert.equal(whole.completedCommutes.reduce((n, c) => n + c.size, 0), 3);
  assert.equal(whole.completedCommutes.reduce((n, c) => n + c.size, 0),
    a.completedCommutes.reduce((n, c) => n + c.size, 0)
      + b.completedCommutes.reduce((n, c) => n + c.size, 0));
  assert.ok(whole.completedCommutes.every((commute) => Number.isSafeInteger(commute.size)));
  assert.deepEqual(whole.hourlyPostings.map(row => row.hour), [23, 24]);
  assert.notEqual(a.postingId, b.postingId);
});

function fixture(evaluate = async () => calculated(), isReady = () => true) {
  let nativeTicks = 0, nativeCommutes = 0, nativePaths = 0;
  const postings = [], hours = [], days = [];
  const state = { gameSessionId: 'one', cityCode: 'A', timeConfig: { paused: true, timeSpeed: 'ultrafast', elapsedSeconds: 25000 },
    routes: [], tracks: [], stations: [], trains: [{ id: 'train', timings: [{ arrivalTime: 25000 }] }], fareGroups: [],
    demandData: { points: new Map(demand.points.map(p => [p.id, p])), popsMap: new Map(demand.pops.map(p => [p.id, p])) },
    handleIncrementGameState() { nativeTicks++; }, simulateCommutes() { nativeCommutes++; }, calculatePaths() { nativePaths++; },
    generateSave() { return { data: { elapsedSeconds: this.timeConfig.elapsedSeconds, trains: structuredClone(this.trains) } }; },
    setTimeConfig(update) { this.timeConfig = { ...this.timeConfig, ...update }; },
    setTrains(trains) { this.trains = trains; }, setDemandData(value) { this.demandData = value; },
    setCompletedCommutes(value) { this.completedCommutes = value; },
  };
  const game = { captureCrossTileNetworkProfile: network, calculateNativeFinanceProfile: () => ({ expenseProfile: {} }),
    postBackgroundNativeFinanceNow: posting => { postings.push(posting); return { applied: true }; } };
  const controller = createCachedSimulation({ game, getState: () => state, api: { utils: {} }, evaluate, isReady,
    onHour: async hour => hours.push(hour), onDay: async day => days.push(day) });
  return { state, game, controller, postings, hours, days, native: () => ({ nativeTicks, nativeCommutes, nativePaths }) };
}

test('tick-suppression status follows the wrapper readiness dispatch condition', async () => {
  let ready = true;
  const f = fixture(undefined, () => ready);
  await f.controller.setEnabled(true);
  assert.equal(f.controller.isTickSuppressionActive(), true);
  ready = false;
  assert.equal(f.controller.isTickSuppressionActive(), false);
  await f.state.handleIncrementGameState();
  assert.equal(f.native().nativeTicks, 1, 'an unready cache delegates to native simulation');
  await f.controller.dispose();
});

test('cached ticks bypass all native simulation, reuse assignments, honor pause and restore physical fleet', async () => {
  const f = fixture();
  assert.equal(f.controller.isTickSuppressionActive(), false);
  await f.state.handleIncrementGameState();
  assert.equal(f.native().nativeTicks, 1);
  await f.controller.setEnabled(true);
  assert.equal(f.controller.isTickSuppressionActive(), true);
  const trains = f.state.trains;
  await f.state.handleIncrementGameState();
  assert.equal(f.state.timeConfig.elapsedSeconds, 25000);
  f.state.setTimeConfig({ paused: false });
  for (let i = 0; i < 20; i++) await f.state.handleIncrementGameState();
  await f.state.simulateCommutes({});
  const path = f.state.demandData.popsMap.get('p').lastCommute.transitPaths[0];
  const query = { origin: { type: 'coords', coords: path.segments[0].fromStopCoords },
    destination: { type: 'coords', coords: path.segments.at(-1).toStopCoords } };
  const paths = await f.state.calculatePaths({ query });
  assert.equal(paths.paths.length, 1);
  assert.deepEqual(f.native(), { nativeTicks: 1, nativeCommutes: 0, nativePaths: 0 });
  assert.equal(f.controller.snapshot().calculations, 1);
  assert.equal(f.state.trains, trains);
  assert.equal(f.state.timeConfig.elapsedSeconds, 29800);
  assert.ok(f.postings.length > 0);
  assert.deepEqual(f.hours, [7, 8]);
  await f.controller.setEnabled(false);
  assert.equal(f.controller.isTickSuppressionActive(), false);
  assert.equal(f.state.trains[0].id, trains[0].id);
  assert.equal(f.state.trains[0].timings[0].arrivalTime, 29800);
  await f.state.handleIncrementGameState();
  assert.equal(f.native().nativeTicks, 2);
  await f.controller.dispose();
});

test('network/fare edits invalidate the cache before another tick advances time', async () => {
  const f = fixture();
  await f.controller.setEnabled(true);
  f.state.routes = [{ id: 'new' }];
  f.state.setTimeConfig({ paused: false });
  await f.state.handleIncrementGameState();
  assert.equal(f.controller.snapshot().calculations, 2);
  f.state.transitCost = 7;
  await f.state.handleIncrementGameState();
  assert.equal(f.controller.snapshot().calculations, 3);
  f.controller.invalidate();
  await f.state.handleIncrementGameState();
  assert.equal(f.controller.snapshot().calculations, 4);
  await f.controller.dispose();
});

test('look-ahead follows speed changes and synchronous saves settle only the elapsed interval', async () => {
  const f = fixture(), prepared = [];
  f.game.prepareBackgroundNativeFinance = async posting => { prepared.push(posting); };
  await f.controller.setEnabled(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(prepared.at(-1).targetElapsedSeconds, 25240, 'Ultra includes its exact boundary overshoot');
  f.state.setTimeConfig({ paused: false, timeSpeed: 'fast' });
  await f.state.handleIncrementGameState();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(prepared.at(-1).targetElapsedSeconds, 25200);
  const save = f.state.generateSave();
  assert.equal(save.then, undefined);
  assert.equal(f.postings.at(-1).targetElapsedSeconds, 25008);
  assert.equal(f.postings.at(-1).postingId, 'cached-simulation:one:25000:25008');
  await f.controller.dispose();
});

test('late worker results cannot mutate another save or a disabled mode', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const enabling = f.controller.setEnabled(true);
  await new Promise(resolve => setImmediate(resolve));
  const oldDemand = f.state.demandData;
  f.state.gameSessionId = 'two';
  const disabling = f.controller.setEnabled(false);
  finish(calculated());
  await enabling; await disabling;
  assert.equal(f.state.demandData, oldDemand);
  assert.equal(f.controller.snapshot().enabled, false);
  assert.equal(f.postings.length, 0);
  await f.controller.dispose();
});

test('hot reload unwraps a previous generation and disposal restores the native action', async () => {
  const f = fixture();
  const previous = f.state.handleIncrementGameState;
  const owner = Symbol.for('open-world.cached-simulation');
  const original = previous[owner].original;
  await f.controller.dispose();
  const obsolete = () => { throw new Error('obsolete wrapper executed'); };
  const oldPatch = { version: 'open-world-cached-simulation-v5', original };
  Object.defineProperty(obsolete, owner, { value: oldPatch });
  f.state.handleIncrementGameState = obsolete;
  const current = createCachedSimulation({ game: f.game, api: { utils: {} }, getState: () => f.state });
  assert.notEqual(f.state.handleIncrementGameState, obsolete);
  assert.notEqual(f.state.handleIncrementGameState[owner], oldPatch);
  assert.equal(f.state.handleIncrementGameState[owner].version, 'open-world-cached-simulation-v6');
  await f.state.handleIncrementGameState();
  assert.equal(f.native().nativeTicks, 1);
  await current.dispose();
  assert.equal(f.state.handleIncrementGameState, original);
});

test('network edits preserving a train billing cursor cannot replay already estimated operating time', async () => {
  const f = fixture();
  f.state.trains[0].operationalTime = { totalSeconds: 10, lastChargedAt: 24990 };
  await f.controller.setEnabled(true);
  f.state.setTimeConfig({ paused: false });
  for (let i = 0; i < 20; i++) await f.state.handleIncrementGameState();
  // Native route regeneration replaces train objects but keeps operationalTime.
  f.state.setTrains(f.state.trains.map(train => ({ ...train,
    operationalTime: { ...train.operationalTime } })));
  await f.state.handleIncrementGameState();
  const save = f.state.generateSave();
  assert.equal(save.data.elapsedSeconds - save.data.trains[0].operationalTime.lastChargedAt, 10,
    'saving after an edit must exclude the entire cached interval');
  await f.controller.setEnabled(false);
  assert.equal(f.state.timeConfig.elapsedSeconds - f.state.trains[0].operationalTime.lastChargedAt, 10,
    'tile navigation must retain only pre-cache unpaid native time');
  await f.controller.dispose();
});

test('new trains and explicitly reset billing cursors exclude only time since their creation or reset', async () => {
  const f = fixture();
  f.state.trains[0].operationalTime = { totalSeconds: 10, lastChargedAt: 24990 };
  await f.controller.setEnabled(true);
  f.state.setTimeConfig({ paused: false });
  await f.state.handleIncrementGameState();
  const editedAt = f.state.timeConfig.elapsedSeconds;
  f.state.setTrains([
    { ...f.state.trains[0], operationalTime: { totalSeconds: 0, lastChargedAt: editedAt } },
    { id: 'new', operationalTime: { totalSeconds: 0, lastChargedAt: editedAt } },
  ]);
  await f.state.handleIncrementGameState();
  await f.controller.setEnabled(false);
  for (const train of f.state.trains) assert.equal(train.operationalTime.lastChargedAt, f.state.timeConfig.elapsedSeconds);
  await f.controller.dispose();
});

test('saving cached time rebases fleet timing without moving the live fleet or charging twice', async () => {
  const f = fixture();
  await f.controller.setEnabled(true);
  f.state.setTimeConfig({ paused: false });
  await f.state.handleIncrementGameState();
  const save = f.state.generateSave();
  assert.equal(save?.then, undefined, 'preserve the synchronous native save contract');
  assert.equal(save.data.trains[0].timings[0].arrivalTime, 25240);
  assert.equal(f.state.trains[0].timings[0].arrivalTime, 25000);
  const posts = f.postings.length;
  await f.state.generateSave();
  assert.equal(f.postings.length, posts);
  await f.controller.dispose();
});

test('return to native mode rebases all observed absolute train anchors and preserves unpaid native time', () => {
  const train = { timings: [{ arrivalTime: null, departureTime: 12, adjustedExpectedArrivalTime: 14,
    futureCycleArrivalTimes: [16, 20] }], currentStComboInfo: { timeAtStop: 12, timeAtStopEnd: null },
    stuckDetection: { lastMovementTime: 10 }, operationalTime: { totalSeconds: 8, lastChargedAt: 5 } };
  const next = rebaseCachedTrain(train, 100, 120);
  assert.equal(next.timings[0].arrivalTime, null);
  assert.equal(next.timings[0].adjustedExpectedArrivalTime, 114);
  assert.deepEqual(next.timings[0].futureCycleArrivalTimes, [116, 120]);
  assert.equal(next.currentStComboInfo.timeAtStop, 112);
  assert.equal(next.stuckDetection.lastMovementTime, 110);
  assert.deepEqual(next.operationalTime, { totalSeconds: 8, lastChargedAt: 105 });
  assert.equal(train.operationalTime.lastChargedAt, 5);
});

test('failed calculation pauses the clock and never falls through to native simulation', async () => {
  const f = fixture(async () => { throw new Error('worker failed'); });
  f.state.setTimeConfig({ paused: false });
  await f.controller.setEnabled(true);
  await f.state.handleIncrementGameState();
  assert.equal(f.state.timeConfig.paused, true);
  assert.equal(f.controller.snapshot().status, 'error');
  assert.equal(f.state.timeConfig.elapsedSeconds, 25000);
  assert.equal(f.native().nativeTicks, 0);
  await f.controller.dispose();
});

test('cached expenses use native nested train stats and charge constructed grade crossings', () => {
  const profile = calculateGlobalExpenseProfile({
    tracks: [{ id: 'built', trackType: 'custom', buildType: 'constructed' },
      { id: 'blueprint', trackType: 'custom', buildType: 'blueprint' }],
    routes: [{ id: 'r', trainType: 'custom', idealTrainCount: 1 }],
    trains: [{ id: 't', routeId: 'r', cars: 2 }],
    gradeCrossings: [{ id: 'one', trackId: 'built' }, { id: 'two', trackId: 'blueprint' }],
  }, { custom: { stats: { trainOperationalCostPerHour: 10, carOperationalCostPerHour: 2 }, gradeCrossingMaintenancePerDay: 240 } });
  assert.equal(profile.routeHourly.r[0], 14 * 365);
  assert.deepEqual(profile.infrastructureItems.map(item => [item.category, item.hourlyCost]), [['gradeCrossingMaintenance', 10]]);
});

test('cached accounting batches within an hour and flushes every remaining second on save', async () => {
  const f = fixture();
  f.state.setTimeConfig({ elapsedSeconds: 25200 });
  await f.controller.setEnabled(true);
  f.state.setTimeConfig({ paused: false });
  for (let i = 0; i < 14; i++) await f.state.handleIncrementGameState();
  assert.equal(f.postings.length, 0, 'no repeated intra-hour ledger cloning');
  await f.state.handleIncrementGameState();
  assert.equal(f.postings.length, 1);
  assert.equal(f.postings[0].targetElapsedSeconds, 28800);
  await f.state.handleIncrementGameState();
  f.state.generateSave();
  assert.equal(f.postings.length, 2);
  assert.equal(f.postings[1].targetElapsedSeconds, 29040);
  await f.controller.dispose();
  assert.equal(f.postings.length, 2);
});
