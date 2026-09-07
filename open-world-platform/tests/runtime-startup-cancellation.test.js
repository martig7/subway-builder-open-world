import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { startOpenWorld } from '../src/runtime/start-open-world.js';
import { WorldTileRuntime } from '../src/runtime/world-tile-runtime.js';
import { WorldIdentityResolver } from '../src/runtime/world-identity.js';
import { createSubwayBuilderHostState } from '../testkit/subway-builder-host.js';
import { GeographicContextOverlayController } from '../src/runtime/ui/geographic-context-overlay.js';
import { HashCityNavigationAdapter } from '../src/runtime/adapters/hash-city-navigation-adapter.js';
import definition from '../../worlds/tokyo-kanagawa/world.json' with { type: 'json' };
import catalogSource from '../../worlds/tokyo-kanagawa/geography/tile-views.json' with { type: 'json' };

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness(run) {
  const savedGlobals = new Map(Object.getOwnPropertyNames(globalThis).filter(key => key.startsWith('__')
    || ['fetch', 'sessionStorage', 'requestIdleCallback'].includes(key)).map(key => [key, globalThis[key]]));
  const savedConsole = { debug: console.debug, info: console.info, log: console.log, warn: console.warn, error: console.error };
  const hooks = new Map(); const idle = []; const errors = []; const ui = []; const unsubscribed = [];
  const state = createSubwayBuilderHostState({ cityCode: 'JP_TOKYO_MAINLAND', gameSessionId: 'session-A', saveName: 'save-A', money: 1_000_000, transitCost: 2.5,
    routeFinancials: { byRoute: {}, lastHourTimestamp: 0, currentHour: {} },
    financialHistory: { entries: [], lastHourTimestamp: 0, currentHourRevenue: 0, currentHourExpenses: 0, currentHourExpenseCategories: {} },
    generateSave() { return { name: state.saveName, cityCode: state.cityCode, gameSessionId: state.gameSessionId, viewport: {}, data: {
      cityCode: state.cityCode, elapsedSeconds: 0, money: state.money, routes: [], stations: [], stNodes: [], trains: [], tracks: [], trackGroups: [], signals: [], stationGroups: [],
      routeFinancials: structuredClone(state.routeFinancials), financialHistory: structuredClone(state.financialHistory),
    } }; }, loadSave() {},
  });
  const api = { version: '1.0.0', registerCity() {}, cities: { setCityDataFiles() {} }, map: { setTileURLOverride() {}, setDefaultLayerVisibility() {} },
    utils: { getCities: () => [], getCityCode: () => state.cityCode, getMap: () => null, getPathfindingRules: () => ({}), loadCityData: async () => ({ points: [], pops: [] }),
      React: { createElement: () => null }, components: { Button: () => null } },
    trains: { getTrainTypes: () => [] }, gameState: { getGameSessionId: () => state.gameSessionId, getSaveName: () => state.saveName, getCurrentDay: () => 1,
      getStations: () => state.stations, getRoutes: () => state.routes, getTrains: () => state.trains },
    hooks: new Proxy({}, { get: (_target, key) => callback => {
      hooks.set(key, callback);
      return () => { unsubscribed.push(key); if (hooks.get(key) === callback) hooks.delete(key); };
    } }),
    ui: { addToolbarPanel: panel => { ui.push(panel); return panel; }, unregisterComponent() {}, showNotification: (...args) => ui.push(args) },
  };
  globalThis.__subwayBuilder_storeCallbacks__ = { getState: () => state, setMoney() {}, setTicketCost() {} };
  globalThis.fetch = undefined;
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.requestIdleCallback = (callback, options) => { if (options?.timeout === 1000) idle.push(callback); return 1; };
  console.debug = console.info = console.log = console.warn = () => {};
  console.error = (...args) => errors.push(args);
  const controllers = [];
  const restart = () => {
    const controller = startOpenWorld({ definition, catalogSource, subwayBuilderHost: api, artifacts: {
      commuteCatalog: { buildHash: 'startup-cancellation', buckets: [], gateways: [] },
      crossDemandGzipBase64: gzipSync(JSON.stringify({ schemaVersion: 1, points: [], pops: [], gateways: [], popFields: [] })).toString('base64'),
    } });
    controllers.push(controller);
    return controller;
  };
  try {
    await run({ controller: restart(), restart, state, hooks, idle, errors, ui, unsubscribed });
  } finally {
    for (const controller of controllers) controller.dispose();
    Object.assign(console, savedConsole);
    for (const key of Object.getOwnPropertyNames(globalThis)) {
      if ((key.startsWith('__') || ['fetch', 'sessionStorage', 'requestIdleCallback'].includes(key)) && !savedGlobals.has(key)) delete globalThis[key];
    }
    for (const [key, value] of savedGlobals) globalThis[key] = value;
  }
}

