import {
  clipLineStringWithValues,
  createRendererVirtualization,
  createStationMarkerVisibilityAdapter,
  normalizeRenderDistance,
  virtualizeGeoJsonData,
} from './renderer-virtualization.js';
import { readWorldContextTheme, syncWorldContextTheme } from './world-context-theme.js';
import { syncNativeParkLanduse, releaseNativeParkLanduse } from './native-park-landuse.js';
import { ensureWorldVegetation, releaseWorldVegetation, WORLD_VEGETATION_LAYER } from './world-vegetation.js';
const EMPTY = Object.freeze({ type: 'FeatureCollection', features: [] });
const BOUNDARY_SOURCE_ID = 'open-world-tile-boundaries-source';
const TILE_SELECTION_LAYER_ID = 'open-world-tile-selection';
const TILE_BOUNDARY_LAYER_ID = 'open-world-tile-boundaries';
const WORLD_BOUNDARY_LAYER_ID = 'open-world-country-boundaries';
const WORLD_CONTEXT_SOURCE_ID = 'open-world-world-context-source';
export const WORLD_CONTEXT_VERSION = 'independent-world-context-v1';
export const WORLD_CONTEXT_RESTORE_VERSION = 'source-independent-context-restoration-v2';
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
const ROAD_DETAIL_MIN_ZOOM = Object.freeze({ highway: 10, major: 12, medium: 13, minor: 14 });
const ROAD_LAYER_ID_RE = /(?:^|[-_])(road|roads|highway|highways|street|streets)(?:[-_]|$)/i;
const ROAD_SOURCE_LAYER_RE = /^(?:road|roads|highway|highways|street|streets|transportation)(?:[-_]|$)/i;
const ROAD_LABEL_LAYER_RE = /(?:^|[-_])labels?(?:[-_]|$)/i;
// The native game renders its roads as Deck GeoJsonLayers, not as MapLibre
// style layers. Keep this tied to the bundle's stable layer-id families so
// the low-zoom gate cannot accidentally hide rail or route layers.
const ROAD_DECK_LAYER_ID_RE = /^road-(?:lines-|bridge-(?:casing|fill)-)/i;
const NON_ROAD_LAYER_RE = /(?:^|[-_])(rail|railway|track|transit|station|route|metro|tram|subway)(?:[-_]|$)/i;
const RAIL_LINE_LAYER_RE = /(?:^|[-_])(interlined|portolan|ribbons?|rail|railway|tracks?|routes?|transit|metro|tram|subway)(?:[-_]|$)/i;
const NON_RAIL_LINE_DETAIL_RE = /(?:^|[-_])(station|node|marker|label|preview|train|signal|demand|pop)(?:[-_]|$)/i;
const MOD_OWNED_MAP_LAYER_RE = /^open-world-/i;
const WATER_MAP_LAYER_RE = /(?:^|[-_])(water|ocean)(?:[-_]|$)/i;
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
const MOVEMENT_DECK_GUARD_VERSION = 11;
const RENDERER_VIRTUALIZATION_AUTHORITY_VERSION = 'renderer-authority-v1';
const GEOGRAPHIC_CONTEXT_CONTROLLER_KEY = Symbol.for('open-world.geographic-context-controller');
const SPATIAL_SOURCE_GUARD_KEY = '__openWorldSpatialSourceVisibilityGuard';
const VOLATILE_RAIL_LAYER_ID_RE = /^(?:interlined-routes|portolan-ribbons)(?:-under)?$/i;
const PORTOLAN_RIBBON_LAYER_ID_RE = /^portolan-ribbons(?:-under)?$/i;
const STATION_DECK_LAYER_ID_RE = /^(?:station-marker-(?:dots|labels)|portolan-station-pills)$/i;
const RAIL_CLIP_DIAGNOSTIC_VERSION = 'portolan-binary-v7';
const RAIL_CLIP_DEBUG_FLAG = '__OPEN_WORLD_RAIL_CLIP_DEBUG';
const RAIL_CLIP_DEBUG_STATE = '__OPEN_WORLD_RAIL_CLIP_DEBUG_STATE';
const RAIL_CLIP_DEBUG_PREFIX = '[DEBUG-railclip]';
const MAP_MOVE_PERF_VERSION = 'map-move-perf-v4';
const MAP_MOVE_PERF_FLAG = '__OPEN_WORLD_MAP_MOVE_PERF_DEBUG';
const MAP_MOVE_PERF_STATE = '__OPEN_WORLD_MAP_MOVE_PERF_DEBUG_STATE_V4';
const MAP_MOVE_PERF_LEGACY_STATE = '__OPEN_WORLD_MAP_MOVE_PERF_DEBUG_STATE';
const MAP_MOVE_PERF_OBSERVER = '__OPEN_WORLD_MAP_MOVE_PERF_OBSERVER';
const MAP_MOVE_PERF_PROBES = '__OPEN_WORLD_MAP_MOVE_PERF_PROBES';
const MAP_MOVE_PERF_PREFIX = '[DEBUG-map-move-perf-v4]';
const NATIVE_HOVER_DELEGATE_GATE_KEY = '__openWorldNativeHoverDelegateGate';
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

function mapMovePerfNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function newMapMovePerfState({ slowMs = 8, frameGapSlowMs = 50, quiet = true } = {}) {
  return {
    version: MAP_MOVE_PERF_VERSION,
    createdAt: Date.now(),
    quiet: quiet !== false,
    slowMs: Number.isFinite(Number(slowMs)) ? Math.max(0, Number(slowMs)) : 8,
    frameGapSlowMs: Number.isFinite(Number(frameGapSlowMs))
      ? Math.max(0, Number(frameGapSlowMs))
      : 50,
    stages: {},
    slowEvents: [],
    browserEvents: [],
    moves: [],
    observers: null,
    probes: [],
  };
}

function mapMovePerfState() {
  const existing = globalThis[MAP_MOVE_PERF_STATE];
  if (!existing || existing.version !== MAP_MOVE_PERF_VERSION) {
    globalThis[MAP_MOVE_PERF_STATE] = newMapMovePerfState();
  }
  return globalThis[MAP_MOVE_PERF_STATE];
}

function mapMovePerfEnabled() {
  return globalThis[MAP_MOVE_PERF_FLAG] === true;
}

function mapMovePerfLiveLoggingEnabled() {
  return mapMovePerfState().quiet === false;
}

function mapMovePerfStates() {
  const current = mapMovePerfState();
  const legacy = globalThis[MAP_MOVE_PERF_LEGACY_STATE];
  return [
    { key: MAP_MOVE_PERF_STATE, state: current },
    ...(legacy && legacy !== current && typeof legacy === 'object'
      ? [{ key: MAP_MOVE_PERF_LEGACY_STATE, state: legacy }]
      : []),
  ];
}

function mapMovePerfRecord(stage, durationMs, details = null, { logSlow = true } = {}) {
  if (!mapMovePerfEnabled()) return;
  const duration = Number(durationMs);
  if (!Number.isFinite(duration)) return;
  const state = mapMovePerfState();
  const stats = state.stages[stage] ?? {
    count: 0,
    totalMs: 0,
    averageMs: 0,
    maxMs: 0,
    slowCount: 0,
    lastMs: 0,
  };
  stats.count += 1;
  stats.totalMs += duration;
  stats.averageMs = stats.totalMs / stats.count;
  stats.maxMs = Math.max(stats.maxMs, duration);
  stats.lastMs = duration;
  if (duration >= state.slowMs) stats.slowCount += 1;
  state.stages[stage] = stats;
  if (!logSlow || duration < state.slowMs) return;
  const resolvedDetails = typeof details === 'function' ? details() : details;
  const event = {
    at: Date.now(),
    stage,
    durationMs: duration,
    ...(resolvedDetails && typeof resolvedDetails === 'object' ? resolvedDetails : {}),
  };
  state.slowEvents.push(event);
  if (state.slowEvents.length > 120) state.slowEvents.splice(0, state.slowEvents.length - 120);
  if (stage.startsWith('browser.')) {
    state.browserEvents.push(event);
    if (state.browserEvents.length > 120) {
      state.browserEvents.splice(0, state.browserEvents.length - 120);
    }
  }
  const slowEventCount = stats.slowCount;
  if (mapMovePerfLiveLoggingEnabled() && (slowEventCount <= 5 || slowEventCount % 20 === 0)) {
    console.warn(MAP_MOVE_PERF_PREFIX, 'slow-stage', event);
  }
}

function mapMovePerfMeasure(stage, operation, details = null) {
  if (!mapMovePerfEnabled()) return operation();
  const startedAt = mapMovePerfNow();
  try {
    return operation();
  } finally {
    mapMovePerfRecord(stage, mapMovePerfNow() - startedAt, details);
  }
}

function stopMapMoveLongTaskObserver() {
  for (const observer of globalThis[MAP_MOVE_PERF_OBSERVER] ?? []) observer?.disconnect?.();
  delete globalThis[MAP_MOVE_PERF_OBSERVER];
}

function startMapMoveLongTaskObserver() {
  stopMapMoveLongTaskObserver();
  const supportedEntryTypes = Array.from(globalThis.PerformanceObserver?.supportedEntryTypes ?? []);
  const status = {
    supportedEntryTypes,
    longTask: false,
    longAnimationFrame: false,
  };
  if (typeof globalThis.PerformanceObserver !== 'function') return status;
  const observers = [];
  const observe = (type, callback) => {
    if (supportedEntryTypes.length && !supportedEntryTypes.includes(type)) return false;
    try {
      const observer = new globalThis.PerformanceObserver((list) => {
        for (const entry of list?.getEntries?.() ?? []) callback(entry);
      });
      observer.observe({ type, buffered: false });
      observers.push(observer);
      return true;
    } catch {
      return false;
    }
  };
  status.longTask = observe('longtask', (entry) => {
    mapMovePerfRecord('browser.long-task', entry.duration, {
      startTime: entry.startTime,
      name: entry.name ?? null,
      attribution: Array.from(entry.attribution ?? []).slice(0, 4).map((value) => ({
        name: value?.name ?? null,
        containerType: value?.containerType ?? null,
        containerName: value?.containerName ?? null,
        containerId: value?.containerId ?? null,
        containerSrc: value?.containerSrc ?? null,
      })),
    });
  });
  status.longAnimationFrame = observe('long-animation-frame', (entry) => {
    const scripts = Array.from(entry.scripts ?? [])
      .sort((left, right) => Number(right?.duration ?? 0) - Number(left?.duration ?? 0))
      .slice(0, 8)
      .map((script) => ({
        durationMs: Number(script?.duration ?? 0),
        pauseDurationMs: Number(script?.pauseDuration ?? 0),
        forcedStyleAndLayoutDurationMs: Number(script?.forcedStyleAndLayoutDuration ?? 0),
        sourceURL: script?.sourceURL ?? null,
        sourceFunctionName: script?.sourceFunctionName ?? null,
        invoker: script?.invoker ?? null,
        invokerType: script?.invokerType ?? null,
        windowAttribution: script?.windowAttribution ?? null,
      }));
    mapMovePerfRecord('browser.long-animation-frame', entry.duration, {
      startTime: entry.startTime,
      blockingDurationMs: Number(entry.blockingDuration ?? 0),
      renderStart: Number(entry.renderStart ?? 0),
      styleAndLayoutStart: Number(entry.styleAndLayoutStart ?? 0),
      firstUIEventTimestamp: Number(entry.firstUIEventTimestamp ?? 0),
      scripts,
    });
  });
  globalThis[MAP_MOVE_PERF_OBSERVER] = observers;
  return status;
}

