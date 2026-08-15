import test from 'node:test';
import assert from 'node:assert/strict';
import { ModStorageWorldStateAdapter, SAVE_CHECKPOINT_LIMIT } from '../src/adapters/mod-storage-world-state-adapter.js';
import { createWorld } from '../src/world-model.js';

test('save checkpoints restore by native save name and retain only the newest ten', async () => {
  const storage = new Map();
  let timestamp = 1_000;
  const adapter = new ModStorageWorldStateAdapter({ storage, now: () => timestamp++ });
  const world = createWorld({ worldId: 'checkpoint-world', tileIds: ['KCW', 'KCE'] });

  for (let number = 1; number <= 12; number += 1) {
    world.elapsedSeconds = number * 3_600;
    world.worldTime = number;
    world.commuteLastProcessedHour = number;
    world.revision = number;
    for (const tile of Object.values(world.tiles)) tile.lastSimulatedTime = number;
    await adapter.saveCheckpoint(world, `Autosave ${number}`);
  }

  const index = storage.get('world:checkpoint-world:save-checkpoints');
  assert.equal(index.entries.length, SAVE_CHECKPOINT_LIMIT);
  assert.deepEqual(index.entries.map((entry) => entry.saveName), [
    'Autosave 3', 'Autosave 4', 'Autosave 5', 'Autosave 6', 'Autosave 7',
    'Autosave 8', 'Autosave 9', 'Autosave 10', 'Autosave 11', 'Autosave 12',
  ]);
  assert.equal([...storage.keys()].filter((key) => key.includes(':save-checkpoint:')).length, SAVE_CHECKPOINT_LIMIT);
  assert.equal(await adapter.load('checkpoint-world', { saveName: 'Autosave 2' }), null);
  assert.equal((await adapter.load('checkpoint-world', { saveName: 'Autosave 4' })).elapsedSeconds, 4 * 3_600);
});

test('saving the same native save name replaces its prior checkpoint payload', async () => {
  const storage = new Map();
  const adapter = new ModStorageWorldStateAdapter({ storage });
  const world = createWorld({ worldId: 'replace-world', tileIds: ['KCW', 'KCE'] });

  world.elapsedSeconds = 3_600;
  await adapter.saveCheckpoint(world, 'Autosave');
  world.elapsedSeconds = 7_200;
  await adapter.saveCheckpoint(world, 'Autosave');

  const index = storage.get('world:replace-world:save-checkpoints');
  assert.equal(index.entries.length, 1);
  assert.equal([...storage.keys()].filter((key) => key.includes(':save-checkpoint:')).length, 1);
  assert.equal((await adapter.load('replace-world', { saveName: 'Autosave' })).elapsedSeconds, 7_200);
});

test('same-named grid autosaves retain separate checkpoints by native session identity', async () => {
  const storage = new Map();
  const adapter = new ModStorageWorldStateAdapter({ storage });
  const world = createWorld({ worldId: 'shared-grid-world', tileIds: ['KCW', 'KCE'] });

  world.activeTileId = 'KCW';
  world.elapsedSeconds = 3_600;
  await adapter.saveCheckpoint(world, 'Autosave', {
    nativeSessionId: 'west-native-session',
    nativeTileId: 'KCW',
  });
  world.activeTileId = 'KCE';
  world.elapsedSeconds = 7_200;
  await adapter.saveCheckpoint(world, 'Autosave', {
    nativeSessionId: 'east-native-session',
    nativeTileId: 'KCE',
  });

  const index = storage.get('world:shared-grid-world:save-checkpoints');
  assert.equal(index.entries.length, 2);
  assert.equal((await adapter.load('shared-grid-world', {
    saveName: 'Autosave', nativeSessionId: 'west-native-session', nativeTileId: 'KCW',
  })).elapsedSeconds, 3_600);
  assert.equal((await adapter.load('shared-grid-world', {
    saveName: 'Autosave', nativeSessionId: 'east-native-session', nativeTileId: 'KCE',
  })).elapsedSeconds, 7_200);
});

