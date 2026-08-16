import {
  createRendererVirtualization,
  createStationMarkerVisibilityAdapter,
  virtualizeGeoJsonData,
} from './renderer-virtualization.js';
const EMPTY = Object.freeze({ type: 'FeatureCollection', features: [] });
const BOUNDARY_SOURCE_ID = 'open-world-tile-boundaries-source';
const TILE_BOUNDARY_LAYER_ID = 'open-world-tile-boundaries';
const WORLD_BOUNDARY_LAYER_ID = 'open-world-country-boundaries';
const WORLD_CONTEXT_SOURCE_ID = 'open-world-world-context-source';
const WORLD_LAND_HIGH_ZOOM_LAYER_ID = 'open-world-land-high-zoom';
const WORLD_BOUNDARY_HIGH_ZOOM_LAYER_ID = 'open-world-country-boundaries-high-zoom';
const WORLD_OCEAN_SOURCE_ID = 'open-world-ocean-source';
const WORLD_OCEAN_LAYER_ID = 'open-world-ocean';
// Kept only so a hot reload can remove the obsolete background-layer version.
const WORLD_WATER_BACKGROUND_LAYER_ID = 'open-world-water-background';
const WORLD_LAND_LAYER_ID = 'open-world-land';
const STATION_MARKER_STYLE_ID = 'open-world-station-marker-zoom-style';
const STATION_MARKER_VISIBILITY_KEY = 'openWorldStationMarkers';
const STATION_MARKER_MIN_ZOOM = 10;
const STATION_MARKER_MAX_ZOOM = 16;
const GEOGRAPHIC_CONTEXT_MAX_ZOOM = 24;
const ROAD_LAYER_ID_RE = /(?:^|[-_])(road|roads|highway|highways|street|streets)(?:[-_]|$)/i;
const ROAD_SOURCE_LAYER_RE = /^(?:road|roads|highway|highways|street|streets|transportation)(?:[-_]|$)/i;
const ROAD_LABEL_LAYER_RE = /(?:^|[-_])labels?(?:[-_]|$)/i;
// The native game renders its roads as Deck GeoJsonLayers, not as MapLibre
// style layers. Keep this tied to the bundle's stable layer-id families so
// the low-zoom gate cannot accidentally hide rail or route layers.
const ROAD_DECK_LAYER_ID_RE = /^road-(?:lines-|bridge-(?:casing|fill)-)/i;
const NON_ROAD_LAYER_RE = /(?:^|[-_])(rail|railway|track|transit|station|route|metro|tram|subway)(?:[-_]|$)/i;
const MOVEMENT_LAYER_PREFIXES = Object.freeze([
  'trains',
  'pop-movements-deck',
]);
const SPATIAL_SOURCE_IDS = Object.freeze([
  // Subway Builder materializes station/track snapping nodes in this
  // MapLibre GeoJSON source rather than in the Deck layer tree.
  'all-nodes-source',
]);
const MOVEMENT_DECK_GUARD_KEY = '__openWorldMovementDeckVisibilityGuard';
const SPATIAL_SOURCE_GUARD_KEY = '__openWorldSpatialSourceVisibilityGuard';
const RAIL_CLIP_DIAGNOSTIC_VERSION = 'zoom-fast-path-v5';
const RAIL_CLIP_DEBUG_FLAG = '__OPEN_WORLD_RAIL_CLIP_DEBUG';
const RAIL_CLIP_DEBUG_STATE = '__OPEN_WORLD_RAIL_CLIP_DEBUG_STATE';
const RAIL_CLIP_DEBUG_PREFIX = '[DEBUG-railclip]';
const TOOLBOX_RENDER_DEBUG_FLAG = '__OPEN_WORLD_TOOLBOX_RENDER_DEBUG';
const TOOLBOX_RENDER_DEBUG_STATE = '__OPEN_WORLD_TOOLBOX_RENDER_DEBUG_STATE';
const TOOLBOX_RENDER_DEBUG_VERSION = 'toolbox-render-v1';
const TOOLBOX_RENDER_DEBUG_PREFIX = '[DEBUG-toolbox-render-v1]';
const TOOLBOX_RENDER_DEBUG_RE = /all-nodes|station|stnode|route|train|connection|warning|track|node|preview|platform|pop-movements|signal|road|highway|street/i;
const STATION_MARKER_CONTENT_SELECTOR = [
  '.maplibregl-marker > .flex.items-center.translate-x-1\\/2.relative',
  '.mapboxgl-marker > .flex.items-center.translate-x-1\\/2.relative',
].join(', ');
const SELECTED_TRAIN_MARKER_SELECTOR = [
  '.maplibregl-marker > .flex.flex-col.items-center.cursor-pointer.animate-in.fade-in.zoom-in.duration-300',
  '.mapboxgl-marker > .flex.flex-col.items-center.cursor-pointer.animate-in.fade-in.zoom-in.duration-300',
].join(', ');
const HIDDEN_DETAIL_MARKER_SELECTOR = [
  STATION_MARKER_CONTENT_SELECTOR,
  SELECTED_TRAIN_MARKER_SELECTOR,
].join(', ');
const STATION_MARKER_CSS = `
[data-open-world-station-markers="hidden"] ${HIDDEN_DETAIL_MARKER_SELECTOR.replaceAll(', ', ',\n[data-open-world-station-markers="hidden"] ')} {
  display: none !important;
}`;
const WORLD_OCEAN = Object.freeze({
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-180, -85.05112878],
        [180, -85.05112878],
        [180, 85.05112878],
        [-180, 85.05112878],
        [-180, -85.05112878],
      ]],
    },
  }],
});

function railClipDebugEnabled() {
  return globalThis[RAIL_CLIP_DEBUG_FLAG] === true;
}

function railClipDebugState() {
  const existing = globalThis[RAIL_CLIP_DEBUG_STATE];
  if (!existing || existing.version !== RAIL_CLIP_DIAGNOSTIC_VERSION) {
    globalThis[RAIL_CLIP_DEBUG_STATE] = {
      version: RAIL_CLIP_DIAGNOSTIC_VERSION,
      setPropsCalls: 0,
      attachCalls: 0,
      events: [],
      lastByKey: {},
    };
  }
  return globalThis[RAIL_CLIP_DEBUG_STATE];
}

function railClipDebugLog(event, details = {}, { key = event, every = 30, first = 5 } = {}) {
  if (!railClipDebugEnabled()) return;
  const state = railClipDebugState();
  const count = (state.lastByKey[key] ?? 0) + 1;
  state.lastByKey[key] = count;
  if (count > first && count % every !== 0) return;
  const resolvedDetails = typeof details === 'function' ? details() : details;
  const entry = { at: Date.now(), event, count, ...resolvedDetails };
  state.events.push(entry);
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
  console.info(RAIL_CLIP_DEBUG_PREFIX, event, entry);
}

function toolboxRenderDebugEnabled() {
  return globalThis[TOOLBOX_RENDER_DEBUG_FLAG] === true;
}

function toolboxRenderDebugState() {
  const existing = globalThis[TOOLBOX_RENDER_DEBUG_STATE];
  if (!existing || existing.version !== TOOLBOX_RENDER_DEBUG_VERSION) {
    globalThis[TOOLBOX_RENDER_DEBUG_STATE] = {
      version: TOOLBOX_RENDER_DEBUG_VERSION,
      events: [],
      lastByKey: {},
    };
  }
  return globalThis[TOOLBOX_RENDER_DEBUG_STATE];
}

function toolboxRenderDebugLog(event, details = {}, { key = event, every = 1, first = 20 } = {}) {
  if (!toolboxRenderDebugEnabled()) return;
  const state = toolboxRenderDebugState();
  const count = (state.lastByKey[key] ?? 0) + 1;
  state.lastByKey[key] = count;
  if (count > first && count % every !== 0) return;
  const resolvedDetails = typeof details === 'function' ? details() : details;
  const entry = { at: Date.now(), event, count, ...resolvedDetails };
  state.events.push(entry);
  if (state.events.length > 300) state.events.splice(0, state.events.length - 300);
  console.info(TOOLBOX_RENDER_DEBUG_PREFIX, event, entry);
}

const toolboxDebugObjectIds = new WeakMap();
let nextToolboxDebugObjectId = 1;

function toolboxRenderObjectId(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  if (!toolboxDebugObjectIds.has(value)) toolboxDebugObjectIds.set(value, nextToolboxDebugObjectId++);
  return toolboxDebugObjectIds.get(value);
}

function toolboxRenderFeatureCount(data) {
  if (Array.isArray(data)) return data.length;
  if (Array.isArray(data?.features)) return data.features.length;
  return null;
}

