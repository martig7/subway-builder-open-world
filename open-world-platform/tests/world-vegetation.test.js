import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { loadWorldVegetationArtifact } from '../src/mod-builder/world-vegetation-artifact.js';
import { createWorldVegetationLoader } from '../src/runtime/ui/world-vegetation.js';

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
