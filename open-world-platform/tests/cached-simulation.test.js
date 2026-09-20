import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrototypeSaveController } from '../src/runtime/prototype-save-controller.js';
import { prototypeSaveBusyReason } from '../src/runtime/prototype-save-readiness.js';
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

function fixture(evaluate = async () => calculated(), isReady = () => true, options = {}) {
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
    ...options.nativeActions,
  };
  const game = { captureCrossTileNetworkProfile: network, calculateNativeFinanceProfile: () => ({ expenseProfile: {} }),
    postBackgroundNativeFinanceNow: posting => { postings.push(posting); return { applied: true }; } };
  const controller = createCachedSimulation({ game, getState: () => state, api: { utils: {} }, evaluate, isReady,
    onHour: async hour => hours.push(hour), onDay: async day => { days.push(day); await controller.refreshAtMidnight(day); }, ...options });
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

test('tile handoff holds the clock across readiness changes and allows native routing when not requested', async () => {
  let ready = false;
  const f = fixture(undefined, () => ready);
  f.state.setTimeConfig({ paused: false });
  f.controller.setSuspended(true);
  assert.equal(f.controller.snapshot().suspended, true);
  assert.equal(f.controller.isTickSuppressionActive(), true);
  await f.state.handleIncrementGameState();
  await f.state.simulateCommutes();
  await f.state.calculatePaths({ query: {} });
  assert.deepEqual(f.native(), { nativeTicks: 0, nativeCommutes: 1, nativePaths: 1 });
  ready = true;
  await f.state.handleIncrementGameState();
  assert.equal(f.state.timeConfig.elapsedSeconds, 25000);
  assert.equal(f.state.timeConfig.paused, false, 'a hold must preserve user pause intent');
  f.controller.setSuspended(false);
  await f.state.handleIncrementGameState();
  assert.equal(f.native().nativeTicks, 1);
  await f.controller.dispose();
});

test('cached tile handoff suppresses native routing, prepares once under the hold, and resumes at the same clock', async () => {
  let calls = 0, ready = true;
  const f = fixture(async () => { calls++; return calculated(); }, () => ready);
  await f.controller.setEnabled(true);
  f.controller.setSuspended(true, { suppressCommutes: true });
  await f.controller.setEnabled(false);
  ready = false;
  f.state.cityCode = 'B';
  f.state.demandData = { points: new Map(demand.points.map(p => [p.id, p])), popsMap: new Map(demand.pops.map(p => [p.id, p])) };
  f.state.setTimeConfig({ paused: false });
  await f.state.handleIncrementGameState();
  await f.state.simulateCommutes();
  const result = await f.state.calculatePaths({ query: { origin: { coords: [0, 0] } } });
  assert.deepEqual(result.paths, []);
  assert.deepEqual(f.native(), { nativeTicks: 0, nativeCommutes: 0, nativePaths: 0 });
  ready = true;
  await f.controller.setEnabled(true);
  await f.controller.setEnabled(true);
  assert.equal(calls, 2, 'one preparation per tile, with no repeated enable calculation');
  await f.state.handleIncrementGameState();
  assert.equal(f.state.timeConfig.elapsedSeconds, 25000, 'finance is still preparing');
  f.controller.setSuspended(false);
  await f.state.handleIncrementGameState();
  assert.equal(f.state.timeConfig.elapsedSeconds, 25240);
  assert.equal(f.controller.snapshot().assignedPops, 1);
  await f.controller.dispose();
});

test('tile handoff drains observed native work and an expired hold cannot intercept another session', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let current = true;
  const f = fixture(undefined, undefined, { nativeActions: { simulateCommutes: () => pending } });
  const nativeJob = f.state.simulateCommutes();
  f.controller.setSuspended(true, { suppressCommutes: true, isCurrent: () => current });
  let drained = false;
  const drain = f.controller.drainNativeWork().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  finish(); await nativeJob; await drain;
  assert.equal(drained, true);
  current = false;
  f.state.gameSessionId = 'unrelated-save';
  assert.equal(f.controller.snapshot().suspended, false);
  assert.equal(f.controller.isTickSuppressionActive(), false);
  await f.state.handleIncrementGameState();
  assert.equal(f.native().nativeTicks, 1);
  await f.controller.dispose();
});

