import { evaluateOffTileNativeDemand } from '../runtime/off-tile-native-demand.js';
import { createCrossTileRoutingCache } from '../runtime/cross-tile-mode-choice.js';

const WORKER_MARKER = 'open-world-native-demand-worker-evaluator-v1';
const routingCache = createCrossTileRoutingCache();

async function decodeDemand(bytes, gzip) {
  const input = new Uint8Array(bytes);
  let text;
  if (gzip) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This game runtime cannot decompress native demand data');
    }
    const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(input);
  }
  return JSON.parse(text);
}

self.onmessage = async ({ data }) => {
  const { id, bytes, gzip, input } = data ?? {};
  try {
    const demand = await decodeDemand(bytes, gzip);
    const value = evaluateOffTileNativeDemand({ ...input, demand, routingCache });
    self.postMessage({ id, ok: true, value });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: {
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        stack: error?.stack ?? null,
      },
    });
  }
};

self.postMessage({ type: 'ready', marker: WORKER_MARKER });
