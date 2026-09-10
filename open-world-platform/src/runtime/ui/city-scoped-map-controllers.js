import { stabilizeMapLayerMoves } from '../map-layer-stability.js';

export const CITY_SCOPED_MAP_CONTROLLERS_VERSION = 'city-scoped-map-controllers-v3';

export function refreshCityScopedMapArtifacts({ map, controller }) {
  if (!map || typeof controller?.refresh !== 'function') return { status: 'unavailable' };
  if (map._removed) return { status: 'map-removed' };
  const refresh = () => {
    if (map._removed) return { status: 'map-removed' };
    try { controller.refresh(); return { status: 'refreshed' }; }
    catch (error) { return { status: 'failed', error: error?.message ?? String(error) }; }
  };
  if (map.isStyleLoaded?.() === false) {
    if (typeof map.once !== 'function') return { status: 'style-not-ready' };
    map.once('idle', refresh);
    return { status: 'deferred-until-idle' };
  }
  return refresh();
}

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
