"""Place every owner's source marginals on one shared road-frontage support."""
import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely.geometry import Point, LineString
from shapely.ops import transform

from .building_sites import _local_metric_crs, read_building_centers
from .frontage_allocation import random_unit, select_sites, assign_cells, refine_buildings
from .road_support import digest, read, write

VERSION = 'boundary-road-frontage-sites-v1'


def samples_from_roads(data, forward, boundary, excluded, source_xy):
    land_geoms = [transform(forward.transform, shapely.from_geojson(g)) for _, g in data['landuse']]
    land_kinds = [kind for kind, _ in data['landuse']]
    land_tree = shapely.STRtree(land_geoms)
    source_tree = cKDTree(source_xy)
    samples, rejected = [], Counter()
    for road in data['roads']:
        line = transform(forward.transform, LineString(road['coordinates']))
        length = line.length
        if length < 5:
            continue
        count = max(1, math.ceil(length / 55))
        for j in range(count):
            key = f'{road["id"]}/{j}'
            at = (j + .12 + .76 * random_unit(key + '/at')) / count * length
            p = line.interpolate(at)
            if source_tree.query([p.x, p.y])[0] > 800:
                continue
            a, b = line.interpolate(max(0, at - 2)), line.interpolate(min(length, at + 2))
            dx, dy = b.x - a.x, b.y - a.y
            norm = math.hypot(dx, dy)
            if norm == 0:
                continue
            offset = (9 + 19 * random_unit(key + '/offset')) * (1 if random_unit(key + '/side') > .5 else -1)
            q = Point(p.x - dy / norm * offset, p.y + dx / norm * offset)
            if not boundary.covers(q) or excluded.covers(q):
                q = Point(p.x + dy / norm * offset, p.y - dx / norm * offset)
            if not boundary.covers(q) or excluded.covers(q):
                rejected['off-land-offset'] += 1
                continue
            weights = list(road['weights'])
            kinds = {land_kinds[int(i)] for i in land_tree.query(q, predicate='within')}
            if 'residential' in kinds:
                weights[0] *= 1.3
            if kinds & {'commercial', 'retail', 'industrial'}:
                weights[0] *= .35
                weights[1] *= 1.4
            if kinds & {'forest', 'farmland', 'meadow'}:
                weights[0] *= .3
                weights[1] *= .3
            samples.append(dict(id=key, xy=[q.x, q.y], length=length/count,
                                weights=weights, highway=road['highway']))
    return samples, dict(rejected)


def placement_cache_pin(owner, source_groups, boundary, building_path, road_support, policy,
                        *, physical_land=None, supplemental_buildings=()):
    """Explicit input identity, also used when auditing equivalent cache migrations."""
    pin = dict(version=VERSION, policy=policy, sourceGroups=source_groups,
               boundary=hashlib.sha256(shapely.to_wkb(boundary)).hexdigest(),
               buildings=digest(building_path), roads=road_support.owner_pin(owner),
               supplements=supplemental_buildings,
               code={p.name:digest(p) for p in (Path(__file__), Path(__file__).with_name('frontage_allocation.py'))})
    # The mask identity is attached by the compiler; do not rehash its 258 MB
    # geometry once for every prefecture.
    pin['physicalLand'] = getattr(physical_land, 'source_sha256', None)
    return pin


