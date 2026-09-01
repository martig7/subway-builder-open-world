/**
 * Renderer-only spatial virtualization.
 *
 * The native network is deliberately not an input to this module's mutation
 * path: all arrays returned here are new arrays and the objects/features they
 * contain are never edited in place.  This keeps the complete network in the
 * save/store while limiting the amount of geometry handed to Deck/MapLibre.
 */

export const DETAILED_RENDER_ZOOM = Object.freeze({ min: 10, maxExclusive: 16 });
export const RENDER_DISTANCE = Object.freeze({ min: 1, default: 3, max: 9 });

const SPATIAL_KEYS = Object.freeze([
  'tracks', 'routes', 'interlines', 'routeGeometry', 'routeGeometries',
  'trains', 'signals', 'previewArtifacts', 'previewRoute', 'popMovements',
  'stationMarkers', 'stationDots', 'markers', 'features', 'stNodes',
  'stationNodes', 'routeNodes', 'stationRouteNodes', 'nodes',
  'connections', 'connectionHints', 'missingConnections',
]);
const MOVEMENT_LAYER_RE = /^(?:trains|signals|preview|pop-movements)(?:-|$)/i;

function finite(value) { return Number.isFinite(Number(value)); }
function number(value) { return Number(value); }

export function normalizeRenderDistance(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return RENDER_DISTANCE.default;
  return Math.min(RENDER_DISTANCE.max, Math.max(RENDER_DISTANCE.min, numeric));
}

/**
 * Odd render distances are complete square windows. Even values are the
 * deliberately lighter intermediate footprints described by the UI: the
 * preceding odd square plus a centered strip on each of its four sides.
 */
export function tileOffsetWithinRenderDistance(deltaColumn, deltaRow, value) {
  const distance = normalizeRenderDistance(value);
  const column = Math.abs(number(deltaColumn));
  const row = Math.abs(number(deltaRow));
  if (!Number.isFinite(column) || !Number.isFinite(row)) return false;
  if (distance % 2 === 1) {
    const radius = (distance - 1) / 2;
    return column <= radius && row <= radius;
  }
  const innerRadius = distance / 2 - 1;
  const outerRadius = innerRadius + 1;
  const sideHalfWidth = Math.max(0, (distance - 4) / 2);
  return (column <= innerRadius && row <= innerRadius)
    || (column === outerRadius && row <= sideHalfWidth)
    || (row === outerRadius && column <= sideHalfWidth);
}

function boundsOf(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [a, b, c, d] = value.map(number);
  if (![a, b, c, d].every(Number.isFinite)) return null;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

function tilePosition(tile, fallbackIndex = 0) {
  const column = finite(tile?.column) ? number(tile.column) : null;
  const row = finite(tile?.row) ? number(tile.row) : null;
  if (column != null && row != null) return [column, row];
  return [fallbackIndex, 0];
}

function tileBounds(tile) {
  if (Array.isArray(tile?.bounds)) return boundsOf(tile.bounds);
  const ring = tile?.boundary;
  if (!Array.isArray(ring)) return null;
  const points = ring.filter((point) => Array.isArray(point) && point.length >= 2);
  if (!points.length) return null;
  const xs = points.map((point) => number(point[0])).filter(Number.isFinite);
  const ys = points.map((point) => number(point[1])).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function boundsIntersect(left, right) {
  return Boolean(left && right)
    && left[0] <= right[2] && left[2] >= right[0]
    && left[1] <= right[3] && left[3] >= right[1];
}

function pointInBounds(point, bounds) {
  return Array.isArray(point) && point.length >= 2
    && finite(point[0]) && finite(point[1])
    && number(point[0]) >= bounds[0] && number(point[0]) <= bounds[2]
    && number(point[1]) >= bounds[1] && number(point[1]) <= bounds[3];
}

function geometryBounds(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const points = [];
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && finite(value[0]) && finite(value[1])) points.push(value);
    else value.forEach(visit);
  };
  visit(geometry.coordinates);
  if (!points.length) return null;
  const xs = points.map((point) => number(point[0]));
  const ys = points.map((point) => number(point[1]));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function geometryOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.type && value.coordinates) return value;
  if (value.geometry?.coordinates) return value.geometry;
  if (value.feature?.geometry?.coordinates) return value.feature.geometry;
  if (Array.isArray(value.coordinates)) {
    const first = value.coordinates.find((point) => Array.isArray(point));
    if (first && Array.isArray(first) && finite(first[0]) && finite(first[1])) {
      return { type: value.coordinates.length > 1 ? 'LineString' : 'Point', coordinates: value.coordinates };
    }
  }
  const point = value.coords ?? value.center ?? value.position ?? value.lngLat;
  if (Array.isArray(point) && point.length >= 2 && finite(point[0]) && finite(point[1])) {
    return { type: 'Point', coordinates: point.slice(0, 2) };
  }
  if (point && typeof point === 'object' && finite(point.lng) && finite(point.lat)) {
    return { type: 'Point', coordinates: [number(point.lng), number(point.lat)] };
  }
  const line = value.path
    ?? value.line
    ?? value.centerLine
    ?? value.trackPath
    ?? (Array.isArray(value.coords) && Array.isArray(value.coords[0]) ? value.coords : null);
  if (Array.isArray(line)) return { type: 'LineString', coordinates: line };
  return null;
}

