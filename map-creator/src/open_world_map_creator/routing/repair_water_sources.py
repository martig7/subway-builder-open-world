"""Repair known OSM area-assembly failures from original way-node geometry."""
import argparse
import hashlib
import json
from pathlib import Path

import shapely
from shapely.geometry import LineString, shape, mapping


def polygonize_ways(coordinates):
    lines = [LineString(points) for points in coordinates if len(points) >= 2]
    return shapely.union_all(shapely.get_parts(shapely.polygonize(
        shapely.get_parts(shapely.union_all(lines)))))


def repair(pbf, land_path, output, definitions):
    import osmium
    report = json.loads(land_path.with_suffix('.report.json').read_text(encoding='utf-8'))
    with pbf.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != report['sha256']['pbf']:
            raise ValueError('OSM repair source does not match the mask PBF fingerprint')
    requested_ids = {definition['areaId'] for definition in definitions}
    if not requested_ids <= set(report['unusableAreaIds']):
        raise ValueError('Repair definitions must match unresolved areas in this mask')
    wanted = {int(way) for definition in definitions for role in ('outer', 'inner')
              for way in definition[role]}
    coordinates = {}

    class Ways(osmium.SimpleHandler):
        def way(self, way):
            if way.id in wanted:
                coordinates[way.id] = [(n.location.lon, n.location.lat) for n in way.nodes]
                print(f"[water-repair] captured source way {way.id}", flush=True)

    Ways().apply_file(str(pbf), locations=True, idx="sparse_mem_array")
    if set(coordinates) != wanted:
        raise ValueError(f"Missing source ways: {wanted - set(coordinates)}")
    repairs = []
    for definition in definitions:
        outer = polygonize_ways([coordinates[i] for i in definition['outer']])
        inner = polygonize_ways([coordinates[i] for i in definition['inner']])
        water = shapely.make_valid(outer.difference(inner))
        if water.is_empty or water.area <= 0:
            raise ValueError(f"Cannot reconstruct water area {definition['areaId']}")
        repairs.append(water)
    data = json.loads(land_path.read_text(encoding='utf-8'))
    geometries = [shape(f['geometry']) for f in data['features']]
    tree = shapely.STRtree(geometries)
    touched = set()
    for water in repairs:
        for index in tree.query(water, predicate='intersects'):
            geometries[index] = shapely.make_valid(geometries[index].difference(water))
            touched.add(int(index))
    features = []
    for index, (feature, geometry) in enumerate(zip(data['features'], geometries, strict=True)):
        if index not in touched:
            features.append(feature)
        else:
            features.extend({'type': 'Feature', 'properties': {'landPart': index}, 'geometry': mapping(part)}
                            for part in shapely.get_parts(geometry) if part.geom_type == 'Polygon' and not part.is_empty)
    data['features'] = features
    output.write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
    repaired_ids = {d['areaId'] for d in definitions}
    report['unusableAreaIds'] = [i for i in report['unusableAreaIds'] if i not in repaired_ids]
    report['sourceWayRepairs'] = definitions
    report['patchedLandParts'] = len(touched)
    report['polygons'] = len(features)
    report['vertices'] = sum(int(shapely.get_num_coordinates(shape(f['geometry']))) for f in features)
    report['previousOutputSha256'] = report['sha256']['output']
    with output.open('rb') as stream:
        report['sha256']['output'] = hashlib.file_digest(stream, 'sha256').hexdigest()
    output.with_suffix('.report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'status': 'complete', 'patchedLandParts': len(touched),
                      'remainingUnusable': report['unusableAreaIds']}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pbf', type=Path, required=True)
    parser.add_argument('--land', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--definitions', type=Path, required=True)
    args = parser.parse_args()
    if args.land.resolve() == args.output.resolve():
        raise ValueError('Preserve the source mask; write a separate repaired mask')
    repair(args.pbf, args.land, args.output, json.loads(args.definitions.read_text(encoding='utf-8')))
