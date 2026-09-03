import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const versionIndex = process.argv.indexOf('--version');
const requestedVersion = versionIndex >= 0 ? process.argv[versionIndex + 1] : null;
if (!requestedVersion || !/^\d+\.\d+\.\d+$/.test(requestedVersion)) {
  throw new Error('Usage: npm run build:release -- --version X.Y.Z');
}

await import('./build-mod.mjs');

const manifestPath = path.resolve(import.meta.dirname, '..', 'dist', 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.id !== 'local.tokyo-kanagawa-open-world') {
  throw new Error(`Expected the Tokyo–Kanagawa development manifest; got ${manifest.id}.`);
}
if (manifest.version !== requestedVersion) {
  throw new Error(`Built mod version ${manifest.version} does not match requested release ${requestedVersion}.`);
}

manifest.id = 'tokyo-kanagawa-open-world';
manifest.author = { name: 'Giancarlo Martinelli (gcm)' };
manifest.dependencies = { 'subway-builder': '>=1.7.0 <1.8.0' };
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Prepared Railyard release manifest ${manifest.id} v${manifest.version}`);