test('failed destination preparation can retry while the handoff clock remains held', async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1) throw new Error('memory admission deferred');
    return calculated();
  });
  f.state.setTimeConfig({ paused: false });
  f.controller.setSuspended(true, { suppressCommutes: true });
  const failed = await f.controller.setEnabled(true);
  assert.equal(failed.status, 'error');
  assert.equal(failed.suspended, true);
  assert.equal(f.state.timeConfig.paused, false, 'the hold already stops time without changing pause intent');
  const recovered = await f.controller.setEnabled(true);
  assert.equal(recovered.status, 'ready');
  assert.equal(calls, 2);
  assert.equal(f.state.timeConfig.elapsedSeconds, 25000);
  f.controller.setSuspended(false);
  await f.state.handleIncrementGameState();
  assert.equal(f.state.timeConfig.elapsedSeconds, 25240, 'the previously running session resumes after retry');
  await f.controller.dispose();
});

test('failed work from a cancelled handoff cannot pause an unrelated save', async () => {
  let reject;
  const f = fixture(() => new Promise((_resolve, fail) => { reject = fail; }));
  let current = true;
  f.controller.setSuspended(true, { suppressCommutes: true, isCurrent: () => current });
  const pending = f.controller.setEnabled(true);
  while (!reject) await Promise.resolve();
  current = false;
  f.state.gameSessionId = 'another-save';
  f.state.setTimeConfig({ paused: false });
  reject(new Error('old worker failed'));
  await pending;
  assert.equal(f.state.timeConfig.paused, false);
  await f.controller.dispose();
});

test('destination enabling awaits replacement work when a service edit invalidates its first calculation', async () => {
  const pending = [];
  const f = fixture(() => new Promise(resolve => { pending.push(resolve); }));
  f.controller.setSuspended(true, { suppressCommutes: true });
  let finished = false;
  const enabling = f.controller.setEnabled(true).then(result => { finished = true; return result; });
  while (pending.length < 1) await Promise.resolve();
  f.controller.invalidate();
  pending[0](calculated());
  while (pending.length < 2) await Promise.resolve();
  assert.equal(finished, false, 'enabling waits for the coalesced replacement calculation');
  pending[1](calculated());
  assert.equal((await enabling).status, 'ready');
  assert.equal(pending.length, 2, 'one stale calculation and one replacement, without another job');
  f.controller.setSuspended(false);
  await f.controller.dispose();
});

test('prepared finance profile can be reused only for the unchanged active destination', async () => {
  const f = fixture();
  assert.equal(f.controller.preparedNativeProfile('A'), null);
  await f.controller.setEnabled(true);
  const profile = f.controller.preparedNativeProfile('A');
  assert.ok(profile?.hourly?.length);
  assert.equal(profile.assignments, undefined);
  assert.equal(f.controller.preparedNativeProfile('B'), null);
  f.controller.invalidate();
  assert.equal(f.controller.preparedNativeProfile('A'), null, 'queued service edits cannot expose an old profile as current');
  await f.controller.refreshAtMidnight(1);
  assert.ok(f.controller.preparedNativeProfile('A'));
  f.state.gameSessionId = 'new-save';
  assert.equal(f.controller.preparedNativeProfile('A'), null);
  await f.controller.dispose();
});

