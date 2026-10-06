import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const MAGIC = 0x4f54574f; // OWTO, little endian.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Package the approved coordinates verbatim; this is bundling, not map generation. */
export function packTileOwnershipArtifact({ definition, catalogSource, boundaries, sourceSha256 = null }) {
  if (boundaries?.purpose === 'display-only' || boundaries?.lods || boundaries?.type !== 'FeatureCollection') {
    throw new Error('Tile ownership requires the original ownership FeatureCollection, never display LODs');
  }
  const selected = (catalogSource.tiles ?? []).filter(tile => tile.status === 'selected');
  const tileById = new Map(selected.map(tile => [tile.id, tile]));
  const tileByCode = new Map(selected.filter(tile => tile.prefCode != null).map(tile => [String(tile.prefCode).padStart(2, '0'), tile]));
  const owners = [];
  const ownerById = new Map();
  const parts = [];
  const rings = [];
  let coordinateCount = 0;
  for (const feature of boundaries.features ?? []) {
    const properties = feature.properties ?? {};
    const code = properties.pref_code ?? properties.prefCode;
    const tile = tileById.get(properties.tile_id ?? properties.tileId)
      ?? (code == null ? null : tileByCode.get(String(code).padStart(2, '0')));
    if (!tile) continue;
    let owner = ownerById.get(tile.id);
    if (owner == null) {
      owner = owners.length;
      ownerById.set(tile.id, owner);
      owners.push({ id: tile.id, rank: String(tile.prefCode ?? code ?? tile.id).padStart(2, '0') });
    }
    const geometry = feature.geometry;
    const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon' ? geometry.coordinates : null;
    if (!polygons) throw new Error(`Unsupported ownership geometry for ${tile.id}`);
    for (const polygon of polygons) {
      if (!polygon?.length) throw new Error(`Empty ownership polygon for ${tile.id}`);
      const descriptors = [];
      for (const ring of polygon) {
        if (!Array.isArray(ring) || ring.length < 4
          || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) {
          throw new Error(`Ownership ring must be closed for ${tile.id}`);
        }
        for (const coordinate of ring) {
          if (!Array.isArray(coordinate) || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])
            || Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 90) {
            throw new Error(`Invalid ownership coordinate for ${tile.id}`);
          }
        }
        descriptors.push([coordinateCount, ring.length]);
        rings.push(ring);
        coordinateCount += ring.length;
      }
      parts.push({ owner, rings: descriptors });
    }
  }
  if (!parts.length || selected.some(tile => !ownerById.has(tile.id))) {
    throw new Error('Original ownership geometry is missing a selected Tile View');
  }
  const sourceHash = sourceSha256 ?? hash(JSON.stringify(boundaries));
  const identityHash = hash(JSON.stringify({ definitionId: definition.identity.worldId, sourceHash, owners }));
  const header = Buffer.from(JSON.stringify({ version: 1, definitionId: definition.identity.worldId,
    key: `ownership-v1:${identityHash}`, sourceSha256: sourceHash, owners, parts }));
  const coordinateOffset = Math.ceil((16 + header.length) / 8) * 8;
  const bytes = Buffer.alloc(coordinateOffset + coordinateCount * 16);
  bytes.writeUInt32LE(MAGIC, 0);
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt32LE(header.length, 8);
  bytes.writeUInt32LE(coordinateCount, 12);
  header.copy(bytes, 16);
  let offset = coordinateOffset;
  for (const ring of rings) for (const [longitude, latitude] of ring) {
    bytes.writeDoubleLE(longitude, offset);
    bytes.writeDoubleLE(latitude, offset + 8);
    offset += 16;
  }
  return { key: `ownership-v1:${identityHash}`, gzipBytes: gzipSync(bytes), coordinateCount, partCount: parts.length };
}

export async function loadTileOwnershipArtifact(definition, worldRoot, catalogSource) {
  const relative = definition.tileViews.ownershipBoundary;
  if (!relative) return '';
  const root = path.resolve(worldRoot);
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(`${root}${path.sep}`)) throw new Error('Tile ownership path escapes the World directory');
  const source = await readFile(filename);
  const packed = packTileOwnershipArtifact({ definition, catalogSource, boundaries: JSON.parse(source.toString('utf8')), sourceSha256: hash(source) });
  return packed.gzipBytes.toString('base64');
}