function segmentClipInterval(a, b, bounds) {
  let t0 = 0; let t1 = 1;
  const dx = b[0] - a[0]; const dy = b[1] - a[1];
  const tests = [
    [-dx, a[0] - bounds[0]], [dx, bounds[2] - a[0]],
    [-dy, a[1] - bounds[1]], [dy, bounds[3] - a[1]],
  ];
  for (const [p, q] of tests) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [t0, t1];
}

function segmentClip(a, b, bounds) {
  const interval = segmentClipInterval(a, b, bounds);
  if (!interval) return null;
  const [t0, t1] = interval;
  const dx = b[0] - a[0]; const dy = b[1] - a[1];
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}

function samePoint(a, b) { return a?.[0] === b?.[0] && a?.[1] === b?.[1]; }

/** Clip a line into contiguous pieces, avoiding synthetic closing segments. */
export function clipLineString(coordinates, haloBounds) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
  const pieces = [];
  let current = [];
  for (let index = 1; index < coordinates.length; index += 1) {
    const a = coordinates[index - 1]; const b = coordinates[index];
    if (!Array.isArray(a) || !Array.isArray(b) || !finite(a[0]) || !finite(a[1]) || !finite(b[0]) || !finite(b[1])) {
      if (current.length >= 2) pieces.push(current); current = []; continue;
    }
    const clipped = segmentClip(a, b, haloBounds);
    if (!clipped) { if (current.length >= 2) pieces.push(current); current = []; continue; }
    const [start, end] = clipped;
    if (!current.length) current = [start, end];
    else if (samePoint(current.at(-1), start)) current.push(end);
    else { if (current.length >= 2) pieces.push(current); current = [start, end]; }
  }
  if (current.length >= 2) pieces.push(current);
  return pieces;
}

/**
 * Clip a line and one scalar value per vertex against the union of bounds.
 * Adjacent tile intervals are merged before materializing vertices, preventing
 * duplicate internal-boundary points while keeping custom Deck attributes
 * exactly aligned with each emitted path.
 */
