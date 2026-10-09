import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { startOpenWorld } from '../src/runtime/start-open-world.js';
import { prototypeSaveBusyReason } from '../src/runtime/prototype-save-readiness.js';
import { WorldTileRuntime } from '../src/runtime/world-tile-runtime.js';
import { WorldIdentityResolver } from '../src/runtime/world-identity.js';
import { DemandExtensionStore, DEMAND_CHECKPOINT_FIELD } from '../src/runtime/demand-extension-state.js';
import { assertNativeDemandMemoryBudget } from '../src/runtime/embedded-tile-package-adapter.js';
import { createSubwayBuilderHostState } from '../testkit/subway-builder-host.js';
import { GeographicContextOverlayController } from '../src/runtime/ui/geographic-context-overlay.js';
import { HashCityNavigationAdapter } from '../src/runtime/adapters/hash-city-navigation-adapter.js';
import { SubwayBuilderGameAdapter } from '../src/runtime/adapters/subway-builder-game-adapter.js';
import { nativeHandoffEvidence } from '../src/runtime/native-handoff-verification.js';
import { SHARED_TRANSIT_STATE_KEYS } from '../src/runtime/shared-transit-network.js';
import definition from '../../worlds/tokyo-kanagawa/world.json' with { type: 'json' };
import catalogSource from '../../worlds/tokyo-kanagawa/geography/tile-views.json' with { type: 'json' };

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness(run, { storage = new Map(), nativeDayTicks = false, initialCityCode = 'JP_TOKYO_MAINLAND' } = {}) {
  const savedGlobals = new Map(Object.getOwnPropertyNames(globalThis).filter(key => key.startsWith('__')
    || ['fetch', 'localStorage', 'sessionStorage', 'requestIdleCallback'].includes(key)).map(key => [key, globalThis[key]]));
  const savedConsole = { debug: console.debug, info: console.info, log: console.log, warn: console.warn, error: console.error };
  const hooks = new Map(); const idle = []; const errors = []; const ui = []; const unsubscribed = [];
  const nativeDays = [];
  const state = createSubwayBuilderHostState({ cityCode: initialCityCode, gameSessionId: 'session-A', saveName: 'save-A', money: 1_000_000, transitCost: 2.5,
    routeFinancials: { byRoute: {}, lastHourTimestamp: 0, currentHour: {} },
    financialHistory: { entries: [], lastHourTimestamp: 0, currentHourRevenue: 0, currentHourExpenses: 0, currentHourExpenseCategories: {} },
    generateSave() { return { name: state.saveName, cityCode: state.cityCode, gameSessionId: state.gameSessionId, viewport: {}, data: {
      cityCode: state.cityCode, elapsedSeconds: 0, money: state.money, routes: [], stations: [], stNodes: [], trains: [], tracks: [], trackGroups: [], signals: [], stationGroups: [],
      routeFinancials: structuredClone(state.routeFinancials), financialHistory: structuredClone(state.financialHistory),
    } }; }, loadSave() {},
    async handleIncrementGameState() {
      if (!nativeDayTicks) return;
      // Native handleIncrementGameState owns public day dispatch. Native
      // setTimeConfig only updates clock state, as it does in the real game.
      const before = Math.floor(state.timeConfig.elapsedSeconds / 86400);
      state.setTimeConfig({ elapsedSeconds: state.timeConfig.elapsedSeconds + 240 });
      const after = Math.floor(state.timeConfig.elapsedSeconds / 86400);
      for (let day = before + 1; day <= after; day++) {
        nativeDays.push(day); hooks.get('onDayChange')?.(day);
      }
    },
  });
  const api = { version: '1.0.0', registerCity() {}, cities: { setCityDataFiles() {} }, map: { setTileURLOverride() {}, setDefaultLayerVisibility() {} },
    utils: { getCities: () => [], getCityCode: () => state.cityCode, getMap: () => null, getPathfindingRules: () => ({}), loadCityData: async () => ({ points: [], pops: [] }),
      React: { createElement: () => null }, components: { Button: () => null } },
    trains: { getTrainTypes: () => ({}) }, gameState: { getGameSessionId: () => state.gameSessionId, getSaveName: () => state.saveName, getCurrentDay: () => 1,
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
  const preferences = new Map();
  globalThis.localStorage = { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) };
  if (storage) globalThis.__tokyoKanagawaDurableStorageV1__ = storage;
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
    await run({ controller: restart(), restart, api, state, hooks, idle, errors, ui, unsubscribed, nativeDays });
  } finally {
    for (const controller of new Set([...controllers, globalThis.__tokyoKanagawaActiveRuntimeV1__].filter(Boolean))) controller.dispose();
    Object.assign(console, savedConsole);
    for (const key of Object.getOwnPropertyNames(globalThis)) {
      if ((key.startsWith('__') || ['fetch', 'localStorage', 'sessionStorage', 'requestIdleCallback'].includes(key)) && !savedGlobals.has(key)) delete globalThis[key];
    }
    for (const [key, value] of savedGlobals) globalThis[key] = value;
  }
}

test('cold native load resolves the saved demand checkpoint World despite a stale session binding', async t => {
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  const savedWorldId = 'saved-player-world';
  const storage = new Map([['identity:session:session-A', 'stale-player-world']]);
  const store = new DemandExtensionStore({ storage, createId: () => 'saved-checkpoint' });
  const saved = await store.commit(await store.readCheckpoint(null, savedWorldId), 'JP_TOKYO_MAINLAND', 'induced-demand',
    { ledger: '{"pressure":7}', points: [], pops: [] }, 'saved-day');
  await harness(async ({ controller, state, errors, idle }) => {
    state.financialHistory.openWorldAuthoritativeWorldId = savedWorldId;
    state.financialHistory[DEMAND_CHECKPOINT_FIELD] = structuredClone(saved.marker);
    await controller.lifecycle.gameLoaded('save-A');
    assert.equal(controller.diagnostics.demandExtensions().error, null);
    assert.equal(controller.diagnostics.currentWorld.worldId, savedWorldId);
    assert.equal(storage.get('identity:session:session-A'), savedWorldId);
    assert.deepEqual(state.financialHistory[DEMAND_CHECKPOINT_FIELD], saved.marker, 'the exact saved checkpoint remains authoritative');
    idle.shift()(); await new Promise(setImmediate);
    const demand = globalThis.SubwayBuilderOpenWorldDemand;
    assert.equal(await demand.readState('induced-demand', demand.getContext()), '{"pressure":7}');
    assert.deepEqual(errors, []);
  }, { storage });
});

