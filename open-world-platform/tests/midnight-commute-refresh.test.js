import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailyModeShareInvalidation } from '../src/runtime/mode-share-hook-policy.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('midnight starts active and cross work together, coalesces edits, and duplicate hooks await both', async () => {
  const active = deferred(), cross = deferred(), calls = [];
  const queue = createDailyModeShareInvalidation({
    refreshActiveTile: day => { calls.push(['active', day]); return active.promise; },
    recalculate: (...args) => { calls.push(args); return cross.promise; },
  });
  queue.markDirty('rail'); queue.markDirty('rail'); queue.markDirty('schedule');
  let finished = false, duplicateFinished = false;
  const run = queue.flushAtMidnight(3).then(value => { finished = true; return value; });
  const duplicate = queue.flushAtMidnight(3).then(() => { duplicateFinished = true; });
  await turn();
  assert.deepEqual(calls, [['active', 3], ['midnight-change', 3, ['rail', 'schedule']]]);
  cross.resolve({ status: 'recalculated' }); await turn();
  assert.equal(finished, false); assert.equal(duplicateFinished, false);
  active.resolve({ status: 'refreshed' }); await Promise.all([run, duplicate]);
  assert.equal(queue.isDirty(), false);
  assert.equal(queue.snapshot().lastRun.activeTileRefresh.status, 'refreshed');
  await queue.flushAtMidnight(4);
  assert.equal(calls.length, 2, 'no edits means no next-day work');
});

test('a failed active worker waits for cross work before rejecting and retains the batch', async () => {
  const active = deferred(), cross = deferred();
  const queue = createDailyModeShareInvalidation({ refreshActiveTile: () => active.promise, recalculate: () => cross.promise });
  queue.markDirty('rail');
  let finished = false;
  const run = queue.flushAtMidnight(1);
  const checked = assert.rejects(run, /active failed/).then(() => { finished = true; });
  active.reject(new Error('active failed')); await turn();
  assert.equal(finished, false);
  cross.resolve({ status: 'recalculated' }); await checked;
  assert.equal(queue.isDirty(), true);
});

test('stale active results, incomplete cross results and new edits survive midnight completion', async () => {
  for (const outcome of ['stale', 'pending', 'new-edit']) {
    const cross = deferred();
    const queue = createDailyModeShareInvalidation({
      refreshActiveTile: async () => ({ status: outcome === 'stale' ? 'stale' : 'refreshed' }),
      recalculate: () => cross.promise,
    });
    queue.markDirty('rail'); const run = queue.flushAtMidnight(1);
    if (outcome === 'new-edit') queue.markDirty('later-rail');
    cross.resolve({ status: 'recalculated', nativeFinanceProfile: { status: outcome === 'pending' ? 'pending' : 'ready' } });
    await run; assert.equal(queue.isDirty(), true, outcome);
  }
});

test('a late duplicate day hook cannot consume edits queued during the completed batch', async () => {
  const cross = deferred(); let calls = 0;
  const queue = createDailyModeShareInvalidation({
    refreshActiveTile: async () => ({ status: 'refreshed' }),
    recalculate: () => { calls++; return cross.promise; },
  });
  queue.markDirty('rail'); const first = queue.flushAtMidnight(1);
  queue.markDirty('later-rail'); cross.resolve({ status: 'recalculated' }); await first;
  await queue.flushAtMidnight(1);
  assert.equal(calls, 1);
  assert.equal(queue.isDirty(), true);
  await queue.flushAtMidnight(2);
  assert.equal(calls, 2); assert.equal(queue.isDirty(), false);
});
