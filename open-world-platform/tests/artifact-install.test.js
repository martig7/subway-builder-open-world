import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256Value } from '../src/contracts/canonical-hash.js';
import { installWorldMod } from '../src/installer/install-world-mod.js';
import { TILE_DATA_FILES } from '../src/mod-builder/artifact-files.js';
import { OPEN_WORLD_PLATFORM_RELEASE } from '../src/runtime/start-open-world.js';
import definition from '../../worlds/tokyo-kanagawa/world.json' with { type: 'json' };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'open-world-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worldRoot = path.join(root, 'world');
  const outputRoot = path.join(root, 'dist');
  const packageRoot = path.join(root, 'packages');
  const applicationDataPath = path.join(root, 'game');
  const tileIds = [definition.tileViews.initialTileId, 'JP_KANAGAWA_MAINLAND'];
  await mkdir(path.join(worldRoot, 'geography'), { recursive: true });
  await mkdir(outputRoot);
  await writeFile(path.join(worldRoot, 'world.json'), JSON.stringify(definition));
  await writeFile(path.join(worldRoot, definition.tileViews.catalog), JSON.stringify({ tiles: tileIds.map(id => ({ id, status: 'selected' })) }));
  const hash = sha256Value(definition);
  await writeFile(path.join(outputRoot, 'index.js'), [OPEN_WORLD_PLATFORM_RELEASE, definition.identity.worldId, definition.identity.manifestId, hash].join('\n'));
  await writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify({ id: definition.identity.manifestId, version: '1.0.0', main: 'index.js' }));
  await writeFile(path.join(outputRoot, 'world-definition.json'), JSON.stringify(definition));
  await writeFile(path.join(outputRoot, 'world-definition.sha256'), hash);
  for (const name of ['start-tile-server.ps1', 'native-pmtiles-server.ps1']) await writeFile(path.join(outputRoot, name), '# fixture');
  for (const id of tileIds) {
    await mkdir(path.join(packageRoot, id), { recursive: true });
    for (const name of TILE_DATA_FILES) await writeFile(path.join(packageRoot, id, name), `${id}:${name}`);
  }
  const calls = [];
  const control = {
    async stopTileServer() { calls.push('stop'); },
    async ensureTileServerReady() { calls.push('health'); return { status: 'already-running' }; },
  };
  const options = { worldRoot, outputRoot, packageRoot, applicationDataPath };
  return { options, tileIds, calls, control, install: extra => installWorldMod({ ...options, ...extra }, control) };
}

