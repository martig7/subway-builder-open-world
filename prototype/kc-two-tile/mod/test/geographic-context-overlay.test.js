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
    sources, layers, layerOrder, insertions, listeners, container, __deck: deck,
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
    moveLayer: (id, beforeId) => {
      layerOrder.splice(layerOrder.indexOf(id), 1);
      const index = beforeId == null ? layerOrder.length : layerOrder.indexOf(beforeId);
      layerOrder.splice(index < 0 ? layerOrder.length : index, 0, id);
    },
    setLayerZoomRange: (id, minzoom, maxzoom) => Object.assign(layers.get(id), { minzoom, maxzoom }),
    getContainer: () => container,
    getZoom: () => zoom,
    setZoom: (nextZoom) => { zoom = nextZoom; },
    on: (event, callback) => listeners.set(event, callback),
    off: (event, callback) => {
      if (listeners.get(event) === callback) listeners.delete(event);
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
  const data = tileBoundaryGeoJson(catalog, 'B');
  assert.equal(data.features.length, 2);
  assert.deepEqual(data.features.map((feature) => feature.properties.active), [false, true]);
  assert.deepEqual(data.features[0].geometry.coordinates[0][0], [-75, 40]);
});

test('keeps tiled geography on the unified basemap and adds lightweight context sources', () => {
  const map = fixtureMap();
  const controller = registerGeographicContextOverlay({
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  assert.ok(map.layers.has(geographicContextLayerIds.tileBoundaries));
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
    source: 'general-tiles',
    'source-layer': 'world_land',
    maxzoom: 24,
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
    source: 'general-tiles',
    'source-layer': 'world_boundaries',
    minzoom: 1,
    maxzoom: 24,
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
    [geographicContextLayerIds.tileBoundaries, undefined],
  ]);
  assert.equal(map.sources.get(geographicContextLayerIds.boundarySource).data.features[0].properties.active, true);
});

test('renders the world ocean and land above the opaque native background without low-zoom place names', () => {
  const map = fixtureMap();
  const controller = registerGeographicContextOverlay({
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
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
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
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

  // Collision layers are deliberately invisible in the native bundle and
  // must not be mistaken for the React station markers.
  assert.equal(map.layers.get('station-collision-big').minzoom, undefined);
  assert.equal(map.layers.get('station-collision-small').maxzoom, undefined);
});

test('gates repeated native train and pop movement Deck updates with the station detail zoom', () => {
  const map = fixtureMap();
  const originalSetProps = map.__deck.setProps;
  const controller = registerGeographicContextOverlay({
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
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
    fixtureDeckLayer('road-lines-major'),
    fixtureDeckLayer('road-bridge-casing-highway'),
    fixtureDeckLayer('road-bridge-fill-highway'),
    fixtureDeckLayer('rail-network'),
  ];
  map.setZoom(9);
  const controller = registerGeographicContextOverlay({
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const layer = (id) => map.__deck.props.layers.find((candidate) => candidate.id === id);
  assert.equal(layer('road-lines-major').props.visible, false);
  assert.equal(layer('road-bridge-casing-highway').props.visible, false);
  assert.equal(layer('road-bridge-fill-highway').props.visible, false);
  assert.equal(layer('rail-network').props.visible, true);

  map.setZoom(10);
  map.listeners.get('zoom')();
  assert.equal(layer('road-lines-major').props.visible, true);
  assert.equal(layer('road-bridge-casing-highway').props.visible, true);
  assert.equal(layer('road-bridge-fill-highway').props.visible, true);

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

test('hides native road layers below detail zoom without hiding rail layers', () => {
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
  for (const layer of [roadMajor, roadHighway, roadLabels, rail]) {
    map.layers.set(layer.id, layer);
    map.layerOrder.push(layer.id);
  }
  const controller = registerGeographicContextOverlay({
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  for (const layer of [roadMajor, roadHighway]) {
    assert.equal(layer.minzoom, 10);
    assert.equal(layer.maxzoom, 24);
  }
  assert.equal(roadLabels.minzoom, 15.75);
  assert.equal(roadLabels.maxzoom, undefined);
  assert.equal(rail.minzoom, undefined);
  assert.equal(rail.maxzoom, undefined);
});

test('does not rebuild the Deck layer tree for zooms within the same visibility band', () => {
  const map = fixtureMap();
  const controller = registerGeographicContextOverlay({
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
    tileCatalog: catalog,
  });
  controller.attachMap(map);

  const initialSetPropsCalls = map.__deck.setPropsCalls;
  for (const zoom of [10.1, 10.2, 10.3, 11.4, 12.7, 15.9]) {
    map.setZoom(zoom);
    map.listeners.get('zoom')();
  }
  assert.equal(map.__deck.setPropsCalls, initialSetPropsCalls);

  map.setZoom(16);
  map.listeners.get('zoom')();
  assert.equal(map.__deck.setPropsCalls, initialSetPropsCalls + 1);

  map.setZoom(16.1);
  map.listeners.get('zoom')();
  assert.equal(map.__deck.setPropsCalls, initialSetPropsCalls + 1);

  controller.dispose();
});

test('masks a movement Deck layer added after map attachment', () => {
  const map = fixtureMap();
  map.setZoom(9);
  const controller = registerGeographicContextOverlay({
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
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
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
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
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
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
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
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
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
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
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
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
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
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
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
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
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
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
    runtime: { view: () => ({ activeTileId: 'A' }), subscribe: () => () => {} },
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
