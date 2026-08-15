import { createGlobalNetwork } from './network-projection.js';

const ENTITY_KEYS = Object.freeze([
  'tracks', 'trains', 'routes', 'trackGroups', 'signals', 'stNodes', 'stations', 'stationGroups',
]);

const clone = (value) => value === undefined ? undefined : structuredClone(value);

function values(value) {
  return Array.isArray(value) ? value : Object.values(value ?? {});
}

function collectReferences(value, references) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'trackId' && child != null) references.trackIds.add(String(child));
    else if (key === 'trackIds' && Array.isArray(child)) {
      for (const id of child) if (id != null) references.trackIds.add(String(id));
    } else if (key === 'stNodeId' && child != null) references.stNodeIds.add(String(child));
    else if (key === 'stNodeIds' && Array.isArray(child)) {
      for (const id of child) if (id != null) references.stNodeIds.add(String(id));
    } else if (key === 'stationId' && child != null) references.stationIds.add(String(child));
    else if (key === 'stationIds' && Array.isArray(child)) {
      for (const id of child) if (id != null) references.stationIds.add(String(id));
    } else if (key === 'trackGroupId' && child != null) references.trackGroupIds.add(String(child));
    else if (key === 'signalId' && child != null) references.signalIds.add(String(child));
    else if (key === 'signalIds' && Array.isArray(child)) {
      for (const id of child) if (id != null) references.signalIds.add(String(id));
    }
    collectReferences(child, references);
  }
}

function intersectsIds(candidate, selected) {
  return values(candidate).some((id) => id != null && selected.has(String(id)));
}

/**
 * Restrict a recovery snapshot to topology owned by routes that still exist in
 * the live world. This is deliberately dependency-driven: clipped route
 * metadata can retain references to remote tracks/stations after those entity
 * arrays were accidentally truncated, so geographic filtering cannot recover
 * the missing half safely.
 */
export function selectRouteRecoveryState(nativeState, routeIds) {
  const selectedRouteIds = new Set(values(routeIds).map(String));
  const routes = values(nativeState?.routes)
    .filter((route) => route?.id != null && selectedRouteIds.has(String(route.id)));
  const references = {
    trackIds: new Set(),
    stNodeIds: new Set(),
    stationIds: new Set(),
    trackGroupIds: new Set(),
    signalIds: new Set(),
  };
  collectReferences(routes, references);

  const stations = values(nativeState?.stations).filter((station) => (
    references.stationIds.has(String(station?.id))
    || intersectsIds(station?.routeIds, selectedRouteIds)
    || intersectsIds(station?.stNodeIds, references.stNodeIds)
  ));
  collectReferences(stations, references);

  const stNodes = values(nativeState?.stNodes).filter((node) => (
    references.stNodeIds.has(String(node?.id))
  ));
  collectReferences(stNodes, references);

  const stationGroups = values(nativeState?.stationGroups).filter((group) => (
    references.stationIds.has(String(group?.id))
    || intersectsIds(group?.stationIds, references.stationIds)
    || intersectsIds(group?.stNodeIds, references.stNodeIds)
  ));
  collectReferences(stationGroups, references);

  const trackGroups = values(nativeState?.trackGroups).filter((group) => (
    references.trackGroupIds.has(String(group?.id))
    || intersectsIds(group?.trackIds, references.trackIds)
  ));
  collectReferences(trackGroups, references);

  const tracks = values(nativeState?.tracks).filter((track) => references.trackIds.has(String(track?.id)));
  const signals = values(nativeState?.signals).filter((signal) => (
    references.signalIds.has(String(signal?.id))
    || references.trackIds.has(String(signal?.trackId))
    || intersectsIds(signal?.trackIds, references.trackIds)
    || values(signal?.signalTracks).some(({ trackId }) => references.trackIds.has(String(trackId)))
  ));
  const trains = values(nativeState?.trains).filter((train) => selectedRouteIds.has(String(train?.routeId)));
  const fareGroups = values(nativeState?.fareGroups).filter((group) => intersectsIds(group?.routeIds, selectedRouteIds));
  const routeFinancials = values(nativeState?.routeFinancials).filter((entry) => (
    selectedRouteIds.has(String(entry?.routeId ?? entry?.id))
  ));

  return {
    tracks: clone(tracks),
    trains: clone(trains),
    routes: clone(routes),
    trackGroups: clone(trackGroups),
    signals: clone(signals),
    stNodes: clone(stNodes),
    stations: clone(stations),
    stationGroups: clone(stationGroups),
    fareGroups: clone(fareGroups),
    routeFinancials: clone(routeFinancials),
  };
}

