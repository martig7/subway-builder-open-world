import test from 'node:test';
import assert from 'node:assert/strict';
import { SerializedStorageAdapter } from '../src/adapters/serialized-storage-adapter.js';

class SnapshotReplacingStorage {
  constructor() { this.values = new Map(); }
  async get(key, fallback = null) {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : fallback;
  }
  async set(key, value) {
    const next = new Map(this.values);
    await new Promise((resolve) => setTimeout(resolve, 1));
    next.set(key, structuredClone(value));
    this.values = next;
  }
  async delete(key) {
    const next = new Map(this.values);
    await new Promise((resolve) => setTimeout(resolve, 1));
    next.delete(key);
    this.values = next;
  }
}

test('shared coordinator serializes different component writes and hot-reload generations', async () => {
  const raw = new SnapshotReplacingStorage();
  const coordinator = { tail: Promise.resolve() };
  const firstGeneration = new SerializedStorageAdapter({ storage: raw, coordinator });
  const secondGeneration = new SerializedStorageAdapter({ storage: raw, coordinator });

  await Promise.all([
    firstGeneration.set('world:asset:a', { id: 'a' }),
    secondGeneration.set('identity:canonical-world', 'canonical'),
    firstGeneration.set('diagnostics:transitions', [{ id: 1 }]),
    secondGeneration.set('world:pointer', { revisionId: 'revision-1' }),
  ]);

  assert.deepEqual([...raw.values.keys()].sort(), [
    'diagnostics:transitions',
    'identity:canonical-world',
    'world:asset:a',
    'world:pointer',
  ]);
});
