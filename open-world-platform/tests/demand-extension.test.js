import test from 'node:test';
import assert from 'node:assert/strict';
import { demandContextRegistry, createDemandExtensionRuntime } from '../src/runtime/demand-context.js';
import { DemandExtensionStore, mergeDemandExtensions, DEMAND_CHECKPOINT_FIELD } from '../src/runtime/demand-extension-state.js';
import { offTileNativeDemandContextKey, evaluateOffTileNativeDemand } from '../src/runtime/off-tile-native-demand.js';
import { runNativeDemandWorkerJob } from '../src/runtime/native-demand-worker-job.js';
import { createActiveDemandPreparation } from '../src/runtime/active-demand-preparation.js';
import { createCachedSimulation } from '../src/runtime/cached-simulation.js';
import { WorldTileRuntime } from '../src/runtime/world-tile-runtime.js';
import { FakeGameAdapter } from '../src/runtime/adapters/fake-game-adapter.js';
import { MemoryTilePackageAdapter } from '../src/runtime/adapters/memory-tile-package-adapter.js';
import { ModStorageWorldStateAdapter } from '../src/runtime/adapters/mod-storage-world-state-adapter.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

const payload = (id = 'owned-1', size = 50) => ({
  ledger: JSON.stringify({ pops: { [id]: { residenceId: 'home', jobId: 'work', size } }, seq: 1 }),
  points: [], pops: [{ id, residenceId: 'home', jobId: 'work', size, drivingSeconds: 400,
    drivingDistance: 1000, homeDepartureTime: 28800, workDepartureTime: 61200 }],
});
const baseDemand = () => ({ points: [
  { id: 'home', location: [0, 0], residents: 0, jobs: 0 },
  { id: 'work', location: [.01, 0], residents: 0, jobs: 0 },
], pops: [] });
function fixture(storage = new Map(), selectContext = context => context) {
  let sequence = 0, actual = 0;
  const native = { cityCode: 'tile', gameSessionId: 'native', financialHistory: { nativeFinance: 123 },
    timeConfig: { paused: false }, demandData: { points: new Map(baseDemand().points.map(p => [p.id, p])), popsMap: new Map() },
    setFinancialHistory(history) { this.financialHistory = history; },
    setTimeConfig(config) { this.timeConfig = { ...this.timeConfig, ...config }; },
  };
  const context = { providerId: 'provider', definitionId: 'geographic-definition', resolvedWorldId: 'player-world',
    tileId: 'tile', cityCode: 'tile', nativeSessionId: 'native', epoch: 1, demandReady: true,
    tileBounds: [-1, -1, 1, 1], basemapRevision: 'map-v1' };
  const api = { gameState: { getDemandData: () => native.demandData }, demand: {
    addDemandPoint(point) { native.demandData.points.set(point.id, { ...point, residents: 0, jobs: 0 }); return { success: true, pointId: point.id }; },
    addPops(pops) {
      const popIds = pops.map(pop => {
        assert.ok(native.demandData.points.has(pop.residenceId)); assert.ok(native.demandData.points.has(pop.jobId));
        const id = `mod-pop-${++actual}`;
        native.demandData.popsMap.set(id, { ...pop, id, homeDepartureTime: 30000, workDepartureTime: 62000 });
        for (const [endpoint, total] of [[pop.residenceId, 'residents'], [pop.jobId, 'jobs']]) {
          const point = native.demandData.points.get(endpoint); point[total] = (point[total] ?? 0) + pop.size;
          point.popIds ??= []; if (!point.popIds.includes(id)) point.popIds.push(id);
        }
        return id;
      });
      return { success: true, popIds };
    },
    removePops(ids) {
      let removedCount = 0;
      for (const id of ids) {
        const pop = native.demandData.popsMap.get(id); if (!pop) continue;
        for (const [endpoint, total] of [[pop.residenceId, 'residents'], [pop.jobId, 'jobs']]) {
          const point = native.demandData.points.get(endpoint); point[total] -= pop.size;
          point.popIds = (point.popIds ?? []).filter(value => value !== id);
        }
        native.demandData.popsMap.delete(id); removedCount++;
      }
      return { success: true, removedCount };
    },
    removeDemandPoint(id) {
      assert.ok([...native.demandData.popsMap.values()].every(pop => pop.residenceId !== id && pop.jobId !== id));
      native.demandData.points.delete(id); return { success: true, removedPopCount: 0 };
    },
  } };
  const errors = [];
  const runtime = createDemandExtensionRuntime({ api, game: { callbacks: { getState: () => native } }, storage,
    readContext: () => selectContext(context), createId: () => String(++sequence), onError: error => errors.push(error) });
  return { runtime, api, context, native, storage, errors };
}

test('demand provider is separate from schematic provider and replacement fences old clients', async () => {
  const root = { crypto: { randomUUID: () => 'operation' }, SubwayBuilderOpenWorld: { version: 1, marker: 'untouched' } };
  const registry = demandContextRegistry(root);
  const f = fixture();
  const handle = registry.register('provider', f.runtime);
  assert.equal(registry.getContext().demandReady, false);
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const expected = registry.getContext();
  assert.equal(expected.demandReady, true);
  assert.equal(root.SubwayBuilderOpenWorld.marker, 'untouched');
  registry.register('provider', f.runtime);
  assert.throws(() => registry.readState('induced-demand', expected), /replaced/);
  handle.dispose();
  assert.ok(registry.getContext(), 'stale disposal must not remove the new provider');
});

