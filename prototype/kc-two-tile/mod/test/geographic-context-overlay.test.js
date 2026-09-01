import test from 'node:test';
import assert from 'node:assert/strict';

import {
  geographicContextLayerIds,
  mapLayerDiagnostic,
  registerGeographicContextOverlay,
  tileBoundaryGeoJson,
} from '../src/ui/geographic-context-overlay.js';

function fixtureDeckLayer(id, props = {}) {
  return {
    id,
    props: { id, visible: true, data: [], ...props },
    clone(overrides = {}) {
      return fixtureDeckLayer(id, { ...this.props, ...overrides });
    },
  };
}

function fixtureMap() {
  const sources = new Map([
    ['general-tiles', {
      type: 'vector',
      tiles: ['http://127.0.0.1:8798/NY_CP00_RP00/{z}/{x}/{y}.mvt'],
    }],
  ]);
  const layers = new Map([
    ['native-background', { id: 'native-background', type: 'background' }],
    ['water', { id: 'water', source: 'general-tiles' }],
    ['native-city-labels', {
      id: 'native-city-labels',
      type: 'symbol',
      source: 'general-tiles',
      'source-layer': 'city_labels',
    }],
    ['native-city-labels-secondary', {
      id: 'native-city-labels-secondary',
      type: 'symbol',
      source: 'general-tiles',
      'source-layer': 'city_labels',
    }],
    ['station-collision-big', { id: 'station-collision-big', type: 'symbol', source: 'station-collision-big' }],
    ['station-collision-small', { id: 'station-collision-small', type: 'symbol', source: 'station-collision-small' }],
    ['station-connections', { id: 'station-connections', type: 'line', source: 'station-connections' }],
  ]);
  const layerOrder = [...layers.keys()];
  const insertions = [];
  const listeners = new Map();
  const container = { dataset: {} };
  const canvas = { style: { cursor: '' } };
  const deck = {
    props: {
      layers: [
        fixtureDeckLayer('routes'),
        fixtureDeckLayer('trains'),
        fixtureDeckLayer('trains-under'),
        fixtureDeckLayer('pop-movements-deck'),
      ],
    },
    redrawCalls: 0,
    setPropsCalls: 0,
    setProps(next) { this.setPropsCalls++; this.props = { ...this.props, ...next }; },
    redraw() { this.redrawCalls++; },
  };
  let zoom = 11;
  return {
    sources, layers, layerOrder, insertions, listeners, container, canvas, __deck: deck,
    isStyleLoaded: () => true,
    getSource: (id) => sources.get(id),
    addSource: (id, definition) => sources.set(id, { ...definition, setData(data) { this.data = data; } }),
    getLayer: (id) => layers.get(id),
    getStyle: () => ({
      layers: layerOrder.map((id) => layers.get(id)),
      sources: Object.fromEntries(sources),
    }),
    addLayer: (definition, beforeId) => {
      layers.set(definition.id, definition);
      const index = beforeId == null ? layerOrder.length : layerOrder.indexOf(beforeId);
      layerOrder.splice(index < 0 ? layerOrder.length : index, 0, definition.id);
      insertions.push([definition.id, beforeId]);
    },
    removeLayer: (id) => {
      layers.delete(id);
      const index = layerOrder.indexOf(id);
      if (index >= 0) layerOrder.splice(index, 1);
    },
    moveLayer: (id, beforeId) => {
      layerOrder.splice(layerOrder.indexOf(id), 1);
      const index = beforeId == null ? layerOrder.length : layerOrder.indexOf(beforeId);
      layerOrder.splice(index < 0 ? layerOrder.length : index, 0, id);
    },
    setLayerZoomRange: (id, minzoom, maxzoom) => Object.assign(layers.get(id), { minzoom, maxzoom }),
    getContainer: () => container,
    getCanvas: () => canvas,
    getZoom: () => zoom,
    setZoom: (nextZoom) => { zoom = nextZoom; },
    on: (event, layerOrCallback, callback) => {
      const key = typeof callback === 'function' ? `${event}:${layerOrCallback}` : event;
      listeners.set(key, callback ?? layerOrCallback);
    },
    off: (event, layerOrCallback, callback) => {
      const key = typeof callback === 'function' ? `${event}:${layerOrCallback}` : event;
      const expected = callback ?? layerOrCallback;
      if (listeners.get(key) === expected) listeners.delete(key);
    },
  };
}

const catalog = {
  tiles: [
    { id: 'A', name: 'Alpha', bounds: [-75, 40, -74, 41] },
    { id: 'B', name: 'Beta', boundary: [[-74, 40], [-73, 40], [-73, 41], [-74, 41], [-74, 40]] },
  ],
};

test('builds geographic tile polygons and identifies the active tile', () => {
  const data = tileBoundaryGeoJson(catalog, 'B', 'A');
  assert.equal(data.features.length, 2);
  assert.deepEqual(data.features.map((feature) => feature.properties.active), [false, true]);
  assert.deepEqual(data.features.map((feature) => feature.properties.hovered), [true, false]);
  assert.deepEqual(data.features[0].geometry.coordinates[0][0], [-75, 40]);
});

test('updates renderer virtualization when the render-distance control changes', () => {
  const gridCatalog = {
    tiles: Array.from({ length: 49 }, (_, index) => ({
      id: `T${index}`,
      column: index % 7,
      row: Math.floor(index / 7),
      bounds: [index % 7, Math.floor(index / 7), index % 7 + 1, Math.floor(index / 7) + 1],
    })),
  };
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'T24', subscribe: () => () => {} },
    tileCatalog: gridCatalog,
  });
  assert.equal(controller.getRenderDistance(), 3);
  assert.equal(controller.getRendererVirtualization().haloTileIds.length, 9);
  controller.setRenderDistance(6);
  assert.equal(controller.getRendererVirtualization().haloTileIds.length, 37);
  controller.setRenderDistance(99);
  assert.equal(controller.getRenderDistance(), 9);
  assert.equal(controller.getRendererVirtualization().haloTileIds.length, 49);
  controller.dispose();
});

test('restores and persists render distance across controller generations', () => {
  const writes = [];
  const storage = {
    getItem: () => '5',
    setItem: (key, value) => writes.push([key, value]),
  };
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
    renderDistanceStorage: storage,
  });
  assert.equal(controller.getRenderDistance(), 5);
  controller.setRenderDistance(2);
  assert.deepEqual(writes, [['open-world:render-distance', '2']]);
  controller.dispose();
});

test('keeps runtime.view out of tile pointer handling while tracking active-tile notifications', () => {
  const map = fixtureMap();
  map.setZoom(8);
  let activeTileId = 'A';
  let runtimeListener = null;
  let viewCalls = 0;
  const runtime = {
    getActiveTileId: () => activeTileId,
    view: () => {
      viewCalls += 1;
      return { activeTileId };
    },
    subscribe(listener) {
      runtimeListener = listener;
      return () => { runtimeListener = null; };
    },
  };
  const controller = registerGeographicContextOverlay({
    runtime,
    tileCatalog: catalog,
    onTileSelect: async () => {},
  });

  controller.attachMap(map);
  const move = map.listeners.get(`mousemove:${geographicContextLayerIds.tileSelection}`);
  move({ features: [{ properties: { tileId: 'B' } }] });
  move({ features: [{ properties: { tileId: 'B' } }] });

  assert.equal(viewCalls, 0, 'map attachment and pointer movement must not build full runtime views');
  assert.equal(map.canvas.style.cursor, 'pointer');

  activeTileId = 'B';
  runtimeListener({ type: 'projection-changed', tileId: 'B' }, { activeTileId: 'B' });
  move({ features: [{ properties: { tileId: 'B' } }] });

  assert.equal(viewCalls, 0, 'runtime refreshes must reuse the supplied active-tile state');
  assert.equal(map.canvas.style.cursor, '');
  assert.equal(
    map.sources.get(geographicContextLayerIds.boundarySource).data.features
      .find((feature) => feature.properties.tileId === 'B').properties.active,
    true,
  );
});

