import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packTileOwnershipArtifact, loadTileOwnershipArtifact } from '../src/mod-builder/tile-ownership-artifact.js';

const definition = { identity: { worldId: 'exact' }, tileViews: { ownershipBoundary: 'geography/original.geojson' } };
const catalogSource = { tiles: [{ id: 'A', prefCode: '01', status: 'selected' }] };
const vertices = [[1.23456789123456, 2.34567891234567], [2, 2], [2, 3], [1.23456789123456, 2.34567891234567]];
const boundaries = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { tile_id: 'A' }, geometry: { type: 'Polygon', coordinates: [vertices] } }] };

test('binary ownership packaging preserves every original Float64 coordinate and stable source key', () => {
  const result = packTileOwnershipArtifact({ definition, catalogSource, boundaries });
  const bytes = gunzipSync(result.gzipBytes);
  const headerLength = bytes.readUInt32LE(8), offset = Math.ceil((16 + headerLength) / 8) * 8;
  const header = JSON.parse(bytes.subarray(16, 16 + headerLength).toString('utf8'));
  assert.equal(header.key, result.key);
  assert.equal(result.coordinateCount, vertices.length);
  assert.equal(result.partCount, 1);
  assert.deepEqual(vertices.map((_, index) => [bytes.readDoubleLE(offset + index * 16), bytes.readDoubleLE(offset + index * 16 + 8)]), vertices);
  assert.equal(packTileOwnershipArtifact({ definition, catalogSource, boundaries }).key, result.key);
  assert.notEqual(packTileOwnershipArtifact({ definition: { ...definition, identity: { worldId: 'other' } }, catalogSource, boundaries }).key, result.key);
});

test('display LOD and incomplete ownership data cannot be bundled as authority', () => {
  assert.throws(() => packTileOwnershipArtifact({ definition, catalogSource, boundaries: { ...boundaries, purpose: 'display-only' } }), /never display LOD/);
  assert.throws(() => packTileOwnershipArtifact({ definition, catalogSource, boundaries: { ...boundaries, lods: [] } }), /never display LOD/);
  assert.throws(() => packTileOwnershipArtifact({ definition, catalogSource: { tiles: [...catalogSource.tiles, { id: 'B', status: 'selected' }] }, boundaries }), /missing a selected/);
});

test('only the declared original ownership file is loaded, within the World directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tile-ownership-'));
  try {
    await mkdir(path.join(root, 'geography'));
    await writeFile(path.join(root, 'geography/original.geojson'), JSON.stringify(boundaries));
    const encoded = await loadTileOwnershipArtifact(definition, root, catalogSource);
    assert.ok(encoded.length > 0);
    assert.equal(await loadTileOwnershipArtifact({ ...definition, tileViews: {} }, root, catalogSource), '');
    await assert.rejects(loadTileOwnershipArtifact({ ...definition, tileViews: { ownershipBoundary: '../other.geojson' } }, root, catalogSource), /escapes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
