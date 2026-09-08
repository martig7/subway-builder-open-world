import assert from 'node:assert/strict';
import test from 'node:test';
import { packDisplayBoundaryOverlay } from '../src/mod-builder/display-boundary-artifact.js';
import { createOpenWorldCatalog } from '../src/runtime/open-world-catalog.js';

const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1.123456, 0], [1, 1], [0, 0]]] };
const feature = geometry => ({ type: 'Feature', properties: { pref_code: 'A' }, geometry });
const source = () => ({ purpose: 'display-only', quantizationDegrees: 0.00001, features: [feature(polygon)], lods: [
  { minZoom: 0, toleranceMetres: 2000, features: [feature(polygon)] },
  { minZoom: 11, toleranceMetres: 25, features: [feature({ type: 'MultiPolygon', coordinates: [polygon.coordinates, [[[2, 2], [3, 2], [3, 3], [2, 2]]]] })] },
  { minZoom: 13, toleranceMetres: 0, features: [feature(polygon)] },
] });
const catalogFor = boundaryOverlay => createOpenWorldCatalog({
  definition: { identity: { name: 'fixture' }, tileViews: { initialTileId: 'A' } },
  catalogSource: { tiles: [{ id: 'A', status: 'selected' }] }, boundaryOverlay,
}).tileCatalog;

test('display packing caps detail, quantizes coordinates and preserves islands and closed rings', () => {
  const input = source(), before = JSON.stringify(input);
  const packed = packDisplayBoundaryOverlay(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(packed.encoding, 'quantized-display-boundaries-v1');
  assert.deepEqual(packed.lods.map(l => l.minZoom), [0, 11]);
  const tile = catalogFor(packed).tiles[0];
  assert.equal(tile.boundaryGeometry.coordinates[0][1][0], 1.12346);
  const high = tile.boundaryLods[1].geometry;
  assert.equal(high.type, 'MultiPolygon');
  assert.equal(high.coordinates.length, 2);
  for (const poly of high.coordinates) for (const ring of poly) assert.deepEqual(ring[0], ring.at(-1));
  assert.strictEqual(tile.boundaryLods[1].geometry, high, 'repeated access reuses the current geometry');
  tile.boundaryLods[0].geometry;
  assert.notStrictEqual(tile.boundaryLods[1].geometry, high, 'only one decoded level is retained per tile');
});

test('packing never changes authoritative or legacy geometry without explicit display-only LODs', () => {
  const original = { features: [feature(polygon)] };
  assert.strictEqual(packDisplayBoundaryOverlay(original), original);
  assert.strictEqual(packDisplayBoundaryOverlay({ ...original, purpose: 'display-only' }).features, original.features);
});

test('packed and ordinary catalogs expose the same IDs, level selection, polygon holes and shape', () => {
  const input = source();
  input.lods[0].features[0].geometry = { type: 'Polygon', coordinates: [polygon.coordinates[0], [[.2,.2],[.3,.2],[.3,.3],[.2,.2]]] };
  const packed = catalogFor(packDisplayBoundaryOverlay(input)).tiles[0];
  const native = catalogFor(input).tiles[0];
  assert.equal(packed.id, native.id);
  assert.equal(packed.boundaryLods[0].geometry.coordinates.length, 2);
  assert.deepEqual(packed.boundaryLods[0].geometry.coordinates[1], native.boundaryLods[0].geometry.coordinates[1]);
});