test('keeps tiled geography on the unified basemap and adds lightweight context sources', () => {
  const map = fixtureMap();
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  assert.ok(map.layers.has(geographicContextLayerIds.tileBoundaries));
  assert.deepEqual(map.layers.get(geographicContextLayerIds.tileSelection), {
    id: geographicContextLayerIds.tileSelection,
    type: 'fill',
    source: geographicContextLayerIds.boundarySource,
    maxzoom: 10,
    paint: {
      'fill-color': '#ffd166',
      'fill-opacity': ['case', ['boolean', ['get', 'hovered'], false], 0.28, 0],
    },
  });
  assert.deepEqual(map.layers.get(geographicContextLayerIds.worldOcean), {
    id: geographicContextLayerIds.worldOcean,
    type: 'fill',
    source: geographicContextLayerIds.worldOceanSource,
    maxzoom: 10,
    paint: { 'fill-color': '#102f68', 'fill-opacity': 1 },
  });
  assert.deepEqual(map.layers.get(geographicContextLayerIds.worldLand), {
    id: geographicContextLayerIds.worldLand,
    type: 'fill',
    source: geographicContextLayerIds.worldContextSource,
    'source-layer': 'world_land',
    maxzoom: 10,
    paint: { 'fill-color': '#1c3046', 'fill-opacity': 1 },
  });
  assert.deepEqual(map.layers.get(geographicContextLayerIds.worldLandHighZoom), {
    id: geographicContextLayerIds.worldLandHighZoom,
    type: 'fill',
    source: geographicContextLayerIds.worldContextSource,
    'source-layer': 'world_land',
    minzoom: 10,
    maxzoom: 24,
    paint: { 'fill-color': '#1c3046', 'fill-opacity': 1 },
  });
  assert.deepEqual(map.layers.get(geographicContextLayerIds.worldBoundaries), {
    id: geographicContextLayerIds.worldBoundaries,
    type: 'line',
    source: geographicContextLayerIds.worldContextSource,
    'source-layer': 'world_boundaries',
    minzoom: 1,
    maxzoom: 10,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#7890a6',
      'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.45, 6, 0.8, 9, 1.35],
      'line-opacity': 0.7,
      'line-dasharray': [3, 2],
    },
  });
  assert.deepEqual(map.layers.get(geographicContextLayerIds.worldBoundariesHighZoom), {
    id: geographicContextLayerIds.worldBoundariesHighZoom,
    type: 'line',
    source: geographicContextLayerIds.worldContextSource,
    'source-layer': 'world_boundaries',
    minzoom: 10,
    maxzoom: 24,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#7890a6',
      'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.45, 6, 0.8, 9, 1.35],
      'line-opacity': 0.7,
      'line-dasharray': [3, 2],
    },
  });
  assert.deepEqual(
    [...map.sources.keys()].sort(),
    [
      'general-tiles',
      geographicContextLayerIds.boundarySource,
      geographicContextLayerIds.worldContextSource,
      geographicContextLayerIds.worldOceanSource,
    ].sort(),
  );
  const ocean = map.sources.get(geographicContextLayerIds.worldOceanSource).data;
  assert.equal(ocean.features[0].geometry.type, 'Polygon');
  assert.deepEqual(ocean.features[0].geometry.coordinates[0][0], [-180, -85.05112878]);
  assert.deepEqual(map.insertions, [
    [geographicContextLayerIds.worldOcean, 'water'],
    [geographicContextLayerIds.worldLand, 'water'],
    [geographicContextLayerIds.worldLandHighZoom, 'water'],
    [geographicContextLayerIds.worldBoundaries, 'native-city-labels'],
    [geographicContextLayerIds.worldBoundariesHighZoom, 'native-city-labels'],
    [geographicContextLayerIds.tileSelection, undefined],
    [geographicContextLayerIds.tileBoundaries, undefined],
  ]);
  assert.equal(
    map.layers.get(geographicContextLayerIds.worldLand).maxzoom,
    map.layers.get(geographicContextLayerIds.worldLandHighZoom).minzoom,
    'world land layers must meet at one exact zoom without an ocean-only gap',
  );
  assert.equal(map.sources.get(geographicContextLayerIds.boundarySource).data.features[0].properties.active, true);
});

test('uses the original delegated MapLibre tile-selection pointer events', () => {
  const map = fixtureMap();
  map.setZoom(8);
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
    onTileSelect: async () => {},
  });
  controller.attachMap(map);

  assert.equal(map.listeners.has('mousemove'), false);
  assert.equal(map.listeners.has(`mousemove:${geographicContextLayerIds.tileSelection}`), true);
  assert.equal(map.listeners.has('click'), false);
  assert.equal(map.listeners.has(`click:${geographicContextLayerIds.tileSelection}`), true);
  controller.dispose();
});

test('removes stale delegated world-tile listeners left by a hot-reloaded controller', () => {
  const map = fixtureMap();
  const staleMove = () => {};
  const staleLeave = () => {};
  const staleClick = () => {};
  map._delegatedListeners = {
    mousemove: [{
      layers: [geographicContextLayerIds.tileSelection],
      listener: () => {},
      delegates: { mousemove: staleMove },
    }],
    mouseleave: [{
      layers: [geographicContextLayerIds.tileSelection],
      listener: () => {},
      delegates: { mousemove: staleMove, mouseout: staleLeave },
    }],
    click: [{
      layers: [geographicContextLayerIds.tileSelection],
      listener: () => {},
      delegates: { click: staleClick },
    }],
  };
  const removed = [];
  const originalOff = map.off;
  map.off = (...args) => {
    removed.push(args);
    return originalOff(...args);
  };
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
    onTileSelect: async () => {},
  });

  controller.attachMap(map);

  assert.deepEqual(map._delegatedListeners.mousemove, []);
  assert.deepEqual(map._delegatedListeners.mouseleave, []);
  assert.deepEqual(map._delegatedListeners.click, []);
  assert.ok(removed.some(([event, listener]) => event === 'mousemove' && listener === staleMove));
  assert.ok(removed.some(([event, listener]) => event === 'mouseout' && listener === staleLeave));
  assert.ok(removed.some(([event, listener]) => event === 'click' && listener === staleClick));
  controller.dispose();
});

test('replaces the previous geographic overlay controller during a hot reload', () => {
  const map = fixtureMap();
  const listenerSets = new Map();
  map.on = (event, layerOrCallback, callback) => {
    const key = typeof callback === 'function' ? `${event}:${layerOrCallback}` : event;
    const listeners = listenerSets.get(key) ?? new Set();
    listeners.add(callback ?? layerOrCallback);
    listenerSets.set(key, listeners);
  };
  map.off = (event, layerOrCallback, callback) => {
    const key = typeof callback === 'function' ? `${event}:${layerOrCallback}` : event;
    listenerSets.get(key)?.delete(callback ?? layerOrCallback);
  };
  let firstRuntimeUnsubscribes = 0;
  const first = registerGeographicContextOverlay({
    runtime: {
      getActiveTileId: () => 'A',
      subscribe: () => () => { firstRuntimeUnsubscribes += 1; },
    },
    tileCatalog: catalog,
  });
  const second = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });

  first.attachMap(map);
  assert.equal(listenerSets.get('zoom')?.size, 1);
  second.attachMap(map);

  assert.equal(first.map, null, 'the superseded controller must release its map');
  assert.equal(firstRuntimeUnsubscribes, 1);
  assert.equal(listenerSets.get('zoom')?.size, 1, 'one native zoom event must have one overlay handler');
  assert.equal(listenerSets.get('zoom')?.has(second.handleZoom), true);
  assert.equal(map.__deck.__openWorldMovementDeckVisibilityGuard.owners.size, 1);

  second.dispose();
  assert.equal(listenerSets.get('zoom')?.size, 0);
});

