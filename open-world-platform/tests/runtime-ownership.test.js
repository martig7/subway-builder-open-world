import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { startOpenWorld } from '../src/runtime/start-open-world.js';
import definition from '../../worlds/tokyo-kanagawa/world.json' with { type: 'json' };
import catalogSource from '../../worlds/tokyo-kanagawa/geography/tile-views.json' with { type: 'json' };
import boundaryOverlay from '../../worlds/tokyo-kanagawa/geography/world-boundary-overlay.json' with { type: 'json' };

function createHookRegistry() {
  const callbacks = new Map();
  return {
    callbacks,
    api: new Proxy({}, {
      get(_target, name) {
        return (callback) => {
          const entries = callbacks.get(name) ?? [];
          entries.push(callback);
          callbacks.set(name, entries);
          return () => {
            const index = entries.indexOf(callback);
            if (index >= 0) entries.splice(index, 1);
          };
        };
      },
    }),
    count(name) {
      return callbacks.get(name)?.length ?? 0;
    },
  };
}

function createHost(activeCityCode, { publicCityCode = activeCityCode, currentMap = null } = {}) {
  const hooks = createHookRegistry();
  const cities = [];
  const state = {
    cityCode: activeCityCode,
    gameSessionId: 'runtime-ownership-session',
    timeConfig: { elapsedSeconds: 0, paused: false },
    stations: [],
    stNodes: [],
    routes: [],
    trains: [],
    tracks: [],
    trackGroups: [],
    signals: [],
    stationGroups: [],
    fareGroups: [],
    money: 1_000_000,
    transitCost: 2.5,
    routeFinancials: { byRoute: {}, lastHourTimestamp: 0, currentHour: {} },
    financialHistory: {
      entries: [],
      lastHourTimestamp: 0,
      currentHourRevenue: 0,
      currentHourExpenses: 0,
      currentHourExpenseCategories: {},
    },
    demandData: { points: new Map(), popsMap: new Map() },
    gameMode: 'easy',
    portolanDiagram: null,
    portolanProgress: null,
    generateSave() {
      return {
        name: 'ownership-test',
        cityCode: state.cityCode,
        gameSessionId: state.gameSessionId,
        viewport: {},
        data: {
          cityCode: state.cityCode,
          elapsedSeconds: state.timeConfig.elapsedSeconds,
          money: state.money,
          stations: [],
          stNodes: [],
          routes: [],
          trains: [],
          tracks: [],
          trackGroups: [],
          signals: [],
          stationGroups: [],
          routeFinancials: structuredClone(state.routeFinancials),
          financialHistory: structuredClone(state.financialHistory),
        },
      };
    },
    loadSave() {},
    loadInitialData() {},
    setCityCode(cityCode) { state.cityCode = cityCode; },
    setTimeConfig(patch) { state.timeConfig = { ...state.timeConfig, ...patch }; },
    setGameMode(gameMode) { state.gameMode = gameMode; },
    setRoutes(routes) { state.routes = routes; },
    setTracks({ newTracks = state.tracks, newTrackGroups = state.trackGroups } = {}) {
      state.tracks = newTracks;
      state.trackGroups = newTrackGroups;
    },
    recalculateAllRouteGeojsons: async () => {},
    setPreviewRoute() {},
    batchPreviewRouteUpdates: async () => {},
    confirmRouteChange() {},
    handleIncrementGameState: async () => {},
    simulateCommutes: async () => {},
    calculatePaths: async () => {},
    setFinancialHistory(value) { state.financialHistory = value; },
    setRouteFinancials(value) { state.routeFinancials = value; },
    addRevenue(amount) { state.money += amount; },
    addExpense(amount) { state.money -= amount; },
    recordRouteFinancials() {},
    setCompletedCommutes() {},
  };
  const api = {
    version: '1.0.0',
    registerCity(city) { cities.push(city); },
    cities: { setCityDataFiles() {} },
    map: {
      setTileURLOverride() {},
      setDefaultLayerVisibility() {},
    },
    utils: {
      getCities: () => cities,
      getCityCode: () => publicCityCode,
      getMap: () => typeof currentMap === 'function' ? currentMap() : currentMap,
      getPathfindingRules: () => ({}),
      loadCityData: async () => ({ points: [], pops: [] }),
      React: { createElement: () => null },
      components: { Button: () => null },
    },
    trains: { getTrainTypes: () => [] },
    gameState: {
      getGameSessionId: () => state.gameSessionId,
      getSaveName: () => 'ownership-test',
      getCurrentDay: () => 1,
      getStations: () => state.stations,
      getRoutes: () => state.routes,
      getTrains: () => state.trains,
    },
    hooks: hooks.api,
    ui: {
      addToolbarPanel: (panel) => panel,
      registerComponent: (_placement, component) => component,
      unregisterComponent() {},
      showNotification() {},
    },
  };
  return { api, cities, hooks, state };
}

