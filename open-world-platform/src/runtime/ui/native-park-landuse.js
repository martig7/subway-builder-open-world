export const NATIVE_PARK_LANDUSE_VERSION = 'native-park-landuse-all-large-v3';
const STATE = Symbol.for('open-world.native-park-landuse');
const BUSY = new WeakSet();

function replaceLayer(map, layers, original, replacement) {
  const next = layers[layers.findIndex((layer) => layer.id === original.id) + 1]?.id;
  map.removeLayer(original.id);
  try { map.addLayer(replacement, next); }
  catch (error) {
    map.addLayer(original, next);
    throw error;
  }
}

// Adapt only the active World's native park layers, not the global modding
// override registry (which would also change unrelated vanilla cities).
// Paint, opacity, foundation visibility and zoom behavior remain native-owned.
export function syncNativeParkLanduse(map) {
  if (!map || BUSY.has(map)) return;
  // Retained v1 mappings sent unknown-area parks through the small-park fade.
  // Restore their native definitions before installing the new generation.
  if (map[STATE] && map[STATE].version !== NATIVE_PARK_LANDUSE_VERSION) releaseNativeParkLanduse(map);
  BUSY.add(map);
  try {
    if (typeof map.getLayer === 'function' && ['parks-large', 'parks-small'].every((id) => {
      const layer = map.getLayer(id);
      return !layer || (layer['source-layer'] ?? layer.sourceLayer) !== 'parks';
    })) return;
    const layers = map.getStyle?.()?.layers ?? [];
    const state = map[STATE] ??= new Map();
    state.version = NATIVE_PARK_LANDUSE_VERSION;
    for (const id of ['parks-large', 'parks-small']) {
      const layer = layers.find((candidate) => candidate.id === id);
      if (!layer || layer.source !== 'general-tiles' || layer['source-layer'] !== 'parks') continue;
      // All real park polygons use native large-park visibility. Disable the
      // small pass so alpha blending never paints the same polygon twice.
      const filter = id === 'parks-large' ? ['==', ['get', 'kind'], 'park'] : ['==', ['literal', 1], 0];
      replaceLayer(map, layers, layer, { ...layer, 'source-layer': 'landuse', filter });
      state.set(id, { sourceLayer: layer['source-layer'], filter: layer.filter, mappedFilter: filter });
    }
    map.__openWorldNativeParkLanduse = {
      version: NATIVE_PARK_LANDUSE_VERSION,
      sourceLayer: 'landuse', includedKinds: ['park'], sizePolicy: 'all-large',
      layers: [...state.keys()],
    };
  } finally { BUSY.delete(map); }
}

export function releaseNativeParkLanduse(map) {
  if (!map?.[STATE] || BUSY.has(map)) return;
  if (map._removed || ('style' in map && !map.style)) {
    delete map[STATE];
    delete map.__openWorldNativeParkLanduse;
    return;
  }
  BUSY.add(map);
  try {
    const layers = map.getStyle?.()?.layers ?? [];
    for (const [id, saved] of map[STATE]) {
      const layer = layers.find((candidate) => candidate.id === id);
      if (!layer || layer['source-layer'] !== 'landuse'
        || JSON.stringify(layer.filter) !== JSON.stringify(saved.mappedFilter)) continue;
      const restored = { ...layer, 'source-layer': saved.sourceLayer };
      if (saved.filter === undefined) delete restored.filter;
      else restored.filter = saved.filter;
      replaceLayer(map, layers, layer, restored);
    }
    delete map[STATE];
    delete map.__openWorldNativeParkLanduse;
  } finally { BUSY.delete(map); }
}
