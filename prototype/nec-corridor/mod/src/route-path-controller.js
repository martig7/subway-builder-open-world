// Compatibility binding for behavioral tests; the implementation is platform-owned.
import { createOpenWorldRoutePaths } from '../../../../open-world-platform/src/runtime/route-path-controller.js';

export { shortestTilePath } from '../../../../open-world-platform/src/runtime/route-path-controller.js';

export function createNecRoutePaths(options = {}) {
  return createOpenWorldRoutePaths({
    ...options,
    nativePopPrefixes: ['nec-native-pop-'],
    crossPopPrefixes: ['nec-cross-pop-'],
  });
}
