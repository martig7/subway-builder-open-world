import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DurableStorageAdapter,
  IndexedDbRecordStore,
} from '../src/adapters/durable-storage-adapter.js';

class MemoryRecordStore {
  constructor() { this.records = new Map(); }

  async read(key) {
    return this.records.has(key) ? structuredClone(this.records.get(key)) : null;
  }

  async write(record) {
    this.records.set(record.key, structuredClone(record));
  }
}

class LegacyStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
    this.writeCount = 0;
  }

  async get(key, fallback = null) {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : fallback;
  }

  async set() { this.writeCount += 1; }
  async delete() { this.writeCount += 1; }
}

class FakeIndexedDbTransaction {
  constructor(records) {
    this.records = records;
    this.store = {
      get: (key) => this.#request(() => this.records.get(key)),
      put: (record) => this.#request(() => {
        this.records.set(record.key, structuredClone(record));
        return record.key;
      }),
    };
  }

  objectStore() { return this.store; }

  #request(operation) {
    const request = {};
    queueMicrotask(() => {
      try {
        request.result = structuredClone(operation());
        request.onsuccess?.();
        queueMicrotask(() => this.oncomplete?.());
      } catch (error) {
        request.error = error;
        request.onerror?.();
        this.error = error;
        this.onerror?.();
      }
    });
    return request;
  }
}

class FakeIndexedDbDatabase {
  constructor() {
    this.stores = new Map();
    this.objectStoreNames = { contains: (name) => this.stores.has(name) };
  }

  createObjectStore(name) { this.stores.set(name, new Map()); }
  transaction(name) { return new FakeIndexedDbTransaction(this.stores.get(name)); }
  close() {}
}

class FakeIndexedDbFactory {
  constructor() { this.databases = new Map(); }

  open(name) {
    const request = {};
    queueMicrotask(() => {
      const isNew = !this.databases.has(name);
      if (isNew) this.databases.set(name, new FakeIndexedDbDatabase());
      request.result = this.databases.get(name);
      if (isNew) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }
}

test('a legacy value is migrated once and then read from durable per-record storage', async () => {
  const legacy = new LegacyStorage([
    ['world:active', { revisionId: 'legacy-revision' }],
  ]);
  const storage = new DurableStorageAdapter({
    recordStore: new MemoryRecordStore(),
    legacyStorage: legacy,
  });

  assert.deepEqual(await storage.get('world:active'), { revisionId: 'legacy-revision' });
  legacy.values.set('world:active', { revisionId: 'stale-legacy-revision' });

  assert.deepEqual(await storage.get('world:active'), { revisionId: 'legacy-revision' });
  assert.equal(legacy.writeCount, 0);
});

test('new values are persisted without mutating the legacy shared document', async () => {
  const legacy = new LegacyStorage();
  const storage = new DurableStorageAdapter({
    recordStore: new MemoryRecordStore(),
    legacyStorage: legacy,
  });

  await storage.set('identity:canonical-world', 'world-42');

  assert.equal(await storage.get('identity:canonical-world'), 'world-42');
  assert.equal(legacy.writeCount, 0);
});

test('deleting a migrated value prevents the legacy copy from being resurrected', async () => {
  const legacy = new LegacyStorage([['world:obsolete', { revisionId: 'old' }]]);
  const storage = new DurableStorageAdapter({
    recordStore: new MemoryRecordStore(),
    legacyStorage: legacy,
  });
  assert.deepEqual(await storage.get('world:obsolete'), { revisionId: 'old' });

  await storage.delete('world:obsolete');

  assert.equal(await storage.get('world:obsolete', 'missing'), 'missing');
  assert.equal(legacy.writeCount, 0);
});

test('IndexedDB records remain available to a new store instance', async () => {
  const indexedDB = new FakeIndexedDbFactory();
  const first = new IndexedDbRecordStore({ indexedDB, databaseName: 'sidecar-test' });
  await first.write({ key: 'world:active', state: 'value', value: { revisionId: 'r1' } });

  const second = new IndexedDbRecordStore({ indexedDB, databaseName: 'sidecar-test' });

  assert.deepEqual(await second.read('world:active'), {
    key: 'world:active',
    state: 'value',
    value: { revisionId: 'r1' },
  });
});
