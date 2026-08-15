import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'src', 'game-entry.js')],
  outfile: path.join(root, 'dist', 'index.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  legalComments: 'none',
});

await mkdir(path.join(root, 'dist'), { recursive: true });
await copyFile(path.join(root, 'manifest.json'), path.join(root, 'dist', 'manifest.json'));

console.log('Built game-ready dist/ (plain-script IIFE plus manifest)');
