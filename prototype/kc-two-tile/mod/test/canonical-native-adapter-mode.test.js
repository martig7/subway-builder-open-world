import test from 'node:test';
import assert from 'node:assert/strict';
import { SubwayBuilderGameAdapter } from '../src/adapters/subway-builder-game-adapter.js';
import { CANONICAL_NATIVE_NETWORK_MODE } from '../src/shared-transit-network.js';

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
    setTimeConfig() {},
  };
  state = {
    gameSessionId: 'session-a',
    routes: [],
    stations: [],
    trains: [],
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
    setFinancialHistory(value) { state.financialHistory = value; },
    setRouteFinancials(value) { state.routeFinancials = value; },
    setTracks() { native.trackCalls++; },
    handleIncrementGameState() { native.tickCalls++; },
    batchPreviewRouteUpdates() { native.previewCalls++; },
    confirmRouteChange() { native.confirmCalls++; },
    setPreviewRoute() { native.setPreviewCalls++; },
    setTimeConfig: native.setTimeConfig,
  };
  return { callbacks, state, native };
}

test('new-world initialization uses the mounted native store action', async () => {
  const testFixture = fixture();
  const calls = [];
  testFixture.state.loadInitialData = async (cityCode) => { calls.push(cityCode); };
  const adapter = new SubwayBuilderGameAdapter({
    api: {
      version: '1.0.0',
      cities: { setCityDataFiles() {} },
      utils: { getCityCode: () => 'NY_CP00_RP00' },
      trains: { getTrainTypes: () => [] },
    },
    callbacks: testFixture.callbacks,
  });

  await adapter.initializeNewWorld('NY_CP00_RP00');

  assert.deepEqual(calls, ['NY_CP00_RP00']);
});

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
  testFixture.state.interlinedFeatureCollection = { type: 'FeatureCollection', features: [] };
  testFixture.state.recalculateAllRouteGeojsons = async () => {
    recalculationCalls += 1;
    testFixture.state.interlinedFeatureCollection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: track.coords } }],
    };
  };
  const adapter = new SubwayBuilderGameAdapter({
    api: { trains: { getTrainTypes: () => [] } },
    callbacks: testFixture.callbacks,
  });

  adapter.activateCanonicalNativeNetworkMode();
  await testFixture.state.recalculateAllRouteGeojsons(testFixture.state.routes);
  await testFixture.state.recalculateAllRouteGeojsons(testFixture.state.routes);

  assert.equal(recalculationCalls, 1);

  testFixture.state.routes = [{ ...route, trainSchedule: { morning: 4 } }];
  await testFixture.state.recalculateAllRouteGeojsons(testFixture.state.routes);
  assert.equal(recalculationCalls, 1, 'schedule-only changes must not invalidate route geometry');

  testFixture.state.routes = [{ ...route, color: '#08f' }];
  await testFixture.state.recalculateAllRouteGeojsons(testFixture.state.routes);
  assert.equal(recalculationCalls, 2, 'a real route edit must still recalculate interlining');
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