test('a ready cached session can save before any native commute worker was created', async () => {
  const f = fixture();
  await f.controller.setEnabled(true);
  const generate = f.state.generateSave;
  f.state.generateSave = function (...args) { return { ...generate.apply(this, args), version: 4 }; };
  let writes = 0, nativeSaves = 0;
  const writer = createPrototypeSaveController({ getState: () => f.state,
    isBusy: () => prototypeSaveBusyReason({ nativeWorkers: { logicalWorkers: 0, busy: 0, queued: 0 }, simulation: f.controller.snapshot() }),
    settleMs: 0, yieldTask: async () => {}, freezeUi: () => ({ progress() {}, dispose() {} }),
    fetchFn: async () => Response.json({ version: 'tile-save-prototype-v1' }),
    writeSave: async (_save, options) => { options.beforeCommit(); writes++; return { bytes: 100, path: 'fixture.metro' }; },
  });
  try {
    await writer.configure({ origin: 'http://127.0.0.1:8800', token: 'fixture-control-token' });
    writer.setEnabled(true);
    const result = await writer.invoke(() => { nativeSaves++; });
    assert.equal(result.path, 'fixture.metro', writer.snapshot().error);
    assert.equal(writes, 1);
    assert.equal(nativeSaves, 0);
  } finally { writer.dispose(); await f.controller.dispose(); }
});

test('save readiness follows native async actions even when their worker pool predates the mod', async () => {
  for (const action of ['handleIncrementGameState', 'simulateCommutes', 'calculatePaths']) {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = fixture(undefined, undefined, { nativeActions: { [action]: () => pending } });
    const reason = () => prototypeSaveBusyReason({ simulation: f.controller.snapshot() });
    const result = f.state[action]();
    assert.equal(result, pending, 'tracking must preserve the native promise identity');
    assert.match(reason(), /native simulation/);
    finish(); await result;
    assert.equal(reason(), false);
    await f.controller.dispose();
  }
});

test('save readiness waits for a cached tick after routing has finished', async () => {
  let finish, entered;
  const arrived = new Promise(resolve => { entered = resolve; });
  const f = fixture(undefined, undefined, { onHour: () => new Promise(resolve => { finish = resolve; entered(); }) });
  await f.controller.setEnabled(true);
  f.state.setTimeConfig({ paused: false, elapsedSeconds: 28790 });
  const tick = f.state.handleIncrementGameState();
  await arrived;
  f.state.setTimeConfig({ paused: true });
  const reason = () => prototypeSaveBusyReason({ nativeWorkers: { logicalWorkers: 24, busy: 0, queued: 0 }, simulation: f.controller.snapshot() });
  assert.equal(f.controller.snapshot().status, 'ready');
  assert.match(reason(), /cached simulation/);
  finish(); await tick;
  assert.equal(reason(), false);
  await f.controller.dispose();
});

test('failed native actions release save readiness and replaced actions cannot masquerade as observed', async () => {
  const f = fixture(undefined, undefined, { nativeActions: { simulateCommutes: async () => { throw new Error('Native routing failed'); } } });
  await assert.rejects(f.state.simulateCommutes(), /Native routing failed/);
  assert.equal(prototypeSaveBusyReason({ simulation: f.controller.snapshot() }), false);
  f.state.calculatePaths = () => {};
  assert.match(prototypeSaveBusyReason({ simulation: f.controller.snapshot() }), /Cannot observe simulation work/);
  f.controller.attach();
  assert.equal(prototypeSaveBusyReason({ simulation: f.controller.snapshot() }), false);
  await f.controller.dispose();
});