function toolboxRenderCoordinatePoint(value, fromEnd = false) {
  let current = value;
  while (Array.isArray(current) && Array.isArray(current[0])) {
    current = fromEnd ? current.at(-1) : current[0];
  }
  return Array.isArray(current) && current.length <= 3 && current.every(Number.isFinite)
    ? [...current]
    : null;
}

function toolboxRenderFeatureSample(data) {
  const feature = Array.isArray(data) ? data[0] : data?.features?.[0];
  if (!feature || typeof feature !== 'object') return null;
  const geometry = feature.geometry ?? feature;
  const coordinates = geometry?.coordinates ?? feature.coords ?? feature.path ?? null;
  return {
    keys: Object.keys(feature).slice(0, 12),
    properties: feature.properties ? Object.keys(feature.properties).slice(0, 12) : [],
    geometryType: geometry?.type ?? null,
    firstCoordinate: toolboxRenderCoordinatePoint(coordinates),
    lastCoordinate: toolboxRenderCoordinatePoint(coordinates, true),
  };
}

function toolboxRenderMarkerCollection(map) {
  const nativeMap = map?.getMap?.() ?? map;
  const candidates = nativeMap?._markers ?? nativeMap?.markers ?? nativeMap?._markerManager?.markers;
  return candidates instanceof Map ? [...candidates.values()]
    : candidates instanceof Set ? [...candidates]
      : Array.isArray(candidates) ? candidates : [];
}

function toolboxRenderMarkerSummary(map, virtualization) {
  const markers = toolboxRenderMarkerCollection(map);
  const markerSamples = [];
  let outsideHaloCount = 0;
  let hiddenCount = 0;
  for (const marker of markers) {
    const element = marker?.getElement?.();
    const position = marker?.getLngLat?.();
    const point = position ? [position.lng, position.lat] : null;
    const outsideHalo = Boolean(point && virtualization && !virtualization.contains(point));
    if (outsideHalo) outsideHaloCount += 1;
    if (element?.style?.display === 'none' || element?.style?.visibility === 'hidden') hiddenCount += 1;
    if (markerSamples.length < 12) {
      markerSamples.push({
        objectId: toolboxRenderObjectId(marker),
        point,
        outsideHalo,
        display: element?.style?.display ?? null,
        visibility: element?.style?.visibility ?? null,
        className: typeof element?.className === 'string' ? element.className : null,
        parentClassName: typeof element?.parentElement?.className === 'string'
          ? element.parentElement.className : null,
        dataset: element?.dataset ? { ...element.dataset } : null,
      });
    }
  }
  const container = map?.getCanvasContainer?.() ?? map?.getContainer?.();
  const domMarkers = container?.querySelectorAll?.('.maplibregl-marker, .mapboxgl-marker') ?? [];
  const domSpatialHiddenCount = [...domMarkers]
    .filter((element) => element?.dataset?.openWorldSpatialMarker === 'hidden')
    .length;
  const domSpatialVisibleCount = [...domMarkers]
    .filter((element) => element?.dataset?.openWorldSpatialMarker === 'visible')
    .length;
  return {
    nativeMarkerCount: markers.length,
    outsideHaloCount,
    nativeHiddenCount: hiddenCount,
    hiddenCount: hiddenCount + domSpatialHiddenCount,
    domMarkerCount: domMarkers.length,
    domSpatialHiddenCount,
    domSpatialVisibleCount,
    domMarkerClassNames: [...domMarkers].slice(0, 12).map((element) => ({
      className: typeof element.className === 'string' ? element.className : null,
      display: element.style?.display ?? null,
      visibility: element.style?.visibility ?? null,
      spatial: element.dataset?.openWorldSpatialMarker ?? null,
    })),
    samples: markerSamples,
  };
}

function toolboxRenderMapSnapshot(map, virtualization) {
  const style = map?.getStyle?.() ?? {};
  const sources = Object.entries(style.sources ?? {})
    .filter(([id]) => TOOLBOX_RENDER_DEBUG_RE.test(id))
    .map(([id]) => {
      const source = map?.getSource?.(id);
      const data = source?._data ?? source?.data;
      const patch = map?.[SPATIAL_SOURCE_GUARD_KEY]?.patches?.get?.(id);
      return {
        id,
        sourceObjectId: toolboxRenderObjectId(source),
        dataCount: toolboxRenderFeatureCount(data),
        dataSample: toolboxRenderFeatureSample(data),
        setDataGuarded: Boolean(patch && source?.setData === patch.wrapper),
        setDataCalls: patch?.calls ?? 0,
      };
    });
  const layers = (style.layers ?? [])
    .filter((layer) => TOOLBOX_RENDER_DEBUG_RE.test(layer.id) || TOOLBOX_RENDER_DEBUG_RE.test(layer.source))
    .map((layer) => ({
      id: layer.id,
      type: layer.type ?? null,
      source: layer.source ?? null,
      visibility: layer.layout?.visibility ?? 'visible',
      minzoom: layer.minzoom ?? null,
      maxzoom: layer.maxzoom ?? null,
    }));
  const deck = map?.__deck;
  const deckLayers = Array.isArray(deck?.props?.layers)
    ? deck.props.layers
      .map((layer) => {
        const id = layer?.id ?? layer?.props?.id ?? null;
        if (!TOOLBOX_RENDER_DEBUG_RE.test(String(id))) return null;
        const data = layer?.props?.data ?? layer?.data;
        return {
          id,
          constructor: layer?.constructor?.name ?? null,
          dataCount: toolboxRenderFeatureCount(data),
          dataSample: toolboxRenderFeatureSample(data),
          visible: layer?.props?.visible ?? layer?.visible ?? true,
        };
      })
      .filter(Boolean)
    : null;
  return {
    mapObjectId: toolboxRenderObjectId(map),
    deckObjectId: toolboxRenderObjectId(deck),
    activeTileId: virtualization?.activeTileId ?? null,
    haloTileIds: virtualization?.haloTileIds ?? [],
    haloBounds: virtualization?.haloBounds ?? [],
    sources,
    layers,
    deckLayers,
    markers: toolboxRenderMarkerSummary(map, virtualization),
  };
}

function installToolboxRenderDebugApi() {
  if (typeof globalThis.__enableOpenWorldToolboxRenderDebug !== 'function') {
    globalThis.__enableOpenWorldToolboxRenderDebug = (enabled = true) => {
      globalThis[TOOLBOX_RENDER_DEBUG_FLAG] = enabled === true;
      console.info(TOOLBOX_RENDER_DEBUG_PREFIX, 'toggle', { enabled: globalThis[TOOLBOX_RENDER_DEBUG_FLAG] });
      return globalThis[TOOLBOX_RENDER_DEBUG_FLAG];
    };
  }
  if (typeof globalThis.__printOpenWorldToolboxRenderDiagnostic !== 'function') {
    globalThis.__printOpenWorldToolboxRenderDiagnostic = () => {
      const map = globalThis.__openWorldToolboxRenderMap;
      const diagnostic = toolboxRenderMapSnapshot(map, globalThis.__openWorldToolboxRenderVirtualization);
      globalThis.__openWorldToolboxRenderDiagnostic = diagnostic;
      console.info(TOOLBOX_RENDER_DEBUG_PREFIX, 'diagnostic', diagnostic);
      return diagnostic;
    };
  }
}

installToolboxRenderDebugApi();

function railClipLayerLike(id) {
  return /rail|track|route|network/i.test(String(id ?? ''));
}

function railClipGeometrySample(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['coords', 'path', 'line', 'centerLine', 'trackPath', 'coordinates']) {
    const candidate = value[key];
    if (!Array.isArray(candidate)) continue;
    return {
      key,
      shape: candidate.length && Array.isArray(candidate[0]) ? 'line' : 'point',
      first: candidate[0] ?? null,
      last: candidate.at(-1) ?? null,
    };
  }
  return null;
}

function railClipNestedValueSummary(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      firstKeys: value[0] && typeof value[0] === 'object'
        ? Object.keys(value[0]).slice(0, 12)
        : [],
      firstGeometry: railClipGeometrySample(value[0]),
    };
  }
  if (typeof value !== 'object') return { type: typeof value };
  return {
    type: value.constructor?.name ?? 'object',
    keys: Object.keys(value).slice(0, 20),
    length: Number.isFinite(value.length) ? value.length : null,
  };
}

function railClipNestedStateSummary(layer) {
  const summary = {};
  for (const owner of ['internalState', 'state']) {
    const value = layer?.[owner];
    if (!value || typeof value !== 'object') continue;
    const candidateKeys = Object.keys(value)
      .filter((key) => /data|path|line|geometry|attribute|feature|layerProps|props|binary/i.test(key))
      .slice(0, 20);
    summary[owner] = {
      keys: Object.keys(value).slice(0, 24),
      candidates: Object.fromEntries(candidateKeys.map((key) => [
        key,
        railClipNestedValueSummary(value[key]),
      ])),
    };
  }
  return summary;
}

