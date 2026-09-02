import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { loadWorldDefinition } from '../contracts/load-world-definition.js';
import { OPEN_WORLD_PLATFORM_RELEASE } from '../runtime/start-open-world.js';

export async function verifyWorldMod({ worldRoot, outputRoot }) {
  const { definition, worldDefinitionHash } = await loadWorldDefinition(worldRoot);
  const dist = path.resolve(outputRoot);
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
  if (manifest.id !== definition.identity.manifestId) throw new Error(`Manifest mismatch: ${manifest.id}`);
  if (manifest.main !== 'index.js') throw new Error('Runnable manifest must use index.js');
  const bundlePath = path.join(dist, manifest.main);
  const bundle = await readFile(bundlePath, 'utf8');
  for (const marker of [OPEN_WORLD_PLATFORM_RELEASE, definition.identity.worldId, definition.identity.manifestId, worldDefinitionHash]) {
    if (!bundle.includes(marker)) throw new Error(`Bundle marker is missing: ${marker}`);
  }
  const worldDefinition = JSON.parse(await readFile(path.join(dist, 'world-definition.json'), 'utf8'));
  if (worldDefinition.identity.worldId !== definition.identity.worldId) throw new Error('Embedded World Definition does not match the selected World');
  const writtenHash = (await readFile(path.join(dist, 'world-definition.sha256'), 'utf8')).trim();
  if (writtenHash !== worldDefinitionHash) throw new Error('Written World Definition hash does not match the selected World');
  return { manifestId: manifest.id, worldDefinitionHash, bundlePath, bytes: (await stat(bundlePath)).size, platformRelease: OPEN_WORLD_PLATFORM_RELEASE };
}
