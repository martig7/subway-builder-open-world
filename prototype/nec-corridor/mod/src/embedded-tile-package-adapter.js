import { tileById } from './tile-catalog.js';

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
    loadCityData = null,
    fetchData = null,
    resolveDataUrl = (path) => path,
  } = {}) {
    this.catalogTileIds = [...tileIds]; this.prepared = new Map();
    this.embeddedData = embeddedData;
    this.crossDemandBase = null;
    this.loadCityData = loadCityData;
    this.fetchData = fetchData;
    this.resolveDataUrl = resolveDataUrl;
    this.nativeDemand = new Map();
  }
  tileIds() { return [...this.catalogTileIds]; }
  async prepare(tileId) {
    if (!this.catalogTileIds.includes(tileId)) throw new Error(`Unknown NEC Corridor tile: ${tileId}`);
    if (!this.prepared.has(tileId)) {
      const tile = tileById.get(tileId);
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
    if (!this.embeddedData?.commuteCatalog) throw new Error('Embedded NEC commute catalog is unavailable');
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
  async #fetchNativeDemand(path) {
    const url = this.resolveDataUrl(path);
    const response = await this.fetchData(url);
    if (!response?.ok) throw new Error(`Failed to fetch native demand (${response?.status ?? 'unknown'}): ${url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let text;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream !== 'function') throw new Error('This game runtime cannot decompress native demand data');
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      text = await new Response(stream).text();
    } else {
      text = new TextDecoder().decode(bytes);
    }
    return JSON.parse(text);
  }
  #assertTile(tileId) {
    if (!this.catalogTileIds.includes(tileId)) throw new Error(`Unknown NEC Corridor tile: ${tileId}`);
  }
  async #decodeCrossDemand() {
    if (this.embeddedData?.crossDemand) return this.embeddedData.crossDemand;
    const encoded = this.embeddedData?.crossDemandGzipBase64;
    if (!encoded) throw new Error('Embedded NEC cross-demand data is unavailable');
    if (typeof DecompressionStream !== 'function') throw new Error('This game runtime cannot decompress cross-demand data');
    const bytes = decodeBase64(encoded);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
}
