import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { WorldTileRuntime } from '../src/world-tile-runtime.js';
import { FakeGameAdapter } from '../src/adapters/fake-game-adapter.js';
import { MemoryTilePackageAdapter } from '../src/adapters/memory-tile-package-adapter.js';
import { HttpTilePackageAdapter } from '../src/adapters/http-tile-package-adapter.js';
import { ModStorageWorldStateAdapter } from '../src/adapters/mod-storage-world-state-adapter.js';
import { compactNativeSnapshot, SubwayBuilderGameAdapter } from '../src/adapters/subway-builder-game-adapter.js';
import { createGlobalNetwork } from '../src/network-projection.js';
import { applyNetworkRecovery } from '../src/network-recovery.js';
import { packages, cohorts } from '../fixtures/two-tile-fixture.js';

function setup(options = {}) {
  const game = new FakeGameAdapter(options);
  const storage = new ModStorageWorldStateAdapter();
  const runtime = new WorldTileRuntime({ game, worldState: storage, tilePackages: new MemoryTilePackageAdapter(packages), initialWorld: { wallet: 100, cohorts } });
  return { game, storage, runtime };
}

function setupProjectedRuntime() {
  const game = new FakeGameAdapter();
  const storage = new ModStorageWorldStateAdapter();
  const tilePackages = new MemoryTilePackageAdapter({
    T0: {
      manifest: { tileId: 'T0', cityCode: 'T0', schemaVersion: 1, dataFiles: {} },
      demand: [],
      commuteCatalog: { buildHash: 'projected-runtime', buckets: [], gateways: [] },
    },
  });
  const runtime = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages,
    tileCatalog: { tiles: [{ id: 'T0', column: 0, row: 0, bounds: [0, 0, 1, 1] }] },
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
  });
  return { game, storage, runtime };
}

test('boot reports a complete startup performance breakdown', async () => {
  const game = new FakeGameAdapter();
  const telemetry = [];
  let clock = 0;
  const runtime = new WorldTileRuntime({
    game,
    worldState: new ModStorageWorldStateAdapter(),
    tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { activeTileId: 'KCW', wallet: 100, cohorts: [] },
    now: () => (clock += 5),
    telemetry: (event) => telemetry.push(event),
  });

  await runtime.boot('startup-performance-world', 'KCW');

  const performanceEvent = telemetry.find(({ phase }) => phase === 'startup-performance');
  assert.ok(performanceEvent);
  assert.equal(performanceEvent.status, 'ready');
  assert.equal(performanceEvent.tileId, 'KCW');
  assert.ok(performanceEvent.milliseconds > 0);
  assert.deepEqual(Object.keys(performanceEvent.stages), [
    'capability',
    'storageLoad',
    'worldPreparation',
    'packagePreparation',
    'packageAdoption',
    'pause',
    'stateAdoption',
    'authoritativeGlobals',
    'nativeCommuteRefresh',
    'verification',
    'networkProfile',
    'snapshotFallback',
    'storageSave',
    'pauseRestore',
  ]);
  for (const duration of Object.values(performanceEvent.stages)) assert.ok(duration >= 0);
});

test('autosave checkpoint is non-mutating and preserves the player pause state', async () => {
  const { runtime, game } = setupProjectedRuntime();
  await runtime.boot('non-mutating-autosave', 'T0');
  game.paused = true;
  game.log.length = 0;

  await runtime.checkpoint('game-save', { saveName: 'Autosave' });

  assert.equal(game.log.includes('restoreSnapshot'), false, 'autosave must never invoke native loadSave');
  assert.equal(game.paused, true, 'autosave must leave a paused game paused');
  assert.equal(game.log.includes('resume'), false, 'autosave must not force the simulation to resume');
});

test('accepted in-window construction does not reload the save or change pause state', async () => {
  const { runtime, game } = setupProjectedRuntime();
  await runtime.boot('non-mutating-reconcile', 'T0');
  let commuteRefreshes = 0;
  game.refreshNativeCommutes = async () => {
    commuteRefreshes++;
    return { status: 'recalculated', refreshed: 1 };
  };
  game.native.tracks = [{ id: 'inside-track', coords: [[0.2, 0.2], [0.8, 0.2]] }];
  game.paused = true;
  game.log.length = 0;

  const result = await runtime.reconcileActiveProjection('track-built');

  assert.equal(result.status, 'accepted');
  assert.equal(game.log.includes('restoreSnapshot'), false, 'accepted edits must not invoke native loadSave');
  assert.equal(game.paused, true, 'reconciliation must preserve a user pause');
  assert.equal(game.log.includes('resume'), false, 'accepted edits must not force the simulation to resume');
  assert.equal(commuteRefreshes, 1, 'accepted topology edits must refresh native pop paths');
});

test('loading a save preserves the pause state selected by the player', async () => {
  const { runtime, game } = setup();
  await runtime.boot('paused-save-reload', 'KCW');
  await runtime.checkpoint('game-save', { saveName: 'Paused save' });
  game.paused = true;
  game.log.length = 0;

  await runtime.reloadFromSave('paused-save-reload', 'KCW', 'Paused save');

  assert.equal(game.paused, true);
  assert.equal(game.log.at(-1), 'pause', 'save reload must restore the player-selected paused state');
});

test('commits a transition once and makes duplicate destination requests idempotent', async () => {
  const { runtime } = setup(); await runtime.boot('fixture');
  const [a, b] = await Promise.all([runtime.transitionTo('KCE'), runtime.transitionTo('KCE')]);
  assert.equal(a.status, 'committed'); assert.equal(b.transitionId, a.transitionId);
  const repeat = await runtime.transitionTo('KCE');
  assert.equal(repeat.status, 'already-active'); assert.equal(runtime.view().revision, 1);
});

test('rolls game and world back when a native load phase fails', async () => {
  const { runtime, game, storage } = setup(); await runtime.boot('fixture');
  const before = runtime.view(); game.failAt = 'loadStaticPackage';
  await assert.rejects(runtime.transitionTo('KCE'), /Injected game failure/);
  assert.deepEqual(runtime.view(), before);
  assert.equal(game.currentPackage.manifest.tileId, 'KCW');
  assert.equal((await storage.load('fixture')).activeTileId, 'KCW');
});

test('an aborted staged projection quarantines later autosaves until authoritative rail is restored', async () => {
  const game = new FakeGameAdapter();
  const storage = new ModStorageWorldStateAdapter();
  const tilePackages = new MemoryTilePackageAdapter(Object.fromEntries(['T0', 'T1'].map((tileId) => [tileId, {
    manifest: { tileId, cityCode: tileId, schemaVersion: 1, dataFiles: {} },
    demand: [],
    commuteCatalog: { buildHash: 'projection-quarantine', buckets: [], gateways: [] },
  }])));
  const runtimeOptions = {
    game,
    worldState: storage,
    tilePackages,
    tileCatalog: { tiles: [
      { id: 'T0', column: 0, row: 0, bounds: [0, 0, 1, 1] },
      { id: 'T1', column: 1, row: 0, bounds: [1, 0, 2, 1] },
    ] },
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
  };
  const runtime = new WorldTileRuntime(runtimeOptions);
  await runtime.boot('projection-quarantine-world', 'T0');
  game.native.tracks = [{ id: 'authoritative-track', coords: [[0.2, 0.2], [0.8, 0.2]] }];
  await runtime.reconcileActiveProjection('track-built');
  await runtime.stageNavigationTransition('T1');

  // The destination city loader has cleared transit state, then native
  // loadSave aborts before the authoritative projection can be published.
  game.native.tracks = [];
  game.failAt = 'restoreSnapshot';
  await assert.rejects(runtime.completeStagedTransition('T1'), /Injected game failure/);

  const quarantined = await storage.load('projection-quarantine-world');
  assert.equal(quarantined.projectionWriteQuarantine?.active, true);
  assert.equal(quarantined.projectionWriteQuarantine?.tileId, 'T1');
  assert.deepEqual(
    quarantined.globalNetwork.nativeState.tracks.map(({ id }) => id),
    ['authoritative-track'],
  );

  game.failAt = null;
  const checkpoint = await runtime.checkpoint('game-save', { saveName: 'Autosave after failure' });
  assert.equal(checkpoint.status, 'projection-quarantined');
  assert.deepEqual(
    (await storage.load('projection-quarantine-world')).globalNetwork.nativeState.tracks.map(({ id }) => id),
    ['authoritative-track'],
  );

  const recovered = new WorldTileRuntime(runtimeOptions);
  await recovered.boot('projection-quarantine-world', 'T1');
  assert.equal(recovered.view().projectionWriteQuarantine, null);
  assert.deepEqual(game.native.tracks.map(({ id }) => id), ['authoritative-track']);
});

test('stages a live tile switch for route navigation without loading a city in place', async () => {
  const { runtime, game, storage } = setup();
  await runtime.boot('reload-world');
  game.log.length = 0;

  const result = await runtime.stageNavigationTransition('KCE');

  assert.equal(result.status, 'reload-required');
  assert.equal(result.worldId, 'reload-world');
  assert.equal(runtime.view().activeTileId, 'KCE');
  assert.equal(game.log.includes('loadStaticPackage'), false);
  const saved = await storage.load('reload-world');
  assert.equal(saved.pendingTransition.to, 'KCE');
  assert.ok(saved.tiles.KCW.snapshot);
});

test('completes a staged switch after the destination city loads through its route', async () => {
  const { runtime, game, storage } = setup();
  await runtime.boot('route-world');
  const staged = await runtime.stageNavigationTransition('KCE');
  // The game route's StoreInitializer has now reset and loaded native KCE.
  game.native = { ...game.native, objects: [], activity: { departures: [], walletDelta: 0 } };

  const result = await runtime.completeStagedTransition('KCE');

  assert.equal(result.status, 'committed');
  assert.equal(result.transitionId, staged.transitionId);
  assert.equal(game.currentPackage.manifest.tileId, 'KCE');
  const saved = await storage.load('route-world');
  assert.equal(saved.pendingTransition, null);
  assert.equal(saved.activeTileId, 'KCE');
});

test('tile completion refreshes visible native demand but defers statewide finance recalculation', async () => {
  const { runtime, game } = setup();
  await runtime.boot('destination-demand-refresh');
  await runtime.stageNavigationTransition('KCE');
  game.native = { ...game.native, objects: [], activity: { departures: [], walletDelta: 0 } };
  const events = [];
  game.refreshNativeCommutes = async () => {
    events.push('native-demand');
    return { status: 'recalculated', refreshed: 12 };
  };
  const calculateNativeFinanceProfile = game.calculateNativeFinanceProfile.bind(game);
  game.calculateNativeFinanceProfile = (...args) => {
    events.push('finance-profile');
    return calculateNativeFinanceProfile(...args);
  };

  await runtime.completeStagedTransition('KCE');

  assert.deepEqual(events, ['native-demand']);
  assert.equal(runtime.view().backgroundNativeFinance.tileRevenueProfiles.KCE, undefined);
});

test('network recalculation evaluates native demand for an unvisited tile', async () => {
  const nativeDemand = {
    points: [
      { id: 'home', location: [-73.8, 42.7], residents: 100, jobs: 0 },
      { id: 'work', location: [-73.7, 42.7], residents: 0, jobs: 100 },
    ],
    pops: [{
      id: 'remote-pop', size: 100, residenceId: 'home', jobId: 'work',
      drivingSeconds: 3_600, drivingDistance: 25_000,
    }],
  };
  const packageFixture = Object.fromEntries(['T0', 'T1'].map((tileId) => [tileId, {
    manifest: { tileId, cityCode: tileId, schemaVersion: 1, dataFiles: {} },
    nativeDemand,
    commuteCatalog: { buildHash: 'off-tile-native', buckets: [], gateways: [] },
  }]));
  const game = new FakeGameAdapter();
  const runtime = new WorldTileRuntime({
    game,
    worldState: new ModStorageWorldStateAdapter(),
    tilePackages: new MemoryTilePackageAdapter(packageFixture),
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
  });
  await runtime.boot('off-tile-native-world', 'T0');
  runtime.world.globalNetwork = {
    hash: 'global-network',
    nativeState: {
      stations: [
        { id: 'home-station', coords: [-73.8, 42.7], stNodeIds: ['home-node'], buildType: 'constructed' },
        { id: 'work-station', coords: [-73.7, 42.7], stNodeIds: ['work-node'], buildType: 'constructed' },
      ],
      routes: [{
        id: 'R', stNodes: [{ id: 'home-node' }, { id: 'work-node' }], idealTrainCount: 2,
        stComboTimings: [
          { stNodeIndex: 0, arrivalTime: 0, departureTime: 20 },
          { stNodeIndex: 1, arrivalTime: 600, departureTime: 620 },
        ],
      }],
      trains: [], fareGroups: [], tracks: [], trackGroups: [],
    },
  };
  runtime.world.activeProjection = { financeOwnedRouteIds: [], financeOwnedTrackIds: [] };

  await runtime.recalculateCrossTileModeShare({ reason: 'network-change', force: true });

  const profiles = runtime.view().backgroundNativeFinance.tileRevenueProfiles;
  assert.equal(game.currentPackage.manifest.tileId, 'T0');
  assert.equal(profiles.T0.source, 'off-tile-estimator');
  assert.equal(profiles.T1.source, 'off-tile-estimator');
  assert.ok(profiles.T1.dailyRevenue > 0);
});

test('cached native demand is not recalculated by startup, save-load, or tile lifecycle events', async () => {
  const nativeDemand = { points: [], pops: [] };
  const packageFixture = Object.fromEntries(Object.entries(packages).map(([tileId, pkg]) => [tileId, {
    ...structuredClone(pkg), nativeDemand,
  }]));
  const tilePackages = new MemoryTilePackageAdapter(packageFixture);
  let nativeDemandLoads = 0;
  const loadNativeDemand = tilePackages.loadNativeDemand.bind(tilePackages);
  tilePackages.loadNativeDemand = async (...args) => {
    nativeDemandLoads++;
    return loadNativeDemand(...args);
  };
  const runtime = new WorldTileRuntime({
    game: new FakeGameAdapter(),
    worldState: new ModStorageWorldStateAdapter(),
    tilePackages,
    initialWorld: { activeTileId: 'KCW', wallet: 100, cohorts },
  });
  await runtime.boot('passive-lifecycle-cache', 'KCW');
  runtime.world.crossModeShare = {
    schemaVersion: 1, day: 1, reason: 'midnight-change', calculatedAtHour: 24,
    evaluatedPops: 0, transitViablePops: 0, changedFlows: 0, revision: 1,
  };
  for (const tileId of runtime.world.tileIds) {
    runtime.world.backgroundNativeFinance.tileRevenueProfiles[tileId] = {
      schemaVersion: 3,
      source: 'off-tile-estimator',
      evaluatorSchemaVersion: 3,
      contextKey: `${tileId}:context`,
      evaluationKey: `${tileId}:cached`,
      tileId,
      hourly: Array.from({ length: 24 }, () => ({ revenue: 0, revenueByRoute: {} })),
      transitPopulation: 0,
      dailyRevenue: 0,
    };
  }
  runtime.world.backgroundNativeFinance.networkHash = runtime.world.globalNetwork?.hash ?? null;

  for (const reason of ['startup', 'save-load', 'tile-transition']) {
    const result = await runtime.recalculateCrossTileModeShare({ reason });
    assert.equal(result.status, 'cached');
  }
  assert.equal(nativeDemandLoads, 0);

  await runtime.recalculateCrossTileModeShare({ reason: 'midnight-change', day: 2 });
  assert.ok(nativeDemandLoads > 0, 'an explicit dirty midnight must still evaluate stale native demand');
});

test('route and fare-group changes recalculate native demand only for tiles served by their routes', async () => {
  const tileIds = ['T0', 'T1', 'T2'];
  const nativeDemand = { points: [], pops: [] };
  const tilePackages = new MemoryTilePackageAdapter(Object.fromEntries(tileIds.map((tileId) => [tileId, {
    manifest: { tileId, cityCode: tileId, schemaVersion: 1, dataFiles: {} },
    demand: [], nativeDemand,
    commuteCatalog: { buildHash: 'selective-native-demand', buckets: [], gateways: [] },
  }])));
  const loadedNativeDemand = [];
  const loadNativeDemand = tilePackages.loadNativeDemand.bind(tilePackages);
  tilePackages.loadNativeDemand = async (tileId) => {
    loadedNativeDemand.push(tileId);
    return loadNativeDemand(tileId);
  };
  const catalog = {
    tiles: tileIds.map((id, column) => ({ id, column, row: 0, bounds: [column, 0, column + 1, 1] })),
  };
  const stations = [
    { id: 'A0', coords: [0.5, 0.5], stNodeIds: ['A0-node'], buildType: 'constructed' },
    { id: 'A1', coords: [1.5, 0.5], stNodeIds: ['A1-node'], buildType: 'constructed' },
    { id: 'B0', coords: [2.2, 0.5], stNodeIds: ['B0-node'], buildType: 'constructed' },
    { id: 'B1', coords: [2.8, 0.5], stNodeIds: ['B1-node'], buildType: 'constructed' },
  ];
  const route = (id, nodeIds, idealTrainCount) => ({
    id, idealTrainCount, stNodes: nodeIds.map((nodeId) => ({ id: nodeId })),
    stComboTimings: nodeIds.map((_, index) => ({
      stNodeIndex: index, arrivalTime: index * 600, departureTime: index * 600 + 20,
    })),
  });
  const nativeState = {
    stations,
    routes: [route('route-A', ['A0-node', 'A1-node'], 2), route('route-B', ['B0-node', 'B1-node'], 2)],
    trains: [], tracks: [], trackGroups: [], stationGroups: [], signals: [],
    fareGroups: [
      { id: 'fare-A', routeIds: ['route-A'], fareSystem: 'flat', flatFare: 2.5 },
      { id: 'fare-B', routeIds: ['route-B'], fareSystem: 'flat', flatFare: 3 },
    ],
    crossings: [], junctions: [],
  };
  const game = new FakeGameAdapter();
  game.native.fareGroups = structuredClone(nativeState.fareGroups);
  const runtime = new WorldTileRuntime({
    game,
    worldState: new ModStorageWorldStateAdapter(),
    tilePackages,
    tileCatalog: catalog,
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
  });
  await runtime.boot('selective-native-demand', 'T0');
  runtime.world.globalNetwork = createGlobalNetwork(nativeState);
  await runtime.recalculateCrossTileModeShare({ reason: 'midnight-change', day: 1, force: true });
  loadedNativeDemand.length = 0;

  runtime.world.globalNetwork = createGlobalNetwork({
    ...nativeState,
    routes: [route('route-A', ['A0-node', 'A1-node'], 3), nativeState.routes[1]],
  }, 1);
  await runtime.recalculateCrossTileModeShare({ reason: 'midnight-change', day: 2 });

  assert.deepEqual(loadedNativeDemand.sort(), ['T0', 'T1']);

  loadedNativeDemand.length = 0;
  game.native.fareGroups = structuredClone(nativeState.fareGroups);
  game.native.fareGroups[0].flatFare = 4;
  await runtime.recalculateCrossTileModeShare({ reason: 'midnight-change', day: 3 });

  assert.deepEqual(loadedNativeDemand.sort(), ['T0', 'T1']);
});

test('capturing visible fare groups preserves a wholly unrendered fare group', async () => {
  const { runtime, game } = setupProjectedRuntime();
  await runtime.boot('unrendered-fare-group', 'T0');
  runtime.world.globalNetwork = createGlobalNetwork({
    ...game.native,
    fareGroups: [
      { id: 'visible', routeIds: ['visible-route'], fareSystem: 'flat', flatFare: 2.5 },
      { id: 'remote', routeIds: ['remote-route'], fareSystem: 'flat', flatFare: 3.5 },
    ],
  });
  game.native.fareGroups = [
    { id: 'visible', routeIds: ['visible-route'], fareSystem: 'flat', flatFare: 4 },
  ];

  await runtime.recalculateCrossTileModeShare({ reason: 'midnight-change', day: 1, force: true });

  assert.deepEqual(runtime.world.globalNetwork.nativeState.fareGroups.map(({ id }) => id).sort(), ['remote', 'visible']);
});

test('keeps the visible transit network when switching logical city saves', async () => {
  const { runtime, game, storage } = setup();
  const network = {
    tracks: [{ id: 'shared-track', coords: [[-94.7, 39.1], [-94.5, 39.1]] }],
    stations: [{ id: 'shared-station', coords: [-94.6, 39.1] }],
    routes: [{ id: 'shared-route', stNodes: [{ id: 'shared-node' }] }],
    trains: [{ id: 'shared-train', routeId: 'shared-route' }],
  };
  Object.assign(game.native, structuredClone(network));
  await runtime.boot('shared-network-world');

  await runtime.stageNavigationTransition('KCE');
  assert.deepEqual((await storage.load('shared-network-world')).tiles.KCW.snapshot.tracks, network.tracks);
  // Remix loads KCE through its native city route, which resets these slices.
  Object.assign(game.native, { tracks: [], stations: [], routes: [], trains: [] });
  await runtime.completeStagedTransition('KCE');

  for (const [key, value] of Object.entries(network)) assert.deepEqual(game.native[key], value, key);

  const expandedNetwork = {
    tracks: [...network.tracks, { id: 'east-track', coords: [[-94.5, 39.1], [-94.4, 39.1]] }],
    stations: [...network.stations, { id: 'east-station', coords: [-94.4, 39.1] }],
    routes: [...network.routes, { id: 'east-route', stNodes: [{ id: 'east-node' }] }],
    trains: [...network.trains, { id: 'east-train', routeId: 'east-route' }],
  };
  Object.assign(game.native, structuredClone(expandedNetwork));
  await runtime.stageNavigationTransition('KCW');
  Object.assign(game.native, { tracks: [], stations: [], routes: [], trains: [] });
  await runtime.completeStagedTransition('KCW');
  for (const [key, value] of Object.entries(expandedNetwork)) assert.deepEqual(game.native[key], value, key);
});

test('a fresh renderer boot captures the pending destination network profile', async () => {
  const game = new FakeGameAdapter();
  const storage = new ModStorageWorldStateAdapter();
  const handoffPackages = structuredClone(packages);
  for (const tilePackage of Object.values(handoffPackages)) tilePackage.commuteCatalog.gateways[0].location = [-94.6035, 39.1];
  const runtime = new WorldTileRuntime({ game, storage, worldState: storage, tilePackages: new MemoryTilePackageAdapter(handoffPackages), initialWorld: { wallet: 100, cohorts } });
  game.native.networkProfile = {
    schemaVersion: 1, tileId: 'KCW', signature: 'west', pathfindingRules: {}, activeRouteIds: ['west-route'],
    stations: [{ id: 'west-home', coords: [-94.66, 39.1], stNodeIds: ['west-home-node'], nearbyStations: [] }, { id: 'west-gate', coords: [-94.604, 39.1], stNodeIds: ['west-gate-node'], nearbyStations: [] }],
    routes: [{ id: 'west-route', stNodeIds: ['west-home-node', 'west-gate-node'], serviceCount: 1 }],
  };
  await runtime.boot('renderer-handoff', 'KCW');
  await runtime.stageNavigationTransition('KCE');

  const destinationGame = new FakeGameAdapter();
  destinationGame.native.networkProfile = {
    schemaVersion: 1, tileId: 'KCE', signature: 'east', pathfindingRules: {}, activeRouteIds: ['east-route'],
    stations: [{ id: 'east-gate', coords: [-94.603, 39.1], stNodeIds: ['east-gate-node'], nearbyStations: [] }, { id: 'east-work', coords: [-94.54, 39.1], stNodeIds: ['east-work-node'], nearbyStations: [] }],
    routes: [{ id: 'east-route', stNodeIds: ['east-gate-node', 'east-work-node'], serviceCount: 1 }],
  };
  const reloaded = new WorldTileRuntime({ game: destinationGame, worldState: storage, tilePackages: new MemoryTilePackageAdapter(handoffPackages), initialWorld: { wallet: 100, cohorts } });
  await reloaded.boot('renderer-handoff', 'KCE');
  const demand = {
    schemaVersion: 1, gateways: ['central'],
    points: [['home', -94.66, 39.1, 'KCW', 100, 0], ['work', -94.54, 39.1, 'KCE', 0, 100]],
    pops: [['pop', 100, 0, 1, 0]],
  };

  assert.equal(reloaded.inspectCrossTileTransitPath(demand, 0).available, true);
});

test('a late city-load callback is idempotent after destination boot committed the handoff', async () => {
  const source = setup();
  await source.runtime.boot('late-city-load', 'KCW');
  const staged = await source.runtime.stageNavigationTransition('KCE');

  const destinationGame = new FakeGameAdapter();
  const destination = new WorldTileRuntime({
    game: destinationGame,
    worldState: source.storage,
    tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { wallet: 100, cohorts },
  });
  await destination.boot('late-city-load', 'KCE');

  const result = await destination.completeStagedTransition('KCE');
  assert.equal(result.status, 'already-committed');
  assert.equal(result.transitionId, staged.transitionId);
  assert.equal(destination.view().activeTileId, 'KCE');
});

test('fresh destination boot restores in-window native rail and clipped cross-window rail', async () => {
  const tileIds = ['T0', 'T1', 'T2', 'T3'];
  const catalog = {
    tiles: tileIds.map((id, column) => ({ id, column, row: 0, bounds: [column, 0, column + 1, 1] })),
  };
  const emptyCatalog = { buildHash: 'projection-handoff', buckets: [], gateways: [] };
  const handoffPackages = Object.fromEntries(tileIds.map((tileId) => [tileId, {
    manifest: { tileId, cityCode: tileId, schemaVersion: 1, dataFiles: {} },
    demand: [], commuteCatalog: emptyCatalog,
  }]));
  const storage = new ModStorageWorldStateAdapter();
  const sourceGame = new FakeGameAdapter();
  Object.assign(sourceGame.native, {
    tracks: [
      { id: 'west-track', coords: [[0.2, 0.5], [0.8, 0.5]] },
      { id: 'crossing-track', coords: [[0.8, 0.5], [3.5, 0.5]] },
      { id: 'east-track', coords: [[3.2, 0.7], [3.8, 0.7]] },
    ],
    stations: [
      { id: 'west', coords: [0.2, 0.5], stNodeIds: ['west-node'] },
      { id: 'east', coords: [3.5, 0.5], stNodeIds: ['east-node'] },
    ],
    routes: [{
      id: 'statewide', color: '#f00', stationIds: ['west', 'east'],
      trackIds: ['west-track', 'crossing-track', 'east-track'],
      trainSchedule: { highDemand: 4 },
    }],
    trains: [], trackGroups: [], signals: [], stNodes: [], stationGroups: [], fareGroups: [], routeFinancials: {},
  });
  const source = new WorldTileRuntime({
    game: sourceGame,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter(handoffPackages),
    tileCatalog: catalog,
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
  });
  await source.boot('projected-handoff', 'T0');
  await source.stageNavigationTransition('T3');

  const destinationGame = new FakeGameAdapter();
  const destination = new WorldTileRuntime({
    game: destinationGame,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter(handoffPackages),
    tileCatalog: catalog,
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
  });
  await destination.boot('projected-handoff', 'T3');

  assert.deepEqual(destinationGame.native.tracks.map((track) => track.id), ['east-track']);
  assert.ok(destination.projectionOverlay().features.some(
    (feature) => feature.properties.sourceTrackId === 'crossing-track',
  ));
  assert.equal(destination.world.globalNetwork.nativeState.tracks.length, 3);
  assert.deepEqual(destination.world.globalNetwork.routeDescriptors.statewide.trainSchedule, { highDemand: 4 });
});

