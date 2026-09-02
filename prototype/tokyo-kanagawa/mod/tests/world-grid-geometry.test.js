import assert from 'node:assert/strict';
import test from 'node:test';

import { tileBoundaryGeoJson } from '../../../../open-world-platform/src/runtime/ui/geographic-context-overlay.js';
import { tileCatalog } from '../src/tile-catalog.js';

test('map overlay renders prefecture geometry instead of tile rectangles', () => {
  const features = tileBoundaryGeoJson(tileCatalog).features;
  assert.equal(features.length, tileCatalog.tiles.length);

  for (const tile of tileCatalog.tiles) {
    const feature = features.find((candidate) => candidate.properties.tileId === tile.id);
    assert.ok(feature, `${tile.id} overlay feature`);
    assert.ok(tile.boundaryGeometry, `${tile.id} prefecture geometry`);
    assert.deepEqual(feature.geometry, tile.boundaryGeometry);
    assert.ok(['Polygon', 'MultiPolygon'].includes(feature.geometry.type));

    const [west, south, east, north] = tile.bounds;
    const rectangle = {
      type: 'Polygon',
      coordinates: [[
        [west, south], [east, south], [east, north], [west, north], [west, south],
      ]],
    };
    assert.notDeepEqual(feature.geometry, rectangle, `${tile.id} must not render its tile bounds`);
  }
});
