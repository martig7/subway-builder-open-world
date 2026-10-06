import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { packTileOwnershipArtifact } from '../src/mod-builder/tile-ownership-artifact.js';
import { prepareTileOwnership, projectNad83Utm18 } from '../src/runtime/tile-ownership.js';

const definition = { identity: { worldId: 'test-world' }, tileViews: { ownershipBoundary: 'original.geojson' } };
const ring = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
const feature = (id, coordinates, type = 'Polygon') => ({ type: 'Feature', properties: { tile_id: id }, geometry: { type, coordinates } });
const catalog = { tiles: [{ id: 'A', prefCode: '13', status: 'selected' }, { id: 'B', prefCode: '14', status: 'selected' }] };
function asset(boundaries, catalogSource = catalog, inputDefinition = definition) {
  return packTileOwnershipArtifact({ definition: inputDefinition, catalogSource, boundaries: { type: 'FeatureCollection', features: boundaries } }).gzipBytes.toString('base64');
}

test('original polygons resolve holes, islands, foreign bbox interiors, and canonical shared borders', async () => {
  const ownershipGzipBase64 = asset([
    feature('B', [[ring(2, 0, 4, 2)], [ring(10, 10, 11, 11)]], 'MultiPolygon'),
    feature('A', [ring(0, 0, 2, 2), ring(0.5, 0.5, 1, 1)]),
  ]);
  const handle = await prepareTileOwnership({ definition, catalogSource: catalog, ownershipGzipBase64 });
  assert.equal(Object.isFrozen(handle), true);
  assert.deepEqual(Object.keys(handle), ['version', 'key', 'ownerAt', 'contains']);
  assert.equal(handle.ownerAt([0.25, 0.25]), 'A');
  assert.equal(handle.ownerAt([0.75, 0.75]), null);
  assert.equal(handle.ownerAt([0.5, 0.75]), 'A');
  assert.equal(handle.ownerAt([2, 1]), 'A');
  assert.equal(handle.ownerAt([2 + 1e-12, 1]), 'B');
  assert.equal(handle.ownerAt([2 - 1e-12, 1]), 'A');
  assert.equal(handle.ownerAt([10.5, 10.5]), 'B');
  assert.equal(handle.ownerAt([5, 5]), null);
  assert.equal(handle.contains('B', [2, 1]), false);
  assert.equal(handle.contains('A', [0.25, 0.25], 1_000), true);
  assert.equal(handle.contains('A', [0.01, 0.25], 2_000), false);
  assert.equal(handle.contains('A', [0.49, 0.75], 2_000), false);
  assert.equal(handle.contains('A', [0.25, 0.25], -1), false);
  assert.equal(handle.ownerAt([NaN, 0]), null);
});

test('border tie uses prefecture rank rather than feature, tile-ID, or tree order', async () => {
  const catalogSource = { tiles: [{ id: 'Z', prefCode: '13', status: 'selected' }, { id: 'A', prefCode: '14', status: 'selected' }] };
  const ownershipGzipBase64 = asset([feature('A', [ring(2, 0, 4, 2)]), feature('Z', [ring(0, 0, 2, 2)])], catalogSource);
  const handle = await prepareTileOwnership({ definition, catalogSource, ownershipGzipBase64 });
  assert.equal(handle.ownerAt([2, 1]), 'Z');
  assert.equal(handle.ownerAt([2, 0]), 'Z');
});

test('ownership preparation yields, cancels, and never publishes a partial handle', async () => {
  const catalogSource = { tiles: [{ id: 'A', status: 'selected' }] };
  const vertices = Array.from({ length: 10_000 }, (_, index) => [Math.cos(index * Math.PI * 2 / 10_000), Math.sin(index * Math.PI * 2 / 10_000)]);
  vertices.push(vertices[0]);
  const ownershipGzipBase64 = asset([feature('A', [vertices])], catalogSource);
  let cancelled = false, slices = 0, ticks = 0;
  const result = await prepareTileOwnership({ definition, catalogSource, ownershipGzipBase64 }, {
    sliceMs: 1, nowMs: () => ticks++, isCancelled: () => cancelled,
    onSlice: () => slices++, yieldFn: async () => { cancelled = true; },
  });
  assert.equal(result, null);
  assert.equal(slices, 1);
  assert.equal(await prepareTileOwnership({ definition, catalogSource, ownershipGzipBase64 }, { isCancelled: () => true }), null);
  let cancelledOnCompletion = false, completedSlices = 0;
  assert.equal(await prepareTileOwnership({ definition, catalogSource, ownershipGzipBase64 }, {
    sliceMs: Infinity, isCancelled: () => cancelledOnCompletion,
    onSlice: () => { if (++completedSlices === 2) cancelledOnCompletion = true; },
  }), null);
  assert.equal(completedSlices, 2, 'cancel immediately before publishing the completed index, after decode and compile');
});

