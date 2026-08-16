import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createNetworkProfile } from '../../../kc-two-tile/mod/src/cross-tile-mode-choice.js';
import { createGlobalNetwork } from '../../../kc-two-tile/mod/src/network-projection.js';
import {
  mergeRecoveryStates,
  selectRouteRecoveryState,
} from '../../../kc-two-tile/mod/src/network-recovery.js';
import { decodeMetroSave } from '../../../kc-two-tile/mod/scripts/inspect-metro-save.mjs';

const CANONICAL_WORLD_ID = '969e5d4d-62d2-463f-99b2-235ca101f372';
const LOST_WORLD_ID = '62842bd8-de7c-4c94-a020-722a33e49956';
const RECOVERY_ID = 'authoritative-lineage-storage-race-2026-08-15';
const ENTITY_KEYS = Object.freeze([
  'tracks', 'trains', 'routes', 'trackGroups', 'signals', 'stNodes', 'stations', 'stationGroups',
]);
const REQUIRED_ROUTES = Object.freeze({
  'd7b58cd2-b68c-4fc5-b860-b3747e0b97d5': '1',
  '36901c8e-b76c-4d3e-921e-adb1860286f0': 'A',
  '9160dcdd-30d2-4a7e-821e-c560a45b48a5': 'F',
  '2a6cb02f-4a78-4ac0-b0d0-16fef8c755bb': 'Empire Line',
  'da40e3d7-1257-41af-b10d-eec737d47467': '101',
  '22db486a-28d5-4b6d-899c-e986335c6f93': '102',
  'a707a2be-d39a-400b-b73a-f2b61ee4e639': '103',
  'b13a0ef3-deec-473b-88d1-d7bdc2d4acac': 'Long Island Line',
  'df1d2c1d-3f92-4034-b8ee-bdfd3a33c660': 'R',
  '9d06b386-d23a-4cb8-9d48-28cc247b2373': 'Z',
});
const KNOWN_SESSIONS = Object.freeze([
  '354ec4ab-4d32-4ffa-b186-a0cd4ae7a01e',
  '6c36b2d7-6fff-452e-9511-d9cbe316fcfc',
  LOST_WORLD_ID,
  'f437945c-fa4b-41a1-9c6e-38fbc8d8417b',
]);
const DYNAMIC_WORLD_KEYS = Object.freeze([
  'worldTime',
  'elapsedSeconds',
  'wallet',
  'farePolicy',
  'gatewayLedger',
  'gatewayCatalog',
  'commuteCatalogBuildHash',
  'commuteLastProcessedHour',
  'crossModeShare',
  'crossPopModeChoices',
  'crossTileFinancials',
  'pendingCrossTileAttribution',
  'settlementAccountingSchemaVersion',
  'settlementFinanceQuarantine',
  'financialHistory',
  'backgroundNativeFinance',
  'commuteLedgerSchemaVersion',
  'commuteNextActivityHour',
]);

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function values(value) {
  return Array.isArray(value) ? value : Object.values(value ?? {});
}

function idSet(items) {
  return new Set(array(items).filter((item) => item?.id != null).map((item) => String(item.id)));
}

function assertUniqueIds(state, key, failures) {
  const seen = new Set();
  for (const item of array(state[key])) {
    const id = item?.id == null ? null : String(item.id);
    if (!id) failures.push(`${key} contains an entity without an id`);
    else if (seen.has(id)) failures.push(`${key} contains duplicate id ${id}`);
    else seen.add(id);
  }
}

function collectReferences(value, keys, result = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, keys, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && (typeof child === 'string' || typeof child === 'number')) result.add(String(child));
    else if (keys.has(key) && Array.isArray(child)) {
      for (const id of child) if (id != null && typeof id !== 'object') result.add(String(id));
    }
    collectReferences(child, keys, result);
  }
  return result;
}

function missing(references, available) {
  return [...references].filter((id) => !available.has(id));
}

