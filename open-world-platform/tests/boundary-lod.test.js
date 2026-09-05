import assert from 'node:assert/strict';
import test from 'node:test';
import { BOUNDARY_LOD_VERSION, tileBoundaryGeoJson, GeographicContextOverlayController } from '../src/runtime/ui/geographic-context-overlay.js';

const coarse = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
const detailed = { type: 'Polygon', coordinates: [[[0, 0], [.5, -.1], [1, 0], [1.1, .5], [1, 1], [.5, 1.1], [0, 1], [-.1, .5], [0, 0]]] };

test('render feature IDs are numeric, stable across LODs and match hover state targets', () => {
  const catalog = { tiles: [{ id: 'missing-geometry' }, { id: 'JP_PREF_14', boundaryGeometry: detailed,
    boundaryLods: [{ minZoom: 0, geometry: coarse }, { minZoom: 10, geometry: detailed }] }] };
  const low = tileBoundaryGeoJson(catalog, null, null, 4);
  const high = tileBoundaryGeoJson(catalog, null, null, 11);
  assert.ok(Number.isSafeInteger(low.features[0].id), 'GeoJSON tiling must preserve the feature ID');
  assert.equal(low.features[0].id, high.features[0].id);
  const states = [];
  const source = { setData() {} };
  const controller = new GeographicContextOverlayController({ tileCatalog: catalog, onTileSelect() {} });
  controller.map = { getSource: () => source, getZoom: () => 4,
    setFeatureState: (target, state) => states.push({ target, state }), setPaintProperty() {} };
  controller.syncTileBoundaryData();
  controller.handleTilePointerMove({ features: low.features });
  const hovered = states.findLast(({ state }) => state.hovered);
  assert.equal(hovered.target.id, low.features[0].id);
});

test('zoomed-out boundary submission uses precomputed coarse geometry, never computation geometry', () => {
  const catalog = { tiles: [{ id: 'A', boundaryGeometry: detailed,
    boundaryLods: [{ minZoom: 0, geometry: coarse }, { minZoom: 10, geometry: detailed }] }] };
  const low = tileBoundaryGeoJson(catalog, 'A', null, 4);
  const high = tileBoundaryGeoJson(catalog, 'A', null, 12);
  assert.equal(low.features[0].geometry.coordinates[0].length, 5);
  assert.equal(high.features[0].geometry.coordinates[0].length, 9);
  assert.equal(catalog.tiles[0].boundaryGeometry, detailed);
});

test('hover and fractional zoom do not resubmit geometry; new LOD/source does', () => {
  const catalog = { tiles: [{ id: 'A', boundaryGeometry: detailed,
    boundaryLods: [{ minZoom: 0, geometry: coarse }, { minZoom: 10, geometry: detailed }] }] };
  const controller = new GeographicContextOverlayController({ tileCatalog: catalog });
  let calls = 0, zoom = 4, paints = 0;
  let source = { setData() { calls++; } };
  const states = [];
  controller.map = { getSource: () => source, getZoom: () => zoom,
    setFeatureState: (id, state) => states.push(state), setPaintProperty: () => paints++ };
  controller.syncTileBoundaryData();
  zoom = 4.1;
  controller.syncTileBoundaryData();
  controller.hoveredTileId = 'A';
  controller.syncTileBoundaryData();
  assert.equal(calls, 1);
  assert.equal(states.at(-1).hovered, true);
  zoom = 11;
  controller.syncTileBoundaryData();
  assert.equal(calls, 2);
  source = { setData() { calls++; } };
  controller.syncTileBoundaryData();
  assert.equal(calls, 3);
  assert.equal(paints, 8); // Reinstall paint after style/source replacement.
});

test('a retained v1 submission upgrades IDs and paint without replacing its source', () => {
  const catalog = { tiles: [{ id: 'JP_PREF_14', boundaryGeometry: detailed }] };
  const controller = new GeographicContextOverlayController({ tileCatalog: catalog });
  const submitted = [], states = [], paints = [];
  const source = { setData: data => submitted.push(data) };
  controller.map = { getSource: () => source, getZoom: () => 4,
    __openWorldBoundaryLodStyleVersion: 'precomputed-boundary-lod-v1',
    setFeatureState: (target, state) => states.push({ target, state }),
    setPaintProperty: (...args) => paints.push(args) };
  controller.boundarySubmission = { source, lodKey: 'legacy', stateKey: 'null:null',
    version: 'precomputed-boundary-lod-v1' };
  controller.syncTileBoundaryData();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].features[0].id, 0);
  assert.equal(states[0].target.id, 0);
  assert.equal(paints.length, 4);
  assert.equal(controller.map.__openWorldBoundaryLodStyleVersion, BOUNDARY_LOD_VERSION);
  controller.syncTileBoundaryData();
  assert.equal(submitted.length, 1);
});
