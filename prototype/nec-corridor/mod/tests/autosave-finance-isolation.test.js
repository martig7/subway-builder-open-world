import { createSubwayBuilderHostState } from '../../../../open-world-platform/testkit/subway-builder-host.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { startOpenWorld } from '../../../../open-world-platform/src/runtime/start-open-world.js';
import definition from '../../../../worlds/nec-corridor/world.json' with { type: 'json' };
import catalogSource from '../../../../worlds/nec-corridor/geography/tile-views.json' with { type: 'json' };

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
  const activeTileId = 'NEC_CM01_RM01';
  const counters = {
    generateSave: 0,
    loadSave: 0,
    sessionWrites: 0,
    sessionRemovals: 0,
    toolbarRegistrations: 0,
    unregisteredComponents: [],
  };
  const state = createSubwayBuilderHostState({
    cityCode: activeTileId,
    gameSessionId: 'autosave-finance-isolation-session',
    saveName: 'open-world-runtime',
    money: 9_876_543,
    transitCost: 2.5,
    fareGroups: [],
    gameMode: 'easy',
    timeConfig: { elapsedSeconds: 8 * 3_600, paused: false },
    stations: [{ id: 'source-station', coords: [-74, 40.7], stNodeIds: ['source-node'] }],
    stNodes: [{ id: 'source-node', stationId: 'source-station' }],
    routes: [{
      id: 'source-route',
      stationIds: ['source-station'],
      trackIds: ['source-track'],
      stNodes: [{ id: 'source-node', stationId: 'source-station' }],
    }],
    trains: [],
    tracks: [{ id: 'source-track', coords: [[-74, 40.7], [-73.99, 40.7]] }],
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
    portolanDiagram: null,
    portolanProgress: null,
    trackEditSession: null,
    completedCommutes: [],
    mapViewport: {},
    generateSave() {
      counters.generateSave += 1;
      return {
        name: 'open-world-runtime',
        cityCode: state.cityCode,
        gameSessionId: state.gameSessionId,
        viewport: {},
        data: {
          cityCode: state.cityCode,
          elapsedSeconds: state.timeConfig.elapsedSeconds,
          money: state.money,
          stations: structuredClone(state.stations),
          stNodes: structuredClone(state.stNodes),
          routes: structuredClone(state.routes),
          trains: structuredClone(state.trains),
          tracks: structuredClone(state.tracks),
          trackGroups: structuredClone(state.trackGroups),
          signals: structuredClone(state.signals),
          stationGroups: structuredClone(state.stationGroups),
          routeFinancials: structuredClone(state.routeFinancials),
          financialHistory: structuredClone(state.financialHistory),
        },
      };
    },
    loadSave(snapshot) {
      counters.loadSave += 1;
      const data = snapshot?.data ?? snapshot;
      for (const key of [
        'stations', 'stNodes', 'routes', 'trains', 'tracks',
        'trackGroups', 'signals', 'stationGroups', 'routeFinancials', 'financialHistory',
      ]) {
        if (data?.[key] !== undefined) state[key] = structuredClone(data[key]);
      }
      if (Number.isFinite(data?.money)) state.money = data.money;
      if (Number.isFinite(data?.elapsedSeconds)) {
        state.timeConfig = { ...state.timeConfig, elapsedSeconds: data.elapsedSeconds };
      }
    },

  });
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
      onBlueprintPlaced: (callback) => { hooks.blueprintPlaced = callback; return () => {}; },
      onTrackChange: (callback) => { hooks.trackChange = callback; return () => {}; },
      onTrackBuilt: (callback) => { hooks.trackBuilt = callback; return () => {}; },
      onScheduleChange: (callback) => { hooks.scheduleChange = callback; return () => {}; },
      onDayChange: (callback) => { hooks.dayChange = callback; return () => {}; },
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
    electron: globalThis.electron,
    location: globalThis.location,
    api: globalThis.SubwayBuilderAPI,
    callbacks: globalThis.__subwayBuilder_storeCallbacks__,
    fetch: globalThis.fetch,
    sessionStorage: globalThis.sessionStorage,
    requestIdleCallback: globalThis.requestIdleCallback,
    generation: globalThis.__necCorridorGeneration__,
    diagnostics: globalThis.__necCorridorDiagnostics__,
    coordinator: globalThis.__nyStateScopedStorageCoordinator__,
    embeddedCommutes: globalThis.__NEC_CROSS_COMMUTE_CATALOG__,
    embeddedDemand: globalThis.__NEC_CROSS_DEMAND_GZIP_BASE64__,
    embeddedRecovery: globalThis.__NEC_NETWORK_RECOVERY_GZIP_BASE64__,
    consoleDebug: console.debug,
    consoleError: console.error,
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
  globalThis.__NEC_CROSS_COMMUTE_CATALOG__ = {
    buildHash: 'autosave-finance-isolation', buckets: [], gateways: [],
  };
  globalThis.__NEC_CROSS_DEMAND_GZIP_BASE64__ = gzipSync(JSON.stringify({
    schemaVersion: 1, points: [], pops: [], gateways: [], popFields: [],
  })).toString('base64');
  globalThis.__NEC_NETWORK_RECOVERY_GZIP_BASE64__ = gzipSync(JSON.stringify({})).toString('base64');
  console.debug = () => {};
  const consoleErrors = [];
  console.error = (...args) => { consoleErrors.push(args); };
  console.info = () => {};
  console.log = () => {};
  let pendingRecovery = null;
  globalThis.location = { hash: '#/game' };
  globalThis.electron = {
    getPendingSave: async () => ({ success: true, data: pendingRecovery }),
    setPendingSave: async (save) => { pendingRecovery = save; return { success: true }; },
    reloadWindow() {},
  };
  let mod;
  try {
    mod = startOpenWorld({
      definition,
      catalogSource,
      artifacts: {
        commuteCatalog: globalThis.__NEC_CROSS_COMMUTE_CATALOG__,
        crossDemandGzipBase64: globalThis.__NEC_CROSS_DEMAND_GZIP_BASE64__,
      },
    });
    assert.equal(globalThis.__necCorridorDiagnostics__?.saveAuthorityVersion, 'native-save-authority-v1');
    assert.equal(globalThis.__necCorridorDiagnostics__?.capability?.supported, true);
    assert.equal(globalThis.__necCorridorDiagnostics__?.capability?.inspectedGameVersion, '1.7.0');
    assert.equal(globalThis.__necCorridorDiagnostics__?.capability?.interliningModel, 'portolan-v1');
    assert.deepEqual(globalThis.__necCorridorDiagnostics__?.capability?.missing, []);
    assert.deepEqual(counters.unregisteredComponents.slice(0, 2), [
      ['top-bar', 'nec-corridor-world-saves'],
      ['main-menu', 'nec-corridor-world-saves-home'],
    ]);
    assert.equal(typeof hooks.gameLoaded, 'function');
    assert.equal(typeof hooks.gameSaved, 'function');
    assert.equal(typeof hooks.mapReady, 'function');

    await hooks.gameLoaded('open-world-runtime');
    hooks.mapReady(map);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (globalThis.__necCorridorDiagnostics__?.startup) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(globalThis.__necCorridorDiagnostics__?.startup, 'fixture must reach a ready runtime');

    globalThis.electron.reloadWindow();
    await globalThis.__openWorldNativeReloadRecoveryGuard__.flush();
    const generatedForRecovery = counters.generateSave;
    state.money += 10;
    globalThis.electron.reloadWindow();
    await globalThis.__openWorldNativeReloadRecoveryGuard__.flush();
    assert.equal(counters.generateSave, generatedForRecovery, 'later recovery must reuse the native snapshot template');
    assert.equal(pendingRecovery.data.money, state.money, 'template reuse must capture current live state');
    state.money -= 10;
    pendingRecovery = null;

    const navigationOnlyKey = 'nec-corridor:pending-navigation';
    const destinationTileId = 'NEC_CM01_RM02';
    const sourceMoney = state.money;
    const sourceHistory = structuredClone(state.financialHistory);
    const sourceRoutes = structuredClone(state.routes);
    const sourceTracks = structuredClone(state.tracks);
    sessionValues.set(navigationOnlyKey, JSON.stringify({
      worldId: 'autosave-finance-isolation-world',
      tileId: destinationTileId,
      from: activeTileId,
      transitionId: 'autosave-finance-isolation-world:tile-navigation',
    }));

    // Subway Builder emits game-end/game-init while its router initializes the
    // destination city. That is still a Tile View change, not a new World.
    hooks.gameEnd();
    state.cityCode = destinationTileId;
    state.gameSessionId = 'tile-navigation-native-session';
    state.saveName = null;
    state.money = 3_000_000;
    state.financialHistory = {
      entries: [], lastHourTimestamp: 0,
      currentHourRevenue: 0, currentHourExpenses: 0,
      currentHourExpenseCategories: {},
    };
    state.stations = [];
    state.stNodes = [];
    state.routes = [];
    state.trains = [];
    state.tracks = [];
    const errorsBeforeNavigationOnlyCityLoad = consoleErrors.length;
    await hooks.gameInit();
    await hooks.cityLoad(destinationTileId);
    assert.equal(
      consoleErrors.length,
      errorsBeforeNavigationOnlyCityLoad,
      'an explicit navigation token must repair a missing staged transition instead of reporting completion failure',
    );
    assert.equal(
      sessionValues.has(navigationOnlyKey),
      false,
      'a repaired navigation token must be consumed after the destination becomes authoritative',
    );
    assert.equal(state.money, sourceMoney, 'tile initialization must not replace the source balance');
    assert.deepEqual(state.financialHistory, sourceHistory,
      'tile initialization must not replace the source financial history');
    assert.deepEqual(state.routes, sourceRoutes,
      'tile initialization must restore the source routes');
    assert.deepEqual(state.tracks, sourceTracks,
      'tile initialization must restore the source rail');

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

    scopedStorage.operations.length = 0;
    hooks.gameSaved('open-world-runtime');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(
      scopedStorage.operations,
      [],
      'an internally generated runtime snapshot must not persist save metadata',
    );

    assert.equal(typeof hooks.gameEnd, 'function');
    assert.equal(typeof hooks.gameInit, 'function');
    const previousRoutes = globalThis.__necCorridorRoutePathRuntimeV1__;
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
      const restarted = globalThis.__necCorridorDiagnostics__?.authoritativeLoads?.some((event) => (
        event.segment === 'lifecycle-start'
        && event.nativeSessionId === 'brand-new-native-session'
      ));
      if (restarted && counters.toolbarRegistrations > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.ok(
      globalThis.__necCorridorDiagnostics__?.authoritativeLoads?.some((event) => (
        event.segment === 'lifecycle-start'
        && event.nativeSessionId === 'brand-new-native-session'
      )),
      'onGameInit after game end must start a new runtime rather than retaining the old world',
    );
    assert.ok(counters.toolbarRegistrations > 0, 'new-game startup must restore the in-game panels');
    assert.equal(globalThis.__necCorridorDiagnostics__?.currentWorld?.worldId, 'brand-new-native-session');
    const newRuntimeReady = globalThis.__necCorridorDiagnostics__?.authoritativeLoads
      ?.findLast((event) => event.segment === 'runtime-ready-for-ui');
    assert.equal(
      newRuntimeReady?.runtimeView?.worldId,
      'brand-new-native-session',
      'new-game startup must replace the old runtime world, not merely restore its panels',
    );
    assert.notEqual(globalThis.__necCorridorRoutePathRuntimeV1__, previousRoutes, 'new games need fresh route resources');
    assert.ok(globalThis.__necCorridorRoutePathRuntimeV1__);
    hooks.scheduleChange();
    hooks.dayChange(2);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (globalThis.__necCorridorDiagnostics__?.latestCrossModeShare?.reason === 'midnight-change') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(globalThis.__necCorridorDiagnostics__?.latestCrossModeShare?.reason, 'midnight-change');
  } finally {
    mod?.dispose();
    globalThis.electron = previous.electron;
    globalThis.location = previous.location;
    globalThis.SubwayBuilderAPI = previous.api;
    globalThis.__subwayBuilder_storeCallbacks__ = previous.callbacks;
    globalThis.fetch = previous.fetch;
    globalThis.sessionStorage = previous.sessionStorage;
    globalThis.requestIdleCallback = previous.requestIdleCallback;
    console.debug = previous.consoleDebug;
    console.error = previous.consoleError;
    console.info = previous.consoleInfo;
    console.log = previous.consoleLog;
    for (const [key, value] of [
      ['__necCorridorGeneration__', previous.generation],
      ['__necCorridorDiagnostics__', previous.diagnostics],
      ['__nyStateScopedStorageCoordinator__', previous.coordinator],
      ['__NEC_CROSS_COMMUTE_CATALOG__', previous.embeddedCommutes],
      ['__NEC_CROSS_DEMAND_GZIP_BASE64__', previous.embeddedDemand],
      ['__NEC_NETWORK_RECOVERY_GZIP_BASE64__', previous.embeddedRecovery],
    ]) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
