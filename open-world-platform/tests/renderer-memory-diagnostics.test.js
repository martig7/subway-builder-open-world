import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installRendererMemoryDiagnostics,
  RENDERER_MEMORY_DIAGNOSTICS_KEY,
  RENDERER_MEMORY_DIAGNOSTICS_VERSION,
} from '../src/runtime/renderer-memory-diagnostics.js';

const MiB = 1024 * 1024;

function fixture(options = {}) {
  let time = 0;
  let heap = { usedJSHeapSize: 100 * MiB, totalJSHeapSize: 200 * MiB, jsHeapSizeLimit: 1000 * MiB };
  let nextTimer = 1;
  const timers = new Map();
  const root = {};
  const dependencies = {
    root,
    now: () => time,
    wallNow: () => 100_000 + time,
    readMemory: () => heap,
    readV8Memory: () => ({ version: 'renderer-v8-heap-v1', status: 'available', targetId: 'renderer-1',
      at: 100_000 + time, usedBytes: heap?.usedJSHeapSize, totalBytes: heap?.totalJSHeapSize, limitBytes: heap?.jsHeapSizeLimit }),
    setIntervalFn: callback => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearIntervalFn: id => { timers.delete(id); },
  };
  const monitor = installRendererMemoryDiagnostics({ ...dependencies, ...options });
  return {
    monitor, timers, root, dependencies,
    setHeap: value => { heap = value; },
    advance(ms, usedMiB) {
      time += ms;
      if (usedMiB != null) heap = { ...heap, usedJSHeapSize: usedMiB * MiB };
      for (const callback of [...timers.values()]) callback();
    },
  };
}

test('reports headroom, sampled high-water and the save boundary around a heap spike', () => {
  const f = fixture();
  f.monitor.recordActivity('native-save.serialize.start', { bytes: 100, tileId: 'NEC_CP00_RP00' });
  f.advance(1_000, 920);
  const report = f.monitor.snapshot();
  assert.equal(report.latest.usedBytes, 920 * MiB);
  assert.equal(report.latest.totalBytes, 200 * MiB);
  assert.equal(report.latest.limitBytes, 1000 * MiB);
  assert.equal(report.latest.headroomBytes, 80 * MiB);
  assert.equal(report.latest.usageRatio, 0.92);
  assert.equal(report.latest.pressure, 'high');
  assert.equal(report.highWater.usedBytes, 920 * MiB);
  const spike = report.events.find(event => event.kind === 'heap-growth');
  assert.equal(spike.deltaBytes, 820 * MiB);
  assert.equal(spike.activity, 'native-save.serialize.start');
  assert.equal(spike.activityAgeMs, 1000);
  assert.equal(report.events.filter(event => event.kind === 'pressure-change').length, 1);
  f.monitor.dispose();
});

test('captures a 30 second observation gap and labels a heap drop as inferred GC', () => {
  const f = fixture();
  f.monitor.recordActivity('native-save.start');
  f.advance(30_000, 850);
  f.monitor.recordActivity('native-save.end');
  f.advance(1_000, 500);
  const report = f.monitor.snapshot();
  assert.equal(report.summary.maxObservationGapMs, 30_000);
  assert.equal(report.events.find(event => event.kind === 'sampling-gap').gapMs, 30_000);
  const drop = report.events.find(event => event.kind === 'heap-drop-inferred-gc');
  assert.equal(drop.deltaBytes, -350 * MiB);
  assert.equal(drop.activity, 'native-save.end');
  assert.equal(report.summary.inferredGcDrops, 1);
  assert.equal(report.highWater.usedBytes, 850 * MiB);
  assert.match(report.interpretation, /not a GC notification/);
  assert.match(report.interpretation, /GPU/);
  f.monitor.dispose();
});