test('schedule hook commits a clipped-route frequency without adopting native topology normalization', async () => {
  const tileIds = ['T0', 'T1', 'T2', 'T3'];
  const catalog = {
    tiles: tileIds.map((id, column) => ({ id, column, row: 0, bounds: [column, 0, column + 1, 1] })),
  };
  const emptyCatalog = { buildHash: 'schedule-direct-commit', buckets: [], gateways: [] };
  const handoffPackages = Object.fromEntries(tileIds.map((tileId) => [tileId, {
    manifest: { tileId, cityCode: tileId, schemaVersion: 1, dataFiles: {} },
    demand: [], commuteCatalog: emptyCatalog,
  }]));
  const game = new FakeGameAdapter();
  Object.assign(game.native, {
    tracks: [{ id: 'empire-track', coords: [[0.2, 0.5], [3.5, 0.5]] }],
    stations: [
      { id: 'west', coords: [0.2, 0.5], stNodeIds: ['west-node'] },
      { id: 'east', coords: [3.5, 0.5], stNodeIds: ['east-node'] },
    ],
    routes: [{
      id: 'empire-line', stationIds: ['west', 'east'], trackIds: ['empire-track'],
      trainSchedule: { highDemand: 4, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1 },
    }],
    trains: [], trackGroups: [], signals: [], stNodes: [], stationGroups: [], fareGroups: [], routeFinancials: {},
  });
  const runtime = new WorldTileRuntime({
    game,
    worldState: new ModStorageWorldStateAdapter(),
    tilePackages: new MemoryTilePackageAdapter(handoffPackages),
    tileCatalog: catalog,
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
  });
  await runtime.boot('schedule-direct-world', 'T0');

  // The real route editor can normalize other route fields while changing the
  // schedule. Generic reconciliation rejects that snapshot and restores the
  // old value, which is the user-visible undo.
  game.log.length = 0;
  game.native.routes[0].trainSchedule.highDemand = 5;
  game.native.routes[0].stCombos = [{ editorNormalized: true }];
  const generic = await runtime.reconcileActiveProjection('schedule-change');
  assert.equal(generic.status, 'rejected');
  assert.equal(game.native.routes[0].trainSchedule.highDemand, 4);
  assert.ok(game.log.includes('restoreSnapshot'), 'a rejected topology edit must restore the projection baseline');

  game.log.length = 0;
  // onScheduleChange fires after the native scheduler has already committed
  // the route update with setRoutes(..., false).
  game.native.routes[0].trainSchedule.highDemand = 5;
  const direct = await runtime.reconcileActiveScheduleChanges([{
    routeId: 'empire-line',
    schedule: {
      idealTrainCount: undefined,
      trainSchedule: { highDemand: 5, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1 },
      timetableSchedule: undefined,
    },
  }]);

  assert.equal(direct.status, 'accepted');
  assert.equal(runtime.world.globalNetwork.nativeState.routes[0].trainSchedule.highDemand, 5);
  assert.equal(game.native.routes[0].trainSchedule.highDemand, 5);
  assert.equal(
    game.log.includes('restoreSnapshot'),
    false,
    'an accepted schedule-only edit must update the authoritative network without loadSave/restoreSnapshot',
  );
});

test('city-load completion repairs an active destination when transition markers were consumed', async () => {
  const tileIds = ['T0', 'T1', 'T2', 'T3'];
  const catalog = {
    tiles: tileIds.map((id, column) => ({ id, column, row: 0, bounds: [column, 0, column + 1, 1] })),
  };
  const emptyCatalog = { buildHash: 'transition-repair', buckets: [], gateways: [] };
  const handoffPackages = Object.fromEntries(tileIds.map((tileId) => [tileId, {
    manifest: { tileId, cityCode: tileId, schemaVersion: 1, dataFiles: {} },
    demand: [], commuteCatalog: emptyCatalog,
  }]));
  const storage = new ModStorageWorldStateAdapter();
  const sourceGame = new FakeGameAdapter();
  Object.assign(sourceGame.native, {
    tracks: [{ id: 'empire-track', coords: [[0.5, 0.5], [3.5, 0.5]] }],
    stations: [
      { id: 'west', coords: [0.5, 0.5], stNodeIds: ['west-node'] },
      { id: 'east', coords: [3.5, 0.5], stNodeIds: ['east-node'] },
    ],
    routes: [{ id: 'empire-line', stationIds: ['west', 'east'], trackIds: ['empire-track'] }],
    trains: [], trackGroups: [], signals: [], stNodes: [], stationGroups: [], fareGroups: [], routeFinancials: {},
  });
  const source = new WorldTileRuntime({
    game: sourceGame, worldState: storage, tilePackages: new MemoryTilePackageAdapter(handoffPackages),
    tileCatalog: catalog, initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
  });
  await source.boot('transition-repair-world', 'T0');
  await source.stageNavigationTransition('T3');

  const destinationGame = new FakeGameAdapter();
  const destination = new WorldTileRuntime({
    game: destinationGame, worldState: storage, tilePackages: new MemoryTilePackageAdapter(handoffPackages),
    tileCatalog: catalog, initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
  });
  await destination.boot('transition-repair-world', 'T3');

  // The browser navigation token can outlive the persisted transition marker.
  // Reproduce the late callback after a checkpoint/migration lost that marker
  // and after the native city loader reset the transit slices.
  destination.world.committedTransitionId = null;
  Object.assign(destinationGame.native, { tracks: [], stations: [], routes: [], trains: [] });

  const result = await destination.completeStagedTransition('T3');

  assert.equal(result.status, 'repaired-active');
  assert.ok(destination.projectionOverlay().features.some(
    (feature) => feature.properties.sourceTrackId === 'empire-track',
  ));
  assert.equal(destination.world.globalNetwork.nativeState.tracks.length, 1);
});

test('city-load completion rehydrates a staged handoff when the callback runtime is stale', async () => {
  const storage = new ModStorageWorldStateAdapter();
  const staleGame = new FakeGameAdapter();
  const staleRuntime = new WorldTileRuntime({
    game: staleGame,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { wallet: 100, cohorts },
  });
  await staleRuntime.boot('stale-callback-world', 'KCW');

  // A second lifecycle path stages and persists the navigation while the
  // callback-owning runtime still holds its older KCW world in memory.
  const stagingRuntime = new WorldTileRuntime({
    game: new FakeGameAdapter(),
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { wallet: 100, cohorts },
  });
  await stagingRuntime.boot('stale-callback-world', 'KCW');
  const staged = await stagingRuntime.stageNavigationTransition('KCE');
  assert.equal(staleRuntime.view().activeTileId, 'KCW');

  const result = await staleRuntime.completeStagedTransition('KCE');

  assert.equal(result.status, 'committed');
  assert.equal(result.transitionId, staged.transitionId);
  assert.equal(staleRuntime.view().activeTileId, 'KCE');
  assert.equal(staleGame.currentPackage.manifest.tileId, 'KCE');
});

test('city-load completion still rejects an unrelated tile with no persisted handoff', async () => {
  const { runtime } = setup();
  await runtime.boot('unrelated-city-load', 'KCW');

  await assert.rejects(
    runtime.completeStagedTransition('KCE'),
    /No staged transition targets loaded tile: KCE \(active=KCW, pending=none\)/,
  );
});

test('a late source save-load cannot overwrite a staged destination handoff', async () => {
  const { runtime, game } = setup();
  await runtime.boot('save-load-transition-race', 'KCE');
  await runtime.checkpoint('game-save', { saveName: 'CP01 autosave' });
  const staged = await runtime.stageNavigationTransition('KCW');

  // onGameLoaded can still report the source city while the router is loading
  // the destination. It must not replace the live world with the source save.
  await runtime.reloadFromSave('save-load-transition-race', 'KCE', 'CP01 autosave');
  assert.equal(runtime.view().activeTileId, 'KCW');
  assert.equal(runtime.world.pendingTransition?.transitionId, staged.transitionId);
  await runtime.reloadFromSave('save-load-transition-race', 'KCW', 'CP01 autosave');
  assert.equal(runtime.view().activeTileId, 'KCW');
  assert.equal(runtime.world.pendingTransition?.transitionId, staged.transitionId);

  Object.assign(game.native, { tracks: [], stations: [], routes: [], trains: [] });
  const completed = await runtime.completeStagedTransition('KCW');
  assert.equal(completed.status, 'committed');
  assert.equal(runtime.view().activeTileId, 'KCW');
});

test('carries the active game balance into the destination tile', async () => {
  const { runtime, game } = setup();
  await runtime.boot('money-world');
  game.native.wallet = 37;

  await runtime.stageNavigationTransition('KCE');
  // StoreInitializer resets the destination city before the handoff completes.
  game.native = { ...game.native, wallet: 1_000_000, objects: [], activity: { departures: [], walletDelta: 0 } };
  await runtime.completeStagedTransition('KCE');

  assert.equal(runtime.view().wallet, 37);
  assert.equal(game.native.wallet, 37);
});

test('accumulates native revenue and expenses from successive tiles in the global wallet and history', async () => {
  const { runtime, game } = setup();
  await runtime.boot('native-multi-tile-finance');
  game.native.wallet = 130;
  game.native.financialHistory = {
    entries: [],
    lastHourTimestamp: 0,
    currentHourRevenue: 40,
    currentHourExpenses: 10,
    currentHourExpenseCategories: { trainOperational: 10 },
  };

  await runtime.stageNavigationTransition('KCE');
  game.native = {
    ...game.native,
    wallet: 1_000_000,
    financialHistory: {
      entries: [], lastHourTimestamp: 0, currentHourRevenue: 0,
      currentHourExpenses: 0, currentHourExpenseCategories: {},
    },
    objects: [], activity: { departures: [], walletDelta: 0 },
  };
  await runtime.completeStagedTransition('KCE');

  assert.equal(game.native.wallet, 130);
  assert.equal(game.native.financialHistory.currentHourRevenue, 40);
  assert.equal(game.native.financialHistory.currentHourExpenses, 10);

  // Native tile-B simulation posts into the same authoritative ledger.
  game.native.wallet += 15;
  game.native.financialHistory.currentHourRevenue += 20;
  game.native.financialHistory.currentHourExpenses += 5;
  game.native.financialHistory.currentHourExpenseCategories.stationMaintenance = 5;

  await runtime.stageNavigationTransition('KCW');
  game.native = {
    ...game.native,
    wallet: 1_000_000,
    financialHistory: {
      entries: [], lastHourTimestamp: 0, currentHourRevenue: 0,
      currentHourExpenses: 0, currentHourExpenseCategories: {},
    },
    objects: [], activity: { departures: [], walletDelta: 0 },
  };
  await runtime.completeStagedTransition('KCW');

  assert.equal(runtime.view().wallet, 145);
  assert.equal(game.native.wallet, 145);
  assert.equal(game.native.financialHistory.currentHourRevenue, 60);
  assert.equal(game.native.financialHistory.currentHourExpenses, 15);
  assert.deepEqual(game.native.financialHistory.currentHourExpenseCategories, {
    trainOperational: 10,
    stationMaintenance: 5,
  });
});

test('cross-tile transit departures credit fare revenue to the authoritative player balance', async () => {
  const { runtime, game } = setup();
  await runtime.boot('cross-tile-fare-world');
  game.native.transitCost = 3;
  runtime.world.farePolicy.fare = 3;
  runtime.world.gatewayLedger['cohort-west-east-1'].modeChoice = {
    driving: 6, walking: 0, transit: 4, unknown: 0,
  };

  await runtime.advanceTo(7);

  assert.equal(runtime.view().wallet, 4_380);
  assert.equal(game.native.wallet, 4_380);
  assert.deepEqual(runtime.view().crossTileFinancials, { transitTrips: 4, fareRevenue: 4_380, pendingNativeRevenue: 0 });

  await runtime.advanceTo(7);
  assert.equal(runtime.view().wallet, 4_380);

  await runtime.advanceTo(17);
  assert.equal(runtime.view().wallet, 8_760);
  assert.equal(game.native.wallet, 8_760);
  assert.deepEqual(runtime.view().crossTileFinancials, { transitTrips: 8, fareRevenue: 8_760, pendingNativeRevenue: 0 });

  await runtime.stageNavigationTransition('KCE');
  game.native = {
    ...game.native,
    wallet: 1_000_000,
    financialHistory: { entries: [], lastHourTimestamp: 0, currentHourRevenue: 0, currentHourExpenses: 0, currentHourExpenseCategories: {} },
    objects: [],
    activity: { departures: [], walletDelta: 0 },
  };
  await runtime.completeStagedTransition('KCE');

  assert.equal(game.native.wallet, 8_760);
  assert.equal(game.native.financialHistory.currentHourRevenue, 8_760);
});

test('legacy settlement state recovers to the native clock and wallet before boot catch-up', async () => {
  const { runtime, game, storage } = setup();
  await runtime.boot('legacy-settlement-recovery');
  const legacy = structuredClone(runtime.world);
  delete legacy.settlementAccountingSchemaVersion;
  legacy.worldTime = 6;
  legacy.elapsedSeconds = 6 * 3_600;
  legacy.commuteLastProcessedHour = 6;
  legacy.crossTileFinancials.pendingNativeRevenue = 4_380;
  legacy.pendingCrossTileAttribution.completedCommutes = [{ popId: 'ambiguous', fareRevenue: 4_380 }];
  await storage.save(legacy);

  const reloadedGame = new FakeGameAdapter();
  reloadedGame.native.clock = 7 * 3_600;
  reloadedGame.native.wallet = 777;
  const reloaded = new WorldTileRuntime({
    game: reloadedGame, worldState: storage, tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { wallet: 100, cohorts },
  });

  await reloaded.boot('legacy-settlement-recovery');

  assert.equal(reloaded.view().settlementAccountingSchemaVersion, 2);
  assert.equal(reloaded.view().worldTime, 7);
  assert.equal(reloaded.world.commuteLastProcessedHour, 7);
  assert.equal(reloaded.view().wallet, 777);
  assert.equal(reloaded.view().crossTileFinancials.pendingNativeRevenue, 0);
  assert.equal(reloaded.world.pendingCrossTileAttribution.completedCommutes.length, 0);
  assert.equal(reloadedGame.log.includes('creditCrossTileFareRevenue'), false);
});

test('settlement rebases onto native income earned since the last sidecar capture', async () => {
  const { runtime, game } = setup();
  await runtime.boot('cross-tile-native-income-drift');
  game.native.transitCost = 3;
  runtime.world.farePolicy.fare = 3;
  runtime.world.gatewayLedger['cohort-west-east-1'].modeChoice = {
    driving: 6, walking: 0, transit: 4, unknown: 0,
  };
  runtime.world.gatewayLedger['cohort-west-east-1'].transitJourneys = [{
    popId: 'retry-pop', transitMass: 4, fare: 3, revenueByRoute: { route: 3 },
    totalClockSeconds: 900,
    stationRoutes: [{ routeId: 'route', stationIds: ['home', 'work'] }],
  }];
  game.native.wallet += 7;

  await assert.doesNotReject(runtime.advanceTo(7));
  assert.equal(game.native.wallet, 4_387);
  assert.equal(runtime.view().wallet, 4_387);
  assert.equal(runtime.view().crossTileFinancials.pendingNativeRevenue, 0);
});

test('retry after a post-mutation failure does not credit the same commutes twice', async () => {
  const { runtime, game } = setup();
  await runtime.boot('cross-tile-idempotent-retry');
  game.native.transitCost = 3;
  runtime.world.farePolicy.fare = 3;
  runtime.world.gatewayLedger['cohort-west-east-1'].modeChoice = {
    driving: 6, walking: 0, transit: 4, unknown: 0,
  };
  runtime.world.gatewayLedger['cohort-west-east-1'].transitJourneys = [{
    popId: 'retry-pop', transitMass: 4, fare: 3, revenueByRoute: { route: 3 },
    totalClockSeconds: 900,
    stationRoutes: [{ routeId: 'route', stationIds: ['home', 'work'] }],
  }];
  const credit = game.creditCrossTileFareRevenue.bind(game);
  let failAfterMutation = true;
  game.creditCrossTileFareRevenue = async (...args) => {
    const result = await credit(...args);
    if (failAfterMutation) {
      failAfterMutation = false;
      throw new Error('Injected failure after native mutation');
    }
    return result;
  };

  await assert.rejects(runtime.advanceTo(7), /Injected failure/);
  const walletAfterFirstPost = game.native.wallet;
  game.native.clock = 7 * 3_600;
  await runtime.settleCrossTileCommutes('retry');

  assert.equal(game.native.wallet, walletAfterFirstPost);
  assert.equal(runtime.view().wallet, walletAfterFirstPost);
  assert.equal(runtime.view().crossTileFinancials.pendingNativeRevenue, 0);
});

test('boot quarantines an unavailable settlement action instead of trapping the save', async () => {
  const { runtime, storage } = setup();
  await runtime.boot('settlement-quarantine');
  const persisted = structuredClone(runtime.world);
  persisted.crossTileFinancials.pendingNativeRevenue = 12;
  await storage.save(persisted);
  const game = new FakeGameAdapter({ failAt: 'creditCrossTileFareRevenue' });
  game.native.wallet = 90;
  const reloaded = new WorldTileRuntime({
    game, worldState: storage, tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { wallet: 100, cohorts },
  });

  await assert.doesNotReject(reloaded.boot('settlement-quarantine'));

  assert.equal(reloaded.view().wallet, 90);
  assert.equal(reloaded.view().crossTileFinancials.pendingNativeRevenue, 12);
  assert.match(reloaded.view().settlementFinanceQuarantine.message, /Injected game failure/);
});

test('captured fare edits update the global group while retaining clipped remote routes', async () => {
  const { runtime, game } = setup();
  await runtime.boot('global-fare-group-merge');
  runtime.world.globalNetwork = {
    nativeState: {
      fareGroups: [{
        id: 'statewide', fareSystem: 'distance', routeIds: ['local', 'remote'],
        boardingCharge: 3, perKmRate: 0.15, fareCap: 20,
      }],
      routes: [], stations: [],
    },
  };
  game.native.fareGroups = [{
    id: 'statewide', fareSystem: 'distance', routeIds: ['local'],
    boardingCharge: 4, perKmRate: 0.2, fareCap: 25,
  }];

  await runtime.settleCrossTileCommutes('fare-capture');

  assert.deepEqual(runtime.world.globalNetwork.nativeState.fareGroups, [{
    id: 'statewide', fareSystem: 'distance', routeIds: ['remote', 'local'],
    boardingCharge: 4, perKmRate: 0.2, fareCap: 25,
  }]);
});

test('daily mode-share callback pushes newly accrued cross-tile fares into the live game', async () => {
  const { runtime, game } = setup();
  await runtime.boot('daily-cross-tile-fare-world');
  game.native.transitCost = 3;
  runtime.world.gatewayLedger['cohort-west-east-1'].modeChoice = {
    driving: 6, walking: 0, transit: 4, unknown: 0,
  };
  game.native.clock = 7 * 3_600;

  await runtime.recalculateCrossTileModeShare({ reason: 'daily', day: 1 });

  assert.equal(runtime.view().wallet, 4_380);
  assert.equal(game.native.wallet, 4_380);
  assert.equal(game.native.financialHistory.currentHourRevenue, 4_380);
  assert.equal(runtime.world.financialHistory.currentHourRevenue, 4_380);
});

test('network-change recalculation skips detailed demand when the structure is unchanged', async () => {
  const { runtime, game } = setup();
  await runtime.boot('unchanged-network-world');
  let crossDemandLoads = 0;
  const originalLoad = runtime.tilePackages.loadCrossDemand.bind(runtime.tilePackages);
  runtime.tilePackages.loadCrossDemand = async (...args) => {
    crossDemandLoads++;
    return originalLoad(...args);
  };
  game.native.networkProfile = structuredClone(runtime.world.tiles.KCW.networkProfile);

  const result = await runtime.recalculateCrossTileModeShare({ reason: 'network-change', day: 1 });

  assert.equal(result.status, 'network-unchanged');
  assert.equal(crossDemandLoads, 0);
});

test('hourly settlement credits scheduled cross-tile fares without recalculating mode share', async () => {
  const { runtime, game } = setup();
  await runtime.boot('hourly-cross-tile-fare-world');
  game.native.transitCost = 3;
  runtime.world.gatewayLedger['cohort-west-east-1'].modeChoice = {
    driving: 6, walking: 0, transit: 4, unknown: 0,
  };
  game.native.clock = 7 * 3_600;

  await runtime.settleCrossTileCommutes('hourly');

  assert.equal(runtime.view().wallet, 4_380);
  assert.equal(game.native.wallet, 4_380);
  assert.equal(game.native.financialHistory.currentHourRevenue, 4_380);
  assert.equal(runtime.view().crossModeShare, null);
});

test('paid hourly settlement writes the compact journal instead of the full world', async () => {
  const { runtime, game, storage } = setup();
  await runtime.boot('compact-hourly-world');
  runtime.world.gatewayLedger['cohort-west-east-1'].modeChoice = {
    driving: 6, walking: 0, transit: 4, unknown: 0,
  };
  let fullSaves = 0;
  let journals = 0;
  const originalSave = storage.save.bind(storage);
  const originalSettlement = storage.saveSettlement.bind(storage);
  storage.save = async (...args) => { fullSaves++; return originalSave(...args); };
  storage.saveSettlement = async (...args) => { journals++; return originalSettlement(...args); };
  game.native.clock = 7 * 3_600;

  const result = await runtime.settleCrossTileCommutes('hourly');

  assert.equal(result.persistence, 'settlement-journal');
  assert.equal(journals, 1);
  assert.equal(fullSaves, 0);
});

test('hourly settlement does not rewrite the full world on an inert hour', async () => {
  const { runtime, game, storage } = setup();
  await runtime.boot('inert-hour-world');
  let saves = 0;
  const originalSave = storage.save.bind(storage);
  storage.save = async (...args) => { saves++; return originalSave(...args); };
  game.native.clock = 1 * 3_600;

  const result = await runtime.settleCrossTileCommutes('hourly');

  assert.equal(result.activeHours, 0);
  assert.equal(result.persisted, false);
  assert.equal(saves, 0);
});

test('hourly settlement posts saved inactive-tile native finances exactly once', async () => {
  const { runtime, game } = setupProjectedRuntime();
  await runtime.boot('background-native-finance', 'T0');
  const hours = (amount, routeId = null) => Array.from({ length: 24 }, () => ({
    revenue: amount,
    revenueByRoute: routeId ? { [routeId]: amount } : {},
  }));
  runtime.world.backgroundNativeFinance = {
    schemaVersion: 1,
    networkHash: runtime.world.globalNetwork?.hash ?? null,
    lastSettledHour: 0,
    tileRevenueProfiles: {
      T0: { hourly: hours(10, 'local') },
      T1: { hourly: hours(20, 'remote') },
    },
    expenseProfile: {
      routeHourly: {
        local: Array(24).fill(30),
        remote: Array(24).fill(40),
        clipped: Array(24).fill(50),
      },
      infrastructureItems: [
        { id: 'visible', category: 'trackMaintenance', hourlyCost: 60, trackIds: ['visible-track'] },
        { id: 'remote', category: 'trackMaintenance', hourlyCost: 70, trackIds: ['remote-track'] },
      ],
    },
    totalRevenue: 0,
    totalExpenses: 0,
  };
  runtime.world.activeProjection.baselineState = {
    routes: [{ id: 'local' }, { id: 'clipped' }],
    tracks: [{ id: 'visible-track' }],
  };
  runtime.world.activeProjection.partialRouteIds = ['clipped'];
  game.native.clock = 3_600;

  const first = await runtime.settleCrossTileCommutes('hourly');
  const second = await runtime.settleCrossTileCommutes('duplicate-hour');

  assert.equal(first.backgroundRevenue, 20);
  assert.equal(first.backgroundExpenses, 160);
  assert.equal(first.wallet, -140);
  assert.equal(game.native.financialHistory.currentHourRevenue, 20);
  assert.equal(game.native.financialHistory.currentHourExpenses, 160);
  assert.deepEqual(game.native.routeRevenueByRoute, { remote: 20 });
  assert.deepEqual(game.native.routeExpensesByRoute, { remote: 40, clipped: 50 });
  assert.equal(second.backgroundRevenue, 0);
  assert.equal(second.backgroundExpenses, 0);
  assert.equal(second.wallet, -140);
  assert.equal(runtime.view().backgroundNativeFinance.lastSettledHour, 1);
});

test('hourly settlement leaves its cursor pending while native finance profiles target an older network', async () => {
  const { runtime, game } = setupProjectedRuntime();
  await runtime.boot('stale-background-native-finance', 'T0');
  runtime.world.backgroundNativeFinance = {
    schemaVersion: 2,
    networkHash: 'older-network',
    lastSettledHour: 0,
    tileRevenueProfiles: {
      T1: {
        hourly: Array.from({ length: 24 }, () => ({
          revenue: 999,
          revenueByRoute: { stale: 999 },
        })),
      },
    },
    expenseProfile: null,
    totalRevenue: 0,
    totalExpenses: 0,
  };
  game.native.clock = 3_600;

  const result = await runtime.settleCrossTileCommutes('stale-profile');

  assert.equal(result.backgroundRevenue, 0);
  assert.equal(game.native.financialHistory.currentHourRevenue, 0);
  assert.equal(runtime.view().backgroundNativeFinance.lastSettledHour, 0);
});

