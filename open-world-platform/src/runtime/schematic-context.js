export const SCHEMATIC_CONTEXT_VERSION = 1;
export const SCHEMATIC_CONTEXT_EVENT = 'subway-builder-open-world-context';

/** A shared registry survives reloads while provider tokens retire old closures. */
export function schematicContextRegistry(root = globalThis) {
  if (root.SubwayBuilderOpenWorld?.version === SCHEMATIC_CONTEXT_VERSION) return root.SubwayBuilderOpenWorld;
  const providers = new Map();
  const listeners = new Set();
  let providerGeneration = 0;
  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { console.warn('[OpenWorld] schematic context listener failed', error); }
    }
    if (typeof root.dispatchEvent === 'function' && typeof root.Event === 'function') {
      root.dispatchEvent(new root.Event(SCHEMATIC_CONTEXT_EVENT));
    }
  };
  const registry = Object.freeze({
    version: SCHEMATIC_CONTEXT_VERSION,
    getContext() {
      for (const id of [...providers.keys()].sort()) {
        const provider = providers.get(id);
        const context = provider.read();
        if (context) return Object.freeze({ ...context, providerGeneration: provider.generation });
      }
      return null;
    },
    loadGeoJSON(providerId, sourceId) {
      return providers.get(providerId)?.loadGeoJSON?.(sourceId) ?? Promise.resolve(null);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    register(providerId, provider) {
      const token = { ...provider, generation: ++providerGeneration };
      providers.set(providerId, token);
      notify();
      return {
        refresh: () => { if (providers.get(providerId) === token) notify(); },
        dispose: () => { if (providers.get(providerId) === token) { providers.delete(providerId); notify(); } },
      };
    },
  });
  root.SubwayBuilderOpenWorld = registry;
  return registry;
}

const validBounds = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)
  && b[0] < b[2] && b[1] < b[3] && b[0] >= -180 && b[2] <= 180 && b[1] >= -85 && b[3] <= 85;

/** Publish source metadata without copying native topology or simulation state. */
export function registerSchematicContext({ definition, tileCatalog, tileUrl, readState, loadVegetation, root = globalThis }) {
  const registry = schematicContextRegistry(root);
  let topologyRevision = 0;
  let epoch = 0;
  let previousSignature = '';
  const bounds = tileCatalog.tiles.map(tile => tile.bounds).filter(validBounds);
  const worldBounds = bounds.length ? Object.freeze([
    Math.min(...bounds.map(b => b[0])), Math.min(...bounds.map(b => b[1])),
    Math.max(...bounds.map(b => b[2])), Math.max(...bounds.map(b => b[3])),
  ]) : null;
  const sources = Object.freeze([
    Object.freeze({ id: 'world-land', type: 'vector', role: 'land', source: Object.freeze({
      type: 'vector', tiles: Object.freeze([tileUrl({ tileId: definition.map.worldContextTileId ?? definition.tileViews.initialTileId })]), minzoom: 0, maxzoom: 9,
    }), layers: Object.freeze(['world_land']), bounds: worldBounds }),
    ...tileCatalog.tiles.filter(tile => validBounds(tile.nativeMapBounds ?? tile.bounds)).map(tile => Object.freeze({
      id: `detail:${tile.id}`, type: 'vector', role: 'detail', bounds: Object.freeze([...(tile.nativeMapBounds ?? tile.bounds)]),
      source: Object.freeze({ type: 'vector', tiles: Object.freeze([tileUrl({ tileId: tile.id })]), minzoom: 10, maxzoom: tileCatalog.maxZoom ?? 15 }),
      layers: Object.freeze(['water', definition.map.nativeParkSourceLayer ?? 'landuse', 'city_labels', 'suburb_labels', 'neighborhood_labels']),
    })),
    ...(loadVegetation ? [Object.freeze({ id: 'world-vegetation', type: 'geojson', role: 'green', bounds: worldBounds })] : []),
  ]);
  const providerId = definition.identity.manifestId;
  const read = () => {
    const state = readState();
    const tile = tileCatalog.tiles.find(tile => (tile.gameCityCode ?? tile.id) === state.cityCode);
    if (!state.owned || !tile || !worldBounds) return null;
    const signature = JSON.stringify([state.sessionId, state.cityCode, state.ready, state.generation, definition.map.basemapRevision]);
    if (signature !== previousSignature) { previousSignature = signature; epoch++; }
    return Object.freeze({
      version: SCHEMATIC_CONTEXT_VERSION, providerId, worldId: definition.identity.worldId,
      tileId: tile.id, cityCode: state.cityCode, sessionId: state.sessionId ?? null,
      ready: Boolean(state.ready), epoch, topologyRevision, coordinateFrame: 'longitude-latitude',
      bearing: Number(definition.map.schematicBearing ?? 0), bounds: Object.freeze([...worldBounds]),
      tileBounds: Object.freeze([...(tile.nativeMapBounds ?? tile.bounds)]),
      basemapRevision: definition.map.basemapRevision, sources,
    });
  };
  const handle = registry.register(providerId, {
    read,
    loadGeoJSON: sourceId => sourceId === 'world-vegetation' ? loadVegetation?.() ?? Promise.resolve(null) : Promise.resolve(null),
  });
  return {
    refresh(networkChanged = false) { if (networkChanged) topologyRevision++; handle.refresh(); },
    dispose: handle.dispose,
  };
}
