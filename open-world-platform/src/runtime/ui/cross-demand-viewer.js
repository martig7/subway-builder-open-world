import { CrossDemandModel } from '../cross-demand-model.js';
import { demandPanelContent } from './cross-demand-presentation.js';

export const CROSS_DEMAND_PANEL_VERSION = 'native-route-designs-and-fade-v2';

// Native GeoJsonLayer uses opacity 0.33, then deck gamma-adjusts the shader
// uniform. MapLibre paint opacity is direct; copying 0.33 would still over-fade.
const FADED_DEMAND_OPACITY = 0.33 ** (1 / 2.2);

const EMPTY = Object.freeze({ type: 'FeatureCollection', features: [] });
const POINTS_SOURCE = 'kc-cross-demand-points-source';
const DETAILS_SOURCE = 'kc-cross-demand-details-source';
const CONNECTION_LAYER = 'kc-cross-demand-connections';
const POP_LINE_LAYER = 'kc-cross-demand-pop-line';
const POINT_LAYER = 'kc-cross-demand-points';
const ENDPOINT_LAYER = 'kc-cross-demand-endpoints';

export function clipDemandDotsToRenderHalo(data, virtualization) {
  if (!Array.isArray(data?.features) || typeof virtualization?.presentation !== 'function') return data;
  const features = data.features.filter((feature) => (
    feature?.geometry?.type !== 'Point'
    || virtualization.presentation(feature, { clip: false }) != null
  ));
  return features.length === data.features.length ? data : { ...data, features };
}

// Demand radii are geographic metres. MapLibre circle radii are pixels, so
// convert metres with the Web Mercator scale and double pixels at every zoom.
// Deliberately omit the native demand layer's additional 2^(zoom * 0.75)
// enlargement: that changes the dot's world size instead of preserving it.
const DECK_EARTH_CIRCUMFERENCE_METRES = 40_030_000;
const DECK_TILE_SIZE = 512;
const KC_REFERENCE_LATITUDE = 39.1;
const MAPLIBRE_MAX_ZOOM = 24;
const PIXELS_PER_METRE_AT_ZOOM_ZERO = DECK_TILE_SIZE
  / (DECK_EARTH_CIRCUMFERENCE_METRES * Math.cos(KC_REFERENCE_LATITUDE * Math.PI / 180));
const radiusFactorAtZoom = (zoom) => PIXELS_PER_METRE_AT_ZOOM_ZERO * 2 ** zoom;

const zoomScaledMetres = (metres) => ['interpolate', ['exponential', 2], ['zoom'],
  0, ['*', metres, radiusFactorAtZoom(0)],
  MAPLIBRE_MAX_ZOOM, ['*', metres, radiusFactorAtZoom(MAPLIBRE_MAX_ZOOM)],
];
const zoomScaledRadius = zoomScaledMetres(['get', 'baseRadius']);
const zoomScaledStrokeWidth = zoomScaledMetres(['case', ['get', 'selected'], 20, 4]);

