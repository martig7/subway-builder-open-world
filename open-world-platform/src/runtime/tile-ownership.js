const MAGIC = 0x4f54574f;
const RADIUS_M = 6371008.8;
const DEGREES_M = RADIUS_M * Math.PI / 180;
const DEFAULT_SLICE_MS = 5;
const MAX_COORDINATES = 10_000_000;

function coordinate(value) {
  return Array.isArray(value) && Number.isFinite(value[0]) && Number.isFinite(value[1])
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90 ? value : null;
}

/** NAD83 / UTM 18N (EPSG:26918), sixth-order Krueger forward series.
 * GRS80 constants and series follow GeographicLib TransverseMercator (MIT/X11).
 * Unlike inverse-projected grid corners, this retains the original curved edges.
 */
export function projectNad83Utm18(value) {
  const point = coordinate(value);
  if (!point || point[1] < 0 || point[1] > 84 || Math.abs(point[0] + 75) > 45) return null;
  const f = 1 / 298.257222101;
  const n = f / (2 - f);
  const e = Math.sqrt(f * (2 - f));
  const phi = point[1] * Math.PI / 180;
  const lambda = (point[0] + 75) * Math.PI / 180;
  const tau = Math.tan(phi);
  const sigma = Math.sinh(e * Math.atanh(e * tau / Math.hypot(1, tau)));
  const tauPrime = tau * Math.hypot(1, sigma) - sigma * Math.hypot(1, tau);
  const xiPrime = Math.atan2(tauPrime, Math.cos(lambda));
  const etaPrime = Math.asinh(Math.sin(lambda) / Math.hypot(tauPrime, Math.cos(lambda)));
  const n2 = n * n, n3 = n2 * n, n4 = n2 * n2, n5 = n4 * n, n6 = n3 * n3;
  const alpha = [
    n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
    13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
    61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
    49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
    34729 * n5 / 80640 - 3418889 * n6 / 1995840,
    212378941 * n6 / 319334400,
  ];
  let xi = xiPrime, eta = etaPrime;
  for (let index = 0; index < alpha.length; index++) {
    const order = 2 * (index + 1);
    xi += alpha[index] * Math.sin(order * xiPrime) * Math.cosh(order * etaPrime);
    eta += alpha[index] * Math.cos(order * xiPrime) * Math.sinh(order * etaPrime);
  }
  const scale = 0.9996 * 6378137 / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  return [500000 + scale * eta, scale * xi];
}

function includes(bounds, x, y) { return x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3]; }
function overlaps(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
function combined(parts) {
  const result = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { bounds } of parts) {
    result[0] = Math.min(result[0], bounds[0]); result[1] = Math.min(result[1], bounds[1]);
    result[2] = Math.max(result[2], bounds[2]); result[3] = Math.max(result[3], bounds[3]);
  }
  return result;
}

// AABB tree prunes islands/parts before latitude buckets prune their original edges.
function* buildTree(parts) {
  if (!parts.length) return null;
  const bounds = combined(parts);
  yield;
  if (parts.length <= 8) return { bounds, parts };
  const axis = bounds[2] - bounds[0] > bounds[3] - bounds[1] ? 0 : 1;
  parts.sort((a, b) => (a.bounds[axis] + a.bounds[axis + 2]) - (b.bounds[axis] + b.bounds[axis + 2]));
  const midpoint = parts.length >> 1;
  return { bounds, left: yield* buildTree(parts.slice(0, midpoint)), right: yield* buildTree(parts.slice(midpoint)) };
}

function collectParts(tree, bounds, result) {
  if (!tree || !overlaps(tree.bounds, bounds)) return;
  if (tree.parts) { for (const part of tree.parts) if (overlaps(part.bounds, bounds)) result.push(part); return; }
  collectParts(tree.left, bounds, result); collectParts(tree.right, bounds, result);
}

