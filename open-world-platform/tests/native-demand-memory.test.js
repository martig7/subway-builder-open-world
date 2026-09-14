import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOffTileNativeDemand } from '../src/runtime/off-tile-native-demand.js';
import { createNetworkProfile } from '../src/runtime/cross-tile-mode-choice.js';
import { nativeDemandEvaluationBatches } from '../src/runtime/off-tile-native-demand.js';
import { runNativeDemandWorkerJob } from '../src/runtime/native-demand-worker-job.js';
import { createOffMainThreadNativeDemandEvaluator, assertNativeDemandMemoryBudget } from '../src/runtime/embedded-tile-package-adapter.js';
import { createActiveDemandPreparation } from '../src/runtime/active-demand-preparation.js';
import { Worker as NodeWorker } from 'node:worker_threads';

function input() {
  return { tileId: 'A', worldId: 'session', includeAssignments: true, farePolicy: { fare: 2.5 },
    networkProfile: createNetworkProfile({ tileId: 'A',
      stations: [0, 1].map(i => ({ id: `s${i}`, coords: [i * .1, 0], stNodeIds: [`n${i}`] })),
      routes: [{ id: 'r', idealTrainCount: 2, stNodes: [{ id: 'n0' }, { id: 'n1' }],
        stComboTimings: [{ stNodeIndex: 0, arrivalTime: 0, departureTime: 20 },
          { stNodeIndex: 1, arrivalTime: 600, departureTime: 620 }] }],
    }),
    demand: { points: [{ id: 'h', location: [0, 0] }, { id: 'w', location: [.1, 0] }],
      pops: Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, size: 100 + i,
        residenceId: i % 2 ? 'w' : 'h', jobId: i % 2 ? 'h' : 'w',
        drivingSeconds: 3600, drivingDistance: 25000, homeDepartureTime: 25000 + i, workDepartureTime: 64000 + i })) },
  };
}

test('native demand bounds both-direction intermediates without changing assignments or finance', () => {
  const request = input();
  const whole = evaluateOffTileNativeDemand({ ...request, batchSize: 100 });
  const batches = [];
  const bounded = evaluateOffTileNativeDemand({ ...request, batchSize: 2, onBatch: count => batches.push(count) });
  assert.deepEqual(batches, [2, 2, 2, 2, 1], 'routing must release direction results after each bounded cohort batch');
  assert.deepEqual(bounded.assignments, whole.assignments);
  assert.equal(bounded.profile.evaluationKey, whole.profile.evaluationKey);
  assert.equal(bounded.profile.transitPopulation, whole.profile.transitPopulation);
  assert.deepEqual(bounded.profile.modeChoicePopulation, whole.profile.modeChoicePopulation);
  assert.deepEqual(bounded.profile.ridershipByRoute, whole.profile.ridershipByRoute);
  for (let hour = 0; hour < 24; hour++) {
    assert.ok(Math.abs(bounded.profile.hourly[hour].revenue - whole.profile.hourly[hour].revenue) < 1e-7);
    assert.deepEqual(bounded.profile.hourly[hour].completedCommutes, whole.profile.hourly[hour].completedCommutes);
  }
});

export { input };

function diskFixture() {
  const records = new Map();
  let evaluations = 0, maxChunkPops = 0;
  const store = { read: async key => structuredClone(records.get(key)),
    write: async (key, value) => {
      if (typeof key === 'number') maxChunkPops = Math.max(maxChunkPops, JSON.parse(new TextDecoder().decode(value)).assignments.length);
      records.set(key, structuredClone(value));
    }, clear: async () => records.clear() };
  const execute = async (bytes, request, options) => {
    const assignments = [];
    const result = await runNativeDemandWorkerJob({ bytes: typeof bytes === 'function' ? await bytes() : bytes,
      input: { ...request, batchSize: 2 }, ...options }, { store,
      evaluateBatches: function* (value) { evaluations++; yield* nativeDemandEvaluationBatches(value); },
      emitAssignments: rows => assignments.push(...rows), resetAssignments: () => { assignments.length = 0; } });
    return { ...result, ...(options.cacheMode === 'assignments' ? { assignments } : {}) };
  };
  return { records, store, execute, snapshot: () => ({ evaluations, maxChunkPops }) };
}

test('regular active-tile preparation persists chunks and ultra-speed loads them without a second routing pass', async () => {
  const disk = diskFixture(), request = input();
  const state = { gameSessionId: 'save-one', cityCode: 'A', transitCost: 2.5, routes: [], fareGroups: [],
    demandData: { points: new Map(request.demand.points.map(p => [p.id, p])), popsMap: new Map(request.demand.pops.map(p => [p.id, p])) } };
  const service = createActiveDemandPreparation({ getState: () => state,
    game: { captureCrossTileNetworkProfile: () => request.networkProfile },
    evaluator: { evaluate: disk.execute, snapshot: () => ({}) } });
  const prepared = await service.prepare();
  assert.equal(prepared.assignments, undefined, 'preparation must not materialize dormant assignments in the main heap');
  assert.equal(prepared.profile.source, 'active-tile-prepared', 'active departures cannot masquerade as an inactive profile');
  const loaded = await service.prepare({ assignments: true });
  assert.equal(loaded.diskCache, 'hit');
  assert.equal(disk.snapshot().evaluations, 1);
  assert.equal(disk.snapshot().maxChunkPops, 2);
  assert.deepEqual(loaded.assignments, evaluateOffTileNativeDemand(request).assignments);
  assert.deepEqual(prepared.profile, loaded.profile);
  request.networkProfile.signature = 'moving-train-clock';
  request.networkProfile.routes[0].departureAnchorsByNode = { n0: [999999] };
  await service.prepare({ assignments: true });
  assert.equal(disk.snapshot().evaluations, 1, 'moving anchors do not invalidate configured-service assignments');
  state.transitCost = 4;
  await service.prepare({ assignments: true });
  assert.equal(disk.snapshot().evaluations, 2, 'fare edits invalidate the disk generation');
  state.gameSessionId = 'save-two';
  await service.prepare();
  assert.equal(disk.snapshot().evaluations, 3, 'a loaded save cannot inherit another save cache');
  state.demandData.popsMap.get('p0').homeDepartureTime++;
  await service.prepare();
  assert.equal(disk.snapshot().evaluations, 4, 'native departure changes invalidate routing');
  assert.equal(disk.records.size, 6, 'disk cache retains only five current chunks and one committed manifest');
});