test('replacing the cached wrapper retains pending native work until its original promise settles', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture(undefined, undefined, { nativeActions: { simulateCommutes: () => pending } });
  const originalWrapper = f.state.simulateCommutes;
  const action = f.state.simulateCommutes();
  const current = createCachedSimulation({ game: f.game, api: { utils: {} }, getState: () => f.state });
  assert.notEqual(f.state.simulateCommutes, originalWrapper);
  assert.equal(current.snapshot().saveWork.native, 1);
  finish(); await action;
  assert.equal(current.snapshot().saveWork.native, 0);
  await f.controller.dispose(); await current.dispose();
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

test('rail and fare edits retain assignments through daytime and coalesce at midnight', async () => {
  const f = fixture();
  await f.controller.setEnabled(true);
  const assignments = f.state.demandData;
  f.state.routes = [{ id: 'new' }];
  f.controller.invalidate(); // Shared committed-service notification.
  f.state.setTimeConfig({ paused: false });
  await f.state.handleIncrementGameState();
  assert.equal(f.controller.snapshot().calculations, 1);
  f.state.transitCost = 7;
  f.controller.invalidate(); // Shared fare notification.
  await f.state.handleIncrementGameState();
  f.controller.invalidate();
  await f.state.handleIncrementGameState();
  assert.equal(f.controller.snapshot().calculations, 1);
  assert.equal(f.state.demandData, assignments);
  assert.equal(f.controller.snapshot().pendingMidnightRefresh, true);
  f.state.setTimeConfig({ elapsedSeconds: 86390 });
  await f.state.handleIncrementGameState();
  assert.equal(f.state.timeConfig.elapsedSeconds, 86400, 'stop exactly at midnight before publishing new rates');
  assert.equal(f.controller.snapshot().calculations, 2);
  assert.equal(f.controller.snapshot().pendingMidnightRefresh, false);
  await f.state.handleIncrementGameState();
  assert.equal(f.state.timeConfig.elapsedSeconds, 86640);
  assert.equal(f.controller.snapshot().calculations, 2);
  await f.controller.dispose();
});

test('raw route, track, fleet and inventory replacements do not queue a commute refresh', async () => {
  const f = fixture();
  await f.controller.setEnabled(true);
  f.state.setTimeConfig({ paused: false });
  f.state.routes = [{ id: 'blank', stNodes: [] }];
  f.state.tracks = [{ id: 'blueprint', buildType: 'blueprint' }];
  f.state.trains = f.state.trains.map(train => ({ ...train }));
  f.state.ownedTrainCount = 20;
  await f.state.handleIncrementGameState();
  assert.equal(f.controller.snapshot().pendingMidnightRefresh, false);
  assert.equal(f.controller.snapshot().calculations, 1);
  f.state.routes = [{ ...f.state.routes[0], color: 'blue' }];
  assert.equal((await f.controller.refreshAtMidnight(1)).status, 'not-dirty');
  await f.controller.dispose();
});

test('reference and fleet changes during refresh retain assignments and account for new trains', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const enabling = f.controller.setEnabled(true);
  await new Promise(resolve => setImmediate(resolve));
  f.state.routes = [...f.state.routes];
  f.state.trains = [...f.state.trains, { id: 'new', operationalTime: { lastChargedAt: 25000 } }];
  finish(calculated()); await enabling;
  assert.equal(f.controller.snapshot().status, 'ready');
  assert.equal(f.controller.snapshot().calculations, 1);
  assert.equal(f.controller.snapshot().pendingMidnightRefresh, false);
  f.state.setTimeConfig({ paused: false }); await f.state.handleIncrementGameState();
  assert.equal(f.state.generateSave().data.trains.find(train => train.id === 'new').operationalTime.lastChargedAt,
    f.state.timeConfig.elapsedSeconds, 'a train created while routing was pending must not replay cached time');
  await f.controller.dispose();
});

test('paused rail edits do no routing and enabling remains an immediate calculation', async () => {
  const f = fixture();
  await f.controller.setEnabled(true);
  f.state.routes = [{ id: 'edited' }];
  f.controller.invalidate(); f.controller.invalidate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.snapshot().calculations, 1);
  assert.equal(f.controller.snapshot().status, 'ready');
  await f.controller.setEnabled(false);
  await f.controller.setEnabled(true);
  assert.equal(f.controller.snapshot().calculations, 2);
  assert.equal(f.controller.snapshot().pendingMidnightRefresh, false);
  await f.controller.dispose();
});

test('a replaced demand set cannot use the previous tile assignments until midnight', async () => {
  const f = fixture();
  await f.controller.setEnabled(true);
  f.state.demandData = structuredClone(f.state.demandData);
  f.state.setTimeConfig({ paused: false });
  await f.state.handleIncrementGameState();
  assert.equal(f.controller.snapshot().calculations, 2);
  await f.controller.dispose();
});

