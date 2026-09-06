import path from 'node:path';

import { installWorldMod } from '../../../../open-world-platform/src/installer/install-world-mod.js';

const modRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(modRoot, '..', '..', '..');
const result = await installWorldMod({
  repair: process.argv.includes('--repair'),
  worldRoot: path.join(repositoryRoot, 'worlds', 'tokyo-kanagawa'),
  outputRoot: path.join(modRoot, 'dist'),
  packageRoot: path.resolve(modRoot, '..', 'generated', 'mod', 'tiles'),
});
console.log(`Installed ${result.definition.identity.name} to ${result.targetPath}; PMTiles ${result.tileServer.status}`);