test('a failed finance handoff keeps the prior ownership and hourly ledger active after a route edit', async () => {
  const { runtime, game } = setupProjectedRuntime();
  const ownershipHashes = [];
  game.configureGlobalFinanceOwnership = (manifest) => {
    ownershipHashes.push(manifest?.networkHash ?? null);
  };
  await runtime.boot('transactional-finance-handoff', 'T0');
  const oldNetworkHash = runtime.world.globalNetwork.hash;
  const oldOwnership = structuredClone(runtime.world.activeProjection);
  const hourly = Array.from({ length: 24 }, () => ({
    revenue: 20,
    revenueByRoute: { global: 20 },
    financeOwnedRevenue: 20,
    financeOwnedRevenueByRoute: { global: 20 },
  }));
  runtime.world.backgroundNativeFinance = {
    schemaVersion: 2,
    networkHash: oldNetworkHash,
    ownershipProjection: oldOwnership,
    lastSettledHour: 0,
    lastRevenueSettledHour: 0,
    lastExpenseSettledHour: 0,
    tileRevenueProfiles: { T0: { hourly } },
    expenseProfile: {
      networkHash: oldNetworkHash,
      financeOwnedRouteIds: ['global'],
      routeHourly: {},
      infrastructureItems: [],
    },
    totalRevenue: 0,
    totalExpenses: 0,
  };
  game.calculateNativeFinanceProfile = () => {
    throw new Error('candidate finance compilation failed');
  };

  game.native.tracks = [{ id: 'new-local-track', coords: [[0.2, 0.2], [0.8, 0.2]] }];
  const reconciled = await runtime.reconcileActiveProjection('track-built');
  const newNetworkHash = runtime.world.globalNetwork.hash;
  assert.equal(reconciled.status, 'accepted');
  assert.notEqual(newNetworkHash, oldNetworkHash);

  game.native.clock = 3_600;
  const settled = await runtime.settleCrossTileCommutes('hourly');

  assert.equal(settled.backgroundRevenue, 20, 'the committed ledger must remain eligible while replacement compilation is pending');
  assert.equal(runtime.world.backgroundNativeFinance.networkHash, oldNetworkHash);
  assert.equal(runtime.world.backgroundNativeFinance.ownershipProjection.networkHash, oldNetworkHash);
  assert.equal(runtime.world.backgroundNativeFinance.pendingHandoff.networkHash, newNetworkHash);
  assert.equal(ownershipHashes.at(-1), oldNetworkHash, 'native suppression must remain paired with the committed ledger');
});

test('a complete finance compile commits the replacement profile and ownership atomically', async () => {
  const nativeDemand = { points: [], pops: [] };
  const game = new FakeGameAdapter();
  const storage = new ModStorageWorldStateAdapter();
  const handoffEvents = [];
  const saveSettlement = storage.saveSettlement.bind(storage);
  storage.saveSettlement = async (...args) => {
    handoffEvents.push('persist');
    return saveSettlement(...args);
  };
  const ownershipHashes = [];
  game.configureGlobalFinanceOwnership = (manifest) => {
    ownershipHashes.push(manifest?.networkHash ?? null);
    handoffEvents.push(`ownership:${manifest?.networkHash ?? 'none'}`);
  };
  const runtime = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter({
      T0: {
        manifest: { tileId: 'T0', cityCode: 'T0', schemaVersion: 1, dataFiles: {} },
        demand: [], nativeDemand,
        commuteCatalog: { buildHash: 'transactional-finance-commit', buckets: [], gateways: [] },
      },
    }),
    tileCatalog: { tiles: [{ id: 'T0', column: 0, row: 0, bounds: [0, 0, 1, 1] }] },
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
  });
  await runtime.boot('transactional-finance-commit', 'T0');
  const oldNetworkHash = runtime.world.globalNetwork.hash;
  runtime.world.backgroundNativeFinance = {
    schemaVersion: 2,
    networkHash: oldNetworkHash,
    ownershipProjection: structuredClone(runtime.world.activeProjection),
    lastSettledHour: 0,
    lastRevenueSettledHour: 0,
    lastExpenseSettledHour: 0,
    tileRevenueProfiles: {
      T0: {
        schemaVersion: 3, source: 'off-tile-estimator', evaluatorSchemaVersion: 3,
        contextKey: 'old', evaluationKey: 'old', tileId: 'T0',
        hourly: Array.from({ length: 24 }, () => ({ revenue: 10, revenueByRoute: {} })),
        transitPopulation: 0, dailyRevenue: 240,
      },
    },
    expenseProfile: {
      networkHash: oldNetworkHash,
      financeOwnedRouteIds: [], routeHourly: {}, infrastructureItems: [],
    },
    totalRevenue: 0,
    totalExpenses: 0,
  };
  game.native.tracks = [{ id: 'new-local-track', coords: [[0.2, 0.2], [0.8, 0.2]] }];
  await runtime.reconcileActiveProjection('track-built');
  const newNetworkHash = runtime.world.globalNetwork.hash;
  assert.notEqual(newNetworkHash, oldNetworkHash);
  assert.equal(runtime.world.backgroundNativeFinance.networkHash, oldNetworkHash);

  const result = await runtime.recalculateCrossTileModeShare({ reason: 'midnight-change', day: 1, force: true });

  assert.equal(result.nativeFinanceProfile.status, 'committed');
  assert.equal(runtime.world.backgroundNativeFinance.networkHash, newNetworkHash);
  assert.equal(runtime.world.backgroundNativeFinance.expenseProfile.networkHash, newNetworkHash);
  assert.equal(runtime.world.backgroundNativeFinance.ownershipProjection.networkHash, newNetworkHash);
  assert.equal(runtime.world.backgroundNativeFinance.pendingHandoff, null);
  assert.equal(ownershipHashes.at(-1), newNetworkHash);
  assert.deepEqual(handoffEvents.slice(-2), ['persist', `ownership:${newNetworkHash}`]);
});

test('a route-change finance handoff never back-bills the replacement operating profile', async () => {
  const nativeDemand = { points: [], pops: [] };
  const game = new FakeGameAdapter();
  const storage = new ModStorageWorldStateAdapter();
  const runtime = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter({
      T0: {
        manifest: { tileId: 'T0', cityCode: 'T0', schemaVersion: 1, dataFiles: {} },
        demand: [], nativeDemand,
        commuteCatalog: { buildHash: 'no-replacement-back-bill', buckets: [], gateways: [] },
      },
    }),
    tileCatalog: { tiles: [{ id: 'T0', column: 0, row: 0, bounds: [0, 0, 1, 1] }] },
    initialWorld: { activeTileId: 'T0', wallet: 1_000, cohorts: [] },
  });
  await runtime.boot('no-replacement-back-bill', 'T0');
  const oldNetworkHash = runtime.world.globalNetwork.hash;
  runtime.world.backgroundNativeFinance = {
    schemaVersion: 2,
    networkHash: oldNetworkHash,
    ownershipProjection: structuredClone(runtime.world.activeProjection),
    lastSettledHour: 0,
    lastRevenueSettledHour: 0,
    lastExpenseSettledHour: 0,
    tileRevenueProfiles: {
      T0: {
        schemaVersion: 3, source: 'off-tile-estimator', evaluatorSchemaVersion: 3,
        contextKey: 'old', evaluationKey: 'old', tileId: 'T0',
        hourly: Array.from({ length: 24 }, () => ({ revenue: 0, revenueByRoute: {} })),
        transitPopulation: 0, dailyRevenue: 0,
      },
    },
    // Simulate a profile that could not be settled before the route edit.
    expenseProfile: {
      networkHash: 'unavailable-old-profile',
      financeOwnedRouteIds: [], routeHourly: {}, infrastructureItems: [],
    },
    totalRevenue: 0,
    totalExpenses: 0,
  };
  game.native.nativeFinanceProfile = {
    tileRevenueProfile: {
      schemaVersion: 3, tileId: 'T0', calculatedAtSeconds: 3 * 3_600,
      hourly: Array.from({ length: 24 }, () => ({ revenue: 0, revenueByRoute: {} })),
      transitPopulation: 0, dailyRevenue: 0,
    },
    expenseProfile: {
      schemaVersion: 2, calculatedAtSeconds: 3 * 3_600,
      financeOwnedRouteIds: ['new-route'],
      routeHourly: { 'new-route': Array.from({ length: 24 }, () => 100) },
      infrastructureItems: [],
    },
  };
  game.native.clock = 3 * 3_600;
  game.native.tracks = [{ id: 'new-route-track', coords: [[0.2, 0.2], [0.8, 0.2]] }];
  await runtime.reconcileActiveProjection('route-created');

  const result = await runtime.recalculateCrossTileModeShare({
    reason: 'midnight-change', day: 1, force: true,
  });

  assert.equal(result.nativeFinanceProfile.status, 'committed');
  assert.equal(result.backgroundFinance.expenses, 0,
    'the new route must start accruing after the handoff instead of being charged for earlier hours');
  assert.equal(runtime.world.backgroundNativeFinance.lastExpenseSettledHour, 3);
  assert.equal(game.native.financialHistory.currentHourExpenseCategories.trainOperational ?? 0, 0);
});

test('hourly settlement rebuilds a stale finance profile once before advancing its cursors', async () => {
  const { runtime, game } = setupProjectedRuntime();
  await runtime.boot('stale-background-native-finance-recovery', 'T0');
  runtime.tilePackages.packages.get('T0').nativeDemand = { points: [], pops: [] };
  const currentNetworkHash = runtime.world.globalNetwork?.hash ?? null;
  runtime.world.backgroundNativeFinance = {
    schemaVersion: 2,
    networkHash: 'older-network',
    lastSettledHour: 0,
    lastRevenueSettledHour: 0,
    lastExpenseSettledHour: 0,
    tileRevenueProfiles: {},
    expenseProfile: {
      networkHash: 'older-network',
      financeOwnedRouteIds: [],
      routeHourly: {},
      infrastructureItems: [],
    },
    totalRevenue: 0,
    totalExpenses: 0,
  };
  game.native.nativeFinanceProfile = {
    tileRevenueProfile: {
      schemaVersion: 3,
      tileId: 'T0',
      hourly: Array.from({ length: 24 }, () => ({ revenue: 0, revenueByRoute: {} })),
      transitPopulation: 0,
      dailyRevenue: 0,
    },
    expenseProfile: {
      schemaVersion: 2,
      financeOwnedRouteIds: ['global'],
      routeHourly: { global: Array(24).fill(50) },
      infrastructureItems: [],
    },
  };
  game.native.clock = 3_600;

  const result = await runtime.settleCrossTileCommutes('stale-profile-recovery');

  assert.equal(runtime.world.backgroundNativeFinance.networkHash, currentNetworkHash);
  assert.equal(runtime.world.backgroundNativeFinance.expenseProfile.networkHash, currentNetworkHash);
  assert.equal(result.backgroundExpenses, 50);
  assert.equal(runtime.view().backgroundNativeFinance.lastExpenseSettledHour, 1);
});

test('save-load boot rebuilds stale inactive-tile finance before reporting ready', async () => {
  const { runtime, game, storage } = setupProjectedRuntime();
  runtime.tilePackages.packages.get('T0').nativeDemand = { points: [], pops: [] };
  await runtime.boot('save-load-finance-recovery', 'T0');
  const currentNetworkHash = runtime.world.globalNetwork?.hash ?? null;
  runtime.world.backgroundNativeFinance = {
    schemaVersion: 2,
    networkHash: 'older-network',
    ownershipProjection: null,
    pendingHandoff: null,
    lastSettledHour: 0,
    lastRevenueSettledHour: 0,
    lastExpenseSettledHour: 0,
    tileRevenueProfiles: {},
    expenseProfile: {
      networkHash: 'older-network',
      financeOwnedRouteIds: [],
      routeHourly: {},
      infrastructureItems: [],
    },
    totalRevenue: 0,
    totalExpenses: 0,
  };
  await storage.save(runtime.world);
  await storage.saveCheckpoint(runtime.world, 'Autosave');

  const reloadedGame = new FakeGameAdapter();
  reloadedGame.native = structuredClone(game.native);
  const startupEvents = [];
  const reloaded = new WorldTileRuntime({
    game: reloadedGame,
    worldState: storage,
    tilePackages: runtime.tilePackages,
    tileCatalog: runtime.tileCatalog,
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
    telemetry: (event) => startupEvents.push(event),
  });

  await reloaded.boot('save-load-finance-recovery', 'T0', { saveName: 'Autosave' });

  const finance = reloaded.view().backgroundNativeFinance;
  assert.equal(finance.networkHash, currentNetworkHash);
  assert.equal(finance.expenseProfile.networkHash, currentNetworkHash);
  assert.equal(finance.pendingHandoff, null);
  assert.equal(startupEvents.find(({ phase }) => phase === 'startup-performance')?.status, 'ready');
});

test('stale native revenue profiles do not block a current global expense profile', async () => {
  const { runtime, game } = setupProjectedRuntime();
  await runtime.boot('current-expenses-stale-revenue', 'T0');
  const currentNetworkHash = runtime.world.globalNetwork?.hash ?? null;
  runtime.world.backgroundNativeFinance = {
    schemaVersion: 2,
    // Revenue projections failed to refresh for the current network.
    networkHash: 'older-network',
    lastSettledHour: 0,
    tileRevenueProfiles: {
      T1: {
        hourly: Array.from({ length: 24 }, () => ({
          revenue: 999,
          revenueByRoute: { stale: 999 },
        })),
      },
    },
    // Expense compilation is independent of native demand harvesting and did
    // succeed for the authoritative graph.
    expenseProfile: {
      networkHash: currentNetworkHash,
      financeOwnedRouteIds: ['global'],
      routeHourly: { global: Array(24).fill(50) },
      infrastructureItems: [
        {
          id: 'global-track', category: 'trackMaintenance', hourlyCost: 10,
          trackIds: ['global-track'], financeOwned: true,
        },
      ],
    },
    totalRevenue: 0,
    totalExpenses: 0,
  };
  game.native.clock = 3_600;

  const result = await runtime.settleCrossTileCommutes('stale-revenue-current-expenses');

  assert.equal(result.backgroundRevenue, 0, 'stale revenue must remain withheld');
  assert.equal(result.backgroundExpenses, 60, 'current expenses must still be posted');
  assert.equal(game.native.financialHistory.currentHourExpenses, 60);
  assert.equal(runtime.view().backgroundNativeFinance.lastRevenueSettledHour, 0);
  assert.equal(runtime.view().backgroundNativeFinance.lastExpenseSettledHour, 1);
  assert.equal(runtime.view().backgroundNativeFinance.lastSettledHour, 0);

  runtime.world.backgroundNativeFinance.networkHash = currentNetworkHash;
  game.native.clock = 2 * 3_600;
  const caughtUp = await runtime.settleCrossTileCommutes('revenue-profile-recovered');

  assert.equal(caughtUp.backgroundRevenue, 1_998, 'revenue catches up both pending hours');
  assert.equal(caughtUp.backgroundExpenses, 60, 'expense posts only the newly pending hour');
  assert.equal(runtime.view().backgroundNativeFinance.totalExpenses, 120);
  assert.equal(runtime.view().backgroundNativeFinance.lastRevenueSettledHour, 2);
  assert.equal(runtime.view().backgroundNativeFinance.lastExpenseSettledHour, 2);
  assert.equal(runtime.view().backgroundNativeFinance.lastSettledHour, 2);
});

test('inactive native finance catch-up preserves each simulated hour in history', async () => {
  const { runtime, game } = setupProjectedRuntime();
  await runtime.boot('background-native-finance-history', 'T0');
  const hours = (amount, routeId = null) => Array.from({ length: 24 }, () => ({
    revenue: amount,
    revenueByRoute: routeId ? { [routeId]: amount } : {},
  }));
  runtime.world.backgroundNativeFinance = {
    schemaVersion: 1,
    networkHash: runtime.world.globalNetwork?.hash ?? null,
    lastSettledHour: 0,
    tileRevenueProfiles: {
      T0: { hourly: hours(10, 'local') },
      T1: { hourly: hours(20, 'remote') },
    },
    expenseProfile: {
      routeHourly: { local: Array(24).fill(30), remote: Array(24).fill(40) },
      infrastructureItems: [],
    },
    totalRevenue: 0,
    totalExpenses: 0,
  };
  runtime.world.activeProjection.baselineState = {
    routes: [{ id: 'local' }],
    tracks: [],
  };
  runtime.world.activeProjection.partialRouteIds = [];
  game.native.clock = 3 * 3_600;

  await runtime.settleCrossTileCommutes('three-hour-catch-up');

  assert.deepEqual(game.native.financialHistory.entries.slice(-3).map((entry) => ({
    timestamp: entry.timestamp,
    revenue: entry.hourlyRevenue,
    expenses: entry.hourlyExpenses,
  })), [
    { timestamp: 0, revenue: 0, expenses: 0 },
    { timestamp: 3_600, revenue: 20, expenses: 40 },
    { timestamp: 7_200, revenue: 20, expenses: 40 },
  ]);
  assert.equal(game.native.financialHistory.lastHourTimestamp, 10_800);
  assert.equal(game.native.financialHistory.currentHourRevenue, 20);
  assert.equal(game.native.financialHistory.currentHourExpenses, 40);
  assert.deepEqual(game.native.routeFinancials.byRoute.remote.map((entry) => ({
    timestamp: entry.timestamp,
    revenue: entry.revenue,
    expenses: entry.expenses,
  })), [
    { timestamp: 3_600, revenue: 20, expenses: 40 },
    { timestamp: 7_200, revenue: 20, expenses: 40 },
  ]);
  assert.deepEqual(game.native.routeFinancials.currentHour.remote, { revenue: 20, expenses: 40 });
});

test('hourly settlement persists a native-versus-projected finance audit', async () => {
  const { runtime, game, storage } = setupProjectedRuntime();
  await runtime.boot('native-finance-audit', 'T0');
  const hourly = Array.from({ length: 24 }, () => ({
    revenue: 40,
    revenueByRoute: { global: 40 },
    financeOwnedRevenue: 40,
    financeOwnedRevenueByRoute: { global: 40 },
  }));
  runtime.world.backgroundNativeFinance = {
    schemaVersion: 2,
    networkHash: runtime.world.globalNetwork?.hash ?? null,
    lastSettledHour: 1,
    tileRevenueProfiles: { T0: { hourly } },
    expenseProfile: {
      financeOwnedRouteIds: ['global'],
      routeHourly: { global: Array(24).fill(50) },
      infrastructureItems: [],
    },
    totalRevenue: 0,
    totalExpenses: 0,
    audit: { schemaVersion: 2, samples: [], rolling24Hours: null, updatedAtHour: null },
  };
  runtime.world.activeProjection.baselineState = { routes: [{ id: 'global' }], tracks: [] };
  runtime.world.activeProjection.partialRouteIds = [];
  game.native.clock = 3_600;
  game.queueNativeFinanceAudit({
    hour: 0,
    revenueByRoute: { global: 35 },
    expensesByRoute: { global: 55 },
  });
  let journals = 0;
  const saveSettlement = storage.saveSettlement.bind(storage);
  storage.saveSettlement = async (...args) => { journals++; return saveSettlement(...args); };

  const result = await runtime.settleCrossTileCommutes('hourly');
  const audit = runtime.view().backgroundNativeFinance.audit;

  assert.equal(result.persisted, true);
  assert.equal(journals, 1);
  assert.equal(audit.latest.complete, true);
  assert.deepEqual(audit.latest.revenue, {
    native: 35,
    projected: 40,
    projectedMinusNative: 5,
    percentOfNative: 40 / 35 * 100,
    percentError: 5 / 35 * 100,
  });
  assert.deepEqual(audit.latest.expenses, {
    native: 55,
    projected: 50,
    projectedMinusNative: -5,
    percentOfNative: 50 / 55 * 100,
    percentError: -5 / 55 * 100,
  });
  assert.equal(audit.rolling24Hours.sampleCount, 1);
  assert.equal(audit.rolling24Hours.ready, false);
  assert.equal(audit.rolling24Hours.net.native, null);
  assert.equal(audit.rolling24Hours.partial.net.native, -20);
  assert.equal(audit.rolling24Hours.partial.net.projected, -10);
});

test('hourly finance audit reaches 24 hours across autosave projection churn', async () => {
  const { runtime, game } = setupProjectedRuntime();
  await runtime.boot('native-finance-autosave-churn', 'T0');
  runtime.world.tiles.T0.networkProfile = {
    schemaVersion: 1,
    tileId: 'T0',
    signature: 'stable-service',
    structuralSignature: 'stable-service',
    stations: [],
    routes: [],
    activeRouteIds: [],
    pathfindingRules: {},
  };
  runtime.world.backgroundNativeFinance = {
    schemaVersion: 2,
    networkHash: runtime.world.globalNetwork?.hash ?? null,
    lastSettledHour: 0,
    tileRevenueProfiles: { T0: { hourly: Array.from({ length: 24 }, () => ({ revenue: 40, revenueByRoute: { global: 40 } })) } },
    expenseProfile: { financeOwnedRouteIds: ['global'], routeHourly: { global: Array(24).fill(50) }, infrastructureItems: [] },
    totalRevenue: 0,
    totalExpenses: 0,
    audit: { schemaVersion: 3, samples: [], rolling24Hours: null, updatedAtHour: null },
  };
  runtime.world.activeProjection.baselineState = { routes: [{ id: 'global' }], tracks: [] };
  runtime.world.activeProjection.financeOwnedRouteIds = ['global'];
  runtime.world.activeProjection.partialRouteIds = [];

  for (let hour = 0; hour < 24; hour++) {
    runtime.world.activeProjection.projectionHash = `autosave-${Math.floor(hour / 3)}`;
    runtime.world.activeProjection.networkRevision = 10 + Math.floor(hour / 3);
    game.native.clock = (hour + 1) * 3_600;
    game.queueNativeFinanceAudit({
      hour,
      revenueByRoute: { global: 35 },
      expensesByRoute: { global: 55 },
    });
    await runtime.settleCrossTileCommutes('hourly');
  }

  const audit = runtime.view().backgroundNativeFinance.audit.rolling24Hours;
  assert.equal(audit.ready, true);
  assert.equal(audit.sampleCount, 24);
  assert.equal(audit.firstHour, 0);
  assert.equal(audit.lastHour, 23);
});

test('carries exact elapsed game time into the destination tile', async () => {
  const { runtime, game } = setup();
  await runtime.boot('time-world');
  game.native.clock = 12_345;

  await runtime.stageNavigationTransition('KCE');
  game.native = { ...game.native, clock: 0, objects: [], activity: { departures: [], walletDelta: 0 } };
  await runtime.completeStagedTransition('KCE');

  assert.equal(runtime.view().elapsedSeconds, 12_345);
  assert.equal(game.native.clock, 12_345);
});

test('in-game mod reload adopts the live balance before restoring persisted tile state', async () => {
  const { runtime, game, storage } = setup();
  await runtime.boot('hot-reload-money');
  game.native.wallet = 37;

  const reloadedRuntime = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { wallet: 100, cohorts },
  });
  await reloadedRuntime.boot('hot-reload-money', 'KCW');

  assert.equal(reloadedRuntime.view().wallet, 37);
  assert.equal(game.native.wallet, 37);
});

test('mod reload migrates a remote cached revenue profile without revisiting that tile', async () => {
  const { runtime, game, storage } = setup();
  await runtime.boot('remote-finance-profile-migration', 'KCW');
  const oldHourly = Array.from({ length: 24 }, () => ({ revenue: 0, revenueByRoute: {} }));
  oldHourly[7] = { revenue: 100, revenueByRoute: { remote: 100 } };
  oldHourly[17] = { revenue: 100, revenueByRoute: { remote: 100 } };
  runtime.world.backgroundNativeFinance.tileRevenueProfiles.KCE = {
    schemaVersion: 2,
    tileId: 'KCE',
    dailyRevenue: 200,
    hourly: oldHourly,
  };
  await storage.save(runtime.world);
  const reloaded = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { wallet: 100, cohorts },
  });

  await reloaded.boot('remote-finance-profile-migration', 'KCW');

  const migrated = reloaded.view().backgroundNativeFinance.tileRevenueProfiles.KCE;
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.hourly.filter(({ revenue }) => revenue > 0).length, 24);
  assert.ok(Math.abs(migrated.hourly.reduce((sum, hour) => sum + hour.revenue, 0) - 200) < 1e-9);
  assert.equal(game.currentPackage.manifest.tileId, 'KCW');
});

test('aliased seed reload recovers finance from live state when the indexed checkpoint payload is missing', async () => {
  const { runtime, game, storage } = setup();
  await runtime.boot('dangling-seed-finance', 'KCW');
  const finance = runtime.world.backgroundNativeFinance;
  finance.tileRevenueProfiles.KCE = {
    schemaVersion: 3,
    tileId: 'KCE',
    dailyRevenue: 12_000,
    hourly: Array.from({ length: 24 }, () => ({ revenue: 500, revenueByRoute: { R: 500 } })),
  };
  finance.networkHash = null;
  finance.ownershipProjection = {
    activeTileId: 'KCW',
    networkHash: null,
    financeOwnedRouteIds: [],
    partialRouteIds: [],
    financeOwnedTrackIds: [],
  };
  finance.lastSettledHour = 20;
  finance.lastRevenueSettledHour = 20;
  finance.lastExpenseSettledHour = 20;
  runtime.world.worldTime = 20;
  runtime.world.elapsedSeconds = 20 * 3_600;
  await storage.save(runtime.world);
  storage.storage.set('world:dangling-seed-finance:save-checkpoints', {
    schemaVersion: 1,
    nextSequence: 12,
    entries: [{ checkpointId: '0000000012', saveName: 'Seed', savedAt: 12 }],
  });

  game.native.clock = 10 * 3_600;
  const reloaded = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { wallet: 100, cohorts },
  });
  await reloaded.boot('dangling-seed-finance', 'KCW', {
    saveName: 'Seed',
    allowLiveFallback: true,
  });

  const restored = reloaded.view().backgroundNativeFinance;
  assert.equal(restored.tileRevenueProfiles.KCE.dailyRevenue, 12_000);
  assert.equal(restored.lastRevenueSettledHour, 10);
  assert.equal(restored.lastExpenseSettledHour, 10);

  game.native.clock = 11 * 3_600;
  const firstPostLoadHour = await reloaded.settleCrossTileCommutes('hourly');
  assert.equal(firstPostLoadHour.backgroundRevenue, 500);
  assert.equal(firstPostLoadHour.backgroundExpenses, 0);
  assert.equal(reloaded.view().backgroundNativeFinance.lastRevenueSettledHour, 11);
});

test('loading an older autosave restores its matching commute checkpoint', async () => {
  const { runtime, game, storage } = setup();
  await runtime.boot('hot-reload-clock');
  await runtime.advanceTo(7);
  await runtime.checkpoint('game-save', { saveName: 'Autosave Day 1' });
  await runtime.advanceTo(9);
  game.native.clock = 7 * 3_600;

  const reloadedRuntime = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { wallet: 100, cohorts },
  });

  await assert.doesNotReject(reloadedRuntime.boot('hot-reload-clock', 'KCW', { saveName: 'Autosave Day 1' }));
  assert.equal(reloadedRuntime.view().elapsedSeconds, 7 * 3_600);
  assert.equal(game.native.clock, 7 * 3_600);
});

