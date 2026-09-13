"""Road-frontage allocation validated by the Saitama demand experiment."""
from __future__ import annotations
import hashlib
import math
from collections import defaultdict
import numpy as np
import shapely
from scipy.spatial import cKDTree

VERSION = 'road-frontage-allocation-v1'
ROAD_WEIGHTS = {
    'residential': (1.0, .8), 'living_street': (1.0, .65),
    'unclassified': (.8, .8), 'tertiary': (.8, 1.0),
    'secondary': (.65, 1.1), 'primary': (.5, 1.1), 'service': (.5, .8),
}

def random_unit(key):
    return int.from_bytes(hashlib.blake2b(str(key).encode(), digest_size=8).digest(), 'big') / 2**64

def road_weights(tags):
    if tags.get('highway') not in ROAD_WEIGHTS:
        return None
    if any(tags.get(k, 'no') not in ('no', '0', '') for k in ('bridge', 'tunnel')):
        return None
    if tags.get('service') in ('parking_aisle', 'emergency_access') or tags.get('access') == 'no':
        return None
    result = ROAD_WEIGHTS[tags['highway']]
    return tuple(v * .4 for v in result) if tags.get('service') == 'driveway' else result

def allocate_integer(weights, total):
    values = np.asarray(weights, dtype=float)
    if total < 0 or not len(values) or np.any(values < 0) or not np.isfinite(values).all() or values.sum() <= 0:
        raise ValueError('Positive, finite allocation support required')
    exact = values / values.sum() * int(total)
    counts = np.floor(exact).astype(np.int64)
    remaining = int(total) - int(counts.sum())
    order = np.lexsort((np.arange(len(values)), -(exact - counts)))
    counts[order[:remaining]] += 1
    assert int(counts.sum()) == total
    return counts

def select_sites(samples, source_xy, source_mass):
    """Hash-ordered variable-radius Poisson thinning, independent of mesh centres."""
    xy = np.asarray([s['xy'] for s in samples])
    tree = cKDTree(source_xy)
    distances, indices = tree.query(xy)
    density = np.asarray(source_mass)[indices]
    radii = np.clip(215 * (np.maximum(density, 8) / 100)**-.22, 115, 300)
    eligible = np.flatnonzero(distances <= 800)
    grid = defaultdict(list)
    selected = []
    for i in sorted(eligible, key=lambda i: random_unit(samples[i]['id'])):
        x, y = xy[i]
        gx, gy = math.floor(x / 300), math.floor(y / 300)
        neighbors = [j for dx in (-1, 0, 1) for dy in (-1, 0, 1) for j in grid.get((gx+dx, gy+dy), ())]
        if any(np.linalg.norm(xy[i]-xy[j]) < max(radii[i], radii[j]) for j in neighbors):
            continue
        selected.append(i)
        grid[gx, gy].append(i)
    if not selected:
        raise ValueError('No road-supported sites')
    return [dict(samples[i], radius=float(radii[i]), anchor='road-frontage') for i in selected]

