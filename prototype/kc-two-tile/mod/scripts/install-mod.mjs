/** Copy game-ready dist/ into Subway Builder's mods folder after each build. */
import { copyFile, cp, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const distPath = path.join(root, 'dist');
const sourceManifestPath = path.join(root, 'manifest.json');
const artifactsPath = path.resolve(root, '..', 'artifacts');
const cityCodes = ['KCW', 'KCE'];
const cityDataFilenames = [
  'demand_data.json.gz',
  'buildings_index.bin.gz',
  'roads.geojson.gz',
  'runways_taxiways.geojson.gz',
];

function applicationDataPathForPlatform() {
  if (process.platform === 'darwin') {
    if (!process.env.HOME) throw new Error('HOME is not set');
    return path.join(process.env.HOME, 'Library', 'Application Support', 'metro-maker4');
  }
  if (process.platform === 'win32') {
    if (!process.env.APPDATA) throw new Error('APPDATA is not set');
    return path.join(process.env.APPDATA, 'metro-maker4');
  }
  if (process.platform === 'linux') {
    if (!process.env.HOME) throw new Error('HOME is not set');
    return path.join(process.env.HOME, '.config', 'metro-maker4');
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

async function modDirectoryName() {
  const manifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'));
  const id = String(manifest.id ?? '').trim();
  const directoryName = id.split('.').at(-1);
  if (!directoryName || !/^[a-zA-Z0-9_-]+$/.test(directoryName)) {
    throw new Error(`Manifest has an unsafe or missing mod id: ${id || '(empty)'}`);
  }
  return directoryName;
}

async function assertGameReadyDist() {
  const manifest = JSON.parse(await readFile(path.join(distPath, 'manifest.json'), 'utf8'));
  if (manifest.main !== 'index.js') throw new Error('dist/manifest.json must use "main": "index.js"');
  await lstat(path.join(distPath, manifest.main));
}

async function assertCityArtifacts() {
  for (const cityCode of cityCodes) {
    for (const filename of cityDataFilenames) {
      await lstat(path.join(artifactsPath, cityCode, filename));
    }
  }
}

const applicationDataPath = path.resolve(applicationDataPathForPlatform());
const modsPath = path.join(applicationDataPath, 'mods');
const citiesDataPath = path.join(applicationDataPath, 'cities', 'data');
const targetPath = path.resolve(modsPath, await modDirectoryName());
if (path.dirname(targetPath) !== modsPath) throw new Error(`Refusing unsafe install target: ${targetPath}`);

await assertGameReadyDist();
await assertCityArtifacts();
await mkdir(modsPath, { recursive: true });
await rm(targetPath, { recursive: true, force: true });
await cp(distPath, targetPath, { recursive: true });
console.log(`Installed mod to: ${targetPath}`);

await mkdir(citiesDataPath, { recursive: true });
for (const cityCode of cityCodes) {
  const cityTargetPath = path.resolve(citiesDataPath, cityCode);
  if (path.dirname(cityTargetPath) !== citiesDataPath) {
    throw new Error(`Refusing unsafe city-data target: ${cityTargetPath}`);
  }
  await rm(cityTargetPath, { recursive: true, force: true });
  await mkdir(cityTargetPath, { recursive: true });
  for (const filename of cityDataFilenames) {
    await copyFile(path.join(artifactsPath, cityCode, filename), path.join(cityTargetPath, filename));
  }
  console.log(`Installed ${cityCode} data to: ${cityTargetPath}`);
}
