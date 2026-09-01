import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtimeDataRoot = path.resolve(root, '..', 'generated', 'pilot', 'tiles', 'NY_CP00_RP00');
const commuteCatalog = JSON.parse(await readFile(path.join(runtimeDataRoot, 'cross_commutes.json'), 'utf8'));
const crossDemandGzipBase64 = (await readFile(path.join(runtimeDataRoot, 'cross_demand.json.gz'))).toString('base64');
let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  // The KC prototype already pins the same compiler; reuse it in this shared
  // workspace so the canary can be rebuilt offline.
  esbuild = await import('../../../kc-two-tile/mod/node_modules/esbuild/lib/main.js');
}
await mkdir(path.join(root, 'dist'), { recursive: true });
await esbuild.build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'src', 'game-entry.js')],
  outfile: path.join(root, 'dist', 'index.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  legalComments: 'none',
  define: {
    __NY_CROSS_COMMUTE_CATALOG__: JSON.stringify(commuteCatalog),
    __NY_CROSS_DEMAND_GZIP_BASE64__: JSON.stringify(crossDemandGzipBase64),
  },
});
await copyFile(path.join(root, 'manifest.json'), path.join(root, 'dist', 'manifest.json'));
console.log('Built New York seven-tile corridor performance canary');
