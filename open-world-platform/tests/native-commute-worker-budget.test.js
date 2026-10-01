import test from 'node:test';
import assert from 'node:assert/strict';
import { installNativeCommuteWorkerBudget } from '../src/runtime/native-commute-worker-budget.js';

const url = 'file:///game/popCommuteWorker.worker-CI81Zuw7.js';
function harness() {
  const workers = [], timers = new Map(); let nextTimer = 0, now = 1000;
  class NativeWorker {
    constructor(url, options) { this.url = url; this.options = options; this.messages = []; workers.push(this); }
    postMessage(data) { this.messages.push(structuredClone(data)); }
    finish(data) { this.onmessage?.({ data }); }
    terminate() { this.terminated = true; }
  }
  const root = { Worker: NativeWorker, EventTarget, Event, MessageEvent, structuredClone,
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id) };
  const budget = installNativeCommuteWorkerBudget({ root, now: () => now });
  const step = () => new Promise(resolve => setImmediate(resolve));
  const pressure = gib => budget.updateMemory({ at: now, workersAvailable: true, allIsolatesAllocatedBytes: gib * 1024 ** 3 });
  return { root, budget, workers, timers, step, pressure, advance: ms => { now += ms; } };
}

test('24 native logical workers share six physical workers and one cloned network per version', async () => {
  const f = harness(), faces = Array.from({ length: 24 }, () => new f.root.Worker(url, { type: 'module' }));
  const network = { version: 1, network: { stops: ['original'] } }, received = [];
  assert.equal(f.workers.length, 0, 'idle logical workers allocate no native heap');
  for (const [id, face] of faces.entries()) {
    face.addEventListener('message', event => received.push([id, event.data]));
    face.postMessage({ setNetwork: network });
    face.postMessage({ popCommutes: [{ id }] });
  }
  network.network.stops[0] = 'mutated';
  await f.step();
  assert.equal(f.workers.length, 6);
  assert.equal(f.budget.snapshot().networkClones, 1);
  for (let group = 0; group < 4; group++) {
    for (const worker of f.workers.toReversed()) {
      assert.equal(worker.messages[0].setNetwork.network.stops[0], 'original');
      const id = worker.messages.at(-1).popCommutes[0].id;
      worker.finish({ processedPops: [{ id }] });
    }
    await f.step();
  }
  assert.equal(received.length, 24);
  for (const [id, data] of received) assert.equal(data.processedPops[0].id, id);
  assert.equal(f.budget.snapshot().busy, 0);
  assert.equal(f.budget.snapshot().queued, 0);
  const idleTimer = [...f.timers.keys()];
  for (let i = 0; i < 4; i++) { f.advance(1000); f.pressure(2); await f.step(); }
  assert.deepEqual([...f.timers.keys()], idleTimer, 'periodic samples must not postpone idle heap release');
});

test('the game app protocol reports native routing activity to the save gate', async () => {
  const f = harness();
  const face = new f.root.Worker('app://./assets/popCommuteWorker.worker-CI81Zuw7.js', { type: 'module' });
  face.postMessage({ setNetwork: { version: 1, network: {} } });
  face.postMessage({ popCommutes: [] });
  await f.step();
  assert.equal(f.budget.snapshot().logicalWorkers, 1, 'native workers served by the game app protocol must be observed');
  assert.equal(f.budget.snapshot().busy, 1);
  f.workers[0].finish({ processedPops: [] });
  await f.step();
  assert.equal(f.budget.snapshot().busy, 0);
});

test('the verified 1.7.2 worker keeps background commute waves inside the physical budget', async () => {
  const f = harness();
  const faces = Array.from({ length: 24 }, () => new f.root.Worker(
    'app://./assets/popCommuteWorker.worker-CAqx0wJ7.js', { type: 'module' }));
  const network = { version: 1, network: { stops: ['native-1.7.2'] } };
  for (const face of faces.slice(0, 7)) {
    face.postMessage({ setNetwork: network });
    face.postMessage({ popCommutes: [] });
  }
  await f.step();
  assert.equal(f.budget.snapshot().logicalWorkers, 24);
  assert.equal(f.budget.snapshot().workers, 6);
  assert.equal(f.budget.snapshot().queued, 1);
  assert.equal(f.budget.snapshot().networkClones, 1);
  f.workers[0].finish({ processedPops: [] }); await f.step();
  assert.equal(f.budget.snapshot().queued, 0);
  for (const worker of f.workers) worker.finish({ processedPops: [] });
  await f.step();
  assert.equal(f.budget.snapshot().busy, 0);
  for (const callback of [...f.timers.values()]) callback();
  assert.equal(f.budget.snapshot().workers, 0, 'native dynamic scheduling does not retire idle network heaps');
});

