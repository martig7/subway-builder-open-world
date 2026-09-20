import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sharedNativeDemandEvaluator } from '../src/runtime/embedded-tile-package-adapter.js';

const evaluatorUrl = new URL('../src/runtime/embedded-tile-package-adapter.js', import.meta.url).href;
const queueUrl = new URL('../src/runtime/routing-job-queue.js', import.meta.url).href;

test('an idle evaluator releases successful assignment results while its owner remains alive', () => {
  // An isolated diagnostic process supplies GC; no production or game GC hook
  // is required. Keep the evaluator alive, but release all caller-owned results.
  const output = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createOffMainThreadNativeDemandEvaluator } from ${JSON.stringify(evaluatorUrl)};
    import { runRoutingJob } from ${JSON.stringify(queueUrl)};
    class Worker {
      set onmessage(handler) {
        this.handler = handler;
        queueMicrotask(() => handler({ data: { type: 'ready' } }));
      }
      postMessage(message) {
        queueMicrotask(() => {
          this.handler({ data: { id: message.id, assignments: [{ id: 'pop-1',
            commutes: { homeToWork: { transitPaths: [{ segments: [{ routeId: 'r', stationIds: ['s1', 's2'] }] }] } } }] } });
          this.handler({ data: { id: message.id, ok: true, value: { profile: { evaluatedPops: 1 } } } });
        });
      }
      terminate() {}
    }
    const make = () => createOffMainThreadNativeDemandEvaluator({ WorkerClass: Worker,
      BlobClass: class {}, workerSource: 'fixture', createObjectURL: () => 'blob:fixture',
      revokeObjectURL() {}, readMemory: () => null });
    async function collect() {
      for (let i = 0; i < 8; i++) { await new Promise(setImmediate); globalThis.gc(); }
    }
    const results = [];
    for (const disposeBeforeCollection of [false, true]) {
      const evaluator = make();
      let response, assignment;
      await (async () => {
        const result = await evaluator.evaluate(new Uint8Array([1]), { includeAssignments: true }, { cacheMode: 'assignments' });
        assert.equal(result.assignments.length, 1);
        response = new WeakRef(result);
        assignment = new WeakRef(result.assignments[0]);
      })();
      // Isolate the evaluator's own serial tail from the shared routing queue.
      await runRoutingJob(() => undefined);
      if (disposeBeforeCollection) evaluator.dispose();
      await collect();
      const diagnostics = evaluator.snapshot();
      assert.equal(diagnostics.workerAlive, false);
      assert.equal(diagnostics.active, 0);
      assert.equal(diagnostics.queued, 0);
      results.push({ disposeBeforeCollection, responseRetained: Boolean(response.deref()),
        assignmentRetained: Boolean(assignment.deref()), completed: diagnostics.completed });
      evaluator.dispose();
    }
    console.log(JSON.stringify(results));
  `], { encoding: 'utf8', timeout: 15000 });
  const results = JSON.parse(output.trim());
  assert.deepEqual(results, [false, true].map(disposeBeforeCollection => ({
    disposeBeforeCollection, responseRetained: false, assignmentRetained: false, completed: 1,
  })), 'worker termination/disposal must not leave the last response pinned by the evaluator queue');
});

test('shared evaluator replaces the previous generation rather than retaining its old queue closure', () => {
  const key = '__openWorldNativeDemandEvaluator';
  const previous = globalThis[key];
  let disposed = 0;
  const oldEvaluator = { dispose() { disposed++; } };
  globalThis[key] = { version: 3, workerSource: 'fixture-source', evaluator: oldEvaluator };
  try {
    const current = sharedNativeDemandEvaluator('fixture-source');
    assert.notEqual(current, oldEvaluator);
    assert.equal(disposed, 1);
    assert.equal(globalThis[key].version, 4);
    assert.equal(sharedNativeDemandEvaluator('fixture-source'), current, 'current generation remains shared');
  } finally {
    if (globalThis[key]?.evaluator !== oldEvaluator) globalThis[key]?.evaluator?.dispose();
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
});
