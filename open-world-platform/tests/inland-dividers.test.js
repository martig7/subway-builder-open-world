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

test('unmasked coastal fill stays hidden while native-land selection receives active and hovered polygons', () => {
  const controller = new GeographicContextOverlayController({ tileCatalog: fixture() });
  const selections = [];
  controller.landSelection = { update: selection => selections.push(selection) };
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
  assert.deepEqual(selections.at(-1), { active: polygon, hovered: polygon });
});

test('an island owner without dividers still gets a filled native-land highlight', () => {
  const catalog = { tiles: [{ id: 'Hokkaido', boundaryGeometry: polygon }], dividerLods: [] };
  const controller = new GeographicContextOverlayController({ tileCatalog: catalog });
  const selections = [];
  controller.landSelection = { update: selection => selections.push(selection) };
  controller.map = { getSource: () => ({ setData() {} }), getZoom: () => 6 };
  controller.syncTileBoundaryData('Hokkaido');
  assert.deepEqual(selections.at(-1), { active: polygon, hovered: null });
});

test('packaging uses offshore selection geometry without changing inland divider geometry', () => {
  const offshore = { type: 'Polygon', coordinates: [[[-1,-1],[2,-1],[2,2],[-1,2],[-1,-1]]] };
  const feature = geometry => ({ type: 'Feature', properties: { id: 'A' }, geometry });
  const packed = packDisplayBoundaryOverlay({ purpose: 'display-only', quantizationDegrees: .00001,
    selection: { version: 'offshore-selection-v1', vertexCount: 5, features: [feature(offshore)] },
    lods: [{ minZoom: 7, toleranceMetres: 500, features: [feature(polygon)],
      dividers: { vertexCount: 2, features: [{ ...feature(divider), properties: { owners: ['A','B'] } }] } }],
  });
  const catalog = createOpenWorldCatalog({ definition: { identity: {}, tileViews: { initialTileId: 'A' } },
    catalogSource: { tiles: [{ id: 'A', status: 'selected' }, { id: 'B', status: 'selected' }] }, boundaryOverlay: packed }).tileCatalog;
  assert.equal(packed.lods[0].selectionVersion, 'offshore-selection-v1');
  assert.deepEqual(tileBoundaryGeoJson(catalog, 'A', null, 7).features[0].geometry, offshore);
  assert.deepEqual(catalog.dividerLods[0].features[0].geometry, divider);
});
