import { calculateCrossTileModeShares, prepareCrossTileModeShares, finishCrossTileModeShares, createCrossTileRoutingCache, CROSS_ROUTING_CACHE_VERSION } from '../runtime/cross-tile-mode-choice.js';

export const CROSS_MODE_SHARE_WORKER_MARKER = CROSS_ROUTING_CACHE_VERSION;

/** Fare callbacks remain on the native host; only their compact results cross back. */
export function createCrossModeShareWorkerHandler(postMessage) {
  const prepared = new Map();
  const routingCache = createCrossTileRoutingCache();
  return (message) => {
    const { id, type, input } = message ?? {};
    try {
      if (type === 'cancel') { prepared.delete(id); return; }
      let value;
      if (type === 'fare-quotes') {
        const batch = prepared.get(id);
        if (!batch) return;
        prepared.delete(id);
        value = finishCrossTileModeShares(batch, new Map(message.quotes));
      } else if (type === 'evaluate' && message.quoteFares) {
        const batch = prepareCrossTileModeShares({ ...input, routingCache });
        if (batch.fareRequests.length) {
          prepared.set(id, batch);
          postMessage({ id, type: 'fare-requests', requests: batch.fareRequests, stations: batch.stations });
          return;
        }
        value = finishCrossTileModeShares(batch);
      } else if (type === 'evaluate') {
        value = calculateCrossTileModeShares({ ...input, routingCache });
      } else return;
      postMessage({ id, ok: true, value });
    } catch (error) {
      prepared.delete(id);
      postMessage({ id, ok: false, error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) } });
    }
  };
}

if (typeof self !== 'undefined') {
  const handle = createCrossModeShareWorkerHandler(message => self.postMessage(message));
  self.onmessage = ({ data }) => handle(data);
  self.postMessage({ type: 'ready', marker: CROSS_MODE_SHARE_WORKER_MARKER });
}
