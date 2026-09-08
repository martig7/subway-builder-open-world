// A fixed local equirectangular map plane, in kilometres. Using the same plane
// for build limits and clipping makes the maximum independent of the origin.
export const DISTANCE_RENDER_VERSION = 'distance-render-km-v1';
const KM_PER_DEGREE = Math.PI * 6371.0088 / 180;

export function renderTileBounds(tile) {
  const points = tile?.boundary;
  const bounds = tile?.bounds ?? (Array.isArray(points) && points.length
    ? [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
      Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))] : null);
  return Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite) ? bounds : null;
}

export function precomputeRenderDistance(catalog) {
  const tiles = [...(catalog?.tiles ?? []).filter(t => !t.status || t.status === 'selected'), ...(catalog?.spatialTiles ?? [])];
  const entries = tiles.map(tile => ({ tile, bounds: renderTileBounds(tile) })).filter(e => e.bounds);
  if (!entries.length) return { version: DISTANCE_RENDER_VERSION, minByTile: {}, max: 1, scale: [KM_PER_DEGREE, KM_PER_DEGREE] };
  const world = [Math.min(...entries.map(e => e.bounds[0])), Math.min(...entries.map(e => e.bounds[1])),
    Math.max(...entries.map(e => e.bounds[2])), Math.max(...entries.map(e => e.bounds[3]))];
  const scale = [KM_PER_DEGREE * Math.cos((world[1] + world[3]) * Math.PI / 360), KM_PER_DEGREE];
  const minByTile = Object.fromEntries(entries.map(({ tile, bounds: b }) => [tile.id,
    Math.hypot((b[2] - b[0]) * scale[0], (b[3] - b[1]) * scale[1]) / 2]));
  const corners = entries.flatMap(({ bounds: b }) => [[b[0], b[1]], [b[0], b[3]], [b[2], b[1]], [b[2], b[3]]]);
  let max = 0;
  for (let i = 0; i < corners.length; i++) for (let j = i + 1; j < corners.length; j++) {
    max = Math.max(max, Math.hypot((corners[i][0] - corners[j][0]) * scale[0], (corners[i][1] - corners[j][1]) * scale[1]));
  }
  return { version: DISTANCE_RENDER_VERSION, scale, worldBounds: world, minByTile, max };
}

const computed = new WeakMap();
export function renderDistanceMetadata(catalog) {
  if (catalog?.renderDistance?.version === DISTANCE_RENDER_VERSION) return catalog.renderDistance;
  if (!catalog) return precomputeRenderDistance(null);
  if (!computed.has(catalog)) computed.set(catalog, precomputeRenderDistance(catalog));
  return computed.get(catalog);
}

export function renderDistanceLimits(catalog, activeTileId) {
  const metadata = renderDistanceMetadata(catalog);
  const min = metadata.minByTile[activeTileId] ?? Object.values(metadata.minByTile)[0] ?? 0.1;
  return { min, max: Math.max(min, metadata.max), default: min, step: 0.1 };
}

export function normalizeRenderDistance(value, limits = { min: 0, max: Infinity, default: 1 }) {
  const numeric = value == null || value === '' ? NaN : Number(value);
  return Math.min(limits.max, Math.max(limits.min, Number.isFinite(numeric) ? numeric : limits.default));
}

export function distanceRenderBounds(tile, metadata, distance, shape) {
  const b = renderTileBounds(tile);
  if (!b) return null;
  const center = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const [sx, sy] = metadata.scale;
  const bounds = [center[0] - distance / sx, center[1] - distance / sy,
    center[0] + distance / sx, center[1] + distance / sy];
  // Bounds remain compatible with broad-phase consumers; exact clipping uses
  // this attached metric region, including binary paths with vertex values.
  bounds.region = Object.freeze({ center, scale: metadata.scale, distance, shape });
  return bounds;
}
