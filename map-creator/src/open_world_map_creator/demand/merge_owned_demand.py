"""Conserve the native and cross ledgers while merging their shared locations."""
import hashlib
from collections import defaultdict
from dataclasses import replace

import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree

from .building_sites import _local_metric_crs
from .road_support import write
from .voronoi_merge import VERSION, merge_cells


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
        merged = merge_cells(xy, mass, min_weight=minimum, min_spacing=spacing)
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
            state['merged'] = merge_cells(state['xy'], state['mass'], min_weight=minimum, min_spacing=spacing,
                                         initial_cells=state['merged']['cells'], force_indices=indices)
        after = sum(len(state['merged']['cells']) for state in states.values())
        if after >= before:
            raise AssertionError('Border spacing repair made no progress')
        border_rounds += 1
        progress(f'[voronoi] border/projection repair {border_rounds}: {before} -> {after}')

    mapping, representatives, reports, membership = {}, {}, {}, {}
    for owner, state in sorted(states.items()):
        displacement = np.zeros(len(state['points']))
        for cell in state['merged']['cells']:
            members = [state['points'][i]['id'] for i in cell['members']]
            point_id = f'owner-{owner}-voronoi-' + hashlib.sha256('\n'.join(members).encode()).hexdigest()[:20]
            anchor = state['points'][cell['anchor']]
            representatives[point_id] = Site(point_id,*anchor['location'],0,0,owner,owner)
            for member in members:
                mapping[member] = point_id
            displacement[cell['members']] = np.linalg.norm(state['xy'][cell['members']]-state['xy'][cell['anchor']],axis=1)
        weights = np.asarray([cell['mass'] for cell in state['merged']['cells']])
        reports[owner] = dict(inputPoints=len(state['points']), outputPoints=len(weights),
            maximumDisplacementM=float(displacement.max()),
            demandWeightedMeanDisplacementM=float(np.average(displacement,weights=state['mass'].sum(axis=1))),
            endpointMassMovedOver5Km=int(state['mass'][displacement>5000].sum()),
            totalsBefore=state['mass'].sum(axis=0).tolist(), totalsAfter=weights.sum(axis=0).tolist(),
            positiveWeightMedians=[float(np.median(column[column>0])) if np.any(column>0) else 0 for column in weights.T])
        membership[owner] = dict(oldPointIds=[p['id'] for p in state['points']],cells=state['merged']['cells'])

    result = {}
    for owner, payload in native.items():
        points = {}
        pops = []
        for original in payload['pops']:
            home, work = representatives[mapping[original['residenceId']]], representatives[mapping[original['jobId']]]
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
    cross_result = [replace(record,home=representatives[mapping[record.home.id]],work=representatives[mapping[record.work.id]]) for record in cross]
    if membership_path:
        write(membership_path,dict(version=VERSION,mapping=mapping,owners=membership))
    nearest = cKDTree(coordinates).query(coordinates,k=2)[0][:,1] if len(coordinates)>1 else np.array([])
    report = dict(version=VERSION,minimumPositiveDemand=minimum,minimumSpacingM=spacing,
        measuredMinimumSpacingM=float(nearest.min()) if len(nearest) else None,
        fields=['nativeResidents','nativeJobs','crossResidents','crossWorkers'],
        ownerPreserving=True,borderRepairRounds=border_rounds,
        inputPoints=sum(row['inputPoints'] for row in reports.values()),outputPoints=len(representatives),owners=reports)
    return result,cross_result,report
