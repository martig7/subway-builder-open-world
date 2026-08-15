import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkProjectionReconciler, createRouteScheduleReconciler, registerNetworkProjectionHooks } from '../src/network-projection-hooks.js';

test('projection hook registration observes constructed network state but not blueprints', () => {
  const registered = [];
  const hooks = new Proxy({}, {
    get: (_, name) => (callback) => { registered.push([name, callback]); return () => {}; },
  });
  const reasons = [];
  registerNetworkProjectionHooks(hooks, (reason) => reasons.push(reason));
  assert.deepEqual(registered.map(([name]) => name), [
    'onBlueprintPlaced', 'onTrackChange', 'onTrackBuilt',
    'onStationBuilt', 'onStationDeleted',
    'onRouteCreated', 'onRouteDeleted', 'onScheduleChange',
  ]);
  const callback = (name) => registered.find(([registeredName]) => registeredName === name)[1];
  callback('onBlueprintPlaced')([{ id: 'blueprint-track' }]);
  callback('onTrackChange')('add', 1);
  assert.deepEqual(reasons, [], 'the blueprint callback only suppresses its paired total-track callback');

  callback('onTrackChange')('delete', 0);
  callback('onTrackBuilt')([{ id: 'constructed-track' }]);
  for (const name of ['onStationBuilt', 'onStationDeleted', 'onRouteCreated', 'onRouteDeleted', 'onScheduleChange']) {
    callback(name)();
  }
  assert.deepEqual(reasons, [
    'track-change', 'track-built', 'station-built', 'station-deleted',
    'route-created', 'route-deleted', 'schedule-change',
  ]);
});

test('a blueprint-only track callback does not queue projection reconciliation', () => {
  const callbacks = new Map();
  const hooks = new Proxy({}, {
    get: (_, name) => (callback) => { callbacks.set(name, callback); return () => {}; },
  });
  const reasons = [];
  let constructedTrackIds = ['built-track'];
  registerNetworkProjectionHooks(
    hooks,
    (reason) => reasons.push(reason),
    null,
    { readConstructedTrackIds: () => constructedTrackIds },
  );

  // Subway Builder fires onTrackChange after adding a blueprint even though
  // its constructed-track inventory is unchanged.
  callbacks.get('onTrackChange')('add', 2);

  assert.deepEqual(reasons, []);

  constructedTrackIds = ['built-track', 'new-constructed-track'];
  callbacks.get('onTrackChange')('add', 3);
  assert.deepEqual(reasons, ['track-change']);
});

test('station blueprints and their undo stay non-structural when they split constructed track ids', () => {
  const callbacks = new Map();
  const hooks = new Proxy({}, {
    get: (_, name) => (callback) => { callbacks.set(name, callback); return () => {}; },
  });
  const reasons = [];
  let inventory = {
    constructedTrackIds: ['original-built-track'],
    blueprintTrackIds: [],
  };
  registerNetworkProjectionHooks(
    hooks,
    (reason) => reasons.push(reason),
    null,
    { readTrackInventory: () => inventory },
  );

  inventory = {
    constructedTrackIds: ['split-built-a', 'split-built-b'],
    blueprintTrackIds: ['blueprint-station-track'],
  };
  callbacks.get('onBlueprintPlaced')([{ id: 'blueprint-station-track' }]);
  callbacks.get('onTrackChange')('add', 3);

  inventory = {
    constructedTrackIds: ['original-built-track'],
    blueprintTrackIds: [],
  };
  callbacks.get('onTrackChange')('delete', 1);

  assert.deepEqual(reasons, [], 'placing and undoing a station blueprint must not reconcile the built network');
});

test('schedule hook forwards the native route and schedule payload to the narrow reconciler', () => {
  let registered;
  const hooks = { onScheduleChange(callback) { registered = callback; return () => {}; } };
  const generic = [];
  const schedules = [];
  registerNetworkProjectionHooks(
    hooks,
    (reason) => generic.push(reason),
    (...args) => schedules.push(args),
  );
  const next = { trainSchedule: { highDemand: 6 } };
  const previous = { trainSchedule: { highDemand: 5 } };

  registered('empire-line', next, previous);

  assert.deepEqual(generic, []);
  assert.deepEqual(schedules, [['empire-line', next, previous]]);
});

test('route schedule reconciler coalesces repeated frequency clicks per route', async () => {
  const commits = [];
  const reconciler = createRouteScheduleReconciler({
    delayMs: 0,
    runtime: { async reconcileActiveScheduleChanges(changes) { commits.push(changes); return { status: 'accepted' }; } },
  });
  reconciler.queue('empire-line', { trainSchedule: { highDemand: 5 } });
  reconciler.queue('empire-line', { trainSchedule: { highDemand: 6 } });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], [{
    routeId: 'empire-line',
    schedule: { trainSchedule: { highDemand: 6 } },
    previousSchedule: null,
  }]);
  reconciler.cancel();
});

test('projection reconciler coalesces a burst and reports rejected edits once', async () => {
  const calls = [];
  const warnings = [];
  const reconciler = createNetworkProjectionReconciler({
    delayMs: 0,
    runtime: { async reconcileActiveProjection(reason) { calls.push(reason); return { status: 'rejected', warning: { code: 'outside-window' } }; } },
    onRejected: (warning) => warnings.push(warning.code),
  });
  reconciler.queue('track-change');
  reconciler.queue('route-created');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['route-created']);
  assert.deepEqual(warnings, ['outside-window']);
  reconciler.queue('restore-hook-replay');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['route-created', 'restore-hook-replay']);
  assert.deepEqual(warnings, ['outside-window'], 'the same rejected action should notify once');
  reconciler.cancel();
});

test('projection reconciler waits for runtime boot before committing a schedule edit', async () => {
  let ready = false;
  const calls = [];
  const reconciler = createNetworkProjectionReconciler({
    delayMs: 1,
    isReady: () => ready,
    runtime: {
      async reconcileActiveProjection(reason) {
        if (!ready) throw new Error('WorldTileRuntime.boot must complete first');
        calls.push(reason);
        return { status: 'accepted' };
      },
    },
  });

  reconciler.queue('schedule-change');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, [], 'the edit must remain queued while boot is incomplete');
  ready = true;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['schedule-change']);
  reconciler.cancel();
});

test('an obsolete hot-reload reconciler drops queued work instead of retrying forever', async () => {
  let active = true;
  let ready = false;
  const calls = [];
  const reconciler = createNetworkProjectionReconciler({
    delayMs: 1,
    isActive: () => active,
    isReady: () => ready,
    runtime: { async reconcileActiveProjection(reason) { calls.push(reason); return { status: 'accepted' }; } },
  });

  reconciler.queue('schedule-change');
  await new Promise((resolve) => setTimeout(resolve, 5));
  active = false;
  ready = true;
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(calls, []);
  reconciler.cancel();
});