test('unknown worker hashes, non-module workers, remote URLs and a second script build pass through', () => {
  const f = harness();
  new f.root.Worker(url, { type: 'module' });
  for (const [candidate, options] of [
    ['file:///game/popCommuteWorker.worker-unknown.js', { type: 'module' }],
    ['file:///game/popCommuteWorker.worker-CAqx0wJ7.js', { type: 'module' }],
    [url, {}],
    ['https://example.com/popCommuteWorker.worker-CI81Zuw7.js', { type: 'module' }],
  ]) {
    const worker = new f.root.Worker(candidate, options);
    assert.equal(worker, f.workers.at(-1));
  }
  assert.equal(f.budget.snapshot().logicalWorkers, 1);
});

test('pressure reduces concurrency without terminating in-flight work, and idle workers can be recreated with their network', async () => {
  const f = harness(), faces = Array.from({ length: 8 }, () => new f.root.Worker(url, { type: 'module' }));
  for (const face of faces) { face.postMessage({ setNetwork: { version: 1, network: { name: 'first' } } }); face.postMessage({ popCommutes: [] }); }
  await f.step();
  f.pressure(3.6);
  assert.equal(f.budget.snapshot().limit, 1);
  assert.equal(f.workers.some(worker => worker.terminated), false);
  for (const worker of f.workers.slice(0, 5)) worker.finish({ processedPops: [] });
  await f.step();
  assert.equal(f.budget.snapshot().busy, 1);
  assert.equal(f.budget.snapshot().queued, 2);
  const last = f.workers[5]; last.finish({ processedPops: [] }); await f.step();
  assert.equal(f.budget.snapshot().busy, 1);
  last.finish({ processedPops: [] }); await f.step();
  last.finish({ processedPops: [] }); await f.step();
  for (const callback of [...f.timers.values()]) callback();
  assert.equal(f.budget.snapshot().workers, 0);
  faces[0].postMessage({ popCommutes: [] }); await f.step();
  assert.equal(f.workers.at(-1).messages[0].setNetwork.network.name, 'first');
  f.workers.at(-1).finish({ processedPops: [] }); await f.step();
  f.advance(4000); f.pressure(2);
  assert.equal(f.budget.snapshot().limit, 6);
});

test('other workers pass through unchanged and hot reload restores the previous constructor before replacing it', () => {
  const f = harness();
  const other = new f.root.Worker('file:///game/roadTiles.worker-J9HaJ8p5.js', { type: 'module' });
  assert.equal(other, f.workers[0]);
  const prior = f.root.Worker;
  assert.equal(installNativeCommuteWorkerBudget({ root: f.root }), f.budget);
  f.root.__openWorldNativeCommuteWorkerBudget__.version = 'native-commute-worker-budget-v2';
  const next = installNativeCommuteWorkerBudget({ root: f.root });
  assert.notEqual(f.root.Worker, prior);
  assert.notEqual(next, f.budget);
  assert.equal(next.original, f.budget.original);
  next.restoreConstructor();
  assert.equal(f.root.Worker, f.budget.original);
});

test('queued network versions and batch snapshots remain paired, and errors do not strand another logical worker', async () => {
  const f = harness(); f.pressure(3.6);
  const first = new f.root.Worker(url, { type: 'module' }), second = new f.root.Worker(url, { type: 'module' });
  const received = [];
  first.addEventListener('error', event => received.push(event.message));
  second.addEventListener('message', event => received.push(event.data));
  first.postMessage({ setNetwork: { version: 1, network: { id: 'old' } } });
  first.postMessage({ popCommutes: [{ id: 'first' }] });
  second.postMessage({ setNetwork: { version: 2, network: { id: 'new' } } });
  const batch = { popCommutes: [{ id: 'second' }] };
  second.postMessage(batch); batch.popCommutes[0].id = 'changed-after-send';
  await f.step();
  f.workers[0].onerror({ message: 'worker failed' }); await f.step();
  assert.equal(f.workers[0].terminated, true);
  assert.equal(f.workers[1].messages[0].setNetwork.network.id, 'new');
  assert.equal(f.workers[1].messages[1].popCommutes[0].id, 'second');
  f.workers[1].finish({ processedPops: ['second'] }); await f.step();
  assert.deepEqual(received, ['worker failed', { processedPops: ['second'] }]);
  first.postMessage({ popCommutes: [{ id: 'recreated' }] }); await f.step();
  assert.equal(f.workers[1].messages.at(-2).setNetwork.network.id, 'old');
  first.terminate(); await f.step();
  assert.equal(f.workers[1].terminated, true);
  assert.equal(f.budget.snapshot().busy, 0);
});
