export const NATIVE_ROAD_LABEL_SOURCE_VERSION = 'native-road-label-source-v2';
const PATCH = '__openWorldNativeRoadLabelSource';
const SOURCE_PATCH = '__openWorldNativeRoadLabelData';

// This native GeoJSON source serves road-labels only. Deck and collision
// detection read the full native road collection independently.
export function compactRoadLabelData(data) {
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) return data;
  const features = data.features.filter(feature => {
    const name = feature?.properties?.name;
    return name != null && String(name).length > 0;
  });
  return features.length === data.features.length ? data : { ...data, features };
}

function labelOnly(map) {
  const layers = map?.getStyle?.()?.layers ?? [];
  return layers.every(layer => layer.source !== 'roads-source'
    || (layer.id === 'road-labels' && layer.type === 'symbol'));
}

/** Intercept source creation before MapLibre serializes/indexes native roads. */
export function createNativeRoadLabelSourceGuard({ isEnabled, onReport = () => {} }) {
  const patches = new Set();
  const owner = { isEnabled, onReport };
  let disposed = false;
  function attach(map) {
    if (disposed || !map || map._removed) return;
    const prototype = Object.getPrototypeOf(map);
    if (typeof prototype?.addSource !== 'function') return;
    let patch = Object.hasOwn(prototype, PATCH) ? prototype[PATCH] : null;
    if (patch && (patch.version !== NATIVE_ROAD_LABEL_SOURCE_VERSION || prototype.addSource !== patch.wrapper)) {
      patch.dispose();
      patch = null;
    }
    if (!patch) {
      const nativeAddSource = prototype.addSource;
      const owners = new Set();
      function compact(map, data) {
        const active = [...owners].filter(entry => entry.isEnabled());
        if (!active.length || !labelOnly(map)) return data;
        const result = compactRoadLabelData(data);
        if (result !== data) {
          const report = { version: NATIVE_ROAD_LABEL_SOURCE_VERSION,
            inputFeatures: data.features.length, labelFeatures: result.features.length };
          for (const entry of active) entry.onReport(report);
        }
        return result;
      }
      function wrapSource(map) {
        const source = map.getSource?.('roads-source');
        if (source?.type !== 'geojson' || typeof source.setData !== 'function') return;
        const previous = source[SOURCE_PATCH];
        if (previous?.patch === patch && source.setData === previous.wrapper) return;
        const nativeSetData = previous && source.setData === previous.wrapper ? previous.nativeSetData : source.setData;
        const nativeOnRemove = previous && source.onRemove === previous.removeWrapper ? previous.nativeOnRemove : source.onRemove;
        const wrapper = function setNativeRoadLabelData(data) {
          return nativeSetData.call(this, compact(this.map, data));
        };
        const removeWrapper = function retireNativeRoadLabelData(...args) {
          const result = nativeOnRemove.apply(this, args);
          // Native onRemove signals the worker before setting no more data.
          // Drop our separate filtered array if a removed source is retained.
          if (this._removed) this._data = { type: 'FeatureCollection', features: [] };
          return result;
        };
        source.setData = wrapper;
        if (typeof nativeOnRemove === 'function') source.onRemove = removeWrapper;
        source[SOURCE_PATCH] = { patch, nativeSetData, wrapper, nativeOnRemove, removeWrapper };
        const data = compact(map, source._data);
        if (data !== source._data) nativeSetData.call(source, data);
      }
      const wrapper = function addNativeRoadLabelSource(id, specification, ...args) {
        const selected = id === 'roads-source' && specification?.type === 'geojson';
        const data = selected ? compact(this, specification.data) : null;
        const input = selected && data !== specification.data ? { ...specification, data } : specification;
        const result = nativeAddSource.call(this, id, input, ...args);
        if (selected) wrapSource(this);
        return result;
      };
      patch = { version: NATIVE_ROAD_LABEL_SOURCE_VERSION, owners, wrapper, wrapSource,
        dispose() {
          owners.clear();
          if (prototype.addSource === wrapper) prototype.addSource = nativeAddSource;
          if (prototype[PATCH] === patch) delete prototype[PATCH];
        } };
      prototype.addSource = wrapper;
      Object.defineProperty(prototype, PATCH, { configurable: true, value: patch });
    }
    patch.owners.add(owner);
    patches.add(patch);
    patch.wrapSource(map);
  }
  return { attach, dispose() {
    disposed = true;
    for (const patch of patches) {
      patch.owners.delete(owner);
      if (!patch.owners.size) patch.dispose();
    }
    patches.clear();
  } };
}
