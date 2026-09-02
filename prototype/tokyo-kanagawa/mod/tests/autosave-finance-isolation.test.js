import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { startOpenWorld } from '../../../../open-world-platform/src/runtime/start-open-world.js';
import definition from '../../../../worlds/tokyo-kanagawa/world.json' with { type: 'json' };
import catalogSource from '../../../../worlds/tokyo-kanagawa/geography/tile-views.json' with { type: 'json' };
import boundaryOverlay from '../../../../worlds/tokyo-kanagawa/geography/world-boundary-overlay.json' with { type: 'json' };

function memoryStorage() {
  const values = new Map();
  const operations = [];
  return {
    values,
    operations,
    get: async (key, fallback = null) => (values.has(key) ? structuredClone(values.get(key)) : fallback),
    set: async (key, value) => {
      operations.push({ type: 'set', key });
      values.set(key, structuredClone(value));
    },
    delete: async (key) => {
      operations.push({ type: 'delete', key });
      values.delete(key);
    },
  };
}

test('autosave is observational and cannot checkpoint or mutate native finance', async () => {
  const activeTileId = 'JP_TOKYO_MAINLAND';
  const counters = {
    generateSave: 0,
    loadSave: 0,
    sessionWrites: 0,
    sessionRemovals: 0,
    toolbarRegistrations: 0,
    unregisteredComponents: [],
  };
  const state = {
    cityCode: activeTileId,
    gameSessionId: 'autosave-finance-isolation-session',
    saveName: 'open-world-runtime',
    money: 9_876_543,
    transitCost: 2.5,
    fareGroups: [],
    timeConfig: { elapsedSeconds: 8 * 3_600, paused: false },
    stations: [],
    stNodes: [],
    routes: [],
    trains: [],
    tracks: [],
    trackGroups: [],
    signals: [],
    stationGroups: [],
    routeFinancials: { byRoute: {}, lastHourTimestamp: 8 * 3_600, currentHour: {} },
    financialHistory: {
      entries: [{ hour: 7, revenue: 1234, expenses: 567 }],
      lastHourTimestamp: 8 * 3_600,
      currentHourRevenue: 1234,
      currentHourExpenses: 567,
      currentHourExpenseCategories: { trains: 567 },
      openWorldAuthoritativeWorldId: 'autosave-finance-isolation-world',
    },
    demandData: { points: new Map(), popsMap: new Map() },
    mapViewport: {},
    generateSave() {
      counters.generateSave += 1;
      return {
        name: 'open-world-runtime',
        cityCode: activeTileId,
        gameSessionId: state.gameSessionId,
        viewport: {},
        data: {
          cityCode: activeTileId,
          elapsedSeconds: state.timeConfig.elapsedSeconds,
          money: state.money,
          stations: [], stNodes: [], routes: [], trains: [], tracks: [],
          trackGroups: [], signals: [], stationGroups: [],
          routeFinancials: structuredClone(state.routeFinancials),
          financialHistory: structuredClone(state.financialHistory),
        },
      };
    },
    loadSave() { counters.loadSave += 1; },
    loadInitialData() {},
    setTimeConfig(patch) { state.timeConfig = { ...state.timeConfig, ...patch }; },
    setFinancialHistory(value) { state.financialHistory = value; },
    setRouteFinancials(value) { state.routeFinancials = value; },
    addRevenue(amount) {
      state.money += amount;
      state.financialHistory.currentHourRevenue += amount;
    },
  };
  const scopedStorage = memoryStorage();
  const hooks = {};
  const map = {
    on() {}, off() {}, getSource: () => null, getZoom: () => 8,
    getCenter: () => ({ lng: -74, lat: 40.7 }),
  };
  const api = {
    version: '1.0.0',
    registerCity() {},
    storage: { scoped: () => scopedStorage },
    cities: { setCityDataFiles() {} },
    map: { setTileURLOverride() {}, setDefaultLayerVisibility() {} },
    utils: {
      getCities: () => [],
      getCityCode: () => state.cityCode,
      getPathfindingRules: () => ({}),
      getMap: () => map,
      loadCityData: async () => ({ points: [], pops: [] }),
      React: { createElement: () => null },
      components: { Button: () => null },
    },
    trains: { getTrainTypes: () => [] },
    gameState: {
      getGameSessionId: () => state.gameSessionId,
      getSaveName: () => state.saveName,
      getCurrentDay: () => 1,
      getStations: () => state.stations,
      getRoutes: () => state.routes,
      getTrains: () => state.trains,
    },
    hooks: new Proxy({
      onGameInit: (callback) => { hooks.gameInit = callback; return () => {}; },
      onGameEnd: (callback) => { hooks.gameEnd = callback; return () => {}; },
      onGameLoaded: (callback) => { hooks.gameLoaded = callback; return () => {}; },
      onGameSaved: (callback) => { hooks.gameSaved = callback; return () => {}; },
      onMapReady: (callback) => { hooks.mapReady = callback; return () => {}; },
      onCityLoad: (callback) => { hooks.cityLoad = callback; return () => {}; },
    }, { get: (target, key) => target[key] ?? (() => () => {}) }),
    ui: {
      addToolbarPanel(definition) { counters.toolbarRegistrations += 1; return definition; },
      registerComponent: (_placement, definition) => definition,
      unregisterComponent(placement, id) { counters.unregisteredComponents.push([placement, id]); },
      showNotification() {},
    },
  };
  const sessionValues = new Map();
  const sessionStorage = {
    getItem: (key) => sessionValues.get(key) ?? null,
    setItem: (key, value) => {
      counters.sessionWrites += 1;
      sessionValues.set(key, String(value));
    },
    removeItem: (key) => {
      counters.sessionRemovals += 1;
      sessionValues.delete(key);
    },
  };
  const previous = {
    api: globalThis.SubwayBuilderAPI,
    callbacks: globalThis.__subwayBuilder_storeCallbacks__,
    fetch: globalThis.fetch,
    sessionStorage: globalThis.sessionStorage,
    requestIdleCallback: globalThis.requestIdleCallback,
    generation: globalThis.__tokyoKanagawaGeneration__,
    diagnostics: globalThis.__tokyoKanagawaDiagnostics__,
    coordinator: globalThis.__nyStateScopedStorageCoordinator__,
    embeddedCommutes: globalThis.__TOKYO_KANAGAWA_CROSS_COMMUTE_CATALOG__,
    embeddedDemand: globalThis.__TOKYO_KANAGAWA_CROSS_DEMAND_GZIP_BASE64__,
    consoleDebug: console.debug,
    consoleInfo: console.info,
    consoleLog: console.log,
  };
  globalThis.SubwayBuilderAPI = api;
  globalThis.__subwayBuilder_storeCallbacks__ = {
    getState: () => state,
    setMoney: (money) => { state.money = money; },
    setTicketCost: (fare) => { state.transitCost = fare; },
  };
  globalThis.fetch = undefined;
  globalThis.sessionStorage = sessionStorage;
  globalThis.requestIdleCallback = (callback) => { queueMicrotask(callback); return 1; };
  globalThis.__TOKYO_KANAGAWA_CROSS_COMMUTE_CATALOG__ = {
    buildHash: 'autosave-finance-isolation', buckets: [], gateways: [],
  };
  globalThis.__TOKYO_KANAGAWA_CROSS_DEMAND_GZIP_BASE64__ = gzipSync(JSON.stringify({
    schemaVersion: 1, points: [], pops: [], gateways: [], popFields: [],
  })).toString('base64');
  console.debug = () => {};
  console.info = () => {};
  console.log = () => {};
  try {
    startOpenWorld({
      definition,
      catalogSource,
      boundaryOverlay,
      artifacts: {
        commuteCatalog: globalThis.__TOKYO_KANAGAWA_CROSS_COMMUTE_CATALOG__,
        crossDemandGzipBase64: globalThis.__TOKYO_KANAGAWA_CROSS_DEMAND_GZIP_BASE64__,
      },
    });
    assert.equal(globalThis.__tokyoKanagawaDiagnostics__?.saveAuthorityVersion, 'native-save-authority-v1');
    assert.deepEqual(counters.unregisteredComponents.slice(0, 3), [
      ['top-bar', 'nec-corridor-world-saves'],
      ['top-bar', 'tokyo-kanagawa-world-saves'],
      ['main-menu', 'tokyo-kanagawa-world-saves-home'],
    ]);
    assert.equal(typeof hooks.gameLoaded, 'function');
    assert.equal(typeof hooks.gameSaved, 'function');
    assert.equal(typeof hooks.mapReady, 'function');

    await hooks.gameLoaded('open-world-runtime');
    hooks.mapReady(map);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (globalThis.__tokyoKanagawaDiagnostics__?.startupRuntime) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(globalThis.__tokyoKanagawaDiagnostics__?.startupRuntime, 'fixture must reach a ready runtime');

    scopedStorage.operations.length = 0;
    counters.generateSave = 0;
    counters.loadSave = 0;
    counters.sessionWrites = 0;
    counters.sessionRemovals = 0;
    const openingMoney = state.money;
    const openingHistory = structuredClone(state.financialHistory);
    const openingRouteFinancials = structuredClone(state.routeFinancials);

    hooks.gameSaved('Autosave');
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepEqual(
      scopedStorage.operations,
      [],
      'autosave must not persist mod-owned save metadata',
    );
    assert.equal(counters.generateSave, 0, 'autosave must not generate an internal native snapshot');
    assert.equal(counters.loadSave, 0, 'autosave must not restore an internal native snapshot');
    assert.equal(counters.sessionWrites, 0, 'autosave must not create a native-save correlation token');
    assert.equal(counters.sessionRemovals, 0, 'autosave must not end or clear a native-save correlation token');
    assert.equal(state.money, openingMoney);
    assert.deepEqual(state.financialHistory, openingHistory);
    assert.deepEqual(state.routeFinancials, openingRouteFinancials);

    assert.equal(typeof hooks.gameEnd, 'function');
    assert.equal(typeof hooks.gameInit, 'function');
    hooks.gameEnd();
    state.gameSessionId = 'brand-new-native-session';
    state.saveName = null;
    state.money = 3_000_000_000;
    state.financialHistory = {
      entries: [], lastHourTimestamp: 0,
      currentHourRevenue: 0, currentHourExpenses: 0,
      currentHourExpenseCategories: {},
    };
    counters.toolbarRegistrations = 0;
    hooks.gameInit();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const restarted = globalThis.__tokyoKanagawaDiagnostics__?.authoritativeLoads?.some((event) => (
        event.segment === 'lifecycle-start'
        && event.nativeSessionId === 'brand-new-native-session'
      ));
      if (restarted && counters.toolbarRegistrations > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.ok(
      globalThis.__tokyoKanagawaDiagnostics__?.authoritativeLoads?.some((event) => (
        event.segment === 'lifecycle-start'
        && event.nativeSessionId === 'brand-new-native-session'
      )),
      'onGameInit after game end must start a new runtime rather than retaining the old world',
    );
    assert.ok(counters.toolbarRegistrations > 0, 'new-game startup must restore the in-game panels');
    assert.equal(globalThis.__tokyoKanagawaDiagnostics__?.currentWorld?.worldId, 'brand-new-native-session');
    const newRuntimeReady = globalThis.__tokyoKanagawaDiagnostics__?.authoritativeLoads
      ?.findLast((event) => event.segment === 'runtime-ready-for-ui');
    assert.equal(
      newRuntimeReady?.runtimeView?.worldId,
      'brand-new-native-session',
      'new-game startup must replace the old runtime world, not merely restore its panels',
    );
  } finally {
    globalThis.SubwayBuilderAPI = previous.api;
    globalThis.__subwayBuilder_storeCallbacks__ = previous.callbacks;
    globalThis.fetch = previous.fetch;
    globalThis.sessionStorage = previous.sessionStorage;
    globalThis.requestIdleCallback = previous.requestIdleCallback;
    console.debug = previous.consoleDebug;
    console.info = previous.consoleInfo;
    console.log = previous.consoleLog;
    for (const [key, value] of [
      ['__tokyoKanagawaGeneration__', previous.generation],
      ['__tokyoKanagawaDiagnostics__', previous.diagnostics],
      ['__nyStateScopedStorageCoordinator__', previous.coordinator],
      ['__TOKYO_KANAGAWA_CROSS_COMMUTE_CATALOG__', previous.embeddedCommutes],
      ['__TOKYO_KANAGAWA_CROSS_DEMAND_GZIP_BASE64__', previous.embeddedDemand],
    ]) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
