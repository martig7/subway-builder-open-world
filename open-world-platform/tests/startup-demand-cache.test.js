import assert from 'node:assert/strict';
import test from 'node:test';
import { WorldTileRuntime } from '../src/runtime/world-tile-runtime.js';
import { FakeGameAdapter } from '../src/runtime/adapters/fake-game-adapter.js';
import { MemoryTilePackageAdapter } from '../src/runtime/adapters/memory-tile-package-adapter.js';
import { ModStorageWorldStateAdapter } from '../src/runtime/adapters/mod-storage-world-state-adapter.js';
import { NativeRevenueAccrual } from '../src/runtime/native-revenue-accrual.js';
import { calculateCrossTileModeShares, inspectCrossTileModeChoice } from '../src/runtime/cross-tile-mode-choice.js';
import { createDerivedDemandCache, derivedDemandContextKey } from '../src/runtime/derived-demand-cache.js';

async function fixture({ diskCodec = false } = {}) {
  const records = new Map();
  const store = { read: async key => structuredClone(records.get(key) ?? null),
    write: async (key, value) => { records.set(key, structuredClone(value)); } };
  const cache = diskCodec ? createDerivedDemandCache({ store }) : store;
  const worldState = new ModStorageWorldStateAdapter({ financeMode: 'blind' });
  const demand = { points: [
    { id: 'home', location: [-71.08, 42.35], residents: 100, jobs: 0 },
    { id: 'work', location: [-71.02, 42.35], residents: 0, jobs: 100 },
  ], pops: [{ id: 'native-pop', size: 100, residenceId: 'home', jobId: 'work', drivingSeconds: 3600, drivingDistance: 25000 }] };
  const crossDemand = { schemaVersion: 1, gateways: ['border'],
    points: [['cross-home', -71.08, 42.35, 'BOSTON', 100, 0], ['cross-work', -71.02, 42.25, 'SOUTH', 0, 100]],
    popFields: ['id', 'mass', 'homeIndex', 'workIndex', 'gatewayIndex', 'drivingSeconds', 'drivingDistance', 'homeDepartureTime'],
    pops: [['cross-pop', 100, 0, 1, 0, 3600, 25000, '08:00']], };
  const commuteCatalog = { buildHash: 'startup-cache-fixture',
    buckets: [{ id: 'cross-flow', mass: 100, homeTileId: 'BOSTON', workTileId: 'SOUTH', gatewayId: 'border', defaultTravelSeconds: 7200 }],
    gateways: [{ id: 'border', location: [-71.05, 42.3] }] };
  const tilePackages = new MemoryTilePackageAdapter(Object.fromEntries(['BOSTON', 'SOUTH'].map(id => [id, {
    manifest: { tileId: id, cityCode: id, schemaVersion: 1, dataFiles: {} }, demand: [],
    nativeDemand: id === 'BOSTON' ? demand : { points: [], pops: [] }, crossDemand, commuteCatalog,
  }])));
  const identity = { BOSTON: 'a'.repeat(64), SOUTH: 'b'.repeat(64), cross: 'c'.repeat(64) };
  tilePackages.nativeDemandCacheIdentity = id => identity[id];
  tilePackages.crossDemandCacheIdentity = () => ({ digest: identity.cross, completeDepartures: true });
  const calls = { native: 0, cross: 0 };
  const load = tilePackages.loadNativeDemand.bind(tilePackages);
  tilePackages.loadNativeDemand = async id => { calls.native++; return load(id); };
  const game = new FakeGameAdapter();
  Object.assign(game.native, { gameSessionId: 'same-native-save', wallet: 1000000,
    stations: ['home', 'work'].map((id, i) => ({ id, coords: demand.points[i].location, stNodeIds: [`${id}-node`], buildType: 'constructed' })),
    stNodes: ['home', 'work'].map((id, i) => ({ id: `${id}-node`, stationId: id, coords: demand.points[i].location })),
    routes: [{ id: 'R', idealTrainCount: 2, stNodes: [{ id: 'home-node' }, { id: 'work-node' }],
      stComboTimings: [{ stNodeIndex: 0, arrivalTime: 0, departureTime: 20 }, { stNodeIndex: 1, arrivalTime: 600, departureTime: 620 }] }],
    trains: [], tracks: [], trackGroups: [] });
  const create = currentGame => {
    currentGame.capturePathfindingRules = () => currentGame.native.routingRules ?? {};
    return new WorldTileRuntime({ game: currentGame, worldState, tilePackages, derivedDemandCache: cache,
    getNativeSessionId: () => currentGame.native.gameSessionId,
    tileCatalog: { tiles: [
      { id: 'BOSTON', column: 0, row: 0, bounds: [-71.2, 42.3, -70.9, 42.5] },
      { id: 'SOUTH', column: 0, row: 1, bounds: [-71.2, 42.1, -70.9, 42.3] },
    ] }, revenueAccrual: new NativeRevenueAccrual({ adapter: currentGame }), backgroundNativeExpenses: false,
    evaluateCrossModeShares: input => { calls.cross++; return calculateCrossTileModeShares(input); },
    initialWorld: { activeTileId: 'SOUTH', cohorts: [] } });
  };
  const original = create(game);
  await original.boot('startup-cache', 'SOUTH');
  await original.recalculateCrossTileModeShare({ reason: 'startup' });
  await worldState.save(original.world);
  const saved = structuredClone(game.native);
  const coldLoad = async (mutate = () => {}, beforeCalculation = () => {}) => {
    const nextGame = new FakeGameAdapter(); nextGame.native = structuredClone(saved); mutate(nextGame.native);
    const runtime = create(nextGame);
    calls.native = calls.cross = 0;
    await runtime.boot('startup-cache', 'SOUTH', { nativeAuthoritativeLoad: true });
    beforeCalculation({ runtime, game: nextGame });
    const result = await runtime.recalculateCrossTileModeShare({ reason: 'startup' });
    return { runtime, game: nextGame, result, calls: { ...calls } };
  };
  return { coldLoad, identity, cache, records, original, saved, tilePackages };
}

