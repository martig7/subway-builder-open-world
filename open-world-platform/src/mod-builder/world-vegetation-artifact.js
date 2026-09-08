import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function loadWorldVegetationArtifact(repositoryRoot, definition, worldRoot = null) {
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
  if (definition.map.worldVegetationDetail === 'world') {
    const variant = spec.worldVariants?.[definition.identity.worldId];
    if (!worldRoot || !variant || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.geojson\.gz$/.test(variant.artifact ?? '')
      || !/^[a-f0-9]{64}$/.test(variant.artifactSha256 ?? '') || variant.sourceSha256 !== spec.artifactSha256) {
      throw new Error('Missing or stale World vegetation variant; rebuild the World footprint artifact');
    }
    const focus = await readFile(path.join(worldRoot, definition.tileViews.ownershipBoundary ?? definition.tileViews.catalog));
    if (createHash('sha256').update(focus).digest('hex') !== variant.focusInputSha256) {
      throw new Error('World vegetation footprint changed; rebuild the World footprint artifact');
    }
    const focused = await readFile(path.join(path.dirname(artifact), variant.artifact));
    if (createHash('sha256').update(focused).digest('hex') !== variant.artifactSha256) {
      throw new Error('World vegetation variant checksum mismatch');
    }
    return focused.toString('base64');
  }
  return bytes.toString('base64');
}