function railClipLayerSummary(layer) {
  const data = layerData(layer);
  return {
    id: layer?.id ?? layer?.props?.id ?? null,
    dataKey: data?.[0] ?? null,
    dataCount: data?.[1]?.length ?? null,
    firstKeys: data?.[1]?.[0] && typeof data[1][0] === 'object'
      ? Object.keys(data[1][0]).slice(0, 12)
      : [],
    firstGeometry: railClipGeometrySample(data?.[1]?.[0]),
    nestedState: railClipNestedStateSummary(layer),
  };
}

function railClipRuntimeLayerSummary(layer) {
  const data = layerData(layer);
  const internalState = layer?.internalState;
  const state = layer?.state;
  return {
    ...railClipLayerSummary(layer),
    constructor: layer?.constructor?.name ?? null,
    count: Number.isFinite(layer?.count) ? layer.count : null,
    hasPropsData: Array.isArray(layer?.props?.data),
    hasLayerData: Array.isArray(layer?.data),
    internalStateType: internalState == null ? null : typeof internalState,
    internalStateKeys: internalState && typeof internalState === 'object'
      ? Object.keys(internalState).slice(0, 24)
      : [],
    stateType: state == null ? null : typeof state,
    stateKeys: state && typeof state === 'object'
      ? Object.keys(state).slice(0, 24)
      : [],
    dataCount: data?.[1]?.length ?? null,
  };
}

function railClipDeckRuntimeLayers(deck) {
  const manager = deck?.layerManager;
  let layers = null;
  try {
    layers = typeof manager?.getLayers === 'function'
      ? manager.getLayers()
      : manager?.layers;
  } catch (error) {
    return {
      managerKeys: manager && typeof manager === 'object' ? Object.keys(manager).slice(0, 24) : [],
      error: String(error?.message ?? error),
      layers: null,
    };
  }
  return {
    managerKeys: manager && typeof manager === 'object' ? Object.keys(manager).slice(0, 24) : [],
    layers: Array.isArray(layers)
      ? layers.filter((layer) => railClipLayerLike(layer?.id ?? layer?.props?.id))
        .map(railClipRuntimeLayerSummary)
      : { type: typeof layers },
  };
}

function installRailClipDebugApi() {
  if (typeof globalThis.__enableOpenWorldRailClipDebug !== 'function') {
    globalThis.__enableOpenWorldRailClipDebug = (enabled = true) => {
      globalThis[RAIL_CLIP_DEBUG_FLAG] = enabled === true;
      console.info(RAIL_CLIP_DEBUG_PREFIX, 'toggle', { enabled: globalThis[RAIL_CLIP_DEBUG_FLAG] });
      return globalThis[RAIL_CLIP_DEBUG_FLAG];
    };
  }
  if (typeof globalThis.__printOpenWorldRailClipDiagnostic !== 'function') {
    globalThis.__printOpenWorldRailClipDiagnostic = () => {
      const diagnostic = railClipDebugState();
      console.info(RAIL_CLIP_DEBUG_PREFIX, 'diagnostic', diagnostic);
      return diagnostic;
    };
  }
}

installRailClipDebugApi();

function ringFor(tile) {
  if (Array.isArray(tile.boundary) && tile.boundary.length >= 4) return tile.boundary;
  const [west, south, east, north] = tile.bounds ?? [];
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return [[west, south], [east, south], [east, north], [west, north], [west, south]];
}

export function tileBoundaryGeoJson(catalog, activeTileId = null) {
  return {
    type: 'FeatureCollection',
    features: (catalog?.tiles ?? []).flatMap((tile) => {
      const ring = ringFor(tile);
      if (!ring) return [];
      return [{
        type: 'Feature',
        properties: {
          tileId: tile.id,
          name: tile.name ?? tile.id,
          active: tile.id === activeTileId,
        },
        geometry: { type: 'Polygon', coordinates: [ring] },
      }];
    }),
  };
}

export function mapLayerDiagnostic(map) {
  const style = map?.getStyle?.() ?? {};
  const container = map?.getContainer?.();
  const layers = (style.layers ?? []).map((layer, index) => ({
    index,
    id: layer.id,
    type: layer.type ?? '',
    source: layer.source ?? '',
    sourceLayer: layer['source-layer'] ?? '',
    minzoom: Number.isFinite(layer.minzoom) ? layer.minzoom : '',
    maxzoom: Number.isFinite(layer.maxzoom) ? layer.maxzoom : '',
    visibility: layer.layout?.visibility ?? 'visible',
    color: layer.paint?.['fill-color'] ?? layer.paint?.['background-color'] ?? '',
    opacity: layer.paint?.['fill-opacity'] ?? layer.paint?.['background-opacity'] ?? '',
  }));
  const sources = Object.entries(style.sources ?? {}).map(([id, source]) => ({
    id,
    type: source?.type ?? '',
    url: source?.url ?? '',
    minzoom: Number.isFinite(source?.minzoom) ? source.minzoom : '',
    maxzoom: Number.isFinite(source?.maxzoom) ? source.maxzoom : '',
    present: Boolean(map?.getSource?.(id)),
  }));
  const indexOf = (id) => layers.findIndex((layer) => layer.id === id);
  const movementLayers = layers.filter((layer) => isMovementLayerId(layer.id));
  return {
    capturedAt: Date.now(),
    styleLoaded: Boolean(map?.isStyleLoaded?.()),
    zoom: map?.getZoom?.() ?? null,
    layerCount: layers.length,
    sourceCount: sources.length,
    stationMarkers: {
      visibilityState: container?.dataset?.[STATION_MARKER_VISIBILITY_KEY] ?? null,
      domMatches: container?.querySelectorAll?.(STATION_MARKER_CONTENT_SELECTOR)?.length ?? 0,
      minZoom: STATION_MARKER_MIN_ZOOM,
      maxZoomExclusive: STATION_MARKER_MAX_ZOOM,
    },
    movementLayers: {
      maplibreZoomRangeInstalled: movementLayers.length > 0 && movementLayers.every(
        (layer) => layer.minzoom === STATION_MARKER_MIN_ZOOM
          && layer.maxzoom === STATION_MARKER_MAX_ZOOM,
      ),
      visibleAtCurrentZoom: isDetailedMovementZoom(map?.getZoom?.()),
      layerIds: movementLayers.map((layer) => layer.id),
      minZoom: STATION_MARKER_MIN_ZOOM,
      maxZoomExclusive: STATION_MARKER_MAX_ZOOM,
    },
    ocean: {
      sourcePresent: Boolean(map?.getSource?.(WORLD_OCEAN_SOURCE_ID)),
      layerPresent: Boolean(map?.getLayer?.(WORLD_OCEAN_LAYER_ID)),
      nativeBackgroundIndex: layers.findIndex((layer) => layer.type === 'background'),
      layerIndex: indexOf(WORLD_OCEAN_LAYER_ID),
      landLayerIndex: indexOf(WORLD_LAND_LAYER_ID),
      nativeWaterIndices: layers
        .filter((layer) => layer.id === 'water' || layer.sourceLayer === 'water')
        .map((layer) => layer.index),
    },
    layers,
    sources,
  };
}

function printMapLayerDiagnostic(map, reason = 'manual') {
  if (!map || typeof map.getCanvas !== 'function') return null;
  const diagnostic = mapLayerDiagnostic(map);
  diagnostic.reason = reason;
  globalThis.__openWorldMapLayerDiagnostic = diagnostic;
  console.groupCollapsed?.(`[OpenWorld] map layers (${reason})`);
  console.info('[OpenWorld] ocean summary', diagnostic.ocean);
  console.table?.(diagnostic.layers);
  console.table?.(diagnostic.sources);
  console.groupEnd?.();
  return diagnostic;
}

function ensureStationMarkerStyle(doc = globalThis.document) {
  if (!doc?.head || typeof doc.createElement !== 'function') return;
  let style = doc.getElementById?.(STATION_MARKER_STYLE_ID);
  if (!style) {
    style = doc.createElement('style');
    style.id = STATION_MARKER_STYLE_ID;
    doc.head.appendChild(style);
  }
  if (style.textContent !== STATION_MARKER_CSS) style.textContent = STATION_MARKER_CSS;
}

function updateStationMarkerVisibility(map) {
  const container = map?.getContainer?.();
  const zoom = map?.getZoom?.();
  if (!container?.dataset || !Number.isFinite(zoom)) return;
  const visibility = (
    zoom >= STATION_MARKER_MIN_ZOOM && zoom < STATION_MARKER_MAX_ZOOM
  ) ? 'visible' : 'hidden';
  if (container.dataset[STATION_MARKER_VISIBILITY_KEY] !== visibility) {
    container.dataset[STATION_MARKER_VISIBILITY_KEY] = visibility;
  }
}

