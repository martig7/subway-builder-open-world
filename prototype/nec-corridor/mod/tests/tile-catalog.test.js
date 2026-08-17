import test from 'node:test';
import assert from 'node:assert/strict';
import { PILOT_TILE_IDS, tileById, tileCatalog } from '../src/tile-catalog.js';

test('NEC mod exposes the complete selected corridor catalog', () => {
  assert.equal(PILOT_TILE_IDS.length, 34);
  assert.equal(new Set(PILOT_TILE_IDS).size, 34);
  assert.equal(tileCatalog.tiles.length, 34);
  assert.deepEqual(tileCatalog.initialView.center, [-74.05697022, 40.88652063]);
});

test('NEC tile neighbors stay inside the selected package set', () => {
  for (const tile of tileCatalog.tiles) {
    for (const neighbor of tile.neighbors) assert.ok(tileById.has(neighbor.tileId), `${tile.id} -> ${neighbor.tileId}`);
  }
});