// Exact determinant fallback prevents an epsilon from creating foreign border owners.
const bits = new DataView(new ArrayBuffer(8));
function binaryValue(value) {
  if (value === 0) return [0n, -1074];
  bits.setFloat64(0, value, false);
  const hi = bits.getUint32(0, false), lo = bits.getUint32(4, false);
  const exponent = (hi >>> 20) & 2047;
  const mantissa = BigInt(hi & 0xfffff) * 0x100000000n + BigInt(lo) + (exponent ? 0x10000000000000n : 0n);
  return [(hi >>> 31) ? -mantissa : mantissa, exponent ? exponent - 1075 : -1074];
}
function orientation(ax, ay, bx, by, x, y) {
  const left = (bx - ax) * (y - ay), right = (by - ay) * (x - ax);
  const determinant = left - right;
  if (Math.abs(determinant) > (Math.abs(left) + Math.abs(right)) * 3.3306690738754716e-16) return Math.sign(determinant);
  const values = [ax, ay, bx, by, x, y].map(binaryValue);
  const exponent = Math.min(...values.map(value => value[1]));
  const [a, b, c, d, p, q] = values.map(([mantissa, power]) => mantissa << BigInt(power - exponent));
  const exact = (c - a) * (q - b) - (d - b) * (p - a);
  return exact < 0n ? -1 : exact > 0n ? 1 : 0;
}

function bucketIndex(ring, latitude) {
  return Math.max(0, Math.min(ring.buckets.length - 1, Math.floor((latitude - ring.bounds[1]) * ring.bucketScale)));
}

function* compileRing(coordinates, offset, count) {
  if (!Number.isInteger(offset) || !Number.isInteger(count) || count < 4 || offset < 0 || (offset + count) * 2 > coordinates.length) {
    throw new Error('Invalid original ownership ring descriptor');
  }
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (let index = offset; index < offset + count; index++) {
    const x = coordinates[index * 2], y = coordinates[index * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) throw new Error('Invalid original ownership coordinate');
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
    if ((index & 255) === 0) yield;
  }
  if (coordinates[offset * 2] !== coordinates[(offset + count - 1) * 2]
    || coordinates[offset * 2 + 1] !== coordinates[(offset + count - 1) * 2 + 1]) throw new Error('Original ownership ring is not closed');
  const bucketCount = Math.min(512, Math.max(8, Math.ceil(count / 64)));
  const ring = { coordinates, offset, count, bounds, bucketScale: bounds[3] > bounds[1] ? bucketCount / (bounds[3] - bounds[1]) : 0,
    buckets: Array.from({ length: bucketCount }, () => []), longSegments: [] };
  for (let index = offset; index < offset + count - 1; index++) {
    const y1 = coordinates[index * 2 + 1], y2 = coordinates[(index + 1) * 2 + 1];
    const first = bucketIndex(ring, Math.min(y1, y2)), last = bucketIndex(ring, Math.max(y1, y2));
    if (last - first > 64) ring.longSegments.push(index);
    else for (let bucket = first; bucket <= last; bucket++) ring.buckets[bucket].push(index);
    if ((index & 255) === 0) yield;
  }
  ring.buckets = ring.buckets.map(values => Uint32Array.from(values));
  ring.longSegments = Uint32Array.from(ring.longSegments);
  yield;
  return ring;
}

function ringLocation(ring, x, y, work) {
  if (!includes(ring.bounds, x, y)) return -1;
  let inside = false;
  const coordinates = ring.coordinates;
  const inspect = index => {
    if (work) work.segmentChecks++;
    const ax = coordinates[index * 2], ay = coordinates[index * 2 + 1];
    const bx = coordinates[index * 2 + 2], by = coordinates[index * 2 + 3];
    if (y < Math.min(ay, by) || y > Math.max(ay, by)) return false;
    if (x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && orientation(ax, ay, bx, by, x, y) === 0) return true;
    if ((ay > y) !== (by > y)) {
      // Exact orientation supplies the crossing sign without dividing nearly horizontal edges.
      const side = orientation(ax, ay, bx, by, x, y);
      if ((by > ay && side > 0) || (by < ay && side < 0)) inside = !inside;
    }
    return false;
  };
  for (const index of ring.buckets[bucketIndex(ring, y)]) if (inspect(index)) return 0;
  for (const index of ring.longSegments) if (inspect(index)) return 0;
  return inside ? 1 : -1;
}

function partCovers(part, x, y, work) {
  if (work) work.partChecks++;
  if (ringLocation(part.rings[0], x, y, work) < 0) return false;
  for (let index = 1; index < part.rings.length; index++) {
    const location = ringLocation(part.rings[index], x, y, work);
    if (location === 1) return false;
    if (location === 0) return true; // Hole boundary is covered; its interior is not.
  }
  return true;
}