test('empty checkpoints and ledger-only records do not require a native demand editor', async () => {
  const f = fixture(); delete f.api.gameState.getDemandData; delete f.api.demand;
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const store = new DemandExtensionStore({ storage: f.storage, createId: () => 'empty-ledger' });
  const committed = await store.commit(await store.readCheckpoint(null, 'player-world'), 'tile', 'induced',
    { ledger: '{"pressure":1}', points: [], pops: [] }, 'empty', [], { demandChanged: false });
  f.native.financialHistory[DEMAND_CHECKPOINT_FIELD] = committed.marker; f.context.epoch++;
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile', nativeAuthoritativeLoad: true });
  assert.equal(await f.runtime.readState('induced', f.runtime.getContext()), '{"pressure":1}');
});

test('mutation is synchronous once, becomes durable before native marker, and preserves finance', async () => {
  const f = fixture(); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const expected = f.runtime.getContext(); let applications = 0;
  const result = f.runtime.runMutation('induced-demand', expected, { mutationId: 'day-1', apply: () => { applications++; return payload(); } });
  assert.equal(applications, 1);
  assert.equal(f.runtime.getContext().demandReady, false);
  assert.equal(f.native.financialHistory[DEMAND_CHECKPOINT_FIELD], undefined);
  assert.throws(() => f.runtime.assertSaveReady(), /deferred/);
  await result;
  const marker = f.native.financialHistory[DEMAND_CHECKPOINT_FIELD];
  assert.ok(f.storage.has(marker.key)); assert.equal(f.native.financialHistory.nativeFinance, 123);
  assert.equal(f.runtime.getContext().demandRevision, 1); f.runtime.assertSaveReady();
  await f.runtime.runMutation('induced-demand', expected, { mutationId: 'day-1', apply: () => { applications++; return payload(); } });
  assert.equal(applications, 1);
  f.context.epoch++;
  await assert.rejects(f.runtime.runMutation('induced-demand', expected, { mutationId: 'day-2', apply: () => payload() }), /context changed/);
});

test('ledger-only commits keep routing identity; real overlay changes invalidate it', async () => {
  const f = fixture(); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  await f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'empty-pressure',
    apply: () => ({ ledger: '{"pressure":1}', points: [], pops: [] }) });
  assert.equal(f.runtime.cacheKeyFor('tile'), null);
  await f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'grow', apply: () => payload() });
  const routingKey = f.runtime.cacheKeyFor('tile'), revision = f.runtime.getContext().demandRevision;
  await f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'pressure',
    apply: () => ({ ...payload(), ledger: '{"pressure":2}' }) });
  assert.equal(f.runtime.cacheKeyFor('tile'), routingKey);
  assert.equal(f.runtime.getContext().demandRevision, revision + 1);
  await f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'resize', apply: () => payload('owned-1', 100) });
  assert.notEqual(f.runtime.cacheKeyFor('tile'), routingKey);
});

test('different edited branches of an older checkpoint cannot collide in routing identity', async () => {
  const storage = new Map(); let sequence = 0;
  const store = new DemandExtensionStore({ storage, createId: () => String(++sequence) });
  const empty = await store.readCheckpoint(null, 'world');
  const first = await store.commit(empty, 'a', 'induced', payload(), 'first');
  const branchA = await store.commit(first.checkpoint, 'a', 'induced', payload('owned-1', 100), 'branch-a');
  const branchB = await store.commit(first.checkpoint, 'a', 'induced', payload('owned-1', 150), 'branch-b');
  assert.equal(branchA.checkpoint.tiles.a.routingRevision, branchB.checkpoint.tiles.a.routingRevision);
  assert.notEqual(branchA.checkpoint.tiles.a.routingKey, branchB.checkpoint.tiles.a.routingKey);
});

test('failed durable write pauses and retries captured payload without repeating native mutations', async () => {
  const entries = new Map(); let fail = true;
  const storage = { get: key => entries.get(key), set: (key, value) => { if (fail) throw new Error('disk full'); entries.set(key, value); } };
  const f = fixture(storage); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const expected = f.runtime.getContext(); let applications = 0;
  const mutation = { mutationId: 'day-1', apply: () => { applications++; return payload(); } };
  await assert.rejects(f.runtime.runMutation('induced-demand', expected, mutation), /disk full/);
  assert.equal(f.native.timeConfig.paused, true); assert.equal(f.runtime.getContext().demandReady, false);
  assert.equal(f.native.financialHistory[DEMAND_CHECKPOINT_FIELD], undefined);
  fail = false; await f.runtime.runMutation('induced-demand', expected, mutation);
  assert.equal(applications, 1); assert.equal(f.runtime.getContext().demandReady, true);
});