test('dormant city discovery waits for the selected native save before choosing its demand checkpoint World', async t => {
  let boots = 0, nativeLoaded = false;
  const gate = deferred(), originalBoot = WorldTileRuntime.prototype.boot;
  t.mock.method(WorldTileRuntime.prototype, 'boot', async function (...args) {
    boots++; if (!nativeLoaded) await gate.promise;
    return originalBoot.apply(this, args);
  });
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  const storage = new Map(), savedWorldId = 'selected-saved-world';
  const store = new DemandExtensionStore({ storage, createId: () => 'dormant-checkpoint' });
  const saved = await store.commit(await store.readCheckpoint(null, savedWorldId), 'JP_TOKYO_MAINLAND', 'induced-demand',
    { ledger: '{"pressure":9}', points: [], pops: [] }, 'saved-day');
  await harness(async ({ controller, state, hooks, idle, errors }) => {
    assert.equal(controller.status, 'dormant');
    state.cityCode = 'JP_TOKYO_MAINLAND'; state.gameSessionId = 'temporary-city-session';
    const discovery = hooks.get('onCityLoad')(state.cityCode);
    await new Promise(setImmediate);
    const active = globalThis.__tokyoKanagawaActiveRuntimeV1__, earlyBoots = boots;
    state.gameSessionId = 'selected-native-session';
    state.financialHistory.openWorldAuthoritativeWorldId = savedWorldId;
    state.financialHistory[DEMAND_CHECKPOINT_FIELD] = structuredClone(saved.marker);
    nativeLoaded = true;
    const loaded = active.lifecycle.gameLoaded('selected-native-save');
    gate.resolve(); await Promise.all([discovery, loaded]);
    assert.equal(active.diagnostics.demandExtensions().error, null);
    assert.equal(earlyBoots, 0, 'city discovery must not authorize native save adoption');
    assert.equal(boots, 1); assert.equal(active.diagnostics.currentWorld.worldId, savedWorldId);
    assert.equal(active.diagnostics.nativeStartupReadinessVersion, 'native-load-before-world-startup-v1');
    assert.deepEqual(state.financialHistory[DEMAND_CHECKPOINT_FIELD], saved.marker);
    idle.shift()(); await new Promise(setImmediate);
    const demand = globalThis.SubwayBuilderOpenWorldDemand;
    assert.equal(await demand.readState('induced-demand', demand.getContext()), '{"pressure":9}');
    assert.deepEqual(errors, []);
  }, { storage, initialCityCode: 'unknown' });
});

test('dormant city discovery still starts a new World when native game initialization completes', async t => {
  let boots = 0;
  const originalBoot = WorldTileRuntime.prototype.boot;
  t.mock.method(WorldTileRuntime.prototype, 'boot', function (...args) { boots++; return originalBoot.apply(this, args); });
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  await harness(async ({ state, hooks, idle, errors }) => {
    state.cityCode = 'JP_TOKYO_MAINLAND';
    await hooks.get('onCityLoad')(state.cityCode);
    assert.equal(boots, 0);
    const active = globalThis.__tokyoKanagawaActiveRuntimeV1__;
    state.gameSessionId = 'new-native-world';
    await active.lifecycle.gameInit();
    assert.equal(boots, 1); assert.equal(active.diagnostics.currentWorld.worldId, 'new-native-world');
    idle.shift()(); await new Promise(setImmediate);
    assert.equal(globalThis.SubwayBuilderOpenWorldDemand.getContext().demandReady, true);
    assert.deepEqual(errors, []);
  }, { initialCityCode: 'unknown' });
});

for (const kind of ['internal-runtime', 'save-echo']) test(`dormant city discovery preserves the native hot-reload startup route (${kind})`, async t => {
  let boots = 0;
  const originalBoot = WorldTileRuntime.prototype.boot;
  t.mock.method(WorldTileRuntime.prototype, 'boot', function (...args) { boots++; return originalBoot.apply(this, args); });
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  const storage = new Map(), entries = new Map(), savedWorldId = 'replayed-saved-world';
  const store = new DemandExtensionStore({ storage, createId: () => `replay-${kind}` });
  const saved = await store.commit(await store.readCheckpoint(null, savedWorldId), 'JP_TOKYO_MAINLAND', 'induced-demand',
    { ledger: '{"pressure":11}', points: [], pops: [] }, 'saved-day');
  await harness(async ({ state, hooks, idle, errors }) => {
    globalThis.sessionStorage = { getItem: key => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
    state.cityCode = 'JP_TOKYO_MAINLAND';
    await hooks.get('onCityLoad')(state.cityCode);
    assert.equal(boots, 0);
    const active = globalThis.__tokyoKanagawaActiveRuntimeV1__;
    state.gameSessionId = 'replayed-native-session';
    state.financialHistory.openWorldAuthoritativeWorldId = savedWorldId;
    state.financialHistory[DEMAND_CHECKPOINT_FIELD] = structuredClone(saved.marker);
    if (kind === 'save-echo') entries.set('tokyo-kanagawa:pending-native-save-echo', JSON.stringify({
      saveName: 'selected-native-save', nativeSessionId: state.gameSessionId,
    }));
    await active.lifecycle.gameLoaded(kind === 'internal-runtime' ? 'open-world-runtime' : 'selected-native-save');
    assert.equal(boots, 1); assert.equal(active.diagnostics.currentWorld.worldId, savedWorldId);
    assert.equal(active.diagnostics.authoritativeLoads.find(event => event.segment === 'lifecycle-start').hotReload, true);
    assert.deepEqual(state.financialHistory[DEMAND_CHECKPOINT_FIELD], saved.marker);
    idle.shift()(); await new Promise(setImmediate);
    const demand = globalThis.SubwayBuilderOpenWorldDemand;
    assert.equal(await demand.readState('induced-demand', demand.getContext()), '{"pressure":11}');
    assert.deepEqual(errors, []);
  }, { storage, initialCityCode: 'unknown' });
});

test('startup retries a native memory admission deferral after the budget becomes available', async t => {
  let allowed = false, attempts = 0;
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => {
    attempts++;
    assertNativeDemandMemoryBudget({ at: Date.now(), workersAvailable: true,
      allIsolatesAllocatedBytes: (allowed ? 1 : 3.5) * 1024 ** 3 });
    return { status: 'cached' };
  });
  await harness(async ({ controller, idle }) => {
    await controller.lifecycle.gameLoaded('save-A');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    idle.shift()(); await new Promise(setImmediate);
    assert.equal(attempts, 1);
    assert.equal(controller.diagnostics.startupDemandSettlement.status, 'waiting-for-memory');
    assert.equal(globalThis.SubwayBuilderOpenWorldDemand.getContext().demandReady, false);
    allowed = true;
    t.mock.timers.tick(1000); await new Promise(setImmediate);
    idle.shift()?.(); await new Promise(setImmediate);
    assert.equal(attempts, 2, 'startup should resume automatically after a native memory admission deferral');
    assert.equal(globalThis.SubwayBuilderOpenWorldDemand.getContext().demandReady, true);
    assert.equal(controller.diagnostics.authoritativeLoads.at(-1).segment, 'startup-simulation-ready');
    assert.equal(controller.diagnostics.startupDemandSettlement.status, 'ready');
  });
});

for (const retire of ['dispose', 'game-end']) test(`startup memory retry is cancelled on ${retire}`, async t => {
  let attempts = 0;
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => {
    attempts++; assertNativeDemandMemoryBudget({ at: Date.now(), workersAvailable: true,
      allIsolatesAllocatedBytes: 3.5 * 1024 ** 3 });
  });
  await harness(async ({ controller, idle, hooks }) => {
    await controller.lifecycle.gameLoaded('save-A'); t.mock.timers.enable({ apis: ['setTimeout'] });
    idle.shift()(); await new Promise(setImmediate);
    if (retire === 'dispose') controller.dispose(); else hooks.get('onGameEnd')();
    t.mock.timers.tick(60_000); await new Promise(setImmediate);
    idle.shift()?.(); await new Promise(setImmediate);
    assert.equal(attempts, 1); assert.equal(controller.diagnostics.startupDemandSettlement.status, 'cancelled');
  });
});

