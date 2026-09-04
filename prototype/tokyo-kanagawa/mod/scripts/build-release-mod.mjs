import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

await import('./build-mod.mjs');

const manifestPath = path.resolve(import.meta.dirname, '..', 'dist', 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.id !== 'local.tokyo-kanagawa-open-world') {
  throw new Error(`Expected the Tokyo–Kanagawa development manifest; got ${manifest.id}.`);
}
manifest.id = 'tokyo-kanagawa-open-world';
manifest.author = { name: 'Giancarlo Martinelli (gcm)' };
manifest.dependencies = { 'subway-builder': '>=1.7.0 <1.8.0' };
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Prepared Railyard release manifest ${manifest.id} v${manifest.version}`);
