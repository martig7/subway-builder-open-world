"""Publish polygon-filtered building indexes and MVT layers from map artifacts.

Keep complete intersecting buildings; never simplify geometry or alter roads,
labels, demand, heights, foundations or OSM identities. Work happens offline.
"""
from __future__ import annotations

import argparse
from collections import Counter
import gzip
import hashlib
import json
import math
import mmap
import shutil
from pathlib import Path
import struct
import time

import numpy as np
import shapely
from shapely.geometry import Polygon, shape

VERSION = 'ownership-building-filter-v1'
HEADER = struct.Struct('<IBBH8I6d')
NAMES = ['magic', 'version', 'flags', 'reserved', 'buildings', 'cols', 'rows',
         'rings', 'coords', 'cells', 'refs', 'osmIds', 'cellSize', 'maxDepth',
         'minLon', 'minLat', 'maxLon', 'maxLat']


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def sections(header):
    h = header
    entries = [('bounds', '<f8', h['buildings'] * 4, False),
               ('depths', '<f4', h['buildings'], False),
               ('buildingRings', '<u4', h['buildings'] + 1, True),
               ('ringCoords', '<u4', h['rings'] + 1, False),
               ('coords', '<f8', h['coords'] * 2, True),
               ('rowStarts', '<u4', h['rows'] + 1, False),
               ('cellCols', '<u4', h['cells'], False),
               ('cellOffsets', '<u4', h['cells'] + 1, False),
               ('cellIds', '<u4', h['refs'], False)]
    if h['flags'] & 1:
        entries.append(('heights', '<f4', h['buildings'], True))
    if h['flags'] & 2:
        entries.extend([('osmOffsets', '<u4', h['buildings'] + 1, True),
                        ('osmIds', '<f8', h['osmIds'], True)])
    offset = HEADER.size
    result = {}
    for name, dtype, count, aligned in entries:
        if aligned:
            offset = (offset + 7) & ~7
        result[name] = (offset, dtype, count)
        offset += np.dtype(dtype).itemsize * count
    return result, offset


def decode_index(raw):
    h = dict(zip(NAMES, HEADER.unpack_from(raw)))
    if h['magic'] != 0x49424253 or h['version'] != 1 or h['flags'] & ~3:
        raise ValueError('Unsupported native building index')
    layout, size = sections(h)
    if size != len(raw):
        raise ValueError(f'Building index size mismatch: {size} != {len(raw)}')
    arrays = {name: np.frombuffer(raw, dtype=dtype, count=count, offset=offset)
              for name, (offset, dtype, count) in layout.items()}
    for name, total in [('buildingRings', h['rings']), ('ringCoords', h['coords']),
                        ('rowStarts', h['cells']), ('cellOffsets', h['refs'])]:
        values = arrays[name]
        if values[0] != 0 or values[-1] != total or np.any(values[1:] < values[:-1]):
            raise ValueError(f'Invalid {name}')
    if len(arrays['cellIds']) and arrays['cellIds'].max() >= h['buildings']:
        raise ValueError('Invalid building cell reference')
    if 'osmOffsets' in arrays:
        offsets = arrays['osmOffsets']
        if offsets[0] != 0 or offsets[-1] != h['osmIds'] or np.any(offsets[1:] < offsets[:-1]):
            raise ValueError('Invalid OSM offsets')
    return h, arrays


def encode_index(header, arrays):
    layout, size = sections(header)
    raw = bytearray(size)
    HEADER.pack_into(raw, 0, *(header[name] for name in NAMES))
    for name, (offset, dtype, count) in layout.items():
        values = np.asarray(arrays[name], dtype=dtype).reshape(-1)
        if len(values) != count:
            raise ValueError(f'Incorrect {name} section length')
        memoryview(raw)[offset:offset + values.nbytes] = values.tobytes()
    return raw


