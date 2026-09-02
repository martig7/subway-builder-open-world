/** Loads manifest-first packages. Hash verification is delegated to a supplied verifier. */
export class HttpTilePackageAdapter {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, verify = async () => true, assetValidation = 'full', tileIds = [] }) {
    if (!['full', 'manifest'].includes(assetValidation)) throw new Error(`Unknown asset validation mode: ${assetValidation}`);
    this.baseUrl = baseUrl.replace(/\/$/, '');
    // Window.fetch is brand-checked in the game renderer. Retaining it as an
    // object method changes its receiver to this adapter and throws
    // "Illegal invocation"; bind it while the Window/global receiver is known.
    this.fetch = fetchImpl.bind(globalThis);
    this.verify = verify; this.assetValidation = assetValidation;
    this.catalogTileIds = [...tileIds];
    this.prepared = new Map(); this.commuteCatalogs = new Map(); this.crossDemand = new Map(); this.nativeDemand = new Map();
  }
  tileIds() { return [...this.catalogTileIds]; }
  async prepare(tileId) {
    if (this.prepared.has(tileId)) return this.prepared.get(tileId);
    const pending = this.#prepare(tileId).catch((error) => { this.prepared.delete(tileId); throw error; });
    this.prepared.set(tileId, pending);
    return pending;
  }
  async #prepare(tileId) {
    const response = await this.fetch(`${this.baseUrl}/${encodeURIComponent(tileId)}/manifest.json`);
    if (!response.ok) throw new Error(`Tile manifest request failed (${response.status}) for ${tileId}`);
    const manifest = await response.json();
    if (manifest.tileId !== tileId || !manifest.schemaVersion || !Array.isArray(manifest.assets)) throw new Error(`Invalid tile manifest: ${tileId}`);
    const tileBase = `${this.baseUrl}/${encodeURIComponent(tileId)}`;
    const declaredAssets = new Set(manifest.assets.map((asset) => asset.path));
    for (const [key, value] of Object.entries(manifest.dataFiles ?? {})) {
      if (!/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value) && !declaredAssets.has(value)) throw new Error(`Tile data file is absent from manifest assets: ${key}`);
    }
    for (const [key, descriptor] of Object.entries(manifest.runtimeFiles ?? {}).filter(([key]) => key !== 'schemaVersion')) {
      if (!descriptor?.path || !declaredAssets.has(descriptor.path)) throw new Error(`Tile runtime file is absent from manifest assets: ${key}`);
    }
    if (this.assetValidation === 'manifest') {
      return { manifest, assets: manifest.assets.map((asset) => ({ ...asset, verified: false })) };
    }
    const assets = [];
    for (const asset of manifest.assets) {
      const result = await this.fetch(`${tileBase}/${asset.path}`);
      if (!result.ok) throw new Error(`Asset request failed: ${asset.path}`);
      const bytes = new Uint8Array(await result.arrayBuffer());
      if (!await this.verify(asset, bytes)) throw new Error(`Checksum mismatch: ${asset.path}`);
      // Do not retain large asset buffers. The game reads its installed copies
      // through /data/<city>/...; this host is only the package validation seam.
      assets.push({ ...asset, verified: true });
    }
    return { manifest, assets };
  }

  async loadCommuteCatalog(tileId) {
    if (this.commuteCatalogs.has(tileId)) return this.commuteCatalogs.get(tileId);
    const pending = this.#loadCommuteCatalog(tileId).catch((error) => { this.commuteCatalogs.delete(tileId); throw error; });
    this.commuteCatalogs.set(tileId, pending);
    return pending;
  }

  async #loadCommuteCatalog(tileId) {
    const pkg = await this.prepare(tileId);
    const crossDescriptor = pkg.manifest.runtimeFiles?.crossCommutes;
    const gatesDescriptor = pkg.manifest.runtimeFiles?.gates;
    if (!crossDescriptor?.path) return null;
    const [summary, gateways] = await Promise.all([
      this.#readRuntimeJson(tileId, crossDescriptor),
      gatesDescriptor?.path ? this.#readRuntimeJson(tileId, gatesDescriptor) : Promise.resolve([]),
    ]);
    if (summary.tileId && summary.tileId !== tileId) throw new Error(`Cross-commute catalog identity mismatch: ${tileId}`);
    return { ...summary, gateways };
  }

  async loadCrossDemand(tileId) {
    if (this.crossDemand.has(tileId)) return this.crossDemand.get(tileId);
    const pending = this.#loadCrossDemand(tileId).catch((error) => { this.crossDemand.delete(tileId); throw error; });
    this.crossDemand.set(tileId, pending);
    return pending;
  }

  async #loadCrossDemand(tileId) {
    const pkg = await this.prepare(tileId);
    const descriptor = pkg.manifest.runtimeFiles?.crossDemand;
    if (!descriptor?.path) throw new Error(`Cross-demand viewer data is absent for ${tileId}`);
    const data = await this.#readRuntimeJson(tileId, descriptor);
    if (data.tileId && data.tileId !== tileId) throw new Error(`Cross-demand data identity mismatch: ${tileId}`);
    return data;
  }

  async loadNativeDemand(tileId) {
    if (this.nativeDemand.has(tileId)) return this.nativeDemand.get(tileId);
    const pending = this.#loadNativeDemand(tileId).catch((error) => { this.nativeDemand.delete(tileId); throw error; });
    this.nativeDemand.set(tileId, pending);
    return pending;
  }

  async #loadNativeDemand(tileId) {
    const pkg = await this.prepare(tileId);
    const path = pkg.manifest.dataFiles?.demandData;
    if (!path || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path)) return null;
    const asset = pkg.manifest.assets?.find((candidate) => candidate.path === path) ?? {};
    return this.#readRuntimeJson(tileId, {
      ...asset,
      path,
      encoding: path.endsWith('.gz') ? 'gzip-json' : 'json',
    });
  }

  async #readRuntimeJson(tileId, descriptor) {
    const response = await this.fetch(`${this.baseUrl}/${encodeURIComponent(tileId)}/${descriptor.path}`);
    if (!response.ok) throw new Error(`Runtime data request failed: ${descriptor.path}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!await this.verify(descriptor, bytes)) throw new Error(`Checksum mismatch: ${descriptor.path}`);
    if (descriptor.encoding !== 'gzip-json') return JSON.parse(new TextDecoder().decode(bytes));
    if (typeof DecompressionStream !== 'function') throw new Error('This game runtime cannot decompress tile data');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
}
