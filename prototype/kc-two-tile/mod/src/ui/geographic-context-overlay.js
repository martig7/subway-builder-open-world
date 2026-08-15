const EMPTY = Object.freeze({ type: 'FeatureCollection', features: [] });
const BOUNDARY_SOURCE_ID = 'open-world-tile-boundaries-source';
const TILE_BOUNDARY_LAYER_ID = 'open-world-tile-boundaries';
const WORLD_BOUNDARY_LAYER_ID = 'open-world-country-boundaries';
const WORLD_OCEAN_SOURCE_ID = 'open-world-ocean-source';
const WORLD_OCEAN_LAYER_ID = 'open-world-ocean';
// Kept only so a hot reload can remove the obsolete background-layer version.
const WORLD_WATER_BACKGROUND_LAYER_ID = 'open-world-water-background';
const WORLD_LAND_LAYER_ID = 'open-world-land';
const STATION_MARKER_STYLE_ID = 'open-world-station-marker-zoom-style';
const STATION_MARKER_VISIBILITY_KEY = 'openWorldStationMarkers';
const STATION_MARKER_MIN_ZOOM = 10;
const STATION_MARKER_MAX_ZOOM = 16;
const STATION_MARKER_CONTENT_SELECTOR = [
  '.maplibregl-marker > .flex.items-center.translate-x-1\\/2.relative',
  '.mapboxgl-marker > .flex.items-center.translate-x-1\\/2.relative',
].join(', ');
const STATION_MARKER_CSS = `
[data-open-world-station-markers="hidden"] ${STATION_MARKER_CONTENT_SELECTOR.replace(', ', ',\n[data-open-world-station-markers="hidden"] ')} {
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
  container.dataset[STATION_MARKER_VISIBILITY_KEY] = (
    zoom >= STATION_MARKER_MIN_ZOOM && zoom < STATION_MARKER_MAX_ZOOM
  ) ? 'visible' : 'hidden';
}

function ensureArtifacts(map) {
  const worldLayerIds = new Set([
    WORLD_WATER_BACKGROUND_LAYER_ID,
    WORLD_OCEAN_LAYER_ID,
    WORLD_LAND_LAYER_ID,
    WORLD_BOUNDARY_LAYER_ID,
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
      maxzoom: 10,
      paint: { 'fill-color': '#102f68', 'fill-opacity': 1 },
    }, firstNativeContentLayer);
  }
  if (map.getSource?.('general-tiles') && !map.getLayer?.(WORLD_LAND_LAYER_ID)) {
    map.addLayer?.({
      id: WORLD_LAND_LAYER_ID,
      type: 'fill',
      source: 'general-tiles',
      'source-layer': 'world_land',
      maxzoom: 10,
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
      if (layer.minzoom === 10) continue;
      const maximum = Number.isFinite(layer.maxzoom) ? layer.maxzoom : 24;
      map.setLayerZoomRange(layer.id, 10, maximum);
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
      maxzoom: 10,
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
    this.handleStyle = () => {
      const refresh = () => {
        this.refresh();
      };
      globalThis.requestAnimationFrame?.(refresh) ?? refresh();
    };
    this.handleZoom = () => updateStationMarkerVisibility(this.map);
    this.unsubscribeRuntime = runtime?.subscribe?.(() => this.refresh());
  }

  attachMap(map) {
    if (this.map === map) return this.refresh();
    if (this.map) {
      try { this.map.off('style.load', this.handleStyle); } catch {}
      try { this.map.off('zoom', this.handleZoom); } catch {}
    }
    this.map = map;
    map?.on?.('style.load', this.handleStyle);
    map?.on?.('zoom', this.handleZoom);
    ensureStationMarkerStyle();
    updateStationMarkerVisibility(map);
    globalThis.__printOpenWorldMapLayers = () => printMapLayerDiagnostic(map);
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
    updateStationMarkerVisibility(this.map);
    ensureArtifacts(this.map);
    const activeTileId = this.runtime?.view?.()?.activeTileId ?? null;
    this.map.getSource(BOUNDARY_SOURCE_ID)?.setData(tileBoundaryGeoJson(this.tileCatalog, activeTileId));
  }

  dispose() {
    this.unsubscribeRuntime?.();
    if (this.map) {
      try { this.map.off('style.load', this.handleStyle); } catch {}
      try { this.map.off('zoom', this.handleZoom); } catch {}
      const container = this.map.getContainer?.();
      if (container?.dataset) delete container.dataset[STATION_MARKER_VISIBILITY_KEY];
    }
    this.map = null;
  }
}

export function registerGeographicContextOverlay(options) {
  return new GeographicContextOverlayController(options);
}

export const geographicContextLayerIds = Object.freeze({
  boundarySource: BOUNDARY_SOURCE_ID,
  tileBoundaries: TILE_BOUNDARY_LAYER_ID,
  worldBoundaries: WORLD_BOUNDARY_LAYER_ID,
  worldLand: WORLD_LAND_LAYER_ID,
  worldOceanSource: WORLD_OCEAN_SOURCE_ID,
  worldOcean: WORLD_OCEAN_LAYER_ID,
  worldWaterBackground: WORLD_WATER_BACKGROUND_LAYER_ID,
});
