import { calculateCrossTileModeShares, createBoundedCrossTileRoutingCache, CROSS_ROUTING_CACHE_VERSION } from './cross-tile-mode-choice.js';
import { runRoutingJob } from './routing-job-queue.js';
import { assertNativeDemandMemoryBudget } from './embedded-tile-package-adapter.js';

/** One allocation slot per calculation; crashed workers never retry in the main heap. */
export function createCrossModeShareEvaluator({
  workerSource,
  WorkerClass = globalThis.Worker,
  BlobClass = globalThis.Blob,
  createObjectURL = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
  revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
  readMemory = () => globalThis.__openWorldRendererMemoryDiagnostics__?.sample?.('cross-demand.admission'),
} = {}) {
  let worker = null;
  let objectUrl = null;
  let unavailable = false;
  let disposed = false;
  let sequence = 0;
  let workerFailure = null;
  const pending = new Map();
  const routingCache = createBoundedCrossTileRoutingCache();
  const stats = { version: CROSS_ROUTING_CACHE_VERSION, workerEvaluations: 0, fallbackEvaluations: 0, latestError: null, latestRoutingStats: null };

  const release = () => {
    worker?.terminate?.(); worker = null;
    if (objectUrl) revokeObjectURL?.(objectUrl);
    objectUrl = null;
  };
  const fail = (error) => {
    workerFailure = error;
    unavailable = true;
    stats.latestError = error.message;
    release();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const ensureWorker = () => {
    if (worker || unavailable || disposed) return worker;
    if (!workerSource || typeof WorkerClass !== 'function' || typeof BlobClass !== 'function' || !createObjectURL) {
      unavailable = true;
      return null;
    }
    try {
      objectUrl = createObjectURL(new BlobClass([workerSource], { type: 'text/javascript' }));
      worker = new WorkerClass(objectUrl, { name: 'open-world-cross-mode-share-worker' });
      worker.onmessage = ({ data }) => {
        if (data?.type === 'ready') return;
        const request = pending.get(data?.id);
        if (!request) return;
        if (data.type === 'fare-requests') {
          try {
            const stations = new Map(data.stations);
            const quotes = data.requests.map(({ key, stationRoutes }) => {
              const quote = request.journeyFare(stationRoutes, stations);
              // Mode choice and settlement need no diagnostic breakdown payload.
              return [key, { total: quote?.total, revenueByRoute: quote?.revenueByRoute }];
            });
            worker.postMessage({ id: data.id, type: 'fare-quotes', quotes });
          } catch (error) {
            pending.delete(data.id);
            try { worker?.postMessage({ id: data.id, type: 'cancel' }); } catch {}
            request.reject(error);
          }
          return;
        }
        pending.delete(data.id);
        if (data.ok) request.resolve(data.value);
        else request.reject(new Error(data.error?.message ?? 'Cross-mode share worker failed'));
      };
      worker.onerror = (event) => fail(new Error(event?.message ?? 'Cross-mode share worker crashed'));
      worker.onmessageerror = () => fail(new Error('Cross-mode share worker response could not be decoded'));
    } catch (error) { fail(error); }
    return worker;
  };

  const evaluate = async input => {
      assertNativeDemandMemoryBudget(readMemory());
      if (disposed) throw new Error('Cross-mode share evaluator was disposed');
      if (workerFailure) throw workerFailure;
      const activeWorker = ensureWorker();
      if (activeWorker) {
        const id = ++sequence;
        const { journeyFare, tileCatalog, ...transferInput } = input;
        // Routing uses tile adjacency and rectangular bounds. Display geometry
        // and its LODs can be tens of megabytes and must stay in the renderer.
        if (tileCatalog != null) transferInput.tileCatalog = {
          tiles: (tileCatalog.tiles ?? []).map(tile => ({
            id: tile.id, bounds: tile.bounds,
            neighbors: (tile.neighbors ?? []).map(neighbor => ({ tileId: neighbor.tileId })),
          })),
        };
        try {
          const value = await new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject, journeyFare });
            try { activeWorker.postMessage({ id, type: 'evaluate', input: transferInput, quoteFares: typeof journeyFare === 'function' }); }
            catch (error) { pending.delete(id); reject(error); }
          });
          stats.workerEvaluations++;
          stats.latestRoutingStats = value.routingStats;
          return value;
        } catch (error) {
          stats.latestError = error.message;
          throw error;
        }
      }
      if (workerFailure) throw workerFailure;
      if (disposed) throw new Error('Cross-mode share evaluator was disposed');
      stats.fallbackEvaluations++;
      const value = calculateCrossTileModeShares({ ...input, routingCache });
      stats.latestRoutingStats = value.routingStats;
      return value;
  };
  return {
    evaluate: input => runRoutingJob(async () => {
      try { return await evaluate(input); }
      finally {
        // Return committed pages before handing the allocation slot to another job.
        if (!pending.size) release();
      }
    }),
    diagnostics: () => ({ ...stats, pending: pending.size }),
    dispose() {
      if (disposed) return;
      disposed = true;
      routingCache.clear();
      release();
      for (const request of pending.values()) request.reject(new Error('Cross-mode share evaluator was disposed'));
      pending.clear();
    },
  };
}
