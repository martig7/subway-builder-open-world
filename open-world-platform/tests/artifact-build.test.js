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
  const ownedDefinition = structuredClone(definition);
  ownedDefinition.tileViews.ownershipBoundary = 'geography/ownership.geojson';
  await writeFile(path.join(worldRoot, 'world.json'), JSON.stringify(ownedDefinition));
  await writeFile(path.join(worldRoot, 'geography/ownership.geojson'), JSON.stringify({ type: 'FeatureCollection',
    features: catalog.tiles.filter(tile => tile.status === 'selected').map(tile => {
      const [x1, y1, x2, y2] = tile.bounds;
      return { type: 'Feature', properties: { tile_id: tile.id }, geometry: { type: 'Polygon',
        coordinates: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]] } };
    }),
  }));
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
  await access(path.join(built.distPath, 'tile-ownership.bin.gz'));
  assert.match(await readFile(path.join(built.distPath, 'index.js'), 'utf8'), /tileOwnershipGzipBase64/);
  const bundle = await readFile(path.join(built.distPath, 'index.js'), 'utf8');
  assert.match(bundle, /demandArtifactIdentities/);
  assert.ok(/"?completeCrossDepartures"?: true/.test(bundle), 'builder embeds complete-departure metadata');
  const archive = path.join(built.packageRoot, definition.tileViews.initialTileId, 'tiles.pmtiles');
  const before = await stat(archive, { bigint: true });
  const beforeLimits = JSON.parse(await readFile(path.join(built.distPath, 'render-distance.json'), 'utf8'));
  const updatedCatalog = structuredClone(catalog);
  updatedCatalog.tiles.find(tile => tile.id === definition.tileViews.initialTileId).bounds[0] -= 2;
  await writeFile(path.join(worldRoot, definition.tileViews.catalog), JSON.stringify(updatedCatalog));
  await buildWorldMod(options);
  const after = await stat(archive, { bigint: true });
  const afterLimits = JSON.parse(await readFile(path.join(built.distPath, 'render-distance.json'), 'utf8'));
  assert.ok(afterLimits.max > beforeLimits.max, 'rebuilding refreshes the world extent');
  assert.ok(afterLimits.minByTile[definition.tileViews.initialTileId] > beforeLimits.minByTile[definition.tileViews.initialTileId]);
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
  // Reusing dist for an undeclared rectangular World retires the polygon archive.
  await writeFile(path.join(worldRoot, 'world.json'), JSON.stringify(definition));
  // Release builds can consume the newly staged layout, while old standalone
  // Tile Packages remain supported by the builder's per-tile fallback.
  await buildWorldMod({ ...options, packagedTileRoot: built.packageRoot });
  await assert.rejects(access(path.join(built.distPath, 'tile-ownership.bin.gz')), { code: 'ENOENT' });
  const initial = path.join(built.packageRoot, definition.tileViews.initialTileId);
  for (const filename of ['cross_commutes.json', 'cross_demand.json.gz']) {
    await copyFile(path.join(built.packageRoot, filename), path.join(initial, filename));
    await rm(path.join(built.packageRoot, filename));
  }
  await buildWorldMod({ ...options, packagedTileRoot: built.packageRoot });
  await access(path.join(initial, 'cross_commutes.json'));
  await access(path.join(initial, 'cross_demand.json.gz'));
});