test('a 1.7 runtime keeps the live store city when public and delayed lifecycle reports are stale', async () => {
  const cameraMoves = [];
  let center = { lng: -75, lat: 40 };
  const map = {
    getZoom: () => 11,
    getCenter: () => center,
    getSource: () => null,
    jumpTo: (camera) => { cameraMoves.push(camera); center = { lng: camera.center[0], lat: camera.center[1] }; },
    on() {},
    off() {},
  };
  let mapReads = 0;
  let overviewNavigation = null;
  const previousSessionStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: key => key === 'tokyo-kanagawa:pending-navigation' ? overviewNavigation : null,
    setItem() {}, removeItem() {} };
  const host = createHost('JP_TOKYO_MAINLAND', {
    publicCityCode: 'NEC_CP00_RP00',
    currentMap: () => ++mapReads >= 4 ? map : null,
  });
  const previousCallbacks = globalThis.__subwayBuilder_storeCallbacks__;
  const previousFetch = globalThis.fetch;
  const previousGeneration = globalThis.__tokyoKanagawaGeneration__;
  const previousDiagnostics = globalThis.__tokyoKanagawaDiagnostics__;
  const previousMapControllerVersion = globalThis.__openWorldCityScopedMapControllersVersion;
  globalThis.__subwayBuilder_storeCallbacks__ = {
    getState: () => host.state,
    setMoney() {},
    setTicketCost() {},
  };
  globalThis.fetch = undefined;
  try {
    const controller = startOpenWorld({
      definition,
      catalogSource,
      boundaryOverlay,
      subwayBuilderHost: host.api,
      artifacts: {
        commuteCatalog: { buildHash: 'runtime-ownership', buckets: [], gateways: [] },
        crossDemandGzipBase64: gzipSync(JSON.stringify({
          schemaVersion: 1,
          points: [],
          pops: [],
          gateways: [],
          popFields: [],
        })).toString('base64'),
      },
    });

    assert.equal(controller.status, 'active');
    assert.equal(controller.diagnostics.cityAuthorityVersion, 'zustand-city-authority-v6');
    assert.equal(controller.diagnostics.startupMapRecoveryVersion, 'startup-map-recovery-v1');
    assert.equal(host.hooks.count('onGameSaved'), 1, 're-entry must attach the owned runtime lifecycle');
    assert.equal(host.hooks.count('onMapReady'), 1, 're-entry must attach map repair to the current tile');

    await controller.lifecycle.cityLoad('JP_TOKYO_MAINLAND', { authoritative: true });
    assert.equal(controller.diagnostics.startupMapRefresh.status, 'refreshed');
    assert.equal(globalThis.__openWorldCityScopedMapControllersVersion, 'city-scoped-map-controllers-v3');

    host.hooks.callbacks.get('onMapReady')[0](map);
    assert.equal(globalThis.__tokyoKanagawaDiagnostics__.mapCameraRepair.cityCode, 'JP_TOKYO_MAINLAND');
    assert.equal(globalThis.__tokyoKanagawaDiagnostics__.mapCameraRepair.status, 'current');
    assert.equal(cameraMoves.length, 1, 'camera repair must target the live tile instead of the stale public city');
    map.getZoom = () => 4;
    overviewNavigation = JSON.stringify({ worldId: 'runtime-ownership-session', from: 'JP_KANAGAWA_MAINLAND', tileId: 'JP_TOKYO_MAINLAND', transitionId: 'camera-overview-test' });
    host.hooks.callbacks.get('onMapReady')[0](map);
    assert.equal(cameraMoves.length, 2, 'an explicit tile selection must recenter even from world overview');
    host.hooks.callbacks.get('onMapReady')[0](map);
    assert.equal(cameraMoves.length, 2, 'repeated readiness must not reset the overview again');
    overviewNavigation = null;
    map.getZoom = () => 11;

    await controller.lifecycle.cityLoad('JP_KANAGAWA_MAINLAND', { authoritative: true });

    assert.equal(host.state.cityCode, 'JP_TOKYO_MAINLAND');
    assert.equal(controller.diagnostics.latestAuthoritativeLoad.segment, 'lifecycle-city-load-ignored');
    assert.equal(controller.diagnostics.latestAuthoritativeLoad.reason, 'event-disagrees-with-live-store-and-runtime');

    host.state.cityCode = 'JP_KANAGAWA_MAINLAND';
    host.hooks.callbacks.get('onMapReady')[0](map);

    assert.equal(host.state.cityCode, 'JP_TOKYO_MAINLAND', 'map-ready must reclaim a late naked store write');
    assert.equal(controller.diagnostics.cityStoreRepair.status, 'reasserted');
    assert.equal(controller.diagnostics.cityStoreRepair.cityCode, 'JP_TOKYO_MAINLAND');
    assert.equal(controller.diagnostics.mapCameraRepair.cityCode, 'JP_TOKYO_MAINLAND');
  } finally {
    globalThis.sessionStorage = previousSessionStorage;
    globalThis.__subwayBuilder_storeCallbacks__ = previousCallbacks;
    globalThis.fetch = previousFetch;
    if (previousGeneration === undefined) delete globalThis.__tokyoKanagawaGeneration__;
    else globalThis.__tokyoKanagawaGeneration__ = previousGeneration;
    if (previousDiagnostics === undefined) delete globalThis.__tokyoKanagawaDiagnostics__;
    else globalThis.__tokyoKanagawaDiagnostics__ = previousDiagnostics;
    if (previousMapControllerVersion === undefined) delete globalThis.__openWorldCityScopedMapControllersVersion;
    else globalThis.__openWorldCityScopedMapControllersVersion = previousMapControllerVersion;
  }
});

