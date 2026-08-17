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

test('an unmarked native session does not inherit the durable canonical world by default', async () => {
  const storage = new Map();
  const resolver = new WorldIdentityResolver({ storage });

  await resolver.resolve('known-grid-save', null, {
    authoritativeWorldId: 'canonical-open-world',
  });
  const reopened = await resolver.resolve('new-unmarked-autosave');

  assert.equal(reopened.nativeSessionId, 'new-unmarked-autosave');
  assert.equal(reopened.worldId, 'new-unmarked-autosave');
  assert.equal(reopened.aliased, false);
  assert.equal(storage.get(`${WORLD_IDENTITY_ALIAS_PREFIX}new-unmarked-autosave`), undefined);
});

test('a configured canonical seed recovers when aliases and native markers were lost', async () => {
  const storage = new Map();
  const resolver = new WorldIdentityResolver({
    storage,
    canonicalWorldId: 'canonical-open-world',
  });

  const recovered = await resolver.resolve('new-unmarked-autosave', null, {
    allowCanonicalFallback: true,
  });

  assert.equal(recovered.worldId, 'canonical-open-world');
  assert.equal(recovered.aliased, true);
  assert.equal(recovered.source, 'canonical-world');
  assert.equal(storage.get('identity:canonical-world'), 'canonical-open-world');
});

test('an unavailable native session receives a stable isolated world id', async () => {
  const storage = new Map([['identity:canonical-world', 'old-open-world']]);
  const resolver = new WorldIdentityResolver({ storage, fallbackWorldId: 'ny-state-six-tile' });

  const first = await resolver.resolve(null, null, { allowCanonicalFallback: true });
  const reopened = await resolver.resolve(undefined);

  assert.equal(first.worldId, reopened.worldId);
  assert.match(first.worldId, /^ny-state-six-tile:unbound:/);
  assert.equal(first.aliased, false);
  assert.notEqual(first.worldId, 'old-open-world');
  assert.equal(storage.get(`${WORLD_IDENTITY_ALIAS_PREFIX}${first.worldId}`), undefined);
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

test('an explicit user-selected canonical path overrides a stale alias', async () => {
  const storage = new Map([
    [`${WORLD_IDENTITY_ALIAS_PREFIX}native-save`, 'old-world'],
  ]);
  const resolver = new WorldIdentityResolver({ storage });

  const resolved = await resolver.resolve('native-save', null, {
    selectedWorldId: 'chosen-world',
  });

  assert.deepEqual(resolved, {
    nativeSessionId: 'native-save',
    worldId: 'chosen-world',
    aliased: true,
    source: 'user-selection',
    sourceSessionId: null,
  });
  assert.equal(storage.get(`${WORLD_IDENTITY_ALIAS_PREFIX}native-save`), 'chosen-world');
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

test('an established canonical identity binding is served from memory on later autosaves', async () => {
  const values = new Map();
  let reads = 0;
  const storage = {
    async get(key, fallback = null) { reads++; return values.has(key) ? values.get(key) : fallback; },
    async set(key, value) { values.set(key, value); },
  };
  const resolver = new WorldIdentityResolver({ storage });

  assert.equal(await resolver.bind('native-save', 'canonical-world'), true);
  const readsAfterFirstBind = reads;
  assert.equal(await resolver.bind('native-save', 'canonical-world'), true);
  assert.equal(reads, readsAfterFirstBind);
});
