import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { loadWorldVegetationArtifact } from '../src/mod-builder/world-vegetation-artifact.js';
import { createWorldVegetationLoader, ensureWorldVegetation, WORLD_VEGETATION_VERSION } from '../src/runtime/ui/world-vegetation.js';

test('vegetation decoding is lazy, cached and validates the collection', async () => {
  assert.equal(createWorldVegetationLoader(''), null);
  const data = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }] };
  const load = createWorldVegetationLoader(gzipSync(JSON.stringify(data)).toString('base64'));
  const first = load();
  assert.equal(load(), first);
  assert.deepEqual(await first, data);
  const invalid = createWorldVegetationLoader(gzipSync('{}').toString('base64'));
  await assert.rejects(invalid(), /Invalid world vegetation/);
});

test('World vegetation hot reload and changing Worlds replace the retained source', () => {
  const data = { type: 'FeatureCollection', focusWorld: 'japan-world', features: [] };
  const calls = [];
  const map = { __openWorldVegetation: { version: 'world-vegetation-seam-safe-v2' },
    getSource: () => ({ setData: value => calls.push(value) }),
    getLayer: () => ({ maxzoom: 24 }), moveLayer() {} };
  ensureWorldVegetation(map, data);
  assert.equal(map.__openWorldVegetation.version, WORLD_VEGETATION_VERSION);
  assert.equal(calls.length, 1);
  ensureWorldVegetation(map, data);
  assert.equal(calls.length, 1);
  ensureWorldVegetation(map, { ...data, focusWorld: 'nec-corridor-world' });
  assert.equal(calls.length, 2);
});

test('World vegetation variants are pinned to both their input footprint and output bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ow-focus-vegetation-'));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  try {
    const artifacts = path.join(root, 'map-creator/data/artifacts/world-vegetation');
    const sources = path.join(root, 'map-creator/sources');
    await mkdir(artifacts, { recursive: true }); await mkdir(sources, { recursive: true });
    const source = gzipSync('{}'), focused = gzipSync('{"focusWorld":"fixture-world"}'), footprint = '{"tiles":[]}';
    const variant = { artifact: 'fixture-world.geojson.gz', sourceSha256: digest(source),
      artifactSha256: digest(focused), focusInputSha256: digest(footprint) };
    const spec = { id: 'modis-igbp-2023-v1', artifactSha256: digest(source), worldVariants: { 'fixture-world': variant } };
    await writeFile(path.join(sources, 'world-vegetation.json'), JSON.stringify(spec));
    await writeFile(path.join(artifacts, spec.id + '.geojson.gz'), source);
    await writeFile(path.join(artifacts, variant.artifact), focused);
    await writeFile(path.join(root, 'tiles.json'), footprint);
    const definition = { identity: { worldId: 'fixture-world' }, map: { worldVegetation: spec.id, worldVegetationDetail: 'world' }, tileViews: { catalog: 'tiles.json' } };
    assert.equal(await loadWorldVegetationArtifact(root, definition, root), focused.toString('base64'));
    await writeFile(path.join(root, 'tiles.json'), '{"changed":true}');
    await assert.rejects(loadWorldVegetationArtifact(root, definition, root), /footprint changed/);
    await writeFile(path.join(root, 'tiles.json'), footprint);
    await writeFile(path.join(artifacts, variant.artifact), 'corrupt');
    await assert.rejects(loadWorldVegetationArtifact(root, definition, root), /variant checksum/);
    await assert.rejects(loadWorldVegetationArtifact(root, { ...definition, identity: { worldId: 'missing' } }, root), /Missing or stale/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('vegetation builds reject missing pins, wrong ids and changed artifact bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ow-vegetation-test-'));
  try {
    assert.equal(await loadWorldVegetationArtifact(root, { map: {} }), '');
    const source = path.join(root, 'map-creator/sources');
    const artifacts = path.join(root, 'map-creator/data/artifacts/world-vegetation');
    await mkdir(source, { recursive: true });
    await mkdir(artifacts, { recursive: true });
    const bytes = gzipSync('{}');
    const spec = { id: 'modis-igbp-2023-v1', artifactSha256: createHash('sha256').update(bytes).digest('hex') };
    const definition = { map: { worldVegetation: spec.id } };
    const specPath = path.join(source, 'world-vegetation.json');
    const artifactPath = path.join(artifacts, `${spec.id}.geojson.gz`);
    await writeFile(specPath, JSON.stringify(spec));
    await writeFile(artifactPath, bytes);
    assert.equal(await loadWorldVegetationArtifact(root, definition), bytes.toString('base64'));
    await assert.rejects(loadWorldVegetationArtifact(root, { map: { worldVegetation: 'unknown' } }), /Unknown or unpinned/);
    await writeFile(artifactPath, 'changed');
    await assert.rejects(loadWorldVegetationArtifact(root, definition), /checksum mismatch/);
    delete spec.artifactSha256;
    await writeFile(specPath, JSON.stringify(spec));
    await assert.rejects(loadWorldVegetationArtifact(root, definition), /Unknown or unpinned/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