function validateRecoveredState(state) {
  const failures = [];
  const warnings = [];
  for (const key of ENTITY_KEYS) assertUniqueIds(state, key, failures);

  const routeIds = idSet(state.routes);
  const trackIds = idSet(state.tracks);
  const nodeIds = idSet(state.stNodes);
  const stationIds = idSet(state.stations);
  const trackGroupIds = idSet(state.trackGroups);
  const signalIds = idSet(state.signals);
  for (const [routeId, label] of Object.entries(REQUIRED_ROUTES)) {
    if (!routeIds.has(routeId)) failures.push(`required route ${label} (${routeId}) is missing`);
  }
  if (routeIds.size !== Object.keys(REQUIRED_ROUTES).length) {
    failures.push(`expected exactly ${Object.keys(REQUIRED_ROUTES).length} routes, found ${routeIds.size}`);
  }

  for (const route of array(state.routes)) {
    const routeId = String(route.id);
    const directNodeIds = new Set(array(route.stNodes).map((node) => node?.id).filter(Boolean).map(String));
    const referencedNodes = collectReferences(route, new Set(['stNodeId', 'stNodeIds']));
    for (const id of directNodeIds) referencedNodes.add(id);
    const missingNodes = missing(referencedNodes, nodeIds);
    if (missingNodes.length) failures.push(`route ${routeId} references missing station nodes: ${missingNodes.join(', ')}`);

    const missingTracks = missing(
      collectReferences(route, new Set(['trackId', 'trackIds'])),
      trackIds,
    );
    if (missingTracks.length) failures.push(`route ${routeId} references missing tracks: ${missingTracks.join(', ')}`);
  }

  for (const train of array(state.trains)) {
    if (train?.routeId != null && !routeIds.has(String(train.routeId))) {
      failures.push(`train ${train.id} references missing route ${train.routeId}`);
    }
  }
  for (const station of array(state.stations)) {
    const missingNodes = missing(new Set(array(station.stNodeIds).map(String)), nodeIds);
    if (missingNodes.length) failures.push(`station ${station.id} references missing nodes: ${missingNodes.join(', ')}`);
  }
  for (const node of array(state.stNodes)) {
    if (node?.stationId != null && !stationIds.has(String(node.stationId))) {
      failures.push(`station node ${node.id} references missing station ${node.stationId}`);
    }
    if (node?.trackGroupId != null && !trackGroupIds.has(String(node.trackGroupId))) {
      failures.push(`station node ${node.id} references missing track group ${node.trackGroupId}`);
    }
  }
  for (const group of array(state.trackGroups)) {
    const missingTracks = missing(new Set(array(group.trackIds).map(String)), trackIds);
    if (missingTracks.length) failures.push(`track group ${group.id} references missing tracks: ${missingTracks.join(', ')}`);
  }
  for (const signal of array(state.signals)) {
    const referencedTracks = collectReferences(signal, new Set(['trackId', 'trackIds']));
    const missingTracks = missing(referencedTracks, trackIds);
    // Subway Builder retains a handful of merge/diamond signal records after
    // splitting their underlying track a second time. The coherent native
    // source save already contains those dangling operational hints and loads
    // them successfully; preserve them, but make the inherited condition
    // explicit in the recovery report instead of confusing it with damage
    // introduced by the merge.
    if (missingTracks.length) warnings.push(`signal ${signal.id} references source-missing tracks: ${missingTracks.join(', ')}`);
  }
  for (const group of array(state.fareGroups)) {
    const missingRoutes = missing(new Set(array(group.routeIds).map(String)), routeIds);
    if (missingRoutes.length) failures.push(`fare group ${group.id} references missing routes: ${missingRoutes.join(', ')}`);
  }
  if (failures.length) throw new Error(`Recovered network failed validation:\n- ${failures.slice(0, 100).join('\n- ')}`);
  return {
    entities: Object.fromEntries([...ENTITY_KEYS, 'fareGroups'].map((key) => [key, array(state[key]).length])),
    routes: array(state.routes).map((route) => ({
      id: String(route.id),
      name: route.bullet ?? route.fullName ?? route.name ?? String(route.id),
      stationNodes: array(route.stNodes).length,
    })),
    warnings,
  };
}

