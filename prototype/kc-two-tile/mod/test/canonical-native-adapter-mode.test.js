import test from 'node:test';
import assert from 'node:assert/strict';
import { SubwayBuilderGameAdapter } from '../../../../open-world-platform/src/runtime/adapters/subway-builder-game-adapter.js';
import { CANONICAL_NATIVE_NETWORK_MODE } from '../../../../open-world-platform/src/runtime/shared-transit-network.js';

function fixture() {
  let state;
  const callbacks = {
    getState: () => state,
    setMoney() {},
    setTicketCost() {},
  };
  const native = {
    tickCalls: 0,
    trackCalls: 0,
    previewCalls: 0,
    confirmCalls: 0,
    setPreviewCalls: 0,
    setTimeConfigCalls: 0,
    setTimeConfig() { native.setTimeConfigCalls += 1; },
  };
  state = {
    cityCode: 'NY_CP00_RP00',
    gameSessionId: 'session-a',
    gameMode: 'easy',
    routes: [],
    tracks: [],
    trackGroups: [],
    stations: [],
    trains: [],
    tracksGeojsonFeatures: {
      lines: { geojson: { type: 'FeatureCollection', features: [] }, polygons: [] },
      base: { geojson: { type: 'FeatureCollection', features: [] }, polygons: [] },
    },
    trainWindowsGeojson: { geojson: { type: 'FeatureCollection', features: [] }, polygons: [] },
    timeConfig: { paused: false, timeSpeed: 'normal', elapsedSeconds: 0 },
    stNodes: [],
    portolanDiagram: null,
    portolanProgress: null,
    financialHistory: {
      entries: [],
      lastHourTimestamp: 0,
      currentHourRevenue: 0,
      currentHourExpenses: 0,
      currentHourExpenseCategories: {},
    },
    routeFinancials: { byRoute: {}, lastHourTimestamp: 0, currentHour: {} },
    setRoutes() {},
    generateSave() {},
    loadSave() {},
    loadInitialData() {},
    setCityCode(cityCode) { state.cityCode = cityCode; },
    setGameMode() {},
    setFinancialHistory(value) { state.financialHistory = value; },
    setRouteFinancials(value) { state.routeFinancials = value; },
    addRevenue() {},
    addExpense() {},
    recordRouteFinancials() {},
    setCompletedCommutes() {},
    setTracks() { native.trackCalls++; },
    setTrainWindowsGeojson(value) { state.trainWindowsGeojson = value; },
    handleIncrementGameState() { native.tickCalls++; },
    simulateCommutes: async () => {},
    calculatePaths: async () => {},
    recalculateAllRouteGeojsons: async () => {},
    batchPreviewRouteUpdates() { native.previewCalls++; },
    confirmRouteChange() { native.confirmCalls++; },
    setPreviewRoute() { native.setPreviewCalls++; },
    setTimeConfig: native.setTimeConfig,
  };
  return { callbacks, state, native };
}

test('canonical activation makes existing clipped wrappers inert and clears simulation ownership filters', async () => {
  const testFixture = fixture();
  const adapter = new SubwayBuilderGameAdapter({
    api: { trains: { getTrainTypes: () => [] } },
    callbacks: testFixture.callbacks,
  });

  adapter.configureGlobalFinanceOwnership({ financeOwnedRouteIds: ['R'], financeOwnedTrackIds: ['T'] });
  adapter.installClippedRouteTickGuard();
  adapter.installClippedRouteTrackEditGuard();
  adapter.installClippedRoutePreviewEditGuard();

  const activation = adapter.activateCanonicalNativeNetworkMode();
  assert.equal(adapter.nativeNetworkMode, CANONICAL_NATIVE_NETWORK_MODE);
  assert.equal(activation.mode, CANONICAL_NATIVE_NETWORK_MODE);
  assert.equal(adapter.financeOwnedRouteIds.size, 0);
  assert.equal(adapter.financeOwnedTrackIds.size, 0);

  adapter.configureGlobalFinanceOwnership({ financeOwnedRouteIds: ['R'], financeOwnedTrackIds: ['T'] });
  assert.equal(adapter.financeOwnedRouteIds.size, 0);
  assert.equal(adapter.financeOwnedTrackIds.size, 0);
  assert.deepEqual([...adapter.nativeFinanceAccountingRouteIds], ['R']);

  await testFixture.state.handleIncrementGameState();
  testFixture.state.setTracks({});
  await testFixture.state.batchPreviewRouteUpdates();
  testFixture.state.confirmRouteChange();
  testFixture.state.setPreviewRoute(null);
  assert.equal(testFixture.native.tickCalls, 1);
  assert.equal(testFixture.native.trackCalls, 1);
  assert.equal(testFixture.native.previewCalls, 1);
  assert.equal(testFixture.native.confirmCalls, 1);
  assert.equal(testFixture.native.setPreviewCalls, 1);
});

