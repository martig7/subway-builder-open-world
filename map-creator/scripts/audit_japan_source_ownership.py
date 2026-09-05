"""Audit positive source cells against full ownership before expensive placement/routing."""
import argparse
import json
from pathlib import Path
from collections import Counter
import shapely
from shapely.ops import nearest_points
from pyproj import Geod
from open_world_map_creator.demand.package_japan import _source_cells, tile_id, SPECIAL_TILE_IDS
from open_world_map_creator.demand.estat_japan_prefecture import load_prefecture_boundary
from open_world_map_creator.geography import ownership_boundary

root=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--world-root',type=Path,default=root/'worlds/japan')
parser.add_argument('--boundary-source',type=Path)
parser.add_argument('--evidence-root',type=Path,default=root/'map-creator/data/artifacts/japan-prefecture-demand-v2')
parser.add_argument('--compatible-evidence',type=Path,default=root/'prototype/japan/generated/tokyo-kanagawa-test')
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
limit=json.loads((args.world_root/'demand.json').read_text(encoding='utf-8'))['cohortPolicy']['maximumBoundarySnapDistanceM']
codes={f'{i:02}' for i in range(1,48)}
_,boundaries,index,_=load_prefecture_boundary(codes,args.boundary_source or ownership_boundary(args.world_root))
geod=Geod(ellps='WGS84')
exceptions=[]
totals=Counter()
for code in sorted(codes):
    directory=(args.compatible_evidence if code in SPECIAL_TILE_IDS else
        args.evidence_root/tile_id(code))
    for kind,name,field in [('home','home-mesh-250m.geojson','commuters'),('jobs','job-mesh-500m.geojson','jobs')]:
        cells=[c for c in _source_cells(directory/name,field,code) if c[field]>0]
        points=shapely.points([[c['longitude'],c['latitude']] for c in cells])
        hits=index.all_tree.query(points,predicate='covered_by')
        covered=set(hits[0].tolist())
        totals[kind+'Cells']+=len(cells)
        for i,c in enumerate(cells):
            if i in covered: continue
            totals[kind+'Outside']+=1
            point=points[i]
            part_index=int(index.all_tree.nearest(point))
            target=nearest_points(point,index.all_parts[part_index])[1]
            distance=geod.inv(point.x,point.y,target.x,target.y)[2]
            if distance>limit:
                exceptions.append({'source':code,'kind':kind,'mass':c[field],'location':[point.x,point.y],
                    'nearestOwner':index.all_codes[part_index],'nearestBoundary':[target.x,target.y],
                    'distanceM':round(distance,1)})
    print(f"audited {code}: distant cells so far {len(exceptions)}",flush=True)
result={'valid':not exceptions,'maximumSnapDistanceM':limit,'totals':dict(totals),'distantCellCount':len(exceptions),
    'distantBySource':dict(Counter(row['source'] for row in exceptions)),
    'distantHomeMarginal':sum(row['mass'] for row in exceptions if row['kind']=='home'),
    'distantJobMarginal':sum(row['mass'] for row in exceptions if row['kind']=='jobs'),
    'exceptions':sorted(exceptions,key=lambda r:-r['distanceM'])}
args.output.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text(json.dumps(result,separators=(',',':')),encoding='utf-8')
print(json.dumps({**result,'exceptions':result['exceptions'][:15]},indent=2),flush=True)
raise SystemExit(1 if exceptions else 0)
