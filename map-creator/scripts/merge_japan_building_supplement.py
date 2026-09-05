"""Import attributed building footprints into Japan's shared placement inputs.

This never substitutes mesh centres or invented points for missing buildings.
Anchors must lie within a supplied footprint, physical land and its named owner.
"""
import argparse
import hashlib
import json
from pathlib import Path

import shapely
from shapely.geometry import Point, shape
from open_world_map_creator.demand.physical_land import PhysicalLandIndex
from open_world_map_creator.geography import SOURCE_ROOT, ownership_boundary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--world-root', type=Path, default=Path('worlds/japan'))
    args = parser.parse_args()
    world = args.world_root
    definition = json.loads((world/'demand.json').read_text(encoding='utf-8'))
    spec = definition['physicalLandMask']
    land_path = (SOURCE_ROOT/spec['source']).resolve()
    if SOURCE_ROOT.resolve() not in land_path.parents or hashlib.sha256(land_path.read_bytes()).hexdigest() != spec['sha256']:
        raise ValueError('Physical-land path/hash mismatch')
    print('Loading pinned physical land',flush=True)
    land = PhysicalLandIndex.read(land_path)
    boundaries = {f['properties']['pref_code']:shape(f['geometry']) for f in
                  json.loads(ownership_boundary(world).read_text(encoding='utf-8'))['features']}
    for boundary in boundaries.values(): shapely.prepare(boundary)
    source = json.loads(args.source.read_text(encoding='utf-8'))
    if not source.get('attribution') or not source.get('source'):
        raise ValueError('Footprint source and attribution are required')
    target = (world/definition['supplementalBuildingAnchors']).resolve()
    if world.resolve() not in target.parents: raise ValueError('Supplement escapes World')
    anchors = json.loads(target.read_text(encoding='utf-8'))
    footprint_path = target.with_name('supplemental-building-footprints.geojson')
    footprints = json.loads(footprint_path.read_text(encoding='utf-8'))
    seen = {tuple(r['location']) for rows in anchors['byOwner'].values() for r in rows}
    added = {}; rejected = 0
    for i,feature in enumerate(source['features']):
        properties = feature['properties']; owner = properties['prefCode']
        geometry = shape(feature['geometry'])
        if owner not in boundaries or geometry.geom_type not in ('Polygon','MultiPolygon') or not geometry.is_valid:
            rejected += 1; continue
        point = geometry.centroid
        if not geometry.covers(point): point = geometry.representative_point()
        if not boundaries[owner].covers(point) or not land.covers([point.coords[0]])[0]:
            owned = geometry.intersection(boundaries[owner])
            if owned.is_empty: rejected += 1; continue
            pieces = [owned.intersection(land.parts[int(j)]) for j in land.tree.query(owned)]
            eligible = shapely.union_all(pieces)
            if eligible.is_empty or eligible.area <= 0: rejected += 1; continue
            point = eligible.representative_point()
        location = [round(point.x,7),round(point.y,7)]
        if not geometry.covers(Point(*location)) or not boundaries[owner].covers(Point(*location)) or not land.covers([location])[0]:
            rejected += 1; continue
        if tuple(location) in seen: continue
        seen.add(tuple(location))
        identity = 'gsi-building-'+hashlib.sha256(json.dumps(location).encode()).hexdigest()[:20]
        anchors['byOwner'].setdefault(owner,[]).append({'id':identity,'location':location,
            'sourceTile':properties['tile'],'sourceId':properties.get('sourceId')})
        footprints['features'].append(feature)
        added[owner] = added.get(owner,0)+1
        if i % 500 == 0: print(f'Processed {i}/{len(source["features"])} footprints',flush=True)
    for rows in anchors['byOwner'].values(): rows.sort(key=lambda row:row['id'])
    anchors.setdefault('imports',[]).append({'sha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),
        'source':source['source'],'attribution':source['attribution'],'tiles':source.get('tiles',[]),
        'addedByOwner':added,'rejectedFootprints':rejected})
    footprints['attribution'] = anchors['attribution']
    for path,value in [(target,anchors),(footprint_path,footprints)]:
        path.write_text(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n',encoding='utf-8')
    print(json.dumps({'added':added,'rejected':rejected}),flush=True)


if __name__ == '__main__': main()
