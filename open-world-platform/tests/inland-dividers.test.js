import test from 'node:test';
import assert from 'node:assert/strict';
import { packDisplayBoundaryOverlay } from '../src/mod-builder/display-boundary-artifact.js';
import { createOpenWorldCatalog } from '../src/runtime/open-world-catalog.js';
import { tileBoundaryGeoJson, GeographicContextOverlayController } from '../src/runtime/ui/geographic-context-overlay.js';

const polygon = { type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]] };
const divider = { type: 'LineString', coordinates: [[1,0],[1,1]] };
function fixture() {
  const features = ['A','B'].map(id => ({ type: 'Feature', properties: { id }, geometry: polygon }));
  const overlay = { purpose: 'display-only', quantizationDegrees: .00001,
    lods: [{ minZoom: 0, toleranceMetres: 2000, features, dividers: { features: [{
      type: 'Feature', properties: { owners: ['A','B'] }, geometry: divider,
    }] } }] };
  return createOpenWorldCatalog({ definition: { identity: {}, tileViews: { initialTileId: 'A' } },
    catalogSource: { tiles: ['A','B'].map(id => ({ id, status: 'selected' })) },
    boundaryOverlay: packDisplayBoundaryOverlay(overlay),
  }).tileCatalog;
}

test('inland source keeps hidden selection polygons and draws each shared divider once', () => {
  const catalog = fixture(), data = tileBoundaryGeoJson(catalog, 'A', 'B', 12);
  assert.equal(data.features.filter(f => f.geometry.type === 'Polygon').length, 2);
  const lines = data.features.filter(f => f.geometry.type === 'LineString');
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].geometry, divider);
  assert.equal(lines[0].id, 2);
  assert.equal(lines[0].properties.active, true);
  assert.equal(lines[0].properties.hovered, true);
  assert.equal(new Set(data.features.map(f => f.id)).size, 3);
});

test('coastal polygon strokes and hover fills are suppressed; dividers retain selection state', () => {
  const controller = new GeographicContextOverlayController({ tileCatalog: fixture() });
  const paints = [], filters = [], states = [], calls = [];
  const source = { setData: data => calls.push(data) };
  controller.map = { getSource: () => source, getZoom: () => 8,
    setPaintProperty: (...args) => paints.push(args), setFilter: (...args) => filters.push(args),
    setFeatureState: (target, state) => states.push({ target, state }) };
  controller.syncTileBoundaryData('A');
  assert.ok(paints.some(([id, key, value]) => id === 'open-world-tile-selection' && key === 'fill-opacity' && value === 0));
  assert.ok(filters.some(([id, filter]) => id === 'open-world-tile-boundaries' && JSON.stringify(filter) === JSON.stringify(['==','$type','LineString'])));
  assert.equal(states.find(s => s.target.id === 2).state.active, true);
  controller.hoveredTileId = 'B'; controller.syncTileBoundaryData('A');
  assert.equal(calls.length, 1, 'hover does not rebuild geometry');
  assert.equal(states.findLast(s => s.target.id === 2).state.hovered, true);
  assert.equal(controller.selectableTileIdFromEvent({ features: [calls[0].features[1]] }), 'B');
});
