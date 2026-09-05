"""Resolve ownership before building placement, independently of evidence labels.

Source prefectures remain statistical OD provenance. They never select a building
index or create a second, census-centred placement path. Every final owner uses
one shared building clustering pass for all evidence assigned to its polygon.
"""
from collections import defaultdict

import shapely
from pyproj import Transformer
from shapely.geometry import Point

from .building_sites import build_tile_sites, assign_source_weights, _local_metric_crs
from .estat_japan_prefecture import BoundaryOwnershipIndex, relocate_into_boundary, resolve_cell_ownership

VERSION = 'boundary-first-building-sites-v1'


def compile_boundary_sites(boundaries, sources, building_paths, policy, progress=print):
    index = BoundaryOwnershipIndex(boundaries, boundaries)
    maximum_coastal = float(policy.get('maximumBoundarySnapDistanceM', 750))
    maximum_assignment = float(policy.get('maximumCellToSiteDistanceM', 5000))
    if maximum_coastal <= 0 or maximum_assignment <= 0:
        raise ValueError('Placement distance limits must be positive')
    for boundary in boundaries.values():
        if not boundary.is_valid or boundary.is_empty:
            raise ValueError('Ownership polygons must be nonempty and valid')
        shapely.prepare(boundary)
    grouped = defaultdict(lambda: defaultdict(lambda: {'home': [], 'jobs': []}))
    report = {'version': VERSION, 'coastalAdjustedCellCount': 0, 'ownerChangedCellCount': 0,
              'maximumBoundarySnapDistanceM': 0, 'unanchoredSiteCount': 0, 'owners': {}}
    for source_pref, kinds in sorted(sources.items()):
        for kind, field in [('home', 'commuters'), ('jobs', 'jobs')]:
            for cell in kinds.get(kind, []):
                if int(cell[field]) <= 0:
                    continue
                x, y = float(cell['longitude']), float(cell['latitude'])
                point = Point(x, y)
                resolved = resolve_cell_ownership(x, y, 1 if kind == 'home' else 2, index)
                owner = resolved[0] if resolved else index.all_codes[int(index.all_tree.nearest(point))]
                if not boundaries[owner].covers(point):
                    x, y, _, distance = relocate_into_boundary(x, y, owner, index)
                    if distance > maximum_coastal:
                        raise ValueError(f'Evidence outside permitted ownership snap: source={source_pref} '
                                         f'owner={owner} location={point.x},{point.y} distance={distance:.1f}m')
                    report['coastalAdjustedCellCount'] += 1
                    report['maximumBoundarySnapDistanceM'] = max(report['maximumBoundarySnapDistanceM'], distance)
                report['ownerChangedCellCount'] += int(owner != source_pref)
                grouped[owner][source_pref][kind].append({**cell, 'longitude': x, 'latitude': y})
        progress(f'[boundary-sites] assigned source {source_pref}')

    by_source = {source: [] for source in sources}
    for owner, source_groups in sorted(grouped.items()):
        progress(f'[boundary-sites] building owner {owner}')
        homes = [cell for group in source_groups.values() for cell in group['home']]
        jobs = [cell for group in source_groups.values() for cell in group['jobs']]
        boundary = boundaries[owner]
        sites, owner_report = build_tile_sites(
            f'owner-{owner}', homes, jobs, building_paths[owner], list(boundary.bounds), boundary,
            radius_m=float(policy.get('pointMergeDistanceM', 350)),
            source_radius_m=float(policy.get('buildingSourceRadiusM', 750)),
            candidate_grid_m=float(policy.get('candidateGridM', 100)),
        )
        if not sites:
            raise ValueError(f'Owner {owner} has demand but no eligible building sites')
        forward = Transformer.from_crs('EPSG:4326', _local_metric_crs(boundary), always_xy=True)
        positioned = []
        for site in sites:
            x, y = forward.transform(*site['location'])
            positioned.append({**site, 'x': x, 'y': y})
        for source, group in sorted(source_groups.items()):
            home_weights, home_distance = assign_source_weights(positioned, group['home'], 'commuters', forward)
            job_weights, job_distance = assign_source_weights(positioned, group['jobs'], 'jobs', forward)
            if max(home_distance, job_distance) > maximum_assignment:
                raise ValueError(f'Owner {owner} has source {source} beyond the building placement limit; '
                                 f'maximum={max(home_distance, job_distance):.1f}m')
            for site, home, work in zip(sites, home_weights, job_weights, strict=True):
                if not home and not work:
                    continue
                x, y = site['location']
                if not boundary.covers(Point(x, y)):
                    raise ValueError(f'Final building anchor escaped owner {owner}: {site["id"]}')
                by_source[source].append({'id': site['id'], 'longitude': x, 'latitude': y,
                    'home_weight': home, 'job_weight': work, 'source_pref': source,
                    'owner_pref': owner, 'force_cross': False})
            for kind, field, weights in [('home', 'commuters', home_weights), ('jobs', 'jobs', job_weights)]:
                if sum(weights) != sum(int(cell[field]) for cell in group[kind]):
                    raise AssertionError(f'Placement lost {source}/{owner}/{kind} mass')
        report['owners'][owner] = {**owner_report, 'sourcePrefectures': sorted(source_groups)}
        progress(f'[boundary-sites] completed owner {owner}: {len(sites)} shared building sites')
    for sites in by_source.values():
        sites.sort(key=lambda site: (site['owner_pref'], site['id']))
    return by_source, report