test('cold startup reuses derived demand after a finance-blind World Record load without routing again', async () => {
  const { coldLoad, original, saved } = await fixture();
  const { runtime, game, result, calls } = await coldLoad();
  assert.equal(calls.native, 0, 'same Native Save must reuse packaged native profiles before evaluating demand');
  assert.equal(calls.cross, 0, 'same Native Save must reuse cross choices before running cross routing');
  assert.equal(result.status, 'cached');
  assert.equal(runtime.world.backgroundNativeFinance.tileRevenueProfiles.BOSTON.dailyRevenue,
    original.world.backgroundNativeFinance.tileRevenueProfiles.BOSTON.dailyRevenue);
  assert.deepEqual(runtime.world.crossPopModeChoices, original.world.crossPopModeChoices);
  assert.equal(game.native.wallet, saved.wallet, 'cache adoption must not restore or post money');
  assert.deepEqual(game.native.financialHistory, saved.financialHistory);
});

test('saving later in the same service day reuses complete-departure cross demand', async () => {
  const { coldLoad } = await fixture();
  const { calls, result, game } = await coldLoad(native => { native.clock = 1250; });
  assert.equal(calls.native, 0);
  assert.equal(calls.cross, 0, 'native time advanced after the calculation, but explicit departures still use the same service day');
  assert.equal(result.status, 'cached');
  assert.equal(game.native.clock, 1250);
});

test('a cold resume also bypasses routing through the production gzip and integrity cache codec', async () => {
  const { coldLoad, cache } = await fixture({ diskCodec: true });
  const { calls, result } = await coldLoad(native => { native.clock = 1250; });
  assert.equal(calls.native, 0);
  assert.equal(calls.cross, 0);
  assert.equal(result.diskCache, 'hit');
  assert.equal(cache.snapshot().hits, 3);
});

for (const [name, mutate] of [
  ['another Native Save session', native => { native.gameSessionId = 'another-native-save'; }],
  ['a fare change', native => { native.transitCost += 1; }],
  ['a route service change', native => { native.routes[0].idealTrainCount += 1; }],
  ['a routing rule change', native => { native.routingRules = { MAX_WALK_TO_FROM_STATION: 123 }; }],
]) test(`startup cache rejects ${name}`, async () => {
  const { coldLoad } = await fixture();
  const { calls } = await coldLoad(mutate);
  assert.ok(calls.native > 0, 'stale native profile must be recomputed');
  assert.equal(calls.cross, 1, 'stale cross choices must be recomputed');
});

test('a changed native demand byte identity invalidates only that tile profile', async () => {
  const { coldLoad, identity } = await fixture();
  identity.BOSTON = 'd'.repeat(64);
  const { calls } = await coldLoad();
  assert.equal(calls.native, 1);
  assert.equal(calls.cross, 0);
});