function isDetailedMovementZoom(zoom) {
  return Number.isFinite(zoom)
    && zoom >= STATION_MARKER_MIN_ZOOM
    && zoom < STATION_MARKER_MAX_ZOOM;
}

function isMovementLayerId(id) {
  if (typeof id !== 'string') return false;
  return MOVEMENT_LAYER_PREFIXES.some((prefix) => id === prefix || id.startsWith(`${prefix}-`));
}

function isRoadDeckLayerId(id) {
  return typeof id === 'string' && ROAD_DECK_LAYER_ID_RE.test(id);
}

function isNativeRoadLayer(layer) {
  const id = String(layer?.id ?? '');
  const sourceLayer = String(layer?.['source-layer'] ?? '');
  // RoadLabelsLayer owns a separate MapLibre symbol layer and intentionally
  // starts at 15.75 in the native bundle. Do not widen that label window when
  // applying the low-zoom geometry rule.
  if (ROAD_LABEL_LAYER_RE.test(id) || ROAD_LABEL_LAYER_RE.test(sourceLayer)) return false;
  if (NON_ROAD_LAYER_RE.test(id) || NON_ROAD_LAYER_RE.test(sourceLayer)) return false;
  return ROAD_LAYER_ID_RE.test(id) || ROAD_SOURCE_LAYER_RE.test(sourceLayer);
}

function applyRoadLayerZoomRanges(map) {
  if (typeof map?.setLayerZoomRange !== 'function') return [];
  const roadLayers = (map.getStyle?.()?.layers ?? []).filter(isNativeRoadLayer);
  for (const layer of roadLayers) {
    if (layer.minzoom === STATION_MARKER_MIN_ZOOM && layer.maxzoom === GEOGRAPHIC_CONTEXT_MAX_ZOOM) continue;
    try {
      map.setLayerZoomRange(
        layer.id,
        STATION_MARKER_MIN_ZOOM,
        GEOGRAPHIC_CONTEXT_MAX_ZOOM,
      );
    } catch {}
  }
  return roadLayers.map((layer) => layer.id);
}

function applyMovementLayerZoomRanges(map) {
  if (typeof map?.setLayerZoomRange !== 'function') return [];
  const layers = map.getStyle?.()?.layers ?? [];
  const movementLayers = layers.filter((layer) => isMovementLayerId(layer.id));
  for (const layer of movementLayers) {
    if (
      layer.minzoom === STATION_MARKER_MIN_ZOOM
      && layer.maxzoom === STATION_MARKER_MAX_ZOOM
    ) continue;
    try {
      map.setLayerZoomRange(
        layer.id,
        STATION_MARKER_MIN_ZOOM,
        STATION_MARKER_MAX_ZOOM,
      );
    } catch {}
  }
  return movementLayers.map((layer) => layer.id);
}

function virtualizationSignature(virtualization) {
  return virtualization
    ? `${virtualization.activeTileId ?? ''}|${(virtualization.haloTileIds ?? []).join(',')}`
    : 'none';
}

function layerData(layer) {
  const entryFor = (shape, value) => {
    if (Array.isArray(value)) return [shape, value];
    if (Array.isArray(value?.features)) {
      return [`${shape}-feature-collection`, value.features, value];
    }
    return null;
  };
  const propsData = layer?.props?.data;
  const directEntries = [
    ['props', propsData],
    ['layer', layer?.data],
    ['state-features', layer?.state?.features],
    ['state-data', layer?.state?.data],
    ['state-layer-props', layer?.state?.layerProps],
    ['internal-state-features', layer?.internalState?.features],
    ['internal-state-data', layer?.internalState?.data],
    ['internal-state-layer-props', layer?.internalState?.layerProps],
    ['internal-state-old-props', layer?.internalState?.oldProps],
    ['internal-state-old-async-props', layer?.internalState?.oldAsyncProps],
    ['component-props', layer?.internalState?.component?.props],
    ['parent-props', layer?.parent?.props],
  ];
  for (const [shape, value] of directEntries) {
    const entry = entryFor(shape, value);
    if (entry) return entry;
  }

  // Some CompositeLayer versions keep the source one level deeper under
  // state.layerProps/oldProps. Follow only known data-bearing keys so this
  // cannot walk arbitrary Deck internals or create a recursive traversal.
  const nestedEntries = [
    ['state-layer-props-data', layer?.state?.layerProps?.data],
    ['state-layer-props-features', layer?.state?.layerProps?.features],
    ['internal-state-layer-props-data', layer?.internalState?.layerProps?.data],
    ['internal-state-layer-props-features', layer?.internalState?.layerProps?.features],
    ['internal-state-old-props-data', layer?.internalState?.oldProps?.data],
    ['internal-state-old-props-features', layer?.internalState?.oldProps?.features],
    ['internal-state-old-async-props-data', layer?.internalState?.oldAsyncProps?.data],
    ['internal-state-old-async-props-features', layer?.internalState?.oldAsyncProps?.features],
  ];
  for (const [shape, value] of nestedEntries) {
    const entry = entryFor(shape, value);
    if (entry) return entry;
  }
  return null;
}

function cloneLayerWithOverrides(layer, overrides) {
  if (typeof layer?.clone === 'function') return layer.clone(overrides);
  if (layer?.props && typeof layer.props === 'object') {
    return { ...layer, props: { ...layer.props, ...overrides } };
  }
  return { ...layer, ...overrides };
}

function stableRenderValueEqual(left, right) {
  if (left === right) return true;
  if (typeof left === 'function' || typeof right === 'function') {
    return typeof left === 'function' && typeof right === 'function';
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => stableRenderValueEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key)
      && stableRenderValueEqual(left[key], right[key]));
}

function reusableDeckLayer(layer) {
  // A masked Layer can be reused when it has a clone/props surface.  Event
  // and accessor identity is checked by sameDeckRenderProps below; rejecting
  // every interactive layer here forced the already-materialized rail
  // sublayers through a full clone on every simulation frame.
  return typeof layer?.clone === 'function'
    || Boolean(layer?.props && typeof layer.props === 'object');
}

function sameDeckRenderProps(previous, current) {
  const previousProps = previous?.props ?? {};
  const currentProps = current?.props ?? {};
  for (const key of [
    'visible', 'beforeId', 'pickable', 'stroked', 'filled', 'extruded',
    'lineWidthUnits', 'lineWidthMinPixels', 'lineCapRounded', 'lineMiterLimit',
    'onHover', 'onClick', 'getLineColor', 'getLineWidth', 'getPath',
    'getPosition', 'getRadius', 'getColor', 'getFillColor', 'getElevation',
  ]) {
    if (previousProps[key] !== currentProps[key]) return false;
  }
  return stableRenderValueEqual(previousProps.updateTriggers, currentProps.updateTriggers);
}

function sameNativeLayerValue(previous, current) {
  if (previous === current) return true;
  if (Array.isArray(previous) || Array.isArray(current)) {
    return Array.isArray(previous)
      && Array.isArray(current)
      && previous.length === current.length
      && previous.every((value, index) => sameNativeLayerValue(value, current[index]));
  }
  if (!previous || !current || typeof previous !== 'object' || typeof current !== 'object') return false;
  const previousId = previous.id ?? previous.props?.id ?? null;
  const currentId = current.id ?? current.props?.id ?? null;
  if (previousId !== currentId || previous.count !== current.count) return false;
  const previousData = layerData(previous);
  const currentData = layerData(current);
  if (Boolean(previousData) !== Boolean(currentData)) return false;
  // A materialized layer with no discoverable source may have changed its
  // binary buffers, so only fast-path layers whose source identity is known.
  if (!previousData || !currentData) return false;
  if (previousData[0] !== currentData[0] || previousData[1] !== currentData[1]) return false;
  return sameDeckRenderProps(previous, current);
}

function sameNativeLayerTree(previous, current) {
  return sameNativeLayerValue(previous, current);
}

function layerMaskSignature(layerId, zoom, virtualization) {
  const detailVisibility = isMovementLayerId(layerId) || isRoadDeckLayerId(layerId)
    ? `|${isDetailedMovementZoom(zoom)}`
    : '';
  return `${virtualizationSignature(virtualization)}${detailVisibility}`;
}

