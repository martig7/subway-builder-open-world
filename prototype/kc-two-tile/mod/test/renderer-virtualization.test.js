import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRendererVirtualization,
  createStationMarkerVisibilityAdapter,
  virtualizeDeckLayers,
  virtualizeGeoJsonData,
  virtualizeRenderInputs,
} from '../src/ui/renderer-virtualization.js';

const catalog = {
  tiles: Array.from({ length: 9 }, (_, index) => ({
    id: `T${index}`,
    column: index % 3,
    row: Math.floor(index / 3),
    bounds: [index % 3, Math.floor(index / 3), index % 3 + 1, Math.floor(index / 3) + 1],
  })),
};

test('selects the active tile and its 3x3 halo without mutating the catalog', () => {
  const virtualization = createRendererVirtualization({ activeTileId: 'T4', tileCatalog: catalog });
  assert.deepEqual(virtualization.haloTileIds, catalog.tiles.map((tile) => tile.id));

  const edge = createRendererVirtualization({ activeTileId: 'T0', tileCatalog: catalog });
  assert.deepEqual(edge.haloTileIds, ['T0', 'T1', 'T3', 'T4']);
});

test('uses the complete spatial grid when loadable packages omit empty halo cells', () => {
  const virtualization = createRendererVirtualization({
    activeTileId: 'T0',
    tileCatalog: {
      tiles: [{ id: 'T0', column: 0, row: 0, bounds: [0, 0, 1, 1] }],
      spatialTiles: [
        { id: 'S-1--1', column: -1, row: -1, bounds: [-1, -1, 0, 0] },
        { id: 'S0--1', column: 0, row: -1, bounds: [0, -1, 1, 0] },
        { id: 'S1--1', column: 1, row: -1, bounds: [1, -1, 2, 0] },
        { id: 'S-1-0', column: -1, row: 0, bounds: [-1, 0, 0, 1] },
        { id: 'S1-0', column: 1, row: 0, bounds: [1, 0, 2, 1] },
        { id: 'S-1-1', column: -1, row: 1, bounds: [-1, 1, 0, 2] },
        { id: 'S0-1', column: 0, row: 1, bounds: [0, 1, 1, 2] },
        { id: 'S1-1', column: 1, row: 1, bounds: [1, 1, 2, 2] },
      ],
    },
  });
  assert.equal(virtualization.haloBounds.length, 9);
  assert.equal(virtualization.haloTileIds.length, 9);
});

test('clips boundary-crossing lines into contiguous segments and avoids closing triangles', () => {
  const virtualization = createRendererVirtualization({
    activeTileId: 'T0',
    tileCatalog: { tiles: [{ id: 'T0', column: 0, row: 0, bounds: [0, 0, 1, 1] }] },
  });
  const canonical = {
    tracks: [
      { id: 'crossing', geometry: { type: 'LineString', coordinates: [[-1, 0.5], [2, 0.5]] } },
      { id: 'remote', geometry: { type: 'LineString', coordinates: [[2, 2], [3, 3]] } },
    ],
    previewArtifacts: [{ id: 'polygon', geometry: {
      type: 'Polygon', coordinates: [[[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9], [0.1, 0.1]]],
    } }],
  };
  const before = structuredClone(canonical);
  const result = virtualization.renderInputs(canonical);
  assert.equal(result.tracks.length, 1);
  assert.deepEqual(result.tracks[0].geometry.coordinates, [[0, 0.5], [1, 0.5]]);
  assert.equal(result.previewArtifacts.length, 1);
  assert.deepEqual(canonical, before);
});

test('handles null and missing geometry conservatively while filtering known spatial points', () => {
  const virtualization = createRendererVirtualization({
    activeTileId: 'T0',
    tileCatalog: { tiles: [{ id: 'T0', bounds: [0, 0, 1, 1] }] },
  });
  const result = virtualization.renderInputs({
    trains: [null, { id: 'inside', coords: [0.5, 0.5] }, { id: 'outside', coords: [3, 3] }],
    routes: [{ id: 'metadata-only', name: 'Preserve route list metadata' }],
  });
  assert.deepEqual(result.trains.map((train) => train.id), ['inside']);
  assert.deepEqual(result.routes.map((route) => route.id), ['metadata-only']);
});

test('filters trains, station dots, placement nodes, and missing connections through the shared halo presenter', () => {
  const virtualization = createRendererVirtualization({
    activeTileId: 'T0',
    tileCatalog: { tiles: [{ id: 'T0', bounds: [0, 0, 1, 1] }] },
  });
  const result = virtualization.renderInputs({
    trains: [{ id: 'train-in', position: [0.5, 0.5] }, { id: 'train-out', position: [2, 2] }],
    stationDots: [{ id: 'station-in', coords: [0.2, 0.2] }, { id: 'station-out', coords: [2, 2] }],
    stationRouteNodes: [{ id: 'node-in', geometry: { type: 'Point', coordinates: [0.4, 0.4] } }, { id: 'node-out', geometry: { type: 'Point', coordinates: [2, 2] } }],
    missingConnections: [{ id: 'warning-in', position: [0.6, 0.6] }, { id: 'warning-out', position: [2, 2] }],
  });
  assert.deepEqual(result.trains.map((value) => value.id), ['train-in']);
  assert.deepEqual(result.stationDots.map((value) => value.id), ['station-in']);
  assert.deepEqual(result.stationRouteNodes.map((value) => value.id), ['node-in']);
  assert.deepEqual(result.missingConnections.map((value) => value.id), ['warning-in']);
});