test('startup reports a nonmemory failure without scheduling another attempt', async t => {
  let attempts = 0;
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => {
    attempts++; throw new Error('Saved demand checkpoint is unavailable');
  });
  await harness(async ({ controller, idle }) => {
    await controller.lifecycle.gameLoaded('save-A'); t.mock.timers.enable({ apis: ['setTimeout'] });
    idle.shift()(); await new Promise(setImmediate);
    t.mock.timers.tick(60_000); await new Promise(setImmediate);
    idle.shift()?.(); await new Promise(setImmediate);
    assert.equal(attempts, 1); assert.equal(controller.diagnostics.startupDemandSettlement.status, 'failed');
    assert.equal(controller.diagnostics.startupDemandSettlement.error, 'Saved demand checkpoint is unavailable');
    assert.equal(globalThis.SubwayBuilderOpenWorldDemand.getContext().demandReady, false);
  });
});

test('failed remembered Ultra restoration reports the startup error and retries on explicit enable', async t => {
  let attempts = 0;
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => {
    attempts++;
    return attempts === 1 ? { status: 'recalculated', nativeFinanceProfile: { status: 'pending',
      failed: [{ tileId: 'JP_TOKYO_MAINLAND', error: 'trainTypes.find is not a function', errorName: 'TypeError' }], unavailable: [] } }
      : { status: 'cached' };
  });
  await harness(async ({ controller, idle, state }) => {
    state.setDemandData = value => { state.demandData = value; };
    state.setTrains = value => { state.trains = value; };
    await controller.simulationControls.setEnabled(true);
    const changes = [], unsubscribe = controller.simulationControls.subscribe(value => changes.push(value));
    await controller.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(setImmediate);
    assert.equal(controller.diagnostics.startupDemandSettlement.status, 'failed');
    assert.equal(controller.cachedSimulation.snapshot().enabled, false);
    const failed = controller.simulationControls.snapshot();
    assert.equal(failed.enabled, true, 'the remembered user choice remains selected');
    assert.equal(failed.status, 'error', 'a terminal preparation failure cannot display endless restoring');
    assert.match(failed.error, /trainTypes.find is not a function/);
    assert.equal(changes.at(-1).status, 'error', 'the visible control is notified when preparation fails');
    await controller.simulationControls.setEnabled(false);
    assert.equal(controller.simulationControls.snapshot().status, 'off');
    const retry = controller.simulationControls.setEnabled(true);
    await new Promise(setImmediate);
    assert.equal(attempts, 1, 'retry uses the normal deferred startup admission');
    idle.shift()(); await retry;
    assert.equal(attempts, 2);
    assert.equal(controller.diagnostics.startupDemandSettlement.status, 'ready');
    assert.equal(controller.cachedSimulation.snapshot().enabled, true);
    assert.equal(globalThis.SubwayBuilderOpenWorldDemand.getContext().demandReady, true);
    assert.equal(controller.simulationControls.snapshot().error, null);
    unsubscribe();
  });
});

test('a fresh runtime restores both choices, enabling Ultra only after network finance is ready', async t => {
  const finance = deferred(), entered = deferred();
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => {
    entered.resolve(); await finance.promise; return { status: 'cached' };
  });
  await harness(async ({ controller, restart, idle, hooks }) => {
    await controller.simulationControls.setEnabled(true);
    await controller.diagnostics.prototypeSaveWriter.configureAutomatic({ origins: ['http://127.0.0.1:8800'],
      fetchFn: async () => Response.json({ version: 'tile-save-prototype-v1' }) });
    controller.diagnostics.prototypeSaveWriter.setEnabled(true);
    hooks.get('onGameEnd')();
    assert.equal(controller.modePreferences.snapshot().ultraHighSpeed, true, 'lifecycle disable does not change user intent');
    controller.dispose();
    const next = restart();
    assert.equal(next.diagnostics.prototypeSaveWriter.snapshot().enabled, true);
    assert.equal(next.diagnostics.prototypeSaveWriter.snapshot().configured, false, 'writer discovery is independent of remembered selection');
    assert.equal(next.simulationControls.snapshot().enabled, true);
    assert.equal(next.cachedSimulation.snapshot().enabled, false, 'do not enable on an uninitialized native store');
    const enabled = [];
    t.mock.method(next.cachedSimulation, 'setEnabled', async value => { enabled.push(value); return { status: value ? 'ready' : 'off' }; });
    await next.lifecycle.gameLoaded('save-A');
    idle.shift()(); await entered.promise;
    assert.deepEqual(enabled.filter(Boolean), [], 'do not race startup demand allocation');
    finance.resolve(); await new Promise(setImmediate);
    assert.deepEqual(enabled.filter(Boolean), [true]);
    assert.equal(next.modePreferences.snapshot().ultraHighSpeed, true);
  });
});

for (const cancellation of ['user-disables', 'game-end', 'hot-reload']) {
  test(`remembered Ultra restoration cannot outlive ${cancellation}`, async t => {
    const finance = deferred(), entered = deferred();
    t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => {
      entered.resolve(); await finance.promise; return { status: 'cached' };
    });
    await harness(async ({ controller, restart, idle, hooks }) => {
      await controller.simulationControls.setEnabled(true);
      const enabled = [];
      t.mock.method(controller.cachedSimulation, 'setEnabled', async value => { enabled.push(value); return { status: value ? 'ready' : 'off' }; });
      await controller.lifecycle.gameLoaded('save-A');
      idle.shift()(); await entered.promise;
      if (cancellation === 'user-disables') await controller.simulationControls.setEnabled(false);
      else if (cancellation === 'game-end') hooks.get('onGameEnd')();
      else restart();
      finance.resolve(); await new Promise(setImmediate);
      assert.deepEqual(enabled.filter(Boolean), []);
      assert.equal(controller.modePreferences.snapshot().ultraHighSpeed, cancellation !== 'user-disables');
    });
  });
}

test('an explicit off choice persists through runtime restart', async t => {
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  await harness(async ({ controller, restart, idle }) => {
    await controller.simulationControls.setEnabled(true);
    await controller.simulationControls.setEnabled(false);
    controller.diagnostics.prototypeSaveWriter.setEnabled(false);
    controller.dispose();
    const next = restart();
    const enabled = [];
    t.mock.method(next.cachedSimulation, 'setEnabled', async value => { enabled.push(value); return { status: 'off' }; });
    await next.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(setImmediate);
    assert.deepEqual(enabled.filter(Boolean), []);
    assert.equal(next.simulationControls.snapshot().enabled, false);
    assert.equal(next.diagnostics.prototypeSaveWriter.snapshot().enabled, false);
  });
});

