import { CrossDemandModel } from '../cross-demand-model.js';

const EMPTY = Object.freeze({ type: 'FeatureCollection', features: [] });
const POINTS_SOURCE = 'kc-cross-demand-points-source';
const DETAILS_SOURCE = 'kc-cross-demand-details-source';
const CONNECTION_LAYER = 'kc-cross-demand-connections';
const POP_LINE_LAYER = 'kc-cross-demand-pop-line';
const POINT_LAYER = 'kc-cross-demand-points';
const ENDPOINT_LAYER = 'kc-cross-demand-endpoints';

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
    filter: ['==', ['get', 'kind'], 'connection'],
    layout: { visibility: 'none', 'line-cap': 'round' },
    paint: {
      'line-color': ['get', 'color'], 'line-opacity': 0.6,
      'line-width': ['min', 12, ['max', 1, ['/', ['sqrt', ['get', 'mass']], 8]]],
    },
  });
  if (!map?.getLayer?.(POP_LINE_LAYER)) map?.addLayer?.({
    id: POP_LINE_LAYER, type: 'line', source: DETAILS_SOURCE,
    filter: ['==', ['get', 'kind'], 'pop-line'],
    layout: { visibility: 'none', 'line-cap': 'round' },
    paint: { 'line-color': '#ff0000', 'line-width': 4, 'line-opacity': 1 },
  });
  if (!map?.getLayer?.(POINT_LAYER)) map?.addLayer?.({
    id: POINT_LAYER, type: 'circle', source: POINTS_SOURCE,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': zoomScaledRadius,
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.88,
      'circle-stroke-color': '#000000',
      'circle-stroke-opacity': 1,
      'circle-stroke-width': zoomScaledStrokeWidth,
      'circle-pitch-alignment': 'map',
      'circle-pitch-scale': 'map',
    },
  });
  if (!map?.getLayer?.(ENDPOINT_LAYER)) map?.addLayer?.({
    id: ENDPOINT_LAYER, type: 'circle', source: DETAILS_SOURCE,
    filter: ['match', ['get', 'kind'], ['home', 'work'], true, false],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 15, 'circle-color': ['get', 'color'],
      'circle-stroke-color': '#000000', 'circle-stroke-width': 2,
    },
  });
}