test('authoritative load diagnostics identify the exact checkpoint payload selected', async () => {
  const storage = new Map();
  const diagnostics = [];
  const adapter = new ModStorageWorldStateAdapter({
    storage,
    diagnostics: (event) => diagnostics.push(event),
  });
  const world = createWorld({ worldId: 'diagnostic-world', tileIds: ['KCW', 'KCE'] });
  world.activeTileId = 'KCE';
  world.revision = 7;
  await adapter.save(world);
  await adapter.saveCheckpoint(world, 'Autosave', {
    nativeSessionId: 'native-session', nativeTileId: 'KCE',
  });

  await adapter.load('diagnostic-world', {
    saveName: 'Autosave',
    allowLiveFallback: true,
    nativeSessionId: 'native-session',
    nativeTileId: 'KCE',
    loadTraceId: 'checkpoint-diagnostic',
  });

  assert.deepEqual(diagnostics.map(({ segment }) => segment), [
    'storage-key-lookup-start',
    'checkpoint-index-read',
    'checkpoint-match-selected',
    'checkpoint-payload-read',
    'checkpoint-load-complete',
  ]);
  assert.equal(diagnostics.at(-1).loadTraceId, 'checkpoint-diagnostic');
  assert.equal(diagnostics.at(-1).revision, 7);
  assert.equal(diagnostics.at(-1).activeTileId, 'KCE');
});

test('an aliased grid save never accepts another grid checkpoint with the same display name', async () => {
  const storage = new Map();
  const adapter = new ModStorageWorldStateAdapter({ storage });
  const world = createWorld({ worldId: 'strict-grid-world', tileIds: ['KCW', 'KCE'], wallet: 900 });
  await adapter.save(world);
  await adapter.saveCheckpoint(world, 'Autosave', {
    nativeSessionId: 'west-native-session', nativeTileId: 'KCW',
  });
  world.wallet = 1_200;
  await adapter.save(world);

  const loaded = await adapter.load('strict-grid-world', {
    saveName: 'Autosave',
    nativeSessionId: 'east-native-session',
    nativeTileId: 'KCE',
    allowLiveFallback: true,
  });

  assert.equal(loaded.wallet, 1_200);
});

test('a named native save never inherits unsafe unversioned world state', async () => {
  const adapter = new ModStorageWorldStateAdapter();
  const world = createWorld({ worldId: 'legacy-world', tileIds: ['KCW', 'KCE'], elapsedSeconds: 10 * 3_600, worldTime: 10 });
  await adapter.save(world);

  assert.equal(await adapter.load('legacy-world', { saveName: 'Older autosave' }), null);
  assert.equal((await adapter.load('legacy-world')).elapsedSeconds, 10 * 3_600);
});

test('an explicitly aliased tile save may fall back to its live shared world before first checkpoint', async () => {
  const storage = new Map();
  const adapter = new ModStorageWorldStateAdapter({ storage });
  const world = createWorld({ worldId: 'shared-world', tileIds: ['KCW', 'KCE'], wallet: 4321 });
  await adapter.save(world);

  const loaded = await adapter.load('shared-world', {
    saveName: 'Destination Autosave', allowLiveFallback: true,
  });

  assert.equal(loaded.worldId, 'shared-world');
  assert.equal(loaded.wallet, 4321);
});

test('an aliased save recovers live finance when its checkpoint index points to a missing payload', async () => {
  const storage = new Map();
  const adapter = new ModStorageWorldStateAdapter({ storage });
  const world = createWorld({ worldId: 'dangling-checkpoint-world', tileIds: ['KCW', 'KCE'] });
  world.backgroundNativeFinance.tileRevenueProfiles.KCE = {
    schemaVersion: 3,
    tileId: 'KCE',
    dailyRevenue: 12_000,
    hourly: Array.from({ length: 24 }, () => ({ revenue: 500, revenueByRoute: { R: 500 } })),
  };
  world.backgroundNativeFinance.expenseProfile = {
    schemaVersion: 2,
    hourly: Array.from({ length: 24 }, () => 250),
  };
  await adapter.save(world);
  storage.set('world:dangling-checkpoint-world:save-checkpoints', {
    schemaVersion: 1,
    nextSequence: 12,
    entries: [{ checkpointId: '0000000012', saveName: 'Seed', savedAt: 12 }],
  });

  const loaded = await adapter.load('dangling-checkpoint-world', {
    saveName: 'Seed',
    allowLiveFallback: true,
  });

  assert.equal(loaded.backgroundNativeFinance.tileRevenueProfiles.KCE.dailyRevenue, 12_000);
  assert.equal(loaded.backgroundNativeFinance.expenseProfile.schemaVersion, 2);
});