test('a failed World or disposed provider cannot block ordinary city native saves', async () => {
  let owned = true;
  const f = fixture({ get: () => null, set() { throw new Error('disk full'); } }, context => owned ? context : null);
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  await assert.rejects(f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'one', apply: () => payload() }), /disk full/);
  assert.throws(() => f.runtime.assertSaveReady(), /deferred/);
  owned = false; f.runtime.assertSaveReady();
  owned = true; f.runtime.dispose(); f.runtime.assertSaveReady();
});

test('a real native reload clears the failed durability promise from the previous save', async () => {
  const f = fixture({ get: () => null, set() { throw new Error('disk full'); } });
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  await assert.rejects(f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'one', apply: () => payload() }), /disk full/);
  f.context.epoch++;
  f.native.demandData = { points: new Map(baseDemand().points.map(point => [point.id, point])), popsMap: new Map() };
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  await f.runtime.flush(); f.runtime.assertSaveReady();
  assert.equal(f.runtime.getContext().demandReady, true);
});

test('async native save leases reject edits and release on success or error after save preparation', async () => {
  for (const fails of [false, true]) {
    const f = fixture(), finishing = deferred(); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
    const expected = f.runtime.getContext(); let applications = 0;
    f.native.generateSave = async () => {
      await finishing.promise;
      if (fails) throw new Error('native save failed');
      return { data: { completedCommutes: [] } };
    };
    const controller = createCachedSimulation({ game: {}, api: { utils: {} }, getState: () => f.native,
      beforeGenerateSave: () => f.runtime.beginNativeSave() });
    const saving = f.native.generateSave();
    assert.equal(f.runtime.getContext().demandReady, false);
    await assert.rejects(f.runtime.runMutation('induced', expected, { mutationId: 'one', apply() { applications++; return payload(); } }), /not ready/);
    assert.equal(applications, 0);
    const completed = fails ? assert.rejects(saving, /native save failed/) : saving;
    finishing.resolve(); await completed;
    assert.equal(f.runtime.getContext().demandReady, true);
    await controller.dispose();
  }
});

test('native save leases from a previous context cannot hold a newly loaded save', async () => {
  const f = fixture(); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const oldRelease = f.runtime.beginNativeSave(); assert.equal(f.runtime.getContext().demandReady, false);
  f.context.epoch++; f.context.nativeSessionId = 'loaded-native';
  f.native.demandData = { points: new Map(baseDemand().points.map(point => [point.id, point])), popsMap: new Map() };
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  assert.equal(f.runtime.getContext().demandReady, true);
  oldRelease(); assert.equal(f.runtime.getContext().demandReady, true);
});

test('cached startup waits an extension initialization commit before internal save capture', async () => {
  const entries = new Map(), writing = deferred(), finish = deferred(); let writes = 0;
  const storage = { get: key => entries.get(key), async set(key, value) {
    if (++writes === 1) { writing.resolve(); await finish.promise; } entries.set(key, value);
  } };
  const f = fixture(storage); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  f.native.generateSave = () => ({ data: { completedCommutes: [] } });
  f.native.setDemandData = value => { f.native.demandData = value; };
  let prepared = 0;
  const controller = createCachedSimulation({ game: { calculateNativeFinanceProfile: () => ({ expenseProfile: {} }) },
    api: { utils: {} }, getState: () => f.native, beforeGenerateSave: () => f.runtime.beginNativeSave(),
    admitDemand: () => f.runtime.admit(), prepareActiveDemand: async () => {
      f.native.generateSave(); prepared++; return { assignments: [], profile: { hourly: [] } };
    } });
  const initialization = f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'initialize',
    apply: () => ({ ledger: '{}', points: [], pops: [] }) });
  await writing.promise;
  const enabling = controller.setEnabled(true);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(prepared, 0); assert.notEqual(controller.snapshot().status, 'error');
  finish.resolve(); await initialization; await enabling;
  assert.equal(prepared, 1); assert.equal(controller.snapshot().status, 'ready');
  await controller.dispose();
});

test('cached startup retries a typed durability deferral without requiring a mode toggle', async () => {
  const f = fixture(); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  f.native.generateSave = () => ({ data: { completedCommutes: [] } });
  f.native.setDemandData = value => { f.native.demandData = value; };
  let prepared = 0;
  const controller = createCachedSimulation({ game: { calculateNativeFinanceProfile: () => ({ expenseProfile: {} }) },
    api: { utils: {} }, getState: () => f.native, beforeGenerateSave: () => f.runtime.beginNativeSave(),
    admitDemand: () => f.runtime.admit(), prepareActiveDemand: async () => {
      if (++prepared === 1) {
        void f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'initialize',
          apply: () => ({ ledger: '{}', points: [], pops: [] }) });
        // Reproduce native capture after admission but before commit durability.
        f.native.generateSave();
      }
      return { assignments: [], profile: { hourly: [] } };
    } });
  await controller.setEnabled(true);
  assert.equal(prepared, 2); assert.equal(controller.snapshot().status, 'ready');
  assert.equal(f.runtime.getContext().demandReady, true); await controller.dispose();
});

