"""Space shared sites, then merge each resident/worker endpoint independently."""
import hashlib
from collections import defaultdict
from dataclasses import replace

import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree

from .building_sites import _local_metric_crs
from .road_support import write
from .voronoi_merge import merge_cells

VERSION = 'voronoi-demand-independent-merge-v2'
FIELDS = ('nativeResidents', 'nativeJobs', 'crossResidents', 'crossWorkers')


def merge_owned_demand(native, cross, boundaries, *, minimum=50, spacing=275, progress=print, membership_path=None):
    from .package_japan import Site, road_estimate
    by_owner = {code:{} for code in boundaries}

    def add(code, site_id, location, column, amount):
        point = by_owner[code].setdefault(site_id, dict(id=site_id, location=list(location), mass=[0,0,0,0]))
        if point['location'] != list(location):
            raise ValueError(f'Conflicting native/cross geometry: {site_id}')
        point['mass'][column] += int(amount)

    for code, payload in native.items():
        for point in payload['points']:
            add(code, point['id'], point['location'], 0, point['residents'])
            add(code, point['id'], point['location'], 1, point['jobs'])
    for record in cross:
        add(record.home.owner_pref, record.home.id, [record.home.longitude,record.home.latitude], 2, record.mass)
        add(record.work.owner_pref, record.work.id, [record.work.longitude,record.work.latitude], 3, record.mass)
    states = {}
    for owner, points in sorted(by_owner.items()):
        if not points:
            continue
        ordered = [points[key] for key in sorted(points)]
        forward = Transformer.from_crs('EPSG:4326', _local_metric_crs(boundaries[owner]), always_xy=True)
        xy = np.asarray([forward.transform(*p['location']) for p in ordered])
        mass = np.asarray([p['mass'] for p in ordered], dtype=np.int64)
        # Establish common geometry using spacing alone. Applying a weight floor
        # here would let one sparse endpoint type drag every other type with it.
        merged = merge_cells(xy, mass, min_weight=1, min_spacing=spacing)
        states[owner] = dict(points=ordered, xy=xy, mass=mass, merged=merged)
        progress(f'[voronoi] owner {owner}: {len(points)} -> {len(merged["cells"])} sites')

    # Neighboring prefectures retain ownership. Repair a border conflict by
    # another same-owner Voronoi contraction, never by moving it across a border.
    # ECEF chord distance also catches projection-scale differences nationally.
    ecef = Transformer.from_crs('EPSG:4979', 'EPSG:4978', always_xy=True)
    border_rounds = 0
    while True:
        entries, coordinates = [], []
        for owner, state in sorted(states.items()):
            for i, cell in enumerate(state['merged']['cells']):
                entries.append((owner,i))
                coordinates.append(ecef.transform(*state['points'][cell['anchor']]['location'],0))
        if len(entries)<2:
            break
        tree = cKDTree(coordinates)
        pairs = tree.query_pairs(spacing, output_type='ndarray')
        if not len(pairs):
            break
        forced = defaultdict(set)
        for a,b in pairs:
            options = [entries[int(a)], entries[int(b)]]
            options = [(owner,index) for owner,index in options if len(states[owner]['merged']['cells'])>1]
            if not options:
                raise ValueError('Two singleton owners cannot satisfy minimum spacing without changing ownership')
            owner,index = min(options,key=lambda pair:(sum(states[pair[0]]['merged']['cells'][pair[1]]['mass']),pair))
            forced[owner].add(index)
        before = len(entries)
        for owner, indices in sorted(forced.items()):
            state = states[owner]
            state['merged'] = merge_cells(state['xy'], state['mass'], min_weight=1, min_spacing=spacing,
                                         initial_cells=state['merged']['cells'], force_indices=indices)
        after = sum(len(state['merged']['cells']) for state in states.values())
        if after >= before:
            raise AssertionError('Border spacing repair made no progress')
        border_rounds += 1
        progress(f'[voronoi] border/projection repair {border_rounds}: {before} -> {after}')

    mapping, representatives, reports, membership = {}, {}, {}, {}
    endpoint_mappings = {field:{} for field in FIELDS}
    for owner, state in sorted(states.items()):
        cells = state['merged']['cells']
        point_ids = []
        for cell in cells:
            members = [state['points'][i]['id'] for i in cell['members']]
            point_id = f'owner-{owner}-voronoi-' + hashlib.sha256('\n'.join(members).encode()).hexdigest()[:20]
            anchor = state['points'][cell['anchor']]
            representatives[point_id] = Site(point_id,*anchor['location'],0,0,owner,owner)
            point_ids.append(point_id)
            for member in members:
                mapping[member] = point_id
        owner_membership = dict(oldPointIds=[p['id'] for p in state['points']],cells=cells,
                                canonicalPointIds=point_ids,endpointCells={})
        membership[owner] = owner_membership
        displacement = np.zeros_like(state['mass'],dtype=float)
        totals_after, medians = [], []
        input_counts, output_counts, cross_outputs = {}, {}, set()
        # Each pass sees only sites with positive mass in that endpoint column.
        # Its retained anchors are a subset of the shared, already-spaced sites.
        # Tiny jobs can therefore move without moving valid resident endpoints.
        for column, field in enumerate(FIELDS):
            indices = [i for i,cell in enumerate(cells) if cell['mass'][column]>0]
            input_counts[field] = len(indices)
            if not indices:
                totals_after.append(0);medians.append(0);output_counts[field]=0
                owner_membership['endpointCells'][field] = dict(pointIds=[],cells=[])
                continue
            xy = np.asarray([state['xy'][cells[i]['anchor']] for i in indices])
            mass = np.asarray([[cells[i]['mass'][column]] for i in indices],dtype=np.int64)
            merged = merge_cells(xy,mass,min_weight=minimum,min_spacing=spacing)
            for cell in merged['cells']:
                base_anchor = indices[cell['anchor']]
                anchor = cells[base_anchor]['anchor']
                point_id = point_ids[base_anchor]
                if column>=2:cross_outputs.add(point_id)
                for member in cell['members']:
                    base = indices[member]
                    endpoint_mappings[field][point_ids[base]] = point_id
                    original = cells[base]['members']
                    displacement[original,column] = np.linalg.norm(state['xy'][original]-state['xy'][anchor],axis=1)
            weights = [cell['mass'][0] for cell in merged['cells']]
            totals_after.append(sum(weights));medians.append(float(np.median(weights)))
            output_counts[field] = len(weights)
            owner_membership['endpointCells'][field] = dict(pointIds=[point_ids[i] for i in indices],cells=merged['cells'])
        totals = state['mass'].sum(axis=0)
        if totals_after != totals.tolist():
            raise AssertionError('Independent endpoint merging changed demand totals')
        costs = (displacement*state['mass']).sum(axis=0)
        moved = (state['mass']*(displacement>5000)).sum(axis=0)
        native_sum, cross_sum = int(totals[:2].sum()), int(totals[2:].sum())
        reports[owner] = dict(inputPoints=len(state['points']),outputPoints=len(cells),
            maximumDisplacementM=float(displacement[state['mass']>0].max()),
            demandWeightedMeanDisplacementM=float(costs.sum()/totals.sum()),
            nativeWeightedMeanDisplacementM=float(costs[:2].sum()/native_sum) if native_sum else 0,
            crossWeightedMeanDisplacementM=float(costs[2:].sum()/cross_sum) if cross_sum else 0,
            endpointMassMovedOver5Km=int(moved.sum()),
            nativeEndpointMassMovedOver5Km=int(moved[:2].sum()),crossEndpointMassMovedOver5Km=int(moved[2:].sum()),
            crossViewInputPoints=sum(bool(sum(cell['mass'][2:])) for cell in cells),crossViewOutputPoints=len(cross_outputs),
            endpointInputPoints=input_counts,endpointOutputPoints=output_counts,
            totalsBefore=totals.tolist(),totalsAfter=totals_after,positiveWeightMedians=medians)
        progress(f'[voronoi] independent endpoints {owner}: {output_counts}')

    result = {}
    for owner, payload in native.items():
        points = {}
        pops = []
        for original in payload['pops']:
            home = representatives[endpoint_mappings['nativeResidents'][mapping[original['residenceId']]]]
            work = representatives[endpoint_mappings['nativeJobs'][mapping[original['jobId']]]]
            seconds, metres = road_estimate(home, work)
            pop = {k:v for k,v in original.items() if not k.startswith('driving')}
            pop.update(residenceId=home.id,jobId=work.id,drivingSeconds=seconds,drivingDistance=metres)
            pops.append(pop)
            for site,field in [(home,'residents'),(work,'jobs')]:
                point=points.setdefault(site.id,dict(id=site.id,location=[site.longitude,site.latitude],residents=0,jobs=0,popIds=[]))
                point[field]+=pop['size']
                if not point['popIds'] or point['popIds'][-1]!=pop['id']:
                    point['popIds'].append(pop['id'])
        result[owner]=dict(points=[points[key] for key in sorted(points)],pops=pops)
    cross_result = [replace(record,home=representatives[endpoint_mappings['crossResidents'][mapping[record.home.id]]],
                           work=representatives[endpoint_mappings['crossWorkers'][mapping[record.work.id]]]) for record in cross]
    used_by_owner = defaultdict(set)
    for owner,payload in result.items():
        used_by_owner[owner].update(point['id'] for point in payload['points'])
    for record in cross_result:
        used_by_owner[record.home.owner_pref].add(record.home.id)
        used_by_owner[record.work.owner_pref].add(record.work.id)
    for owner,ids in used_by_owner.items():
        reports[owner]['outputPoints'] = len(ids)
    coordinates = [ecef.transform(representatives[point_id].longitude,representatives[point_id].latitude,0)
                   for owner,ids in sorted(used_by_owner.items()) for point_id in sorted(ids)]
    if membership_path:
        write(membership_path,dict(version=VERSION,mapping=mapping,endpointMappings=endpoint_mappings,owners=membership))
    nearest = cKDTree(coordinates).query(coordinates,k=2)[0][:,1] if len(coordinates)>1 else np.array([])
    report = dict(version=VERSION,minimumPositiveDemand=minimum,minimumSpacingM=spacing,
        measuredMinimumSpacingM=float(nearest.min()) if len(nearest) else None,
        fields=['nativeResidents','nativeJobs','crossResidents','crossWorkers'],
        ownerPreserving=True,borderRepairRounds=border_rounds,ledgerMergePolicy='independent-residential-worker-endpoints-v2',
        inputPoints=sum(row['inputPoints'] for row in reports.values()),outputPoints=len(coordinates),owners=reports)
    return result,cross_result,report
