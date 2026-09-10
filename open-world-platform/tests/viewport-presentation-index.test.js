import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStableGeoJsonChunks,
  createViewportPresentationIndex,
} from '../src/runtime/ui/viewport-presentation-index.js';

const point = (id, longitude, latitude) => ({
  type: 'Feature',
  properties: { id },
  geometry: { type: 'Point', coordinates: [longitude, latitude] },
});

test('a tiny viewport over a large source visits only bounded local candidates', () => {
  const features = [];
  for (let y = 0; y < 100; y += 1) {
    for (let x = 0; x < 100; x += 1) features.push(point(`${x}:${y}`, x / 10, y / 10));
  }
  const index = createViewportPresentationIndex({ cellSize: 0.1, paddingRatio: 0 });
  index.update(features, { revision: 1 });

  const result = index.query({ viewportBounds: [4.05, 4.05, 4.15, 4.15] });

  assert.deepEqual(result.features.map((feature) => feature.properties.id), ['41:41']);
  assert.ok(result.stats.visitedCandidates < 20, `${result.stats.visitedCandidates} candidates were visited`);
  assert.equal(result.stats.totalFeatures, 10_000);
});

test('keeps a line whose endpoints are outside but whose geometry crosses the viewport', () => {
  const crossing = {
    type: 'Feature', properties: { id: 'crossing' },
    geometry: { type: 'LineString', coordinates: [[-2, 0], [2, 0]] },
  };
  const index = createViewportPresentationIndex({ cellSize: 0.25, paddingRatio: 0 });
  index.update([crossing, point('away', 5, 5)], { revision: 'tracks-1' });

  assert.deepEqual(
    index.query({ viewportBounds: [-0.1, -0.1, 0.1, 0.1] }).features,
    [crossing],
  );
});

test('reuses candidates inside the padded region and expands synchronously for pans and zoom-outs', () => {
  const center = point('center', 0, 0);
  const east = point('east', 1.4, 0);
  const farEast = point('far-east', 2.4, 0);
  const index = createViewportPresentationIndex({ cellSize: 0.1, paddingRatio: 0.5 });
  index.update([center, east, farEast], { revision: 1 });

  const initial = index.query({ viewportBounds: [-1, -1, 1, 1] });
  const withinMargin = index.query({ viewportBounds: [-0.5, -0.5, 1.2, 0.5] });
  assert.strictEqual(withinMargin.features, initial.features);
  assert.equal(withinMargin.signature, initial.signature);
  assert.deepEqual(initial.features, [center, east]);

  const pannedBeyondMargin = index.query({ viewportBounds: [2.35, -0.1, 2.45, 0.1] });
  assert.notStrictEqual(pannedBeyondMargin.features, initial.features);
  assert.deepEqual(pannedBeyondMargin.features, [farEast]);

  const zoomedOut = index.query({ viewportBounds: [-2, -2, 2, 2] });
  assert.notStrictEqual(zoomedOut.features, pannedBeyondMargin.features);
  assert.deepEqual(zoomedOut.features, [center, east, farEast]);
});

test('revision is the invalidation contract for in-place edits', () => {
  const moving = point('moving', 0, 0);
  const features = [moving];
  const index = createViewportPresentationIndex({ cellSize: 0.25, paddingRatio: 0 });
  assert.equal(index.update(features, { revision: 1 }), true);
  assert.deepEqual(index.query({ viewportBounds: [-1, -1, 1, 1] }).features, [moving]);

  moving.geometry.coordinates[0] = 20;
  assert.equal(index.update(features, { revision: 1 }), false, 'unchanged revision intentionally avoids a source scan');
  assert.deepEqual(index.query({ viewportBounds: [-1, -1, 1, 1] }).features, [moving]);

  assert.equal(index.update(features, { revision: 2 }), true);
  assert.deepEqual(index.query({ viewportBounds: [-1, -1, 1, 1] }).features, []);
});

test('a null revision rebuilds for a new source array and explicit invalidation handles in-place edits', () => {
  const moving = point('moving', 0, 0);
  const index = createViewportPresentationIndex({ cellSize: 0.25, paddingRatio: 0 });
  index.update([moving]);
  moving.geometry.coordinates[0] = 20;
  assert.equal(index.update([moving]), true);
  assert.deepEqual(index.query({ viewportBounds: [-1, -1, 1, 1] }).features, []);

  moving.geometry.coordinates[0] = 0;
  index.invalidate();
  assert.equal(index.update(index.source), true);
  assert.deepEqual(index.query({ viewportBounds: [-1, -1, 1, 1] }).features, [moving]);
});

