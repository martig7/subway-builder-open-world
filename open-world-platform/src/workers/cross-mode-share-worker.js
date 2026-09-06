import { calculateCrossTileModeShares, prepareCrossTileModeShares, finishCrossTileModeShares } from '../runtime/cross-tile-mode-choice.js';

export const CROSS_MODE_SHARE_WORKER_MARKER = 'open-world-cross-mode-share-worker-v1';

/** Fare callbacks remain on the native host; only their compact results cross back. */
export function createCrossModeShareWorkerHandler(postMessage) {
  const prepared = new Map();
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
        const batch = prepareCrossTileModeShares(input);
        if (batch.fareRequests.length) {
          prepared.set(id, batch);
          postMessage({ id, type: 'fare-requests', requests: batch.fareRequests, stations: batch.stations });
          return;
        }
        value = finishCrossTileModeShares(batch);
      } else if (type === 'evaluate') {
        value = calculateCrossTileModeShares(input);
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
