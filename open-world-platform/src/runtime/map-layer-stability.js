const PATCH_GENERATION = 6;
const LEGACY_PATCH_KEY = Symbol.for('subway-builder-open-world:stable-map-layer-moves');
const V2_PATCH_KEY = Symbol.for('subway-builder-open-world:stable-map-layer-moves:v2');
const V3_PATCH_KEY = Symbol.for('subway-builder-open-world:stable-map-layer-moves:v3');
const V4_PATCH_KEY = Symbol.for('subway-builder-open-world:stable-map-layer-moves:v4');
const V5_PATCH_KEY = Symbol.for('subway-builder-open-world:stable-map-layer-moves:v5');
const PATCH_KEY = Symbol.for('subway-builder-open-world:stable-map-layer-moves:v6');
const V4_STYLE_PATCH_KEY = Symbol.for('subway-builder-open-world:stable-style-layer-moves:v4');
const V5_STYLE_MOVE_PATCH_KEY = Symbol.for('subway-builder-open-world:stable-style-layer-moves:v5');
const STYLE_MOVE_PATCH_KEY = Symbol.for('subway-builder-open-world:stable-style-layer-moves:v6');
const STYLE_ADD_PATCH_KEY = Symbol.for('subway-builder-open-world:stable-style-layer-adds:v6');
const V5_PROTOTYPE_MOVE_PATCH_KEY = Symbol.for('subway-builder-open-world:stable-map-layer-prototype:v5');
const PROTOTYPE_MOVE_PATCH_KEY = Symbol.for('subway-builder-open-world:stable-map-layer-prototype:v6');
const PROTOTYPE_ADD_PATCH_KEY = Symbol.for('subway-builder-open-world:stable-map-add-layer-prototype:v6');
const CONSOLE_FILTER_GENERATION = 1;
const CONSOLE_FILTER_KEY = Symbol.for('subway-builder-open-world:transient-layer-order-console-filter:v1');

function activeStyleOrder(map) {
  const order = map?.style?._order;
  if (!Array.isArray(order)) return null;
  return new Set(order.map((entry) => (
    typeof entry === 'string' ? entry : entry?.id
  )).filter(Boolean));
}

function isTransientMissingLayerOrder(error) {
  const message = String(
    typeof error === 'string'
      ? error
      : error?.message ?? error?.error?.message ?? '',
  );
  return /^Cannot (?:add|move) layer .+(?:before non-existing layer|because it does not exist)/.test(message);
}

/**
 * MapLibre logs an ErrorEvent through console.error when it has no map-level
 * error listener yet. During initial load/resume the public API still exposes
 * no Map, so the method guards cannot be installed. Filter only this known
 * transient family at the earlier console seam and preserve every other error.
 */
export function installTransientLayerOrderConsoleFilter(consoleObject = globalThis.console) {
  if (!consoleObject || typeof consoleObject.error !== 'function') return consoleObject;
  const existingPatch = consoleObject[CONSOLE_FILTER_KEY];
  if (
    existingPatch?.generation === CONSOLE_FILTER_GENERATION
    && consoleObject.error === existingPatch.wrapper
  ) return consoleObject;

  const nativeError = existingPatch && consoleObject.error === existingPatch.wrapper
    ? existingPatch.nativeError
    : consoleObject.error.bind(consoleObject);
  const wrapper = function stableTransientLayerOrderConsoleError(...args) {
    if (args.some((value) => isTransientMissingLayerOrder(value))) return undefined;
    return nativeError(...args);
  };
  consoleObject.error = wrapper;
  Object.defineProperty(consoleObject, CONSOLE_FILTER_KEY, {
    value: { generation: CONSOLE_FILTER_GENERATION, nativeError, wrapper },
    configurable: true,
  });
  return consoleObject;
}

function styleHasLayer(style, layerId) {
  const layers = style?._layers;
  if (layers instanceof Map) return layers.has(layerId);
  if (layers && typeof layers === 'object') {
    return Object.prototype.hasOwnProperty.call(layers, layerId);
  }
  if (typeof style?.getLayer === 'function') return Boolean(style.getLayer(layerId));
  return null;
}

function isImpossibleStyleMove(style, layerId, beforeId) {
  const order = activeStyleOrder({ style });
  if (order && !order.has(layerId)) return true;
  if (order && beforeId != null && !order.has(beforeId)) return true;
  if (styleHasLayer(style, layerId) === false) return true;
  if (beforeId != null && styleHasLayer(style, beforeId) === false) return true;
  return false;
}

function isImpossibleStyleAdd(style, beforeId) {
  if (beforeId == null) return false;
  const order = activeStyleOrder({ style });
  if (order && !order.has(beforeId)) return true;
  return styleHasLayer(style, beforeId) === false;
}

