import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createWorld } from '../src/world-model.js';
import { createGlobalNetwork } from '../src/network-projection.js';
import {
  applyNetworkRecovery,
  decodeGzipBase64Json,
  mergeRecoveryStates,
  selectRouteRecoveryState,
} from '../src/network-recovery.js';

test('embedded recovery payload decodes from gzip base64', async () => {
  const value = { routes: [{ id: 'remote-route' }], tracks: [] };
  const encoded = gzipSync(JSON.stringify(value)).toString('base64');
  assert.deepEqual(await decodeGzipBase64Json(encoded), value);
});

test('one-time recovery unions remote topology into a clipped live world and keeps live conflicts', () => {
  const world = createWorld({ worldId: 'clipped-world', tileIds: ['near', 'remote'] });
  world.globalNetwork = createGlobalNetwork({
    tracks: [{ id: 'shared-track', coords: [[0, 0], [1, 0]], buildType: 'live' }],
    stations: [{ id: 'live-station', coords: [0, 0] }],
    routes: [], trains: [],
    fareGroups: [{ id: 'default', fareSystem: 'distance', routeIds: [] }],
    ownedTrainCount: 99,
  }, 3);
  const recoveryState = {
    tracks: [
      { id: 'shared-track', coords: [[0, 0], [1, 0]], buildType: 'backup' },
      { id: 'remote-track', coords: [[4, 0], [5, 0]] },
    ],
    stations: [{ id: 'remote-station', coords: [5, 0] }],
    routes: [{ id: 'remote-route', fullName: 'Remote route' }],
    trains: [{ id: 'remote-train', routeId: 'remote-route' }],
    fareGroups: [{ id: 'default', fareSystem: 'flat', routeIds: ['remote-route'] }],
    ownedTrainCount: 12,
  };

  const first = applyNetworkRecovery(world, {
    recoveryId: 'network-v1', nativeState: recoveryState,
  });
  const second = applyNetworkRecovery(world, {
    recoveryId: 'network-v1', nativeState: recoveryState,
  });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(world.globalNetwork.nativeState.tracks.map(({ id }) => id), ['shared-track', 'remote-track']);
  assert.equal(world.globalNetwork.nativeState.tracks[0].buildType, 'live');
  assert.deepEqual(world.globalNetwork.nativeState.routes.map(({ fullName }) => fullName), ['Remote route']);
  assert.deepEqual(world.globalNetwork.nativeState.fareGroups[0].routeIds, ['remote-route']);
  assert.equal(world.globalNetwork.nativeState.fareGroups[0].fareSystem, 'distance');
  assert.equal(world.globalNetwork.nativeState.ownedTrainCount, 99);
  assert.equal(world.networkRecoveries['network-v1'].routes, 1);
});

test('route-scoped recovery can replace a known truncated route while retaining other live routes', () => {
  const world = createWorld({ worldId: 'truncated-world', tileIds: ['near', 'remote'] });
  world.globalNetwork = createGlobalNetwork({
    tracks: [{ id: 'live-track', coords: [[0, 0], [1, 0]] }],
    routes: [
      { id: 'damaged-route', fullName: 'Damaged', stNodes: [{ id: 'near' }], stCombos: [] },
      { id: 'healthy-route', fullName: 'New live name', stNodes: [{ id: 'healthy' }], stCombos: [] },
    ],
    stations: [], trains: [],
  });
  const recoveryState = {
    tracks: [{ id: 'remote-track', coords: [[1, 0], [2, 0]] }],
    routes: [
      {
        id: 'damaged-route', fullName: 'Recovered',
        stNodes: [{ id: 'near' }, { id: 'remote' }],
        stCombos: [{ startStNodeId: 'near', endStNodeId: 'remote', path: [{ trackId: 'remote-track' }] }],
      },
      { id: 'healthy-route', fullName: 'Old backup name', stNodes: [], stCombos: [] },
    ],
    stations: [], trains: [],
  };

  applyNetworkRecovery(world, {
    recoveryId: 'network-v2',
    nativeState: recoveryState,
    replaceRouteIds: ['damaged-route'],
  });

  const routes = new Map(world.globalNetwork.nativeState.routes.map((route) => [route.id, route]));
  assert.equal(routes.get('damaged-route').stNodes.length, 2);
  assert.equal(routes.get('damaged-route').stCombos.length, 1);
  assert.equal(routes.get('healthy-route').fullName, 'New live name');
  assert.deepEqual(world.globalNetwork.nativeState.tracks.map(({ id }) => id), ['remote-track', 'live-track']);
});