test('aliased recovery rebases future sidecar time to the native save without dropping its network', async () => {
  const { runtime, game, storage } = setup();
  await runtime.boot('aliased-recovery-clock');
  await runtime.advanceTo(9);
  runtime.world.globalNetwork = createGlobalNetwork({
    tracks: [{ id: 'recovered-track', coords: [[0, 0], [1, 0]] }],
    stations: [{ id: 'recovered-station', coords: [0, 0] }],
    routes: [{ id: 'recovered-route', fullName: 'Recovered route' }],
    trains: [{ id: 'recovered-train', routeId: 'recovered-route' }],
  });
  await storage.save(runtime.world);
  game.native.clock = 7 * 3_600 + 123;

  const recovered = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { wallet: 100, cohorts },
  });

  await assert.doesNotReject(recovered.boot('aliased-recovery-clock', 'KCW', {
    saveName: 'Uncheckpointed destination save',
    allowLiveFallback: true,
  }));
  assert.equal(recovered.view().worldTime, 7);
  assert.equal(recovered.view().elapsedSeconds, 7 * 3_600 + 123);
  assert.equal(recovered.world.commuteLastProcessedHour, 7);
  assert.deepEqual(
    recovered.world.globalNetwork.nativeState.routes.map((route) => route.fullName),
    ['Recovered route'],
  );
});

test('boot persists an injected remote-network recovery through world storage', async () => {
  const { runtime, game, storage } = setup();
  await runtime.boot('api-network-recovery');
  runtime.world.globalNetwork = createGlobalNetwork({
    tracks: [{ id: 'visible-track', coords: [[0, 0], [1, 0]] }],
    routes: [], stations: [], trains: [],
  });
  await storage.save(runtime.world);

  const recovered = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { wallet: 100, cohorts },
    networkRecovery: async (world) => applyNetworkRecovery(world, {
      recoveryId: 'remote-network-v1',
      nativeState: {
        tracks: [{ id: 'remote-track', coords: [[4, 0], [5, 0]] }],
        routes: [{ id: 'remote-route', fullName: 'Remote route' }],
        stations: [], trains: [],
      },
    }),
  });

  await recovered.boot('api-network-recovery', 'KCW');

  const persisted = await storage.load('api-network-recovery');
  assert.deepEqual(
    persisted.globalNetwork.nativeState.routes.map((route) => route.fullName),
    ['Remote route'],
  );
  assert.deepEqual(
    persisted.globalNetwork.nativeState.tracks.map((track) => track.id).sort(),
    ['remote-track', 'visible-track'],
  );
  assert.ok(persisted.networkRecoveries['remote-network-v1']);
});

test('network recovery invalidates stale inactive-tile finance profiles before startup settlement', async () => {
  const nativeDemand = {
    points: [
      { id: 'home', location: [1.2, 0.5], residents: 100, jobs: 0 },
      { id: 'work', location: [1.8, 0.5], residents: 0, jobs: 100 },
    ],
    pops: [{
      id: 'remote-pop', size: 100, residenceId: 'home', jobId: 'work',
      drivingSeconds: 3_600, drivingDistance: 25_000,
    }],
  };
  const packageFixture = Object.fromEntries(['T0', 'T1'].map((tileId) => [tileId, {
    manifest: { tileId, cityCode: tileId, schemaVersion: 1, dataFiles: {} },
    nativeDemand,
    commuteCatalog: { buildHash: 'recovery-finance', buckets: [], gateways: [] },
  }]));
  const tilePackages = new MemoryTilePackageAdapter(packageFixture);
  const tileCatalog = { tiles: [
    { id: 'T0', column: 0, row: 0, bounds: [0, 0, 1, 1] },
    { id: 'T1', column: 1, row: 0, bounds: [1, 0, 2, 1] },
  ] };
  const game = new FakeGameAdapter();
  const storage = new ModStorageWorldStateAdapter();
  const original = new WorldTileRuntime({
    game, worldState: storage, tilePackages, tileCatalog,
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
  });
  await original.boot('recovery-finance-world', 'T0');
  const staleProfile = (tileId, hourlyRevenue = 0) => ({
    schemaVersion: 3,
    source: 'off-tile-estimator',
    evaluatorSchemaVersion: 3,
    contextKey: `${tileId}:stale-empty-network`,
    evaluationKey: `${tileId}:stale`,
    tileId,
    hourly: Array.from({ length: 24 }, () => ({
      revenue: hourlyRevenue,
      revenueByRoute: hourlyRevenue ? { stale: hourlyRevenue } : {},
    })),
    transitPopulation: 0,
    dailyRevenue: hourlyRevenue * 24,
  });
  original.world.backgroundNativeFinance.tileRevenueProfiles = {
    T0: staleProfile('T0'),
    T1: staleProfile('T1', 999),
  };
  original.world.crossModeShare = {
    schemaVersion: 1, day: 1, reason: 'startup', calculatedAtHour: 0,
    evaluatedPops: 0, transitViablePops: 0, changedFlows: 0, revision: 1,
  };
  await storage.save(original.world);

  let nativeDemandLoads = 0;
  const loadNativeDemand = tilePackages.loadNativeDemand.bind(tilePackages);
  tilePackages.loadNativeDemand = async (...args) => {
    nativeDemandLoads++;
    return loadNativeDemand(...args);
  };
  let backgroundPosts = 0;
  const postBackgroundNativeFinance = game.postBackgroundNativeFinance.bind(game);
  game.postBackgroundNativeFinance = async (...args) => {
    backgroundPosts++;
    return postBackgroundNativeFinance(...args);
  };
  game.native.clock = 3_600;
  const recovered = new WorldTileRuntime({
    game, worldState: storage, tilePackages, tileCatalog,
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
    networkRecovery: async (world) => applyNetworkRecovery(world, {
      recoveryId: 'finance-network-v1',
      nativeState: {
        tracks: [], trackGroups: [], signals: [],
        stations: [
          { id: 'home-station', coords: [1.2, 0.5], stNodeIds: ['home-node'], buildType: 'constructed' },
          { id: 'work-station', coords: [1.8, 0.5], stNodeIds: ['work-node'], buildType: 'constructed' },
        ],
        stNodes: [{ id: 'home-node' }, { id: 'work-node' }],
        routes: [{
          id: 'R', stNodes: [{ id: 'home-node' }, { id: 'work-node' }], idealTrainCount: 2,
          stComboTimings: [
            { stNodeIndex: 0, arrivalTime: 0, departureTime: 20 },
            { stNodeIndex: 1, arrivalTime: 600, departureTime: 620 },
          ],
        }],
        trains: [], fareGroups: [],
      },
    }),
  });

  await recovered.boot('recovery-finance-world', 'T0');
  assert.equal(backgroundPosts, 0, 'startup must not settle a stale profile before reevaluating it');
  const result = await recovered.recalculateCrossTileModeShare({ reason: 'startup' });

  assert.notEqual(result.status, 'cached');
  assert.ok(nativeDemandLoads > 0);
  assert.ok(recovered.view().backgroundNativeFinance.tileRevenueProfiles.T1.dailyRevenue > 0);
  assert.equal(
    recovered.view().backgroundNativeFinance.networkHash,
    recovered.world.globalNetwork.hash,
  );
});

test('boot restores recovered visible topology before a later reconciliation can delete it', async () => {
  const { runtime, game, storage } = setupProjectedRuntime();
  await runtime.boot('visible-network-recovery', 'T0');
  runtime.world.globalNetwork = createGlobalNetwork({
    tracks: [], routes: [], stations: [], trains: [], trackGroups: [],
  });
  runtime.world.activeProjection = null;
  await storage.save(runtime.world);
  game.native.tracks = [];

  const recovered = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: runtime.tilePackages,
    tileCatalog: runtime.tileCatalog,
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
    networkRecovery: async (world) => applyNetworkRecovery(world, {
      recoveryId: 'visible-network-v1',
      nativeState: {
        tracks: [{ id: 'recovered-track', coords: [[0.2, 0.2], [0.8, 0.2]] }],
        routes: [], stations: [], trains: [], trackGroups: [],
      },
    }),
  });

  await recovered.boot('visible-network-recovery', 'T0');
  assert.deepEqual(game.native.tracks.map(({ id }) => id), ['recovered-track']);

  await recovered.reconcileActiveProjection('post-startup-native-callback');
  assert.deepEqual(
    recovered.world.globalNetwork.nativeState.tracks.map(({ id }) => id),
    ['recovered-track'],
  );
});

test('aliased stale native save restores the authoritative visible topology on boot', async () => {
  const { runtime, game, storage } = setupProjectedRuntime();
  await runtime.boot('aliased-stale-native-network', 'T0');
  game.native.tracks = [{ id: 'authoritative-track', coords: [[0.2, 0.2], [0.8, 0.2]] }];
  await runtime.reconcileActiveProjection('track-built');
  await runtime.checkpoint('game-save', {
    saveName: 'Autosave',
    nativeSessionId: 'stale-native-save',
    nativeTileId: 'T0',
  });

  // The player resumes an older native autosave whose transit projection is
  // missing rail that remains present in its authoritative open-world checkpoint.
  game.native.tracks = [];
  const loadTrace = [];
  const recovered = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: runtime.tilePackages,
    tileCatalog: runtime.tileCatalog,
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
    telemetry: (event) => {
      if (event.phase === 'authoritative-load') loadTrace.push(event);
    },
  });

  await recovered.boot('aliased-stale-native-network', 'T0', {
    saveName: 'Autosave',
    allowLiveFallback: true,
    nativeSessionId: 'stale-native-save',
    nativeTileId: 'T0',
    loadTraceId: 'stale-save-regression',
  });

  assert.deepEqual({
    native: game.native.tracks.map(({ id }) => id),
    authoritative: recovered.world.globalNetwork.nativeState.tracks.map(({ id }) => id),
  }, {
    native: ['authoritative-track'],
    authoritative: ['authoritative-track'],
  });
  const segments = loadTrace.map(({ segment }) => segment);
  for (const segment of [
    'boot-start',
    'storage-load-start',
    'storage-load-complete',
    'authoritative-globals-captured',
    'live-snapshot-captured',
    'projection-built',
    'native-restore-start',
    'native-restore-complete',
    'native-verified',
    'storage-saved',
    'boot-complete',
  ]) assert.ok(segments.includes(segment), `missing authoritative load segment: ${segment}`);
});

test('boot repairs and persists station groups missing from the world sidecar', async () => {
  const { runtime, game, storage } = setupProjectedRuntime();
  await runtime.boot('sidecar-track-group-repair', 'T0');
  const network = createGlobalNetwork({
    tracks: [
      {
        id: 'platform-a', type: 'station', trackType: 'commuter-rail', buildType: 'constructed',
        coords: [[0.4, 0.5], [0.5, 0.5]],
      },
      {
        id: 'platform-b', type: 'station', trackType: 'commuter-rail', buildType: 'constructed',
        coords: [[0.5, 0.51], [0.4, 0.51]],
      },
    ],
    trackGroups: [{ id: 'station-a', type: 'station', trackIds: ['platform-a', 'platform-b'] }],
    stations: [{
      id: 'station-a', coords: [0.45, 0.505], trackGroupId: 'station-a',
      trackIds: ['platform-a', 'platform-b'], stNodeIds: [], routeIds: [],
    }],
    routes: [],
    trains: [],
  });
  network.nativeState.trackGroups = [];
  runtime.world.globalNetwork = network;
  await storage.save(runtime.world);

  const recovered = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: runtime.tilePackages,
    tileCatalog: runtime.tileCatalog,
    initialWorld: { activeTileId: 'T0', wallet: 100, cohorts: [] },
  });
  await recovered.boot('sidecar-track-group-repair', 'T0');

  const persisted = await storage.load('sidecar-track-group-repair');
  assert.deepEqual(
    persisted.globalNetwork.nativeState.trackGroups.map(({ id }) => id),
    ['station-a'],
  );
});

test('an already-running runtime can replace its world from a loaded save checkpoint', async () => {
  const { runtime, game } = setup();
  await runtime.boot('running-save-load');
  await runtime.advanceTo(4);
  await runtime.checkpoint('game-save', { saveName: 'Autosave 4' });
  await runtime.advanceTo(8);
  game.native.clock = 4 * 3_600;

  await runtime.reloadFromSave('running-save-load', 'KCW', 'Autosave 4');

  assert.equal(runtime.view().worldTime, 4);
  assert.equal(runtime.view().elapsedSeconds, 4 * 3_600);
  assert.equal(runtime.world.commuteLastProcessedHour, 4);
});

test('view remains available while an already-running runtime reloads a save', async () => {
  const { runtime, game, storage } = setup();
  await runtime.boot('visible-during-save-load');
  await runtime.checkpoint('game-save', { saveName: 'Autosave visible' });
  const before = runtime.view();
  const originalLoad = storage.load.bind(storage);
  let releaseLoad;
  let markLoadStarted;
  const loadBlocked = new Promise((resolve) => { releaseLoad = resolve; });
  const loadStarted = new Promise((resolve) => { markLoadStarted = resolve; });
  storage.load = async (...args) => {
    markLoadStarted();
    await loadBlocked;
    return originalLoad(...args);
  };
  game.native.clock = before.elapsedSeconds;

  const reload = runtime.reloadFromSave('visible-during-save-load', 'KCW', 'Autosave visible');
  await loadStarted;
  assert.deepEqual(runtime.view(), before, 'the mounted tile panel must retain a stable view during reload');
  releaseLoad();
  await reload;
});

test('a failed save reload restores the previous committed runtime view', async () => {
  const { runtime, storage } = setup();
  await runtime.boot('failed-visible-save-load');
  const before = runtime.view();
  storage.load = async () => { throw new Error('Injected checkpoint read failure'); };

  await assert.rejects(
    runtime.reloadFromSave('failed-visible-save-load', 'KCW', 'Broken autosave'),
    /Injected checkpoint read failure/,
  );
  assert.deepEqual(runtime.view(), before);
});

test('the natively loaded tile wins when a save checkpoint names another tile', async () => {
  const { runtime, game, storage } = setup();
  await runtime.boot('save-tile-reconciliation', 'KCW');
  await runtime.checkpoint('game-save', { saveName: 'Autosave 1' });

  const resumed = new WorldTileRuntime({
    game,
    worldState: storage,
    tilePackages: new MemoryTilePackageAdapter(packages),
    initialWorld: { wallet: 100, cohorts },
  });

  await resumed.boot('save-tile-reconciliation', 'KCE', { saveName: 'Autosave 1' });
  assert.equal(resumed.view().activeTileId, 'KCE');
  assert.equal(game.currentPackage.manifest.tileId, 'KCE');
});

test('new world startup adopts the balance initialized by the game', async () => {
  const { runtime, game } = setup();
  game.native.wallet = 37;

  await runtime.boot('brand-new-money', 'KCW');

  assert.equal(runtime.view().wallet, 37);
  assert.equal(game.native.wallet, 37);
});

test('conserves cross-tile cohort mass across departure and lazy catch-up', async () => {
  const { runtime, game } = setup(); await runtime.boot('fixture');
  game.queueActivity({ departures: [{ cohortId: 'cohort-west-east-1', mass: 4 }] });
  await runtime.transitionTo('KCE');
  let entry = runtime.view().gatewayLedger['cohort-west-east-1'];
  assert.equal(entry.atHome, 6); assert.equal(entry.toWork[0].mass, 4);
  await runtime.advanceTo(2); entry = runtime.view().gatewayLedger['cohort-west-east-1'];
  assert.equal(entry.atWork, 4); assert.equal(entry.toWork.length, 0);
  assert.equal(entry.atHome + entry.atWork, 10);
});

test('inactive state produces equal hourly and lazy catch-up results', async () => {
  const eager = setup(); const lazy = setup(); await eager.runtime.boot('eager'); await lazy.runtime.boot('lazy');
  for (let hour = 1; hour <= 5; hour++) await eager.runtime.advanceTo(hour);
  await lazy.runtime.advanceTo(5);
  assert.deepEqual(eager.runtime.view().tiles, lazy.runtime.view().tiles);
});

test('rejects corrupt packages before pausing or mutating the native game', async () => {
  const { runtime, game } = setup(); await runtime.boot('fixture');
  runtime.tilePackages.packages.get('KCE').valid = false;
  await assert.rejects(runtime.transitionTo('KCE'), /validation failed/);
  assert.equal(game.paused, false); assert.equal(game.currentPackage.manifest.tileId, 'KCW');
});

test('boot adopts an already loaded initial tile without starting a second native city load', async () => {
  const fixture = realSeamFixture();
  const game = new SubwayBuilderGameAdapter(fixture);
  const runtime = new WorldTileRuntime({
    game,
    worldState: new ModStorageWorldStateAdapter(),
    tilePackages: new MemoryTilePackageAdapter({
      KCW: { manifest: { tileId: 'KCW', cityCode: 'KCW', dataFiles: { demandData: 'demand_data.json.gz' } } },
    }),
    initialWorld: { activeTileId: 'KCW', wallet: 100, cohorts: [] },
  });

  await runtime.boot('already-loaded');

  assert.equal(fixture.calls.filter(([name]) => name === 'city').length, 0);
  assert.equal(fixture.calls.filter(([name]) => name === 'files').length, 0);
});

function realSeamFixture({ omit = [], publicCityCode = 'KCW' } = {}) {
  const calls = []; const save = { cityCode: 'KCW', viewport: { center: [-94.6, 39] }, data: { routes: [], tracks: [], stations: [], trains: [] } };
  const state = {
    cityCode: 'KCW', money: 50, transitCost: 4, timeConfig: { elapsedSeconds: 0, paused: false },
    financialHistory: { entries: [], lastHourTimestamp: 0, currentHourRevenue: 0, currentHourExpenses: 0, currentHourExpenseCategories: {} },
    routeFinancials: { byRoute: {}, lastHourTimestamp: 0, currentHour: {} },
    generateSave: (options) => { calls.push(['save', options]); return structuredClone(save); },
    loadSave: (value) => { calls.push(['load', value]); state.cityCode = value.cityCode; },
    loadInitialData: (cityCode) => { calls.push(['city', cityCode]); state.cityCode = cityCode; },
    setTimeConfig: (patch) => { calls.push(['time', patch]); state.timeConfig = { ...state.timeConfig, ...patch }; },
    addRevenue: (amount, isFareRevenue) => {
      calls.push(['revenue', amount, isFareRevenue]); state.money += amount;
      if (isFareRevenue) state.financialHistory.currentHourRevenue += amount;
    },
    addExpense: (amount, category) => {
      calls.push(['expense', amount, category]); state.money -= amount;
      state.financialHistory.currentHourExpenses += amount;
      state.financialHistory.currentHourExpenseCategories[category]
        = (state.financialHistory.currentHourExpenseCategories[category] ?? 0) + amount;
    },
    completedCommutes: [],
    recordRouteFinancials: ({ revenueByRoute, expensesByRoute }) => {
      calls.push(['route-financials', revenueByRoute, expensesByRoute]);
    },
    setRouteFinancials: (routeFinancials) => {
      calls.push(['set-route-financials', routeFinancials]); state.routeFinancials = structuredClone(routeFinancials);
    },
    setCompletedCommutes: (commutes) => {
      calls.push(['completed-commutes', commutes]); state.completedCommutes = structuredClone(commutes);
    },
    setFinancialHistory: (history) => { calls.push(['financial-history', history]); state.financialHistory = structuredClone(history); },
  };
  for (const name of omit) delete state[name];
  const api = {
    version: '1.0.0',
    cities: { setCityDataFiles: (cityCode, files) => calls.push(['files', cityCode, files]) },
    gameState: { getStations: () => [], getRoutes: () => [], getTrains: () => [] },
    utils: {
      getCityCode: () => publicCityCode,
      getMap: () => ({ jumpTo: (camera) => calls.push(['camera', camera]) }),
      getPathfindingRules: () => ({}),
    },
  };
  return { calls, state, api, callbacks: { setMoney: (money) => { calls.push(['money', money]); state.money = money; }, setTicketCost: (fare) => calls.push(['fare', fare]), getState: () => state } };
}

test('production adapter uses the inspected 1.6.0 getState seam and API 1.0.0 surface', async () => {
  const fixture = realSeamFixture(); const adapter = new SubwayBuilderGameAdapter(fixture);
  const report = adapter.probe(); assert.equal(report.supported, true); assert.deepEqual(report.callbackMethods, ['getState', 'setMoney', 'setTicketCost']);
  assert.equal(report.selectedActions.staticData, 'loadInitialData'); assert.ok(report.stateMethods.includes('generateSave'));
  await adapter.pause(); const save = await adapter.captureSnapshot(); await adapter.loadStaticPackage({ manifest: { tileId: 'KCE', dataFiles: { demandData: 'demand_data.json' } } }); await adapter.restoreSnapshot({ ...save, cityCode: 'KCE' });
  await adapter.setAuthoritativeGlobals({ worldTime: 8, wallet: 20, farePolicy: { fare: 3 } }); await adapter.resume();
  assert.deepEqual(fixture.calls.map(([name]) => name), ['time', 'save', 'files', 'city', 'time', 'load', 'time', 'money', 'fare', 'time', 'time']);
  assert.equal(fixture.state.timeConfig.elapsedSeconds, 8 * 3600);
});

test('production adapter persists and recovers authoritative identity through native autosaves', async () => {
  const fixture = realSeamFixture();
  fixture.state.gameSessionId = 'parent-native-save';
  const adapter = new SubwayBuilderGameAdapter(fixture);

  assert.deepEqual(adapter.readWorldIdentityHints(), {
    authoritativeWorldId: null,
    ancestorSessionIds: ['parent-native-save'],
  });

  assert.equal(await adapter.stampAuthoritativeWorldIdentity('canonical-open-world'), true);
  assert.equal(await adapter.stampAuthoritativeWorldIdentity('canonical-open-world'), false);
  assert.deepEqual(adapter.readWorldIdentityHints(), {
    authoritativeWorldId: 'canonical-open-world',
    ancestorSessionIds: ['parent-native-save'],
  });
  assert.equal(
    fixture.state.financialHistory.openWorldAuthoritativeWorldId,
    'canonical-open-world',
  );
});

