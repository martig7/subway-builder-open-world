import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_HANDOFF_VERIFICATION_VERSION,
  nativeHandoffEvidence,
  observeNativeTileHandoff,
  stripVerifiedNativeHandoffNetwork,
} from '../src/runtime/native-handoff-verification.js';
import { stageNativeRecovery } from '../src/runtime/native-reload-recovery.js';
import { SubwayBuilderGameAdapter } from '../src/runtime/adapters/subway-builder-game-adapter.js';
import { stripNetworkFromSnapshot } from '../src/runtime/network-projection.js';

function snapshotFixture() {
  return {
    id: 'native-save', gameSessionId: 'native-session', cityCode: 'A', cityUid: 'A',
    data: {
      tracks: [{ id: 't', coords: [[0, 0], [1, 1]], length: 100, buildType: 'constructed' }],
      trackGroups: [{ id: 'tg', trackIds: ['t'] }],
      trains: [{ id: 'train', routeId: 'r', windows: { forward: { signalIds: ['s'], tracks: [] } } }],
      routes: [{ id: 'r', trainSchedule: { lowDemand: 2, veryLowDemand: 2 },
        stCombos: [{ path: [{ trackId: 't', signals: [{ signalId: 's', time: 5 }] }] }] }],
      signals: [{ id: 's', type: 'standard', coords: [0, 0], status: { occupations: [], reservedBy: null } },
        { id: '1,1-v-merge-signal', type: 'v-merge', coords: [1, 1], buildType: 'constructed',
          signalTracks: [{ trackId: 't', areaCovered: 'all' }],
          status: { occupations: ['train'], reservedBy: 'train' } }],
      stNodes: [{ id: 'n', stationId: 'station', trackIds: ['t'] }],
      stations: [{ id: 'station', name: 'Station', stNodeIds: ['n'] }], stationGroups: [],
      fareGroups: [{ id: 'fare', routeIds: ['r'], fare: 2.5 }],
      ownedTrainCount: 1, ownedCarsByType: { metro: 4 },
      gameMode: 'easy', money: 4567.8, transitCost: 2.5,
      financialHistory: { entries: [{ timestamp: 0, revenue: 2, expenses: 1 }], currentHourRevenue: 3 },
      routeFinancials: { byRoute: { r: { revenue: 5 } }, currentHour: {}, lastHourTimestamp: 0 },
      completedCommutes: [{ popId: 'p', fareRevenue: 2.5, revenueByRoute: { r: 2.5 } }],
      bonds: [{ id: 'bond', remainingBalance: 12 }], lastInfrastructureChargeTime: 120,
      timeConfig: { paused: false, timeSpeed: 'normal', elapsedSeconds: 321 },
      playTimeSeconds: 42, dailyStats: { ridership: 10, serviceSampleCount: 1 },
      yardsEnabled: false, yards: [], trackEditSession: null,
    },
  };
}

const marker = {
  schemaVersion: 1, reason: 'tile-navigation', recoveryId: 'handoff', transitionId: 'world:1:A->B',
  sourceCityCode: 'A', destinationCityCode: 'B',
};

// Behavioral fixture from the inspected Subway Builder 1.7.0 loadSave seam:
// it reconstructs route paths, regenerates v-merge occupancy, pauses the clock,
// preserves modern schedules/ledger, and omits the infrastructure charge cursor.
// Unknown topology changes are deliberately not normalized by the verifier.
function loadNative170(state, save) {
  const next = { ...state, ...structuredClone(save.data), gameSessionId: save.gameSessionId, cityCode: save.cityCode };
  next.routes = next.routes.map(route => ({ ...route, stCombos: route.stCombos.map(combo => ({
    ...combo, path: combo.path.map(segment => ({ ...segment, signals: [...segment.signals] })),
  })) }));
  next.signals = next.signals.map(signal => signal.type === 'v-merge'
    ? { ...signal, status: { occupations: [], reservedBy: null } } : signal);
  next.yardsEnabled = save.data.yardsEnabled ?? false;
  next.yards = save.data.yards ?? [];
  if (!save.data.trackEditSession?.snapshot) {
    const disrupted = next.routes.filter(route => route.tempParentId === null && route.disruption);
    next.trackEditSession = disrupted.length ? {
      previousPauseState: true, affectedRouteIds: disrupted.map(route => route.id),
      demolishedConstructedTracks: [], restoredFromSave: true,
      snapshot: { tracks: next.tracks, trackGroups: next.trackGroups, routes: next.routes,
        trains: next.trains, stations: next.stations, money: next.money },
    } : null;
  }
  next.timeConfig = { ...next.timeConfig, paused: true };
  next.lastInfrastructureChargeTime = state.lastInfrastructureChargeTime;
  return next;
}