test('a context replacement cancels demand admission instead of following it into the new save', async () => {
  const entries = new Map(), writing = deferred(), finish = deferred();
  const storage = { get: key => entries.get(key), async set(key, value) { writing.resolve(); await finish.promise; entries.set(key, value); } };
  const f = fixture(storage); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const mutation = f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'initialize', apply: () => payload() });
  const failedMutation = assert.rejects(mutation, /context changed/);
  await writing.promise;
  const admission = f.runtime.admit(); const cancelled = assert.rejects(admission, /context changed/);
  f.context.epoch++; f.context.nativeSessionId = 'loaded-native';
  finish.resolve(); await failedMutation; await cancelled;
});

test('exact older native save marker restores old extension and remaps regenerated pop IDs in ledger', async () => {
  const f = fixture(); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  await f.runtime.runMutation('induced-demand', f.runtime.getContext(), { mutationId: 'day-1', apply: () => payload('original', 50) });
  const oldMarker = structuredClone(f.native.financialHistory[DEMAND_CHECKPOINT_FIELD]);
  await f.runtime.runMutation('induced-demand', f.runtime.getContext(), { mutationId: 'day-2', apply: () => payload('later', 100) });
  f.native.financialHistory[DEMAND_CHECKPOINT_FIELD] = oldMarker;
  f.context.epoch++; f.native.demandData.popsMap.clear();
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const ledger = JSON.parse(await f.runtime.readState('induced-demand', f.runtime.getContext()));
  assert.deepEqual(Object.keys(ledger.pops), ['mod-pop-1']); assert.equal(ledger.pops['mod-pop-1'].size, 50);
  assert.equal(f.native.demandData.popsMap.get('mod-pop-1').size, 50);
  const restored = await f.runtime.extensionsFor('tile');
  assert.equal(restored[0].pops[0].homeDepartureTime, 30000);
  assert.equal(restored[0].pops[0].workDepartureTime, 62000);
  assert.ok(!Object.hasOwn(ledger.pops, 'later'));
  const missing = fixture(); missing.native.financialHistory[DEMAND_CHECKPOINT_FIELD] = oldMarker;
  await assert.rejects(missing.runtime.activate({ worldId: 'player-world', tileId: 'tile' }), /unavailable/);
  assert.equal(missing.runtime.getContext().demandReady, false);
});

test('same-object older native checkpoint removes only newer proven owned demand, including absent owners', async () => {
  const f = fixture(); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const demandObject = f.native.demandData;
  const ownedPoints = [{ id: 'qa-home', location: [.001, 0] }, { id: 'qa-work', location: [.009, 0] }];
  await f.runtime.runMutation('qa-owner', f.runtime.getContext(), { mutationId: 'qa-add', apply() {
    for (const point of ownedPoints) f.api.demand.addDemandPoint(point);
    const { popIds } = f.api.demand.addPops([{ residenceId: 'qa-home', jobId: 'qa-work', size: 25, drivingSeconds: 400 }]);
    return { ledger: JSON.stringify({ pops: { [popIds[0]]: { size: 25 } } }), points: ownedPoints,
      pops: popIds.map(id => f.native.demandData.popsMap.get(id)) };
  } });
  const saveB = structuredClone(f.native.financialHistory[DEMAND_CHECKPOINT_FIELD]);
  const unrelated = f.api.demand.addPops([{ residenceId: 'home', jobId: 'work', size: 3 }]).popIds[0];
  delete f.native.financialHistory[DEMAND_CHECKPOINT_FIELD]; f.context.epoch++;
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile', nativeAuthoritativeLoad: true });
  assert.equal(f.native.demandData, demandObject, 'native same-city loads can retain their demand object');
  assert.equal(await f.runtime.readState('qa-owner', f.runtime.getContext()), null);
  assert.equal(f.native.demandData.points.size, 2); assert.deepEqual([...f.native.demandData.popsMap.keys()], [unrelated]);
  assert.deepEqual(f.native.demandData.points.get('home').popIds, [unrelated]);
  // Repeating B then A restores/remaps B and removes that exact new live ID.
  f.native.financialHistory[DEMAND_CHECKPOINT_FIELD] = saveB; f.context.epoch++;
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile', nativeAuthoritativeLoad: true });
  assert.equal(f.native.demandData.points.size, 4); assert.equal(f.native.demandData.popsMap.size, 2);
  delete f.native.financialHistory[DEMAND_CHECKPOINT_FIELD]; f.context.epoch++;
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile', nativeAuthoritativeLoad: true });
  assert.equal(f.native.demandData.points.size, 2); assert.deepEqual([...f.native.demandData.popsMap.keys()], [unrelated]);
});

test('provider replacement retains previous ownership for same-object native checkpoint rollback', async () => {
  const f = fixture(); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const id = f.api.demand.addPops([{ residenceId: 'home', jobId: 'work', size: 25 }]).popIds[0];
  await f.runtime.runMutation('qa-owner', f.runtime.getContext(), { mutationId: 'qa-add',
    apply: () => ({ ledger: '{}', points: [], pops: [f.native.demandData.popsMap.get(id)] }) });
  const registry = demandContextRegistry({}); registry.register('provider', f.runtime);
  delete f.native.financialHistory[DEMAND_CHECKPOINT_FIELD]; f.context.epoch++;
  const replacement = createDemandExtensionRuntime({ api: f.api, game: { callbacks: { getState: () => f.native } },
    storage: f.storage, readContext: () => f.context, onError: () => {} });
  registry.register('provider', replacement);
  await replacement.activate({ worldId: 'player-world', tileId: 'tile', nativeAuthoritativeLoad: true });
  assert.equal(f.native.demandData.popsMap.size, 0); assert.equal(f.native.demandData.points.get('home').residents, 0);
});