function maskMovementDeckLayers(
  layers,
  zoom,
  virtualization,
  spatialCache = null,
  layerCache = null,
) {
  if (Array.isArray(layers)) {
    return layers.map((layer) => maskMovementDeckLayers(
      layer,
      zoom,
      virtualization,
      spatialCache,
      layerCache,
    ));
  }
  if (!layers || typeof layers !== 'object') return layers;
  const layerId = layers?.id ?? layers?.props?.id ?? null;
  const isMovement = isMovementLayerId(layerId);
  const isRoad = isRoadDeckLayerId(layerId);
  if (!isMovement && !virtualization) return layers;
  const overrides = {};
  const dataEntry = layerData(layers);
  const [, source] = dataEntry ?? [];
  const maskSignature = virtualization
    ? layerMaskSignature(layerId, zoom, virtualization)
    : null;
  const cachedLayer = layerCache?.get(layerId);
  if (
    dataEntry
    && virtualization
    && reusableDeckLayer(layers)
    && cachedLayer?.source === source
    && cachedLayer.signature === maskSignature
    && sameDeckRenderProps(cachedLayer.inputLayer, layers)
  ) {
    railClipDebugLog('rail-layer-reuse', () => ({
      layerId,
      dataShape: dataEntry[0],
      sourceCount: source.length,
    }), { key: `reuse:${layerId}`, every: 60 });
    return cachedLayer.layer;
  }
  if (railClipDebugEnabled() && railClipLayerLike(layerId) && !dataEntry) {
    railClipDebugLog('rail-layer-no-array-data', () => ({
      layerId,
      layerKeys: Object.keys(layers).slice(0, 16),
      propKeys: Object.keys(layers?.props ?? {}).slice(0, 16),
      nestedState: railClipNestedStateSummary(layers),
      hasVirtualization: Boolean(virtualization),
    }), { key: `no-data:${layerId}`, every: 60 });
  }
  if (dataEntry && virtualization) {
    const [dataShape, source, sourceContainer] = dataEntry;
    const signature = virtualizationSignature(virtualization);
    const cached = spatialCache?.get(source);
    const cacheHit = cached?.signature === signature;
    const filtered = cacheHit
      ? cached.data
      : virtualization.renderInputs({ features: source }, { clip: true }).features;
    const renderedData = cacheHit
      ? cached.renderedData
      : dataShape.endsWith('feature-collection')
        ? { ...sourceContainer, features: filtered }
        : filtered;
    spatialCache?.set(source, {
      signature,
      data: filtered,
      renderedData,
    });
    overrides.data = renderedData;
    if (railClipDebugEnabled() && railClipLayerLike(layerId)) {
      railClipDebugLog(
        cacheHit ? 'rail-layer-cache-hit' : 'rail-layer-filter',
        () => ({
          layerId,
          dataShape,
          cacheHit,
          sourceCount: source.length,
          outputCount: filtered.length,
          virtualization: {
            activeTileId: virtualization.activeTileId,
            haloTileIds: virtualization.haloTileIds,
            haloBounds: virtualization.haloBounds?.length ?? 0,
          },
          sourceSample: cacheHit ? null : railClipGeometrySample(source[0]),
          outputSample: cacheHit ? null : railClipGeometrySample(filtered[0]),
        }),
        { key: `${cacheHit ? 'cache-hit' : 'filter'}:${layerId}`, every: 60 },
      );
    }
  }
  if (isMovement) {
    const nativeVisible = layers.props?.visible !== false;
    overrides.visible = nativeVisible && isDetailedMovementZoom(zoom);
  }
  if (isRoad) {
    const nativeVisible = layers.props?.visible !== false;
    // Station dots use a parent visibility gate rather than rebuilding their
    // marker tree on every camera update. Apply the equivalent gate to the
    // game's Deck road layers and let the existing signature cache skip
    // fractional-zoom updates within the same band.
    overrides.visible = nativeVisible && isDetailedMovementZoom(zoom);
  }
  const maskedLayer = Object.keys(overrides).length ? cloneLayerWithOverrides(layers, overrides) : layers;
  if (
    dataEntry
    && virtualization
    && layerCache
    && layerId != null
    && reusableDeckLayer(layers)
  ) {
    layerCache.set(layerId, {
      source,
      signature: maskSignature,
      inputLayer: layers,
      layer: maskedLayer,
    });
  }
  return maskedLayer;
}

function spatialSourceState(map) {
  let state = map?.[SPATIAL_SOURCE_GUARD_KEY];
  if (!state) {
    state = { patches: new Map() };
    try {
      Object.defineProperty(map, SPATIAL_SOURCE_GUARD_KEY, { value: state, configurable: true });
    } catch {}
  }
  return state;
}

function installSpatialSourceVisibilityGuards(map, virtualizationProvider) {
  if (!map) return null;
  const state = spatialSourceState(map);
  for (const sourceId of SPATIAL_SOURCE_IDS) {
    const source = map.getSource?.(sourceId);
    if (!source || typeof source.setData !== 'function') {
      toolboxRenderDebugLog('spatial-source-missing', {
        sourceId,
        mapObjectId: toolboxRenderObjectId(map),
      }, { key: `spatial-source-missing:${sourceId}`, every: 10, first: 10 });
      continue;
    }
    let patch = state.patches.get(sourceId);
    if (!patch || patch.source !== source) {
      if (patch && patch.source?.setData === patch.wrapper) patch.source.setData = patch.originalSetData;
      const originalSetData = source.setData;
      patch = {
        source,
        originalSetData,
        virtualizationProvider,
        lastInput: null,
        lastOutput: null,
        lastSignature: null,
        calls: 0,
        wrapper(data) {
          patch.calls += 1;
          const virtualization = patch.virtualizationProvider?.();
          const signature = virtualizationSignature(virtualization);
          if (data === patch.lastInput && signature === patch.lastSignature) return patch.lastOutput;
          const filtered = virtualizeGeoJsonData(data, virtualization, { clip: true });
          patch.lastInput = data;
          patch.lastOutput = filtered;
          patch.lastSignature = signature;
          toolboxRenderDebugLog('spatial-source-setData', () => ({
            sourceId,
            sourceObjectId: toolboxRenderObjectId(source),
            call: patch.calls,
            signature,
            inputCount: toolboxRenderFeatureCount(data),
            outputCount: toolboxRenderFeatureCount(filtered),
            inputSample: toolboxRenderFeatureSample(data),
            outputSample: toolboxRenderFeatureSample(filtered),
          }), { key: `spatial-source-setData:${sourceId}`, every: 10, first: 20 });
          return patch.originalSetData.call(this, filtered);
        },
      };
      source.setData = patch.wrapper;
      state.patches.set(sourceId, patch);
      toolboxRenderDebugLog('spatial-source-guard-installed', () => ({
        sourceId,
        sourceObjectId: toolboxRenderObjectId(source),
        currentDataCount: toolboxRenderFeatureCount(source._data ?? source.data),
      }), { key: `spatial-source-guard-installed:${sourceId}`, every: 1, first: 100 });
    } else {
      patch.virtualizationProvider = virtualizationProvider;
    }

    // React-MapLibre may create the source before the mod attaches. If its
    // current data is discoverable, clip it immediately; subsequent native
    // updates go through the wrapper above.
    const currentData = source._data ?? source.data;
    if (currentData != null && currentData !== patch.lastOutput) patch.wrapper.call(source, currentData);
    else if (patch.lastInput != null) patch.wrapper.call(source, patch.lastInput);
  }
  return state;
}

function releaseSpatialSourceVisibilityGuards(map) {
  const state = map?.[SPATIAL_SOURCE_GUARD_KEY];
  if (!state) return;
  for (const patch of state.patches.values()) {
    if (patch.source?.setData === patch.wrapper) patch.source.setData = patch.originalSetData;
  }
  state.patches.clear();
  try { delete map[SPATIAL_SOURCE_GUARD_KEY]; } catch {}
}

function movementDeckVisibilitySignature(zoom, virtualization) {
  return `${virtualizationSignature(virtualization)}|detailed:${isDetailedMovementZoom(zoom)}`;
}

function applyMovementDeckVisibility(deck, { force = false } = {}) {
  const patch = deck?.[MOVEMENT_DECK_GUARD_KEY];
  if (!patch || patch.nativeLayers == null) return;
  const zoom = patch.map?.getZoom?.();
  const virtualization = patch.virtualizationProvider?.();
  const signature = movementDeckVisibilitySignature(zoom, virtualization);
  if (
    !force
    && patch.lastAppliedNativeLayers === patch.nativeLayers
    && patch.lastAppliedSignature === signature
    && patch.lastAppliedLayers != null
  ) {
    railClipDebugLog('deck-apply-skip', () => ({
      zoom,
      signature,
      reason: 'unchanged-native-layers-and-visibility',
    }), { key: 'deck-apply-skip', every: 60 });
    return patch.lastAppliedLayers;
  }
  railClipDebugLog('deck-apply', () => ({
    zoom,
    signature,
    activeTileId: virtualization?.activeTileId ?? null,
    haloTileIds: virtualization?.haloTileIds ?? [],
    layers: Array.isArray(patch.nativeLayers)
      ? patch.nativeLayers.map(railClipLayerSummary)
      : { type: typeof patch.nativeLayers },
  }), { key: 'deck-apply', every: 20 });
  const maskedLayers = maskMovementDeckLayers(
    patch.nativeLayers,
    zoom,
    virtualization,
    patch.spatialCache,
    patch.layerCache,
  );
  patch.lastAppliedNativeLayers = patch.nativeLayers;
  patch.lastAppliedSignature = signature;
  patch.lastAppliedLayers = maskedLayers;
  patch.originalSetProps.call(deck, { layers: maskedLayers });
  return maskedLayers;
}