function setup({ load = loadNative170 } = {}) {
  const snapshot = snapshotFixture();
  const evidence = nativeHandoffEvidence(snapshot, marker);
  let state = { lastInfrastructureChargeTime: 0 };
  let calls = 0;
  const original = function (save) { calls++; state = load(state, save); return 'loaded'; };
  state.loadSave = original;
  const observer = observeNativeTileHandoff({ getState: () => state, evidence, snapshot });
  const handoff = () => ({ ...structuredClone(snapshot), cityCode: 'B', cityUid: 'B',
    metadata: { openWorldNativeRecovery: { ...marker } } });
  const consume = (overrides = {}) => observer.consume({ transitionId: marker.transitionId,
    sourceCityCode: 'A', destinationCityCode: 'B', snapshot, nativeNetwork: snapshot.data, ...overrides });
  return { snapshot, evidence, observer, original, handoff, consume, get state() { return state; }, get calls() { return calls; } };
}

test('a staged exact native load reuses authority after normal 1.7 loader transformations', () => {
  const f = setup();
  assert.equal(f.observer.status().state, 'armed');
  assert.equal(f.state.loadSave(f.handoff()), 'loaded');
  assert.equal(f.observer.status().state, 'observed');
  assert.equal(f.state.lastInfrastructureChargeTime, 0);
  assert.deepEqual(f.consume(), { reused: true, reason: 'verified-staged-native-load',
    version: NATIVE_HANDOFF_VERIFICATION_VERSION, recoveryId: 'handoff',
    transitionId: marker.transitionId, nativeSessionId: 'native-session' });
  assert.equal(f.state.lastInfrastructureChargeTime, 120);
  assert.equal(f.calls, 1);
  assert.equal(f.state.loadSave, f.original);
  assert.equal(f.observer.status().state, 'consumed');
  assert.equal(f.consume().reused, false, 'proof is one-use');
});

for (const changed of [false, true]) test(`1.7.2 handoff verifies deserialized reliability history (changed=${changed})`, () => {
  const history = { lastHourTimestamp: 3600,
    currentHour: { r: { all: { count: 3, onTime: 2, delaySum: 12, addedSum: 6 } } }, byRoute: {} };
  const f = setup({ load: (state, save) => ({ ...loadNative170(state, save), reliabilityHistory: structuredClone(history) }) });
  f.snapshot.data.reliabilityHistory = { v: 1, lastHourTimestamp: 3600,
    currentHour: { r: { all: [3, 2, 12, 6] } }, byRoute: {} };
  f.state.loadSave(f.handoff());
  if (changed) f.state.reliabilityHistory.currentHour.r.all.count++;
  assert.equal(f.consume().reused, !changed, 'reliability must agree with the staged Native Save');
});

for (const value of [undefined, null]) test(`native nullish yard defaults preserve exact reuse (${value})`, () => {
  const f = setup();
  f.snapshot.data.yardsEnabled = value;
  f.snapshot.data.yards = value;
  f.state.loadSave(f.handoff());
  assert.equal(f.state.yardsEnabled, false);
  assert.deepEqual(f.state.yards, []);
  assert.equal(f.consume().reused, true);
  assert.equal(f.calls, 1);
});

test('yard default normalization cannot hide changed payload intent or live yard contents', () => {
  const f = setup();
  f.snapshot.data.yardsEnabled = undefined;
  const altered = f.handoff(); altered.data.yardsEnabled = true;
  f.state.loadSave(altered);
  assert.equal(f.consume().reason, 'loader-payload-mismatch:yardsEnabled');
  const g = setup();
  g.snapshot.data.yardsEnabled = undefined;
  g.snapshot.data.yards = undefined;
  g.state.loadSave(g.handoff());
  g.state.yards.push({ id: 'unexpected-yard' });
  assert.equal(g.consume().reason, 'native-state-mismatch:yards.length');
});

for (const enabled of [true, false]) test(`explicit saved yard setting remains exact (${enabled})`, () => {
  const f = setup(); f.snapshot.data.yardsEnabled = enabled;
  f.state.loadSave(f.handoff()); f.state.yardsEnabled = !enabled;
  assert.equal(f.consume().reason, 'native-state-mismatch:yardsEnabled');
});

