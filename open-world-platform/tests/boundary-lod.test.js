import assert from 'node:assert/strict';
import test from 'node:test';
import { tileBoundaryGeoJson, GeographicContextOverlayController } from '../src/runtime/ui/geographic-context-overlay.js';

const coarse = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
const detailed = { type: 'Polygon', coordinates: [[[0, 0], [.5, -.1], [1, 0], [1.1, .5], [1, 1], [.5, 1.1], [0, 1], [-.1, .5], [0, 0]]] };

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