test('a changed cross-demand byte identity rejects cross choices', async () => {
  const { coldLoad, identity } = await fixture();
  identity.cross = 'd'.repeat(64);
  const { calls } = await coldLoad();
  assert.equal(calls.native, 0);
  assert.equal(calls.cross, 1);
});

test('legacy departures remain keyed on the exact fallback clock', async () => {
  const { coldLoad, tilePackages } = await fixture();
  const identity = tilePackages.crossDemandCacheIdentity();
  tilePackages.crossDemandCacheIdentity = () => ({ ...identity, completeDepartures: false });
  await coldLoad();
  const { calls } = await coldLoad(native => { native.clock = 1; });
  assert.equal(calls.native, 0);
  assert.equal(calls.cross, 1);
});

test('an unavailable cache safely recomputes rather than blocking startup', async () => {
  const { coldLoad, cache } = await fixture();
  cache.read = cache.write = async () => { throw new Error('storage is unavailable'); };
  const { calls, result } = await coldLoad();
  assert.equal(calls.native, 2);
  assert.equal(calls.cross, 1);
  assert.equal(result.status, 'recalculated');
});

test('a malformed cross cache entry cannot leak gateway or financial mutations before recomputation', async () => {
  const { coldLoad, records } = await fixture();
  for (const entry of records.values()) if (entry.kind === 'cross-choices') entry.extensionFlows = [
    { id: 'bogus-extension', mass: 1, homeTileId: 'BOSTON', workTileId: 'SOUTH', gatewayId: 'cache-only-leak' },
    { id: 'cross-flow', mass: 1, homeTileId: 'BOSTON', workTileId: 'SOUTH', gatewayId: 'collision' },
  ];
  const { runtime, result, calls } = await coldLoad();
  assert.equal(result.status, 'recalculated');
  assert.equal(calls.cross, 1);
  assert.equal(runtime.world.gatewayCatalog['cache-only-leak'], undefined);
  assert.equal(runtime.world.gatewayLedger['bogus-extension'], undefined);
  assert.equal(runtime.world.crossTileFinancials.pendingNativeRevenue, 0);
});

test('a late cache read cannot publish into a replaced native session', async () => {
  const { coldLoad, cache } = await fixture();
  const read = cache.read;
  const { runtime, result, calls } = await coldLoad(() => {}, ({ game }) => {
    cache.read = async key => { const value = await read(key); game.native.gameSessionId = 'replacement-session'; return value; };
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(calls.native, 0);
  assert.equal(calls.cross, 0);
  assert.deepEqual(runtime.world.backgroundNativeFinance.tileRevenueProfiles, {});
});

test('gzip cache integrity, quota failures and raw-size bounds degrade to misses', async () => {
  const entries = new Map();
  const store = { read: async key => entries.get(key), write: async (key, entry) => { entries.set(key, entry); } };
  const cache = createDerivedDemandCache({ store, maxRawEntryBytes: 1024 });
  const key = await derivedDemandContextKey({ version: 1, network: ['R'] });
  const value = { deterministic: [1, 2, 3] };
  assert.equal(await cache.write(key, value), true);
  assert.deepEqual(await cache.read(key), value);
  entries.get(key).rawBytes = 1;
  assert.equal(await cache.read(key), null, 'oversized decompression must stop before allocating the declared result');
  assert.equal(await cache.write(key, { data: 'x'.repeat(1024) }), false);
  store.write = async () => { throw new Error('quota exceeded'); };
  assert.equal(await cache.write(key, value), false);
  assert.ok(cache.snapshot().failures >= 2);
});

test('Japan packaged HH:MM departures route at the declared service time rather than the save clock', () => {
  const demand = { schemaVersion: 1, gateways: ['border'], popFields: ['id', 'mass', 'homePoint', 'workPoint', 'gateway', 'homeDepartureTime'],
    points: [['home', 0, 0, 'A'], ['work', 0.1, 0, 'B']], pops: [['pop', 10, 0, 1, 0, '07:30']] };
  const result = inspectCrossTileModeChoice({ crossDemand: demand, popIndex: 0, networkProfiles: {}, gatewayCatalog: {}, requestedDepartureSeconds: 1250 });
  assert.equal(result.requestedDepartureSeconds, 27000);
});

test('optional crypto support being unavailable disables context keys safely', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    assert.equal(await derivedDemandContextKey({ network: ['R'] }), null);
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
});
