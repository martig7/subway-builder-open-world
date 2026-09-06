import { createSubwayBuilderHostState } from '../../../../open-world-platform/testkit/subway-builder-host.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { tileCatalog } from '../src/tile-catalog.js';
import { startOpenWorld } from '../../../../open-world-platform/src/runtime/start-open-world.js';
import definition from '../../../../worlds/nec-corridor/world.json' with { type: 'json' };
import catalogSource from '../../../../worlds/nec-corridor/geography/tile-views.json' with { type: 'json' };

function memoryStorage() {
  const values = new Map();
  return {
    values,
    get: async (key, fallback = null) => (values.has(key) ? structuredClone(values.get(key)) : fallback),
    set: async (key, value) => values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
  };
}

test('hot reload evaluates and caches commute demand when the public city getter is stale', async () => {
  const activeTileId = 'NEC_CM01_RM01';
  const inactiveTile = tileCatalog.tiles.find((tile) => tile.id !== activeTileId);
  assert.ok(inactiveTile);
  const [west, south, east, north] = inactiveTile.bounds;
  const latitude = (south + north) / 2;
  const homeLongitude = west + (east - west) * 0.35;
  const workLongitude = west + (east - west) * 0.65;
  const stations = [
    { id: 'home-station', coords: [homeLongitude, latitude], stNodeIds: ['home-node'], buildType: 'constructed' },
    { id: 'work-station', coords: [workLongitude, latitude], stNodeIds: ['work-node'], buildType: 'constructed' },
  ];
  const routes = [{
    id: 'inactive-route',
    stNodes: [{ id: 'home-node' }, { id: 'work-node' }],
    stComboTimings: [
      { stNodeIndex: 0, arrivalTime: 0, departureTime: 20 },
      { stNodeIndex: 1, arrivalTime: 600, departureTime: 620 },
    ],
    idealTrainCount: 2,
  }];
  const state = createSubwayBuilderHostState({
    cityCode: activeTileId,
    gameSessionId: 'hot-reload-native-session',
    saveName: 'open-world-runtime',
    money: 1_000_000,
    transitCost: 2.5,
    fareGroups: [],
    gameMode: 'easy',
    timeConfig: { elapsedSeconds: 8 * 3_600, paused: false },
    stations,
    stNodes: [{ id: 'home-node' }, { id: 'work-node' }],
    routes,
    trains: [],
    tracks: [],
    trackGroups: [],
    signals: [],
    stationGroups: [],
    routeFinancials: { byRoute: {}, lastHourTimestamp: 8 * 3_600, currentHour: {} },
    financialHistory: {
      entries: [], lastHourTimestamp: 8 * 3_600,
      currentHourRevenue: 0, currentHourExpenses: 0, currentHourExpenseCategories: {},
      openWorldAuthoritativeWorldId: 'hot-reload-demand-world',
    },
    demandData: { points: new Map(), popsMap: new Map() },
    portolanDiagram: null,
    portolanProgress: null,
    trackEditSession: null,
    completedCommutes: [],
    mapViewport: {},
    generateSave: () => ({
      name: 'open-world-runtime', cityCode: activeTileId,
      gameSessionId: state.gameSessionId, viewport: {},
      data: {
        cityCode: activeTileId,
        elapsedSeconds: state.timeConfig.elapsedSeconds,
        money: state.money,
        stations: structuredClone(state.stations),
        stNodes: structuredClone(state.stNodes),
        routes: structuredClone(state.routes),
        trains: [], tracks: [], trackGroups: [], signals: [], stationGroups: [],
        routeFinancials: structuredClone(state.routeFinancials),
        financialHistory: structuredClone(state.financialHistory),
      },
    }),
    loadSave() {},

  });
  const demand = {
    points: [
      { id: 'home', location: [homeLongitude, latitude], residents: 100, jobs: 0, popIds: ['inactive-pop'] },
      { id: 'work', location: [workLongitude, latitude], residents: 0, jobs: 100, popIds: ['inactive-pop'] },
    ],
    pops: [{
      id: 'inactive-pop', size: 100, residenceId: 'home', jobId: 'work',
      drivingSeconds: 3_600, drivingDistance: 25_000,
    }],
  };
  const scopedStorage = memoryStorage();
  const nativeDemandLoads = [];
  const debugEvents = [];
  const hooks = {};
  const map = {
    on() {}, off() {}, getSource: () => null, getZoom: () => 8,
    getCenter: () => ({ lng: homeLongitude, lat: latitude }),
  };
  const api = {
    version: '1.0.0',
    registerCity() {},
    storage: { scoped: () => scopedStorage },
    cities: { setCityDataFiles() {} },
    map: { setTileURLOverride() {}, setDefaultLayerVisibility() {} },
    utils: {
      getCities: () => [],
      // Subway Builder 1.7 retains the previous tile in this public closure;
      // the live Zustand snapshot above already names the active tile.
      getCityCode: () => 'NEC_CP00_RP00',
      getPathfindingRules: () => ({}),
      getMap: () => map,
      loadCityData: async (path) => {
        nativeDemandLoads.push(path);
        return demand;
      },
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
      onGameLoaded: (callback) => { hooks.gameLoaded = callback; return () => {}; },
      onMapReady: (callback) => { hooks.mapReady = callback; return () => {}; },
      onCityLoad: (callback) => { hooks.cityLoad = callback; return () => {}; },
      onHourChange: (callback) => { hooks.hourChange = callback; return () => {}; },
    }, { get: (target, key) => target[key] ?? (() => () => {}) }),
    ui: {
      addToolbarPanel() {}, unregisterComponent() {}, showNotification() {},
    },
  };
  const sessionValues = new Map();
  const sessionStorage = {
    getItem: (key) => sessionValues.get(key) ?? null,
    setItem: (key, value) => sessionValues.set(key, String(value)),
    removeItem: (key) => sessionValues.delete(key),
  };
  const previous = {
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
  globalThis.__NEC_CROSS_COMMUTE_CATALOG__ = { buildHash: 'mod-reload-demand', buckets: [], gateways: [] };
  globalThis.__NEC_CROSS_DEMAND_GZIP_BASE64__ = gzipSync(JSON.stringify({
    schemaVersion: 1, points: [], pops: [], gateways: [], popFields: [],
  })).toString('base64');
  globalThis.__NEC_NETWORK_RECOVERY_GZIP_BASE64__ = gzipSync(JSON.stringify({})).toString('base64');
  console.debug = (...args) => debugEvents.push(args);
  console.info = () => {};
  console.log = () => {};
  try {
    const openingMoney = state.money;
    startOpenWorld({
      definition,
      catalogSource,
      artifacts: {
        commuteCatalog: globalThis.__NEC_CROSS_COMMUTE_CATALOG__,
        crossDemandGzipBase64: globalThis.__NEC_CROSS_DEMAND_GZIP_BASE64__,
      },
    });
    assert.equal(typeof hooks.gameLoaded, 'function');
    assert.equal(typeof hooks.mapReady, 'function');
    await hooks.gameLoaded('open-world-runtime');
    hooks.mapReady(map);
    for (let attempt = 0; attempt < 100; attempt++) {
      const evaluated = debugEvents.find(([prefix, event]) => (
        prefix === '[Northeast Corridor Open World]'
        && event?.phase === 'off-tile-native-demand'
        && event.tileId === inactiveTile.id
        && event.dailyRevenue > 0
      ));
      const recalculated = debugEvents.find(([prefix, event]) => (
        prefix === '[Northeast Corridor Open World]'
        && event?.phase === 'cross-mode-share'
        && event.status === 'recalculated'
      ));
      if (evaluated && recalculated) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const evaluated = debugEvents.find(([prefix, event]) => (
      prefix === '[Northeast Corridor Open World]'
      && event?.phase === 'off-tile-native-demand'
      && event.tileId === inactiveTile.id
      && event.dailyRevenue > 0
    ));
    assert.ok(evaluated, 'hot reload must rebuild a positive inactive-tile revenue profile');
    assert.ok(debugEvents.some(([prefix, event]) => (
      prefix === '[Northeast Corridor Open World]'
      && event?.phase === 'cross-mode-share'
      && event.status === 'recalculated'
    )), 'hot-reload mode-share recovery must complete');
    assert.equal(
      globalThis.__necCorridorDiagnostics__.latestCrossModeShare?.tileId,
      activeTileId,
      'commute calculations must bind to the live store tile, not the stale public getter',
    );
    assert.ok(nativeDemandLoads.some((path) => path.includes(`/${inactiveTile.id}/`)));
    assert.equal(state.money, openingMoney, 'reload must rebuild profiles without changing native finance');
    assert.equal(state.financialHistory.currentHourExpenses, 0);

    assert.equal(typeof hooks.hourChange, 'function');
    let paidHour = null;
    for (let hour = 9; hour <= 32 && state.money === openingMoney; hour++) {
      state.timeConfig.elapsedSeconds = hour * 3_600;
      hooks.hourChange(hour);
      for (let attempt = 0; attempt < 20 && state.money === openingMoney; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (state.money > openingMoney) paidHour = hour;
    }
    assert.ok(paidHour !== null, 'an eligible hourly tick must post inactive-tile revenue');
    assert.equal(state.financialHistory.currentHourExpenses, 0, 'the mod must never post expenses');

    const moneyAfterFirstReceipt = state.money;
    hooks.hourChange(paidHour);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.money, moneyAfterFirstReceipt, 'the native hourly receipt must be idempotent');
    const revenueReport = await globalThis.__necCorridorDiagnostics__.revenueSnapshot();
    assert.equal(revenueReport.activeTileId, activeTileId);
    assert.equal(revenueReport.lifecycle.observedCityCode, activeTileId);
    assert.equal(revenueReport.lifecycle.ready, true);
    assert.ok(revenueReport.inactiveEstimatedDailyRevenue > 0);
    assert.equal(revenueReport.lastPosting.status, 'already-posted');
    assert.equal(revenueReport.latestSettlement.backgroundRevenue, 0);
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
