import test from 'node:test';
import assert from 'node:assert/strict';
import { cityDefinitionsFor } from '../src/city-registration.js';
import { PILOT_TILE_IDS, tileById, tileCatalog } from '../src/tile-catalog.js';

test('Tokyo–Kanagawa mod exposes both selected prefecture catalogs', () => {
  assert.deepEqual(PILOT_TILE_IDS, ['JP_TOKYO_MAINLAND', 'JP_KANAGAWA_MAINLAND']);
  assert.equal(new Set(PILOT_TILE_IDS).size, 2);
  assert.equal(tileCatalog.tiles.length, 2);
  assert.deepEqual(tileCatalog.initialView.center, [139.7671, 35.6812]);
});

test('Tokyo–Kanagawa tile neighbors stay inside the selected package set', () => {
  for (const tile of tileCatalog.tiles) {
    for (const neighbor of tile.neighbors) assert.ok(tileById.has(neighbor.tileId), `${tile.id} -> ${neighbor.tileId}`);
  }
});

test('registered Tokyo–Kanagawa cities expose the native initial view state', () => {
  for (const city of cityDefinitionsFor()) {
    assert.ok(Number.isFinite(city.initialViewState?.longitude), `${city.code} longitude`);
    assert.ok(Number.isFinite(city.initialViewState?.latitude), `${city.code} latitude`);
    assert.ok(Number.isFinite(city.initialViewState?.zoom), `${city.code} zoom`);
  }
});
