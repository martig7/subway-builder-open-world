import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkProjection, classifyCrossTileRouteIds, createGlobalNetwork, stripNetworkFromSnapshot } from '../../../../open-world-platform/src/runtime/network-projection.js';

const catalog = {
  tiles: Array.from({ length: 4 }, (_, column) => ({
    id: `T${column}`,
    column,
    row: 0,
    status: 'normal',
    bounds: [column, 0, column + 1, 1],
  })),
};

function fixtureState() {
  return {
    tracks: [
      { id: 'inside-track', coords: [[1.2, 0.5], [1.8, 0.5]] },
      { id: 'crossing-track', coords: [[1.8, 0.5], [3.5, 0.5]] },
      { id: 'outside-track', coords: [[3.2, 0.7], [3.8, 0.7]] },
    ],
    stations: [
      { id: 'inside-a', coords: [1.2, 0.5], stNodeIds: ['a'], routeIds: ['local-route'] },
      { id: 'inside-b', coords: [1.8, 0.5], stNodeIds: ['b'], routeIds: ['local-route', 'long-route'] },
      { id: 'outside', coords: [3.5, 0.5], stNodeIds: ['c'], routeIds: ['long-route'] },
    ],
    routes: [
      {
        id: 'local-route', color: '#ff0000', stationIds: ['inside-a', 'inside-b'], trackIds: ['inside-track'],
        timetableSchedule: { mode: 'timetable', periods: [{ id: 'peak', headwaySeconds: 300 }] },
        cycleTimeSeconds: 1_800,
      },
      {
        id: 'long-route', color: '#00ff00', stationIds: ['inside-b', 'outside'], trackIds: ['crossing-track'],
        timetableSchedule: { mode: 'timetable', periods: [{ id: 'peak', headwaySeconds: 600 }] },
        cycleTimeSeconds: 7_200,
      },
    ],
    trains: [
      { id: 'local-train', routeId: 'local-route' },
      { id: 'long-train', routeId: 'long-route' },
    ],
    trackGroups: [], signals: [], stNodes: [], stationGroups: [], fareGroups: [], routeFinancials: {},
    ownedTrainCount: 2, ownedCarsByType: { metro: 8 },
  };
}

test('global-network creation unwraps a clipped facade and recovers its deferred trains', () => {
  const canonicalRoute = {
    id: 'empire',
    stNodes: [{ id: 'nyc' }, { id: 'albany' }],
    stCombos: [{
      startStNodeId: 'nyc',
      endStNodeId: 'albany',
      path: [{ trackId: 'remote-track', length: 10_000 }],
    }],
    trainSchedule: { highDemand: 3 },
  };
  const deferredTrain = {
    id: 'empire-train',
    routeId: 'empire',
    windows: { train: { tracks: [{ trackId: 'remote-track' }] } },
  };
  const projectedFacade = {
    ...structuredClone(canonicalRoute),
    stNodes: [{ id: 'nyc' }],
    stCombos: [],
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: {
      ...structuredClone(canonicalRoute),
      // Reproduces the nested projection metadata found in the persisted
      // Empire Line after a projected save was promoted to authoritative.
      openWorldNativeCommuteRoute: structuredClone(canonicalRoute),
    },
    openWorldNativeCommuteRoute: structuredClone(canonicalRoute),
    openWorldNativeCommuteTrains: [structuredClone(deferredTrain)],
  };

  const network = createGlobalNetwork({
    tracks: [{ id: 'remote-track', coords: [[3.2, 0.5], [3.8, 0.5]] }],
    stations: [],
    routes: [projectedFacade],
    trains: [],
    trackGroups: [], signals: [], stNodes: [], stationGroups: [], fareGroups: [], routeFinancials: {},
    ownedTrainCount: 1, ownedCarsByType: { 'commuter-rail': 1 },
  });

  assert.deepEqual(network.nativeState.routes, [canonicalRoute]);
  assert.deepEqual(network.nativeState.trains, [deferredTrain]);
  assert.equal(
    JSON.stringify(network.nativeState).includes('openWorld'),
    false,
    'projection-only metadata must never persist in the authoritative network',
  );
});

function nativeRouteSplitIndices(route, stations) {
  const stationByNode = new Map(stations.flatMap((station) => (
    (station.stNodeIds ?? []).map((nodeId) => [String(nodeId), station])
  )));
  const seenStationIds = new Set();
  const splits = [{ start: 0, end: null }];
  for (let index = 0; index < (route.stNodes ?? []).length; index += 1) {
    const station = stationByNode.get(String(route.stNodes[index]?.id));
    if (!station) continue;
    const current = splits.find((split) => split.end === null);
    if (index === route.stNodes.length - 1) {
      current.end = index;
    } else if (seenStationIds.has(String(station.id))) {
      current.end = index - 1;
      splits.push({ start: index - 1, end: null });
      seenStationIds.clear();
      seenStationIds.add(String(station.id));
    } else {
      seenStationIds.add(String(station.id));
    }
  }
  return splits;
}

