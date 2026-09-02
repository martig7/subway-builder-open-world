import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateWorldDefinition } from '../src/contracts/validate-world-definition.js';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const fixtures = JSON.parse(await readFile(new URL('../testkit/fixtures/frozen-consumer-identities.json', import.meta.url)));

for (const worldName of ['nec-corridor', 'tokyo-kanagawa', 'ny-state']) {
  test(`${worldName} definition is valid and preserves frozen identities`, async () => {
    const worldRoot = path.join(root, 'worlds', worldName);
    const definition = JSON.parse(await readFile(path.join(worldRoot, 'world.json'), 'utf8'));
    const result = validateWorldDefinition(definition);
    assert.deepEqual(result.errors, []);

    const frozen = fixtures.consumers[worldName];
    assert.equal(definition.identity.manifestId, frozen.manifestId);
    assert.equal(definition.identity.worldId, frozen.runtimeWorldId);
    assert.equal(definition.identity.artifactWorldId, frozen.artifactWorldId);
    assert.equal(definition.tileViews.initialTileId, frozen.initialTileId);
    assert.equal(definition.runtime.storageNamespace, frozen.storageNamespace);
    assert.equal(definition.runtime.tileServerPort, frozen.tileServerPort);
    assert.equal(definition.map.basemapRevision, frozen.basemapRevision);

    const catalog = JSON.parse(await readFile(path.join(worldRoot, definition.tileViews.catalog), 'utf8'));
    assert.equal(catalog.worldId, definition.identity.artifactWorldId);
    assert.ok(catalog.tiles.some((tile) => tile.id === definition.tileViews.initialTileId && tile.status === 'selected'));
    await readFile(path.join(worldRoot, definition.map.sourceLock));
    await readFile(path.join(worldRoot, definition.demand.definition));
  });
}

test('definition validation rejects paths that escape the World directory', () => {
  const definition = {
    schemaVersion: 1,
    identity: { worldId: 'w', artifactWorldId: 'a', manifestId: 'local.test', name: 'n', description: 'd', version: '1.0.0', author: 'a', compatibilityLineage: ['w'] },
    tileViews: { catalog: '../catalog.json', initialTileId: 'tile' },
    map: { sourceLock: 'sources.lock.json', profile: 'map-v1', basemapRevision: 'base-v1' },
    demand: { adapter: 'lodes-us', definition: 'demand.json', routingProfile: 'roads-v1', nativePopPrefixes: ['native-'], crossPopPrefixes: ['cross-'] },
    runtime: { storageNamespace: 'storage', tileServerPort: 8799, tileBaseGlobal: 'TEST_TILE_BASE', diagnosticNamespace: 'test', healthTile: 'tile/0/0/0.mvt', requiredHostCapabilities: [] },
    release: { platformCompatibility: '^1.0.0', artifactSelection: 'explicit', artifactLayout: 'split-map-demand-v1' }
  };
  const result = validateWorldDefinition(definition);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('contained relative JSON path')));
});

test('Japan freezes all 47 prefectures while exposing only ready packages to runtime', async () => {
  const worldRoot = path.join(root, 'worlds', 'japan');
  const definition = JSON.parse(await readFile(path.join(worldRoot, 'world.json'), 'utf8'));
  assert.deepEqual(validateWorldDefinition(definition).errors, []);
  const catalog = JSON.parse(await readFile(path.join(worldRoot, definition.tileViews.catalog), 'utf8'));
  assert.equal(catalog.tiles.length, 47);
  assert.equal(new Set(catalog.tiles.map((tile) => tile.id)).size, 47);
  assert.deepEqual(catalog.tiles.filter((tile) => tile.status === 'selected').map((tile) => tile.id).sort(), [
    'JP_KANAGAWA_MAINLAND',
    'JP_TOKYO_MAINLAND',
  ]);
  const saitama = catalog.tiles.find((tile) => tile.prefCode === '11');
  assert.equal(saitama.id, 'JP_PREF_11');
  assert.equal(saitama.readiness, 'geography-ready');
  assert.ok(saitama.neighbors.some((neighbor) => neighbor.tileId === 'JP_TOKYO_MAINLAND'));
});