test('runtime-only installation leaves verified city files and their server untouched', async t => {
  const f = await fixture(t);
  const first = await f.install();
  assert.equal(first.changedArtifactFiles, 10);
  const target = path.join(first.citiesDataPath, f.tileIds[0], 'tiles.pmtiles');
  const before = await stat(target, { bigint: true });
  await writeFile(path.join(f.options.outputRoot, 'index.js'), (await readFile(path.join(f.options.outputRoot, 'index.js'), 'utf8')) + '\nnew-runtime');
  f.calls.length = 0;
  const result = await f.install();
  assert.equal(result.changedArtifactFiles, 0);
  const after = await stat(target, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
  assert.deepEqual(f.calls, ['health']);
  assert.match(await readFile(path.join(result.targetPath, 'index.js'), 'utf8'), /new-runtime/);
});

test('changed source and same-size installed corruption each replace only the affected file', async t => {
  const f = await fixture(t);
  const first = await f.install();
  const target = path.join(first.citiesDataPath, f.tileIds[0], 'tiles.pmtiles');
  const source = path.join(f.options.packageRoot, f.tileIds[0], 'tiles.pmtiles');
  const expected = await readFile(source);
  const before = await stat(target);
  await writeFile(target, Buffer.alloc(expected.length, 88));
  await utimes(target, before.atime, before.mtime);
  f.calls.length = 0;
  assert.equal((await f.install()).changedArtifactFiles, 1);
  assert.deepEqual(await readFile(target), expected);
  assert.deepEqual(f.calls, ['stop', 'health']);
  const sourceBefore = await stat(source);
  const updated = Buffer.alloc(expected.length, 89);
  await writeFile(source, updated);
  await utimes(source, sourceBefore.atime, sourceBefore.mtime);
  f.control.stopTileServer = async () => {
    assert.deepEqual(await readFile(target), expected, 'the server must stop before archive replacement');
    f.calls.push('stop');
  };
  f.calls.length = 0;
  assert.equal((await f.install()).changedArtifactFiles, 1);
  assert.deepEqual(await readFile(target), updated);
  assert.deepEqual(f.calls, ['stop', 'health']);
});

test('explicit repair replaces every artifact; incomplete input fails before stopping the server', async t => {
  const f = await fixture(t);
  await f.install();
  f.calls.length = 0;
  assert.equal((await f.install({ repair: true })).changedArtifactFiles, 10);
  assert.deepEqual(f.calls, ['stop', 'health']);
  await rm(path.join(f.options.packageRoot, f.tileIds[0], 'tiles.pmtiles'));
  f.calls.length = 0;
  await assert.rejects(f.install(), /Required artifact is missing/);
  assert.deepEqual(f.calls, []);
});

test('old redundant files and a damaged hash cache can be retired without rewriting city assets', async t => {
  const f = await fixture(t);
  const first = await f.install();
  const target = path.join(first.citiesDataPath, f.tileIds[0], 'tiles.pmtiles');
  const before = await stat(target, { bigint: true });
  const foreignTile = path.join(first.citiesDataPath, 'OTHER_WORLD_TILE');
  await mkdir(foreignTile);
  await writeFile(path.join(foreignTile, 'cross_commutes.json'), 'foreign-world-data');
  for (const filename of ['cross_commutes.json', 'cross_demand.json.gz']) await writeFile(path.join(first.citiesDataPath, f.tileIds[0], filename), 'old-bundled-copy');
  await writeFile(path.join(first.targetPath, '.open-world-artifacts.json'), '{interrupted');
  f.calls.length = 0;
  assert.equal((await f.install()).changedArtifactFiles, 0);
  assert.deepEqual(f.calls, ['health']);
  assert.equal((await stat(target, { bigint: true })).mtimeNs, before.mtimeNs);
  for (const filename of ['cross_commutes.json', 'cross_demand.json.gz']) await assert.rejects(stat(path.join(first.citiesDataPath, f.tileIds[0], filename)), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(foreignTile, 'cross_commutes.json'), 'utf8'), 'foreign-world-data');
});

test('updating demand keeps a server that only reads PMTiles running', async t => {
  const f = await fixture(t);
  const first = await f.install();
  const source = path.join(f.options.packageRoot, f.tileIds[0], 'demand_data.json.gz');
  await writeFile(source, 'updated-native-demand');
  f.calls.length = 0;
  assert.equal((await f.install()).changedArtifactFiles, 1);
  assert.deepEqual(f.calls, ['health']);
  assert.equal(await readFile(path.join(first.citiesDataPath, f.tileIds[0], 'demand_data.json.gz'), 'utf8'), 'updated-native-demand');
});

test('a selected city junction cannot redirect cleanup into another world directory', async t => {
  const f = await fixture(t);
  const first = await f.install();
  const directory = path.join(first.citiesDataPath, f.tileIds[0]);
  const foreign = path.join(first.citiesDataPath, 'FOREIGN_WORLD_TILE');
  await mkdir(foreign);
  await writeFile(path.join(foreign, 'cross_commutes.json'), 'foreign-data');
  await rm(directory, { recursive: true });
  await symlink(foreign, directory, process.platform === 'win32' ? 'junction' : 'dir');
  f.calls.length = 0;
  await assert.rejects(f.install(), /Refusing linked city target/);
  assert.deepEqual(f.calls, []);
  assert.equal(await readFile(path.join(foreign, 'cross_commutes.json'), 'utf8'), 'foreign-data');
});