test('build bounds native stations and topology while retaining clipped partial-route presentation', () => {
  const source = fixtureState();
  const before = structuredClone(source);
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(source);

  const result = projection.build({ network, activeTileId: 'T1', catalog, baseSnapshot: { cityCode: 'T1', data: {} } });

  assert.deepEqual(source, before, 'projection must not mutate authoritative input');
  assert.deepEqual(result.manifest.visibleTileIds, ['T0', 'T1', 'T2']);
  assert.deepEqual(result.state.stations.map(({ id }) => id), ['inside-a', 'inside-b']);
  assert.deepEqual(result.state.tracks.map(({ id }) => id), ['inside-track']);
  assert.deepEqual(result.state.routes.map(({ id }) => id), ['local-route', 'long-route']);
  assert.deepEqual(result.state.trains.map(({ id }) => id), ['local-train']);
  assert.deepEqual(result.manifest.deferredTrainIds, ['long-train']);
  assert.deepEqual(result.state.routes[1].openWorldNativeCommuteTrains.map(({ id }) => id), ['long-train']);
  assert.deepEqual(
    result.state.routes[1].openWorldNativeCommuteStations.map(({ id }) => id),
    ['inside-b', 'outside'],
  );
  assert.ok(network.nativeState.trains.some((train) => train.id === 'long-train'));
  assert.deepEqual(result.state.routes[1].stationIds, ['inside-b', 'outside']);
  assert.equal(result.state.routes[1].timetableSchedule.periods[0].headwaySeconds, 600);
  assert.deepEqual(result.manifest.partialRouteIds, ['long-route']);
  assert.equal(
    result.manifest.protectedStationIds.includes('inside-b'),
    false,
    'an interior station does not become a boundary dependency merely because its route is clipped elsewhere',
  );
  assert.ok(result.overlay.features.some((feature) => feature.properties.kind === 'track-fragment'));
  assert.ok(result.overlay.features.some((feature) => feature.properties.kind === 'route-fragment'));
  for (const feature of result.overlay.features) {
    for (const [longitude] of feature.geometry.coordinates) assert.ok(longitude <= 3 + 1e-9);
  }
  assert.deepEqual(network.routeDescriptors['long-route'].orderedStationIds, ['inside-b', 'outside']);
  assert.equal(network.routeDescriptors['long-route'].timetableSchedule.periods[0].headwaySeconds, 600);
  assert.equal(network.routeDescriptors['long-route'].fullCycleTimeSeconds, 7_200);
});

test('1.7 track curves, lane directions, and light-rail type survive canonical projection', () => {
  const track = {
    id: 'light-rail-curve',
    coords: [[1.2, 0.4], [1.5, 0.55], [1.8, 0.6]],
    trackType: 'light-rail',
    curveType: 'modified-euler',
    curveGeometry: { type: 'spiral', entryLength: 42, radius: 275 },
    nodes: [{ id: 'curve-a', coords: [1.2, 0.4] }, { id: 'curve-b', coords: [1.8, 0.6] }],
    direction: 'custom',
    laneDirection: 'forward',
    reversable: false,
  };
  const group = {
    id: 'light-rail-group',
    trackIds: [track.id],
    trackType: 'light-rail',
    trackLanesType: 'parallel',
    laneDirections: ['forward', 'reverse', 'forward'],
    directions: ['forward', 'reverse', 'forward'],
  };
  const source = {
    ...fixtureState(),
    tracks: [track],
    trackGroups: [group],
    stations: [], routes: [], trains: [],
  };

  const result = new NetworkProjection({ guardBandMeters: 0 }).build({
    network: createGlobalNetwork(source),
    activeTileId: 'T1',
    catalog,
    baseSnapshot: { cityCode: 'T1', data: {} },
  });

  assert.deepEqual(result.state.tracks, [track]);
  assert.deepEqual(result.state.trackGroups, [group]);
});

test('structural projection fingerprint ignores train motion but detects topology and schedule edits', () => {
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(fixtureState());
  const built = projection.build({
    network,
    activeTileId: 'T1',
    catalog,
    baseSnapshot: { cityCode: 'T1', data: {} },
  });
  const input = (nativeSnapshot) => ({ network, baseline: built.manifest, nativeSnapshot });

  assert.equal(projection.isSnapshotStructurallyCurrent(input(built.snapshot)), true);

  const movingTrain = structuredClone(built.snapshot);
  movingTrain.data.trains[0].progress = 0.75;
  movingTrain.data.trains[0].position = [1.5, 0.5];
  assert.equal(projection.isSnapshotStructurallyCurrent(input(movingTrain)), true);

  const changedTrack = structuredClone(built.snapshot);
  changedTrack.data.tracks[0].coords[1] = [1.7, 0.6];
  assert.equal(projection.isSnapshotStructurallyCurrent(input(changedTrack)), false);

  const changedSchedule = structuredClone(built.snapshot);
  changedSchedule.data.routes[0].timetableSchedule.periods[0].headwaySeconds = 420;
  assert.equal(projection.isSnapshotStructurallyCurrent(input(changedSchedule)), false);
});