test('canonical activation deduplicates repeated native interlining for unchanged topology', async () => {
  const testFixture = fixture();
  let recalculationCalls = 0;
  const route = {
    id: 'route-a',
    color: '#f60',
    stCombos: [{ path: [{ trackId: 'track-a' }] }],
  };
  const track = {
    id: 'track-a',
    trackType: 'atGrade',
    coords: [[-73.1, 40.7], [-73.0, 40.8]],
  };
  testFixture.state.cityCode = 'NY_CP00_RP00';
  testFixture.state.routes = [route];
  testFixture.state.tracks = [track];
  testFixture.state.portolanDiagram = null;
  testFixture.state.portolanProgress = null;
  const nativeRecalculateAllRouteGeojsons = async () => {
    recalculationCalls += 1;
    testFixture.state.portolanProgress = { stage: 'starting', pct: 0 };
    testFixture.state.portolanDiagram = { revision: recalculationCalls, bands: {} };
    testFixture.state.portolanProgress = null;
  };
  testFixture.state.recalculateAllRouteGeojsons = nativeRecalculateAllRouteGeojsons;
  const adapter = new SubwayBuilderGameAdapter({
    api: { trains: { getTrainTypes: () => [] } },
    callbacks: testFixture.callbacks,
  });

  adapter.activateCanonicalNativeNetworkMode();
  assert.equal(adapter.getInterliningRevision(), 0);
  const firstRecalculation = testFixture.state.recalculateAllRouteGeojsons(testFixture.state.routes);
  assert.equal(adapter.getInterliningRevision(), 1);
  await firstRecalculation;
  await testFixture.state.recalculateAllRouteGeojsons(testFixture.state.routes);

  assert.equal(recalculationCalls, 1);
  assert.equal(adapter.getInterliningRevision(), 1);

  testFixture.state.routes = [{ ...route, trainSchedule: { morning: 4 } }];
  await testFixture.state.recalculateAllRouteGeojsons(testFixture.state.routes);
  assert.equal(recalculationCalls, 1, 'schedule-only changes must not invalidate route geometry');
  assert.equal(adapter.getInterliningRevision(), 1);

  testFixture.state.routes = [{ ...route, color: '#08f' }];
  await testFixture.state.recalculateAllRouteGeojsons(testFixture.state.routes);
  assert.equal(recalculationCalls, 2, 'a real route edit must still recalculate interlining');
  assert.equal(adapter.getInterliningRevision(), 2);

  testFixture.state.recalculateAllRouteGeojsons = nativeRecalculateAllRouteGeojsons;
  assert.equal(
    adapter.getInterliningRevision(),
    3,
    'a replaced native action must invalidate the Deck cache instead of disabling revisions',
  );
  assert.notEqual(testFixture.state.recalculateAllRouteGeojsons, nativeRecalculateAllRouteGeojsons);

  testFixture.state.routes = [{ ...route, color: '#0c8' }];
  const afterStoreReplacement = testFixture.state.recalculateAllRouteGeojsons(testFixture.state.routes);
  assert.equal(adapter.getInterliningRevision(), 4);
  await afterStoreReplacement;
  assert.equal(recalculationCalls, 3);
  assert.equal(testFixture.native.setTimeConfigCalls, 2, 'the repaired action must be republished');
});

