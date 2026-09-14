import { nativeDemandEvaluationBatches, mergeNativeDemandProfiles } from './off-tile-native-demand.js';
import { createCrossTileRoutingCache } from './cross-tile-mode-choice.js';
import { ACTIVE_DEMAND_DISK_CACHE_VERSION } from './active-demand-disk-cache.js';

export const NATIVE_DEMAND_WORKER_MEMORY_VERSION = 'native-demand-worker-memory-v2';
export const NATIVE_DEMAND_WORKER_CACHE_LIMITS = Object.freeze({
  maxSearchLabels: 8000, maxPaths: 1024, maxCatchments: 4096,
});
const MAX_DISK_BYTES = 256 * 1024 * 1024;
const MAX_CHUNKS = 4096;

async function decodeDemand(bytes, gzip) {
  const input = new Uint8Array(bytes);
  const text = gzip
    ? await new Response(new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(input);
  return JSON.parse(text);
}

// Called serially by the client. No raw demand, graph, assignments or search
// labels survive a completed job. Only a small chunk is cloned to IDB at once.
export async function runNativeDemandWorkerJob({ bytes, gzip = false, input, cacheMode = null }, {
  store, emitAssignments = () => {}, resetAssignments = () => {},
  digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), byte => byte.toString(16).padStart(2, '0')).join(''),
  evaluateBatches = nativeDemandEvaluationBatches,
} = {}) {
  const routingCache = createCrossTileRoutingCache(NATIVE_DEMAND_WORKER_CACHE_LIMITS);
  let disk = Boolean(cacheMode && store), key = null, cacheError = null;
  if (disk) {
    try {
      key = `${ACTIVE_DEMAND_DISK_CACHE_VERSION}:${await digest(bytes)}:${await digest(new TextEncoder().encode(JSON.stringify(input)))}`;
      const manifest = await store.read('manifest');
      if (manifest?.key === key && Number.isInteger(manifest.chunks) && manifest.chunks > 0
        && manifest.chunks <= MAX_CHUNKS && manifest.bytes <= MAX_DISK_BYTES) {
        let cachedProfile = null;
        for (let index = 0; index < manifest.chunks; index++) {
          const chunk = await store.read(index);
          if (!chunk) throw new Error('Incomplete demand disk cache');
          const value = JSON.parse(await new Response(new Blob([chunk]).stream()
            .pipeThrough(new DecompressionStream('gzip'))).text());
          if (!Array.isArray(value.assignments) || value.profile?.hourly?.length !== 24) throw new Error('Invalid demand cache chunk');
          cachedProfile = mergeNativeDemandProfiles(cachedProfile, value.profile);
          if (cacheMode === 'assignments') emitAssignments(value.assignments);
        }
        return { status: 'cached', profile: cachedProfile, diskCache: 'hit', cacheBytes: manifest.bytes };
      }
      await store.clear();
    } catch (error) {
      cacheError = String(error.message); disk = false; resetAssignments();
    }
  }
  let profile = null, chunks = 0, cacheBytes = 0;
  try {
    const demand = await decodeDemand(bytes, gzip);
    for (const batch of evaluateBatches({ ...input, demand, routingCache })) {
      profile = mergeNativeDemandProfiles(profile, batch.profile);
      if (disk) {
        try {
          // Route lists repeat heavily across assignments. Compress only this
          // bounded batch, so a large tile fits on disk without a large buffer.
          const encoded = new Uint8Array(await new Response(new Blob([
            JSON.stringify({ assignments: batch.assignments, profile: batch.profile }),
          ]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
          cacheBytes += encoded.byteLength;
          if (cacheBytes > MAX_DISK_BYTES - 1024 || chunks >= MAX_CHUNKS) throw new Error('Demand disk cache size limit reached');
          await store.write(chunks, encoded);
        } catch (error) { disk = false; cacheError = String(error.message); }
      }
      if (cacheMode === 'assignments') emitAssignments(batch.assignments);
      chunks++;
    }
    if (disk) {
      try { await store.write('manifest', { key, chunks, bytes: cacheBytes }); }
      catch (error) { disk = false; cacheError = String(error.message); }
    }
    return { status: 'evaluated', profile, diskCache: cacheMode ? disk ? 'written' : 'unavailable' : 'unused',
      cacheBytes, cacheError, batchSize: input.batchSize ?? 128, batches: chunks };
  } finally { routingCache.clear(); }
}
