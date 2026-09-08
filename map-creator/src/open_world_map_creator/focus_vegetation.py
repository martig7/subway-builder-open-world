"""Precompute decorative vegetation with full detail only inside a World."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path

import shapely
from shapely.geometry import shape, mapping, box, Polygon


def focus_vegetation(source, world_mask, world_id, tolerance=.2, minimum_area=.02):
    if world_mask.is_empty or not world_mask.is_valid:
        raise ValueError('Invalid world mask')
    detailed, coarse = [], []
    for feature in source['features']:
        geometry = shape(feature['geometry'])
        if geometry.intersects(world_mask):
            detailed.append(geometry.intersection(world_mask))
        reduced = geometry.simplify(tolerance, preserve_topology=True)
        parts = []
        for part in shapely.get_parts(reduced):
            if part.geom_type != 'Polygon' or part.area < minimum_area:
                continue
            holes = [ring.coords for ring in part.interiors if Polygon(ring).area >= minimum_area / 2]
            parts.append(Polygon(part.exterior.coords, holes))
        coarse.extend(parts)
    # Clip after simplification: coarser foreign geometry must never overwrite
    # domestic holes or add vegetation inside the World. Dissolve overlaps once
    # offline so translucent fills do not double-paint simplified neighbors.
    foreign = shapely.union_all(coarse).difference(world_mask)
    domestic = shapely.union_all(detailed)
    features = []
    for detail, geometry in [('world', domestic), ('context', foreign)]:
        for part in shapely.get_parts(geometry):
            if part.geom_type != 'Polygon' or part.is_empty:
                continue
            if not part.is_valid:
                raise ValueError('Vegetation simplification created invalid geometry')
            features.append({'type': 'Feature', 'properties': {'detail': detail}, 'geometry': mapping(part)})
    return {'type': 'FeatureCollection', 'processingRevision': 'world-footprint-vegetation-v1',
            'focusWorld': world_id, 'outsideToleranceDegrees': tolerance,
            'outsideMinimumAreaDegrees2': minimum_area, 'features': features}


def vegetation_footprint(mask):
    # Simplify before buffering; offsetting a million coastline vertices first
    # creates an enormous temporary graph for no visible benefit.
    protected = mask.simplify(.002, preserve_topology=True).buffer(.02).simplify(.005, preserve_topology=True)
    if not protected.covers(mask):
        raise ValueError('Simplified vegetation footprint lost part of the World')
    return protected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--focus', type=Path, required=True, help='Ownership GeoJSON or selected Tile View catalog')
    parser.add_argument('--world-id', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve() in (args.source.resolve(), args.focus.resolve()):
        raise ValueError('Display output must not overwrite source or ownership')
    source_bytes, focus_bytes = args.source.read_bytes(), args.focus.read_bytes()
    source = json.loads(gzip.decompress(source_bytes))
    focus = json.loads(focus_bytes)
    if focus.get('purpose') == 'display-only':
        raise ValueError('World footprint requires ownership geometry, not display LODs')
    mask = shapely.union_all([shape(f['geometry']) for f in focus['features']]) if 'features' in focus else shapely.union_all([
        box(*tile['bounds']) for tile in focus['tiles'] if tile['status'] == 'selected'])
    if not mask.is_valid:
        mask = shapely.make_valid(mask)
    # Do not import a detailed administrative coastline into a decorative
    # vegetation mask. A small outward collar retains every domestic point;
    # the simplified collar also keeps country-edge clipping inexpensive.
    mask = vegetation_footprint(mask)
    result = focus_vegetation(source, mask, args.world_id)
    result['detailMarginDegrees'] = .02
    output = gzip.compress(json.dumps(result, separators=(',', ':')).encode(), mtime=0)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(output)
    report = {'artifact': args.output.name, 'artifactSha256': hashlib.sha256(output).hexdigest(),
              'sourceSha256': hashlib.sha256(source_bytes).hexdigest(), 'focusInputSha256': hashlib.sha256(focus_bytes).hexdigest(),
              'bytes': len(output), 'originalVertices': int(sum(shapely.get_num_coordinates(shape(f['geometry'])) for f in source['features'])),
              'vertices': int(sum(shapely.get_num_coordinates(shape(f['geometry'])) for f in result['features'])),
              'features': len(result['features'])}
    args.output.with_suffix('.report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