test('saved yard topology remains exact after native loading', () => {
  const f = setup();
  f.snapshot.data.yardsEnabled = true;
  f.snapshot.data.yards = [{ id: 'yard', trackIds: ['t'], name: 'Depot' }];
  f.state.loadSave(f.handoff()); f.state.yards[0].trackIds[0] = 'other-track';
  assert.equal(f.consume().reason, 'native-state-mismatch:yards[0].trackIds[0]');
});

test('native absent edit default is accepted but synthesized recovery state remains a mismatch', () => {
  const f = setup(); f.snapshot.data.trackEditSession = undefined;
  f.state.loadSave(f.handoff());
  assert.equal(f.state.trackEditSession, null);
  assert.equal(f.consume().reused, true);
  const g = setup(); g.snapshot.data.trackEditSession = undefined;
  g.snapshot.data.routes[0].tempParentId = null;
  g.snapshot.data.routes[0].disruption = { reason: 'missing-track' };
  g.state.loadSave(g.handoff());
  assert.equal(g.state.trackEditSession.restoredFromSave, true);
  assert.equal(g.consume().reason, 'native-state-mismatch:trackEditSession');
});

test('saved edit-session contents and unknown edit-state changes remain exact', () => {
  const f = setup();
  f.snapshot.data.trackEditSession = { snapshot: { money: 123 }, unknownEditIntent: 'keep' };
  f.state.loadSave(f.handoff()); f.state.trackEditSession.unknownEditIntent = 'changed';
  assert.equal(f.consume().reason, 'native-state-mismatch:trackEditSession.unknownEditIntent');
});

test('native city-load hook waits for the first pending-save load instead of consuming armed proof', async () => {
  const f = setup();
  const capturedLoadSave = f.state.loadSave;
  let cityLoad, consumed = false, pendingRead;
  const pendingSave = new Promise(resolve => { pendingRead = resolve; });
  // StoreInitializer captures loadSave at render, awaits loadInitialData (which
  // fires but does not await onCityLoad), then reads and loads the pending save.
  const loadInitialData = async () => {
    cityLoad = f.observer.waitForLoad().then(result => {
      assert.equal(result.state, 'observed');
      consumed = true;
      return f.consume();
    });
  };
  const initialize = (async () => {
    await loadInitialData();
    capturedLoadSave(await pendingSave);
  })();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(consumed, false);
  assert.equal(f.calls, 0);
  assert.equal(f.observer.status().state, 'armed');
  pendingRead(f.handoff());
  await initialize;
  assert.equal((await cityLoad).reused, true);
  assert.equal(f.calls, 1, 'only the original native loader applies the network');
});

test('waiting observes native completion, including asynchronous loader work after its lifecycle hook', async () => {
  let finish, state = { lastInfrastructureChargeTime: 0 }, callbackStatus;
  const snapshot = snapshotFixture();
  const nativeDone = new Promise(resolve => { finish = resolve; });
  state.loadSave = async save => {
    state = loadNative170(state, save);
    callbackStatus = observer.status().state;
    await nativeDone;
    return 'loaded';
  };
  const observer = observeNativeTileHandoff({ getState: () => state,
    snapshot, evidence: nativeHandoffEvidence(snapshot, marker) });
  let waited = false;
  const waiting = observer.waitForLoad().then(result => { waited = true; return result; });
  const load = state.loadSave({ ...snapshot, cityCode: 'B', metadata: { openWorldNativeRecovery: marker } });
  await Promise.resolve();
  assert.equal(callbackStatus, 'loading-exact');
  assert.equal(waited, false);
  finish();
  assert.equal(await load, 'loaded');
  assert.equal((await waiting).state, 'observed');
  observer.dispose();
});

test('invalid asynchronous native payload remains observable but fallback waits for loader completion', async () => {
  let finish, state = { lastInfrastructureChargeTime: 0 }, completed = false;
  const snapshot = snapshotFixture();
  const nativeDone = new Promise(resolve => { finish = resolve; });
  state.loadSave = async save => {
    state = loadNative170(state, save);
    assert.equal(observer.status().state, 'invalid', 'manual-load hooks must see invalid identity immediately');
    await nativeDone;
    return 'loaded';
  };
  const observer = observeNativeTileHandoff({ getState: () => state,
    snapshot, evidence: nativeHandoffEvidence(snapshot, marker) });
  const waiting = observer.waitForLoad().then(result => { completed = true; return result; });
  const save = { ...structuredClone(snapshot), cityCode: 'B', metadata: { openWorldNativeRecovery: marker } };
  save.data.money++;
  const load = state.loadSave(save);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, 'fallback cannot start while the invalid native loader is still running');
  finish();
  assert.equal(await load, 'loaded');
  assert.equal((await waiting).reason, 'loader-payload-mismatch:money');
  assert.equal(observer.consume({}).reused, false);
});

