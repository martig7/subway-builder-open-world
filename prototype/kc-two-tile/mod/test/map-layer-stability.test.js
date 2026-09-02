import test from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeMapLayerMoves } from '../../../../open-world-platform/src/runtime/map-layer-stability.js';
import * as mapLayerStability from '../../../../open-world-platform/src/runtime/map-layer-stability.js';

function fixtureMap(layerIds, { reportedLayerIds = layerIds } = {}) {
  const layers = new Set(layerIds);
  const reportedLayers = new Set(reportedLayerIds);
  const calls = [];
  return {
    calls,
    style: { _order: [...layers] },
    getLayer: (id) => reportedLayers.has(id) ? { id } : undefined,
    moveLayer(id, beforeId) {
      calls.push([id, beforeId]);
      if (!layers.has(id)) throw new Error(`Cannot move layer "${id}" because it does not exist.`);
      if (beforeId != null && !layers.has(beforeId)) {
        throw new Error(`Cannot move layer "${id}" before non-existing layer "${beforeId}".`);
      }
      return this;
    },
  };
}

function eventingMap(layerIds) {
  const style = {
    _layers: Object.fromEntries(layerIds.map((id) => [id, { id }])),
    _order: [...layerIds],
    errors: [],
    addLayer(layer, beforeId) {
      if (beforeId && this._order.indexOf(beforeId) === -1) {
        this.errors.push(`Cannot add layer "${layer.id}" before non-existing layer "${beforeId}".`);
        return;
      }
      this._layers[layer.id] = layer;
      const index = beforeId ? this._order.indexOf(beforeId) : this._order.length;
      this._order.splice(index, 0, layer.id);
    },
    moveLayer(id, beforeId) {
      if (!this._layers[id]) {
        this.errors.push(`The layer '${id}' does not exist in the map's style and cannot be moved.`);
        return;
      }
      if (id === beforeId) return;
      const index = this._order.indexOf(id);
      this._order.splice(index, 1);
      const newIndex = beforeId ? this._order.indexOf(beforeId) : this._order.length;
      if (beforeId && newIndex === -1) {
        this.errors.push(`Cannot move layer "${id}" before non-existing layer "${beforeId}".`);
        return;
      }
      this._order.splice(newIndex, 0, id);
    },
  };
  const map = {
    style,
    getLayer: (id) => style._layers[id],
    addLayer(layer, beforeId) {
      this.style.addLayer(layer, beforeId);
      return this;
    },
    moveLayer(id, beforeId) {
      this.style.moveLayer(id, beforeId);
      return this;
    },
  };
  return map;
}

test('pre-map startup suppresses only transient MapLibre layer-order console errors', () => {
  const calls = [];
  const consoleObject = {
    error: (...args) => calls.push(args),
  };
  mapLayerStability.installTransientLayerOrderConsoleFilter?.(consoleObject);

  consoleObject.error(new Error(
    'Cannot add layer "road-bridge-casing-major" before non-existing layer "neighborhood-labels".',
  ));
  consoleObject.error(new Error('Style is not done loading'));

  assert.equal(calls.length, 1);
  assert.match(calls[0][0].message, /Style is not done loading/);
});

test('hot reload does not stack the pre-map console filter', () => {
  const calls = [];
  const consoleObject = {
    error: (...args) => calls.push(args),
  };
  mapLayerStability.installTransientLayerOrderConsoleFilter(consoleObject);
  const guarded = consoleObject.error;
  mapLayerStability.installTransientLayerOrderConsoleFilter(consoleObject);

  assert.equal(consoleObject.error, guarded);
  consoleObject.error('Cannot move layer "routes" before non-existing layer "routes-under".');
  consoleObject.error('unrelated failure');
  assert.deepEqual(calls, [['unrelated failure']]);
});

