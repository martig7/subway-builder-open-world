import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { routeGeometryArtifacts, routeDataFiles } from '../src/mod-builder/route-geometry-artifact.js';

test('route packaging pins native/cross demand and validates every archive', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'route-artifact-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition = { demand: { routeGeometry: 'stored-driving-routes-v1' }, tileViews: { initialTileId: 'JP_TEST' } };
  const manifest = { version: 'stored-driving-routes-v1', datasetId: 'fixture', packages: {} };
  const hash = data => createHash('sha256').update(data).digest('hex');
  for (const id of ['cross', 'JP_TEST']) {
    const directory = path.join(root, 'routes', id);
    await mkdir(directory, { recursive: true });
    const demand = id === 'cross' ? path.join(root, 'demand/world/cross_demand.json.gz') : path.join(root, 'demand/tiles/JP_TEST/demand_data.json.gz');
    await mkdir(path.dirname(demand), { recursive: true }); await writeFile(demand, id);
    const assets = [];
    for (const extension of ['idx', 'bin']) {
      const name = `${id === 'cross' ? 'cross-' : ''}driving-routes.${extension}`;
      await writeFile(path.join(directory, name), 'bytes');
      assets.push({ path: name, bytes: 5, sha256: hash('bytes') });
    }
    manifest.packages[id] = { version: manifest.version, datasetId: 'fixture', tileId: id, demandSha256: hash(id), assets };
  }
  await writeFile(path.join(root, 'routes/route-geometry-manifest.json'), JSON.stringify(manifest));
  const options = { definition, selectedTiles: [{ id: 'JP_TEST' }], generatedRoot: root, packageRoot: path.join(root, 'packaged') };
  const result = await routeGeometryArtifacts(options);
  assert.equal(result.entries.length, 4);
  assert.equal(routeDataFiles(definition, 'JP_TEST').length, 4);
  assert.equal(routeDataFiles(definition, 'JP_OTHER').length, 2);
  await writeFile(path.join(root, 'routes/JP_TEST/driving-routes.bin'), 'wrong');
  await assert.rejects(routeGeometryArtifacts(options), /hash mismatch/);
  await writeFile(path.join(root, 'routes/JP_TEST/driving-routes.bin'), 'bytes');
  await writeFile(path.join(root, 'demand/tiles/JP_TEST/demand_data.json.gz'), 'changed');
  await assert.rejects(routeGeometryArtifacts(options), /does not match demand/);
});