test('wait cancellation and disposal release pending waits and restore native action', async () => {
  const f = setup(); let current = true;
  const waiting = f.observer.waitForLoad({ isCurrent: () => current });
  current = false;
  assert.equal((await waiting).state, 'cancelled');
  assert.equal(f.state.loadSave, f.original);
  const g = setup();
  const disposed = g.observer.waitForLoad();
  g.observer.dispose();
  assert.equal((await disposed).state, 'consumed');
  assert.equal(g.state.loadSave, g.original);
});

test('bounded timeout cannot promote a bypassed captured native function into verified reuse', async () => {
  const f = setup();
  // A selector captured before attachment can still call the original. Matching
  // live data alone is insufficient evidence of the actual loader payload.
  f.original(f.handoff());
  const result = await f.observer.waitForLoad({ timeoutMs: 0 });
  assert.equal(result.state, 'timeout');
  assert.equal(f.consume().reason, 'staged-native-load-not-observed');
  assert.equal(f.calls, 1);
});

test('invalid payload and failed native load wake waiters without accepting the proof', async () => {
  const f = setup();
  const waiting = f.observer.waitForLoad();
  const ordinary = f.handoff(); delete ordinary.metadata;
  f.state.loadSave(ordinary);
  assert.equal((await waiting).state, 'invalid');
  assert.equal(f.consume().reason, 'unexpected-native-save-load');
  const failure = new Error('native load failed');
  const g = setup({ load: () => { throw failure; } });
  const failed = g.observer.waitForLoad();
  assert.throws(() => g.state.loadSave(g.handoff()), error => error === failure);
  assert.equal((await failed).reason, 'native-save-load-failed');
  g.observer.dispose();
});

test('observer publishes exact-load or invalid identity before native lifecycle callbacks', () => {
  const seen = [];
  let f;
  f = setup({ load: (state, save) => { seen.push(f.observer.status().state); return loadNative170(state, save); } });
  f.state.loadSave(f.handoff());
  assert.deepEqual(seen, ['loading-exact']);
  const ordinary = f.handoff(); delete ordinary.metadata;
  f.state.loadSave(ordinary);
  assert.deepEqual(seen, ['loading-exact', 'invalid']);
  assert.equal(f.consume().reason, 'unexpected-native-save-load');
});

test('stage evidence is compact and available only for complete tile-navigation handoffs', async () => {
  let pending;
  const source = snapshotFixture();
  const options = { electron: { setPendingSave: async save => { pending = save; } }, snapshot: source,
    destinationCityCode: 'B', sourceCityCode: 'A', reason: 'tile-navigation',
    transitionId: marker.transitionId, randomUUID: () => marker.recoveryId };
  const stage = await stageNativeRecovery(options);
  assert.deepEqual(stage.nativeHandoff, nativeHandoffEvidence(source, marker));
  assert.ok(JSON.stringify(stage.nativeHandoff).length < 500);
  assert.equal(pending.cityCode, 'B');
  assert.equal(source.cityCode, 'A');
  assert.equal((await stageNativeRecovery({ ...options, reason: 'renderer-reload' })).nativeHandoff, null);
  const incomplete = structuredClone(source); delete incomplete.data.stNodes;
  assert.equal(nativeHandoffEvidence(incomplete, marker), null);
});