test('detaches from a foreign map without disposing its reusable runtime subscription', () => {
  const map = fixtureMap();
  const listenerSets = new Map();
  map.on = (event, layerOrCallback, callback) => {
    const key = typeof callback === 'function' ? `${event}:${layerOrCallback}` : event;
    const listeners = listenerSets.get(key) ?? new Set();
    listeners.add(callback ?? layerOrCallback);
    listenerSets.set(key, listeners);
  };
  map.off = (event, layerOrCallback, callback) => {
    const key = typeof callback === 'function' ? `${event}:${layerOrCallback}` : event;
    listenerSets.get(key)?.delete(callback ?? layerOrCallback);
  };
  let runtimeUnsubscribes = 0;
  const controller = registerGeographicContextOverlay({
    runtime: {
      getActiveTileId: () => 'A',
      subscribe: () => () => { runtimeUnsubscribes += 1; },
    },
    tileCatalog: catalog,
  });

  controller.attachMap(map);
  assert.equal(listenerSets.get('zoom')?.size, 1);
  controller.detachMap();

  assert.equal(controller.map, null);
  assert.equal(listenerSets.get('zoom')?.size, 0);
  assert.equal(runtimeUnsubscribes, 0, 'leaving a city must preserve the reusable controller');

  controller.attachMap(map);
  assert.equal(listenerSets.get('zoom')?.size, 1);
  controller.dispose();
  assert.equal(runtimeUnsubscribes, 1);
});

test('never overrides the native rendered-feature query method', () => {
  const map = fixtureMap();
  let nativeQueries = 0;
  const originalQueryRenderedFeatures = function queryRenderedFeatures() {
    nativeQueries += 1;
    return [{ id: 'native-detail-feature' }];
  };
  map.queryRenderedFeatures = originalQueryRenderedFeatures;
  map.setZoom(9);
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
    onTileSelect: async () => {},
  });

  controller.attachMap(map);

  assert.deepEqual(map.queryRenderedFeatures([0, 0], { layers: ['native-routes'] }), [
    { id: 'native-detail-feature' },
  ]);
  assert.equal(nativeQueries, 1);
  map.setZoom(10);
  assert.deepEqual(map.queryRenderedFeatures([0, 0], { layers: ['native-routes'] }), [
    { id: 'native-detail-feature' },
  ]);
  assert.equal(nativeQueries, 2);

  controller.dispose();
  assert.strictEqual(map.queryRenderedFeatures, originalQueryRenderedFeatures);
});

test('suspends hidden native hover delegates below zoom 10 and restores them exactly', () => {
  const map = fixtureMap();
  map.setZoom(9);
  const nativeMove = () => {};
  const nativeOut = () => {};
  map._delegatedListeners = {
    mouseenter: [{
      layers: ['native-stations'],
      listener: () => {},
      delegates: { mousemove: nativeMove, mouseout: nativeOut },
    }],
  };
  const calls = [];
  const originalOn = map.on;
  const originalOff = map.off;
  map.on = (...args) => { calls.push(['on', ...args]); return originalOn(...args); };
  map.off = (...args) => { calls.push(['off', ...args]); return originalOff(...args); };
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
    onTileSelect: async () => {},
  });

  controller.attachMap(map);
  assert.ok(calls.some(([operation, event, listener]) => (
    operation === 'off' && event === 'mousemove' && listener === nativeMove
  )));
  assert.ok(calls.some(([operation, event, listener]) => (
    operation === 'off' && event === 'mouseout' && listener === nativeOut
  )));

  calls.length = 0;
  map.setZoom(10);
  map.listeners.get('zoom')();
  assert.equal(calls.filter(([operation, event, listener]) => (
    operation === 'on' && event === 'mousemove' && listener === nativeMove
  )).length, 1);
  assert.equal(calls.filter(([operation, event, listener]) => (
    operation === 'on' && event === 'mouseout' && listener === nativeOut
  )).length, 1);

  calls.length = 0;
  map.listeners.get('zoom')();
  assert.equal(calls.filter(([operation, event, listener]) => (
    operation === 'on' && event === 'mousemove' && listener === nativeMove
  )).length, 0);
  controller.dispose();
});

test('highlights and switches a different world tile only below the detail cutoff', async () => {
  const map = fixtureMap();
  map.setZoom(9.99);
  const selected = [];
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
    onTileSelect: async (tileId) => { selected.push(tileId); },
  });
  controller.attachMap(map);

  const move = map.listeners.get(`mousemove:${geographicContextLayerIds.tileSelection}`);
  const click = map.listeners.get(`click:${geographicContextLayerIds.tileSelection}`);
  assert.equal(typeof move, 'function');
  assert.equal(typeof click, 'function');

  move({ features: [{ properties: { tileId: 'B' } }] });
  assert.equal(map.canvas.style.cursor, 'pointer');
  assert.equal(
    map.sources.get(geographicContextLayerIds.boundarySource).data.features
      .find((feature) => feature.properties.tileId === 'B').properties.hovered,
    true,
  );

  click({ features: [{ properties: { tileId: 'B' } }] });
  await Promise.resolve();
  assert.deepEqual(selected, ['B']);

  map.setZoom(10);
  map.listeners.get('zoom')();
  move({ features: [{ properties: { tileId: 'B' } }] });
  click({ features: [{ properties: { tileId: 'B' } }] });
  await Promise.resolve();
  assert.deepEqual(selected, ['B']);
  assert.equal(map.canvas.style.cursor, '');
});

test('never highlights or switches the active world tile', async () => {
  const map = fixtureMap();
  map.setZoom(8);
  const selected = [];
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
    onTileSelect: async (tileId) => { selected.push(tileId); },
  });
  controller.attachMap(map);

  map.listeners.get(`mousemove:${geographicContextLayerIds.tileSelection}`)({
    features: [{ properties: { tileId: 'A' } }],
  });
  map.listeners.get(`click:${geographicContextLayerIds.tileSelection}`)({
    features: [{ properties: { tileId: 'A' } }],
  });
  await Promise.resolve();

  assert.deepEqual(selected, []);
  assert.equal(map.canvas.style.cursor, '');
  assert.equal(
    map.sources.get(geographicContextLayerIds.boundarySource).data.features
      .some((feature) => feature.properties.hovered),
    false,
  );
});

test('renders the world ocean and land above the opaque native background without low-zoom place names', () => {
  const map = fixtureMap();
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const nativeBackgroundIndex = map.layerOrder.indexOf('native-background');
  const oceanIndex = map.layerOrder.indexOf(geographicContextLayerIds.worldOcean);
  const landIndex = map.layerOrder.indexOf(geographicContextLayerIds.worldLand);
  const nativeWaterIndex = map.layerOrder.indexOf('water');
  assert.ok(nativeBackgroundIndex < oceanIndex);
  assert.ok(oceanIndex < landIndex);
  assert.ok(landIndex < nativeWaterIndex);
  assert.equal(map.layers.get('native-city-labels').minzoom, 10);
  assert.equal(map.layers.get('native-city-labels').maxzoom, 24);
  assert.equal(map.layers.get('native-city-labels-secondary').minzoom, 10);
  assert.equal(map.layers.get('native-city-labels-secondary').maxzoom, 24);
});

test('gates the native DOM station markers to zooms 10 through 15', () => {
  const map = fixtureMap();
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  assert.equal(map.container.dataset.openWorldStationMarkers, 'visible');

  map.setZoom(9.99);
  map.listeners.get('zoom')();
  assert.equal(map.container.dataset.openWorldStationMarkers, 'hidden');

  map.setZoom(10);
  map.listeners.get('zoom')();
  assert.equal(map.container.dataset.openWorldStationMarkers, 'visible');

  map.setZoom(15.99);
  map.listeners.get('zoom')();
  assert.equal(map.container.dataset.openWorldStationMarkers, 'visible');

  map.setZoom(16);
  map.listeners.get('zoom')();
  assert.equal(map.container.dataset.openWorldStationMarkers, 'hidden');

  // Collision layers are not the React station markers, but the general
  // low-zoom native-detail gate still keeps them out of the overview.
  assert.equal(map.layers.get('station-collision-big').minzoom, 10);
  assert.equal(map.layers.get('station-collision-small').maxzoom, 24);
});