function ensureMapArtifacts(map) {
  if (!map?.getSource?.(POINTS_SOURCE)) map?.addSource?.(POINTS_SOURCE, { type: 'geojson', data: EMPTY });
  if (!map?.getSource?.(DETAILS_SOURCE)) map?.addSource?.(DETAILS_SOURCE, { type: 'geojson', data: EMPTY });
  if (!map?.getLayer?.(CONNECTION_LAYER)) map?.addLayer?.({
    id: CONNECTION_LAYER, type: 'line', source: DETAILS_SOURCE,
    minzoom: 10,
    filter: ['==', ['get', 'kind'], 'connection'],
    layout: { visibility: 'none', 'line-cap': 'round' },
    paint: {
      'line-color': ['get', 'color'], 'line-opacity': 0.6,
      'line-width': ['min', 12, ['max', 1, ['/', ['sqrt', ['get', 'mass']], 8]]],
    },
  });
  if (!map?.getLayer?.(POP_LINE_LAYER)) map?.addLayer?.({
    id: POP_LINE_LAYER, type: 'line', source: DETAILS_SOURCE,
    minzoom: 0,
    filter: ['==', ['get', 'kind'], 'pop-line'],
    layout: { visibility: 'none', 'line-cap': 'round' },
    paint: { 'line-color': '#ff0000', 'line-width': 4, 'line-opacity': 1 },
  });
  if (!map?.getLayer?.(POINT_LAYER)) map?.addLayer?.({
    id: POINT_LAYER, type: 'circle', source: POINTS_SOURCE,
    minzoom: 10,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': zoomScaledRadius,
      'circle-color': ['get', 'color'],
      'circle-opacity': 1,
      'circle-stroke-color': '#000000',
      'circle-stroke-opacity': 1,
      'circle-stroke-width': zoomScaledStrokeWidth,
      'circle-pitch-alignment': 'map',
      'circle-pitch-scale': 'map',
    },
  });
  if (!map?.getLayer?.(ENDPOINT_LAYER)) map?.addLayer?.({
    id: ENDPOINT_LAYER, type: 'circle', source: DETAILS_SOURCE,
    minzoom: 0,
    filter: ['match', ['get', 'kind'], ['home', 'work'], true, false],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 15, 'circle-color': ['get', 'color'],
      'circle-stroke-color': '#000000', 'circle-stroke-width': 2,
    },
  });
  for (const id of [POP_LINE_LAYER, ENDPOINT_LAYER]) {
    if (map?.getLayer?.(id)?.minzoom !== 0) map?.setLayerZoomRange?.(id, 0, 24);
  }
}