for (const [name, mutate, path] of [
  ['route schedule', s => { s.routes[0].trainSchedule.lowDemand++; }, 'routes[0].trainSchedule.lowDemand'],
  ['route path timing', s => { s.routes[0].stCombos[0].path[0].signals[0].time++; }, 'routes[0].stCombos[0].path[0].signals[0].time'],
  ['train window', s => { s.trains[0].windows.forward.signalIds[0] = 'other'; }, 'trains[0].windows.forward.signalIds[0]'],
  ['track geometry', s => { s.tracks[0].coords[1][0]++; }, 'tracks[0].coords[1][0]'],
  ['signal topology', s => { s.signals[1].signalTracks[0].areaCovered = 'different'; }, 'signals[1].signalTracks[0].areaCovered'],
  ['unknown route property', s => { s.routes[0].newIntent = true; }, 'routes[0]:keys'],
  ['owned cars', s => { s.ownedCarsByType.metro++; }, 'ownedCarsByType.metro'],
  ['ledger', s => { s.financialHistory.entries[0].revenue++; }, 'financialHistory.entries[0].revenue'],
  ['completed fares', s => { s.completedCommutes[0].fareRevenue++; }, 'completedCommutes[0].fareRevenue'],
  ['clock', s => { s.timeConfig.elapsedSeconds++; }, 'timeConfig.elapsedSeconds'],
]) {
  test(`same IDs/counts with changed ${name} fall back with a scalar field path`, () => {
    const f = setup(); f.state.loadSave(f.handoff()); mutate(f.state);
    assert.equal(f.consume().reason, `native-state-mismatch:${path}`);
    assert.equal(f.state.lastInfrastructureChargeTime, 0, 'failed proof must not change finance');
    assert.equal(f.state.loadSave, f.original);
  });
}

test('matching live state cannot rescue a modified loader payload or canonical authority', () => {
  const f = setup();
  const save = f.handoff(); save.data.money++;
  f.state.loadSave(save); f.state.money = f.snapshot.data.money;
  assert.equal(f.consume().reason, 'loader-payload-mismatch:money');
  const g = setup(); g.state.loadSave(g.handoff());
  const network = structuredClone(g.snapshot.data); network.routes[0].trainSchedule.lowDemand++;
  assert.equal(g.consume({ nativeNetwork: network }).reason, 'canonical-mismatch:routes[0].trainSchedule.lowDemand');
});

test('paired-object reuse checks distinct reconstructed aliases instead of trusting only the saved object', () => {
  const f = setup();
  const shared = { nested: { geometry: [1, 2, 3] } };
  f.snapshot.data.routes[0].first = shared;
  f.snapshot.data.routes[0].second = shared;
  const save = f.handoff();
  save.data.routes[0].second = structuredClone(save.data.routes[0].first);
  save.data.routes[0].second.nested.geometry[2] = 4;
  f.state.loadSave(save);
  assert.equal(f.consume().reason, 'loader-payload-mismatch:routes[0].second.nested.geometry[2]');
});

test('large shared structures remain exact after the bounded pair cache turns over', () => {
  const f = setup();
  const shared = Array.from({ length: 10_000 }, (_, index) => ({ value: index }));
  f.snapshot.data.routes[0].first = shared;
  f.snapshot.data.routes[0].second = shared;
  f.state.loadSave(f.handoff());
  const second = structuredClone(f.state.routes[0].second);
  second[9_999].value = -1;
  f.state.routes[0].second = second;
  assert.equal(f.consume().reason, 'native-state-mismatch:routes[0].second[9999].value');
});

test('cyclic nonidentical objects cannot validate themselves through pair memoization', () => {
  const f = setup();
  const cycle = {}; cycle.self = cycle;
  f.snapshot.data.routes[0].futureIntent = cycle;
  f.state.loadSave(f.handoff());
  assert.match(f.consume().reason, /^loader-payload-mismatch:routes\[0\]\.futureIntent\.self.*:comparison-limit$/);
});

test('unknown signal status changes fail conservatively', () => {
  const f = setup(); f.snapshot.data.signals[1].status.futureField = true;
  f.state.loadSave(f.handoff());
  assert.equal(f.consume().reused, false);
});

test('absent observations, stale transitions, copied snapshots and other sessions cannot reuse', () => {
  assert.equal(setup().consume().reason, 'staged-native-load-not-observed');
  for (const overrides of [{ transitionId: 'old' }, { destinationCityCode: 'C' }, { sourceCityCode: 'C' }]) {
    const f = setup(); f.state.loadSave(f.handoff());
    assert.equal(f.consume(overrides).reason, 'handoff-context-mismatch');
  }
  const f = setup(); f.state.loadSave(f.handoff());
  assert.equal(f.consume({ snapshot: structuredClone(f.snapshot) }).reason, 'handoff-context-mismatch');
  const g = setup(); g.state.loadSave(g.handoff()); g.state.gameSessionId = 'other-session';
  assert.equal(g.consume().reason, 'native-identity-mismatch');
});

test('ordinary saves and repeat loads retain native behavior but invalidate reuse', () => {
  const f = setup(); const ordinary = f.handoff(); delete ordinary.metadata;
  assert.equal(f.state.loadSave(ordinary), 'loaded');
  assert.equal(f.consume().reason, 'unexpected-native-save-load');
  const g = setup(); g.state.loadSave(g.handoff()); g.state.loadSave(g.handoff());
  assert.equal(g.calls, 2);
  assert.equal(g.consume().reason, 'unexpected-native-save-load');
});