test('gates repeated native train and pop movement Deck updates with the station detail zoom', () => {
  const map = fixtureMap();
  const originalSetProps = map.__deck.setProps;
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const layer = (id) => map.__deck.props.layers.find((candidate) => candidate.id === id);
  assert.equal(layer('trains').props.visible, true);
  assert.equal(layer('pop-movements-deck').props.visible, true);

  map.setZoom(9.99);
  map.listeners.get('zoom')();
  assert.equal(layer('routes').props.visible, true);
  assert.equal(layer('trains').props.visible, false);
  assert.equal(layer('trains-under').props.visible, false);
  assert.equal(layer('pop-movements-deck').props.visible, false);

  // React replaces the layer instances as train positions change. The guard
  // must mask every incoming frame rather than only the initial layer array.
  map.__deck.setProps({
    layers: [
      fixtureDeckLayer('routes'),
      fixtureDeckLayer('trains', { data: [{ id: 'new-frame' }] }),
      fixtureDeckLayer('trains-under', { data: [{ id: 'new-frame' }] }),
      fixtureDeckLayer('pop-movements-deck'),
    ],
  });
  assert.equal(layer('trains').props.visible, false);
  assert.equal(layer('trains').props.data.length, 1);

  map.setZoom(10);
  map.listeners.get('zoom')();
  assert.equal(layer('trains').props.visible, true);

  // Respect a native/user-hidden layer when returning to detailed zoom.
  map.__deck.setProps({ layers: [fixtureDeckLayer('trains', { visible: false })] });
  map.setZoom(9);
  map.listeners.get('zoom')();
  map.setZoom(11);
  map.listeners.get('zoom')();
  assert.equal(layer('trains').props.visible, false);

  controller.dispose();
  assert.equal(map.__deck.setProps, originalSetProps);
});

test('gates the native Deck road layer families with the station detail zoom', () => {
  const map = fixtureMap();
  map.__deck.props.layers = [
    fixtureDeckLayer('road-lines-minor'),
    fixtureDeckLayer('road-lines-major'),
    fixtureDeckLayer('road-lines-highway'),
    fixtureDeckLayer('road-bridge-casing-highway'),
    fixtureDeckLayer('road-bridge-fill-highway'),
    fixtureDeckLayer('rail-network'),
  ];
  map.setZoom(9);
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const layer = (id) => map.__deck.props.layers.find((candidate) => candidate.id === id);
  assert.equal(layer('road-lines-major').props.visible, false);
  assert.equal(layer('road-bridge-casing-highway').props.visible, false);
  assert.equal(layer('road-bridge-fill-highway').props.visible, false);
  assert.equal(layer('rail-network').props.visible, true);

  map.setZoom(11.6);
  map.listeners.get('zoom')();
  assert.equal(layer('road-lines-minor').props.visible, false);
  assert.equal(layer('road-lines-major').props.visible, false);
  assert.equal(layer('road-lines-highway').props.visible, true);
  assert.equal(layer('road-bridge-casing-highway').props.visible, true);
  assert.equal(layer('road-bridge-fill-highway').props.visible, true);

  map.setZoom(12);
  map.listeners.get('zoom')();
  assert.equal(layer('road-lines-major').props.visible, true);
  assert.equal(layer('road-lines-minor').props.visible, false);

  map.setZoom(14);
  map.listeners.get('zoom')();
  assert.equal(layer('road-lines-minor').props.visible, true);

  // The native game recreates these GeoJsonLayers when road data changes.
  // The guard must mask those incoming instances too.
  map.setZoom(9);
  map.listeners.get('zoom')();
  map.__deck.setProps({
    layers: [
      fixtureDeckLayer('road-lines-major', { data: [{ id: 'new-frame' }] }),
      fixtureDeckLayer('road-bridge-fill-highway', { data: [{ id: 'new-frame' }] }),
    ],
  });
  assert.equal(layer('road-lines-major').props.visible, false);
  assert.equal(layer('road-bridge-fill-highway').props.visible, false);
  assert.equal(layer('road-lines-major').props.data.length, 1);

  controller.dispose();
});

test('shows only rail-line Deck layers below zoom 10', () => {
  const map = fixtureMap();
  map.__deck.props.layers = [
    fixtureDeckLayer('interlined-routes'),
    fixtureDeckLayer('routes'),
    fixtureDeckLayer('tracks-base'),
    fixtureDeckLayer('rail-network'),
    fixtureDeckLayer('demand'),
    fixtureDeckLayer('stations'),
    fixtureDeckLayer('buildings'),
    fixtureDeckLayer('trains'),
  ];
  map.setZoom(9);
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const visible = (id) => map.__deck.props.layers.find((layer) => layer.id === id).props.visible;
  for (const id of ['interlined-routes', 'routes', 'tracks-base', 'rail-network']) {
    assert.equal(visible(id), true, `${id} remains visible in the overview`);
  }
  for (const id of ['demand', 'stations', 'buildings', 'trains']) {
    assert.equal(visible(id), false, `${id} is hidden in the overview`);
  }

  map.setZoom(10);
  map.listeners.get('zoom')();
  for (const id of ['demand', 'stations', 'buildings', 'trains']) {
    assert.equal(visible(id), true, `${id} returns at detailed zoom`);
  }
  controller.dispose();
});

test('hides every native MapLibre detail layer below zoom 10 while preserving rail, water, and mod layers', () => {
  const map = fixtureMap();
  const roadMajor = { id: 'road-lines-major', type: 'line', source: 'general-tiles' };
  const roadHighway = { id: 'road-lines-highway', type: 'line', source: 'general-tiles' };
  const roadLabels = {
    id: 'road-labels',
    type: 'symbol',
    source: 'general-tiles',
    'source-layer': 'roads',
    minzoom: 15.75,
  };
  const rail = {
    id: 'rail-lines',
    type: 'line',
    source: 'general-tiles',
    'source-layer': 'rail',
  };
  const demand = { id: 'native-demand', type: 'circle', source: 'native-demand' };
  const buildings = { id: 'native-buildings', type: 'fill', source: 'general-tiles' };
  const lowOnly = { id: 'native-low-only', type: 'fill', source: 'general-tiles', maxzoom: 9 };
  const modOwned = { id: 'open-world-test-overlay', type: 'fill', source: 'general-tiles' };
  for (const layer of [roadMajor, roadHighway, roadLabels, rail, demand, buildings, lowOnly, modOwned]) {
    map.layers.set(layer.id, layer);
    map.layerOrder.push(layer.id);
  }
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  for (const layer of [roadMajor, roadHighway]) {
    assert.equal(layer.minzoom, layer.id === 'road-lines-highway' ? 10 : 12);
    assert.equal(layer.maxzoom, 24);
  }
  assert.equal(roadLabels.minzoom, 15.75);
  assert.equal(roadLabels.maxzoom, 24);
  assert.equal(rail.minzoom, undefined);
  assert.equal(rail.maxzoom, undefined);
  assert.equal(demand.minzoom, 10);
  assert.equal(demand.maxzoom, 24);
  assert.equal(buildings.minzoom, 10);
  assert.equal(buildings.maxzoom, 24);
  assert.equal(lowOnly.minzoom, 10);
  assert.equal(lowOnly.maxzoom, 10);
  assert.equal(modOwned.minzoom, undefined);
  assert.equal(map.layers.get('water').minzoom, undefined);
  assert.equal(map.layers.get('native-background').minzoom, undefined);
});

