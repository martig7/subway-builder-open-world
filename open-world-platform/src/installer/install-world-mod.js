import { copyFile, cp, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { loadWorldDefinition } from '../contracts/load-world-definition.js';
import { verifyWorldMod } from '../mod-builder/verify-world-mod.js';
import { ensureTileServerReady, stopTileServer } from './tile-server-control.js';

const CITY_DATA_FILENAMES = ['demand_data.json.gz', 'buildings_index.bin.gz', 'roads.geojson.gz', 'runways_taxiways.geojson.gz', 'cross_commutes.json', 'cross_demand.json.gz', 'tiles.pmtiles'];

function applicationDataPathForPlatform(platform = process.platform, environment = process.env) {
  if (platform === 'win32') {
    if (!environment.APPDATA) throw new Error('APPDATA is not set');
    return path.join(environment.APPDATA, 'metro-maker4');
  }
  if (!environment.HOME) throw new Error('HOME is not set');
  return platform === 'darwin'
    ? path.join(environment.HOME, 'Library', 'Application Support', 'metro-maker4')
    : path.join(environment.HOME, '.config', 'metro-maker4');
}

export function resolveInstallTargets({ definition, applicationDataPath = applicationDataPathForPlatform() }) {
  const directoryName = definition.identity.manifestId.split('.').at(-1);
  if (!directoryName || !/^[a-zA-Z0-9_-]+$/.test(directoryName)) throw new Error(`Unsafe mod id: ${definition.identity.manifestId}`);
  const appData = path.resolve(applicationDataPath);
  const modsPath = path.join(appData, 'mods');
  const citiesDataPath = path.join(appData, 'cities', 'data');
  const targetPath = path.resolve(modsPath, directoryName);
  if (path.dirname(targetPath) !== modsPath) throw new Error(`Refusing unsafe mod target: ${targetPath}`);
  return { applicationDataPath: appData, modsPath, citiesDataPath, targetPath };
}

export async function installWorldMod({ worldRoot, outputRoot, packageRoot, applicationDataPath, startServer = true }) {
  const { definition, selectedTiles } = await loadWorldDefinition(worldRoot);
  await verifyWorldMod({ worldRoot, outputRoot });
  const targets = resolveInstallTargets({ definition, applicationDataPath });
  const distPath = path.resolve(outputRoot);
  const packagesPath = path.resolve(packageRoot);
  for (const filename of ['index.js', 'manifest.json', 'world-definition.json', 'world-definition.sha256', 'start-tile-server.ps1', 'native-pmtiles-server.ps1']) await lstat(path.join(distPath, filename));
  for (const tile of selectedTiles) for (const filename of CITY_DATA_FILENAMES) await lstat(path.join(packagesPath, tile.id, filename));

  await stopTileServer({ definition, starterPath: path.join(distPath, 'start-tile-server.ps1'), installRoot: targets.targetPath });
  await mkdir(targets.modsPath, { recursive: true });
  await rm(targets.targetPath, { recursive: true, force: true });
  await cp(distPath, targets.targetPath, { recursive: true });
  await mkdir(targets.citiesDataPath, { recursive: true });
  for (const tile of selectedTiles) {
    const cityTargetPath = path.resolve(targets.citiesDataPath, tile.id);
    if (path.dirname(cityTargetPath) !== targets.citiesDataPath) throw new Error(`Refusing unsafe city target: ${cityTargetPath}`);
    await rm(cityTargetPath, { recursive: true, force: true });
    await mkdir(cityTargetPath, { recursive: true });
    for (const filename of CITY_DATA_FILENAMES) await copyFile(path.join(packagesPath, tile.id, filename), path.join(cityTargetPath, filename));
  }
  const installedManifest = JSON.parse(await readFile(path.join(targets.targetPath, 'manifest.json'), 'utf8'));
  if (installedManifest.id !== definition.identity.manifestId) throw new Error('Installed manifest verification failed');
  const tileServer = startServer
    ? await ensureTileServerReady({ definition, starterPath: path.join(targets.targetPath, 'start-tile-server.ps1') })
    : { status: 'not-started' };
  return { ...targets, definition, tileServer };
}
