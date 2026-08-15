const PATCH_KEY = Symbol.for('subway-builder-open-world:stable-map-layer-moves');

/**
 * Deck's style-change resolver reads MapLibre's private `_order` array, which
 * can briefly retain an anchor after that layer has been removed. Guard only
 * those impossible moves; a later style event retries once both layers exist.
 */
export function stabilizeMapLayerMoves(map) {
  if (!map || typeof map.moveLayer !== 'function' || typeof map.getLayer !== 'function') return map;
  if (map[PATCH_KEY]) return map;
  const nativeMoveLayer = map.moveLayer.bind(map);
  map.moveLayer = function stableMoveLayer(layerId, beforeId) {
    if (!map.getLayer(layerId)) return map;
    if (beforeId != null && !map.getLayer(beforeId)) return map;
    return nativeMoveLayer(layerId, beforeId);
  };
  Object.defineProperty(map, PATCH_KEY, { value: { nativeMoveLayer }, configurable: false });
  return map;
}