test('a transiently missing Deck anchor does not throw or reach raw MapLibre moveLayer', () => {
  const map = fixtureMap(['construction-tracks-base']);
  stabilizeMapLayerMoves(map);

  assert.doesNotThrow(() => map.moveLayer('construction-tracks-base', 'tracks-base'));
  assert.deepEqual(map.calls, []);
});

test('a stale getLayer result cannot move before an anchor absent from the active style order', () => {
  const map = fixtureMap(['signal-points'], {
    reportedLayerIds: ['signal-points', 'signal-points-under'],
  });
  stabilizeMapLayerMoves(map);

  assert.doesNotThrow(() => map.moveLayer('signal-points', 'signal-points-under'));
  assert.deepEqual(map.calls, [], 'the impossible move must not reach raw MapLibre moveLayer');
});

test('a layer removed between validation and the native move is treated as a transient race', () => {
  const map = fixtureMap(['signal-lines', 'signal-lines-under']);
  map.moveLayer = (id, beforeId) => {
    map.calls.push([id, beforeId]);
    throw new Error(`Cannot move layer "${id}" before non-existing layer "${beforeId}".`);
  };
  stabilizeMapLayerMoves(map);

  assert.doesNotThrow(() => map.moveLayer('signal-lines', 'signal-lines-under'));
  assert.deepEqual(map.calls, [['signal-lines', 'signal-lines-under']]);
});

test('the style seam rejects a stale Deck anchor when the map wrapper is bypassed', () => {
  const map = eventingMap(['platform-polygons']);
  const rawMapMoveLayer = map.moveLayer;
  stabilizeMapLayerMoves(map);

  // Deck's style-change callback can retain the raw MapLibre method even when
  // the long-lived map instance has already been guarded.
  map.moveLayer = rawMapMoveLayer;
  map.moveLayer('platform-polygons', 'construction-tracks');

  assert.deepEqual(map.style.errors, []);
  assert.deepEqual(map.style._order, ['platform-polygons']);
});

test('save resume keeps the guard when MapLibre replaces Style and clears instance patches', () => {
  class RetainedMap {
    constructor(style) {
      this.style = style;
    }

    getLayer(id) {
      return this.style._layers[id];
    }

    moveLayer(id, beforeId) {
      this.style.moveLayer(id, beforeId);
      return this;
    }
  }

  const map = new RetainedMap(eventingMap(['routes']).style);
  stabilizeMapLayerMoves(map);

  // Native save resume constructs a fresh Style and exposes MapLibre's class
  // method again while retaining the Map instance and its listeners.
  map.style = eventingMap(['platform-polygons']).style;
  delete map.moveLayer;
  map.moveLayer('platform-polygons', 'construction-tracks');

  assert.deepEqual(map.style.errors, []);
  assert.deepEqual(map.style._order, ['platform-polygons']);
});

test('save resume rejects Deck add-before and its missing-anchor move cascade', () => {
  class RetainedMap {
    constructor(style) {
      this.style = style;
    }

    getLayer(id) {
      return this.style._layers[id];
    }

    addLayer(layer, beforeId) {
      this.style.addLayer(layer, beforeId);
      return this;
    }

    moveLayer(id, beforeId) {
      this.style.moveLayer(id, beforeId);
      return this;
    }
  }

  const map = new RetainedMap(eventingMap(['road-lines-highway']).style);
  stabilizeMapLayerMoves(map);
  map.style = eventingMap(['road-lines-highway']).style;
  delete map.moveLayer;
  delete map.addLayer;

  map.addLayer({ id: 'road-bridge-casing-minor' }, 'neighborhood-labels');
  map.moveLayer('road-lines-highway', 'road-bridge-casing-minor');

  assert.deepEqual(map.style.errors, []);
  assert.deepEqual(map.style._order, ['road-lines-highway']);
});

test('the guard does not swallow unrelated MapLibre failures', () => {
  const map = fixtureMap(['routes', 'routes-under']);
  map.moveLayer = () => { throw new Error('Style is not done loading'); };
  stabilizeMapLayerMoves(map);

  assert.throws(() => map.moveLayer('routes', 'routes-under'), /Style is not done loading/);
});

