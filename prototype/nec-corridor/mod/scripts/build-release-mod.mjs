import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

await import('./build-mod.mjs');

const distRoot = path.resolve(import.meta.dirname, '..', 'dist');
const manifestPath = path.join(distRoot, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.id !== 'local.nec-corridor-open-world') {
  throw new Error(`Expected the NEC development manifest; got ${manifest.id}.`);
}
manifest.id = 'northeast-corridor-open-world';
manifest.author = { name: 'Giancarlo Martinelli (gcm)' };
manifest.dependencies = { 'subway-builder': '>=1.7.0 <1.8.0' };
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Prepared Railyard release manifest ${manifest.id} v${manifest.version}`);
