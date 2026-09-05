import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Japan catalog names are romanized without changing prefecture identities', async () => {
  const world = new URL('../../../../worlds/japan/', import.meta.url);
  const catalog = JSON.parse(await readFile(new URL('geography/tile-views.json', world)));
  const names = JSON.parse(await readFile(new URL('geography/prefecture-display-names.json', world)));
  const definition = JSON.parse(await readFile(new URL('world.json', world)));
  assert.equal(definition.map.labelPolicy, 'japan-source-romaji-v1');
  assert.equal(Object.keys(names).length, 47);
  for (const tile of catalog.tiles) {
    assert.equal(tile.name, names[tile.prefCode]);
    assert.match(tile.name, /^[A-Za-z]+$/);
  }
  assert.equal(catalog.tiles.find(tile => tile.prefCode === '13').id, 'JP_TOKYO_MAINLAND');
  assert.equal(catalog.tiles.find(tile => tile.prefCode === '14').id, 'JP_KANAGAWA_MAINLAND');
});
