import test from 'node:test';
import assert from 'node:assert/strict';
import { SubwayBuilderGameAdapter } from '../src/adapters/subway-builder-game-adapter.js';
import { CANONICAL_NATIVE_NETWORK_MODE } from '../src/shared-transit-network.js';

function fixture() {
  let state;
  const callbacks = {
    getState: () => state,
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
    routes: [],
    stations: [],
    trains: [],
    setRoutes() {},
    setTracks() { native.trackCalls++; },
    handleIncrementGameState() { native.tickCalls++; },
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