function stopMapMovePerfProbes() {
  const active = globalThis[MAP_MOVE_PERF_PROBES];
  for (const restore of [...(active?.restorers ?? [])].reverse()) {
    try { restore(); } catch {}
  }
  delete globalThis[MAP_MOVE_PERF_PROBES];
}

function startMapMovePerfProbes() {
  stopMapMovePerfProbes();
  const map = globalThis.__openWorldToolboxRenderMap;
  const deck = map?.__deck;
  const installed = [];
  const restorers = [];
  const patchMethod = (target, method, stage, details = null, probeName = null) => {
    const original = target?.[method];
    if (typeof original !== 'function') return false;
    const wrapper = function openWorldMapPerfMethodProbe(...args) {
      const resolvedStage = typeof stage === 'function' ? stage(...args) : stage;
      const resolvedDetails = typeof details === 'function' ? () => details(...args) : details;
      return mapMovePerfMeasure(resolvedStage, () => original.apply(this, args), resolvedDetails);
    };
    try {
      target[method] = wrapper;
      if (target[method] !== wrapper) return false;
    } catch {
      return false;
    }
    restorers.push(() => {
      if (target[method] === wrapper) target[method] = original;
    });
    installed.push(probeName ?? stage);
    return true;
  };
  const mapDetails = () => ({ zoom: map?.getZoom?.() ?? null });
  const deckDetails = () => ({
    zoom: map?.getZoom?.() ?? null,
    layerCount: Array.isArray(deck?.props?.layers) ? deck.props.layers.length : null,
  });
  patchMethod(map, '_render', 'maplibre.map._render', mapDetails);
  patchMethod(map, '_update', 'maplibre.map._update', mapDetails);
  patchMethod(map?._renderTaskQueue, 'run', 'maplibre.render-task-queue.run', mapDetails);
  patchMethod(map?.painter, 'render', 'maplibre.painter.render', mapDetails);
  patchMethod(map?.style, 'update', 'maplibre.style.update', mapDetails);
  patchMethod(map?.style, '_updateSources', 'maplibre.style._updateSources', mapDetails);
  patchMethod(map?.style, '_updateWorkerLayers', 'maplibre.style._updateWorkerLayers', mapDetails);
  patchMethod(map?.style, '_updateLayers', 'maplibre.style._updateLayers', mapDetails);
  const eventStage = (event) => {
    const type = typeof event === 'string' ? event : event?.type;
    const safeType = String(type ?? 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
    return `maplibre.event.${safeType}`;
  };
  const eventDetails = (event) => ({
    zoom: map?.getZoom?.() ?? null,
    eventType: typeof event === 'string' ? event : event?.type ?? null,
  });
  patchMethod(map, 'fire', eventStage, eventDetails, 'maplibre.event.*');
  patchMethod(map, '_fire', eventStage, eventDetails, 'maplibre._event.*');
  patchMethod(
    map,
    'queryRenderedFeatures',
    'maplibre.queryRenderedFeatures',
    (geometry, options) => ({
      zoom: map?.getZoom?.() ?? null,
      layers: Array.isArray(options?.layers) ? options.layers.slice(0, 24) : null,
      layerCount: Array.isArray(options?.layers) ? options.layers.length : null,
      hasGeometry: geometry != null,
    }),
  );
  patchMethod(deck, 'redraw', 'deck.redraw', deckDetails);
  patchMethod(deck?.layerManager, 'updateLayers', 'deck.layerManager.updateLayers', deckDetails);
  patchMethod(deck?.layerManager, '_updateLayers', 'deck.layerManager._updateLayers', deckDetails);
  patchMethod(deck?.animationLoop, '_renderFrame', 'deck.animationLoop._renderFrame', deckDetails);
  patchMethod(deck, '_onPointerMove', 'deck._onPointerMove', deckDetails);
  patchMethod(deck, '_onEvent', 'deck._onEvent', deckDetails);
  patchMethod(deck, '_pickAndCallback', 'deck._pickAndCallback', deckDetails);
  patchMethod(deck, 'pickObject', 'deck.pickObject', deckDetails);
  patchMethod(deck, 'pickMultipleObjects', 'deck.pickMultipleObjects', deckDetails);
  patchMethod(deck, 'pickObjects', 'deck.pickObjects', deckDetails);

  let moveTrace = null;
  let nextMoveId = 1;
  const handleMoveStart = () => {
    if (!mapMovePerfEnabled()) return;
    const now = mapMovePerfNow();
    moveTrace = {
      id: `probe-${nextMoveId++}`,
      startedAt: now,
      lastEventAt: now,
      moveEvents: 0,
      maxFrameGapMs: 0,
      startZoom: map?.getZoom?.() ?? null,
    };
  };
  const handleMove = () => {
    if (!mapMovePerfEnabled() || !moveTrace) return;
    const now = mapMovePerfNow();
    const gap = now - moveTrace.lastEventAt;
    moveTrace.lastEventAt = now;
    moveTrace.moveEvents += 1;
    moveTrace.maxFrameGapMs = Math.max(moveTrace.maxFrameGapMs, gap);
  };
  const handleMoveEnd = () => {
    const trace = moveTrace;
    moveTrace = null;
    if (!mapMovePerfEnabled() || !trace) return;
    const state = mapMovePerfState();
    const endedAt = mapMovePerfNow();
    const move = {
      id: trace.id,
      source: 'profiler-probe',
      capturedAt: Date.now(),
      durationMs: endedAt - trace.startedAt,
      moveEvents: trace.moveEvents,
      maxFrameGapMs: Math.max(trace.maxFrameGapMs, endedAt - trace.lastEventAt),
      startZoom: trace.startZoom,
      endZoom: map?.getZoom?.() ?? null,
    };
    state.moves.push(move);
    if (state.moves.length > 60) state.moves.splice(0, state.moves.length - 60);
    if (mapMovePerfLiveLoggingEnabled() && move.maxFrameGapMs >= state.frameGapSlowMs) {
      console.warn(MAP_MOVE_PERF_PREFIX, 'slow-move-frame', move);
    }
  };
  if (map && typeof map.on === 'function') {
    try {
      map.on('movestart', handleMoveStart);
      map.on('move', handleMove);
      map.on('moveend', handleMoveEnd);
      restorers.push(() => {
        map.off?.('movestart', handleMoveStart);
        map.off?.('move', handleMove);
        map.off?.('moveend', handleMoveEnd);
      });
      installed.push('map-events.movement');
    } catch {}
  }
  globalThis[MAP_MOVE_PERF_PROBES] = { map, deck, installed, restorers };
  return {
    mapAvailable: Boolean(map),
    deckAvailable: Boolean(deck),
    installed: [...installed],
  };
}

function ensureMapMovePerfProbes() {
  if (!mapMovePerfEnabled()) {
    return { mapAvailable: false, deckAvailable: false, installed: [] };
  }
  const map = globalThis.__openWorldToolboxRenderMap;
  const deck = map?.__deck;
  const active = globalThis[MAP_MOVE_PERF_PROBES];
  const status = active?.map === map && active?.deck === deck
    ? {
        mapAvailable: Boolean(map),
        deckAvailable: Boolean(deck),
        installed: [...(active?.installed ?? [])],
      }
    : startMapMovePerfProbes();
  mapMovePerfState().probes = [...status.installed];
  return status;
}

function mapMovePerfReport() {
  ensureMapMovePerfProbes();
  const state = mapMovePerfState();
  const states = mapMovePerfStates();
  const mergedStages = {};
  for (const { state: source } of states) {
    for (const [stage, stats] of Object.entries(source?.stages ?? {})) {
      const merged = mergedStages[stage] ?? {
        count: 0,
        totalMs: 0,
        averageMs: 0,
        maxMs: 0,
        slowCount: 0,
        lastMs: 0,
      };
      merged.count += Number(stats?.count ?? 0);
      merged.totalMs += Number(stats?.totalMs ?? 0);
      merged.maxMs = Math.max(merged.maxMs, Number(stats?.maxMs ?? 0));
      merged.slowCount += Number(stats?.slowCount ?? 0);
      merged.lastMs = Number(stats?.lastMs ?? merged.lastMs);
      merged.averageMs = merged.count > 0 ? merged.totalMs / merged.count : 0;
      mergedStages[stage] = merged;
    }
  }
  const stages = Object.fromEntries(Object.entries(mergedStages)
    .sort(([, left], [, right]) => right.totalMs - left.totalMs)
    .map(([stage, stats]) => [stage, {
      ...stats,
      totalMs: Number(stats.totalMs.toFixed(3)),
      averageMs: Number(stats.averageMs.toFixed(3)),
      maxMs: Number(stats.maxMs.toFixed(3)),
      lastMs: Number(stats.lastMs.toFixed(3)),
    }]));
  return {
    version: state.version,
    enabled: mapMovePerfEnabled(),
    quiet: state.quiet !== false,
    slowMs: state.slowMs,
    frameGapSlowMs: state.frameGapSlowMs,
    observers: state.observers,
    probes: [...(state.probes ?? [])],
    stages,
    moves: states.flatMap(({ state: source }) => source?.moves ?? [])
      .sort((left, right) => Number(left?.capturedAt ?? 0) - Number(right?.capturedAt ?? 0))
      .slice(-120)
      .map((move) => ({ ...move })),
    slowEvents: states.flatMap(({ state: source }) => source?.slowEvents ?? [])
      .sort((left, right) => Number(left?.at ?? 0) - Number(right?.at ?? 0))
      .slice(-240)
      .map((event) => ({ ...event })),
    browserEvents: states.flatMap(({ state: source }) => source?.browserEvents ?? [])
      .sort((left, right) => Number(left?.at ?? 0) - Number(right?.at ?? 0))
      .slice(-240)
      .map((event) => ({ ...event })),
    sources: states.map(({ key, state: source }) => ({
      key,
      version: source?.version ?? null,
      stageCount: Object.keys(source?.stages ?? {}).length,
      moveCount: source?.moves?.length ?? 0,
      slowEventCount: source?.slowEvents?.length ?? 0,
    })),
  };
}

function resetLegacyMapMovePerfState(options = {}) {
  const legacy = globalThis[MAP_MOVE_PERF_LEGACY_STATE];
  if (!legacy || typeof legacy !== 'object') return;
  globalThis[MAP_MOVE_PERF_LEGACY_STATE] = {
    ...newMapMovePerfState(options),
    version: legacy.version ?? 'map-move-perf-v2',
  };
}

function updateLegacyMapMovePerfThresholds(options = {}) {
  const legacy = globalThis[MAP_MOVE_PERF_LEGACY_STATE];
  if (!legacy || typeof legacy !== 'object') return;
  if (typeof options.quiet === 'boolean') legacy.quiet = options.quiet;
  if (Number.isFinite(Number(options.slowMs))) legacy.slowMs = Math.max(0, Number(options.slowMs));
  if (Number.isFinite(Number(options.frameGapSlowMs))) {
    legacy.frameGapSlowMs = Math.max(0, Number(options.frameGapSlowMs));
  }
}

function installMapMovePerfDebugApi() {
  globalThis.__enableOpenWorldMapMovePerfDebug = (configuration = true) => {
    const enabled = configuration !== false;
    const options = configuration && typeof configuration === 'object' ? configuration : {};
    if (options.reset === true || !globalThis[MAP_MOVE_PERF_STATE]) {
      globalThis[MAP_MOVE_PERF_STATE] = newMapMovePerfState(options);
      if (options.reset === true) resetLegacyMapMovePerfState(options);
    } else {
      const state = mapMovePerfState();
      if (typeof options.quiet === 'boolean') state.quiet = options.quiet;
      if (Number.isFinite(Number(options.slowMs))) state.slowMs = Math.max(0, Number(options.slowMs));
      if (Number.isFinite(Number(options.frameGapSlowMs))) {
        state.frameGapSlowMs = Math.max(0, Number(options.frameGapSlowMs));
      }
      updateLegacyMapMovePerfThresholds(options);
    }
    globalThis[MAP_MOVE_PERF_FLAG] = enabled;
    const observers = enabled ? startMapMoveLongTaskObserver() : (stopMapMoveLongTaskObserver(), {
      supportedEntryTypes: [],
      longTask: false,
      longAnimationFrame: false,
    });
    const probeStatus = enabled ? startMapMovePerfProbes() : (stopMapMovePerfProbes(), {
      mapAvailable: false,
      deckAvailable: false,
      installed: [],
    });
    const activeState = mapMovePerfState();
    activeState.observers = observers;
    activeState.probes = [...probeStatus.installed];
    const status = {
      enabled,
      quiet: activeState.quiet !== false,
      slowMs: activeState.slowMs,
      frameGapSlowMs: activeState.frameGapSlowMs,
      observers,
      probes: probeStatus,
    };
    console.info(MAP_MOVE_PERF_PREFIX, 'toggle', status);
    return status;
  };
  globalThis.__printOpenWorldMapMovePerfDiagnostic = () => {
    const report = mapMovePerfReport();
    console.info(MAP_MOVE_PERF_PREFIX, 'diagnostic', report);
    return report;
  };
  globalThis.__clearOpenWorldMapMovePerfDiagnostic = () => {
    const state = mapMovePerfState();
    globalThis[MAP_MOVE_PERF_STATE] = {
      ...newMapMovePerfState(state),
      observers: state.observers,
      probes: [...(state.probes ?? [])],
    };
    resetLegacyMapMovePerfState(state);
    return true;
  };
}

installMapMovePerfDebugApi();

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
      const source = safeMapSource(map, id);
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

export const BOUNDARY_LOD_VERSION = 'precomputed-boundary-lod-v2';

function boundaryLodFor(tile, zoom) {
  return (tile.boundaryLods ?? []).filter((level) => level.minZoom <= zoom).at(-1);
}

function boundaryGeometryFor(tile, zoom) {
  const lod = boundaryLodFor(tile, zoom);
  if (lod?.geometry) return lod.geometry;
  const geometry = tile.boundaryGeometry
    ?? (tile.boundary && !Array.isArray(tile.boundary) ? tile.boundary : null);
  if (geometry && ['Polygon', 'MultiPolygon'].includes(geometry.type)) return geometry;
  const ring = ringFor(tile);
  return ring ? { type: 'Polygon', coordinates: [ring] } : null;
}

function removeStaleTileSelectionDelegates(map) {
  const registry = map?._delegatedListeners;
  if (!registry || typeof registry !== 'object') return 0;
  let removed = 0;
  for (const listeners of Object.values(registry)) {
    if (!Array.isArray(listeners)) continue;
    for (let index = listeners.length - 1; index >= 0; index -= 1) {
      const delegated = listeners[index];
      if (!(delegated?.layers ?? []).includes(TILE_SELECTION_LAYER_ID)) continue;
      for (const [event, listener] of Object.entries(delegated?.delegates ?? {})) {
        try { map.off?.(event, listener); } catch {}
      }
      listeners.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

function nativeHoverDelegateGate(map, owner) {
  const existing = map?.[NATIVE_HOVER_DELEGATE_GATE_KEY];
  if (existing) {
    existing.owner = owner;
    return existing;
  }
  if (!map) return null;
  const gate = { owner, suspended: [] };
  map[NATIVE_HOVER_DELEGATE_GATE_KEY] = gate;
  return gate;
}

function delegatedListenerRegistered(map, event, listener) {
  return Object.values(map?._delegatedListeners ?? {}).some((listeners) => (
    (listeners ?? []).some((delegated) => delegated?.delegates?.[event] === listener)
  ));
}

function resumeNativeHoverDelegates(map, owner, { release = false } = {}) {
  const gate = map?.[NATIVE_HOVER_DELEGATE_GATE_KEY];
  if (!gate || gate.owner !== owner) return;
  for (const { event, listener } of gate.suspended) {
    if (delegatedListenerRegistered(map, event, listener)) map.on?.(event, listener);
  }
  gate.suspended = [];
  if (release) delete map[NATIVE_HOVER_DELEGATE_GATE_KEY];
}

function syncNativeHoverDelegateGate(map, owner) {
  const gate = nativeHoverDelegateGate(map, owner);
  if (!gate) return;
  if (!isWorldTileSelectionZoom(map?.getZoom?.())) {
    resumeNativeHoverDelegates(map, owner);
    return;
  }
  const alreadySuspended = (event, listener) => gate.suspended
    .some((entry) => entry.event === event && entry.listener === listener);
  for (const listeners of Object.values(map?._delegatedListeners ?? {})) {
    for (const delegated of listeners ?? []) {
      if ((delegated?.layers ?? []).includes(TILE_SELECTION_LAYER_ID)) continue;
      for (const event of ['mousemove', 'mouseout']) {
        const listener = delegated?.delegates?.[event];
        if (typeof listener !== 'function' || alreadySuspended(event, listener)) continue;
        map.off?.(event, listener);
        gate.suspended.push({ event, listener });
      }
    }
  }
}

export function tileBoundaryGeoJson(catalog, activeTileId = null, hoveredTileId = null, zoom = Infinity) {
  return {
    type: 'FeatureCollection',
    features: (catalog?.tiles ?? []).flatMap((tile, featureId) => {
      const geometry = boundaryGeometryFor(tile, zoom);
      if (!geometry) return [];
      return [{
        type: 'Feature',
        // The game's GeoJSON tiler drops string Feature.id values unless the
        // source uses promoteId. Numeric catalog slots also repair retained
        // sources on hot reload without destroying layers or their delegates.
        // Keep the World identity in properties.tileId, not this render-only ID.
        id: featureId,
        properties: {
          tileId: tile.id,
          name: tile.name ?? tile.id,
          active: tile.id === activeTileId,
          hovered: tile.id === hoveredTileId && tile.id !== activeTileId,
        },
        geometry,
      }];
    }),
  };
}

export function isWorldTileSelectionZoom(zoom) {
  return Number.isFinite(zoom) && zoom < STATION_MARKER_MIN_ZOOM;
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
    present: Boolean(safeMapSource(map, id)),
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
      sourcePresent: Boolean(safeMapSource(map, WORLD_OCEAN_SOURCE_ID)),
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

function isRailLineLayerId(id) {
  const value = String(id ?? '');
  return RAIL_LINE_LAYER_RE.test(value) && !NON_RAIL_LINE_DETAIL_RE.test(value);
}

function isLowZoomOverview(zoom) {
  return Number.isFinite(zoom) && zoom < STATION_MARKER_MIN_ZOOM;
}

function roadDetailMinZoom(id) {
  const value = String(id ?? '');
  if (/(?:^|[-_])minor(?:[-_]|$)/i.test(value)) return ROAD_DETAIL_MIN_ZOOM.minor;
  if (/(?:^|[-_])medium(?:[-_]|$)/i.test(value)) return ROAD_DETAIL_MIN_ZOOM.medium;
  if (/(?:^|[-_])highway(?:[-_]|$)/i.test(value)) return ROAD_DETAIL_MIN_ZOOM.highway;
  return ROAD_DETAIL_MIN_ZOOM.major;
}

function isDetailedRoadZoom(id, zoom) {
  return Number.isFinite(zoom)
    && zoom >= roadDetailMinZoom(id)
    && zoom < GEOGRAPHIC_CONTEXT_MAX_ZOOM;
}

function roadVisibilityBand(zoom) {
  return Object.entries(ROAD_DETAIL_MIN_ZOOM)
    .map(([family, minZoom]) => `${family}:${Number.isFinite(zoom) && zoom >= minZoom}`)
    .join(',');
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
    const minZoom = roadDetailMinZoom(`${layer.id}-${layer['source-layer'] ?? ''}`);
    if (layer.minzoom === minZoom && layer.maxzoom === GEOGRAPHIC_CONTEXT_MAX_ZOOM) continue;
    try {
      map.setLayerZoomRange(
        layer.id,
        minZoom,
        GEOGRAPHIC_CONTEXT_MAX_ZOOM,
      );
    } catch {}
  }
  return roadLayers.map((layer) => layer.id);
}

function preserveMapLayerBelowDetailZoom(layer) {
  const id = String(layer?.id ?? '');
  const sourceLayer = String(layer?.['source-layer'] ?? '');
  if (layer?.type === 'background' || MOD_OWNED_MAP_LAYER_RE.test(id)) return true;
  if (WATER_MAP_LAYER_RE.test(id) || WATER_MAP_LAYER_RE.test(sourceLayer)) return true;
  return layer?.type === 'line' && isRailLineLayerId(`${id}-${sourceLayer}`);
}

function applyNativeDetailLayerZoomRanges(map) {
  if (typeof map?.setLayerZoomRange !== 'function') return [];
  const detailLayers = (map.getStyle?.()?.layers ?? []).filter(
    (layer) => !preserveMapLayerBelowDetailZoom(layer),
  );
  for (const layer of detailLayers) {
    const minZoom = Math.max(
      STATION_MARKER_MIN_ZOOM,
      Number.isFinite(layer.minzoom) ? layer.minzoom : 0,
    );
    const nativeMaxZoom = Number.isFinite(layer.maxzoom) ? layer.maxzoom : GEOGRAPHIC_CONTEXT_MAX_ZOOM;
    const maxZoom = Math.max(minZoom, nativeMaxZoom);
    if (layer.minzoom === minZoom && layer.maxzoom === maxZoom) continue;
    try { map.setLayerZoomRange(layer.id, minZoom, maxZoom); } catch {}
  }
  return detailLayers.map((layer) => layer.id);
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

function isVolatileRailLayerId(id) {
  return typeof id === 'string' && VOLATILE_RAIL_LAYER_ID_RE.test(id);
}

function isPortolanRibbonLayerId(id) {
  return typeof id === 'string' && PORTOLAN_RIBBON_LAYER_ID_RE.test(id);
}

function sequenceLike(source, values) {
  if (Array.isArray(source)) return values;
  if (ArrayBuffer.isView(source)) return new source.constructor(values);
  return values;
}

function portolanBinaryPathData(value) {
  const startIndices = value?.startIndices;
  const attributes = value?.attributes;
  const path = attributes?.getPath;
  if (!value || typeof value !== 'object'
    || !Number.isSafeInteger(value.length) || value.length < 0
    || (!Array.isArray(startIndices) && !ArrayBuffer.isView(startIndices))
    || startIndices.length !== value.length + 1
    || (!Array.isArray(path?.value) && !ArrayBuffer.isView(path?.value))
    || Number(path?.size) !== 2) return null;
  const vertexCount = Number(startIndices[startIndices.length - 1]);
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 0 || path.value.length < vertexCount * 2) return null;
  return { source: value, startIndices, attributes, path, vertexCount };
}

function sampleBinaryAttribute(attribute, vertexIndex) {
  const source = attribute?.value;
  const size = Number(attribute?.size);
  if ((!Array.isArray(source) && !ArrayBuffer.isView(source))
    || !Number.isSafeInteger(size) || size < 1) return null;
  const left = Math.max(0, Math.floor(vertexIndex));
  const right = Math.min(Math.ceil(vertexIndex), Math.floor(source.length / size) - 1);
  const ratio = Math.max(0, Math.min(1, vertexIndex - left));
  const values = [];
  for (let component = 0; component < size; component += 1) {
    const leftValue = Number(source[left * size + component]);
    const rightValue = Number(source[right * size + component]);
    values.push(leftValue + (rightValue - leftValue) * ratio);
  }
  return values;
}

function clipPortolanBinaryPaths(binary, virtualization) {
  const haloBounds = virtualization?.haloBounds;
  if (!Array.isArray(haloBounds)) return binary.source;
  const outputStarts = [0];
  const outputValues = Object.fromEntries(Object.entries(binary.attributes).map(([key]) => [key, []]));
  let outputVertexCount = 0;
  let outputFeatureCount = 0;
  for (let featureIndex = 0; featureIndex < binary.source.length; featureIndex += 1) {
    const start = Number(binary.startIndices[featureIndex]);
    const end = Number(binary.startIndices[featureIndex + 1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end - start < 2) continue;
    const coordinates = [];
    const sourceIndices = [];
    for (let vertexIndex = start; vertexIndex < end; vertexIndex += 1) {
      coordinates.push([
        Number(binary.path.value[vertexIndex * 2]),
        Number(binary.path.value[vertexIndex * 2 + 1]),
      ]);
      sourceIndices.push(vertexIndex);
    }
    const pieces = clipLineStringWithValues(coordinates, sourceIndices, haloBounds);
    for (const piece of pieces) {
      for (let pointIndex = 0; pointIndex < piece.coordinates.length; pointIndex += 1) {
        const sourceVertex = piece.values[pointIndex];
        for (const [key, attribute] of Object.entries(binary.attributes)) {
          const sampled = key === 'getPath'
            ? piece.coordinates[pointIndex]
            : sampleBinaryAttribute(attribute, sourceVertex);
          if (sampled) outputValues[key].push(...sampled);
        }
      }
      outputVertexCount += piece.coordinates.length;
      outputFeatureCount += 1;
      outputStarts.push(outputVertexCount);
    }
  }
  const attributes = Object.fromEntries(Object.entries(binary.attributes).map(([key, attribute]) => [
    key,
    outputValues[key].length
      ? { ...attribute, value: sequenceLike(attribute.value, outputValues[key]) }
      : { ...attribute, value: sequenceLike(attribute.value, []) },
  ]));
  return {
    ...binary.source,
    length: outputFeatureCount,
    startIndices: sequenceLike(binary.startIndices, outputStarts),
    attributes,
  };
}

function interlinedSourceParts(feature) {
  const geometry = feature?.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  const coordinateParts = geometry.type === 'LineString'
    ? [geometry.coordinates]
    : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
  if (!coordinateParts.length) return [];
  const rawOffsets = feature?.properties?.offset;
  const nestedOffsets = Array.isArray(rawOffsets)
    && rawOffsets.length === coordinateParts.length
    && rawOffsets.every((value) => Array.isArray(value) || ArrayBuffer.isView(value));
  let flatIndex = 0;
  return coordinateParts.map((coordinates, index) => {
    let offsets;
    if (nestedOffsets) offsets = Array.from(rawOffsets[index], Number);
    else if ((Array.isArray(rawOffsets) || ArrayBuffer.isView(rawOffsets))
      && rawOffsets.length >= flatIndex + coordinates.length) {
      offsets = Array.from(rawOffsets).slice(flatIndex, flatIndex + coordinates.length).map(Number);
    } else {
      offsets = coordinates.map(() => 0);
    }
    flatIndex += coordinates.length;
    return { coordinates, offsets };
  });
}

function clipInterlinedFeatures(features, virtualization) {
  const haloBounds = virtualization?.haloBounds;
  return features.flatMap((feature) => {
    const parts = interlinedSourceParts(feature);
    if (!parts.length) {
      const rendered = virtualization?.presentation?.(feature, { clip: true });
      return rendered == null ? [] : [rendered];
    }
    return parts.flatMap(({ coordinates, offsets }) => (
      clipLineStringWithValues(coordinates, offsets, haloBounds).map((piece) => ({
        ...feature,
        properties: { ...(feature.properties ?? {}), offset: piece.values },
        geometry: {
          ...feature.geometry,
          type: 'LineString',
          coordinates: piece.coordinates,
        },
      }))
    ));
  });
}

function snapshotInterlinedValue(value) {
  // Native interlining mutates retained GeoJSON arrays in place. Keep an
  // allocation-free-on-hit snapshot comparison so those mutations invalidate
  // clipping without paying the much larger clip/materialization cost on
  // every hover or simulation update.
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return Array.from(value, (entry) => snapshotInterlinedValue(entry));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).map((key) => [key, snapshotInterlinedValue(value[key])]),
  );
}

function sameInterlinedSnapshotValue(value, snapshot) {
  if (Object.is(value, snapshot)) return true;
  const valueIsSequence = Array.isArray(value) || ArrayBuffer.isView(value);
  const snapshotIsSequence = Array.isArray(snapshot) || ArrayBuffer.isView(snapshot);
  if (valueIsSequence || snapshotIsSequence) {
    if (!valueIsSequence || !snapshotIsSequence || value.length !== snapshot.length) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!sameInterlinedSnapshotValue(value[index], snapshot[index])) return false;
    }
    return true;
  }
  if (!value || !snapshot || typeof value !== 'object' || typeof snapshot !== 'object') {
    return false;
  }
  const valueKeys = Object.keys(value);
  const snapshotKeys = Object.keys(snapshot);
  return valueKeys.length === snapshotKeys.length
    && valueKeys.every((key) => Object.hasOwn(snapshot, key)
      && sameInterlinedSnapshotValue(value[key], snapshot[key]));
}

const MOVEMENT_SPATIAL_UNCACHEABLE = Symbol('movement-spatial-uncacheable');
const MOVEMENT_SPATIAL_KEEP = Symbol('movement-spatial-keep');
const MOVEMENT_SPATIAL_DROP = Symbol('movement-spatial-drop');
const MOVEMENT_SPATIAL_KIND_KEEP = 0;
const MOVEMENT_SPATIAL_KIND_DROP = 1;
const MOVEMENT_SPATIAL_KIND_POINT = 2;

function movementSpatialPoint(value) {
  if (value == null) return MOVEMENT_SPATIAL_DROP;
  if (typeof value !== 'object') return MOVEMENT_SPATIAL_KEEP;

  const directGeometry = value.type && value.coordinates ? value : null;
  const geometry = directGeometry
    ?? (value.geometry?.coordinates ? value.geometry : null)
    ?? (value.feature?.geometry?.coordinates ? value.feature.geometry : null);
  if (geometry) {
    return geometry.type === 'Point'
      ? geometry.coordinates
      : MOVEMENT_SPATIAL_UNCACHEABLE;
  }
  if (Array.isArray(value.coordinates)
    && value.coordinates.some((coordinate) => Array.isArray(coordinate))) {
    return MOVEMENT_SPATIAL_UNCACHEABLE;
  }

  const point = value.coords ?? value.center ?? value.position ?? value.lngLat;
  if (Array.isArray(point)) {
    if (Array.isArray(point[0])) return MOVEMENT_SPATIAL_UNCACHEABLE;
    if (point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))) {
      return point;
    }
  } else if (point && typeof point === 'object'
    && Number.isFinite(Number(point.lng)) && Number.isFinite(Number(point.lat))) {
    return point;
  }

  const line = value.path ?? value.line ?? value.centerLine ?? value.trackPath;
  if (Array.isArray(line)) return MOVEMENT_SPATIAL_UNCACHEABLE;
  return MOVEMENT_SPATIAL_KEEP;
}