export function clipLineStringWithValues(coordinates, values, haloBounds) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
  if ((!Array.isArray(values) && !ArrayBuffer.isView(values)) || values.length !== coordinates.length) return [];
  if (!Array.isArray(haloBounds)) return [];
  if (!haloBounds.length) return [{
    coordinates: coordinates.map((point) => [...point]),
    values: Array.from(values, Number),
  }];
  const epsilon = 1e-12;
  const pieces = [];
  let current = null;
  const interpolatePoint = (a, b, t) => [
    number(a[0]) + t * (number(b[0]) - number(a[0])),
    number(a[1]) + t * (number(b[1]) - number(a[1])),
  ];
  const interpolateValue = (left, right, t) => number(left) + t * (number(right) - number(left));
  const flush = () => {
    if (current?.coordinates.length >= 2) pieces.push(current);
    current = null;
  };

  for (let index = 1; index < coordinates.length; index += 1) {
    const a = coordinates[index - 1]; const b = coordinates[index];
    const leftValue = number(values[index - 1]); const rightValue = number(values[index]);
    if (!Array.isArray(a) || !Array.isArray(b)
      || !finite(a[0]) || !finite(a[1]) || !finite(b[0]) || !finite(b[1])
      || !Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      flush();
      continue;
    }
    const intervals = haloBounds
      .map((bounds) => segmentClipInterval(a, b, bounds))
      .filter((interval) => interval && interval[1] - interval[0] > epsilon)
      .sort((left, right) => left[0] - right[0]);
    const merged = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous && interval[0] <= previous[1] + epsilon) previous[1] = Math.max(previous[1], interval[1]);
      else merged.push([...interval]);
    }
    if (!merged.length) {
      flush();
      continue;
    }
    for (const [t0, t1] of merged) {
      const start = interpolatePoint(a, b, t0);
      const end = interpolatePoint(a, b, t1);
      const startValue = interpolateValue(leftValue, rightValue, t0);
      const endValue = interpolateValue(leftValue, rightValue, t1);
      if (!current || !samePoint(current.coordinates.at(-1), start)) {
        flush();
        current = { coordinates: [start], values: [startValue] };
      }
      if (!samePoint(current.coordinates.at(-1), end)) {
        current.coordinates.push(end);
        current.values.push(endValue);
      }
    }
  }
  flush();
  return pieces;
}

function clippedGeometry(geometry, halo) {
  // A missing catalog/bounds is an unknown spatial domain, not an empty one.
  // Keep the canonical presentation until a real halo can be established.
  if (!geometry || !Array.isArray(halo)) return null;
  if (!halo.length) return geometry;
  const intersects = (point) => halo.some((bounds) => pointInBounds(point, bounds));
  const linePieces = (line) => halo.flatMap((bounds) => clipLineString(line, bounds));
  switch (geometry.type) {
    case 'Point': return intersects(geometry.coordinates) ? { ...geometry, coordinates: [...geometry.coordinates] } : null;
    case 'MultiPoint': {
      const coordinates = geometry.coordinates.filter(intersects);
      return coordinates.length ? { ...geometry, coordinates: coordinates.map((point) => [...point]) } : null;
    }
    case 'LineString': {
      const pieces = linePieces(geometry.coordinates);
      if (!pieces.length) return null;
      return pieces.length === 1 ? { ...geometry, coordinates: pieces[0] } : { type: 'MultiLineString', coordinates: pieces };
    }
    case 'MultiLineString': {
      const coordinates = geometry.coordinates.flatMap(linePieces);
      return coordinates.length ? { ...geometry, coordinates } : null;
    }
    // Polygon clipping is intentionally conservative.  Filter whole polygons
    // by bounds; clipping polygon rings independently would create giant,
    // invalid closing triangles at a tile edge.
    case 'Polygon': return halo.some((bounds) => boundsIntersect(geometryBounds(geometry), bounds)) ? structuredClone(geometry) : null;
    case 'MultiPolygon': return halo.some((bounds) => boundsIntersect(geometryBounds(geometry), bounds)) ? structuredClone(geometry) : null;
    case 'GeometryCollection': {
      const geometries = (geometry.geometries ?? []).map((item) => clippedGeometry(item, halo)).filter(Boolean);
      return geometries.length ? { ...geometry, geometries } : null;
    }
    default: return null;
  }
}

