// Disposable derived data, separate from World Records and Native Saves. One
// committed generation replaces the previous one; chunks keep IDB clones small.
export const ACTIVE_DEMAND_DISK_CACHE_VERSION = 'active-demand-disk-cache-v1';
export function createActiveDemandDiskStore(indexedDB = globalThis.indexedDB) {
  let database = null;
  const open = () => database ??= new Promise((resolve, reject) => {
    if (!indexedDB) return reject(new Error('Demand disk cache is unavailable'));
    const request = indexedDB.open(ACTIVE_DEMAND_DISK_CACHE_VERSION, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('chunks');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Demand disk cache is blocked'));
  });
  const run = async (mode, operation) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('chunks', mode);
      const request = operation(transaction.objectStore('chunks'));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Demand cache transaction failed'));
    });
  };
  return {
    read: key => run('readonly', store => store.get(key)),
    write: (key, value) => run('readwrite', store => store.put(value, key)),
    clear: () => run('readwrite', store => store.clear()),
  };
}