test('deferred commute updates still settle expense changes at the edit time', async () => {
  const f = fixture();
  let hourlyCost = 3600;
  f.game.calculateNativeFinanceProfile = () => ({ expenseProfile: { routeHourly: { r: Array(24).fill(hourlyCost) } } });
  await f.controller.setEnabled(true);
  f.state.setTimeConfig({ elapsedSeconds: 25010 });
  hourlyCost = 7200; f.controller.invalidate();
  assert.equal(f.postings.at(-1).expensesByRoute.r, 10);
  f.state.setTimeConfig({ elapsedSeconds: 25020 }); f.state.generateSave();
  assert.equal(f.postings.at(-1).expensesByRoute.r, 20);
  assert.equal(f.controller.snapshot().calculations, 1);
  await f.controller.dispose();
});

test('an edit during midnight work discards its result and stays queued for the next batch', async () => {
  let finish;
  const f = fixture(async () => finish ? await new Promise(resolve => { finish = resolve; }) : calculated());
  await f.controller.setEnabled(true);
  f.controller.invalidate();
  finish = true;
  const running = f.controller.refreshAtMidnight(1);
  await new Promise(resolve => setImmediate(resolve));
  const previous = f.state.demandData;
  f.state.routes = [{ id: 'late-edit' }]; f.controller.invalidate();
  finish(calculated());
  assert.equal((await running).status, 'stale');
  assert.equal(f.state.demandData, previous);
  assert.equal(f.controller.snapshot().pendingMidnightRefresh, true);
  finish = null;
  await f.controller.refreshAtMidnight(2);
  assert.equal(f.controller.snapshot().calculations, 2);
  assert.equal(f.controller.snapshot().pendingMidnightRefresh, false);
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

test('normal native saves share route references without changing data or settling cached time', async () => {
  for (const ready of [true, false]) {
    const f = fixture(undefined, () => ready);
    const path = [{ routeId: 'r', stationIds: ['a', 'b'] }];
    const nativeSave = { name: 'manual', data: { elapsedSeconds: 25000,
      lastInfrastructureChargeTime: 24900, trains: structuredClone(f.state.trains),
      compressedDemandData: { c: [{ sr: structuredClone(path) }, { sr: structuredClone(path) }] },
      completedCommutes: [{ stationRoutes: structuredClone(path) }] } };
    const before = structuredClone(nativeSave);
    f.state.generateSave = function (options) {
      assert.equal(this, f.state);
      assert.equal(options.name, 'manual');
      return nativeSave;
    };
    f.controller.attach();
    const save = f.state.generateSave({ name: 'manual' });
    assert.equal(save.then, undefined, 'the native synchronous contract is preserved');
    assert.deepEqual(save, before);
    assert.equal(JSON.stringify(save), JSON.stringify(before));
    assert.deepEqual(nativeSave, before);
    assert.notEqual(nativeSave.data.compressedDemandData.c[0].sr, nativeSave.data.compressedDemandData.c[1].sr);
    assert.equal(save.data.compressedDemandData.c[0].sr, save.data.compressedDemandData.c[1].sr);
    assert.equal(save.data.completedCommutes[0].stationRoutes, save.data.compressedDemandData.c[0].sr);
    assert.equal(f.postings.length, 0);
    await f.controller.dispose();
  }
});

test('normal promise-returning saves retain their values and share repeated paths', async () => {
  const f = fixture();
  const path = [{ routeId: 'r', stationIds: ['a', 'b'] }];
  const nativeSave = { data: { completedCommutes: [
    { stationRoutes: structuredClone(path) }, { stationRoutes: structuredClone(path) },
  ] } };
  f.state.generateSave = async () => nativeSave;
  f.controller.attach();
  const save = await f.state.generateSave();
  assert.deepEqual(save, nativeSave);
  assert.equal(save.data.completedCommutes[0].stationRoutes, save.data.completedCommutes[1].stationRoutes);
  await f.controller.dispose();
});

test('hot reload unwraps a previous generation and disposal restores the native action', async () => {
  const f = fixture();
  const previous = f.state.handleIncrementGameState;
  const owner = Symbol.for('open-world.cached-simulation');
  const original = previous[owner].original;
  await f.controller.dispose();
  const obsolete = () => { throw new Error('obsolete wrapper executed'); };
  const oldPatch = { version: 'open-world-cached-simulation-v16', original };
  Object.defineProperty(obsolete, owner, { value: oldPatch });
  f.state.handleIncrementGameState = obsolete;
  const current = createCachedSimulation({ game: f.game, api: { utils: {} }, getState: () => f.state });
  assert.notEqual(f.state.handleIncrementGameState, obsolete);
  assert.notEqual(f.state.handleIncrementGameState[owner], oldPatch);
  assert.equal(f.state.handleIncrementGameState[owner].version, 'open-world-cached-simulation-v17');
  await f.state.handleIncrementGameState();
  assert.equal(f.native().nativeTicks, 1);
  await current.dispose();
  assert.equal(f.state.handleIncrementGameState, original);
});

test('hot reload replaces the old save wrapper and restores the native generator on disposal', async () => {
  const f = fixture();
  const owner = Symbol.for('open-world.cached-simulation');
  const original = f.state.generateSave[owner].original;
  await f.controller.dispose();
  const obsolete = () => { throw new Error('obsolete save wrapper executed'); };
  const oldPatch = { version: 'open-world-cached-simulation-v16', original };
  Object.defineProperty(obsolete, owner, { value: oldPatch });
  f.state.generateSave = obsolete;
  const current = createCachedSimulation({ game: f.game, api: { utils: {} }, getState: () => f.state });
  assert.notEqual(f.state.generateSave, obsolete);
  assert.notEqual(f.state.generateSave[owner], oldPatch);
  assert.equal(f.state.generateSave[owner].version, 'open-world-cached-simulation-v17');
  assert.deepEqual(f.state.generateSave(), original.call(f.state));
  await current.dispose();
  assert.equal(f.state.generateSave, original);
});

test('streaming saves skip bridge reference sharing while preserving cached clock rebasing', async () => {
  const f = fixture(); await f.controller.setEnabled(true);
  await f.state.handleIncrementGameState();
  const native = f.state.generateSave();
  const streamed = f.state.generateSave({ [Symbol.for('open-world.stream-native-save')]: true });
  assert.deepEqual(streamed, native);
  assert.equal(streamed.data.elapsedSeconds, f.state.timeConfig.elapsedSeconds);
  await f.controller.dispose();
});

test('save stage diagnostics contain timings without retaining payloads and cannot interrupt saving', async () => {
  const phases = [];
  const f = fixture(undefined, undefined, { onSavePhase(stage, details) {
    phases.push({ stage, details });
    throw new Error('Diagnostic observer failed');
  } });
  const save = f.state.generateSave();
  assert.ok(save.data.trains.length);
  assert.deepEqual(phases.map(value => value.stage), ['generate.start', 'generate.end', 'sharing.end']);
  assert.ok(phases.every(value => Object.keys(value.details).join(',') === 'durationMs'
    && value.details.durationMs >= 0));
  phases.length = 0;
  const failure = new Error('Native save failed');
  f.state.generateSave = async () => { throw failure; };
  f.controller.attach();
  await assert.rejects(f.state.generateSave(), error => error === failure);
  assert.deepEqual(phases.map(value => value.stage), ['generate.start', 'generate.error']);
  await f.controller.dispose();
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

test('paused saves return identical train objects so the sharing pass can hit', () => {
  const train = { timings: [{ arrivalTime: 1, futureCycleArrivalTimes: [2] }],
    operationalTime: { totalSeconds: 8, lastChargedAt: 5 } };
  assert.equal(rebaseCachedTrain(train, 0, 100), train);
  const moved = rebaseCachedTrain(train, 100, 200);
  assert.notEqual(moved, train);
  assert.equal(moved.timings[0].arrivalTime, 101);
  assert.equal(train.timings[0].arrivalTime, 1);
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