test('disk failures preserve bounded computation, and an incomplete cache cannot duplicate assignments', async () => {
  const disk = diskFixture(), { demand, ...request } = input();
  const bytes = new TextEncoder().encode(JSON.stringify(demand));
  await disk.execute(bytes, request, { cacheMode: 'prepare' });
  disk.records.delete(2);
  const restored = await disk.execute(bytes, request, { cacheMode: 'assignments' });
  assert.equal(restored.assignments.length, demand.pops.length);
  assert.equal(restored.diskCache, 'unavailable');
  assert.deepEqual(restored.assignments, evaluateOffTileNativeDemand({ ...request, demand }).assignments);
});

test('shared evaluator serializes requests before allocating inputs and releases the idle heap', async () => {
  const messages = []; let allocations = 0, terminated = 0;
  class Worker {
    set onmessage(value) { this.handler = value; queueMicrotask(() => value({ data: { type: 'ready' } })); }
    postMessage(message) { messages.push(() => this.handler({ data: { id: message.id, ok: true, value: { profile: {} } } })); }
    terminate() { terminated++; }
  }
  const evaluator = createOffMainThreadNativeDemandEvaluator({ WorkerClass: Worker, BlobClass: class {},
    workerSource: 'test', createObjectURL: () => 'blob:test', revokeObjectURL() {}, readMemory: () => null });
  const payload = () => { allocations++; return new Uint8Array([1]); };
  const first = evaluator.evaluate(payload, {}), second = evaluator.evaluate(payload, {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(allocations, 1);
  assert.equal(messages.length, 1);
  messages.shift()(); await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(allocations, 2);
  assert.equal(evaluator.snapshot().active, 1);
  messages.shift()(); await second;
  assert.equal(terminated, 2);
  assert.equal(evaluator.snapshot().workerAlive, false);
  evaluator.dispose();
});

test('fresh combined allocation defers additional routing; stale or partial samples never invent free space', () => {
  const at = Date.now();
  const sample = { at, available: true, workersAvailable: true, allIsolatesAllocatedBytes: 3.9 * 1024 ** 3,
    headroomBytes: 2 * 1024 ** 3 };
  assert.throws(() => assertNativeDemandMemoryBudget(sample, { now: at }), { name: 'NativeDemandMemoryPressureError' });
  assert.doesNotThrow(() => assertNativeDemandMemoryBudget({ ...sample, at: at - 4000 }, { now: at }));
  assert.doesNotThrow(() => assertNativeDemandMemoryBudget({ ...sample, workersAvailable: false }, { now: at }));
  assert.throws(() => assertNativeDemandMemoryBudget({ ...sample, workersAvailable: false, headroomBytes: 1 }, { now: at }));
});

test('the production native worker streams complete assignments across a real thread and releases it', async () => {
  const url = new URL('../src/workers/native-demand-evaluator-worker.js', import.meta.url).href;
  let terminated = 0;
  class ThreadWorker {
    constructor() {
      this.thread = new NodeWorker(`
        const { parentPort } = await import('node:worker_threads');
        globalThis.self = { postMessage: value => parentPort.postMessage(value) };
        await import(${JSON.stringify(url)});
        parentPort.on('message', data => self.onmessage({ data }));
      `, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 } });
      this.thread.on('message', data => this.onmessage?.({ data }));
      this.thread.on('error', error => this.onerror?.(error));
    }
    postMessage(message, transfer) { this.thread.postMessage(message, transfer); }
    terminate() { terminated++; return this.thread.terminate(); }
  }
  const client = createOffMainThreadNativeDemandEvaluator({ WorkerClass: ThreadWorker, workerSource: 'native-worker',
    createObjectURL: () => 'blob:real-thread', revokeObjectURL() {}, readMemory: () => null });
  const { demand, ...request } = input();
  try {
    const result = await client.evaluate(new TextEncoder().encode(JSON.stringify(demand)), request);
    assert.deepEqual(result.assignments, evaluateOffTileNativeDemand({ ...request, demand }).assignments);
    assert.equal(result.diskCache, 'unavailable', 'Node has no IndexedDB; bounded computation remains available');
    assert.equal(client.snapshot().workerAlive, false);
    assert.equal(terminated, 1);
  } finally { client.dispose(); }
});
