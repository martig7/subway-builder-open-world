export const OPEN_WORLD_MIN_ZOOM = 0;
export const OPEN_WORLD_MAX_ZOOM = 24;

function readZoomLimit(map, methodName) {
  try {
    const value = Number(map?.[methodName]?.());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Remove the city-specific zoom-out clamp while remaining inside MapLibre's
 * supported camera range. Tile sources may still over/under-zoom their lowest
 * and highest available vector tiles; this changes the camera constraint only.
 */
export function relaxMapZoomLimits(map, {
  minZoom = OPEN_WORLD_MIN_ZOOM,
  maxZoom = OPEN_WORLD_MAX_ZOOM,
  sourceMinZoom = null,
} = {}) {
  if (!map || typeof map.setMinZoom !== 'function') {
    return { status: 'unsupported' };
  }

  const previousMinZoom = readZoomLimit(map, 'getMinZoom');
  const previousMaxZoom = readZoomLimit(map, 'getMaxZoom');

  const finiteSourceMinZoom = sourceMinZoom == null ? null : Number(sourceMinZoom);
  const hasSourceMinZoom = Number.isFinite(finiteSourceMinZoom);
  const effectiveMinZoom = hasSourceMinZoom
    ? Math.max(minZoom, finiteSourceMinZoom)
    : minZoom;

  map.setMinZoom(effectiveMinZoom);
  if (typeof map.setMaxZoom === 'function') map.setMaxZoom(maxZoom);

  return {
    status: 'relaxed',
    previousMinZoom,
    previousMaxZoom,
    requestedMinZoom: minZoom,
    sourceMinZoom: hasSourceMinZoom ? finiteSourceMinZoom : null,
    minZoom: readZoomLimit(map, 'getMinZoom') ?? effectiveMinZoom,
    maxZoom: readZoomLimit(map, 'getMaxZoom') ?? maxZoom,
  };
}