test('a clipped route always closes the native route-panel split on a delivered station', () => {
  const source = fixtureState();
  source.routes.find(({ id }) => id === 'long-route').stNodes = [
    { id: 'b', stationId: 'inside-b' },
    { id: 'c', stationId: 'outside' },
  ];
  source.stNodes = [
    { id: 'b', stationId: 'inside-b', coords: [1.8, 0.5] },
    { id: 'c', stationId: 'outside', coords: [3.5, 0.5] },
  ];
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const built = projection.build({
    network: createGlobalNetwork(source),
    activeTileId: 'T1',
    catalog,
    baseSnapshot: { cityCode: 'T1', data: {} },
  });
  const route = built.state.routes.find(({ id }) => id === 'long-route');
  const splits = nativeRouteSplitIndices(route, built.state.stations);

  assert.ok(
    splits.every(({ end }) => end !== null),
    'Subway Builder throws “Route split index end is null” when the projected terminal has no delivered station',
  );
});

test('build retains a native platform signal through its signalTracks dependency', () => {
  const source = fixtureState();
  source.signals = [{
    id: 'inside-platform-signal',
    signalTracks: [{ trackId: 'inside-track', areaCovered: 'all' }],
    // A recovered signal need not retain a usable point coordinate. Its track
    // dependency is authoritative for native train-window lookups.
    coords: null,
  }];
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(source);

  const result = projection.build({
    network,
    activeTileId: 'T1',
    catalog,
    baseSnapshot: { cityCode: 'T1', data: {} },
  });

  assert.deepEqual(result.state.signals.map(({ id }) => id), ['inside-platform-signal']);
});

test('repairs a retained station whose canonical track group is missing', () => {
  const source = fixtureState();
  source.tracks = [
    {
      id: 'platform-a-1', type: 'station', trackType: 'commuter-rail',
      coords: [[1.1, 0.4], [1.3, 0.5]],
    },
    {
      id: 'platform-a-2', type: 'station', trackType: 'commuter-rail',
      coords: [[1.3, 0.5], [1.5, 0.6]],
    },
    {
      id: 'platform-b-1', type: 'station', trackType: 'commuter-rail',
      coords: [[1.5, 0.61], [1.3, 0.51]],
    },
    {
      id: 'platform-b-2', type: 'station', trackType: 'commuter-rail',
      coords: [[1.3, 0.51], [1.1, 0.41]],
    },
  ];
  source.stations = [{
    id: 'station-with-missing-group',
    name: 'Recover Me',
    coords: [1.3, 0.505],
    trackGroupId: 'station-with-missing-group',
    trackIds: source.tracks.map(({ id }) => id),
    stNodeIds: [],
    routeIds: [],
    stationType: 'standard',
    buildType: 'constructed',
  }];
  source.routes = [];
  source.trains = [];
  source.trackGroups = [];
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(source);

  const built = projection.build({ network, activeTileId: 'T1', catalog });
  const repairedGroup = built.state.trackGroups.find(({ id }) => id === 'station-with-missing-group');

  assert.ok(repairedGroup, 'the native loader requires every station.trackGroupId to resolve');
  assert.deepEqual(repairedGroup.trackIds, source.stations[0].trackIds);
  assert.equal(repairedGroup.type, 'station');
  assert.equal(repairedGroup.trackLanesType, 'parallel');
  assert.equal(repairedGroup.trackType, 'commuter-rail');
  assert.equal(repairedGroup.platformLayout, 'side-platforms');
  assert.equal(repairedGroup.platformWidthScale, 1);
  assert.equal(repairedGroup.centerLine.length, 2);

  const reconciled = projection.reconcile({
    network,
    baseline: built.manifest,
    nativeSnapshot: built.snapshot,
    catalog,
  });
  assert.equal(reconciled.accepted, true);
  assert.ok(
    reconciled.network.nativeState.trackGroups.some(({ id }) => id === 'station-with-missing-group'),
    'an unchanged repaired group must still be promoted into canonical state',
  );
});