function installMovementDeckVisibilityGuard(map, owner, virtualizationProvider) {
  const deck = map?.__deck;
  if (!deck || typeof deck.setProps !== 'function') {
    railClipDebugLog('deck-missing', () => ({
      hasMap: Boolean(map),
      hasDeck: Boolean(deck),
      deckSetProps: typeof deck?.setProps,
      mapStyleLayers: map?.getStyle?.()?.layers?.map((layer) => layer.id).filter(railClipLayerLike) ?? [],
    }), { key: 'deck-missing', every: 20 });
    return null;
  }
  let patch = deck[MOVEMENT_DECK_GUARD_KEY];
  const reused = Boolean(patch);
  if (!patch) {
    patch = {
      map,
      owners: new Set(),
      nativeLayers: deck.props?.layers,
      originalSetProps: deck.setProps,
      virtualizationProvider,
      spatialCache: new WeakMap(),
      layerCache: new Map(),
      lastAppliedNativeLayers: null,
      lastAppliedSignature: null,
      lastAppliedLayers: null,
      wrapper: null,
    };
    patch.wrapper = function guardedMovementDeckSetProps(nextProps = {}) {
      patch.debugSetPropsCalls = (patch.debugSetPropsCalls ?? 0) + 1;
      if (railClipDebugEnabled()) railClipDebugState().setPropsCalls += 1;
      toolboxRenderDebugLog('deck-setProps', () => ({
        mapObjectId: toolboxRenderObjectId(patch.map),
        deckObjectId: toolboxRenderObjectId(this),
        call: patch.debugSetPropsCalls,
        hasLayers: Object.hasOwn(nextProps, 'layers'),
        layerIds: Array.isArray(nextProps.layers)
          ? nextProps.layers.map((layer) => layer?.id ?? layer?.props?.id ?? null)
          : null,
        relevantLayers: Array.isArray(nextProps.layers)
          ? nextProps.layers
            .map((layer) => {
              const id = layer?.id ?? layer?.props?.id ?? null;
              if (!TOOLBOX_RENDER_DEBUG_RE.test(String(id))) return null;
              const data = layer?.props?.data ?? layer?.data;
              return {
                id,
                dataCount: toolboxRenderFeatureCount(data),
                dataSample: toolboxRenderFeatureSample(data),
                visible: layer?.props?.visible ?? layer?.visible ?? true,
              };
            })
            .filter(Boolean)
          : null,
      }), { key: 'deck-setProps', every: 60, first: 5 });
      let forwarded = nextProps;
      if (Object.hasOwn(nextProps, 'layers')) {
        patch.nativeLayers = nextProps.layers;
        const zoom = patch.map?.getZoom?.();
        const virtualization = patch.virtualizationProvider?.();
        railClipDebugLog('deck-setProps', () => ({
          call: patch.debugSetPropsCalls,
          layerCount: Array.isArray(nextProps.layers) ? nextProps.layers.length : null,
          layers: Array.isArray(nextProps.layers)
            ? nextProps.layers.map(railClipLayerSummary)
            : { type: typeof nextProps.layers },
        }), { key: 'deck-setProps', every: 30 });
        const signature = movementDeckVisibilitySignature(zoom, virtualization);
        const canReuseMaskedTree = patch.lastAppliedSignature === signature
          && patch.lastAppliedLayers != null
          && sameNativeLayerTree(patch.lastAppliedNativeLayers, nextProps.layers);
        const maskedLayers = canReuseMaskedTree
          ? patch.lastAppliedLayers
          : maskMovementDeckLayers(
            nextProps.layers,
            zoom,
            virtualization,
            patch.spatialCache,
            patch.layerCache,
          );
        patch.lastAppliedNativeLayers = nextProps.layers;
        patch.lastAppliedSignature = signature;
        patch.lastAppliedLayers = maskedLayers;
        forwarded = {
          ...nextProps,
          layers: maskedLayers,
        };
        const onlyLayers = Object.keys(nextProps).every((key) => key === 'layers');
        if (onlyLayers && this.props?.layers === maskedLayers) {
          railClipDebugLog('deck-setProps-skip', () => ({
            reason: canReuseMaskedTree ? 'masked-layer-tree-unchanged' : 'same-masked-layer-reference',
            layerCount: Array.isArray(maskedLayers) ? maskedLayers.length : null,
          }), { key: 'deck-setProps-skip', every: 60 });
          return this;
        }
      }
      const result = patch.originalSetProps.call(this, forwarded);
      if (railClipDebugEnabled()) {
        railClipDebugLog('deck-runtime-layers', () => railClipDeckRuntimeLayers(this), {
          key: 'deck-runtime-layers',
          every: 30,
          first: 3,
        });
      }
      return result;
    };
    deck[MOVEMENT_DECK_GUARD_KEY] = patch;
    deck.setProps = patch.wrapper;
  }
  patch.map = map;
  patch.virtualizationProvider = virtualizationProvider;
  patch.spatialCache ??= new WeakMap();
  patch.owners.add(owner);
  toolboxRenderDebugLog('deck-guard-sync', {
    mapObjectId: toolboxRenderObjectId(map),
    deckObjectId: toolboxRenderObjectId(deck),
    reused,
    nativeLayerCount: Array.isArray(patch.nativeLayers) ? patch.nativeLayers.length : null,
  }, { key: 'deck-guard-sync', every: 1, first: 100 });
  railClipDebugLog('deck-guard-installed', () => ({
    reused,
    initialLayers: Array.isArray(patch.nativeLayers)
      ? patch.nativeLayers.map(railClipLayerSummary)
      : { type: typeof patch.nativeLayers },
  }), { key: 'deck-guard-installed', every: 10 });
  applyMovementDeckVisibility(deck);
  return deck;
}

function releaseMovementDeckVisibilityGuard(deck, owner) {
  const patch = deck?.[MOVEMENT_DECK_GUARD_KEY];
  if (!patch) return;
  patch.owners.delete(owner);
  if (patch.owners.size > 0) return;
  railClipDebugLog('deck-guard-released', {
    setPropsCalls: patch.debugSetPropsCalls ?? 0,
    nativeLayerCount: Array.isArray(patch.nativeLayers) ? patch.nativeLayers.length : null,
  }, { key: 'deck-guard-released', every: 10 });
  if (deck.setProps === patch.wrapper) deck.setProps = patch.originalSetProps;
  if (patch.nativeLayers != null) patch.originalSetProps.call(deck, { layers: patch.nativeLayers });
  delete deck[MOVEMENT_DECK_GUARD_KEY];
}

function worldContextSourceDefinition(map) {
  const serialized = map?.getStyle?.()?.sources?.['general-tiles'];
  const source = map?.getSource?.('general-tiles');
  const tiles = source?.tiles ?? source?._options?.tiles ?? serialized?.tiles;
  const url = source?._options?.url ?? serialized?.url;
  if (!Array.isArray(tiles) && typeof url !== 'string') return null;
  return {
    type: 'vector',
    ...(Array.isArray(tiles) ? { tiles: [...tiles] } : { url }),
    minzoom: 0,
    // The unified archives contain the shared world land/boundary layers
    // through z9, then switch to city-only tiles at z10. Keeping this source
    // at z9 makes MapLibre overzoom the world tile instead of exposing the
    // full-world ocean fill when the city tile has no world_land features.
    maxzoom: 9,
  };
}

function ensureWorldContextSource(map) {
  if (map?.getSource?.(WORLD_CONTEXT_SOURCE_ID)) return true;
  const definition = worldContextSourceDefinition(map);
  if (!definition) return false;
  try { map.addSource?.(WORLD_CONTEXT_SOURCE_ID, definition); } catch {}
  return Boolean(map?.getSource?.(WORLD_CONTEXT_SOURCE_ID));
}