function revisionWorld(store) {
  const envelopes = Object.values(store).filter((value) => value?.kind === 'world-revision' && value?.world);
  if (!envelopes.length) throw new Error('Broken sidecar contains no recoverable revision envelope');
  return envelopes.sort((left, right) => (
    (Number(right.world?.revision) || 0) - (Number(left.world?.revision) || 0)
  ))[0].world;
}

function nativeSave(filePath) {
  const decoded = decodeMetroSave(filePath);
  const save = decoded.mainSave ?? decoded;
  if (!save?.data) throw new Error(`Native save has no data payload: ${filePath}`);
  return save;
}

const appData = process.env.APPDATA ?? '';
const basePath = path.resolve(option('base', path.join(
  appData,
  'metro-maker4',
  'mod-data',
  'local.ny-state-six-tile-canary.json.pre-lineage-race-recovery-1786761104776.bak',
)));
const brokenPath = path.resolve(option('broken', path.join(
  'recovery', '2026-08-15-frozen-live', 'broken-live-sidecar-frozen.json',
)));
const corridorPath = path.resolve(option(
  'corridor-save',
  'D:/SubwayBuilder/_auto__2026_08_15_19_00_02_c7f16724a2ef4e7dbc4418ff6f79888c.metro',
));
const nycPath = path.resolve(option(
  'nyc-save',
  'D:/SubwayBuilder/_auto__2026_08_15_19_12_33_a12923f9213f41d4a75f284724c358a4.metro',
));
const outputDirectory = path.resolve(option(
  'output-dir',
  path.join('recovery', '2026-08-15-authoritative-recovery'),
));
const outputPath = path.join(outputDirectory, 'recovered-sidecar.json');
const reportPath = path.join(outputDirectory, 'recovery-report.json');

const [baseStore, brokenStore] = await Promise.all([
  readFile(basePath, 'utf8').then(JSON.parse),
  readFile(brokenPath, 'utf8').then(JSON.parse),
]);
const baseWorld = clone(baseStore[`world:${CANONICAL_WORLD_ID}`]);
if (!baseWorld?.globalNetwork?.nativeState) throw new Error('Base sidecar lacks the canonical global network');
const latestWorld = revisionWorld(brokenStore);

const corridor = nativeSave(corridorPath);
const nyc = nativeSave(nycPath);
const nycRouteIds = array(nyc.data.routes).map((route) => String(route.id));
const recoveredState = mergeRecoveryStates(
  corridor.data,
  selectRouteRecoveryState(nyc.data, nycRouteIds),
);
recoveredState.routeFinancials = clone(nyc.data.routeFinancials ?? corridor.data.routeFinancials ?? {});
recoveredState.ownedTrainCount = clone(nyc.data.ownedTrainCount ?? corridor.data.ownedTrainCount ?? null);
recoveredState.ownedCarsByType = clone(nyc.data.ownedCarsByType ?? corridor.data.ownedCarsByType ?? null);
const validation = validateRecoveredState(recoveredState);