test('same-tile player World replacement retires preceding proven owned demand', async () => {
  const f = fixture(); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const id = f.api.demand.addPops([{ residenceId: 'home', jobId: 'work', size: 25 }]).popIds[0];
  await f.runtime.runMutation('qa-owner', f.runtime.getContext(), { mutationId: 'qa-add',
    apply: () => ({ ledger: '{}', points: [], pops: [f.native.demandData.popsMap.get(id)] }) });
  f.context.resolvedWorldId = 'other-player-world'; f.context.nativeSessionId = 'other-player-native'; f.context.epoch++;
  delete f.native.financialHistory[DEMAND_CHECKPOINT_FIELD];
  await f.runtime.activate({ worldId: 'other-player-world', tileId: 'tile', nativeAuthoritativeLoad: true });
  assert.equal(f.native.demandData.popsMap.size, 0); assert.equal(f.native.demandData.points.get('home').residents, 0);
  assert.equal(f.runtime.getContext().resolvedWorldId, 'other-player-world');
});

test('activation retains admission hold across prior commit completion and delayed restoration reads', async () => {
  const entries = new Map(), writing = deferred(), finishWrite = deferred(), reading = deferred(), finishRead = deferred();
  let holdWrite = false, holdRead = false;
  const storage = { get(key) {
    if (holdRead && key.startsWith('demand-checkpoint:')) { holdRead = false; reading.resolve(); return finishRead.promise.then(() => entries.get(key)); }
    return entries.get(key);
  }, async set(key, value) { if (holdWrite) { holdWrite = false; writing.resolve(); await finishWrite.promise; } entries.set(key, value); } };
  const f = fixture(storage); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const empty = () => ({ ledger: '{}', points: [], pops: [] });
  await f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'one', apply: empty });
  holdWrite = true;
  const obsolete = f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'two', apply: empty });
  const rejected = assert.rejects(obsolete, /context changed/); await writing.promise;
  holdRead = true;
  const activating = f.runtime.activate({ worldId: 'player-world', tileId: 'tile', nativeAuthoritativeLoad: true });
  let admitted = false; const admission = f.runtime.admit().then(() => { admitted = true; });
  finishWrite.resolve(); await rejected; await reading.promise;
  await Promise.resolve(); await Promise.resolve();
  assert.equal(admitted, false); assert.equal(f.runtime.snapshot().busy, true);
  assert.equal(f.runtime.getContext().demandReady, false);
  assert.throws(() => f.runtime.assertSaveReady(), error => error.code === 'OPEN_WORLD_DEMAND_DEFERRED');
  finishRead.resolve(); await activating; await admission;
  assert.equal(admitted, true); assert.equal(f.runtime.getContext().demandReady, true);
});

test('superseding a restore during remapped-ID persistence retires the generated live IDs', async () => {
  const entries = new Map(), writing = deferred(), finish = deferred(); let hold = false;
  const storage = { get: key => entries.get(key), async set(key, value) {
    if (hold) { hold = false; writing.resolve(); await finish.promise; } entries.set(key, value);
  } };
  const f = fixture(storage); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const id = f.api.demand.addPops([{ residenceId: 'home', jobId: 'work', size: 25 }]).popIds[0];
  await f.runtime.runMutation('qa-owner', f.runtime.getContext(), { mutationId: 'qa-add',
    apply: () => ({ ledger: '{}', points: [], pops: [f.native.demandData.popsMap.get(id)] }) });
  const populated = structuredClone(f.native.financialHistory[DEMAND_CHECKPOINT_FIELD]);
  delete f.native.financialHistory[DEMAND_CHECKPOINT_FIELD]; f.context.epoch++;
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile', nativeAuthoritativeLoad: true });
  f.native.financialHistory[DEMAND_CHECKPOINT_FIELD] = populated; f.context.epoch++; hold = true;
  const restoring = f.runtime.activate({ worldId: 'player-world', tileId: 'tile', nativeAuthoritativeLoad: true });
  const obsolete = assert.rejects(restoring, /superseded/); await writing.promise;
  assert.equal(f.native.demandData.popsMap.size, 1);
  delete f.native.financialHistory[DEMAND_CHECKPOINT_FIELD]; f.context.epoch++;
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile', nativeAuthoritativeLoad: true });
  assert.equal(f.native.demandData.popsMap.size, 0); assert.equal(f.runtime.getContext().demandReady, true);
  finish.resolve(); await obsolete;
  assert.equal(f.native.demandData.popsMap.size, 0); assert.equal(f.runtime.getContext().demandReady, true);
});

