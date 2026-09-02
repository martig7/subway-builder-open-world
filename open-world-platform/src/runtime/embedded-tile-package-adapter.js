import { projectOffTileNativeDemandTransferInput } from './off-tile-native-demand.js';

const DEMAND_JSON_DECODER_VERSION = 1;
const DEMAND_JSON_DECODER_STATE = '__openWorldDemandJsonDecoder';
const NATIVE_DEMAND_EVALUATOR_VERSION = 1;
const NATIVE_DEMAND_EVALUATOR_STATE = '__openWorldNativeDemandEvaluator';
const NATIVE_DEMAND_EVALUATOR_WORKER_NAME = 'open-world-native-demand-worker-evaluator-v1';

function demandJsonWorkerMain() {
  self.onmessage = async ({ data }) => {
    const { id, bytes, gzip } = data ?? {};
    try {
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
      self.postMessage({ id, ok: true, value: JSON.parse(text) });
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
  self.postMessage({ type: 'ready' });
}

const DEMAND_JSON_WORKER_SOURCE = `(${demandJsonWorkerMain.toString()})();`;

async function decodeJsonBytesOnMainThread(bytes, { gzip = false } = {}) {
  let text;
  if (gzip) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This game runtime cannot decompress native demand data');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(bytes);
  }
  return JSON.parse(text);
}

/** Keep gzip inflation and JSON.parse out of the Electron renderer event loop. */
export function createOffMainThreadJsonDecoder({
  WorkerClass = globalThis.Worker,
  BlobClass = globalThis.Blob,
  createObjectURL = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
  revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
} = {}) {
  let worker = null;
  let workerUrl = null;
  let workerUnavailable = false;
  let workerReady = null;
  let resolveWorkerReady = null;
  let nextRequestId = 1;
  const pending = new Map();

  const rejectPending = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const releaseWorker = () => {
    worker?.terminate?.();
    worker = null;
    resolveWorkerReady?.(null);
    workerReady = null;
    resolveWorkerReady = null;
    if (workerUrl && typeof revokeObjectURL === 'function') revokeObjectURL(workerUrl);
    workerUrl = null;
  };
  const ensureWorker = () => {
    if (worker || workerUnavailable) return worker;
    if (typeof WorkerClass !== 'function'
      || typeof BlobClass !== 'function'
      || typeof createObjectURL !== 'function') {
      workerUnavailable = true;
      return null;
    }
    try {
      workerUrl = createObjectURL(new BlobClass([DEMAND_JSON_WORKER_SOURCE], {
        type: 'text/javascript',
      }));
      worker = new WorkerClass(workerUrl, { name: 'nec-demand-json-decoder' });
      workerReady = new Promise((resolve) => { resolveWorkerReady = resolve; });
      worker.onmessage = ({ data }) => {
        if (data?.type === 'ready') {
          resolveWorkerReady?.(worker);
          resolveWorkerReady = null;
          return;
        }
        const request = pending.get(data?.id);
        if (!request) return;
        pending.delete(data.id);
        if (data.ok) request.resolve(data.value);
        else {
          const error = new Error(data?.error?.message ?? 'Demand JSON worker failed');
          error.name = data?.error?.name ?? 'Error';
          if (data?.error?.stack) error.stack = data.error.stack;
          request.reject(error);
        }
      };
      worker.onerror = (event) => {
        const error = new Error(event?.message ?? 'Demand JSON worker crashed');
        rejectPending(error);
        releaseWorker();
        workerUnavailable = true;
      };
    } catch {
      releaseWorker();
      workerUnavailable = true;
    }
    return worker;
  };

  const decode = async (bytes, { gzip = false } = {}) => {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const candidateWorker = ensureWorker();
    if (!candidateWorker) return decodeJsonBytesOnMainThread(input, { gzip });
    const activeWorker = await workerReady;
    if (!activeWorker) return decodeJsonBytesOnMainThread(input, { gzip });
    const transferable = input.byteOffset === 0 && input.byteLength === input.buffer.byteLength
      ? input
      : input.slice();
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        activeWorker.postMessage(
          { id, bytes: transferable.buffer, gzip },
          [transferable.buffer],
        );
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  };

  const dispose = () => {
    rejectPending(new Error('Demand JSON worker was disposed'));
    releaseWorker();
  };

  return { decode, dispose };
}

/**
 * Inflate, parse, and evaluate native demand inside a dedicated worker. Only
 * the compact evaluator result is cloned back into the Electron renderer.
 */
export function createOffMainThreadNativeDemandEvaluator({
  WorkerClass = globalThis.Worker,
  BlobClass = globalThis.Blob,
  createObjectURL = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
  revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
  workerSource = null,
} = {}) {
  let worker = null;
  let workerUrl = null;
  let workerUnavailable = false;
  let workerReady = null;
  let resolveWorkerReady = null;
  let nextRequestId = 1;
  const pending = new Map();

  const rejectPending = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const releaseWorker = () => {
    worker?.terminate?.();
    worker = null;
    resolveWorkerReady?.(null);
    workerReady = null;
    resolveWorkerReady = null;
    if (workerUrl && typeof revokeObjectURL === 'function') revokeObjectURL(workerUrl);
    workerUrl = null;
  };
  const ensureWorker = () => {
    if (worker || workerUnavailable) return worker;
    if (typeof WorkerClass !== 'function'
      || typeof BlobClass !== 'function'
      || typeof createObjectURL !== 'function'
      || typeof workerSource !== 'string'
      || workerSource.length === 0) {
      workerUnavailable = true;
      return null;
    }
    try {
      workerUrl = createObjectURL(new BlobClass([workerSource], { type: 'text/javascript' }));
      worker = new WorkerClass(workerUrl, { name: NATIVE_DEMAND_EVALUATOR_WORKER_NAME });
      workerReady = new Promise((resolve) => { resolveWorkerReady = resolve; });
      worker.onmessage = ({ data }) => {
        if (data?.type === 'ready') {
          resolveWorkerReady?.(worker);
          resolveWorkerReady = null;
          return;
        }
        const request = pending.get(data?.id);
        if (!request) return;
        pending.delete(data.id);
        if (data.ok) request.resolve(data.value);
        else {
          const error = new Error(data?.error?.message ?? 'Native demand evaluator worker failed');
          error.name = data?.error?.name ?? 'Error';
          if (data?.error?.stack) error.stack = data.error.stack;
          request.reject(error);
        }
      };
      worker.onerror = (event) => {
        const error = new Error(event?.message ?? 'Native demand evaluator worker crashed');
        rejectPending(error);
        releaseWorker();
        workerUnavailable = true;
      };
    } catch {
      releaseWorker();
      workerUnavailable = true;
    }
    return worker;
  };

  const evaluate = async (bytes, input, { gzip = false } = {}) => {
    const candidateWorker = ensureWorker();
    if (!candidateWorker) return null;
    const activeWorker = await workerReady;
    if (!activeWorker) return null;
    const sourceBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const transferable = sourceBytes.byteOffset === 0
      && sourceBytes.byteLength === sourceBytes.buffer.byteLength
      ? sourceBytes
      : sourceBytes.slice();
    const id = nextRequestId++;
    const compactInput = projectOffTileNativeDemandTransferInput(input);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        activeWorker.postMessage(
          { id, bytes: transferable.buffer, gzip, input: compactInput },
          [transferable.buffer],
        );
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  };

  const dispose = () => {
    rejectPending(new Error('Native demand evaluator worker was disposed'));
    releaseWorker();
  };

  return { evaluate, dispose };
}

function sharedDemandJsonDecoder() {
  const existing = globalThis[DEMAND_JSON_DECODER_STATE];
  if (existing?.version === DEMAND_JSON_DECODER_VERSION && existing.decoder) {
    return existing.decoder;
  }
  existing?.decoder?.dispose?.();
  const decoder = createOffMainThreadJsonDecoder();
  globalThis[DEMAND_JSON_DECODER_STATE] = {
    version: DEMAND_JSON_DECODER_VERSION,
    decoder,
  };
  return decoder;
}

function sharedNativeDemandEvaluator(workerSource = null) {
  const existing = globalThis[NATIVE_DEMAND_EVALUATOR_STATE];
  if (existing?.version === NATIVE_DEMAND_EVALUATOR_VERSION
    && existing?.workerSource === workerSource
    && existing.evaluator) {
    return existing.evaluator;
  }
  existing?.evaluator?.dispose?.();
  const evaluator = createOffMainThreadNativeDemandEvaluator({ workerSource });
  globalThis[NATIVE_DEMAND_EVALUATOR_STATE] = {
    version: NATIVE_DEMAND_EVALUATOR_VERSION,
    workerSource,
    evaluator,
  };
  return evaluator;
}

function decodeBase64(base64) {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Resolve native city data against the game's randomized HTTP asset server.
 * The Electron renderer itself is loaded from file://, so root-relative fetches
 * otherwise become file:///C:/data/... and can never reach the asset server.
 */
export function resolveRendererDataUrl(path, {
  resourceEntries = globalThis.performance?.getEntriesByType?.('resource') ?? [],
  locationHref = globalThis.location?.href ?? '',
} = {}) {
  for (let index = resourceEntries.length - 1; index >= 0; index -= 1) {
    try {
      const resource = new URL(resourceEntries[index]?.name);
      if (
        (resource.protocol === 'http:' || resource.protocol === 'https:')
        && resource.pathname.startsWith('/data/')
      ) {
        return new URL(path, `${resource.origin}/`).href;
      }
    } catch {
      // Performance entries can contain non-URL names. Keep looking.
    }
  }

  try {
    const renderer = new URL(locationHref);
    if (renderer.protocol === 'http:' || renderer.protocol === 'https:') {
      return new URL(path, `${renderer.origin}/`).href;
    }
  } catch {
    // Fall through to the actionable error below.
  }

  throw new Error(`Renderer data HTTP origin is unavailable: ${path}`);
}

/** Native map files stay under /data/<city>; cross-tile runtime data is bundled. */
export class EmbeddedTilePackageAdapter {
  constructor(tileIds, embeddedData, {
    tileById,
    worldLabel = 'Open World',
    loadCityData = null,
    fetchData = null,
    resolveDataUrl = (path) => path,
    decodeJsonBytes = null,
    evaluateNativeDemandBytes = null,
    nativeDemandWorkerSource = null,
  } = {}) {
    if (!(tileById instanceof Map)) throw new Error('Embedded Tile Package Adapter requires a Tile View index');
    this.catalogTileIds = [...tileIds]; this.prepared = new Map();
    this.tileById = tileById;
    this.worldLabel = worldLabel;
    this.embeddedData = embeddedData;
    this.crossDemandBase = null;
    this.loadCityData = loadCityData;
    this.fetchData = fetchData;
    this.resolveDataUrl = resolveDataUrl;
    this.decodeJsonBytes = decodeJsonBytes ?? sharedDemandJsonDecoder().decode;
    this.evaluateNativeDemandBytes = evaluateNativeDemandBytes
      ?? sharedNativeDemandEvaluator(nativeDemandWorkerSource).evaluate;
    this.nativeDemand = new Map();
  }
  tileIds() { return [...this.catalogTileIds]; }
  canSkipNativeDemandForUnservedTile(tileId) {
    this.#assertTile(tileId);
    // Every installed Tile View has a native demand package. A tile with no
    // localized route service is therefore known to produce zero transit
    // revenue without inflating that package in the renderer.
    return true;
  }
  async prepare(tileId) {
    if (!this.catalogTileIds.includes(tileId)) throw new Error(`Unknown ${this.worldLabel} Tile View: ${tileId}`);
    if (!this.prepared.has(tileId)) {
      const tile = this.tileById.get(tileId);
      this.prepared.set(tileId, {
        manifest: {
          schemaVersion: 1,
          tileId,
          cityCode: tile.gameCityCode ?? tile.id,
          viewport: tile.initialViewState,
          dataFiles: {
            demandData: 'demand_data.json.gz',
            buildingsIndex: 'buildings_index.bin.gz',
            roads: 'roads.geojson.gz',
            runwaysTaxiways: 'runways_taxiways.geojson.gz',
          },
          runtimeFiles: {
            schemaVersion: 1,
            crossCommutes: { path: 'cross_commutes.json', encoding: 'canonical-json' },
            crossDemand: { path: 'cross_demand.json.gz', encoding: 'gzip-json' },
          },
          assets: [],
        },
        assets: [],
      });
    }
    return this.prepared.get(tileId);
  }
  async loadCommuteCatalog(tileId) {
    this.#assertTile(tileId);
    if (!this.embeddedData?.commuteCatalog) throw new Error(`Embedded ${this.worldLabel} commute catalog is unavailable`);
    return { ...this.embeddedData.commuteCatalog, tileId };
  }
  async loadCrossDemand(tileId) {
    this.#assertTile(tileId);
    if (!this.crossDemandBase) this.crossDemandBase = this.#decodeCrossDemand();
    return { ...await this.crossDemandBase, tileId };
  }
  async loadNativeDemand(tileId) {
    this.#assertTile(tileId);
    if (typeof this.fetchData !== 'function' && typeof this.loadCityData !== 'function') return null;
    if (!this.nativeDemand.has(tileId)) {
      const path = `/data/${tileId}/demand_data.json.gz`;
      const read = typeof this.fetchData === 'function'
        ? this.#fetchNativeDemand(path)
        : Promise.resolve(this.loadCityData(path));
      const pending = read
        .then((data) => {
          if (!Array.isArray(data?.points) || !Array.isArray(data?.pops)) {
            throw new Error(`Invalid native demand package: ${tileId}`);
          }
          return data;
        })
        .catch((error) => { this.nativeDemand.delete(tileId); throw error; });
      this.nativeDemand.set(tileId, pending);
    }
    return this.nativeDemand.get(tileId);
  }
  async evaluateNativeDemand(input) {
    const tileId = input?.tileId;
    this.#assertTile(tileId);
    if (typeof this.fetchData !== 'function') return null;
    const bytes = await this.#fetchNativeDemandBytes(`/data/${tileId}/demand_data.json.gz`);
    return this.evaluateNativeDemandBytes(bytes, input, {
      gzip: bytes[0] === 0x1f && bytes[1] === 0x8b,
    });
  }
  async loadRoadBytes(tileId) {
    this.#assertTile(tileId);
    if (typeof this.fetchData !== 'function') throw new Error(`${this.worldLabel} road data fetch is unavailable`);
    const url = this.resolveDataUrl(`/data/${tileId}/roads.geojson.gz`);
    const response = await this.fetchData(url);
    if (!response?.ok) throw new Error(`Failed to fetch generated roads (${response?.status ?? 'unknown'}): ${url}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  async #fetchNativeDemand(path) {
    const bytes = await this.#fetchNativeDemandBytes(path);
    return this.decodeJsonBytes(bytes, { gzip: bytes[0] === 0x1f && bytes[1] === 0x8b });
  }
  async #fetchNativeDemandBytes(path) {
    const url = this.resolveDataUrl(path);
    const response = await this.fetchData(url);
    if (!response?.ok) throw new Error(`Failed to fetch native demand (${response?.status ?? 'unknown'}): ${url}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  #assertTile(tileId) {
    if (!this.catalogTileIds.includes(tileId)) throw new Error(`Unknown ${this.worldLabel} Tile View: ${tileId}`);
  }
  async #decodeCrossDemand() {
    if (this.embeddedData?.crossDemand) return this.embeddedData.crossDemand;
    const encoded = this.embeddedData?.crossDemandGzipBase64;
    if (!encoded) throw new Error(`Embedded ${this.worldLabel} cross-demand data is unavailable`);
    const bytes = decodeBase64(encoded);
    return this.decodeJsonBytes(bytes, { gzip: true });
  }
}
