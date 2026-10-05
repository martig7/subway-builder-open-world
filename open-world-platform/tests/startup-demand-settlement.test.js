import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartupDemandSettlement, nativeDemandMemoryDeferral } from '../src/runtime/startup-demand-settlement.js';
import { assertNativeDemandMemoryBudget } from '../src/runtime/embedded-tile-package-adapter.js';

const memoryFailure = { tileId: 'T0', errorName: 'NativeDemandMemoryPressureError', error: 'Memory admission deferred' };
function fixture(options) {
  let now = 0, sequence = 0, peakTimers = 0;
  const scheduled = [], timers = new Map(), changes = [], errors = [];
  const controller = createStartupDemandSettlement({ isCurrent: () => true, ...options,
    schedule: callback => scheduled.push(callback), now: () => now,
    setTimer(callback, delay) {
      const id = ++sequence; timers.set(id, { callback, delay, at: now + delay });
      peakTimers = Math.max(peakTimers, timers.size); return id;
    },
    clearTimer: id => timers.delete(id),
    onChange: state => changes.push(state), onError: error => errors.push(error),
  });
  const drain = async () => {
    while (scheduled.length) scheduled.shift()();
    await new Promise(setImmediate);
  };
  return { controller, timers, changes, errors, drain, now: () => now, peakTimers: () => peakTimers,
    async advance() {
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(id); now = timer.at; timer.callback(); await drain(); return timer.delay;
    },
  };
}

test('late memory recovery keeps one timer, caps backoff at sixty seconds, and avoids rebuilding while blocked', async () => {
  let allowed = false, runs = 0, ready = 0;
  const admission = () => assertNativeDemandMemoryBudget({ at: f.now(), workersAvailable: true,
    allIsolatesAllocatedBytes: (allowed ? 1 : 3.5) * 1024 ** 3 }, { now: f.now() });
  const f = fixture({ admit: admission, run: async () => { runs++; admission(); return { status: 'cached' }; },
    onReady: () => ready++ });
  await f.drain();
  assert.equal(f.controller.snapshot().status, 'waiting-for-memory');
  for (const delay of [1000, 2000, 5000, 10_000, 30_000, 60_000]) assert.equal(await f.advance(), delay);
  assert.ok(f.now() > 60_000);
  assert.equal(runs, 1, 'failed retry admission must not rebuild the network');
  allowed = true;
  assert.equal(await f.advance(), 60_000);
  await f.controller.promise;
  assert.equal(runs, 2); assert.equal(ready, 1);
  assert.equal(f.controller.snapshot().status, 'ready');
  assert.equal(f.controller.snapshot().nextRetryAt, null);
  assert.equal(f.timers.size, 0); assert.equal(f.peakTimers(), 1);
});

test('all-memory finance failures retry and then recover', async () => {
  let attempts = 0;
  const f = fixture({ run: async () => ++attempts === 1
    ? { status: 'no-cross-demand', nativeFinanceProfile: { status: 'pending', failed: [memoryFailure], unavailable: [] } }
    : { status: 'cached' } });
  await f.drain(); assert.equal(f.timers.size, 1);
  await f.advance(); await f.controller.promise;
  assert.equal(attempts, 2); assert.equal(f.controller.snapshot().status, 'ready');
});

for (const name of ['Error', 'CheckpointReadError', 'StorageWriteError']) test(`startup never retries a nonmemory error (${name})`, async () => {
  let attempts = 0;
  const f = fixture({ run: async () => { attempts++; throw Object.assign(new Error('Durable checkpoint failed'), { name }); } });
  await f.drain(); await f.controller.promise;
  assert.equal(attempts, 1); assert.equal(f.timers.size, 0);
  assert.equal(f.controller.snapshot().status, 'failed'); assert.equal(f.errors.length, 1);
});

for (const profile of [
  { status: 'pending', failed: [memoryFailure, { tileId: 'T1', errorName: 'Error', error: 'Package invalid' }], unavailable: [] },
  { status: 'pending', failed: [memoryFailure], unavailable: ['T1'] },
  { status: 'pending', failed: [], unavailable: [] },
]) test(`incomplete or mixed finance failures do not retry (${JSON.stringify(profile)})`, async () => {
  const result = { status: 'recalculated', nativeFinanceProfile: profile };
  assert.equal(nativeDemandMemoryDeferral(result), null);
  const f = fixture({ run: async () => result });
  await f.drain(); await f.controller.promise;
  assert.equal(f.controller.snapshot().status, 'failed'); assert.equal(f.timers.size, 0);
});

for (const cancel of [false, true]) test(`an obsolete startup retires its memory retry (explicit cancel=${cancel})`, async () => {
  let current = true, attempts = 0;
  const f = fixture({ isCurrent: () => current, run: async () => {
    attempts++; throw Object.assign(new Error('Memory admission deferred'), { name: 'NativeDemandMemoryPressureError' });
  } });
  await f.drain(); current = false;
  if (cancel) f.controller.cancel(); else await f.advance();
  await f.controller.promise;
  assert.equal(attempts, 1); assert.equal(f.controller.snapshot().status, 'cancelled');
  assert.equal(f.timers.size, 0);
});
