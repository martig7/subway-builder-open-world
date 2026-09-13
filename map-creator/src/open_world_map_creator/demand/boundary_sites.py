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

VERSION = 'boundary-first-building-sites-v2-land-inputs'


def compile_boundary_sites(boundaries, sources, building_paths, policy, progress=print, *, supplemental_buildings=None, physical_land=None, road_support=None, placement_cache=None, placement_workers=1):
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
                grouped[owner][source_pref][kind].append({**cell, 'sourceLongitude':cell['longitude'],
                    'sourceLatitude':cell['latitude'], 'longitude': x, 'latitude': y})
        progress(f'[boundary-sites] assigned source {source_pref}')

    by_source = {source: [] for source in sources}
    if policy.get('sitePlacement') == 'road-frontage-v1' and placement_workers > 1:
        from concurrent.futures import ProcessPoolExecutor, as_completed
        from .frontage_worker import initialize, build
        if road_support is None:
            raise ValueError('Road-frontage placement requires cached OSM support')
        if physical_land is not None and not getattr(physical_land, 'source_path', None):
            raise ValueError('Parallel placement requires a readable physical-land source')
        arguments = [(owner, dict(groups), boundaries[owner], building_paths[owner], policy,
            (supplemental_buildings or {}).get(owner, []), placement_cache) for owner,groups in sorted(grouped.items())]
        with ProcessPoolExecutor(max_workers=placement_workers, initializer=initialize, initargs=(
                road_support.config, road_support.osm_root, road_support.root, road_support.pins,
                getattr(physical_land,'source_path',None), getattr(physical_land,'source_sha256',None))) as pool:
            futures = [pool.submit(build, argument) for argument in arguments]
            for future in as_completed(futures):
                owner,(owner_rows,owner_report) = future.result()
                for source,rows in owner_rows.items():
                    by_source[source].extend(rows)
                report['owners'][owner] = owner_report
                progress(f'[road-sites] completed owner {owner}: {owner_report["initialSites"]} sites')
        for sites in by_source.values():
            sites.sort(key=lambda site:(site['owner_pref'],site['id']))
        return by_source, report
    for owner, source_groups in sorted(grouped.items()):
        if policy.get('sitePlacement') == 'road-frontage-v1':
            if road_support is None:
                raise ValueError('Road-frontage placement requires cached OSM support')
            from .frontage_sites import build_owner_frontage
            owner_rows, owner_report = build_owner_frontage(owner, source_groups, boundaries[owner],
                building_paths[owner], road_support, policy, physical_land=physical_land,
                supplemental_buildings=(supplemental_buildings or {}).get(owner, []),
                cache_root=placement_cache, progress=progress)
            for source, rows in owner_rows.items():
                by_source[source].extend(rows)
            report['owners'][owner] = owner_report
            progress(f'[road-sites] completed owner {owner}: {owner_report["initialSites"]} sites')
            continue
        progress(f'[boundary-sites] building owner {owner}')
        homes = [cell for group in source_groups.values() for cell in group['home']]
        jobs = [cell for group in source_groups.values() for cell in group['jobs']]
        boundary = boundaries[owner]
        sites, owner_report = build_tile_sites(
            f'owner-{owner}', homes, jobs, building_paths[owner], list(boundary.bounds), boundary,
            radius_m=float(policy.get('pointMergeDistanceM', 350)),
            source_radius_m=float(policy.get('buildingSourceRadiusM', 750)),
            candidate_grid_m=float(policy.get('candidateGridM', 100)),
            supplemental_buildings=(supplemental_buildings or {}).get(owner, []),
            physical_land=physical_land,
            maximum_assignment_m=maximum_assignment,
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
