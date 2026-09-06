import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createCrossModeShareEvaluator } from '../src/runtime/cross-mode-share-evaluator.js';
import { createCrossModeShareWorkerHandler } from '../src/workers/cross-mode-share-worker.js';
import { calculateCrossTileModeShares, createNetworkProfile } from '../src/runtime/cross-tile-mode-choice.js';
import { fareSegmentsFromStationRoutes, quoteJourneyFare } from '../src/runtime/journey-fare.js';

function fixture() {
  const profile = createNetworkProfile({ tileId: 'T0', stations: [0, 1, 2].map(i => ({ id: `s${i}`, coords: [i * 0.05, 0], stNodeIds: [`n${i}`], nearbyStations: [], buildType: 'constructed' })),
    routes: [{ id: 'r0', stNodes: [0, 1, 2].map(i => ({ id: `n${i}` })) }], trains: [{ id: 'train', routeId: 'r0' }],
  });
  return { crossDemand: { schemaVersion: 1, tileId: 'T0', points: [['h', 0, 0, 'T0'], ['w', 0.1, 0, 'T0']], gateways: ['local'],
    pops: [['p0', 100, 0, 1, 0], ['p1', 150, 0, 1, 0], ['p2', 100, 1, 0, 0]],
  }, networkProfiles: { T0: profile }, gatewayCatalog: {}, fare: 2 };
}

class HarnessWorker {
  constructor() {
    this.received = [];
    this.handler = createCrossModeShareWorkerHandler(message => queueMicrotask(() => this.onmessage?.({ data: structuredClone(message) })));
    queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
  }
  postMessage(message) {
    const copy = structuredClone(message); // Functions cannot accidentally cross the worker boundary.
    this.received.push(copy);
    queueMicrotask(() => this.handler(copy));
  }
  terminate() { this.terminated = true; }
}

function evaluator(WorkerClass = HarnessWorker) {
  return createCrossModeShareEvaluator({ workerSource: 'worker', WorkerClass,
    createObjectURL: () => 'blob:audit-worker', revokeObjectURL: () => {},
  });
}

test('worker retains native fare totals and exact attribution for flat, route and distance fare groups', async () => {
  for (const group of [
    { id: 'g', fareSystem: 'flat', flatFare: 2, routeIds: ['r0'] },
    { id: 'g', fareSystem: 'route', routeFares: { r0: 3.1 }, routeIds: ['r0'] },
    { id: 'g', fareSystem: 'distance', boardingCharge: 1.5, perKmRate: 0.2, fareCap: 20, routeIds: ['r0'] },
  ]) {
    const input = fixture();
    let quoteCalls = 0;
    input.journeyFare = (stationRoutes, stationById) => {
      quoteCalls++;
      return quoteJourneyFare({ segments: fareSegmentsFromStationRoutes(stationRoutes, stationById), fareGroups: [group],
        routes: [{ id: 'r0' }], nativeFare: () => 7.35 });
    };
    const expected = calculateCrossTileModeShares(input);
    quoteCalls = 0;
    const client = evaluator();
    try {
      assert.deepEqual(await client.evaluate(input), expected);
      assert.equal(quoteCalls, 2, 'repeated outward journeys share one authoritative quote');
      assert.equal(client.diagnostics().workerEvaluations, 1);
      assert.equal(client.diagnostics().fallbackEvaluations, 0);
    } finally { client.dispose(); }
  }
});

test('missing and crashed workers safely preserve the original calculation and native fare callback', async () => {
  class BrokenWorker extends HarnessWorker { postMessage() { queueMicrotask(() => this.onerror({ message: 'worker crash' })); } }
  for (const WorkerClass of [null, BrokenWorker]) {
    const input = fixture();
    input.journeyFare = () => ({ total: 9.8, revenueByRoute: { r0: 9.8 } });
    const client = evaluator(WorkerClass);
    try {
      assert.deepEqual(await client.evaluate(input), calculateCrossTileModeShares(input));
      assert.equal(client.diagnostics().fallbackEvaluations, 1);
    } finally { client.dispose(); }
  }
});

test('disposal cancels pending worker evaluation without doing expensive fallback work', async () => {
  class SilentWorker extends HarnessWorker { postMessage() {} }
  const client = evaluator(SilentWorker);
  const pending = client.evaluate(fixture());
  client.dispose();
  await assert.rejects(pending, /disposed/);
  assert.equal(client.diagnostics().fallbackEvaluations, 0);
  await assert.rejects(client.evaluate(fixture()), /disposed/);
});

test('worker transport excludes display geometry and retains the original catalog for fallback', async () => {
  const input = fixture();
  const unused = () => { throw new Error('display geometry must not cross the worker boundary'); };
  const tile = { id: 'T0', bounds: [-1, -1, 1, 1], neighbors: [{ tileId: 'T1', displayOnly: 'unused' }] };
  Object.defineProperty(tile, 'boundaryGeometry', { enumerable: true, get: unused });
  Object.defineProperty(tile, 'boundaryLods', { enumerable: true, get: unused });
  const catalog = { tiles: [tile], displayOnly: 'unused' };
  input.tileCatalog = catalog;
  const expected = calculateCrossTileModeShares(input);
  let worker;
  class RecordingWorker extends HarnessWorker { constructor() { super(); worker = this; } }
  const client = evaluator(RecordingWorker);
  const fallback = evaluator(null);
  try {
    assert.deepEqual(await client.evaluate(input), expected);
    assert.equal(client.diagnostics().workerEvaluations, 1);
    assert.equal(client.diagnostics().fallbackEvaluations, 0);
    const transferred = worker.received.find(message => message.type === 'evaluate').input.tileCatalog;
    assert.deepEqual(transferred, { tiles: [{ id: 'T0', bounds: [-1, -1, 1, 1], neighbors: [{ tileId: 'T1' }] }] });
    assert.equal(input.tileCatalog, catalog);
    assert.equal(Object.getOwnPropertyDescriptor(tile, 'boundaryGeometry').get, unused);
    assert.deepEqual(await fallback.evaluate(input), expected);
  } finally { client.dispose(); fallback.dispose(); }
});

test('the production handler evaluates across a real worker boundary with host fare callbacks', async () => {
  const moduleUrl = new URL('../src/workers/cross-mode-share-worker.js', import.meta.url).href;
  class ThreadWorker {
    constructor() {
      this.thread = new NodeWorker(`
        const { parentPort } = await import('node:worker_threads');
        globalThis.self = { postMessage: value => parentPort.postMessage(value) };
        await import(${JSON.stringify(moduleUrl)});
        parentPort.on('message', data => self.onmessage({ data }));
      `, { eval: true });
      this.thread.on('message', data => this.onmessage?.({ data }));
      this.thread.on('error', error => this.onerror?.(error));
    }
    postMessage(message) { this.thread.postMessage(message); }
    terminate() { void this.thread.terminate(); }
  }
  const input = fixture();
  input.journeyFare = () => ({ total: 6.85, revenueByRoute: { r0: 6.85 } });
  const client = evaluator(ThreadWorker);
  try {
    assert.deepEqual(await client.evaluate(input), calculateCrossTileModeShares(input));
    assert.equal(client.diagnostics().workerEvaluations, 1);
    assert.equal(client.diagnostics().fallbackEvaluations, 0);
  } finally { client.dispose(); }
});
