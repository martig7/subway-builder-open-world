import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function loadWorldVegetationArtifact(repositoryRoot, definition) {
  if (!definition.map.worldVegetation) return '';
  const spec = JSON.parse(await readFile(path.join(repositoryRoot, 'map-creator/sources/world-vegetation.json'), 'utf8'));
  if (definition.map.worldVegetation !== spec.id || !/^[a-f0-9]{64}$/.test(spec.artifactSha256 ?? '')) {
    throw new Error('Unknown or unpinned world vegetation artifact');
  }
  const artifact = path.join(repositoryRoot, 'map-creator/data/artifacts/world-vegetation', `${spec.id}.geojson.gz`);
  const bytes = await readFile(artifact);
  if (createHash('sha256').update(bytes).digest('hex') !== spec.artifactSha256) {
    throw new Error('World vegetation artifact checksum mismatch; rebuild from the pinned sources');
  }
  return bytes.toString('base64');
}
