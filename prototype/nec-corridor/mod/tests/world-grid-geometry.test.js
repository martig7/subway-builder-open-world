import assert from 'node:assert/strict';
import test from 'node:test';

import { tileBoundaryGeoJson } from '../../../../open-world-platform/src/runtime/ui/geographic-context-overlay.js';
import { tileCatalog } from '../src/tile-catalog.js';

function adjacentPairs(tiles) {
  const byCell = new Map(
    tiles.map((tile) => [`${tile.column},${tile.row}`, tile]),
  );
  const pairs = [];

  for (const tile of tiles) {
    const east = byCell.get(`${tile.column + 1},${tile.row}`);
    const north = byCell.get(`${tile.column},${tile.row + 1}`);
    if (east) pairs.push({ axis: 'east', first: tile, second: east });
    if (north) pairs.push({ axis: 'north', first: tile, second: north });
  }

  return pairs;
}

function pointKey(point) {
  return `${point[0]},${point[1]}`;
}

test('adjacent projected cells render with one shared geographic edge', () => {
  const pairs = adjacentPairs(tileCatalog.tiles);
  assert.ok(pairs.length > 0, 'fixture must include adjacent cells');
  const features = tileBoundaryGeoJson(tileCatalog).features;
  const rings = new Map(
    features.map((feature) => [feature.properties.tileId, feature.geometry.coordinates[0]]),
  );

  for (const { axis, first, second } of pairs) {
    if (axis === 'east') {
      assert.equal(first.ownershipProjected[2], second.ownershipProjected[0]);
    } else {
      assert.equal(first.ownershipProjected[3], second.ownershipProjected[1]);
    }

    const firstVertices = new Set(rings.get(first.id).slice(0, -1).map(pointKey));
    const sharedVertices = rings.get(second.id)
      .slice(0, -1)
      .map(pointKey)
      .filter((point) => firstVertices.has(point));
    assert.equal(
      sharedVertices.length,
      2,
      `${first.id}/${second.id} must render the same two endpoints for their shared edge`,
    );
  }
});
