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
