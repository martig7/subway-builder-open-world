import { boundsPolygon, catalogBounds, fitBoundsView, panView, projectCoordinate, visibleSlippyGrid, zoomViewAt } from '../tile-map-model.js';

export const TILE_MAP_VIEWPORT = Object.freeze({ width: 344, height: 230 });
const DRAG_THRESHOLD_PX = 6;

const COLORS = Object.freeze({
  map: '#091421', water: '#12395A', grid: '#29465F', active: '#F2B84B',
  hover: '#63D5FF', warning: '#F87171', text: '#E8F1F7', muted: '#91A5B5', land: '#102334',
});

const format = (value) => Math.round(value ?? 0).toLocaleString();
const serviceLabel = (route) => {
  const headways = (route.timetableSchedule?.periods ?? [])
    .map((period) => Number(period.headwaySeconds))
    .filter((seconds) => seconds > 0);
  if (headways.length) {
    const minimum = Math.min(...headways);
    const maximum = Math.max(...headways);
    const formatMinutes = (seconds) => `${Math.round(seconds / 60)} min`;
    return minimum === maximum ? formatMinutes(minimum) : `${formatMinutes(minimum)}–${formatMinutes(maximum)}`;
  }
  const trains = Number(route.trainSchedule?.highDemand ?? route.trainSchedule?.mediumDemand ?? route.trainSchedule?.lowDemand);
  return trains > 0 ? `${trains} trains` : 'No scheduled service';
};
const pointsAttribute = (points) => points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
const pathAttribute = (coordinates, view) => coordinates.map((coordinate, index) => {
  const [x, y] = projectCoordinate(coordinate, view, TILE_MAP_VIEWPORT);
  return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
}).join(' ');

