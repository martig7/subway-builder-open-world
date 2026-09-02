/**
 * Serialize access to a scoped Modding API store.
 *
 * The API persists a mutation by replacing one shared JSON document, so even
 * writes to different keys are not safe to overlap. A coordinator can be
 * retained on globalThis so old and new hot-reload generations drain through
 * the same queue.
 */
export class SerializedStorageAdapter {
  constructor({ storage, coordinator = { tail: Promise.resolve() } } = {}) {
    this.storage = storage;
    this.coordinator = coordinator;
    if (!this.coordinator.tail?.then) this.coordinator.tail = Promise.resolve();
  }

  #enqueue(operation) {
    const pending = this.coordinator.tail.then(operation, operation);
    this.coordinator.tail = pending.catch(() => {});
    return pending;
  }

  get(key, fallback = null) {
    return this.#enqueue(() => this.storage?.get?.(key, fallback));
  }

  set(key, value) {
    return this.#enqueue(() => this.storage?.set?.(key, value));
  }

  delete(key) {
    return this.#enqueue(() => this.storage?.delete?.(key));
  }
}
