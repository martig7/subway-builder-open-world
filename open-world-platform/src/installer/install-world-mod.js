import { cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadWorldDefinition } from '../contracts/load-world-definition.js';
import { verifyWorldMod } from '../mod-builder/verify-world-mod.js';
import { ensureTileServerReady, stopTileServer } from './tile-server-control.js';
import { prepareSharedServer, registerSharedWorld, startSharedServer, stopSharedServer } from './shared-tile-server-control.js';

import { TILE_DATA_FILES, WORLD_DATA_FILES, planArtifactFiles, applyArtifactFiles } from '../mod-builder/artifact-files.js';
import { routeDataFiles, ROUTE_GEOMETRY_VERSION } from '../mod-builder/route-geometry-artifact.js';

const serverControl = { prepareSharedServer, stopSharedServer, registerSharedWorld, startSharedServer, stopTileServer, ensureTileServerReady };

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
  const directoryName = definition.release?.installDirectoryName ?? definition.identity.manifestId.split('.').at(-1);
  if (!directoryName || !/^[a-zA-Z0-9._-]+$/.test(directoryName)) throw new Error(`Unsafe mod install directory: ${directoryName ?? definition.identity.manifestId}`);
  const appData = path.resolve(applicationDataPath);
  const modsPath = path.join(appData, 'mods');
  const citiesDataPath = path.join(appData, 'cities', 'data');
  const targetPath = path.resolve(modsPath, directoryName);
  if (path.dirname(targetPath) !== modsPath) throw new Error(`Refusing unsafe mod target: ${targetPath}`);
  return { applicationDataPath: appData, modsPath, citiesDataPath, targetPath };
}

export async function installWorldMod({ worldRoot, outputRoot, packageRoot, applicationDataPath, startServer = true, repair = false }, control = serverControl) {
  const { definition, selectedTiles } = await loadWorldDefinition(worldRoot);
  await verifyWorldMod({ worldRoot, outputRoot });
  const targets = resolveInstallTargets({ definition, applicationDataPath });
  const distPath = path.resolve(outputRoot);
  const packagesPath = path.resolve(packageRoot);
  const shared = definition.runtime.tileServerProvider === 'shared-native-v4';
  const requiredBundleFiles = ['index.js', 'manifest.json', 'world-definition.json', 'world-definition.sha256'];
  if (!shared) requiredBundleFiles.push('start-tile-server.ps1', 'native-pmtiles-server.ps1');
  for (const filename of requiredBundleFiles) await lstat(path.join(distPath, filename));
  for (const tile of selectedTiles) {
    const directory = path.resolve(targets.citiesDataPath, tile.id);
    if (path.dirname(directory) !== targets.citiesDataPath) throw new Error(`Refusing unsafe city target: ${directory}`);
    for (const candidate of [directory, ...[...TILE_DATA_FILES, ...WORLD_DATA_FILES, ...routeDataFiles(definition, tile.id)].map(filename => path.join(directory, filename))]) {
      try {
        if ((await lstat(candidate)).isSymbolicLink()) throw new Error(`Refusing linked city target: ${candidate}`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const statePath = path.join(targets.targetPath, '.open-world-artifacts.json');
  let previous = {};
  try { previous = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const entries = selectedTiles.flatMap(tile => [...TILE_DATA_FILES, ...routeDataFiles(definition, tile.id)].map(filename => ({
    key: `${tile.id}/${filename}`, source: path.join(packagesPath, tile.id, filename), target: path.join(targets.citiesDataPath, tile.id, filename),
  })));
  const artifactPlan = await planArtifactFiles(entries, { previous, repair });

  const builtManifest = JSON.parse(await readFile(path.join(distPath, 'manifest.json'), 'utf8'));
  const sharedContext = shared ? await control.prepareSharedServer({ definition, selectedTiles, dataRoot: targets.citiesDataPath, version: builtManifest.version }) : null;
  // Bundle updates leave the running server and unchanged city files alone.
  if (artifactPlan.files.some(file => file.changed && file.key.endsWith('/tiles.pmtiles'))) {
    if (shared) await control.stopSharedServer(sharedContext);
    else await control.stopTileServer({ definition, starterPath: path.join(distPath, 'start-tile-server.ps1'), installRoot: targets.targetPath });
  }
  await mkdir(targets.modsPath, { recursive: true });
  await rm(targets.targetPath, { recursive: true, force: true });
  await cp(distPath, targets.targetPath, { recursive: true });
  await mkdir(targets.citiesDataPath, { recursive: true });
  const artifactState = await applyArtifactFiles(artifactPlan);
  // Only these retired mod-owned files are removed; standalone input packages
  // and the historical HTTP adapter keep their own copies.
  for (const tile of selectedTiles) for (const filename of WORLD_DATA_FILES) await rm(path.join(targets.citiesDataPath, tile.id, filename), { force: true });
  await writeFile(statePath, `${JSON.stringify(artifactState, null, 2)}\n`);
  const installedManifest = JSON.parse(await readFile(path.join(targets.targetPath, 'manifest.json'), 'utf8'));
  if (installedManifest.id !== definition.identity.manifestId) throw new Error('Installed manifest verification failed');
  if (shared) await control.registerSharedWorld(sharedContext);
  const tileServer = startServer
    ? shared ? await control.startSharedServer(sharedContext, definition)
      : await control.ensureTileServerReady({ definition, starterPath: path.join(targets.targetPath, 'start-tile-server.ps1') })
    : { status: 'not-started' };
  if (startServer && definition.demand.routeGeometry) {
    const health = await fetch(`http://127.0.0.1:${definition.runtime.tileServerPort}/_health`, { signal: AbortSignal.timeout(5_000) });
    if (!health.ok || health.headers.get('X-OpenWorld-Route-Archive') !== ROUTE_GEOMETRY_VERSION)
      throw new Error('The installed map service needs the stored-driving-routes-v1 update');
  }
  return { ...targets, definition, tileServer, changedArtifactFiles: artifactPlan.changed };
}