export class CrossDemandOverlayController {
  constructor({ api, runtime, tilePackages }) {
    this.api = api; this.runtime = runtime; this.tilePackages = tilePackages;
    this.active = false; this.status = 'closed'; this.error = null;
    this.viewMode = 'residents';
    this.selectedPointId = null; this.selectedPopIndex = null;
    this.model = null; this.rawData = null; this.map = null; this.listeners = new Set();
    this.handlePointClick = (event) => event.features?.[0]?.properties?.id && this.selectPoint(event.features[0].properties.id);
    this.handleMouseEnter = () => { if (this.map) this.map.getCanvas().style.cursor = 'pointer'; };
    this.handleMouseLeave = () => { if (this.map) this.map.getCanvas().style.cursor = ''; };
    this.handleStyle = () => requestAnimationFrame(() => this.#refreshMap());
    api.hooks.onMapReady((map) => this.attachMap(map));
    this.unsubscribeRuntime = runtime.subscribe?.((event) => {
      if (event?.type !== 'cross-mode-share' || !this.rawData) return;
      const view = this.runtime.view();
      this.model = new CrossDemandModel(this.rawData, view.gatewayLedger, view.crossPopModeChoices);
      this.#emit(); this.#refreshMap();
    });
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  #emit() { for (const listener of this.listeners) listener(this.snapshot()); }
  snapshot() {
    return {
      active: this.active, status: this.status, error: this.error,
      viewMode: this.viewMode,
      selectedPointId: this.selectedPointId, selectedPopIndex: this.selectedPopIndex,
      stats: this.model?.stats ?? null,
    };
  }

  attachMap(map) {
    if (this.map === map) return this.#refreshMap();
    if (this.map) {
      try { this.map.off('click', POINT_LAYER, this.handlePointClick); } catch {}
      try { this.map.off('mouseenter', POINT_LAYER, this.handleMouseEnter); } catch {}
      try { this.map.off('mouseleave', POINT_LAYER, this.handleMouseLeave); } catch {}
      try { this.map.off('style.load', this.handleStyle); } catch {}
    }
    this.map = map;
    map.on('click', POINT_LAYER, this.handlePointClick);
    map.on('mouseenter', POINT_LAYER, this.handleMouseEnter);
    map.on('mouseleave', POINT_LAYER, this.handleMouseLeave);
    // `styledata` also fires for our own visibility changes and would create a
    // redraw loop. `style.load` is the one event where sources need rehydrating.
    map.on('style.load', this.handleStyle);
    this.#refreshMap();
  }

  async open() {
    this.active = true; this.status = 'loading'; this.error = null; this.#emit(); this.#refreshMap();
    try {
      const tileId = this.runtime.view().activeTileId;
      const data = await this.tilePackages.loadCrossDemand(tileId);
      if (!this.active) return;
      this.rawData = data;
      const view = this.runtime.view();
      this.model = new CrossDemandModel(this.rawData, view.gatewayLedger, view.crossPopModeChoices);
      this.status = 'ready'; this.#emit(); this.#refreshMap();
    } catch (error) {
      if (!this.active) return;
      this.status = 'error'; this.error = error.message ?? String(error); this.#emit(); this.#refreshMap();
    }
  }

  close() {
    this.active = false; this.status = 'closed'; this.selectedPointId = null; this.selectedPopIndex = null;
    this.#refreshMap(); this.#emit();
  }

  setViewMode(viewMode) {
    if (!['residents', 'workers'].includes(viewMode)) return;
    this.viewMode = viewMode; this.selectedPopIndex = null; this.#emit(); this.#refreshMap();
  }

  selectPoint(pointId) {
    if (!this.model?.pointById.has(pointId)) return;
    this.selectedPointId = pointId; this.selectedPopIndex = null; this.#emit(); this.#refreshMap();
  }

  selectPop(popIndex) {
    if (!this.model?.popDetails(popIndex)) return;
    this.selectedPopIndex = popIndex; this.#emit(); this.#refreshMap();
  }

  backToPoint() { this.selectedPopIndex = null; this.#emit(); this.#refreshMap(); }
  clearSelection() { this.selectedPointId = null; this.selectedPopIndex = null; this.#emit(); this.#refreshMap(); }
  pointDetails(offset = 0, limit = 40) { return this.model?.pointDetails(this.selectedPointId, this.viewMode, offset, limit) ?? null; }
  popDetails() {
    const pop = this.model?.popDetails(this.selectedPopIndex) ?? null;
    if (!pop) return null;
    const transitPath = this.runtime.inspectCrossTileTransitPath?.(this.rawData, pop.index) ?? null;
    const modeChoiceComparison = this.runtime.inspectCrossTileModeChoice?.(this.rawData, pop.index) ?? null;
    return { ...pop, transitPath, modeChoiceComparison };
  }

  #setVisibility(layerId, visible) {
    if (this.map?.getLayer(layerId)) this.map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }
  #setData(sourceId, data) { this.map?.getSource(sourceId)?.setData(data); }

  #refreshMap() {
    if (!this.map?.isStyleLoaded?.()) return;
    ensureMapArtifacts(this.map);
    const ready = this.active && this.status === 'ready' && this.model;
    const popSelected = ready && this.selectedPopIndex != null;
    this.#setVisibility(POINT_LAYER, Boolean(ready && !popSelected));
    this.#setVisibility(CONNECTION_LAYER, Boolean(ready && this.selectedPointId && !popSelected));
    this.#setVisibility(POP_LINE_LAYER, Boolean(popSelected));
    this.#setVisibility(ENDPOINT_LAYER, Boolean(popSelected));
    if (!ready) return;
    this.#setData(POINTS_SOURCE, this.model.pointFeatures(this.viewMode, this.selectedPointId));
    const details = popSelected
      ? this.model.popSelection(this.selectedPopIndex)
      : this.selectedPointId
        ? this.model.connections(this.selectedPointId, this.viewMode)
        : EMPTY;
    this.#setData(DETAILS_SOURCE, details);
  }
}

function modeChart(h, modeChoice) {
  const total = ['driving', 'walking', 'transit'].reduce((sum, key) => sum + (modeChoice?.[key] ?? 0), 0);
  if (!(total > 0)) return h('p', { className: 'text-xs text-muted-foreground' }, 'Commutes not calculated');
  const rows = [['Driving', 'driving', '#ef4444'], ['Walking', 'walking', '#22c55e'], ['Transit', 'transit', '#3b82f6']];
  return h('div', { className: 'flex flex-col gap-1' }, ...rows.map(([label, key, color]) => {
    const percent = (modeChoice?.[key] ?? 0) / total * 100;
    return h('div', { key },
      h('div', { className: 'flex justify-between text-xs' }, h('span', null, label), h('span', { className: 'font-mono' }, `${percent.toFixed(1)}%`)),
      h('div', { className: 'h-1.5 rounded-full bg-secondary overflow-hidden' }, h('div', { className: 'h-full rounded-full', style: { width: `${percent}%`, backgroundColor: color } })));
  }));
}

function segmentedButton(h, label, selected, onClick) {
  return h('button', {
    onClick, className: `flex-1 rounded px-2 py-1.5 text-xs font-medium ${selected ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}`,
  }, label);
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

export function registerCrossDemandViewer({ api, runtime, tilePackages }) {
  if (typeof api?.ui?.addToolbarPanel !== 'function') throw new Error('ui.addToolbarPanel is unavailable');
  const React = api.utils?.React;
  const h = React?.createElement;
  if (!React || typeof h !== 'function') throw new Error('Native React UI is unavailable');
  const controller = new CrossDemandOverlayController({ api, runtime, tilePackages });

  function DemandViewerPanel() {
    const [snapshot, setSnapshot] = React.useState(controller.snapshot());
    const [limit, setLimit] = React.useState(40);
    React.useEffect(() => {
      const unsubscribe = controller.subscribe(setSnapshot);
      controller.open();
      return () => { unsubscribe(); controller.close(); };
    }, []);
    React.useEffect(() => setLimit(40), [snapshot.selectedPointId, snapshot.viewMode]);

    if (snapshot.status === 'loading') return h('p', { className: 'p-2 text-sm text-muted-foreground' }, 'Loading compact cross-city demand…');
    if (snapshot.status === 'error') return h('p', { className: 'p-2 text-sm text-destructive' }, snapshot.error);
    const pointDetails = controller.pointDetails(0, limit);
    const pop = controller.popDetails();
    const modeToggle = h('div', { className: 'flex gap-1' },
      segmentedButton(h, 'Residents', snapshot.viewMode === 'residents', () => controller.setViewMode('residents')),
      segmentedButton(h, 'Workers', snapshot.viewMode === 'workers', () => controller.setViewMode('workers')));
    if (pop) return h('div', { className: 'flex flex-col gap-3 p-2 text-sm' },
      h('button', { className: 'self-start text-xs text-primary hover:underline', onClick: () => controller.backToPoint() }, '← Back to demand location'),
      h('div', null, h('div', { className: 'text-xs uppercase tracking-wide text-muted-foreground' }, 'Selected pop'), h('div', { className: 'text-xl font-semibold' }, pop.mass.toLocaleString()), h('div', { className: 'font-mono text-[10px] text-muted-foreground break-all' }, pop.id)),
      h('div', { className: 'rounded-md border p-2 text-xs' }, h('div', null, `Home: ${pop.home.id} (${pop.home.tileId})`), h('div', null, `Work: ${pop.work.id} (${pop.work.tileId})`)),
      h('div', null, h('div', { className: 'mb-1 font-medium' }, 'Mode share'), modeChart(h, pop.modeChoice)),
      modeChoiceComparisonSection(h, pop.modeChoiceComparison),
      transitPathSection(h, pop.transitPath));

    return h('div', { className: 'flex flex-col gap-3 p-2' },
      modeToggle,
      !pointDetails && snapshot.stats && h('div', { className: 'rounded-md border p-2 text-xs leading-5' },
        h('div', null, `${snapshot.stats.population.toLocaleString()} cross-city commuters`),
        h('div', null, `${snapshot.stats.points.toLocaleString()} locations · ${snapshot.stats.pops.toLocaleString()} pops`),
        h('div', { className: 'text-muted-foreground' }, 'Click a demand dot to inspect its paired destinations.')),
      pointDetails && h('div', { className: 'flex flex-col gap-2' },
        h('div', { className: 'flex items-start justify-between gap-2' },
          h('div', null, h('div', { className: 'font-medium' }, `${pointDetails.population.toLocaleString()} ${snapshot.viewMode}`), h('div', { className: 'font-mono text-[10px] text-muted-foreground' }, `${pointDetails.point.id} · ${pointDetails.point.tileId}`)),
          h('button', { className: 'text-xs text-primary hover:underline', onClick: () => controller.clearSelection() }, 'Clear')),
        modeChart(h, pointDetails.modeChoice),
        h('div', { className: 'text-xs font-medium' }, `${pointDetails.popCount.toLocaleString()} pops`),
        h('div', { className: 'flex max-h-72 flex-col gap-1 overflow-y-auto pr-1' }, ...pointDetails.pops.map((item) => h('button', {
          key: item.index, onClick: () => controller.selectPop(item.index),
          className: 'flex w-full items-center justify-between rounded border px-2 py-1.5 text-left text-xs hover:bg-secondary',
        }, h('span', null, `${item.mass.toLocaleString()} via ${item.gatewayId}`), h('span', { className: 'text-muted-foreground' }, `${item.home.tileId} → ${item.work.tileId}`)))),
        limit < pointDetails.popCount && h('button', { className: 'rounded border px-2 py-1 text-xs hover:bg-secondary', onClick: () => setLimit((value) => value + 40) }, `Show more (${(pointDetails.popCount - limit).toLocaleString()} remaining)`)));
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
