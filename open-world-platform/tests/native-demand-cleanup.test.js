import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createNetworkProfile, createBoundedCrossTileRoutingCache } from '../src/runtime/cross-tile-mode-choice.js';
import { nativeDemandEvaluationBatches } from '../src/runtime/off-tile-native-demand.js';
import { runNativeDemandWorkerJob } from '../src/runtime/native-demand-worker-job.js';

// Observe real internally owned caches without adding a production test hook.
// Only the imported factory binding changes; evaluator and cache bodies remain
// the production implementations, and the wrapper records public clear calls.
const sourceUrl = new URL('../src/runtime/off-tile-native-demand.js', import.meta.url);
let source = await readFile(sourceUrl, 'utf8');
const factoryImport = 'createBoundedCrossTileRoutingCache, createRoutingSnapshot';
assert.ok(source.includes(factoryImport));
source = source.replace(factoryImport, 'createBoundedCrossTileRoutingCache as actualCreateCache, createRoutingSnapshot')
  .replace(/from '(\.[^']+)'/g, (_, relative) => `from '${new URL(relative, sourceUrl).href}'`);
source += `
export const observedCaches = [];
function createBoundedCrossTileRoutingCache(options) {
  const cache = actualCreateCache(options);
  const observed = { cache, clears: 0 };
  const clear = cache.clear;
  cache.clear = () => { observed.clears++; clear(); };
  observedCaches.push(observed);
  return cache;
}
`;
const observed = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function fixture() {
  return { tileId: 'cleanup', worldId: 'cleanup-world', batchSize: 1, includeAssignments: true,
    farePolicy: { fare: 2.5 }, networkProfile: createNetworkProfile({ tileId: 'cleanup',
      stations: [0, 1].map(i => ({ id: `s${i}`, coords: [i * 0.04, 0], stNodeIds: [`n${i}`], buildType: 'constructed' })),
      routes: [{ id: 'r', idealTrainCount: 2, stNodes: [{ id: 'n0' }, { id: 'n1' }],
        stComboTimings: [{ stNodeIndex: 0, arrivalTime: 0, departureTime: 20 },
          { stNodeIndex: 1, arrivalTime: 400, departureTime: 420 }] }],
    }), demand: { points: [{ id: 'h', location: [0, 0] }, { id: 'w', location: [0.04, 0] }],
      pops: Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, size: 100 + i,
        residenceId: 'h', jobId: 'w', drivingSeconds: 1800, drivingDistance: 10000,
        homeDepartureTime: 25000, workDepartureTime: 64000 })) },
  };
}
function assertReleased(cache) {
  const diagnostics = cache.diagnostics();
  assert.equal(diagnostics.kernel.linearMemoryBytes, 0);
  assert.equal(diagnostics.kernel.retainedEdges, 0);
  assert.equal(diagnostics.modeChoice.cacheBytes, 0);
  assert.equal(diagnostics.modeChoice.cacheEntries, 0);
}

test('generator releases its owned cache on completion and early consumer return', () => {
  for (const stopEarly of [false, true]) {
    const batches = observed.nativeDemandEvaluationBatches(fixture());
    assert.equal(batches.next().done, false);
    const tracked = observed.observedCaches.at(-1);
    assert.equal(tracked.clears, 0);
    assert.ok(tracked.cache.diagnostics().kernel.linearMemoryBytes > 0);
    assert.ok(tracked.cache.diagnostics().modeChoice.cacheBytes > 0);
    if (stopEarly) batches.return();
    else for (const batch of batches) assert.equal(batch.status, 'evaluated');
    assert.equal(tracked.clears, 1);
    assertReleased(tracked.cache);
  }
});

test('generator releases its owned cache when evaluation throws', () => {
  const batches = observed.nativeDemandEvaluationBatches({ ...fixture(), onBatch() { throw new Error('stop batch'); } });
  assert.throws(() => batches.next(), /stop batch/);
  const tracked = observed.observedCaches.at(-1);
  assert.equal(tracked.clears, 1);
  assertReleased(tracked.cache);
});

test('generator leaves a borrowed routing cache available to its owner after early return', () => {
  const cache = createBoundedCrossTileRoutingCache();
  try {
    const batches = nativeDemandEvaluationBatches({ ...fixture(), routingCache: cache });
    batches.next();
    const before = cache.diagnostics();
    batches.return();
    assert.equal(cache.diagnostics().kernel.linearMemoryBytes, before.kernel.linearMemoryBytes);
    assert.ok(cache.diagnostics().modeChoice.cacheBytes > 0);
  } finally { cache.clear(); }
  assertReleased(cache);
});

test('asynchronous worker job releases its explicit cache when a later batch fails', async () => {
  const { demand, ...input } = fixture();
  let cache;
  await assert.rejects(runNativeDemandWorkerJob({
    input, bytes: new TextEncoder().encode(JSON.stringify(demand)),
  }, { evaluateBatches: function* (request) {
    cache = request.routingCache;
    for (const batch of nativeDemandEvaluationBatches(request)) {
      yield batch;
      throw new Error('later batch failed');
    }
  } }), /later batch failed/);
  assertReleased(cache);
});