function movementPointInVirtualization(x, y, virtualization) {
  const haloBounds = virtualization?.haloBounds;
  if (!Array.isArray(haloBounds) || !haloBounds.length) return true;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return haloBounds.some((bounds) => (
    x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3]
  ));
}

function movementSpatialSnapshot(source, virtualization) {
  // Movement layers are point clouds in the native renderer. Index only the
  // fields that can affect halo membership: two numeric coordinates and two
  // one-byte flags per item. Arbitrary feature properties are intentionally
  // neither cloned nor inspected.
  const kinds = new Uint8Array(source.length);
  const coordinates = new Float64Array(source.length * 2);
  const included = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    const point = movementSpatialPoint(source[index]);
    if (point === MOVEMENT_SPATIAL_UNCACHEABLE) return null;
    if (point === MOVEMENT_SPATIAL_KEEP) {
      kinds[index] = MOVEMENT_SPATIAL_KIND_KEEP;
      included[index] = 1;
      continue;
    }
    if (point === MOVEMENT_SPATIAL_DROP) {
      kinds[index] = MOVEMENT_SPATIAL_KIND_DROP;
      continue;
    }
    const x = Number(Array.isArray(point) ? point[0] : point.lng);
    const y = Number(Array.isArray(point) ? point[1] : point.lat);
    kinds[index] = MOVEMENT_SPATIAL_KIND_POINT;
    coordinates[index * 2] = x;
    coordinates[index * 2 + 1] = y;
    included[index] = movementPointInVirtualization(x, y, virtualization) ? 1 : 0;
  }
  return { kinds, coordinates, included };
}

