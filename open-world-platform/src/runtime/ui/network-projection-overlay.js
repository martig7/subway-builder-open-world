import { createRendererVirtualization } from './renderer-virtualization.js';
const EMPTY = Object.freeze({ type: 'FeatureCollection', features: [] });
const SOURCE_ID = 'open-world-network-projection-source';
const TRACK_LAYER_ID = 'open-world-network-projection-tracks';
const ROUTE_LAYER_ID = 'open-world-network-projection-routes';

function ensureArtifacts(map) {
  if (!map?.getSource?.(SOURCE_ID)) map?.addSource?.(SOURCE_ID, { type: 'geojson', data: EMPTY });
  if (!map?.getLayer?.(TRACK_LAYER_ID)) map?.addLayer?.({
    id: TRACK_LAYER_ID,
    type: 'line',
    source: SOURCE_ID,
    filter: ['==', ['get', 'kind'], 'track-fragment'],
    layout: { visibility: 'visible', 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#747b85'],
      'line-width': ['coalesce', ['get', 'width'], 3],
      'line-opacity': 0.78,
    },
  });
  if (!map?.getLayer?.(ROUTE_LAYER_ID)) map?.addLayer?.({
    id: ROUTE_LAYER_ID,
    type: 'line',
    source: SOURCE_ID,
    filter: ['==', ['get', 'kind'], 'route-fragment'],
    layout: { visibility: 'visible', 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#ffffff'],
      'line-width': ['coalesce', ['get', 'width'], 5],
      'line-opacity': 0.92,
    },
  });
}

/**
 * Draw clipped continuations without putting synthetic tracks, stations, or
 * shortened routes into the native simulation. The source is refreshed after
 * both projection changes and MapLibre style replacement.
 */
export class NetworkProjectionOverlayController {
  constructor({ api, runtime, tileCatalog = runtime?.tileCatalog ?? null }) {
    this.api = api;
    this.runtime = runtime;
    this.tileCatalog = tileCatalog;
    this.map = null;
    this.handleStyle = () => requestAnimationFrame(() => this.refresh());
    this.unsubscribeRuntime = runtime.subscribe?.((event) => {
      if (event?.type === 'projection-changed' || event?.type === 'save-loaded') this.refresh();
    }, { includeView: false });
  }

  attachMap(map) {
    if (this.map === map) return this.refresh();
    this.detachMap();
    this.map = map;
    map.on('style.load', this.handleStyle);
    this.refresh();
  }

  detachMap() {
    if (!this.map) return;
    try { this.map.off('style.load', this.handleStyle); } catch {}
    this.map = null;
  }

  refresh() {
    if (!this.map?.isStyleLoaded?.()) return;
    ensureArtifacts(this.map);
    // In canonical full-native mode the native map already receives the
    // complete topology.  Painting the historical projected continuation on
    // top would duplicate tracks/routes, so retain this source as a harmless
    // lifecycle-compatible no-op.  Older runtimes without the capability flag
    // continue to use the projection overlay.
    const overlay = this.runtime.fullNativeNetworkEnabled === true
      ? EMPTY
      : (this.runtime.projectionOverlay?.() ?? EMPTY);
    const virtualization = createRendererVirtualization({
      activeTileId: this.runtime?.view?.()?.activeTileId ?? null,
      tileCatalog: this.tileCatalog,
    });
    const features = virtualization.renderInputs({ features: overlay.features ?? [] }).features;
    this.map.getSource(SOURCE_ID)?.setData({ ...overlay, features });
  }

  dispose() {
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.detachMap();
  }
}

export function registerNetworkProjectionOverlay(options) {
  return new NetworkProjectionOverlayController(options);
}
