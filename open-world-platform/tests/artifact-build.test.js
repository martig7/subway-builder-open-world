import assert from 'node:assert/strict';
import { access, copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { buildWorldMod } from '../src/mod-builder/build-world-mod.js';
import { TILE_DATA_FILES } from '../src/mod-builder/artifact-files.js';
import definition from '../../worlds/tokyo-kanagawa/world.json' with { type: 'json' };
import catalog from '../../worlds/tokyo-kanagawa/geography/tile-views.json' with { type: 'json' };
import boundary from '../../worlds/tokyo-kanagawa/geography/world-boundary-overlay.json' with { type: 'json' };

test('rebuilding a synthetic consumer reuses packages and stores world data only once', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'open-world-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worldRoot = path.join(root, 'world');
  const modRoot = path.join(root, 'mod');
  const artifactsRoot = path.join(root, 'artifacts');
  await mkdir(path.join(worldRoot, 'geography'), { recursive: true });
  await mkdir(modRoot);
  await writeFile(path.join(worldRoot, 'world.json'), JSON.stringify(definition));
  await writeFile(path.join(worldRoot, definition.tileViews.catalog), JSON.stringify(catalog));
  await writeFile(path.join(worldRoot, definition.tileViews.boundaryOverlay), JSON.stringify(boundary));
  const worldDataRoot = path.join(artifactsRoot, 'demand', 'world');
  await mkdir(worldDataRoot, { recursive: true });
  await writeFile(path.join(worldDataRoot, 'cross_commutes.json'), JSON.stringify({ buildHash: 'fixture', buckets: [], gateways: [] }));
  await writeFile(path.join(worldDataRoot, 'cross_demand.json.gz'), gzipSync(JSON.stringify({ points: [], pops: [] })));
  for (const tile of catalog.tiles.filter(tile => tile.status === 'selected')) {
    const mapRoot = path.join(artifactsRoot, 'maps', 'tiles', tile.id);
    const demandRoot = path.join(artifactsRoot, 'demand', 'tiles', tile.id);
    await mkdir(mapRoot, { recursive: true });
    await mkdir(demandRoot, { recursive: true });
    for (const filename of TILE_DATA_FILES) await writeFile(path.join(filename === 'demand_data.json.gz' ? demandRoot : mapRoot, filename), 'fixture');
    await writeFile(path.join(mapRoot, 'map-manifest.json'), JSON.stringify({ cityCode: tile.id, haloBounds: tile.bounds }));
    const legacyRoot = path.join(artifactsRoot, 'mod', 'tiles', tile.id);
    await mkdir(legacyRoot, { recursive: true });
    for (const filename of ['cross_commutes.json', 'cross_demand.json.gz']) await writeFile(path.join(legacyRoot, filename), 'retired-copy');
  }
  const options = { repositoryRoot: path.resolve(import.meta.dirname, '../..'), worldRoot, modRoot, artifactsRoot };
  const built = await buildWorldMod(options);
  const archive = path.join(built.packageRoot, definition.tileViews.initialTileId, 'tiles.pmtiles');
  const before = await stat(archive, { bigint: true });
  await buildWorldMod(options);
  const after = await stat(archive, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
  await access(path.join(built.packageRoot, 'cross_commutes.json'));
  await access(path.join(built.packageRoot, 'cross_demand.json.gz'));
  for (const tile of built.selectedTiles) {
    await assert.rejects(access(path.join(built.packageRoot, tile.id, 'cross_commutes.json')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(built.packageRoot, tile.id, 'cross_demand.json.gz')), { code: 'ENOENT' });
  }
  const manifest = JSON.parse(await readFile(path.join(built.packageRoot, 'package-manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.ok(manifest.artifactState[`${definition.tileViews.initialTileId}/tiles.pmtiles`].source.sha256);
  // Release builds can consume the newly staged layout, while old standalone
  // Tile Packages remain supported by the builder's per-tile fallback.
  await buildWorldMod({ ...options, packagedTileRoot: built.packageRoot });
  const initial = path.join(built.packageRoot, definition.tileViews.initialTileId);
  for (const filename of ['cross_commutes.json', 'cross_demand.json.gz']) {
    await copyFile(path.join(built.packageRoot, filename), path.join(initial, filename));
    await rm(path.join(built.packageRoot, filename));
  }
  await buildWorldMod({ ...options, packagedTileRoot: built.packageRoot });
  await access(path.join(initial, 'cross_commutes.json'));
  await access(path.join(initial, 'cross_demand.json.gz'));
});