function ringIntersectsBox(ring, box) {
  if (!overlaps(ring.bounds, box)) return false;
  const seen = new Set();
  const coordinates = ring.coordinates;
  const intersects = index => {
    if (seen.has(index)) return false;
    seen.add(index);
    const ax = coordinates[index * 2], ay = coordinates[index * 2 + 1];
    const bx = coordinates[index * 2 + 2], by = coordinates[index * 2 + 3];
    if (!overlaps([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)], box)) return false;
    if (includes(box, ax, ay) || includes(box, bx, by)) return true;
    // Segment/rectangle intersection, including touching edges.
    let minimum = 0, maximum = 1;
    for (const [p, q] of [[ax - bx, ax - box[0]], [bx - ax, box[2] - ax], [ay - by, ay - box[1]], [by - ay, box[3] - ay]]) {
      if (p === 0) { if (q < 0) return false; continue; }
      const value = q / p;
      if (p < 0) minimum = Math.max(minimum, value); else maximum = Math.min(maximum, value);
      if (minimum > maximum) return false;
    }
    return true;
  };
  const first = bucketIndex(ring, box[1]), last = bucketIndex(ring, box[3]);
  for (let bucket = first; bucket <= last; bucket++) for (const index of ring.buckets[bucket]) if (intersects(index)) return true;
  for (const index of ring.longSegments) if (intersects(index)) return true;
  return false;
}

function clearanceBox(point, clearanceM) {
  const latitudeMargin = clearanceM / DEGREES_M;
  const latitude = Math.max(Math.abs(point[1] - latitudeMargin), Math.abs(point[1] + latitudeMargin));
  if (latitude >= 90) return null;
  const longitudeMargin = latitudeMargin / Math.cos(latitude * Math.PI / 180);
  const box = [point[0] - longitudeMargin, point[1] - latitudeMargin, point[0] + longitudeMargin, point[1] + latitudeMargin];
  return box[0] >= -180 && box[2] <= 180 ? box : null;
}

function polygonHandle(key, owners, tree, onQueryWork) {
  const rank = owner => owners[owner].rank;
  const ownerAt = value => {
    const point = coordinate(value);
    if (!point) return null;
    const candidates = [];
    collectParts(tree, [point[0], point[1], point[0], point[1]], candidates);
    const work = onQueryWork ? { partChecks: 0, segmentChecks: 0 } : null;
    let winner = null;
    for (const part of candidates) {
      if (winner != null && (rank(part.owner) > rank(winner)
        || (rank(part.owner) === rank(winner) && owners[part.owner].id >= owners[winner].id))) continue;
      if (partCovers(part, point[0], point[1], work)) winner = part.owner;
    }
    onQueryWork?.(work);
    return winner == null ? null : owners[winner].id;
  };
  const contains = (tileId, value, clearanceM = 0) => {
    const point = coordinate(value);
    if (!point || !Number.isFinite(clearanceM) || clearanceM < 0 || ownerAt(point) !== tileId) return false;
    if (clearanceM === 0) return true;
    // Conservative clearance: reject any original edge intersecting a box enclosing the metric disc.
    const box = clearanceBox(point, clearanceM);
    if (!box) return false;
    const candidates = [];
    collectParts(tree, [point[0], point[1], point[0], point[1]], candidates);
    return candidates.some(part => owners[part.owner].id === tileId && partCovers(part, point[0], point[1])
      && !part.rings.some(ring => ringIntersectsBox(ring, box)));
  };
  return Object.freeze({ version: 1, key, ownerAt, contains });
}

