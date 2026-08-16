import { readFile } from 'node:fs/promises';
import path from 'node:path';

const CANONICAL_WORLD_ID = '969e5d4d-62d2-463f-99b2-235ca101f372';
const REJECTED_LINEAGE_ID = '62842bd8-de7c-4c94-a020-722a33e49956';
const REQUIRED_BULLETS = new Set(['1', 'A', 'F', 'EL', '101', '102', '103', 'LI', 'R', 'Z']);

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

function referencedAssetKeys(refs) {
  return [
    refs?.globalNetwork?.key,
    ...Object.values(refs?.tileSnapshots ?? {}).map((ref) => ref?.key),
    refs?.projectionBaseline?.key,
    refs?.projectionOverlay?.key,
  ].filter(Boolean);
}

const sidecarPath = path.resolve(option('sidecar', path.join(
  process.env.APPDATA ?? '',
  'metro-maker4',
  'mod-data',
  'local.ny-state-six-tile-canary.json',
)));
const store = JSON.parse(await readFile(sidecarPath, 'utf8'));
const pointerKey = `world:${CANONICAL_WORLD_ID}`;
const pointer = store[pointerKey];
const failures = [];

if (store['identity:canonical-world'] !== CANONICAL_WORLD_ID) {
  failures.push('durable canonical-world identity is missing or incorrect');
}
if (store[`world:${REJECTED_LINEAGE_ID}`]) {
  failures.push('the rejected lineage still has a live world pointer');
}
if (pointer?.kind !== 'world-revision-pointer' || !pointer?.revisionId) {
  failures.push('canonical live pointer is not a revision pointer');
}

const revisionKey = pointer?.revisionId
  ? `world:${CANONICAL_WORLD_ID}:revision:${pointer.revisionId}`
  : null;
const revision = revisionKey ? store[revisionKey] : null;
if (!revision?.world) failures.push('canonical live revision payload is missing');

const refs = revision?.assetRefs ?? pointer?.assetRefs ?? {};
const missingAssets = referencedAssetKeys(refs).filter((key) => store[key] == null);
if (missingAssets.length) failures.push(`canonical revision has ${missingAssets.length} missing assets`);

const globalState = refs?.globalNetwork?.key ? store[refs.globalNetwork.key] : null;
if (!globalState) failures.push('global native network asset is missing');
const routes = Array.isArray(globalState?.routes) ? globalState.routes : [];
const bullets = routes.map((route) => route?.bullet ?? route?.name ?? route?.fullName).filter(Boolean);
for (const bullet of REQUIRED_BULLETS) {
  if (!bullets.includes(bullet)) failures.push(`required route ${bullet} is missing`);
}
if (routes.length !== REQUIRED_BULLETS.size) {
  failures.push(`expected ${REQUIRED_BULLETS.size} global routes, found ${routes.length}`);
}

const result = {
  status: failures.length ? 'invalid' : 'valid',
  sidecarPath,
  canonicalWorldId: store['identity:canonical-world'] ?? null,
  revisionId: pointer?.revisionId ?? null,
  worldRevision: revision?.world?.revision ?? pointer?.worldRevision ?? null,
  activeTileId: revision?.world?.activeTileId ?? pointer?.activeTileId ?? null,
  referencedAssetCount: referencedAssetKeys(refs).length,
  missingAssets,
  globalNetworkHash: revision?.world?.globalNetwork?.hash ?? null,
  entityCounts: globalState ? Object.fromEntries([
    'tracks', 'trains', 'routes', 'trackGroups', 'signals', 'stNodes', 'stations', 'stationGroups',
  ].map((key) => [key, Array.isArray(globalState[key]) ? globalState[key].length : 0])) : null,
  routes: routes.map((route) => ({
    id: route?.id ?? null,
    bullet: route?.bullet ?? null,
    name: route?.fullName ?? route?.name ?? null,
    stationNodes: Array.isArray(route?.stNodes) ? route.stNodes.length : 0,
  })),
  rejectedLineagePresent: Boolean(store[`world:${REJECTED_LINEAGE_ID}`]),
  failures,
};

console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exitCode = 1;