function movementSpatialSourceMatches(source, snapshot) {
  if (!snapshot || source.length !== snapshot.kinds.length) return false;
  for (let index = 0; index < source.length; index += 1) {
    const point = movementSpatialPoint(source[index]);
    const kind = point === MOVEMENT_SPATIAL_KEEP
      ? MOVEMENT_SPATIAL_KIND_KEEP
      : point === MOVEMENT_SPATIAL_DROP
        ? MOVEMENT_SPATIAL_KIND_DROP
        : point === MOVEMENT_SPATIAL_UNCACHEABLE
          ? -1
          : MOVEMENT_SPATIAL_KIND_POINT;
    if (kind !== snapshot.kinds[index]) return false;
    if (kind !== MOVEMENT_SPATIAL_KIND_POINT) continue;
    const x = Number(Array.isArray(point) ? point[0] : point.lng);
    const y = Number(Array.isArray(point) ? point[1] : point.lat);
    const coordinateIndex = index * 2;
    if (!Object.is(x, snapshot.coordinates[coordinateIndex])
      || !Object.is(y, snapshot.coordinates[coordinateIndex + 1])) {
      return false;
    }
  }
  return true;
}

function filterMovementSpatialSource(source, snapshot) {
  const filtered = [];
  for (let index = 0; index < source.length; index += 1) {
    if (snapshot.included[index]) filtered.push(source[index]);
  }
  return filtered;
}

