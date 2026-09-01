import { copyFile, cp, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { PILOT_TILE_IDS } from '../src/tile-catalog.js';
import { ensureTileServerReady, stopTileServer } from './tile-server-control.mjs';

const root = path.resolve(import.meta.dirname, '..');
const distPath = path.join(root, 'dist');
const sourceManifestPath = path.join(root, 'manifest.json');
const packagesPath = path.resolve(root, '..', 'generated', 'mod', 'tiles');
const cityDataFilenames = [
  'demand_data.json.gz',
  'buildings_index.bin.gz',
  'roads.geojson.gz',
  'runways_taxiways.geojson.gz',
  'cross_commutes.json',
  'cross_demand.json.gz',
  'tiles.pmtiles',
];
const tileServerFilenames = ['start-tile-server.ps1', 'native-pmtiles-server.ps1'];

function applicationDataPathForPlatform() {
  if (process.platform === 'win32') {
    if (!process.env.APPDATA) throw new Error('APPDATA is not set');
    return path.join(process.env.APPDATA, 'metro-maker4');
  }
  if (!process.env.HOME) throw new Error('HOME is not set');
  return process.platform === 'darwin'
    ? path.join(process.env.HOME, 'Library', 'Application Support', 'metro-maker4')
    : path.join(process.env.HOME, '.config', 'metro-maker4');
}

async function modDirectoryName() {
  const manifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'));
  const id = String(manifest.id ?? '').trim();
  const directoryName = id.split('.').at(-1);
  if (!directoryName || !/^[a-zA-Z0-9_-]+$/.test(directoryName)) {
    throw new Error(`Unsafe mod id: ${id || '(empty)'}`);
  }
  return directoryName;
}

const distManifest = JSON.parse(await readFile(path.join(distPath, 'manifest.json'), 'utf8'));
if (distManifest.main !== 'index.js') throw new Error('dist manifest must use index.js');
await lstat(path.join(distPath, distManifest.main));
for (const filename of tileServerFilenames) await lstat(path.join(distPath, filename));
for (const tileId of PILOT_TILE_IDS) {
  for (const filename of cityDataFilenames) await lstat(path.join(packagesPath, tileId, filename));
}

const applicationDataPath = path.resolve(applicationDataPathForPlatform());
const modsPath = path.join(applicationDataPath, 'mods');
const citiesDataPath = path.join(applicationDataPath, 'cities', 'data');
const targetPath = path.resolve(modsPath, await modDirectoryName());
if (path.dirname(targetPath) !== modsPath) throw new Error(`Refusing unsafe mod target: ${targetPath}`);

await stopTileServer({
  starterPath: path.join(root, 'start-tile-server.ps1'),
  installRoot: targetPath,
});
console.log('Stopped the existing NEC PMTiles service before replacement');

await mkdir(modsPath, { recursive: true });
await rm(targetPath, { recursive: true, force: true });
await cp(distPath, targetPath, { recursive: true });
console.log(`Installed mod to: ${targetPath}`);

await mkdir(citiesDataPath, { recursive: true });
for (const tileId of PILOT_TILE_IDS) {
  const cityTargetPath = path.resolve(citiesDataPath, tileId);
  if (path.dirname(cityTargetPath) !== citiesDataPath) throw new Error(`Refusing unsafe city target: ${cityTargetPath}`);
  await rm(cityTargetPath, { recursive: true, force: true });
  await mkdir(cityTargetPath, { recursive: true });
  for (const filename of cityDataFilenames) {
    await copyFile(path.join(packagesPath, tileId, filename), path.join(cityTargetPath, filename));
  }
  console.log(`Installed ${tileId} data to: ${cityTargetPath}`);
}

const tileServer = await ensureTileServerReady({
  starterPath: path.join(targetPath, 'start-tile-server.ps1'),
});
console.log(`PMTiles service: ${tileServer.status} at ${tileServer.baseUrl}`);