test('the add guard does not swallow unrelated MapLibre failures', () => {
  const map = eventingMap(['routes']);
  map.style.addLayer = () => { throw new Error('Style is not done loading'); };
  stabilizeMapLayerMoves(map);

  assert.throws(() => map.addLayer({ id: 'route-labels' }), /Style is not done loading/);
});

test('valid layer moves retain native MapLibre behavior', () => {
  const map = fixtureMap(['construction-tracks-base', 'tracks-base']);
  stabilizeMapLayerMoves(map);

  assert.equal(map.moveLayer('construction-tracks-base', 'tracks-base'), map);
  assert.deepEqual(map.calls, [['construction-tracks-base', 'tracks-base']]);
});

test('valid layer additions retain native MapLibre behavior', () => {
  const map = eventingMap(['neighborhood-labels']);
  stabilizeMapLayerMoves(map);

  assert.equal(map.addLayer({ id: 'road-bridge-casing-minor' }, 'neighborhood-labels'), map);
  assert.deepEqual(map.style._order, ['road-bridge-casing-minor', 'neighborhood-labels']);
  assert.deepEqual(map.style.errors, []);
});

test('hot reload does not wrap moveLayer repeatedly', () => {
  const map = fixtureMap(['road-lines-major', 'road-lines-highway']);
  stabilizeMapLayerMoves(map);
  const guarded = map.moveLayer;
  stabilizeMapLayerMoves(map);

  assert.equal(map.moveLayer, guarded);
  map.moveLayer('road-lines-major', 'road-lines-highway');
  assert.deepEqual(map.calls, [['road-lines-major', 'road-lines-highway']]);
});

test('hot reload does not wrap addLayer repeatedly', () => {
  const map = eventingMap(['neighborhood-labels']);
  stabilizeMapLayerMoves(map);
  const guarded = map.addLayer;
  stabilizeMapLayerMoves(map);

  assert.equal(map.addLayer, guarded);
  map.addLayer({ id: 'road-bridge-casing-minor' }, 'neighborhood-labels');
  assert.deepEqual(map.style._order, ['road-bridge-casing-minor', 'neighborhood-labels']);
});

test('save resume reinstalls a guard replaced while the map object is retained', () => {
  const map = fixtureMap(['routes']);
  const nativeMoveLayer = map.moveLayer;
  const patchKey = Symbol.for('subway-builder-open-world:stable-map-layer-moves:v6');
  stabilizeMapLayerMoves(map);
  const firstPatch = map[patchKey];
  const firstWrapper = map.moveLayer;

  // Subway Builder rebuilds its style during save resume and can restore the
  // native method while retaining properties attached to the long-lived map.
  map.moveLayer = nativeMoveLayer;
  stabilizeMapLayerMoves(map);

  assert.notEqual(map[patchKey], firstPatch);
  assert.notEqual(map.moveLayer, firstWrapper);
  assert.doesNotThrow(() => map.moveLayer('routes', 'routes-under'));
  assert.deepEqual(map.calls, []);
});

test('a retained previous-generation patch is replaced by the current guard', () => {
  const map = fixtureMap(['routes']);
  const nativeMoveLayer = map.moveLayer.bind(map);
  const legacyPatchKey = Symbol.for('subway-builder-open-world:stable-map-layer-moves');
  const currentPatchKey = Symbol.for('subway-builder-open-world:stable-map-layer-moves:v6');
  const legacyWrapper = function stableMoveLayer(layerId, beforeId) {
    return nativeMoveLayer(layerId, beforeId);
  };
  const legacyPatch = { nativeMoveLayer };
  map.moveLayer = legacyWrapper;
  Object.defineProperty(map, legacyPatchKey, { value: legacyPatch, configurable: false });

  stabilizeMapLayerMoves(map);

  assert.notEqual(map[currentPatchKey], legacyPatch);
  assert.notEqual(map.moveLayer, legacyWrapper);
  assert.doesNotThrow(() => map.moveLayer('routes', 'routes-under'));
  assert.deepEqual(map.calls, []);
});