test('native save notifications do not materialize the full World view to read identity', async t => {
  let viewReads = 0;
  t.mock.method(WorldTileRuntime.prototype, 'view', () => { viewReads++; return { worldId:'world-A' }; });
  await harness(async ({ hooks, controller }) => {
    await hooks.get('onGameSaved')('manual-save');
    assert.equal(controller.diagnostics.latestAutosave.status, 'observed');
    assert.equal(viewReads, 0, 'save diagnostics must not clone commute and finance payloads');
  });
});

test('world grid rejects startup clicks without queuing navigation and unlocks after demand finishes', async t => {
  const calculation = deferred(); const entered = deferred();
  let grid; let staged = 0; let navigated = 0;
  const readActive = GeographicContextOverlayController.prototype.readRuntimeActiveTileId;
  t.mock.method(GeographicContextOverlayController.prototype, 'readRuntimeActiveTileId', function () {
    grid = this; return readActive.call(this);
  });
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => {
    entered.resolve(); return calculation.promise;
  });
  t.mock.method(WorldTileRuntime.prototype, 'stageNavigationTransition', async tileId => {
    staged++; return { worldId: 'world-A', tileId };
  });
  t.mock.method(HashCityNavigationAdapter.prototype, 'navigateTo', () => { navigated++; });
  await harness(async ({ controller, idle, hooks, ui, state }) => {
    await controller.lifecycle.gameLoaded('save-A');
    const select = grid.onTileSelect;
    const tileId = 'JP_KANAGAWA_MAINLAND';
    assert.equal((await select(tileId)).status, 'initializing');
    idle.shift()(); await entered.promise;
    assert.equal((await select(tileId)).status, 'initializing');
    assert.equal(staged, 0, 'a startup click must not enqueue a native save/navigation transaction');
    assert.equal(navigated, 0);
    assert.ok(ui.some(item => Array.isArray(item) && /initializ/i.test(item[0])));
    calculation.resolve({ status: 'cached' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(staged, 0, 'blocked clicks must not replay once startup completes');
    await select(tileId);
    assert.equal(staged, 1);
    assert.equal(navigated, 1);
    hooks.get('onGameEnd')();
    assert.equal((await select(tileId)).status, 'initializing');
    assert.equal(staged, 1, 'a retained grid callback must not resurrect navigation');
    state.gameSessionId = 'session-B'; state.saveName = 'save-B';
    await controller.lifecycle.gameLoaded('save-B');
    idle.shift()(); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await select(tileId)).status, 'initializing');
    assert.equal(staged, 1, 'an old grid cannot navigate the replacement session');
    await grid.onTileSelect(tileId);
    assert.equal(staged, 2, 'the replacement grid is usable');
  });
});

test('game end during startup identity lookup prevents boot and UI resurrection', async t => {
  const gate = deferred(); const entered = deferred(); let bootCalls = 0;
  const originalResolve = WorldIdentityResolver.prototype.resolve;
  t.mock.method(WorldIdentityResolver.prototype, 'resolve', async function (...args) { entered.resolve(); await gate.promise; return originalResolve.apply(this, args); });
  const originalBoot = WorldTileRuntime.prototype.boot;
  t.mock.method(WorldTileRuntime.prototype, 'boot', function (...args) { bootCalls++; return originalBoot.apply(this, args); });
  await harness(async ({ controller, hooks, errors }) => {
    const opening = controller.lifecycle.gameLoaded('save-A');
    await entered.promise;
    hooks.get('onGameEnd')();
    gate.resolve(); await opening;
    assert.equal(bootCalls, 0);
    assert.equal(controller.diagnostics.startup, undefined);
    assert.deepEqual(errors, []);
  });
});

test('failure of an ended startup cannot clear a newer pending startup', async t => {
  const first = deferred(); const second = deferred(); const firstEntered = deferred(); const secondEntered = deferred();
  const originalBoot = WorldTileRuntime.prototype.boot; let bootCalls = 0;
  t.mock.method(WorldTileRuntime.prototype, 'boot', async function (...args) {
    bootCalls++;
    if (bootCalls === 1) { firstEntered.resolve(); await first.promise; }
    if (bootCalls === 2) { secondEntered.resolve(); await second.promise; }
    return originalBoot.apply(this, args);
  });
  await harness(async ({ controller, state, hooks, errors }) => {
    const opening = controller.lifecycle.gameLoaded('save-A'); await firstEntered.promise;
    hooks.get('onGameEnd')(); state.gameSessionId = 'session-B'; state.saveName = 'save-B';
    const next = controller.lifecycle.gameLoaded('save-B');
    first.reject(new Error('ended startup failed')); await opening; await secondEntered.promise;
    const duplicate = controller.lifecycle.gameLoaded('save-B');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bootCalls, 2, 'the stale catch must not allow a third boot');
    second.resolve(); await Promise.all([next, duplicate]);
    assert.equal(controller.diagnostics.currentWorld.nativeSessionId, 'session-B');
    assert.ok(controller.diagnostics.startup);
    assert.deepEqual(errors, []);
  });
});