test('canonical rail render revisions follow native payload identity and native tick ownership', () => {
  const testFixture = fixture();
  const adapter = new SubwayBuilderGameAdapter({ callbacks: testFixture.callbacks, api: {} });
  adapter.activateCanonicalNativeNetworkMode();

  assert.deepEqual(adapter.getRailRenderRevisions(), {
    tracks: 0,
    trackStyles: 0,
    trains: 0,
    trainStyles: 0,
    trainSimulationActive: true,
  });

  testFixture.state.timeConfig = { paused: false, timeSpeed: 'ultrafast', elapsedSeconds: 1000 };
  assert.deepEqual(adapter.getRailRenderRevisions(), {
    tracks: 0,
    trackStyles: 0,
    trains: 0,
    trainStyles: 0,
    trainSimulationActive: true,
  });

  testFixture.state.trains = [{ id: 'train-a', progress: 0.5 }];
  testFixture.state.timeConfig.elapsedSeconds = 2000;
  assert.equal(adapter.getRailRenderRevisions().trains, 0,
    'non-rendering native train updates must not invalidate the Deck cache');

  const cachedOwner = Symbol.for('open-world.cached-simulation');
  Object.defineProperty(testFixture.state.handleIncrementGameState, cachedOwner, {
    value: { controller: { isTickSuppressionActive: () => true } },
  });
  testFixture.state.timeConfig = { paused: false, timeSpeed: 'normal', elapsedSeconds: 2000 };
  assert.equal(adapter.getRailRenderRevisions().trainSimulationActive, false,
    'cached mode suppresses native train simulation independently of native speed');
  testFixture.state.handleIncrementGameState[cachedOwner].controller.isTickSuppressionActive = () => false;
  testFixture.state.timeConfig.paused = true;
  assert.equal(adapter.getRailRenderRevisions().trainSimulationActive, false,
    'pause suppresses train simulation when cached mode is off');
  testFixture.state.timeConfig.paused = false;

  testFixture.state.trainWindowsGeojson = {
    geojson: { type: 'FeatureCollection', features: [{ id: 'train-a' }] },
    polygons: [],
  };
  assert.equal(adapter.getRailRenderRevisions().trains, 1);
  testFixture.state.tracksGeojsonFeatures.lines.geojson = {
    type: 'FeatureCollection', features: [{ id: 'track-a' }],
  };
  const changed = adapter.getRailRenderRevisions();
  assert.equal(changed.tracks, 1);
  assert.equal(changed.trackStyles, 1);

  const reloaded = new SubwayBuilderGameAdapter({ callbacks: testFixture.callbacks, api: {} });
  reloaded.activateCanonicalNativeNetworkMode();
  assert.equal(reloaded.getRailRenderRevisions().tracks, 1,
    'a hot reload must adopt the retained monotonic revision contract');
});

test('canonical rail render action guards invalidate same-reference in-place edits', () => {
  const testFixture = fixture();
  const trackFeature = { id: 'track-a', geometry: { coordinates: [[0, 0], [1, 1]] } };
  const trainFeature = { id: 'train-a', geometry: { coordinates: [0, 0] } };
  testFixture.state.tracksGeojsonFeatures.lines.geojson.features.push(trackFeature);
  testFixture.state.trainWindowsGeojson.geojson.features.push(trainFeature);
  const originalTrackPayload = testFixture.state.tracksGeojsonFeatures;
  const originalTrainPayload = testFixture.state.trainWindowsGeojson;
  testFixture.state.setTracks = function setTracksInPlace() {
    trackFeature.geometry.coordinates[0][0] = 2;
  };
  testFixture.state.setTrainWindowsGeojson = function setTrainWindowsInPlace(payload) {
    payload.geojson.features[0].geometry.coordinates[0] = 2;
  };
  const adapter = new SubwayBuilderGameAdapter({ callbacks: testFixture.callbacks, api: {} });
  adapter.activateCanonicalNativeNetworkMode();
  assert.equal(adapter.getRailRenderRevisions().tracks, 0);

  testFixture.state.setTracks({ newTracks: testFixture.state.tracks });
  testFixture.state.setTrainWindowsGeojson(originalTrainPayload);
  const changed = adapter.getRailRenderRevisions();
  assert.equal(testFixture.state.tracksGeojsonFeatures, originalTrackPayload);
  assert.equal(testFixture.state.trainWindowsGeojson, originalTrainPayload);
  assert.equal(changed.tracks, 1);
  assert.equal(changed.trains, 1);
});

test('canonical rail render revisions reject unknown payload shapes and invalidate a new native session', () => {
  const testFixture = fixture();
  const adapter = new SubwayBuilderGameAdapter({ callbacks: testFixture.callbacks, api: {} });
  adapter.activateCanonicalNativeNetworkMode();
  assert.equal(adapter.getRailRenderRevisions().tracks, 0);

  testFixture.state.gameSessionId = 'session-b';
  const nextSession = adapter.getRailRenderRevisions();
  assert.equal(nextSession.tracks, 1);
  assert.equal(nextSession.trains, 1);

  testFixture.state.trainWindowsGeojson = { geojson: { type: 'FeatureCollection' } };
  assert.equal(adapter.getRailRenderRevisions(), null);
});