test('rebuilds the Deck layer tree only when a detail visibility band changes', () => {
  const map = fixtureMap();
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const initialSetPropsCalls = map.__deck.setPropsCalls;
  for (const zoom of [10.1, 10.2, 10.3, 11.4, 12.7, 15.9]) {
    map.setZoom(zoom);
    map.listeners.get('zoom')();
  }
  assert.equal(
    map.__deck.setPropsCalls,
    initialSetPropsCalls + 2,
    'crossing the major and minor road thresholds should each apply once',
  );

  map.setZoom(16);
  map.listeners.get('zoom')();
  assert.equal(map.__deck.setPropsCalls, initialSetPropsCalls + 3);

  map.setZoom(16.1);
  map.listeners.get('zoom')();
  assert.equal(map.__deck.setPropsCalls, initialSetPropsCalls + 3);

  controller.dispose();
});

test('replaces the previous movement Deck guard generation during a hot reload', () => {
  const map = fixtureMap();
  const firstController = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  firstController.attachMap(map);
  const guardKey = '__openWorldMovementDeckVisibilityGuard';
  const previousPatch = map.__deck[guardKey];
  const previousWrapper = map.__deck.setProps;
  previousPatch.version = 4;

  const reloadedController = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  reloadedController.attachMap(map);

  assert.notStrictEqual(map.__deck[guardKey], previousPatch);
  assert.notStrictEqual(map.__deck.setProps, previousWrapper);
  firstController.dispose();
  reloadedController.dispose();
});

test('profiles a map movement by stage without requiring verbose render diagnostics', () => {
  assert.equal(typeof globalThis.__enableOpenWorldMapMovePerfDebug, 'function');
  assert.equal(typeof globalThis.__printOpenWorldMapMovePerfDiagnostic, 'function');
  const map = fixtureMap();
  map.sources.set('all-nodes-source', {
    data: { type: 'FeatureCollection', features: [] },
    setData(data) { this.data = data; },
  });
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);
  const originalConsoleInfo = console.info;
  console.info = () => {};
  try {
    globalThis.__enableOpenWorldMapMovePerfDebug({ slowMs: Number.MAX_SAFE_INTEGER, reset: true });
    map.listeners.get('movestart')();
    map.setZoom(16);
    map.listeners.get('zoom')();
    map.listeners.get('move')();
    map.sources.get('all-nodes-source').setData({ type: 'FeatureCollection', features: [] });
    map.listeners.get('styledata')();
    map.listeners.get('moveend')();

    const report = globalThis.__printOpenWorldMapMovePerfDiagnostic();
    assert.equal(report.stages['map.zoom.total'].count, 1);
    assert.ok(report.stages['marker.visibility'].count >= 1);
    assert.ok(report.stages['deck.apply.total'].count >= 1);
    assert.equal(report.stages['maplibre.spatial-source.clip'].count, 1);
    assert.equal(report.stages['maplibre.spatial-source.setData'].count, 1);
    assert.equal(report.stages['map.styledata.work'].count, 1);
    assert.equal(report.moves.length, 1);
    assert.equal(report.moves[0].moveEvents, 1);
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalConsoleInfo;
    controller.dispose();
  }
});

test('quiet map movement profiling retains slow samples without live warnings', () => {
  const map = fixtureMap();
  map._render = function renderNativeMap() { return 'map-rendered'; };
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);
  const originalConsoleInfo = console.info;
  const originalConsoleWarn = console.warn;
  const warnings = [];
  console.info = () => {};
  console.warn = (...args) => warnings.push(args);
  try {
    const status = globalThis.__enableOpenWorldMapMovePerfDebug({
      slowMs: 0,
      frameGapSlowMs: 0,
      quiet: true,
      reset: true,
    });
    map.listeners.get('movestart')();
    map.listeners.get('move')();
    assert.equal(map._render(), 'map-rendered');
    map.listeners.get('moveend')();

    const report = globalThis.__printOpenWorldMapMovePerfDiagnostic();
    assert.equal(status.quiet, true);
    assert.equal(report.quiet, true);
    assert.equal(report.stages['maplibre.map._render'].slowCount, 1);
    assert.equal(report.slowEvents.some((event) => event.stage === 'maplibre.map._render'), true);
    assert.equal(report.moves.length, 1);
    assert.equal(warnings.length, 0);
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalConsoleInfo;
    console.warn = originalConsoleWarn;
    controller.dispose();
  }
});

test('preserves profiler samples recorded by an older hot-reload generation', () => {
  const originalConsoleInfo = console.info;
  console.info = () => {};
  try {
    globalThis.__enableOpenWorldMapMovePerfDebug({ slowMs: 8, reset: true });
    globalThis.__OPEN_WORLD_MAP_MOVE_PERF_DEBUG_STATE = {
      version: 'map-move-perf-v1',
      createdAt: Date.now(),
      slowMs: 8,
      frameGapSlowMs: 50,
      stages: {
        'browser.long-task': {
          count: 2,
          totalMs: 300,
          averageMs: 150,
          maxMs: 200,
          slowCount: 2,
          lastMs: 100,
        },
      },
      moves: [{ id: 41, durationMs: 320, moveEvents: 5, maxFrameGapMs: 200 }],
      slowEvents: [{ stage: 'browser.long-task', durationMs: 200 }],
    };

    const report = globalThis.__printOpenWorldMapMovePerfDiagnostic();
    assert.equal(report.stages['browser.long-task'].count, 2);
    assert.equal(report.moves[0].id, 41);
    assert.equal(report.slowEvents[0].durationMs, 200);
    assert.ok(report.sources.some((source) => source.version === 'map-move-perf-v1'));
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalConsoleInfo;
  }
});

test('profiles native render methods and movement independently of controller generation', () => {
  const map = fixtureMap();
  map._render = function renderNativeMap() { return 'map-rendered'; };
  map.painter = { render() { return 'painted'; } };
  map.__deck.animationLoop = { _renderFrame() { return 'deck-frame'; } };
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);
  map.listeners.delete('movestart');
  map.listeners.delete('move');
  map.listeners.delete('moveend');
  const originalConsoleInfo = console.info;
  console.info = () => {};
  try {
    globalThis.__enableOpenWorldMapMovePerfDebug({
      slowMs: Number.MAX_SAFE_INTEGER,
      reset: true,
    });
    map.listeners.get('movestart')();
    map.listeners.get('move')();
    assert.equal(map._render(), 'map-rendered');
    assert.equal(map.painter.render(), 'painted');
    assert.equal(map.__deck.animationLoop._renderFrame(), 'deck-frame');
    map.listeners.get('moveend')();

    const report = globalThis.__printOpenWorldMapMovePerfDiagnostic();
    assert.equal(report.moves.length, 1);
    assert.equal(report.moves[0].source, 'profiler-probe');
    assert.equal(report.stages['maplibre.map._render'].count, 1);
    assert.equal(report.stages['maplibre.painter.render'].count, 1);
    assert.equal(report.stages['deck.animationLoop._renderFrame'].count, 1);
    assert.ok(report.probes.includes('maplibre.map._render'));
    assert.ok(report.probes.includes('deck.animationLoop._renderFrame'));
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalConsoleInfo;
    controller.dispose();
  }
});

test('installs native profiler probes when the map attaches after profiling is enabled', () => {
  delete globalThis.__openWorldToolboxRenderMap;
  const originalConsoleInfo = console.info;
  console.info = () => {};
  let controller = null;
  try {
    const initialStatus = globalThis.__enableOpenWorldMapMovePerfDebug({
      slowMs: Number.MAX_SAFE_INTEGER,
      reset: true,
    });
    assert.equal(initialStatus.probes.mapAvailable, false);

    const map = fixtureMap();
    map._render = function renderNativeMap() { return 'map-rendered'; };
    controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
      tileCatalog: catalog,
    });
    controller.attachMap(map);
    assert.equal(map._render(), 'map-rendered');

    const report = globalThis.__printOpenWorldMapMovePerfDiagnostic();
    assert.ok(report.probes.includes('maplibre.map._render'));
    assert.equal(report.stages['maplibre.map._render'].count, 1);
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalConsoleInfo;
    controller?.dispose();
  }
});

