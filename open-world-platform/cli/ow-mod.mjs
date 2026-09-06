#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadWorldDefinition } from '../src/contracts/load-world-definition.js';
import { buildWorldMod } from '../src/mod-builder/build-world-mod.js';
import { verifyWorldMod } from '../src/mod-builder/verify-world-mod.js';
import { installWorldMod } from '../src/installer/install-world-mod.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const [command = 'help', ...rawArgs] = process.argv.slice(2);
const args = new Map();
for (let index = 0; index < rawArgs.length; index += 1) {
  const token = rawArgs[index];
  if (!token.startsWith('--')) continue;
  const next = rawArgs[index + 1];
  args.set(token.slice(2), next?.startsWith('--') || next == null ? true : rawArgs[++index]);
}
const resolveArg = (name) => {
  const value = args.get(name);
  if (!value || value === true) throw new Error(`--${name} is required`);
  return path.resolve(repositoryRoot, value);
};

if (command === 'validate') {
  const roots = args.has('all')
    ? ['worlds/nec-corridor', 'worlds/tokyo-kanagawa', 'worlds/ny-state', 'worlds/japan'].map((entry) => path.join(repositoryRoot, entry))
    : [resolveArg('world')];
  for (const worldRoot of roots) {
    const { definition, selectedTiles } = await loadWorldDefinition(worldRoot);
    console.log(`Valid ${definition.identity.name}: ${selectedTiles.length} selected Tile Views`);
  }
} else if (command === 'build') {
  const result = await buildWorldMod({ repositoryRoot, worldRoot: resolveArg('world'), modRoot: resolveArg('mod'), artifactsRoot: resolveArg('artifacts'), repair: args.has('repair') });
  console.log(`Built ${result.definition.identity.name} with ${result.selectedTiles.length} Tile Packages (${result.platformRelease})`);
} else if (command === 'verify') {
  const result = await verifyWorldMod({ worldRoot: resolveArg('world'), outputRoot: resolveArg('output') });
  console.log(`Verified ${result.manifestId}: ${result.bytes} bytes (${result.platformRelease})`);
} else if (command === 'install') {
  const result = await installWorldMod({
    worldRoot: resolveArg('world'),
    outputRoot: resolveArg('output'),
    packageRoot: resolveArg('packages'),
    repair: args.has('repair'),
  });
  console.log(`Installed ${result.definition.identity.name} to ${result.targetPath}; PMTiles ${result.tileServer.status}`);
} else {
  console.log('Usage: ow-mod <validate|build|verify|install> --world <world-dir> [--mod <consumer-mod> --artifacts <artifact-root> | --output <dist> --packages <tile-packages>] [--repair]');
  if (command !== 'help') process.exitCode = 2;
}
