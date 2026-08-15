import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorldIdentityResolver,
  WORLD_IDENTITY_ALIAS_PREFIX,
  worldIdentityLoadOptions,
} from '../src/world-identity.js';

test('a destination tile session remains bound to the pending open world', async () => {
  const storage = new Map();
  const resolver = new WorldIdentityResolver({ storage });

  const transition = await resolver.resolve('destination-native-save', 'shared-open-world');
  const reopened = await resolver.resolve('destination-native-save');

  assert.deepEqual(transition, {
    nativeSessionId: 'destination-native-save', worldId: 'shared-open-world', aliased: true,
  });
  assert.deepEqual(reopened, transition);
  assert.equal(storage.get(`${WORLD_IDENTITY_ALIAS_PREFIX}destination-native-save`), 'shared-open-world');
});

test('an unrelated native save remains isolated without an explicit alias', async () => {
  const resolver = new WorldIdentityResolver({ storage: new Map() });
  assert.deepEqual(await resolver.resolve('unrelated-save'), {
    nativeSessionId: 'unrelated-save', worldId: 'unrelated-save', aliased: false,
  });
});

test('a one-time recovery alias is persisted through authoritative mod storage', async () => {
  const storage = new Map();
  const resolver = new WorldIdentityResolver({
    storage,
    recoveryAliases: { 'clipped-native-save': 'recovered-open-world' },
  });

  const recovered = await resolver.resolve('clipped-native-save');

  assert.equal(recovered.worldId, 'recovered-open-world');
  assert.equal(recovered.aliased, true);
  assert.equal(storage.get(`${WORLD_IDENTITY_ALIAS_PREFIX}clipped-native-save`), 'recovered-open-world');
});

test('a recovery alias replaces a stale persisted lineage binding', async () => {
  const storage = new Map([
    [`${WORLD_IDENTITY_ALIAS_PREFIX}native-save`, 'clipped-open-world'],
  ]);
  const resolver = new WorldIdentityResolver({
    storage,
    recoveryAliases: { 'native-save': 'recovered-open-world' },
  });

  const recovered = await resolver.resolve('native-save');

  assert.equal(recovered.worldId, 'recovered-open-world');
  assert.equal(storage.get(`${WORLD_IDENTITY_ALIAS_PREFIX}native-save`), 'recovered-open-world');
});

test('a late save from a stale self-world cannot overwrite an established canonical lineage', async () => {
  const storage = new Map();
  const resolver = new WorldIdentityResolver({ storage });

  const staleResolution = await resolver.resolve('native-save');
  assert.equal(staleResolution.worldId, 'native-save');

  await resolver.bind('native-save', 'canonical-open-world');
  const staleSaveAccepted = await resolver.bind('native-save', staleResolution.worldId);

  assert.equal(staleSaveAccepted, false);
  assert.equal(
    storage.get(`${WORLD_IDENTITY_ALIAS_PREFIX}native-save`),
    'canonical-open-world',
  );
  assert.deepEqual(await resolver.resolve('native-save'), {
    nativeSessionId: 'native-save',
    worldId: 'canonical-open-world',
    aliased: true,
  });
});

test('a newly named autosave inherits the canonical world from its embedded parent session', async () => {
  const storage = new Map();
  const resolver = new WorldIdentityResolver({
    storage,
    recoveryAliases: { 'parent-native-save': 'canonical-open-world' },
  });

  const resolved = await resolver.resolve('new-autosave-id', null, {
    ancestorSessionIds: ['parent-native-save'],
  });

  assert.deepEqual(resolved, {
    nativeSessionId: 'new-autosave-id',
    worldId: 'canonical-open-world',
    aliased: true,
    source: 'ancestor-session',
    sourceSessionId: 'parent-native-save',
  });
  assert.equal(
    storage.get(`${WORLD_IDENTITY_ALIAS_PREFIX}new-autosave-id`),
    'canonical-open-world',
  );
});

test('a persisted authoritative world marker survives a native autosave id change', async () => {
  const storage = new Map();
  const resolver = new WorldIdentityResolver({ storage });

  const resolved = await resolver.resolve('new-autosave-id', null, {
    authoritativeWorldId: 'canonical-open-world',
  });

  assert.deepEqual(resolved, {
    nativeSessionId: 'new-autosave-id',
    worldId: 'canonical-open-world',
    aliased: true,
    source: 'authoritative-marker',
    sourceSessionId: null,
  });
});

test('an aliased autosave without a public save name still requests authoritative restoration', () => {
  assert.deepEqual(worldIdentityLoadOptions({
    nativeSessionId: 'new-autosave-id',
    worldId: 'canonical-open-world',
    aliased: true,
  }, {
    saveName: null,
    nativeTileId: 'NY_CP00_RP02',
  }), {
    allowLiveFallback: true,
    nativeSessionId: 'new-autosave-id',
    nativeTileId: 'NY_CP00_RP02',
  });
});