def assign_cells(sites, samples, cells, field, forward, boundary, excluded, *, maximum_assignment_m=5000):
    """Integrate sampled road length in each true mesh footprint, conserving every cell."""
    from shapely.geometry import Point, box
    from shapely.ops import transform
    site_xy = np.asarray([s['xy'] for s in sites])
    site_tree = cKDTree(site_xy)
    sample_xy = np.asarray([s['xy'] for s in samples])
    sample_tree = cKDTree(sample_xy)
    sample_owner = site_tree.query(sample_xy)[1]
    totals = np.zeros(len(sites), dtype=np.int64)
    report = dict(inputMass=0, assignedMass=0, splitCells=0, positiveCells=0,
                  nearestSupportFallbackCells=0, landFallbackCells=0,
                  maximumCellToSiteM=0., fallbackLocations=[])
    contribution_rows = []
    scale = 1 if field == 'commuters' else 2
    weight_index = 0 if field == 'commuters' else 1
    for cell in cells:
        mass = int(cell[field])
        if mass <= 0:
            continue
        lon, lat = cell['longitude'], cell['latitude']
        half_lon, half_lat = .003125*scale/2, (1/480)*scale/2
        footprint = transform(forward.transform, box(lon-half_lon, lat-half_lat, lon+half_lon, lat+half_lat))
        # Prepared containment is much cheaper than intersecting a whole
        # prefecture for every inland mesh. Only edge/water meshes need clipping.
        if not boundary.covers(footprint):
            footprint = footprint.intersection(boundary)
        cx, cy = forward.transform(lon, lat)
        support = defaultdict(float)
        for i in sample_tree.query_ball_point([cx, cy], 450*scale):
            if footprint.covers(Point(sample_xy[i])):
                amount = samples[i]['length'] * samples[i]['weights'][weight_index]
                if amount > 0:
                    support[int(sample_owner[i])] += amount
        fallback = None
        if not support:
            distances, indices = site_tree.query([cx, cy], k=min(4, len(sites)), distance_upper_bound=650)
            for distance, i in zip(np.atleast_1d(distances), np.atleast_1d(indices)):
                if np.isfinite(distance):
                    support[int(i)] += 1 / max(50., distance)**2
            if support:
                report['nearestSupportFallbackCells'] += 1
                fallback = 'nearby-road-support'
        if not support:
            # Explicitly labelled uncertainty: bounded land within the source footprint,
            # never a census-centre dot or a multi-kilometre jump to a mapped building.
            usable = footprint.difference(excluded)
            if usable.is_empty:
                # Coastal evidence can land in filled administrative water.
                # Keep the existing bounded source-to-land allowance, recording
                # uncertainty instead of silently returning a census centre.
                from shapely.ops import nearest_points
                land = boundary.difference(excluded)
                if land.is_empty:
                    raise ValueError(f'No physical placement support for {cell["id"]}')
                nearest = nearest_points(Point(cx,cy),land)[1]
                if nearest.distance(Point(cx,cy)) > maximum_assignment_m-50:
                    raise ValueError(f'No bounded physical placement support for {cell["id"]}')
                usable = land.intersection(nearest.buffer(50))
            x0,y0,x1,y1 = usable.bounds
            point = None
            for attempt in range(300):
                point = Point(x0+(x1-x0)*random_unit(f'{cell["id"]}/x/{attempt}'),
                              y0+(y1-y0)*random_unit(f'{cell["id"]}/y/{attempt}'))
                if usable.covers(point):
                    break
            else:
                point = usable.representative_point()
            i = len(sites)
            sites.append(dict(id=f'land-{cell["id"]}',xy=[point.x,point.y],anchor='uncertain-land',radius=0))
            totals = np.append(totals, 0)
            support[i] = 1.
            report['landFallbackCells'] += 1
            fallback = 'uncertain-land'
        indices = sorted(support)
        counts = allocate_integer([support[i] for i in indices], mass)
        if any(math.dist([cx,cy],sites[i]['xy']) > maximum_assignment_m for i,n in zip(indices,counts) if n):
            raise ValueError(f'Source placement exceeds {maximum_assignment_m} m: {cell["id"]}')
        totals[indices] += counts
        report['positiveCells'] += 1
        report['splitCells'] += int(np.count_nonzero(counts) > 1)
        report['inputMass'] += mass
        report['assignedMass'] += int(counts.sum())
        report['maximumCellToSiteM'] = max(report['maximumCellToSiteM'],
            max(math.dist([cx,cy],sites[i]['xy']) for i,n in zip(indices,counts) if n))
        if fallback:
            report['fallbackLocations'].append(dict(id=cell['id'],location=[lon,lat],mass=mass,kind=fallback))
        contribution_rows.append((cell['id'], mass, [(i,int(n)) for i,n in zip(indices,counts) if n]))
    assert int(totals.sum()) == report['inputMass']
    return totals, report, contribution_rows

def refine_buildings(sites, building_xy, boundary, excluded, maximum=30):
    """Coordinates only; coverage never changes point counts or allocated demand."""
    if not len(building_xy):
        return 0
    tree = cKDTree(building_xy)
    distance, index = tree.query(np.asarray([s['xy'] for s in sites]))
    count = 0
    for s,d,i in zip(sites,distance,index):
        point = shapely.Point(building_xy[i])
        if d <= maximum and boundary.covers(point) and not excluded.covers(point):
            s['roadXY'] = list(s['xy'])
            s['xy'] = list(building_xy[i])
            s['anchor'] = 'nearby-building'
            count += 1
    return count