test('retired point references from an unrelated owner fail preflight before any live demand edit', async () => {
  const f = fixture(); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const point = { id: 'owned-home', location: [.001, 0] };
  f.api.demand.addDemandPoint(point);
  const id = f.api.demand.addPops([{ residenceId: point.id, jobId: 'work', size: 25 }]).popIds[0];
  await f.runtime.runMutation('qa-owner', f.runtime.getContext(), { mutationId: 'qa-add',
    apply: () => ({ ledger: '{}', points: [point], pops: [f.native.demandData.popsMap.get(id)] }) });
  const foreign = f.api.demand.addPops([{ residenceId: point.id, jobId: 'work', size: 3 }]).popIds[0];
  delete f.native.financialHistory[DEMAND_CHECKPOINT_FIELD]; f.context.epoch++;
  await assert.rejects(f.runtime.activate({ worldId: 'player-world', tileId: 'tile', nativeAuthoritativeLoad: true }), /unrelated live pop/);
  assert.deepEqual([...f.native.demandData.popsMap.keys()], [id, foreign]);
  assert.equal(f.native.demandData.points.get(point.id).residents, 28);
  assert.equal(f.runtime.getContext().demandReady, false); assert.equal(f.native.timeConfig.paused, true);
});

test('old immutable manifest never incorporates a later tile extension', async () => {
  const storage = new Map(); let id = 0;
  const store = new DemandExtensionStore({ storage, createId: () => String(++id) });
  const empty = await store.readCheckpoint(null, 'world');
  const old = await store.commit(empty, 'a', 'induced', payload(), 'a-day-1');
  const next = await store.commit(old.checkpoint, 'b', 'induced', payload('b-pop'), 'b-day-1');
  assert.ok(next.checkpoint.tiles.b);
  assert.equal((await store.readCheckpoint(old.marker, 'world')).tiles.b, undefined);
  await assert.rejects(store.readCheckpoint(old.marker, 'another-world'), /does not belong/);
});

test('overlay merge derives balanced native endpoint totals and leaves installed base untouched', () => {
  const base = baseDemand(); const merged = mergeDemandExtensions(base, [payload()]);
  assert.equal(merged.points[0].residents, 50); assert.equal(merged.points[1].jobs, 50);
  assert.equal(merged.pops.length, 1); assert.equal(base.points[0].residents, 0); assert.equal(base.pops.length, 0);
  assert.throws(() => mergeDemandExtensions(merged, [payload()]), /collides/);
});

test('both JSON evaluator and byte worker evaluate extensions and revision invalidates shortcut key', async () => {
  const input = { worldId: 'world', tileId: 'tile', networkProfile: { stations: [], routes: [], trains: [], structuralSignature: 'empty' },
    demandRevisionKey: 'revision-1', demandExtensions: [payload()] };
  const json = evaluateOffTileNativeDemand({ ...input, demand: baseDemand() });
  const bytes = new TextEncoder().encode(JSON.stringify(baseDemand()));
  const worker = await runNativeDemandWorkerJob({ bytes: bytes.buffer, input });
  assert.equal(json.profile.evaluatedPops, 1); assert.equal(worker.profile.evaluatedPops, 1);
  assert.equal(worker.profile.demandRevisionKey, 'revision-1');
  assert.notEqual(offTileNativeDemandContextKey(input), offTileNativeDemandContextKey({ ...input, demandRevisionKey: 'revision-2' }));
});

test('throwing apply can be retried, while malformed captured output never repeats native edits', async () => {
  const f = fixture(); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const expected = f.runtime.getContext(); let attempts = 0;
  const operation = { mutationId: 'retry-editor', apply() { if (++attempts === 1) throw new Error('editor rolled back'); return payload(); } };
  await assert.rejects(f.runtime.runMutation('induced', expected, operation), /rolled back/);
  await f.runtime.runMutation('induced', expected, operation); assert.equal(attempts, 2);
  let invalidEdits = 0;
  const invalidExpected = f.runtime.getContext();
  const invalid = { mutationId: 'invalid-snapshot', apply() { invalidEdits++; return { ...payload(), ledger: 'bad JSON' }; } };
  await assert.rejects(f.runtime.runMutation('induced', invalidExpected, invalid));
  await assert.rejects(f.runtime.runMutation('induced', invalidExpected, invalid));
  assert.equal(invalidEdits, 1); assert.throws(() => f.runtime.assertSaveReady(), /deferred/);
});

for (const delayedKind of ['demand-checkpoint:', 'demand-extension:']) {
  test(`activation fences a changed native session after delayed ${delayedKind} read`, async () => {
    const entries = new Map(), read = deferred(), waiting = deferred(); let delay = false;
    const storage = { get(key) { if (delay && key.startsWith(delayedKind)) { waiting.resolve(); return read.promise.then(() => entries.get(key)); } return entries.get(key); },
      set: (key, value) => entries.set(key, value) };
    const f = fixture(storage); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
    await f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'one', apply: () => payload() });
    f.native.demandData.popsMap.clear(); delay = true;
    const obsolete = f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
    await waiting.promise;
    f.context.nativeSessionId = 'new-native'; f.context.epoch++;
    f.native.demandData = { points: new Map(), popsMap: new Map() };
    const oldHistory = f.native.financialHistory;
    read.resolve(); await assert.rejects(obsolete, /context changed/);
    assert.equal(f.native.demandData.points.size, 0); assert.equal(f.native.demandData.popsMap.size, 0);
    assert.equal(f.native.financialHistory, oldHistory); assert.equal(f.native.timeConfig.paused, false);
  });
}

