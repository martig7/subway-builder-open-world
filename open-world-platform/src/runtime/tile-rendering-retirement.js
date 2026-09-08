export const TILE_RENDERING_RETIREMENT_VERSION = 'tile-rendering-retirement-v4';
const PATCH = '__openWorldTileRenderingRetirement';

// Native binary detectors expose closures over every typed-array section of
// their city buffer. A retained old store/detector shell keeps that entire
// buffer alive. These empty methods deliberately close over no retired data.
const EMPTY_BUILDING = Object.freeze({ id: -1, polygon: Object.freeze([]),
  bounds: Object.freeze({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, foundationDepth: 0 }),
  foundationDepth: 0, height: 0, osmIds: Object.freeze([]) });
const RETIRED_BUILDING_METHODS = Object.freeze({
  forEachBuildingInCell() {},
  getBoundsMinX: () => Infinity, getBoundsMinY: () => Infinity,
  getBoundsMaxX: () => -Infinity, getBoundsMaxY: () => -Infinity,
  getFoundationDepth: () => 0, getHeight: () => 0,
  getOsmIds: () => EMPTY_BUILDING.osmIds, getBuilding: () => EMPTY_BUILDING,
});

function clearBuildingDetector(detector, current) {
  if (!detector || detector === current || !Number.isFinite(detector.buildingCount)) return 0;
  const methods = Object.keys(RETIRED_BUILDING_METHODS);
  const fields = [...methods, 'buildingCount', 'cols', 'rows'];
  // Keep unknown/frozen third-party detector implementations untouched.
  if (!methods.every(key => typeof detector[key] === 'function')
    || !fields.every(key => Object.getOwnPropertyDescriptor(detector, key)?.writable)
    || Object.keys(detector).some(key => typeof detector[key] === 'function' && !methods.includes(key))) return 0;
  const count = detector.buildingCount;
  Object.assign(detector, RETIRED_BUILDING_METHODS, { buildingCount: 0, cols: 0, rows: 0 });
  return count;
}

function clearCollection(collection, current) {
  if (!collection || collection === current || collection.features === current?.features) return 0;
  const count = collection.features?.length ?? 0;
  if (Array.isArray(collection.features)) collection.features.length = 0;
  return count;
}

function clearRoadIndex(index, current) {
  if (!index || index === current || index.data === current?.data) return 0;
  const nodes = [index.data];
  let entries = 0;
  while (nodes.length) {
    const node = nodes.pop();
    if (!Array.isArray(node?.children)) continue;
    if (node.leaf) entries += node.children.length;
    else nodes.push(...node.children);
    // Empty the old root too: RBush.clear() alone replaces it, leaving any
    // separately retained root with the complete old index.
    node.children.length = 0;
  }
  index.clear?.();
  return entries;
}

function rendererLayers(deck) {
  const layers = new Set();
  const pending = [deck?.props?.layers, deck?.layerManager?.getLayers?.()];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) { pending.push(...value); continue; }
    if (!value || typeof value !== 'object' || layers.has(value)) continue;
    layers.add(value);
    pending.push(value.internalState?.subLayers);
  }
  return [...layers];
}

function captureRendering(state, map) {
  return {
    roads: state.roadsGeojson,
    index: state.roadsIndex,
    runways: state.runwaysTaxiwaysGeojson,
    buildingDetector: state.buildingDetector,
    map,
    deck: map?.__deck,
    layers: rendererLayers(map?.__deck),
  };
}

/** Drop references only after native teardown has finalized their owners. */
function releaseFinalizedRendering(retired, currentMap, report) {
  if (!retired.map?._removed) return false;
  // The API keeps returning the old map between removal and map-ready.
  const currentDeck = currentMap?._removed ? null : currentMap?.__deck;
  if (retired.deck === currentDeck) return false;
  const active = new Set();
  for (const layer of currentDeck?.layerManager?.getLayers?.() ?? []) {
    active.add(layer); active.add(layer.state); active.add(layer.props?.data);
    for (const attribute of Object.values(layer.internalState?.attributeManager?.attributes ?? {})) active.add(attribute);
  }
  for (const layer of retired.layers) {
    if (active.has(layer) || !String(layer.lifecycle).startsWith('Finalized')) continue;
    if (/road/i.test(layer.id)) {
      const data = layer.props?.data;
      if (!active.has(data)) clearCollection(data, null);
      for (const attribute of Object.values(layer.internalState?.attributeManager?.attributes ?? {})) {
        if (active.has(attribute)) continue;
        report.cpuAttributeBytes += attribute.value?.byteLength ?? 0;
        attribute.value = null;
        if (attribute.state) {
          attribute.state.allocatedValue = null;
          attribute.state.binaryValue = null;
          attribute.state.lastExternalBuffer = null;
        }
      }
      if (layer.state && !active.has(layer.state)) {
        for (const key of ['features', 'featuresDiff', 'binary', 'layerProps', 'tiles']) {
          if (Object.hasOwn(layer.state, key)) layer.state[key] = null;
        }
      }
      layer.props = { id: layer.id, data: [] };
      layer.state = null;
      layer.internalState = null;
      layer.context = null;
      report.roadLayers++;
    }
  }
  // Deck.finalize destroys managers and GPU resources but leaves props.layers.
  // Do not finalize twice or modify live/shared layers and buffers.
  if (retired.deck && !retired.deck.layerManager) {
    retired.deck.props = { ...retired.deck.props, layers: [] };
  }
  retired.layers.length = 0;
  report.rendererReleased = true;
  return true;
}