export class CrossDemandOverlayController {
  constructor({ api, runtime, tilePackages, routePaths = null, rendererVirtualization = null, tileCatalog = null }) {
    this.api = api; this.runtime = runtime; this.tilePackages = tilePackages; this.routePaths = routePaths;
    this.rendererVirtualization = rendererVirtualization;
    this.tileNames = new Map((tileCatalog?.tiles ?? []).map(tile => [tile.id, tile.name ?? tile.id]));
    this.modeFilter = 'all'; this.faded = false; this.openRequest = 0;
    this.pointsKey = null; this.detailsKey = null; this.detailCache = null;
    this.pendingMapRefresh = false; this.modelRevision = 0;
    this.active = false; this.status = 'closed'; this.error = null;
    this.viewMode = 'residents';
    this.selectedPointId = null; this.selectedPopIndex = null;
    this.model = null; this.rawData = null; this.map = null; this.listeners = new Set();
    this.selectedDrivingPath = null; this.routeStatus = 'idle'; this.routeRequest = 0;
    this.handlePointClick = (event) => {
      if (!this.active || this.selectedPopIndex != null) return;
      const p = event.point;
      const features = event.features ?? (p && this.map?.getLayer?.(POINT_LAYER)
        ? this.map.queryRenderedFeatures?.([[p.x - 4, p.y - 4], [p.x + 4, p.y + 4]], { layers: [POINT_LAYER] }) : []);
      const nearest = features?.filter(f => this.model?.pointById.has(f.properties?.id)).sort((a, b) => {
        if (!p || !this.map?.project) return 0;
        const distance = f => { const v = this.map.project(f.geometry.coordinates); return Math.hypot(v.x - p.x, v.y - p.y); };
        return distance(a) - distance(b);
      })[0];
      if (nearest) this.selectPoint(nearest.properties.id);
    };
    this.handleMouseEnter = () => { if (this.map) this.map.getCanvas().style.cursor = 'pointer'; };
    this.handleMouseLeave = () => { if (this.map) this.map.getCanvas().style.cursor = ''; };
    this.handleStyle = () => { this.pointsKey = this.detailsKey = null; this.#refreshMap(); };
    this.handleIdle = () => { if (this.pendingMapRefresh) this.#refreshMap(); };
    this.unsubscribeRuntime = runtime.subscribe?.((event) => {
      if (event?.type !== 'cross-mode-share' || !this.rawData) return;
      const view = this.runtime.view();
      this.model = new CrossDemandModel(this.rawData, view.gatewayLedger, view.crossPopModeChoices);
      this.modelRevision++; this.detailCache = null;
      this.#emit(); this.#refreshMap();
    }, { includeView: false });
    this.unsubscribeRenderDistance = rendererVirtualization?.subscribeRenderDistance?.(
      () => { this.pointsKey = this.detailsKey = null; this.#refreshMap(); },
    );
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  #emit() { for (const listener of this.listeners) listener(this.snapshot()); }
  snapshot() {
    return {
      active: this.active, status: this.status, error: this.error,
      viewMode: this.viewMode,
      selectedPointId: this.selectedPointId, selectedPopIndex: this.selectedPopIndex,
      routeStatus: this.routeStatus,
      version: CROSS_DEMAND_PANEL_VERSION, modeFilter: this.modeFilter, faded: this.faded,
      stats: this.model?.stats ?? null,
    };
  }

  attachMap(map) {
    if (this.map === map) return this.#refreshMap();
    this.detachMap();
    this.map = map;
    this.pointsKey = this.detailsKey = null;
    map.on('click', this.handlePointClick);
    map.on('mouseenter', POINT_LAYER, this.handleMouseEnter);
    map.on('mouseleave', POINT_LAYER, this.handleMouseLeave);
    // `styledata` also fires for our own visibility changes and would create a
    // redraw loop. `style.load` is the one event where sources need rehydrating.
    map.on('style.load', this.handleStyle);
    map.on('idle', this.handleIdle);
    this.#refreshMap();
  }

  detachMap() {
    if (!this.map) return;
    try { this.map.off('click', this.handlePointClick); } catch {}
    try { this.map.off('mouseenter', POINT_LAYER, this.handleMouseEnter); } catch {}
    try { this.map.off('mouseleave', POINT_LAYER, this.handleMouseLeave); } catch {}
    try { this.map.off('style.load', this.handleStyle); } catch {}
    try { this.map.off('idle', this.handleIdle); } catch {}
    try {
      const canvas = this.map.getCanvas?.();
      if (canvas?.style) canvas.style.cursor = '';
    } catch {}
    this.map = null;
  }

  dispose() {
    this.close();
    this.detachMap();
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.unsubscribeRenderDistance?.();
    this.unsubscribeRenderDistance = null;
  }

  async open() {
    const request = ++this.openRequest;
    this.active = true; this.status = 'loading'; this.error = null; this.#emit(); this.#refreshMap();
    try {
      const tileId = this.runtime.getActiveTileId();
      const data = await this.tilePackages.loadCrossDemand(tileId);
      if (!this.active || request !== this.openRequest) return;
      this.rawData = data;
      const view = this.runtime.view();
      this.model = new CrossDemandModel(this.rawData, view.gatewayLedger, view.crossPopModeChoices);
      this.modelRevision++; this.detailCache = null;
      this.status = 'ready'; this.#emit(); this.#refreshMap();
    } catch (error) {
      if (!this.active || request !== this.openRequest) return;
      this.status = 'error'; this.error = error.message ?? String(error); this.#emit(); this.#refreshMap();
    }
  }

  close() {
    this.openRequest++;
    this.active = false; this.status = 'closed'; this.selectedPointId = null; this.selectedPopIndex = null;
    this.selectedDrivingPath = null; this.routeStatus = 'idle'; this.routeRequest++;
    this.#refreshMap(); this.#emit(); this.detailCache = null;
  }

  setViewMode(viewMode) {
    if (!['residents', 'workers'].includes(viewMode)) return;
    this.viewMode = viewMode; this.selectedPopIndex = null; this.selectedDrivingPath = null;
    this.routeStatus = 'idle'; this.routeRequest++; this.#emit(); this.#refreshMap();
  }

  setModeFilter(mode) {
    if (!['all', 'driving', 'walking', 'transit'].includes(mode)) return;
    this.modeFilter = mode; this.#emit(); this.#refreshMap();
  }
  setFaded(faded) { this.faded = Boolean(faded); this.#emit(); this.#refreshMap(); }
  tileName(id) { return this.tileNames.get(id) ?? id; }
  focusEndpoint(kind) {
    const point = this.model?.popDetails(this.selectedPopIndex)?.[kind];
    if (point) this.map?.jumpTo?.({ center: point.location, zoom: Math.max(12, this.map.getZoom?.() ?? 12) });
  }
  fitRoute(panelBounds = null) {
    const pop = this.model?.popDetails(this.selectedPopIndex);
    if (!pop) return;
    const coordinates = this.selectedDrivingPath ?? [pop.home.location, pop.work.location];
    const bounds = coordinates.reduce((b, p) => [[Math.min(b[0][0], p[0]), Math.min(b[0][1], p[1])],
      [Math.max(b[1][0], p[0]), Math.max(b[1][1], p[1])]], [[Infinity, Infinity], [-Infinity, -Infinity]]);
    const container = this.map?.getContainer?.();
    const width = container?.clientWidth ?? 1200;
    const panelLeft = panelBounds?.left - (container?.getBoundingClientRect?.()?.left ?? 0);
    const right = Math.min(Number.isFinite(panelLeft) ? Math.max(60, width - panelLeft + 40) : 650, Math.max(60, width - 160));
    this.map?.fitBounds?.(bounds, { padding: { top: 70, bottom: 70, left: 60, right }, maxZoom: 14, duration: 0 });
  }

  selectPoint(pointId) {
    if (!this.model?.pointById.has(pointId)) return;
    this.selectedPointId = pointId; this.selectedPopIndex = null;
    this.selectedDrivingPath = null; this.routeStatus = 'idle'; this.routeRequest++;
    this.#emit(); this.#refreshMap();
  }

  selectPop(popIndex) {
    if (!this.model?.popDetails(popIndex)) return;
    this.selectedPopIndex = popIndex; this.selectedDrivingPath = null;
    this.routeStatus = this.routePaths ? 'loading' : 'geometric-fallback';
    const request = ++this.routeRequest;
    this.#emit(); this.#refreshMap();
    if (this.routePaths) void this.#loadDrivingPath(popIndex, request);
  }

  async #loadDrivingPath(popIndex, request) {
    const pop = this.model?.popDetails(popIndex);
    if (!pop) return;
    const city = this.runtime.getActiveTileId();
    const result = await this.routePaths.resolve(city, pop.id);
    if (request !== this.routeRequest || this.selectedPopIndex !== popIndex) return;
    this.selectedDrivingPath = result?.coordinates ?? null;
    this.routeStatus = result?.source ?? 'geometric-fallback';
    this.#emit(); this.#refreshMap();
  }

  backToPoint() {
    this.selectedPopIndex = null; this.selectedDrivingPath = null;
    this.routeStatus = 'idle'; this.routeRequest++; this.#emit(); this.#refreshMap();
  }
  clearSelection() {
    this.selectedPointId = null; this.selectedPopIndex = null; this.selectedDrivingPath = null;
    this.routeStatus = 'idle'; this.routeRequest++; this.#emit(); this.#refreshMap();
  }
  pointDetails(offset = 0, limit = 40) { return this.model?.pointDetails(this.selectedPointId, this.viewMode, offset, limit) ?? null; }
  routeDesign(route) {
    // Read the current design only for visible trip legs; never retain native
    // route objects (which also own track/timetable arrays) in a display cache.
    const native = this.api.gameState?.getRoutes?.()?.find(candidate => candidate.id === route.routeId);
    if (!native) return route;
    const { bullet, fullName, color, textColor, shape, bordered, font } = native;
    return { ...route, bullet, name: fullName || route.name, color, textColor, shape, bordered, font };
  }
  popDetails() {
    const pop = this.model?.popDetails(this.selectedPopIndex) ?? null;
    if (!pop) return null;
    if (this.detailCache?.model === this.model && this.detailCache.index === pop.index) return this.detailCache.value;
    const modeChoiceComparison = this.runtime.inspectCrossTileModeChoice?.(this.rawData, pop.index) ?? null;
    const transitPath = modeChoiceComparison?.transitPath ?? this.runtime.inspectCrossTileTransitPath?.(this.rawData, pop.index) ?? null;
    const value = { ...pop, transitPath, modeChoiceComparison };
    this.detailCache = { model: this.model, index: pop.index, value };
    return value;
  }

  #setVisibility(layerId, visible) {
    if (this.map?.getLayer(layerId)) this.map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }
  #setData(sourceId, data) { this.map?.getSource(sourceId)?.setData(data); }

  #clipDemandDots(data) {
    return clipDemandDotsToRenderHalo(
      data,
      this.rendererVirtualization?.getRendererVirtualization?.(),
    );
  }

  #refreshMap() {
    if (!this.map?.isStyleLoaded?.()) { this.pendingMapRefresh = true; return; }
    this.pendingMapRefresh = false;
    ensureMapArtifacts(this.map);
    const ready = this.active && this.status === 'ready' && this.model;
    const popSelected = ready && this.selectedPopIndex != null;
    this.#setVisibility(POINT_LAYER, Boolean(ready && !popSelected));
    this.#setVisibility(CONNECTION_LAYER, Boolean(ready && this.selectedPointId && !popSelected));
    this.#setVisibility(POP_LINE_LAYER, Boolean(popSelected));
    this.#setVisibility(ENDPOINT_LAYER, Boolean(ready && (this.selectedPointId || popSelected)));
    const opacity = this.faded ? FADED_DEMAND_OPACITY : 1;
    this.map.setPaintProperty?.(POINT_LAYER, 'circle-opacity', opacity);
    this.map.setPaintProperty?.(POINT_LAYER, 'circle-stroke-opacity', opacity);
    if (!ready) {
      if (this.pointsKey !== 'closed') { this.#setData(POINTS_SOURCE, EMPTY); this.#setData(DETAILS_SOURCE, EMPTY); }
      this.pointsKey = this.detailsKey = 'closed'; return;
    }
    const pointsKey = popSelected ? 'pop-selected' : `${this.modelRevision}/${this.viewMode}/${this.selectedPointId}/${this.modeFilter}`;
    if (pointsKey !== this.pointsKey) {
      this.#setData(POINTS_SOURCE, popSelected ? EMPTY : this.#clipDemandDots(this.model.pointFeatures(this.viewMode, this.selectedPointId, this.modeFilter)));
      this.pointsKey = pointsKey;
    }
    const detailsKey = `${this.modelRevision}/${this.viewMode}/${this.selectedPointId}/${this.selectedPopIndex}/${this.routeRequest}/${this.routeStatus}`;
    if (detailsKey === this.detailsKey) return;
    const details = popSelected
      ? this.model.popSelection(this.selectedPopIndex, this.selectedDrivingPath)
      : this.selectedPointId
        ? this.model.connections(this.selectedPointId, this.viewMode)
        : EMPTY;
    // Two selected trip endpoints must remain visible outside the active tile's halo.
    this.#setData(DETAILS_SOURCE, popSelected ? details : this.#clipDemandDots(details));
    this.detailsKey = detailsKey;
  }
}

function duration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function pathReason(reason) {
  return ({
    'network-profile-missing': 'Network not loaded for this tile',
    'no-constructed-stations': 'No constructed stations',
    'origin-outside-walk-range': 'Origin is outside station walking range',
    'destination-outside-walk-range': 'Destination is outside station walking range',
    'stations-disconnected': 'Nearby stations are not connected',
    'gateway-location-missing': 'Gateway location is missing',
    'no-through-service': 'No saved network contains a continuous through route',
  })[reason] ?? 'No complete path';
}

export function transitLegPresentation(leg) {
  if (!leg) return { stations: null, routes: null };
  const origin = leg.originStationName || leg.originStationId || 'Unknown station';
  const destination = leg.destinationStationName || leg.destinationStationId || 'Unknown station';
  const routeLabels = [...new Set((leg.routes ?? [])
    .map((route) => route?.label || route?.name || route?.bullet || route?.routeId)
    .filter(Boolean))];
  return {
    stations: `${origin} → ${destination}`,
    routes: routeLabels.length > 0 ? routeLabels.join(' → ') : null,
  };
}

function transitLeg(h, label, leg, {
  totalSeconds = leg?.totalSeconds,
  showAccess = true,
  showEgress = true,
  showWait = true,
  showDepartureShift = true,
} = {}) {
  if (!leg) return h('div', { className: 'text-xs text-muted-foreground' }, `${label}: unavailable`);
  if (!leg.available) return h('div', { className: 'rounded border border-destructive/40 p-2 text-xs' },
    h('div', { className: 'font-medium text-destructive' }, `${label}: no path`),
    h('div', { className: 'text-muted-foreground' }, pathReason(leg.reason)));
  const presentation = transitLegPresentation(leg);
  return h('div', { className: 'rounded border p-2 text-xs leading-5' },
    h('div', { className: 'flex justify-between gap-2' }, h('span', { className: 'font-medium' }, label), h('span', null, duration(totalSeconds))),
    h('div', { className: 'text-muted-foreground' }, `Saved network: ${leg.networkTileId}`),
    h('div', null, `Stations: ${presentation.stations}`),
    presentation.routes && h('div', null, `Routes: ${presentation.routes}`),
    h('div', { className: 'text-muted-foreground' }, [
      showAccess && `walk in ${duration(leg.accessWalkSeconds)}`,
      showEgress && `walk out ${duration(leg.egressWalkSeconds)}`,
      showDepartureShift && leg.departureShiftSeconds > 0 && `leave later ${duration(leg.departureShiftSeconds)}`,
      showWait && leg.waitSeconds > 0 && `platform wait ${duration(leg.waitSeconds)}`,
      leg.networkSeconds > 0 && `train ${duration(leg.networkSeconds)}`,
    ].filter(Boolean).join(' · ')),
    !leg.usesNetworkConnection && h('div', { className: 'text-amber-500' }, 'No rail connection is traversed on this leg.'));
}

function transitPathSection(h, path) {
  if (!path) return h('div', null,
    h('div', { className: 'mb-1 font-medium' }, 'Transit path'),
    h('p', { className: 'text-xs text-muted-foreground' }, 'Path diagnostics unavailable until mode share is recalculated.'));
  return h('div', { className: 'flex flex-col gap-2' },
    h('div', { className: 'flex items-center justify-between gap-2' },
      h('div', { className: 'font-medium' }, 'Transit path'),
      h('div', { className: `text-xs font-medium ${path.available ? 'text-blue-400' : 'text-destructive'}` }, path.available ? 'Path available' : 'No complete path')),
    path.reason === 'gateway-location-missing' && h('div', { className: 'text-xs text-destructive' }, pathReason(path.reason)),
    path.continuous
      ? transitLeg(h, 'Home → work (through service)', path.continuousLeg)
      : transitLeg(h, 'Home → gateway', path.homeLeg, { totalSeconds: path.homeSegmentSeconds, showEgress: false }),
    !path.continuous && path.intermediateLeg && transitLeg(h, 'Gateway → gateway (cached core)', path.intermediateLeg, {
      totalSeconds: path.intermediateSegmentSeconds,
      showAccess: false,
      showEgress: false,
      showWait: false,
      showDepartureShift: false,
    }),
    !path.continuous && transitLeg(h, 'Gateway → work', path.workLeg, {
      totalSeconds: path.workSegmentSeconds,
      showAccess: false,
      showWait: false,
      showDepartureShift: false,
    }),
    path.available && h('div', { className: 'flex justify-between border-t pt-2 text-xs font-medium' }, h('span', null, 'Total mode-choice time'), h('span', null, duration(path.totalSeconds))),
    path.available && h('p', { className: 'text-[10px] text-muted-foreground' }, 'A path can exist even when driving wins the cost comparison.'));
}

function modeChoiceComparisonSection(h, comparison) {
  if (!comparison) return null;
  const money = (value) => Number.isFinite(value) ? `$${value.toFixed(2)}` : '—';
  const distance = (value) => Number.isFinite(value) ? `${(value / 1_000).toFixed(1)} km` : '—';
  const costs = comparison.representativePerson?.generalizedCost ?? {};
  const row = (label, value) => h('div', { className: 'flex justify-between gap-3' }, h('span', { className: 'text-muted-foreground' }, label), h('span', { className: 'text-right font-mono' }, value));
  return h('div', { className: 'flex flex-col gap-1 rounded border p-2 text-xs' },
    h('div', { className: 'mb-1 font-medium' }, 'Mode-choice inputs'),
    row('Driving time', duration(comparison.driving.clockSeconds)),
    row('Driving in traffic', duration(comparison.driving.congestedClockSeconds)),
    row('Driving perceived', duration(comparison.driving.perceivedSeconds)),
    row('Driving distance', distance(comparison.driving.distanceMetres)),
    row('Driving money', money(comparison.driving.moneyCost)),
    h('div', { className: 'mb-1 text-[10px] text-muted-foreground' }, `Estimate: ${comparison.driving.estimator}`),
    row('Transit clock time', duration(comparison.transit.clockSeconds)),
    row('Transit perceived', duration(comparison.transit.perceivedSeconds)),
    row('Transit fare', money(comparison.transit.moneyCost)),
    row('Walking time', duration(comparison.walking.clockSeconds)),
    h('div', { className: 'my-1 border-t' }),
    h('div', { className: 'font-medium' }, `Representative income: ${money(comparison.representativePerson?.annualIncome)}/yr`),
    row('Driving generalized cost', money(costs.driving)),
    row('Transit generalized cost', money(costs.transit)),
    row('Walking generalized cost', money(costs.walking)));
}

export function registerCrossDemandViewer({
  api,
  runtime,
  tilePackages,
  routePaths = null,
  rendererVirtualization = null,
  tileCatalog = null,
}) {
  if (typeof api?.ui?.addToolbarPanel !== 'function') throw new Error('ui.addToolbarPanel is unavailable');
  const React = api.utils?.React;
  const h = React?.createElement;
  if (!React || typeof h !== 'function') throw new Error('Native React UI is unavailable');
  const controller = new CrossDemandOverlayController({
    api,
    runtime,
    tilePackages,
    routePaths,
    rendererVirtualization,
    tileCatalog,
  });

  function DemandViewerPanel() {
    const [snapshot, setSnapshot] = React.useState(controller.snapshot());
    const [limit, setLimit] = React.useState(5);
    const [page, setPage] = React.useState(0);
    const [showDiagnostics, setShowDiagnostics] = React.useState(false);
    const panelRef = React.useRef(null);
    React.useEffect(() => {
      const unsubscribe = controller.subscribe(setSnapshot);
      controller.open();
      return () => { unsubscribe(); controller.close(); };
    }, []);
    React.useEffect(() => { setLimit(5); setPage(0); }, [snapshot.selectedPointId, snapshot.viewMode]);
    React.useEffect(() => setShowDiagnostics(false), [snapshot.selectedPopIndex]);
    React.useEffect(() => { if (panelRef.current) panelRef.current.scrollTop = 0; }, [snapshot.selectedPopIndex, snapshot.selectedPointId, snapshot.viewMode]);
    if (snapshot.status === 'loading') return h('p', { className: 'p-2 text-sm text-muted-foreground', role: 'status' }, 'Loading cross-city demand…');
    if (snapshot.status === 'error') return h('div', { className: 'p-2 text-sm' },
      h('p', { role: 'alert' }, snapshot.error), h('button', { onClick: () => controller.open(), className: 'mt-2 rounded border p-2' }, 'Retry'));
    if (!controller.model) return null;
    const point = controller.pointDetails(page, limit), pop = controller.popDetails();
    const advanced = pop && h('section', { className: 'border-t pt-2' },
      h('button', { type: 'button', 'aria-expanded': showDiagnostics, className: 'text-xs text-muted-foreground hover:text-primary',
        onClick: () => setShowDiagnostics(value => !value) }, showDiagnostics ? 'Hide calculation details' : 'Calculation details'),
      showDiagnostics && h('div', { className: 'mt-2 flex flex-col gap-3 text-xs' },
        h('div', { className: 'break-all text-muted-foreground' }, `Pop: ${pop.id}`),
        h('div', null, `Driving path: ${snapshot.routeStatus}`),
        modeChoiceComparisonSection(h, pop.modeChoiceComparison), transitPathSection(h, pop.transitPath)));
    return demandPanelContent({ h, controller, snapshot, point, pop, limit, setLimit, page, setPage, advanced, panelRef });
  }

  controller.ensurePanel = () => {
    api.ui.unregisterComponent?.('top-bar', 'kc-cross-demand-viewer');
    api.ui.addToolbarPanel({
      id: 'kc-cross-demand-viewer', icon: 'UsersRound', tooltip: 'Cross-city demand',
      title: 'Cross-city demand', width: 390, render: DemandViewerPanel,
    });
  };
  controller.ensurePanel();
  return controller;
}
