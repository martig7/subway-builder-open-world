import { createOffMainThreadJsonDecoder } from '../embedded-tile-package-adapter.js';
import { readWorldContextTheme } from './world-context-theme.js';

export const WORLD_VEGETATION_VERSION = 'world-footprint-vegetation-v3';
export const WORLD_VEGETATION_SOURCE = 'open-world-vegetation-source';
export const WORLD_VEGETATION_LAYER = 'open-world-vegetation';
export const WORLD_VEGETATION_ATTRIBUTION = 'Vegetation: NASA MODIS MCD12Q1 v061 (2023), NASA GIBS / ESDIS; simplified by Open World';

export function createWorldVegetationLoader(base64) {
  if (!base64) return null;
  let loaded;
  return () => loaded ??= (async () => {
    const decoder = createOffMainThreadJsonDecoder();
    try {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const data = await decoder.decode(bytes, { gzip: true });
      if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || !data.features.length) {
        throw new Error('Invalid world vegetation artifact');
      }
      return data;
    } finally { decoder.dispose(); }
  })();
}

export function ensureWorldVegetation(map, data, beforeId) {
  if (!data) return;
  const existing = map.getSource?.(WORLD_VEGETATION_SOURCE);
  if (!existing) {
    map.addSource(WORLD_VEGETATION_SOURCE, {
      // Processing chunks are dissolved offline, so low-zoom simplification
      // cannot move two independent sides of the same artificial boundary.
      type: 'geojson', data, maxzoom: 9, tolerance: 2,
      attribution: WORLD_VEGETATION_ATTRIBUTION,
    });
  } else if (map.__openWorldVegetation?.version !== WORLD_VEGETATION_VERSION
    || map.__openWorldVegetation?.focusWorld !== (data.focusWorld ?? null)) {
    existing.setData(data);
  }
  if (!map.getLayer?.(WORLD_VEGETATION_LAYER)) {
    map.addLayer({
      id: WORLD_VEGETATION_LAYER, type: 'fill', source: WORLD_VEGETATION_SOURCE,
      minzoom: 0, maxzoom: 24,
      paint: { 'fill-color': readWorldContextTheme(map).vegetation, 'fill-opacity': .8, 'fill-antialias': false },
    }, beforeId);
  }
  if (map.getLayer?.(WORLD_VEGETATION_LAYER)?.maxzoom !== 24) map.setLayerZoomRange?.(WORLD_VEGETATION_LAYER, 0, 24);
  // This background is above base land but below native water, roads and rail.
  map.moveLayer?.(WORLD_VEGETATION_LAYER, beforeId);
  map.__openWorldVegetation = { version: WORLD_VEGETATION_VERSION, features: data.features.length, maxzoom: 24,
    focusWorld: data.focusWorld ?? null, outsideToleranceDegrees: data.outsideToleranceDegrees ?? null };
}

export function releaseWorldVegetation(map) {
  if (!map) return;
  // Map.remove()/setStyle(null) keeps Map methods but removes their Style.
  // Optional method calls do not protect against those methods dereferencing it.
  if (map._removed || ('style' in map && !map.style)) {
    delete map.__openWorldVegetation;
    return;
  }
  if (map.getLayer?.(WORLD_VEGETATION_LAYER)) map.removeLayer?.(WORLD_VEGETATION_LAYER);
  if (map.getSource?.(WORLD_VEGETATION_SOURCE)) map.removeSource?.(WORLD_VEGETATION_SOURCE);
  delete map.__openWorldVegetation;
}
