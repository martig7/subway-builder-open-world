import test from 'node:test';
import assert from 'node:assert/strict';
import { registerModeShareInvalidationHooks } from '../../../../open-world-platform/src/runtime/mode-share-hook-policy.js';

test('public invalidation hooks exclude construction and blank route lifecycle', () => {
  const registered = [];
  const hooks = new Proxy({}, {
    get: (_, name) => (callback) => {
      registered.push([name, callback]);
      return () => {};
    },
  });

  registerModeShareInvalidationHooks(hooks, {
    scheduleChanged() {},
    fareChanged() {},
  });

  assert.deepEqual(registered.map(([name]) => name), [
    'onScheduleChange',
    'onTicketPriceChanged',
    'onFareGroupsChanged',
  ]);
});