test('history stays bounded through sustained gameplay and ignores retained object details', () => {
  const f = fixture({ sampleLimit: 8, eventLimit: 5, activityLimit: 4 });
  const gameObject = { trains: new Array(1000).fill({}) };
  Object.defineProperty(gameObject, 'toString', { value: () => { throw new Error('must not stringify game objects'); } });
  for (let index = 0; index < 200; index++) {
    f.monitor.recordActivity('map.move.start', {
      tileId: 'x'.repeat(1000), bytes: gameObject, payload: gameObject, reason: gameObject, durationMs: 42,
    });
    f.advance(1000, index % 2 ? 100 : 900);
  }
  const report = f.monitor.snapshot();
  assert.equal(report.samples.length, 8);
  assert.equal(report.events.length, 5);
  assert.equal(report.activities.length, 4);
  assert.equal(report.summary.samples, 401);
  assert.equal(report.summary.activities, 200);
  assert.equal(report.activities[0].tileId.length, 96);
  assert.equal(report.activities[0].durationMs, 42);
  assert.equal('payload' in report.activities[0], false);
  assert.equal('bytes' in report.activities[0], false);
  assert.equal('reason' in report.activities[0], false);
  report.samples[0].usedBytes = -1;
  report.activities[0].tileId = 'mutated';
  report.highWater.usedBytes = -1;
  assert.notEqual(f.monitor.snapshot().samples[0].usedBytes, -1);
  assert.notEqual(f.monitor.snapshot().activities[0].tileId, 'mutated');
  assert.notEqual(f.monitor.snapshot().highWater.usedBytes, -1);
  f.monitor.dispose();
});

test('missing or invalid heap APIs stay unavailable without invented headroom or GC events', () => {
  const f = fixture();
  f.setHeap(undefined);
  f.advance(1000);
  let report = f.monitor.snapshot();
  assert.equal(report.latest.available, false);
  assert.equal(report.latest.usedBytes, null);
  assert.equal(report.latest.headroomBytes, null);
  assert.equal(report.latest.deltaBytes, null);
  assert.equal(report.latest.pressure, 'unavailable');
  f.setHeap({ usedJSHeapSize: 900 * MiB, totalJSHeapSize: NaN, jsHeapSizeLimit: 0 });
  f.advance(1000);
  report = f.monitor.snapshot();
  assert.equal(report.latest.usedBytes, null);
  assert.equal(report.latest.browserUsedBytes, 900 * MiB);
  assert.equal(report.latest.totalBytes, null);
  assert.equal(report.latest.headroomBytes, null);
  assert.equal(report.latest.usageRatio, null);
  assert.equal(report.latest.deltaBytes, null);
  assert.equal(report.events.some(event => event.kind === 'heap-drop-inferred-gc'), false);
  f.monitor.dispose();
});

test('stop and reset release history, restart once, and disposal leaves no sampler', () => {
  const f = fixture();
  f.monitor.start();
  assert.equal(f.timers.size, 1);
  f.monitor.stop();
  assert.equal(f.timers.size, 0);
  const before = f.monitor.snapshot().summary.samples;
  f.advance(1000, 800);
  assert.equal(f.monitor.recordActivity('stopped'), null);
  assert.equal(f.monitor.snapshot().summary.samples, before);
  f.monitor.start();
  f.monitor.reset();
  const report = f.monitor.snapshot();
  assert.equal(report.summary.samples, 1);
  assert.equal(report.samples[0].id, 1);
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].source, 'reset');
  assert.equal(report.events[0].id, 1);
  assert.deepEqual(report.activities, []);
  assert.equal(f.timers.size, 1);
  f.monitor.dispose();
  f.monitor.start();
  assert.equal(f.timers.size, 0);
  assert.equal(f.root[RENDERER_MEMORY_DIAGNOSTICS_KEY], undefined);
});

