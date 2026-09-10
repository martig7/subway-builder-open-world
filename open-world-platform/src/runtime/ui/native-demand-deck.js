import { findNativeDemandLayer, nativeDemandRadius, readNativeDemandPresentation } from './native-demand-presentation.js';

export const CROSS_DEMAND_DECK_LAYER = 'open-world-cross-demand-points';
const OWNER = Symbol.for('open-world.cross-demand-deck');
const EMPTY = Object.freeze([]);
const color = feature => {
  const hex = feature.properties.color;
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)).concat(255);
};
const lineWidth = feature => feature.properties.selected ? 20 : 4;

// Compose through the existing shared deck guard. Cross-demand layers never
// become canonical native input, and no second setProps wrapper is installed.
export function appendCrossDemandDeckLayer(map, nativeLayers, renderedLayers) {
  const layer = map?.[OWNER]?.layerFor(nativeLayers);
  return layer ? [renderedLayers, layer] : renderedLayers;
}

export class NativeDemandDeckOverlay {
  constructor({ api, onClick, onHover }) {
    this.api = api;
    this.onClick = onClick;
    this.onHover = onHover;
    this.data = EMPTY;
    this.active = false;
    this.viewMode = 'residents';
    this.faded = false;
    this.layer = null;
    this.key = null;
    this.map = null;
  }

  attachMap(map) {
    if (this.map === map) return;
    this.detachMap();
    map[OWNER]?.detachMap();
    this.map = map;
    map[OWNER] = this;
    this.refresh();
  }

  detachMap() {
    const map = this.map;
    if (map?.[OWNER] === this) {
      delete map[OWNER];
      this.refresh();
    }
    this.map = null;
    this.layer = null;
    this.key = null;
    this.data = EMPTY;
  }

  update({ data, active, viewMode, faded }) {
    const points = data?.features ?? EMPTY;
    if (points === this.data && active === this.active && viewMode === this.viewMode && faded === this.faded) return;
    this.data = points;
    this.active = active;
    this.viewMode = viewMode;
    this.faded = faded;
    this.refresh();
  }

  refresh() {
    const deck = this.map?.__deck;
    const nativeLayers = deck?.__openWorldMovementDeckVisibilityGuard?.nativeLayers;
    if (nativeLayers != null && !this.map?._removed) deck.setProps({ layers: nativeLayers });
  }

  layerFor(nativeLayers) {
    if (!this.active || this.data.length === 0) { this.layer = this.key = null; return null; }
    const native = findNativeDemandLayer(nativeLayers);
    if (typeof native?.clone !== 'function') { this.layer = this.key = null; return null; }
    const style = readNativeDemandPresentation(this.api, this.map, undefined, native);
    const visible = (this.map?.getZoom?.() ?? 13) >= 10;
    const key = JSON.stringify([style, this.viewMode, this.faded, visible]);
    if (this.layer && this.layer.props.data === this.data && this.key === key) return this.layer;
    const viewMode = this.viewMode;
    const radius = feature => (feature.properties.selected ? 80
      : nativeDemandRadius(feature.properties.population, viewMode, style.logarithmic)) * style.scale;
    // Inherit the game's renderer and projection settings. Geographic size,
    // fractional zoom, stroke centering and antialiasing now all stay on deck.
    this.layer = native.clone({
      id: CROSS_DEMAND_DECK_LAYER,
      data: this.data,
      visible,
      pickable: true,
      getPointRadius: radius,
      pointRadiusScale: style.radiusScale,
      getFillColor: color,
      getLineColor: [0, 0, 0, 255],
      getLineWidth: lineWidth,
      opacity: this.faded ? 0.33 : 1,
      onClick: this.onClick,
      onHover: this.onHover,
      updateTriggers: { getPointRadius: [this.viewMode, style.scale, style.logarithmic] },
    });
    this.key = key;
    return this.layer;
  }

  pick(point) {
    if (!point || !this.active || !this.map?.__deck?.pickMultipleObjects) return undefined;
    return this.map.__deck.pickMultipleObjects({ x: point.x, y: point.y, radius: 4,
      depth: 16, layerIds: [CROSS_DEMAND_DECK_LAYER] }).map(info => info.object).filter(Boolean);
  }
}
