"""Merge neighboring Voronoi cells after native scaling and final anchor placement.

Each round contracts disjoint pairs of neighboring cells, then recomputes the
Voronoi diagram at the retained anchors. This avoids collapsing whole connected
street chains. Representatives are existing valid sites nearest the combined
mass centroid; no new location can fall in water or outside the prefecture.
"""
import numpy as np
from scipy.spatial import Voronoi, cKDTree

VERSION='voronoi-demand-merge-v1'


def neighbors(xy):
    if len(xy)<2:return []
    unique,first,inverse=np.unique(xy,axis=0,return_index=True,return_inverse=True)
    edges={(min(int(first[u]),i),max(int(first[u]),i)) for i,u in enumerate(inverse) if first[u]!=i}
    centered=unique-unique.mean(axis=0)
    if len(unique)>1:
        if len(unique)==2 or np.linalg.matrix_rank(centered,tol=1e-8)<2:
            axis=int(np.argmax(np.ptp(unique,axis=0)))
            order=np.argsort(unique[:,axis],kind='stable')
            pairs=zip(order[:-1],order[1:])
        else:
            pairs=Voronoi(unique).ridge_points
        for a,b in pairs:
            x,y=int(first[a]),int(first[b]);edges.add((min(x,y),max(x,y)))
    return sorted(edges)


def merge_cells(xy,mass,*,min_weight=50,min_spacing=275,initial_cells=None,force_indices=()):
    xy=np.asarray(xy,dtype=float);mass=np.asarray(mass,dtype=np.int64)
    if len(xy)==0 or xy.shape!=(len(mass),2) or mass.ndim!=2 or mass.shape[0]!=len(xy):
        raise ValueError('Expected nonempty two-dimensional sites and demand columns')
    if not np.isfinite(xy).all() or (mass<0).any() or (mass.sum(axis=1)==0).any():
        raise ValueError('Sites must have finite coordinates and positive nonnegative demand')
    if min_weight<1 or min_spacing<=0:raise ValueError('Positive merge constraints required')
    totals=mass.sum(axis=0)
    if np.any((totals>0)&(totals<min_weight)):
        raise ValueError('A positive mode total is below the minimum; conservation makes the floor impossible')
    cells=([dict(members=list(c['members']),anchor=c['anchor'],mass=np.asarray(c['mass']).copy()) for c in initial_cells]
           if initial_cells is not None else [dict(members=[i],anchor=i,mass=mass[i].copy()) for i in range(len(xy))])
    force_indices=set(force_indices)
    if force_indices and len(cells)<2:raise ValueError('Spacing cannot be repaired without another same-owner cell')
    rounds=[]
    while len(cells)>1:
        anchors=xy[[c['anchor'] for c in cells]]
        weights=np.array([c['mass'] for c in cells])
        bad=np.any((weights>0)&(weights<min_weight),axis=1)
        if force_indices:
            bad[list(force_indices)]=True
            force_indices.clear()
        candidates=[];nearest_bad={}
        for a,b in neighbors(anchors):
            distance=float(np.linalg.norm(anchors[a]-anchors[b]))
            close=distance<min_spacing
            if close:candidates.append((0,distance,a,b))
            for i,j in ((a,b),(b,a)):
                if bad[i] and (i not in nearest_bad or (distance,j)<nearest_bad[i]):
                    nearest_bad[i]=(distance,j)
        # A sparse site's nearest neighbor may already participate this round.
        # Wait for the next tessellation rather than accepting a distant hull
        # neighbor just because it is free.
        candidates.extend((1,d,min(i,j),max(i,j)) for i,(d,j) in nearest_bad.items())
        if not candidates:break
        consumed=set();next_cells=[];close_count=0;weight_count=0
        for reason,distance,a,b in sorted(candidates):
            if a in consumed or b in consumed:continue
            consumed.update((a,b))
            members=sorted(cells[a]['members']+cells[b]['members'])
            combined=cells[a]['mass']+cells[b]['mass']
            centroid=np.average(xy[members],axis=0,weights=mass[members].sum(axis=1))
            anchor=members[int(np.argmin(np.sum((xy[members]-centroid)**2,axis=1)))]
            next_cells.append(dict(members=members,anchor=anchor,mass=combined))
            close_count+=int(reason==0);weight_count+=int(reason==1)
        next_cells.extend(c for i,c in enumerate(cells) if i not in consumed)
        cells=sorted(next_cells,key=lambda c:c['members'][0])
        rounds.append(dict(points=len(cells),spacingMerges=close_count,weightMerges=weight_count))
    final=np.array([c['mass'] for c in cells])
    if np.any((final>0)&(final<min_weight)):raise AssertionError('Unsatisfied final native weight floor')
    if not np.array_equal(final.sum(axis=0),totals):raise AssertionError('Merge did not conserve every demand column')
    if len(cells)>1:
        anchors=xy[[c['anchor'] for c in cells]]
        if cKDTree(anchors).query(anchors,k=2)[0][:,1].min()<min_spacing-1e-8:
            raise AssertionError('Unsatisfied final spacing')
    for c in cells:c['mass']=c['mass'].tolist()
    return dict(cells=cells,rounds=rounds,minWeight=min_weight,minSpacingM=min_spacing)


def remap_native(native,result,*,point_prefix='merged-point-'):
    points=[];mapping={}
    for c in result['cells']:
        point_id=f'{point_prefix}{c["members"][0]}'
        anchor=native['points'][c['anchor']]
        points.append(dict(id=point_id,location=list(anchor['location']),residents=c['mass'][0],jobs=c['mass'][1],popIds=[]))
        for i in c['members']:mapping[native['points'][i]['id']]=point_id
    by_id={p['id']:p for p in points};pops=[]
    for original in native['pops']:
        # Endpoint movement invalidates old routes, including same-site trips.
        pop={k:v for k,v in original.items() if not k.startswith('driving')}
        pop['residenceId']=mapping[original['residenceId']];pop['jobId']=mapping[original['jobId']]
        for point_id in dict.fromkeys((pop['residenceId'],pop['jobId'])):
            by_id[point_id]['popIds'].append(pop['id'])
        pops.append(pop)
    return dict(points=points,pops=pops),mapping