def polygon_at(arrays, building):
    rings = []
    coords = arrays['coords'].reshape(-1, 2)
    for ring in range(int(arrays['buildingRings'][building]), int(arrays['buildingRings'][building + 1])):
        rings.append(coords[arrays['ringCoords'][ring]:arrays['ringCoords'][ring + 1]])
    polygon = Polygon(rings[0], rings[1:])
    return polygon if polygon.is_valid else shapely.make_valid(polygon)


def cumulative(counts):
    return np.concatenate((np.array([0], dtype='<u4'), np.cumsum(counts, dtype='<u4')))


def filter_index(raw, mask, progress=print):
    h, a = decode_index(raw)
    shapely.prepare(mask)
    bounds = a['bounds'].reshape(-1, 4)
    keep = np.zeros(h['buildings'], dtype=bool)
    for start in range(0, len(bounds), 25000):
        batch = bounds[start:start + 25000]
        boxes = shapely.box(*batch.T)
        inside = shapely.covers(mask, boxes)
        ambiguous = np.flatnonzero(shapely.intersects(mask, boxes) & ~inside)
        for local in ambiguous:
            inside[local] = mask.intersects(polygon_at(a, start + local))
        keep[start:start + len(batch)] = inside
        if start % 250000 == 0:
            progress(json.dumps({'stage': 'select-buildings', 'visited': start + len(batch), 'total': len(bounds), 'retainedSoFar': int(keep.sum())}), flush=True)
    if not keep.any():
        raise ValueError('Ownership filter retained no buildings; refusing publication')
    ring_counts = np.diff(a['buildingRings'])
    ring_keep = np.repeat(keep, ring_counts)
    coord_counts = np.diff(a['ringCoords'])
    coord_keep = np.repeat(ring_keep, coord_counts)
    remap = np.full(h['buildings'], -1, dtype='<i4')
    remap[keep] = np.arange(keep.sum(), dtype='<i4')
    references = remap[a['cellIds']]
    ref_keep = references >= 0
    ref_prefix = cumulative(ref_keep)
    cell_counts = np.diff(ref_prefix[a['cellOffsets']])
    cell_keep = cell_counts > 0
    selected = {
        'bounds': bounds[keep].reshape(-1), 'depths': a['depths'][keep],
        'buildingRings': cumulative(ring_counts[keep]),
        'ringCoords': cumulative(coord_counts[ring_keep]),
        'coords': a['coords'].reshape(-1, 2)[coord_keep].reshape(-1),
        'rowStarts': cumulative(cell_keep)[a['rowStarts']],
        'cellCols': a['cellCols'][cell_keep],
        'cellOffsets': cumulative(cell_counts[cell_keep]),
        'cellIds': references[ref_keep].astype('<u4'),
    }
    if 'heights' in a:
        selected['heights'] = a['heights'][keep]
    osm_count = 0
    if 'osmOffsets' in a:
        counts = np.diff(a['osmOffsets'])
        selected['osmOffsets'] = cumulative(counts[keep])
        selected['osmIds'] = a['osmIds'][np.repeat(keep, counts)]
        osm_count = len(selected['osmIds'])
    # Preserve the original grid transform. Empty cells disappear, but moving
    # its origin/extents would change cellSizeLon and invalidate the remap.
    output_header = {**h, 'buildings': int(keep.sum()), 'rings': int(ring_keep.sum()),
                     'coords': int(coord_keep.sum()), 'cells': int(cell_keep.sum()),
                     'refs': int(ref_keep.sum()), 'osmIds': osm_count,
                     'maxDepth': float(selected['depths'].max())}
    output = encode_index(output_header, selected)
    _, verified = decode_index(output)
    for name, values in selected.items():
        if not np.array_equal(values, verified[name]):
            raise ValueError(f'Written building section differs: {name}')
    return output, {'inputBuildings': h['buildings'], 'retainedBuildings': output_header['buildings'],
                    'inputDecodedBytes': len(raw), 'outputDecodedBytes': len(output)}


def mercator_coordinates(coords):
    result = np.empty_like(coords)
    result[:, 0] = (coords[:, 0] + 180) / 360
    result[:, 1] = (1 - np.arcsinh(np.tan(np.radians(coords[:, 1]))) / math.pi) / 2
    return result