test('deferred demand from an ended session cannot run on the replacement worker', async t => {
  const evaluations = [];
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async function (options) { evaluations.push(options); return { status: 'cached' }; });
  await harness(async ({ controller, state, hooks, idle }) => {
    await controller.lifecycle.gameLoaded('save-A');
    const oldDeferred = idle.shift(); assert.equal(typeof oldDeferred, 'function');
    hooks.get('onGameEnd')(); state.gameSessionId = 'session-B'; state.saveName = 'save-B';
    await controller.lifecycle.gameLoaded('save-B');
    oldDeferred(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(evaluations.length, 0);
    idle.shift()(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(evaluations.length, 1);
    const capturedEvaluator = evaluations[0].evaluateCrossModeShares;
    assert.equal(typeof capturedEvaluator, 'function');
    hooks.get('onGameEnd')();
    assert.throws(() => capturedEvaluator({}), /session ended/);
  });
});

test('full disposal unregisters hooks once and disables retained lifecycle callbacks', async t => {
  let identityCalls = 0;
  t.mock.method(WorldIdentityResolver.prototype, 'resolve', async () => { identityCalls++; throw new Error('disposed callback ran'); });
  await harness(async ({ controller, hooks, errors, unsubscribed }) => {
    const registered = [...hooks.keys()];
    assert.equal(registered.length, 11);
    const retainedGameLoaded = hooks.get('onGameLoaded');
    controller.dispose();
    controller.dispose();
    assert.equal(hooks.size, 0);
    assert.deepEqual(unsubscribed, registered);
    retainedGameLoaded('save-A');
    await controller.lifecycle.gameLoaded('save-A');
    await controller.lifecycle.gameInit();
    await controller.lifecycle.cityLoad('JP_TOKYO_MAINLAND');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(identityCalls, 0);
    assert.deepEqual(errors, []);
  });
});

test('a queued runtime recalculation keeps the evaluator captured when it was requested', async t => {
  const queue = deferred(); let runtime; let replacementCalls = 0;
  const originalBoot = WorldTileRuntime.prototype.boot;
  t.mock.method(WorldTileRuntime.prototype, 'boot', function (...args) { runtime = this; return originalBoot.apply(this, args); });
  await harness(async ({ controller }) => {
    await controller.lifecycle.gameLoaded('save-A');
    runtime.serial = queue.promise;
    runtime.evaluateCrossModeShares = () => { throw new Error('original evaluator cancelled'); };
    const pending = runtime.recalculateCrossTileModeShare({ force: true });
    runtime.evaluateCrossModeShares = () => { replacementCalls++; throw new Error('replacement evaluator used'); };
    queue.resolve();
    await assert.rejects(pending, /original evaluator cancelled/);
    assert.equal(replacementCalls, 0);
  });
});

test('hot reload removes the previous module hooks, including when the replacement is dormant', async t => {
  let bootCalls = 0;
  const originalBoot = WorldTileRuntime.prototype.boot;
  t.mock.method(WorldTileRuntime.prototype, 'boot', function (...args) { bootCalls++; return originalBoot.apply(this, args); });
  await harness(async ({ controller, restart, state, hooks, errors, unsubscribed }) => {
    const replacement = restart();
    assert.equal(unsubscribed.length, 11);
    assert.equal(hooks.size, 11);
    await controller.lifecycle.gameLoaded('save-A');
    assert.equal(bootCalls, 0);
    await replacement.lifecycle.gameLoaded('save-A');
    assert.equal(bootCalls, 1);
    state.cityCode = 'unrelated-city';
    assert.equal(restart().status, 'dormant');
    assert.equal(unsubscribed.length, 22);
    assert.deepEqual([...hooks.keys()].sort(), ['onCityLoad', 'onGameInit', 'onGameLoaded']);
    state.cityCode = 'JP_TOKYO_MAINLAND';
    await replacement.lifecycle.gameLoaded('save-A');
    assert.equal(bootCalls, 1);
    assert.deepEqual(errors, []);
  });
});