for (const scenario of ['available', 'delayed', 'ended']) test(`transition completion handles missed map-ready (${scenario})`, async t => {
  const delayed = scenario !== 'available';
  let grid; let activeTile = 'JP_TOKYO_MAINLAND'; let pending = null;
  const attachments = [];
  t.mock.method(GeographicContextOverlayController.prototype, 'attachMap', function (map) {
    grid = this; this.map = map; attachments.push(map);
  });
  t.mock.method(GeographicContextOverlayController.prototype, 'refresh', () => {});
  t.mock.method(WorldTileRuntime.prototype, 'getActiveTileId', () => activeTile);
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  t.mock.method(WorldTileRuntime.prototype, 'completeStagedTransition', async function (tile) {
    activeTile = tile;
    await this.demandExtensions.activate({ worldId: this.getWorldId(), tileId: tile });
  });
  t.mock.method(HashCityNavigationAdapter.prototype, 'pending', () => pending);
  t.mock.method(HashCityNavigationAdapter.prototype, 'complete', () => { pending = null; });
  const map = () => {
    const listeners = new Map();
    return { listeners,
      on(event, callback) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(callback); },
      off(event, callback) { listeners.get(event)?.delete(callback); },
      getSource: () => null, getLayer: () => null, isStyleLoaded: () => true };
  };
  await harness(async ({ controller, api, state, hooks, idle, errors }) => {
    const oldMap = map(); const newMap = map();
    api.utils.getMap = () => oldMap;
    hooks.get('onMapReady')(oldMap);
    await controller.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(grid.map, oldMap);
    oldMap._removed = true;
    let publishedMap = delayed ? oldMap : newMap;
    api.utils.getMap = () => publishedMap;
    pending = { worldId: state.gameSessionId, from: activeTile, tileId: 'JP_KANAGAWA_MAINLAND', transitionId: 'missed-map-ready' };
    state.cityCode = pending.tileId;
    const completion = controller.lifecycle.cityLoad(state.cityCode, { authoritative: true });
    if (delayed) {
      while (controller.diagnostics.mapAttachment?.status !== 'waiting-for-live-map') {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.notEqual(pending, null, 'navigation stays pending while the host exposes its removed map');
      if (scenario === 'ended') controller.dispose();
      publishedMap = newMap;
    }
    await completion;
    if (scenario === 'ended') {
      assert.equal(attachments.includes(newMap), false, 'an ended session cannot attach to the replacement map');
      return;
    }
    assert.equal(grid.map, newMap, 'completion must attach controllers to the replacement map without a map-ready event');
    assert.equal(controller.diagnostics.mapAttachment.reason, 'tile-navigation-complete');
    assert.equal(controller.diagnostics.mapAttachment.liveMapMatches, true);
    assert.deepEqual(errors, []);
    const styleListeners = newMap.listeners.get('style.load').size;
    hooks.get('onMapReady')(newMap);
    assert.equal(grid.map, newMap, 'a late readiness callback keeps the live map');
    assert.equal(newMap.listeners.get('style.load').size, styleListeners, 'late readiness must not duplicate style listeners');
    assert.ok(attachments.includes(newMap));
  });
});

test('native save notifications do not materialize the full World view to read identity', async t => {
  let viewReads = 0;
  t.mock.method(WorldTileRuntime.prototype, 'view', () => { viewReads++; return { worldId:'world-A' }; });
  await harness(async ({ hooks, controller }) => {
    await hooks.get('onGameSaved')('manual-save');
    assert.equal(controller.diagnostics.latestAutosave.status, 'observed');
    assert.equal(viewReads, 0, 'save diagnostics must not clone commute and finance payloads');
  });
});