test('Portolan cache waits for the deferred diagram before accepting a cache hit', async () => {
  const testFixture = fixture();
  const route = {
    id: 'route-a',
    color: '#f60',
    stCombos: [{ path: [{ trackId: 'track-a' }] }],
  };
  testFixture.state.routes = [route];
  testFixture.state.tracks = [{
    id: 'track-a',
    coords: [[-73.1, 40.7], [-73, 40.8]],
  }];
  let recalculationCalls = 0;
  testFixture.state.recalculateAllRouteGeojsons = async () => {
    recalculationCalls += 1;
  };
  const adapter = new SubwayBuilderGameAdapter({
    api: { trains: { getTrainTypes: () => [] } },
    callbacks: testFixture.callbacks,
  });

  adapter.activateCanonicalNativeNetworkMode();
  await testFixture.state.recalculateAllRouteGeojsons(testFixture.state.routes);
  await testFixture.state.recalculateAllRouteGeojsons(testFixture.state.routes);
  assert.equal(recalculationCalls, 2, 'the previous diagram must not satisfy a deferred Portolan request');

  testFixture.state.portolanDiagram = { bands: {}, completed: true };
  await testFixture.state.recalculateAllRouteGeojsons(testFixture.state.routes);
  assert.equal(recalculationCalls, 2, 'the completed deferred diagram should promote the pending signature');
});

test('canonical interlining excludes routes whose paths reference unusable track geometry', async () => {
  const testFixture = fixture();
  const validRoute = {
    id: 'valid-route',
    color: '#f60',
    stCombos: [{
      startStNodeId: 'valid-a',
      endStNodeId: 'valid-b',
      path: [{ trackId: 'valid-track' }],
    }],
  };
  const invalidRoute = {
    id: 'invalid-route',
    color: '#08f',
    stCombos: [{
      startStNodeId: 'invalid-a',
      endStNodeId: 'invalid-b',
      path: [{ trackId: 'invalid-track' }],
    }],
  };
  testFixture.state.cityCode = 'NY_CP00_RP00';
  testFixture.state.routes = [validRoute, invalidRoute];
  testFixture.state.tracks = [
    { id: 'valid-track', coords: [[-73.1, 40.7], [-73.0, 40.8]] },
    { id: 'invalid-track', coords: undefined },
  ];
  testFixture.state.trackGroups = [
    {
      id: 'valid-group',
      trackIds: ['valid-track'],
      centerLine: [[-73.1, 40.7], [-73.0, 40.8]],
    },
    { id: 'invalid-group', trackIds: ['invalid-track'], centerLine: undefined },
  ];
  testFixture.state.stations = [
    { id: 'valid-station-a', stNodeIds: ['valid-a'] },
    { id: 'valid-station-b', stNodeIds: ['valid-b'] },
    { id: 'invalid-station-a', stNodeIds: ['invalid-a'] },
    { id: 'invalid-station-b', stNodeIds: ['invalid-b'] },
  ];
  testFixture.state.interlinedFeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { routeIds: ['invalid-route'] },
      geometry: { type: 'LineString', coordinates: [[-73.2, 40.6], [-73.1, 40.7]] },
    }],
  };
  let receivedRoutes = null;
  testFixture.state.recalculateAllRouteGeojsons = async (routes) => {
    for (const route of routes) {
      for (const combo of route.stCombos ?? []) {
        for (const pathItem of combo.path ?? []) {
          const track = testFixture.state.tracks.find((candidate) => candidate.id === pathItem.trackId);
          if (!track?.coords) throw new Error('coordinates is required');
        }
      }
    }
    receivedRoutes = routes;
    testFixture.state.interlinedFeatureCollection = { type: 'FeatureCollection', features: [] };
  };
  const adapter = new SubwayBuilderGameAdapter({
    api: { trains: { getTrainTypes: () => [] } },
    callbacks: testFixture.callbacks,
  });

  adapter.activateCanonicalNativeNetworkMode();
  await testFixture.state.recalculateAllRouteGeojsons(testFixture.state.routes);

  assert.deepEqual(receivedRoutes.map((route) => route.id), ['valid-route']);
  assert.deepEqual(testFixture.state.interlinedFeatureCollection.features, []);
});