test('keeps unknown geometry conservatively and intersects candidates with a circular halo', () => {
  const unknown = { type: 'Feature', properties: { id: 'unknown' }, geometry: null };
  const inside = point('inside', 0.5, 0);
  const cornerOutsideCircle = point('corner', 0.9, 0.9);
  const halo = Object.assign([-1, -1, 1, 1], {
    region: { shape: 'circle', center: [0, 0], scale: [1, 1], distance: 1 },
  });
  const index = createViewportPresentationIndex({ cellSize: 0.25, paddingRatio: 0 });
  index.update([unknown, inside, cornerOutsideCircle], { revision: 1 });

  assert.deepEqual(
    index.query({ viewportBounds: [-1, -1, 1, 1], haloBounds: [halo] }).features,
    [unknown, inside],
  );
});

test('indexes and queries features that cross the antimeridian locally', () => {
  const crossing = {
    type: 'Feature', properties: { id: 'dateline' },
    geometry: { type: 'LineString', coordinates: [[179.8, 0], [-179.8, 0]] },
  };
  const greenwich = point('greenwich', 0, 0);
  const index = createViewportPresentationIndex({ cellSize: 0.1, paddingRatio: 0 });
  index.update([crossing, greenwich], { revision: 1 });

  const result = index.query({ viewportBounds: [179.9, -1, -179.9, 1] });
  assert.deepEqual(result.features, [crossing]);
  assert.ok(result.stats.visitedCandidates <= 2);
});

test('a substantial zoom-in refits an overview candidate set without rebuilding the source index', () => {
  const features = [];
  for (let y = 0; y < 50; y += 1) {
    for (let x = 0; x < 50; x += 1) features.push(point(`${x}:${y}`, x / 10, y / 10));
  }
  const index = createViewportPresentationIndex({ cellSize: 0.1, paddingRatio: 0.5 });
  assert.equal(index.update(features, { revision: 'static-1' }), true);
  const overview = index.query({ viewportBounds: [-1, -1, 6, 6] });
  assert.equal(overview.features.length, 2_500);

  const local = index.query({ viewportBounds: [2.05, 2.05, 2.15, 2.15] });
  assert.notStrictEqual(local.features, overview.features);
  assert.ok(local.features.length < 20, `${local.features.length} overview candidates survived the refit`);
  assert.equal(index.update([...features], { revision: 'static-1' }), false,
    'the local refit must query the existing index rather than rebuild it');
});

test('a refit preserves presentation identity until the candidate mask changes', () => {
  const center = point('center', 0, 0);
  const east = point('east', 5, 0);
  const index = createViewportPresentationIndex({ cellSize: 0.25, paddingRatio: 0.5 });
  index.update([center, east], { revision: 'tracks-1' });

  const initial = index.query({ viewportBounds: [-1, -1, 1, 1] });
  const tighterRefit = index.query({ viewportBounds: [-0.5, -0.5, 0.5, 0.5], refit: true });
  assert.strictEqual(tighterRefit.features, initial.features);
  assert.strictEqual(tighterRefit.indices, initial.indices);
  assert.equal(tighterRefit.signature, initial.signature);
  assert.equal(tighterRefit.stats.selectionReused, true);

  const expanded = index.query({ viewportBounds: [-1, -1, 5.1, 1] });
  assert.notStrictEqual(expanded.features, initial.features);
  assert.notEqual(expanded.signature, initial.signature);
  assert.deepEqual(expanded.features, [center, east]);
});

test('caps grid references and conservatively queries features that overflow to the broad set', () => {
  const crossing = Array.from({ length: 20 }, (_, index) => ({
    type: 'Feature', properties: { id: `crossing-${index}` },
    geometry: { type: 'LineString', coordinates: [[-2, index / 100], [2, index / 100]] },
  }));
  const index = createViewportPresentationIndex({
    cellSize: 0.1,
    paddingRatio: 0,
    maxCellsPerFeature: 256,
    maxGridReferences: 100,
  });
  index.update(crossing, { revision: 1 });

  const result = index.query({ viewportBounds: [-0.1, -0.1, 0.1, 0.3] });
  assert.deepEqual(result.features, crossing);
  assert.ok(result.stats.gridReferences <= 100);
  assert.ok(result.stats.broadFeatures > 0);
});

