"""Reproduce the Osaka edge-placement regression against local evidence/building artifacts.

Run from the repository with PYTHONPATH=map-creator/src. This is a diagnostic
pilot, not a publisher: it never replaces generated or installed demand.
"""
import json
import gzip
from pathlib import Path
from open_world_map_creator.demand.package_japan import _source_cells, tile_id
from open_world_map_creator.demand.boundary_sites import compile_boundary_sites
from open_world_map_creator.demand.estat_japan_prefecture import load_prefecture_boundary
from open_world_map_creator.geography import ownership_boundary

root = Path(__file__).resolve().parents[2]
regions = {'Ikeda': (135.42,34.80,135.455,34.845), 'Shimamoto': (135.645,34.865,135.68,34.905)}
def inside(x, y, bounds, buffer=0):
    a,b,c,d=bounds
    return a-buffer <= x <= c+buffer and b-buffer <= y <= d+buffer
def near_grid(x,y):
    def near(value, scale, metres):
        return abs(value*scale-(int(value*scale)+.5))/scale*metres < 35
    return any(near(x,320/s,91180) and near(y,480/s,110900) for s in (1,2))
sources={}
for code in ('26','27','28'):
    directory=root/'map-creator/data/artifacts/japan-prefecture-demand-v2'/tile_id(code)
    sources[code]={kind:[c for c in _source_cells(directory/name,field,code)
        if any(inside(c['longitude'],c['latitude'],bounds,.025) for bounds in regions.values())]
        for kind,name,field in [('home','home-mesh-250m.geojson','commuters'),('jobs','job-mesh-500m.geojson','jobs')]}
_,boundaries,_,_=load_prefecture_boundary({f'{i:02}' for i in range(1,48)},ownership_boundary(root/'worlds/japan'))
policy=json.loads((root/'worlds/japan/demand.json').read_text())['cohortPolicy']
sites,report=compile_boundary_sites(boundaries,sources,
    {code:root/'prototype/japan/generated/maps/tiles'/tile_id(code)/'buildings_index.bin.gz' for code in boundaries},
    policy,lambda s:print(s,flush=True))
unique={s['id']:s for rows in sites.values() for s in rows}
with gzip.open(root/'prototype/japan/generated/demand/tiles/JP_PREF_27/demand_data.json.gz','rt') as stream:
    old=json.load(stream)['points']
measurements={}
for region,bounds in regions.items():
    before=[p['location'] for p in old if inside(*p['location'],bounds)]
    after=[[s['longitude'],s['latitude']] for s in unique.values() if s['owner_pref']=='27' and inside(s['longitude'],s['latitude'],bounds)]
    measurements[region]={label:{'points':len(points),'nearMeshCenters':sum(near_grid(*p) for p in points),
        'nearMeshPercent':round(100*sum(near_grid(*p) for p in points)/len(points),2)}
        for label,points in [('before',before),('after',after)]}
    assert measurements[region]['after']['nearMeshPercent'] < measurements[region]['before']['nearMeshPercent']
for source,rows in sites.items():
    assert sum(s['home_weight'] for s in rows)==sum(c['commuters'] for c in sources[source]['home'])
    assert sum(s['job_weight'] for s in rows)==sum(c['jobs'] for c in sources[source]['jobs'])
output={'measurements':measurements,'report':report,'sites':sites}
(root/'.analysis/japan-routing').mkdir(parents=True, exist_ok=True)
(root/'.analysis/japan-routing/boundary-first-pilot.json').write_text(json.dumps(output,separators=(',',':')))
print(json.dumps({'measurements':measurements,'report':report},indent=2),flush=True)
