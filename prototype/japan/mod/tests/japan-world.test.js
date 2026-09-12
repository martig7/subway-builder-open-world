import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tileBoundaryGeoJson } from '../../../../open-world-platform/src/runtime/ui/geographic-context-overlay.js';
import { loadWorldDefinition } from '../../../../open-world-platform/src/contracts/load-world-definition.js';
import { createOpenWorldCityRegistration } from '../../../../open-world-platform/src/runtime/open-world-city-registration.js';
import { createOpenWorldCatalog } from '../../../../open-world-platform/src/runtime/open-world-catalog.js';
import { packDisplayBoundaryOverlay } from '../../../../open-world-platform/src/mod-builder/display-boundary-artifact.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const worldRoot = path.join(repositoryRoot, 'worlds', 'japan');

test('Japan packages fixed selection polygons and bounded inland divider detail', async () => {
  const definition = JSON.parse(await readFile(path.join(worldRoot, 'world.json'), 'utf8'));
  const catalogSource = JSON.parse(await readFile(path.join(worldRoot, definition.tileViews.catalog), 'utf8'));
  const display = JSON.parse(await readFile(path.join(worldRoot, definition.tileViews.boundaryOverlay), 'utf8'));
  const packed = packDisplayBoundaryOverlay(display);
  assert.equal(packed.encoding, 'inland-display-boundaries-v2');
  assert.ok(JSON.stringify(packed).length < 2_000_000, 'coastline LODs must not enter the bundle');
  assert.deepEqual(packed.lods.map(level => level.minZoom), [0]);
  assert.equal(packed.lods[0].selectionVersion, 'offshore-selection-v1');
  assert.deepEqual(packed.dividerLods.map(level => level.minZoom), [0, 7, 9, 11]);
  assert.ok(packed.lods[0].vertexCount < 60_000);
  assert.ok(packed.dividerLods.at(-1).vertexCount < 80_000);
  const { tileCatalog } = createOpenWorldCatalog({ definition, catalogSource, boundaryOverlay: packed });
  for (const zoom of [0, 7, 9, 11, 15]) {
    const data = tileBoundaryGeoJson(tileCatalog, null, null, zoom);
    assert.equal(data.features.length, 135);
    assert.equal(new Set(data.features.map(feature => feature.id)).size, 135);
    assert.equal(data.features.filter(feature => ['Polygon', 'MultiPolygon'].includes(feature.geometry.type)).length, 47);
    assert.equal(data.features.filter(feature => ['LineString', 'MultiLineString'].includes(feature.geometry.type)).length, 88);
  }
});

test('Japan world context uses its installed worldwide archive independently of the active prefecture', async () => {
  const { definition, catalog } = await loadWorldDefinition(worldRoot);
  const { tileUrl } = createOpenWorldCityRegistration({ definition, tileCatalog: catalog });
  assert.equal(definition.map.worldContextTileId, 'JP_TOKYO_MAINLAND');
  const sourceUrl = tileUrl({ tileId: definition.map.worldContextTileId });
  assert.match(sourceUrl, /^http:\/\/127\.0\.0\.1:8799\/JP_TOKYO_MAINLAND\//);
  assert.notEqual(sourceUrl, tileUrl({ tileId: 'JP_PREF_27' }));
  assert.ok(tileUrl({ tileId: definition.map.worldContextTileId }, 'http://localhost:9000').startsWith('http://localhost:9000/'));
});

test('Japan Open World owns every prefecture through one manifest', async () => {
  const definition = JSON.parse(await readFile(path.join(worldRoot, 'world.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(path.join(worldRoot, definition.tileViews.catalog), 'utf8'));
  assert.equal(definition.identity.manifestId, 'local.japan-open-world');
  assert.equal(definition.identity.name, 'Japan Open World');
  assert.equal(catalog.tiles.length, 47);
  assert.equal(catalog.tiles.filter(({ status }) => status === 'selected').length, 47);
  assert.equal(new Set(catalog.tiles.map(({ prefCode }) => prefCode)).size, 47);
  assert.equal(new Set(catalog.tiles.map(({ gameCityCode }) => gameCityCode)).size, 47);
  assert.ok(definition.demand.crossPopPrefixes.includes('jp-noncommute-'));
});

test('Japan separates centrally stored computation geometry from zoom-dependent display data', async () => {
  const definition = JSON.parse(await readFile(path.join(worldRoot, 'world.json'), 'utf8'));
  assert.equal(definition.map.computationBoundary, 'japan/geography/prefectures-full.geojson');
  assert.equal(definition.tileViews.ownershipBoundary, 'geography/prefectures.geojson');
  const ownership = JSON.parse(await readFile(path.join(worldRoot, definition.tileViews.ownershipBoundary), 'utf8'));
  assert.equal(ownership.features.length, 47);
  assert.equal(ownership.lods, undefined);
  assert.notEqual(ownership.purpose, 'display-only');
  const display = JSON.parse(await readFile(path.join(worldRoot, definition.tileViews.boundaryOverlay), 'utf8'));
  assert.equal(display.purpose, 'display-only');
  assert.deepEqual(display.lods.map((level) => level.minZoom), [0, 7, 9, 11, 13]);
  assert.ok(display.lods[0].vertexCount < display.lods.at(-1).vertexCount * .06);
  for (const level of display.lods) assert.equal(level.features.length, 47);
  const tile = { id: 'display-threshold-test', boundaryLods: display.lods.map(level => ({
    minZoom: level.minZoom, geometry: level.features[0].geometry,
  })) };
  for (let i = 1; i < display.lods.length; i++) {
    const zoom = display.lods[i].minZoom;
    for (const priorZoom of [zoom - 1, zoom - .001]) {
      assert.equal(tileBoundaryGeoJson({ tiles: [tile] }, null, null, priorZoom).features[0].geometry,
        display.lods[i - 1].features[0].geometry);
    }
    assert.equal(tileBoundaryGeoJson({ tiles: [tile] }, null, null, zoom).features[0].geometry,
      display.lods[i].features[0].geometry);
  }
});