function ensureArtifacts(map) {
  const worldLayerIds = new Set([
    WORLD_WATER_BACKGROUND_LAYER_ID,
    WORLD_OCEAN_LAYER_ID,
    WORLD_LAND_LAYER_ID,
    WORLD_LAND_HIGH_ZOOM_LAYER_ID,
    WORLD_BOUNDARY_LAYER_ID,
    WORLD_BOUNDARY_HIGH_ZOOM_LAYER_ID,
    TILE_BOUNDARY_LAYER_ID,
  ]);
  const styleLayers = map.getStyle?.()?.layers ?? [];
  const firstNativeContentLayer = styleLayers.find(
    (layer) => layer.type !== 'background' && !worldLayerIds.has(layer.id),
  )?.id;

  // A MapLibre background is always painted below all non-background layers,
  // irrespective of its position in the style. Use an ordinary fill so the
  // ocean can sit above Subway Builder's opaque native background instead.
  if (map.getLayer?.(WORLD_WATER_BACKGROUND_LAYER_ID)) {
    try { map.removeLayer?.(WORLD_WATER_BACKGROUND_LAYER_ID); } catch {}
  }
  if (!map.getSource?.(WORLD_OCEAN_SOURCE_ID)) {
    map.addSource?.(WORLD_OCEAN_SOURCE_ID, { type: 'geojson', data: WORLD_OCEAN });
  }
  if (!map.getLayer?.(WORLD_OCEAN_LAYER_ID)) {
    map.addLayer?.({
      id: WORLD_OCEAN_LAYER_ID,
      type: 'fill',
      source: WORLD_OCEAN_SOURCE_ID,
      // This is a full-world fallback. It must stop before detailed native
      // land tiles begin, otherwise an unavailable/overzoomed land source can
      // leave the ocean painted over the base game's land.
      maxzoom: STATION_MARKER_MIN_ZOOM,
      paint: { 'fill-color': '#102f68', 'fill-opacity': 1 },
    }, firstNativeContentLayer);
  } else if (
    map.getLayer(WORLD_OCEAN_LAYER_ID)?.maxzoom !== STATION_MARKER_MIN_ZOOM
    && typeof map.setLayerZoomRange === 'function'
  ) {
    // A hot reload can retain the layer created by an older build. Repair its
    // zoom range in place so the stale full-world ocean cannot cover native
    // land until the next full game restart.
    try { map.setLayerZoomRange(WORLD_OCEAN_LAYER_ID, 0, STATION_MARKER_MIN_ZOOM); } catch {}
  }
  if (map.getSource?.('general-tiles') && !map.getLayer?.(WORLD_LAND_LAYER_ID)) {
    map.addLayer?.({
      id: WORLD_LAND_LAYER_ID,
      type: 'fill',
      source: 'general-tiles',
      'source-layer': 'world_land',
      maxzoom: GEOGRAPHIC_CONTEXT_MAX_ZOOM,
      paint: { 'fill-color': '#1c3046', 'fill-opacity': 1 },
    }, firstNativeContentLayer);
  }
  const hasWorldContextSource = ensureWorldContextSource(map);
  if (hasWorldContextSource && !map.getLayer?.(WORLD_LAND_HIGH_ZOOM_LAYER_ID)) {
    map.addLayer?.({
      id: WORLD_LAND_HIGH_ZOOM_LAYER_ID,
      type: 'fill',
      source: WORLD_CONTEXT_SOURCE_ID,
      'source-layer': 'world_land',
      minzoom: STATION_MARKER_MIN_ZOOM,
      maxzoom: GEOGRAPHIC_CONTEXT_MAX_ZOOM,
      paint: { 'fill-color': '#1c3046', 'fill-opacity': 1 },
    }, firstNativeContentLayer);
  }
  // These moves are intentional on every refresh: a hot reload may inherit
  // old ordering. Ocean must be below land, but both must cover the native
  // background and remain below native water/road/rail layers.
  try { map.moveLayer?.(WORLD_OCEAN_LAYER_ID, firstNativeContentLayer); } catch {}
  try { map.moveLayer?.(WORLD_LAND_LAYER_ID, firstNativeContentLayer); } catch {}

  // `city_labels` is a vector source-layer. The rendered style layer IDs are
  // generated by the game and are not guaranteed to have the same name.
  const cityLabelLayers = styleLayers.filter((layer) => (
    layer.type === 'symbol'
    && layer.source === 'general-tiles'
    && layer['source-layer'] === 'city_labels'
  ));
  if (typeof map.setLayerZoomRange === 'function') {
    for (const layer of cityLabelLayers) {
      if (layer.minzoom === 10 && layer.maxzoom === GEOGRAPHIC_CONTEXT_MAX_ZOOM) continue;
      map.setLayerZoomRange(layer.id, 10, GEOGRAPHIC_CONTEXT_MAX_ZOOM);
    }
  }
  if (map.getSource?.('general-tiles') && !map.getLayer?.(WORLD_BOUNDARY_LAYER_ID)) {
    const labelLayer = cityLabelLayers[0]?.id;
    map.addLayer?.({
      id: WORLD_BOUNDARY_LAYER_ID,
      type: 'line',
      source: 'general-tiles',
      'source-layer': 'world_boundaries',
      minzoom: 1,
      maxzoom: GEOGRAPHIC_CONTEXT_MAX_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#7890a6',
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.45, 6, 0.8, 9, 1.35],
        'line-opacity': 0.7,
        'line-dasharray': [3, 2],
      },
    }, labelLayer);
  }
  if (hasWorldContextSource && !map.getLayer?.(WORLD_BOUNDARY_HIGH_ZOOM_LAYER_ID)) {
    const labelLayer = cityLabelLayers[0]?.id;
    map.addLayer?.({
      id: WORLD_BOUNDARY_HIGH_ZOOM_LAYER_ID,
      type: 'line',
      source: WORLD_CONTEXT_SOURCE_ID,
      'source-layer': 'world_boundaries',
      minzoom: STATION_MARKER_MIN_ZOOM,
      maxzoom: GEOGRAPHIC_CONTEXT_MAX_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#7890a6',
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.45, 6, 0.8, 9, 1.35],
        'line-opacity': 0.7,
        'line-dasharray': [3, 2],
      },
    }, labelLayer);
  }

  if (!map.getSource?.(BOUNDARY_SOURCE_ID)) {
    map.addSource?.(BOUNDARY_SOURCE_ID, { type: 'geojson', data: EMPTY });
  }

  if (!map.getLayer?.(TILE_BOUNDARY_LAYER_ID)) {
    map.addLayer?.({
      id: TILE_BOUNDARY_LAYER_ID,
      type: 'line',
      source: BOUNDARY_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['boolean', ['get', 'active'], false], '#ffd166', '#79b8e8'],
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          0, ['case', ['boolean', ['get', 'active'], false], 1.1, 0.65],
          9, ['case', ['boolean', ['get', 'active'], false], 2.8, 1.5],
          15, ['case', ['boolean', ['get', 'active'], false], 4.2, 2.2],
        ],
        'line-opacity': ['case', ['boolean', ['get', 'active'], false], 0.95, 0.7],
        'line-dasharray': [3, 2],
      },
    });
  }
}

export class GeographicContextOverlayController {
  constructor({ runtime, tileCatalog }) {
    this.runtime = runtime;
    this.tileCatalog = tileCatalog;
    this.map = null;
    this.movementDeck = null;
    this.stationMarkerVisibility = null;
    this.rendererVirtualization = null;
    this.spatialSourceVisibility = null;
    this.handleStyle = () => {
      const refresh = () => {
        this.refresh();
      };
      globalThis.requestAnimationFrame?.(refresh) ?? refresh();
    };
    this.handleZoom = () => {
      updateStationMarkerVisibility(this.map);
      toolboxRenderDebugLog('zoom', () => ({
        zoom: this.map?.getZoom?.() ?? null,
        activeTileId: this.rendererVirtualization?.activeTileId ?? null,
        haloTileIds: this.rendererVirtualization?.haloTileIds ?? [],
      }), { key: 'zoom', every: 20, first: 5 });
      // Rail clipping depends on the active tile/halo, not on every fractional
      // camera zoom.  Only reapply Deck layers when the detailed movement
      // visibility state actually crosses a boundary.
      if (this.movementDeck?.[MOVEMENT_DECK_GUARD_KEY]) {
        applyMovementDeckVisibility(this.movementDeck);
      } else {
        this.syncMovementDeckVisibilityGuard();
      }
    };
    this.handleStyleData = () => {
      const refreshMovementRanges = () => {
        toolboxRenderDebugLog('styledata', () => toolboxRenderMapSnapshot(
          this.map,
          this.rendererVirtualization,
        ), { key: 'styledata', every: 1, first: 100 });
        applyRoadLayerZoomRanges(this.map);
        applyMovementLayerZoomRanges(this.map);
        this.syncSpatialSourceVisibilityGuard();
        this.syncMovementDeckVisibilityGuard();
      };
      globalThis.requestAnimationFrame?.(refreshMovementRanges) ?? refreshMovementRanges();
    };
    this.unsubscribeRuntime = runtime?.subscribe?.(() => this.refresh());
  }