test('filters MapLibre GeoJSON source data without mutating the native FeatureCollection', () => {
  const virtualization = createRendererVirtualization({
    activeTileId: 'T0',
    tileCatalog: { tiles: [{ id: 'T0', bounds: [0, 0, 1, 1] }] },
  });
  const source = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { id: 'inside' }, geometry: { type: 'Point', coordinates: [0.5, 0.5] } },
      { type: 'Feature', properties: { id: 'outside' }, geometry: { type: 'Point', coordinates: [2, 2] } },
    ],
  };
  const result = virtualizeGeoJsonData(source, virtualization);
  assert.deepEqual(result.features.map((feature) => feature.properties.id), ['inside']);
  assert.equal(source.features.length, 2);
});

test('masks movement Deck layers by zoom and spatially filters their data', () => {
  const virtualization = createRendererVirtualization({
    activeTileId: 'T0',
    tileCatalog: { tiles: [{ id: 'T0', bounds: [0, 0, 1, 1] }] },
  });
  const layer = {
    id: 'trains',
    props: { visible: true, data: [
      { id: 'inside', coords: [0.5, 0.5] },
      { id: 'outside', coords: [2, 2] },
    ] },
    clone(overrides) { return { ...this, props: { ...this.props, ...overrides } }; },
  };
  const hidden = virtualizeDeckLayers([layer], { virtualization, zoom: 9 })[0];
  assert.equal(hidden.props.visible, false);
  assert.deepEqual(hidden.props.data.map((item) => item.id), ['inside']);
  const visible = virtualizeDeckLayers([layer], { virtualization, zoom: 10 })[0];
  assert.equal(visible.props.visible, true);
});

test('clips native rail layer coordinates instead of forwarding the full crossing track', () => {
  const virtualization = createRendererVirtualization({
    activeTileId: 'T0',
    tileCatalog: { tiles: [{ id: 'T0', bounds: [0, 0, 1, 1] }] },
  });
  const layer = {
    id: 'rail-network',
    props: {
      data: [{ id: 'crossing-rail', coords: [[-1, 0.5], [2, 0.5]] }],
    },
  };

  const [visibleLayer] = virtualizeDeckLayers([layer], { virtualization, zoom: 11 });

  assert.deepEqual(visibleLayer.props.data[0].coords, [[0, 0.5], [1, 0.5]]);
});

test('reapplying marker visibility is reversible and does not mutate marker state', () => {
  const element = { style: { display: 'block', visibility: '' }, dataset: {} };
  const markers = [{ getElement: () => element, getLngLat: () => ({ lng: 2, lat: 2 }) }];
  const map = { getMap: () => ({ _markers: markers }) };
  const virtualization = createRendererVirtualization({
    activeTileId: 'T0',
    tileCatalog: { tiles: [{ id: 'T0', bounds: [0, 0, 1, 1] }] },
  });
  const adapter = createStationMarkerVisibilityAdapter({ map, virtualization });
  adapter.apply(); adapter.apply();
  assert.equal(element.style.display, 'none');
  assert.equal(element.dataset.openWorldSpatialMarker, 'hidden');
  adapter.reset();
  assert.equal(element.style.display, 'block');
  assert.equal(element.style.visibility, '');
  assert.equal(element.dataset.openWorldSpatialMarker, undefined);
});

test('clips DOM-backed markers when MapLibre exposes no native marker registry', () => {
  const makeElement = (left) => ({
    className: 'maplibregl-marker maplibregl-marker-anchor-center',
    style: { display: 'block', visibility: '' },
    dataset: {},
    getBoundingClientRect: () => ({ left, top: 40, width: 10, height: 10 }),
  });
  const outside = makeElement(150);
  const inside = makeElement(50);
  const container = {
    querySelectorAll: () => [outside, inside],
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const nativeMap = {
    getContainer: () => container,
    unproject: ([x]) => (x > 100 ? { lng: 2, lat: 2 } : { lng: 0.5, lat: 0.5 }),
  };
  const map = {
    getMap: () => nativeMap,
    getCanvasContainer: () => container,
  };
  const virtualization = createRendererVirtualization({
    activeTileId: 'T0',
    tileCatalog: { tiles: [{ id: 'T0', bounds: [0, 0, 1, 1] }] },
  });
  const adapter = createStationMarkerVisibilityAdapter({ map, virtualization });
  adapter.apply();
  assert.equal(outside.style.display, 'none');
  assert.equal(outside.dataset.openWorldSpatialMarker, 'hidden');
  assert.equal(inside.style.display, 'block');
  assert.equal(inside.dataset.openWorldSpatialMarker, 'visible');
  adapter.reset();
  assert.equal(outside.style.display, 'block');
  assert.equal(inside.style.display, 'block');
});

test('returns a presentation object with canonical inputs untouched', () => {
  const canonical = { signals: [{ id: 'signal', coords: [0.2, 0.2] }] };
  const before = structuredClone(canonical);
  const result = virtualizeRenderInputs({
    activeTileId: 'T0',
    tileCatalog: { tiles: [{ id: 'T0', bounds: [0, 0, 1, 1] }] },
    canonical,
  });
  assert.deepEqual(result.signals, canonical.signals);
  assert.deepEqual(canonical, before);
  assert.deepEqual(result.virtualization.haloTileIds, ['T0']);
});

test('does not treat an unavailable tile catalog as an empty render window', () => {
  const virtualization = createRendererVirtualization({ activeTileId: 'unknown', tileCatalog: null });
  const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [100, 100] }, properties: {} };
  assert.deepEqual(virtualization.renderInputs({ features: [feature] }).features, [feature]);
});