test('overlapping activation cannot replace the newer checkpoint or records', async () => {
  const entries = new Map(), waiting = deferred(), read = deferred(); let delay = false;
  const storage = { get(key) { if (delay && key.startsWith('demand-checkpoint:')) { delay = false; waiting.resolve(); return read.promise.then(() => entries.get(key)); } return entries.get(key); },
    set: (key, value) => entries.set(key, value) };
  const f = fixture(storage); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  await f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'one', apply: () => payload() });
  delay = true; const old = f.runtime.activate({ worldId: 'player-world', tileId: 'tile' }); await waiting.promise;
  f.context.resolvedWorldId = 'other-world'; f.context.nativeSessionId = 'other-native'; f.context.epoch++;
  delete f.native.financialHistory[DEMAND_CHECKPOINT_FIELD];
  await f.runtime.activate({ worldId: 'other-world', tileId: 'tile' });
  read.resolve(); await assert.rejects(old, /superseded/);
  assert.equal(f.runtime.getContext().resolvedWorldId, 'other-world');
  assert.equal(await f.runtime.readState('induced', f.runtime.getContext()), null);
  assert.equal(f.runtime.getContext().demandReady, true);
});

test('pending hot reload takeover preserves payload without repeating edits; old provider never stamps', async () => {
  const entries = new Map(), writing = deferred(), release = deferred(); let delay = false;
  const storage = { get: key => entries.get(key), async set(key, value) {
    if (delay) { delay = false; writing.resolve(); await release.promise; } entries.set(key, value);
  } };
  const f = fixture(storage); const registry = demandContextRegistry({});
  const oldHandle = registry.register('provider', f.runtime);
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const oldExpected = registry.getContext(); let applications = 0;
  delay = true;
  const mutation = registry.runMutation('induced', oldExpected, { mutationId: 'one', apply() {
    applications++; const result = payload(); f.native.demandData.popsMap.set('owned-1', result.pops[0]); return result;
  } });
  // Mark the rejection handled before releasing the old durable write.
  const rejectedOld = assert.rejects(mutation, /context changed/);
  await writing.promise; oldHandle.dispose(); f.context.epoch++;
  let sequence = 100;
  const replacement = createDemandExtensionRuntime({ api: f.api, game: { callbacks: { getState: () => f.native } }, storage,
    readContext: () => f.context, createId: () => String(++sequence), onError: () => {} });
  registry.register('provider', replacement);
  const activation = replacement.activate({ worldId: 'player-world', tileId: 'tile' });
  assert.throws(() => replacement.assertSaveReady(), /deferred/);
  release.resolve(); await rejectedOld;
  assert.equal(f.native.financialHistory[DEMAND_CHECKPOINT_FIELD], undefined, 'old owner cannot stamp the new generation');
  await activation;
  assert.equal(applications, 1);
  const ledger = JSON.parse(await registry.readState('induced', registry.getContext()));
  assert.equal(ledger.pops['owned-1'].size, 50);
  assert.deepEqual([...f.native.demandData.popsMap.keys()], ['owned-1']);
});

test('explicit same-object native reload discards pending hot reload takeover', async () => {
  const entries = new Map(), writing = deferred(), release = deferred(); let delay = false;
  const storage = { get: key => entries.get(key), async set(key, value) {
    if (delay) { delay = false; writing.resolve(); await release.promise; } entries.set(key, value);
  } };
  const f = fixture(storage); const registry = demandContextRegistry({}); registry.register('provider', f.runtime);
  await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' }); delay = true;
  const mutation = registry.runMutation('induced', registry.getContext(), { mutationId: 'one', apply() {
    const id = f.api.demand.addPops([{ residenceId: 'home', jobId: 'work', size: 50, drivingSeconds: 400, drivingDistance: 1000 }]).popIds[0];
    return { ...payload(id), pops: [f.native.demandData.popsMap.get(id)] };
  } });
  const rejectedOld = assert.rejects(mutation, /context changed/); await writing.promise;
  f.context.epoch++;
  const replacement = createDemandExtensionRuntime({ api: f.api, game: { callbacks: { getState: () => f.native } }, storage,
    readContext: () => f.context, onError: () => {} });
  registry.register('provider', replacement); const activation = replacement.activate({ worldId: 'player-world', tileId: 'tile', nativeAuthoritativeLoad: true });
  release.resolve(); await rejectedOld; await activation;
  assert.equal(await registry.readState('induced', registry.getContext()), null);
  assert.equal(f.native.demandData.popsMap.size, 0); assert.equal(f.native.financialHistory[DEMAND_CHECKPOINT_FIELD], undefined);
});