test('sparse original polygon queries inspect local edges rather than every vertex', async () => {
  const catalogSource = { tiles: [{ id: 'A', status: 'selected' }] };
  const vertices = Array.from({ length: 20_000 }, (_, index) => [Math.cos(index * Math.PI * 2 / 20_000), Math.sin(index * Math.PI * 2 / 20_000)]);
  vertices.push(vertices[0]);
  const parts = [feature('A', [vertices]), ...Array.from({ length: 500 }, (_, index) => feature('A', [ring(10 + index / 100, 10, 10.001 + index / 100, 10.001)]))];
  let work;
  const handle = await prepareTileOwnership({ definition, catalogSource, ownershipGzipBase64: asset(parts, catalogSource) }, { onQueryWork: value => { work = value; } });
  assert.equal(handle.ownerAt([0, 0]), 'A');
  assert.ok(work.partChecks <= 2, JSON.stringify(work));
  assert.ok(work.segmentChecks < 256, JSON.stringify(work));
});

test('an explicit polygon declaration fails closed if missing or from another World', async () => {
  await assert.rejects(prepareTileOwnership({ definition, catalogSource: catalog }), /artifact is required/);
  const ownershipGzipBase64 = asset([feature('A', [ring(0, 0, 2, 2)]), feature('B', [ring(2, 0, 4, 2)])]);
  await assert.rejects(prepareTileOwnership({ definition: { ...definition, identity: { worldId: 'other' } }, catalogSource: catalog, ownershipGzipBase64 }), /different World Definition/);
});

test('NAD83 UTM18 projection matches original pyproj grid calculations below one micrometre', () => {
  const samples = [
    [[-74.006, 40.7128], [583959.3723246718, 4507350.998128469]],
    [[-71.0589, 42.3601], [824569.7546040788, 4697286.581038819]],
    [[-77.0369, 38.9072], [323383.1542496395, 4308450.75815245]],
    [[-75, 40], [500000, 4427757.218624494]],
    [[-69, 45], [972891.7912730465, 5000491.005341887]],
  ];
  for (const [point, expected] of samples) {
    const projected = projectNad83Utm18(point);
    assert.ok(Math.hypot(projected[0] - expected[0], projected[1] - expected[1]) < 1e-6, JSON.stringify({ point, projected, expected }));
  }
});

test('original projected half-open ownership assigns exact and adjacent grid-border points', async () => {
  const inputDefinition = { identity: { worldId: 'grid-world' }, tileViews: {} };
  const catalogSource = { crs: 'EPSG:26918', grid: { originX: 553400, originY: 4483300, tileWidthM: 77700, tileHeightM: 97300 },
    tiles: [{ id: 'west', status: 'selected', column: 0, row: 0, ownershipProjected: [553400, 4483300, 631100, 4580600] },
      { id: 'east', status: 'selected', column: 1, row: 0, ownershipProjected: [631100, 4483300, 708800, 4580600] }] };
  const handle = await prepareTileOwnership({ definition: inputDefinition, catalogSource });
  assert.equal(handle.ownerAt([-74.36980573812328, 40.498689586118495]), 'west');
  assert.equal(handle.ownerAt([-73.45306094651934, 40.49005366648574]), 'east');
  assert.equal(handle.ownerAt([-73.45285407225693, 40.49905940604048]), 'west');
  assert.equal(handle.ownerAt([-73.45285404866254, 40.499059405724545]), 'east');
  assert.equal(handle.contains('east', [-73.45306094651934, 40.49005366648574], 1), false);
  assert.equal(handle.ownerAt([-120, 40]), null);
  const moved = await prepareTileOwnership({ definition: inputDefinition, catalogSource: { ...catalogSource, tiles: catalogSource.tiles.slice(0, 1) } });
  assert.notEqual(handle.key, moved.key);
  assert.equal(moved.ownerAt([-73.45306094651934, 40.49005366648574]), null);
});

test('the original Tokyo ownership excludes Yokohama despite the native map halo containing it', async () => {
  const worldRoot = new URL('../../worlds/japan/', import.meta.url);
  const inputDefinition = JSON.parse(await readFile(new URL('world.json', worldRoot), 'utf8'));
  const sourceCatalog = JSON.parse(await readFile(new URL('geography/tile-views.json', worldRoot), 'utf8'));
  const boundaries = JSON.parse(await readFile(new URL('geography/prefectures.geojson', worldRoot), 'utf8'));
  const wanted = new Set(['JP_TOKYO_MAINLAND', 'JP_KANAGAWA_MAINLAND']);
  const catalogSource = { ...sourceCatalog, tiles: sourceCatalog.tiles.filter(tile => wanted.has(tile.id)) };
  const features = boundaries.features.filter(value => wanted.has(value.properties.tile_id));
  const ownershipGzipBase64 = packTileOwnershipArtifact({ definition: inputDefinition, catalogSource, boundaries: { ...boundaries, features } }).gzipBytes.toString('base64');
  const handle = await prepareTileOwnership({ definition: inputDefinition, catalogSource, ownershipGzipBase64 });
  assert.equal(handle.ownerAt([139.7671, 35.6812]), 'JP_TOKYO_MAINLAND');
  assert.equal(handle.ownerAt([139.638, 35.4437]), 'JP_KANAGAWA_MAINLAND');
  assert.equal(handle.contains('JP_TOKYO_MAINLAND', [139.638, 35.4437]), false);
});
