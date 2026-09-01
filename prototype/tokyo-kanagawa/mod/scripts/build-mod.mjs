import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const generatedRoot = path.resolve(root, '..', 'generated');
const catalogPath = path.join(generatedRoot, 'catalog', 'tokyo-kanagawa-tile-catalog.json');
const demandRoot = path.join(generatedRoot, 'demand');
const mapRoot = path.join(generatedRoot, 'maps', 'tiles');
const packageRoot = path.join(generatedRoot, 'mod', 'tiles');
const tileServerFiles = [
  [path.join(root, 'start-tile-server.ps1'), 'start-tile-server.ps1'],
  [path.resolve(root, '..', 'tools', 'native-pmtiles-server.ps1'), 'native-pmtiles-server.ps1'],
];
const selectedTiles = JSON.parse(await readFile(catalogPath, 'utf8')).tiles
  .filter((tile) => tile.status === 'selected');

const requiredMapFiles = [
  'buildings_index.bin.gz',
  'roads.geojson.gz',
  'runways_taxiways.geojson.gz',
  'tiles.pmtiles',
  'map-manifest.json',
];
const requiredDemandFiles = ['demand_data.json.gz'];
const missing = [];

async function hasFile(filePath) {
  try {
    return (await stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

for (const tile of selectedTiles) {
  for (const filename of requiredDemandFiles) {
    if (!(await hasFile(path.join(demandRoot, 'tiles', tile.id, filename)))) {
      missing.push(`demand/${tile.id}/${filename}`);
    }
  }
  for (const filename of requiredMapFiles) {
    if (!(await hasFile(path.join(mapRoot, tile.id, filename)))) {
      missing.push(`maps/${tile.id}/${filename}`);
    }
  }
}

if (missing.length) {
  throw new Error([
    `Tokyo–Kanagawa mod build is waiting for ${missing.length} generated asset(s).`,
    'Finish the remote Depot run and sync its map packages, then rerun npm run build.',
    ...missing.slice(0, 20).map((entry) => `- ${entry}`),
    missing.length > 20 ? `- …and ${missing.length - 20} more` : '',
  ].filter(Boolean).join('\n'));
}

const crossCommutes = await readFile(path.join(demandRoot, 'world', 'cross_commutes.json'), 'utf8');
const crossDemandGzipBase64 = (await readFile(path.join(demandRoot, 'world', 'cross_demand.json.gz'))).toString('base64');

await rm(packageRoot, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

const packageManifest = {
  schemaVersion: 1,
  worldId: 'JP_TOKYO_KANAGAWA_MAINLAND',
  tileCount: selectedTiles.length,
  tileIds: selectedTiles.map((tile) => tile.id),
  demandSource: 'e-Stat Census municipality O/D constrained by local mesh demand, clipped to mainland Tokyo and Kanagawa',
  mapSource: 'Geofabrik Kanto OpenStreetMap extract processed by the Depot map builder',
  files: {
    demandData: 'demand_data.json.gz',
    crossCommutes: 'cross_commutes.json',
    crossDemand: 'cross_demand.json.gz',
    buildingsIndex: 'buildings_index.bin.gz',
    roads: 'roads.geojson.gz',
    runwaysTaxiways: 'runways_taxiways.geojson.gz',
    pmtiles: 'tiles.pmtiles',
  },
  tiles: [],
};

for (const tile of selectedTiles) {
  const tilePackageRoot = path.join(packageRoot, tile.id);
  await mkdir(tilePackageRoot, { recursive: true });
  const demandTileRoot = path.join(demandRoot, 'tiles', tile.id);
  const mapTileRoot = path.join(mapRoot, tile.id);
  const copies = [
    [path.join(demandTileRoot, 'demand_data.json.gz'), 'demand_data.json.gz'],
    [path.join(demandRoot, 'world', 'cross_commutes.json'), 'cross_commutes.json'],
    [path.join(demandRoot, 'world', 'cross_demand.json.gz'), 'cross_demand.json.gz'],
    ...requiredMapFiles.slice(0, 4).map((filename) => [path.join(mapTileRoot, filename), filename]),
  ];
  for (const [source, filename] of copies) await copyFile(source, path.join(tilePackageRoot, filename));
  const mapManifest = JSON.parse(await readFile(path.join(mapTileRoot, 'map-manifest.json'), 'utf8'));
  packageManifest.tiles.push({
    id: tile.id,
    gameCityCode: tile.gameCityCode ?? tile.id,
    mapCityCode: mapManifest.cityCode ?? null,
    mapManifest: mapManifest,
  });
}

await writeFile(
  path.join(packageRoot, 'package-manifest.json'),
  `${JSON.stringify(packageManifest, null, 2)}\n`,
  'utf8',
);

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = await import('../../../kc-two-tile/mod/node_modules/esbuild/lib/main.js');
}

const distPath = path.join(root, 'dist');
await mkdir(distPath, { recursive: true });
await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['./src/game-entry.js'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  legalComments: 'none',
  define: {
    __TOKYO_KANAGAWA_CROSS_COMMUTE_CATALOG__: crossCommutes,
    __TOKYO_KANAGAWA_CROSS_DEMAND_GZIP_BASE64__: JSON.stringify(crossDemandGzipBase64),
  },
});
await copyFile(path.join(root, 'manifest.json'), path.join(distPath, 'manifest.json'));
for (const [source, filename] of tileServerFiles) {
  await copyFile(source, path.join(distPath, filename));
}
console.log(`Built Tokyo–Kanagawa mod with ${selectedTiles.length} tile packages`);