test('records one movement trace when MapLibre supports multiple event listeners', () => {
  const map = fixtureMap();
  const eventListeners = new Map();
  map.on = (event, layerOrCallback, callback) => {
    const key = typeof callback === 'function' ? `${event}:${layerOrCallback}` : event;
    const listener = callback ?? layerOrCallback;
    const listeners = eventListeners.get(key) ?? new Set();
    listeners.add(listener);
    eventListeners.set(key, listeners);
  };
  map.off = (event, layerOrCallback, callback) => {
    const key = typeof callback === 'function' ? `${event}:${layerOrCallback}` : event;
    eventListeners.get(key)?.delete(callback ?? layerOrCallback);
  };
  const emit = (event) => {
    for (const listener of eventListeners.get(event) ?? []) listener();
  };
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);
  const originalConsoleInfo = console.info;
  console.info = () => {};
  try {
    globalThis.__enableOpenWorldMapMovePerfDebug({
      slowMs: Number.MAX_SAFE_INTEGER,
      reset: true,
    });
    emit('movestart');
    emit('move');
    emit('moveend');

    const report = globalThis.__printOpenWorldMapMovePerfDiagnostic();
    assert.equal(report.moves.length, 1);
    assert.equal(report.moves[0].source, 'profiler-probe');
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalConsoleInfo;
    controller.dispose();
  }
});

test('profiles synchronous MapLibre event dispatch separately from rendering', () => {
  const map = fixtureMap();
  map.fire = function fireNativeEvent(event) { return event; };
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);
  const originalConsoleInfo = console.info;
  console.info = () => {};
  try {
    globalThis.__enableOpenWorldMapMovePerfDebug({
      slowMs: Number.MAX_SAFE_INTEGER,
      reset: true,
    });
    assert.equal(map.fire('move'), 'move');

    const report = globalThis.__printOpenWorldMapMovePerfDiagnostic();
    assert.equal(report.stages['maplibre.event.move'].count, 1);
    assert.ok(report.probes.includes('maplibre.event.*'));
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalConsoleInfo;
    controller.dispose();
  }
});

test('retains browser stall details outside the routine slow-render event buffer', () => {
  const originalPerformanceObserver = globalThis.PerformanceObserver;
  const observers = [];
  class FixturePerformanceObserver {
    static supportedEntryTypes = ['longtask'];
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  globalThis.PerformanceObserver = FixturePerformanceObserver;
  const originalConsoleInfo = console.info;
  const originalConsoleWarn = console.warn;
  console.info = () => {};
  console.warn = () => {};
  try {
    globalThis.__enableOpenWorldMapMovePerfDebug({ slowMs: 8, reset: true });
    observers[0].callback({
      getEntries: () => [{
        duration: 175,
        startTime: 42,
        name: 'self',
        attribution: [],
      }],
    });

    const report = globalThis.__printOpenWorldMapMovePerfDiagnostic();
    assert.equal(report.browserEvents.length, 1);
    assert.equal(report.browserEvents[0].stage, 'browser.long-task');
    assert.equal(report.browserEvents[0].durationMs, 175);
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalConsoleInfo;
    console.warn = originalConsoleWarn;
    globalThis.PerformanceObserver = originalPerformanceObserver;
  }
});

test('masks a movement Deck layer added after map attachment', () => {
  const map = fixtureMap();
  map.setZoom(9);
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  map.__deck.setProps({ layers: [fixtureDeckLayer('trains-3d')] });

  assert.equal(map.__deck.props.layers[0].id, 'trains-3d');
  assert.equal(map.__deck.props.layers[0].props.visible, false);
});

test('clips native rail Deck data to the active tile halo', () => {
  const map = fixtureMap();
  map.__deck.props.layers = [fixtureDeckLayer('rail-network', {
    data: [{ id: 'crossing-rail', coords: [[-76, 40.5], [-73, 40.5]] }],
  })];
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const rail = map.__deck.props.layers[0];
  assert.deepEqual(rail.props.data[0].coords, [
    [[-75, 40.5], [-74, 40.5]],
    [[-74, 40.5], [-73, 40.5]],
  ]);
});

test('clips native GeoJsonLayer FeatureCollections before Deck expands rail sublayers', () => {
  const map = fixtureMap();
  map.__deck.props.layers = [fixtureDeckLayer('tracks', {
    data: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { trackId: 'crossing-track' },
        geometry: {
          type: 'LineString',
          coordinates: [[-76, 40.5], [-73, 40.5]],
        },
      }],
    },
  })];
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const rail = map.__deck.props.layers[0];
  assert.equal(rail.props.data.features[0].geometry.type, 'MultiLineString');
  assert.deepEqual(rail.props.data.features[0].geometry.coordinates, [
    [[-75, 40.5], [-74, 40.5]],
    [[-74, 40.5], [-73, 40.5]],
  ]);
});

test('clips native station and route placement nodes at the MapLibre source boundary', () => {
  const map = fixtureMap();
  const source = {
    data: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { id: 'inside-node' }, geometry: { type: 'Point', coordinates: [-74.5, 40.5] } },
        { type: 'Feature', properties: { id: 'outside-node' }, geometry: { type: 'Point', coordinates: [-72.5, 40.5] } },
      ],
    },
    setData(data) { this.data = data; },
  };
  map.sources.set('all-nodes-source', source);
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  assert.deepEqual(
    source.data.features.map((feature) => feature.properties.id),
    ['inside-node'],
  );
  source.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { id: 'new-outside-node' },
      geometry: { type: 'Point', coordinates: [-72.5, 40.5] },
    }],
  });
  assert.equal(source.data.features.length, 0);
  controller.dispose();
});

test('clips already-materialized Deck rail layers that only retain state.features', () => {
  const map = fixtureMap();
  const layer = fixtureDeckLayer('tracks');
  delete layer.props.data;
  layer.state = {
    features: [{
      type: 'Feature',
      properties: { trackId: 'materialized-track' },
      geometry: {
        type: 'LineString',
        coordinates: [[-76, 40.5], [-73, 40.5]],
      },
    }],
  };
  map.__deck.props.layers = [layer];
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const rendered = map.__deck.props.layers[0];
  assert.equal(rendered.props.data[0].geometry.type, 'MultiLineString');
  assert.deepEqual(rendered.props.data[0].geometry.coordinates, [
    [[-75, 40.5], [-74, 40.5]],
    [[-74, 40.5], [-73, 40.5]],
  ]);
});

test('clips materialized CompositeLayer sources retained under state.layerProps', () => {
  const map = fixtureMap();
  const layer = fixtureDeckLayer('tracks-base');
  delete layer.props.data;
  layer.state = {
    layerProps: {
      data: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { trackId: 'composite-track' },
          geometry: {
            type: 'LineString',
            coordinates: [[-76, 40.5], [-73, 40.5]],
          },
        }],
      },
    },
  };
  map.__deck.props.layers = [layer];
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const rendered = map.__deck.props.layers[0];
  assert.equal(rendered.props.data.features[0].geometry.type, 'MultiLineString');
});

test('reuses the clipped FeatureCollection identity across equivalent Deck updates', () => {
  const map = fixtureMap();
  const source = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { trackId: 'stable-track' },
      geometry: {
        type: 'LineString',
        coordinates: [[-76, 40.5], [-73, 40.5]],
      },
    }],
  };
  map.__deck.props.layers = [fixtureDeckLayer('tracks', { data: source })];
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);
  const firstRenderedLayer = map.__deck.props.layers[0];
  const firstRenderedData = map.__deck.props.layers[0].props.data;

  // Native hover updates recreate layer instances but retain the same network
  // FeatureCollection. The clipped data object must remain stable.
  map.__deck.setProps({ layers: [fixtureDeckLayer('tracks', { data: source })] });
  const secondRenderedLayer = map.__deck.props.layers[0];
  const secondRenderedData = map.__deck.props.layers[0].props.data;

  assert.strictEqual(secondRenderedLayer, firstRenderedLayer);
  assert.strictEqual(secondRenderedData, firstRenderedData);
});