test('snapshot restore keeps empty route definitions out of native topology rebuilding', async () => {
  const testFixture = fixture();
  const loadedRouteIds = [];
  const publishedRoutes = [];
  testFixture.state.loadSave = async (snapshot) => {
    const routes = structuredClone(snapshot.data.routes);
    loadedRouteIds.push(routes.map((route) => route.id));
    if (routes.some((route) => (route.stCombos ?? []).length === 0)) {
      throw new Error('coordinates is required');
    }
    testFixture.state.routes = routes;
  };
  testFixture.state.setRoutes = (routes, regenerate = true) => {
    publishedRoutes.push({
      routeIds: routes.map((route) => route.id),
      regenerate,
    });
    testFixture.state.routes = structuredClone(routes);
  };
  const adapter = new SubwayBuilderGameAdapter({
    api: {
      version: '1.0.0',
      cities: { setCityDataFiles() {} },
      utils: { getCityCode: () => 'NY_CP00_RP00' },
      trains: { getTrainTypes: () => [] },
    },
    callbacks: testFixture.callbacks,
  });
  adapter.activateCanonicalNativeNetworkMode();
  const snapshot = {
    cityCode: 'NY_CP00_RP00',
    data: {
      routes: [
        {
          id: 'operational-route',
          stNodes: [{ id: 'a' }, { id: 'b' }],
          stCombos: [{ startStNodeId: 'a', endStNodeId: 'b', path: [{ trackId: 'track-a' }] }],
        },
        {
          id: 'empty-route-definition',
          name: 'PA',
          color: '#08f',
          stNodes: [],
          stCombos: [],
        },
      ],
      tracks: [{ id: 'track-a', coords: [[-73.1, 40.7], [-73.0, 40.8]] }],
      stations: [],
      trains: [],
    },
  };

  await adapter.restoreSnapshot(snapshot);

  assert.deepEqual(loadedRouteIds, [['operational-route']]);
  assert.deepEqual(publishedRoutes, [{
    routeIds: ['operational-route', 'empty-route-definition'],
    regenerate: false,
  }]);
  assert.deepEqual(testFixture.state.routes, snapshot.data.routes);
  assert.deepEqual(snapshot.data.routes.map((route) => route.id), [
    'operational-route',
    'empty-route-definition',
  ]);
});

test('canonical finance rebase clears stale current-hour route expenses and keeps history', () => {
  const testFixture = fixture();
  const { state } = testFixture;
  state.routes = [{ id: 'live-route' }];
  state.trains = [{ id: 'live-train', routeId: 'live-route' }];
  state.financialHistory = {
    entries: [{ timestamp: 0, hourlyExpenses: 10 }],
    lastHourTimestamp: 7_200,
    currentHourRevenue: 20,
    currentHourExpenses: 100,
    currentHourExpenseCategories: { trainOperational: 50 },
  };
  state.routeFinancials = {
    byRoute: {
      'live-route': [
        { timestamp: 0, revenue: 1, expenses: 2 },
        { timestamp: 10_800, revenue: 3, expenses: 4 },
      ],
      'deleted-route': [{ timestamp: 0, revenue: 9, expenses: 900 }],
    },
    lastHourTimestamp: 3_600,
    currentHour: {
      'live-route': { revenue: 5, expenses: 999_999 },
      'deleted-route': { revenue: 6, expenses: 888_888 },
    },
  };

  const adapter = new SubwayBuilderGameAdapter({
    api: { trains: { getTrainTypes: () => [] } },
    callbacks: testFixture.callbacks,
  });
  adapter.activateCanonicalNativeNetworkMode();

  const first = adapter.rebaseNativeFinanceForCanonicalMode();
  assert.equal(first.changed, true);
  assert.equal(first.resetCurrentHour, true);
  assert.deepEqual(Object.keys(state.routeFinancials.byRoute), ['live-route']);
  assert.deepEqual(state.routeFinancials.currentHour, {});
  assert.equal(state.routeFinancials.lastHourTimestamp, 7_200);
  assert.deepEqual(state.routeFinancials.byRoute['live-route'], [
    { timestamp: 0, revenue: 1, expenses: 2 },
  ]);
  assert.equal(state.financialHistory.openWorldNativeFinanceSessionId, 'session-a');

  const second = adapter.rebaseNativeFinanceForCanonicalMode();
  assert.equal(second.changed, false);
  assert.equal(second.resetCurrentHour, false);
});