def build_owner_frontage(owner, source_groups, boundary, building_path, road_support, policy,
                         *, physical_land=None, supplemental_buildings=(), cache_root=None, progress=print):
    pin = placement_cache_pin(owner, source_groups, boundary, building_path, road_support, policy,
                              physical_land=physical_land, supplemental_buildings=supplemental_buildings)
    key = hashlib.sha256(json.dumps(pin, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    target = Path(cache_root) / f'owner-{owner}.json.gz' if cache_root else None
    if target and target.exists():
        previous = read(target)
        if previous.get('key') == key:
            progress(f'[road-sites] reused owner {owner}')
            return previous['bySource'], previous['report']
    forward = Transformer.from_crs('EPSG:4326', _local_metric_crs(boundary), always_xy=True)
    inverse = Transformer.from_crs(forward.target_crs, 'EPSG:4326', always_xy=True)
    land = boundary
    if physical_land is not None:
        parts = [shapely.make_valid(shapely.clip_by_rect(physical_land.parts[int(i)], *boundary.bounds))
                 for i in physical_land.tree.query(boundary)]
        land = boundary.intersection(shapely.union_all(parts))
    metric_land = transform(forward.transform, land)
    data = road_support.owner_data(owner, boundary)
    geographic_clip = shapely.box(*boundary.bounds).buffer(.01)
    for field in ('masks', 'landuse'):
        values = []
        for row in data[field]:
            kind, geometry = row if field == 'landuse' else (None, row)
            clipped = shapely.from_geojson(geometry).intersection(geographic_clip)
            values.append((kind, shapely.to_geojson(clipped)) if kind else shapely.to_geojson(clipped))
        data[field] = values
    excluded = shapely.union_all([transform(forward.transform, shapely.from_geojson(g)) for g in data['masks']])
    shapely.prepare(metric_land)
    shapely.prepare(excluded)
    cells = {'home': [], 'jobs': []}
    for source, kinds in sorted(source_groups.items()):
        for kind, field in [('home', 'commuters'), ('jobs', 'jobs')]:
            for i, cell in enumerate(kinds[kind]):
                cells[kind].append(dict(id=f'{source}/{kind}/{i}', source=source,
                    longitude=cell.get('sourceLongitude', cell['longitude']),
                    latitude=cell.get('sourceLatitude', cell['latitude']), **{field:int(cell[field])}))
    all_cells = cells['home'] + cells['jobs']
    source_xy = np.asarray([forward.transform(c['longitude'], c['latitude']) for c in all_cells])
    density = [c.get('commuters', c.get('jobs', 0)/4) for c in all_cells]
    samples, rejected = samples_from_roads(data, forward, metric_land, excluded, source_xy)
    progress(f'[road-sites] owner {owner}: {len(samples)} frontage samples')
    if samples:
        sites = select_sites(samples, source_xy, density)
    else:
        # An entirely roadless owner still needs bounded physical-land support.
        # A temporary valid seed is used only for tree construction; allocation
        # below ignores it unless a source is within the ordinary 650 m radius.
        usable = metric_land.difference(excluded)
        if usable.is_empty:
            raise ValueError(f'Owner {owner} has no physical placement support')
        point = usable.representative_point()
        sites = [dict(id=f'owner-{owner}-roadless', xy=[point.x,point.y], anchor='uncertain-land')]
        samples = [dict(id='roadless-tree-seed', xy=[point.x,point.y], length=0, weights=[0,0])]
    contributions, allocation = {}, {}
    for kind, field in [('home', 'commuters'), ('jobs', 'jobs')]:
        _, allocation[kind], contributions[kind] = assign_cells(sites, samples, cells[kind], field, forward,
            metric_land, excluded, maximum_assignment_m=float(policy.get('maximumCellToSiteDistanceM', 5000)))
    buildings = read_building_centers(building_path, list(boundary.bounds), forward)
    building_xy = np.column_stack([buildings['x'], buildings['y']])
    if supplemental_buildings:
        building_xy = np.concatenate([building_xy, np.asarray([forward.transform(*row['location']) for row in supplemental_buildings])])
    refined = refine_buildings(sites, building_xy, metric_land, excluded,
                               maximum=float(policy.get('maximumBuildingRefinementM', 30)))
    by_source = defaultdict(list)
    weights = defaultdict(lambda: np.zeros((len(sites),2), dtype=np.int64))
    for column, kind in enumerate(('home','jobs')):
        for cell, (_, amount, splits) in zip(cells[kind], contributions[kind], strict=True):
            if amount != sum(n for _,n in splits):
                raise AssertionError('Source mesh mass changed')
            for index, count in splits:
                weights[cell['source']][index,column] += count
    coordinates = []
    for site in sites:
        original = list(inverse.transform(*site['xy']))
        rounded = [round(value,7) for value in original]
        # Match the existing routing cache's e7 precision where serialization
        # remains on land. Retain full precision for rare shoreline anchors.
        valid = land.covers(Point(rounded)) and not excluded.covers(Point(forward.transform(*rounded)))
        coordinates.append(rounded if valid else original)
    for source, mass in sorted(weights.items()):
        for i in np.flatnonzero(mass.sum(axis=1)):
            x,y = coordinates[i]
            if not land.covers(Point(x,y)) or excluded.covers(Point(sites[i]['xy'])):
                raise ValueError(f'Final road/building anchor escaped physical land: owner={owner}')
            by_source[source].append(dict(id=f'owner-{owner}-frontage-{i}', longitude=x, latitude=y,
                home_weight=int(mass[i,0]), job_weight=int(mass[i,1]), source_pref=source,
                owner_pref=owner, force_cross=False))
    report = dict(version=VERSION, roadSamples=len(samples), initialSites=len(sites),
        nearbyBuildingRefinements=refined, supplementalBuildingCount=len(supplemental_buildings),
        home=allocation['home'], jobs=allocation['jobs'], sourcePrefectures=sorted(source_groups),
        inputHomeMass=sum(c['commuters'] for c in cells['home']), inputJobMass=sum(c['jobs'] for c in cells['jobs']),
        rejectedSamples=rejected, unanchoredSiteCount=0,
        uncertainLandSites=sum(s['anchor']=='uncertain-land' for s in sites), everySourceMeshConserved=True,
        physicalLandSha256=pin['physicalLand'], inputFingerprint=key)
    if target:
        write(target, dict(key=key, bySource=by_source, report=report, contributions=contributions))
    return dict(by_source), report