test('reuses movement clipping across recreated equivalent data and invalidates changed content', () => {
  let controller;
  let irrelevantPayloadReads = 0;
  try {
    globalThis.__enableOpenWorldMapMovePerfDebug({
      slowMs: Number.MAX_SAFE_INTEGER,
      reset: true,
    });
    const map = fixtureMap();
    const irrelevantPayload = { blob: 'x'.repeat(100_000) };
    Object.defineProperty(irrelevantPayload, 'mustNotTraverse', {
      enumerable: true,
      get() {
        irrelevantPayloadReads += 1;
        throw new Error('movement cache traversed an irrelevant payload');
      },
    });
    const canonicalSource = Array.from({ length: 1_000 }, (_, index) => ({
      id: `movement-${index}`,
      coords: index % 2 === 0 ? [-74.5, 40.5] : [-72, 40.5],
      passengers: index,
      irrelevantPayload,
    }));
    const movementLayer = () => fixtureDeckLayer(
      'pop-movements-deck',
      {
        data: canonicalSource.map((entry) => ({
          ...entry,
          coords: [...entry.coords],
        })),
      },
    );
    map.__deck.props.layers = [movementLayer()];
    controller = registerGeographicContextOverlay({
      runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
      tileCatalog: catalog,
    });

    controller.attachMap(map);
    const state = globalThis.__OPEN_WORLD_MAP_MOVE_PERF_DEBUG_STATE_V4;
    assert.equal(state.stages['deck.spatial.clip'].count, 1);
    assert.equal(map.__deck.props.layers[0].props.data.length, 500);

    for (let index = 0; index < 20; index += 1) {
      map.__deck.setProps({ layers: [movementLayer()] });
    }
    assert.equal(
      state.stages['deck.spatial.clip'].count,
      1,
      'equivalent native frames must reuse the first spatial clip',
    );
    assert.equal(
      state.stages['deck.spatial.compare'].count,
      20,
      'each recreated frame should take the comparison path instead of clipping',
    );
    assert.equal(irrelevantPayloadReads, 0);

    canonicalSource[0].passengers += 1;
    map.__deck.setProps({ layers: [movementLayer()] });
    assert.equal(
      state.stages['deck.spatial.clip'].count,
      1,
      'fresh non-spatial properties must not force another spatial clip',
    );
    assert.equal(state.stages['deck.spatial.compare'].count, 21);
    assert.equal(
      map.__deck.props.layers[0].props.data.find((entry) => entry.id === 'movement-0')?.passengers,
      1,
      'cache reuse must forward fresh non-spatial properties',
    );

    canonicalSource[1].coords = [-74.25, 40.5];
    map.__deck.setProps({ layers: [movementLayer()] });
    assert.equal(state.stages['deck.spatial.clip'].count, 2);
    assert.equal(state.stages['deck.spatial.compare'].count, 22);
    assert.equal(map.__deck.props.layers[0].props.data.length, 501);
    assert.equal(
      map.__deck.props.layers[0].props.data.find((entry) => entry.id === 'movement-1')?.passengers,
      1,
    );

    const retainedLayer = movementLayer();
    map.__deck.setProps({ layers: [retainedLayer] });
    assert.equal(state.stages['deck.spatial.clip'].count, 2);
    retainedLayer.props.data[1].coords = [-72, 40.5];
    map.__deck.setProps({ layers: [retainedLayer] });
    assert.equal(
      state.stages['deck.spatial.clip'].count,
      3,
      'in-place spatial mutation must invalidate membership even when layer and data identities remain stable',
    );
    assert.equal(map.__deck.props.layers[0].props.data.length, 500);
    assert.equal(irrelevantPayloadReads, 0);
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    controller?.dispose();
  }
});

test('rebuilds volatile interlined route layers after in-place geometry mutation', () => {
  for (const layerId of ['interlined-routes', 'interlined-routes-under']) {
    const map = fixtureMap();
    const source = [{
      type: 'Feature',
      properties: { routeId: 'mutable-interline' },
      geometry: {
        type: 'LineString',
        coordinates: [[-74.8, 40.5], [-74.4, 40.5]],
      },
    }];
    map.__deck.props.layers = [fixtureDeckLayer(layerId, { data: source })];
    const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
      tileCatalog: catalog,
    });
    controller.attachMap(map);
    const firstRenderedLayer = map.__deck.props.layers[0];
    const firstRenderedData = firstRenderedLayer.props.data;

    // Subway Builder retains the two-item interline array and mutates the
    // contained route coordinates as construction changes route topology.
    source[0].geometry.coordinates.push([-74.1, 40.5]);
    map.__deck.setProps({ layers: [fixtureDeckLayer(layerId, { data: source })] });
    const secondRenderedLayer = map.__deck.props.layers[0];
    const secondRenderedData = secondRenderedLayer.props.data;

    assert.notStrictEqual(secondRenderedLayer, firstRenderedLayer, layerId);
    assert.notStrictEqual(secondRenderedData, firstRenderedData, layerId);
    assert.deepEqual(secondRenderedData[0].geometry.coordinates, [
      [-74.8, 40.5],
      [-74.4, 40.5],
      [-74.1, 40.5],
    ], layerId);
    controller.dispose();
  }
});

test('clips a shared volatile interline source only when its content changes', () => {
  const originalConsoleWarn = console.warn;
  const originalConsoleInfo = console.info;
  console.warn = () => {};
  console.info = () => {};
  let controller;
  try {
    globalThis.__enableOpenWorldMapMovePerfDebug({
      slowMs: Number.MAX_SAFE_INTEGER,
      reset: true,
    });
    const map = fixtureMap();
    const source = [{
      type: 'Feature',
      properties: {
        routeIds: ['shared-interline'],
        offset: [-4, 4],
      },
      geometry: {
        type: 'LineString',
        coordinates: [[-74.8, 40.5], [-74.4, 40.5]],
      },
    }];
    const nativeLayers = () => [
      fixtureDeckLayer('interlined-routes-under', { data: source }),
      fixtureDeckLayer('interlined-routes', { data: source }),
    ];
    map.__deck.props.layers = nativeLayers();
    controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
      tileCatalog: catalog,
    });

    controller.attachMap(map);
    const state = globalThis.__OPEN_WORLD_MAP_MOVE_PERF_DEBUG_STATE_V4;
    const firstRenderedData = map.__deck.props.layers[0].props.data;
    assert.equal(state.stages['deck.interlining.clip'].count, 1);
    assert.strictEqual(map.__deck.props.layers[1].props.data, firstRenderedData);

    for (let index = 0; index < 20; index += 1) {
      map.__deck.setProps({ layers: nativeLayers() });
    }
    assert.equal(state.stages['deck.interlining.clip'].count, 1);
    assert.strictEqual(map.__deck.props.layers[0].props.data, firstRenderedData);

    source[0].geometry.coordinates.push([-74.1, 40.5]);
    source[0].properties.offset.push(8);
    map.__deck.setProps({ layers: nativeLayers() });

    assert.equal(state.stages['deck.interlining.clip'].count, 2);
    assert.notStrictEqual(map.__deck.props.layers[0].props.data, firstRenderedData);
    assert.strictEqual(
      map.__deck.props.layers[1].props.data,
      map.__deck.props.layers[0].props.data,
    );

    source[0].properties.routeIds[0] = 'renamed-interline';
    map.__deck.setProps({ layers: nativeLayers() });
    assert.equal(state.stages['deck.interlining.clip'].count, 3);
    assert.equal(map.__deck.props.layers[0].props.data[0].properties.routeIds[0], 'renamed-interline');
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.warn = originalConsoleWarn;
    console.info = originalConsoleInfo;
    controller?.dispose();
  }
});