def filter_vector_tile(raw, zxy, mask, counts):
    from mapbox_vector_tile.Mapbox import vector_tile_pb2
    from mapbox_vector_tile import decode
    tile = vector_tile_pb2.tile()
    tile.ParseFromString(raw)
    z, x, y = zxy
    scale = 2 ** z
    footprint = shapely.box(x / scale, y / scale, (x + 1) / scale, (y + 1) / scale)
    inside = mask.covers(footprint)
    outside = not mask.intersects(footprint)
    changed = False
    for i in range(len(tile.layers) - 1, -1, -1):
        layer = tile.layers[i]
        if layer.name not in ('building', 'buildings'):
            continue
        counts['inputFeatures'] += len(layer.features)
        if inside:
            counts['retainedFeatures'] += len(layer.features)
            continue
        if outside:
            counts['removedFeatures'] += len(layer.features)
            del tile.layers[i]
            changed = True
            continue
        one_layer = vector_tile_pb2.tile()
        one_layer.layers.add().CopyFrom(layer)
        features = decode(one_layer.SerializeToString(), default_options={'y_coord_down': True})[layer.name]['features']
        extent = layer.extent
        selected = []
        for index, feature in enumerate(features):
            geometry = shape(feature['geometry'])
            def to_world(coords):
                return (coords / extent + np.array([x, y])) / scale
            geometry = shapely.transform(geometry, to_world)
            if not geometry.is_valid:
                geometry = shapely.make_valid(geometry)
            if mask.intersects(geometry):
                selected.append(index)
        counts['retainedFeatures'] += len(selected)
        counts['removedFeatures'] += len(features) - len(selected)
        if len(selected) == len(features):
            continue
        changed = True
        if not selected:
            del tile.layers[i]
        else:
            retained = [layer.features[index] for index in selected]
            del layer.features[:]
            layer.features.extend(retained)
    return tile.SerializeToString() if changed else raw


def update_nonbuilding_digest(digest_value, raw, zxy):
    from mapbox_vector_tile.Mapbox import vector_tile_pb2
    tile = vector_tile_pb2.tile()
    tile.ParseFromString(raw)
    digest_value.update(struct.pack('<3I', *zxy))
    for layer in tile.layers:
        if layer.name in ('building', 'buildings'):
            continue
        encoded = layer.SerializeToString()
        digest_value.update(struct.pack('<I', len(encoded)))
        digest_value.update(encoded)


def filter_pmtiles(source, target, geographic_mask):
    from pmtiles.reader import Reader, all_tiles
    from pmtiles.writer import Writer
    from pmtiles.tile import Compression, zxy_to_tileid
    mask = shapely.transform(geographic_mask, mercator_coordinates)
    shapely.prepare(mask)
    counts = Counter()
    expected = hashlib.sha256()
    with source.open('rb') as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
        get_bytes = lambda offset, length: mapped[offset:offset + length]
        reader = Reader(get_bytes)
        header, metadata = reader.header(), reader.metadata()
        if metadata.get('ownershipBuildingFilter'):
            raise ValueError('Use unfiltered source packages, not an already filtered archive')
        compression = header['tile_compression']
        if compression not in (Compression.GZIP, Compression.NONE):
            raise ValueError('Unsupported tile compression')
        with target.open('wb') as output:
            writer = Writer(output)
            try:
                for zxy, data in all_tiles(get_bytes):
                    raw = gzip.decompress(data) if compression == Compression.GZIP else data
                    update_nonbuilding_digest(expected, raw, zxy)
                    filtered = filter_vector_tile(raw, zxy, mask, counts)
                    encoded = data if filtered == raw else (gzip.compress(filtered, compresslevel=6, mtime=0) if compression == Compression.GZIP else filtered)
                    writer.write_tile(zxy_to_tileid(*zxy), encoded)
                    counts['tiles'] += 1
                    if counts['tiles'] % 1000 == 0:
                        print(json.dumps({'stage': 'filter-map', **counts}), flush=True)
                if not counts['inputFeatures']:
                    raise ValueError('No recognized building layer; refusing publication')
                metadata.pop('tilestats', None)
                metadata['ownershipBuildingFilter'] = VERSION
                writer.finalize(header, metadata)
            finally:
                writer.tile_f.close()
    actual = hashlib.sha256()
    with target.open('rb') as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
        get_bytes = lambda offset, length: mapped[offset:offset + length]
        for zxy, data in all_tiles(get_bytes):
            raw = gzip.decompress(data) if compression == Compression.GZIP else data
            update_nonbuilding_digest(actual, raw, zxy)
    if actual.digest() != expected.digest():
        raise ValueError('Non-building geometry or labels changed during publication')
    return {**counts, 'sourceSha256': digest(source), 'sha256': digest(target),
            'sourceBytes': source.stat().st_size, 'bytes': target.stat().st_size,
            'nonBuildingDigest': actual.hexdigest()}


