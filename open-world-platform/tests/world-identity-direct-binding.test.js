import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldIdentityResolver } from '../src/runtime/world-identity.js';
import { DurableStorageAdapter } from '../src/runtime/adapters/durable-storage-adapter.js';

test('an explicit transition binds a new session without reading the legacy document', async () => {
  const records = new Map(), operations = [];
  const storage = new DurableStorageAdapter({
    recordStore: {
      async read(key) { operations.push('read'); return records.get(key); },
      async write(record) { operations.push('write'); records.set(record.key, record); },
    },
    legacyStorage: { get() { throw new Error('Unexpected full legacy document read'); } },
  });
  const resolver = new WorldIdentityResolver({ storage });
  assert.equal(await resolver.bind('new-native-session', 'world', { force: true }), true);
  assert.deepEqual(operations, ['write', 'read']);
  assert.equal((await resolver.resolve('new-native-session')).worldId, 'world');
});

test('forced binding verifies the stored winner before remembering an alias', async () => {
  const storage = new Map([['identity:session:native', 'different-world']]);
  const resolver = new WorldIdentityResolver({ storage: {
    set() {}, get: (key, fallback) => storage.get(key) ?? fallback,
  } });
  assert.equal(await resolver.bind('native', 'requested-world', { force: true }), false);
  assert.equal((await resolver.resolve('native')).worldId, 'different-world');
});

test('ordinary binding still protects a legacy canonical alias from reassignment', async () => {
  const resolver = new WorldIdentityResolver({ storage: new Map([['identity:session:native', 'original-world']]) });
  assert.equal(await resolver.bind('native', 'another-world'), false);
  assert.equal((await resolver.resolve('native')).worldId, 'original-world');
});

for (const warm of [false, true]) test(`a saved authoritative World repairs a stale native binding (warm=${warm})`, async () => {
  const storage = new Map([['identity:session:native', 'stale-world']]);
  const resolver = new WorldIdentityResolver({ storage });
  if (warm) assert.equal((await resolver.resolve('native')).worldId, 'stale-world');
  const selected = await resolver.resolve('native', null, { authoritativeWorldId: 'saved-world' });
  assert.equal(selected.worldId, 'saved-world');
  assert.equal(selected.source, 'authoritative-marker');
  assert.equal(storage.get('identity:session:native'), 'saved-world');
  assert.equal((await resolver.resolve('native')).worldId, 'saved-world');
});

test('a saved self-World repairs a stale cached alias without changing the native session', async () => {
  const storage = new Map([['identity:session:native', 'stale-world']]);
  const resolver = new WorldIdentityResolver({ storage });
  await resolver.resolve('native');
  const selected = await resolver.resolve('native', null, { authoritativeWorldId: 'native' });
  assert.equal(selected.worldId, 'native');
  assert.equal(selected.aliased, false);
  assert.equal(selected.nativeSessionId, 'native');
  assert.equal(storage.get('identity:session:native'), 'native');
  assert.equal((await resolver.resolve('native')).worldId, 'native');
});

test('intentional pending navigation takes priority over saved markers and recovery bindings', async () => {
  const storage = new Map([['identity:session:native', 'stale-world']]);
  const resolver = new WorldIdentityResolver({ storage, recoveryAliases: { native: 'recovered-world' } });
  const selected = await resolver.resolve('native', 'pending-world', { authoritativeWorldId: 'saved-world' });
  assert.equal(selected.worldId, 'pending-world');
  assert.equal(storage.get('identity:session:native'), 'pending-world');
});

test('configured recovery migration still takes priority over an old saved marker', async () => {
  const storage = new Map([['identity:session:native', 'stale-world']]);
  const resolver = new WorldIdentityResolver({ storage, recoveryAliases: { native: 'recovered-world' } });
  const selected = await resolver.resolve('native', null, { authoritativeWorldId: 'saved-world' });
  assert.equal(selected.worldId, 'recovered-world');
  assert.equal(storage.get('identity:session:native'), 'recovered-world');
});

for (const fault of ['write', 'read', 'missing']) test(`saved-authority repair stops when binding durability cannot be verified (${fault})`, async () => {
  let failing = false;
  const values = new Map([['identity:session:native', 'stale-world']]);
  const storage = {
    get(key, fallback = null) {
      if (failing && fault === 'read') throw new Error('binding read failed');
      return values.get(key) ?? fallback;
    },
    set(key, value) {
      if (failing && fault === 'write') throw new Error('binding write failed');
      if (failing && fault === 'missing') { values.delete(key); return; }
      values.set(key, value);
    },
  };
  const resolver = new WorldIdentityResolver({ storage });
  await resolver.resolve('native');
  failing = true;
  await assert.rejects(resolver.resolve('native', null, { authoritativeWorldId: 'saved-world' }),
    /binding write failed|binding read failed|binding could not be verified/);
});