export function createRendererVirtualization({
  activeTileId,
  tileCatalog,
  renderDistance = RENDER_DISTANCE.default,
  haloRadius,
} = {}) {
  const packageEntries = (tileCatalog?.tiles ?? []).map((tile, index) => ({
    tile, index, id: tile?.id, position: tilePosition(tile, index), bounds: tileBounds(tile),
  }));
  const spatialEntries = (tileCatalog?.spatialTiles ?? []).map((tile, index) => ({
    tile, index: packageEntries.length + index, id: tile?.id,
    position: tilePosition(tile, packageEntries.length + index), bounds: tileBounds(tile),
  }));
  // `tiles` describes loadable packages while `spatialTiles` describes the
  // complete grid, including empty cells.  Rendering must use the latter when
  // present; otherwise a seven-package canary silently turns a 3x3 halo into
  // a four-cell union and makes the clip boundary depend on which packages
  // happen to exist.
  const entries = [];
  const positions = new Set();
  for (const entry of [...packageEntries, ...spatialEntries]) {
    const key = `${entry.position[0]}:${entry.position[1]}`;
    if (positions.has(key)) continue;
    positions.add(key);
    entries.push(entry);
  }
  const active = packageEntries.find((entry) => entry.id === activeTileId)
    ?? entries.find((entry) => entry.id === activeTileId)
    ?? entries[0]
    ?? null;
  const normalizedRenderDistance = normalizeRenderDistance(renderDistance);
  const includesOffset = Number.isFinite(Number(haloRadius))
    ? (deltaColumn, deltaRow) => Math.abs(deltaColumn) <= Number(haloRadius)
      && Math.abs(deltaRow) <= Number(haloRadius)
    : (deltaColumn, deltaRow) => tileOffsetWithinRenderDistance(
      deltaColumn,
      deltaRow,
      normalizedRenderDistance,
    );
  const haloEntries = active
    ? entries.filter((entry) => includesOffset(
      entry.position[0] - active.position[0],
      entry.position[1] - active.position[1],
    ))
    : entries;
  const halo = haloEntries.map((entry) => entry.bounds).filter(Boolean);
  const haloTileIds = haloEntries.map((entry) => entry.id).filter((id) => id != null);
  const inHalo = (point) => !halo.length || halo.some((bounds) => pointInBounds(point, bounds));
  const intersectsHalo = (bounds) => !halo.length || halo.some((item) => boundsIntersect(bounds, item));
  const intersectsGeometry = (value) => {
    const geometry = geometryOf(value);
    return geometry == null || clippedGeometry(geometry, halo) != null;
  };

  const presentation = (value, { clip = true } = {}) => {
    const geometry = geometryOf(value);
    if (!geometry) return value == null ? null : value;
    const clipped = clippedGeometry(geometry, halo);
    if (!clipped) return null;
    if (!clip || clipped === geometry) return value;
    const next = { ...value };
    if (value.geometry?.coordinates) next.geometry = { ...value.geometry, ...clipped };
    else if (value.type && value.coordinates) return clipped;
    else if (Array.isArray(value.coordinates)) next.coordinates = clipped.coordinates;
    else if (Array.isArray(value.coords)) next.coords = clipped.coordinates;
    else if (Array.isArray(value.path)) next.path = clipped.coordinates;
    else if (Array.isArray(value.line)) next.line = clipped.coordinates;
    else if (Array.isArray(value.centerLine)) next.centerLine = clipped.coordinates;
    else if (Array.isArray(value.trackPath)) next.trackPath = clipped.coordinates;
    return next;
  };

  const filterArray = (values, options) => Array.isArray(values)
    ? values.map((value) => presentation(value, options)).filter((value) => value != null)
    : values;

  const renderInputs = (canonical = {}, options = {}) => {
    const next = { ...canonical };
    for (const key of SPATIAL_KEYS) {
      if (Array.isArray(canonical[key])) next[key] = filterArray(canonical[key], options);
    }
    return next;
  };

  return Object.freeze({
    activeTileId: active?.id ?? activeTileId ?? null,
    renderDistance: normalizedRenderDistance,
    haloTileIds: Object.freeze([...haloTileIds]),
    tileIds: Object.freeze([...haloTileIds]),
    haloBounds: Object.freeze(halo.map((bounds) => Object.freeze([...bounds]))),
    bounds: Object.freeze(halo.map((bounds) => Object.freeze([...bounds]))),
    contains: inHalo,
    intersects: intersectsHalo,
    intersectsGeometry,
    geometryOf,
    presentation,
    renderInputs,
  });
}

export function virtualizeRenderInputs({
  activeTileId,
  tileCatalog,
  canonical,
  renderDistance = RENDER_DISTANCE.default,
  haloRadius,
  ...options
} = {}) {
  const virtualization = createRendererVirtualization({
    activeTileId,
    tileCatalog,
    renderDistance,
    haloRadius,
  });
  return { ...virtualization.renderInputs(canonical, options), virtualization };
}