function stabilizeStyleLayerMoves(style) {
  if (!style || typeof style.moveLayer !== 'function') return;
  const existingPatch = style[STYLE_MOVE_PATCH_KEY];
  if (existingPatch?.generation === PATCH_GENERATION && style.moveLayer === existingPatch.wrapper) return;

  const previousPatch = existingPatch ? null : (
    style[V5_STYLE_MOVE_PATCH_KEY] ?? style[V4_STYLE_PATCH_KEY]
  );
  const nativeMoveLayer = existingPatch && style.moveLayer === existingPatch.wrapper
    ? existingPatch.nativeMoveLayer
    : previousPatch && style.moveLayer === previousPatch.wrapper
      ? previousPatch.nativeMoveLayer
      : style.moveLayer;
  const wrapper = function stableStyleMoveLayer(layerId, beforeId) {
    if (isImpossibleStyleMove(this, layerId, beforeId)) return undefined;
    try {
      return nativeMoveLayer.call(this, layerId, beforeId);
    } catch (error) {
      if (isTransientMissingLayerOrder(error)) return undefined;
      throw error;
    }
  };
  style.moveLayer = wrapper;
  Object.defineProperty(style, STYLE_MOVE_PATCH_KEY, {
    value: { generation: PATCH_GENERATION, nativeMoveLayer, wrapper },
    configurable: true,
  });
}

function stabilizeStyleLayerAdds(style) {
  if (!style || typeof style.addLayer !== 'function') return;
  const existingPatch = style[STYLE_ADD_PATCH_KEY];
  if (existingPatch?.generation === PATCH_GENERATION && style.addLayer === existingPatch.wrapper) return;

  const nativeAddLayer = existingPatch && style.addLayer === existingPatch.wrapper
    ? existingPatch.nativeAddLayer
    : style.addLayer;
  const wrapper = function stableStyleAddLayer(layer, beforeId, ...rest) {
    if (isImpossibleStyleAdd(this, beforeId)) return undefined;
    try {
      return nativeAddLayer.call(this, layer, beforeId, ...rest);
    } catch (error) {
      if (isTransientMissingLayerOrder(error)) return undefined;
      throw error;
    }
  };
  style.addLayer = wrapper;
  Object.defineProperty(style, STYLE_ADD_PATCH_KEY, {
    value: { generation: PATCH_GENERATION, nativeAddLayer, wrapper },
    configurable: true,
  });
}

function stabilizeStyleLayerOrder(style) {
  stabilizeStyleLayerMoves(style);
  stabilizeStyleLayerAdds(style);
}

function layerMethodPrototype(map, methodName) {
  let prototype = Object.getPrototypeOf(map);
  while (prototype) {
    if (Object.prototype.hasOwnProperty.call(prototype, methodName)) return prototype;
    prototype = Object.getPrototypeOf(prototype);
  }
  return null;
}

function stabilizeMapMoveLayerPrototype(map) {
  const prototype = layerMethodPrototype(map, 'moveLayer');
  if (!prototype || typeof prototype.moveLayer !== 'function') return;
  const existingPatch = prototype[PROTOTYPE_MOVE_PATCH_KEY];
  if (existingPatch?.generation === PATCH_GENERATION && prototype.moveLayer === existingPatch.wrapper) return;

  const previousPatch = existingPatch ? null : prototype[V5_PROTOTYPE_MOVE_PATCH_KEY];
  const nativeMoveLayer = existingPatch && prototype.moveLayer === existingPatch.wrapper
    ? existingPatch.nativeMoveLayer
    : previousPatch && prototype.moveLayer === previousPatch.wrapper
      ? previousPatch.nativeMoveLayer
      : prototype.moveLayer;
  const wrapper = function stableMapPrototypeMoveLayer(layerId, beforeId) {
    stabilizeStyleLayerOrder(this?.style);
    if (isImpossibleStyleMove(this?.style, layerId, beforeId)) return this;
    try {
      return nativeMoveLayer.call(this, layerId, beforeId);
    } catch (error) {
      if (isTransientMissingLayerOrder(error)) return this;
      throw error;
    }
  };
  prototype.moveLayer = wrapper;
  Object.defineProperty(prototype, PROTOTYPE_MOVE_PATCH_KEY, {
    value: { generation: PATCH_GENERATION, nativeMoveLayer, wrapper },
    configurable: true,
  });
}

function stabilizeMapAddLayerPrototype(map) {
  const prototype = layerMethodPrototype(map, 'addLayer');
  if (!prototype || typeof prototype.addLayer !== 'function') return;
  const existingPatch = prototype[PROTOTYPE_ADD_PATCH_KEY];
  if (existingPatch?.generation === PATCH_GENERATION && prototype.addLayer === existingPatch.wrapper) return;

  const nativeAddLayer = existingPatch && prototype.addLayer === existingPatch.wrapper
    ? existingPatch.nativeAddLayer
    : prototype.addLayer;
  const wrapper = function stableMapPrototypeAddLayer(layer, beforeId, ...rest) {
    stabilizeStyleLayerOrder(this?.style);
    if (isImpossibleStyleAdd(this?.style, beforeId)) return this;
    try {
      return nativeAddLayer.call(this, layer, beforeId, ...rest);
    } catch (error) {
      if (isTransientMissingLayerOrder(error)) return this;
      throw error;
    }
  };
  prototype.addLayer = wrapper;
  Object.defineProperty(prototype, PROTOTYPE_ADD_PATCH_KEY, {
    value: { generation: PATCH_GENERATION, nativeAddLayer, wrapper },
    configurable: true,
  });
}