async function decodeArtifact(encoded, { cancelled, now, yieldFn, sliceMs, onSlice }) {
  if (typeof encoded !== 'string' || !encoded) throw new Error('Original tile ownership artifact is missing');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(encoded.length / 4 * 3 - padding);
  let written = 0, sliceStart = now();
  // Decode aligned chunks: no multi-megabyte atob string or uninterruptible byte callback loop.
  for (let offset = 0; offset < encoded.length; offset += 32768) {
    const binary = atob(encoded.slice(offset, offset + 32768));
    for (let index = 0; index < binary.length; index++) bytes[written++] = binary.charCodeAt(index);
    if (now() - sliceStart >= sliceMs) {
      onSlice?.(now() - sliceStart);
      if (cancelled()) return null;
      await yieldFn();
      if (cancelled()) return null;
      sliceStart = now();
    }
  }
  onSlice?.(now() - sliceStart);
  if (cancelled()) return null;
  const inflated = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if (cancelled()) return null;
  const view = new DataView(inflated);
  if (view.byteLength < 16 || view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== 1) throw new Error('Unsupported tile ownership artifact');
  const headerLength = view.getUint32(8, true), count = view.getUint32(12, true);
  const offset = Math.ceil((16 + headerLength) / 8) * 8;
  if (headerLength > 4_000_000 || count > MAX_COORDINATES || count === 0 || offset + count * 16 !== view.byteLength) throw new Error('Invalid tile ownership artifact length');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(inflated, 16, headerLength)));
  if (header.version !== 1 || typeof header.key !== 'string' || !Array.isArray(header.owners) || !Array.isArray(header.parts)
    || header.parts.length > 100_000 || !header.parts.length) throw new Error('Invalid tile ownership artifact header');
  const ids = new Set();
  for (const owner of header.owners) {
    if (typeof owner.id !== 'string' || typeof owner.rank !== 'string' || ids.has(owner.id)) throw new Error('Invalid tile ownership owner');
    ids.add(owner.id);
  }
  const coordinates = new Float64Array(inflated, offset, count * 2);
  return { ...header, coordinates };
}

function* compileArtifact(artifact) {
  const parts = [];
  for (const descriptor of artifact.parts) {
    if (!Number.isInteger(descriptor.owner) || !artifact.owners[descriptor.owner]
      || !Array.isArray(descriptor.rings) || !descriptor.rings.length) throw new Error('Invalid tile ownership polygon');
    const rings = [];
    for (const [offset, count] of descriptor.rings) rings.push(yield* compileRing(artifact.coordinates, offset, count));
    parts.push({ owner: descriptor.owner, bounds: rings[0].bounds, rings });
    yield;
  }
  return yield* buildTree(parts);
}

