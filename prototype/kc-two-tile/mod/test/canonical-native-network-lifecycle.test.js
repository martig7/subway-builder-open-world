import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGlobalNetwork,
  createNativeNetworkSnapshot,
  isLegacyProjectedSnapshot,
  inspectNativeNetworkSnapshot,
} from '../src/network-projection.js';
import {
  CANONICAL_NATIVE_NETWORK_MODE,
  SHARED_TRANSIT_STATE_KEYS,
} from '../src/shared-transit-network.js';

function topology() {
  return {
    tracks: [{ id: 'remote-track', coords: [[3.2, 0.5], [3.8, 0.5]] }],
    trackGroups: [{ id: 'remote-group', trackIds: ['remote-track'] }],
    stations: [{ id: 'remote-station', coords: [3.5, 0.5], stNodeIds: ['remote-node'] }],
    stNodes: [{ id: 'remote-node', trackIds: ['remote-track'] }],
    stationGroups: [{ id: 'remote-stations', stationIds: ['remote-station'] }],
    signals: [{ id: 'remote-signal', trackIds: ['remote-track'] }],
    routes: [{ id: 'remote-route', stationIds: ['remote-station'], trackIds: ['remote-track'] }],
    trains: [{ id: 'remote-train', routeId: 'remote-route' }],
    fareGroups: [{ id: 'remote-fares', routeIds: ['remote-route'] }],
    routeFinancials: { byRoute: { 'remote-route': { revenue: 9 } } },
    ownedTrainCount: 1,
    ownedCarsByType: { commuter: 1 },
  };
}

test('canonical native snapshot carries the complete topology independently of the presentation window', () => {
  const network = createGlobalNetwork(topology());
  const base = { wallet: 73, cityCode: 'T0', data: { wallet: 73, localMarker: 'keep' } };
  const snapshot = createNativeNetworkSnapshot(base, network);
  const inspected = inspectNativeNetworkSnapshot(snapshot);

  assert.equal(inspected.mode, CANONICAL_NATIVE_NETWORK_MODE);
  assert.equal(inspected.complete, true);
  assert.equal(snapshot.data.localMarker, 'keep');
  for (const key of SHARED_TRANSIT_STATE_KEYS) assert.deepEqual(snapshot.data[key], network.nativeState[key], key);
  assert.deepEqual(snapshot.data.routes.map(({ id }) => id), ['remote-route']);
  assert.deepEqual(snapshot.data.trains.map(({ id }) => id), ['remote-train']);
});

test('legacy projected snapshots are migration inputs while complete native snapshots remain authoritative', () => {
  const network = createGlobalNetwork(topology());
  const baseline = {
    baselineState: network.nativeState,
    structuralHash: 'not-the-current-snapshot',
  };
  const stale = {
    tracks: [], routes: [], trains: [], stations: [], trackGroups: [], signals: [], stNodes: [], stationGroups: [],
    fareGroups: [], routeFinancials: {}, ownedTrainCount: 0, ownedCarsByType: {},
  };
  assert.equal(isLegacyProjectedSnapshot(stale, { baseline, fallbackState: network.nativeState }), true);

  const complete = createNativeNetworkSnapshot({ data: {} }, network);
  assert.equal(isLegacyProjectedSnapshot(complete, { baseline, fallbackState: network.nativeState }), false);
});

test('native snapshot composition is failure-atomic because it never mutates either input', () => {
  const source = topology();
  const network = createGlobalNetwork(source);
  const base = { data: { localMarker: 'before' } };
  const sourceBefore = structuredClone(source);
  const networkBefore = structuredClone(network);
  const snapshot = createNativeNetworkSnapshot(base, network);

  snapshot.data.tracks[0].id = 'mutated-copy';
  assert.deepEqual(source, sourceBefore);
  assert.deepEqual(network, networkBefore);
  assert.equal(base.data.localMarker, 'before');
});
