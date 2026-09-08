import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadWorldDefinition } from '../contracts/load-world-definition.js';
import { OPEN_WORLD_PLATFORM_RELEASE } from '../runtime/start-open-world.js';
import { loadWorldVegetationArtifact } from './world-vegetation-artifact.js';
import { packDisplayBoundaryOverlay } from './display-boundary-artifact.js';
import { TILE_DATA_FILES, WORLD_DATA_FILES, planArtifactFiles, applyArtifactFiles } from './artifact-files.js';

const REQUIRED_MAP_FILES = ['buildings_index.bin.gz', 'roads.geojson.gz', 'runways_taxiways.geojson.gz', 'tiles.pmtiles', 'map-manifest.json'];
const REQUIRED_DEMAND_FILES = ['demand_data.json.gz'];

async function hasFile(filePath) {
  try { return (await stat(filePath)).size > 0; } catch { return false; }
}

async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch (error) {
    throw new Error('open-world-platform requires its declared esbuild dependency; run npm install in open-world-platform', { cause: error });
  }
}

function moduleSpecifier(fromDirectory, targetPath) {
  const relative = path.relative(fromDirectory, targetPath).replaceAll(path.sep, '/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

export function assertMapLabelPolicy(definition, manifest, tileId) {
  const required = definition.map.labelPolicy;
  if (required && manifest.labelPolicy !== required) {
    throw new Error(`${tileId}: map label policy ${manifest.labelPolicy ?? '(missing)'} does not match ${required}; run the World's label publication stage`);
  }
}

function generatedEntrySource({ consumerRoot, platformRoot, worldRoot, definition, worldDefinitionHash, nativeMapBounds }) {
  const runtime = moduleSpecifier(consumerRoot, path.join(platformRoot, 'src', 'runtime', 'start-open-world.js'));
  const worldDefinition = moduleSpecifier(consumerRoot, path.join(worldRoot, 'world.json'));
  const catalog = moduleSpecifier(consumerRoot, path.join(worldRoot, definition.tileViews.catalog));
  const boundary = definition.tileViews.boundaryOverlay
    ? moduleSpecifier(consumerRoot, path.join(worldRoot, definition.tileViews.boundaryOverlay))
    : null;
  return [
    `import { startOpenWorld } from ${JSON.stringify(runtime)};`,
    `import definition from ${JSON.stringify(worldDefinition)} with { type: 'json' };`,
    `import catalogSource from ${JSON.stringify(catalog)} with { type: 'json' };`,
    boundary ? `import boundaryOverlay from ${JSON.stringify(boundary)} with { type: 'json' };` : 'const boundaryOverlay = null;',
    '',
    'startOpenWorld({',
    '  definition,',
    `  catalogSource: { ...catalogSource, tiles: catalogSource.tiles.map(tile => ({ ...tile, nativeMapBounds: (${JSON.stringify(nativeMapBounds)})[tile.id] ?? tile.bounds })) },`,
    '  boundaryOverlay,',
    '  artifacts: {',
    `    worldDefinitionHash: ${JSON.stringify(worldDefinitionHash)},`,
    '    commuteCatalog: __OPEN_WORLD_CROSS_COMMUTE_CATALOG__,',
    '    crossDemandGzipBase64: __OPEN_WORLD_CROSS_DEMAND_GZIP_BASE64__,',
    '    worldVegetationGzipBase64: __OPEN_WORLD_VEGETATION_GZIP_BASE64__,',
    '  },',
    '  workerSources: {',
    '    nativeDemandEvaluator: __OPEN_WORLD_NATIVE_DEMAND_EVALUATOR_WORKER_SOURCE__,',
    '    roadRoute: __OPEN_WORLD_ROAD_ROUTE_WORKER_SOURCE__,',
    '    crossModeShare: __OPEN_WORLD_CROSS_MODE_SHARE_WORKER_SOURCE__,',
    '    hourlyFinance: __OPEN_WORLD_HOURLY_FINANCE_WORKER_SOURCE__,',
    '  },',
    '});',
  ].join('\n');
}

export async function buildWorldMod({ repositoryRoot, worldRoot, modRoot, artifactsRoot, packagedTileRoot = null, repair = false }) {
  const root = path.resolve(repositoryRoot);
  const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid Open World version: ${version}`);
  const consumerRoot = path.resolve(modRoot);
  const generatedRoot = path.resolve(artifactsRoot);
  const loaded = await loadWorldDefinition(worldRoot);
  const { definition, selectedTiles, worldDefinitionHash } = loaded;
  const worldVegetationGzipBase64 = await loadWorldVegetationArtifact(root, definition);
  let packageRoot;
  let crossCommutesPath;
  let crossDemandPath;
  const missing = [];
  if (packagedTileRoot != null || definition.release.artifactLayout === 'packaged-tile-directories-v1') {
    packageRoot = packagedTileRoot == null ? generatedRoot : path.resolve(packagedTileRoot);
    for (const tile of selectedTiles) {
      for (const filename of TILE_DATA_FILES) {
        if (!(await hasFile(path.join(packageRoot, tile.id, filename)))) missing.push(`${tile.id}/${filename}`);
      }
    }
    const initialPackage = path.join(packageRoot, definition.tileViews.initialTileId);
    // Current embedded packages store World data once; historical standalone
    // packages keep their per-tile files for the HTTP adapter and fixtures.
    crossCommutesPath = await hasFile(path.join(packageRoot, 'cross_commutes.json'))
      ? path.join(packageRoot, 'cross_commutes.json') : path.join(initialPackage, 'cross_commutes.json');
    crossDemandPath = await hasFile(path.join(packageRoot, 'cross_demand.json.gz'))
      ? path.join(packageRoot, 'cross_demand.json.gz') : path.join(initialPackage, 'cross_demand.json.gz');
  } else {
    const demandRoot = path.join(generatedRoot, 'demand');
    const mapRoot = path.join(generatedRoot, 'maps', 'tiles');
    packageRoot = path.join(generatedRoot, 'mod', 'tiles');
    for (const tile of selectedTiles) {
      for (const filename of REQUIRED_DEMAND_FILES) {
        if (!(await hasFile(path.join(demandRoot, 'tiles', tile.id, filename)))) missing.push(`demand/${tile.id}/${filename}`);
      }
      for (const filename of REQUIRED_MAP_FILES) {
        if (!(await hasFile(path.join(mapRoot, tile.id, filename)))) missing.push(`maps/${tile.id}/${filename}`);
      }
    }
    crossCommutesPath = path.join(demandRoot, 'world', 'cross_commutes.json');
    crossDemandPath = path.join(demandRoot, 'world', 'cross_demand.json.gz');
    if (!(await hasFile(crossCommutesPath))) missing.push('demand/world/cross_commutes.json');
    if (!(await hasFile(crossDemandPath))) missing.push('demand/world/cross_demand.json.gz');
    if (missing.length === 0) {
      // Validate before replacing any staged packages. Presentation must not
      // silently regress when a map worker produces fresh, raw source labels.
      for (const tile of selectedTiles) {
        const manifest = JSON.parse(await readFile(path.join(mapRoot, tile.id, 'map-manifest.json'), 'utf8'));
        assertMapLabelPolicy(definition, manifest, tile.id);
      }
      let previousManifest = {};
      try { previousManifest = JSON.parse(await readFile(path.join(packageRoot, 'package-manifest.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (!previousManifest || typeof previousManifest !== 'object' || Array.isArray(previousManifest)) previousManifest = {};
      await mkdir(packageRoot, { recursive: true });
      const entries = WORLD_DATA_FILES.map((filename, index) => ({ key: filename, source: [crossCommutesPath, crossDemandPath][index], target: path.join(packageRoot, filename) }));
      const packageManifest = {
        schemaVersion: 2,
        worldId: definition.identity.artifactWorldId,
        tileCount: selectedTiles.length,
        tileIds: selectedTiles.map((tile) => tile.id),
        files: {
          demandData: 'demand_data.json.gz',
          buildingsIndex: 'buildings_index.bin.gz', roads: 'roads.geojson.gz', runwaysTaxiways: 'runways_taxiways.geojson.gz', pmtiles: 'tiles.pmtiles',
        },
        worldFiles: { crossCommutes: 'cross_commutes.json', crossDemand: 'cross_demand.json.gz' },
        tiles: [],
      };
      for (const tile of selectedTiles) {
        const tilePackageRoot = path.join(packageRoot, tile.id);
        const demandTileRoot = path.join(demandRoot, 'tiles', tile.id);
        const mapTileRoot = path.join(mapRoot, tile.id);
        const copies = [
          [path.join(demandTileRoot, 'demand_data.json.gz'), 'demand_data.json.gz'],
          ...REQUIRED_MAP_FILES.slice(0, 4).map((filename) => [path.join(mapTileRoot, filename), filename]),
        ];
        for (const [source, filename] of copies) entries.push({ key: `${tile.id}/${filename}`, source, target: path.join(tilePackageRoot, filename) });
        const mapManifest = JSON.parse(await readFile(path.join(mapTileRoot, 'map-manifest.json'), 'utf8'));
        packageManifest.tiles.push({ id: tile.id, gameCityCode: tile.gameCityCode ?? tile.id, mapCityCode: mapManifest.cityCode ?? null, mapManifest });
      }
      const artifactPlan = await planArtifactFiles(entries, { previous: previousManifest.artifactState, repair });
      packageManifest.artifactState = await applyArtifactFiles(artifactPlan);
      for (const tile of selectedTiles) for (const filename of WORLD_DATA_FILES) await rm(path.join(packageRoot, tile.id, filename), { force: true });
      for (const tileId of previousManifest.tileIds ?? []) {
        if (packageManifest.tileIds.includes(tileId)) continue;
        const obsolete = path.resolve(packageRoot, tileId);
        if (path.dirname(obsolete) !== packageRoot) throw new Error(`Unsafe retired Tile Package: ${tileId}`);
        await rm(obsolete, { recursive: true, force: true });
      }
      await writeFile(path.join(packageRoot, 'package-manifest.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);
    }
  }
  if (missing.length) {
    throw new Error([
      `${definition.identity.name} build is waiting for ${missing.length} generated asset(s).`,
      ...missing.slice(0, 20).map((entry) => `- ${entry}`),
      missing.length > 20 ? `- …and ${missing.length - 20} more` : '',
    ].filter(Boolean).join('\n'));
  }

  const crossCommutes = await readFile(crossCommutesPath, 'utf8');
  // Native map generation includes a halo beyond selection/ownership polygons.
  // Preserve its actual footprint for the high-zoom land backing, without
  // changing demand boundaries or rebuilding the tile archives.
  const nativeMapBounds = {};
  let packageManifest = {};
  try { packageManifest = JSON.parse(await readFile(path.join(packageRoot, 'package-manifest.json'), 'utf8')); } catch {}
  for (const tile of selectedTiles) {
    let manifest = packageManifest.tiles?.find(entry => entry.id === tile.id)?.mapManifest;
    if (!manifest) {
      try { manifest = JSON.parse(await readFile(path.join(generatedRoot, 'maps', 'tiles', tile.id, 'map-manifest.json'), 'utf8')); } catch {}
    }
    const bounds = manifest?.haloBounds ?? tile.bounds;
    if (Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)) nativeMapBounds[tile.id] = bounds;
  }
  const crossDemandGzipBase64 = (await readFile(crossDemandPath)).toString('base64');

  const esbuild = await loadEsbuild();
  const platformRoot = path.join(root, 'open-world-platform');
  const workerEntries = {
    nativeDemandEvaluator: './src/workers/native-demand-evaluator-worker.js',
    roadRoute: './src/workers/road-route-worker.js',
    crossModeShare: './src/workers/cross-mode-share-worker.js',
    hourlyFinance: './src/workers/hourly-finance-worker.js',
  };
  const workerSources = {};
  for (const [name, entryPoint] of Object.entries(workerEntries)) {
    const built = await esbuild.build({ absWorkingDir: platformRoot, entryPoints: [entryPoint], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', legalComments: 'none', write: false });
    workerSources[name] = built.outputFiles[0].text;
  }
  const distPath = path.join(consumerRoot, 'dist');
  await mkdir(distPath, { recursive: true });
  await esbuild.build({
    absWorkingDir: consumerRoot,
    plugins: definition.tileViews.boundaryOverlay ? [{
      name: 'quantized-display-boundaries-v1',
      setup(build) {
        const boundaryPath = path.resolve(worldRoot, definition.tileViews.boundaryOverlay);
        build.onLoad({ filter: /\.json$/ }, async args => {
          if (path.resolve(args.path) !== boundaryPath) return;
          const overlay = JSON.parse(await readFile(args.path, 'utf8'));
          return { contents: JSON.stringify(packDisplayBoundaryOverlay(overlay)), loader: 'json' };
        });
      },
    }] : [],
    stdin: {
      contents: generatedEntrySource({ consumerRoot, platformRoot, worldRoot: path.resolve(worldRoot), definition, worldDefinitionHash, nativeMapBounds }),
      resolveDir: consumerRoot,
      sourcefile: 'open-world-entry.generated.js',
      loader: 'js',
    },
    outfile: path.join(distPath, 'index.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    legalComments: 'none',
    define: {
      __OPEN_WORLD_CROSS_COMMUTE_CATALOG__: crossCommutes,
      __OPEN_WORLD_CROSS_DEMAND_GZIP_BASE64__: JSON.stringify(crossDemandGzipBase64),
      __OPEN_WORLD_VEGETATION_GZIP_BASE64__: JSON.stringify(worldVegetationGzipBase64),
      __OPEN_WORLD_NATIVE_DEMAND_EVALUATOR_WORKER_SOURCE__: JSON.stringify(workerSources.nativeDemandEvaluator),
      __OPEN_WORLD_ROAD_ROUTE_WORKER_SOURCE__: JSON.stringify(workerSources.roadRoute),
      __OPEN_WORLD_CROSS_MODE_SHARE_WORKER_SOURCE__: JSON.stringify(workerSources.crossModeShare),
      __OPEN_WORLD_HOURLY_FINANCE_WORKER_SOURCE__: JSON.stringify(workerSources.hourlyFinance),
    },
  });
  const manifest = {
    id: definition.identity.manifestId,
    name: definition.identity.name,
    description: definition.identity.description,
    version,
    author: { name: definition.identity.author },
    main: 'index.js',
  };
  await writeFile(path.join(distPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(distPath, 'world-definition.json'), `${JSON.stringify(definition, null, 2)}\n`);
  await writeFile(path.join(distPath, 'world-definition.sha256'), `${worldDefinitionHash}\n`);
  await copyFile(path.join(root, 'SOURCES.md'), path.join(distPath, 'SOURCES.md'));
  if (definition.runtime.tileServerProvider === 'shared-native-v4') {
    // dist is reused across builds. Explicitly retire the old server artifacts
    // when an existing consumer migrates to the official shared service.
    await rm(path.join(distPath, 'start-tile-server.ps1'), { force: true });
    await rm(path.join(distPath, 'native-pmtiles-server.ps1'), { force: true });
  } else {
    const installerRoot = path.join(root, 'open-world-platform', 'src', 'installer');
    const starterTemplate = await readFile(path.join(installerRoot, 'start-tile-server.template.ps1'), 'utf8');
    const starter = starterTemplate
      .replaceAll('{{PORT}}', String(definition.runtime.tileServerPort))
      .replaceAll('{{NAMESPACE}}', definition.runtime.diagnosticNamespace)
      .replaceAll('{{HEALTH_TILE_ID}}', definition.runtime.healthTile.split('/')[0]);
    await writeFile(path.join(distPath, 'start-tile-server.ps1'), starter, 'utf8');
    await copyFile(path.join(installerRoot, 'native-pmtiles-server.ps1'), path.join(distPath, 'native-pmtiles-server.ps1'));
  }
  return { definition, worldDefinitionHash, selectedTiles, distPath, packageRoot, platformRelease: OPEN_WORLD_PLATFORM_RELEASE };
}