test('a world stays dormant while the active city ID belongs to another registered world', async () => {
  const host = createHost('NEC_CP00_RP00');
  const previousCallbacks = globalThis.__subwayBuilder_storeCallbacks__;
  const previousFetch = globalThis.fetch;
  const previousGeneration = globalThis.__tokyoKanagawaGeneration__;
  const previousDiagnostics = globalThis.__tokyoKanagawaDiagnostics__;
  globalThis.__subwayBuilder_storeCallbacks__ = {
    getState: () => host.state,
    setMoney() {},
    setTicketCost() {},
  };
  globalThis.fetch = undefined;
  try {
    const controller = startOpenWorld({
      definition,
      catalogSource,
      boundaryOverlay,
      subwayBuilderHost: host.api,
      artifacts: {
        commuteCatalog: { buildHash: 'runtime-ownership', buckets: [], gateways: [] },
        crossDemandGzipBase64: gzipSync(JSON.stringify({
          schemaVersion: 1,
          points: [],
          pops: [],
          gateways: [],
          popFields: [],
        })).toString('base64'),
      },
    });

    assert.deepEqual(
      host.cities.map((city) => city.code).sort(),
      ['JP_KANAGAWA_MAINLAND', 'JP_TOKYO_MAINLAND'],
      'the dormant mod must still register its native city IDs',
    );
    assert.equal(host.hooks.count('onCityLoad'), 1, 'a dormant mod needs one ownership activation listener');
    assert.equal(host.hooks.count('onGameSaved'), 0, 'a foreign world must not observe native saves');
    assert.equal(host.hooks.count('onMapReady'), 0, 'a foreign world must not attach map runtime work');
    assert.equal(host.hooks.count('onHourChanged'), 0, 'a foreign world must not attach simulation work');

    assert.equal(controller.status, 'dormant');
    host.state.cityCode = 'JP_TOKYO_MAINLAND';
    await host.hooks.callbacks.get('onGameInit')[0]();
    assert.equal(host.hooks.count('onGameSaved'), 1, 'the runtime must activate when a registered city becomes current');
    assert.equal(host.hooks.count('onMapReady'), 1, 'activation must attach the owned map runtime');

    host.state.cityCode = 'NEC_CP00_RP00';
    await host.hooks.callbacks.get('onGameSaved')[0]('Autosave');
    assert.equal(
      globalThis.__tokyoKanagawaDiagnostics__.autosaves.length,
      0,
      'an activated runtime must ignore saves after the player enters another world',
    );
  } finally {
    globalThis.__subwayBuilder_storeCallbacks__ = previousCallbacks;
    globalThis.fetch = previousFetch;
    if (previousGeneration === undefined) delete globalThis.__tokyoKanagawaGeneration__;
    else globalThis.__tokyoKanagawaGeneration__ = previousGeneration;
    if (previousDiagnostics === undefined) delete globalThis.__tokyoKanagawaDiagnostics__;
    else globalThis.__tokyoKanagawaDiagnostics__ = previousDiagnostics;
  }
});