test('clipped-route tick guard keeps frequency editable but hides it from native train generation', async () => {
  const fixture = realSeamFixture();
  const clipped = {
    id: 'statewide',
    openWorldProjectionDormant: true,
    trainSchedule: { highDemand: 11, mediumDemand: 6, lowDemand: 4, veryLowDemand: 3 },
    timetableSchedule: { mode: 'timetable', periods: [] },
    idealTrainCount: 11,
  };
  const local = { id: 'local', trainSchedule: { highDemand: 2 }, idealTrainCount: 2 };
  fixture.state.routes = [clipped, local];
  const observed = [];
  fixture.state.handleIncrementGameState = () => {
    observed.push(structuredClone(fixture.state.routes));
    return Promise.resolve('tick');
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  assert.deepEqual(adapter.installClippedRouteTickGuard(), { installed: true, reused: false });
  await fixture.state.handleIncrementGameState();

  assert.equal(observed[0][0].trainSchedule, null);
  assert.equal(observed[0][0].timetableSchedule, null);
  assert.equal(observed[0][0].idealTrainCount, 0);
  assert.deepEqual(observed[0][1].trainSchedule, { highDemand: 2 });
  assert.deepEqual(clipped.trainSchedule, { highDemand: 11, mediumDemand: 6, lowDemand: 4, veryLowDemand: 3 });
  assert.deepEqual(clipped.timetableSchedule, { mode: 'timetable', periods: [] });
  assert.equal(clipped.idealTrainCount, 11);
  assert.deepEqual(adapter.installClippedRouteTickGuard(), { installed: true, reused: true });
});

test('native tick retains visible cross-tile trains but withholds their route finances', async () => {
  const fixture = realSeamFixture();
  fixture.state.routes = [
    { id: 'global', trainSchedule: { highDemand: 2 } },
    { id: 'local', trainSchedule: { highDemand: 1 } },
  ];
  fixture.state.trackGroups = [
    { id: 'global-assets', trackIds: ['global-track'] },
    { id: 'local-assets', trackIds: ['local-track'] },
  ];
  const observed = [];
  fixture.state.handleIncrementGameState = () => {
    observed.push({
      globalSchedule: fixture.state.routes[0].trainSchedule,
      trackGroupIds: fixture.state.trackGroups.map(({ id }) => id),
    });
    fixture.state.addRevenue(100, true);
    fixture.state.recordRouteFinancials({ revenueByRoute: { global: 40, local: 60 }, expensesByRoute: {} });
    fixture.state.addExpense(50, 'trainOperational');
    fixture.state.recordRouteFinancials({ revenueByRoute: {}, expensesByRoute: { global: 20, local: 30 } });
    return Promise.resolve('tick');
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.configureGlobalFinanceOwnership({ financeOwnedRouteIds: ['global'], financeOwnedTrackIds: ['global-track'] });
  adapter.installClippedRouteTickGuard();
  await fixture.state.handleIncrementGameState();

  assert.deepEqual(observed, [{
    globalSchedule: { highDemand: 2 },
    trackGroupIds: ['global-assets', 'local-assets'],
  }]);
  assert.equal(fixture.state.money, 80);
  assert.equal(fixture.state.financialHistory.currentHourRevenue, 60);
  assert.equal(fixture.state.financialHistory.currentHourExpenses, 30);
  assert.deepEqual(fixture.calls.filter(([name]) => name === 'route-financials'), [
    ['route-financials', { local: 60 }, {}],
    ['route-financials', {}, { local: 30 }],
  ]);
  assert.deepEqual(adapter.consumeNativeFinanceAudit(), [{
    hour: 0,
    revenueByRoute: { global: 40 },
    expensesByRoute: { global: 20 },
  }]);
  assert.deepEqual(adapter.consumeNativeFinanceAudit(), []);
  assert.deepEqual(fixture.state.trackGroups.map(({ id }) => id), ['global-assets', 'local-assets']);
});

test('native finance guard preserves rolling-stock purchases as capital expenses', async () => {
  const fixture = realSeamFixture();
  fixture.state.routes = [{ id: 'global', trainSchedule: { highDemand: 2 } }];
  fixture.state.handleIncrementGameState = () => {
    fixture.state.addExpense(40, 'trainPurchase');
    return Promise.resolve('tick');
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);
  adapter.configureGlobalFinanceOwnership({ financeOwnedRouteIds: ['global'] });
  adapter.installClippedRouteTickGuard();

  await fixture.state.handleIncrementGameState();

  assert.equal(fixture.state.financialHistory.currentHourExpenseCategories.trainPurchase, 40);
  assert.equal(fixture.state.financialHistory.currentHourExpenseCategories.trainOperational ?? 0, 0);
});

test('hot reload rebinds native finance audit collection to the current adapter', async () => {
  const fixture = realSeamFixture();
  fixture.state.routes = [{ id: 'global', trainSchedule: { highDemand: 2 } }];
  fixture.state.handleIncrementGameState = () => {
    fixture.state.recordRouteFinancials({
      revenueByRoute: { global: 40 },
      expensesByRoute: { global: 20 },
    });
    return Promise.resolve('tick');
  };
  const staleAdapter = new SubwayBuilderGameAdapter(fixture);
  staleAdapter.configureGlobalFinanceOwnership({ financeOwnedRouteIds: ['global'] });
  assert.deepEqual(staleAdapter.installClippedRouteTickGuard(), { installed: true, reused: false });

  const currentAdapter = new SubwayBuilderGameAdapter(fixture);
  currentAdapter.configureGlobalFinanceOwnership({ financeOwnedRouteIds: ['global'] });
  assert.deepEqual(currentAdapter.installClippedRouteTickGuard(), {
    installed: true,
    reused: true,
    rebound: true,
  });
  await fixture.state.handleIncrementGameState();

  assert.deepEqual(staleAdapter.consumeNativeFinanceAudit(), []);
  assert.deepEqual(currentAdapter.consumeNativeFinanceAudit(), [{
    hour: 0,
    revenueByRoute: { global: 40 },
    expensesByRoute: { global: 20 },
  }]);
});

test('native finance tick guard does not accumulate recursive wrappers when Zustand replaces state', async () => {
  const fixture = realSeamFixture();
  let liveState = fixture.state;
  fixture.callbacks.getState = () => liveState;
  const nativeAddRevenue = liveState.addRevenue;
  const nativeAddExpense = liveState.addExpense;
  const nativeRecordRouteFinancials = liveState.recordRouteFinancials;
  liveState.routes = [{ id: 'global', trainSchedule: { highDemand: 2 } }];
  liveState.trackGroups = [{ id: 'global-assets', trackIds: ['global-track'] }];
  liveState.handleIncrementGameState = () => {
    // Zustand actions can publish a replacement object while the guarded tick
    // is running. The replacement inherits whatever temporary methods exist.
    liveState = { ...liveState };
    liveState.addRevenue(100, true);
    liveState.recordRouteFinancials({ revenueByRoute: { global: 40 }, expensesByRoute: {} });
    liveState.addExpense(50, 'trainOperational');
    liveState.recordRouteFinancials({ revenueByRoute: {}, expensesByRoute: { global: 20 } });
    return Promise.resolve('tick');
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);
  adapter.configureGlobalFinanceOwnership({ financeOwnedRouteIds: ['global'], financeOwnedTrackIds: ['global-track'] });
  adapter.installClippedRouteTickGuard();

  for (let index = 0; index < 25; index++) await liveState.handleIncrementGameState();

  assert.equal(liveState.addRevenue, nativeAddRevenue);
  assert.equal(liveState.addExpense, nativeAddExpense);
  assert.equal(liveState.recordRouteFinancials, nativeRecordRouteFinancials);
  assert.deepEqual(liveState.trackGroups, [{ id: 'global-assets', trackIds: ['global-track'] }]);
});

test('native finance tick guard never exposes topology without owned track groups to autosave', async () => {
  const fixture = realSeamFixture();
  fixture.state.routes = [{ id: 'global', trainSchedule: { highDemand: 2 } }];
  fixture.state.tracks = [{ id: 'global-track' }];
  fixture.state.trackGroups = [{ id: 'global-assets', trackIds: ['global-track'] }];
  fixture.state.stations = [{ id: 'global-station', trackGroupId: 'global-assets' }];
  let autosaveSnapshot = null;
  fixture.state.handleIncrementGameState = () => {
    autosaveSnapshot = structuredClone({
      tracks: fixture.state.tracks,
      trackGroups: fixture.state.trackGroups,
      stations: fixture.state.stations,
    });
    return Promise.resolve('tick');
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);
  adapter.configureGlobalFinanceOwnership({
    financeOwnedRouteIds: ['global'],
    financeOwnedTrackIds: ['global-track'],
  });
  adapter.installClippedRouteTickGuard();

  await fixture.state.handleIncrementGameState();

  assert.deepEqual(autosaveSnapshot.trackGroups, [{ id: 'global-assets', trackIds: ['global-track'] }]);
  const groupIds = new Set(autosaveSnapshot.trackGroups.map(({ id }) => id));
  assert.ok(autosaveSnapshot.stations.every(({ trackGroupId }) => groupIds.has(trackGroupId)));
});

test('native finance tick guard suppresses owned infrastructure expense without hiding topology', async () => {
  const fixture = realSeamFixture();
  const hourlyStationMaintenance = 320_000 / 24;
  fixture.state.money = 100_000;
  fixture.state.routes = [{ id: 'global', trackIds: ['global-platform'] }];
  fixture.state.tracks = [
    { id: 'global-platform', buildType: 'constructed', trackType: 'commuter-rail' },
    { id: 'local-platform', buildType: 'constructed', trackType: 'commuter-rail' },
  ];
  fixture.state.trackGroups = [
    { id: 'global-station', type: 'station', trackType: 'commuter-rail', trackIds: ['global-platform'] },
    { id: 'local-station', type: 'station', trackType: 'commuter-rail', trackIds: ['local-platform'] },
  ];
  let groupsSeenByTick = null;
  fixture.state.handleIncrementGameState = () => {
    groupsSeenByTick = fixture.state.trackGroups.map(({ id }) => id);
    fixture.state.addExpense(hourlyStationMaintenance * 2, 'stationMaintenance');
    return Promise.resolve('tick');
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);
  adapter.configureGlobalFinanceOwnership({
    financeOwnedRouteIds: ['global'],
    financeOwnedTrackIds: ['global-platform'],
    baselineState: {
      routes: fixture.state.routes,
      trains: [],
      tracks: fixture.state.tracks,
      trackGroups: fixture.state.trackGroups,
    },
  });
  adapter.installClippedRouteTickGuard();

  await fixture.state.handleIncrementGameState();

  assert.deepEqual(groupsSeenByTick, ['global-station', 'local-station']);
  assert.ok(Math.abs(fixture.state.money - (100_000 - hourlyStationMaintenance)) < 1e-6);
  assert.ok(Math.abs(
    fixture.state.financialHistory.currentHourExpenseCategories.stationMaintenance
      - hourlyStationMaintenance,
  ) < 1e-6);
});

test('native save load repairs a station group omitted by an older finance-tick autosave', async () => {
  const fixture = realSeamFixture();
  let loaded = null;
  fixture.state.loadSave = (snapshot) => {
    loaded = structuredClone(snapshot);
    const groups = new Set(snapshot.data.trackGroups.map(({ id }) => String(id)));
    if (!snapshot.data.stations.every(({ trackGroupId }) => groups.has(String(trackGroupId)))) {
      throw new Error('Track group not found for station');
    }
    return Promise.resolve();
  };
  const snapshot = {
    cityCode: 'KCW',
    data: {
      routes: [],
      trains: [],
      trackGroups: [],
      tracks: [
        {
          id: 'platform-a', type: 'station', trackType: 'commuter-rail',
          coords: [[-74.01, 40.70], [-74.009, 40.71]],
        },
        {
          id: 'platform-b', type: 'station', trackType: 'commuter-rail',
          coords: [[-74.009, 40.71], [-74.01, 40.70]],
        },
        {
          id: 'line-a', type: null, trackType: 'commuter-rail', createdAt: 200,
          coords: [[-74.01, 40.70], [-73.99, 40.72]],
        },
        {
          id: 'line-b', type: null, trackType: 'commuter-rail', createdAt: 200,
          coords: [[-73.99, 40.7201], [-74.01, 40.7001]],
        },
      ],
      stations: [{
        id: 'liberty',
        coords: [-74.0095, 40.705],
        trackGroupId: 'liberty',
        trackIds: ['platform-a', 'platform-b'],
      }],
    },
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  assert.deepEqual(adapter.installTrackGroupLoadGuard(), { installed: true, reused: false });
  assert.deepEqual(adapter.installTrackGroupLoadGuard(), { installed: true, reused: true });
  await fixture.state.loadSave(snapshot);

  assert.equal(snapshot.data.trackGroups.length, 0, 'repair must not mutate the saved input object');
  const libertyGroup = loaded.data.trackGroups.find(({ id }) => id === 'liberty');
  assert.deepEqual(libertyGroup.trackIds, ['platform-a', 'platform-b']);
  assert.equal(libertyGroup.type, 'station');
  const groupedTrackIds = new Set(loaded.data.trackGroups.flatMap(({ trackIds }) => trackIds));
  assert.deepEqual([...groupedTrackIds].sort(), ['line-a', 'line-b', 'platform-a', 'platform-b']);
});

test('native finance audit excludes clipped routes that native cannot faithfully simulate', async () => {
  const fixture = realSeamFixture();
  fixture.state.routes = [
    { id: 'visible-global', trainSchedule: { highDemand: 2 } },
    { id: 'clipped-global', openWorldProjectionDormant: true, trainSchedule: { highDemand: 2 } },
  ];
  fixture.state.handleIncrementGameState = () => {
    fixture.state.addRevenue(70, true);
    fixture.state.recordRouteFinancials({
      revenueByRoute: { 'visible-global': 40, 'clipped-global': 30 },
      expensesByRoute: {},
    });
    fixture.state.addExpense(50, 'trainOperational');
    fixture.state.recordRouteFinancials({
      revenueByRoute: {},
      expensesByRoute: { 'visible-global': 20, 'clipped-global': 30 },
    });
    return Promise.resolve('tick');
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);
  adapter.configureGlobalFinanceOwnership({
    financeOwnedRouteIds: ['visible-global', 'clipped-global'],
    partialRouteIds: ['clipped-global'],
  });
  adapter.installClippedRouteTickGuard();

  await fixture.state.handleIncrementGameState();

  assert.deepEqual(adapter.consumeNativeFinanceAudit(), [{
    hour: 0,
    revenueByRoute: { 'visible-global': 40 },
    expensesByRoute: { 'visible-global': 20 },
  }]);
  assert.equal(fixture.state.money, 50, 'both globally owned routes remain suppressed from native wallet accounting');
});

test('clipped-route tick guard exposes deferred trains only to native commute pathfinding', async () => {
  const fixture = realSeamFixture();
  const deferredTrain = {
    id: 'statewide-commute-train',
    routeId: 'statewide',
    timings: [
      { stNodeIndex: 0, expectedArrivalTime: 0, expectedDepartureTime: 30 },
      { stNodeIndex: 1, expectedArrivalTime: 330, expectedDepartureTime: 360 },
    ],
  };
  const clipped = {
    id: 'statewide',
    openWorldProjectionDormant: true,
    openWorldNativeCommuteTrains: [deferredTrain],
    openWorldNativeCommuteStations: [{ id: 'remote-station', stNodeIds: ['remote-node'] }],
    stNodes: [{ id: 'local-node' }],
    openWorldGlobalRoute: {
      id: 'statewide',
      stNodes: [{ id: 'local-node' }, { id: 'remote-node' }],
      stCombos: [{ startStNodeId: 'local-node', endStNodeId: 'remote-node', path: [] }],
      stComboTimings: [
        { stNodeIndex: 0, arrivalTime: 0, departureTime: 30 },
        { stNodeIndex: 1, arrivalTime: 330, departureTime: 360 },
      ],
    },
    trainSchedule: { highDemand: 2, mediumDemand: 2, lowDemand: 1, veryLowDemand: 1 },
  };
  const localTrain = { id: 'local-train', routeId: 'local', timings: [] };
  fixture.state.routes = [clipped];
  fixture.state.trains = [localTrain];
  fixture.state.stations = [];
  fixture.state.timeConfig.elapsedSeconds = 100_000;
  const tickObservations = [];
  const commuteObservations = [];
  fixture.state.simulateCommutes = () => {
    commuteObservations.push({
      trainIds: fixture.state.trains.map((train) => train.id),
      stationIds: fixture.state.stations.map((station) => station.id),
      routeNodeIds: fixture.state.routes[0].stNodes.map((node) => node.id),
      deferredDeparture: fixture.state.trains
        .find((train) => train.id === 'statewide-commute-train')?.timings?.[0]?.expectedDepartureTime,
      deferredFutureMax: Math.max(...(fixture.state.trains
        .find((train) => train.id === 'statewide-commute-train')?.timings?.[0]
        ?.futureCycleDepartureTimes ?? [])),
      schedule: fixture.state.routes[0].trainSchedule,
    });
    return Promise.resolve('commutes');
  };
  fixture.state.handleIncrementGameState = () => {
    tickObservations.push(fixture.state.trains.map((train) => train.id));
    return fixture.state.simulateCommutes({ popCommutes: [{ popId: 'native-pop' }] });
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  assert.deepEqual(adapter.installClippedRouteTickGuard(), { installed: true, reused: false });
  await fixture.state.handleIncrementGameState();

  assert.deepEqual(tickObservations, [['local-train']], 'the simulation tick must not move the deferred train');
  assert.deepEqual(commuteObservations, [{
    trainIds: ['local-train', 'statewide-commute-train'],
    stationIds: ['remote-station'],
    routeNodeIds: ['local-node', 'remote-node'],
    deferredDeparture: 99_750,
    deferredFutureMax: 100_830,
    schedule: null,
  }], 'native commute RAPTOR must receive the deferred service timing');
  assert.deepEqual(fixture.state.trains, [localTrain], 'commute-only trains must never persist in native state');
  assert.equal(deferredTrain.timings[0].expectedDepartureTime, 30, 'rebasing must not mutate global train state');
  assert.deepEqual(fixture.state.stations, [], 'commute-only stations must never enter native rendering state');
  assert.deepEqual(
    fixture.state.routes[0].stNodes.map((node) => node.id),
    ['local-node'],
    'authoritative route topology must never persist in native rendering state',
  );
});

test('clipped-route commute service follows the saved schedule instead of a frozen partial fleet', async () => {
  const fixture = realSeamFixture();
  const cycleSeconds = 1_200;
  const staleTrains = [0, 1].map((index) => ({
    id: `stale-${index}`,
    routeId: 'statewide',
    operatingSchedule: { highDemand: true, mediumDemand: true, lowDemand: true, veryLowDemand: true },
    timings: [
      { stNodeIndex: 0, expectedArrivalTime: 10, expectedDepartureTime: 20 },
      { stNodeIndex: 1, expectedArrivalTime: 1_190, expectedDepartureTime: 1_200 },
    ],
  }));
  fixture.state.routes = [{
    id: 'statewide',
    openWorldProjectionDormant: true,
    openWorldNativeCommuteTrains: staleTrains,
    openWorldNativeCommuteStations: [
      { id: 'origin', stNodeIds: ['origin-node'] },
      { id: 'destination', stNodeIds: ['destination-node'] },
    ],
    openWorldNativeCommuteRoute: {
      id: 'statewide',
      stNodes: [{ id: 'origin-node' }, { id: 'destination-node' }],
      stCombos: [{ startStNodeId: 'origin-node', endStNodeId: 'destination-node', path: [] }],
      stComboTimings: [
        { stNodeIndex: 0, arrivalTime: 10, departureTime: 20 },
        { stNodeIndex: 1, arrivalTime: 1_190, departureTime: cycleSeconds },
      ],
      trainSchedule: { highDemand: 4, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1 },
    },
    trainSchedule: { highDemand: 4, mediumDemand: 3, lowDemand: 2, veryLowDemand: 1 },
  }];
  fixture.state.stations = [];
  fixture.state.trains = [];
  fixture.state.timeConfig.elapsedSeconds = 17 * 3_600;
  let observedTrains = [];
  fixture.state.simulateCommutes = () => {
    observedTrains = structuredClone(fixture.state.trains);
    return Promise.resolve();
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);
  adapter.installClippedRouteTickGuard();

  await fixture.state.simulateCommutes({ popCommutes: [] });

  assert.equal(observedTrains.length, 4, 'peak schedule requires four evenly phased service trips');
  const phases = observedTrains
    .map((train) => ((train.timings[0].expectedDepartureTime % cycleSeconds) + cycleSeconds) % cycleSeconds)
    .sort((left, right) => left - right);
  const cyclicGaps = phases.map((phase, index) => (
    index === phases.length - 1 ? phases[0] + cycleSeconds - phase : phases[index + 1] - phase
  ));
  assert.ok(Math.max(...cyclicGaps) <= cycleSeconds / 4 + 0.001, `uneven service gaps: ${cyclicGaps}`);
});

test('clipped-route commute hydration upgrades an already-loaded legacy projection', () => {
  const fixture = realSeamFixture();
  fixture.state.routes = [{
    id: 'statewide',
    openWorldProjectionDormant: true,
    stNodes: [{ id: 'local-node' }],
    openWorldGlobalRoute: { id: 'statewide', stNodes: [{ id: 'stale-local-node' }] },
  }];
  fixture.state.trains = [];
  fixture.state.stations = [{ id: 'local', stNodeIds: ['local-node'] }];
  const authoritative = {
    routes: [{
      id: 'statewide',
      stNodes: [{ id: 'local-node' }, { id: 'remote-node' }],
      stCombos: [{ startStNodeId: 'local-node', endStNodeId: 'remote-node', path: [] }],
    }],
    trains: [{
      id: 'statewide-train', routeId: 'statewide',
      timings: [
        { stNodeIndex: 0, expectedArrivalTime: 0, expectedDepartureTime: 30 },
        { stNodeIndex: 1, expectedArrivalTime: 330, expectedDepartureTime: 360 },
      ],
    }],
    stations: [
      { id: 'local', stNodeIds: ['local-node'] },
      { id: 'remote', stNodeIds: ['remote-node'] },
    ],
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  const result = adapter.hydrateClippedRouteCommuteData(authoritative);

  assert.deepEqual(result, { hydratedRoutes: 1, trains: 1, stations: 2 });
  assert.deepEqual(
    fixture.state.routes[0].openWorldNativeCommuteRoute.stNodes.map((node) => node.id),
    ['local-node', 'remote-node'],
  );
  assert.deepEqual(
    fixture.state.routes[0].openWorldNativeCommuteTrains.map((train) => train.id),
    ['statewide-train'],
  );
  assert.deepEqual(
    fixture.state.routes[0].openWorldNativeCommuteStations.map((station) => station.id),
    ['local', 'remote'],
  );
  assert.deepEqual(
    fixture.state.routes[0].openWorldGlobalRoute.stNodes.map((node) => node.id),
    ['stale-local-node'],
    'hydration must not replace editor topology with a possibly older persisted route',
  );
});

test('mod-reload hydration removes remote terminal nodes from an already-loaded route facade', () => {
  const fixture = realSeamFixture();
  fixture.state.routes = [{
    id: 'statewide',
    openWorldProjectionDormant: true,
    // This is the stale pre-fix facade still resident in Zustand when the mod
    // is reloaded without reloading the entire native save.
    stNodes: [{ id: 'local-a' }, { id: 'local-b' }, { id: 'remote-terminal' }],
    openWorldGlobalRoute: {
      id: 'statewide',
      stNodes: [{ id: 'local-a' }, { id: 'local-b' }, { id: 'remote-terminal' }],
    },
  }];
  fixture.state.stations = [
    { id: 'local-a-station', stNodeIds: ['local-a'] },
    { id: 'local-b-station', stNodeIds: ['local-b'] },
  ];
  fixture.state.trains = [];
  const authoritative = {
    routes: [{
      id: 'statewide',
      stNodes: [{ id: 'local-a' }, { id: 'local-b' }, { id: 'remote-terminal' }],
      stCombos: [],
    }],
    trains: [],
    stations: [
      ...fixture.state.stations,
      { id: 'remote-station', stNodeIds: ['remote-terminal'] },
    ],
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.hydrateClippedRouteCommuteData(authoritative);

  const deliveredNodeIds = new Set(fixture.state.stations.flatMap(({ stNodeIds }) => stNodeIds));
  const facade = fixture.state.routes[0];
  assert.ok(
    facade.stNodes.every(({ id }) => deliveredNodeIds.has(id)),
    'the native route splitter leaves its final split open when a facade node has no delivered station',
  );
  assert.deepEqual(facade.stNodes.map(({ id }) => id), ['local-a', 'local-b']);
  assert.deepEqual(
    facade.openWorldGlobalRoute.stNodes.map(({ id }) => id),
    ['local-a', 'local-b', 'remote-terminal'],
    'localizing the live facade must not alter authoritative topology',
  );
});

test('clipped-route hydration gives the visible facade matching timing indices', () => {
  const fixture = realSeamFixture();
  fixture.state.routes = [{
    id: 'statewide',
    openWorldProjectionDormant: true,
    stNodes: [{ id: 'local-a' }, { id: 'local-b' }],
    stComboTimings: [
      { stNodeId: 'remote-a', stNodeIndex: 0, arrivalTime: 0, departureTime: 40 },
      { stNodeId: 'local-a', stNodeIndex: 1, arrivalTime: 100, departureTime: 140 },
      { stNodeId: 'local-b', stNodeIndex: 2, arrivalTime: 220, departureTime: 260 },
    ],
  }];
  fixture.state.trains = [];
  fixture.state.stations = [
    { id: 'local-a-station', stNodeIds: ['local-a'] },
    { id: 'local-b-station', stNodeIds: ['local-b'] },
  ];
  const authoritative = {
    routes: [{
      id: 'statewide',
      stNodes: [{ id: 'remote-a' }, { id: 'local-a' }, { id: 'local-b' }],
      stCombos: [
        { startStNodeId: 'remote-a', endStNodeId: 'local-a', path: [], distance: 1 },
        { startStNodeId: 'local-a', endStNodeId: 'local-b', path: [], distance: 1 },
      ],
      stComboTimings: [
        { stNodeId: 'remote-a', stNodeIndex: 0, arrivalTime: 0, departureTime: 40 },
        { stNodeId: 'local-a', stNodeIndex: 1, arrivalTime: 100, departureTime: 140 },
        { stNodeId: 'local-b', stNodeIndex: 2, arrivalTime: 220, departureTime: 260 },
      ],
    }],
    trains: [],
    stations: [],
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.hydrateClippedRouteCommuteData(authoritative);

  assert.deepEqual(fixture.state.routes[0].stComboTimings, [
    { stNodeId: 'local-a', stNodeIndex: 0, arrivalTime: 0, departureTime: 40 },
    { stNodeId: 'local-b', stNodeIndex: 1, arrivalTime: 120, departureTime: 160 },
  ]);
});

test('clipped-route track-edit guard keeps dormant routes out of native route regeneration', () => {
  const fixture = realSeamFixture();
  const clipped = { id: 'statewide', openWorldProjectionDormant: true, stNodes: [{ id: 'remote-stop' }] };
  const local = { id: 'local', stNodes: [{ id: 'local-stop' }] };
  fixture.state.routes = [clipped, local];
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  const observed = [];
  fixture.state.setTracks = () => {
    observed.push(fixture.state.routes.map((route) => route.id));
    if (fixture.state.routes.some((route) => route.openWorldProjectionDormant)) {
      throw new Error('No path found for clipped route');
    }
    fixture.state.routes = fixture.state.routes.map((route) => (
      route.id === 'local' ? { ...route, regenerated: true } : route
    ));
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  assert.deepEqual(adapter.installClippedRouteTrackEditGuard(), { installed: true, reused: false });
  assert.doesNotThrow(() => fixture.state.setTracks({ newTracks: [] }));

  assert.deepEqual(observed, [['local']]);
  assert.deepEqual(fixture.state.routes.map((route) => route.id), ['statewide', 'local']);
  assert.equal(fixture.state.routes.find((route) => route.id === 'local').regenerated, true);
  assert.equal(fixture.state.routes.find((route) => route.id === 'statewide').stNodes[0].id, 'remote-stop');
  assert.deepEqual(adapter.installClippedRouteTrackEditGuard(), { installed: true, reused: true });
});

test('clipped-route preview guard edits the local station run while preserving remote stops', async () => {
  const fixture = realSeamFixture();
  const combo = (startStNodeId, endStNodeId, trackId) => ({
    startStNodeId, endStNodeId, path: [{ trackId }],
  });
  const globalRoute = {
    id: 'statewide',
    stNodes: ['remote-a', 'local-a', 'local-b', 'remote-b'].map((id) => ({ id })),
    stCombos: [
      combo('remote-a', 'local-a', 'remote-west'),
      combo('local-a', 'local-b', 'local-old'),
      combo('local-b', 'remote-b', 'remote-east'),
    ],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = ['local-a', 'new-local', 'local-b'].map((id) => ({ id }));
  fixture.state.stations = ['local-a', 'new-local', 'local-b'].map((id) => ({
    id: `station-${id}`,
    stNodeIds: [id],
  }));
  fixture.state.tracks = [{ id: 'local-old' }, { id: 'local-new-a' }, { id: 'local-new-b' }];
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'new-local', action: 'add' }];
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.clearPendingStNodeChanges = () => { fixture.state.pendingStNodeChanges = []; };
  fixture.state.setRoutes = (routes, regenerate) => {
    assert.equal(regenerate, false);
    fixture.state.routes = routes;
  };
  const observed = [];
  fixture.state.batchPreviewRouteUpdates = async () => {
    observed.push(fixture.state.previewRoute.stNodes.map(({ id }) => id));
    for (const node of fixture.state.previewRoute.stNodes) {
      if (!fixture.state.stNodes.some(({ id }) => id === node.id)) throw new Error(`Station not found for stNodeId: ${node.id}`);
    }
    fixture.state.setPreviewRoute({
      ...fixture.state.previewRoute,
      stNodes: ['local-a', 'new-local', 'local-b'].map((id) => ({ id })),
      stCombos: [
        combo('local-a', 'new-local', 'local-new-a'),
        combo('new-local', 'local-b', 'local-new-b'),
      ],
    });
  };
  fixture.state.confirmRouteChange = () => {
    throw new Error('native confirmation cannot resolve remote station nodes');
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);
  const staleConfirmedRouteIds = [];
  const confirmedRouteIds = [];

  assert.deepEqual(adapter.installClippedRoutePreviewEditGuard({
    onConfirmed: ({ routeId }) => staleConfirmedRouteIds.push(routeId),
  }), { installed: true, reused: false });
  assert.deepEqual(adapter.installClippedRoutePreviewEditGuard({
    onConfirmed: ({ routeId }) => confirmedRouteIds.push(routeId),
  }), { installed: true, reused: true });
  await assert.doesNotReject(fixture.state.batchPreviewRouteUpdates());
  assert.deepEqual(observed, [['local-a', 'local-b']]);
  assert.deepEqual(
    fixture.state.previewRoute.stNodes.map(({ id }) => id),
    ['local-a', 'new-local', 'local-b'],
  );
  assert.deepEqual(
    fixture.state.previewRoute.openWorldGlobalRoute.stCombos
      .map(({ startStNodeId, endStNodeId }) => [startStNodeId, endStNodeId]),
    [['remote-a', 'local-a'], ['local-a', 'new-local'], ['new-local', 'local-b'], ['local-b', 'remote-b']],
  );
  assert.deepEqual(fixture.state.confirmRouteChange(), { success: true });
  assert.deepEqual(
    fixture.state.routes[0].stNodes.map(({ id }) => id),
    ['local-a', 'new-local', 'local-b'],
    'the native route prop must remain a converter-safe local facade after confirmation',
  );
  assert.deepEqual(
    fixture.state.routes[0].openWorldGlobalRoute.stCombos
      .map(({ startStNodeId, endStNodeId }) => [startStNodeId, endStNodeId]),
    [['remote-a', 'local-a'], ['local-a', 'new-local'], ['new-local', 'local-b'], ['local-b', 'remote-b']],
  );
  assert.equal(
    fixture.state.routes[0].openWorldProjectionLocalEdit,
    true,
    'confirmation must retain the marker until projection reconciliation persists the full route',
  );
  assert.deepEqual(staleConfirmedRouteIds, [], 'hot reload must replace the stale confirmation listener');
  assert.deepEqual(confirmedRouteIds, ['statewide']);
  assert.equal(fixture.state.previewRoute, null);
  assert.deepEqual(adapter.installClippedRoutePreviewEditGuard(), { installed: true, reused: true });
});

test('clipped-route preview guard never presents disconnected local route fragments to native pathfinding', async () => {
  const fixture = realSeamFixture();
  const combo = (startStNodeId, endStNodeId, trackId) => ({
    startStNodeId, endStNodeId, path: [{ trackId }],
  });
  const globalRoute = {
    id: 'statewide',
    stNodes: ['local-west', 'remote-gap', 'local-east'].map((id) => ({ id })),
    stCombos: [
      combo('local-west', 'remote-gap', 'remote-west'),
      combo('remote-gap', 'local-east', 'remote-east'),
    ],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = ['local-west', 'new-local', 'local-east'].map((id) => ({ id }));
  fixture.state.tracks = [{ id: 'new-west' }];
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'new-local', action: 'add' }];
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.clearPendingStNodeChanges = () => { fixture.state.pendingStNodeChanges = []; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  const observed = [];
  fixture.state.batchPreviewRouteUpdates = async () => {
    const ids = fixture.state.previewRoute.stNodes.map(({ id }) => id);
    observed.push(ids);
    // This is the native failure in the screenshot: two delivered stops are
    // separated by topology outside the tile window.
    if (ids.includes('local-west') && ids.includes('local-east')) return;
    fixture.state.setPreviewRoute({
      ...fixture.state.previewRoute,
      stNodes: [...fixture.state.previewRoute.stNodes, { id: 'new-local' }],
      stCombos: [combo(ids[0], 'new-local', 'new-west')],
    });
  };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  await fixture.state.batchPreviewRouteUpdates();

  assert.equal(observed.length, 1);
  assert.equal(observed[0].includes('local-west') && observed[0].includes('local-east'), false);
  assert.deepEqual(
    fixture.state.previewRoute.openWorldGlobalRoute.stNodes.map(({ id }) => id),
    observed[0][0] === 'local-west'
      ? ['local-west', 'new-local', 'remote-gap', 'local-east']
      : ['local-west', 'remote-gap', 'local-east', 'new-local'],
  );
});

test('clipped-route preview guard splits delivered loop stops when their turnaround path leaves the window', async () => {
  const fixture = realSeamFixture();
  const globalRoute = {
    id: 'downtown-uptown-loop',
    stNodes: [
      { id: 'downtown', center: [0, 0] },
      { id: 'uptown', center: [0, 1] },
      { id: 'next-local', center: [0, 2] },
    ],
    stCombos: [
      {
        startStNodeId: 'downtown',
        endStNodeId: 'uptown',
        path: [{ trackId: 'turn-a', reversed: false }, { trackId: 'turn-b', reversed: false }],
      },
      {
        startStNodeId: 'uptown',
        endStNodeId: 'next-local',
        path: [{ trackId: 'delivered-track' }],
      },
    ],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = [
    { id: 'downtown', center: [0, 0] },
    { id: 'new-local', center: [0, 0.1] },
    { id: 'uptown', center: [0, 1] },
    { id: 'next-local', center: [0, 2] },
  ];
  fixture.state.tracks = [
    { id: 'turn-a', coords: [[0, 0], [0, 0.25]] },
    // Both clipped path IDs exist, but the missing turnaround leaves their
    // oriented endpoints disconnected—matching the persisted Empire Line.
    { id: 'turn-b', coords: [[0, 0.75], [0, 1]] },
    { id: 'delivered-track', coords: [[0, 1], [0, 2]] },
    { id: 'new-track', coords: [[0, 0], [0, 0.1]] },
  ];
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'new-local', action: 'add' }];
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  const observed = [];
  fixture.state.batchPreviewRouteUpdates = async () => {
    const ids = fixture.state.previewRoute.stNodes.map(({ id }) => id);
    observed.push(ids);
    if (ids.includes('downtown') && ids.includes('uptown')) {
      throw new Error('No path found between downtown and uptown');
    }
    fixture.state.setPreviewRoute({
      ...fixture.state.previewRoute,
      stNodes: [...fixture.state.previewRoute.stNodes, { id: 'new-local', center: [0, 0.1] }],
    });
  };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();

  await assert.doesNotReject(fixture.state.batchPreviewRouteUpdates());
  assert.equal(observed[0].includes('downtown') && observed[0].includes('uptown'), false);
});

test('clipped-route preview guard splits coincident tracks at different elevations', async () => {
  const fixture = realSeamFixture();
  const globalRoute = {
    id: 'grade-separated-loop',
    stNodes: ['lower', 'upper'].map((id) => ({ id })),
    stCombos: [{
      startStNodeId: 'lower',
      endStNodeId: 'upper',
      path: [{ trackId: 'lower-track' }, { trackId: 'upper-track' }],
    }],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = [
    { id: 'lower', center: [0, 0] },
    { id: 'new-local', center: [0, 0.1] },
    { id: 'upper', center: [0, 1] },
  ];
  fixture.state.tracks = [
    { id: 'lower-track', coords: [[0, 0], [0, 0.5]], startElevation: -10, endElevation: -10 },
    { id: 'upper-track', coords: [[0, 0.5], [0, 1]], startElevation: 10, endElevation: 10 },
  ];
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'new-local', action: 'add' }];
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  const observed = [];
  fixture.state.batchPreviewRouteUpdates = async () => {
    const ids = fixture.state.previewRoute.stNodes.map(({ id }) => id);
    observed.push(ids);
    if (ids.includes('lower') && ids.includes('upper')) {
      throw new Error('No path found across coincident grade-separated tracks');
    }
  };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();

  await assert.doesNotReject(fixture.state.batchPreviewRouteUpdates());
  assert.equal(observed[0].includes('lower') && observed[0].includes('upper'), false);
});

test('clipped-route preview guard orients elevation endpoints for reversed path segments', async () => {
  const fixture = realSeamFixture();
  const globalRoute = {
    id: 'reversed-grade',
    stNodes: ['local-a', 'local-b'].map((id) => ({ id })),
    stCombos: [{
      startStNodeId: 'local-a',
      endStNodeId: 'local-b',
      path: [{ trackId: 'reversed-track', reversed: true }, { trackId: 'forward-track', reversed: false }],
    }],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = [
    { id: 'local-a', center: [0, 0] },
    { id: 'new-local', center: [0, 0.1] },
    { id: 'local-b', center: [0, 1] },
  ];
  fixture.state.tracks = [
    {
      id: 'reversed-track',
      coords: [[0, 0.5], [0, 0]],
      startElevation: 10,
      endElevation: -10,
    },
    {
      id: 'forward-track',
      coords: [[0, 0.5], [0, 1]],
      startElevation: 10,
      endElevation: 10,
    },
  ];
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'new-local', action: 'add' }];
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  const observed = [];
  fixture.state.batchPreviewRouteUpdates = async () => {
    observed.push(fixture.state.previewRoute.stNodes.map(({ id }) => id));
  };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  await fixture.state.batchPreviewRouteUpdates();

  assert.deepEqual(observed, [['local-a', 'local-b']]);
});

test('clipped-route preview guard chooses the reachable parallel side instead of the nearest marker', async () => {
  const fixture = realSeamFixture();
  const globalRoute = {
    id: 'parallel-loop',
    stNodes: [
      { id: 'near-wrong', center: [0, 0], trackIds: ['wrong-a', 'wrong-b'] },
      { id: 'remote', center: [1, 1], trackIds: ['remote-a', 'remote-b'] },
      { id: 'far-reachable', center: [0, 1], trackIds: ['right-a', 'right-b'] },
    ],
    stCombos: [],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = [
    globalRoute.stNodes[0],
    globalRoute.stNodes[2],
    { id: 'new-local', center: [0, 0.1], trackIds: ['new-a', 'new-b'] },
  ];
  fixture.state.tracks = [
    { id: 'wrong-a', coords: [[0, -0.1], [0, 0]], startElevation: 0, endElevation: 0, length: 1 },
    { id: 'wrong-b', coords: [[0, 0], [0, 0.04]], startElevation: 0, endElevation: 0, length: 1 },
    { id: 'new-a', coords: [[0, 0.1], [0, 0.2]], startElevation: 0, endElevation: 0, length: 1 },
    { id: 'new-b', coords: [[0, 0.05], [0, 0.1]], startElevation: 0, endElevation: 0, length: 1 },
    { id: 'connector', coords: [[0, 0.2], [0, 0.9]], startElevation: 0, endElevation: 0, length: 10 },
    { id: 'right-a', coords: [[0, 0.9], [0, 1]], startElevation: 0, endElevation: 0, length: 1 },
    { id: 'right-b', coords: [[0, 1], [0, 1.1]], startElevation: 0, endElevation: 0, length: 1 },
  ];
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'new-local', action: 'add' }];
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  const observed = [];
  fixture.state.batchPreviewRouteUpdates = async () => {
    const ids = fixture.state.previewRoute.stNodes.map(({ id }) => id);
    observed.push(ids);
    if (ids.includes('near-wrong')) throw new Error('No path found on geographically nearest parallel side');
    fixture.state.setPreviewRoute({
      ...fixture.state.previewRoute,
      stNodes: [{ id: 'new-local' }, ...fixture.state.previewRoute.stNodes],
    });
  };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();

  await assert.doesNotReject(fixture.state.batchPreviewRouteUpdates());
  assert.deepEqual(observed, [['far-reachable']]);
  assert.deepEqual(
    fixture.state.previewRoute.stNodes.map(({ id }) => id),
    ['new-local', 'far-reachable'],
  );
});

test('clipped-route preview guard follows native directed trackGraph reachability', async () => {
  const fixture = realSeamFixture();
  const nearWrong = { id: 'near-wrong', center: [0, 0], trackIds: ['near-platform'] };
  const farReachable = { id: 'far-reachable', center: [0, 1], trackIds: ['far-platform'] };
  const added = { id: 'new-local', center: [0, 0.1], trackIds: ['new-platform'] };
  const globalRoute = {
    id: 'directed-loop',
    stNodes: [nearWrong, { id: 'remote', center: [1, 1] }, farReachable],
    stCombos: [],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = [nearWrong, farReachable, added];
  // Track geometry intentionally makes the wrong platform look closest. The
  // native graph only allows near -> added, while the far side is traversable
  // in both directions.
  fixture.state.tracks = [
    { id: 'near-platform', coords: [[0, 0], [0, 0.1]], startElevation: 0, endElevation: 0, length: 1 },
    { id: 'new-platform', coords: [[0, 0.1], [0, 0.2]], startElevation: 0, endElevation: 0, length: 1 },
    { id: 'far-platform', coords: [[0, 0.9], [0, 1]], startElevation: 0, endElevation: 0, length: 1 },
  ];
  fixture.state.trackGraph = new Map([
    ['0-0', [{ coordsString: '0-0.1', trackId: 'near-platform', reversed: false }]],
    ['0-0.1', [{ coordsString: '0-0.9', trackId: 'connector', reversed: false }]],
    ['0-0.9', [
      { coordsString: '0-0.1', trackId: 'connector', reversed: true },
      { coordsString: '0-1', trackId: 'far-platform', reversed: false },
    ]],
    ['0-1', [{ coordsString: '0-0.9', trackId: 'far-platform', reversed: true }]],
  ]);
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'new-local', action: 'add' }];
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  const observed = [];
  fixture.state.batchPreviewRouteUpdates = async () => {
    observed.push(fixture.state.previewRoute.stNodes.map(({ id }) => id));
  };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  await fixture.state.batchPreviewRouteUpdates();

  assert.deepEqual(observed, [['far-reachable']]);
  assert.equal(
    globalThis.__openWorldLastClippedRouteDiagnostic.directedRunSelection.trackGraphSize,
    4,
  );
});

test('clipped-route preview guard applies opposite station platforms through separate directed runs', async () => {
  delete globalThis.__openWorldClippedRouteDiagnostics;
  const fixture = realSeamFixture();
  const outbound = { id: 'outbound', center: [0, 0], trackIds: ['outbound-platform'] };
  const inbound = { id: 'inbound', center: [0, 1], trackIds: ['inbound-platform'] };
  const addedOutbound = { id: 'added-outbound', center: [0, 0.1], trackIds: ['added-outbound-platform'] };
  const addedInbound = { id: 'added-inbound', center: [0, 0.9], trackIds: ['added-inbound-platform'] };
  const globalRoute = {
    id: 'split-direction-loop',
    stNodes: [outbound, { id: 'remote-turnaround', center: [1, 1] }, inbound],
    stCombos: [],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = [outbound, inbound, addedOutbound, addedInbound];
  fixture.state.stations = [outbound, inbound, addedOutbound, addedInbound].map((node) => ({
    id: `${node.id}-station`,
    stNodeIds: [node.id],
  }));
  fixture.state.tracks = [];
  fixture.state.trackGraph = new Map([
    ['0-0', [{
      coordsString: '0-0.1', trackId: 'outbound-track', trackIsReversed: true, trackLength: 125,
    }]],
    ['0-0.9', [{
      coordsString: '0-1', trackId: 'inbound-track', trackIsReversed: false, trackLength: 150,
    }]],
  ]);
  fixture.state.pendingStNodeChanges = [
    { stNodeId: 'added-outbound', action: 'add' },
    { stNodeId: 'added-inbound', action: 'add' },
  ];
  fixture.state.processingStNodeChanges = [];
  fixture.state.clearPendingStNodeChanges = () => { fixture.state.pendingStNodeChanges = []; };
  fixture.state.changePreviewRoute = (change) => { fixture.state.pendingStNodeChanges.push(change); };
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  let nativeBatchCalls = 0;
  fixture.state.batchPreviewRouteUpdates = async () => {
    nativeBatchCalls += 1;
    throw new Error('native batch must not close a clipped directed fragment');
  };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  await fixture.state.batchPreviewRouteUpdates();

  assert.equal(nativeBatchCalls, 0);
  assert.deepEqual(
    fixture.state.previewRoute.openWorldGlobalRoute.stNodes.map(({ id }) => id),
    ['outbound', 'added-outbound', 'remote-turnaround', 'added-inbound', 'inbound'],
  );
  assert.deepEqual(
    fixture.state.previewRoute.stNodes.map(({ id }) => id),
    ['outbound', 'added-outbound', 'added-inbound', 'inbound'],
    'both delivered directional runs remain visible and selectable',
  );
  assert.equal(fixture.state.previewRoute.openWorldMultiRunPresentation, true);
  assert.deepEqual(
    fixture.state.previewRoute.openWorldGlobalRoute.stCombos.map(({ startStNodeId, endStNodeId }) => (
      `${startStNodeId}->${endStNodeId}`
    )),
    ['outbound->added-outbound', 'added-inbound->inbound'],
  );
  assert.deepEqual(
    fixture.state.previewRoute.openWorldGlobalRoute.stCombos.map(({ distance }) => distance),
    [125, 150],
  );
  assert.equal(
    fixture.state.previewRoute.openWorldGlobalRoute.stCombos[0].path[0].reversed,
    true,
  );
  assert.equal(globalThis.__openWorldLastClippedRouteDiagnostic.stage, 'after-native');
  assert.equal(globalThis.__openWorldLastClippedRouteDiagnostic.applied, true);
});

test('clipped-route preview guard applies one directional platform flushed in its own batch', async () => {
  const fixture = realSeamFixture();
  const outbound = { id: 'outbound', center: [0, 0], trackIds: ['outbound-platform'] };
  const inbound = { id: 'inbound', center: [0, 1], trackIds: ['inbound-platform'] };
  const addedInbound = { id: 'added-inbound', center: [0, 0.9], trackIds: ['added-inbound-platform'] };
  const globalRoute = {
    id: 'single-flush-loop',
    stNodes: [outbound, { id: 'remote-turnaround', center: [1, 1] }, inbound],
    stCombos: [
      { startStNodeId: 'outbound', endStNodeId: 'remote-turnaround', path: [{ trackId: 'remote-a', length: 1_000 }], distance: 1_000 },
      { startStNodeId: 'remote-turnaround', endStNodeId: 'inbound', path: [{ trackId: 'remote-b', length: 1_000 }], distance: 1_000 },
    ],
    stComboTimings: [
      { stNodeId: 'outbound', stNodeIndex: 0, arrivalTime: 0, departureTime: 40 },
      { stNodeId: 'remote-turnaround', stNodeIndex: 1, arrivalTime: 140, departureTime: 180 },
      { stNodeId: 'inbound', stNodeIndex: 2, arrivalTime: 280, departureTime: 320 },
    ],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = [outbound, inbound, addedInbound];
  fixture.state.tracks = [];
  fixture.state.trackGraph = new Map([[
    '0-0.9',
    [{
      coordsString: '0-1', trackId: 'inbound-track', trackIsReversed: false, trackLength: 150,
    }],
  ]]);
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'added-inbound', action: 'add' }];
  fixture.state.clearPendingStNodeChanges = () => { fixture.state.pendingStNodeChanges = []; };
  fixture.state.changePreviewRoute = (change) => { fixture.state.pendingStNodeChanges.push(change); };
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  let nativeBatchCalls = 0;
  fixture.state.batchPreviewRouteUpdates = async () => { nativeBatchCalls += 1; };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  await fixture.state.batchPreviewRouteUpdates();

  assert.equal(nativeBatchCalls, 0);
  assert.deepEqual(
    fixture.state.previewRoute.openWorldGlobalRoute.stNodes.map(({ id }) => id),
    ['outbound', 'remote-turnaround', 'added-inbound', 'inbound'],
  );
  assert.equal(
    fixture.state.previewRoute.openWorldGlobalRoute.stCombos
      .find(({ startStNodeId, endStNodeId }) => startStNodeId === 'added-inbound' && endStNodeId === 'inbound')
      .distance,
    150,
  );
  const canonical = fixture.state.previewRoute.openWorldGlobalRoute;
  assert.deepEqual(
    canonical.stCombos.map(({ startStNodeId, endStNodeId }) => `${startStNodeId}->${endStNodeId}`),
    ['outbound->remote-turnaround', 'remote-turnaround->added-inbound', 'added-inbound->inbound'],
    'the inserted stop must replace, not duplicate, the old unsplit route edge',
  );
  assert.deepEqual(
    canonical.stComboTimings.map(({ stNodeId, stNodeIndex }) => [stNodeId, stNodeIndex]),
    [['outbound', 0], ['remote-turnaround', 1], ['added-inbound', 2], ['inbound', 3]],
    'every reconstructed stop must receive a timing record at its new route index',
  );
  assert.ok(canonical.stComboTimings[2].arrivalTime > canonical.stComboTimings[1].departureTime);
  assert.ok(canonical.stComboTimings[2].departureTime < canonical.stComboTimings[3].arrivalTime);
  assert.equal(globalThis.__openWorldLastClippedRouteDiagnostic.applied, true);
});

test('clipped-route preview guard treats a repeated add for an existing global stop as a no-op', async () => {
  const fixture = realSeamFixture();
  const localA = { id: 'local-a', center: [0, 0] };
  const existingAdded = { id: 'existing-added', center: [0, 0.5] };
  const remote = { id: 'remote', center: [1, 1] };
  const globalRoute = {
    id: 'duplicate-add-loop',
    stNodes: [localA, existingAdded, remote],
    stCombos: [],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  // Preserve a different visible fragment: a duplicate click must not switch
  // the route editor to the fragment containing the already-added stop.
  fixture.state.previewRoute = {
    ...structuredClone(fixture.state.routes[0]),
    stNodes: [remote],
  };
  fixture.state.stNodes = [localA, existingAdded, remote];
  fixture.state.trackGraph = new Map([['0-0', []]]);
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'existing-added', action: 'add' }];
  fixture.state.clearPendingStNodeChanges = () => { fixture.state.pendingStNodeChanges = []; };
  fixture.state.changePreviewRoute = (change) => { fixture.state.pendingStNodeChanges.push(change); };
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  let nativeBatchCalls = 0;
  fixture.state.batchPreviewRouteUpdates = async () => { nativeBatchCalls += 1; };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  await fixture.state.batchPreviewRouteUpdates();

  assert.equal(nativeBatchCalls, 0);
  assert.deepEqual(fixture.state.previewRoute.stNodes.map(({ id }) => id), ['remote']);
  assert.deepEqual(fixture.state.pendingStNodeChanges, []);
  assert.equal(globalThis.__openWorldLastClippedRouteDiagnostic.stage, 'duplicate-add-noop');
  assert.deepEqual(globalThis.__openWorldLastClippedRouteDiagnostic.duplicateNodeIds, ['existing-added']);
});

test('clipped-route preview guard removes stops by collapsing canonical paths without native regeneration', async () => {
  const fixture = realSeamFixture();
  const nodes = ['loop', 'before', 'remove-out', 'turn', 'remove-in', 'after', 'loop']
    .map((id, index) => ({ id, stationId: `station-${id}`, center: [0, index] }));
  const combo = (startStNodeId, endStNodeId, trackId, distance = 100) => ({
    startStNodeId,
    endStNodeId,
    path: [{ trackId, length: distance }],
    distance,
  });
  const globalRoute = {
    id: 'remove-from-clipped-loop',
    stNodes: nodes,
    stCombos: [
      combo('loop', 'before', 'loop-before'),
      combo('before', 'remove-out', 'split-out-a', 40),
      combo('remove-out', 'turn', 'split-out-b', 60),
      // Stale pre-split envelopes reproduce the real Empire Line sidecar.
      combo('before', 'turn', 'missing-parent-out', 100),
      combo('turn', 'remove-in', 'split-in-a', 55),
      combo('remove-in', 'after', 'split-in-b', 45),
      combo('turn', 'after', 'missing-parent-in', 100),
      combo('after', 'loop', 'after-loop'),
    ],
    stComboTimings: nodes.map((node, index) => ({
      stNodeId: node.id,
      stNodeIndex: index,
      arrivalTime: index * 100,
      departureTime: index * 100 + 40,
    })),
    trackIds: [
      'loop-before', 'split-out-a', 'split-out-b', 'missing-parent-out',
      'split-in-a', 'split-in-b', 'missing-parent-in', 'after-loop',
    ],
    stationIds: nodes.slice(0, -1).map(({ stationId }) => stationId),
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = structuredClone(nodes);
  fixture.state.stations = nodes.slice(0, -1).map(({ stationId, id }) => ({ id: stationId, stNodeIds: [id] }));
  fixture.state.tracks = globalRoute.trackIds.map((id) => ({ id }));
  fixture.state.trackGraph = new Map([
    ['0-1', [{ coordsString: '0-1.5', trackId: 'split-out-a', trackLength: 40 }]],
    ['0-1.5', [{ coordsString: '0-3', trackId: 'split-out-b', trackLength: 60 }]],
    ['0-3', [{ coordsString: '0-4.5', trackId: 'split-in-a', trackLength: 55 }]],
    ['0-4.5', [{ coordsString: '0-5', trackId: 'split-in-b', trackLength: 45 }]],
  ]);
  fixture.state.pendingStNodeChanges = [
    { stNodeId: 'remove-out', action: 'remove' },
    { stNodeId: 'remove-in', action: 'remove' },
  ];
  fixture.state.clearPendingStNodeChanges = () => { fixture.state.pendingStNodeChanges = []; };
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  let nativeBatchCalls = 0;
  fixture.state.batchPreviewRouteUpdates = async () => {
    nativeBatchCalls += 1;
    throw new Error('No path found between surviving clipped-route stops');
  };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  await assert.doesNotReject(fixture.state.batchPreviewRouteUpdates());

  assert.equal(nativeBatchCalls, 0, 'station deletion must not invoke native graph search');
  const canonical = fixture.state.previewRoute.openWorldGlobalRoute;
  assert.deepEqual(
    canonical.stNodes.map(({ id }) => id),
    ['loop', 'before', 'turn', 'after', 'loop'],
  );
  assert.deepEqual(
    canonical.stCombos.map(({ startStNodeId, endStNodeId }) => `${startStNodeId}->${endStNodeId}`),
    ['loop->before', 'before->turn', 'turn->after', 'after->loop'],
  );
  assert.deepEqual(
    canonical.stCombos[1].path.map(({ trackId }) => trackId),
    ['split-out-a', 'split-out-b'],
    'the surviving path must concatenate split children instead of restoring the missing parent',
  );
  assert.deepEqual(
    canonical.stCombos[2].path.map(({ trackId }) => trackId),
    ['split-in-a', 'split-in-b'],
  );
  assert.deepEqual(
    canonical.stComboTimings.map(({ stNodeId, stNodeIndex }) => [stNodeId, stNodeIndex]),
    [['loop', 0], ['before', 1], ['turn', 2], ['after', 3], ['loop', 4]],
  );
  assert.deepEqual(
    canonical.stComboTimings.map(({ arrivalTime }) => arrivalTime),
    [0, 100, 260, 420, 520],
    'removed station dwell is deleted while physical running time remains unchanged',
  );
  assert.deepEqual(
    fixture.state.previewRoute.stComboTimings.map(({ stNodeId, stNodeIndex }) => [stNodeId, stNodeIndex]),
    [['loop', 0], ['before', 1], ['turn', 2], ['after', 3], ['loop', 4]],
    'the visible route editor facade must receive matching timing indices immediately',
  );
  assert.deepEqual(canonical.stationIds, ['station-loop', 'station-before', 'station-turn', 'station-after']);
  assert.equal(globalThis.__openWorldLastClippedRouteDiagnostic.stage, 'after-canonical-remove');
  assert.equal(globalThis.__openWorldLastClippedRouteDiagnostic.rebuiltRemovedGaps, 2);
});

test('clipped-route removal never publishes station nodes without a delivered station map', async () => {
  const fixture = realSeamFixture();
  const nodes = ['local-a', 'remove-platform', 'local-b']
    .map((id, index) => ({ id, center: [0, index] }));
  const combo = (startStNodeId, endStNodeId, trackId) => ({
    startStNodeId,
    endStNodeId,
    path: [{ trackId, length: 50 }],
    distance: 50,
  });
  const globalRoute = {
    id: 'remove-without-station-map',
    stNodes: nodes,
    stCombos: [
      combo('local-a', 'remove-platform', 'left'),
      combo('remove-platform', 'local-b', 'right'),
    ],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = structuredClone(nodes);
  // stNodes alone are insufficient for the native route converter: its map
  // is built exclusively from stations[].stNodeIds.
  fixture.state.stations = [];
  fixture.state.tracks = [{ id: 'left' }, { id: 'right' }];
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'remove-platform', action: 'remove' }];
  fixture.state.clearPendingStNodeChanges = () => { fixture.state.pendingStNodeChanges = []; };
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  fixture.state.batchPreviewRouteUpdates = async () => {
    throw new Error('native graph search must remain bypassed');
  };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  await fixture.state.batchPreviewRouteUpdates();

  const stationNodeIds = new Set(fixture.state.stations.flatMap(({ stNodeIds }) => stNodeIds));
  assert.ok(
    fixture.state.previewRoute.stNodes.every(({ id }) => stationNodeIds.has(id)),
    'publishing an unmapped terminal reproduces “Route split index end is null” in RouteStationsView',
  );
  assert.ok(
    fixture.state.previewRoute.stComboTimings.length > 0,
    'RouteStationsView ignores previewRoute when its timings are empty and falls back to the stale route prop',
  );
});

test('clipped-route preview rejects an open native route split synchronously and keeps the prior preview', () => {
  const fixture = realSeamFixture();
  const validPreview = {
    id: 'native-split-guard',
    openWorldProjectionDormant: true,
    openWorldProjectionLocalEdit: true,
    stNodes: [{ id: 'platform-a' }, { id: 'platform-b' }],
    stComboTimings: [
      { stNodeId: 'platform-a', stNodeIndex: 0, arrivalTime: 0, departureTime: 0 },
      { stNodeId: 'platform-b', stNodeIndex: 1, arrivalTime: 60, departureTime: 60 },
    ],
  };
  fixture.state.routes = [{
    ...structuredClone(validPreview),
    openWorldGlobalRoute: structuredClone(validPreview),
  }];
  fixture.state.previewRoute = structuredClone(validPreview);
  fixture.state.stations = [
    { id: 'station-a', stNodeIds: ['platform-a'] },
    { id: 'station-b', stNodeIds: ['platform-b'] },
  ];
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'platform-b', action: 'remove' }];
  fixture.state.clearPendingStNodeChanges = () => { fixture.state.pendingStNodeChanges = []; };
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  fixture.state.batchPreviewRouteUpdates = async () => undefined;
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  fixture.state.setPreviewRoute({
    ...structuredClone(validPreview),
    stNodes: [{ id: 'platform-a' }, { id: 'missing-terminal-platform' }],
  });

  assert.deepEqual(
    fixture.state.previewRoute.stNodes.map(({ id }) => id),
    ['platform-a', 'platform-b'],
    'the invalid edit must be undone before RouteStationsView can render it',
  );
  assert.deepEqual(fixture.state.pendingStNodeChanges, []);
  assert.equal(globalThis.__openWorldLastClippedRouteDiagnostic.stage, 'invalid-native-route-order-rejected');
  assert.equal(globalThis.__openWorldLastClippedRouteDiagnostic.reason, 'open-final-route-split');
  assert.deepEqual(globalThis.__openWorldLastClippedRouteDiagnostic.missingStationNodeIds, [
    'missing-terminal-platform',
  ]);
});

