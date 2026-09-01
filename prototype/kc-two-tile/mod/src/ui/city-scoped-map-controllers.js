import { stabilizeMapLayerMoves } from '../map-layer-stability.js';

export const CITY_SCOPED_MAP_CONTROLLERS_VERSION = 'city-scoped-map-controllers-v2';

/**
 * Keep a runnable Open World mod's map controllers on its own Tile Views.
 * Enabled consumer bundles share the game's map-ready hook, so controllers
 * that were created for a previously visited World must not follow a foreign
 * city onto its MapLibre instance.
 */
export function syncCityScopedMapControllers({ map, cityCode, cityCodes, controllers = [] }) {
  globalThis.__openWorldCityScopedMapControllersVersion = CITY_SCOPED_MAP_CONTROLLERS_VERSION;
  const ownsCity = Array.isArray(cityCodes) && cityCodes.includes(cityCode);
  if (ownsCity) stabilizeMapLayerMoves(map);
  for (const controller of controllers) {
    if (!controller) continue;
    if (ownsCity) controller.attachMap?.(map);
    else controller.detachMap?.();
  }
  return ownsCity;
}