function makeLoadGuard({ getState, getMap, targetCity, original, onReport, schedule }) {
  let armed = true;
  let retiredEarly = false;
  function cancel() {
    armed = false;
    const current = getState();
    if (current.loadInitialData === guardedTileRenderingLoad) current.loadInitialData = original;
  }
  function guardedTileRenderingLoad(city, ...args) {
    if (!armed) return original.call(this, city, ...args);
    cancel();
    if (city !== targetCity) return original.call(this, city, ...args);
    if (retiredEarly) return original.call(this, city, ...args);
    const retired = captureRendering(getState(), getMap());
    // Native loadInitialData resets the store synchronously before its first
    // fetch/await. Never clear anything if that reset throws or did not occur.
    const result = original.call(this, city, ...args);
    release(retired, getState());
    return result;
  }
  function release(retired, current) {
    const report = { version: TILE_RENDERING_RETIREMENT_VERSION, city: targetCity,
      roads: 0, roadIndexEntries: 0, runways: 0, buildings: 0,
      roadLayers: 0, cpuAttributeBytes: 0, rendererReleased: false, errors: [] };
    const attempt = (stage, fn) => {
      try { fn(); } catch (error) { report.errors.push({ stage, message: String(error?.message ?? error) }); }
    };
    attempt('road-worker', () => {
      const sources = new Set(retired.layers.filter(layer => /road/i.test(layer.id)).map(layer => layer.props?.tileSource).filter(Boolean));
      for (const source of sources) source.dispose?.();
    });
    attempt('roads', () => { report.roads = clearCollection(retired.roads, current.roadsGeojson); });
    attempt('road-index', () => { report.roadIndexEntries = clearRoadIndex(retired.index, current.roadsIndex); });
    attempt('runways', () => { report.runways = clearCollection(retired.runways, current.runwaysTaxiwaysGeojson); });
    attempt('building-detector', () => { report.buildings = clearBuildingDetector(retired.buildingDetector, current.buildingDetector); });
    const finish = () => {
      attempt('finalized-renderer', () => releaseFinalizedRendering(retired, getMap(), report));
      onReport?.({ ...report });
    };
    attempt('remove-listener', () => {
      if (retired.map?._removed) schedule(finish);
      else retired.map?.once?.('remove', () => schedule(finish));
    });
    onReport?.({ ...report });
  }
  function retireBeforeNavigation() {
    if (!armed || retiredEarly) return;
    retiredEarly = true;
    const retired = captureRendering(getState(), getMap());
    // Only called after route validation and a staged native handoff. The old
    // city is now retiring; blank its presentation before new allocations.
    release(retired, {});
  }
  Object.defineProperty(guardedTileRenderingLoad, PATCH, {
    value: { version: TILE_RENDERING_RETIREMENT_VERSION, original, cancel },
  });
  return { wrapper: guardedTileRenderingLoad, cancel, retireBeforeNavigation, get armed() { return armed; } };
}

/** Arm only after the native save handoff has been staged successfully. */
export function armTileRenderingRetirement({ getState, getMap, targetCity, onReport, schedule = queueMicrotask }) {
  const previous = getState().loadInitialData?.[PATCH];
  previous?.cancel();
  const original = previous?.original ?? getState().loadInitialData;
  if (typeof original !== 'function') return { cancel() {}, retireBeforeNavigation() {}, armed: false };
  // The factory's closure must not capture a whole Zustand state snapshot.
  const guard = makeLoadGuard({ getState, getMap, targetCity, original, onReport, schedule });
  getState().loadInitialData = guard.wrapper;
  getState().setTimeConfig?.({});
  return guard;
}