test('a retained v5 patch is replaced without nesting its stale wrapper', () => {
  const map = fixtureMap(['routes']);
  const nativeMoveLayer = map.moveLayer.bind(map);
  const previousPatchKey = Symbol.for('subway-builder-open-world:stable-map-layer-moves:v5');
  const currentPatchKey = Symbol.for('subway-builder-open-world:stable-map-layer-moves:v6');
  const previousWrapper = function stableMoveLayer(layerId, beforeId) {
    return nativeMoveLayer(layerId, beforeId);
  };
  map.moveLayer = previousWrapper;
  Object.defineProperty(map, previousPatchKey, {
    value: { generation: 5, nativeMoveLayer, wrapper: previousWrapper },
    configurable: true,
  });

  stabilizeMapLayerMoves(map);

  assert.notEqual(map.moveLayer, previousWrapper);
  assert.equal(map[currentPatchKey].nativeMoveLayer, nativeMoveLayer);
  assert.doesNotThrow(() => map.moveLayer('routes', 'routes-under'));
  assert.deepEqual(map.calls, []);
});

test('a retained v5 style patch is replaced without nesting its stale wrapper', () => {
  const map = eventingMap(['routes']);
  const nativeStyleMoveLayer = map.style.moveLayer;
  const previousPatchKey = Symbol.for('subway-builder-open-world:stable-style-layer-moves:v5');
  const currentPatchKey = Symbol.for('subway-builder-open-world:stable-style-layer-moves:v6');
  const previousWrapper = function stableStyleMoveLayer(layerId, beforeId) {
    return nativeStyleMoveLayer.call(this, layerId, beforeId);
  };
  const previousPatch = {
    generation: 5,
    nativeMoveLayer: nativeStyleMoveLayer,
    wrapper: previousWrapper,
  };
  map.style.moveLayer = previousWrapper;
  Object.defineProperty(map.style, previousPatchKey, { value: previousPatch, configurable: true });

  stabilizeMapLayerMoves(map);

  assert.notEqual(map.style[currentPatchKey], previousPatch);
  assert.notEqual(map.style.moveLayer, previousWrapper);
  assert.equal(map.style[currentPatchKey].nativeMoveLayer, nativeStyleMoveLayer);
});

test('a retained v5 prototype patch is replaced without nesting its stale wrapper', () => {
  class RetainedMap {
    constructor(style) {
      this.style = style;
    }

    getLayer(id) {
      return this.style._layers[id];
    }

    moveLayer(id, beforeId) {
      this.style.moveLayer(id, beforeId);
      return this;
    }
  }

  const nativeMoveLayer = RetainedMap.prototype.moveLayer;
  const previousPatchKey = Symbol.for('subway-builder-open-world:stable-map-layer-prototype:v5');
  const currentPatchKey = Symbol.for('subway-builder-open-world:stable-map-layer-prototype:v6');
  const previousWrapper = function stableMapPrototypeMoveLayer(layerId, beforeId) {
    return nativeMoveLayer.call(this, layerId, beforeId);
  };
  const previousPatch = {
    generation: 5,
    nativeMoveLayer,
    wrapper: previousWrapper,
  };
  RetainedMap.prototype.moveLayer = previousWrapper;
  Object.defineProperty(RetainedMap.prototype, previousPatchKey, {
    value: previousPatch,
    configurable: true,
  });

  const map = new RetainedMap(eventingMap(['routes']).style);
  stabilizeMapLayerMoves(map);

  assert.notEqual(RetainedMap.prototype[currentPatchKey], previousPatch);
  assert.notEqual(RetainedMap.prototype.moveLayer, previousWrapper);
  assert.equal(RetainedMap.prototype[currentPatchKey].nativeMoveLayer, nativeMoveLayer);
});
