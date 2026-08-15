import { deepCopy } from '../world-model.js';

export class MemoryTilePackageAdapter {
  constructor(packages) { this.packages = new Map(Object.entries(packages)); }
  tileIds() { return [...this.packages.keys()]; }
  async prepare(tileId) {
    const pkg = this.packages.get(tileId);
    if (!pkg) throw new Error(`Tile package is missing: ${tileId}`);
    if (pkg.valid === false) throw new Error(`Tile package validation failed: ${tileId}`);
    if (pkg.manifest?.tileId && pkg.manifest.tileId !== tileId) throw new Error(`Tile manifest identity mismatch: ${tileId}`);
    return deepCopy(pkg);
  }
  async loadCommuteCatalog(tileId) {
    const pkg = await this.prepare(tileId);
    return deepCopy(pkg.commuteCatalog ?? null);
  }
  async loadCrossDemand(tileId) {
    const pkg = await this.prepare(tileId);
    return deepCopy(pkg.crossDemand ?? null);
  }
  async loadNativeDemand(tileId) {
    const pkg = await this.prepare(tileId);
    return deepCopy(pkg.nativeDemand ?? null);
  }
}