test('repairs ordinary and crossover track groups omitted by an autosave race', () => {
  const source = fixtureState();
  source.routes = [];
  source.trains = [];
  source.stations = [];
  source.trackGroups = [];
  source.tracks = [
    {
      id: 'outbound', type: null, trackType: 'commuter-rail', createdAt: 100,
      coords: [[0.2, 0.2], [0.8, 0.2]],
    },
    {
      id: 'inbound', type: null, trackType: 'commuter-rail', createdAt: 100,
      coords: [[0.8, 0.2001], [0.2, 0.2001]],
    },
    {
      id: 'separate-outbound', type: null, trackType: 'commuter-rail', createdAt: 100,
      coords: [[1.2, 0.2], [1.8, 0.2]],
    },
    {
      id: 'separate-inbound', type: null, trackType: 'commuter-rail', createdAt: 100,
      coords: [[1.8, 0.2001], [1.2, 0.2001]],
    },
    {
      id: 'crossover-a', type: 'scissors-crossover', trackType: 'commuter-rail', createdAt: 101,
      coords: [[0.49, 0.2], [0.51, 0.21]],
    },
    {
      id: 'crossover-b', type: 'scissors-crossover', trackType: 'commuter-rail', createdAt: 101,
      coords: [[0.49, 0.21], [0.51, 0.2]],
    },
  ];
  const built = new NetworkProjection({ guardBandMeters: 0 }).build({
    network: createGlobalNetwork(source),
    activeTileId: 'T1',
    catalog,
  });

  const groupedTrackIds = new Set(built.state.trackGroups.flatMap(({ trackIds }) => trackIds));
  assert.deepEqual([...groupedTrackIds].sort(), source.tracks.map(({ id }) => id).sort());
  assert.ok(built.state.trackGroups.some(({ type }) => type === 'scissors-crossover'));
  const ordinaryGroups = built.state.trackGroups.filter(({ type }) => type == null);
  assert.equal(ordinaryGroups.length, 2, 'spatially separate rail from one construction batch must not merge');
  for (const group of ordinaryGroups) {
    assert.ok(
      group.trackIds.some((trackId) => {
        const track = source.tracks.find(({ id }) => id === trackId);
        return JSON.stringify(track.coords) === JSON.stringify(group.centerLine);
      }),
      'a recovered centerline must follow member rail instead of cutting a straight chord across it',
    );
  }
});

test('cross-tile finance ownership is global even when the whole route fits in the active 3x3', () => {
  const source = fixtureState();
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(source);

  assert.deepEqual(classifyCrossTileRouteIds(source, catalog), ['long-route']);
  const built = projection.build({ network, activeTileId: 'T2', catalog });

  assert.deepEqual(built.manifest.partialRouteIds, []);
  assert.deepEqual(built.manifest.financeOwnedRouteIds, ['long-route']);
  assert.ok(built.state.routes.find(({ id }) => id === 'long-route').openWorldFinanceOwned);
  assert.ok(built.state.trains.some(({ id }) => id === 'long-train'), 'contained global trains stay native-simulated');
  assert.equal(built.manifest.deferredTrainIds.includes('long-train'), false);
});

test('projects the native 1.6 route-finance envelope without deleting remote route history', () => {
  const source = fixtureState();
  source.routeFinancials = {
    byRoute: {
      'local-route': [{ timestamp: 0, revenue: 10, expenses: 4 }],
      'long-route': [{ timestamp: 0, revenue: 20, expenses: 8 }],
      'remote-route': [{ timestamp: 0, revenue: 30, expenses: 12 }],
    },
    lastHourTimestamp: 3_600,
    currentHour: {
      'local-route': { revenue: 1, expenses: 2 },
      'remote-route': { revenue: 3, expenses: 4 },
    },
  };
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(source);

  const built = projection.build({ network, activeTileId: 'T1', catalog });

  assert.deepEqual(Object.keys(built.state.routeFinancials.byRoute).sort(), ['local-route', 'long-route']);
  assert.deepEqual(Object.keys(built.state.routeFinancials.currentHour), ['local-route']);
  assert.equal(built.state.routeFinancials.lastHourTimestamp, 3_600);
  assert.ok(network.nativeState.routeFinancials.byRoute['remote-route']);
});

test('reconcile deep-merges projected route finances and retains remote history', () => {
  const source = fixtureState();
  source.routeFinancials = {
    byRoute: {
      'local-route': [{ timestamp: 0, revenue: 10, expenses: 4 }],
      'remote-route': [{ timestamp: 0, revenue: 30, expenses: 12 }],
    },
    lastHourTimestamp: 3_600,
    currentHour: {
      'local-route': { revenue: 1, expenses: 2 },
      'remote-route': { revenue: 3, expenses: 4 },
    },
  };
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(source);
  const built = projection.build({ network, activeTileId: 'T1', catalog });
  const nativeState = structuredClone(built.state);
  nativeState.routeFinancials.byRoute['local-route'].push({ timestamp: 3_600, revenue: 5, expenses: 6 });
  nativeState.routeFinancials.lastHourTimestamp = 7_200;
  nativeState.routeFinancials.currentHour = { 'local-route': { revenue: 7, expenses: 8 } };

  const result = projection.reconcile({ network, baseline: built.manifest, nativeSnapshot: nativeState, catalog });

  assert.equal(result.accepted, true);
  assert.deepEqual(result.network.nativeState.routeFinancials.byRoute['remote-route'], [
    { timestamp: 0, revenue: 30, expenses: 12 },
  ]);
  assert.equal(result.network.nativeState.routeFinancials.byRoute['local-route'].length, 2);
  assert.deepEqual(result.network.nativeState.routeFinancials.currentHour, {
    'local-route': { revenue: 7, expenses: 8 },
  });
  assert.equal(result.network.nativeState.routeFinancials.lastHourTimestamp, 7_200);
});