function stabilizeMapLayerPrototypes(map) {
  stabilizeMapMoveLayerPrototype(map);
  stabilizeMapAddLayerPrototype(map);
}

function activePreviousPatch(map) {
  for (const key of [V5_PATCH_KEY, V4_PATCH_KEY, V3_PATCH_KEY, V2_PATCH_KEY, LEGACY_PATCH_KEY]) {
    const patch = map[key];
    if (typeof patch?.nativeMoveLayer !== 'function') continue;
    if (patch.wrapper && map.moveLayer === patch.wrapper) return patch;
    if (!patch.wrapper && map.moveLayer.name === 'stableMoveLayer') return patch;
  }
  return null;
}

/**
 * Deck's style-change resolver reads MapLibre's private `_order` array, which
 * can briefly retain an anchor after that layer has been removed. Guard only
 * impossible additions and moves; a later style event retries once the anchor
 * exists again.
 */
export function stabilizeMapLayerMoves(map) {
  if (!map || typeof map.moveLayer !== 'function') return map;
  stabilizeStyleLayerOrder(map.style);
  stabilizeMapLayerPrototypes(map);
  if (typeof map.getLayer !== 'function') return map;

  const existingPatch = map[PATCH_KEY];
  const moveGuardActive = existingPatch?.generation === PATCH_GENERATION
    && map.moveLayer === existingPatch.wrapper;
  const addGuardActive = typeof map.addLayer !== 'function'
    || map.addLayer === existingPatch?.addWrapper;
  if (moveGuardActive && addGuardActive) {
    return map;
  }

  const previousPatch = existingPatch ? null : activePreviousPatch(map);
  const nativeMoveLayer = existingPatch && map.moveLayer === existingPatch.wrapper
    ? existingPatch.nativeMoveLayer
    : previousPatch
      ? previousPatch.nativeMoveLayer
      : map.moveLayer.bind(map);
  const nativeAddLayer = typeof map.addLayer !== 'function'
    ? null
    : existingPatch && map.addLayer === existingPatch.addWrapper
      ? existingPatch.nativeAddLayer
      : map.addLayer.bind(map);

  // Restore the unguarded implementation before installing this generation.
  // Save resume may already have replaced moveLayer; in that case its current
  // implementation is the new native method and must not be overwritten.
  if (existingPatch && map.moveLayer === existingPatch.wrapper) {
    map.moveLayer = existingPatch.nativeMoveLayer;
  } else if (previousPatch) {
    map.moveLayer = previousPatch.nativeMoveLayer;
  }
  if (existingPatch?.nativeAddLayer && map.addLayer === existingPatch.addWrapper) {
    map.addLayer = existingPatch.nativeAddLayer;
  }

  const wrapper = function stableMoveLayer(layerId, beforeId) {
    // A setStyle call can replace the Style object while retaining this Map.
    // Reinstall the lower-level guard before every Deck-triggered move.
    stabilizeStyleLayerOrder(map.style);
    const order = activeStyleOrder(map);
    if (order && !order.has(layerId)) return map;
    if (order && beforeId != null && !order.has(beforeId)) return map;
    if (!map.getLayer(layerId)) return map;
    if (beforeId != null && !map.getLayer(beforeId)) return map;
    try {
      return nativeMoveLayer(layerId, beforeId);
    } catch (error) {
      // A style event can remove an anchor after the checks above but before
      // MapLibre updates its private order. Deck will retry on the next event.
      if (isTransientMissingLayerOrder(error)) return map;
      throw error;
    }
  };
  const addWrapper = nativeAddLayer && function stableAddLayer(layer, beforeId, ...rest) {
    stabilizeStyleLayerOrder(map.style);
    if (isImpossibleStyleAdd(map.style, beforeId)) return map;
    try {
      return nativeAddLayer(layer, beforeId, ...rest);
    } catch (error) {
      if (isTransientMissingLayerOrder(error)) return map;
      throw error;
    }
  };
  map.moveLayer = wrapper;
  if (addWrapper) map.addLayer = addWrapper;
  Object.defineProperty(map, PATCH_KEY, {
    value: {
      generation: PATCH_GENERATION,
      nativeMoveLayer,
      wrapper,
      nativeAddLayer,
      addWrapper,
    },
    configurable: true,
  });
  return map;
}