test('treats null and array coordinate scalars as unknown geometry instead of Greenwich', () => {
  const malformed = [
    { type: 'Feature', properties: { id: 'nulls' }, geometry: { type: 'Point', coordinates: [null, null] } },
    { type: 'Feature', properties: { id: 'arrays' }, geometry: { type: 'Point', coordinates: [[], []] } },
  ];
  const index = createViewportPresentationIndex({ cellSize: 0.25, paddingRatio: 0 });
  index.update(malformed, { revision: 1 });

  const result = index.query({ viewportBounds: [50, 50, 51, 51] });
  assert.deepEqual(result.features, malformed, 'unknown geometry must be retained conservatively');
  assert.equal(result.stats.broadFeatures, 2);
});

test('stable GeoJSON chunks bound data arrays and preserve identities for one revision', () => {
  const features = Array.from({ length: 10 }, (_, index) => point(String(index), index / 100, 0));
  const chunks = createStableGeoJsonChunks({ cellSize: 1, maxFeaturesPerChunk: 3 });
  assert.equal(chunks.update(features, { revision: 1 }), true);
  const built = chunks.chunks;
  assert.ok(built.every((chunk) => chunk.features.length <= 3));
  assert.deepEqual(built.flatMap((chunk) => chunk.features), features);
  assert.equal(new Set(built.flatMap((chunk) => chunk.features)).size, features.length);

  const first = chunks.query({ viewportBounds: [-0.1, -0.1, 0.1, 0.1] });
  const movedInsidePadding = chunks.query({ viewportBounds: [-0.05, -0.05, 0.12, 0.05] });
  assert.strictEqual(movedInsidePadding.chunks, first.chunks);
  assert.equal(movedInsidePadding.signature, first.signature);
  assert.equal(chunks.update([...features], { revision: 1 }), false);
  assert.strictEqual(chunks.chunks, built);
});

test('stable chunks select crossing and unknown features without duplicating canonical objects', () => {
  const crossing = {
    type: 'Feature', properties: { id: 'crossing' },
    geometry: { type: 'LineString', coordinates: [[-2, 0], [2, 0]] },
  };
  const unknown = { type: 'Feature', properties: { id: 'unknown' }, geometry: null };
  const away = point('away', 10, 10);
  const chunks = createStableGeoJsonChunks({ cellSize: 0.25, maxFeaturesPerChunk: 2 });
  chunks.update([crossing, unknown, away], { revision: 'tracks-1' });

  const result = chunks.query({ viewportBounds: [-0.1, -0.1, 0.1, 0.1], paddingRatio: 0 });
  const selected = result.chunks.flatMap((chunk) => chunk.features);
  assert.ok(selected.includes(crossing));
  assert.ok(selected.includes(unknown));
  assert.ok(!selected.includes(away));
  assert.strictEqual(selected.find((feature) => feature === crossing), crossing);
});

test('stable chunk IDs are deterministic and metadata references stay bounded', () => {
  const features = Array.from({ length: 600 }, (_, index) => ({
    type: 'Feature', properties: { id: index },
    geometry: { type: 'LineString', coordinates: [[-120, index / 100], [120, index / 100]] },
  }));
  const options = { cellSize: 0.1, maxFeaturesPerChunk: 64, maxGridReferences: 500 };
  const left = createStableGeoJsonChunks(options);
  const right = createStableGeoJsonChunks(options);
  left.update(features, { revision: 1 });
  right.update(features, { revision: 1 });
  assert.deepEqual(left.chunks.map((chunk) => chunk.id), right.chunks.map((chunk) => chunk.id));
  assert.ok(left.chunks.every((chunk) => chunk.features.length <= 64));
  const result = left.query({ viewportBounds: [-1, -1, 1, 7] });
  assert.ok(result.stats.gridReferences <= 500);
  assert.ok(result.stats.broadChunks > 0);
  assert.equal(new Set(left.chunks.flatMap((chunk) => chunk.features)).size, features.length);
});