test('the editable window uses the complete spatial 3x3 even when only some tiles are selectable', () => {
  const spatialTiles = Array.from({ length: 9 }, (_, index) => ({
    id: `S${index}`,
    column: index % 3,
    row: Math.floor(index / 3),
    status: 'normal',
    bounds: [index % 3, Math.floor(index / 3), index % 3 + 1, Math.floor(index / 3) + 1],
  }));
  const sparseCatalog = {
    tiles: spatialTiles.filter((tile) => ['S4', 'S5', 'S7'].includes(tile.id)),
    spatialTiles,
  };
  const result = new NetworkProjection({ guardBandMeters: 0 }).build({
    network: createGlobalNetwork({ ...fixtureState(), tracks: [], stations: [], routes: [], trains: [] }),
    activeTileId: 'S4',
    catalog: sparseCatalog,
  });

  assert.equal(result.manifest.editableBounds.length, 9);
  assert.deepEqual(result.manifest.visibleTileIds, spatialTiles.map((tile) => tile.id));
});

test('reconcile accepts constructed station topology entirely inside the 3x3 on a clipped line', () => {
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(fixtureState());
  const built = projection.build({ network, activeTileId: 'T1', catalog });
  const changed = structuredClone(built.state);
  changed.stations.find((station) => station.id === 'inside-b').stNodeIds.push('new-platform-node');
  changed.stations.push({ id: 'new-interior-station', coords: [1.6, 0.5], stNodeIds: ['new-platform-node'] });
  changed.tracks.push({ id: 'new-interior-track', coords: [[1.5, 0.5], [1.7, 0.5]] });

  const result = projection.reconcile({ network, baseline: built.manifest, nativeSnapshot: changed, catalog });

  assert.equal(result.accepted, true);
  assert.ok(result.network.nativeState.stations.some((station) => station.id === 'new-interior-station'));
  assert.ok(result.network.nativeState.tracks.some((track) => track.id === 'new-interior-track'));
});

test('real-schema route remains listed when only a referenced path track crosses the window', () => {
  const source = fixtureState();
  source.routes = [{
    id: 'native-long-route',
    fullName: 'Native long route',
    color: '#8a2be2',
    stNodes: [
      { id: 'remote-node-a', center: [3.4, 0.4], trackIds: ['crossing-track'] },
      { id: 'remote-node-b', center: [3.7, 0.6], trackIds: ['crossing-track'] },
    ],
    stCombos: [{
      startStNodeId: 'remote-node-a',
      endStNodeId: 'remote-node-b',
      path: [
        { trackId: 'inside-track', reversed: false, length: 500 },
        { trackId: 'crossing-track', reversed: false, length: 1_000 },
      ],
    }],
    terminusPlatformAlternates: [{
      platforms: [
        { arrival: { path: [] }, departure: { path: [] } },
        {
          arrival: { path: [{ trackId: 'crossing-track', reversed: false, length: 1_000 }] },
          departure: { path: [{ trackId: 'crossing-track', reversed: true, length: 1_000 }] },
        },
      ],
    }],
    trainSchedule: { highDemand: 5, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1 },
  }];
  source.trains = [{
    id: 'native-long-train',
    routeId: 'native-long-route',
    windows: { train: { tracks: [{ trackId: 'crossing-track' }] } },
  }, {
    id: 'native-local-window-train',
    routeId: 'native-long-route',
    windows: { train: { tracks: [{ trackId: 'inside-track' }] } },
  }];

  const result = new NetworkProjection({ guardBandMeters: 0 }).build({
    network: createGlobalNetwork(source), activeTileId: 'T1', catalog,
  });

  assert.deepEqual(result.state.routes.map((route) => route.id), ['native-long-route']);
  assert.deepEqual(
    result.state.trains.map((train) => train.id),
    [],
    'partial-route trains must remain global but not enter the native simulation with rebased path geometry',
  );
  assert.deepEqual(result.manifest.partialRouteIds, ['native-long-route']);
  const deliveredTrackIds = new Set(result.state.tracks.map((track) => track.id));
  const deliveredRouteTrackIds = result.state.routes[0].stCombos
    .flatMap((combo) => combo.path.map((segment) => segment.trackId));
  const deliveredStationNodeTrackIds = result.state.routes[0].stNodes
    .flatMap((node) => node.trackIds ?? []);
  const deliveredAlternateTrackIds = result.state.routes[0].terminusPlatformAlternates
    .flatMap((group) => group.platforms)
    .flatMap((platform) => [
      ...(platform.arrival?.path ?? []),
      ...(platform.departure?.path ?? []),
    ])
    .map((segment) => segment.trackId);
  assert.ok(
    deliveredRouteTrackIds.every((trackId) => deliveredTrackIds.has(trackId)),
    'a partial route must not be removed by the native missing-track validator',
  );
  assert.ok(
    deliveredStationNodeTrackIds.every((trackId) => deliveredTrackIds.has(trackId)),
    'a partial route must not crash native route geometry or train-window generation',
  );
  assert.ok(
    deliveredAlternateTrackIds.every((trackId) => deliveredTrackIds.has(trackId)),
    'terminus alternates must not crash native getRoutesGeojson',
  );
  assert.deepEqual(
    result.state.routes[0].stNodes.map((node) => node.id),
    [],
    'a route with no delivered stations must use an empty safe facade instead of crashing the route panel',
  );
  assert.deepEqual(
    result.state.routes[0].openWorldGlobalRoute.stNodes.map((node) => node.id),
    ['remote-node-a', 'remote-node-b'],
    'the complete station sequence remains authoritative outside the native facade',
  );
  assert.deepEqual(result.state.routes[0].trainSchedule, {
    highDemand: 5, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1,
  });
  assert.equal(result.state.routes[0].openWorldProjectionDormant, true);
  assert.deepEqual(result.state.routes[0].openWorldGlobalTrainSchedule, {
    highDemand: 5, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1,
  });
  assert.deepEqual(source.routes[0].trainSchedule, {
    highDemand: 5, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1,
  });
  assert.ok(result.overlay.features.some((feature) => feature.properties.kind === 'route-fragment'));
});

