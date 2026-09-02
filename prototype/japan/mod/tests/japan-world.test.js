import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const worldRoot = path.join(repositoryRoot, 'worlds', 'japan');

test('Japan Open World owns every prefecture through one manifest', async () => {
  const definition = JSON.parse(await readFile(path.join(worldRoot, 'world.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(path.join(worldRoot, definition.tileViews.catalog), 'utf8'));
  assert.equal(definition.identity.manifestId, 'local.japan-open-world');
  assert.equal(definition.identity.name, 'Japan Open World');
  assert.equal(catalog.tiles.length, 47);
  assert.equal(catalog.tiles.filter(({ status }) => status === 'selected').length, 47);
  assert.equal(new Set(catalog.tiles.map(({ prefCode }) => prefCode)).size, 47);
  assert.equal(new Set(catalog.tiles.map(({ gameCityCode }) => gameCityCode)).size, 47);
});
