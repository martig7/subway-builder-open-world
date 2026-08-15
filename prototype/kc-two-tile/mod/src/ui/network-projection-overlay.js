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
  constructor({ api, runtime }) {
    this.api = api;
    this.runtime = runtime;
    this.map = null;
    this.handleStyle = () => requestAnimationFrame(() => this.refresh());
    this.unsubscribeRuntime = runtime.subscribe?.((event) => {
      if (event?.type === 'projection-changed' || event?.type === 'save-loaded') this.refresh();
    });
  }

  attachMap(map) {
    if (this.map === map) return this.refresh();
    if (this.map) {
      try { this.map.off('style.load', this.handleStyle); } catch {}
    }
    this.map = map;
    map.on('style.load', this.handleStyle);
    this.refresh();
  }

  refresh() {
    if (!this.map?.isStyleLoaded?.()) return;
    ensureArtifacts(this.map);
    this.map.getSource(SOURCE_ID)?.setData(this.runtime.projectionOverlay?.() ?? EMPTY);
  }

  dispose() {
    this.unsubscribeRuntime?.();
    if (this.map) {
      try { this.map.off('style.load', this.handleStyle); } catch {}
    }
    this.map = null;
  }
}

export function registerNetworkProjectionOverlay(options) {
  return new NetworkProjectionOverlayController(options);
}