test('reuses interline clipping when native updates recreate equivalent source arrays', () => {
  const originalConsoleInfo = console.info;
  console.info = () => {};
  let controller;
  try {
    globalThis.__enableOpenWorldMapMovePerfDebug({
      slowMs: Number.MAX_SAFE_INTEGER,
      reset: true,
    });
    const map = fixtureMap();
    const canonicalSource = [{
      type: 'Feature',
      properties: {
        routeIds: ['recreated-interline'],
        offset: [-4, 4],
      },
      geometry: {
        type: 'LineString',
        coordinates: [[-74.8, 40.5], [-74.4, 40.5]],
      },
    }];
    const copySource = () => structuredClone(canonicalSource);
    const nativeLayers = () => [
      fixtureDeckLayer('interlined-routes-under', { data: copySource() }),
      fixtureDeckLayer('interlined-routes', { data: copySource() }),
    ];
    map.__deck.props.layers = nativeLayers();
    let interliningRevision = 1;
    controller = registerGeographicContextOverlay({
    runtime: {
      getActiveTileId: () => 'A',
      getInterliningRevision: () => interliningRevision,
      subscribe: () => () => {},
    },
      tileCatalog: catalog,
    });

    controller.attachMap(map);
    const state = globalThis.__OPEN_WORLD_MAP_MOVE_PERF_DEBUG_STATE_V4;
    assert.equal(state.stages['deck.interlining.clip'].count, 1);
    assert.equal(state.stages['deck.interlining.compare']?.count ?? 0, 0);
    const firstRenderedData = map.__deck.props.layers[0].props.data;
    assert.strictEqual(map.__deck.props.layers[1].props.data, firstRenderedData);

    for (let index = 0; index < 20; index += 1) {
      map.__deck.setProps({ layers: nativeLayers() });
    }
    assert.equal(state.stages['deck.interlining.clip'].count, 1);
    assert.equal(state.stages['deck.interlining.compare']?.count ?? 0, 0);

    interliningRevision += 1;
    canonicalSource[0].geometry.coordinates.push([-74.1, 40.5]);
    canonicalSource[0].properties.offset.push(8);
    map.__deck.setProps({ layers: nativeLayers() });
    assert.equal(state.stages['deck.interlining.clip'].count, 2);
    assert.equal(state.stages['deck.interlining.compare']?.count ?? 0, 0);
  } finally {
    globalThis.__enableOpenWorldMapMovePerfDebug(false);
    console.info = originalConsoleInfo;
    controller?.dispose();
  }
});

test('clips interlined routes to the render halo while preserving aligned native offset buffers', () => {
  const map = fixtureMap();
  const coordinates = [
    [-76, 40.5],
    [-75, 40.5],
    [-74, 40.5],
    [-73, 40.5],
    [-72, 40.5],
  ];
  const source = [{
    type: 'Feature',
    properties: {
      type: 'parallelRoute',
      routeIds: ['cross-halo-route'],
      // Subway Builder emits one custom offset attribute per path vertex.
      offset: [-4, -4, 0, 4, 4],
    },
    geometry: { type: 'LineString', coordinates },
  }];
  map.__deck.props.layers = [fixtureDeckLayer('interlined-routes', { data: source })];
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });

  controller.attachMap(map);

  const rendered = map.__deck.props.layers[0].props.data[0];
  assert.equal(rendered.geometry.type, 'LineString');
  assert.deepEqual(rendered.geometry.coordinates, [
    [-75, 40.5],
    [-74, 40.5],
    [-73, 40.5],
  ]);
  assert.deepEqual(rendered.properties.offset, [-4, 0, 4]);
  assert.equal(rendered.geometry.coordinates.length, rendered.properties.offset.length);
  assert.deepEqual(source[0].geometry.coordinates, coordinates);
  assert.deepEqual(source[0].properties.offset, [-4, -4, 0, 4, 4]);
  assert.doesNotThrow(() => {
    const nativeAttributeBuffer = new Float32Array(rendered.geometry.coordinates.length);
    nativeAttributeBuffer.set(rendered.properties.offset);
  });
  controller.dispose();
});

test('skips Deck setProps when a native update produces the same masked layer tree', () => {
  const map = fixtureMap();
  const source = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { trackId: 'unchanged-track' },
      geometry: { type: 'LineString', coordinates: [[-76, 40.5], [-73, 40.5]] },
    }],
  };
  map.__deck.props.layers = [fixtureDeckLayer('tracks', { data: source })];
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const callsAfterAttach = map.__deck.setPropsCalls;
  map.__deck.setProps({ layers: [fixtureDeckLayer('tracks', { data: source })] });
  assert.equal(map.__deck.setPropsCalls, callsAfterAttach);
  controller.dispose();
});

test('captures the actual runtime layer order and source metadata for ocean diagnosis', () => {
  const map = fixtureMap();
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const diagnostic = mapLayerDiagnostic(map);
  assert.equal(diagnostic.styleLoaded, true);
  assert.equal(diagnostic.ocean.sourcePresent, true);
  assert.equal(diagnostic.ocean.layerPresent, true);
  assert.deepEqual(diagnostic.stationMarkers, {
    visibilityState: 'visible',
    domMatches: 0,
    minZoom: 10,
    maxZoomExclusive: 16,
  });
  assert.deepEqual(diagnostic.movementLayers, {
    maplibreZoomRangeInstalled: false,
    visibleAtCurrentZoom: true,
    layerIds: [],
    minZoom: 10,
    maxZoomExclusive: 16,
  });
  assert.ok(diagnostic.ocean.layerIndex > diagnostic.ocean.nativeBackgroundIndex);
  assert.ok(diagnostic.ocean.layerIndex < diagnostic.ocean.landLayerIndex);
  assert.deepEqual(
    diagnostic.layers
      .filter((layer) => layer.sourceLayer === 'city_labels')
      .map((layer) => [layer.id, layer.minzoom]),
    [['native-city-labels', 10], ['native-city-labels-secondary', 10]],
  );
  assert.ok(diagnostic.sources.some((source) => source.id === geographicContextLayerIds.worldOceanSource));
});

test('installs geographic context when the map becomes idle after an initially unready attach', () => {
  const map = fixtureMap();
  let styleLoaded = false;
  let idleCallback = null;
  map.isStyleLoaded = () => styleLoaded;
  map.once = (event, callback) => {
    if (event === 'idle') idleCallback = callback;
  };
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });

  controller.attachMap(map);
  assert.equal(map.layers.has(geographicContextLayerIds.worldOcean), false);
  assert.equal(typeof idleCallback, 'function');

  styleLoaded = true;
  idleCallback();
  assert.equal(map.layers.has(geographicContextLayerIds.worldOcean), true);
  assert.equal(map.layers.has(geographicContextLayerIds.worldLand), true);
});

test('survives styledata while MapLibre temporarily detaches its internal style', () => {
  const map = fixtureMap();
  const controller = registerGeographicContextOverlay({
    runtime: { getActiveTileId: () => 'A', subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const handleStyleData = map.listeners.get('styledata');
  assert.equal(typeof handleStyleData, 'function');
  const originalGetSource = map.getSource;
  map.getSource = () => {
    throw new TypeError("Cannot read properties of undefined (reading 'getSource')");
  };

  assert.doesNotThrow(() => handleStyleData());

  map.getSource = originalGetSource;
  for (const id of [
    geographicContextLayerIds.worldOcean,
    geographicContextLayerIds.worldLand,
    geographicContextLayerIds.worldLandHighZoom,
    geographicContextLayerIds.worldBoundaries,
    geographicContextLayerIds.worldBoundariesHighZoom,
  ]) map.removeLayer(id);
  for (const id of [
    geographicContextLayerIds.worldOceanSource,
    geographicContextLayerIds.worldContextSource,
  ]) map.sources.delete(id);

  assert.doesNotThrow(() => map.listeners.get('style.load')());
  assert.ok(map.sources.has(geographicContextLayerIds.worldContextSource));
  assert.equal(
    map.layers.get(geographicContextLayerIds.worldLand).source,
    geographicContextLayerIds.worldContextSource,
  );
});