test('clipped-route preview never exposes native removal with empty timings to RouteStationsView', () => {
  const fixture = realSeamFixture();
  const routeProp = {
    id: 'empty-timing-fallback-guard',
    openWorldProjectionDormant: true,
    openWorldProjectionLocalEdit: true,
    stNodes: [
      { id: 'platform-a' },
      { id: 'platform-b' },
      { id: 'removed-unmapped-terminal' },
    ],
    stComboTimings: [
      { stNodeId: 'platform-a', stNodeIndex: 0, arrivalTime: 0, departureTime: 0 },
      { stNodeId: 'platform-b', stNodeIndex: 1, arrivalTime: 60, departureTime: 60 },
      { stNodeId: 'removed-unmapped-terminal', stNodeIndex: 2, arrivalTime: 120, departureTime: 120 },
    ],
  };
  fixture.state.routes = [{
    ...structuredClone(routeProp),
    openWorldGlobalRoute: structuredClone(routeProp),
  }];
  fixture.state.previewRoute = {
    ...structuredClone(routeProp),
    stNodes: routeProp.stNodes.slice(0, 2),
    stComboTimings: routeProp.stComboTimings.slice(0, 2),
  };
  fixture.state.stations = [
    { id: 'station-a', stNodeIds: ['platform-a'] },
    { id: 'station-b', stNodeIds: ['platform-b'] },
  ];
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  fixture.state.batchPreviewRouteUpdates = async () => undefined;
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  fixture.state.setPreviewRoute({
    ...structuredClone(fixture.state.previewRoute),
    // This is exactly what native StationsList.handleRemoveStation publishes.
    stComboTimings: [],
  });

  assert.ok(
    fixture.state.previewRoute.stComboTimings.length > 0,
    'an empty array makes RouteStationsView ignore the valid preview and render the invalid route prop',
  );
  assert.deepEqual(
    fixture.state.previewRoute.stNodes.map(({ id }) => id),
    ['platform-a', 'platform-b'],
  );
});