  attachMap(map) {
    if (this.map === map) return this.refresh();
    if (this.map) {
      try { this.map.off('style.load', this.handleStyle); } catch {}
      try { this.map.off('styledata', this.handleStyleData); } catch {}
      try { this.map.off('zoom', this.handleZoom); } catch {}
    }
    this.releaseMovementDeckVisibilityGuard();
    releaseSpatialSourceVisibilityGuards(this.map);
    this.spatialSourceVisibility = null;
    this.stationMarkerVisibility?.reset?.();
    this.stationMarkerVisibility = null;
    this.map = map;
    this.rendererVirtualization = this.createRendererVirtualization();
    globalThis.__openWorldToolboxRenderMap = map;
    globalThis.__openWorldToolboxRenderVirtualization = this.rendererVirtualization;
    railClipDebugState().attachCalls += 1;
    railClipDebugLog('map-attached', {
      attachCall: railClipDebugState().attachCalls,
      activeTileId: this.rendererVirtualization?.activeTileId ?? null,
      haloTileIds: this.rendererVirtualization?.haloTileIds ?? [],
      mapHasDeck: Boolean(map?.__deck),
      deckLayerIds: Array.isArray(map?.__deck?.props?.layers)
        ? map.__deck.props.layers.map((layer) => layer?.id ?? layer?.props?.id ?? null)
        : null,
      mapStyleRailLayerIds: map?.getStyle?.()?.layers?.map((layer) => layer.id).filter(railClipLayerLike) ?? [],
    }, { key: 'map-attached', every: 10 });
    this.stationMarkerVisibility = createStationMarkerVisibilityAdapter({
      map,
      virtualization: this.rendererVirtualization,
      onApply: () => toolboxRenderDebugLog('marker-adapter-apply', () => ({
        mapObjectId: toolboxRenderObjectId(map),
        activeTileId: this.rendererVirtualization?.activeTileId ?? null,
        haloTileIds: this.rendererVirtualization?.haloTileIds ?? [],
        markerSnapshot: toolboxRenderMarkerSummary(map, this.rendererVirtualization),
      }), { key: 'marker-adapter-apply', every: 30, first: 5 }),
    });
    this.stationMarkerVisibility.apply?.();
    map?.on?.('style.load', this.handleStyle);
    map?.on?.('styledata', this.handleStyleData);
    map?.on?.('zoom', this.handleZoom);
    ensureStationMarkerStyle();
    updateStationMarkerVisibility(map);
    applyRoadLayerZoomRanges(map);
    applyMovementLayerZoomRanges(map);
    this.syncSpatialSourceVisibilityGuard();
    this.syncMovementDeckVisibilityGuard();
    toolboxRenderDebugLog('map-attached-snapshot', () => toolboxRenderMapSnapshot(
      map,
      this.rendererVirtualization,
    ), { key: 'map-attached-snapshot', every: 1, first: 100 });
    globalThis.__printOpenWorldMapLayers = () => printMapLayerDiagnostic(map);
    delete globalThis.__openWorldMovementZoomTrace;
    delete globalThis.__printOpenWorldMovementZoomTrace;
    this.refresh();
    map?.once?.('idle', () => {
      if (this.map !== map) return;
      // onMapReady may arrive after style.load but before MapLibre considers
      // every style source loaded. The initial refresh then exits, so idle is
      // the authoritative retry point rather than only a diagnostic event.
      this.refresh();
    });
  }

  refresh() {
    if (!this.map?.isStyleLoaded?.()) return;
    ensureStationMarkerStyle();
    this.rendererVirtualization = this.createRendererVirtualization();
    globalThis.__openWorldToolboxRenderMap = this.map;
    globalThis.__openWorldToolboxRenderVirtualization = this.rendererVirtualization;
    railClipDebugLog('map-refresh', {
      activeTileId: this.rendererVirtualization?.activeTileId ?? null,
      haloTileIds: this.rendererVirtualization?.haloTileIds ?? [],
      mapHasDeck: Boolean(this.map?.__deck),
      deckLayerIds: Array.isArray(this.map?.__deck?.props?.layers)
        ? this.map.__deck.props.layers.map((layer) => layer?.id ?? layer?.props?.id ?? null)
        : null,
    }, { key: 'map-refresh', every: 30 });
    this.stationMarkerVisibility?.updateVirtualization?.(this.rendererVirtualization);
    updateStationMarkerVisibility(this.map);
    applyRoadLayerZoomRanges(this.map);
    applyMovementLayerZoomRanges(this.map);
    this.syncSpatialSourceVisibilityGuard();
    this.syncMovementDeckVisibilityGuard();
    toolboxRenderDebugLog('map-refresh-snapshot', () => toolboxRenderMapSnapshot(
      this.map,
      this.rendererVirtualization,
    ), { key: 'map-refresh-snapshot', every: 1, first: 100 });
    ensureArtifacts(this.map);
    const activeTileId = this.runtime?.view?.()?.activeTileId ?? null;
    this.map.getSource(BOUNDARY_SOURCE_ID)?.setData(tileBoundaryGeoJson(this.tileCatalog, activeTileId));
  }

  dispose() {
    this.unsubscribeRuntime?.();
    if (this.map) {
      try { this.map.off('style.load', this.handleStyle); } catch {}
      try { this.map.off('styledata', this.handleStyleData); } catch {}
      try { this.map.off('zoom', this.handleZoom); } catch {}
      const container = this.map.getContainer?.();
      if (container?.dataset) delete container.dataset[STATION_MARKER_VISIBILITY_KEY];
    }
    this.stationMarkerVisibility?.reset?.();
    this.stationMarkerVisibility = null;
    releaseSpatialSourceVisibilityGuards(this.map);
    this.spatialSourceVisibility = null;
    this.releaseMovementDeckVisibilityGuard();
    if (globalThis.__openWorldToolboxRenderMap === this.map) {
      delete globalThis.__openWorldToolboxRenderMap;
      delete globalThis.__openWorldToolboxRenderVirtualization;
    }
    this.map = null;
  }

  syncMovementDeckVisibilityGuard() {
    const currentDeck = this.map?.__deck;
    if (
      currentDeck
      && currentDeck === this.movementDeck
      && currentDeck[MOVEMENT_DECK_GUARD_KEY]
    ) {
      const patch = currentDeck[MOVEMENT_DECK_GUARD_KEY];
      patch.map = this.map;
      patch.virtualizationProvider = () => this.getDeckRendererVirtualization();
      applyMovementDeckVisibility(currentDeck);
      return currentDeck;
    }

    const previousDeck = this.movementDeck;
    const deck = installMovementDeckVisibilityGuard(
      this.map,
      this,
      () => this.getDeckRendererVirtualization(),
    );
    if (previousDeck && previousDeck !== deck) {
      releaseMovementDeckVisibilityGuard(previousDeck, this);
    }
    this.movementDeck = deck;
    return deck;
  }

  syncSpatialSourceVisibilityGuard() {
    this.spatialSourceVisibility = installSpatialSourceVisibilityGuards(
      this.map,
      () => this.getDeckRendererVirtualization(),
    );
    return this.spatialSourceVisibility;
  }

  createRendererVirtualization() {
    return createRendererVirtualization({
      activeTileId: this.runtime?.view?.()?.activeTileId ?? null,
      tileCatalog: this.tileCatalog,
    });
  }

  getDeckRendererVirtualization() {
    return this.rendererVirtualization ?? this.createRendererVirtualization();
  }

  getRendererVirtualization() {
    return this.createRendererVirtualization();
  }

  releaseMovementDeckVisibilityGuard() {
    if (!this.movementDeck) return;
    releaseMovementDeckVisibilityGuard(this.movementDeck, this);
    this.movementDeck = null;
  }
}

export function registerGeographicContextOverlay(options) {
  return new GeographicContextOverlayController(options);
}

export const geographicContextLayerIds = Object.freeze({
  boundarySource: BOUNDARY_SOURCE_ID,
  tileBoundaries: TILE_BOUNDARY_LAYER_ID,
  worldBoundaries: WORLD_BOUNDARY_LAYER_ID,
  worldBoundariesHighZoom: WORLD_BOUNDARY_HIGH_ZOOM_LAYER_ID,
  worldContextSource: WORLD_CONTEXT_SOURCE_ID,
  worldLand: WORLD_LAND_LAYER_ID,
  worldLandHighZoom: WORLD_LAND_HIGH_ZOOM_LAYER_ID,
  worldOceanSource: WORLD_OCEAN_SOURCE_ID,
  worldOcean: WORLD_OCEAN_LAYER_ID,
  worldWaterBackground: WORLD_WATER_BACKGROUND_LAYER_ID,
  spatialSources: SPATIAL_SOURCE_IDS,
});