test('hot reload disposes the previous generation and replaces the global controller and API closures', () => {
  const f = fixture();
  const oldController = f.root[RENDERER_MEMORY_DIAGNOSTICS_KEY];
  const oldPrint = f.root.__printOpenWorldRendererMemoryDiagnostic;
  let previousDisposed = false;
  f.root[RENDERER_MEMORY_DIAGNOSTICS_KEY] = {
    version: 'renderer-memory-diagnostics-previous',
    dispose() { previousDisposed = true; oldController.dispose(); },
  };
  const next = installRendererMemoryDiagnostics(f.dependencies);
  assert.equal(previousDisposed, true);
  assert.equal(f.timers.size, 1);
  assert.equal(next.version, RENDERER_MEMORY_DIAGNOSTICS_VERSION);
  assert.notEqual(f.root[RENDERER_MEMORY_DIAGNOSTICS_KEY], oldController);
  assert.notEqual(f.root.__printOpenWorldRendererMemoryDiagnostic, oldPrint);
  oldController.dispose();
  assert.equal(f.root[RENDERER_MEMORY_DIAGNOSTICS_KEY], next);
  assert.equal(typeof f.root.__printOpenWorldRendererMemoryDiagnostic, 'function');
  next.dispose();
  assert.equal(f.timers.size, 0);
});

test('a throwing heap getter does not break sampling or the caller operation', () => {
  const f = fixture({ readMemory: () => { throw new Error('API unavailable'); }, readV8Memory: () => { throw new Error('offline'); } });
  assert.doesNotThrow(() => f.monitor.recordActivity('native-save.start'));
  f.advance(1000);
  const report = f.monitor.snapshot();
  assert.equal(report.latest.available, false);
  assert.equal(report.summary.unavailableSamples, 3);
  f.monitor.dispose();
});

test('compact snapshots omit sample history and return each event/activity only after the supplied cursor', () => {
  const f = fixture();
  f.monitor.recordActivity('native-save.start');
  f.advance(1000, 900);
  const first = f.monitor.snapshot({ includeHistory: false });
  assert.equal('samples' in first, false);
  assert.equal(first.activities.length, 1);
  assert.ok(first.events.length > 0);
  const cursor = { includeHistory: false, captureId: first.captureId,
    afterSampleId: first.latest.id, afterActivityId: first.summary.activities };
  f.advance(1000);
  assert.deepEqual(f.monitor.snapshot(cursor).events, []);
  assert.deepEqual(f.monitor.snapshot(cursor).activities, []);
  f.monitor.reset();
  f.monitor.recordActivity('native-save.end');
  const reset = f.monitor.snapshot(cursor);
  assert.notEqual(reset.captureId, first.captureId);
  assert.equal(reset.activities.length, 1);
  f.monitor.dispose();
});

test('sample callback failures and mutation cannot corrupt history or escape into gameplay', () => {
  const observed = [];
  const f = fixture({ onSample: sample => {
    observed.push(sample.usedBytes);
    sample.usedBytes = -1;
    throw new Error('pressure policy failed');
  } });
  assert.doesNotThrow(() => f.advance(1000, 900));
  assert.deepEqual(observed, [100 * MiB, 900 * MiB]);
  assert.equal(f.monitor.snapshot().latest.usedBytes, 900 * MiB);
  f.monitor.dispose();
});

test('the cached 116 MB crash reading is an estimate, never usable headroom', () => {
  const root = { performance: { memory: {
    usedJSHeapSize: 116_000_000, totalJSHeapSize: 157_000_000, jsHeapSizeLimit: 3_760_000_000,
  } } };
  const monitor = installRendererMemoryDiagnostics({ root, setIntervalFn: () => 1, clearIntervalFn() {} });
  const sample = monitor.snapshot().latest;
  assert.equal(sample.pressure, 'unavailable');
  assert.equal(sample.measurementMode, 'estimated');
  assert.equal(sample.headroomBytes, null);
  assert.equal(monitor.snapshot().highWater, null);
  monitor.dispose();
});