test('clipped-route removal replaces the stale route-panel prop with the validated facade', async () => {
  const fixture = realSeamFixture();
  const nodes = ['platform-a', 'platform-b', 'removed-unmapped-terminal']
    .map((id, index) => ({ id, center: [0, index] }));
  const route = {
    id: 'stale-route-panel-prop',
    stNodes: nodes,
    stCombos: [
      { startStNodeId: 'platform-a', endStNodeId: 'platform-b', path: [], distance: 0 },
      { startStNodeId: 'platform-b', endStNodeId: 'removed-unmapped-terminal', path: [], distance: 0 },
    ],
    stComboTimings: nodes.map((node, index) => ({
      stNodeId: node.id,
      stNodeIndex: index,
      arrivalTime: index * 60,
      departureTime: index * 60,
    })),
  };
  fixture.state.routes = [{
    ...structuredClone(route),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(route),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = structuredClone(nodes);
  fixture.state.stations = [
    { id: 'station-a', stNodeIds: ['platform-a'] },
    { id: 'station-b', stNodeIds: ['platform-b'] },
  ];
  fixture.state.tracks = [];
  fixture.state.pendingStNodeChanges = [
    { stNodeId: 'removed-unmapped-terminal', action: 'remove' },
  ];
  fixture.state.clearPendingStNodeChanges = () => { fixture.state.pendingStNodeChanges = []; };
  fixture.state.setPreviewRoute = (value) => { fixture.state.previewRoute = value; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  fixture.state.batchPreviewRouteUpdates = async () => undefined;
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  await fixture.state.batchPreviewRouteUpdates();

  const publishedRoute = fixture.state.routes.find(({ id }) => id === route.id);
  assert.deepEqual(
    publishedRoute.stNodes.map(({ id }) => id),
    ['platform-a', 'platform-b'],
    'RouteStationsView receives routes[] as its route prop, so it must be as safe as previewRoute',
  );
  assert.ok(publishedRoute.stComboTimings.length > 0);
  assert.deepEqual(
    publishedRoute.openWorldGlobalRoute.stNodes.map(({ id }) => id),
    ['platform-a', 'platform-b'],
    'the removed stop must remain removed in canonical metadata',
  );
});

test('clipped-route removal repairs a separate malformed split edge before deleting one stop', async () => {
  const fixture = realSeamFixture();
  const nodes = ['a', 'inserted-a', 'b', 'remove-b', 'c']
    .map((id, index) => ({ id, center: [0, index] }));
  const combo = (startStNodeId, endStNodeId, ...trackIds) => ({
    startStNodeId,
    endStNodeId,
    path: trackIds.map((trackId) => ({ trackId, length: 50 })),
    distance: trackIds.length * 50,
  });
  const globalRoute = {
    id: 'legacy-partially-split-route',
    stNodes: nodes,
    stCombos: [
      combo('a', 'inserted-a', 'a-inserted'),
      // No inserted-a -> b edge: only the stale pre-split envelope remains.
      combo('a', 'b', 'missing-parent-a'),
      combo('b', 'remove-b', 'b-remove'),
      // No remove-b -> c edge either.
      combo('b', 'c', 'missing-parent-b'),
    ],
    stComboTimings: [
      { stNodeId: 'a', stNodeIndex: 0, arrivalTime: 0, departureTime: 40 },
      { stNodeId: 'b', stNodeIndex: 1, arrivalTime: 240, departureTime: 280 },
      { stNodeId: 'c', stNodeIndex: 2, arrivalTime: 480, departureTime: 520 },
    ],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = structuredClone(nodes);
  fixture.state.tracks = [
    'a-inserted', 'inserted-b-a', 'inserted-b-b',
    'b-remove', 'remove-c',
  ].map((id) => ({ id }));
  fixture.state.trackGraph = new Map([
    ['0-1', [{ coordsString: '0-1.5', trackId: 'inserted-b-a', trackLength: 25 }]],
    ['0-1.5', [{ coordsString: '0-2', trackId: 'inserted-b-b', trackLength: 25 }]],
    ['0-2', [{ coordsString: '0-3', trackId: 'b-remove', trackLength: 50 }]],
    ['0-3', [{ coordsString: '0-4', trackId: 'remove-c', trackLength: 50 }]],
  ]);
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'remove-b', action: 'remove' }];
  fixture.state.clearPendingStNodeChanges = () => { fixture.state.pendingStNodeChanges = []; };
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  let nativeBatchCalls = 0;
  fixture.state.batchPreviewRouteUpdates = async () => {
    nativeBatchCalls += 1;
    throw new Error('No path found between surviving clipped-route stops');
  };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  await assert.doesNotReject(fixture.state.batchPreviewRouteUpdates());

  assert.equal(nativeBatchCalls, 0);
  const canonical = fixture.state.previewRoute.openWorldGlobalRoute;
  assert.deepEqual(canonical.stNodes.map(({ id }) => id), ['a', 'inserted-a', 'b', 'c']);
  assert.deepEqual(
    canonical.stCombos.map(({ startStNodeId, endStNodeId }) => `${startStNodeId}->${endStNodeId}`),
    ['a->inserted-a', 'inserted-a->b', 'b->c'],
  );
  assert.deepEqual(
    canonical.stCombos[1].path.map(({ trackId }) => trackId),
    ['inserted-b-a', 'inserted-b-b'],
    'the unrelated malformed edge must be recovered from delivered child tracks',
  );
  assert.deepEqual(
    canonical.stCombos[2].path.map(({ trackId }) => trackId),
    ['b-remove', 'remove-c'],
  );
  assert.equal(canonical.stComboTimings.length, canonical.stNodes.length);
});

test('clipped-route preview guard recovers canonical clipping metadata stripped by the native editor', async () => {
  const fixture = realSeamFixture();
  const globalRoute = {
    id: 'normalized-loop',
    stNodes: ['local-a', 'remote', 'local-b'].map((id) => ({ id })),
    stCombos: [],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  // Native route-editor normalization drops unknown mod properties.
  fixture.state.previewRoute = structuredClone(globalRoute);
  fixture.state.stNodes = ['local-a', 'new-local', 'local-b'].map((id) => ({ id }));
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'new-local', action: 'add' }];
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  const observed = [];
  fixture.state.batchPreviewRouteUpdates = async () => {
    const ids = fixture.state.previewRoute.stNodes.map(({ id }) => id);
    observed.push(ids);
    if (ids.includes('remote')) throw new Error('No path found across stripped clipped-route metadata');
    fixture.state.setPreviewRoute({
      ...fixture.state.previewRoute,
      stNodes: [...fixture.state.previewRoute.stNodes, { id: 'new-local' }],
    });
  };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();

  await assert.doesNotReject(fixture.state.batchPreviewRouteUpdates());
  assert.equal(observed[0].includes('remote'), false);
  assert.equal(fixture.state.previewRoute.openWorldProjectionLocalEdit, true);
});

test('clipped-route preview guard upgrades a legacy in-memory wrapper during mod reload', () => {
  const fixture = realSeamFixture();
  const legacyBatch = async () => undefined;
  Object.defineProperty(legacyBatch, Symbol.for('open-world.clipped-route-preview-edit-guard'), { value: true });
  fixture.state.batchPreviewRouteUpdates = legacyBatch;
  fixture.state.confirmRouteChange = () => ({ success: true });
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  assert.deepEqual(adapter.installClippedRoutePreviewEditGuard(), { installed: true, reused: false });
  assert.notEqual(fixture.state.batchPreviewRouteUpdates, legacyBatch);
  assert.equal(
    fixture.state.batchPreviewRouteUpdates[Symbol.for('open-world.clipped-route-preview-edit-guard-version')],
    18,
  );
  assert.deepEqual(adapter.installClippedRoutePreviewEditGuard(), { installed: true, reused: true });
});

test('clipped-route preview guard keeps a safe local facade when native pathfinding swallows a failure', async () => {
  delete globalThis.__openWorldLastClippedRouteDiagnostic;
  delete globalThis.__openWorldClippedRouteDiagnostics;
  const fixture = realSeamFixture();
  const globalRoute = {
    id: 'statewide',
    stNodes: ['remote-a', 'local-a', 'local-b', 'remote-b'].map((id) => ({ id })),
    stCombos: [],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = ['local-a', 'new-local', 'local-b'].map((id) => ({ id }));
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'new-local', action: 'add' }];
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  // Native catches and logs generateStCombo's error instead of rejecting.
  fixture.state.batchPreviewRouteUpdates = async () => undefined;
  fixture.state.confirmRouteChange = () => { throw new Error('unsafe native confirm'); };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  await fixture.state.batchPreviewRouteUpdates();

  assert.deepEqual(fixture.state.previewRoute.stNodes.map(({ id }) => id), ['local-a', 'local-b']);
  assert.deepEqual(
    fixture.state.previewRoute.openWorldGlobalRoute.stNodes.map(({ id }) => id),
    ['remote-a', 'local-a', 'local-b', 'remote-b'],
  );
  assert.equal(fixture.state.previewRoute.openWorldProjectionLocalEdit, true);
  assert.equal(globalThis.__openWorldLastClippedRouteDiagnostic.stage, 'after-native');
  assert.equal(globalThis.__openWorldLastClippedRouteDiagnostic.applied, false);
  assert.deepEqual(
    globalThis.__openWorldClippedRouteDiagnostics.map(({ stage }) => stage),
    ['before-native', 'after-native'],
  );
  assert.deepEqual(fixture.state.confirmRouteChange(), { success: true });
});

test('clipped-route preview guard preserves a remote loop-closing station occurrence', async () => {
  const fixture = realSeamFixture();
  const globalRoute = {
    id: 'loop',
    stNodes: ['loop-start', 'local-b', 'remote', 'loop-start'].map((id) => ({ id })),
    stCombos: [],
  };
  fixture.state.routes = [{
    ...structuredClone(globalRoute),
    openWorldProjectionDormant: true,
    openWorldGlobalRoute: structuredClone(globalRoute),
  }];
  fixture.state.previewRoute = structuredClone(fixture.state.routes[0]);
  fixture.state.stNodes = ['loop-start', 'new-local', 'local-b'].map((id) => ({ id }));
  fixture.state.pendingStNodeChanges = [{ stNodeId: 'new-local', action: 'add' }];
  fixture.state.setPreviewRoute = (route) => { fixture.state.previewRoute = route; };
  fixture.state.setRoutes = (routes) => { fixture.state.routes = routes; };
  fixture.state.batchPreviewRouteUpdates = async () => {
    fixture.state.setPreviewRoute({
      ...fixture.state.previewRoute,
      stNodes: ['loop-start', 'new-local', 'local-b'].map((id) => ({ id })),
    });
  };
  fixture.state.confirmRouteChange = () => ({ success: false });
  const adapter = new SubwayBuilderGameAdapter(fixture);

  adapter.installClippedRoutePreviewEditGuard();
  await fixture.state.batchPreviewRouteUpdates();

  assert.deepEqual(
    fixture.state.previewRoute.openWorldGlobalRoute.stNodes.map(({ id }) => id),
    ['loop-start', 'new-local', 'local-b', 'remote', 'loop-start'],
  );
});