test('runtime startup observes simulation actions for saving without requiring a native worker pool', async () => {
  await harness(async ({ controller }) => {
    assert.equal(controller.diagnostics.prototypeSaveReadinessVersion, 'prototype-save-work-readiness-v1');
    const simulation = controller.cachedSimulation.snapshot();
    assert.equal(simulation.saveWork.observed, true);
    assert.equal(prototypeSaveBusyReason({ nativeWorkers: controller.diagnostics.nativeCommuteWorkers?.(), simulation }), false);
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

for (const endDuringPaint of [false, true]) test(`grid switching notification paints before preparation (ended=${endDuringPaint})`, async t => {
  let grid; let painted = false; let paint;
  const readActive = GeographicContextOverlayController.prototype.readRuntimeActiveTileId;
  t.mock.method(GeographicContextOverlayController.prototype, 'readRuntimeActiveTileId', function () {
    grid = this; return readActive.call(this);
  });
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  t.mock.method(WorldTileRuntime.prototype, 'stageNavigationTransition', async tileId => {
    assert.equal(painted, true, 'the switching alert must paint before preparing the native handoff');
    return { worldId: 'world-A', tileId };
  });
  t.mock.method(HashCityNavigationAdapter.prototype, 'navigateTo', () => {});
  await harness(async ({ controller, idle, api, hooks }) => {
    await controller.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(resolve => setImmediate(resolve));
    t.mock.method(api.ui, 'showNotification', () => {
      paint = setTimeout(() => {
        painted = true;
        if (endDuringPaint) hooks.get('onGameEnd')();
      }, 0);
    });
    const disable = controller.cachedSimulation.setEnabled;
    t.mock.method(controller.cachedSimulation, 'setEnabled', function (...args) {
      assert.equal(painted, true, 'the switching alert must paint before cached settlement starts');
      return disable.apply(this, args);
    });
    try {
      const result = await grid.onTileSelect('JP_KANAGAWA_MAINLAND');
      if (endDuringPaint) assert.equal(result.status, 'cancelled');
    }
    finally { clearTimeout(paint); t.mock.restoreAll(); }
  });
});

for (const replacement of ['game-end', 'manual-save', 'native-session']) test(`a tile switch cannot navigate after ${replacement} while staging`, async t => {
  const staging = deferred(); const entered = deferred();
  let grid; let navigated = 0; let retired = 0; const abandoned = [];
  const readActive = GeographicContextOverlayController.prototype.readRuntimeActiveTileId;
  t.mock.method(GeographicContextOverlayController.prototype, 'readRuntimeActiveTileId', function () {
    grid = this; return readActive.call(this);
  });
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  t.mock.method(WorldTileRuntime.prototype, 'stageNavigationTransition', async tileId => {
    entered.resolve(); await staging.promise;
    return { status: 'reload-required', worldId: 'session-A', from: 'JP_TOKYO_MAINLAND',
      tileId, transitionId: 'late-staging' };
  });
  const abandon = WorldTileRuntime.prototype.abandonStagedTransition;
  t.mock.method(WorldTileRuntime.prototype, 'abandonStagedTransition', function (options) {
    abandoned.push(options); return abandon.call(this, options);
  });
  t.mock.method(SubwayBuilderGameAdapter.prototype, 'prepareTileRenderingRetirement', () => {
    retired++; return { retireBeforeNavigation() {}, cancel() {} };
  });
  t.mock.method(HashCityNavigationAdapter.prototype, 'navigateTo', () => { navigated++; });
  await harness(async ({ controller, state, hooks, idle }) => {
    await controller.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(resolve => setImmediate(resolve));
    const switching = grid.onTileSelect('JP_KANAGAWA_MAINLAND');
    await entered.promise;
    if (replacement === 'game-end') hooks.get('onGameEnd')();
    else {
      state.gameSessionId = 'session-B';
      if (replacement === 'manual-save') {
        state.saveName = 'save-B';
        await controller.lifecycle.gameLoaded('save-B');
      }
    }
    staging.resolve();
    const result = await switching;
    assert.equal(result.status, 'cancelled');
    assert.equal(navigated, 0, 'a stale staged result must never reach the router');
    assert.equal(retired, 0, 'a stale click must not retire the replacement renderer');
    assert.ok(abandoned.some(item => item.transitionId === 'late-staging'), 'release the exact late staged transition');
    if (replacement === 'manual-save') {
      assert.equal((await grid.onTileSelect('JP_TOKYO_MAINLAND')).status, 'already-active',
        'late staging must not mark the replacement save unready');
    }
  });
});

for (const paused of [true, false]) test(`grid tile switch excludes cached operating time from the native handoff (paused=${paused})`, async t => {
  let grid; let captured; let navigated = false;
  const readActive = GeographicContextOverlayController.prototype.readRuntimeActiveTileId;
  t.mock.method(GeographicContextOverlayController.prototype, 'readRuntimeActiveTileId', function () {
    grid = this; return readActive.call(this);
  });
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  t.mock.method(WorldTileRuntime.prototype, 'stageNavigationTransition', async function (tileId) {
    // Use the production lean snapshot path used by route navigation, without
    // loading map packages or changing the native game in this unit test.
    captured = await this.game.captureSnapshot({ cityCode: 'JP_TOKYO_MAINLAND', data: {
      routes: [], stations: [], tracks: [], trains: [],
    } });
    return { worldId: 'world-A', tileId };
  });
  t.mock.method(HashCityNavigationAdapter.prototype, 'navigateTo', () => { navigated = true; });
  await harness(async ({ controller, state, idle }) => {
    await controller.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(resolve => setImmediate(resolve));
    state.timeConfig = { paused: true, timeSpeed: 'ultrafast', elapsedSeconds: 25000 };
    state.setDemandData = value => { state.demandData = value; };
    state.setTrains = value => { state.trains = value; };
    state.trains = [{ id: 'train-A', operationalTime: { totalSeconds: 100, lastChargedAt: 24990 },
      timings: [{ arrivalTime: 25000 }] }];
    await controller.cachedSimulation.setEnabled(true);
    assert.equal(controller.cachedSimulation.snapshot().status, 'ready', JSON.stringify(controller.cachedSimulation.snapshot()));
    state.setTimeConfig({ paused: false });
    for (let i = 0; i < 20; i++) await state.handleIncrementGameState();
    state.setTimeConfig({ paused });
    const elapsed = state.timeConfig.elapsedSeconds;
    assert.ok(elapsed > 25000);
    await grid.onTileSelect('JP_KANAGAWA_MAINLAND');
    assert.equal(navigated, true);
    // Native operating charges multiply this gap by the train's hourly cost.
    // Only the ten unpaid native seconds from before cached mode remain due.
    assert.equal(captured.data.elapsedSeconds - captured.data.trains[0].operationalTime.lastChargedAt, 10);
    assert.equal(captured.data.trains[0].timings[0].arrivalTime, elapsed);
    assert.equal(controller.cachedSimulation.snapshot().enabled, false);
    assert.equal(state.timeConfig.paused, paused);
  });
});

for (const { paused, failMapOnce = false } of [{ paused: true }, { paused: false }, { paused: false, failMapOnce: true }]) test(`explicit tile handoff shows the map before preparation and resumes cached mode (paused=${paused}, retryMap=${failMapOnce})`, async t => {
  let grid; let activeTile = 'JP_TOKYO_MAINLAND'; let pending = null; let crossCalls = 0;
  let failNextMap = false; let nativeRestores = 0;
  const finance = deferred(); const financeEntered = deferred();
  const readActive = GeographicContextOverlayController.prototype.readRuntimeActiveTileId;
  t.mock.method(GeographicContextOverlayController.prototype, 'readRuntimeActiveTileId', function () {
    grid = this; return readActive.call(this);
  });
  t.mock.method(GeographicContextOverlayController.prototype, 'attachMap', function (map) {
    if (failNextMap) { failNextMap = false; throw new Error('Map attachment temporarily unavailable'); }
    this.map = map;
  });
  t.mock.method(GeographicContextOverlayController.prototype, 'refresh', () => {});
  t.mock.method(WorldTileRuntime.prototype, 'getActiveTileId', () => activeTile);
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async options => {
    crossCalls++;
    if (options.reason !== 'tile-transition') return { status: 'cached' };
    financeEntered.resolve(); return finance.promise;
  });
  t.mock.method(WorldTileRuntime.prototype, 'stageNavigationTransition', async tileId => ({
    status: 'reload-required', worldId: 'session-A', from: activeTile, tileId, transitionId: 'resume-cached',
  }));
  t.mock.method(HashCityNavigationAdapter.prototype, 'pending', () => pending);
  t.mock.method(HashCityNavigationAdapter.prototype, 'navigateTo', transition => { pending = transition; });
  t.mock.method(HashCityNavigationAdapter.prototype, 'complete', () => { pending = null; });
  await harness(async ({ controller, api, state, hooks, idle, errors }) => {
    const map = { on() {}, off() {}, getSource: () => null, getLayer: () => null, isStyleLoaded: () => true };
    api.utils.getMap = () => map;
    await controller.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(resolve => setImmediate(resolve));
    state.setDemandData = value => { state.demandData = value; };
    state.setTrains = value => { state.trains = value; };
    state.setTimeConfig({ paused, timeSpeed: 'ultrafast', elapsedSeconds: 25000 });
    await controller.cachedSimulation.setEnabled(true);
    assert.equal(controller.cachedSimulation.snapshot().calculations, 1);
    t.mock.method(WorldTileRuntime.prototype, 'completeStagedTransition', async function (tile, options) {
      nativeRestores++;
      assert.equal(options.deferNativeCommutes, true, 'cached destination preparation owns routing');
      activeTile = tile;
      state.gameSessionId = 'session-A';
      state.setTimeConfig({ paused: true }); // Native loadSave always starts paused.
      await this.demandExtensions.activate({ worldId: this.getWorldId(), tileId: tile });
    });
    await grid.onTileSelect('JP_KANAGAWA_MAINLAND');
    hooks.get('onGameEnd')();
    state.cityCode = 'JP_KANAGAWA_MAINLAND';
    state.gameSessionId = 'temporary-native-city-session';
    await controller.lifecycle.gameInit();
    const elapsed = state.timeConfig.elapsedSeconds;
    await state.handleIncrementGameState();
    assert.equal(state.timeConfig.elapsedSeconds, elapsed, 'native initializer cannot advance time during the temporary session');
    failNextMap = failMapOnce;
    await controller.lifecycle.cityLoad(state.cityCode, { authoritative: true });
    let retry;
    if (failMapOnce) {
      assert.equal(controller.diagnostics.tileSimulationHandoff.status, 'error');
      assert.notEqual(pending, null, 'a failed map attachment retains its explicit navigation token');
      await state.handleIncrementGameState();
      assert.equal(state.timeConfig.elapsedSeconds, elapsed);
      retry = controller.diagnostics.retryTileSimulation();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(nativeRestores, 1, 'map recovery must not repeat a completed native restore');
    }
    assert.equal(pending, null, 'navigation is complete before finance starts');
    assert.equal(controller.diagnostics.latestGridNavigation.status, 'completed');
    assert.equal(controller.diagnostics.tileSimulationHandoff.status, 'queued');
    assert.equal(crossCalls, 1, 'destination work is deferred until the map-ready callback returns');
    assert.equal(controller.cachedSimulation.snapshot().enabled, false);
    await state.handleIncrementGameState();
    assert.equal(state.timeConfig.elapsedSeconds, elapsed, 'map readiness does not release the clock');
    assert.equal((await grid.onTileSelect('JP_TOKYO_MAINLAND')).status, 'initializing');
    idle.shift()(); await financeEntered.promise;
    assert.equal(controller.cachedSimulation.snapshot().calculations, 2, 'destination assignments are prepared first, exactly once');
    assert.equal(controller.cachedSimulation.snapshot().enabled, true);
    await state.handleIncrementGameState();
    assert.equal(state.timeConfig.elapsedSeconds, elapsed, 'ready assignments alone cannot release the clock');
    finance.resolve({ status: 'cached' });
    await retry;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.diagnostics.tileSimulationHandoff.status, 'ready');
    assert.equal(state.timeConfig.paused, paused, 'player pause state survives both readiness boundaries');
    await controller.cachedSimulation.setEnabled(true);
    assert.equal(controller.cachedSimulation.snapshot().calculations, 2, 'enabling the restored mode does not recalculate');
    await state.handleIncrementGameState();
    assert.equal(state.timeConfig.elapsedSeconds > elapsed, !paused);
    assert.equal(errors.length, failMapOnce ? 1 : 0);
  });
});

test('an unrelated native save invalidates a pending tile handoff and keeps cached mode off', async t => {
  let grid; let pending = null; let invalid = false; let runtime; const reloads = [];
  const readActive = GeographicContextOverlayController.prototype.readRuntimeActiveTileId;
  t.mock.method(GeographicContextOverlayController.prototype, 'readRuntimeActiveTileId', function () {
    grid = this; return readActive.call(this);
  });
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  t.mock.method(WorldTileRuntime.prototype, 'stageNavigationTransition', async function (tileId) {
    runtime = this;
    this.world.pendingTransition = { transitionId: 'abandoned', from: 'JP_TOKYO_MAINLAND', to: tileId,
      nativeSnapshot: { data: { retainedOldSave: true } } };
    this.world.activeTileId = tileId;
    return { status: 'reload-required', worldId: 'session-A', from: 'JP_TOKYO_MAINLAND', tileId, transitionId: 'abandoned' };
  });
  const reloadFromSave = WorldTileRuntime.prototype.reloadFromSave;
  t.mock.method(WorldTileRuntime.prototype, 'reloadFromSave', async function (...args) {
    reloads.push(args); return reloadFromSave.apply(this, args);
  });
  t.mock.method(HashCityNavigationAdapter.prototype, 'pending', () => pending);
  t.mock.method(HashCityNavigationAdapter.prototype, 'navigateTo', transition => { pending = transition; });
  t.mock.method(HashCityNavigationAdapter.prototype, 'complete', () => { pending = null; });
  t.mock.method(SubwayBuilderGameAdapter.prototype, 'nativeTileHandoffStatus', () => invalid
    ? { state: 'invalid', transitionId: 'abandoned' } : null);
  await harness(async ({ controller, state, idle }) => {
    await controller.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(resolve => setImmediate(resolve));
    state.setDemandData = value => { state.demandData = value; };
    state.setTrains = value => { state.trains = value; };
    await controller.cachedSimulation.setEnabled(true);
    await grid.onTileSelect('JP_KANAGAWA_MAINLAND');
    assert.notEqual(pending, null);
    invalid = true; state.gameSessionId = 'manual-session'; state.saveName = 'manual-save';
    state.cityCode = 'JP_TOKYO_MAINLAND';
    await controller.lifecycle.gameLoaded('manual-save');
    assert.equal(pending, null, 'the unrelated load must not inherit the old navigation token');
    assert.equal(controller.diagnostics.tileSimulationHandoff.status, 'cancelled');
    assert.equal(controller.cachedSimulation.snapshot().enabled, false);
    assert.equal(reloads.length, 1, 'the manual save is adopted even while the abandoned transition was not ready');
    assert.equal(reloads[0][1], 'JP_TOKYO_MAINLAND');
    assert.equal(reloads[0][2], 'manual-save');
    assert.equal(reloads[0][3].nativeSessionId, 'manual-session');
    assert.equal(runtime.getActiveTileId(), 'JP_TOKYO_MAINLAND', 'the real runtime must adopt the manual save');
    assert.equal(runtime.world.pendingTransition, null, 'no staged source snapshot may remain rooted');
  });
});

for (const { timeoutFirst = false, manualInstead = false } of [{}, { timeoutFirst: true }, { manualInstead: true }]) test(`city-load waits for the primary native handoff before consuming proof (timeoutFirst=${timeoutFirst}, manualInstead=${manualInstead})`, async t => {
  let grid; let pending = null; let activeTile = 'JP_TOKYO_MAINLAND';
  let snapshot; let handoff; let completed = 0; let nativeLoads = 0;
  const readActive = GeographicContextOverlayController.prototype.readRuntimeActiveTileId;
  t.mock.method(GeographicContextOverlayController.prototype, 'readRuntimeActiveTileId', function () {
    grid = this; return readActive.call(this);
  });
  t.mock.method(GeographicContextOverlayController.prototype, 'attachMap', function (map) { this.map = map; });
  t.mock.method(GeographicContextOverlayController.prototype, 'refresh', () => {});
  t.mock.method(WorldTileRuntime.prototype, 'getActiveTileId', () => activeTile);
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  t.mock.method(HashCityNavigationAdapter.prototype, 'pending', () => pending);
  t.mock.method(HashCityNavigationAdapter.prototype, 'navigateTo', transition => { pending = transition; });
  t.mock.method(HashCityNavigationAdapter.prototype, 'complete', () => { pending = null; });
  const waitForLoad = SubwayBuilderGameAdapter.prototype.awaitNativeTileHandoff;
  let waits = 0;
  t.mock.method(SubwayBuilderGameAdapter.prototype, 'awaitNativeTileHandoff', function (options) {
    waits++;
    return timeoutFirst && waits === 1 ? Promise.resolve({ state: 'timeout', reason: 'test-pending-read-timeout' })
      : waitForLoad.call(this, options);
  });
  t.mock.method(WorldTileRuntime.prototype, 'stageNavigationTransition', async function (tileId) {
    const state = this.game.callbacks.getState();
    snapshot = { id: 'delayed-native-save', gameSessionId: state.gameSessionId, cityCode: state.cityCode,
      data: { ...Object.fromEntries(SHARED_TRANSIT_STATE_KEYS.map(key => [key, structuredClone(state[key])])),
        money: state.money, timeConfig: structuredClone(state.timeConfig) } };
    const marker = { schemaVersion: 1, reason: 'tile-navigation', recoveryId: 'delayed-read',
      transitionId: 'delayed-native', sourceCityCode: state.cityCode, destinationCityCode: tileId };
    handoff = { ...structuredClone(snapshot), cityCode: tileId, name: 'primary-native-handoff',
      metadata: { openWorldNativeRecovery: marker } };
    this.game.armNativeTileHandoff(nativeHandoffEvidence(snapshot, marker), snapshot);
    return { status: 'reload-required', worldId: 'session-A', from: activeTile, tileId, transitionId: marker.transitionId };
  });
  t.mock.method(WorldTileRuntime.prototype, 'completeStagedTransition', async function (tileId, options) {
    completed++;
    const proof = this.game.tryReuseStagedNativeHandoff({ transitionId: options.navigationTransition.transitionId,
      destinationCityCode: tileId, sourceCityCode: 'JP_TOKYO_MAINLAND', snapshot, nativeNetwork: snapshot.data });
    assert.equal(proof.reused, true, JSON.stringify(proof));
    activeTile = tileId;
    await this.demandExtensions.activate({ worldId: this.getWorldId(), tileId });
  });
  await harness(async ({ controller, api, state, hooks, idle, errors }) => {
    const map = { on() {}, off() {}, getSource: () => null, getLayer: () => null, isStyleLoaded: () => true };
    api.utils.getMap = () => map;
    await controller.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(resolve => setImmediate(resolve));
    state.setDemandData = value => { state.demandData = value; };
    state.setTrains = value => { state.trains = value; };
    state.setTimeConfig({ elapsedSeconds: 25000, paused: false });
    await controller.cachedSimulation.setEnabled(true);
    let loadedHook;
    state.loadSave = save => {
      nativeLoads++;
      Object.assign(state, structuredClone(save.data), { cityCode: save.cityCode, gameSessionId: save.gameSessionId });
      state.setTimeConfig({ paused: true });
      // Native hook callbacks are synchronous notifications; the original
      // loadSave completes before any returned mod promise is awaited.
      loadedHook = controller.lifecycle.gameLoaded(save.name);
    };
    await grid.onTileSelect('JP_KANAGAWA_MAINLAND');
    const primaryLoadSave = state.loadSave;
    hooks.get('onGameEnd')();
    state.cityCode = 'JP_KANAGAWA_MAINLAND'; state.gameSessionId = 'temporary-city-init';
    await controller.lifecycle.gameInit();
    let cityLoad = controller.lifecycle.cityLoad(state.cityCode, { authoritative: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, 0, 'city-load must not consume armed proof before the pending save is read');
    assert.equal(nativeLoads, 0);
    assert.equal(state.timeConfig.elapsedSeconds, 25000);
    if (timeoutFirst) {
      await cityLoad;
      assert.equal(controller.diagnostics.tileSimulationHandoff.status, 'error');
      await state.handleIncrementGameState();
      assert.equal(state.timeConfig.elapsedSeconds, 25000, 'timeout retains the tick hold');
      cityLoad = controller.diagnostics.retryTileSimulation();
      await new Promise(resolve => setImmediate(resolve));
    }
    primaryLoadSave(manualInstead ? { ...handoff, id: 'manual-save', gameSessionId: 'manual-session', metadata: {} } : handoff);
    await loadedHook;
    if (manualInstead) {
      await cityLoad;
      assert.equal(completed, 0, 'an unrelated primary load must cancel the waiting old transition');
      assert.equal(nativeLoads, 1);
      assert.equal(pending, null);
      assert.equal(controller.cachedSimulation.snapshot().enabled, false);
      assert.equal(controller.diagnostics.tileSimulationHandoff.status, 'cancelled');
      assert.equal(state.gameSessionId, 'manual-session');
      return;
    }
    // A pre-map retry waits for deferred finance too; allow that separate phase.
    if (timeoutFirst) {
      while (!idle.length) await new Promise(resolve => setImmediate(resolve));
      idle.shift()();
    }
    await cityLoad;
    assert.equal(completed, 1);
    assert.equal(nativeLoads, 1, 'the exact primary native load is reused');
    assert.equal(pending, null);
    assert.equal(state.gameSessionId, 'session-A');
    assert.equal(state.timeConfig.paused, false, 'source pause choice is restored after the native load');
    assert.equal(controller.diagnostics.currentWorld.nativeSessionId, 'session-A', 'identity binding uses the restored UUID');
    if (!timeoutFirst) idle.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.diagnostics.tileSimulationHandoff.status, 'ready');
    assert.equal(errors.length, timeoutFirst ? 1 : 0);
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

test('native daily dispatch remains active and five wrapped cached midnights notify demand extensions', async t => {
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  await harness(async ({ controller, state, idle, errors, nativeDays }) => {
    await controller.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(setImmediate);
    state.setTimeConfig({ elapsedSeconds: 86390, paused: false });
    await state.handleIncrementGameState();
    assert.deepEqual(nativeDays, [1], 'native positive control dispatches an elapsed-day index');
    state.setDemandData = value => { state.demandData = value; };
    state.setTrains = value => { state.trains = value; };
    await controller.cachedSimulation.setEnabled(true);
    const bridge = globalThis.SubwayBuilderOpenWorldDemand, events = [];
    const unsubscribe = bridge.subscribeDayChange(event => events.push(event));
    try {
      assert.deepEqual(events, [], 'subscription never replays missed days');
      for (let day = 1; day <= 5; day++) {
        assert.equal(bridge.getContext().demandReady, true);
        assert.equal(controller.cachedSimulation.snapshot().status, 'ready');
        state.setTimeConfig({ elapsedSeconds: day * 86400 - 10, paused: false, timeSpeed: 'ultrafast' });
        await state.handleIncrementGameState();
        assert.equal(state.timeConfig.elapsedSeconds, day * 86400);
      }
      assert.deepEqual(events.map(event => event.day), [1, 2, 3, 4, 5]);
      assert.ok(events.every(event => event.context.nativeSessionId === 'session-A' && event.context.demandReady));
      assert.equal(controller.cachedSimulation.snapshot().ticks, 5);
      assert.deepEqual(nativeDays, [1], 'cached mode bypasses the native day emitter');
      assert.equal(controller.diagnostics.demandDayEvents.version, 1);
      assert.deepEqual(controller.diagnostics.demandDayEvents.latest, { day: 5, status: 'published', delivered: 1, failed: 0 });
      assert.deepEqual(errors, []);
    } finally { unsubscribe(); }
  }, { nativeDayTicks: true });
});

test('a cached midnight tick waits for async demand day subscribers', async t => {
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  const gate = deferred(), entered = deferred();
  await harness(async ({ controller, state, idle }) => {
    await controller.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(setImmediate);
    state.setDemandData = value => { state.demandData = value; };
    state.setTrains = value => { state.trains = value; };
    await controller.cachedSimulation.setEnabled(true);
    const unsubscribe = globalThis.SubwayBuilderOpenWorldDemand.subscribeDayChange(async () => {
      entered.resolve(); await gate.promise;
    });
    try {
      state.setTimeConfig({ elapsedSeconds: 86390, paused: false, timeSpeed: 'ultrafast' });
      let finished = false;
      const tick = state.handleIncrementGameState().then(() => { finished = true; });
      await entered.promise;
      assert.equal(finished, false, 'checkpoint subscribers settle before the clock can take another tick');
      const duplicate = state.handleIncrementGameState();
      assert.equal(state.timeConfig.elapsedSeconds, 86400);
      gate.resolve(); await Promise.all([tick, duplicate]);
      assert.equal(controller.cachedSimulation.snapshot().ticks, 1);
    } finally { gate.resolve(); unsubscribe(); }
  });
});

test('a same-session save reload during midnight finance cannot publish the obsolete day', async t => {
  const cross = deferred(), entered = deferred();
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async options => {
    if (options.reason !== 'midnight-change') return { status: 'cached' };
    entered.resolve(); return cross.promise;
  });
  await harness(async ({ controller, state, hooks, idle }) => {
    await controller.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(setImmediate);
    state.setDemandData = value => { state.demandData = value; };
    state.setTrains = value => { state.trains = value; };
    await controller.cachedSimulation.setEnabled(true);
    const bridge = globalThis.SubwayBuilderOpenWorldDemand, events = [], expected = bridge.getContext();
    const unsubscribe = bridge.subscribeDayChange(event => events.push(event));
    try {
      hooks.get('onScheduleChange')();
      state.setTimeConfig({ elapsedSeconds: 86390, paused: false, timeSpeed: 'ultrafast' });
      const tick = state.handleIncrementGameState(); await entered.promise;
      const reload = controller.lifecycle.gameLoaded('save-A');
      assert.equal(bridge.getContext().nativeSessionId, expected.nativeSessionId);
      assert.notEqual(bridge.getContext().epoch, expected.epoch);
      cross.resolve({ status: 'recalculated' }); await Promise.all([tick, reload]);
      assert.deepEqual(events, []);
      assert.equal(controller.diagnostics.demandDayEvents.latest.status, 'superseded');
    } finally { cross.resolve({ status: 'recalculated' }); unsubscribe(); }
  });
});

test('schedule changes queue active demand into the midnight cross-network batch and hold the tick', async t => {
  const cross = deferred(), entered = deferred();
  let midnightCalls = 0;
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async options => {
    if (options.reason !== 'midnight-change') return { status: 'cached' };
    midnightCalls++; entered.resolve(); return cross.promise;
  });
  await harness(async ({ controller, state, hooks, idle }) => {
    await controller.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(resolve => setImmediate(resolve));
    state.setDemandData = value => { state.demandData = value; };
    state.setTrains = value => { state.trains = value; };
    await controller.cachedSimulation.setEnabled(true);
    assert.equal(controller.cachedSimulation.snapshot().calculations, 1);
    hooks.get('onScheduleChange')(); hooks.get('onScheduleChange')();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.cachedSimulation.snapshot().calculations, 1);
    assert.equal(controller.cachedSimulation.snapshot().pendingMidnightRefresh, true);
    state.setTimeConfig({ elapsedSeconds: 86390, paused: false, timeSpeed: 'ultrafast' });
    let completed = false;
    const tick = state.handleIncrementGameState().then(() => { completed = true; });
    await entered.promise;
    hooks.get('onDayChange')(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.cachedSimulation.snapshot().calculations, 2);
    assert.equal(state.timeConfig.elapsedSeconds, 86400);
    assert.equal(completed, false, 'active completion cannot release the tick while cross work is pending');
    const duplicateTick = state.handleIncrementGameState();
    cross.resolve({ status: 'recalculated' });
    await Promise.all([tick, duplicateTick]);
    assert.equal(midnightCalls, 1);
    assert.equal(state.timeConfig.elapsedSeconds, 86400);
    assert.equal(controller.diagnostics.midnightCommuteRefresh().lastRun.activeTileRefresh.status, 'refreshed');
    hooks.get('onScheduleChange')();
    hooks.get('onDayChange')(2); // Native UI uses day 2 for the same elapsed-day boundary.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(midnightCalls, 1, 'a late native day label cannot consume tomorrow\'s edits');
    assert.equal(controller.cachedSimulation.snapshot().pendingMidnightRefresh, true);
  });
});

for (const [name, reason, change] of [
  ['blank route creation', null, ({ state }) => state.setRoutes([...state.routes, { id: 'blank-2', stNodes: [] }])],
  ['blank route deletion', null, ({ state }) => state.deleteRoute('blank')],
  ['route color', null, ({ state }) => state.updateRouteProperty('r', 'color', 'blue')],
  ['unchanged train count', null, ({ state }) => state.updateRouteProperty('r', 'idealTrainCount', 1)],
  ['blueprint track construction', null, ({ state }) => state.setTracks({ newTracks: [{ id: 'draft', buildType: 'blueprint' }] })],
  ['fleet and inventory replacement', null, ({ state }) => { state.trains = [...state.trains]; state.ownedTrainCount = 5; }],
  ['committed train count', 'route-service-change', ({ state }) => state.updateRouteProperty('r', 'idealTrainCount', 2)],
  ['committed stops', 'route-service-change', ({ state }) => state.confirmRouteChange()],
  ['served route deletion', 'route-service-change', ({ state }) => state.deleteRoute('r')],
  ['schedule hook', 'schedule-change', ({ hooks }) => hooks.get('onScheduleChange')()],
  ['ticket fare hook', 'fare-change', ({ state, hooks }) => { state.transitCost = 3; hooks.get('onTicketPriceChanged')(3); }],
  ['fare-group action', 'fare-change', ({ state }) => state.setFareGroups([])],
]) test(`active and cross-tile queue conditions agree for ${name}`, async t => {
  t.mock.method(WorldTileRuntime.prototype, 'recalculateCrossTileModeShare', async () => ({ status: 'cached' }));
  await harness(async context => {
    const { controller, state, idle } = context;
    state.updateRouteProperty = (id, key, value) => { state.routes = state.routes.map(route => route.id === id ? { ...route, [key]: value } : route); };
    state.deleteRoute = id => { state.routes = state.routes.filter(route => route.id !== id); };
    state.confirmRouteChange = () => { state.routes = state.routes.map(route => route.id === 'r' ? { ...route, stNodes: [{ id: 'a' }, { id: 'b' }] } : route); };
    state.setFareGroups = value => { state.fareGroups = value; };
    await controller.lifecycle.gameLoaded('save-A');
    idle.shift()(); await new Promise(resolve => setImmediate(resolve));
    state.routes = [{ id: 'r', stNodes: [{ id: 'a' }], idealTrainCount: 1 }, { id: 'blank', stNodes: [] }];
    state.previewRoute = { id: 'r' };
    state.setDemandData = value => { state.demandData = value; };
    state.setTrains = value => { state.trains = value; };
    state.setTimeConfig({ paused: true, timeSpeed: 'ultrafast', elapsedSeconds: 25000 });
    await controller.cachedSimulation.setEnabled(true);
    assert.equal(controller.cachedSimulation.snapshot().status, 'ready');
    change(context);
    state.setTimeConfig({ paused: false });
    await state.handleIncrementGameState();
    assert.deepEqual(controller.diagnostics.midnightCommuteRefresh().dirtyReasons, reason ? [reason] : []);
    assert.equal(controller.cachedSimulation.snapshot().pendingMidnightRefresh, reason !== null);
    assert.equal(controller.cachedSimulation.snapshot().calculations, 1);
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