test('recovery states merge by entity id with later sources winning', () => {
  const merged = mergeRecoveryStates(
    {
      tracks: [{ id: 'shared', buildType: 'native' }, { id: 'nyc' }],
      routes: [{ id: 'F', fullName: 'F' }],
      fareGroups: [{ id: 'distance', routeIds: ['F'], routeFares: { F: 3 } }],
    },
    {
      tracks: [{ id: 'shared', buildType: 'sidecar' }, { id: 'albany' }],
      routes: [{ id: 'EL', fullName: 'Empire Line' }],
      fareGroups: [{ id: 'distance', routeIds: ['EL'], routeFares: { EL: 7 } }],
    },
  );

  assert.deepEqual(merged.tracks, [
    { id: 'shared', buildType: 'sidecar' },
    { id: 'nyc' },
    { id: 'albany' },
  ]);
  assert.deepEqual(merged.routes.map(({ id }) => id), ['F', 'EL']);
  assert.deepEqual(merged.fareGroups, [{
    id: 'distance', routeIds: ['F', 'EL'], routeFares: { F: 3, EL: 7 },
  }]);
});

test('route-scoped recovery follows clipped canonical references without importing unrelated routes', () => {
  const state = {
    tracks: [
      { id: 'empire-track', coords: [[-73.8, 42.6], [-73.7, 42.7]] },
      { id: 'unrelated-track', coords: [[-74, 40.7], [-74, 40.8]] },
    ],
    trackGroups: [
      { id: 'empire-group', trackIds: ['empire-track'] },
      { id: 'unrelated-group', trackIds: ['unrelated-track'] },
    ],
    routes: [
      {
        id: 'empire',
        stNodes: [{ id: 'albany-node', trackIds: ['empire-track'] }],
        stCombos: [{ path: [{ trackId: 'empire-track' }] }],
      },
      { id: 'unrelated', stNodes: [], stCombos: [] },
    ],
    stations: [{
      id: 'albany-station', routeIds: ['empire'], stNodeIds: ['albany-node'],
      trackIds: ['empire-track'], trackGroupId: 'empire-group',
    }],
    stNodes: [{ id: 'albany-node', trackIds: ['empire-track'] }],
    stationGroups: [{ id: 'albany-station', stationIds: ['albany-station'] }],
    trains: [
      { id: 'empire-train', routeId: 'empire' },
      { id: 'unrelated-train', routeId: 'unrelated' },
    ],
    signals: [{
      id: 'empire-signal',
      signalTracks: [{ trackId: 'empire-track', areaCovered: 'all' }],
    }],
    fareGroups: [{ id: 'distance', routeIds: ['empire', 'unrelated'] }],
  };

  const selected = selectRouteRecoveryState(state, ['empire']);

  assert.deepEqual(selected.routes.map(({ id }) => id), ['empire']);
  assert.deepEqual(selected.tracks.map(({ id }) => id), ['empire-track']);
  assert.deepEqual(selected.trackGroups.map(({ id }) => id), ['empire-group']);
  assert.deepEqual(selected.stations.map(({ id }) => id), ['albany-station']);
  assert.deepEqual(selected.stNodes.map(({ id }) => id), ['albany-node']);
  assert.deepEqual(selected.trains.map(({ id }) => id), ['empire-train']);
  assert.deepEqual(selected.signals.map(({ id }) => id), ['empire-signal']);
  assert.deepEqual(selected.fareGroups.map(({ id }) => id), ['distance']);
});
