// These are disposable routing outputs. Native Saves and World Records never
// depend on this database, and no balance, receipt or settlement cursor enters it.
import { demandDepartureSeconds } from './demand-departure-time.js';
export const STARTUP_DERIVED_DEMAND_CACHE_VERSION = 'startup-derived-demand-cache-v2-capacity';
const MAX_ENTRY_BYTES = 32 * 1024 ** 2;
const MAX_RAW_ENTRY_BYTES = 128 * 1024 ** 2;
const MAX_TOTAL_BYTES = 128 * 1024 ** 2;
const MAX_ENTRIES = 512;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

async function digest(bytes) {
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function derivedDemandContextKey(context) {
  try {
    if (!globalThis.crypto?.subtle?.digest) return null;
    return `${STARTUP_DERIVED_DEMAND_CACHE_VERSION}:${await digest(new TextEncoder().encode(JSON.stringify(stable(context))))}`;
  } catch { return null; }
}

export function crossDemandHasCompleteDepartures(demand) {
  const index = demand?.popFields?.indexOf('homeDepartureTime') ?? -1;
  return Array.isArray(demand?.pops) && (demand.pops.length === 0
    || (index >= 0 && demand.pops.every(pop => demandDepartureSeconds(pop?.[index]) != null)));
}

export function createDerivedDemandDiskStore({ indexedDB = globalThis.indexedDB, namespace = 'open-world' } = {}) {
  let database;
  const open = () => database ??= new Promise((resolve, reject) => {
    if (!indexedDB) return reject(new Error('Derived demand cache is unavailable'));
    const request = indexedDB.open(`${namespace}-derived-demand-cache-v1`, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('entries'); request.result.createObjectStore('metadata'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Derived demand cache is blocked'));
  });
  return {
    async read(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const request = db.transaction('entries', 'readonly').objectStore('entries').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },
    async write(key, value) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(['entries', 'metadata'], 'readwrite');
        const entries = transaction.objectStore('entries');
        const metadata = transaction.objectStore('metadata');
        // Inspect only tiny metadata through a key cursor, not all compressed
        // profiles at once. Atomic eviction bounds storage even after a crash.
        const request = metadata.openCursor();
        const existing = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            if (cursor.key !== key) existing.push({ key: cursor.key, at: cursor.value.at, bytes: cursor.value.bytes ?? 0 });
            cursor.continue(); return;
          }
          existing.sort((a, b) => a.at - b.at);
          let bytes = existing.reduce((sum, entry) => sum + entry.bytes, value.bytes.byteLength);
          while (existing.length >= MAX_ENTRIES || bytes > MAX_TOTAL_BYTES) {
            const oldest = existing.shift(); if (!oldest) break;
            entries.delete(oldest.key); metadata.delete(oldest.key); bytes -= oldest.bytes;
          }
          entries.put(value, key);
          metadata.put({ at: value.at, bytes: value.bytes.byteLength }, key);
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Derived demand cache transaction failed'));
      });
    },
  };
}

export function createDerivedDemandCache({ store = createDerivedDemandDiskStore(), maxEntryBytes = MAX_ENTRY_BYTES,
  maxRawEntryBytes = MAX_RAW_ENTRY_BYTES } = {}) {
  const stats = { reads: 0, hits: 0, misses: 0, writes: 0, failures: 0, oversized: 0, lastError: null,
    lastRawBytes: 0, lastStoredBytes: 0 };
  const fail = error => { stats.failures++; stats.lastError = String(error?.message ?? error); };
  return {
    async read(key) {
      stats.reads++;
      try {
        const entry = await store.read(key);
        if (entry?.version !== STARTUP_DERIVED_DEMAND_CACHE_VERSION || entry?.key !== key
          || !(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength > maxEntryBytes
          || !Number.isSafeInteger(entry.rawBytes) || entry.rawBytes < 0 || entry.rawBytes > maxRawEntryBytes) {
          stats.misses++; return null;
        }
        const reader = new Blob([entry.bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
        const chunks = []; let length = 0;
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > entry.rawBytes) { await reader.cancel(); throw new Error('Derived demand cache exceeds its size bound'); }
          chunks.push(value);
        }
        const raw = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
        if (raw.byteLength !== entry.rawBytes || await digest(raw) !== entry.digest) throw new Error('Derived demand cache integrity mismatch');
        const value = JSON.parse(new TextDecoder().decode(raw));
        stats.hits++; return value;
      } catch (error) { fail(error); stats.misses++; return null; }
    },
    async write(key, value) {
      try {
        const raw = new TextEncoder().encode(JSON.stringify(value));
        stats.lastRawBytes = raw.byteLength;
        if (raw.byteLength > maxRawEntryBytes) { stats.oversized++; return false; }
        const bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        stats.lastStoredBytes = bytes.byteLength;
        if (bytes.byteLength > maxEntryBytes) { stats.oversized++; return false; }
        await store.write(key, { version: STARTUP_DERIVED_DEMAND_CACHE_VERSION, key, bytes, rawBytes: raw.byteLength, digest: await digest(raw), at: Date.now() });
        stats.writes++; return true;
      } catch (error) { fail(error); return false; }
    },
    snapshot: () => ({ version: STARTUP_DERIVED_DEMAND_CACHE_VERSION, maxEntryBytes, maxRawEntryBytes,
      maxTotalBytes: MAX_TOTAL_BYTES, maxEntries: MAX_ENTRIES, ...stats }),
  };
}
