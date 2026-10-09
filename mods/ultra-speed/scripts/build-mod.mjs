import path from 'node:path';
import { buildUltraSpeedMod } from '../../../open-world-platform/src/mod-builder/build-ultra-speed-mod.js';
const modRoot = path.resolve(import.meta.dirname, '..');
const result = await buildUltraSpeedMod({ modRoot });
console.log(`Built ${result.manifest.name}: ${result.distPath}`);
console.log(`Publish ${result.archivePath}`);
