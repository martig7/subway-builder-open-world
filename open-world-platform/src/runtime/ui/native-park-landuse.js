export const NATIVE_PARK_LANDUSE_VERSION = 'native-park-landuse-v1';
const STATE = Symbol.for('open-world.native-park-landuse');
const BUSY = new WeakSet();

function withUnknownAreaAsSmall(value) {
  if (!Array.isArray(value)) return value;
  if (value.length === 2 && value[0] === 'get' && value[1] === 'area') {
    return ['coalesce', ['get', 'area'], 0];
  }
  return value.map(withUnknownAreaAsSmall);
}

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
  BUSY.add(map);
  try {
    if (typeof map.getLayer === 'function' && ['parks-large', 'parks-small'].every((id) => {
      const layer = map.getLayer(id);
      return !layer || (layer['source-layer'] ?? layer.sourceLayer) !== 'parks';
    })) return;
    const layers = map.getStyle?.()?.layers ?? [];
    const state = map[STATE] ??= new Map();
    for (const id of ['parks-large', 'parks-small']) {
      const layer = layers.find((candidate) => candidate.id === id);
      if (!layer || layer.source !== 'general-tiles' || layer['source-layer'] !== 'parks') continue;
      const filter = ['all', ['==', ['get', 'kind'], 'park'], withUnknownAreaAsSmall(layer.filter
        ?? [id === 'parks-large' ? '>=' : '<', ['get', 'area'], 100000])];
      replaceLayer(map, layers, layer, { ...layer, 'source-layer': 'landuse', filter });
      state.set(id, { sourceLayer: layer['source-layer'], filter: layer.filter, mappedFilter: filter });
    }
    map.__openWorldNativeParkLanduse = {
      version: NATIVE_PARK_LANDUSE_VERSION,
      sourceLayer: 'landuse', includedKinds: ['park'], unknownArea: 'small',
      layers: [...state.keys()],
    };
  } finally { BUSY.delete(map); }
}

export function releaseNativeParkLanduse(map) {
  if (!map?.[STATE] || BUSY.has(map)) return;
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