export async function decodeGzipBase64Json(base64) {
  if (typeof base64 !== 'string' || !base64) throw new Error('Missing embedded network recovery');
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (typeof DecompressionStream !== 'function') throw new Error('This game runtime cannot decompress network recovery data');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

function byId(values) {
  return new Map((Array.isArray(values) ? values : [])
    .filter((value) => value?.id != null)
    .map((value) => [String(value.id), clone(value)]));
}

function unionEntities(recoveryValues, liveValues) {
  const merged = byId(recoveryValues);
  for (const [id, value] of byId(liveValues)) merged.set(id, value);
  return [...merged.values()];
}

function unionFareGroups(recoveryValues, liveValues) {
  const merged = byId(recoveryValues);
  for (const [id, live] of byId(liveValues)) {
    const recovered = merged.get(id);
    if (!recovered) {
      merged.set(id, live);
      continue;
    }
    merged.set(id, {
      ...recovered,
      ...live,
      routeIds: [...new Set([...(recovered.routeIds ?? []), ...(live.routeIds ?? [])].map(String))],
      routeFares: { ...(recovered.routeFares ?? {}), ...(live.routeFares ?? {}) },
    });
  }
  return [...merged.values()];
}

/**
 * Compose route-scoped recovery material from independent authoritative
 * sources. Sources are applied left-to-right; a later source owns conflicting
 * entity records while fare-group membership is accumulated.
 */
export function mergeRecoveryStates(...states) {
  const merged = {};
  for (const state of states.filter(Boolean)) {
    for (const key of ENTITY_KEYS) merged[key] = unionEntities(merged[key], state[key]);
    merged.fareGroups = unionFareGroups(merged.fareGroups, state.fareGroups);

    const financials = new Map(values(merged.routeFinancials)
      .filter((entry) => entry?.routeId != null || entry?.id != null)
      .map((entry) => [String(entry.routeId ?? entry.id), clone(entry)]));
    for (const entry of values(state.routeFinancials)) {
      const id = entry?.routeId ?? entry?.id;
      if (id != null) financials.set(String(id), clone(entry));
    }
    merged.routeFinancials = [...financials.values()];
  }
  return merged;
}

export function applyNetworkRecovery(world, { recoveryId, nativeState, replaceRouteIds = [] }) {
  if (!world || typeof recoveryId !== 'string' || !recoveryId || !nativeState) {
    throw new Error('Invalid network recovery payload');
  }
  world.networkRecoveries ??= {};
  if (world.networkRecoveries[recoveryId]) {
    return { changed: false, imported: clone(world.networkRecoveries[recoveryId]) };
  }
  const live = world.globalNetwork?.nativeState ?? {};
  const merged = clone(nativeState);
  for (const key of ENTITY_KEYS) merged[key] = unionEntities(nativeState[key], live[key]);
  const replacementIds = new Set(values(replaceRouteIds).map(String));
  if (replacementIds.size) {
    const recoveredRoutes = byId(nativeState.routes);
    merged.routes = values(merged.routes).map((route) => (
      replacementIds.has(String(route?.id)) && recoveredRoutes.has(String(route?.id))
        ? clone(recoveredRoutes.get(String(route.id)))
        : route
    ));
  }
  merged.fareGroups = unionFareGroups(nativeState.fareGroups, live.fareGroups);
  // The loaded native save owns its clock-sensitive financial history and
  // inventory counts. Recovery supplies these only when the live world has no
  // value at all.
  for (const key of ['routeFinancials', 'ownedTrainCount', 'ownedCarsByType']) {
    merged[key] = clone(live[key] ?? nativeState[key]);
  }
  const revision = (Number(world.globalNetwork?.revision) || 0) + 1;
  world.globalNetwork = createGlobalNetwork(merged, revision);
  world.activeProjection = null;
  world.projectionOverlay = { type: 'FeatureCollection', features: [] };
  world.projectionWarning = null;
  const imported = Object.fromEntries(ENTITY_KEYS.map((key) => [key, merged[key]?.length ?? 0]));
  imported.replacedRoutes = [...replacementIds].filter((id) => byId(nativeState.routes).has(id));
  imported.networkHash = world.globalNetwork.hash;
  world.networkRecoveries[recoveryId] = imported;
  world.revision = (Number(world.revision) || 0) + 1;
  return { changed: true, imported: clone(imported) };
}