test('destination projection removes a stale terminus-alternate track before native save load', () => {
  const source = fixtureState();
  const route = source.routes.find(({ id }) => id === 'local-route');
  route.terminusPlatformAlternates = [{
    platforms: [{
      arrival: {
        path: [
          { trackId: 'inside-track', reversed: false, length: 50 },
          { trackId: 'removed-split-platform@@1', reversed: false, length: 50 },
        ],
      },
      departure: { path: [] },
    }],
  }];

  const result = new NetworkProjection({ guardBandMeters: 0 }).build({
    network: createGlobalNetwork(source),
    activeTileId: 'T1',
    catalog,
    baseSnapshot: { cityCode: 'T1', data: {} },
  });
  const deliveredTrackIds = new Set(result.state.tracks.map(({ id }) => String(id)));
  const deliveredAlternateTrackIds = result.state.routes
    .flatMap(({ terminusPlatformAlternates = [] }) => terminusPlatformAlternates)
    .flatMap(({ platforms = [] }) => platforms)
    .flatMap(({ arrival, departure }) => [
      ...(arrival?.path ?? []),
      ...(departure?.path ?? []),
    ])
    .map(({ trackId }) => String(trackId));

  assert.ok(
    deliveredAlternateTrackIds.every((trackId) => deliveredTrackIds.has(trackId)),
    'loadSave calls getRoutesGeojson, which throws when a terminus path references an absent track',
  );
  assert.deepEqual(
    result.state.routes.find(({ id }) => id === 'local-route').terminusPlatformAlternates,
    [],
    'an incomplete alternate must be omitted instead of drawing its surviving segments as a giant triangle',
  );
});

test('reconcile preserves the authoritative path after editing a partial route schedule', () => {
  const source = fixtureState();
  source.routes = [{
    id: 'native-long-route',
    stNodes: [
      { id: 'remote-node-a', trackIds: ['crossing-track'] },
      { id: 'remote-node-b', trackIds: ['crossing-track'] },
    ],
    stCombos: [{
      startStNodeId: 'remote-node-a',
      endStNodeId: 'remote-node-b',
      path: [{ trackId: 'crossing-track', reversed: false, length: 1_000 }],
    }],
    terminusPlatformAlternates: [{
      platforms: [{
        arrival: { path: [{ trackId: 'crossing-track', reversed: false, length: 1_000 }] },
        departure: { path: [{ trackId: 'crossing-track', reversed: true, length: 1_000 }] },
      }],
    }],
    trainSchedule: { highDemand: 5, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1 },
  }];
  source.trains = [{ id: 'native-long-train', routeId: 'native-long-route' }];
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(source);
  const built = projection.build({ network, activeTileId: 'T1', catalog });
  const changed = structuredClone(built.state);
  changed.routes[0].trainSchedule.highDemand = 7;

  const result = projection.reconcile({
    network, baseline: built.manifest, nativeSnapshot: changed, catalog,
  });

  assert.equal(result.accepted, true);
  assert.deepEqual(result.network.nativeState.routes[0].trainSchedule, {
    highDemand: 7, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1,
  });
  assert.deepEqual(result.network.nativeState.routes[0].stCombos[0].path, [
    { trackId: 'crossing-track', reversed: false, length: 1_000 },
  ]);
  assert.deepEqual(result.network.nativeState.routes[0].stNodes[0].trackIds, ['crossing-track']);
  assert.deepEqual(
    result.network.nativeState.routes[0].terminusPlatformAlternates[0].platforms[0].arrival.path,
    [{ trackId: 'crossing-track', reversed: false, length: 1_000 }],
  );
});