def publish_package(package, filtered, backup_root):
    """Verify source/output pins, retain originals, publish manifest last."""
    package, filtered, backup_root = map(Path, (package, filtered, backup_root))
    report = json.loads((filtered / 'building-filter.json').read_text())
    if report.get('version') != VERSION or not report.get('map', {}).get('nonBuildingDigest'):
        raise ValueError('Incomplete or unsupported building-filter report')
    manifest_path = package / 'map-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('tileId') != report['tileId']:
        raise ValueError('Filtered package belongs to a different tile')
    pins = {'buildings_index.bin.gz': (report['sourceIndexSha256'], report['indexSha256']),
            'tiles.pmtiles': (report['map']['sourceSha256'], report['map']['sha256'])}
    if any(sum(asset['path'] == name for asset in manifest['assets']) != 1 for name in pins):
        raise ValueError('Manifest must list each building artifact exactly once')
    for name, (source_hash, output_hash) in pins.items():
        if digest(filtered / name) != output_hash:
            raise ValueError(f'Filtered output hash mismatch: {name}')
        if digest(package / name) != source_hash:
            raise ValueError(f'Original package hash mismatch: {name}')
    backup = backup_root / report['tileId']
    backup.mkdir(parents=True, exist_ok=False)
    for name in [*pins, 'map-manifest.json']:
        shutil.copy2(package / name, backup / name)
    try:
        for name in pins:
            staged = package / (name + '.ownership-staged')
            shutil.copy2(filtered / name, staged)
            staged.replace(package / name)
        for asset in manifest['assets']:
            if asset['path'] in pins:
                asset.update(sha256=pins[asset['path']][1], bytes=(package / asset['path']).stat().st_size)
        manifest['buildingOwnership'] = report
        staged_manifest = package / 'map-manifest.ownership-staged'
        staged_manifest.write_text(json.dumps(manifest, indent=2) + '\n')
        staged_manifest.replace(manifest_path)
    except BaseException:
        for name in [*pins, 'map-manifest.json']:
            shutil.copy2(backup / name, package / name)
        raise
    return manifest


