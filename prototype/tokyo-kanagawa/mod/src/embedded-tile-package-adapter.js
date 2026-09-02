// Compatibility binding for behavioral tests; the implementation is platform-owned.
import {
  EmbeddedTilePackageAdapter as PlatformEmbeddedTilePackageAdapter,
} from '../../../../open-world-platform/src/runtime/embedded-tile-package-adapter.js';
import { tileById } from './tile-catalog.js';

export {
  createOffMainThreadJsonDecoder,
  createOffMainThreadNativeDemandEvaluator,
  resolveRendererDataUrl,
} from '../../../../open-world-platform/src/runtime/embedded-tile-package-adapter.js';

export class EmbeddedTilePackageAdapter extends PlatformEmbeddedTilePackageAdapter {
  constructor(tileIds, embeddedData, options = {}) {
    super(tileIds, embeddedData, { tileById, worldLabel: 'Tokyo–Kanagawa', ...options });
  }
}