test('partial-route frequency edit survives when the native editor rebuilds the route without mod metadata', () => {
  const source = fixtureState();
  source.routes = [{
    id: 'native-long-route',
    stNodes: [
      { id: 'remote-node-a', trackIds: ['crossing-track'] },
      { id: 'remote-node-b', trackIds: ['crossing-track'] },
    ],
    stCombos: [{
      startStNodeId: 'remote-node-a',
      endStNodeId: 'remote-node-b',
      path: [{ trackId: 'crossing-track', reversed: false, length: 1_000 }],
    }],
    trainSchedule: { highDemand: 5, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1 },
  }];
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(source);
  const built = projection.build({ network, activeTileId: 'T1', catalog });
  const changed = structuredClone(built.state);
  changed.routes[0] = {
    ...changed.routes[0],
    trainSchedule: { highDemand: 6, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1 },
  };
  delete changed.routes[0].openWorldProjectionDormant;
  delete changed.routes[0].openWorldGlobalTrainSchedule;
  delete changed.routes[0].openWorldGlobalIdealTrainCount;

  const result = projection.reconcile({
    network, baseline: built.manifest, nativeSnapshot: changed, catalog,
  });

  assert.equal(result.accepted, true);
  assert.deepEqual(result.network.nativeState.routes[0].trainSchedule, {
    highDemand: 6, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1,
  });
  const rebuilt = projection.build({
    network: result.network, activeTileId: 'T1', catalog,
  });
  assert.deepEqual(rebuilt.state.routes[0].trainSchedule, {
    highDemand: 6, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1,
  }, 'the restored clipped-route panel must display the edited schedule');
});

test('projection hashes are deterministic', () => {
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(fixtureState());
  const first = projection.build({ network, activeTileId: 'T1', catalog });
  const second = projection.build({ network: structuredClone(network), activeTileId: 'T1', catalog: structuredClone(catalog) });
  assert.equal(first.manifest.projectionHash, second.manifest.projectionHash);
  assert.deepEqual(first.overlay, second.overlay);
});

test('reconcile accepts contained schedule changes without shortening partial routes', () => {
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(fixtureState());
  const built = projection.build({ network, activeTileId: 'T1', catalog });
  const changed = structuredClone(built.state);
  changed.routes[0].timetableSchedule.periods[0].headwaySeconds = 240;

  const result = projection.reconcile({ network, baseline: built.manifest, nativeSnapshot: changed, catalog });

  assert.equal(result.accepted, true);
  assert.equal(result.changed, true);
  assert.equal(result.network.routeDescriptors['local-route'].timetableSchedule.periods[0].headwaySeconds, 240);
  assert.equal(result.network.routeDescriptors['long-route'].timetableSchedule.periods[0].headwaySeconds, 600);
  assert.deepEqual(result.network.routeDescriptors['long-route'].orderedStationIds, ['inside-b', 'outside']);
  assert.deepEqual(
    result.network.nativeState.stations.find((station) => station.id === 'inside-b').routeIds,
    ['local-route', 'long-route'],
    'unchanged projected stations must retain unseen global route references',
  );
});

test('reconcile permits partial-route schedule edits but rejects partial topology edits', () => {
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(fixtureState());
  const built = projection.build({ network, activeTileId: 'T1', catalog });
  const scheduleChanged = structuredClone(built.state);
  scheduleChanged.routes.find((route) => route.id === 'long-route')
    .timetableSchedule.periods[0].headwaySeconds = 420;

  const scheduleResult = projection.reconcile({
    network, baseline: built.manifest, nativeSnapshot: scheduleChanged, catalog,
  });

  assert.equal(scheduleResult.accepted, true);
  assert.equal(scheduleResult.network.routeDescriptors['long-route'].timetableSchedule.periods[0].headwaySeconds, 420);

  const topologyChanged = structuredClone(built.state);
  topologyChanged.routes.find((route) => route.id === 'long-route').stationIds = ['inside-a', 'inside-b'];
  const topologyResult = projection.reconcile({
    network, baseline: built.manifest, nativeSnapshot: topologyChanged, catalog,
  });

  assert.equal(topologyResult.accepted, false);
  assert.ok(topologyResult.warning.affectedObjectIds.includes('long-route'));
});

test('reconcile accepts an explicitly localized topology edit on a clipped route', () => {
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(fixtureState());
  const built = projection.build({ network, activeTileId: 'T1', catalog });
  const changed = structuredClone(built.state);
  changed.stations.push({ id: 'new-inside', coords: [1.7, 0.5], stNodeIds: ['new-inside-node'], routeIds: ['long-route'] });
  const route = changed.routes.find(({ id }) => id === 'long-route');
  route.stationIds = ['inside-b', 'new-inside', 'outside'];
  route.stNodes = [{ id: 'b' }, { id: 'new-inside-node' }];
  route.openWorldGlobalRoute = {
    ...structuredClone(network.nativeState.routes.find(({ id }) => id === 'long-route')),
    stationIds: ['inside-b', 'new-inside', 'outside'],
    stNodes: [{ id: 'b' }, { id: 'new-inside-node' }, { id: 'c' }],
  };
  route.openWorldProjectionLocalEdit = true;

  const result = projection.reconcile({ network, baseline: built.manifest, nativeSnapshot: changed, catalog });

  assert.equal(result.accepted, true);
  assert.deepEqual(
    result.network.nativeState.routes.find(({ id }) => id === 'long-route').stationIds,
    ['inside-b', 'new-inside', 'outside'],
  );
  assert.deepEqual(
    result.network.nativeState.routes.find(({ id }) => id === 'long-route').stNodes,
    [{ id: 'b' }, { id: 'new-inside-node' }, { id: 'c' }],
    'the saved canonical route must retain remote nodes omitted from the editable facade',
  );
  assert.equal(
    Object.keys(result.network.nativeState.routes.find(({ id }) => id === 'long-route'))
      .some((key) => key.startsWith('openWorld')),
    false,
  );
});