test('active worker result waits concurrent mutation durability then rejects obsolete revision', async () => {
  const f = fixture(); await f.runtime.activate({ worldId: 'player-world', tileId: 'tile' });
  const worker = deferred(), started = deferred();
  const preparation = createActiveDemandPreparation({ game: { captureCrossTileNetworkProfile: () => ({ stations: [], routes: [], trains: [] }) },
    getState: () => f.native, admit: async () => { await f.runtime.flush(); f.runtime.assertSaveReady(); },
    getDemandRevisionKey: id => f.runtime.cacheKeyFor(id),
    evaluator: { evaluate: async () => { started.resolve(); return worker.promise; }, snapshot: () => ({}) } });
  const evaluation = preparation.prepare({ tileId: 'tile' }); await started.promise;
  await f.runtime.runMutation('induced', f.runtime.getContext(), { mutationId: 'one', apply: () => payload() });
  worker.resolve({ profile: {}, status: 'evaluated' });
  await assert.rejects(evaluation, /superseded/);
});

test('staged finance never republishes an earlier tile profile after its demand changed during another evaluation', async () => {
  const tileIds = ['T0', 'T1'], waiting = deferred(), release = deferred(); let delay = true;
  const tilePackages = new MemoryTilePackageAdapter(Object.fromEntries(tileIds.map(tileId => [tileId, {
    manifest: { tileId, cityCode: tileId, schemaVersion: 1, dataFiles: {} },
    commuteCatalog: { buildHash: 'demand-profile-race', buckets: [], gateways: [] },
  }])));
  tilePackages.evaluateNativeDemand = async input => {
    if (delay && input.tileId === 'T1') { delay = false; waiting.resolve(); await release.promise; }
    return evaluateOffTileNativeDemand({ ...input, demand: { points: [], pops: [] } });
  };
  const runtime = new WorldTileRuntime({ game: new FakeGameAdapter(), worldState: new ModStorageWorldStateAdapter(),
    tilePackages, initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] } });
  await runtime.boot('profile-race-world', 'T0');
  const revisions = new Map([['T0', 'old-demand']]);
  runtime.demandExtensions = { cacheKeyFor: tile => revisions.get(tile) ?? null, extensionsFor: async () => [],
    flush: async () => {}, assertSaveReady() {} };
  runtime.world.globalNetwork = { hash: 'global-network', nativeState: {
    stations: [], routes: [], trains: [], fareGroups: [], tracks: [], trackGroups: [],
  } };
  runtime.world.activeProjection = { financeOwnedRouteIds: [], financeOwnedTrackIds: [] };
  const recalculating = runtime.recalculateCrossTileModeShare({ reason: 'extension-demand-change', force: true });
  await waiting.promise; revisions.set('T0', 'new-demand');
  delete runtime.world.backgroundNativeFinance?.tileRevenueProfiles?.T0;
  release.resolve(); await recalculating;
  assert.equal(runtime.world.backgroundNativeFinance?.tileRevenueProfiles?.T0, undefined);
  await runtime.recalculateCrossTileModeShare({ reason: 'extension-demand-change', force: true });
  assert.equal(runtime.world.backgroundNativeFinance.tileRevenueProfiles.T0.demandRevisionKey, 'new-demand');
});

test('both direct and staged tile loads restore extensions before refreshing native commutes', async () => {
  for (const staged of [false, true]) {
    const tileIds = ['T0', 'T1'], events = [];
    const tilePackages = new MemoryTilePackageAdapter(Object.fromEntries(tileIds.map(tileId => [tileId, {
      manifest: { tileId, cityCode: tileId, schemaVersion: 1, dataFiles: {} }, demand: [],
      commuteCatalog: { buildHash: 'extension-load-order', buckets: [], gateways: [] },
    }])));
    const game = new FakeGameAdapter();
    let activatedTile;
    game.refreshNativeCommutes = async () => {
      events.push('commutes');
      assert.equal(game.native.financialHistory[DEMAND_CHECKPOINT_FIELD].key, `marker:${activatedTile}`,
        'authoritative global finance restoration must not overwrite the restored extension marker');
    };
    const runtime = new WorldTileRuntime({ game, worldState: new ModStorageWorldStateAdapter(), tilePackages,
      initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] } });
    assert.equal(Boolean(runtime.revenueAccrual), false, 'exercise the financialHistory replacement path');
    runtime.demandExtensions = { activate: async ({ tileId }) => {
      activatedTile = tileId; events.push(`extension:${tileId}`);
      game.native.financialHistory[DEMAND_CHECKPOINT_FIELD] = { key: `marker:${tileId}` };
    },
      flush: async () => {}, assertSaveReady() {}, cacheKeyFor: () => null, extensionsFor: async () => [] };
    await runtime.boot(`extension-order-${staged}`, 'T0'); events.length = 0;
    if (staged) { await runtime.stageNavigationTransition('T1'); await runtime.completeStagedTransition('T1'); }
    else await runtime.transitionTo('T1');
    assert.ok(events.indexOf('extension:T1') >= 0);
    assert.ok(events.indexOf('extension:T1') < events.indexOf('commutes'));
    assert.equal(game.native.financialHistory[DEMAND_CHECKPOINT_FIELD].key, 'marker:T1');
  }
});
