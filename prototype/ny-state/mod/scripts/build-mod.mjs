import path from 'node:path';

import { buildWorldMod } from '../../../../open-world-platform/src/mod-builder/build-world-mod.js';
import { verifyWorldMod } from '../../../../open-world-platform/src/mod-builder/verify-world-mod.js';

const modRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(modRoot, '..', '..', '..');
const worldRoot = path.join(repositoryRoot, 'worlds', 'ny-state');
const artifactsRoot = path.resolve(modRoot, '..', 'generated', 'pilot', 'tiles');
const result = await buildWorldMod({ repositoryRoot, worldRoot, modRoot, artifactsRoot, repair: process.argv.includes('--repair') });
await verifyWorldMod({ worldRoot, outputRoot: result.distPath });
console.log(`Built ${result.definition.identity.name} with ${result.selectedTiles.length} Tile Packages`);