def ownership_mask(boundary, tile_id):
    features = [f for f in boundary['features'] if f['properties'].get('tile_id') == tile_id]
    if len(features) != 1:
        raise ValueError(f'Expected exactly one computation boundary for {tile_id}')
    geometry = features[0]['geometry']
    geometry_hash = hashlib.sha256(json.dumps(geometry, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    mask = shape(geometry)
    original_area = mask.area
    if not mask.is_valid:
        mask = shapely.make_valid(mask)
        if mask.geom_type == 'GeometryCollection':
            mask = shapely.union_all([part for part in mask.geoms if part.geom_type in ('Polygon', 'MultiPolygon')])
    if mask.geom_type not in ('Polygon', 'MultiPolygon') or not mask.is_valid or mask.is_empty or abs(mask.area - original_area) > max(1e-9, original_area * 1e-5):
        raise ValueError('Invalid ownership mask')
    return mask, geometry_hash


def verified_publication(package, tile_id, geometry_hash):
    manifest = json.loads((package / 'map-manifest.json').read_text())
    report = manifest.get('buildingOwnership')
    if not report:
        return None
    if (manifest.get('tileId') != tile_id or report.get('tileId') != tile_id or
        report.get('version') != VERSION or report.get('ownershipGeometrySha256') != geometry_hash):
        raise ValueError('Ownership boundary changed; rebuild from unfiltered original packages')
    pins = {'buildings_index.bin.gz': report['indexSha256'], 'tiles.pmtiles': report['map']['sha256']}
    if not report['map'].get('nonBuildingDigest'):
        raise ValueError('Incomplete ownership publication')
    for name, expected in pins.items():
        assets = [a for a in manifest['assets'] if a['path'] == name]
        if (len(assets) != 1 or digest(package / name) != expected or assets[0]['sha256'] != expected or
            assets[0]['bytes'] != (package / name).stat().st_size):
            raise ValueError(f'Published building artifact changed: {name}')
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--boundary', type=Path, required=True)
    parser.add_argument('--tile', required=True)
    parser.add_argument('--boundary-tile', help='Source boundary id when the package uses a different id')
    parser.add_argument('--index', type=Path, required=True)
    parser.add_argument('--pmtiles', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--skip-index', action='store_true', help='Resume map filtering after a verified index rebuild')
    parser.add_argument('--publish-to', type=Path, help='Publish both verified artifacts into this generated package')
    parser.add_argument('--backup-root', type=Path)
    args = parser.parse_args()
    if args.publish_to and (not args.backup_root or not args.pmtiles):
        parser.error('Publishing requires --backup-root and --pmtiles')
    if args.index.resolve() == (args.output / 'buildings_index.bin.gz').resolve() or (
        args.pmtiles and args.pmtiles.resolve() == (args.output / 'tiles.pmtiles').resolve()
    ):
        parser.error('Output must be separate from the original artifacts')
    args.output.mkdir(parents=True, exist_ok=True)
    boundary = json.loads(args.boundary.read_text(encoding='utf-8-sig'))
    mask, geometry_hash = ownership_mask(boundary, args.boundary_tile or args.tile)
    del boundary
    if args.publish_to and verified_publication(args.publish_to, args.tile, geometry_hash):
        print(json.dumps({'stage': 'resumed-publication', 'tileId': args.tile, 'version': VERSION}), flush=True)
        return
    report = {'version': VERSION, 'tileId': args.tile, 'boundarySha256': digest(args.boundary),
              'ownershipGeometrySha256': geometry_hash,
              'sourceIndexSha256': digest(args.index)}
    started = time.monotonic()
    target = args.output / 'buildings_index.bin.gz'
    if args.skip_index:
        previous = json.loads((args.output / 'building-filter.json').read_text())
        if any(previous.get(key) != value for key, value in report.items()) or previous['indexSha256'] != digest(target):
            raise ValueError('Cannot resume a mismatched index build')
        report = previous
    else:
        with gzip.open(args.index, 'rb') as stream:
            raw = stream.read()
        filtered, counts = filter_index(raw, mask)
        del raw
        report.update(counts)
        print(json.dumps({'stage': 'index-selected', **report}), flush=True)
        with target.open('wb') as file, gzip.GzipFile(filename='', mode='wb', fileobj=file, mtime=0, compresslevel=6) as zipped:
            zipped.write(filtered)
        del filtered
        report.update(indexSha256=digest(target), indexBytes=target.stat().st_size)
        (args.output / 'building-filter.json').write_text(json.dumps(report, indent=2) + '\n')
    if args.pmtiles:
        report['map'] = filter_pmtiles(args.pmtiles, args.output / 'tiles.pmtiles', mask)
    report['seconds'] = time.monotonic() - started
    (args.output / 'building-filter.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'stage': 'complete', **report}), flush=True)
    if args.publish_to:
        publish_package(args.publish_to, args.output, args.backup_root)


if __name__ == '__main__':
    main()