test('hourly settlement journal restores aggregate progress without copying tile snapshots', async () => {
  const storage = new Map();
  const adapter = new ModStorageWorldStateAdapter({ storage });
  const world = createWorld({ worldId: 'journal-world', tileIds: ['KCW', 'KCE'] });
  world.commuteCatalogBuildHash = 'catalog-v1';
  world.tiles.KCW.snapshot = { objects: Array(1_000).fill({ large: 'native-save-data' }) };
  await adapter.save(world);

  world.worldTime = 7;
  world.elapsedSeconds = 7 * 3_600;
  world.commuteLastProcessedHour = 7;
  world.wallet = 1_234;
  await adapter.saveSettlement(world);

  const journal = storage.get('world:journal-world:settlement');
  assert.equal('snapshot' in (journal.tileClocks.KCW ?? {}), false);
  const restored = await adapter.load('journal-world');
  assert.equal(restored.worldTime, 7);
  assert.equal(restored.wallet, 1_234);
  assert.equal(restored.tiles.KCW.snapshot.objects.length, 1_000);
});

test('named save load overlays a newer compatible settlement journal', async () => {
  const storage = new Map();
  const adapter = new ModStorageWorldStateAdapter({ storage });
  const world = createWorld({ worldId: 'checkpoint-journal-world', tileIds: ['KCW', 'KCE'] });
  world.commuteCatalogBuildHash = 'catalog-v1';
  world.revision = 4;
  world.worldTime = 10;
  world.elapsedSeconds = 10 * 3_600;
  world.wallet = 1_000;
  world.backgroundNativeFinance.networkHash = 'old-network';
  await adapter.save(world);
  await adapter.saveCheckpoint(world, 'Autosave');

  world.worldTime = 12;
  world.elapsedSeconds = 12 * 3_600;
  world.wallet = 1_500;
  world.backgroundNativeFinance.networkHash = 'current-network';
  world.backgroundNativeFinance.totalRevenue = 500;
  world.backgroundNativeFinance.tileRevenueProfiles.KCE = {
    source: 'off-tile-estimator', dailyRevenue: 12_000, hourly: [],
  };
  world.financialHistory = { currentHourRevenue: 500, hourly: [{ hour: 12, revenue: 500 }] };
  await adapter.saveSettlement(world);

  const restored = await adapter.load('checkpoint-journal-world', { saveName: 'Autosave' });

  assert.equal(restored.worldTime, 10);
  assert.equal(restored.wallet, 1_000);
  assert.equal(restored.backgroundNativeFinance.networkHash, 'current-network');
  assert.equal(restored.backgroundNativeFinance.tileRevenueProfiles.KCE.dailyRevenue, 12_000);
  assert.equal(restored.backgroundNativeFinance.totalRevenue, 0);
  assert.notDeepEqual(restored.financialHistory, world.financialHistory);
});

test('named save load retains shared accounting after a later full checkpoint clears the journal', async () => {
  const storage = new Map();
  const adapter = new ModStorageWorldStateAdapter({ storage });
  const world = createWorld({ worldId: 'checkpoint-live-world', tileIds: ['KCW', 'KCE'] });
  world.commuteCatalogBuildHash = 'catalog-v1';
  world.revision = 4;
  world.worldTime = 10;
  world.elapsedSeconds = 10 * 3_600;
  world.wallet = 1_000;
  world.backgroundNativeFinance.networkHash = 'old-network';
  await adapter.save(world);
  await adapter.saveCheckpoint(world, 'Older tile save');

  world.worldTime = 12;
  world.elapsedSeconds = 12 * 3_600;
  world.wallet = 1_500;
  world.backgroundNativeFinance.networkHash = 'current-network';
  world.backgroundNativeFinance.totalRevenue = 500;
  world.backgroundNativeFinance.tileRevenueProfiles.KCE = {
    source: 'off-tile-estimator', dailyRevenue: 12_000, hourly: [],
  };
  world.financialHistory = { currentHourRevenue: 500, hourly: [{ hour: 12, revenue: 500 }] };
  await adapter.saveSettlement(world);
  await adapter.save(world);
  assert.equal(storage.has('world:checkpoint-live-world:settlement'), false);

  const restored = await adapter.load('checkpoint-live-world', { saveName: 'Older tile save' });

  assert.equal(restored.worldTime, 10);
  assert.equal(restored.wallet, 1_000);
  assert.equal(restored.backgroundNativeFinance.networkHash, 'current-network');
  assert.equal(restored.backgroundNativeFinance.tileRevenueProfiles.KCE.dailyRevenue, 12_000);
  assert.equal(restored.backgroundNativeFinance.totalRevenue, 0);
  assert.notDeepEqual(restored.financialHistory, world.financialHistory);
});