function sameNativeLayerValue(previous, current) {
  if (Array.isArray(previous) || Array.isArray(current)) {
    return Array.isArray(previous)
      && Array.isArray(current)
      && previous.length === current.length
      && previous.every((value, index) => sameNativeLayerValue(value, current[index]));
  }
  if (previous === current) {
    const layerId = previous?.id ?? previous?.props?.id ?? null;
    return !isVolatileRailLayerId(layerId) && !isMovementLayerId(layerId);
  }
  if (!previous || !current || typeof previous !== 'object' || typeof current !== 'object') return false;
  const previousId = previous.id ?? previous.props?.id ?? null;
  const currentId = current.id ?? current.props?.id ?? null;
  if (previousId !== currentId || previous.count !== current.count) return false;
  if (isVolatileRailLayerId(currentId) || isMovementLayerId(currentId)) return false;
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
  const detailVisibility = isMovementLayerId(layerId)
    ? `|movement:${isDetailedMovementZoom(zoom)}`
    : isRoadDeckLayerId(layerId)
      ? `|road:${isDetailedRoadZoom(layerId, zoom)}`
      : '';
  return `${virtualizationSignature(virtualization)}|overview:${isLowZoomOverview(zoom)}${detailVisibility}`;
}

function maskMovementDeckLayers(
  layers,
  zoom,
  virtualization,
  spatialCache = null,
  layerCache = null,
  movementCache = null,
  interliningCache = null,
  interliningRevision = null,
  volatilePassCache = null,
) {
  const resolvedVolatilePassCache = volatilePassCache ?? new Map();
  if (Array.isArray(layers)) {
    return layers.map((layer) => maskMovementDeckLayers(
      layer,
      zoom,
      virtualization,
      spatialCache,
      layerCache,
      movementCache,
      interliningCache,
      interliningRevision,
      resolvedVolatilePassCache,
    ));
  }
  if (!layers || typeof layers !== 'object') return layers;
  const layerId = layers?.id ?? layers?.props?.id ?? null;
  const isMovement = isMovementLayerId(layerId);
  const isRoad = isRoadDeckLayerId(layerId);
  const isRailLine = isRailLineLayerId(layerId);
  const isVolatileRail = isVolatileRailLayerId(layerId);
  const isPortolanRibbon = isPortolanRibbonLayerId(layerId);
  const isStationDeckLayer = typeof layerId === 'string' && STATION_DECK_LAYER_ID_RE.test(layerId);
  const hiddenByOverview = isLowZoomOverview(zoom) && !isRailLine;
  if (!isMovement && !isRoad && !hiddenByOverview && !virtualization) return layers;
  const overrides = {};
  const dataEntry = layerData(layers);
  const [, source] = dataEntry ?? [];
  const portolanBinary = isPortolanRibbon ? portolanBinaryPathData(layers?.props?.data) : null;
  const maskSignature = virtualization
    ? layerMaskSignature(layerId, zoom, virtualization)
    : null;
  const cachedLayer = layerCache?.get(layerId);
  if (
    dataEntry
    && virtualization
    && !isVolatileRail
    && !isMovement
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
  if (portolanBinary && virtualization) {
    const cached = spatialCache?.get(portolanBinary.source);
    const cacheHit = cached?.signature === maskSignature
      && cached?.interliningRevision === interliningRevision;
    const renderedData = cacheHit
      ? cached.renderedData
      : mapMovePerfMeasure(
        'deck.interlining.clip',
        () => clipPortolanBinaryPaths(portolanBinary, virtualization),
        {
          layerId,
          sourceCount: portolanBinary.source.length,
          haloBounds: virtualization?.haloBounds?.length ?? 0,
        },
      );
    if (!cacheHit) spatialCache?.set(portolanBinary.source, {
      signature: maskSignature,
      interliningRevision,
      renderedData,
    });
    overrides.data = renderedData;
  }
  if (dataEntry && virtualization) {
    const [dataShape, source, sourceContainer] = dataEntry;
    const signature = virtualizationSignature(virtualization);
    let cached = spatialCache?.get(source);
    let cacheHit = cached?.signature === signature;
    let interliningPassKey = null;
    let currentMovementSnapshot = null;
    let movementContentHit = false;
    if (isMovement) {
      const movementCacheKey = String(layerId).toLowerCase();
      const movementCached = movementCache?.get(movementCacheKey);
      if (movementCached?.signature === signature && movementCached?.dataShape === dataShape) {
        movementContentHit = mapMovePerfMeasure(
          'deck.spatial.compare',
          () => movementSpatialSourceMatches(source, movementCached.movementSpatialSnapshot),
          { layerId, sourceCount: source.length },
        );
        if (movementContentHit) {
          currentMovementSnapshot = movementCached.movementSpatialSnapshot;
        }
      }
      cached = movementContentHit ? movementCached : null;
      cacheHit = movementContentHit;
    } else if (isVolatileRail) {
      const layerCacheKey = String(layerId).toLowerCase();
      interliningPassKey = layerCacheKey.replace(/-under$/i, '');
      const passCached = resolvedVolatilePassCache.get(interliningPassKey);
      const layerCached = interliningCache?.get(layerCacheKey);
      const sourceMatches = (entry) => interliningRevision != null
        ? entry?.interliningRevision === interliningRevision
        : mapMovePerfMeasure(
          'deck.interlining.compare',
          () => sameInterlinedSnapshotValue(source, entry.sourceSnapshot),
          { layerId, sourceCount: source.length },
        );
      const spatialCached = cached;
      cached = null;
      if (passCached?.signature === signature
        && (passCached.source === source || sourceMatches(passCached))) {
        cached = passCached;
      } else if (layerCached?.signature === signature && sourceMatches(layerCached)) {
        cached = layerCached;
      } else if (spatialCached !== layerCached
        && spatialCached?.signature === signature
        && sourceMatches(spatialCached)) {
        cached = spatialCached;
      }
      cacheHit = cached != null;
    }
    const filtered = movementContentHit
      ? mapMovePerfMeasure(
        'deck.spatial.reuse',
        () => filterMovementSpatialSource(source, currentMovementSnapshot),
        { layerId, sourceCount: source.length },
      )
      : cacheHit
        ? cached.data
        : mapMovePerfMeasure(
          isVolatileRail ? 'deck.interlining.clip' : 'deck.spatial.clip',
          () => {
            if (isVolatileRail) return clipInterlinedFeatures(source, virtualization);
            if (isMovement) {
              currentMovementSnapshot ??= movementSpatialSnapshot(source, virtualization);
              if (currentMovementSnapshot) {
                return filterMovementSpatialSource(source, currentMovementSnapshot);
              }
            }
            return virtualization.renderInputs({ features: source }, { clip: true }).features;
          },
          {
            layerId,
            sourceCount: source.length,
            haloBounds: virtualization?.haloBounds?.length ?? 0,
          },
        );
    const renderedData = cacheHit && !movementContentHit
      ? cached.renderedData
      : dataShape.endsWith('feature-collection')
        ? { ...sourceContainer, features: filtered }
        : filtered;
    const cacheEntry = cacheHit && !movementContentHit ? cached : {
      signature,
      source,
      dataShape,
      data: filtered,
      renderedData,
      ...(isVolatileRail ? {
        interliningRevision,
        sourceSnapshot: interliningRevision == null ? snapshotInterlinedValue(source) : null,
      } : isMovement ? {
        movementSpatialSnapshot: currentMovementSnapshot,
      } : {}),
    };
    spatialCache?.set(source, cacheEntry);
    if (isMovement) movementCache?.set(String(layerId).toLowerCase(), cacheEntry);
    if (isVolatileRail) {
      interliningCache?.set(String(layerId).toLowerCase(), cacheEntry);
      // Native updates may recreate separate but equivalent arrays for the
      // under/over pair. Share the first content-matched result within a pass.
      resolvedVolatilePassCache.set(interliningPassKey, cacheEntry);
    }
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
    // Preserve highway context while progressively admitting the much larger
    // major/minor road families as the camera approaches street level.
    overrides.visible = nativeVisible && isDetailedRoadZoom(layerId, zoom);
  }
  if (hiddenByOverview) {
    overrides.visible = false;
  }
  if (isStationDeckLayer && !isDetailedMovementZoom(zoom)) {
    overrides.visible = false;
  }
  const maskedLayer = Object.keys(overrides).length ? cloneLayerWithOverrides(layers, overrides) : layers;
  if (
    dataEntry
    && virtualization
    && layerCache
    && layerId != null
    && !isVolatileRail
    && reusableDeckLayer(layers)
  ) {
    layerCache.set(layerId, {
      source,
      signature: maskSignature,
      inputLayer: layers,
      layer: maskedLayer,
    });
  } else if (isVolatileRail) {
    layerCache?.delete(layerId);
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
    const source = safeMapSource(map, sourceId);
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
          const filtered = mapMovePerfMeasure(
            'maplibre.spatial-source.clip',
            () => virtualizeGeoJsonData(data, virtualization, { clip: true }),
            { sourceId, inputCount: toolboxRenderFeatureCount(data) },
          );
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
          return mapMovePerfMeasure(
            'maplibre.spatial-source.setData',
            () => patch.originalSetData.call(this, filtered),
            { sourceId, outputCount: toolboxRenderFeatureCount(filtered) },
          );
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

function movementDeckVisibilitySignature(zoom, virtualization, interliningRevision = null) {
  return `${virtualizationSignature(virtualization)}|overview:${isLowZoomOverview(zoom)}`
    + `|detailed:${isDetailedMovementZoom(zoom)}`
    + `|roads:${roadVisibilityBand(zoom)}`
    + `|interlining:${interliningRevision ?? 'unknown'}`;
}

function applyMovementDeckVisibility(deck, { force = false } = {}) {
  return mapMovePerfMeasure('deck.apply.total', () => {
    const patch = deck?.[MOVEMENT_DECK_GUARD_KEY];
    if (!patch || patch.nativeLayers == null) return undefined;
    const zoom = patch.map?.getZoom?.();
    const virtualization = patch.virtualizationProvider?.();
    const interliningRevision = patch.interliningRevisionProvider?.() ?? null;
    const signature = movementDeckVisibilitySignature(zoom, virtualization, interliningRevision);
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
    const maskedLayers = mapMovePerfMeasure(
      'deck.mask-layers',
      () => maskMovementDeckLayers(
        patch.nativeLayers,
        zoom,
        virtualization,
        patch.spatialCache,
        patch.layerCache,
        patch.movementCache,
        patch.interliningCache,
        interliningRevision,
      ),
      { layerCount: Array.isArray(patch.nativeLayers) ? patch.nativeLayers.length : null, force },
    );
    patch.lastAppliedNativeLayers = patch.nativeLayers;
    patch.lastAppliedSignature = signature;
    patch.lastAppliedLayers = maskedLayers;
    mapMovePerfMeasure(
      'deck.native-setProps',
      () => patch.originalSetProps.call(deck, { layers: maskedLayers }),
      { source: 'apply', layerCount: Array.isArray(maskedLayers) ? maskedLayers.length : null },
    );
    return maskedLayers;
  }, { force });
}

function installMovementDeckVisibilityGuard(
  map,
  owner,
  virtualizationProvider,
  interliningRevisionProvider,
) {
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
  let initialNativeLayers = deck.props?.layers;
  let initialOriginalSetProps = deck.setProps;
  if (patch?.version !== MOVEMENT_DECK_GUARD_VERSION) {
    initialNativeLayers = patch?.nativeLayers ?? initialNativeLayers;
    initialOriginalSetProps = patch?.originalSetProps ?? initialOriginalSetProps;
    if (patch && deck.props?.onError === patch.errorWrapper && typeof initialOriginalSetProps === 'function') {
      initialOriginalSetProps.call(deck, { onError: patch.nativeOnError });
    }
    if (deck.setProps === patch?.wrapper) deck.setProps = initialOriginalSetProps;
    try { delete deck[MOVEMENT_DECK_GUARD_KEY]; } catch {}
    patch = null;
  }
  const reused = Boolean(patch);
  if (!patch) {
    patch = {
      version: MOVEMENT_DECK_GUARD_VERSION,
      map,
      owners: new Set(),
      nativeLayers: initialNativeLayers,
      originalSetProps: initialOriginalSetProps,
      virtualizationProvider,
      interliningRevisionProvider,
      spatialCache: new WeakMap(),
      layerCache: new Map(),
      movementCache: new Map(),
      interliningCache: new Map(),
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
        const interliningRevision = patch.interliningRevisionProvider?.() ?? null;
        railClipDebugLog('deck-setProps', () => ({
          call: patch.debugSetPropsCalls,
          layerCount: Array.isArray(nextProps.layers) ? nextProps.layers.length : null,
          layers: Array.isArray(nextProps.layers)
            ? nextProps.layers.map(railClipLayerSummary)
            : { type: typeof nextProps.layers },
        }), { key: 'deck-setProps', every: 30 });
        const signature = movementDeckVisibilitySignature(zoom, virtualization, interliningRevision);
        const canReuseMaskedTree = patch.lastAppliedSignature === signature
          && patch.lastAppliedLayers != null
          && sameNativeLayerTree(patch.lastAppliedNativeLayers, nextProps.layers);
        const maskedLayers = canReuseMaskedTree
          ? patch.lastAppliedLayers
          : mapMovePerfMeasure(
            'deck.mask-layers',
            () => maskMovementDeckLayers(
              nextProps.layers,
              zoom,
              virtualization,
              patch.spatialCache,
              patch.layerCache,
              patch.movementCache,
              patch.interliningCache,
              interliningRevision,
            ),
            {
              source: 'native-setProps',
              layerCount: Array.isArray(nextProps.layers) ? nextProps.layers.length : null,
            },
          );
        patch.lastAppliedNativeLayers = nextProps.layers;
        patch.lastAppliedSignature = signature;
        patch.lastAppliedLayers = maskedLayers;
        forwarded = {
          ...forwarded,
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
      const result = mapMovePerfMeasure(
        'deck.native-setProps',
        () => patch.originalSetProps.call(this, forwarded),
        {
          source: 'native-setProps',
          hasLayers: Object.hasOwn(forwarded, 'layers'),
          layerCount: Array.isArray(forwarded.layers) ? forwarded.layers.length : null,
        },
      );
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
  patch.interliningRevisionProvider = interliningRevisionProvider;
  patch.spatialCache ??= new WeakMap();
  patch.movementCache ??= new Map();
  patch.interliningCache ??= new Map();
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
  if (patch.nativeLayers != null) {
    patch.originalSetProps.call(deck, { layers: patch.nativeLayers });
  }
  delete deck[MOVEMENT_DECK_GUARD_KEY];
}

function replaceGeographicContextControllerOwner(map, controller) {
  if (!map) return;
  const superseded = new Set();
  const registered = map[GEOGRAPHIC_CONTEXT_CONTROLLER_KEY];
  if (registered && registered !== controller) superseded.add(registered);
  for (const owner of map.__deck?.[MOVEMENT_DECK_GUARD_KEY]?.owners ?? []) {
    if (owner && owner !== controller) superseded.add(owner);
  }
  for (const owner of superseded) owner.dispose?.();
  try {
    Object.defineProperty(map, GEOGRAPHIC_CONTEXT_CONTROLLER_KEY, {
      configurable: true,
      writable: true,
      value: controller,
    });
  } catch {
    try { map[GEOGRAPHIC_CONTEXT_CONTROLLER_KEY] = controller; } catch {}
  }
}

function worldContextSourceDefinition(map, worldContextTilesUrl) {
  const serialized = safeMapStyle(map)?.sources?.['general-tiles'];
  const source = safeMapSource(map, 'general-tiles');
  const tiles = worldContextTilesUrl ? [worldContextTilesUrl] : source?.tiles ?? source?._options?.tiles ?? serialized?.tiles;
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

function safeMapStyle(map) {
  try { return map?.getStyle?.() ?? null; } catch { return null; }
}

function safeMapSource(map, sourceId) {
  try { return map?.getSource?.(sourceId) ?? null; } catch { return null; }
}

function mapStyleLoaded(map) {
  // MapLibre's public isStyleLoaded includes every source's pending requests.
  // Its layer/source mutation guard checks only Style._loaded. Keep this
  // compatibility seam narrow: never block overview restoration on city data
  // or the vegetation worker, but still reject an unparsed replacement style.
  try {
    if (typeof map?.style?._loaded === 'boolean') return map.style._loaded;
    return Boolean(map?.isStyleLoaded?.());
  } catch { return false; }
}

function contextArtifactsMissing(map) {
  if (!map) return false;
  try {
    return [WORLD_OCEAN_LAYER_ID, TILE_SELECTION_LAYER_ID, TILE_BOUNDARY_LAYER_ID]
      .some((id) => !map.getLayer?.(id))
      || (safeMapSource(map, WORLD_CONTEXT_SOURCE_ID)
        && [WORLD_LAND_LAYER_ID, WORLD_LAND_HIGH_ZOOM_LAYER_ID].some((id) => !map.getLayer?.(id)));
  } catch { return true; }
}

function ensureWorldContextSource(map, worldContextTilesUrl) {
  const definition = worldContextSourceDefinition(map, worldContextTilesUrl);
  if (!definition) return false;
  const existing = safeMapSource(map, WORLD_CONTEXT_SOURCE_ID);
  if (existing) {
    const serialized = safeMapStyle(map)?.sources?.[WORLD_CONTEXT_SOURCE_ID];
    const tiles = existing.tiles ?? existing._options?.tiles ?? serialized?.tiles;
    const maxzoom = existing.maxzoom ?? existing._options?.maxzoom ?? serialized?.maxzoom;
    if (JSON.stringify(tiles) === JSON.stringify(definition.tiles)
      && (definition.tiles || (existing.url ?? existing._options?.url ?? serialized?.url) === definition.url)
      && maxzoom === definition.maxzoom) return true;
    // A retained source may still point at a city-only archive. Remove its
    // dependent layers before replacing it; the refresh recreates them below
    // native map content with the current definition.
    for (const layer of safeMapStyle(map)?.layers ?? []) {
      if (layer.source === WORLD_CONTEXT_SOURCE_ID) map.removeLayer?.(layer.id);
    }
    map.removeSource?.(WORLD_CONTEXT_SOURCE_ID);
  }
  try { map.addSource?.(WORLD_CONTEXT_SOURCE_ID, definition); } catch {}
  return Boolean(safeMapSource(map, WORLD_CONTEXT_SOURCE_ID));
}

function ensureArtifacts(map, worldContextTilesUrl, worldVegetationData = null) {
  map.__openWorldWorldContextVersion = WORLD_CONTEXT_VERSION;
  map.__openWorldWorldContextRestoreVersion = WORLD_CONTEXT_RESTORE_VERSION;
  const theme = readWorldContextTheme(map);
  const worldLayerIds = new Set([
    WORLD_WATER_BACKGROUND_LAYER_ID,
    WORLD_VEGETATION_LAYER,
    WORLD_OCEAN_LAYER_ID,
    WORLD_LAND_LAYER_ID,
    WORLD_LAND_HIGH_ZOOM_LAYER_ID,
    WORLD_BOUNDARY_LAYER_ID,
    WORLD_BOUNDARY_HIGH_ZOOM_LAYER_ID,
    TILE_SELECTION_LAYER_ID,
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
  if (!safeMapSource(map, WORLD_OCEAN_SOURCE_ID)) {
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
      paint: { 'fill-color': theme.water, 'fill-opacity': 1 },
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
  const hasWorldContextSource = ensureWorldContextSource(map, worldContextTilesUrl);
  const worldSourceId = hasWorldContextSource ? WORLD_CONTEXT_SOURCE_ID : 'general-tiles';
  const existingWorldLand = map.getLayer?.(WORLD_LAND_LAYER_ID);
  if (existingWorldLand && existingWorldLand.source !== worldSourceId) {
    try { map.removeLayer?.(WORLD_LAND_LAYER_ID); } catch {}
  }
  if (safeMapSource(map, worldSourceId) && !map.getLayer?.(WORLD_LAND_LAYER_ID)) {
    map.addLayer?.({
      id: WORLD_LAND_LAYER_ID,
      type: 'fill',
      source: worldSourceId,
      'source-layer': 'world_land',
      maxzoom: STATION_MARKER_MIN_ZOOM,
      paint: { 'fill-color': theme.land, 'fill-opacity': 1 },
    }, firstNativeContentLayer);
  }
  if (hasWorldContextSource && !map.getLayer?.(WORLD_LAND_HIGH_ZOOM_LAYER_ID)) {
    map.addLayer?.({
      id: WORLD_LAND_HIGH_ZOOM_LAYER_ID,
      type: 'fill',
      source: WORLD_CONTEXT_SOURCE_ID,
      'source-layer': 'world_land',
      minzoom: STATION_MARKER_MIN_ZOOM,
      maxzoom: GEOGRAPHIC_CONTEXT_MAX_ZOOM,
      paint: { 'fill-color': theme.land, 'fill-opacity': 1 },
    }, firstNativeContentLayer);
  }
  syncWorldContextTheme(map);
  // These moves are intentional on every refresh: a hot reload may inherit
  // old ordering. Ocean must be below land, but both must cover the native
  // background and remain below ALL native content, including native land
  // fills and interleaved Deck layers, as well as water/road/rail layers.
  try { map.moveLayer?.(WORLD_OCEAN_LAYER_ID, firstNativeContentLayer); } catch {}
  try { map.moveLayer?.(WORLD_LAND_LAYER_ID, firstNativeContentLayer); } catch {}
  try { map.moveLayer?.(WORLD_LAND_HIGH_ZOOM_LAYER_ID, firstNativeContentLayer); } catch {}
  ensureWorldVegetation(map, worldVegetationData, firstNativeContentLayer);

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
  const existingWorldBoundary = map.getLayer?.(WORLD_BOUNDARY_LAYER_ID);
  if (existingWorldBoundary && existingWorldBoundary.source !== worldSourceId) {
    try { map.removeLayer?.(WORLD_BOUNDARY_LAYER_ID); } catch {}
  }
  if (safeMapSource(map, worldSourceId) && !map.getLayer?.(WORLD_BOUNDARY_LAYER_ID)) {
    const labelLayer = cityLabelLayers[0]?.id;
    map.addLayer?.({
      id: WORLD_BOUNDARY_LAYER_ID,
      type: 'line',
      source: worldSourceId,
      'source-layer': 'world_boundaries',
      minzoom: 1,
      maxzoom: STATION_MARKER_MIN_ZOOM,
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

  if (!safeMapSource(map, BOUNDARY_SOURCE_ID)) {
    map.addSource?.(BOUNDARY_SOURCE_ID, { type: 'geojson', data: EMPTY });
  }

  if (!map.getLayer?.(TILE_SELECTION_LAYER_ID)) {
    map.addLayer?.({
      id: TILE_SELECTION_LAYER_ID,
      type: 'fill',
      source: BOUNDARY_SOURCE_ID,
      maxzoom: STATION_MARKER_MIN_ZOOM,
      paint: {
        'fill-color': '#ffd166',
        'fill-opacity': ['case', ['boolean', ['get', 'hovered'], false], 0.28, 0],
      },
    });
  }

  if (!map.getLayer?.(TILE_BOUNDARY_LAYER_ID)) {
    map.addLayer?.({
      id: TILE_BOUNDARY_LAYER_ID,
      type: 'line',
      source: BOUNDARY_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': [
          'case',
          ['any',
            ['boolean', ['get', 'active'], false],
            ['boolean', ['get', 'hovered'], false],
          ],
          '#ffd166',
          '#79b8e8',
        ],
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
  constructor({
    runtime,
    tileCatalog,
    onTileSelect = null,
    worldContextTilesUrl = null,
    nativeParkSourceLayer = 'parks',
    worldVegetationLoader = null,
    renderDistance = 3,
    renderDistanceStorage = globalThis.localStorage,
    renderDistanceStorageKey = 'open-world:render-distance',
  }) {
    this.runtime = runtime;
    this.tileCatalog = tileCatalog;
    this.onTileSelect = onTileSelect;
    this.worldContextTilesUrl = worldContextTilesUrl;
    this.nativeParkSourceLayer = nativeParkSourceLayer;
    this.worldVegetationLoader = worldVegetationLoader;
    this.worldVegetationData = null;
    this.worldVegetationPromise = null;
    this.renderDistanceStorage = renderDistanceStorage;
    this.renderDistanceStorageKey = renderDistanceStorageKey;
    let persistedRenderDistance = null;
    try {
      persistedRenderDistance = renderDistanceStorage?.getItem?.(renderDistanceStorageKey) ?? null;
    } catch {}
    this.renderDistance = normalizeRenderDistance(persistedRenderDistance ?? renderDistance);
    this.renderDistanceListeners = new Set();
    this.tileIds = new Set((tileCatalog?.tiles ?? []).map((tile) => tile.id));
    this.runtimeActiveTileId = this.readRuntimeActiveTileId();
    this.map = null;
    this.tileSelectionMap = null;
    this.hoveredTileId = null;
    this.switchingTileId = null;
    this.movementDeck = null;
    this.stationMarkerVisibility = null;
    this.rendererVirtualization = null;
    this.spatialSourceVisibility = null;
    this.nativeHoverDelegateMap = null;
    this.contextRefreshPending = true;
    this.refreshingContext = false;
    this.handleIdle = () => this.retryContextRefresh();
    this.handleStyle = () => {
      this.boundarySubmission = null;
      this.contextRefreshPending = true;
      const refresh = () => {
        this.refresh();
      };
      globalThis.requestAnimationFrame?.(refresh) ?? refresh();
    };
    this.handleZoom = () => mapMovePerfMeasure('map.zoom.total', () => {
      this.syncTileBoundaryData();
      syncNativeHoverDelegateGate(this.map, this);
      mapMovePerfMeasure('marker.visibility', () => updateStationMarkerVisibility(this.map), {
        zoom: this.map?.getZoom?.() ?? null,
      });
      this.stationMarkerVisibility?.updateMovementVisibility?.(
        isDetailedMovementZoom(this.map?.getZoom?.()),
      );
      if (!isWorldTileSelectionZoom(this.map?.getZoom?.())) this.setHoveredTile(null);
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
    }, () => ({ zoom: this.map?.getZoom?.() ?? null }));
    this.handleTilePointerMove = (event) => {
      if (!this.tileSelectionEnabled()) {
        this.setHoveredTile(null);
        return;
      }
      this.setHoveredTile(this.selectableTileIdFromEvent(event));
    };
    this.handleTilePointerLeave = () => this.setHoveredTile(null);
    this.handleTileClick = (event) => {
      if (!this.tileSelectionEnabled() || this.switchingTileId) return;
      const tileId = this.selectableTileIdFromEvent(event);
      if (!tileId) return;
      this.switchingTileId = tileId;
      event?.originalEvent?.preventDefault?.();
      event?.originalEvent?.stopPropagation?.();
      Promise.resolve()
        .then(() => this.onTileSelect(tileId))
        .catch((error) => console.error('[Open World] tile switch failed', error))
        .finally(() => {
          if (this.switchingTileId === tileId) this.switchingTileId = null;
        });
    };
    this.handleStyleData = () => {
      if (this.refreshingContext) return;
      // setStyle can diff away mod layers without another style.load. Also
      // retry a style.load that arrived before native sources finished loading.
      this.retryContextRefresh();
      // Paint edits can arrive while tiles are still loading. Synchronize now,
      // without rebuilding geometry or waiting for isStyleLoaded()/idle.
      syncWorldContextTheme(this.map);
      const refreshMovementRanges = () => {
        if (!mapStyleLoaded(this.map)) return;
        mapMovePerfMeasure('map.styledata.work', () => {
          toolboxRenderDebugLog('styledata', () => toolboxRenderMapSnapshot(
            this.map,
            this.rendererVirtualization,
          ), { key: 'styledata', every: 1, first: 100 });
          applyNativeDetailLayerZoomRanges(this.map);
          if (this.nativeParkSourceLayer === 'landuse') syncNativeParkLanduse(this.map);
          applyRoadLayerZoomRanges(this.map);
          applyMovementLayerZoomRanges(this.map);
          mapMovePerfMeasure(
            'guard.spatial-source.sync',
            () => this.syncSpatialSourceVisibilityGuard(),
          );
          mapMovePerfMeasure(
            'guard.deck.sync',
            () => this.syncMovementDeckVisibilityGuard(),
          );
          syncNativeHoverDelegateGate(this.map, this);
        });
      };
      globalThis.requestAnimationFrame?.(refreshMovementRanges) ?? refreshMovementRanges();
    };
    this.unsubscribeRuntime = runtime?.subscribe?.((_event, view) => {
      this.runtimeActiveTileId = view?.activeTileId ?? this.readRuntimeActiveTileId();
      this.refresh();
    });
  }

  attachMap(map) {
    replaceGeographicContextControllerOwner(map, this);
    if (this.map === map) return this.refresh();
    removeStaleTileSelectionDelegates(map);
    if (this.map) {
      if (globalThis[MAP_MOVE_PERF_PROBES]?.map === this.map) {
        stopMapMovePerfProbes();
        mapMovePerfState().probes = [];
      }
      try { this.map.off('style.load', this.handleStyle); } catch {}
      try { this.map.off('styledata', this.handleStyleData); } catch {}
      try { this.map.off('idle', this.handleIdle); } catch {}
      try { this.map.off('zoom', this.handleZoom); } catch {}
      releaseNativeParkLanduse(this.map);
      releaseWorldVegetation(this.map);
      resumeNativeHoverDelegates(this.map, this, { release: true });
    }
    this.detachTileSelectionHandlers();
    this.releaseMovementDeckVisibilityGuard();
    releaseSpatialSourceVisibilityGuards(this.map);
    this.spatialSourceVisibility = null;
    this.stationMarkerVisibility?.reset?.();
    this.stationMarkerVisibility = null;
    this.map = map;
    this.contextRefreshPending = true;
    this.runtimeActiveTileId = this.readRuntimeActiveTileId();
    this.rendererVirtualization = this.createRendererVirtualization();
    this.nativeHoverDelegateMap = map;
    syncNativeHoverDelegateGate(map, this);
    globalThis.__openWorldToolboxRenderMap = map;
    globalThis.__openWorldToolboxRenderVirtualization = this.rendererVirtualization;
    ensureMapMovePerfProbes();
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
      movementVisible: isDetailedMovementZoom(map?.getZoom?.()),
      onApply: () => toolboxRenderDebugLog('marker-adapter-apply', () => ({
        mapObjectId: toolboxRenderObjectId(map),
        activeTileId: this.rendererVirtualization?.activeTileId ?? null,
        haloTileIds: this.rendererVirtualization?.haloTileIds ?? [],
        markerSnapshot: toolboxRenderMarkerSummary(map, this.rendererVirtualization),
      }), { key: 'marker-adapter-apply', every: 30, first: 5 }),
      measure: mapMovePerfMeasure,
    });
    this.stationMarkerVisibility.apply?.();
    map?.on?.('style.load', this.handleStyle);
    map?.on?.('styledata', this.handleStyleData);
    map?.on?.('idle', this.handleIdle);
    map?.on?.('zoom', this.handleZoom);
    ensureStationMarkerStyle();
    updateStationMarkerVisibility(map);
    applyNativeDetailLayerZoomRanges(map);
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
    if (this.worldVegetationLoader && !this.worldVegetationPromise) {
      this.worldVegetationPromise = this.worldVegetationLoader().then((data) => {
        this.worldVegetationData = data;
        if (this.map) this.refresh();
      }).catch((error) => console.warn('[Open World] vegetation overview unavailable', error));
    }
  }

  retryContextRefresh() {
    if (!this.map || this.refreshingContext) return;
    if (this.contextRefreshPending || contextArtifactsMissing(this.map)
      || (this.worldVegetationData && !this.map.getLayer?.(WORLD_VEGETATION_LAYER))) this.refresh();
  }

  refresh() {
    if (this.refreshingContext) return;
    this.refreshingContext = true;
    try { return this.refreshContext(); }
    finally { this.refreshingContext = false; }
  }

  refreshContext() {
    return mapMovePerfMeasure('overlay.refresh.total', () => {
      this.syncRendererVirtualizationAuthority();
      if (!mapStyleLoaded(this.map)) {
        this.contextRefreshPending = true;
        return;
      }
      this.contextRefreshPending = false;
      ensureStationMarkerStyle();
      globalThis.__openWorldToolboxRenderMap = this.map;
      globalThis.__openWorldToolboxRenderVirtualization = this.rendererVirtualization;
      ensureMapMovePerfProbes();
      railClipDebugLog('map-refresh', {
        activeTileId: this.rendererVirtualization?.activeTileId ?? null,
        haloTileIds: this.rendererVirtualization?.haloTileIds ?? [],
        mapHasDeck: Boolean(this.map?.__deck),
        deckLayerIds: Array.isArray(this.map?.__deck?.props?.layers)
          ? this.map.__deck.props.layers.map((layer) => layer?.id ?? layer?.props?.id ?? null)
          : null,
      }, { key: 'map-refresh', every: 30 });
      this.stationMarkerVisibility?.updateVirtualization?.(this.rendererVirtualization);
      mapMovePerfMeasure('marker.visibility', () => updateStationMarkerVisibility(this.map));
      mapMovePerfMeasure('overlay.layer-ranges', () => {
        applyNativeDetailLayerZoomRanges(this.map);
        applyRoadLayerZoomRanges(this.map);
        applyMovementLayerZoomRanges(this.map);
      });
      mapMovePerfMeasure(
        'guard.spatial-source.sync',
        () => this.syncSpatialSourceVisibilityGuard(),
      );
      mapMovePerfMeasure('guard.deck.sync', () => this.syncMovementDeckVisibilityGuard());
      syncNativeHoverDelegateGate(this.map, this);
      toolboxRenderDebugLog('map-refresh-snapshot', () => toolboxRenderMapSnapshot(
        this.map,
        this.rendererVirtualization,
      ), { key: 'map-refresh-snapshot', every: 1, first: 100 });
      mapMovePerfMeasure('overlay.ensure-artifacts', () => ensureArtifacts(this.map, this.worldContextTilesUrl, this.worldVegetationData));
      if (this.nativeParkSourceLayer === 'landuse') syncNativeParkLanduse(this.map);
      const activeTileId = this.activeTileId();
      if (this.hoveredTileId === activeTileId) this.setHoveredTile(null);
      this.syncTileBoundaryData(activeTileId);
      this.attachTileSelectionHandlers();
    }, () => ({
      zoom: this.map?.getZoom?.() ?? null,
      activeTileId: this.rendererVirtualization?.activeTileId ?? null,
    }));
  }

  detachMap() {
    const attachedMap = this.map;
    if (!attachedMap) return;
    try { attachedMap.off('style.load', this.handleStyle); } catch {}
    try { attachedMap.off('styledata', this.handleStyleData); } catch {}
    try { attachedMap.off('idle', this.handleIdle); } catch {}
    try { attachedMap.off('zoom', this.handleZoom); } catch {}
    releaseNativeParkLanduse(attachedMap);
    releaseWorldVegetation(attachedMap);
    {
      const container = attachedMap.getContainer?.();
      if (container?.dataset) delete container.dataset[STATION_MARKER_VISIBILITY_KEY];
    }
    this.detachTileSelectionHandlers();
    this.stationMarkerVisibility?.reset?.();
    this.stationMarkerVisibility = null;
    releaseSpatialSourceVisibilityGuards(attachedMap);
    this.spatialSourceVisibility = null;
    this.releaseMovementDeckVisibilityGuard();
    if (globalThis[MAP_MOVE_PERF_PROBES]?.map === attachedMap) {
      stopMapMovePerfProbes();
      mapMovePerfState().probes = [];
    }
    resumeNativeHoverDelegates(this.nativeHoverDelegateMap, this, { release: true });
    this.nativeHoverDelegateMap = null;
    if (globalThis.__openWorldToolboxRenderMap === attachedMap) {
      delete globalThis.__openWorldToolboxRenderMap;
      delete globalThis.__openWorldToolboxRenderVirtualization;
    }
    if (attachedMap?.[GEOGRAPHIC_CONTEXT_CONTROLLER_KEY] === this) {
      try { delete attachedMap[GEOGRAPHIC_CONTEXT_CONTROLLER_KEY]; } catch {}
    }
    this.map = null;
  }

  dispose() {
    this.detachMap();
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.renderDistanceListeners.clear();
  }

  getRenderDistance() {
    return this.renderDistance;
  }

  subscribeRenderDistance(listener) {
    this.renderDistanceListeners.add(listener);
    return () => this.renderDistanceListeners.delete(listener);
  }

  setRenderDistance(value) {
    const next = normalizeRenderDistance(value);
    if (next === this.renderDistance) return this.renderDistance;
    this.renderDistance = next;
    try { this.renderDistanceStorage?.setItem?.(this.renderDistanceStorageKey, String(next)); } catch {}
    this.refresh();
    for (const listener of this.renderDistanceListeners) listener(next);
    return next;
  }

  tileSelectionEnabled() {
    return typeof this.onTileSelect === 'function'
      && isWorldTileSelectionZoom(this.map?.getZoom?.());
  }

  readRuntimeActiveTileId() {
    try { return this.runtime?.getActiveTileId?.() ?? null; } catch { return null; }
  }

  activeTileId() {
    return this.runtimeActiveTileId ?? null;
  }

  selectableTileIdFromEvent(event) {
    const activeTileId = this.activeTileId();
    return (event?.features ?? [])
      .map((feature) => feature?.properties?.tileId)
      .find((tileId) => this.tileIds.has(tileId) && tileId !== activeTileId) ?? null;
  }

  syncTileBoundaryData(activeTileId = this.activeTileId()) {
    const source = safeMapSource(this.map, BOUNDARY_SOURCE_ID);
    if (!source) return;
    const zoom = this.map?.getZoom?.() ?? Infinity;
    const lodKey = this.tileCatalog.tiles.map((tile) => boundaryLodFor(tile, zoom)?.minZoom ?? 'legacy').join(',');
    const stateKey = `${activeTileId}:${this.hoveredTileId}`;
    const unchangedGeometry = this.boundarySubmission?.source === source
      && this.boundarySubmission?.version === BOUNDARY_LOD_VERSION
      && this.boundarySubmission?.lodKey === lodKey;
    const featureState = typeof this.map?.setFeatureState === 'function';
    if (featureState && (this.map.__openWorldBoundaryLodStyleVersion !== BOUNDARY_LOD_VERSION
      || this.boundarySubmission?.source !== source)) {
      const state = (key) => ['boolean', ['feature-state', key], ['boolean', ['get', key], false]];
      this.map.setPaintProperty?.(TILE_SELECTION_LAYER_ID, 'fill-opacity', ['case', state('hovered'), .28, 0]);
      this.map.setPaintProperty?.(TILE_BOUNDARY_LAYER_ID, 'line-color', ['case', ['any', state('active'), state('hovered')], '#ffd166', '#79b8e8']);
      this.map.setPaintProperty?.(TILE_BOUNDARY_LAYER_ID, 'line-opacity', ['case', state('active'), .95, .7]);
      this.map.setPaintProperty?.(TILE_BOUNDARY_LAYER_ID, 'line-width', ['interpolate', ['linear'], ['zoom'],
        0, ['case', state('active'), 1.1, .65], 9, ['case', state('active'), 2.8, 1.5],
        15, ['case', state('active'), 4.2, 2.2]]);
      this.map.__openWorldBoundaryLodStyleVersion = BOUNDARY_LOD_VERSION;
    }
    if (unchangedGeometry && this.boundarySubmission.stateKey === stateKey) return;
    if (featureState && unchangedGeometry) {
      for (const [featureId, tile] of this.tileCatalog.tiles.entries()) this.map.setFeatureState(
        { source: BOUNDARY_SOURCE_ID, id: featureId },
        { active: tile.id === activeTileId, hovered: tile.id === this.hoveredTileId && tile.id !== activeTileId },
      );
      this.boundarySubmission.stateKey = stateKey;
      return;
    }
    this.boundarySubmission = { source, lodKey, stateKey, version: BOUNDARY_LOD_VERSION };
    this.map.__openWorldBoundaryLodDiagnostic = { version: BOUNDARY_LOD_VERSION, lodKey, zoom };
    if (featureState) {
      for (const [featureId, tile] of this.tileCatalog.tiles.entries()) this.map.setFeatureState(
        { source: BOUNDARY_SOURCE_ID, id: featureId },
        { active: tile.id === activeTileId, hovered: tile.id === this.hoveredTileId && tile.id !== activeTileId },
      );
    }
    return mapMovePerfMeasure('maplibre.tile-boundary.setData', () => (
      source.setData(
        tileBoundaryGeoJson(this.tileCatalog, activeTileId, this.hoveredTileId, zoom),
      )
    ), { activeTileId, hoveredTileId: this.hoveredTileId });
  }

  setHoveredTile(tileId) {
    const nextTileId = this.tileSelectionEnabled()
      && this.tileIds.has(tileId)
      && tileId !== this.activeTileId()
      ? tileId
      : null;
    const canvas = this.map?.getCanvas?.();
    if (canvas?.style) canvas.style.cursor = nextTileId ? 'pointer' : '';
    if (this.hoveredTileId === nextTileId) return;
    this.hoveredTileId = nextTileId;
    this.syncTileBoundaryData();
  }

  attachTileSelectionHandlers() {
    if (
      typeof this.onTileSelect !== 'function'
      || !this.map?.getLayer?.(TILE_SELECTION_LAYER_ID)
      || this.tileSelectionMap === this.map
    ) return;
    this.detachTileSelectionHandlers();
    this.map.on?.('mousemove', TILE_SELECTION_LAYER_ID, this.handleTilePointerMove);
    this.map.on?.('mouseleave', TILE_SELECTION_LAYER_ID, this.handleTilePointerLeave);
    this.map.on?.('click', TILE_SELECTION_LAYER_ID, this.handleTileClick);
    this.tileSelectionMap = this.map;
  }

  detachTileSelectionHandlers() {
    const map = this.tileSelectionMap;
    if (!map) return;
    try { map.off('mousemove', TILE_SELECTION_LAYER_ID, this.handleTilePointerMove); } catch {}
    try { map.off('mouseleave', TILE_SELECTION_LAYER_ID, this.handleTilePointerLeave); } catch {}
    try { map.off('click', TILE_SELECTION_LAYER_ID, this.handleTileClick); } catch {}
    const canvas = map.getCanvas?.();
    if (canvas?.style) canvas.style.cursor = '';
    this.tileSelectionMap = null;
    this.hoveredTileId = null;
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
      patch.interliningRevisionProvider = () => this.runtime?.getInterliningRevision?.() ?? null;
      applyMovementDeckVisibility(currentDeck);
      return currentDeck;
    }

    const previousDeck = this.movementDeck;
    const deck = installMovementDeckVisibilityGuard(
      this.map,
      this,
      () => this.getDeckRendererVirtualization(),
      () => this.runtime?.getInterliningRevision?.() ?? null,
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
      activeTileId: this.activeTileId(),
      tileCatalog: this.tileCatalog,
      renderDistance: this.renderDistance,
    });
  }

  syncRendererVirtualizationAuthority({ force = false } = {}) {
    const activeTileId = this.activeTileId();
    if (
      force
      || !this.rendererVirtualization
      || this.rendererVirtualization.activeTileId !== activeTileId
      || this.rendererVirtualization.renderDistance !== this.renderDistance
    ) {
      this.rendererVirtualization = mapMovePerfMeasure(
        'overlay.create-virtualization',
        () => this.createRendererVirtualization(),
      );
    }
    if (this.map) {
      globalThis.__openWorldToolboxRenderMap = this.map;
      globalThis.__openWorldToolboxRenderVirtualization = this.rendererVirtualization;
      globalThis.__openWorldRendererVirtualizationAuthorityVersion = (
        RENDERER_VIRTUALIZATION_AUTHORITY_VERSION
      );
    }
    return this.rendererVirtualization;
  }

  getDeckRendererVirtualization() {
    return this.syncRendererVirtualizationAuthority();
  }

  getRendererVirtualization() {
    return this.syncRendererVirtualizationAuthority();
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
  tileSelection: TILE_SELECTION_LAYER_ID,
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
