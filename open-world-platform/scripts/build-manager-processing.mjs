import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? path.join(root, 'native', 'processing'));
const rid = process.argv[3] ?? (process.platform === 'win32' ? 'win-' : process.platform === 'darwin' ? 'osx-' : 'linux-') + process.arch;
if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Manager helper packaging requires Node 22 or later');
const esbuild = createRequire(path.join(root, 'package.json'))('esbuild');
await mkdir(output, { recursive: true });
await esbuild.build({ entryPoints: [path.join(root, 'scripts', 'manager-processing-helper.mjs')], outfile: path.join(output, 'manager-processing.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', legalComments: 'none' });
const currentRid = (process.platform === 'win32' ? 'win-' : process.platform === 'darwin' ? 'osx-' : 'linux-') + process.arch;
if (rid !== currentRid) throw Error('Cross-platform demand helper packaging requires the matching Node runtime; package on the target host');
await copyFile(process.execPath, path.join(output, process.platform === 'win32' ? 'node.exe' : 'node'));
const localLicense = path.join(path.dirname(process.execPath), 'LICENSE');
let license;
try { license = await import('node:fs/promises').then(fs => fs.readFile(localLicense, 'utf8')); }
catch {
  const response = await fetch('https://raw.githubusercontent.com/nodejs/node/v' + process.versions.node + '/LICENSE');
  if (!response.ok) throw Error('Could not obtain the bundled Node runtime license (' + response.status + ')');
  license = await response.text();
}
if (!license.includes('Permission is hereby granted')) throw Error('Invalid Node runtime license');
await writeFile(path.join(output, 'node-LICENSE.txt'), license);
console.log('Packaged manager-processing-helper-v1 with Node ' + process.versions.node + ' at ' + output);