async function contractKey(definition, contract) {
  const bytes = new TextEncoder().encode(JSON.stringify({ definitionId: definition.identity.worldId, contract }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `ownership-v1:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function gridHandle(key, catalog) {
  const grid = catalog.grid;
  if (catalog.crs !== 'EPSG:26918' || !grid || ![grid.originX, grid.originY, grid.tileWidthM, grid.tileHeightM].every(Number.isFinite)
    || grid.tileWidthM <= 0 || grid.tileHeightM <= 0) throw new Error('Unsupported original projected ownership grid');
  const tiles = (catalog.tiles ?? []).filter(tile => tile.status === 'selected');
  const byCell = new Map();
  for (const tile of tiles) {
    const [x1, y1, x2, y2] = tile.ownershipProjected ?? [];
    const expectedX = grid.originX + tile.column * grid.tileWidthM, expectedY = grid.originY + tile.row * grid.tileHeightM;
    if (!Number.isInteger(tile.column) || !Number.isInteger(tile.row)
      || x1 !== expectedX || y1 !== expectedY || x2 !== x1 + grid.tileWidthM || y2 !== y1 + grid.tileHeightM
      || byCell.has(`${tile.column},${tile.row}`)) throw new Error(`Invalid projected ownership rectangle for ${tile.id}`);
    byCell.set(`${tile.column},${tile.row}`, tile);
  }
  const projectedTile = value => {
    const projected = projectNad83Utm18(value);
    if (!projected) return null;
    // Only remove nanometre projection roundoff at an exact integer grid line.
    const position = projected.map((axis, index) => {
      const origin = index === 0 ? grid.originX : grid.originY, size = index === 0 ? grid.tileWidthM : grid.tileHeightM;
      const cells = (axis - origin) / size, nearest = Math.round(cells);
      return Math.abs((cells - nearest) * size) <= 1e-7 ? nearest : cells;
    });
    const tile = byCell.get(`${Math.floor(position[0])},${Math.floor(position[1])}`);
    return tile ? { tile, projected } : null;
  };
  return Object.freeze({ version: 1, key, ownerAt: value => projectedTile(value)?.tile.id ?? null,
    contains(tileId, value, clearanceM = 0) {
      if (!Number.isFinite(clearanceM) || clearanceM < 0) return false;
      const result = projectedTile(value);
      if (!result || result.tile.id !== tileId) return false;
      if (clearanceM === 0) return true;
      // Selected UTM18 footprints have scale <1.01; this margin conservatively encloses ground distance.
      const margin = clearanceM * 1.01, [x, y] = result.projected, [x1, y1, x2, y2] = result.tile.ownershipProjected;
      return x - margin >= x1 && y - margin >= y1 && x + margin < x2 && y + margin < y2;
    } });
}

function rectangularHandle(key, catalog) {
  // Legacy rectangular Worlds only. Explicit polygon/grid declarations never reach this fallback.
  const tiles = (catalog.tiles ?? []).filter(tile => tile.status === 'selected').sort((a, b) => a.id.localeCompare(b.id));
  for (const tile of tiles) if (!Array.isArray(tile.bounds) || tile.bounds.length !== 4 || !tile.bounds.every(Number.isFinite)) throw new Error('Missing original rectangular Tile View bounds');
  const ownerAt = value => { const point = coordinate(value); return point ? tiles.find(tile => includes(tile.bounds, ...point))?.id ?? null : null; };
  return Object.freeze({ version: 1, key, ownerAt, contains(tileId, value, clearanceM = 0) {
    const point = coordinate(value);
    if (!point || !Number.isFinite(clearanceM) || clearanceM < 0 || ownerAt(point) !== tileId) return false;
    if (!clearanceM) return true;
    const tile = tiles.find(item => item.id === tileId), box = clearanceBox(point, clearanceM);
    return box != null && includes(tile.bounds, box[0], box[1]) && includes(tile.bounds, box[2], box[3]);
  } });
}

/** Prepare once per immutable World artifact. Returns null if superseded; never publishes a partial index. */
export async function prepareTileOwnership({ definition, catalogSource, ownershipGzipBase64 = '' }, scheduling = {}) {
  const cancelled = scheduling.isCancelled ?? (() => false);
  const now = scheduling.nowMs ?? (() => performance.now());
  const yieldFn = scheduling.yieldFn ?? (() => new Promise(resolve => setTimeout(resolve, 0)));
  const sliceMs = Math.max(0.1, scheduling.sliceMs ?? DEFAULT_SLICE_MS);
  if (cancelled()) return null;
  if (ownershipGzipBase64) {
    const artifact = await decodeArtifact(ownershipGzipBase64, { cancelled, now, yieldFn, sliceMs, onSlice: scheduling.onSlice });
    if (!artifact || cancelled()) return null;
    if (artifact.definitionId !== definition.identity.worldId) throw new Error('Tile ownership artifact belongs to a different World Definition');
    const ownerIds = new Set(artifact.owners.map(owner => owner.id));
    if ((catalogSource.tiles ?? []).some(tile => tile.status === 'selected' && !ownerIds.has(tile.id))) throw new Error('Tile ownership artifact is missing a selected Tile View');
    const iterator = compileArtifact(artifact);
    let sliceStart = now();
    try {
      while (true) {
        const step = iterator.next();
        if (step.done) {
          scheduling.onSlice?.(now() - sliceStart);
          return cancelled() ? null : polygonHandle(artifact.key, artifact.owners, step.value, scheduling.onQueryWork);
        }
        if (now() - sliceStart >= sliceMs) {
          scheduling.onSlice?.(now() - sliceStart);
          if (cancelled()) return null;
          await yieldFn();
          if (cancelled()) return null;
          sliceStart = now();
        }
      }
    } finally { iterator.return(); }
  }
  if (definition.tileViews.ownershipBoundary) throw new Error('Original polygon ownership artifact is required');
  const selected = (catalogSource.tiles ?? []).filter(tile => tile.status === 'selected');
  const contract = catalogSource.grid ? { crs: catalogSource.crs, grid: catalogSource.grid,
    tiles: selected.map(({ id, column, row, ownershipProjected }) => ({ id, column, row, ownershipProjected })) }
    : { rectangles: selected.map(({ id, bounds }) => ({ id, bounds })) };
  const key = await contractKey(definition, contract);
  if (cancelled()) return null;
  return catalogSource.grid ? gridHandle(key, catalogSource) : rectangularHandle(key, catalogSource);
}