test('snapshot restore guards transient preview-layer ordering before loadSave mutates the style', async () => {
  const fixture = realSeamFixture();
  const layers = new Set(['preview-track-speeds-under']);
  const rawMoves = [];
  const map = {
    getLayer: (id) => layers.has(id) ? { id } : undefined,
    moveLayer(layerId, beforeId) {
      rawMoves.push([layerId, beforeId]);
      if (beforeId != null && !layers.has(beforeId)) {
        throw new Error(`Cannot move layer "${layerId}" before non-existing layer "${beforeId}".`);
      }
      return this;
    },
  };
  fixture.api.utils.getMap = () => map;
  fixture.state.loadSave = (value) => {
    map.moveLayer('preview-track-speeds-under', 'preview-track-elevations');
    fixture.state.cityCode = value.cityCode;
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  await assert.doesNotReject(adapter.restoreSnapshot({
    cityCode: 'KCW', data: { routes: [], tracks: [], stations: [], trains: [] },
  }));
  assert.deepEqual(rawMoves, []);
});

test('verifyLoaded tolerates the public city code settling just after onCityLoad', async () => {
  const fixture = realSeamFixture({ publicCityCode: 'NY_CP00_RP00' });
  let cityReads = 0;
  fixture.api.utils.getCityCode = () => (++cityReads < 2 ? 'NY_CP00_RP00' : 'NY_CP01_RP00');
  const adapter = new SubwayBuilderGameAdapter(fixture);
  await adapter.adoptStaticPackage({
    manifest: { tileId: 'NY_CP01_RP00', cityCode: 'NY_CP01_RP00', dataFiles: {} },
  }, 'NY_CP01_RP00');
  await adapter.pause();

  await assert.doesNotReject(adapter.verifyLoaded());
  assert.ok(cityReads >= 2);
});

test('verifyLoaded tolerates the native self-pause settling after the city is already loaded', async () => {
  const fixture = realSeamFixture({ publicCityCode: 'NY_CP00_RP00' });
  const adapter = new SubwayBuilderGameAdapter(fixture);
  await adapter.adoptStaticPackage({
    manifest: { tileId: 'NY_CP00_RP00', cityCode: 'NY_CP00_RP00', dataFiles: {} },
  }, 'NY_CP00_RP00');
  fixture.state.timeConfig.paused = false;
  setTimeout(() => { fixture.state.timeConfig.paused = true; }, 5);

  await assert.doesNotReject(adapter.verifyLoaded());
  assert.equal(fixture.state.timeConfig.paused, true);
});

test('verifyLoaded reclaims the transition pause after an early user unpause', async () => {
  const fixture = realSeamFixture({ publicCityCode: 'NY_CP00_RP00' });
  const adapter = new SubwayBuilderGameAdapter(fixture);
  await adapter.adoptStaticPackage({
    manifest: { tileId: 'NY_CP00_RP00', cityCode: 'NY_CP00_RP00', dataFiles: {} },
  }, 'NY_CP00_RP00');
  await adapter.pause();
  fixture.state.timeConfig.paused = false; // User clicks play before startup commits.

  await assert.doesNotReject(adapter.verifyLoaded());
  assert.equal(fixture.state.timeConfig.paused, true);
  assert.deepEqual(fixture.calls.at(-1), ['time', { paused: true }]);
});

test('verifyLoaded keeps reclaiming pause from late load writes until it is stable', async () => {
  const fixture = realSeamFixture({ publicCityCode: 'NY_CP00_RP00' });
  let pauseRequests = 0;
  fixture.state.setTimeConfig = (patch) => {
    fixture.calls.push(['time', patch]);
    fixture.state.timeConfig = { ...fixture.state.timeConfig, ...patch };
    if (patch.paused === true && pauseRequests++ < 2) fixture.state.timeConfig.paused = false;
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);
  await adapter.adoptStaticPackage({
    manifest: { tileId: 'NY_CP00_RP00', cityCode: 'NY_CP00_RP00', dataFiles: {} },
  }, 'NY_CP00_RP00');
  await adapter.pause();

  await assert.doesNotReject(adapter.verifyLoaded());
  assert.equal(fixture.state.timeConfig.paused, true);
  assert.ok(pauseRequests >= 3);
});

test('destination restore rebinds a source-derived checkpoint without dropping its routes', async () => {
  const fixture = realSeamFixture({ publicCityCode: 'NY_CP00_RP00' });
  fixture.api.utils.getCityCode = () => fixture.state.cityCode;
  const adapter = new SubwayBuilderGameAdapter(fixture);
  await adapter.adoptStaticPackage({
    manifest: { tileId: 'NY_CP01_RP00', cityCode: 'NY_CP01_RP00', dataFiles: {} },
  }, 'NY_CP01_RP00');
  await adapter.pause();
  const sourceDerivedCheckpoint = {
    cityCode: 'NY_CP00_RP00',
    data: {
      routes: [{ id: 'empire-line', timetableSchedule: { periods: [{ headwaySeconds: 600 }] } }],
      tracks: [{ id: 'empire-track' }], stations: [], trains: [],
    },
  };

  await adapter.restoreSnapshot(sourceDerivedCheckpoint);
  await assert.doesNotReject(adapter.verifyLoaded());

  const loaded = fixture.calls.find(([name]) => name === 'load')?.[1];
  assert.equal(loaded.cityCode, 'NY_CP01_RP00');
  assert.deepEqual(loaded.data.routes, sourceDerivedCheckpoint.data.routes);
  assert.equal(fixture.state.cityCode, 'NY_CP01_RP00');
});

test('production adapter merges only shared transit slices into the destination save', () => {
  const adapter = new SubwayBuilderGameAdapter(realSeamFixture());
  const destination = {
    cityCode: 'KCE', metadata: { custom: 'east' },
    data: { routes: [], tracks: [], stations: [], trains: [], tileMarker: 'east' },
  };
  const source = {
    cityCode: 'KCW',
    data: {
      routes: [{ id: 'route' }], tracks: [{ id: 'track' }], stations: [{ id: 'station' }],
      trains: [{ id: 'train', routeId: 'route' }], signals: [{ id: 'signal' }], tileMarker: 'west',
    },
  };

  const merged = adapter.mergeSharedTransitNetwork(destination, source);

  assert.equal(merged.cityCode, 'KCE');
  assert.equal(merged.data.tileMarker, 'east');
  assert.deepEqual(merged.data.tracks, source.data.tracks);
  assert.deepEqual(merged.data.routes, source.data.routes);
  assert.deepEqual(merged.data.trains, source.data.trains);
  assert.deepEqual(merged.data.stations, source.data.stations);
  assert.deepEqual(merged.data.signals, source.data.signals);
  assert.deepEqual(merged.metadata, { custom: 'east', stations: 1, routes: 1, trains: 1 });
});

test('production adapter records cross-tile fares through native profit accounting', async () => {
  const fixture = realSeamFixture(); const adapter = new SubwayBuilderGameAdapter(fixture);

  const result = await adapter.creditCrossTileFareRevenue(12);

  assert.equal(fixture.state.money, 62);
  assert.equal(fixture.state.financialHistory.currentHourRevenue, 12);
  assert.deepEqual(result, { wallet: 62, financialHistory: fixture.state.financialHistory });
  assert.deepEqual(fixture.calls.at(-1), ['revenue', 12, true]);
});

test('production adapter posts inactive native estimates through native accounting once', async () => {
  const fixture = realSeamFixture(); const adapter = new SubwayBuilderGameAdapter(fixture);
  const posting = {
    postingId: 'world:background-native:1-1',
    targetElapsedSeconds: 3_600,
    revenue: 12,
    expenseCategories: { trainOperational: 7, trackMaintenance: 2 },
    revenueByRoute: { 'route-a': 12 },
    expensesByRoute: { 'route-a': 7 },
  };

  const first = await adapter.postBackgroundNativeFinance(posting);
  const second = await adapter.postBackgroundNativeFinance(posting);

  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(fixture.state.money, 53);
  assert.equal(fixture.state.financialHistory.currentHourRevenue, 12);
  assert.equal(fixture.state.financialHistory.currentHourExpenses, 9);
  assert.deepEqual(fixture.state.routeFinancials.currentHour['route-a'], { revenue: 12, expenses: 7 });
  assert.equal(fixture.calls.filter(([name]) => name === 'set-route-financials').length, 1);
  assert.deepEqual(fixture.state.financialHistory.openWorldBackgroundFinanceReceipts, [posting.postingId]);
});

test('production adapter refuses capital expenses in recurring background postings', async () => {
  const fixture = realSeamFixture(); const adapter = new SubwayBuilderGameAdapter(fixture);

  await assert.rejects(
    adapter.postBackgroundNativeFinance({
      postingId: 'world:invalid-capital-posting',
      targetElapsedSeconds: 3_600,
      revenue: 0,
      expenseCategories: { trainPurchase: 40 },
    }),
    /cannot post capital expense category: trainPurchase/,
  );

  assert.equal(fixture.state.money, 50);
  assert.equal(fixture.state.financialHistory.currentHourExpenses, 0);
});

test('production adapter backfills a range posting into hourly dashboard and route buckets', async () => {
  const fixture = realSeamFixture();
  fixture.state.timeConfig.elapsedSeconds = 3 * 3_600;
  const adapter = new SubwayBuilderGameAdapter(fixture);
  const hourlyPostings = [1, 2, 3].map((hour) => ({
    hour,
    revenue: 12,
    expenses: 9,
    expenseCategories: { trainOperational: 7, trackMaintenance: 2 },
    revenueByRoute: { 'route-a': 12 },
    expensesByRoute: { 'route-a': 7 },
  }));

  await adapter.postBackgroundNativeFinance({
    postingId: 'world:background-native:1-3',
    targetElapsedSeconds: 3 * 3_600,
    hourlyPostings,
    revenue: 36,
    expenseCategories: { trainOperational: 21, trackMaintenance: 6 },
    revenueByRoute: { 'route-a': 36 },
    expensesByRoute: { 'route-a': 21 },
  });

  assert.equal(fixture.state.money, 59);
  assert.deepEqual(fixture.state.financialHistory.entries.map((entry) => ({
    timestamp: entry.timestamp,
    revenue: entry.hourlyRevenue,
    expenses: entry.hourlyExpenses,
  })), [
    { timestamp: 0, revenue: 0, expenses: 0 },
    { timestamp: 3_600, revenue: 12, expenses: 9 },
    { timestamp: 7_200, revenue: 12, expenses: 9 },
  ]);
  assert.equal(fixture.state.financialHistory.currentHourRevenue, 12);
  assert.equal(fixture.state.financialHistory.currentHourExpenses, 9);
  assert.deepEqual(fixture.state.routeFinancials.byRoute['route-a'], [
    { timestamp: 3_600, revenue: 12, expenses: 7 },
    { timestamp: 7_200, revenue: 12, expenses: 7 },
  ]);
  assert.deepEqual(fixture.state.routeFinancials.currentHour['route-a'], { revenue: 12, expenses: 7 });
});

test('production adapter attributes cross-tile revenue and riders to native routes', async () => {
  const fixture = realSeamFixture(); const adapter = new SubwayBuilderGameAdapter(fixture);
  fixture.state.routes = [{ id: 'route-a', tempParentId: null }];
  const completedCommute = {
    popId: 'cross-pop:morning:7', size: 4,
    stationRoutes: [{ routeId: 'route-a', stationIds: ['station-a', 'station-b'] }],
    journeyStart: 7 * 3_600, journeyEnd: 7 * 3_600 + 900, origin: 'home',
  };

  await adapter.creditCrossTileFareRevenue(12, {
    revenueByRoute: { 'route-a': 12 }, completedCommutes: [completedCommute],
  });

  assert.deepEqual(fixture.calls.find(([name]) => name === 'route-financials'), [
    'route-financials', { 'route-a': 12 }, {},
  ]);
  assert.deepEqual(fixture.state.completedCommutes, [completedCommute]);
});

test('production adapter treats native completed commute IDs as idempotent fare receipts', async () => {
  const fixture = realSeamFixture(); const adapter = new SubwayBuilderGameAdapter(fixture);
  fixture.state.routes = [{ id: 'route-a', tempParentId: null }];
  const completedCommute = {
    popId: 'cross-pop:morning:7', size: 4, fareRevenue: 12,
    revenueByRoute: { 'route-a': 12 },
    stationRoutes: [{ routeId: 'route-a', stationIds: ['station-a', 'station-b'] }],
    journeyStart: 7 * 3_600, journeyEnd: 7 * 3_600 + 900, origin: 'home',
  };
  const attribution = { revenueByRoute: { 'route-a': 12 }, completedCommutes: [completedCommute] };

  await adapter.creditCrossTileFareRevenue(12, attribution);
  await adapter.creditCrossTileFareRevenue(12, attribution);

  assert.equal(fixture.state.money, 62);
  assert.equal(fixture.state.financialHistory.currentHourRevenue, 12);
  assert.equal(fixture.calls.filter(([name]) => name === 'revenue').length, 1);
  assert.equal(fixture.calls.filter(([name]) => name === 'route-financials').length, 1);
  assert.equal(fixture.state.completedCommutes.length, 1);
});

test('production adapter restores populated native demand if a compact save load clears it', async () => {
  const fixture = realSeamFixture();
  const loadedDemand = {
    points: new Map([['home', { id: 'home' }], ['work', { id: 'work' }]]),
    popsMap: new Map([['local-pop', { id: 'local-pop', residenceId: 'home', jobId: 'work', size: 12 }]]),
  };
  fixture.state.demandData = loadedDemand;
  fixture.state.loadSave = (value) => {
    fixture.calls.push(['load', value]);
    fixture.state.demandData = { points: new Map(), popsMap: new Map() };
  };
  fixture.state.setDemandData = (value) => {
    fixture.calls.push(['demand', value]);
    fixture.state.demandData = value;
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  await adapter.restoreSnapshot({ cityCode: 'KCW', data: { routes: [], tracks: [], stations: [], trains: [] } });

  assert.equal(fixture.state.demandData.popsMap.size, 1);
  assert.equal(fixture.calls.filter(([name]) => name === 'demand').length, 1);
});

test('native commute health distinguishes missing paths from rejected transit mode choice', () => {
  const fixture = realSeamFixture();
  fixture.state.demandData = {
    points: new Map([
      ['home-a', { id: 'home-a' }], ['work-a', { id: 'work-a' }],
      ['home-b', { id: 'home-b' }], ['work-b', { id: 'work-b' }],
    ]),
    popsMap: new Map([
      ['no-path', {
        id: 'no-path', residenceId: 'home-a', jobId: 'work-a', size: 4, drivingSeconds: 600,
        lastCommute: { transitPaths: [], walking: { time: 3_000 }, modeChoice: { driving: 4, walking: 0, transit: 0, unknown: 0 } },
      }],
      ['rejected-path', {
        id: 'rejected-path', residenceId: 'home-b', jobId: 'work-b', size: 6, drivingSeconds: 300,
        lastCommute: { transitPaths: [{ fareCost: 2, segments: [] }], walking: { time: 4_000 }, modeChoice: { driving: 6, walking: 0, transit: 0, unknown: 0 } },
      }],
    ]),
  };
  fixture.state.stations = [];
  fixture.state.routes = [];
  fixture.state.trains = [];
  const health = new SubwayBuilderGameAdapter(fixture).nativeCommuteHealth();

  assert.equal(health.popsWithTransitPaths, 1);
  assert.equal(health.populationWithTransitPaths, 6);
  assert.equal(health.totalTransitPaths, 1);
  assert.deepEqual(health.modeChoicePopulation, { driving: 10, walking: 0, transit: 0, unknown: 0 });
  assert.equal(health.samples.withTransitPath[0].id, 'rejected-path');
  assert.equal(health.samples.withoutTransitPath[0].id, 'no-path');
});

test('production adapter recalculates stale zero-network commutes after a network restore', async () => {
  const fixture = realSeamFixture();
  const pop = {
    id: 'stale-pop', residenceId: 'home', jobId: 'work', size: 12,
    lastCommute: { transitPaths: [], modeChoice: { driving: 12, walking: 0, transit: 0, unknown: 0 } },
  };
  fixture.state.demandData = {
    points: new Map([['home', { id: 'home' }], ['work', { id: 'work' }]]),
    popsMap: new Map([[pop.id, pop]]),
  };
  fixture.state.stations = [{ id: 'station', buildType: 'constructed' }];
  fixture.state.routes = [{ id: 'route' }];
  fixture.state.trains = [{ id: 'train', routeId: 'route' }];
  fixture.state.simulateCommutes = async ({ popCommutes, startMovements }) => {
    fixture.calls.push(['commutes', popCommutes, startMovements]);
    pop.lastCommute = { transitPaths: [{ segments: [] }], modeChoice: { driving: 6, walking: 0, transit: 6, unknown: 0 } };
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  const result = await adapter.refreshNativeCommutes();

  assert.equal(result.status, 'recalculated');
  assert.deepEqual(fixture.calls.at(-1), ['commutes', [{ popId: 'stale-pop', direction: 'homeToWork' }], false]);
  assert.equal(adapter.nativeCommuteHealth().transitPopulation, 6);
});

test('hydrated clipped service invalidates cached native no-path results without visible trains', async () => {
  const fixture = realSeamFixture();
  const noPathPop = {
    id: 'clipped-no-path', residenceId: 'home', jobId: 'work', size: 12,
    lastCommute: { transitPaths: [], modeChoice: { driving: 12, walking: 0, transit: 0, unknown: 0 } },
  };
  const existingPathPop = {
    id: 'existing-path', residenceId: 'home', jobId: 'work', size: 8,
    lastCommute: { transitPaths: [{ segments: [] }], modeChoice: { driving: 4, walking: 0, transit: 4, unknown: 0 } },
  };
  fixture.state.demandData = {
    points: new Map([['home', { id: 'home' }], ['work', { id: 'work' }]]),
    popsMap: new Map([[noPathPop.id, noPathPop], [existingPathPop.id, existingPathPop]]),
  };
  fixture.state.stations = [{ id: 'local-station', stNodeIds: ['local-node'], buildType: 'constructed' }];
  fixture.state.routes = [{
    id: 'clipped-route',
    openWorldProjectionDormant: true,
    stNodes: [{ id: 'local-node' }],
  }];
  fixture.state.trains = [];
  fixture.state.simulateCommutes = async ({ popCommutes }) => {
    fixture.calls.push(['commutes', popCommutes]);
    noPathPop.lastCommute = {
      transitPaths: [{ segments: [] }],
      modeChoice: { driving: 6, walking: 0, transit: 6, unknown: 0 },
    };
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);
  adapter.hydrateClippedRouteCommuteData({
    routes: [{ id: 'clipped-route', stationIds: ['local-station', 'remote-station'], stNodes: [{ id: 'local-node' }, { id: 'remote-node' }] }],
    trains: [{ id: 'deferred-train', routeId: 'clipped-route', stComboTimings: [{ index: 0 }, { index: 1 }] }],
    stations: [
      { id: 'local-station', stNodeIds: ['local-node'], buildType: 'constructed' },
      { id: 'remote-station', stNodeIds: ['remote-node'], buildType: 'constructed' },
    ],
  });

  const result = await adapter.refreshNativeCommutes();

  assert.equal(result.status, 'recalculated');
  assert.equal(result.reason, 'clipped-route-hydration');
  assert.equal(fixture.calls.filter(([name]) => name === 'commutes').length, 1);
  assert.equal(adapter.nativeCommuteHealth().popsWithTransitPaths, 2);
  assert.equal(adapter.clippedRouteCommuteRefreshPending, false);
});

test('native commute refresh does not overwrite the journey used by an active movement', async () => {
  const fixture = realSeamFixture();
  const activePop = {
    id: 'active-pop', residenceId: 'home', jobId: 'work', size: 12,
    lastCommute: {
      transitPaths: [{ segments: [{ departureTime: 100, arrivalTime: 200, routeId: 'route' }] }],
      modeChoice: { driving: 0, walking: 0, transit: 12, unknown: 0 },
    },
  };
  const idlePop = {
    id: 'idle-pop', residenceId: 'home', jobId: 'work', size: 8,
    lastCommute: { transitPaths: [], modeChoice: { driving: 8, walking: 0, transit: 0, unknown: 0 } },
  };
  fixture.state.demandData = {
    points: new Map([['home', { id: 'home' }], ['work', { id: 'work' }]]),
    popsMap: new Map([[activePop.id, activePop], [idlePop.id, idlePop]]),
  };
  fixture.state.popMovementsMap = new Map([[activePop.id, { journeyIndex: 0 }]]);
  fixture.state.stations = [{ id: 'station', buildType: 'constructed' }];
  fixture.state.routes = [{ id: 'route' }];
  fixture.state.trains = [{ id: 'train', routeId: 'route' }];
  fixture.state.simulateCommutes = async ({ popCommutes }) => {
    fixture.calls.push(['commutes', popCommutes]);
    for (const { popId } of popCommutes) {
      fixture.state.demandData.popsMap.get(popId).lastCommute = {
        transitPaths: [],
        modeChoice: { driving: 8, walking: 0, transit: 0, unknown: 0 },
      };
    }
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);
  adapter.clippedRouteCommuteRefreshPending = true;

  await adapter.refreshNativeCommutes();

  assert.deepEqual(fixture.calls.at(-1), ['commutes', [{ popId: 'idle-pop', direction: 'homeToWork' }]]);
  assert.doesNotThrow(() => activePop.lastCommute.transitPaths[0].segments);
});

test('native commute refresh recovers an autosaved movement whose journey was overwritten', async () => {
  const fixture = realSeamFixture();
  const pop = {
    id: 'corrupt-active-pop', residenceId: 'home', jobId: 'work', size: 12,
    lastCommute: { transitPaths: [], modeChoice: { driving: 12, walking: 0, transit: 0, unknown: 0 } },
  };
  fixture.state.demandData = {
    points: new Map([['home', { id: 'home' }], ['work', { id: 'work' }]]),
    popsMap: new Map([[pop.id, pop]]),
  };
  fixture.state.popMovementsMap = new Map([[pop.id, { journeyIndex: 1 }]]);
  fixture.state.allStationTrainPopMovements = { stations: new Map([['station', {}]]), trains: new Map() };
  fixture.state.popMovementGeojson = { type: 'FeatureCollection', features: [{ id: 'stale' }] };
  fixture.state.stations = [{ id: 'station', buildType: 'constructed' }];
  fixture.state.routes = [{ id: 'route' }];
  fixture.state.trains = [{ id: 'train', routeId: 'route' }];
  fixture.state.simulateCommutes = async ({ popCommutes }) => fixture.calls.push(['commutes', popCommutes]);
  const adapter = new SubwayBuilderGameAdapter(fixture);
  adapter.clippedRouteCommuteRefreshPending = true;

  const result = await adapter.refreshNativeCommutes();

  assert.equal(result.droppedInvalidMovements, 1);
  assert.equal(fixture.state.popMovementsMap.size, 0);
  assert.equal(fixture.state.allStationTrainPopMovements.stations.size, 0);
  assert.deepEqual(fixture.state.popMovementGeojson.features, []);
  assert.deepEqual(fixture.calls.at(-1), ['commutes', [{ popId: pop.id, direction: 'homeToWork' }]]);
});

test('production adapter lowers the native transit floor for one-person LODES cohorts', async () => {
  const fixture = realSeamFixture();
  const rules = { MIN_TRANSIT_CHOICE: 10 };
  fixture.api.utils.getPathfindingRules = () => rules;
  fixture.api.modifyPathfindingRules = (patch) => {
    fixture.calls.push(['rules', patch]);
    Object.assign(rules, patch);
  };
  const pop = {
    id: 'lodes-one', residenceId: 'home', jobId: 'work', size: 1,
    lastCommute: { transitPaths: [{ segments: [] }], modeChoice: { driving: 1, walking: 0, transit: 0, unknown: 0 } },
  };
  fixture.state.demandData = {
    points: new Map([['home', { id: 'home' }], ['work', { id: 'work' }]]),
    popsMap: new Map([[pop.id, pop]]),
  };
  fixture.state.stations = [{ id: 'station', buildType: 'constructed' }];
  fixture.state.routes = [{ id: 'route' }];
  fixture.state.trains = [{ id: 'train', routeId: 'route' }];
  fixture.state.simulateCommutes = async () => {
    pop.lastCommute.modeChoice = rules.MIN_TRANSIT_CHOICE <= 1
      ? { driving: 0, walking: 0, transit: 1, unknown: 0 }
      : { driving: 1, walking: 0, transit: 0, unknown: 0 };
  };
  const adapter = new SubwayBuilderGameAdapter(fixture);

  const result = await adapter.refreshNativeCommutes();

  assert.equal(result.status, 'recalculated');
  assert.deepEqual(fixture.calls.find(([name]) => name === 'rules'), ['rules', { MIN_TRANSIT_CHOICE: 1 }]);
  assert.equal(adapter.nativeCommuteHealth().transitPopulation, 1);
});

test('production adapter restores the native transit floor for aggregated cohorts', async () => {
  const fixture = realSeamFixture();
  const rules = { MIN_TRANSIT_CHOICE: 1 };
  fixture.api.utils.getPathfindingRules = () => rules;
  fixture.api.modifyPathfindingRules = (patch) => Object.assign(rules, patch);
  fixture.state.demandData = {
    points: new Map([['home', { id: 'home' }], ['work', { id: 'work' }]]),
    popsMap: new Map([['aggregated', {
      id: 'aggregated', residenceId: 'home', jobId: 'work', size: 50,
      lastCommute: { transitPaths: [{ segments: [] }], modeChoice: { driving: 40, walking: 0, transit: 10, unknown: 0 } },
    }]]),
  };
  fixture.state.stations = [{ id: 'station' }];
  fixture.state.routes = [{ id: 'route' }];
  fixture.state.trains = [{ id: 'train' }];
  fixture.state.simulateCommutes = async () => {};

  await new SubwayBuilderGameAdapter(fixture).refreshNativeCommutes();

  assert.equal(rules.MIN_TRANSIT_CHOICE, 10);
});

test('production adapter captures the current native balance for a world handoff', async () => {
  const fixture = realSeamFixture();
  fixture.state.money = 37;
  const adapter = new SubwayBuilderGameAdapter(fixture);

  assert.deepEqual(await adapter.captureAuthoritativeGlobals(), {
    wallet: 37,
    elapsedSeconds: 0,
    farePolicy: { fare: 4, fareGroups: [] },
    financialHistory: fixture.state.financialHistory,
  });
});

test('production adapter re-reads immutable store state after an in-game mod reload', async () => {
  let liveState;
  const setTimeConfig = (patch) => {
    liveState = { ...liveState, timeConfig: { ...liveState.timeConfig, ...patch } };
  };
  liveState = {
    cityCode: 'KCW', money: 1_000_000, timeConfig: { elapsedSeconds: 0, paused: false },
    routes: [], tracks: [], stations: [], trains: [], trackGroups: [], signals: [], stNodes: [],
    generateSave: () => ({ data: { routes: [], tracks: [], stations: [], trains: [] } }),
    loadSave: () => {}, loadInitialData: () => {}, setTimeConfig,
  };
  const adapter = new SubwayBuilderGameAdapter({
    api: {
      version: '1.0.0',
      cities: { setCityDataFiles() {} },
      utils: { getCityCode: () => liveState.cityCode },
    },
    callbacks: {
      getState: () => liveState,
      setMoney: (money) => { liveState = { ...liveState, money }; },
      setTicketCost() {},
    },
  });
  adapter.probe();
  // Zustand replaces its state object as gameplay continues after the probe.
  liveState = { ...liveState, money: 37 };

  await adapter.adoptStaticPackage({ manifest: { tileId: 'KCW', cityCode: 'KCW' } }, 'KCW');
  await adapter.pause();

  await assert.doesNotReject(adapter.verifyLoaded());
  assert.deepEqual(await adapter.captureAuthoritativeGlobals(), { wallet: 37, elapsedSeconds: 0 });
});

test('compacts native snapshots by removing reloadable demand and image payloads', () => {
  const snapshot = {
    routeThumbnail: 'data:image/png;base64,large',
    timelapse: { frames: [{ image: 'large' }], nextCaptureDay: 2 },
    data: {
      routes: [], tracks: [], stations: [], trains: [],
      compressedDemandData: { huge: true }, savedDemandData: { huge: true },
      popMovementsMap: [1], completedCommutes: [2],
    },
  };

  const compact = compactNativeSnapshot(snapshot);

  assert.equal(compact.routeThumbnail, undefined);
  assert.deepEqual(compact.timelapse.frames, []);
  assert.equal('compressedDemandData' in compact.data, false);
  assert.equal('savedDemandData' in compact.data, false);
  assert.deepEqual(compact.data.routes, []);
});

test('production adapter uses a lean template checkpoint without running native demand compression', async () => {
  const fixture = realSeamFixture();
  fixture.state.tracks = [{ id: 'new-track' }];
  fixture.state.trains = [];
  fixture.state.routes = [];
  fixture.state.stations = [];
  fixture.state.trackGroups = [];
  fixture.state.signals = [];
  fixture.state.stNodes = [];
  fixture.state.money = 42;
  fixture.state.cityCode = 'KCW';
  fixture.state.generateSave = () => { throw new Error('generateSave entered the switch path'); };
  const adapter = new SubwayBuilderGameAdapter(fixture);
  const template = {
    id: 'old', name: 'old', version: 7, cityCode: 'KCW',
    data: { routes: [], tracks: [], stations: [], trains: [], compressedDemandData: { huge: true } },
  };

  const snapshot = await adapter.captureSnapshot(template);

  assert.deepEqual(snapshot.data.tracks, [{ id: 'new-track' }]);
  assert.equal(snapshot.data.money, 42);
  assert.equal('compressedDemandData' in snapshot.data, false);
});

test('production adapter refuses mutation when a required state action is missing', async () => {
  const fixture = realSeamFixture({ omit: ['loadInitialData'] }); const adapter = new SubwayBuilderGameAdapter(fixture);
  assert.equal(adapter.probe().supported, false); assert.ok(adapter.probe().missing.includes('loadInitialData'));
  await assert.rejects(adapter.pause(), /refused mutation/);
});

test('production adapter verifies the loaded city through the public city-code API', async () => {
  const fixture = realSeamFixture({ publicCityCode: 'KCE' });
  const adapter = new SubwayBuilderGameAdapter(fixture);
  await adapter.adoptStaticPackage({ manifest: { tileId: 'KCW', cityCode: 'KCW' } }, 'KCW');
  await adapter.pause();
  await assert.rejects(adapter.verifyLoaded(), /Loaded city mismatch: expected KCW, got KCE/);
});

test('HTTP package adapter preserves game data paths while validating assets against the artifact host', async () => {
  const requests = [];
  const manifest = { schemaVersion: 1, tileId: 'KCW', cityCode: 'KCW', dataFiles: { demandData: 'demand_data.json.gz' }, assets: [{ path: 'demand_data.json.gz', bytes: 3, sha256: 'fixture' }] };
  const fetchImpl = async (url) => {
    requests.push(url);
    return url.endsWith('manifest.json')
      ? { ok: true, json: async () => structuredClone(manifest) }
      : { ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
  };
  const adapter = new HttpTilePackageAdapter({ baseUrl: 'http://127.0.0.1:8787/', fetchImpl, verify: async (asset, bytes) => asset.bytes === bytes.length });
  const pkg = await adapter.prepare('KCW');
  assert.equal(pkg.manifest.dataFiles.demandData, 'demand_data.json.gz');
  assert.deepEqual(requests, ['http://127.0.0.1:8787/KCW/manifest.json', 'http://127.0.0.1:8787/KCW/demand_data.json.gz']);
});

test('HTTP package adapter calls a browser-style fetch with the global receiver', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function browserFetch(url) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve({
      ok: true,
      json: async () => ({ schemaVersion: 1, tileId: 'KCW', dataFiles: {}, assets: [] }),
    });
  };
  try {
    const adapter = new HttpTilePackageAdapter({ baseUrl: 'http://127.0.0.1:8787', assetValidation: 'manifest' });
    await assert.doesNotReject(adapter.prepare('KCW'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('live HTTP package preparation validates and caches metadata without downloading asset bodies', async () => {
  const requests = [];
  const manifest = { schemaVersion: 1, tileId: 'KCE', cityCode: 'KCE', dataFiles: { demandData: 'demand_data.json.gz' }, assets: [{ path: 'demand_data.json.gz', bytes: 9, sha256: 'fixture' }] };
  const adapter = new HttpTilePackageAdapter({
    baseUrl: 'http://127.0.0.1:8787',
    assetValidation: 'manifest',
    fetchImpl: async (url) => {
      requests.push(url);
      if (!url.endsWith('manifest.json')) throw new Error('asset body entered the live preparation path');
      return { ok: true, json: async () => structuredClone(manifest) };
    },
  });

  const first = await adapter.prepare('KCE');
  const second = await adapter.prepare('KCE');

  assert.equal(first, second);
  assert.deepEqual(requests, ['http://127.0.0.1:8787/KCE/manifest.json']);
  assert.deepEqual(first.assets, [{ path: 'demand_data.json.gz', bytes: 9, sha256: 'fixture', verified: false }]);
});

test('HTTP package adapter loads only the compact commute runtime files', async () => {
  const requests = [];
  const summary = { schemaVersion: 1, tileId: 'KCW', buckets: [{ id: 'flow-1', homeTileId: 'KCW', workTileId: 'KCE', gatewayId: 'central', mass: 12, defaultTravelSeconds: 1800, defaultCapacityPerHour: 1000 }] };
  const gates = [{ id: 'central', x: 1, y: 2 }];
  const manifest = {
    schemaVersion: 1, tileId: 'KCW', cityCode: 'KCW', dataFiles: {},
    runtimeFiles: {
      schemaVersion: 1,
      crossCommutes: { path: 'cross_commutes.json', bytes: 1, sha256: 'cross' },
      gates: { path: 'gates.bin', bytes: 1, sha256: 'gates' },
    },
    assets: [{ path: 'cross_commutes.json' }, { path: 'gates.bin' }, { path: 'trips.bin' }],
  };
  const encoded = (value) => new TextEncoder().encode(JSON.stringify(value)).buffer;
  const adapter = new HttpTilePackageAdapter({
    baseUrl: 'http://127.0.0.1:8787', assetValidation: 'manifest',
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.endsWith('manifest.json')) return { ok: true, json: async () => structuredClone(manifest) };
      if (url.endsWith('cross_commutes.json')) return { ok: true, arrayBuffer: async () => encoded(summary) };
      if (url.endsWith('gates.bin')) return { ok: true, arrayBuffer: async () => encoded(gates) };
      throw new Error(`Unexpected large asset request: ${url}`);
    },
  });

  const catalog = await adapter.loadCommuteCatalog('KCW');
  assert.equal(catalog.buckets[0].mass, 12);
  assert.deepEqual(catalog.gateways, gates);
  assert.deepEqual(requests, [
    'http://127.0.0.1:8787/KCW/manifest.json',
    'http://127.0.0.1:8787/KCW/cross_commutes.json',
    'http://127.0.0.1:8787/KCW/gates.bin',
  ]);
});

test('HTTP package adapter lazily inflates the cross-demand viewer payload', async () => {
  const viewer = { schemaVersion: 1, tileId: 'KCW', gateways: [], points: [], pops: [] };
  const compressed = gzipSync(JSON.stringify(viewer));
  const manifest = {
    schemaVersion: 1, tileId: 'KCW', cityCode: 'KCW', dataFiles: {},
    runtimeFiles: { schemaVersion: 1, crossDemand: { path: 'cross_demand.json.gz', encoding: 'gzip-json' } },
    assets: [{ path: 'cross_demand.json.gz' }],
  };
  const adapter = new HttpTilePackageAdapter({
    baseUrl: 'http://127.0.0.1:8787', assetValidation: 'manifest',
    fetchImpl: async (url) => url.endsWith('manifest.json')
      ? { ok: true, json: async () => structuredClone(manifest) }
      : { ok: true, arrayBuffer: async () => compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) },
  });
  assert.deepEqual(await adapter.loadCrossDemand('KCW'), viewer);
});

test('HTTP tile packages register game data through the native /data city route', async () => {
  const fixture = realSeamFixture();
  const manifest = {
    schemaVersion: 1,
    tileId: 'KCW',
    cityCode: 'KCW',
    dataFiles: { buildingsIndex: 'buildings_index.bin.gz', demandData: 'demand_data.json.gz' },
    assets: [
      { path: 'buildings_index.bin.gz', bytes: 1, sha256: 'fixture-buildings' },
      { path: 'demand_data.json.gz', bytes: 1, sha256: 'fixture-demand' },
    ],
  };
  const packages = new HttpTilePackageAdapter({
    baseUrl: 'http://127.0.0.1:8787/',
    assetValidation: 'manifest',
    fetchImpl: async () => ({ ok: true, json: async () => structuredClone(manifest) }),
  });
  const game = new SubwayBuilderGameAdapter(fixture);

  await game.loadStaticPackage(await packages.prepare('KCW'));

  const registered = fixture.calls.find(([name]) => name === 'files')[2];
  assert.deepEqual(registered, {
    buildingsIndex: '/data/KCW/buildings_index.bin.gz',
    demandData: '/data/KCW/demand_data.json.gz',
  });
  assert.doesNotThrow(() => new URL(`http://127.0.0.1:58290${registered.buildingsIndex}?useDownloaded=true`));
});