test('V8 readings exclude buffers and expire instead of becoming safe stale readings', () => {
  const f = fixture({ readV8Memory: null });
  f.monitor.acceptHeapMeasurement({ version: 'renderer-v8-heap-v1', status: 'available', targetId: 'game', at: 100_000,
    usedBytes: 600 * MiB, totalBytes: 700 * MiB, limitBytes: 1000 * MiB, backingStorageBytes: 500 * MiB, embedderBytes: 20 * MiB });
  f.advance(1000);
  let sample = f.monitor.snapshot().latest;
  assert.equal(sample.usedBytes, 600 * MiB);
  assert.equal(sample.headroomBytes, 400 * MiB);
  assert.equal(sample.backingStorageBytes, 500 * MiB);
  assert.equal(sample.measurementAgeMs, 1000);
  assert.equal(sample.measurementMode, 'v8-inspector');
  f.advance(3000);
  sample = f.monitor.snapshot().latest;
  assert.equal(sample.headroomBytes, null);
  assert.equal(sample.pressure, 'unavailable');
  f.monitor.acceptHeapMeasurement({ version: 'renderer-v8-heap-v1', status: 'unresponsive', at: 104_000,
    usedBytes: 600 * MiB, limitBytes: 1000 * MiB });
  assert.equal(f.monitor.sample().headroomBytes, null);
  f.monitor.dispose();
});

test('a new page rejects a previous renderer reading and replacement clears pressure baselines', () => {
  const f = fixture({ readV8Memory: null });
  f.root.performance = { timeOrigin: 99_900 };
  f.monitor.acceptHeapMeasurement({ version: 'renderer-v8-heap-v1', status: 'available', targetId: 'old', at: 99_000,
    usedBytes: 900 * MiB, limitBytes: 1000 * MiB });
  assert.equal(f.monitor.sample().headroomBytes, null);
  f.monitor.acceptHeapMeasurement({ version: 'renderer-v8-heap-v1', status: 'available', targetId: 'new', at: 100_000,
    usedBytes: 100 * MiB, limitBytes: 1000 * MiB });
  assert.equal(f.monitor.sample().deltaBytes, null);
  f.monitor.dispose();
});

test('measurement freshness includes time spent waiting for the debugger response', () => {
  const f = fixture({ readV8Memory: null });
  f.monitor.acceptHeapMeasurement({ version: 'renderer-v8-heap-v1', status: 'available', targetId: 'game', at: 100_000,
    requestMs: 2500, usedBytes: 600 * MiB, limitBytes: 1000 * MiB });
  f.advance(1000);
  assert.equal(f.monitor.snapshot().latest.measurementAgeMs, 3500);
  assert.equal(f.monitor.snapshot().latest.headroomBytes, null);
  f.monitor.dispose();
});

test('worker allocation totals remain separate from main headroom and expire independently', () => {
  const f = fixture({ readV8Memory: null });
  const main = { version: 'renderer-v8-heap-v1', status: 'available', targetId: 'game', isolateId: 'main', at: 100_000,
    usedBytes: 600 * MiB, totalBytes: 700 * MiB, limitBytes: 1000 * MiB };
  const workers = { version: 'worker-v8-heap-v2', status: 'available', at: 100_000, requestMs: 10,
    workerCount: 2, usedBytes: 200 * MiB, totalBytes: 250 * MiB, backingStorageBytes: 500 * MiB };
  f.monitor.acceptHeapMeasurement({ ...main, workers });
  let sample = f.monitor.sample();
  assert.equal(sample.allIsolatesUsedBytes, 800 * MiB);
  assert.equal(sample.allIsolatesAllocatedBytes, 950 * MiB);
  assert.equal(sample.headroomBytes, 400 * MiB);
  assert.equal(sample.workerBackingStorageBytes, 500 * MiB);
  f.advance(3500);
  f.monitor.acceptHeapMeasurement({ ...main, at: 103_500, workers });
  sample = f.monitor.sample();
  assert.equal(sample.available, true);
  assert.equal(sample.workersAvailable, false);
  assert.equal(sample.allIsolatesAllocatedBytes, null);
  f.monitor.acceptHeapMeasurement({ ...main, at: 103_500, isolateId: 'replacement', workers: { ...workers, at: 103_500, status: 'partial' } });
  sample = f.monitor.sample();
  assert.equal(sample.deltaBytes, null);
  assert.equal(sample.allIsolatesAllocatedBytes, null);
  f.monitor.dispose();
});
