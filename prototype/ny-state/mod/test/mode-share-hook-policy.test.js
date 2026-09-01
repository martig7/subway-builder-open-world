import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDailyModeShareInvalidation,
  registerCrossTileClockHooks,
  registerModeShareInvalidationHooks,
} from '../src/mode-share-hook-policy.js';

test('public hooks reserve blank route lifecycle for native save and tile handoff', () => {
  const registered = [];
  const hooks = new Proxy({}, {
    get: (_target, hookName) => (callback) => { registered.push([hookName, callback]); },
  });

  registerModeShareInvalidationHooks(hooks, {
    scheduleChanged() {}, fareChanged() {},
  });
  registerCrossTileClockHooks(hooks, { hourChanged() {}, dayChanged() {} });

  const hookNames = registered.map(([name]) => name);
  assert.ok(hookNames.includes('onScheduleChange'));
  assert.ok(hookNames.includes('onTicketPriceChanged'));
  assert.equal(hookNames.includes('onRouteCreated'), false);
  assert.equal(hookNames.includes('onRouteDeleted'), false);
  assert.equal(hookNames.includes('onStationBuilt'), false);
  assert.equal(hookNames.includes('onStationDeleted'), false);
  assert.equal(hookNames.includes('onTrackChange'), false);
  assert.equal(hookNames.includes('onTrainSpawned'), false);
  assert.equal(hookNames.includes('onTrainDeleted'), false);
  assert.ok(hookNames.includes('onHourChange'));
  assert.ok(hookNames.includes('onDayChange'));
});

test('route-edit bursts set one dirty flag that recalculates at midnight', async () => {
  const calls = [];
  const invalidation = createDailyModeShareInvalidation({
    recalculate: async (reason, day, dirtyReasons) => {
      calls.push({ reason, day, dirtyReasons });
      return { status: 'recalculated' };
    },
  });

  invalidation.markDirty('schedule-change');
  invalidation.markDirty('schedule-change');
  invalidation.markDirty('route-change');
  assert.deepEqual(calls, []);
  assert.equal(invalidation.isDirty(), true);
  await invalidation.flushAtMidnight(4);

  assert.deepEqual(calls, [{
    reason: 'midnight-change', day: 4,
    dirtyReasons: ['route-change', 'schedule-change'],
  }]);
  assert.equal(invalidation.isDirty(), false);
  await invalidation.flushAtMidnight(5);
  assert.equal(calls.length, 1);
});

test('a failed midnight recalculation leaves the dirty flag set for retry', async () => {
  let attempts = 0;
  const invalidation = createDailyModeShareInvalidation({
    recalculate: async () => (++attempts === 1 ? null : { status: 'recalculated' }),
  });

  invalidation.markDirty('schedule-change');
  await invalidation.flushAtMidnight(4);
  assert.equal(invalidation.isDirty(), true);
  await invalidation.flushAtMidnight(5);
  assert.equal(attempts, 2);
  assert.equal(invalidation.isDirty(), false);
});

test('an incomplete accounting handoff keeps the midnight dirty flag set for retry', async () => {
  let attempts = 0;
  const invalidation = createDailyModeShareInvalidation({
    recalculate: async () => ({
      status: 'recalculated',
      nativeFinanceProfile: attempts++ === 0
        ? { status: 'pending' }
        : { status: 'committed' },
    }),
  });

  invalidation.markDirty('route-change');
  await invalidation.flushAtMidnight(4);
  assert.equal(invalidation.isDirty(), true);
  await invalidation.flushAtMidnight(5);
  assert.equal(attempts, 2);
  assert.equal(invalidation.isDirty(), false);
});
