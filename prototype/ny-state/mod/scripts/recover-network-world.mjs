import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGlobalNetwork } from '../../../kc-two-tile/mod/src/network-projection.js';

const ENTITY_KEYS = ['tracks', 'trains', 'routes', 'trackGroups', 'signals', 'stNodes', 'stations', 'stationGroups'];

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1];
}

function worldKey(value) {
  if (!value) throw new Error('Both --source and --target world IDs are required');
  return value.startsWith('world:') ? value : `world:${value}`;
}

function byId(values) {
  return new Map((Array.isArray(values) ? values : [])
    .filter((value) => value?.id != null)
    .map((value) => [String(value.id), structuredClone(value)]));
}

function unionEntities(older, newer) {
  const result = byId(older);
  for (const [id, value] of byId(newer)) result.set(id, value);
  return [...result.values()];
}

function unionFareGroups(older, newer) {
  const result = byId(older);
  for (const [id, value] of byId(newer)) {
    const previous = result.get(id);
    if (!previous) {
      result.set(id, value);
      continue;
    }
    result.set(id, {
      ...previous,
      ...value,
      routeIds: [...new Set([...(previous.routeIds ?? []), ...(value.routeIds ?? [])].map(String))],
      routeFares: { ...(previous.routeFares ?? {}), ...(value.routeFares ?? {}) },
    });
  }
  return [...result.values()];
}

function mergeFinancials(older, newer) {
  return {
    ...(older ?? {}),
    ...(newer ?? {}),
    byRoute: { ...(older?.byRoute ?? {}), ...(newer?.byRoute ?? {}) },
    currentHour: { ...(older?.currentHour ?? {}), ...(newer?.currentHour ?? {}) },
    lastHourTimestamp: Math.max(Number(older?.lastHourTimestamp) || 0, Number(newer?.lastHourTimestamp) || 0),
  };
}

function overlap(left, right, key) {
  const rightIds = new Set((right[key] ?? []).map((value) => String(value.id)));
  return (left[key] ?? []).filter((value) => rightIds.has(String(value.id))).length;
}

const input = path.resolve(option('input') ?? path.join(
  process.env.APPDATA ?? '', 'metro-maker4', 'mod-data', 'local.ny-state-six-tile-canary.json',
));
const sourceKey = worldKey(option('source'));
const targetKey = worldKey(option('target'));
const write = process.argv.includes('--write');
const store = JSON.parse(await readFile(input, 'utf8'));
const source = store[sourceKey];
const target = store[targetKey];
if (!source?.globalNetwork?.nativeState || !target?.globalNetwork?.nativeState) {
  throw new Error('Source and target must both contain a global network');
}

const older = source.globalNetwork.nativeState;
const newer = target.globalNetwork.nativeState;
const trackOverlap = overlap(older, newer, 'tracks');
const stationOverlap = overlap(older, newer, 'stations');
if (trackOverlap < Math.min(25, (newer.tracks?.length ?? 0) * 0.5)
  || stationOverlap < Math.min(5, (newer.stations?.length ?? 0) * 0.5)) {
  throw new Error(`Refusing unrelated-world merge: ${trackOverlap} track and ${stationOverlap} station IDs overlap`);
}

const mergedState = structuredClone(older);
for (const key of ENTITY_KEYS) mergedState[key] = unionEntities(older[key], newer[key]);
mergedState.fareGroups = unionFareGroups(older.fareGroups, newer.fareGroups);
mergedState.routeFinancials = mergeFinancials(older.routeFinancials, newer.routeFinancials);
for (const key of ['ownedTrainCount', 'ownedCarsByType']) {
  if (newer[key] !== undefined) mergedState[key] = structuredClone(newer[key]);
}

target.globalNetwork = createGlobalNetwork(mergedState, (Number(target.globalNetwork.revision) || 0) + 1);
target.activeProjection = null;
target.projectionOverlay = { type: 'FeatureCollection', features: [] };
target.projectionWarning = null;
target.revision = (Number(target.revision) || 0) + 1;

const summary = Object.fromEntries(ENTITY_KEYS.map((key) => [key, {
  source: older[key]?.length ?? 0,
  target: newer[key]?.length ?? 0,
  merged: mergedState[key]?.length ?? 0,
}]));
console.log(JSON.stringify({ input, sourceKey, targetKey, trackOverlap, stationOverlap, summary, write }, null, 2));

if (write) {
  const backup = `${input}.pre-network-recovery-${Date.now()}.bak`;
  await copyFile(input, backup);
  await writeFile(input, JSON.stringify(store));
  console.log(`Recovered target world; backup: ${backup}`);
}