test('reconcile retains a track while the edited canonical route still references it', () => {
  const source = fixtureState();
  source.routes.find(({ id }) => id === 'long-route').trackIds = ['inside-track', 'crossing-track'];
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(source);
  const built = projection.build({ network, activeTileId: 'T1', catalog });
  const changed = structuredClone(built.state);
  changed.tracks = changed.tracks.filter(({ id }) => id !== 'inside-track');
  const route = changed.routes.find(({ id }) => id === 'long-route');
  route.openWorldProjectionLocalEdit = true;
  route.openWorldGlobalRoute = structuredClone(source.routes.find(({ id }) => id === 'long-route'));

  const result = projection.reconcile({ network, baseline: built.manifest, nativeSnapshot: changed, catalog });

  assert.equal(result.accepted, true);
  assert.ok(
    result.network.nativeState.tracks.some(({ id }) => id === 'inside-track'),
    'a native track split must not orphan the still-canonical route path before its replacement edge is complete',
  );
});

test('reconcile does not mistake a native-normalized missing partial route for deletion', () => {
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(fixtureState());
  const built = projection.build({ network, activeTileId: 'T1', catalog });
  const normalized = structuredClone(built.state);
  normalized.routes = normalized.routes.filter((route) => route.id !== 'long-route');
  normalized.trains = normalized.trains.filter((train) => train.routeId !== 'long-route');

  const result = projection.reconcile({
    network, baseline: built.manifest, nativeSnapshot: normalized, catalog,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.warning.code, 'boundary-dependency');
  assert.ok(result.warning.affectedObjectIds.includes('long-route'));
  assert.ok(result.network.nativeState.routes.some((route) => route.id === 'long-route'));
  assert.ok(result.network.nativeState.trains.some((train) => train.id === 'long-train'));
});

test('reconcile accepts an optional native field that exists on only one side of the diff', () => {
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(fixtureState());
  const built = projection.build({ network, activeTileId: 'T1', catalog });
  const changed = structuredClone(built.state);
  changed.stations.find((station) => station.id === 'inside-a').customName = 'Renamed station';

  const result = projection.reconcile({ network, baseline: built.manifest, nativeSnapshot: changed, catalog });

  assert.equal(result.accepted, true);
  assert.equal(result.changed, true);
  assert.equal(
    result.network.nativeState.stations.find((station) => station.id === 'inside-a').customName,
    'Renamed station',
  );
});

test('reconcile ignores unchanged guard-band dependencies while accepting an interior edit', () => {
  const projection = new NetworkProjection({ guardBandMeters: 60_000 });
  const network = createGlobalNetwork(fixtureState());
  const built = projection.build({ network, activeTileId: 'T1', catalog });
  assert.ok(built.manifest.protectedStationIds.includes('outside'));
  assert.ok(built.state.tracks.some((track) => track.id === 'crossing-track'));
  const changed = structuredClone(built.state);
  changed.stations.find((station) => station.id === 'inside-a').name = 'Interior edit';

  const result = projection.reconcile({ network, baseline: built.manifest, nativeSnapshot: changed, catalog });

  assert.equal(result.accepted, true);
  assert.equal(result.changed, true);
  assert.equal(result.network.nativeState.stations.find((station) => station.id === 'inside-a').name, 'Interior edit');
});

test('reconcile rejects and rolls back construction outside the editable window', () => {
  const projection = new NetworkProjection({ guardBandMeters: 0 });
  const network = createGlobalNetwork(fixtureState());
  const built = projection.build({ network, activeTileId: 'T1', catalog });
  const changed = structuredClone(built.state);
  changed.tracks.push({ id: 'illegal-track', coords: [[2.8, 0.4], [3.4, 0.4]] });

  const result = projection.reconcile({ network, baseline: built.manifest, nativeSnapshot: changed, catalog });

  assert.equal(result.accepted, false);
  assert.equal(result.warning.code, 'outside-window');
  assert.ok(result.warning.affectedObjectIds.includes('illegal-track'));
  assert.deepEqual(result.warning.suggestedTileIds, ['T3']);
  assert.deepEqual(result.rollbackState, built.manifest.baselineState);
  assert.equal(result.network.hash, network.hash);
});

test('stripNetworkFromSnapshot retains tile-local state and removes copied network bodies', () => {
  const snapshot = { cityCode: 'T1', data: { ...fixtureState(), money: 123, localMarker: 'keep' } };
  const stripped = stripNetworkFromSnapshot(snapshot);
  assert.equal(stripped.data.localMarker, 'keep');
  assert.equal(stripped.data.money, 123);
  assert.deepEqual(stripped.data.tracks, []);
  assert.deepEqual(stripped.data.routes, []);
  assert.deepEqual(stripped.data.stations, []);
});