test('native failures and bounded comparisons fail closed without swallowing loader errors', () => {
  const failure = new Error('native failed');
  const f = setup({ load() { throw failure; } });
  assert.throws(() => f.state.loadSave(f.handoff()), error => error === failure);
  assert.equal(f.consume().reason, 'native-save-load-failed');
  const g = setup();
  let nested = {};
  for (let i = 0; i < 140; i++) nested = { nested };
  g.snapshot.data.routes[0].futureIntent = nested;
  g.state.loadSave(g.handoff());
  assert.match(g.consume().reason, /^loader-payload-mismatch:.*comparison-limit$/);
  assert.equal(g.calls, 1);
});

test('new observer replaces the prior generation and restores the original action on dispose', () => {
  const f = setup();
  const previousWrapper = f.state.loadSave;
  const next = observeNativeTileHandoff({ getState: () => f.state, evidence: f.evidence, snapshot: f.snapshot });
  assert.notEqual(f.state.loadSave, previousWrapper);
  assert.equal(f.observer.status().state, 'consumed');
  next.dispose();
  assert.equal(f.state.loadSave, f.original);
  assert.equal(f.calls, 0);
});

test('attachment disposes an older-generation observer and replaces its wrapper', () => {
  const snapshot = snapshotFixture();
  const original = () => 'native';
  const state = { loadSave: original };
  let previousDisposed = 0;
  const oldWrapper = (...args) => original(...args);
  Object.defineProperty(oldWrapper, Symbol.for('open-world.native-handoff-load-observer'), {
    value: { version: 'previous', dispose() { previousDisposed++; state.loadSave = original; } },
  });
  state.loadSave = oldWrapper;
  const current = observeNativeTileHandoff({ getState: () => state,
    evidence: nativeHandoffEvidence(snapshot, marker), snapshot });
  assert.equal(previousDisposed, 1);
  assert.notEqual(state.loadSave, oldWrapper);
  current.dispose();
  assert.equal(state.loadSave, original);
});

test('read-only native action leaves the ordinary restore path available', () => {
  const snapshot = snapshotFixture(), state = {};
  const original = () => 'native';
  Object.defineProperty(state, 'loadSave', { value: original });
  const observer = observeNativeTileHandoff({ getState: () => state,
    evidence: nativeHandoffEvidence(snapshot, marker), snapshot });
  assert.equal(state.loadSave(), 'native');
  assert.equal(observer.consume({}).reason, 'native-load-observer-unavailable');
});

test('adapter owns observer lifecycle and never retains consumed proof', () => {
  const f = setup(); f.observer.dispose();
  const adapter = new SubwayBuilderGameAdapter({ callbacks: { getState: () => f.state } });
  adapter.armNativeTileHandoff(f.evidence, f.snapshot);
  assert.equal(adapter.nativeTileHandoffStatus().state, 'armed');
  f.state.loadSave(f.handoff());
  const result = adapter.tryReuseStagedNativeHandoff({ transitionId: marker.transitionId,
    sourceCityCode: 'A', destinationCityCode: 'B', snapshot: f.snapshot, nativeNetwork: f.snapshot.data });
  assert.equal(result.reused, true);
  assert.equal(adapter.nativeTileHandoffStatus(), null);
  assert.equal(f.state.loadSave, f.original);
});

test('verified bookmark strips topology before cloning and isolates retained save fields', () => {
  const snapshot = snapshotFixture();
  const expected = stripNetworkFromSnapshot(snapshot);
  Object.defineProperty(snapshot.data.routes[0], 'mustNotTraverse', { enumerable: true,
    get() { throw new Error('discarded topology was cloned'); } });
  Object.defineProperty(snapshot.data.trains[0], 'mustNotTraverse', { enumerable: true,
    get() { throw new Error('discarded trains were cloned'); } });
  const stripped = stripVerifiedNativeHandoffNetwork(snapshot);
  assert.deepEqual(stripped, expected);
  stripped.data.financialHistory.entries[0].revenue = 999;
  assert.equal(snapshot.data.financialHistory.entries[0].revenue, 2);
  stripped.data.completedCommutes[0].fareRevenue = 999;
  assert.equal(snapshot.data.completedCommutes[0].fareRevenue, 2.5);
});
