export { WorldTileRuntime } from './world-tile-runtime.js';
export { FakeGameAdapter } from './adapters/fake-game-adapter.js';
export { SubwayBuilderGameAdapter } from './adapters/subway-builder-game-adapter.js';
export { MemoryTilePackageAdapter } from './adapters/memory-tile-package-adapter.js';
export { HttpTilePackageAdapter } from './adapters/http-tile-package-adapter.js';
export { ModStorageWorldStateAdapter } from './adapters/mod-storage-world-state-adapter.js';
export { registerPrototypePanel } from './ui/prototype-panel.js';
export { advanceCommutesTo, applyModeShares, assertCommuteLedger, projectCommutesForTile, registerCommuteCatalog } from './cross-tile-commute-engine.js';
export { calculateCrossTileModeShares, chooseModes, createNetworkProfile, distanceMetres, inspectCrossTileModeChoice } from './cross-tile-mode-choice.js';
export { evaluateOffTileNativeDemand } from './off-tile-native-demand.js';
export { CrossDemandModel, demandPointRadius, modeShareColor } from './cross-demand-model.js';
export { registerCrossDemandViewer } from './ui/cross-demand-viewer.js';

/** Opt-in bootstrap: callers must supply compiled packages and can decide where to persist state. */
export async function bootstrapPrototype({ runtime, api, navigation, mountPanel = true, worldId = 'kc-two-tile' }) {
  await runtime.boot(worldId);
  return mountPanel && typeof document !== 'undefined'
    ? (await import('./ui/prototype-panel.js')).registerPrototypePanel({ runtime, api, navigation })
    : runtime.view();
}
