// A single viewport mask, made from the same loaded vector tiles as the map.
// No coastline copy or per-frame geographic intersection is retained.
export const LAND_SELECTION_VERSION = 'native-land-selection-v1';
export const LAND_SELECTION_LAYER = 'open-world-land-selection';
const SOURCE = 'open-world-land-selection-source';
const CONTEXT = 'open-world-world-context-source';
const MAX_SIZE = 1024;
const mercatorY = latitude => Math.log(Math.tan(Math.PI / 4 + Math.max(-85.051129, Math.min(85.051129, latitude)) * Math.PI / 360));

export function traceSelectionGeometry(context, geometry, project) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  context.beginPath();
  for (const polygon of polygons) for (const ring of polygon) {
    ring.forEach((coordinate, index) => {
      const [x, y] = project(coordinate);
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.closePath();
  }
}

export function paintLandSelection(output, mask, { land, water, active, hovered, project, width, height }) {
  const landContext = mask.getContext('2d');
  landContext.clearRect(0, 0, width, height);
  landContext.fillStyle = '#fff';
  landContext.globalCompositeOperation = 'source-over';
  for (const feature of land) {
    traceSelectionGeometry(landContext, feature.geometry, project);
    landContext.fill('evenodd');
  }
  landContext.globalCompositeOperation = 'destination-out';
  for (const feature of water) {
    traceSelectionGeometry(landContext, feature.geometry, project);
    landContext.fill('evenodd');
  }
  landContext.globalCompositeOperation = 'source-over';
  const context = output.getContext('2d');
  context.clearRect(0, 0, width, height);
  context.globalCompositeOperation = 'source-over';
  context.fillStyle = '#ffd166';
  for (const [geometry, alpha] of [[active, .14], [hovered, .28]]) {
    context.globalAlpha = alpha;
    traceSelectionGeometry(context, geometry, project);
    context.fill('evenodd');
  }
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'destination-in';
  context.drawImage(mask, 0, 0);
  context.globalCompositeOperation = 'source-over';
}

export class LandSelection {
  constructor(map, createCanvas = () => globalThis.document?.createElement?.('canvas')) {
    this.map = map;
    this.createCanvas = createCanvas;
    this.dirty = true;
    this.hide = () => {
      this.dirty = true;
      if (map.getLayer?.(LAND_SELECTION_LAYER)) map.setLayoutProperty(LAND_SELECTION_LAYER, 'visibility', 'none');
    };
    this.invalidate = event => { if (event.sourceId === CONTEXT) this.dirty = true; };
    this.settle = () => this.update(this.selection);
    map.on?.('movestart', this.hide);
    map.on?.('moveend', this.settle);
    map.on?.('sourcedata', this.invalidate);
    map.on?.('idle', this.settle);
  }

  update(selection) {
    if (!selection) return;
    const changed = this.selection?.active !== selection.active || this.selection?.hovered !== selection.hovered;
    this.selection = selection;
    const map = this.map;
    if (!map.querySourceFeatures || !map.getBounds || !map.getCanvas) return;
    if (map.getZoom() >= 10 || (!selection.active && !selection.hovered)) {
      this.hide();
      return;
    }
    if (map.isMoving?.()) return;
    if (!this.dirty && !changed && map.getLayer?.(LAND_SELECTION_LAYER)) return;
    const started = performance.now();
    const bounds = map.getBounds();
    const west = bounds.getWest(), east = bounds.getEast(), north = bounds.getNorth(), south = bounds.getSouth();
    const top = mercatorY(north), bottom = mercatorY(south);
    if (!(east > west && top > bottom)) return;
    const view = map.getCanvas();
    const scale = Math.min(1, MAX_SIZE / Math.max(view.width, view.height));
    const width = Math.max(1, Math.round(view.width * scale)), height = Math.max(1, Math.round(view.height * scale));
    this.canvas ??= this.createCanvas();
    this.mask ??= this.createCanvas();
    if (!this.canvas || !this.mask) return;
    for (const canvas of [this.canvas, this.mask]) { canvas.width = width; canvas.height = height; }
    const project = ([longitude, latitude]) => [(longitude - west) / (east - west) * width,
      (top - mercatorY(latitude)) / (top - bottom) * height];
    paintLandSelection(this.canvas, this.mask, {
      land: map.querySourceFeatures(CONTEXT, { sourceLayer: 'world_land' }),
      water: map.querySourceFeatures(CONTEXT, { sourceLayer: 'water' }),
      ...selection, project, width, height,
    });
    const coordinates = [[west, north], [east, north], [east, south], [west, south]];
    if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'canvas', canvas: this.canvas, animate: false, coordinates });
    if (!map.getLayer(LAND_SELECTION_LAYER)) map.addLayer({ id: LAND_SELECTION_LAYER, type: 'raster', source: SOURCE,
      maxzoom: 10, paint: { 'raster-fade-duration': 0, 'raster-opacity': 1 } }, 'open-world-tile-boundaries');
    const source = map.getSource(SOURCE);
    source.setCoordinates(coordinates);
    // Upload exactly one changed frame; a paused CanvasSource does no ongoing work.
    source.play();
    if (this.pauseUpload) map.off('render', this.pauseUpload);
    this.pauseUpload = () => { source.pause(); this.pauseUpload = null; };
    map.once('render', this.pauseUpload);
    map.setLayoutProperty(LAND_SELECTION_LAYER, 'visibility', 'visible');
    this.dirty = false;
    map.__openWorldLandSelection = { version: LAND_SELECTION_VERSION, width, height,
      draws: (map.__openWorldLandSelection?.draws ?? 0) + 1, lastDrawMs: performance.now() - started };
  }

  dispose() {
    const map = this.map;
    map.off?.('movestart', this.hide);
    map.off?.('moveend', this.settle);
    map.off?.('sourcedata', this.invalidate);
    map.off?.('idle', this.settle);
    if (this.pauseUpload) map.off('render', this.pauseUpload);
    map.getSource?.(SOURCE)?.pause?.();
    if (map.getLayer?.(LAND_SELECTION_LAYER)) map.removeLayer(LAND_SELECTION_LAYER);
    if (map.getSource?.(SOURCE)) map.removeSource(SOURCE);
    for (const canvas of [this.canvas, this.mask]) if (canvas) { canvas.width = 1; canvas.height = 1; }
    this.canvas = this.mask = null;
  }
}
