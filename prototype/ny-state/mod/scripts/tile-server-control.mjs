// Compatibility binding for existing diagnostics; the implementation is platform-owned.
import definition from '../../../../worlds/ny-state/world.json' with { type: 'json' };
import {
  ensureTileServerReady as ensurePlatformTileServerReady,
  NATIVE_PMTILES_SERVER_VERSION,
  stopTileServer as stopPlatformTileServer,
  tileServerBaseUrl,
  tileServerHealthUrl as platformHealthUrl,
} from '../../../../open-world-platform/src/installer/tile-server-control.js';

export { NATIVE_PMTILES_SERVER_VERSION };
export const DEFAULT_TILE_SERVER_BASE = tileServerBaseUrl(definition);
export const tileServerHealthUrl = (baseUrl = DEFAULT_TILE_SERVER_BASE) => platformHealthUrl(definition, baseUrl);
export const ensureTileServerReady = (options = {}) => ensurePlatformTileServerReady({ definition, ...options });
export const stopTileServer = (options = {}) => stopPlatformTileServer({ definition, ...options });
