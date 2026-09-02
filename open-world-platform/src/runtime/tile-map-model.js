const TILE_PIXELS = 256;
const MAX_MERCATOR_LATITUDE = 85.051129;
const EARTH_CIRCUMFERENCE_METRES = 40_075_016.686;

function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }

export function lonLatToWorld([longitude, latitude], zoom) {
  const size = TILE_PIXELS * 2 ** zoom;
  const boundedLatitude = clamp(latitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const radians = boundedLatitude * Math.PI / 180;
  return [
    (longitude + 180) / 360 * size,
    (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * size,
  ];
}

export function worldToLonLat([x, y], zoom) {
  const size = TILE_PIXELS * 2 ** zoom;
  const longitude = x / size * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / size;
  return [longitude, 180 / Math.PI * Math.atan(Math.sinh(n))];
}

export function projectCoordinate(coordinate, view, viewport) {
  const point = lonLatToWorld(coordinate, view.zoom);
  const center = lonLatToWorld(view.center, view.zoom);
  return [viewport.width / 2 + point[0] - center[0], viewport.height / 2 + point[1] - center[1]];
}

export function unprojectPoint(point, view, viewport) {
  const center = lonLatToWorld(view.center, view.zoom);
  return worldToLonLat([
    center[0] + point[0] - viewport.width / 2,
    center[1] + point[1] - viewport.height / 2,
  ], view.zoom);
}

export function zoomViewAt(view, delta, anchor, viewport, limits) {
  const zoom = clamp(view.zoom + delta, limits.minZoom, limits.maxZoom);
  const anchoredCoordinate = unprojectPoint(anchor, view, viewport);
  const anchorWorld = lonLatToWorld(anchoredCoordinate, zoom);
  const centerWorld = [
    anchorWorld[0] - anchor[0] + viewport.width / 2,
    anchorWorld[1] - anchor[1] + viewport.height / 2,
  ];
  return { center: worldToLonLat(centerWorld, zoom), zoom };
}

export function panView(view, deltaPixels) {
  const center = lonLatToWorld(view.center, view.zoom);
  return { ...view, center: worldToLonLat([center[0] - deltaPixels[0], center[1] - deltaPixels[1]], view.zoom) };
}

export function fitBoundsView(bounds, viewport, padding, limits) {
  const [west, south, east, north] = bounds;
  const northWest = lonLatToWorld([west, north], 0);
  const southEast = lonLatToWorld([east, south], 0);
  const spanX = Math.max(1e-9, Math.abs(southEast[0] - northWest[0]));
  const spanY = Math.max(1e-9, Math.abs(southEast[1] - northWest[1]));
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const zoom = clamp(Math.min(
    Math.log2(availableWidth / spanX),
    Math.log2(availableHeight / spanY),
  ), limits.minZoom, limits.maxZoom);
  return {
    center: worldToLonLat([(northWest[0] + southEast[0]) / 2, (northWest[1] + southEast[1]) / 2], 0),
    zoom,
  };
}

export function catalogBounds(tiles) {
  if (!tiles?.length) throw new Error('Tile catalog is empty');
  return tiles.reduce((result, tile) => [
    Math.min(result[0], tile.bounds[0]), Math.min(result[1], tile.bounds[1]),
    Math.max(result[2], tile.bounds[2]), Math.max(result[3], tile.bounds[3]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
}

export function boundsPolygon(bounds, view, viewport) {
  const [west, south, east, north] = bounds;
  return [[west, north], [east, north], [east, south], [west, south]]
    .map((coordinate) => projectCoordinate(coordinate, view, viewport));
}

export function visibleSlippyGrid(view, viewport) {
  const zoom = Math.floor(view.zoom);
  const northWest = lonLatToWorld(unprojectPoint([0, 0], view, viewport), zoom);
  const southEast = lonLatToWorld(unprojectPoint([viewport.width, viewport.height], view, viewport), zoom);
  const firstX = Math.floor(northWest[0] / TILE_PIXELS);
  const lastX = Math.ceil(southEast[0] / TILE_PIXELS);
  const firstY = Math.floor(northWest[1] / TILE_PIXELS);
  const lastY = Math.ceil(southEast[1] / TILE_PIXELS);
  const vertical = [];
  const horizontal = [];
  for (let x = firstX; x <= lastX && vertical.length < 64; x++) {
    const longitude = worldToLonLat([x * TILE_PIXELS, 0], zoom)[0];
    vertical.push({ index: x, position: projectCoordinate([longitude, view.center[1]], view, viewport)[0] });
  }
  for (let y = firstY; y <= lastY && horizontal.length < 64; y++) {
    const latitude = worldToLonLat([0, y * TILE_PIXELS], zoom)[1];
    horizontal.push({ index: y, position: projectCoordinate([view.center[0], latitude], view, viewport)[1] });
  }
  const cellKilometres = EARTH_CIRCUMFERENCE_METRES * Math.cos(view.center[1] * Math.PI / 180) / 2 ** zoom / 1_000;
  return { zoom, vertical, horizontal, cellKilometres };
}