/** Apply the presentation filter to a MapLibre GeoJSON source payload. */
export function virtualizeGeoJsonData(data, virtualization, options = { clip: true }) {
  if (!virtualization || data == null) return data;
  if (Array.isArray(data)) {
    return virtualization.renderInputs({ features: data }, options).features;
  }
  if (Array.isArray(data.features)) {
    const features = virtualization.renderInputs({ features: data.features }, options).features;
    return { ...data, features };
  }
  return data;
}

function layerData(layer) {
  if (Array.isArray(layer?.props?.data)) return ['props', layer.props.data];
  if (Array.isArray(layer?.data)) return ['layer', layer.data];
  return null;
}

function cloneLayer(layer, data, visible) {
  const overrides = { data };
  if (visible != null) overrides.visible = visible;
  if (typeof layer?.clone === 'function') return layer.clone(overrides);
  if (layer?.props && Object.hasOwn(layer.props, 'data')) return { ...layer, props: { ...layer.props, ...overrides } };
  return { ...layer, data, ...(visible == null ? {} : { visible }) };
}

export function virtualizeDeckLayers(layers, { virtualization, zoom, detailedZoom = DETAILED_RENDER_ZOOM } = {}) {
  if (!Array.isArray(layers) || !virtualization) return layers;
  const detailed = !Number.isFinite(Number(zoom)) || (zoom >= detailedZoom.min && zoom < detailedZoom.maxExclusive);
  return layers.map((layer) => {
    const entry = layerData(layer);
    const isMovement = MOVEMENT_LAYER_RE.test(String(layer?.id ?? layer?.props?.id ?? ''));
    const data = entry ? virtualization.renderInputs({ features: entry[1] }, { clip: true }).features : null;
    const visible = isMovement ? ((layer?.props?.visible ?? layer?.visible ?? true) && detailed) : null;
    return entry ? cloneLayer(layer, data, visible) : (isMovement && !detailed ? cloneLayer(layer, undefined, false) : layer);
  });
}

function markerCollection(map) {
  // react-map-gl/react-maplibre passes a MapRef to the mod. The marker
  // registry lives on the underlying native map, not on the ref wrapper.
  const nativeMap = map?.getMap?.() ?? map;
  const candidates = nativeMap?._markers ?? nativeMap?.markers ?? nativeMap?._markerManager?.markers;
  return candidates instanceof Map ? [...candidates.values()]
    : candidates instanceof Set ? [...candidates]
      : Array.isArray(candidates) ? candidates : [];
}

function markerDomCollection(map) {
  const container = map?.getCanvasContainer?.() ?? map?.getContainer?.();
  const elements = container?.querySelectorAll?.('.maplibregl-marker, .mapboxgl-marker');
  return elements ? [...elements] : [];
}

function markerDomElementsInNode(node) {
  const elements = [];
  if (node?.matches?.('.maplibregl-marker, .mapboxgl-marker')) elements.push(node);
  const nested = node?.querySelectorAll?.('.maplibregl-marker, .mapboxgl-marker');
  if (nested) elements.push(...nested);
  return elements;
}

function markerDomAnchorPoint(element) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  const classes = typeof element.className === 'string' ? element.className : '';
  if (/(?:^|\s)(?:maplibregl|mapboxgl)-marker-anchor-bottom(?:\s|$)/.test(classes)) y = rect.bottom;
  if (/(?:^|\s)(?:maplibregl|mapboxgl)-marker-anchor-top(?:\s|$)/.test(classes)) y = rect.top;
  if (/(?:^|\s)(?:maplibregl|mapboxgl)-marker-anchor-left(?:\s|$)/.test(classes)) x = rect.left;
  if (/(?:^|\s)(?:maplibregl|mapboxgl)-marker-anchor-right(?:\s|$)/.test(classes)) x = rect.right;
  return [x, y];
}

function markerDomPosition(map, element) {
  const nativeMap = map?.getMap?.() ?? map;
  const mapContainer = nativeMap?.getContainer?.() ?? map?.getContainer?.();
  const point = markerDomAnchorPoint(element);
  const containerRect = mapContainer?.getBoundingClientRect?.();
  if (!point || !containerRect || typeof nativeMap?.unproject !== 'function') return null;
  const longitudeLatitude = nativeMap.unproject([
    point[0] - containerRect.left,
    point[1] - containerRect.top,
  ]);
  if (!longitudeLatitude || !finite(longitudeLatitude.lng) || !finite(longitudeLatitude.lat)) return null;
  return [number(longitudeLatitude.lng), number(longitudeLatitude.lat)];
}

