const VALUE_RECORD = 'value';
const DELETED_RECORD = 'deleted';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

/** One IndexedDB object-store entry per logical sidecar key. */
export class IndexedDbRecordStore {
  constructor({
    indexedDB = globalThis.indexedDB,
    databaseName,
    storeName = 'entries',
  } = {}) {
    if (typeof databaseName !== 'string' || !databaseName) {
      throw new Error('IndexedDB storage requires a database name');
    }
    if (typeof indexedDB?.open !== 'function') {
      throw new Error('IndexedDB is unavailable');
    }
    this.indexedDB = indexedDB;
    this.databaseName = databaseName;
    this.storeName = storeName;
    this.databasePromise = null;
  }

  async #database() {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = this.indexedDB.open(this.databaseName, 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(this.storeName)) {
            database.createObjectStore(this.storeName, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => database.close();
          resolve(database);
        };
        request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB storage'));
        request.onblocked = () => reject(new Error('IndexedDB storage upgrade is blocked'));
      });
    }
    return this.databasePromise;
  }

  async read(key) {
    const database = await this.#database();
    const transaction = database.transaction(this.storeName, 'readonly');
    const completed = transactionComplete(transaction);
    const result = await requestResult(transaction.objectStore(this.storeName).get(key));
    await completed;
    return result ?? null;
  }

  async write(record) {
    const database = await this.#database();
    const transaction = database.transaction(this.storeName, 'readwrite');
    const completed = transactionComplete(transaction);
    await requestResult(transaction.objectStore(this.storeName).put(record));
    await completed;
  }
}

/**
 * Per-record storage with a read-only fallback for the legacy scoped document.
 * Values are copied into the durable store on first access; a tombstone keeps
 * deleted keys from being resurrected by the untouched legacy document.
 */
export class DurableStorageAdapter {
  constructor({ recordStore, legacyStorage = null } = {}) {
    if (!recordStore?.read || !recordStore?.write) {
      throw new Error('Durable storage requires a record store');
    }
    this.recordStore = recordStore;
    this.legacyStorage = legacyStorage;
  }

  async get(key, fallback = null) {
    const record = await this.recordStore.read(key);
    if (record?.state === VALUE_RECORD) return record.value;
    if (record?.state === DELETED_RECORD) return fallback;

    const legacyValue = await this.legacyStorage?.get?.(key, null);
    if (legacyValue == null) return fallback;
    await this.recordStore.write({ key, state: VALUE_RECORD, value: legacyValue });
    return legacyValue;
  }

  async set(key, value) {
    await this.recordStore.write({ key, state: VALUE_RECORD, value });
  }

  async delete(key) {
    await this.recordStore.write({ key, state: DELETED_RECORD });
  }
}