export class TileMapController {
  constructor({ api, runtime, navigation, catalog = tileCatalog }) {
    this.api = api; this.runtime = runtime; this.navigation = navigation; this.catalog = catalog;
    this.mapView = fitBoundsView(catalogBounds(catalog.tiles), TILE_MAP_VIEWPORT, 28, catalog);
    this.hoveredTileId = null; this.switchingTileId = null; this.listeners = new Set();
    this.unsubscribeRuntime = runtime.subscribe?.(() => this.#emit());
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  #emit() { for (const listener of this.listeners) listener(this.snapshot()); }

  #activeTileId(runtimeView = this.runtime.view()) {
    const loadedTileId = this.api.utils?.getCityCode?.();
    return this.catalog.tiles.some((tile) => tile.id === loadedTileId)
      ? loadedTileId
      : runtimeView.activeTileId;
  }

  snapshot() {
    const runtimeView = this.runtime.view();
    const activeTileId = this.#activeTileId(runtimeView);
    return {
      mapView: { center: [...this.mapView.center], zoom: this.mapView.zoom },
      activeTileId,
      hoveredTileId: this.hoveredTileId,
      switchingTileId: this.switchingTileId,
      projectionWarning: runtimeView.projectionWarning ?? null,
      partialRouteServices: runtimeView.partialRouteServices ?? [],
      commutes: runtimeView.commutes,
      tiles: this.catalog.tiles.map((tile) => ({
        ...tile,
        commute: runtimeView.commutesByTile?.[tile.id] ?? null,
        active: tile.id === activeTileId,
        suggested: runtimeView.projectionWarning?.suggestedTileIds?.includes(tile.id) ?? false,
      })),
    };
  }

  setHoveredTile(tileId) {
    this.hoveredTileId = tileId && this.catalog.tiles.some((tile) => tile.id === tileId) ? tileId : null;
    this.#emit();
  }

  zoomBy(delta, anchor = [TILE_MAP_VIEWPORT.width / 2, TILE_MAP_VIEWPORT.height / 2]) {
    this.mapView = zoomViewAt(this.mapView, delta, anchor, TILE_MAP_VIEWPORT, this.catalog);
    this.#emit();
  }

  panBy(deltaPixels) { this.mapView = panView(this.mapView, deltaPixels); this.#emit(); }
  resetView() { this.mapView = fitBoundsView(catalogBounds(this.catalog.tiles), TILE_MAP_VIEWPORT, 28, this.catalog); this.#emit(); }

  async switchTo(tileId) {
    const tile = this.catalog.tiles.find((candidate) => candidate.id === tileId);
    if (!tile) throw new Error(`Unknown tile: ${tileId}`);
    if (this.#activeTileId() === tileId) return { status: 'already-active', tileId };
    if (this.switchingTileId) return { status: 'already-switching', tileId: this.switchingTileId };
    this.switchingTileId = tileId; this.#emit();
    try {
      this.api.ui.showNotification?.(`Switching to ${tile.name}…`, 'info', 'Open World');
      const transition = await this.runtime.stageNavigationTransition(tileId);
      this.navigation.navigateTo(transition);
      return transition;
    } catch (error) {
      this.api.ui.showNotification?.(`Tile switch failed: ${error.message}`, 'error', 'Open World');
      throw error;
    } finally {
      this.switchingTileId = null; this.#emit();
    }
  }
}

export function TileAtlasPanel({ React, controller }) {
  const h = React.createElement;
  const [, redraw] = React.useState(0);
  const drag = React.useRef(null);
  const suppressClick = React.useRef(false);
  React.useEffect(() => controller.subscribe(() => redraw((value) => value + 1)), [controller]);
  const snapshot = controller.snapshot();
  const grid = visibleSlippyGrid(snapshot.mapView, TILE_MAP_VIEWPORT);
  const focusTile = snapshot.tiles.find((tile) => tile.id === snapshot.hoveredTileId)
    ?? snapshot.tiles.find((tile) => tile.active);

  const pointerPosition = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [event.clientX - bounds.left, event.clientY - bounds.top];
  };
  const requestTileSwitch = (tileId) => {
    void controller.switchTo(tileId).catch(() => {});
  };
  const onPointerDown = (event) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = [event.clientX, event.clientY];
    const tileId = event.target?.dataset?.tileId
      ?? event.target?.closest?.('[data-tile-id]')?.dataset?.tileId
      ?? null;
    suppressClick.current = false;
    drag.current = { origin: point, point, moved: false, tileId };
  };
  const onPointerMove = (event) => {
    if (!drag.current) return;
    const next = [event.clientX, event.clientY];
    const delta = [next[0] - drag.current.point[0], next[1] - drag.current.point[1]];
    const displacement = [next[0] - drag.current.origin[0], next[1] - drag.current.origin[1]];
    if (displacement[0] ** 2 + displacement[1] ** 2 >= DRAG_THRESHOLD_PX ** 2) drag.current.moved = true;
    drag.current.point = next;
    controller.panBy(delta);
  };
  const onPointerUp = (event) => {
    const gesture = drag.current;
    suppressClick.current = Boolean(gesture);
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (gesture?.tileId && !gesture.moved) requestTileSwitch(gesture.tileId);
  };
  const selectTile = (tileId) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    requestTileSwitch(tileId);
  };

  const mapChildren = [
    h('rect', { key: 'land', x: 0, y: 0, width: TILE_MAP_VIEWPORT.width, height: TILE_MAP_VIEWPORT.height, fill: COLORS.land }),
    ...grid.vertical.map((line) => h('line', { key: `vx-${line.index}`, x1: line.position, x2: line.position, y1: 0, y2: TILE_MAP_VIEWPORT.height, stroke: COLORS.grid, strokeWidth: 1, opacity: 0.55 })),
    ...grid.horizontal.map((line) => h('line', { key: `hy-${line.index}`, x1: 0, x2: TILE_MAP_VIEWPORT.width, y1: line.position, y2: line.position, stroke: COLORS.grid, strokeWidth: 1, opacity: 0.55 })),
    ...(controller.catalog.context ?? []).map((feature, index) => h('path', {
      key: `context-${index}`, d: pathAttribute(feature.coordinates, snapshot.mapView), fill: 'none',
      stroke: COLORS.water, strokeWidth: 8, strokeLinecap: 'round', opacity: 0.9, pointerEvents: 'none',
    })),
    ...snapshot.tiles.flatMap((tile) => {
      const polygon = boundsPolygon(tile.bounds, snapshot.mapView, TILE_MAP_VIEWPORT);
      const hovered = tile.id === snapshot.hoveredTileId;
      const stroke = hovered ? COLORS.hover : tile.suggested ? COLORS.warning : tile.active ? COLORS.active : COLORS.muted;
      const fill = hovered ? 'rgba(99,213,255,0.20)' : tile.suggested ? 'rgba(248,113,113,0.20)' : tile.active ? 'rgba(242,184,75,0.15)' : 'rgba(145,165,181,0.06)';
      const center = polygon.reduce((sum, point) => [sum[0] + point[0] / 4, sum[1] + point[1] / 4], [0, 0]);
      return [
        h('polygon', {
          key: `tile-${tile.id}`, points: pointsAttribute(polygon), fill, stroke,
          strokeWidth: hovered ? 3 : tile.suggested ? 2.75 : tile.active ? 2.25 : 1, strokeDasharray: tile.active || tile.suggested || hovered ? undefined : '4 4',
          tabIndex: 0, role: 'button', 'aria-label': `${tile.name}${tile.active ? ', current tile' : ', switch tile'}`,
          'data-tile-id': tile.id,
          style: { cursor: tile.active ? 'default' : 'pointer', outline: 'none' },
          onMouseEnter: () => controller.setHoveredTile(tile.id), onMouseLeave: () => controller.setHoveredTile(null),
          onFocus: () => controller.setHoveredTile(tile.id), onBlur: () => controller.setHoveredTile(null),
          onClick: (event) => { if (event?.detail === 0) requestTileSwitch(tile.id); else selectTile(tile.id); },
          onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); requestTileSwitch(tile.id); } },
        }),
        h('text', {
          key: `label-${tile.id}`, x: center[0], y: center[1], fill: hovered ? COLORS.hover : tile.suggested ? COLORS.warning : tile.active ? COLORS.active : COLORS.text,
          textAnchor: 'middle', dominantBaseline: 'middle', fontSize: 11, fontWeight: 700,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', pointerEvents: 'none',
        }, tile.id),
      ];
    }),
  ];

  const commute = focusTile?.commute;
  return h('div', { className: 'flex flex-col gap-3 p-2' },
    h('div', { className: 'relative overflow-hidden rounded-md border', style: { background: COLORS.map, overscrollBehavior: 'contain' } },
      h('svg', {
        viewBox: `0 0 ${TILE_MAP_VIEWPORT.width} ${TILE_MAP_VIEWPORT.height}`,
        width: '100%', height: TILE_MAP_VIEWPORT.height, role: 'application', 'aria-label': `Zoomable ${controller.catalog.name} tile atlas`,
        style: { display: 'block', background: COLORS.map, touchAction: 'none', cursor: drag.current ? 'grabbing' : 'grab' },
        onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
        onWheel: (event) => { event.stopPropagation(); controller.zoomBy(event.deltaY < 0 ? 0.5 : -0.5, pointerPosition(event)); },
      }, ...mapChildren)),
    snapshot.projectionWarning && h('div', {
      className: 'rounded-md border p-2 text-xs leading-5',
      style: { borderColor: COLORS.warning, color: COLORS.warning, background: 'rgba(248,113,113,0.08)' },
    }, snapshot.projectionWarning.message),
    focusTile && h('div', { className: 'rounded-md border p-2 text-xs leading-5' },
      h('div', { className: 'flex items-center justify-between gap-2' },
        h('div', { className: 'font-medium' }, `${focusTile.name}${focusTile.active ? ' · viewing' : ''}`),
        h('div', { className: 'font-mono text-[10px] text-muted-foreground' }, focusTile.id)),
      commute && h('div', { className: 'text-muted-foreground' },
        `Present ${format(commute.present)} · waiting ${format(commute.waitingToLeave)} · inbound ${format(commute.inboundInTransit)}`),
      snapshot.switchingTileId === focusTile.id && h('div', { className: 'text-[11px]', style: { color: COLORS.hover } }, 'Switching…')),
    snapshot.partialRouteServices.length > 0 && h('div', { className: 'rounded-md border p-2 text-xs' },
      h('div', { className: 'mb-1 font-medium' }, 'Routes continuing outside view'),
      ...snapshot.partialRouteServices.map((route) => h('div', {
        key: route.id, className: 'flex items-center justify-between gap-2 py-1 text-muted-foreground',
      },
      h('div', { className: 'flex min-w-0 items-center gap-2' },
        h('span', { className: 'h-2 w-2 shrink-0 rounded-full', style: { backgroundColor: route.color } }),
        h('span', { className: 'truncate' }, route.name),
        h('span', { className: 'font-mono text-[10px]' }, `${route.orderedStationIds?.length ?? 0} stops`)),
      h('span', { className: 'shrink-0 font-mono text-[10px]' }, serviceLabel(route))))),
    snapshot.commutes && h('div', { className: 'flex items-center justify-between text-[11px] text-muted-foreground' },
      h('span', null, 'Cross-tile network backlog'), h('span', { className: 'font-mono' }, format(snapshot.commutes.globalBacklog))));
}

/** Register the catalog-driven save switcher with Subway Builder's native toolbar UI. */
export function registerPrototypePanel({ api, runtime, navigation, catalog, panelId = 'open-world-tile-switcher' }) {
  if (!catalog?.tiles?.length) throw new Error('registerPrototypePanel requires an explicit World tile catalog');
  if (typeof api?.ui?.addToolbarPanel !== 'function') throw new Error('ui.addToolbarPanel is unavailable');
  const React = api.utils?.React;
  if (typeof React?.createElement !== 'function') throw new Error('Native React UI is unavailable');

  api.ui.unregisterComponent?.('top-bar', panelId);
  const controller = new TileMapController({ api, runtime, navigation, catalog });
  controller.panelRegistration = api.ui.addToolbarPanel({
    id: panelId, icon: 'Map', tooltip: 'Open tile atlas', title: 'World tiles', width: 368,
    render: () => React.createElement(TileAtlasPanel, { React, controller }),
  });
  return controller;
}