const STATION_MARKER_MOVEMENT_BATCH_KEY = Symbol.for('open-world.station-marker-movement-batch');
const STATION_MARKER_MOVEMENT_BATCH_VERSION = 1;

/**
 * Best-effort reversible adapter for native React/MapLibre markers.  The game
 * does not expose its marker registry in the shipped MapLibre build, so the
 * DOM marker elements are also inspected. Their screen-space anchor is
 * converted back to a geographic point with MapLibre's unproject method.
 * Coordinates are cached after the first visible pass because a hidden DOM
 * element has a zero-sized bounding box. Native marker movement is dispatched
 * through one adapter-owned listener per event instead of one listener per
 * marker; a map-level owner makes that replacement reversible across reloads.
 */
export function createStationMarkerVisibilityAdapter({
  map,
  virtualization,
  movementVisible = true,
  onApply,
  measure,
} = {}) {
  const nativeMap = map?.getMap?.() ?? map;
  const originals = new Map();
  const positions = new Map();
  const pendingDomElements = new Set();
  const managedMarkers = new Map();
  const movingMarkers = new Set();
  let currentVirtualization = virtualization;
  let currentMovementVisible = movementVisible !== false;
  let scheduled = false;
  let disposed = false;
  let movementListenersAttached = false;
  let movementReleased = false;
  let movementBatchOwner = null;
  function handleMarkerMovement(event) {
    for (const marker of [...movingMarkers]) {
      if (marker?._map !== nativeMap) {
        movingMarkers.delete(marker);
        managedMarkers.delete(marker);
        continue;
      }
      const update = managedMarkers.get(marker);
      update?.call?.(marker, event);
    }
    syncMovementListeners();
  }
  function syncMovementListeners() {
    const shouldAttach = !movementReleased && currentMovementVisible && movingMarkers.size > 0;
    if (shouldAttach === movementListenersAttached) return;
    movementListenersAttached = shouldAttach;
    const method = shouldAttach ? 'on' : 'off';
    nativeMap?.[method]?.('move', handleMarkerMovement);
    nativeMap?.[method]?.('moveend', handleMarkerMovement);
  }
  function manageMarkerMovement(marker, visible) {
    if (movementReleased || !marker || marker._map !== nativeMap || typeof marker._update !== 'function') return;
    if (!managedMarkers.has(marker)) {
      const nativeUpdate = marker._update;
      nativeMap?.off?.('move', nativeUpdate);
      nativeMap?.off?.('moveend', nativeUpdate);
      managedMarkers.set(marker, nativeUpdate);
    }
    const shouldMove = visible && currentMovementVisible;
    const wasMoving = movingMarkers.has(marker);
    if (shouldMove) movingMarkers.add(marker);
    else movingMarkers.delete(marker);
    if (shouldMove && !wasMoving) managedMarkers.get(marker)?.call?.(marker);
    syncMovementListeners();
  }
  function releaseMarkerMovement() {
    if (movementReleased) return;
    movementReleased = true;
    movingMarkers.clear();
    syncMovementListeners();
    for (const [marker, nativeUpdate] of managedMarkers) {
      if (marker?._map !== nativeMap) continue;
      nativeMap?.on?.('move', nativeUpdate);
      nativeMap?.on?.('moveend', nativeUpdate);
      nativeUpdate.call?.(marker);
    }
    managedMarkers.clear();
    if (nativeMap?.[STATION_MARKER_MOVEMENT_BATCH_KEY] === movementBatchOwner) {
      try { delete nativeMap[STATION_MARKER_MOVEMENT_BATCH_KEY]; } catch {}
    }
  }
  nativeMap?.[STATION_MARKER_MOVEMENT_BATCH_KEY]?.release?.();
  movementBatchOwner = Object.freeze({
    version: STATION_MARKER_MOVEMENT_BATCH_VERSION,
    release: releaseMarkerMovement,
  });
  if (nativeMap) {
    try {
      Object.defineProperty(nativeMap, STATION_MARKER_MOVEMENT_BATCH_KEY, {
        configurable: true,
        writable: true,
        value: movementBatchOwner,
      });
    } catch {
      try { nativeMap[STATION_MARKER_MOVEMENT_BATCH_KEY] = movementBatchOwner; } catch {}
    }
  }
  const setVisibility = (element, point, marker = null) => {
    if (!element || !point || !currentVirtualization) return;
    if (!originals.has(element)) originals.set(element, {
      display: element.style?.display ?? '',
      visibility: element.style?.visibility ?? '',
    });
    positions.set(element, point);
    const original = originals.get(element);
    const visible = currentVirtualization.contains(point);
    if (element.style) {
      element.style.display = visible ? original.display : 'none';
      element.style.visibility = visible ? original.visibility : 'hidden';
    }
    if (element.dataset) element.dataset.openWorldSpatialMarker = visible ? 'visible' : 'hidden';
    if (marker) manageMarkerMovement(marker, visible);
  };
  const applyUnmeasured = (domElements = null) => {
    if (disposed) return originals.size;
    scheduled = false;
    const processed = new Set();
    for (const marker of markerCollection(map)) {
      const element = marker?.getElement?.(); const position = marker?.getLngLat?.();
      if (!element || !position || !currentVirtualization) continue;
      processed.add(element);
      setVisibility(element, [number(position.lng), number(position.lat)], marker);
    }
    for (const element of domElements ?? markerDomCollection(map)) {
      if (processed.has(element)) continue;
      const point = markerDomPosition(map, element) ?? positions.get(element);
      setVisibility(element, point);
    }
    onApply?.();
    return originals.size;
  };
  const apply = (domElements = null) => (typeof measure === 'function'
    ? measure('marker.adapter.apply', () => applyUnmeasured(domElements), {
      suppliedDomElements: domElements?.length ?? null,
    })
    : applyUnmeasured(domElements));
  const scheduleApply = (elements = []) => {
    for (const element of elements) pendingDomElements.add(element);
    if (scheduled) return;
    scheduled = true;
    const run = () => {
      const targets = pendingDomElements.size ? [...pendingDomElements] : null;
      pendingDomElements.clear();
      apply(targets);
    };
    if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(run);
    else if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(run);
    else run();
  };
  const observerTarget = map?.getCanvasContainer?.() ?? map?.getContainer?.();
  const Observer = globalThis.MutationObserver;
  const observer = Observer && observerTarget
    ? new Observer((records) => {
      const addedMarkers = [];
      for (const record of records ?? []) {
        for (const node of record?.addedNodes ?? []) {
          addedMarkers.push(...markerDomElementsInNode(node));
        }
      }
      if (addedMarkers.length) scheduleApply(addedMarkers);
    })
    : null;
  observer?.observe(observerTarget, { childList: true, subtree: true });
  const reset = () => {
    disposed = true;
    observer?.disconnect?.();
    scheduled = false;
    releaseMarkerMovement();
    for (const [element, original] of originals) {
      if (element.style) { element.style.display = original.display; element.style.visibility = original.visibility; }
      try { if (element.dataset) delete element.dataset.openWorldSpatialMarker; } catch {}
    }
    originals.clear();
    positions.clear();
    pendingDomElements.clear();
  };
  const updateVirtualization = (nextVirtualization) => {
    if (disposed || !nextVirtualization) return false;
    const previousSignature = currentVirtualization
      ? String(currentVirtualization.activeTileId ?? '') + '|'
        + (currentVirtualization.haloTileIds ?? []).join(',')
      : '';
    const nextSignature = String(nextVirtualization.activeTileId ?? '') + '|'
      + (nextVirtualization.haloTileIds ?? []).join(',');
    currentVirtualization = nextVirtualization;
    if (previousSignature === nextSignature) return false;
    apply();
    return true;
  };
  const updateMovementVisibility = (nextVisible) => {
    if (disposed) return false;
    const visible = nextVisible !== false;
    if (visible === currentMovementVisible) return false;
    currentMovementVisible = visible;
    apply();
    return true;
  };
  return Object.freeze({
    apply,
    scheduleApply,
    updateVirtualization,
    updateMovementVisibility,
    reset,
  });
}

export { boundsIntersect, boundsOf, clippedGeometry, geometryOf };