const recoveredWorld = baseWorld;
for (const key of DYNAMIC_WORLD_KEYS) {
  if (latestWorld[key] !== undefined) recoveredWorld[key] = clone(latestWorld[key]);
}
recoveredWorld.worldId = CANONICAL_WORLD_ID;
recoveredWorld.activeTileId = latestWorld.activeTileId ?? recoveredWorld.activeTileId;
recoveredWorld.revision = Math.max(Number(baseWorld.revision) || 0, Number(latestWorld.revision) || 0) + 1;
recoveredWorld.globalNetwork = createGlobalNetwork(
  recoveredState,
  Math.max(Number(baseWorld.globalNetwork.revision) || 0, Number(latestWorld.globalNetwork?.revision) || 0) + 1,
);
recoveredWorld.activeProjection = null;
recoveredWorld.projectionOverlay = { type: 'FeatureCollection', features: [] };
recoveredWorld.projectionWarning = null;
recoveredWorld.pendingTransition = null;
recoveredWorld.committedTransitionId = null;
recoveredWorld.projectionWriteQuarantine = {
  active: false,
  reason: null,
  since: null,
  lastFailure: null,
};
recoveredWorld.networkRecoveries ??= {};
recoveredWorld.networkRecoveries[RECOVERY_ID] = {
  recoveredAt: Date.now(),
  canonicalWorldId: CANONICAL_WORLD_ID,
  discardedLineageId: LOST_WORLD_ID,
  sourceNativeSaves: [corridor.id, nyc.id],
  sourceCities: [corridor.cityCode, nyc.cityCode],
  ...validation.entities,
  networkHash: recoveredWorld.globalNetwork.hash,
};

for (const [tileId, tile] of Object.entries(recoveredWorld.tiles ?? {})) {
  tile.lastSimulatedTime = recoveredWorld.worldTime;
  if (tile.networkProfile) {
    tile.networkProfile = createNetworkProfile({
      tileId,
      stations: recoveredState.stations,
      routes: recoveredState.routes,
      trains: recoveredState.trains,
      pathfindingRules: tile.networkProfile.pathfindingRules ?? {},
    });
  }
}

const descriptorIds = new Set(Object.keys(recoveredWorld.globalNetwork.routeDescriptors ?? {}));
for (const routeId of Object.keys(REQUIRED_ROUTES)) {
  if (!descriptorIds.has(routeId)) throw new Error(`Global route descriptor missing after recovery: ${routeId}`);
}

const recoveredStore = {
  [`world:${CANONICAL_WORLD_ID}`]: recoveredWorld,
  [`world:${CANONICAL_WORLD_ID}:save-checkpoints`]: {
    schemaVersion: 3,
    nextSequence: 0,
    entries: [],
  },
  'identity:canonical-world': CANONICAL_WORLD_ID,
  'diagnostics:authoritative-recovery': {
    recoveryId: RECOVERY_ID,
    recoveredAt: Date.now(),
    canonicalWorldId: CANONICAL_WORLD_ID,
    discardedLineageId: LOST_WORLD_ID,
  },
};
for (const sessionId of KNOWN_SESSIONS) {
  recoveredStore[`identity:session:${sessionId}`] = CANONICAL_WORLD_ID;
}

const report = {
  status: 'validated',
  recoveryId: RECOVERY_ID,
  canonicalWorldId: CANONICAL_WORLD_ID,
  discardedLineageId: LOST_WORLD_ID,
  lineageCause: [
    'An unknown native autosave had no embedded canonical marker or persisted session alias.',
    'The identity resolver defaulted its world id to the native session id and stamped that lineage authoritative.',
    'Parallel writes against JSON-backed scoped storage replaced sibling keys, so the new pointer outlived four missing assets.',
  ],
  sources: {
    baseSidecar: basePath,
    brokenSidecar: brokenPath,
    corridorNativeSave: { path: corridorPath, id: corridor.id, cityCode: corridor.cityCode },
    nycNativeSave: { path: nycPath, id: nyc.id, cityCode: nyc.cityCode },
  },
  world: {
    revision: recoveredWorld.revision,
    globalNetworkRevision: recoveredWorld.globalNetwork.revision,
    activeTileId: recoveredWorld.activeTileId,
    elapsedSeconds: recoveredWorld.elapsedSeconds,
    wallet: recoveredWorld.wallet,
    networkHash: recoveredWorld.globalNetwork.hash,
  },
  validation,
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, JSON.stringify(recoveredStore));
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, reportPath, ...report }, null, 2));
