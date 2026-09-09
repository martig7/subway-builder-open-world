import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const ROUTE_GEOMETRY_VERSION = 'stored-driving-routes-v1';
export function routeDataFiles(definition, tileId) {
  if (!definition.demand.routeGeometry) return [];
  return ['driving-routes.idx', 'driving-routes.bin',
    ...(tileId === definition.tileViews.initialTileId ? ['cross-driving-routes.idx', 'cross-driving-routes.bin'] : [])];
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function routeGeometryArtifacts({ definition, selectedTiles, generatedRoot, packageRoot }) {
  if (!definition.demand.routeGeometry) return { entries: [], metadata: null };
  const root = path.join(generatedRoot, 'routes');
  const raw = await readFile(path.join(root, 'route-geometry-manifest.json'), 'utf8');
  const manifest = JSON.parse(raw);
  if (manifest.version !== ROUTE_GEOMETRY_VERSION) throw new Error('Unsupported route geometry artifact');
  const entries = [];
  for (const id of ['cross', ...selectedTiles.map(t => t.id)]) {
    const report = manifest.packages[id];
    const demandPath = id === 'cross' ? path.join(generatedRoot, 'demand/world/cross_demand.json.gz')
      : path.join(generatedRoot, 'demand/tiles', id, 'demand_data.json.gz');
    if (!report || report.version !== manifest.version || report.datasetId !== manifest.datasetId ||
      report.tileId !== id || report.demandSha256 !== await hashFile(demandPath)) throw new Error(`Route geometry does not match demand: ${id}`);
    const tileId = id === 'cross' ? definition.tileViews.initialTileId : id;
    const expected = id === 'cross' ? ['cross-driving-routes.idx', 'cross-driving-routes.bin'] : ['driving-routes.idx', 'driving-routes.bin'];
    if (report.assets?.length !== 2) throw new Error(`Invalid route assets: ${id}`);
    for (const name of expected) {
      const asset = report.assets.find(a => a.path === name);
      const source = path.join(root, id, name);
      if (!asset || (await stat(source)).size !== asset.bytes || await hashFile(source) !== asset.sha256) throw new Error(`Route artifact hash mismatch: ${id}/${name}`);
      entries.push({ key: `${tileId}/${name}`, source, target: path.join(packageRoot, tileId, name) });
    }
  }
  return { entries, metadata: { version: manifest.version, crossTileId: definition.tileViews.initialTileId,
    revision: createHash('sha256').update(raw).digest('hex') } };
}

export async function packagedRouteGeometry({ definition, selectedTiles, packageRoot }) {
  if (!definition.demand.routeGeometry) return null;
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package-manifest.json'), 'utf8'));
  const metadata = manifest.routeGeometry;
  if (metadata?.version !== ROUTE_GEOMETRY_VERSION || metadata.crossTileId !== definition.tileViews.initialTileId ||
    !/^[a-f0-9]{64}$/.test(metadata.revision)) throw new Error('Missing packaged route geometry metadata');
  const keys = ['cross_demand.json.gz', ...selectedTiles.flatMap(tile =>
    ['demand_data.json.gz', ...routeDataFiles(definition, tile.id)].map(name => `${tile.id}/${name}`))];
  for (const key of keys) {
    if (await hashFile(path.join(packageRoot, key)) !== manifest.artifactState?.[key]?.target?.sha256)
      throw new Error(`Packaged route input or artifact changed: ${key}`);
  }
  return metadata;
}
