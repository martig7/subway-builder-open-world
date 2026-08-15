import test from 'node:test';
import assert from 'node:assert/strict';

test('registers both panels when the mod reloads after the city is already loaded', async () => {
  const panels = [];
  let dayChangeCallback = null;
  let hourChangeCallback = null;
  let gameSavedCallback = null;
  const stored = new Map();
  let releaseWorldLoad;
  const worldLoadGate = new Promise((resolve) => { releaseWorldLoad = () => resolve(null); });
  const state = {
    cityCode: 'KCW', money: 1_000_000,
    timeConfig: { elapsedSeconds: 0, paused: false },
    stations: [], routes: [], trains: [], tracks: [],
    demandData: { points: new Map(), popsMap: new Map() },
    generateSave: () => ({ cityCode: 'KCW', data: { routes: [], tracks: [], stations: [], trains: [] }, viewport: {} }),
    loadSave() {}, loadInitialData() {},
    setTimeConfig: (patch) => { state.timeConfig = { ...state.timeConfig, ...patch }; },
  };
  const noopHook = () => () => {};
  const api = {
    version: '1.0.0',
    registerCity() {},
    storage: { scoped: () => ({
      get: async (key, fallback) => key.startsWith('world:') ? worldLoadGate : (stored.has(key) ? stored.get(key) : fallback),
      set: async (key, value) => stored.set(key, value),
      delete: async (key) => stored.delete(key),
    }) },
    cities: { setCityDataFiles() {} },
    map: { setTileURLOverride() {}, setDefaultLayerVisibility() {}, registerSource() {}, registerLayer() {} },
    utils: {
      getCities: () => [],
      getCityCode: () => 'KCW',
      getPathfindingRules: () => ({}),
      React: { createElement: () => null },
      components: { Button: () => null },
    },
    gameState: {
      getGameSessionId: () => 'hot-reload-world', getCurrentDay: () => 1,
      getStations: () => [], getRoutes: () => [], getTrains: () => [],
    },
    hooks: new Proxy({
      onCityLoad: noopHook,
      onMapReady: noopHook,
      onGameLoaded: (callback) => { queueMicrotask(() => callback('existing-save')); return () => {}; },
      onGameSaved: (callback) => { gameSavedCallback = callback; return () => {}; },
      onHourChange: (callback) => { hourChangeCallback = callback; return () => {}; },
      onDayChange: (callback) => { dayChangeCallback = callback; return () => {}; },
    }, { get: (target, key) => target[key] ?? noopHook }),
    ui: {
      addToolbarPanel: (panel) => panels.push(panel),
      unregisterComponent: (_placement, id) => {
        const index = panels.findIndex((panel) => panel.id === id);
        if (index >= 0) panels.splice(index, 1);
      },
      showNotification() {},
    },
  };
  const previous = {
    api: globalThis.SubwayBuilderAPI,
    callbacks: globalThis.__subwayBuilder_storeCallbacks__,
    fetch: globalThis.fetch,
    generation: globalThis.__kcTwoTileOpenWorldGeneration__,
  };
  globalThis.SubwayBuilderAPI = api;
  globalThis.__subwayBuilder_storeCallbacks__ = {
    getState: () => state,
    setMoney: (money) => { state.money = money; },
    setTicketCost() {},
  };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ tileId: 'KCW', schemaVersion: 1, assets: [], dataFiles: {}, runtimeFiles: {} }),
  });
  try {
    await import(`../src/game-entry.js?hot-reload-panel-repro=${Date.now()}`);
    assert.equal(typeof hourChangeCallback, 'function');
    assert.equal(typeof dayChangeCallback, 'function');
    await new Promise((resolve) => setImmediate(resolve));
    releaseWorldLoad();
    for (let attempt = 0; attempt < 20 && panels.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(panels.map((panel) => panel.id).sort(), ['kc-cross-demand-viewer', 'kc-two-tile-switcher']);
    assert.equal(typeof gameSavedCallback, 'function');
    gameSavedCallback('Autosave 1');
    for (let attempt = 0; attempt < 20 && !stored.has('world:hot-reload-world:save-checkpoints'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(stored.get('world:hot-reload-world:save-checkpoints').entries[0].saveName, 'Autosave 1');
  } finally {
    globalThis.SubwayBuilderAPI = previous.api;
    globalThis.__subwayBuilder_storeCallbacks__ = previous.callbacks;
    globalThis.fetch = previous.fetch;
    if (previous.generation === undefined) delete globalThis.__kcTwoTileOpenWorldGeneration__;
    else globalThis.__kcTwoTileOpenWorldGeneration__ = previous.generation;
  }
});
