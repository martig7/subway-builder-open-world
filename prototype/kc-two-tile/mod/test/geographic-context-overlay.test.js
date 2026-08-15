import test from 'node:test';
import assert from 'node:assert/strict';

import {
  geographicContextLayerIds,
  mapLayerDiagnostic,
  registerGeographicContextOverlay,
  tileBoundaryGeoJson,
} from '../src/ui/geographic-context-overlay.js';

function fixtureMap() {
  const sources = new Map([
    ['general-tiles', { type: 'vector' }],
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
  let zoom = 11;
  return {
    sources, layers, layerOrder, insertions, listeners, container,
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
    maxzoom: 10,
    paint: { 'fill-color': '#1c3046', 'fill-opacity': 1 },
  });
  assert.deepEqual(map.layers.get(geographicContextLayerIds.worldBoundaries), {
    id: geographicContextLayerIds.worldBoundaries,
    type: 'line',
    source: 'general-tiles',
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
  assert.deepEqual(
    [...map.sources.keys()].sort(),
    ['general-tiles', geographicContextLayerIds.boundarySource, geographicContextLayerIds.worldOceanSource].sort(),
  );
  const ocean = map.sources.get(geographicContextLayerIds.worldOceanSource).data;
  assert.equal(ocean.features[0].geometry.type, 'Polygon');
  assert.deepEqual(ocean.features[0].geometry.coordinates[0][0], [-180, -85.05112878]);
  assert.deepEqual(map.insertions, [
    [geographicContextLayerIds.worldOcean, 'water'],
    [geographicContextLayerIds.worldLand, 'water'],
    [geographicContextLayerIds.worldBoundaries, 'native-city-labels'],
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
  assert.equal(map.layers.get('native-city-labels-secondary').minzoom, 10);
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
